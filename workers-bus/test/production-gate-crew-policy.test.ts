// production-gate-crew-policy.test.ts - Crew clears by policy when a job is scheduled, and a
// schedule rests on the gate evidence as it stands when it is written (migration 0159).
//
// The store and route cases drive `recordOperatingJobAssignment` and the real schedule route through
// a person's real cookie session, and assert what the ledger, the Crew gate and the audit log hold
// afterwards. The D1 cases write SQL straight at the database, the way a defective writer would, and
// prove each rule is refused there too, after 0098's own rules.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import {
  OperatingJobAssignmentError,
  recordOperatingJobAssignment,
  type RecordOperatingJobAssignmentInput,
} from "../src/operating-job-assignment-store.ts";
import {
  attestGateInLedger,
  bindCrewInLedger,
  clearScheduleGatesInLedger,
  fixtureSchedule,
  fixtureWeatherWindow,
  reverseGateInLedger,
  waiveGateInLedger,
} from "./production-gate-ledger-fixture.ts";

// Synthetic fixtures only: reserved example.invalid identities and times relative to the real clock,
// which is the clock D1 checks the Weather window against.
const TENANT = "ironwrap";
const PEPPER = "synthetic-crew-policy-pepper-0123456789";
const JOB = "job:crew:0001";
const OTHER_JOB = "job:crew:0002";
const CREW_A = "crew:policy:a";
const CREW_B = "crew:policy:b";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const USERS = {
  owner: { id: "appu_owner_crew_01", role: "owner", access: "owner" },
  production: { id: "appu_production_crew", role: "ops", access: "production" },
  ops: { id: "appu_ops_crew_000001", role: "ops", access: "ops" },
  seed: { id: "appu_seed_owner_crew", role: "owner", access: "owner" },
  fieldA: { id: "appu_field_crew_a01", role: "field", access: "field" },
  fieldB: { id: "appu_field_crew_b01", role: "field", access: "field" },
  fieldC: { id: "appu_field_crew_c01", role: "field", access: "field" },
} as const;
type User = (typeof USERS)[keyof typeof USERS];

class TestD1 {
  readonly sqlite: DatabaseSync;

  constructor(sqlite = new DatabaseSync(":memory:")) {
    this.sqlite = sqlite;
  }

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

  /** Runs right before the next batch, as a writer that committed just ahead of it. */
  beforeNextBatch: (() => void) | null = null;

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const before = this.beforeNextBatch;
    this.beforeNextBatch = null;
    before?.();
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
  /** The Weather window a person attested, when the harness is `ready`. */
  window: { start: string; end: string };
}

function envFor(db: TestD1): AppEnv {
  return {
    DB: db as never,
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
    APP_TIME_ZONE: "America/Edmonton",
  } as AppEnv;
}

const gateId = (gate: string, job = JOB) => `gate:${job === JOB ? "crew" : "crew-other"}:${gate.toLowerCase()}`;

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
  const email = `crew-${suffix}@example.invalid`;
  db.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES (?, 'manual', 'Crew Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(`ow_crew_policy_${suffix}`, email, `raw/crew/${suffix}.json`, now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'Crew Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(`lead:crew:${suffix}`, TENANT, `ow_crew_policy_${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'Crew Customer', ?, 'active', 1, ?, ?)`,
  ).run(`customer:crew:${suffix}`, TENANT, `ow_crew_policy_${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
        service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ironwrap', ?, 'Roofing', 'qualified', 'blocked', 1, ?, ?)`,
  ).run(jobId, TENANT, `lead:crew:${suffix}`, `customer:crew:${suffix}`, `ow_crew_policy_${suffix}`, `IW-CREW-${suffix}`, now, now);
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    db.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'owner@example.invalid', ?, ?, 'No active blocker', ?, ?)`,
    ).run(gateId(gate, jobId), TENANT, jobId, `ow_crew_policy_${suffix}`, gate, now, at(7 * DAY), now, now);
  }
}

function insertCrew(db: DatabaseSync, crewId: string, members: User[]): void {
  db.prepare(
    `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Crew', 'Active', 1, ?, ?)`,
  ).run(crewId, TENANT, at(-DAY), at(-DAY));
  for (const member of members) {
    db.prepare(
      `INSERT INTO fleet_crew_members
         (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    ).run(`membership:${crewId}:${member.id}`, TENANT, crewId, member.id, at(-DAY), at(-DAY));
  }
}

/**
 * The full migration chain, two jobs with six blocked gates each, two crews, and the people who
 * touch them: an owner, a production attester on no crew, ops, the QA seed owner and three field
 * workers. With `ready`, a person has cleared the five gates the schedule rests on.
 */
function setup(options: { ready?: boolean } = {}): Harness {
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
  insertCrew(db.sqlite, CREW_A, [USERS.fieldA, USERS.fieldB]);
  insertCrew(db.sqlite, CREW_B, [USERS.fieldC]);
  const window = fixtureWeatherWindow();
  if (options.ready !== false) ready(db.sqlite, JOB, window);
  return { env: envFor(db), db, sqlite: db.sqlite, window };
}

function ready(db: DatabaseSync, job = JOB, window = fixtureWeatherWindow()): void {
  clearScheduleGatesInLedger(db, {
    tenantId: TENANT,
    roofJobId: job,
    ownerUserId: USERS.owner.id,
    attesterUserId: USERS.production.id,
    attesterRole: "production",
    window,
  });
}

let keyCounter = 0;
const nextKey = () => `crew-policy-key-${(++keyCounter).toString().padStart(12, "0")}`;

function command(overrides: Partial<RecordOperatingJobAssignmentInput> = {}): RecordOperatingJobAssignmentInput {
  const day = fixtureSchedule(1);
  return {
    tenantId: TENANT,
    roofJobId: JOB,
    expectedRoofJobVersion: 1,
    crewId: CREW_A,
    expectedCrewVersion: 1,
    authorityRequirements: [{
      authority_record_id: "authority:crew-policy:worker",
      subject_type: "Person",
      subject_role: "Worker",
      subject_ref: USERS.fieldA.id,
      authority_kind: "Worker Competency",
      scope_type: "Roof Job",
      scope_ref: JOB,
      version: 1,
      state_digest_sha256: "c".repeat(64),
    }],
    scheduledStart: day.start,
    scheduledEnd: day.end,
    supersedesAssignmentId: null,
    correctionReason: null,
    actorUserId: USERS.ops.id,
    idempotencyKey: nextKey(),
    ...overrides,
  };
}

async function revise(
  h: Harness,
  previous: string,
  overrides: Partial<RecordOperatingJobAssignmentInput> = {},
) {
  return await recordOperatingJobAssignment(h.env, command({
    supersedesAssignmentId: previous,
    correctionReason: "Synthetic schedule revision for repository proof only.",
    ...overrides,
  }));
}

function crewGate(db: DatabaseSync, job = JOB): Record<string, unknown> {
  return {
    ...(db.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id,
              evidence_refs_json
         FROM operating_production_gates WHERE gate_id = ?`,
    ).get(gateId("Crew", job)) as Record<string, unknown>),
  };
}

