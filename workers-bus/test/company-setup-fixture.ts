import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

export const TENANT = "ironwrap";
export const OTHER_TENANT = "other-tenant";
export const NOW = "2026-08-23T12:00:00.000Z";

export const USERS: Record<AppRole, string> = {
  owner: "appu_owner_000001",
  ops: "appu_ops_000000001",
  sales: "appu_sales_000001",
  production: "appu_production_1",
  accounting: "appu_accounting_1",
  field: "appu_field_000001",
};

/**
 * The real migration chain against an in-memory SQLite, the same way the inventory and
 * fleet suites do it: a store test that invents its own schema proves nothing about the
 * CHECK constraints migration 0110 actually ships.
 */
export class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor(options: { seedUsers?: readonly AppRole[] } = {}) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    for (const role of options.seedUsers ?? ["owner"]) this.addUser(role);
  }

  /** `role` is the legacy storage column; `access_role` carries the effective role. */
  addUser(role: AppRole, tenantId = TENANT, userId = USERS[role]): void {
    const storageRole = role === "field" ? "field" : role === "owner" ? "owner" : "ops";
    this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role,
          frappe_user_id, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    ).run(
      userId, tenantId, `${userId}@example.invalid`, role, storageRole, role,
      `${userId}@example.invalid`, NOW, NOW,
    );
  }

  deactivateUser(userId: string): void {
    this.raw.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(userId);
  }

  addDevice(userId: string, deviceId: string, revokedAt: string | null = null): void {
    // Any 64-character lowercase hex value satisfies the pairing proof CHECK; the
    // device id only has to make it unique across the rows one test seeds.
    const proof = [...deviceId].reduce(
      (accumulator, character) => accumulator + character.charCodeAt(0).toString(16),
      "",
    ).padEnd(64, "0").slice(0, 64);
    this.raw.prepare(
      `INSERT INTO app_devices
         (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
          revoked_at, created_ip_hash, created_user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, TENANT, userId, proof, NOW, NOW, revokedAt, "c".repeat(64), "d".repeat(64));
  }

  addLead(leadId: string): void {
    this.raw.prepare(
      `INSERT INTO envelopes
         (envelope_id, source, contact_name, contact_phone, contact_email, job_ref,
          payload_json, raw_key, ts, status, dedup_key, attempts, created_at, updated_at)
       VALUES (?, 'website', 'Synthetic Lead', '+15875550100', ?, NULL,
               '{}', ?, ?, 'pending_jn_push', ?, 0, ?, ?)`,
    ).run(
      leadId, `${leadId}@example.invalid`, `raw/${leadId}.json`, NOW, `e:${leadId}`, NOW, NOW,
    );
    this.raw.prepare(
      `INSERT INTO operating_leads
         (lead_id, tenant_id, source_envelope_id, source, contact_name, created_at, updated_at)
       VALUES (?, ?, ?, 'website', 'Synthetic Lead', ?, ?)`,
    ).run(leadId, TENANT, leadId, NOW, NOW);
  }

  /**
   * The real connection row, including its OAuth-state parent, so the setup read model
   * is counting the same rows the money desk writes rather than a stand-in.
   * `reconciliation_required` is the not-yet-usable state a revoked row cannot express
   * without a full revocation receipt.
   */
  addQuickBooksConnection(state: "connected" | "reconciliation_required"): void {
    const stateHash = "f".repeat(64);
    this.raw.prepare(
      `INSERT INTO quickbooks_oauth_states
         (state_sha256, tenant_id, user_id, redirect_uri, return_path,
          idempotency_key_sha256, request_fingerprint_sha256, created_at, expires_at)
       VALUES (?, ?, ?, 'https://app.example.invalid/oauth/callback',
               '/accounting/quickbooks', ?, ?, ?, ?)`,
    ).run(
      stateHash, TENANT, USERS.owner, "a".repeat(64), "b".repeat(64), NOW,
      "2026-08-24T12:00:00.000Z",
    );
    this.raw.prepare(
      `INSERT INTO quickbooks_connections
         (connection_id, oauth_state_sha256, tenant_id, realm_id, state,
          encrypted_bundle_b64, bundle_iv_b64, encryption_key_version, bundle_version,
          access_expires_at, connected_by_user_id, connected_at, updated_at)
       VALUES (?, ?, ?, '1234567890', ?, ?, ?, 'v1', 1, ?, ?, ?, ?)`,
    ).run(
      "11111111-2222-3333-4444-555555555555", stateHash, TENANT, state,
      "x".repeat(64), "y".repeat(16), "2026-08-24T12:00:00.000Z",
      USERS.owner, NOW, NOW,
    );
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

export class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  execute(): { changes?: number | bigint } {
    return this.raw.prepare(this.sql).run(...this.args) as { changes?: number | bigint };
  }
}

export function env(db: SqliteD1, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: db,
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    ...overrides,
  } as unknown as AppEnv;
}

export function auth(role: AppRole, tenantId = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW,
      session_expires_at: "2026-08-24T12:00:00.000Z",
      revoked_at: null,
      user_id: USERS[role],
      tenant_id: tenantId,
      email_normalized: `${USERS[role]}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${USERS[role]}@example.invalid`,
      active: 1,
      created_by: USERS.owner,
      created_at: NOW,
      updated_at: NOW,
    },
  } as AuthContext;
}

export const VALID_PROFILE = {
  company_name: "FreshCo Exteriors Ltd.",
  brand_name: "FreshCo",
  service_area: "Greater Edmonton roofing",
  phone: "+1 587 555 0100",
  email: "hello@freshco.example",
  website: "https://freshco.example",
  address_line1: "12 Shop Road",
  address_line2: "Unit 4",
  city: "Edmonton",
  region: "AB",
  postal_code: "T5J 0N3",
  country: "Canada",
  brand_labels: {},
  time_zone: "America/Edmonton",
  currency: "CAD",
  week_start: "monday",
} as const;

export function request(
  method: string,
  path: string,
  options: {
    payload?: unknown;
    csrf?: boolean;
    idempotencyKey?: string | null;
  } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf");
  if (options.idempotencyKey !== null) {
    headers.set("idempotency-key", options.idempotencyKey ?? "setup-key-00000000001");
  }
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers,
    body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
}
