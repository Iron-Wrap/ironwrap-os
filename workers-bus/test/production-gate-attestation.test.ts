// production-gate-attestation.test.ts - a person attests a gate with evidence or reverses one, and
// the office reads the gates (migration 0158).
//
// The route cases drive the real routes through a person's real cookie session and the real runway
// read into the ledger, and assert what the ledger, the gate row and the audit log hold afterwards.
// The D1 cases write SQL straight at the database, the way a defective writer would, and prove the
// re-created validate trigger refuses each rule the route reads first. A1's waiver and settlement
// cases stay in production-gate-clearance(s).test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  buildOwnerNowReadModel,
  STOP_JOB_UNKNOWN_TITLE,
  STOP_JOB_UNKNOWN_WHY,
  STOP_WORK_PACKAGE_UNKNOWN_TITLE,
  STOP_WORK_PACKAGE_UNKNOWN_WHY,
} from "../src/app-read-models.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import {
  permissionsForRole,
  ROLE_PERMISSIONS,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  parseEvidenceRefs,
  parseProductionGateAttestation,
  weatherRefusal,
  type WeatherAttestation,
} from "../src/production-gate-attestation.ts";
import {
  parseProductionGateReversal,
  PRODUCTION_GATE_SAFETY_PERMISSION,
  SITE_SAFETY_AUTHORITY_SCOPE,
} from "../src/production-gate-clearance.ts";
import { recordMakeSafe, recordSafetyResponse, reportSafetyOccurrence } from "../src/safety-lifecycle.ts";
import { endCancellationWindow } from "./production-gate-ledger-fixture.ts";

// Synthetic fixtures only: reserved example.invalid identities and run-relative times. D1 checks
// every time rule against its own clock, so the fixtures are relative to the real one.
const TENANT = "ironwrap";
const PEPPER = "synthetic-gate-attestation-pepper-0123456789";
const JOB = "job:attest:0001";
const OTHER_JOB = "job:attest:0002";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const NOTE = "Panels counted on the trailer against the delivery slip.";

const CLEARANCE = (gate: string, job = JOB) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/clearance`;
const REVERSALS = (gate: string, job = JOB) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/reversals`;
const DECISIONS = (gate: string, job = JOB) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/waiver-decisions`;
const GATES = (job = JOB) => `/api/v1/production/jobs/${encodeURIComponent(job)}/gates`;

const USERS = {
  owner: { id: "appu_owner_attest_01", role: "owner", access: "owner" },
  production: { id: "appu_production_attest", role: "ops", access: "production" },
  crewed: { id: "appu_production_crewed", role: "ops", access: "production" },
  ops: { id: "appu_ops_attest_0001", role: "ops", access: "ops" },
  seed: { id: "appu_seed_owner_attest", role: "owner", access: "owner" },
  field: { id: "appu_field_attest_001", role: "field", access: "field" },
} as const;
type User = (typeof USERS)[keyof typeof USERS];

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          async all<T>() {
            return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] };
          },
          async first<T>() {
            return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null;
          },
          async run() {
            return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...(values as never[])).changes) } };
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

interface Harness {
  env: AppEnv;
  db: TestD1;
  sqlite: DatabaseSync;
}

const gateId = (gate: string, job = JOB) => `gate:${job === JOB ? "attest" : "other"}:${gate.toLowerCase()}`;

function insertUser(db: DatabaseSync, user: User, createdBy = "owner@example.invalid") {
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    user.id, TENANT, `${user.id}@example.invalid`, `Synthetic ${user.access}`, user.role, user.access,
    user.role === "field" ? `${user.id}@example.invalid` : null, createdBy, at(-DAY), at(-DAY),
  );
}

function seedJob(db: DatabaseSync, jobId: string, suffix: string): void {
  const now = at(-DAY);
  const email = `attest-${suffix}@example.invalid`;
  db.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES (?, 'manual', 'Attest Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(`ow_gate_attest_${suffix}`, email, `raw/attest/${suffix}.json`, now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'Attest Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(`lead:attest:${suffix}`, TENANT, `ow_gate_attest_${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'Attest Customer', ?, 'active', 1, ?, ?)`,
  ).run(`customer:attest:${suffix}`, TENANT, `ow_gate_attest_${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
        service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ironwrap', ?, 'Roofing', 'qualified', 'blocked', 1, ?, ?)`,
  ).run(jobId, TENANT, `lead:attest:${suffix}`, `customer:attest:${suffix}`, `ow_gate_attest_${suffix}`, `IW-ATTEST-${suffix}`, now, now);
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    db.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'owner@example.invalid', ?, ?, 'No active blocker', ?, ?)`,
    ).run(gateId(gate, jobId), TENANT, jobId, `ow_gate_attest_${suffix}`, gate, now, at(7 * DAY), now, now);
  }
}

/**
 * The full migration chain, two jobs with six blocked gates each, and the people who touch them:
 * an owner and a production person, a production login that is also on a crew, ops, the QA seed
 * owner and a field worker on that crew.
 */
function setup(): Harness {
  const db = new TestD1();
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    db.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of Object.values(USERS)) {
    insertUser(db.sqlite, user, user === USERS.seed ? SEED_CREATED_BY : undefined);
  }
  seedJob(db.sqlite, JOB, "0001");
  seedJob(db.sqlite, OTHER_JOB, "0002");
  // The customers received their signed copies eleven days ago, so the OD-01 cancellation window,
  // which holds Materials (0160), has ended on both jobs.
  endCancellationWindow(db.sqlite, { tenantId: TENANT, roofJobId: JOB });
  endCancellationWindow(db.sqlite, { tenantId: TENANT, roofJobId: OTHER_JOB });
  db.sqlite.prepare(
    `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES ('crew:attest:0001', ?, 'Attest Crew', 'Active', 1, ?, ?)`,
  ).run(TENANT, at(-DAY), at(-DAY));
  for (const [membershipId, userId] of [
    ["membership:attest:field", USERS.field.id],
    ["membership:attest:crewed", USERS.crewed.id],
  ]) {
    db.sqlite.prepare(
      `INSERT INTO fleet_crew_members
         (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES (?, ?, 'crew:attest:0001', ?, 1, 1, ?, ?)`,
    ).run(membershipId, TENANT, userId, at(-DAY), at(-DAY));
  }
  const env = {
    DB: db as never,
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
    APP_TIME_ZONE: "America/Edmonton",
  } as AppEnv;
  return { env, db, sqlite: db.sqlite };
}

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function person(h: Harness, userId: string): Promise<AuthContext> {
  const token = randomToken();
  h.sqlite.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(await sessionHashFor(h.env, token), userId, TENANT, at(-60_000), at(HOUR), at(-60_000), "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    h.env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** A signed-in role without a person's cookie token: a connector, an agent host, a service token. */
function machine(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: at(-60_000),
      session_expires_at: at(HOUR),
      revoked_at: null,
      user_id: USERS.owner.id,
      tenant_id: TENANT,
      email_normalized: `${USERS.owner.id}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: at(-DAY),
      updated_at: at(-DAY),
    },
  };
}

let keyCounter = 0;
const nextKey = () => `gate-attest-key-${(++keyCounter).toString().padStart(12, "0")}`;

