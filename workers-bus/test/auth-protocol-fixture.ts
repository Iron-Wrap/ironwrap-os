import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { AppEnv, AppRole, AppUserRecord } from "../src/app-types.ts";
import type { AuthProtocolAdmission } from "../src/auth-protocol-control.ts";
import {
  canonicalV2,
  type AuthControlHeadV2,
} from "../../shared/auth-protocol-v2.mjs";

export class ProtocolD1 {
  readonly raw = new DatabaseSync(":memory:");
  failAt: number | null = null;
  beforeBatch: (() => Promise<void>) | null = null;
  constructor(migrations?: readonly { sql: string }[]) {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const statements =
      migrations ??
      readdirSync(new URL("../migrations/", import.meta.url))
        .filter((f) => /^\d{4}_.+\.sql$/.test(f))
        .sort()
        .map((name) => ({
          sql: readFileSync(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        }));
    for (const migration of statements) this.raw.exec(migration.sql);
  }
  prepare(sql: string) {
    const bound = (args: unknown[]) => {
      const execute = () => ({
        success: true,
        meta: {
          changes: Number(
            this.raw.prepare(sql).run(...(args as never[])).changes,
          ),
        },
      });
      return {
        first: async <T>() =>
          (this.raw.prepare(sql).get(...(args as never[])) ?? null) as T | null,
        all: async <T>() => ({
          results: this.raw.prepare(sql).all(...(args as never[])) as T[],
        }),
        run: async () => execute(),
        execute,
      };
    };
    return { ...bound([]), bind: (...args: unknown[]) => bound(args) };
  }
  async batch(statements: Array<{ execute(): unknown }>): Promise<unknown[]> {
    await this.beforeBatch?.();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error("synthetic_sql_failure");
        return statement.execute();
      });
      this.raw.exec("COMMIT");
      return out;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
  user(role: AppRole, label: string = role): AppUserRecord {
    const now = new Date(Date.now() - 60000).toISOString();
    const id = `appu_${crypto.randomUUID()}`;
    this.raw
      .prepare(
        `INSERT INTO app_users
      (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
      VALUES (?,'ironwrap',?,?,?,?,?,1,'synthetic',?,?)`,
      )
      .run(
        id,
        `${label}@example.invalid`,
        label,
        role === "field" ? "field" : role === "owner" ? "owner" : "ops",
        role,
        role === "field" ? `${label}@example.invalid` : null,
        now,
        now,
      );
    return this.raw
      .prepare("SELECT *,access_role AS role FROM app_users WHERE user_id=?")
      .get(id) as unknown as AppUserRecord;
  }
}

export function protocolHead(
  mode: "staged" | "closed" | "active" = "active",
): AuthControlHeadV2 {
  return {
    format: "ironwrap-auth-control-v2",
    controlRevision: 1,
    minProducerProtocol: mode === "staged" ? 1 : 2,
    mode,
    activationId: "activation-synthetic-v2",
    issuer: "issuer-synthetic-v2",
    databaseIdentity: "database-synthetic-v2",
    allowedProducerBindings: [
      {
        versionId: "producer-synthetic-p1",
        artifactHash: "a".repeat(64),
        componentManifestHash: "b".repeat(64),
        protocol: 2,
        databaseIdentity: "database-synthetic-v2",
        issuer: "issuer-synthetic-v2",
      },
    ],
    qualificationReceiptHash: null,
  };
}

export function protocolFixture(
  mode: "staged" | "active" = "active",
  open = false,
) {
  const db = new ProtocolD1();
  const head = protocolHead(mode);
  db.raw
    .prepare(
      `UPDATE app_auth_protocol SET protocol_floor=?,mode=?,control_revision=?,issuer=?,activation_id=?,database_identity=?,enrollment_open=0 WHERE singleton=1`,
    )
    .run(
      head.minProducerProtocol,
      mode === "active" ? "closed" : mode,
      head.controlRevision,
      head.issuer,
      head.activationId,
      head.databaseIdentity,
    );
  if (mode === "active")
    db.raw
      .prepare(
        "UPDATE app_auth_protocol SET mode='active',enrollment_open=? WHERE singleton=1",
      )
      .run(open ? 1 : 0);
  const env = {
    DB: db,
    APP_BFF_ENABLED: "true",
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "Synthetic company",
    APP_TENANT_BRAND: "Synthetic",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "http://localhost:7100",
    APP_ALLOWED_ORIGINS: "http://localhost:7100",
    APP_AUTH_PEPPER: "synthetic-pepper-with-more-than-thirty-two-characters",
    AUTH_CONTROL_ACCOUNT_ID: "0".repeat(32),
    AUTH_CONTROL_BUCKET: "auth-control-synthetic",
    AUTH_CONTROL_KEY: "auth-control/head-v2",
    AUTH_CONTROL_READ_ACCESS_KEY_ID: "synthetic-reader-access",
    AUTH_CONTROL_READ_SECRET_ACCESS_KEY:
      "synthetic-reader-secret-with-32-characters",
    AUTH_DATABASE_IDENTITY: head.databaseIdentity,
    AUTH_CONTROL_ENVIRONMENT: "qa",
    AGENT_DATA_CLASS: "synthetic",
    AUTH_RECOVERY_ENROLLMENT_ENABLED: open ? "true" : "false",
    CF_VERSION_METADATA: { id: "producer-synthetic-p1" },
  } as unknown as AppEnv;
  const admission: AuthProtocolAdmission = {
    head,
    actualVersion: env.CF_VERSION_METADATA!.id,
    mirror: {
      protocol_floor: head.minProducerProtocol,
      mode,
      control_revision: 1,
      issuer: head.issuer,
      activation_id: head.activationId,
      database_identity: head.databaseIdentity,
      enrollment_open: open ? 1 : 0,
    },
    mode,
  };
  const fetcher = async (request: Request | URL | string) => {
    const req = request instanceof Request ? request : new Request(request);
    if (
      req.method !== "GET" ||
      !req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")
    )
      throw new Error("synthetic_unsigned_control");
    return new Response(canonicalV2(head), {
      headers: { etag: '"synthetic-head"' },
    });
  };
  return { db, head, env, admission, fetcher };
}