function crewEntries(db: DatabaseSync, job = JOB): Array<Record<string, any>> {
  return db.prepare(
    `SELECT clearance_id, entry_kind, basis, to_state, from_gate_version, reverses_id, actor_kind,
            actor_user_id, actor_role, policy_version, evidence_refs_json, reason, attestation_json
       FROM production_gate_clearances
      WHERE gate_id = ? ORDER BY from_gate_version`,
  ).all(gateId("Crew", job)).map((row) => ({ ...row }));
}

function auditRows(db: DatabaseSync, clearanceId: string): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT action, trigger, approved_by, source_ids FROM audit_log WHERE run_id = ?",
  ).all(clearanceId).map((row) => ({ ...row }));
}

function assignmentCount(db: DatabaseSync, job = JOB): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS n FROM operating_job_assignments WHERE roof_job_id = ?",
  ).get(job) as { n: number }).n);
}

const binding = (assignmentId: string, crewId = CREW_A, crewVersion = 1) =>
  ({ assignment_id: assignmentId, crew_id: crewId, crew_version: crewVersion });

async function rejectsWith(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    const message = error instanceof OperatingJobAssignmentError ? error.code : String((error as Error).message);
    assert.match(message, new RegExp(code));
    return true;
  });
}

function refused(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

let stopCounter = 0;

/** An active safety stop, as a field worker reports one. Its id is the stop a person opens. */
function stop(h: Harness, scopeType: string, scopeId: string): string {
  stopCounter += 1;
  const occurrenceId = `occurrence.crew.${stopCounter}`;
  h.sqlite.prepare(
    `INSERT INTO safety_occurrences
       (occurrence_id, tenant_id, occurrence_kind, severity, scope_type, scope_id,
        reported_by_user_id, reported_at, summary, report_fingerprint_sha256, created_at,
        updated_at)
     VALUES (?, ?, 'hazard', 'high', ?, ?, ?, ?, 'Synthetic hazard report for repository proof only.', ?, ?, ?)`,
  ).run(occurrenceId, TENANT, scopeType, scopeId, USERS.fieldA.id, at(-HOUR), sha(`stop:${stopCounter}`), at(-HOUR), at(-HOUR));
  return occurrenceId;
}

// --- The schedule binds Crew by policy ----------------------------------------------------------

test("a schedule binds Crew by policy in its own batch, with one audit row, and a replay appends nothing", async () => {
  const h = setup();
  assert.deepEqual(crewGate(h.sqlite), {
    state: "blocked", version: 1, clearance_basis: null, clearance_decision_id: null,
    cleared_by_user_id: null, evidence_refs_json: null,
  });
  const input = command();
  const first = await recordOperatingJobAssignment(h.env, input);
  assert.equal(first.kind, "created");
  const [entry, ...rest] = crewEntries(h.sqlite);
  assert.deepEqual(rest, []);
  const { clearance_id: clearanceId, ...stored } = entry!;
  assert.deepEqual(stored, {
    entry_kind: "clear", basis: "crew_assignment", to_state: "complete", from_gate_version: 1,
    reverses_id: null, actor_kind: "policy", actor_user_id: null, actor_role: null,
    policy_version: "ironwrap.crew-gate.v1",
    evidence_refs_json: JSON.stringify(binding(first.assignment.assignment_id)),
    reason: null, attestation_json: null,
  });
  // The apply trigger is the gate's only writer: complete, one version on, bound to the crew.
  assert.deepEqual(crewGate(h.sqlite), {
    state: "complete", version: 2, clearance_basis: null, clearance_decision_id: clearanceId,
    cleared_by_user_id: null, evidence_refs_json: stored.evidence_refs_json,
  });
  assert.deepEqual(auditRows(h.sqlite, clearanceId), [{
    action: "clear:crew_assignment",
    trigger: "policy",
    approved_by: null,
    source_ids: `job:${JOB},gate:Crew,from_version:1,to_state:complete`,
  }]);

  assert.deepEqual(await recordOperatingJobAssignment(h.env, input), { kind: "replayed", assignment: first.assignment });
  assert.equal(crewEntries(h.sqlite).length, 1);
  assert.equal(assignmentCount(h.sqlite), 1);
});

test("a revision with the same crew keeps Crew bound; another crew or crew version re-binds it with a reversal and a clear", async () => {
  const h = setup();
  const first = await recordOperatingJobAssignment(h.env, command());
  const moved = await revise(h, first.assignment.assignment_id, {
    scheduledStart: fixtureSchedule(2).start,
    scheduledEnd: fixtureSchedule(2).end,
  });
  assert.equal(crewEntries(h.sqlite).length, 1, "the same crew at the same version needs no new entry");
  assert.equal(crewGate(h.sqlite).version, 2);

  const other = await revise(h, moved.assignment.assignment_id, { crewId: CREW_B });
  const [, reversal, clear] = crewEntries(h.sqlite);
  assert.deepEqual(
    {
      kind: reversal!.entry_kind, basis: reversal!.basis, to: reversal!.to_state,
      from: reversal!.from_gate_version, reverses: reversal!.reverses_id, actor: reversal!.actor_kind,
      evidence: JSON.parse(reversal!.evidence_refs_json),
    },
    {
      kind: "reverse", basis: "crew_superseded", to: "blocked", from: 2,
      reverses: crewEntries(h.sqlite)[0]!.clearance_id, actor: "policy",
      evidence: binding(other.assignment.assignment_id, CREW_B),
    },
  );
  assert.deepEqual(
    { kind: clear!.entry_kind, basis: clear!.basis, to: clear!.to_state, from: clear!.from_gate_version },
    { kind: "clear", basis: "crew_assignment", to: "complete", from: 3 },
  );
  assert.deepEqual(JSON.parse(clear!.evidence_refs_json), binding(other.assignment.assignment_id, CREW_B));
  assert.deepEqual({ state: crewGate(h.sqlite).state, version: crewGate(h.sqlite).version }, { state: "complete", version: 4 });
  assert.deepEqual(auditRows(h.sqlite, reversal!.clearance_id).map((row) => [row.action, row.trigger]), [["reverse:crew_superseded", "policy"]]);
  assert.deepEqual(auditRows(h.sqlite, clear!.clearance_id).map((row) => [row.action, row.trigger]), [["clear:crew_assignment", "policy"]]);

  // The same crew at its next version is another binding.
  h.sqlite.prepare("UPDATE fleet_crews SET version = 2, display_name = 'Renamed Crew' WHERE crew_id = ?").run(CREW_B);
  const renamed = await revise(h, other.assignment.assignment_id, { crewId: CREW_B, expectedCrewVersion: 2 });
  assert.deepEqual(JSON.parse(crewEntries(h.sqlite).at(-1)!.evidence_refs_json), binding(renamed.assignment.assignment_id, CREW_B, 2));
  assert.equal(crewGate(h.sqlite).version, 6);

  // A person's reversal blocks Crew again; the next schedule binds it with a single clear.
  reverseGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate: "Crew", actorUserId: USERS.production.id, actorRole: "production" });
  assert.deepEqual({ state: crewGate(h.sqlite).state, version: crewGate(h.sqlite).version }, { state: "blocked", version: 7 });
  const rebound = await revise(h, renamed.assignment.assignment_id, { crewId: CREW_B, expectedCrewVersion: 2 });
  const last = crewEntries(h.sqlite).at(-1)!;
  assert.deepEqual([last.entry_kind, last.from_gate_version], ["clear", 7]);
  assert.deepEqual(JSON.parse(last.evidence_refs_json), binding(rebound.assignment.assignment_id, CREW_B, 2));
  for (const row of crewEntries(h.sqlite)) assert.equal(auditRows(h.sqlite, row.clearance_id).length, 1);
});

