// Versioned setup for historical P0 behavior tests under P1's mandatory STAGED admission.
// Memory-DB fixtures model this read-only precondition; real fence/SQL/provider adapters have
// separate tests. This is not a qualification receipt or an active/enrolled context.
import type { AppEnv } from "../src/app-types.ts";
import { canonicalV2 } from "../../shared/auth-protocol-v2.mjs";

const account = "0".repeat(32);
const mirror = {
  protocol_floor: 1,
  mode: "staged",
  control_revision: 1,
  issuer: "issuer-staged-fixture",
  activation_id: "activation-staged-fixture",
  database_identity: "database-staged-fixture",
  enrollment_open: 0,
};
const head = {
  format: "ironwrap-auth-control-v2",
  controlRevision: 1,
  minProducerProtocol: 1,
  mode: "staged",
  issuer: mirror.issuer,
  activationId: mirror.activation_id,
  databaseIdentity: mirror.database_identity,
  allowedProducerBindings: [
    {
      versionId: "producer-staged-fixture",
      artifactHash: "a".repeat(64),
      componentManifestHash: "b".repeat(64),
      protocol: 2,
      databaseIdentity: mirror.database_identity,
      issuer: mirror.issuer,
    },
  ],
  qualificationReceiptHash: null,
};
const wrapped = new WeakMap<object, unknown>();

export function stagedP1Fetch(next: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url ===
      `https://${account}.r2.cloudflarestorage.com/p1-auth-control-synthetic/auth-control/head-v2`
    ) {
      if (request.method !== "GET")
        throw new Error("staged_fixture_is_read_only");
      return new Response(canonicalV2(head), {
        headers: { etag: '"staged-legacy-fixture"' },
      });
    }
    return next(input, init);
  };
}

export function stagedP1Env<T extends AppEnv>(env: T): T {
  Object.assign(env, {
    AUTH_CONTROL_ACCOUNT_ID: account,
    AUTH_CONTROL_BUCKET: "p1-auth-control-synthetic",
    AUTH_CONTROL_KEY: "auth-control/head-v2",
    AUTH_DATABASE_IDENTITY: mirror.database_identity,
    AUTH_CONTROL_ENVIRONMENT: "qa",
    AUTH_RECOVERY_ENROLLMENT_ENABLED: "false",
    AUTH_CONTROL_READ_ACCESS_KEY_ID: "synthetic-staged-reader",
    AUTH_CONTROL_READ_SECRET_ACCESS_KEY:
      "synthetic-staged-reader-secret-with-more-than32-characters",
    CF_VERSION_METADATA: { id: "producer-staged-fixture" },
  });
  if (env.DB) {
    const db = env.DB as unknown as Record<string, unknown>;
    const raw = db.raw as
      | {
          prepare(sql: string): {
            run(...args: unknown[]): unknown;
            get(): { protocol_floor: number } | undefined;
          };
        }
      | undefined;
    if (raw?.prepare) {
      if (
        raw
          .prepare(
            "SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1",
          )
          .get()?.protocol_floor !== 1
      )
        throw new Error("staged_fixture_cannot_downgrade_active_floor");
      raw
        .prepare(
          "UPDATE app_auth_protocol SET issuer=?,activation_id=?,database_identity=?,control_revision=1,mode='staged',enrollment_open=0 WHERE singleton=1",
        )
        .run(mirror.issuer, mirror.activation_id, mirror.database_identity);
      globalThis.fetch = stagedP1Fetch(globalThis.fetch);
      return env;
    }
    const existing = wrapped.get(db);
    if (existing) env.DB = existing as D1Database;
    else {
      const proxy = new Proxy(db, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (sql.includes("FROM app_auth_protocol WHERE singleton=1")) {
                const query = {
                  first: async () => ({ ...mirror }),
                  all: async () => ({ results: [{ ...mirror }] }),
                  run: async () => {
                    throw new Error("staged_fixture_is_read_only");
                  },
                };
                return { ...query, bind: () => query };
              }
              return (target.prepare as (sql: string) => unknown).call(
                target,
                sql,
              );
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      wrapped.set(db, proxy);
      wrapped.set(proxy, proxy);
      env.DB = proxy as unknown as D1Database;
    }
  }
  globalThis.fetch = stagedP1Fetch(globalThis.fetch);
  return env;
}