async function call(
  h: Harness,
  auth: AuthContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: { idempotency?: string | null; csrf?: string | null } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (method === "POST") {
    const csrf = options.csrf === undefined ? auth.csrfToken : options.csrf;
    if (csrf !== null) headers.set("x-csrf-token", csrf);
    if (options.idempotency !== null) headers.set("idempotency-key", options.idempotency ?? nextKey());
  }
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    h.env,
    auth,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function gateRow(db: DatabaseSync, gate: string, job = JOB): Record<string, unknown> {
  return {
    ...(db.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id,
              evidence_refs_json
         FROM operating_production_gates WHERE gate_id = ?`,
    ).get(gateId(gate, job)) as Record<string, unknown>),
  };
}

function ledgerRows(db: DatabaseSync): Array<Record<string, any>> {
  return db.prepare(
    `SELECT clearance_id, gate, entry_kind, basis, to_state, from_gate_version, reverses_id,
            actor_user_id, actor_role, attestation_json, evidence_refs_json, reason
       FROM production_gate_clearances ORDER BY gate, from_gate_version`,
  ).all().map((row) => ({ ...row }));
}

function auditRows(db: DatabaseSync, clearanceId: string): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT action, trigger, approved_by, reason, source_ids FROM audit_log WHERE run_id = ?",
  ).all(clearanceId).map((row) => ({ ...row }));
}

let fixtureCounter = 0;

interface Competency {
  readback_id: string;
  authority_record_id: string;
  authority_version: number;
  state_digest_sha256: string;
}

/** One internal Worker Competency readback, verified and in force unless a test says otherwise. */
function insertCompetency(
  db: DatabaseSync,
  personUser: string,
  overrides: Record<string, unknown> = {},
): Competency {
  fixtureCounter += 1;
  const row: Record<string, unknown> = {
    readback_id: `readback.attest.${fixtureCounter.toString().padStart(4, "0")}`,
    tenant_id: TENANT,
    authority_record_id: `competency_attest_${fixtureCounter.toString().padStart(4, "0")}`,
    authority_version: 1,
    subject_type: "Person",
    subject_role: "Worker",
    person_user: personUser,
    organization: null,
    authority_kind: "Worker Competency",
    authority_scope: SITE_SAFETY_AUTHORITY_SCOPE,
    scope_type: "Tenant",
    scope_ref: TENANT,
    roof_job: null,
    scope_json: "{}",
    issuer_name: TENANT,
    issuer_jurisdiction: "AB-CA",
    issuer_reference: "internal:competency:attest",
    issuer_source_version: "1",
    verification_state: "verified",
    evidence_refs_json: "[]",
    evidence_sha256: sha(`competency-evidence:${fixtureCounter}`),
    authority_state_digest_sha256: sha(`competency-state:${fixtureCounter}`),
    authority_effective_from: day(-30),
    authority_expires_at: day(365),
    authority_revoked_at: null,
    supersedes_authority_record_id: null,
    authority_verification_method: "Internal Competency Assessment",
    issuer_receipt_sha256: null,
    observed_by_user_id: USERS.owner.id,
    observed_at: at(-DAY),
    observation_fingerprint_sha256: sha(`competency-fingerprint:${fixtureCounter}`),
    action_id: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO authority_record_readbacks (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return {
    readback_id: String(row.readback_id),
    authority_record_id: String(row.authority_record_id),
    authority_version: Number(row.authority_version),
    state_digest_sha256: String(row.authority_state_digest_sha256),
  };
}

/** One verified, manifested, stored Work Package capture of a job; returns its media checksum. */
function insertCapture(
  db: DatabaseSync,
  evidenceId: string,
  options: { jobId?: string; status?: "verified" | "r2_stored"; capturedAt?: string } = {},
): string {
  const deviceActionId = `capture-${evidenceId.slice(4)}`;
  const status = options.status ?? "verified";
  const jobId = options.jobId ?? JOB;
  const capturedAt = options.capturedAt ?? at(-2 * HOUR);
  db.prepare(
    `INSERT INTO field_actions (
       device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind, payload_hash,
       status, checkin_id, manifest_key, response_json, created_at, updated_at, verified_at,
       work_package_id, work_package_version, evidence_slot_id, evidence_requirement,
       evidence_source, evidence_device_id, evidence_freshness, evidence_conflict_state,
       evidence_verification, evidence_disposition, work_package_release_attempt_id,
       work_object_type, work_object_id, physical_context_type, physical_context_id,
       capture_started_at, capture_completed_at
     ) VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?,
               'Site photographs', 'photo', 'device-synthetic-crew', 'Current', 'None',
               'Verified', 'Open', 'attempt-synthetic', 'Roof Job', ?, 'Roof Site', ?, ?, ?)`,
  ).run(
    deviceActionId, TENANT, USERS.field.id, jobId, `ASSIGN-${jobId}`, "a".repeat(64), status,
    `checkin_${deviceActionId}`, `evidence/${deviceActionId}.json`,
    status === "verified" ? '{"status":"verified"}' : null, capturedAt, capturedAt,
    status === "verified" ? capturedAt : null, `wp:attest:${jobId}`, `step:${evidenceId.slice(-8)}`,
    jobId, jobId,
    new Date(Date.parse(capturedAt) - 60_000).toISOString(), capturedAt,
  );
  const checksum = sha(`media:${evidenceId}`);
  db.prepare(
    `INSERT INTO field_action_media
       (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
        content_length, r2_stored_at)
     VALUES (?, ?, ?, ?, ?, 'image/jpeg', 128, ?)`,
  ).run(deviceActionId, `attachment-${deviceActionId}`, evidenceId, `evidence/raw/${deviceActionId}.jpg`, checksum, capturedAt);
  return checksum;
}

/**
 * One stock reservation of a job. The position, unit and command it points at are not what a gate
 * reads, so they are not built here: foreign keys are off for this one insert.
 */
function insertReservation(
  db: DatabaseSync,
  reservationId: string,
  options: { jobId?: string; status?: string; version?: number } = {},
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.prepare(
      `INSERT INTO inventory_reservations
         (reservation_id, tenant_id, position_id, job_id, work_package_id,
          reserved_quantity_scaled, issued_quantity_scaled, returned_quantity_scaled, uom_id,
          status, version, command_id, created_at, updated_at)
       VALUES (?, ?, 'position:attest:panels', ?, NULL, 40, 0, 0, 'uom:attest:each', ?, ?,
               'command:attest:reserve:0001', ?, ?)`,
    ).run(reservationId, TENANT, options.jobId ?? JOB, options.status ?? "reserved", options.version ?? 1, at(-DAY), at(-DAY));
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function insertMaterialException(db: DatabaseSync, status: "open" | "contained" | "resolved"): void {
  fixtureCounter += 1;
  db.prepare(
    `INSERT INTO inventory_exceptions
       (exception_id, tenant_id, exception_type, status, aggregate_type, aggregate_id, reason_code,
        expected_json, observed_json, evidence_refs_json, version, created_at, updated_at,
        resolved_at)
     VALUES (?, ?, 'shortage', ?, 'roof_job', ?, 'panel_shortage', '{}', '{}', '[]', 1, ?, ?, ?)`,
  ).run(`exception.attest.${fixtureCounter}`, TENANT, status, JOB, at(-HOUR), at(-HOUR), status === "resolved" ? at(-HOUR) : null);
}

/** One safety stop, active on this job unless a test names another scope or a released one. */
function insertSafetyStop(
  db: DatabaseSync,
  scope: { type?: string; id?: string; active?: 0 | 1 } = {},
): void {
  fixtureCounter += 1;
  const active = scope.active ?? 1;
  db.prepare(
    `INSERT INTO safety_occurrences
       (occurrence_id, tenant_id, occurrence_kind, severity, state, stop_active, scope_type,
        scope_id, reported_by_user_id, reported_at, summary, report_fingerprint_sha256,
        created_at, updated_at)
     VALUES (?, ?, 'hazard', 'high', ?, ?, ?, ?, ?, ?,
             'Synthetic hazard report for repository proof only.', ?, ?, ?)`,
  ).run(
    `occurrence.attest.${fixtureCounter}`, TENANT, active ? "reported" : "controlled", active,
    scope.type ?? "roof_job", scope.id ?? JOB, USERS.field.id, at(-HOUR), sha(`stop:${fixtureCounter}`),
    at(-HOUR), at(-HOUR),
  );
}

/** One version of a Work Package of a job, its definition mirroring its columns as 0096 requires. */
function workPackageFields(workPackageId: string, jobId: string, version: number, issuedAt: string) {
  return {
    work_package_id: workPackageId,
    tenant_id: TENANT,
    version,
    job_id: jobId,
    assignment_id: `assignment:${workPackageId}`,
    work_object_type: "Roof Job",
    work_object_id: jobId,
    physical_context_type: "Roof Site",
    physical_context_id: jobId,
    assignment_authority_user: null,
    assignment_authority_role: null,
    title: "Synthetic tear-off",
    objective: "Tear off the synthetic roof.",
    boundaries: "This synthetic roof only.",
    prerequisites: "The scheduling gates are ready.",
    expected_result: "The deck is exposed.",
    stop_conditions: "Stop on any hazard.",
    make_safe_procedure: "Cover the open deck.",
    issued_at: issuedAt,
    expires_at: at(7 * DAY),
    released_at: issuedAt,
    release_attempt_id: `attempt:${workPackageId}:${version}`,
    supersedes_id: null as string | null,
    correction_reason: null as string | null,
  };
}

function insertWorkPackageRow(
  db: DatabaseSync,
  fields: ReturnType<typeof workPackageFields>,
  definition: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    ...fields,
    status: "Released",
    definition_json: JSON.stringify({
      ...fields,
      assigned_workers: [{ sequence: 1, worker_user: USERS.field.id, worker_role: "Installer", required: true }],
      ...definition,
    }),
    created_at: fields.issued_at,
    updated_at: fields.issued_at,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO work_packages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
}

/** One released Work Package of a job, the row a work-package-scoped stop names. */
function insertWorkPackage(db: DatabaseSync, workPackageId: string, jobId: string): void {
  insertWorkPackageRow(db, workPackageFields(workPackageId, jobId, 1, at(-DAY)));
}

/**
 * Office reissue of version 1 as version 2 (0096): version 1 of the package is now Superseded. The
 * replacement may carry another package id, as 0096 admits, and then every row of the prior id is
 * Superseded.
 */
function supersedeWorkPackage(
  db: DatabaseSync,
  workPackageId: string,
  jobId: string,
  replacementId = workPackageId,
): void {
  const issuedAt = at(-HOUR);
  const reason = "Synthetic correction for repository proof only.";
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO work_package_supersessions
         (supersession_id, tenant_id, device_action_id, command_sha256, prior_work_package_id,
          prior_work_package_version, replacement_work_package_id, replacement_work_package_version,
          job_id, assignment_id, work_object_type, work_object_id, physical_context_type,
          physical_context_id, actor_user_id, actor_role, correction_reason, manifest_key,
          occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 2, ?, ?, 'Roof Job', ?, 'Roof Site', ?, ?, 'IronWrap Owner', ?, ?, ?, ?)`,
    ).run(
      `supersession:${workPackageId}`, TENANT, `supersede-${sha(workPackageId).slice(0, 24)}`,
      sha(`supersede:${workPackageId}`), workPackageId, replacementId, jobId, `assignment:${workPackageId}`,
      jobId, jobId, USERS.owner.id, reason, `work-packages/office-actions/${TENANT}/supersede.json`,
      issuedAt, issuedAt,
    );
    insertWorkPackageRow(
      db,
      {
        ...workPackageFields(replacementId, jobId, 2, issuedAt),
        assignment_id: `assignment:${workPackageId}`,
        supersedes_id: workPackageId,
        correction_reason: reason,
      },
      { supersedes_version: 1, issued_by_user: USERS.owner.id, issued_by_role: "IronWrap Owner" },
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The assigned field worker's stop_work on version 1 of a package (0094, 0097): the version is
 * Blocked until a release (0145) lifts it.
 */
function insertCrewStop(db: DatabaseSync, workPackageId: string, jobId: string): void {
  const occurredAt = at(-HOUR);
  db.prepare(
    `INSERT INTO work_package_events
       (event_id, tenant_id, work_package_id, work_package_version, job_id, assignment_id,
        work_object_type, work_object_id, physical_context_type, physical_context_id,
        release_attempt_id, event_kind, actor_user_id, actor_role, device_action_id, occurred_at,
        manifest_key, payload_json, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 'Roof Job', ?, 'Roof Site', ?, ?, 'stop_work', ?,
             'Installer', ?, ?, ?, '{}', ?)`,
  ).run(
    `wpe_stop_${sha(workPackageId).slice(0, 24)}`, TENANT, workPackageId, jobId, `assignment:${workPackageId}`,
    jobId, jobId, `attempt:${workPackageId}:1`, USERS.field.id, `stop-${sha(workPackageId).slice(0, 24)}`,
    occurredAt, `work-packages/field-actions/${TENANT}/stop.json`, occurredAt,
  );
}

/** The owner's release of that crew stop (0145, 0152), citing a capture taken after the stop. */
function releaseCrewStop(db: DatabaseSync, workPackageId: string, jobId: string): void {
  const evidenceId = `evi_${sha(`release:${workPackageId}`).slice(0, 32)}`;
  const checksum = insertCapture(db, evidenceId, { jobId, capturedAt: at(-30 * 60_000) });
  db.prepare(
    `INSERT INTO work_package_stop_releases
       (release_id, tenant_id, device_action_id, request_sha256, work_package_id,
        work_package_version, job_id, stop_event_id, stop_device_action_id, stop_actor_user_id,
        stop_reporter_user_id, restored_status, released_by_user_id, released_by_role,
        independence_json, evidence_refs_json, reason, manifest_key, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 'Released', ?, 'owner', ?, ?, ?, ?, ?)`,
  ).run(
    `wsr_${sha(`release-id:${workPackageId}`).slice(0, 32)}`, TENANT, `release-${sha(workPackageId).slice(0, 24)}`,
    sha(`release-request:${workPackageId}`), workPackageId, jobId, `wpe_stop_${sha(workPackageId).slice(0, 24)}`,
    `stop-${sha(workPackageId).slice(0, 24)}`, USERS.field.id, USERS.owner.id,
    JSON.stringify({ released_by_is_stop_actor: false, released_by_is_stop_reporter: false, released_in_person_session: true }),
    JSON.stringify([{ ref: `field-evidence://${evidenceId}`, sha256: checksum }]),
    "Synthetic release after the anchor was replaced, for repository proof only.",
    `work-packages/stop-releases/${TENANT}/release.json`, at(-10 * 60_000),
  );
}

/** Each gate's attestation as a person sends it, built fresh so its times follow the clock. */
const SENT = {
  Materials: () => ({ source: "supplier_delivery", reference: "DEL-2026/0042" }),
  Access: () => ({
    confirmed_with: "property_manager",
    confirmed_at: at(-2 * HOUR),
    constraints: ["pets", "parking"],
  }),
  Weather: () => ({
    window_start: at(DAY),
    window_end: at(4 * DAY),
    forecast_source: "weather.gc.ca",
    forecast_observed_at: at(-3 * HOUR),
  }),
  Safety: () => ({
    hazard_assessment_ref: "FLHA-2026-0042",
    permit: { answer: "needed_and_held", number: "building permit 4417" },
    fall_protection: { plan_ref: "FPP#42" },
    assessed_at: at(-HOUR),
  }),
} as const;
type AttestedGate = keyof typeof SENT;

const attest = (gate: AttestedGate, version = 1, extra: Record<string, unknown> = {}) => ({
  basis: "person_attestation",
  expected_gate_version: version,
  attestation: SENT[gate](),
  ...extra,
});

function refused(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

// --- Routes -----------------------------------------------------------------------------------

test("a person attests Materials, Access, Weather and Safety; each entry readies its gate with one audit row", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  // The competency names the worker by email, another of the attester's login coordinates.
  const competency = insertCompetency(h.sqlite, `${USERS.production.id}@example.invalid`);
  const evidenceId = `evi_${"a1".repeat(16)}`;
  const checksum = insertCapture(h.sqlite, evidenceId);
  insertReservation(h.sqlite, "reservation.attest.0001");

  const bodies = {
    Materials: attest("Materials", 1, {
      attestation: { ...SENT.Materials(), notes: `  ${NOTE}  ` },
      evidence_refs: [`field-evidence://${evidenceId}`, "stock-reservation://reservation.attest.0001"],
    }),
    Access: attest("Access"),
    Weather: attest("Weather"),
    Safety: attest("Safety", 1, { evidence_refs: [`field-evidence://${evidenceId}`] }),
  };
  for (const [gate, body] of Object.entries(bodies)) {
    const key = `attest-${gate.toLowerCase()}-key-00000001`;
    const result = await call(h, production, "POST", CLEARANCE(gate), body, { idempotency: key });
    assert.equal(result.status, 200, `${gate}: ${JSON.stringify(result.body)}`);
    const { entry } = result.body;
    assert.deepEqual(
      { kind: entry.kind, basis: entry.basis, to_state: entry.to_state, from: entry.from_gate_version, role: entry.actor_role },
      { kind: "clear", basis: "person_attestation", to_state: "ready", from: 1, role: "production" },
      gate,
    );
    assert.deepEqual(result.body.gate, { name: gateId(gate), gate, roof_job: JOB, state: "ready", version: 2 });
    assert.equal(result.body.replayed, false);
    assert.ok(!("actor_user_id" in entry), "the projection names a role, not a person");
    assert.deepEqual(gateRow(h.sqlite, gate), {
      state: "ready",
      version: 2,
      clearance_basis: null,
      clearance_decision_id: entry.id,
      cleared_by_user_id: USERS.production.id,
      evidence_refs_json: JSON.stringify(entry.evidence_refs),
    });
    assert.deepEqual(auditRows(h.sqlite, entry.id), [{
      action: "clear:person_attestation",
      trigger: "person",
      approved_by: USERS.production.id,
      reason: null,
      source_ids: `job:${JOB},gate:${gate},from_version:1,to_state:ready`,
    }]);
    // An exact replay answers as the first request did and appends nothing.
    const replay = await call(h, production, "POST", CLEARANCE(gate), body, { idempotency: key });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { ...result.body, replayed: true });
  }

  const [materials, access, safety, weather] = ["Materials", "Access", "Safety", "Weather"]
    .map((gate) => ledgerRows(h.sqlite).find((row) => row.gate === gate)!);
  // The note is the only free text and lives in the redactable reason, trimmed; the structured
  // attestation never carries it.
  assert.equal(materials.reason, NOTE);
  assert.deepEqual(JSON.parse(materials.attestation_json), SENT.Materials());
  // The client sent ids; the Worker resolved each one and took its checksum.
  const evidence = JSON.parse(materials.evidence_refs_json) as Array<Record<string, unknown>>;
  assert.deepEqual(evidence[0], { ref: `field-evidence://${evidenceId}`, sha256: checksum });
  assert.equal(evidence[1]!.ref, "stock-reservation://reservation.attest.0001");
  assert.equal(evidence[1]!.version, 1);
  assert.match(String(evidence[1]!.sha256), /^[0-9a-f]{64}$/);
  // An empty constraint list and an absent one are the same fact, stored once, sorted.
  assert.deepEqual(JSON.parse(access.attestation_json).constraints, ["parking", "pets"]);
  assert.equal(JSON.parse(weather.attestation_json).forecast_source, "weather.gc.ca");
  // Safety names the attester's current competency, bound by the Worker.
  assert.deepEqual(JSON.parse(safety.attestation_json).competency, competency);
  assert.equal(ledgerRows(h.sqlite).length, 4);
  assert.equal(
    (h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE automation = 'production_gate_clearance'").get() as { n: number }).n,
    4,
  );
});

test("a person's entry takes D1's clock, as the policy's entries do, not the Worker's", async (t) => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const body = attest("Materials");
  // The Worker's clock runs 30 minutes ahead of D1's for this one request.
  const realNow = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: realNow + 30 * 60_000 });
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call(h, production, "POST", CLEARANCE("Materials"), body);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const stored = h.sqlite.prepare("SELECT created_at FROM production_gate_clearances").get() as { created_at: string };
  assert.ok(Math.abs(Date.parse(stored.created_at) - realNow) < 60_000, stored.created_at);
  assert.equal(result.body.entry.created_at, stored.created_at);
});