test("a schedule D1 refuses leaves no Crew entry: the entries and the assignment commit together", async () => {
  const h = setup();
  // A stale job version passes every Worker read and fails 0098 inside the batch, after the entry.
  await rejectsWith(
    recordOperatingJobAssignment(h.env, command({ expectedRoofJobVersion: 2 })),
    "operating_job_assignment_job_invalid",
  );
  assert.deepEqual(crewEntries(h.sqlite), []);
  assert.deepEqual({ state: crewGate(h.sqlite).state, version: crewGate(h.sqlite).version }, { state: "blocked", version: 1 });
  assert.equal(assignmentCount(h.sqlite), 0);
  assert.equal(
    (h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE automation = 'production_gate_clearance' AND source_ids LIKE '%gate:Crew%'").get() as { n: number }).n,
    0,
  );
});

test("a Crew gate another schedule moved while this one was written answers with the ledger's code", async () => {
  const h = setup();
  // Another schedule binds Crew between this schedule's read and its batch.
  h.db.beforeNextBatch = () =>
    bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_B, assignmentId: "assignment:crew:raced" });
  await rejectsWith(recordOperatingJobAssignment(h.env, command()), "production_gate_version_conflict");
  assert.equal(assignmentCount(h.sqlite), 0);
  assert.deepEqual(crewEntries(h.sqlite).map((row) => JSON.parse(row.evidence_refs_json).assignment_id), ["assignment:crew:raced"]);
  // The route names it too.
  h.db.beforeNextBatch = () => {
    reverseGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate: "Crew", actorUserId: USERS.owner.id, actorRole: "owner" });
  };
  const raced = await schedule(h, await person(h, USERS.ops.id));
  assert.deepEqual([raced.status, raced.body], [409, { error: "production_gate_version_conflict" }]);
  assert.equal(assignmentCount(h.sqlite), 0);
});

// --- The schedule's named refusals ---------------------------------------------------------------

test("the store answers 0098's rules first, then each 0159 rule by name, and writes nothing", async () => {
  const h = setup({ ready: false });
  await rejectsWith(recordOperatingJobAssignment(h.env, command()), "operating_job_assignment_gates_blocked");
  ready(h.sqlite, JOB, h.window);
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ expectedCrewVersion: 2 })), "operating_job_assignment_crew_invalid");
  // A member who is no longer an active field user: 0098's roster rule, not the Crew entry's.
  h.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.fieldB.id);
  await rejectsWith(recordOperatingJobAssignment(h.env, command()), "operating_job_assignment_roster_invalid");
  h.sqlite.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(USERS.fieldB.id);
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ actorUserId: USERS.seed.id })), "operating_job_assignment_seed_identity_refused");
  await rejectsWith(
    recordOperatingJobAssignment(h.env, command({ scheduledStart: at(-2 * DAY), scheduledEnd: at(-2 * DAY + 8 * HOUR) })),
    "operating_job_assignment_outside_weather_window",
  );
  const past = (offset: number) => new Date(Date.parse(h.window.end) + offset).toISOString();
  await rejectsWith(
    recordOperatingJobAssignment(h.env, command({ scheduledStart: fixtureSchedule(10).start, scheduledEnd: past(1) })),
    "operating_job_assignment_outside_weather_window",
  );
  // A schedule with no end is held to its start.
  await rejectsWith(
    recordOperatingJobAssignment(h.env, command({ scheduledStart: past(HOUR), scheduledEnd: null })),
    "operating_job_assignment_outside_weather_window",
  );
  assert.deepEqual(crewEntries(h.sqlite), []);
  assert.equal(assignmentCount(h.sqlite), 0);
  const open = await recordOperatingJobAssignment(h.env, command({ scheduledStart: fixtureSchedule(3).start, scheduledEnd: null }));
  assert.equal(open.assignment.scheduled_end, null);
});

test("0098's refusals answer ahead of a stop that applies to the job, on the store and in D1", async () => {
  const h = setup();
  stop(h, "roof_job", JOB);
  bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId: "assignment:crew:order" });
  const direct = (overrides: Record<string, unknown>) => () =>
    insertAssignment(h.sqlite, { assignment_id: "assignment:crew:order", ...overrides });
  // A stale job version.
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ expectedRoofJobVersion: 2 })), "operating_job_assignment_job_invalid");
  refused(direct({ roof_job_version: 2 }), "operating_job_assignment_job_invalid");
  // A crew at another version, and an actor who does not schedule.
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ expectedCrewVersion: 2 })), "operating_job_assignment_crew_invalid");
  refused(direct({ crew_version: 2 }), "operating_job_assignment_crew_invalid");
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ actorUserId: USERS.fieldA.id })), "operating_job_assignment_actor_invalid");
  refused(direct({ actor_user_id: USERS.fieldA.id }), "operating_job_assignment_actor_invalid");
  // A cancelled job.
  h.sqlite.prepare("UPDATE operating_roof_jobs SET job_status = 'cancelled', version = version + 1 WHERE roof_job_id = ?").run(JOB);
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ expectedRoofJobVersion: 2 })), "operating_job_assignment_job_invalid");
  refused(direct({ roof_job_version: 2 }), "operating_job_assignment_job_invalid");
  h.sqlite.prepare("UPDATE operating_roof_jobs SET job_status = 'qualified', version = version + 1 WHERE roof_job_id = ?").run(JOB);
  // Only then the stop.
  await rejectsWith(recordOperatingJobAssignment(h.env, command({ expectedRoofJobVersion: 3 })), "operating_job_assignment_stop_active");
  refused(direct({ roof_job_version: 3 }), "operating_job_assignment_stop_active");
  assert.equal(assignmentCount(h.sqlite), 0);
});

