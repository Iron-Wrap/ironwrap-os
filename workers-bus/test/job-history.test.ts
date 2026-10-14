// A finished job had no route at all: `buildJobReadModel` refuses anything outside the two live
// statuses, and the live proof read is keyed on an assignment, work package, version and release
// attempt that a completed job no longer has. So the office had nothing to open when a customer
// called about a roof done two winters ago, and no way to see what had been done to it.
//
// Real SQLite over the full migration chain, driven through the route.

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
const AT = "2024-11-02T10:00:00.000Z";
const DONE_JOB = "JOB-FINISHED";
const LIVE_JOB = "JOB-RUNNING";

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

function hex(seed: string, length = 64): string {
  const base = seed.replace(/[^0-9a-f]/g, "") || "a";
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

function seedTenant(db: SqliteD1, tenant = TENANT): void {
  const raw = db.raw;
  raw
    .prepare(
      `INSERT OR IGNORE INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at)
       VALUES (?, 'website', '{}', ?, 'received', ?, ?)`,
    )
    .run(`ow_${tenant}`, AT, AT, AT);
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_phone, created_at, updated_at)
       VALUES (?, ?, ?, 'website', 'Seed Lead', ?, ?, ?)`,
    )
    .run(
      `LEAD-${tenant}`,
      tenant,
      `ow_${tenant}`,
      `+1403555${tenant.length}101`,
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_phone, contact_email, lifecycle_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Northside Holdings', ?, ?, 'active', ?, ?)`,
    )
    .run(
      `CUSTOMER-${tenant}`,
      tenant,
      `ow_${tenant}`,
      `+1403555${tenant.length}222`,
      `c-${tenant}@example.invalid`,
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT OR IGNORE INTO operating_properties (property_id, tenant_id, property_key, lead_id, source_envelope_id, address_line1, city, province, postal_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '88 Riverbend Way', 'Calgary', 'AB', 'T2P 1A1', ?, ?)`,
    )
    .run(
      `PROPERTY-${tenant}`,
      tenant,
      `${tenant}/p`,
      `LEAD-${tenant}`,
      `ow_${tenant}`,
      AT,
      AT,
    );
  raw
    .prepare(
      `INSERT OR IGNORE INTO app_users (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Dana Crew', 'field', ?, 1, 'seed', ?, ?)`,
    )
    .run(
      `appu_crew_${tenant}`,
      tenant,
      `crew-${tenant}@example.invalid`,
      `crew-${tenant}@example.invalid`,
      AT,
      AT,
    );
}

function seedJob(
  db: SqliteD1,
  jobId: string,
  status: "qualified" | "in_progress" | "complete" | "cancelled",
  tenant = TENANT,
): void {
  seedTenant(db, tenant);
  db.raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Metal re-roof', ?, ?, ?)`,
    )
    .run(
      jobId,
      tenant,
      `LEAD-${tenant}`,
      `CUSTOMER-${tenant}`,
      `PROPERTY-${tenant}`,
      `ow_${tenant}`,
      `IW-${jobId}`,
      status,
      AT,
      AT,
    );
}

/**
 * One piece of stored, verified evidence, captured under an assignment and work package that no
 * longer matter — which is the whole point: the history read must find it by job alone.
 */