test("an attestation is idempotent, version-checked and refused on a gate that is not blocked", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const body = attest("Access");
  const first = await call(h, production, "POST", CLEARANCE("Access"), body, { idempotency: "attest-access-replay-00001" });
  assert.equal(first.status, 200);
  const changed = await call(h, production, "POST", CLEARANCE("Access"), attest("Access", 1, {
    attestation: { ...SENT.Access(), confirmed_with: "customer" },
  }), { idempotency: "attest-access-replay-00001" });
  assert.deepEqual([changed.status, changed.body.error], [409, "production_gate_clearance_replay_conflict"]);
  const again = await call(h, production, "POST", CLEARANCE("Access"), attest("Access", 2));
  assert.deepEqual([again.status, again.body.error], [409, "production_gate_already_cleared"]);
  const stale = await call(h, production, "POST", CLEARANCE("Weather"), attest("Weather", 2));
  assert.deepEqual([stale.status, stale.body.error], [409, "production_gate_version_conflict"]);
  assert.equal(ledgerRows(h.sqlite).length, 1);
});

test("only Materials, Safety, Access and Weather are attested, in exactly their typed shape", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  for (const gate of ["Deposit", "Crew"]) {
    const result = await call(h, owner, "POST", CLEARANCE(gate), attest("Materials"));
    assert.deepEqual([result.status, result.body.error], [409, "production_gate_not_attestable"], gate);
  }
  const completion = await call(h, owner, "POST", CLEARANCE("Completion"), attest("Materials"));
  assert.deepEqual([completion.status, completion.body.error], [400, "invalid_production_gate_clearance"]);
  for (const body of [
    attest("Materials", 1, { reason: "A reason is not part of an attestation." }),
    attest("Materials", 1, { attestation: { ...SENT.Materials(), description: "free text" } }),
    attest("Materials", 1, { attestation: { source: "found_on_site", reference: "DEL-1" } }),
    attest("Materials", 1, { attestation: { source: "supplier_delivery", reference: "the panels came on Tuesday" } }),
    attest("Materials", 1, { attestation: { ...SENT.Materials(), notes: "x".repeat(301) } }),
    attest("Materials", 1, { expected_gate_version: "1" }),
    attest("Materials", 1, { evidence_refs: ["https://example.invalid/photo.jpg"] }),
    { basis: "person_attestation", attestation: SENT.Materials() },
  ]) {
    const result = await call(h, owner, "POST", CLEARANCE("Materials"), body);
    assert.deepEqual([result.status, result.body.error], [400, "production_gate_attestation_invalid"], JSON.stringify(body));
  }
  const future = await call(h, owner, "POST", CLEARANCE("Access"), attest("Access", 1, {
    attestation: { ...SENT.Access(), confirmed_at: at(HOUR) },
  }));
  assert.deepEqual([future.status, future.body.error], [400, "production_gate_attestation_invalid"]);
  const ops = await person(h, USERS.ops.id);
  const forbidden = await call(h, ops, "POST", CLEARANCE("Materials"), attest("Materials"));
  assert.deepEqual([forbidden.status, forbidden.body.error], [403, "production_gate_clearance_forbidden"]);
  const elsewhere = await call(h, owner, "POST", CLEARANCE("Materials", "job:not-on-runway"), attest("Materials"));
  assert.deepEqual([elsewhere.status, elsewhere.body.error], [409, "production_gate_job_not_on_runway"]);
  assert.deepEqual(ledgerRows(h.sqlite), []);
});

test("a crew member and the QA seed owner are refused, and an agent or connector session never attests or reverses", async () => {
  const h = setup();
  const crewed = await person(h, USERS.crewed.id);
  const onCrew = await call(h, crewed, "POST", CLEARANCE("Materials"), attest("Materials"));
  assert.deepEqual([onCrew.status, onCrew.body.error], [403, "production_gate_attester_on_crew"]);
  const seed = await person(h, USERS.seed.id);
  const seeded = await call(h, seed, "POST", CLEARANCE("Access"), attest("Access"));
  assert.deepEqual([seeded.status, seeded.body.error], [403, "production_gate_clearance_seed_identity_refused"]);
  const owner = await person(h, USERS.owner.id);
  for (const path of [CLEARANCE("Weather"), REVERSALS("Weather")]) {
    const body = path.endsWith("clearance")
      ? attest("Weather")
      : { expected_gate_version: 1, reverses_id: `pgc_${"0".repeat(40)}`, reason: "An agent may never reverse a gate." };
    const agent = await call(h, machine("owner"), "POST", path, body);
    assert.deepEqual([agent.status, agent.body.error], [403, "person_session_required"], path);
    // CSRF is read before the person: a forged or missing token is refused as such, from a person
    // and from a session that is no person alike.
    for (const [auth, csrf] of [[owner, "forged"], [owner, null], [machine("owner"), "forged"]] as const) {
      const result = await call(h, auth, "POST", path, body, { csrf });
      assert.deepEqual([result.status, result.body.error], [403, "csrf_failed"], `${path} ${String(csrf)}`);
    }
  }
  assert.deepEqual(ledgerRows(h.sqlite), []);
  for (const gate of ["Materials", "Access", "Weather"]) {
    assert.deepEqual({ state: gateRow(h.sqlite, gate).state, version: gateRow(h.sqlite, gate).version }, { state: "blocked", version: 1 });
  }
});

test("Safety needs the attester's current competency and no active stop on the job", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const refusedWith = async (code: string, status = 403) => {
    const result = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
    assert.deepEqual([result.status, result.body.error], [status, code]);
  };
  // No record at all, then records that are not current for this person and this job.
  await refusedWith("production_gate_competency_required");
  insertCompetency(h.sqlite, USERS.production.id, { authority_expires_at: day(-1) });
  insertCompetency(h.sqlite, USERS.production.id, { roof_job: OTHER_JOB, scope_type: "Roof Job", scope_ref: OTHER_JOB });
  insertCompetency(h.sqlite, USERS.production.id, { verification_state: "unavailable", authority_verification_method: null });
  // A current competency in another field, or with no scope at all, is not one in site safety.
  insertCompetency(h.sqlite, USERS.production.id, { authority_scope: "roofing-installation" });
  insertCompetency(h.sqlite, USERS.production.id, { authority_scope: null });
  insertCompetency(h.sqlite, USERS.production.id, { authority_scope: "" });
  insertCompetency(h.sqlite, USERS.production.id, { authority_scope: "Site Safety" });
  insertCompetency(h.sqlite, USERS.owner.id);
  const superseded = insertCompetency(h.sqlite, USERS.production.id);
  insertCompetency(h.sqlite, USERS.production.id, {
    authority_version: 2,
    supersedes_authority_record_id: superseded.authority_record_id,
    verification_state: "revoked",
    authority_revoked_at: at(-HOUR).replace(/\.\d{3}Z$/, "Z"),
  });
  await refusedWith("production_gate_competency_required");

  insertCompetency(h.sqlite, USERS.production.id, { roof_job: JOB, scope_type: "Roof Job", scope_ref: JOB });
  insertSafetyStop(h.sqlite);
  await refusedWith("production_gate_safety_stop_active", 409);
  // A stop on another job does not hold this one.
  const h2 = setup();
  const production2 = await person(h2, USERS.production.id);
  const current2 = insertCompetency(h2.sqlite, USERS.production.id, { roof_job: JOB, scope_type: "Roof Job", scope_ref: JOB });
  insertSafetyStop(h2.sqlite, { id: OTHER_JOB });
  const cleared = await call(h2, production2, "POST", CLEARANCE("Safety"), attest("Safety", 1, {
    attestation: { ...SENT.Safety(), fall_protection: { no_exposure_at_3m: true } },
  }));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.entry.attestation.competency, current2);
  assert.deepEqual(cleared.body.entry.attestation.fall_protection, { no_exposure_at_3m: true });
  assert.equal(gateRow(h.sqlite, "Safety").state, "blocked");
  // Safety is never waived, whoever asks.
  const owner = await person(h2, USERS.owner.id);
  const waiver = await call(h2, owner, "POST", CLEARANCE("Safety"), {
    basis: "office_waiver",
    reason: "Nobody may waive the safety gate, not even the owner.",
  });
  assert.deepEqual([waiver.status, waiver.body.error], [409, "production_gate_not_waivable"]);
});

test("Safety's permit is held with its number or not needed; unknown is refused by name, on the route and in D1", async () => {
  const withPermit = (permit: unknown) => ({ ...SENT.Safety(), permit });
  for (const [label, permit, refusal] of [
    ["held with its number", { answer: "needed_and_held", number: "building permit 4417" }, null],
    ["not needed", { answer: "not_needed" }, null],
    ["held without a number", { answer: "needed_and_held" }, [400, "production_gate_attestation_invalid"]],
    ["unknown", { answer: "unknown" }, [409, "production_gate_safety_permit_unknown"]],
    ["no permit answer", undefined, [400, "production_gate_attestation_invalid"]],
  ] as const) {
    // Through a person's session.
    const h = setup();
    const production = await person(h, USERS.production.id);
    insertCompetency(h.sqlite, USERS.production.id);
    const routed = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety", 1, {
      attestation: withPermit(permit),
    }));
    if (refusal) {
      assert.deepEqual([routed.status, routed.body.error], refusal, label);
      assert.deepEqual({ state: gateRow(h.sqlite, "Safety").state, entries: ledgerRows(h.sqlite).length }, { state: "blocked", entries: 0 }, label);
    } else {
      assert.equal(routed.status, 200, `${label}: ${JSON.stringify(routed.body)}`);
      assert.deepEqual(routed.body.entry.attestation.permit, permit, label);
      assert.equal(gateRow(h.sqlite, "Safety").state, "ready", label);
    }
    // Straight at D1, as a writer that skipped the route would.
    const { sqlite: db } = setup();
    const competency = insertCompetency(db, USERS.production.id);
    const write = () => append(db, { gate: "Safety", attestation_json: JSON.stringify({ ...withPermit(permit), competency }) });
    if (refusal) {
      refused(write, refusal[1]);
      assert.equal(gateRow(db, "Safety").state, "blocked", label);
    } else {
      write();
      assert.equal(gateRow(db, "Safety").state, "ready", label);
    }
  }
});

/**
 * Production holds a current `site_safety` competency and attests Safety twice: through the route,
 * and straight at D1 as a writer that skipped the route would. Both are refused by the stop, and
 * the gate stays blocked.
 */