test("a crew that shares any login coordinate with a current attester is refused, on the store and in D1", async () => {
  // Production attested Materials, Safety, Access and Weather. Each case makes a field login of
  // crew A the same person as production under one pairing of coordinates.
  const productionEmail = `${USERS.production.id}@example.invalid`;
  const fieldBEmail = `${USERS.fieldB.id}@example.invalid`;
  const cases: Array<[string, Array<[string, string]>]> = [
    ["the worker's Frappe user is the attester's email", [[USERS.fieldB.id, ` ${productionEmail.toUpperCase()} `]]],
    ["the worker's Frappe user is the attester's user id", [[USERS.fieldB.id, USERS.production.id.toUpperCase()]]],
    ["the attester's Frappe user is the worker's email", [[USERS.production.id, fieldBEmail]]],
    ["the attester's Frappe user is the worker's user id", [[USERS.production.id, ` ${USERS.fieldB.id} `]]],
    ["both carry the same Frappe user", [[USERS.fieldB.id, "frappe:crew:shared"], [USERS.production.id, "FRAPPE:CREW:SHARED"]]],
  ];
  for (const [label, frappeUsers] of cases) {
    const h = setup();
    for (const [userId, frappeUser] of frappeUsers) {
      h.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?").run(frappeUser, userId);
    }
    await rejectsWith(recordOperatingJobAssignment(h.env, command()), "operating_job_assignment_crew_not_independent");
    bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId: "assignment:crew:shared" });
    refused(() => insertAssignment(h.sqlite, { assignment_id: "assignment:crew:shared" }), "operating_job_assignment_crew_not_independent");
    assert.equal(assignmentCount(h.sqlite), 0, label);
    // Crew B shares nothing with production.
    assert.equal((await recordOperatingJobAssignment(h.env, command({ crewId: CREW_B }))).kind, "created", label);
  }
});

test("a crew is independent again once the attestations it shares a login with no longer hold the gates", async () => {
  const h = setup();
  // A field login of crew A carries the production attester's email as its Frappe user.
  h.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
    .run(`${USERS.production.id}@example.invalid`, USERS.fieldB.id);
  await rejectsWith(recordOperatingJobAssignment(h.env, command()), "operating_job_assignment_crew_not_independent");
  const scheduled = await recordOperatingJobAssignment(h.env, command({ crewId: CREW_B }));
  assert.equal(scheduled.kind, "created");
  // Once the attestation that person made no longer holds the gate, the crew is independent again.
  reverseGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate: "Materials", actorUserId: USERS.owner.id, actorRole: "owner" });
  attestGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate: "Materials", actorUserId: USERS.owner.id, actorRole: "owner" });
  await rejectsWith(revise(h, scheduled.assignment.assignment_id), "operating_job_assignment_crew_not_independent");
  for (const gate of ["Safety", "Access", "Weather"] as const) {
    reverseGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate, actorUserId: USERS.owner.id, actorRole: "owner" });
    attestGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate, actorUserId: USERS.owner.id, actorRole: "owner" });
  }
  const independent = await revise(h, scheduled.assignment.assignment_id);
  assert.equal(independent.assignment.crew_id, CREW_A);
});

test("an active stop on the job or the tenant holds the schedule; another job's stop does not", async () => {
  for (const [scopeType, scopeId] of [["roof_job", JOB], ["tenant", TENANT]] as const) {
    const h = setup();
    stop(h, scopeType, scopeId);
    await rejectsWith(recordOperatingJobAssignment(h.env, command()), "operating_job_assignment_stop_active");
    bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId: "assignment:crew:stopped" });
    refused(() => insertAssignment(h.sqlite, { assignment_id: "assignment:crew:stopped" }), "operating_job_assignment_stop_active");
    assert.equal(assignmentCount(h.sqlite), 0, scopeType);
  }
  // A stop on another job, a shop or a vehicle does not apply here.
  const h = setup();
  stop(h, "roof_job", OTHER_JOB);
  stop(h, "shop", "shop:crew:0001");
  stop(h, "vehicle", "vehicle:crew:0001");
  assert.equal((await recordOperatingJobAssignment(h.env, command())).kind, "created");
});

test("a stop naming a job or a work package the tenant does not have holds every schedule by its own code, with the stop's id", async () => {
  // Each case holds the stops from the one before it but one: the first named rule answers.
  const cases = [
    ["roof_job", "IW-CREW-0001", "operating_job_assignment_stop_job_unknown"],
    ["work_package", "wp:crew:unknown", "operating_job_assignment_stop_work_package_unknown"],
  ] as const;
  for (const [index, [scopeType, scopeId, code]] of cases.entries()) {
    const h = setup();
    // Both jobs are ready before the stops: once they stand, no Safety is attested on either.
    ready(h.sqlite, OTHER_JOB, h.window);
    const stopId = stop(h, scopeType, scopeId);
    for (const [laterType, laterId] of cases.slice(index + 1)) stop(h, laterType, laterId);
    // A stop on the job itself would hold the schedule too; the named rule answers first.
    stop(h, "roof_job", JOB);
    // The QA seed owner is refused before any stop is read.
    await rejectsWith(recordOperatingJobAssignment(h.env, command({ actorUserId: USERS.seed.id })), "operating_job_assignment_seed_identity_refused");
    await assert.rejects(recordOperatingJobAssignment(h.env, command()), (error: unknown) => {
      assert.ok(error instanceof OperatingJobAssignmentError, String(error));
      assert.deepEqual([error.code, error.detail], [code, { stop_id: stopId }]);
      return true;
    });
    bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId: "assignment:crew:unknown" });
    refused(() => insertAssignment(h.sqlite, { assignment_id: "assignment:crew:unknown", actor_user_id: USERS.seed.id }), "operating_job_assignment_seed_identity_refused");
    refused(() => insertAssignment(h.sqlite, { assignment_id: "assignment:crew:unknown" }), code);
    // It holds the other job's schedule as well: it may be meant for either.
    await rejectsWith(recordOperatingJobAssignment(h.env, command({ roofJobId: OTHER_JOB })), code);
    assert.equal(assignmentCount(h.sqlite) + assignmentCount(h.sqlite, OTHER_JOB), 0, scopeType);
  }
});