function seedEvidence(
  db: SqliteD1,
  input: {
    key: string;
    jobId?: string;
    tenant?: string;
    createdAt?: string;
    capturedAt?: string;
    requirement?: string;
  },
): void {
  const raw = db.raw;
  const tenant = input.tenant ?? TENANT;
  const jobId = input.jobId ?? DONE_JOB;
  const deviceActionId = `fa_${hex(input.key, 24)}`;
  const evidenceId = `evi_${hex(input.key, 32)}`;
  raw
    .prepare(
      `INSERT INTO field_actions
         (device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind, payload_hash,
          status, checkin_id, manifest_key, response_json, created_at, updated_at, verified_at,
          work_package_id, work_package_version, work_package_release_attempt_id,
          evidence_slot_id, evidence_requirement, evidence_source, evidence_device_id,
          evidence_freshness, evidence_conflict_state, evidence_verification, evidence_disposition,
          work_object_type, work_object_id, physical_context_type, physical_context_id,
          capture_completed_at)
       VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, 'verified', ?, ?, '{}', ?, ?, ?,
               ?, 1, ?, ?, ?, 'Device camera', ?, 'Current', 'None', 'Verified', 'Open',
               'Roof Job', ?, 'Roof Site', ?, ?)`,
    )
    .run(
      deviceActionId,
      tenant,
      `appu_crew_${tenant}`,
      jobId,
      `ASSIGN-${input.key}`,
      hex(`${input.key}1`),
      `checkin_${hex(input.key, 24)}`,
      `manifest/${hex(input.key, 24)}.json`,
      input.createdAt ?? AT,
      input.createdAt ?? AT,
      input.createdAt ?? AT,
      `WP-${input.key}`,
      `wpra_${hex(input.key, 24)}`,
      `slot_${input.key}`,
      input.requirement ?? "Finished roof, north slope",
      `device_${input.key}`,
      jobId,
      jobId,
      input.capturedAt ?? input.createdAt ?? AT,
    );
  raw
    .prepare(
      `INSERT INTO field_action_media
         (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
          content_length, r2_stored_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', 2048, ?)`,
    )
    .run(
      deviceActionId,
      `att_${hex(input.key, 24)}`,
      evidenceId,
      `evidence/${hex(input.key, 24)}.jpg`,
      hex(`${input.key}2`),
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
      session_expires_at: "2036-03-02T10:00:00.000Z",
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
  db: SqliteD1,
  jobId = DONE_JOB,
  who: AuthContext = auth("owner"),
  cursor?: string,
): Promise<Response> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/jobs/${encodeURIComponent(jobId)}/history${query}`,
    ),
    env(db),
    who,
  );
}

interface HistoryModel {
  job: {
    id: string;
    job_number: string | null;
    status: string | null;
    address: string | null;
  };
  customer: { display_name: string | null; phone: string | null } | null;
  proof: {
    items: Array<{ id: string; summary: string | null }>;
    next_cursor: string | null;
  };
  openable: boolean;
  proof_unavailable: boolean;
  allowed_actions: string[];
}

test("a finished job is readable where the live job route refuses it", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  const appEnv = env(db);

  const live = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/jobs/${DONE_JOB}`),
    appEnv,
    auth("owner"),
  );
  assert.equal(
    live.status,
    404,
    "the live packet must still refuse finished work",
  );

  const response = await history(db);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const model = (await response.json()) as HistoryModel;
  assert.equal(model.job.id, DONE_JOB);
  assert.equal(model.job.status, "Complete");
  assert.equal(
    model.job.address,
    "88 Riverbend Way, Calgary AB T2P 1A1, Canada",
  );
  assert.equal(model.customer?.display_name, "Northside Holdings");
  assert.equal(model.openable, false);
});

test("it carries the proof of what was done, after the assignment is long gone", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  seedEvidence(db, { key: "ab", requirement: "Finished roof, north slope" });
  seedEvidence(db, { key: "bc", requirement: "Tear-off complete" });
  const model = (await (await history(db)).json()) as HistoryModel;

  assert.equal(model.proof.items.length, 2);
  assert.deepEqual(model.proof.items.map((item) => item.summary).sort(), [
    "Finished roof, north slope",
    "Tear-off complete",
  ]);
  assert.equal(model.proof_unavailable, false);
});

test("a history read authorizes nothing", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  const model = (await (await history(db)).json()) as HistoryModel;

  assert.deepEqual(model.allowed_actions, []);
});