async function assertSafetyHeldByStop(
  h: Harness,
  code = "production_gate_safety_stop_active",
): Promise<void> {
  const production = await person(h, USERS.production.id);
  const competency = insertCompetency(h.sqlite, USERS.production.id);
  const route = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
  assert.deepEqual([route.status, route.body.error], [409, code]);
  refused(
    () => append(h.sqlite, { gate: "Safety", attestation_json: safetyStored(competency) }),
    code,
  );
  assert.deepEqual({ state: gateRow(h.sqlite, "Safety").state, entries: ledgerRows(h.sqlite).length }, { state: "blocked", entries: 0 });
}

test("an active stop on the job holds Safety, on the route and in D1", async () => {
  const h = setup();
  insertSafetyStop(h.sqlite, { type: "roof_job", id: JOB });
  await assertSafetyHeldByStop(h);
});

test("a tenant stop holds Safety, on the route and in D1", async () => {
  const h = setup();
  insertSafetyStop(h.sqlite, { type: "tenant", id: TENANT });
  await assertSafetyHeldByStop(h);
});

test("a work_package stop on one of the job's packages holds Safety, Superseded included, on the route and in D1", async () => {
  const h = setup();
  insertWorkPackage(h.sqlite, "wp:attest:tear-off", JOB);
  insertSafetyStop(h.sqlite, { type: "work_package", id: "wp:attest:tear-off" });
  await assertSafetyHeldByStop(h);
  // A stop on a package that was reissued under another id still names this job's package, though
  // its only row is Superseded.
  const superseded = setup();
  insertWorkPackage(superseded.sqlite, "wp:attest:reissued", JOB);
  supersedeWorkPackage(superseded.sqlite, "wp:attest:reissued", JOB, "wp:attest:reissued-2");
  assert.deepEqual(
    superseded.sqlite.prepare("SELECT version, status FROM work_packages WHERE work_package_id = ?")
      .all("wp:attest:reissued").map((row) => ({ ...row })),
    [{ version: 1, status: "Superseded" }],
  );
  insertSafetyStop(superseded.sqlite, { type: "work_package", id: "wp:attest:reissued" });
  await assertSafetyHeldByStop(superseded);
});

test("a crew stop_work that no release has lifted holds Safety, on the route and in D1", async () => {
  const h = setup();
  insertWorkPackage(h.sqlite, "wp:attest:stopped", JOB);
  insertCrewStop(h.sqlite, "wp:attest:stopped", JOB);
  assert.equal(
    (h.sqlite.prepare("SELECT status FROM work_packages WHERE work_package_id = ?")
      .get("wp:attest:stopped") as { status: string }).status,
    "Blocked",
  );
  // No safety occurrence exists: the crew's own stop is the stop.
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM safety_occurrences").get() as { n: number }).n, 0);
  await assertSafetyHeldByStop(h);
});

/**
 * A stop of a scope type 0047's CHECK does not admit today, as a later migration might add one: the
 * CHECK is lifted for this one insert, so the gate rule meets a type it does not know.
 */
function insertUnknownScopeStop(db: DatabaseSync): void {
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    insertSafetyStop(db, { type: "crane", id: "crane:attest:0001" });
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

test("an unresolvable stop scope holds Safety, on the route and in D1", async () => {
  // A work_package stop naming a package this tenant does not have maps to no job: it may be this
  // job's, so it holds, under its own code (0159).
  const h = setup();
  insertSafetyStop(h.sqlite, { type: "work_package", id: "wp:attest:unknown" });
  await assertSafetyHeldByStop(h, "production_gate_stop_work_package_unknown");
  // A scope type the rule does not know may cover this job, so it holds too.
  const unknownType = setup();
  insertUnknownScopeStop(unknownType.sqlite);
  assert.equal(
    (unknownType.sqlite.prepare("SELECT scope_type FROM safety_occurrences").get() as { scope_type: string }).scope_type,
    "crane",
  );
  await assertSafetyHeldByStop(unknownType);
});

test("a stop on a job the tenant does not have is recorded, holds Safety on every job until it is lifted, and is on the owner's list", async () => {
  const h = setup();
  const occurrenceId = "occurrence.attest.unknown-job";
  const step = (minutesAgo: number) => at(-minutesAgo * 60_000);
  const reportedAt = step(50);
  // A person may always stop work: the stop is recorded though no job of the tenant has this id
  // (here the job's number, not its id).
  const reported = await reportSafetyOccurrence(h.env, {
    occurrenceId,
    tenantId: TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope: { type: "roof_job", id: "IW-ATTEST-0001" },
    reportedByUserId: USERS.field.id,
    reportedAt,
    summary: "Synthetic hazard on a mistyped job, for repository proof only.",
    rescueRequired: false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: reportedAt,
  });
  assert.equal(reported.kind, "reported");
  // The owner's exception list shows it in Track B's final copy, never the raw job id, with who
  // raised it, when, and what they wrote; it has no job and no next step.
  const owner = await person(h, USERS.owner.id);
  const listed = async () => (await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind === "stop_job_unknown");
  assert.deepEqual(await listed(), [{
    id: occurrenceId,
    kind: "stop_job_unknown",
    severity: null,
    title: "This work stop names a job that doesn\u2019t exist",
    // From A4 (0159) the stop holds every schedule as well, so the item says both.
    why: "Safety and scheduling stay held on every job while this work stop is active.",
    next_action: null,
    job_id: null,
    occurred_at: reportedAt,
    due_at: null,
    received_at: null,
    bus_status: null,
    triage_status: null,
    mctb: null,
    reported_by_name: "Synthetic field",
    summary: "Synthetic hazard on a mistyped job, for repository proof only.",
  }]);
  assert.ok(!JSON.stringify(await listed()).includes("IW-ATTEST-0001"), "the raw job id is not shown");
  // It holds Safety on every job of the tenant: on the route by name, with the stop to open, and
  // in D1.
  const production = await person(h, USERS.production.id);
  const competency = insertCompetency(h.sqlite, USERS.production.id);
  for (const job of [JOB, OTHER_JOB]) {
    const routed = await call(h, production, "POST", CLEARANCE("Safety", job), attest("Safety"));
    assert.deepEqual(
      [routed.status, routed.body.error, routed.body.stop_id],
      [409, "production_gate_stop_job_unknown", occurrenceId],
      job,
    );
    refused(
      () => append(h.sqlite, {
        gate: "Safety",
        gate_id: gateId("Safety", job),
        roof_job_id: job,
        attestation_json: safetyStored(competency),
      }),
      "production_gate_stop_job_unknown",
    );
  }
  // A stop's scope cannot be corrected (0047 keeps it immutable), so the stop is recorded again on
  // the job it is for and the mistyped one is lifted through its lifecycle.
  insertSafetyStop(h.sqlite, { type: "roof_job", id: OTHER_JOB });
  await recordMakeSafe(h.env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: USERS.field.id,
    detail: "Area taped off.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: step(40),
    now: step(40),
  });
  for (const [command, minutesAgo] of [["investigation_opened", 30], ["controlled", 20], ["released", 10]] as const) {
    await recordSafetyResponse(h.env, {
      tenantId: TENANT,
      occurrenceId,
      actorUserId: USERS.production.id,
      command,
      detail: "Synthetic response for repository proof only.",
      evidence: null,
      now: step(minutesAgo),
    });
  }
  // The lifted stop leaves the owner's list, and a real job's stop never joins it.
  assert.deepEqual(await listed(), []);
  // The hold drops to the one job the stop is for, on the route and in D1.
  const other = await call(h, production, "POST", CLEARANCE("Safety", OTHER_JOB), attest("Safety"));
  assert.deepEqual([other.status, other.body.error], [409, "production_gate_safety_stop_active"]);
  refused(
    () => append(h.sqlite, {
      gate: "Safety",
      gate_id: gateId("Safety", OTHER_JOB),
      roof_job_id: OTHER_JOB,
      attestation_json: safetyStored(competency),
    }),
    "production_gate_safety_stop_active",
  );
  const cleared = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});

test("a stop on a work package the tenant does not have is recorded, holds Safety on every job until it is lifted, and is on the owner's list", async () => {
  const h = setup();
  const occurrenceId = "occurrence.attest.unknown-package";
  const step = (minutesAgo: number) => at(-minutesAgo * 60_000);
  const reportedAt = step(50);
  // The tenant has a real package, on the other job, so every read must match the stop's package
  // id, not merely find the tenant without packages.
  insertWorkPackage(h.sqlite, "wp:attest:real", OTHER_JOB);
  // A person may always stop work: the stop is recorded though no Work Package of the tenant has
  // this id.
  const reported = await reportSafetyOccurrence(h.env, {
    occurrenceId,
    tenantId: TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope: { type: "work_package", id: "wp:attest:mistyped" },
    reportedByUserId: USERS.field.id,
    reportedAt,
    summary: "Synthetic hazard on a mistyped job plan, for repository proof only.",
    rescueRequired: false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: reportedAt,
  });
  assert.equal(reported.kind, "reported");
  // The owner's exception list shows it in Track B's final copy: the screen says "job plan", never
  // "work package", and never the raw package id; with who raised it, when, and what they wrote;
  // no job and no next step.
  const owner = await person(h, USERS.owner.id);
  const listed = async () => (await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind === "stop_work_package_unknown");
  assert.deepEqual(await listed(), [{
    id: occurrenceId,
    kind: "stop_work_package_unknown",
    severity: null,
    title: "This work stop names a job plan that doesn\u2019t exist",
    why: "Safety and scheduling stay held on every job while this work stop is active.",
    next_action: null,
    job_id: null,
    occurred_at: reportedAt,
    due_at: null,
    received_at: null,
    bus_status: null,
    triage_status: null,
    mctb: null,
    reported_by_name: "Synthetic field",
    summary: "Synthetic hazard on a mistyped job plan, for repository proof only.",
  }]);
  const shown = JSON.stringify((await listed()).map(({ title, why }) => ({ title, why })));
  assert.ok(!/work package/i.test(shown), "the item says job plan, never work package");
  assert.ok(!JSON.stringify(await listed()).includes("wp:attest:mistyped"), "the raw package id is not shown");
  // It holds Safety on every job of the tenant: on the route by name, with the stop to open, and
  // in D1.
  const production = await person(h, USERS.production.id);
  const competency = insertCompetency(h.sqlite, USERS.production.id);
  for (const job of [JOB, OTHER_JOB]) {
    const routed = await call(h, production, "POST", CLEARANCE("Safety", job), attest("Safety"));
    assert.deepEqual(
      [routed.status, routed.body.error, routed.body.stop_id],
      [409, "production_gate_stop_work_package_unknown", occurrenceId],
      job,
    );
    refused(
      () => append(h.sqlite, {
        gate: "Safety",
        gate_id: gateId("Safety", job),
        roof_job_id: job,
        attestation_json: safetyStored(competency),
      }),
      "production_gate_stop_work_package_unknown",
    );
  }
  // A stop's scope cannot be corrected (0047 keeps it immutable), so the stop is recorded again on
  // the real package, the other job's, and the mistyped one is lifted through its lifecycle.
  insertSafetyStop(h.sqlite, { type: "work_package", id: "wp:attest:real" });
  await recordMakeSafe(h.env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: USERS.field.id,
    detail: "Area taped off.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: step(40),
    now: step(40),
  });
  for (const [command, minutesAgo] of [["investigation_opened", 30], ["controlled", 20], ["released", 10]] as const) {
    await recordSafetyResponse(h.env, {
      tenantId: TENANT,
      occurrenceId,
      actorUserId: USERS.production.id,
      command,
      detail: "Synthetic response for repository proof only.",
      evidence: null,
      now: step(minutesAgo),
    });
  }
  // The lifted stop leaves the owner's list, and a real package's stop never joins it.
  assert.deepEqual(await listed(), []);
  // The hold narrows to the one job whose package the stop is on, on the route and in D1.
  const other = await call(h, production, "POST", CLEARANCE("Safety", OTHER_JOB), attest("Safety"));
  assert.deepEqual([other.status, other.body.error], [409, "production_gate_safety_stop_active"]);
  refused(
    () => append(h.sqlite, {
      gate: "Safety",
      gate_id: gateId("Safety", OTHER_JOB),
      roof_job_id: OTHER_JOB,
      attestation_json: safetyStored(competency),
    }),
    "production_gate_safety_stop_active",
  );
  const cleared = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});