test("0159's stop rules are the ones a Safety attestation is held to, carried unchanged", () => {
  const body = (sql: string, open: string) => {
    const at = sql.indexOf(open);
    assert.ok(at >= 0, open);
    return sql.slice(at + open.length, sql.indexOf("\n    );\n", at) + 1);
  };
  const validate = triggerText(read("0159_production_gate_crew_policy.sql"), "production_gate_clearances_validate_insert");
  const guard = triggerText(read("0159_production_gate_crew_policy.sql"), "operating_job_assignments_gate_evidence_guard");
  const safety = (code: string, opener: string) => body(validate, [
    `  SELECT RAISE(ABORT, '${code}')`,
    "  WHERE NEW.basis = 'person_attestation'",
    "    AND NEW.gate = 'Safety'",
    opener,
  ].join("\n"));
  for (const [attestation, schedule, opener] of [
    ["production_gate_stop_job_unknown", "operating_job_assignment_stop_job_unknown", "    AND EXISTS (\n"],
    ["production_gate_stop_work_package_unknown", "operating_job_assignment_stop_work_package_unknown", "    AND EXISTS (\n"],
    ["production_gate_safety_stop_active", "operating_job_assignment_stop_active", "    AND (\n"],
  ] as const) {
    // The schedule's rule opens on WHERE where the attestation's adds AND to its gate.
    const held = body(guard, `  SELECT RAISE(ABORT, '${schedule}')\n  WHERE ${opener.trim().replace(/^AND /, "")}\n`);
    assert.equal(held, safety(attestation, opener), schedule);
  }
  // 0158's own rules are the ones 0159 carries.
  const shipped = triggerText(read("0158_production_gate_attestations.sql"), "production_gate_clearances_validate_insert");
  assert.ok(shipped.includes(safety("production_gate_stop_job_unknown", "    AND EXISTS (\n")));
  assert.ok(shipped.includes(safety("production_gate_safety_stop_active", "    AND (\n")));
  assert.match(guard, /scope_type = 'tenant'/);
  assert.match(guard, /work_package_stop_releases/);
});

test("a Weather gate left ready after its window ended no longer schedules, read on D1's clock", async () => {
  const h = setup({ ready: false });
  // A window that ends three seconds from now: long enough to attest, short enough to wait out.
  const window = { start: at(-HOUR), end: at(3_000) };
  ready(h.sqlite, JOB, window);
  // The work fits the window as attested, and the schedule claims a creation time inside it.
  const input = command({ scheduledStart: at(-30 * 60_000), scheduledEnd: window.end });
  while (Date.now() <= Date.parse(window.end)) await new Promise((resolve) => setTimeout(resolve, 25));
  await rejectsWith(recordOperatingJobAssignment(h.env, input, new Date(Date.parse(window.start))), "operating_job_assignment_weather_window_ended");
  assert.deepEqual(crewEntries(h.sqlite), []);
  // D1 refuses the same row under any created_at.
  bindCrewInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId: "assignment:crew:stale-window" });
  refused(
    () => insertAssignment(h.sqlite, {
      assignment_id: "assignment:crew:stale-window",
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      created_at: window.start,
    }),
    "operating_job_assignment_weather_window_ended",
  );
});

// --- D1 -------------------------------------------------------------------------------------------

let assignmentCounter = 0;

/** Insert one assignment with direct SQL, defaulting to a valid first schedule of crew A. */
function insertAssignment(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  assignmentCounter += 1;
  const day = fixtureSchedule(1);
  const row: Record<string, unknown> = {
    assignment_id: `assignment:crew:direct:${assignmentCounter}`,
    tenant_id: TENANT,
    roof_job_id: JOB,
    assignment_version: 1,
    roof_job_version: 1,
    crew_id: CREW_A,
    crew_version: 1,
    assigned_users_json: JSON.stringify([USERS.fieldA.id, USERS.fieldB.id]),
    scheduled_start: day.start,
    scheduled_end: day.end,
    supersedes_assignment_id: null,
    correction_reason: null,
    actor_user_id: USERS.ops.id,
    command_fingerprint: sha(`command:${assignmentCounter}`),
    idempotency_key_hash: sha(`assignment-key:${assignmentCounter}`),
    created_at: at(0),
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO operating_job_assignments (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return String(row.assignment_id);
}

let entryCounter = 0;

/** Append one Crew policy entry with direct SQL, defaulting to a valid clear binding crew A. */
function appendCrew(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  entryCounter += 1;
  const current = db.prepare("SELECT version FROM operating_production_gates WHERE gate_id = ?")
    .get(gateId("Crew")) as { version: number };
  const row: Record<string, unknown> = {
    clearance_id: `pgc_${(0xc0000 + entryCounter).toString(16).padStart(40, "0")}`,
    tenant_id: TENANT,
    gate_id: gateId("Crew"),
    roof_job_id: JOB,
    gate: "Crew",
    entry_kind: "clear",
    basis: "crew_assignment",
    to_state: "complete",
    from_gate_version: current.version,
    actor_kind: "policy",
    policy_version: "ironwrap.crew-gate.v1",
    evidence_refs_json: JSON.stringify(binding("assignment:crew:direct:next")),
    request_sha256: sha(`crew-request:${entryCounter}`),
    idempotency_key_hash: sha(`crew-key:${entryCounter}`),
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

test("D1 admits a Crew policy entry only in its exact shape, with no person, reason or contract", () => {
  const { sqlite: db } = setup();
  for (const [field, value] of [
    ["policy_version", null],
    ["policy_version", "ironwrap.deposit-gate.v1"],
    ["actor_user_id", USERS.owner.id],
    ["actor_role", "owner"],
    ["requested_by", USERS.owner.id],
    ["reason", "A policy entry never carries free text."],
    ["attestation_json", "{}"],
    ["contract_binding_id", "commercial-acceptance:not-a-crew-fact"],
    ["terms_hash", "a".repeat(64)],
    ["evidence_refs_json", null],
    ["to_state", "ready"],
    ["basis", "contract_no_deposit"],
    ["basis", "crew_superseded"],
    ["reverses_id", `pgc_${"0".repeat(40)}`],
  ] as const) {
    refused(() => appendCrew(db, { [field]: value }), "production_gate_clearance_basis_invalid");
  }
  refused(() => appendCrew(db, { self_approval: 1, self_approval_basis: "only_holder" }), "production_gate_clearance_basis_invalid");
  // A person never clears Crew and nobody waives it.
  refused(
    () => appendCrew(db, { actor_kind: "person", actor_user_id: USERS.production.id, actor_role: "production", policy_version: null, basis: "person_attestation", to_state: "ready", attestation_json: "{}", evidence_refs_json: "[]" }),
    "production_gate_clearance_basis_invalid",
  );
  refused(
    () => appendCrew(db, { entry_kind: "waiver_decision", basis: "office_waiver", to_state: "waived", actor_kind: "person", actor_user_id: USERS.owner.id, actor_role: "owner", requested_by: USERS.owner.id, self_approval: 1, self_approval_basis: "only_holder", policy_version: null, evidence_refs_json: null, reason: "Owner tries to waive Crew." }),
    "production_gate_not_waivable",
  );
  assert.deepEqual(crewEntries(db), []);
});

test("D1 holds a Crew entry's evidence to the binding: plain JSON, three keys once each", () => {
  const { sqlite: db } = setup();
  for (const evidence of [
    "{assignment_id:'assignment:x',crew_id:'crew:policy:a',crew_version:1}",
    '{"assignment_id":"assignment:x","crew_id":"crew:policy:a","crew_version":1,"crew_id":"crew:policy:b"}',
    JSON.stringify({ ...binding("assignment:x"), roster: [USERS.fieldA.id] }),
    JSON.stringify({ assignment_id: "assignment:x", crew_id: CREW_A }),
    JSON.stringify({ ...binding("assignment:x"), crew_version: "1" }),
    JSON.stringify({ ...binding("assignment:x"), crew_version: 1.5 }),
    JSON.stringify({ ...binding("assignment:x"), assignment_id: 7 }),
    JSON.stringify([binding("assignment:x")]),
  ]) {
    refused(() => appendCrew(db, { evidence_refs_json: evidence }), "production_gate_evidence_invalid");
  }
  assert.deepEqual(crewEntries(db), []);
});

test("D1 binds Crew only to a crew 0098 admits: Active at that version, with active field members", () => {
  const { sqlite: db } = setup();
  refused(() => appendCrew(db, { evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_A, 2)) }), "production_gate_crew_binding_invalid");
  refused(() => appendCrew(db, { evidence_refs_json: JSON.stringify(binding("assignment:x", "crew:policy:missing")) }), "production_gate_crew_binding_invalid");
  db.prepare("UPDATE fleet_crews SET status = 'Inactive', version = 2 WHERE crew_id = ?").run(CREW_B);
  refused(() => appendCrew(db, { evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_B, 2)) }), "production_gate_crew_binding_invalid");
  db.prepare("UPDATE fleet_crews SET status = 'Active', version = 3 WHERE crew_id = ?").run(CREW_B);
  db.prepare("UPDATE fleet_crew_members SET active = 0, version = 2 WHERE crew_id = ?").run(CREW_B);
  refused(() => appendCrew(db, { evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_B, 3)) }), "production_gate_crew_binding_invalid");
  db.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.fieldB.id);
  refused(() => appendCrew(db), "production_gate_crew_binding_invalid");
  db.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(USERS.fieldB.id);
  const first = appendCrew(db);
  assert.equal(crewGate(db).state, "complete");
  assert.equal(auditRows(db, first).length, 1);
  // A re-bind reverses the entry in force for another crew or version, never for the same one.
  refused(() => appendCrew(db), "production_gate_already_cleared");
  refused(
    () => appendCrew(db, { entry_kind: "reverse", basis: "crew_superseded", to_state: "blocked", reverses_id: first }),
    "production_gate_crew_binding_invalid",
  );
  db.prepare("UPDATE fleet_crew_members SET active = 1, version = 3 WHERE crew_id = ?").run(CREW_B);
  const reversal = appendCrew(db, {
    entry_kind: "reverse", basis: "crew_superseded", to_state: "blocked", reverses_id: first,
    evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_B, 3)),
  });
  refused(
    () => appendCrew(db, { entry_kind: "reverse", basis: "crew_superseded", to_state: "blocked", reverses_id: reversal, evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_B, 3)) }),
    "production_gate_not_cleared",
  );
  appendCrew(db, { evidence_refs_json: JSON.stringify(binding("assignment:x", CREW_B, 3)) });
  assert.deepEqual({ state: crewGate(db).state, version: crewGate(db).version }, { state: "complete", version: 4 });
});

