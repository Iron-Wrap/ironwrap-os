// The crew on the roof could not see the measurements anyone had taken of it: `buildJobReadModel`
// returned `packet.measurements: []` on the owned path and flagged the slot unavailable, while
// `native_measurement_revisions` held the rows.
//
// Real SQLite over the full migration chain, driven through the job route, because the point of
// this change is the wiring and a store-level test would not have caught it being unwired.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const AT = "2026-03-01T10:00:00.000Z";
const JOB = "JOB-ROOF-1";
const JOB_NUMBER = "IW-1001";
const MEASUREMENTS_UNAVAILABLE = "packet.measurements.native_unavailable";

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

/** The schema pins these ids to exact lengths and a hex alphabet; this keeps fixtures legal. */
function hex(seed: string): string {
  const base = seed.replace(/[^0-9a-f]/g, "") || "a";
  return base.repeat(Math.ceil(64 / base.length)).slice(0, 64);
}

/** OR IGNORE on the shared rows so a second job in the same tenant reuses its customer and property. */
function seedJob(db: SqliteD1, tenant = TENANT, jobId = JOB): void {
  const raw = db.raw;
  raw
    .prepare(
      `INSERT OR IGNORE INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at)
       VALUES (?, 'website', '{}', ?, 'received', ?, ?)`,
    )
    .run(`ow_${tenant}_seed`, AT, AT, AT);
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_phone, created_at, updated_at)
       VALUES (?, ?, ?, 'website', 'Seed Lead', ?, ?, ?)`,
    )
    .run(`LEAD-${tenant}`, tenant, `ow_${tenant}_seed`, "+14035550101", AT, AT);
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Northside Holdings', ?, 'active', ?, ?)`,
    )
    .run(
      `CUSTOMER-${tenant}`,
      tenant,
      `ow_${tenant}_seed`,
      `c-${tenant}@example.invalid`,
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_properties (property_id, tenant_id, property_key, lead_id, source_envelope_id, address_line1, city, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '88 Riverbend Way', 'Calgary', ?, ?)`,
    )
    .run(
      `PROPERTY-${tenant}`,
      tenant,
      `${tenant}/p`,
      `LEAD-${tenant}`,
      `ow_${tenant}_seed`,
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'IW-1001', 'Metal re-roof', 'in_progress', ?, ?)`,
    )
    .run(
      jobId,
      tenant,
      `LEAD-${tenant}`,
      `CUSTOMER-${tenant}`,
      `PROPERTY-${tenant}`,
      `ow_${tenant}_seed`,
      AT,
      AT,
    );
}

interface MeasurementSeed {
  key: string;
  provider?: string;
  reviewRequired?: 0 | 1;
  /** null means the association failed: an unmatched row belongs to no job. */
  jobId?: string | null;
  tenant?: string;
  revisionNumber?: number;
  rootKey?: string;
  supersedesKey?: string;
  createdAt?: string;
}