test("the owner's item for a work stop on a job that doesn't exist names who raised it, or null, and keeps the summary raw", async () => {
  const h = setup();
  // A login whose display name is blank has no name to show.
  h.sqlite.prepare("UPDATE app_users SET display_name = ' ' WHERE user_id = ?").run(USERS.ops.id);
  const report = (occurrenceId: string, reportedByUserId: string, minutesAgo: number, summary: string) =>
    reportSafetyOccurrence(h.env, {
      occurrenceId,
      tenantId: TENANT,
      occurrenceKind: "hazard",
      severity: "high",
      scope: { type: "roof_job", id: `IW-MISSING-${minutesAgo}` },
      reportedByUserId,
      reportedAt: at(-minutesAgo * 60_000),
      summary,
      rescueRequired: false,
      evidence: null,
      capturedOffline: false,
      deviceActionId: null,
      now: at(-minutesAgo * 60_000),
    });
  const raw = '  Loose sheathing at the ridge - "do not walk" zone, 6/12 pitch.  ';
  await report("occurrence.attest.named", USERS.field.id, 30, raw);
  await report("occurrence.attest.unnamed", USERS.ops.id, 20, "Ladder foot slipping on the wet deck.");
  const owner = await person(h, USERS.owner.id);
  const items = (await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind === "stop_job_unknown")
    .map((row) => ({ id: row.id, title: row.title, why: row.why, reported_by_name: row.reported_by_name, summary: row.summary }));
  assert.deepEqual(items, [
    { id: "occurrence.attest.named", title: STOP_JOB_UNKNOWN_TITLE, why: STOP_JOB_UNKNOWN_WHY, reported_by_name: "Synthetic field", summary: raw },
    { id: "occurrence.attest.unnamed", title: STOP_JOB_UNKNOWN_TITLE, why: STOP_JOB_UNKNOWN_WHY, reported_by_name: null, summary: "Ladder foot slipping on the wet deck." },
  ]);
  // Every other kind carries the two fields as null.
  assert.ok((await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind !== "stop_job_unknown")
    .every((row) => row.reported_by_name === null && row.summary === null));
});

test("the owner's item for a work stop on a job plan that doesn't exist names who raised it, or null, and keeps the summary raw", async () => {
  const h = setup();
  // A login whose display name is blank has no name to show.
  h.sqlite.prepare("UPDATE app_users SET display_name = ' ' WHERE user_id = ?").run(USERS.ops.id);
  const report = (occurrenceId: string, reportedByUserId: string, minutesAgo: number, summary: string) =>
    reportSafetyOccurrence(h.env, {
      occurrenceId,
      tenantId: TENANT,
      occurrenceKind: "hazard",
      severity: "high",
      scope: { type: "work_package", id: `wp:missing:${minutesAgo}` },
      reportedByUserId,
      reportedAt: at(-minutesAgo * 60_000),
      summary,
      rescueRequired: false,
      evidence: null,
      capturedOffline: false,
      deviceActionId: null,
      now: at(-minutesAgo * 60_000),
    });
  const raw = '  Tarp torn over the open valley - "keep off" until resecured.  ';
  await report("occurrence.attest.plan-named", USERS.field.id, 30, raw);
  await report("occurrence.attest.plan-unnamed", USERS.ops.id, 20, "Gutter guard loose above the walkway.");
  const owner = await person(h, USERS.owner.id);
  const items = (await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind === "stop_work_package_unknown")
    .map((row) => ({ id: row.id, title: row.title, why: row.why, reported_by_name: row.reported_by_name, summary: row.summary }));
  assert.deepEqual(items, [
    { id: "occurrence.attest.plan-named", title: STOP_WORK_PACKAGE_UNKNOWN_TITLE, why: STOP_WORK_PACKAGE_UNKNOWN_WHY, reported_by_name: "Synthetic field", summary: raw },
    { id: "occurrence.attest.plan-unnamed", title: STOP_WORK_PACKAGE_UNKNOWN_TITLE, why: STOP_WORK_PACKAGE_UNKNOWN_WHY, reported_by_name: null, summary: "Gutter guard loose above the walkway." },
  ]);
  // Both items say the same thing about what the stop holds.
  assert.equal(STOP_WORK_PACKAGE_UNKNOWN_WHY, STOP_JOB_UNKNOWN_WHY);
  // Every kind but the two work-stop items carries the two fields as null.
  assert.ok((await buildOwnerNowReadModel(h.env, owner)).exceptions
    .filter((row) => row.kind !== "stop_job_unknown" && row.kind !== "stop_work_package_unknown")
    .every((row) => row.reported_by_name === null && row.summary === null));
});

test("another job's stop, a shop or vehicle stop, or a lifted stop leaves Safety open on the route and in D1", async () => {
  const h = setup();
  insertWorkPackage(h.sqlite, "wp:attest:other-job", OTHER_JOB);
  insertCrewStop(h.sqlite, "wp:attest:other-job", OTHER_JOB);
  // A crew stop on this job's package that a release has lifted: the version is Released again.
  insertWorkPackage(h.sqlite, "wp:attest:released", JOB);
  insertCrewStop(h.sqlite, "wp:attest:released", JOB);
  releaseCrewStop(h.sqlite, "wp:attest:released", JOB);
  assert.equal(
    (h.sqlite.prepare("SELECT status FROM work_packages WHERE work_package_id = ?")
      .get("wp:attest:released") as { status: string }).status,
    "Released",
  );
  for (const scope of [
    { type: "work_package", id: "wp:attest:other-job" },
    { type: "roof_job", id: OTHER_JOB },
    { type: "shop", id: "shop:attest:main" },
    { type: "vehicle", id: "vehicle:attest:truck-1" },
    { type: "roof_job", id: JOB, active: 0 as const },
  ]) {
    insertSafetyStop(h.sqlite, scope);
  }
  const production = await person(h, USERS.production.id);
  const competency = insertCompetency(h.sqlite, USERS.production.id);
  const routed = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  // The same stops let a direct D1 attestation through as well, once the gate is blocked again.
  append(h.sqlite, reversal("Safety", routed.body.entry.id, { actor_user_id: USERS.owner.id, actor_role: "owner" }));
  append(h.sqlite, { gate: "Safety", attestation_json: safetyStored(competency) });
  assert.equal(gateRow(h.sqlite, "Safety").state, "ready");
});

test("the route alone holds the site_safety scope, every stop and the permit answer, with D1's validate guard lifted", async () => {
  // D1 answers each of these with the same code, so here its validate guard is dropped: only the
  // route's own read can refuse, and a gap in it would let the attestation through.
  for (const [label, prepare, refusal] of [
    ["competency in another field", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id, { authority_scope: "roofing-installation" });
    }, [403, "production_gate_competency_required"]],
    ["competency with no scope", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id, { authority_scope: null });
    }, [403, "production_gate_competency_required"]],
    ["competency with an empty scope", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id, { authority_scope: "" });
    }, [403, "production_gate_competency_required"]],
    ["stop on the job", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertSafetyStop(db, { type: "roof_job", id: JOB });
    }, [409, "production_gate_safety_stop_active"]],
    ["stop on the tenant", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertSafetyStop(db, { type: "tenant", id: TENANT });
    }, [409, "production_gate_safety_stop_active"]],
    ["stop on a Superseded package of the job", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertWorkPackage(db, "wp:attest:reissued", JOB);
      supersedeWorkPackage(db, "wp:attest:reissued", JOB, "wp:attest:reissued-2");
      insertSafetyStop(db, { type: "work_package", id: "wp:attest:reissued" });
    }, [409, "production_gate_safety_stop_active"]],
    ["crew stop_work on a package of the job", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertWorkPackage(db, "wp:attest:stopped", JOB);
      insertCrewStop(db, "wp:attest:stopped", JOB);
    }, [409, "production_gate_safety_stop_active"]],
    ["stop on an unknown package", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertSafetyStop(db, { type: "work_package", id: "wp:attest:unknown" });
    }, [409, "production_gate_stop_work_package_unknown"]],
    ["stop of an unknown scope type", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertUnknownScopeStop(db);
    }, [409, "production_gate_safety_stop_active"]],
    ["stop on a job the tenant does not have", (db: DatabaseSync) => {
      insertCompetency(db, USERS.production.id);
      insertSafetyStop(db, { type: "roof_job", id: "IW-ATTEST-0001" });
    }, [409, "production_gate_stop_job_unknown"]],
  ] as const) {
    const h = setup();
    h.sqlite.exec("DROP TRIGGER production_gate_clearances_validate_insert");
    prepare(h.sqlite);
    const production = await person(h, USERS.production.id);
    const result = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety"));
    assert.deepEqual([result.status, result.body.error], refusal, label);
    assert.equal(gateRow(h.sqlite, "Safety").state, "blocked", label);
  }
  for (const [label, permit, refusal] of [
    ["permit unknown", { answer: "unknown" }, [409, "production_gate_safety_permit_unknown"]],
    ["permit held without a number", { answer: "needed_and_held" }, [400, "production_gate_attestation_invalid"]],
    ["no permit answer", undefined, [400, "production_gate_attestation_invalid"]],
  ] as const) {
    const h = setup();
    h.sqlite.exec("DROP TRIGGER production_gate_clearances_validate_insert");
    insertCompetency(h.sqlite, USERS.production.id);
    const production = await person(h, USERS.production.id);
    const result = await call(h, production, "POST", CLEARANCE("Safety"), attest("Safety", 1, {
      attestation: { ...SENT.Safety(), permit },
    }));
    assert.deepEqual([result.status, result.body.error], refusal, label);
    assert.equal(gateRow(h.sqlite, "Safety").state, "blocked", label);
  }
});

test("Materials is refused over an open or contained inventory exception", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  insertMaterialException(h.sqlite, "resolved");
  insertMaterialException(h.sqlite, "contained");
  const result = await call(h, production, "POST", CLEARANCE("Materials"), attest("Materials"));
  assert.deepEqual([result.status, result.body.error], [409, "production_gate_material_exception_open"]);
  assert.equal(gateRow(h.sqlite, "Materials").state, "blocked");
});