test("D1 refuses a Crew entry that names an assignment already written: the entry comes first, in its batch", async () => {
  const h = setup();
  const first = await recordOperatingJobAssignment(h.env, command());
  // A writer binding Crew after the fact, to an assignment that exists, is refused.
  refused(
    () => appendCrew(h.sqlite, {
      entry_kind: "reverse", basis: "crew_superseded", to_state: "blocked",
      reverses_id: crewEntries(h.sqlite)[0]!.clearance_id,
      evidence_refs_json: JSON.stringify(binding(first.assignment.assignment_id, CREW_B)),
    }),
    "production_gate_crew_binding_invalid",
  );
  assert.equal(crewEntries(h.sqlite).length, 1);
});

test("D1 holds an assignment to its gate evidence after 0098's rules, each refused in turn", async () => {
  const { sqlite: db } = setup();
  const assignmentId = "assignment:crew:direct:valid";
  // 0098 fires first: with Weather reversed, the six-gate check answers, not the window.
  reverseGateInLedger(db, { tenantId: TENANT, roofJobId: JOB, gate: "Weather", actorUserId: USERS.owner.id, actorRole: "owner" });
  refused(() => insertAssignment(db, { assignment_id: assignmentId }), "operating_job_assignment_gates_blocked");
  const window = fixtureWeatherWindow();
  attestGateInLedger(db, { tenantId: TENANT, roofJobId: JOB, gate: "Weather", actorUserId: USERS.production.id, actorRole: "production", window });
  // Crew is not bound yet: still 0098's six-gate check.
  refused(() => insertAssignment(db, { assignment_id: assignmentId }), "operating_job_assignment_gates_blocked");
  bindCrewInLedger(db, { tenantId: TENANT, roofJobId: JOB, crewId: CREW_A, assignmentId });
  refused(() => insertAssignment(db, { assignment_id: assignmentId, crew_version: 2 }), "operating_job_assignment_crew_invalid");

  // 0159, in its order.
  refused(() => insertAssignment(db, { assignment_id: assignmentId, actor_user_id: USERS.seed.id }), "operating_job_assignment_seed_identity_refused");
  // Crew is bound to crew A for this assignment: crew B, or another assignment, is not bound.
  refused(
    () => insertAssignment(db, { assignment_id: assignmentId, crew_id: CREW_B, assigned_users_json: JSON.stringify([USERS.fieldC.id]) }),
    "operating_job_assignment_crew_gate_unbound",
  );
  refused(() => insertAssignment(db, { assignment_id: "assignment:crew:direct:unbound" }), "operating_job_assignment_crew_gate_unbound");
  refused(
    () => insertAssignment(db, { assignment_id: assignmentId, scheduled_start: at(-2 * DAY), scheduled_end: at(-2 * DAY + HOUR) }),
    "operating_job_assignment_outside_weather_window",
  );
  refused(
    () => insertAssignment(db, { assignment_id: assignmentId, scheduled_end: new Date(Date.parse(window.end) + 1).toISOString() }),
    "operating_job_assignment_outside_weather_window",
  );
  refused(
    () => insertAssignment(db, { assignment_id: assignmentId, scheduled_start: new Date(Date.parse(window.end) + HOUR).toISOString(), scheduled_end: null }),
    "operating_job_assignment_outside_weather_window",
  );
  db.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
    .run(`  ${USERS.production.id.toUpperCase()}@EXAMPLE.INVALID `, USERS.fieldA.id);
  refused(() => insertAssignment(db, { assignment_id: assignmentId }), "operating_job_assignment_crew_not_independent");
  db.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?").run(`${USERS.fieldA.id}@example.invalid`, USERS.fieldA.id);
  assert.equal(assignmentCount(db), 0);

  // The window holds the work exactly at its bounds.
  insertAssignment(db, { assignment_id: assignmentId, scheduled_start: window.start, scheduled_end: window.end });
  assert.equal(assignmentCount(db), 1);
});

