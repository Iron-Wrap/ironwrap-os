// Shared harness for the pipeline board suites (IRO-209).
//
// The board is driven through its real route handler against a real SQLite database with every
// migration applied, and seeded from the shipped template document rather than from constants
// invented here - so a drift between config/pipelines/sales-pipeline.v1.json and the code that
// reads it fails these tests instead of the stakeholder's board.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  parsePipelineTemplate,
  pipelineIdFor,
  pipelineSeedStatements,
  stageIdFor,
} from "../../tools/seed-pipeline.mjs";

export const TENANT = "ironwrap";
export const SEED_TIME = "2026-08-22T12:00:00.000Z";
export const TEMPLATE_PATH = new URL(
  "../../config/pipelines/sales-pipeline.v1.json",
  import.meta.url,
);
export const SALES_TEMPLATE = parsePipelineTemplate(
  JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")),
);
export const SALES_PIPELINE_ID = pipelineIdFor(TENANT, SALES_TEMPLATE.key);
export const stageId = (key: string) => stageIdFor(TENANT, SALES_TEMPLATE.key, key);

export const USERS: Readonly<Record<string, { userId: string; email: string; role: AppRole }>> = {
  owner: { userId: "appu_owner_0001", email: "owner@example.com", role: "owner" },
  sales: { userId: "appu_sales_0001", email: "sales@example.com", role: "sales" },
  sales_other: { userId: "appu_sales_0002", email: "sales2@example.com", role: "sales" },
  ops: { userId: "appu_ops_0001", email: "ops@example.com", role: "ops" },
  production: { userId: "appu_prod_0001", email: "prod@example.com", role: "production" },
  field: { userId: "appu_field_0001", email: "field@example.com", role: "field" },
};

export class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort())
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(database: DatabaseSync, statement: StatementSync, args: unknown[] = []) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.args as never[])) ?? null) as T | null;
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    return { success: true, results: this.statement.all(...(this.args as never[])) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...(this.args as never[]));
    return { success: true, meta: { changes: totalChanges(this.database) - before } };
  }
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS total").get() as { total: number };
  return Number(row.total);
}

export interface Harness {
  env: AppEnv;
  db: SqliteD1;
}

/** One seeded Sales board plus the operating-core rows its card template reads from. */
export function setup(): Harness {
  const db = new SqliteD1();
  seedAppUsers(db);
  seedOperatingCore(db);
  seedSalesPipeline(db);
  return { env: { DB: db as never, APP_TENANT_ID: TENANT } as AppEnv, db };
}

/**
 * `app_users.role` is a deployed authentication-class constraint that SQLite cannot widen, so
 * 0038_app_access_roles.sql made `access_role` the effective application role and left specialized
 * office users stored under a compatible legacy class. The fixture honours that split.
 */
function seedAppUsers(db: SqliteD1): void {
  const legacyRole = (role: AppRole) =>
    role === "owner" || role === "field" ? role : "ops";
  const insert = db.raw.prepare(
    `INSERT INTO app_users (
       user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
       active, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
  );
  for (const user of Object.values(USERS))
    insert.run(
      user.userId,
      TENANT,
      user.email,
      user.role,
      legacyRole(user.role),
      user.role,
      user.email,
      SEED_TIME,
      SEED_TIME,
    );
}

/**
 * Two leads: one carrying an estimate, a job number and a service type (a full card), and one bare
 * lead with no money anywhere - the case PO decision D4 says must render no value line at all.
 */
function seedOperatingCore(db: SqliteD1): void {
  const envelope = db.raw.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
        status, created_at, updated_at)
     VALUES (?, 'manual', 'Board Customer', 'board@example.invalid', '{}', ?, ?,
             'reconciled', ?, ?)`,
  );
  envelope.run(
    "ow_pipeline_board_0001",
    "raw/board/0001.json",
    SEED_TIME,
    SEED_TIME,
    SEED_TIME,
  );
  envelope.run(
    "ow_pipeline_board_0002",
    "raw/board/0002.json",
    SEED_TIME,
    SEED_TIME,
    SEED_TIME,
  );
  const lead = db.raw.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, 'qualified', 1, ?, ?)`,
  );
  lead.run(
    "lead:board:0001",
    TENANT,
    "ow_pipeline_board_0001",
    "Naina Tamang",
    "naina@example.invalid",
    SEED_TIME,
    SEED_TIME,
  );
  lead.run(
    "lead:board:0002",
    TENANT,
    "ow_pipeline_board_0002",
    "Bare Lead",
    "bare@example.invalid",
    SEED_TIME,
    SEED_TIME,
  );
  db.raw
    .prepare(
      `INSERT INTO operating_customers
         (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
          lifecycle_status, version, created_at, updated_at)
       VALUES ('customer:board:0001', ?, 'ow_pipeline_board_0001', 'Board Customer',
               'board@example.invalid', 'active', 1, ?, ?)`,
    )
    .run(TENANT, SEED_TIME, SEED_TIME);
  db.raw
    .prepare(
      `INSERT INTO operating_roof_jobs
         (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
          service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES ('job:board:0001', ?, 'lead:board:0001', 'customer:board:0001',
               'ow_pipeline_board_0001', 'ironwrap', 'ABN26-007', 'Metal Roofing',
               'qualified', 'qualification', 1, ?, ?)`,
    )
    .run(TENANT, SEED_TIME, SEED_TIME);
  db.raw
    .prepare(
      `INSERT INTO operating_instant_estimates
         (estimate_session_id, tenant_id, lead_id, roof_job_id, source_envelope_id, source,
          service_type, status, estimate_total_cents, review_required, version, created_at, updated_at)
       VALUES ('estimate:board:0001', ?, 'lead:board:0001', 'job:board:0001',
               'ow_pipeline_board_0001', 'manual', 'Metal Roofing', 'approved', 400000, 0, 1, ?, ?)`,
    )
    .run(TENANT, SEED_TIME, SEED_TIME);
}

function seedSalesPipeline(db: SqliteD1): void {
  for (const { sql, params } of pipelineSeedStatements(SALES_TEMPLATE, {
    tenantId: TENANT,
    now: SEED_TIME,
  }))
    db.raw.prepare(sql).run(...(params as never[]));
}

/** A second tenant, used to prove that isolation is enforced by the query, not by the caller. */
export const OTHER_TENANT = "other-co";

export function auth(who: keyof typeof USERS, tenantId: string = TENANT): AuthContext {
  const user = USERS[who] as { userId: string; email: string; role: AppRole };
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf-token",
    permissions: permissionsForRole(user.role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: SEED_TIME,
      session_expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      user_id: user.userId,
      tenant_id: tenantId,
      email_normalized: user.email,
      display_name: user.role,
      role: user.role,
      frappe_user_id: user.email,
      active: 1,
      created_by: "seed",
      created_at: SEED_TIME,
      updated_at: SEED_TIME,
    },
  };
}

export function request(
  method: string,
  path: string,
  options: { body?: unknown; idempotency?: string | null; csrf?: boolean } = {},
): Request {
  const headers = new Headers();
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf-token");
  if (options.idempotency !== null)
    headers.set("idempotency-key", options.idempotency ?? "pipeline-key-0000000001");
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  return new Request(`https://app.example.com${path}`, init);
}
