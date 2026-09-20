// A repeat customer's finished work, read back out of a real SQLite D1 built from the full
// migration chain — not a hand-written double that reimplements the endpoint's own SQL.
//
// The load-bearing test here is `openable agrees with the job route`: the flag this read model
// publishes is a claim about a DIFFERENT endpoint, so it is checked against that endpoint rather
// than against a constant copied beside it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { CUSTOMER_JOB_HISTORY_PAGE_SIZE } from "../src/customer-job-history.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "otherco";
const AT = "2026-03-01T10:00:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args),
    };
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

class SqliteStatement {
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

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

interface SeedJob {
  id: string;
  status: "qualified" | "in_progress" | "complete" | "cancelled";
  number?: string | null;
  service?: string;
  propertyId?: string | null;
  updatedAt?: string;
  tenant?: string;
  customerId?: string;
}

function seed(db: SqliteD1, jobs: SeedJob[]): void {
  const raw = db.raw;
  const tenants = [...new Set(jobs.map((job) => job.tenant ?? TENANT))];
  for (const tenant of tenants) {
    raw
      .prepare(
        `INSERT INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at)
         VALUES (?, 'website', '{}', ?, 'received', ?, ?)`,
      )
      .run(`ow_${tenant}_seed`, AT, AT, AT);
    raw
      .prepare(
        `INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_phone, created_at, updated_at)
         VALUES (?, ?, ?, 'website', 'Seed Lead', ?, ?, ?)`,
      )
      .run(
        `LEAD-${tenant}`,
        tenant,
        `ow_${tenant}_seed`,
        `+1403555${tenant.length}101`,
        AT,
        AT,
      );
  }
  const customers = [
    ...new Set(
      jobs.map(
        (job) => `${job.tenant ?? TENANT}:${job.customerId ?? "CUSTOMER-A"}`,
      ),
    ),
  ];
  for (const [index, key] of customers.entries()) {
    const [tenant, customerId] = key.split(":");
    raw
      .prepare(
        `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        customerId,
        tenant,
        `ow_${tenant}_seed`,
        `Northside Holdings ${customerId}`,
        `c${index}@example.invalid`,
        AT,
        AT,
      );
  }
  const properties = [
    ...new Set(
      jobs
        .filter((job) => job.propertyId !== null)
        .map(
          (job) => `${job.tenant ?? TENANT}:${job.propertyId ?? "PROPERTY-A"}`,
        ),
    ),
  ];
  for (const key of properties) {
    const [tenant, propertyId] = key.split(":");
    raw
      .prepare(
        `INSERT INTO operating_properties (property_id, tenant_id, property_key, lead_id, source_envelope_id, address_line1, city, province, postal_code, structure_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Calgary', 'AB', 'T2P 1A1', 'Detached', ?, ?)`,
      )
      .run(
        propertyId,
        tenant,
        `${tenant}/${propertyId}`,
        `LEAD-${tenant}`,
        `ow_${tenant}_seed`,
        `${propertyId} Riverbend Way`,
        AT,
        AT,
      );
  }
  for (const job of jobs) {
    const tenant = job.tenant ?? TENANT;
    raw
      .prepare(
        `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, brand, job_number, service_type, job_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ironwrap', ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        tenant,
        `LEAD-${tenant}`,
        job.customerId ?? "CUSTOMER-A",
        job.propertyId === null ? null : (job.propertyId ?? "PROPERTY-A"),
        `ow_${tenant}_seed`,
        job.number === undefined ? `IW-${job.id}` : job.number,
        job.service ?? "Metal re-roof",
        job.status,
        AT,
        job.updatedAt ?? AT,
      );
  }
}

function env(db: SqliteD1): AppEnv {
  return { APP_TENANT_ID: TENANT, DB: db } as unknown as AppEnv;
}

function auth(role: AppRole, tenantId: string = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: AT,
      session_expires_at: "2026-03-02T10:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: tenantId,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: AT,
      updated_at: AT,
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function history(
  appEnv: AppEnv,
  jobId: string,
  who: AuthContext = auth("owner"),
): Promise<Response> {
  return handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/jobs/${encodeURIComponent(jobId)}/customer-history`,
    ),
    appEnv,
    who,
  );
}

test("finished and cancelled work is readable, newest first, with the anchor marked", async () => {
  const db = new SqliteD1();
  seed(db, [
    {
      id: "JOB-LIVE",
      status: "in_progress",
      updatedAt: "2026-03-01T10:00:00.000Z",
    },
    {
      id: "JOB-DONE",
      status: "complete",
      updatedAt: "2024-11-02T10:00:00.000Z",
      propertyId: "PROPERTY-B",
    },
    {
      id: "JOB-GONE",
      status: "cancelled",
      updatedAt: "2023-06-04T10:00:00.000Z",
    },
  ]);
  const response = await history(env(db), "JOB-LIVE");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const model = (await response.json()) as {
    customer: { customer_id: string; display_name: string };
    anchor_job_id: string;
    truncated: boolean;
    entries: Array<{
      roof_job_id: string;
      job_status: string;
      is_anchor: boolean;
      openable: boolean;
      property: { address_line1: string; city: string } | null;
    }>;
  };

  assert.equal(model.customer.customer_id, "CUSTOMER-A");
  assert.equal(model.anchor_job_id, "JOB-LIVE");
  assert.equal(model.truncated, false);
  assert.deepEqual(
    model.entries.map((entry) => entry.roof_job_id),
    ["JOB-LIVE", "JOB-DONE", "JOB-GONE"],
  );
  assert.deepEqual(
    model.entries.map((entry) => entry.job_status),
    ["In Production", "Complete", "Cancelled"],
  );
  assert.deepEqual(
    model.entries.map((entry) => entry.is_anchor),
    [true, false, false],
  );
  // The whole point: the completed job is present and carries the address it was done at.
  const done = model.entries.find((entry) => entry.roof_job_id === "JOB-DONE");
  assert.equal(done?.property?.address_line1, "PROPERTY-B Riverbend Way");
  assert.equal(done?.property?.city, "Calgary");
});

test("openable agrees with what the job route will actually open", async () => {
  const db = new SqliteD1();
  const statuses = [
    "qualified",
    "in_progress",
    "complete",
    "cancelled",
  ] as const;
  seed(
    db,
    statuses.map((status) => ({ id: `JOB-${status.toUpperCase()}`, status })),
  );
  const appEnv = env(db);
  const model = (await (await history(appEnv, "JOB-QUALIFIED")).json()) as {
    entries: Array<{ roof_job_id: string; openable: boolean }>;
  };

  for (const entry of model.entries) {
    const direct = await handleAuthenticatedRoute(
      new Request(
        `https://app.example.invalid/api/v1/jobs/${entry.roof_job_id}`,
      ),
      appEnv,
      auth("owner"),
    );
    assert.notEqual(
      direct.status,
      502,
      `${entry.roof_job_id} failed for an unrelated reason; the agreement check proves nothing`,
    );
    assert.equal(
      entry.openable,
      direct.status === 200,
      `${entry.roof_job_id}: history says openable=${entry.openable}, job route answered ${direct.status}`,
    );
  }
  // And it is not vacuously true in one direction.
  assert.ok(model.entries.some((entry) => entry.openable));
  assert.ok(model.entries.some((entry) => !entry.openable));
});

test("a crew member holding only jobs:read:assigned is refused", async () => {
  const db = new SqliteD1();
  seed(db, [{ id: "JOB-LIVE", status: "in_progress" }]);
  const response = await history(env(db), "JOB-LIVE", auth("field"));
  assert.equal(response.status, 403);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "job_read_any_required",
  );
});

test("history never crosses a tenant", async () => {
  const db = new SqliteD1();
  seed(db, [
    { id: "JOB-OURS", status: "in_progress" },
    {
      id: "JOB-THEIRS",
      status: "complete",
      tenant: OTHER_TENANT,
      customerId: "CUSTOMER-B",
      propertyId: "PROPERTY-Z",
    },
  ]);
  const appEnv = env(db);

  const ours = (await (await history(appEnv, "JOB-OURS")).json()) as {
    entries: Array<{ roof_job_id: string }>;
  };
  assert.deepEqual(
    ours.entries.map((entry) => entry.roof_job_id),
    ["JOB-OURS"],
  );

  // Naming the other tenant's job from our session is a 404, not a peek.
  assert.equal((await history(appEnv, "JOB-THEIRS")).status, 404);
});

test("a full page says so instead of reading as the whole history", async () => {
  const db = new SqliteD1();
  seed(
    db,
    Array.from(
      { length: CUSTOMER_JOB_HISTORY_PAGE_SIZE + 3 },
      (_unused, index) => ({
        id: `JOB-HIST-${String(index).padStart(3, "0")}`,
        status: "complete" as const,
        updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    ),
  );
  const model = (await (await history(env(db), "JOB-HIST-000")).json()) as {
    truncated: boolean;
    entries: unknown[];
  };
  assert.equal(model.entries.length, CUSTOMER_JOB_HISTORY_PAGE_SIZE);
  assert.equal(model.truncated, true);
});

test("an unknown job is a 404, and a job with no property still reads", async () => {
  const db = new SqliteD1();
  seed(db, [{ id: "JOB-NOWHERE", status: "in_progress", propertyId: null }]);
  const appEnv = env(db);

  assert.equal((await history(appEnv, "JOB-MISSING")).status, 404);

  const model = (await (await history(appEnv, "JOB-NOWHERE")).json()) as {
    entries: Array<{ property: unknown }>;
  };
  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0].property, null);
});