test("Weather needs a window of at most 14 days that has not ended, on a forecast at most 72 hours old", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const weather = (attestation: Record<string, unknown>) =>
    call(h, production, "POST", CLEARANCE("Weather"), attest("Weather", 1, { attestation: { ...SENT.Weather(), ...attestation } }));
  for (const [attestation, code] of [
    [{ window_start: at(DAY), window_end: at(16 * DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(-3 * DAY), window_end: at(12 * DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(-3 * DAY), window_end: at(-DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(4 * DAY), window_end: at(DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(12 * DAY), window_end: at(15 * DAY) }, "production_gate_weather_window_invalid"],
    [{ forecast_observed_at: at(-73 * HOUR) }, "production_gate_forecast_stale"],
  ] as const) {
    const result = await weather(attestation);
    assert.deepEqual([result.status, result.body.error], [409, code], JSON.stringify(attestation));
  }
  assert.deepEqual(ledgerRows(h.sqlite), []);
  const ok = await weather({ window_start: at(-HOUR), window_end: at(13 * DAY) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("evidence is resolved against the job by the Worker, and a reference it cannot resolve is refused", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  insertCapture(h.sqlite, `evi_${"b2".repeat(16)}`, { jobId: OTHER_JOB });
  insertCapture(h.sqlite, `evi_${"c3".repeat(16)}`, { status: "r2_stored" });
  insertReservation(h.sqlite, "reservation.attest.released", { status: "released" });
  insertReservation(h.sqlite, "reservation.attest.other-job", { jobId: OTHER_JOB });
  insertReservation(h.sqlite, "reservation.attest.0002");
  for (const [gate, refs] of [
    ["Materials", [`field-evidence://evi_${"d4".repeat(16)}`]],
    ["Materials", [`field-evidence://evi_${"b2".repeat(16)}`]],
    ["Materials", [`field-evidence://evi_${"c3".repeat(16)}`]],
    ["Materials", ["stock-reservation://reservation.attest.released"]],
    ["Materials", ["stock-reservation://reservation.attest.other-job"]],
    ["Access", ["stock-reservation://reservation.attest.0002"]],
  ] as const) {
    const result = await call(h, production, "POST", CLEARANCE(gate), attest(gate, 1, { evidence_refs: refs }));
    assert.deepEqual([result.status, result.body.error], [409, "production_gate_evidence_invalid"], refs[0]);
  }
  const tooMany = Array.from({ length: 11 }, (_, index) => `field-evidence://evi_${index.toString(16).padStart(32, "0")}`);
  const many = await call(h, production, "POST", CLEARANCE("Materials"), attest("Materials", 1, { evidence_refs: tooMany }));
  assert.deepEqual([many.status, many.body.error], [400, "production_gate_attestation_invalid"]);
  assert.deepEqual(ledgerRows(h.sqlite), []);
});

test("a reversal returns the gate to blocked, deletes nothing, and writes one audit row", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const owner = await person(h, USERS.owner.id);
  const attested = await call(h, production, "POST", CLEARANCE("Materials"), attest("Materials"));
  const attestationId = attested.body.entry.id as string;
  const reason = "Supplier recalled the delivered panels for a coating defect.";
  const body = { expected_gate_version: 2, reverses_id: attestationId, reason };
  const reversed = await call(h, owner, "POST", REVERSALS("Materials"), body, { idempotency: "gate-reversal-key-000000001" });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  assert.deepEqual(
    {
      kind: reversed.body.entry.kind,
      basis: reversed.body.entry.basis,
      to_state: reversed.body.entry.to_state,
      reverses_id: reversed.body.entry.reverses_id,
      reason: reversed.body.entry.reason,
      role: reversed.body.entry.actor_role,
    },
    { kind: "reverse", basis: "person_reversal", to_state: "blocked", reverses_id: attestationId, reason, role: "owner" },
  );
  assert.deepEqual(reversed.body.gate, { name: gateId("Materials"), gate: "Materials", roof_job: JOB, state: "blocked", version: 3 });
  assert.deepEqual(gateRow(h.sqlite, "Materials"), {
    state: "blocked",
    version: 3,
    clearance_basis: null,
    clearance_decision_id: null,
    cleared_by_user_id: null,
    evidence_refs_json: null,
  });
  assert.deepEqual(auditRows(h.sqlite, reversed.body.entry.id), [{
    action: "reverse:person_reversal",
    trigger: "person",
    approved_by: USERS.owner.id,
    reason: null,
    source_ids: `job:${JOB},gate:Materials,from_version:2,to_state:blocked`,
  }]);
  assert.deepEqual(ledgerRows(h.sqlite).map((row) => row.entry_kind), ["clear", "reverse"]);
  const replay = await call(h, owner, "POST", REVERSALS("Materials"), body, { idempotency: "gate-reversal-key-000000001" });
  assert.deepEqual(replay.body, { ...reversed.body, replayed: true });

  // A blocked gate has nothing to reverse, and only the entry holding the state can be reversed.
  const nothing = await call(h, owner, "POST", REVERSALS("Materials"), { ...body, expected_gate_version: 3 });
  assert.deepEqual([nothing.status, nothing.body.error], [409, "production_gate_not_cleared"]);
  const reattested = await call(h, production, "POST", CLEARANCE("Materials"), attest("Materials", 3));
  assert.equal(reattested.status, 200);
  const old = await call(h, production, "POST", REVERSALS("Materials"), { ...body, expected_gate_version: 4 });
  assert.deepEqual([old.status, old.body.error], [409, "production_gate_reversal_target_invalid"]);
  const stale = await call(h, production, "POST", REVERSALS("Materials"), {
    expected_gate_version: 3, reverses_id: reattested.body.entry.id, reason,
  });
  assert.deepEqual([stale.status, stale.body.error], [409, "production_gate_version_conflict"]);
  const ops = await person(h, USERS.ops.id);
  const forbidden = await call(h, ops, "POST", REVERSALS("Materials"), {
    expected_gate_version: 4, reverses_id: reattested.body.entry.id, reason,
  });
  assert.deepEqual([forbidden.status, forbidden.body.error], [403, "production_gate_reversal_forbidden"]);
  const seed = await person(h, USERS.seed.id);
  const seeded = await call(h, seed, "POST", REVERSALS("Materials"), {
    expected_gate_version: 4, reverses_id: reattested.body.entry.id, reason,
  });
  assert.deepEqual([seeded.status, seeded.body.error], [403, "production_gate_clearance_seed_identity_refused"]);
  for (const bad of [
    { expected_gate_version: 4, reverses_id: reattested.body.entry.id },
    { expected_gate_version: 4, reverses_id: reattested.body.entry.id, reason: "short" },
    { expected_gate_version: 4, reverses_id: "pgc_short", reason },
    { expected_gate_version: 4, reverses_id: reattested.body.entry.id, reason, extra: true },
  ]) {
    const result = await call(h, production, "POST", REVERSALS("Materials"), bad);
    assert.deepEqual([result.status, result.body.error], [400, "invalid_production_gate_reversal"]);
  }
  assert.equal(gateRow(h.sqlite, "Materials").state, "ready");
});

test("the office reads every gate with its entries and the request ids a waiver decision answers", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const owner = await person(h, USERS.owner.id);
  const waiver = (gate: string) => call(h, production, "POST", CLEARANCE(gate), {
    basis: "office_waiver",
    reason: `Production asks the owner to waive ${gate} for this job.`,
  });
  assert.equal((await waiver("Materials")).body.error, "production_gate_waiver_requested");
  assert.equal((await waiver("Access")).body.error, "production_gate_waiver_requested");
  const [accessRequest, materialsRequest] = ledgerRows(h.sqlite);

  const read = await call(h, owner, "GET", GATES());
  assert.equal(read.status, 200);
  assert.equal(read.body.roof_job, JOB);
  assert.deepEqual(read.body.gates.map((gate: { gate: string }) => gate.gate), ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]);
  const materials = read.body.gates.find((gate: { gate: string }) => gate.gate === "Materials");
  assert.deepEqual(materials.open_waiver_requests, [{
    request_id: materialsRequest!.clearance_id,
    is_own_request: false,
    requested_by_role: "production",
    from_gate_version: 1,
    reason: "Production asks the owner to waive Materials for this job.",
    reason_redacted: false,
    created_at: materials.entries[0].created_at,
  }]);
  assert.deepEqual(
    { state: materials.state, version: materials.version, complete: materials.ledger_complete, kinds: materials.entries.map((entry: { kind: string }) => entry.kind) },
    { state: "blocked", version: 2, complete: true, kinds: ["waiver_request"] },
  );

  // The owner answers the request by the id the read gave.
  const decided = await call(h, owner, "POST", DECISIONS("Materials"), {
    request_id: materials.open_waiver_requests[0].request_id,
    expected_gate_version: materials.version,
    decision: "approve",
    reason: "Owner approves: the shop holds every panel for this job.",
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  // Access is attested while its request is undecided: a request is open only while it can be
  // decided, that is while the gate is blocked.
  const attested = await call(h, production, "POST", CLEARANCE("Access"), attest("Access", 2, {
    attestation: { ...SENT.Access(), notes: "Side gate code given by the property manager." },
  }));
  assert.equal(attested.status, 200, JSON.stringify(attested.body));

  const after = await call(h, owner, "GET", GATES());
  const byGate = Object.fromEntries(after.body.gates.map((gate: { gate: string }) => [gate.gate, gate]));
  assert.deepEqual(byGate.Materials.open_waiver_requests, []);
  assert.deepEqual(byGate.Materials.entries.map((entry: { kind: string }) => entry.kind), ["waiver_request", "waiver_decision"]);
  assert.equal(byGate.Materials.entries[1].request_id, materialsRequest!.clearance_id);
  assert.equal(byGate.Materials.state, "waived");
  assert.deepEqual(byGate.Access.open_waiver_requests, []);
  const accessAttestation = byGate.Access.entries.at(-1);
  assert.deepEqual(
    { kind: accessAttestation.kind, attestation: accessAttestation.attestation, reason: accessAttestation.reason, evidence: accessAttestation.evidence_refs },
    {
      kind: "clear",
      attestation: JSON.parse(ledgerRows(h.sqlite).find((row) => row.entry_kind === "clear")!.attestation_json),
      reason: "Side gate code given by the property manager.",
      evidence: [],
    },
  );
  // Reversing the attestation makes the old Access request decidable again.
  const reversed = await call(h, owner, "POST", REVERSALS("Access"), {
    expected_gate_version: 3,
    reverses_id: accessAttestation.id,
    reason: "The property manager withdrew site access for the week.",
  });
  assert.equal(reversed.status, 200);
  const reopened = await call(h, owner, "GET", GATES());
  const access = reopened.body.gates.find((gate: { gate: string }) => gate.gate === "Access");
  assert.deepEqual(access.open_waiver_requests.map((request: { request_id: string }) => request.request_id), [accessRequest!.clearance_id]);

  // The requester reads the same request as their own.
  const ownRead = await call(h, production, "GET", GATES());
  const ownAccess = ownRead.body.gates.find((gate: { gate: string }) => gate.gate === "Access");
  assert.deepEqual(
    ownAccess.open_waiver_requests.map((request: Record<string, unknown>) => [request.request_id, request.is_own_request]),
    [[accessRequest!.clearance_id, true]],
  );
  assert.ok(!JSON.stringify(ownRead.body).includes(USERS.production.id), "no user id in the office's read");
  // Office roles read it; others are refused. An agent may read gates, never move one.
  assert.equal((await call(h, await person(h, USERS.ops.id), "GET", GATES())).status, 200);
  assert.equal((await call(h, machine("owner"), "GET", GATES())).status, 200);
  for (const role of ["sales", "accounting", "field"] as const) {
    const refusedRead = await call(h, machine(role), "GET", GATES());
    assert.deepEqual([refusedRead.status, refusedRead.body.error], [403, "office_role_required"], role);
  }
  const missing = await call(h, owner, "GET", GATES("job:attest:missing"));
  assert.deepEqual([missing.status, missing.body.error], [404, "production_gate_job_not_found"]);
});

// --- D1 ---------------------------------------------------------------------------------------

let entryCounter = 0;

/** Append one entry with direct SQL, defaulting to production's valid Materials attestation. */
function append(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  entryCounter += 1;
  const gate = String(overrides.gate ?? "Materials");
  const current = db.prepare("SELECT version FROM operating_production_gates WHERE gate_id = ?")
    .get(gateId(gate)) as { version: number };
  const row: Record<string, unknown> = {
    clearance_id: `pgc_${(0xa0000 + entryCounter).toString(16).padStart(40, "0")}`,
    tenant_id: TENANT,
    gate_id: gateId(gate),
    roof_job_id: JOB,
    gate,
    entry_kind: "clear",
    basis: "person_attestation",
    to_state: "ready",
    from_gate_version: current.version,
    actor_kind: "person",
    actor_user_id: USERS.production.id,
    actor_role: "production",
    attestation_json: gate in SENT ? JSON.stringify(SENT[gate as AttestedGate]()) : null,
    evidence_refs_json: "[]",
    request_sha256: sha(`request:${entryCounter}`),
    idempotency_key_hash: sha(`key:${entryCounter}`),
    created_at: at(0),
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO production_gate_clearances (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return String(row.clearance_id);
}

const stored = (gate: AttestedGate, changes: Record<string, unknown>) =>
  JSON.stringify({ ...SENT[gate](), ...changes });
const safetyStored = (competency: Competency, changes: Record<string, unknown> = {}) =>
  JSON.stringify({ ...SENT.Safety(), competency, ...changes });
const reversal = (gate: string, reversesId: string, changes: Record<string, unknown> = {}) => ({
  gate,
  entry_kind: "reverse",
  basis: "person_reversal",
  to_state: "blocked",
  reverses_id: reversesId,
  attestation_json: null,
  evidence_refs_json: null,
  reason: "Synthetic reversal reason for repository proof only.",
  ...changes,
});

test("D1 admits an attestation only from an owner or production person on no crew, and only on its four gates", () => {
  const { sqlite: db } = setup();
  refused(() => append(db, { gate: "Deposit", attestation_json: stored("Materials", {}) }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { gate: "Crew", attestation_json: stored("Materials", {}) }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { to_state: "complete" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { actor_kind: "policy" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { gate: "Safety", actor_kind: "policy" }), "production_gate_safety_person_only");
  refused(() => append(db, { self_approval: 1, self_approval_basis: "only_holder" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { reverses_id: `pgc_${"0".repeat(40)}` }), "production_gate_clearance_basis_invalid");
  refused(
    () => append(db, { entry_kind: "waiver_request", basis: "office_waiver", to_state: "blocked", reason: "A waiver request with an attestation attached." }),
    "production_gate_clearance_basis_invalid",
  );
  refused(() => append(db, { actor_user_id: USERS.ops.id, actor_role: "ops" }), "production_gate_clearance_actor_invalid");
  refused(() => append(db, { actor_user_id: USERS.seed.id, actor_role: "owner" }), "production_gate_clearance_seed_identity_refused");
  refused(() => append(db, { actor_user_id: USERS.crewed.id }), "production_gate_attester_on_crew");
  // A crew login that shares a coordinate with the attester's login is the same person on a crew.
  db.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
    .run(`${USERS.production.id}@example.invalid`, USERS.field.id);
  refused(() => append(db), "production_gate_attester_on_crew");
  db.prepare("UPDATE fleet_crew_members SET active = 0, version = version + 1 WHERE user_id = ?").run(USERS.field.id);
  append(db);
  assert.equal(gateRow(db, "Materials").state, "ready");
  assert.equal(ledgerRows(db).length, 1);
});

test("D1 holds each gate to its typed attestation with no free text but a short note", () => {
  const { sqlite: db } = setup();
  const invalid = "production_gate_attestation_invalid";
  // Well formed but naming no record: a Safety case fails on its shape, not on the competency.
  const named: Competency = {
    readback_id: "readback.attest.none",
    authority_record_id: "competency_attest_none",
    authority_version: 1,
    state_digest_sha256: sha("no record"),
  };
  refused(() => append(db, { gate: "Safety", attestation_json: safetyStored(named) }), "production_gate_competency_required");
  for (const overrides of [
    { attestation_json: null },
    { reason: "x".repeat(301) },
    { attestation_json: stored("Materials", { description: "Panels arrived and look fine." }) },
    { attestation_json: stored("Materials", { source: "found_on_site" }) },
    { attestation_json: stored("Materials", { reference: "delivered last Tuesday" }) },
    { attestation_json: JSON.stringify({ source: "none_needed" }) },
    // A second copy of a key would carry text past every check that reads the first.
    { attestation_json: '{"reference":"DEL-2026-0042","source":"supplier_delivery","source":"The panels came on Tuesday."}' },
    { gate: "Access", attestation_json: stored("Access", { confirmed_at: at(HOUR) }) },
    { gate: "Access", attestation_json: stored("Access", { constraints: ["pets", "pets"] }) },
    { gate: "Access", attestation_json: stored("Access", { constraints: ["a locked gate"] }) },
    { gate: "Access", attestation_json: stored("Access", { constraints: [] }) },
    { gate: "Access", attestation_json: stored("Access", { confirmed_with: "neighbour" }) },
    { gate: "Weather", attestation_json: stored("Weather", { window_start: at(DAY).replace(/\.\d{3}Z$/, "Z") }) },
    { gate: "Weather", attestation_json: stored("Weather", { forecast_source: "The Weather Network" }) },
    { gate: "Weather", attestation_json: stored("Weather", { forecast_observed_at: at(HOUR) }) },
    { gate: "Safety", attestation_json: stored("Safety", {}) },
    { gate: "Safety", attestation_json: safetyStored(named, { fall_protection: { plan_ref: "FPP-1", no_exposure_at_3m: true } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { fall_protection: { no_exposure_at_3m: false } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { fall_protection: { plan_ref: "a plan in the truck" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { assessed_at: "2026-02-30T10:00:00.000Z" }) },
    // The permit: exactly {answer} when not needed or unknown, {answer, number} when held, and the
    // number a reference whose words single spaces join.
    { gate: "Safety", attestation_json: safetyStored(named, { permit: undefined }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: "not_needed" }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "held", number: "BP-4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "maybe" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "not_needed", number: "BP-4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "unknown", number: "BP-4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "not_needed", checked_by: "office" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: 4417 } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "building  permit 4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "building permit 4417 " } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: " building permit 4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "permit\n4417" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "permit (4417)" } }) },
    { gate: "Safety", attestation_json: safetyStored(named, { permit: { answer: "needed_and_held", number: "P".repeat(81) } }) },
    // A second answer would let the first, read by every check, hide the one a reader trusts.
    {
      gate: "Safety",
      attestation_json: safetyStored(named).replace(
        '"permit":{"answer":"needed_and_held","number":"building permit 4417"}',
        '"permit":{"answer":"not_needed","answer":"unknown"}',
      ),
    },
    { gate: "Safety", attestation_json: safetyStored({ ...named, authority_version: "1" } as never) },
    { gate: "Safety", attestation_json: safetyStored({ ...named, issued_by: "x" } as never) },
  ]) {
    refused(() => append(db, overrides), invalid);
  }
  // Exactly 300 code points is a note; 301 is not, whatever their byte length.
  append(db, { reason: "é".repeat(300) });
  assert.equal(ledgerRows(db).length, 1);
});

test("D1 resolves each evidence reference against the job: a stored capture or, on Materials, a live reservation", () => {
  const { sqlite: db } = setup();
  const invalid = "production_gate_evidence_invalid";
  const ownId = `evi_${"e5".repeat(16)}`;
  const checksum = insertCapture(db, ownId);
  const otherId = `evi_${"f6".repeat(16)}`;
  const otherChecksum = insertCapture(db, otherId, { jobId: OTHER_JOB });
  insertReservation(db, "reservation.attest.0003");
  insertReservation(db, "reservation.attest.0004", { status: "released" });
  const capture = { ref: `field-evidence://${ownId}`, sha256: checksum };
  const reservation = { ref: "stock-reservation://reservation.attest.0003", sha256: sha("reservation"), version: 1 };
  // Eleven distinct stored captures: each one alone is good evidence, eleven are one too many.
  const eleven = Array.from({ length: 11 }, (_, index) => {
    const id = `evi_${(0xe000 + index).toString(16).padStart(32, "0")}`;
    return { ref: `field-evidence://${id}`, sha256: insertCapture(db, id) };
  });
  for (const [gate, refs] of [
    ["Materials", null],
    ["Materials", {}],
    ["Materials", [{ ...capture, sha256: sha("forged") }]],
    ["Materials", [{ ref: `field-evidence://${otherId}`, sha256: otherChecksum }]],
    ["Materials", [{ ...capture, note: "extra" }]],
    ["Materials", [capture, capture]],
    ["Materials", eleven],
    ["Materials", [{ ...reservation, version: 2 }]],
    ["Materials", [{ ...reservation, ref: "stock-reservation://reservation.attest.0004" }]],
    ["Materials", [{ ...reservation, sha256: "not-a-digest" }]],
    ["Access", [reservation]],
  ] as const) {
    refused(() => append(db, { gate, evidence_refs_json: refs === null ? null : JSON.stringify(refs) }), invalid);
  }
  // JSON5 naming a good capture: json_each would read it, every parser of the stored list would not.
  refused(() => append(db, { evidence_refs_json: `[{ref:"${capture.ref}",sha256:"${capture.sha256}"}]` }), invalid);
  append(db, { evidence_refs_json: JSON.stringify([capture, reservation]) });
  append(db, { gate: "Access", evidence_refs_json: JSON.stringify(eleven.slice(0, 10)) });
  assert.deepEqual(ledgerRows(db).map((row) => row.gate), ["Access", "Materials"]);
});

test("D1 refuses Materials over an open or contained exception and Safety without a current competency or during a stop", () => {
  const { sqlite: db } = setup();
  insertMaterialException(db, "resolved");
  append(db);
  let held = db;
  for (const status of ["open", "contained"] as const) {
    held = setup().sqlite;
    insertMaterialException(held, status);
    refused(() => append(held), "production_gate_material_exception_open");
  }

  const required = "production_gate_competency_required";
  const own = insertCompetency(db, USERS.production.id);
  const owners = insertCompetency(db, USERS.owner.id);
  const expired = insertCompetency(db, USERS.production.id, { authority_expires_at: day(-1) });
  const future = insertCompetency(db, USERS.production.id, { authority_effective_from: day(2) });
  const otherJob = insertCompetency(db, USERS.production.id, { roof_job: OTHER_JOB, scope_type: "Roof Job", scope_ref: OTHER_JOB });
  const unverified = insertCompetency(db, USERS.production.id, { verification_state: "unavailable", authority_verification_method: null });
  const external = insertCompetency(db, USERS.production.id, { authority_verification_method: "Signed Issuer Record" });
  const otherScope = insertCompetency(db, USERS.production.id, { authority_scope: "roofing-installation" });
  const noScope = insertCompetency(db, USERS.production.id, { authority_scope: null });
  const emptyScope = insertCompetency(db, USERS.production.id, { authority_scope: "" });
  const nearScope = insertCompetency(db, USERS.production.id, { authority_scope: "site_safety " });
  const revoked = insertCompetency(db, USERS.production.id);
  insertCompetency(db, USERS.production.id, {
    authority_version: 2,
    supersedes_authority_record_id: revoked.authority_record_id,
    verification_state: "revoked",
    authority_revoked_at: at(-HOUR).replace(/\.\d{3}Z$/, "Z"),
  });
  const contradicted = insertCompetency(db, USERS.production.id);
  insertCompetency(db, USERS.production.id, {
    authority_record_id: contradicted.authority_record_id,
    authority_state_digest_sha256: sha("a contradicting copy"),
  });
  // A record's second version leaves its first behind: only the latest version is current.
  const versionOne = insertCompetency(db, USERS.production.id);
  const versionTwo = insertCompetency(db, USERS.production.id, {
    authority_record_id: versionOne.authority_record_id,
    authority_version: 2,
  });
  for (const competency of [owners, expired, future, otherJob, unverified, external, otherScope, noScope, emptyScope, nearScope, revoked, contradicted, versionOne]) {
    refused(() => append(db, { gate: "Safety", attestation_json: safetyStored(competency) }), required);
  }
  const attested = append(db, { gate: "Safety", attestation_json: safetyStored(versionTwo) });
  append(db, reversal("Safety", attested, { actor_user_id: USERS.owner.id, actor_role: "owner" }));
  refused(() => append(db, { gate: "Safety", attestation_json: safetyStored({ ...own, state_digest_sha256: sha("forged") }) }), required);
  insertSafetyStop(held);
  const stopped = insertCompetency(held, USERS.production.id);
  refused(() => append(held, { gate: "Safety", attestation_json: safetyStored(stopped) }), "production_gate_safety_stop_active");
  // The owner's own current record names the owner, so the owner may attest under it.
  append(db, { gate: "Safety", actor_user_id: USERS.owner.id, actor_role: "owner", attestation_json: safetyStored(owners) });
  assert.equal(gateRow(db, "Safety").state, "ready");
});

test("D1 refuses a weather window over 14 days, one already over, and a forecast over 72 hours old", () => {
  const { sqlite: db } = setup();
  for (const [changes, code] of [
    [{ window_start: at(DAY), window_end: at(15 * DAY + HOUR) }, "production_gate_weather_window_invalid"],
    // Longer than 14 days although it ends inside the forecast's 14 days.
    [{ window_start: at(-3 * DAY), window_end: at(12 * DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(-2 * DAY), window_end: at(-HOUR) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(2 * DAY), window_end: at(DAY) }, "production_gate_weather_window_invalid"],
    [{ window_start: at(10 * DAY), window_end: at(14 * DAY) }, "production_gate_weather_window_invalid"],
    [{ forecast_observed_at: at(-73 * HOUR) }, "production_gate_forecast_stale"],
  ] as const) {
    refused(() => append(db, { gate: "Weather", attestation_json: stored("Weather", changes) }), code);
  }
  append(db, { gate: "Weather", attestation_json: stored("Weather", { window_start: at(0), window_end: at(13 * DAY) }) });
  assert.equal(gateRow(db, "Weather").state, "ready");
});

test("D1 checks every time against its own clock, never the entry's created_at", () => {
  const { sqlite: db } = setup();
  // Each entry claims a creation time under which it would pass; D1's own clock refuses it.
  refused(
    () => append(db, { gate: "Weather", created_at: at(-90 * HOUR), attestation_json: stored("Weather", { forecast_observed_at: at(-100 * HOUR) }) }),
    "production_gate_forecast_stale",
  );
  refused(
    () => append(db, { gate: "Weather", created_at: at(-3 * DAY), attestation_json: stored("Weather", { window_start: at(-DAY), window_end: at(-HOUR) }) }),
    "production_gate_weather_window_invalid",
  );
  refused(
    () => append(db, { gate: "Access", created_at: at(2 * DAY), attestation_json: stored("Access", { confirmed_at: at(HOUR) }) }),
    "production_gate_attestation_invalid",
  );
  assert.deepEqual(ledgerRows(db), []);
});

test("D1 reverses only the entry holding a gate's state, and never deletes", () => {
  const { sqlite: db } = setup();
  refused(() => append(db, reversal("Materials", `pgc_${"0".repeat(40)}`)), "production_gate_not_cleared");
  const first = append(db);
  refused(() => append(db, reversal("Materials", first, { reason: null })), "production_gate_clearance_reason_required");
  refused(() => append(db, reversal("Materials", first, { evidence_refs_json: "[]" })), "production_gate_clearance_basis_invalid");
  refused(() => append(db, reversal("Materials", first, { attestation_json: stored("Materials", {}) })), "production_gate_clearance_basis_invalid");
  refused(() => append(db, reversal("Materials", first, { actor_user_id: USERS.ops.id, actor_role: "ops" })), "production_gate_clearance_actor_invalid");
  refused(() => append(db, reversal("Materials", first, { actor_user_id: USERS.seed.id, actor_role: "owner" })), "production_gate_clearance_seed_identity_refused");
  refused(() => append(db, reversal("Materials", first, { actor_kind: "policy" })), "production_gate_clearance_basis_invalid");
  const reversed = append(db, reversal("Materials", first));
  assert.deepEqual({ state: gateRow(db, "Materials").state, version: gateRow(db, "Materials").version }, { state: "blocked", version: 3 });
  const second = append(db);
  refused(() => append(db, reversal("Materials", first)), "production_gate_reversal_target_invalid");
  refused(() => append(db, reversal("Materials", reversed)), "production_gate_reversal_target_invalid");
  const access = append(db, { gate: "Access" });
  refused(() => append(db, reversal("Materials", access)), "production_gate_reversal_target_invalid");
  // A crew member may re-block: reversal is the safe direction and the crew rule is the attester's.
  append(db, reversal("Materials", second, { actor_user_id: USERS.crewed.id }));
  // No person reverses a contract that needs no deposit: proved on a real contract's policy entry in
  // customer-contract-acceptance.test.ts, on the route and in D1.
  refused(
    () => db.prepare("DELETE FROM production_gate_clearances WHERE clearance_id = ?").run(first),
    "production_gate_clearance_append_only",
  );
  for (const id of [first, reversed, second, access]) assert.equal(auditRows(db, id).length, 1, id);
});

test("the final validate guard carries every line of 0155 as the merged tree holds it, in order", () => {
  const read = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const trigger = (sql: string): string => {
    const match = sql.match(/CREATE TRIGGER (?:IF NOT EXISTS )?production_gate_clearances_validate_insert\n[\s\S]*?\nEND;/);
    assert.ok(match, "validate trigger");
    return match[0];
  };
  // sqlite_master keeps a trigger's text without the closing semicolon the migration file has.
  const lines = (sql: string) => sql.split("\n").map((line) => line.trim().replace(/^END;$/, "END"));
  // The trigger the fully migrated database ends with, not a copy of it.
  const { sqlite: migrated } = setup();
  const recreated = lines(String((migrated.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'production_gate_clearances_validate_insert'",
  ).get() as { sql: string }).sql));
  // The only 0155 lines 0158 widens, each with the form it takes there.
  const widened: Record<string, string> = {
    "OR NEW.reverses_id IS NOT NULL": "OR (NEW.reverses_id IS NOT NULL AND NEW.entry_kind != 'reverse')",
    "OR NEW.attestation_json IS NOT NULL":
      "OR (NEW.attestation_json IS NOT NULL AND NEW.basis != 'person_attestation')",
    "OR (NEW.entry_kind IN ('waiver_request', 'waiver_decision')":
      "OR (NEW.entry_kind IN ('waiver_request', 'waiver_decision', 'reverse')",
    "WHERE NEW.entry_kind IN ('waiver_request', 'waiver_decision')":
      "WHERE (NEW.entry_kind IN ('waiver_request', 'waiver_decision') OR NEW.basis = 'person_reversal')",
    "WHERE (NEW.entry_kind IN ('clear', 'waiver_request')":
      "WHERE (NEW.entry_kind IN ('clear', 'waiver_request', 'reverse')",
  };
  let at = 0;
  for (const line of lines(trigger(read("0155_od01_deposit_policy.sql")))) {
    if (!line || line.startsWith("--") || line.startsWith("CREATE TRIGGER")) continue;
    const found = recreated.indexOf(widened[line] ?? line, at);
    assert.ok(found >= 0, `the final validate guard carries, in order: ${line}`);
    at = found + 1;
  }
});

test("the validate trigger after every migration still holds A1's, A2's and A3's clauses", () => {
  const { sqlite: db } = setup();
  const body = String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'production_gate_clearances_validate_insert'",
  ).get() as { sql: string }).sql);
  for (const clause of [
    // A1 (0153): the legacy close, the waiver matrix, settlement, decisions, the bound on open
    // requests, no contract facts on a person entry, and the seed refusal.
    "production_gate_clearance_legacy_closed",
    "production_gate_not_waivable",
    "deposit_settlement_not_observed",
    "production_gate_waiver_request_invalid",
    "production_gate_waiver_request_open",
    "production_gate_waiver_already_decided",
    "production_gate_waiver_self_approval_refused",
    "production_gate_clearance_seed_identity_refused",
    "NEW.policy_version IS NOT NULL",
    "NEW.terms_hash IS NOT NULL",
    "NEW.contract_binding_id IS NOT NULL",
    // A3 (0158): attestation, its evidence and gate rules, and the person reversal.
    "'person_attestation'",
    "'person_reversal'",
    "production_gate_safety_person_only",
    "production_gate_attester_on_crew",
    "production_gate_attestation_invalid",
    "COUNT(DISTINCT key) FROM json_each(NEW.attestation_json)",
    "production_gate_evidence_invalid",
    "NOT json_valid(NEW.evidence_refs_json)",
    "production_gate_material_exception_open",
    "production_gate_safety_stop_active",
    "occurrence.scope_type = 'tenant'",
    "FROM work_packages package",
    "FROM work_package_events crew_stop",
    "FROM work_package_stop_releases released",
    "production_gate_competency_required",
    "competency.authority_scope = 'site_safety'",
    "production_gate_safety_permit_unknown",
    "'$.permit.answer'",
    "production_gate_stop_job_unknown",
    "FROM operating_roof_jobs job",
    "'$.permit.number'",
    "production_gate_forecast_stale",
    "production_gate_weather_window_invalid",
    "production_gate_reversal_target_invalid",
    // A2 (0155): the Deposit gate's policy entries and the contract facts they rest on, and no
    // person reversing a contract that needs no deposit.
    "'contract_no_deposit'",
    "'contract_superseded'",
    "'ironwrap.deposit-gate.v1'",
    "production_gate_contract_no_deposit_not_reversible",
    "production_gate_contract_no_deposit_not_observed",
    "deposit_terms_not_allowed_by_policy",
    "production_gate_contract_superseded_not_observed",
  ]) {
    assert.ok(body.includes(clause), `the final validate trigger keeps ${clause}`);
  }
  // A replayed key still reports itself before validation: the replace guard is the newest trigger.
  assert.deepEqual(
    db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'production_gate_clearances' AND sql LIKE '%BEFORE INSERT%'
        ORDER BY rowid DESC LIMIT 1`,
    ).all().map((row) => (row as { name: string }).name),
    ["production_gate_clearances_no_insert_replace"],
  );
});

test("`production.gates.safety` is carried by exactly the roles D1 admits to attest Safety", () => {
  const holders = (Object.keys(ROLE_PERMISSIONS) as AppRole[])
    .filter((role) => ROLE_PERMISSIONS[role].includes(PRODUCTION_GATE_SAFETY_PERMISSION));
  assert.deepEqual(holders, ["owner", "production"]);
  const { sqlite: db } = setup();
  for (const access of ["owner", "ops", "sales", "admin", "production", "shop", "accounting"]) {
    const userId = `appu_role_${access}_safety`;
    db.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Synthetic role', ?, ?, NULL, 1, 'owner@example.invalid', ?, ?)`,
    ).run(userId, TENANT, `${userId}@example.invalid`, access === "owner" ? "owner" : "ops", access, at(-DAY), at(-DAY));
    const competency = insertCompetency(db, userId);
    const attempt = () => append(db, { gate: "Safety", actor_user_id: userId, actor_role: access, attestation_json: safetyStored(competency), idempotency_key_hash: sha(`role:${access}`) });
    if (holders.includes(access as AppRole)) {
      attempt();
      const latest = ledgerRows(db).at(-1)!;
      append(db, reversal("Safety", latest.clearance_id, { actor_user_id: USERS.owner.id, actor_role: "owner" }));
    } else {
      refused(attempt, "production_gate_clearance_actor_invalid");
    }
  }
});

// --- Parsing ----------------------------------------------------------------------------------

test("an attestation body has exactly its keys, and times, notes and constraints are canonical", () => {
  const now = new Date();
  const parsed = parseProductionGateAttestation("Access", {
    basis: "person_attestation",
    expected_gate_version: 3,
    attestation: {
      confirmed_with: "customer",
      confirmed_at: "2026-01-02T03:04:05Z",
      constraints: ["storage", "delivery"],
      notes: "  🚧 gate code with the neighbour  ",
    },
    evidence_refs: ["stock-reservation://reservation.attest.0009", `field-evidence://evi_${"0".repeat(32)}`],
  }, now);
  assert.deepEqual(parsed, {
    gate: "Access",
    expectedGateVersion: 3,
    attestation: { confirmed_with: "customer", confirmed_at: "2026-01-02T03:04:05.000Z", constraints: ["delivery", "storage"] },
    note: "🚧 gate code with the neighbour",
    evidenceRefs: [`field-evidence://evi_${"0".repeat(32)}`, "stock-reservation://reservation.attest.0009"],
  });
  // A note is counted in code points: 300 four-byte characters fit, 301 do not.
  const noted = (notes: string) => parseProductionGateAttestation("Materials", {
    basis: "person_attestation",
    expected_gate_version: 1,
    attestation: { source: "none_needed", reference: "Q-1042", notes },
  }, now);
  assert.equal(noted("🚧".repeat(300))?.note, "🚧".repeat(300));
  assert.equal(noted("🚧".repeat(301)), null);
  assert.equal(noted("carriage\rreturn"), null);
  assert.equal(noted("   ")?.note, null);
  assert.equal(parseEvidenceRefs(["field-evidence://evi_short"]), null);
  assert.deepEqual(parseEvidenceRefs(undefined), []);
  // Safety's permit: held with a number of single-spaced words, not needed, or unknown; the route
  // refuses an unknown answer by name after the shape is accepted.
  const permitOf = (permit: unknown) => (parseProductionGateAttestation("Safety", {
    basis: "person_attestation",
    expected_gate_version: 1,
    attestation: {
      hazard_assessment_ref: "FLHA-1",
      fall_protection: { no_exposure_at_3m: true },
      assessed_at: new Date(now.getTime() - HOUR).toISOString(),
      ...(permit === undefined ? {} : { permit }),
    },
  }, now)?.attestation as { permit?: unknown } | undefined)?.permit ?? null;
  for (const permit of [
    { answer: "needed_and_held", number: "building permit 4417" },
    { answer: "needed_and_held", number: `B${" P".repeat(39)}1` },
    { answer: "not_needed" },
    { answer: "unknown" },
  ]) {
    assert.deepEqual(permitOf(permit), permit, JSON.stringify(permit));
  }
  for (const permit of [
    undefined,
    "needed_and_held",
    { answer: "Needed_and_held", number: "BP-4417" },
    { answer: "maybe" },
    { answer: "needed_and_held" },
    { answer: "needed_and_held", number: "" },
    { answer: "needed_and_held", number: 4417 },
    { answer: "needed_and_held", number: "building  permit" },
    { answer: "needed_and_held", number: "building permit " },
    { answer: "needed_and_held", number: " building permit" },
    { answer: "needed_and_held", number: "building\tpermit" },
    { answer: "needed_and_held", number: `B${" P".repeat(40)}` },
    { answer: "not_needed", number: "BP-4417" },
    { answer: "unknown", number: "BP-4417" },
    { answer: "unknown", note: "nobody checked" },
  ]) {
    assert.equal(permitOf(permit), null, JSON.stringify(permit));
  }
  const reversalBody = { expected_gate_version: 2, reverses_id: `pgc_${"a".repeat(40)}`, reason: "Supplier recalled the panels." };
  assert.deepEqual(parseProductionGateReversal(reversalBody), {
    expectedGateVersion: 2,
    reversesId: reversalBody.reverses_id,
    reason: reversalBody.reason,
  });
  assert.equal(parseProductionGateReversal({ ...reversalBody, expected_gate_version: 0 }), null);
});

test("the weather rule answers stale forecasts before windows, at its exact bounds", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const shifted = (hours: number) => new Date(now.getTime() + hours * HOUR).toISOString();
  const weather = (changes: Partial<WeatherAttestation>): WeatherAttestation => ({
    window_start: shifted(0),
    window_end: shifted(14 * 24),
    forecast_source: "weather.gc.ca",
    forecast_observed_at: shifted(0),
    ...changes,
  });
  assert.equal(weatherRefusal(weather({}), now), null, "exactly 14 days on a fresh forecast");
  assert.equal(weatherRefusal(weather({ window_end: shifted(14 * 24 + 1) }), now), "production_gate_weather_window_invalid");
  assert.equal(weatherRefusal(weather({ forecast_observed_at: shifted(-72) }), now), "production_gate_weather_window_invalid", "ends past the forecast's 14 days");
  assert.equal(weatherRefusal(weather({ forecast_observed_at: shifted(-72), window_end: shifted(10 * 24) }), now), null);
  assert.equal(weatherRefusal(weather({ forecast_observed_at: shifted(-73), window_end: shifted(24) }), now), "production_gate_forecast_stale");
});