test("a Weather gate that stands on no attested window, as one recorded before the ledger, never schedules", async () => {
  // A database through 0152 with a Weather gate already ready, migrated forward: the 0153 backfill
  // records it as a legacy entry, which names no window.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const names = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort();
  for (const name of names.filter((value) => value < "0153")) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of Object.values(USERS)) insertUser(db, user, user === USERS.seed ? SEED_CREATED_BY : undefined);
  seedJob(db, JOB, "0001");
  db.prepare("UPDATE operating_production_gates SET state = 'ready', version = 2 WHERE gate_id = ?").run(gateId("Weather"));
  // A pre-ledger Crew clearance kept whatever evidence text its writer left, parseable or not.
  db.prepare("UPDATE operating_production_gates SET state = 'complete', version = 2, evidence_refs_json = '{not json' WHERE gate_id = ?").run(gateId("Crew"));
  for (const name of names.filter((value) => value >= "0153")) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  insertCrew(db, CREW_A, [USERS.fieldA, USERS.fieldB]);
  const job = { tenantId: TENANT, roofJobId: JOB };
  waiveGateInLedger(db, { ...job, gate: "Deposit", ownerUserId: USERS.owner.id });
  for (const gate of ["Materials", "Safety", "Access"] as const) {
    attestGateInLedger(db, { ...job, gate, actorUserId: USERS.production.id, actorRole: "production" });
  }
  assert.deepEqual(
    db.prepare("SELECT gate, entry_kind, basis FROM production_gate_clearances WHERE gate IN ('Weather', 'Crew') ORDER BY gate, from_gate_version").all().map((row) => ({ ...row })),
    [
      { gate: "Crew", entry_kind: "legacy", basis: "(none)" },
      { gate: "Weather", entry_kind: "legacy", basis: "(none)" },
    ],
    "the backfill kept both gates; people cleared the four it left blocked",
  );
  const env = envFor(new TestD1(db));
  await rejectsWith(recordOperatingJobAssignment(env, command()), "operating_job_assignment_weather_window_ended");
  // In D1, a schedule written over the legacy Crew entry is refused by name, whatever its evidence.
  refused(() => insertAssignment(db), "operating_job_assignment_crew_gate_unbound");
  // Re-attested, Weather holds a window again; the legacy Crew entry is reversed and Crew bound.
  reverseGateInLedger(db, { tenantId: TENANT, roofJobId: JOB, gate: "Weather", actorUserId: USERS.owner.id, actorRole: "owner" });
  attestGateInLedger(db, { tenantId: TENANT, roofJobId: JOB, gate: "Weather", actorUserId: USERS.production.id, actorRole: "production" });
  const scheduled = await recordOperatingJobAssignment(env, command());
  assert.deepEqual(
    db.prepare("SELECT entry_kind, basis, from_gate_version FROM production_gate_clearances WHERE gate = 'Crew' ORDER BY from_gate_version").all().map((row) => ({ ...row })),
    [
      { entry_kind: "legacy", basis: "(none)", from_gate_version: 1 },
      { entry_kind: "reverse", basis: "crew_superseded", from_gate_version: 2 },
      { entry_kind: "clear", basis: "crew_assignment", from_gate_version: 3 },
    ],
  );
  assert.equal(scheduled.kind, "created");
});

// --- The route --------------------------------------------------------------------------------------

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

