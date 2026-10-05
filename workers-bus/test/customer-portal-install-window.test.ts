import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { customerPortalResponseSchema } from "../../app/src/portal/portal-contracts.ts";
import type { AppEnv } from "../src/app-types.ts";
import { handleCustomerPortalResolve } from "../src/customer-portal.ts";
import {
  recordOperatingJobAssignment,
  type RecordOperatingJobAssignmentInput,
} from "../src/operating-job-assignment-store.ts";
import { createProductionScheduleApprovalRequest } from "../src/production-schedule-approval-store.ts";

const NOW = "2026-08-21T08:00:00.000Z";
const SAVED_AT = "2026-08-21T09:00:00.000Z";
const START = "2026-08-24T14:00:00.000Z";
const END = "2026-08-24T22:00:00.000Z";
const TOKEN = "a".repeat(43);
const LINK_ID = "portal_0123456789abcdef0123456789abcdef";
const ORIGIN = "https://portal.example.invalid";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw.prepare(sql));
  }
}

class SqliteStatement {
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(statement: StatementSync, args: unknown[] = []) {
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function seedJob(db: DatabaseSync, tenantId: string, suffix: string) {
  const roofJobId = `job:portal:${suffix}`;
  const customerId = `customer:portal:${suffix}`;
  const ownerId = `appu_owner_portal_${suffix}`;
  const workerId = `appu_field_portal_${suffix}`;
  const crewId = `crew:portal:${suffix}`;
  const envelopeId = `ow_portal_${suffix}`;
  const contactEmail = `portal-${suffix}@example.invalid`;
  for (const [userId, role] of [
    [ownerId, "owner"],
    [workerId, "field"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active,
       created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
    ).run(
      userId,
      tenantId,
      `${userId}@example.invalid`,
      userId,
      role,
      role,
      role === "field" ? `${userId}@example.invalid` : null,
      NOW,
      NOW,
    );
  }
  db.prepare(
    `INSERT INTO envelopes
    (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
     status, tenant_id, created_at, updated_at)
    VALUES (?, 'manual', 'Synthetic Portal Customer', ?, '{}', ?, ?,
            'reconciled', ?, ?, ?)`,
  ).run(envelopeId, contactEmail, `raw/portal/${suffix}.json`, NOW, tenantId, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_leads
    (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
     lifecycle_status, version, created_at, updated_at)
    VALUES (?, ?, ?, 'manual', 'Synthetic Portal Customer', ?,
            'qualified', 1, ?, ?)`,
  ).run(`lead:portal:${suffix}`, tenantId, envelopeId, contactEmail, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_customers
    (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
     lifecycle_status, version, created_at, updated_at)
    VALUES (?, ?, ?, 'Synthetic Portal Customer', ?, 'active', 1, ?, ?)`,
  ).run(customerId, tenantId, envelopeId, contactEmail, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_roof_jobs
    (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
     service_type, job_status, current_gate_state, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ironwrap', 'IW-SYNTHETIC', 'roof_replacement', 'qualified',
            'ready', 1, ?, ?)`,
  ).run(roofJobId, tenantId, `lead:portal:${suffix}`, customerId, envelopeId, NOW, NOW);
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    db.prepare(
      `INSERT INTO operating_production_gates
      (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state,
       owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, 'No active synthetic blocker', 1, ?, ?)`,
    ).run(
      `gate:portal:${suffix}:${gate}`,
      tenantId,
      roofJobId,
      envelopeId,
      gate,
      ownerId,
      NOW,
      START,
      NOW,
      NOW,
    );
  }
  db.prepare(
    `INSERT INTO fleet_crews
    (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
    VALUES (?, ?, 'Synthetic Portal Crew', 'Active', 1, ?, ?)`,
  ).run(crewId, tenantId, NOW, NOW);
  db.prepare(
    `INSERT INTO fleet_crew_members
    (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
  ).run(`membership:portal:${suffix}`, tenantId, crewId, workerId, NOW, NOW);
  return {
    roofJobId,
    customerId,
    ownerId,
    workerId,
    crewId,
    command: {
      tenantId,
      roofJobId,
      expectedRoofJobVersion: 1,
      crewId,
      expectedCrewVersion: 1,
      authorityRequirements: [
        {
          authority_record_id: `authority:portal:${suffix}`,
          subject_type: "Person",
          subject_role: "Worker",
          subject_ref: workerId,
          authority_kind: "Worker Competency",
          scope_type: "Roof Job",
          scope_ref: roofJobId,
          version: 1,
          state_digest_sha256: "c".repeat(64),
        },
      ],
      scheduledStart: START,
      scheduledEnd: END,
      actorUserId: ownerId,
      idempotencyKey: `portal:schedule:${suffix}:1`,
    } satisfies RecordOperatingJobAssignmentInput,
  };
}

type SeededJob = ReturnType<typeof seedJob>;

function fixture() {
  const db = new SqliteD1();
  const job = seedJob(db.raw, "ironwrap", "primary");
  db.raw
    .prepare(
      `INSERT INTO customer_portal_links
    (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
     created_at, expires_at, access_count, issued_ip_hash, issued_user_agent_hash)
    VALUES (?, ?, 'ironwrap', ?, ?, ?, ?, '2099-12-31T00:00:00.000Z', 0, ?, ?)`,
    )
    .run(
      LINK_ID,
      createHash("sha256").update(TOKEN).digest("hex"),
      job.roofJobId,
      job.customerId,
      job.ownerId,
      NOW,
      "d".repeat(64),
      "e".repeat(64),
    );
  const appEnv = {
    DB: db as never,
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED: "false",
    APP_CUSTOMER_PORTAL_DECISION_ENABLED: "false",
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: ORIGIN,
    APP_ALLOWED_ORIGINS: ORIGIN,
    APP_AUTH_PEPPER: "synthetic-portal-install-window-pepper-at-least-thirty-two",
  } as AppEnv;
  return { db, job, appEnv };
}

async function resolve(appEnv: AppEnv) {
  return await handleCustomerPortalResolve(
    new Request(`${ORIGIN}/api/v1/customer-portal/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token: TOKEN }),
    }),
    appEnv,
  );
}

async function portal(appEnv: AppEnv) {
  const response = await resolve(appEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return customerPortalResponseSchema.parse(await response.json());
}

async function proposeSchedule(appEnv: AppEnv, job: SeededJob) {
  return await createProductionScheduleApprovalRequest(appEnv, {
    id: "psapproval_portal_0001",
    tenantId: "ironwrap",
    prepareIdempotencyKey: "portal:tentative:0001",
    intentFingerprint: "f".repeat(64),
    actorUser: "production@example.invalid",
    siteId: "https://legacy.example.invalid",
    roofJobId: job.roofJobId,
    targetAssignmentId: "legacy-assignment-portal-0001",
    crewProfileId: "legacy-crew-portal-0001",
    scheduledStart: START,
    scheduledEnd: END,
    supersedesAssignmentId: null,
    correctionReason: null,
    requestText: "Synthetic uncommitted schedule proposal",
    writeArgsJson: "{}",
    previewJson: "{}",
    argsDigest: "a".repeat(64),
    previewDigest: "b".repeat(64),
    receiptPreviewDigest: "c".repeat(64),
    dryRunReceipt: "synthetic-private-receipt-".repeat(2),
    expiresAt: "2099-12-31T00:00:00.000Z",
    requestedByUserId: job.ownerId,
    requestedByFrappeUser: null,
    runId: "portal-schedule-run-0001",
    now: NOW,
  });
}

test("portal returns the office-committed native install window without crew or approval details", async () => {
  const { db, job, appEnv } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("portal schedule must not read a provider");
  };
  try {
    const saved = await recordOperatingJobAssignment(appEnv, job.command, new Date(SAVED_AT));
    const model = await portal(appEnv);
    assert.deepEqual(model.install_window, {
      scheduled_start: START,
      scheduled_end: END,
      confirmed: true,
      confirmation_basis: "office_committed_assignment",
    });
    assert.equal(model.source_updated_at, SAVED_AT);
    assert.equal(model.job.job_number, "IW-SYNTHETIC");
    assert.equal(model.proposal, null);
    assert.deepEqual(model.option_packages, []);
    for (const privateValue of [
      job.crewId,
      job.workerId,
      job.ownerId,
      saved.assignment.assignment_id,
      saved.assignment.authority_requirements_sha256,
    ]) {
      assert.equal(JSON.stringify(model).includes(privateValue!), false, `leaked ${privateValue}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    db.raw.close();
  }
});

test("portal rereads the current revision after a native schedule supersedes its predecessor", async () => {
  const { db, job, appEnv } = fixture();
  try {
    const first = await recordOperatingJobAssignment(appEnv, job.command, new Date(SAVED_AT));
    assert.equal((await portal(appEnv)).install_window?.scheduled_start, START);
    const changedAt = "2026-08-21T10:00:00.000Z";
    const revised = await recordOperatingJobAssignment(
      appEnv,
      {
        ...job.command,
        idempotencyKey: "portal:schedule:primary:2",
        scheduledStart: "2026-08-25T14:00:00.000Z",
        scheduledEnd: "2026-08-25T22:00:00.000Z",
        supersedesAssignmentId: first.assignment.assignment_id,
        correctionReason: "Synthetic dispatcher moved the install window.",
      },
      new Date(changedAt),
    );
    const model = await portal(appEnv);
    assert.equal(model.install_window?.scheduled_start, revised.assignment.scheduled_start);
    assert.equal(model.install_window?.scheduled_end, revised.assignment.scheduled_end);
    assert.equal(model.source_updated_at, changedAt);
    assert.equal(JSON.stringify(model).includes(START), false);
  } finally {
    db.raw.close();
  }
});

test("a committed start with no saved end stays an open-ended window", async () => {
  const { db, job, appEnv } = fixture();
  try {
    await recordOperatingJobAssignment(
      appEnv,
      { ...job.command, scheduledEnd: null },
      new Date(SAVED_AT),
    );
    const model = await portal(appEnv);
    assert.equal(model.install_window?.scheduled_start, START);
    assert.equal(model.install_window?.scheduled_end, null);
    assert.equal(model.install_window?.confirmed, true);
  } finally {
    db.raw.close();
  }
});

test("missing and tentative legacy approval data never becomes a customer install commitment", async () => {
  const { db, job, appEnv } = fixture();
  try {
    assert.equal((await portal(appEnv)).install_window, null);
    const proposal = await proposeSchedule(appEnv, job);
    assert.equal(proposal.kind, "created");
    assert.equal(proposal.request.state, "pending");
    const model = await portal(appEnv);
    assert.equal(model.install_window, null);
    assert.equal(model.source_updated_at, NOW);
    assert.equal(JSON.stringify(model).includes(START), false);
    assert.equal(JSON.stringify(model).includes("synthetic-private-receipt"), false);
  } finally {
    db.raw.close();
  }
});

test("another job and another tenant cannot supply the bound customer's window", async () => {
  const { db, appEnv } = fixture();
  try {
    const otherJob = seedJob(db.raw, "ironwrap", "other");
    const otherTenant = seedJob(db.raw, "iroof", "tenant");
    await recordOperatingJobAssignment(appEnv, otherJob.command, new Date(SAVED_AT));
    await recordOperatingJobAssignment(appEnv, otherTenant.command, new Date(SAVED_AT));
    assert.equal((await portal(appEnv)).install_window, null);
    const wrongTenant = await resolve({ ...appEnv, APP_TENANT_ID: "iroof" });
    assert.equal(wrongTenant.status, 404);
  } finally {
    db.raw.close();
  }
});

test("native identity guards and the portal refuse a mismatched customer binding", async () => {
  const { db, job, appEnv } = fixture();
  try {
    await recordOperatingJobAssignment(appEnv, job.command, new Date(SAVED_AT));
    const other = seedJob(db.raw, "ironwrap", "rebound");
    assert.throws(
      () =>
        db.raw
          .prepare(
            `UPDATE operating_roof_jobs SET customer_id = ?, version = version + 1
        WHERE tenant_id = 'ironwrap' AND roof_job_id = ?`,
          )
          .run(other.customerId, job.roofJobId),
      /operating_roof_jobs_identity_immutable/,
    );
    // A stale or mismatched capability cannot override the job's immutable customer identity.
    db.raw
      .prepare("UPDATE customer_portal_links SET customer_id = ? WHERE link_id = ?")
      .run(other.customerId, LINK_ID);
    assert.equal((await resolve(appEnv)).status, 404);
  } finally {
    db.raw.close();
  }
});

test("cancelled jobs and revoked capabilities do not expose a committed upcoming window", async () => {
  const { db, job, appEnv } = fixture();
  try {
    await recordOperatingJobAssignment(appEnv, job.command, new Date(SAVED_AT));
    db.raw
      .prepare(
        `UPDATE operating_roof_jobs SET job_status = 'cancelled', version = version + 1
      WHERE tenant_id = 'ironwrap' AND roof_job_id = ?`,
      )
      .run(job.roofJobId);
    assert.equal((await portal(appEnv)).install_window, null);
    db.raw
      .prepare("UPDATE customer_portal_links SET revoked_at = ? WHERE link_id = ?")
      .run(SAVED_AT, LINK_ID);
    assert.equal((await resolve(appEnv)).status, 404);
  } finally {
    db.raw.close();
  }
});

test("a native schedule read outage is unavailable instead of falsely absent", async () => {
  const { db, appEnv } = fixture();
  try {
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes("FROM operating_job_assignments"))
        throw new Error("synthetic schedule read outage");
      return prepare(sql);
    };
    const response = await resolve(appEnv);
    assert.equal(response.status, 503);
    assert.equal(
      db.raw.prepare("SELECT access_count FROM customer_portal_links").get()?.access_count,
      0,
    );
  } finally {
    db.raw.close();
  }
});