function seedMeasurement(db: SqliteD1, input: MeasurementSeed): void {
  const raw = db.raw;
  const tenant = input.tenant ?? TENANT;
  const jobId = input.jobId === undefined ? JOB : input.jobId;
  const revisionNumber = input.revisionNumber ?? 1;
  const measurementId = `measurement:${hex(input.key)}`;
  const rootId = input.rootKey
    ? `measurement:${hex(input.rootKey)}`
    : measurementId;
  // `native_measurement_revisions_receipt_guard` requires the revision to agree with a receipt that
  // is still leased, field for field, so the fixture has to be a real intake in flight rather than
  // a plausible-looking row.
  raw
    .prepare(
      `INSERT INTO measurement_intake_receipts
         (receipt_id, tenant_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id,
          provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at,
          attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'payload_hash', ?, ?, ?, ?, 'application/json', 'processing', ?, ?, 1, ?, ?)`,
    )
    .run(
      `measurement_${hex(input.key)}`,
      tenant,
      hex(`${input.key}1`),
      hex(`${input.key}3`),
      measurementId,
      input.provider ?? "EagleView",
      JOB_NUMBER,
      `raw/measurements/${hex(input.key)}.json`,
      `lease-${input.key}`,
      "2026-03-01T11:00:00.000Z",
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT INTO native_measurement_revisions
         (measurement_revision_id, tenant_id, receipt_id, measurement_id, provider, job_number,
          roof_job_id, operating_job_version, association_status, association_error, receipt_status,
          review_required, root_measurement_id, revision_number, supersedes_measurement_revision_id,
          correction_reason, measurement_raw_key, measurement_raw_sha256, projection_json,
          projection_sha256, command_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(
      `mrev_${hex(input.key)}`,
      tenant,
      `measurement_${hex(input.key)}`,
      measurementId,
      input.provider ?? "EagleView",
      JOB_NUMBER,
      jobId,
      jobId === null ? null : 1,
      jobId === null ? "unmatched" : "matched",
      jobId === null ? "job_not_found" : null,
      jobId === null ? "unmatched" : "matched",
      input.reviewRequired ?? 0,
      rootId,
      revisionNumber,
      input.supersedesKey ? `mrev_${hex(input.supersedesKey)}` : null,
      revisionNumber > 1 ? "Corrected after a site visit" : null,
      `raw/measurements/${hex(input.key)}.json`,
      hex(`${input.key}3`),
      hex(`${input.key}4`),
      hex(`${input.key}5`),
      input.createdAt ?? AT,
    );
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

interface PacketMeasurement {
  id: string;
  provider: string | null;
  review_status: string | null;
  parsed_at: string | null;
}

async function packet(
  db: SqliteD1,
  jobId = JOB,
  who: AuthContext = auth("owner"),
): Promise<{ measurements: PacketMeasurement[]; stale: string[] }> {
  const response = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/jobs/${encodeURIComponent(jobId)}`,
    ),
    env(db),
    who,
  );
  assert.equal(response.status, 200, `job route answered ${response.status}`);
  const model = (await response.json()) as {
    packet: { measurements: PacketMeasurement[] };
    stale_fields: string[];
  };
  return { measurements: model.packet.measurements, stale: model.stale_fields };
}

test("a measurement taken of this roof reaches the crew's job packet", async () => {
  const db = new SqliteD1();
  seedJob(db);
  seedMeasurement(db, { key: "ab", provider: "EagleView", reviewRequired: 0 });
  const { measurements, stale } = await packet(db);

  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].provider, "EagleView");
  assert.equal(measurements[0].parsed_at, AT);
  assert.equal(measurements[0].review_status, "No review flagged");
  // The slot is carried now, so the packet must stop declaring it unavailable.
  assert.ok(
    !stale.includes(MEASUREMENTS_UNAVAILABLE),
    `stale still carries it: ${stale.join(", ")}`,
  );
});

test("a revision flagged for review says so rather than reading as accepted", async () => {
  const db = new SqliteD1();
  seedJob(db);
  seedMeasurement(db, { key: "bc", reviewRequired: 1 });
  const { measurements } = await packet(db);

  assert.equal(measurements[0].review_status, "Flagged for review");
});

test("only the current revision of each measurement is carried", async () => {
  const db = new SqliteD1();
  seedJob(db);
  seedMeasurement(db, {
    key: "cd",
    provider: "EagleView",
    createdAt: "2026-02-01T10:00:00.000Z",
  });
  seedMeasurement(db, {
    key: "de",
    provider: "Corrected EagleView",
    revisionNumber: 2,
    rootKey: "cd",
    supersedesKey: "cd",
    createdAt: "2026-02-20T10:00:00.000Z",
  });
  const { measurements } = await packet(db);

  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].provider, "Corrected EagleView");
});

test("an unmatched measurement belongs to no job, and another job's does not leak", async () => {
  const db = new SqliteD1();
  seedJob(db);
  seedJob(db, TENANT, "JOB-ROOF-2");
  seedMeasurement(db, { key: "ef", jobId: null });
  seedMeasurement(db, {
    key: "fa",
    jobId: "JOB-ROOF-2",
    provider: "Other job",
  });
  seedMeasurement(db, { key: "ab", provider: "This job" });
  const { measurements } = await packet(db);

  assert.deepEqual(
    measurements.map((row) => row.provider),
    ["This job"],
  );
});

test("no measurement at all is an empty slot, not an unavailable one", async () => {
  // The distinction the UI reads: an empty list the server actually looked up may be shown as
  // "none", while a slot it cannot carry must not be. Getting this backwards tells a crew a roof
  // was never measured.
  const db = new SqliteD1();
  seedJob(db);
  const { measurements, stale } = await packet(db);

  assert.deepEqual(measurements, []);
  assert.ok(!stale.includes(MEASUREMENTS_UNAVAILABLE));
});

test("measurements never cross a tenant", async () => {
  const db = new SqliteD1();
  seedJob(db);
  seedJob(db, "otherco", "JOB-ROOF-9");
  seedMeasurement(db, {
    key: "ab",
    tenant: "otherco",
    jobId: "JOB-ROOF-9",
    provider: "Theirs",
  });
  const { measurements } = await packet(db);

  assert.deepEqual(measurements, []);
});