test("openable tracks what the live job route will actually open", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  seedJob(db, LIVE_JOB, "in_progress");
  const appEnv = env(db);

  for (const [jobId, expected] of [
    [DONE_JOB, false],
    [LIVE_JOB, true],
  ] as const) {
    const model = (await (await history(db, jobId)).json()) as HistoryModel;
    const live = await handleAuthenticatedRoute(
      new Request(`https://app.example.invalid/api/v1/jobs/${jobId}`),
      appEnv,
      auth("owner"),
    );
    assert.equal(model.openable, expected);
    assert.equal(
      model.openable,
      live.status === 200,
      `${jobId} disagreed with the live route`,
    );
  }
});

test("evidence from another job, and another tenant, stays there", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  seedJob(db, LIVE_JOB, "in_progress");
  seedJob(db, "JOB-THEIRS", "complete", "otherco");
  seedEvidence(db, { key: "ab", jobId: DONE_JOB, requirement: "Ours" });
  seedEvidence(db, { key: "bc", jobId: LIVE_JOB, requirement: "Another job" });
  seedEvidence(db, {
    key: "cd",
    jobId: "JOB-THEIRS",
    tenant: "otherco",
    requirement: "Theirs",
  });

  const model = (await (await history(db)).json()) as HistoryModel;
  assert.deepEqual(
    model.proof.items.map((item) => item.summary),
    ["Ours"],
  );
  // Naming their job from our session is a 404, not a peek.
  assert.equal((await history(db, "JOB-THEIRS")).status, 404);
});

test("a crew holding only jobs:read:assigned is refused", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  const response = await history(db, DONE_JOB, auth("field"));

  assert.equal(response.status, 403);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "job_read_any_required",
  );
});

test("an unknown job is a 404 and a bad cursor is refused", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");

  assert.equal((await history(db, "JOB-MISSING")).status, 404);
  assert.equal(
    (await history(db, DONE_JOB, auth("owner"), "not-a-cursor")).status,
    404,
  );
});

test("pages follow capture chronology even when old offline evidence arrives later", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  for (let index = 1; index <= 100; index++) {
    seedEvidence(db, {
      key: index.toString(16).padStart(4, "0"),
      requirement: "Late offline proof",
      createdAt: "2026-09-15T12:00:00.000Z",
      capturedAt: "2024-01-01T10:00:00.000Z",
    });
  }
  seedEvidence(db, {
    key: "ffff",
    requirement: "Most recent capture",
    createdAt: "2026-09-14T12:00:00.000Z",
    capturedAt: "2026-09-14T10:00:00.000Z",
  });
  const first = (await (await history(db)).json()) as HistoryModel;
  assert.equal(first.proof.items[0]?.summary, "Most recent capture");
  assert.equal(first.proof.items.length, 100);
  assert.equal(first.proof.next_cursor, "100");
  const second = (await (
    await history(db, DONE_JOB, auth("owner"), first.proof.next_cursor)
  ).json()) as HistoryModel;
  assert.equal(second.proof.items.length, 1);
  assert.equal(second.proof.items[0]?.summary, "Late offline proof");
  assert.equal(second.proof.next_cursor, null);
  assert.equal(
    new Set(
      [...first.proof.items, ...second.proof.items].map((item) => item.id),
    ).size,
    101,
  );
});

test("equal capture times page by the displayed evidence ID, independently of upload order", async () => {
  const db = new SqliteD1();
  seedJob(db, DONE_JOB, "complete");
  for (let index = 1; index <= 101; index++) {
    seedEvidence(db, {
      key: index.toString(16).padStart(4, "0"),
      createdAt: new Date(Date.parse(AT) + (102 - index) * 1000).toISOString(),
      capturedAt: AT,
    });
  }
  const first = (await (await history(db)).json()) as HistoryModel;
  assert.equal(first.proof.next_cursor, "100");
  const second = (await (
    await history(db, DONE_JOB, auth("owner"), first.proof.next_cursor)
  ).json()) as HistoryModel;
  const ids = [...first.proof.items, ...second.proof.items].map(
    (item) => item.id,
  );
  assert.equal(ids.length, 101);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => b.localeCompare(a)),
  );
  assert.equal(new Set(ids).size, ids.length);
});