async function schedule(
  h: Harness,
  auth: AuthContext,
  body: Record<string, unknown> = {},
  key = nextKey(),
): Promise<{ status: number; body: Record<string, any> }> {
  const day = fixtureSchedule(1);
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/jobs/${encodeURIComponent(JOB)}/schedule`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": auth.csrfToken,
        "idempotency-key": key,
      },
      body: JSON.stringify({
        expected_roof_job_version: 1,
        crew_id: CREW_A,
        expected_crew_version: 1,
        authority_requirements: command().authorityRequirements,
        scheduled_start: day.start,
        scheduled_end: day.end,
        supersedes_assignment_id: null,
        correction_reason: null,
        ...body,
      }),
    }),
    h.env,
    auth,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test("only a person's own session schedules; agents, connectors and the QA seed owner never do", async () => {
  const h = setup();
  for (const role of ["owner", "ops", "production"] as const) {
    const result = await schedule(h, machine(role));
    assert.deepEqual([result.status, result.body], [403, { error: "person_session_required" }], role);
  }
  const seed = await schedule(h, await person(h, USERS.seed.id));
  assert.deepEqual([seed.status, seed.body], [403, { error: "operating_job_assignment_seed_identity_refused" }]);
  const field = await schedule(h, machine("field"));
  assert.deepEqual([field.status, field.body], [403, { error: "production_role_required" }]);
  assert.deepEqual(crewEntries(h.sqlite), []);

  const ops = await person(h, USERS.ops.id);
  const created = await schedule(h, ops, {}, "crew-policy-route-key-0001");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The response keeps its shape: the Crew entries are the ledger's, read on the gates route.
  assert.deepEqual(Object.keys(created.body).sort(), ["assignment", "replayed", "version"]);
  assert.deepEqual(Object.keys(created.body.assignment).sort(), [
    "actor_user_id", "assigned_users", "assignment_version", "authority_requirements",
    "authority_requirements_sha256", "correction_reason", "created_at", "crew_id", "crew_version",
    "id", "roof_job_id", "roof_job_version", "scheduled_end", "scheduled_start",
    "supersedes_assignment_id",
  ]);
  assert.equal(created.body.assignment.actor_user_id, USERS.ops.id);
  const replay = await schedule(h, ops, {}, "crew-policy-route-key-0001");
  assert.deepEqual([replay.status, replay.body.replayed], [200, true]);
  assert.equal(crewEntries(h.sqlite).length, 1);
});

test("the route answers the window, independence, blocked-gate and stop refusals by name", async () => {
  const h = setup();
  const ops = await person(h, USERS.ops.id);
  const outside = await schedule(h, ops, { scheduled_start: at(-2 * DAY), scheduled_end: at(-2 * DAY + HOUR) });
  assert.deepEqual([outside.status, outside.body], [409, { error: "operating_job_assignment_outside_weather_window" }]);
  h.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
    .run(`${USERS.production.id}@example.invalid`, USERS.fieldA.id);
  const shared = await schedule(h, ops);
  assert.deepEqual([shared.status, shared.body], [409, { error: "operating_job_assignment_crew_not_independent" }]);
  reverseGateInLedger(h.sqlite, { tenantId: TENANT, roofJobId: JOB, gate: "Access", actorUserId: USERS.owner.id, actorRole: "owner" });
  const blocked = await schedule(h, ops);
  assert.deepEqual([blocked.status, blocked.body], [409, { error: "operating_job_assignment_gates_blocked" }]);
  const stopped = setup();
  stop(stopped, "tenant", TENANT);
  const held = await schedule(stopped, await person(stopped, USERS.ops.id));
  assert.deepEqual([held.status, held.body], [409, { error: "operating_job_assignment_stop_active" }]);
  // A stop naming a package the tenant does not have answers with the stop to open.
  const unknown = setup();
  const stopId = stop(unknown, "work_package", "wp:crew:unknown");
  const named = await schedule(unknown, await person(unknown, USERS.ops.id));
  assert.deepEqual(
    [named.status, named.body],
    [409, { error: "operating_job_assignment_stop_work_package_unknown", stop_id: stopId }],
  );
  assert.deepEqual(crewEntries(h.sqlite), []);
  assert.deepEqual(crewEntries(stopped.sqlite), []);
  assert.deepEqual(crewEntries(unknown.sqlite), []);
});

// --- The migration ------------------------------------------------------------------------------------

const read = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const triggerText = (sql: string, name: string): string => {
  const match = sql.match(new RegExp(`CREATE TRIGGER (?:IF NOT EXISTS )?${name}\\n[\\s\\S]*?\\nEND;`));
  assert.ok(match, name);
  return match[0];
};

test("0159 re-creates the validate guard with every 0158 line carried, in order", () => {
  const lines = (sql: string) => sql.split("\n").map((line) => line.trim());
  const validate = "production_gate_clearances_validate_insert";
  const recreated = lines(triggerText(read("0159_production_gate_crew_policy.sql"), validate));
  let at = 0;
  for (const line of lines(triggerText(read("0158_production_gate_attestations.sql"), validate))) {
    if (!line || line.startsWith("--") || line.startsWith("CREATE TRIGGER")) continue;
    const found = recreated.indexOf(line, at);
    assert.ok(found >= 0, `0159 carries, in order: ${line}`);
    at = found + 1;
  }
  // Every line 0159 adds is marked, or belongs to a rule a marked comment opens.
  const shipped = new Set(lines(triggerText(read("0158_production_gate_attestations.sql"), validate)));
  const added = recreated.filter((line) => line && !shipped.has(line));
  assert.ok(added[0]?.startsWith("-- [0159]"), added[0]);
  const codes = (sql: string) => [...triggerText(sql, validate).matchAll(/RAISE\(ABORT, '([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(codes(read("0159_production_gate_crew_policy.sql")))]
      .filter((code) => !codes(read("0158_production_gate_attestations.sql")).includes(code)),
    ["production_gate_crew_binding_invalid", "production_gate_stop_work_package_unknown"],
  );
});

test("0159 re-creates 0153's replace guard and 0098's validate trigger unchanged, each to fire first", () => {
  const forward = read("0159_production_gate_crew_policy.sql");
  const body = (sql: string, name: string) => triggerText(sql, name).replace(/^CREATE TRIGGER (?:IF NOT EXISTS )?/, "");
  assert.equal(
    body(forward, "production_gate_clearances_no_insert_replace"),
    body(read("0153_production_gate_clearances.sql"), "production_gate_clearances_no_insert_replace"),
  );
  assert.equal(
    body(forward, "operating_job_assignments_validate_insert"),
    body(read("0098_native_operating_job_assignments.sql"), "operating_job_assignments_validate_insert"),
  );
  const { sqlite: db } = setup({ ready: false });
  const newest = (table: string) => (db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE INSERT%'
      ORDER BY rowid DESC LIMIT 1`,
  ).get(table) as { name: string }).name;
  // Triggers on one table fire newest first.
  assert.equal(newest("production_gate_clearances"), "production_gate_clearances_no_insert_replace");
  assert.equal(newest("operating_job_assignments"), "operating_job_assignments_validate_insert");
  assert.deepEqual(
    db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'operating_job_assignments' ORDER BY rowid`,
    ).all().map((row) => (row as { name: string }).name),
    [
      "operating_job_assignments_append_only_update",
      "operating_job_assignments_append_only_delete",
      "operating_job_assignments_gate_evidence_guard",
      // 0160's cancellation window hold, after which 0160 re-creates 0098's trigger once more.
      "operating_job_assignments_cancellation_window_hold",
      "operating_job_assignments_validate_insert",
    ],
  );
});

test("the triggers after every migration hold A1's to A4's clauses", () => {
  const { sqlite: db } = setup({ ready: false });
  const sql = (name: string) => String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(name) as { sql: string }).sql);
  const validate = sql("production_gate_clearances_validate_insert");
  for (const clause of [
    "production_gate_clearance_legacy_closed",
    "production_gate_not_waivable",
    "deposit_settlement_not_observed",
    "production_gate_waiver_self_approval_refused",
    "production_gate_clearance_seed_identity_refused",
    "'contract_no_deposit'",
    "'contract_superseded'",
    "production_gate_contract_superseded_not_observed",
    "'person_attestation'",
    "'person_reversal'",
    "production_gate_attester_on_crew",
    "production_gate_stop_job_unknown",
    "production_gate_stop_work_package_unknown",
    "production_gate_safety_stop_active",
    "production_gate_competency_required",
    "production_gate_weather_window_invalid",
    "production_gate_reversal_target_invalid",
    "'ironwrap.crew-gate.v1'",
    "'crew_assignment'",
    "'crew_superseded'",
    "production_gate_crew_binding_invalid",
  ]) {
    assert.ok(validate.includes(clause), `the final validate trigger keeps ${clause}`);
  }
  assert.equal(`${validate};`, triggerText(read("0159_production_gate_crew_policy.sql"), "production_gate_clearances_validate_insert"));
  const guard = sql("operating_job_assignments_gate_evidence_guard");
  for (const clause of [
    "operating_job_assignment_seed_identity_refused",
    "operating_job_assignment_stop_job_unknown",
    "operating_job_assignment_stop_work_package_unknown",
    "operating_job_assignment_stop_active",
    "operating_job_assignment_crew_gate_unbound",
    "operating_job_assignment_deposit_contract_superseded",
    "operating_job_assignment_weather_window_ended",
    "operating_job_assignment_outside_weather_window",
    "operating_job_assignment_crew_not_independent",
    "julianday('now')",
  ]) {
    assert.ok(guard.includes(clause), `the assignment guard keeps ${clause}`);
  }
  assert.ok(!guard.includes("NEW.created_at"), "the guard reads D1's clock, never the row's created_at");
  assert.ok(sql("operating_job_assignments_validate_insert").includes("operating_job_assignment_gates_blocked"));
});
