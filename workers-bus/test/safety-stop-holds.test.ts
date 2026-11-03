import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  authorityCurrentPrecondition,
  recordAuthorityReadback,
  type AuthorityCurrentPrecondition,
} from "../src/authority-records.ts";
import { activeAssignmentForWorkObject, buildJobReadModel, buildOwnerNowReadModel, buildTodayReadModel,
  buildUniversalWorkPackageReadModel } from "../src/app-read-models.ts";
import { permissionsForRole, type AppEnv, type AuthContext, type WorkObjectScope } from "../src/app-types.ts";
import { recordOperatingWorkObjectAssignment } from "../src/operating-work-object-assignment-store.ts";
import { handleWorkPackageAction, nativeWorkPackageWriter } from "../src/work-package-actions.ts";
import { FieldActionError } from "../src/field-actions.ts";
import { safetyStopActive, unknownJobStop, unknownWorkPackageStop } from "../src/production-job-stops.ts";
import {
  evaluateSafetyReadiness,
  holdingSafetyStops,
  recordMakeSafe,
  recordSafetyResponse,
  reportSafetyOccurrence,
  type SafetyScopeRef,
} from "../src/safety-lifecycle.ts";
import { safetyReadinessForScope, safetyReleaseGate } from "../src/safety-release-gate.ts";
import { attestGateInLedger, bindCrewInLedger, clearScheduleGatesInLedger,
  reverseGateInLedger } from "./production-gate-ledger-fixture.ts";
import {
  issueNativeWorkPackage,
  nativeWorkPackageAction,
  type NativeWorkPackageDefinition,
} from "../src/work-package-store.ts";

// An active safety stop holds work on every job it names, for every crew, and on every job of the
// tenant when the job or Work Package it names does not exist (A3's predicate). The Worker's
// readiness gate and D1 (0170) agree, and the crew reads list exactly the stops that hold a job.
// Every fixture is synthetic: reserved example.invalid identities, and times relative to the run.

const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const BASE = Date.now() - 6 * 60 * 60 * 1_000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const day = (days: number) => new Date(BASE + days * 86_400_000).toISOString().slice(0, 10);

interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: "owner" | "ops" | "field";
  access: string;
  frappe?: string;
}

const USERS = {
  owner: { id: "appu_owner_hold", email: "owner@example.invalid", name: "Synthetic Owner", role: "owner", access: "owner" },
  ops: { id: "appu_ops_hold", email: "ops@example.invalid", name: "Synthetic Ops", role: "ops", access: "ops" },
  production: { id: "appu_production_hold", email: "production@example.invalid", name: "Synthetic Production", role: "ops", access: "production" },
  crew: { id: "appu_crew_hold", email: "crew@example.invalid", name: "Synthetic Crew", role: "field", access: "field", frappe: "crew@example.invalid" },
  mate: { id: "appu_mate_hold", email: "mate@example.invalid", name: "Synthetic Mate", role: "field", access: "field", frappe: "mate@example.invalid" },
  other: { id: "appu_other_crew_hold", email: "other.crew@example.invalid", name: "Synthetic Other Crew", role: "field", access: "field", frappe: "other.crew@example.invalid" },
} satisfies Record<string, FixtureUser>;

const OTHER_USERS = {
  owner: { id: "appu_owner_other_hold", email: "owner@other.example.invalid", name: "Other Owner", role: "owner", access: "owner" },
  crew: { id: "appu_crew_other_hold", email: "crew@other.example.invalid", name: "Other Crew", role: "field", access: "field", frappe: "crew@other.example.invalid" },
} satisfies Record<string, FixtureUser>;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] };
          },
          first<T>() {
            return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null;
          },
          run() {
            const result = sqlite.prepare(sql).run(...(values as never[]));
            return { meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run(): unknown }>) {
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

class MemoryR2 {
  readonly objects = new Map<string, { body: string; size: number; checksum: string; contentType: string }>();

  async head(key: string) {
    const value = this.objects.get(key);
    return value
      ? {
          size: value.size,
          customMetadata: { sha256: value.checksum },
          checksums: { sha256: hexBytes(value.checksum).buffer },
          httpMetadata: { contentType: value.contentType },
        }
      : null;
  }

  async put(
    key: string,
    body: Blob | string,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: { sha256?: string } },
  ) {
    const text = typeof body === "string" ? body : await body.text();
    this.objects.set(key, {
      body: text,
      size: new TextEncoder().encode(text).byteLength,
      checksum: options.customMetadata?.sha256 ?? "",
      contentType: options.httpMetadata?.contentType ?? "application/octet-stream",
    });
    return { key };
  }
}

type TestEnv = AppEnv & { DB: TestD1; RAW: MemoryR2 };

function testEnv(options: { beforeStopMigration?: boolean; reverseTriggers?: boolean } = {}): TestEnv {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    if (options.beforeStopMigration && name === "0170_safety_stop_route_gaps.sql") continue;
    DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  if (options.reverseTriggers) {
    const triggers = DB.sqlite.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid",
    ).all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) DB.sqlite.exec(`DROP TRIGGER ${trigger.name}`);
    for (const trigger of triggers.reverse()) DB.sqlite.exec(trigger.sql);
  }
  for (const user of Object.values(USERS)) insertUser(DB, user, TENANT);
  for (const user of Object.values(OTHER_USERS)) insertUser(DB, user, OTHER_TENANT);
  return {
    APP_TENANT_ID: TENANT,
        DB,
    RAW: new MemoryR2(),
  } as unknown as TestEnv;
}

function insertUser(DB: TestD1, user: FixtureUser, tenantId: string) {
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
        (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
         active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(user.id, tenantId, user.email, user.name, user.role, user.access, user.frappe ?? null,
      "owner@example.invalid", at(-60), at(-60));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}


// --- Native Work Package fixtures --------------------------------------------------------------

function definition(overrides: Partial<NativeWorkPackageDefinition> = {}): NativeWorkPackageDefinition {
  const tenantId = overrides.tenantId ?? TENANT;
  const jobId = overrides.jobId ?? "JOB-HOLD-A";
  const workPackageId = overrides.workPackageId ?? `wp_hold_${jobId.toLowerCase()}`;
  const crew = tenantId === TENANT ? USERS.crew : OTHER_USERS.crew;
  const owner = tenantId === TENANT ? USERS.owner : OTHER_USERS.owner;
  const authorityRequirements = [
    {
      subject_type: "Person" as const,
      subject_role: "Worker" as const,
      subject_ref: crew.email,
      authority_kind: "Worker Competency" as const,
      authority_scope: "field installation",
      scope_type: "Work Package" as const,
      scope_ref: workPackageId,
      issuer_name: "IronWrap Production",
      issuer_jurisdiction: "AB-CA",
      issuer_reference: `internal:competency:${crew.id}`,
      source_version: "internal-competency-v1",
    },
  ];
  return {
    tenantId,
    workPackageId,
    version: 1,
    deviceActionId: `issue-${workPackageId}-1`,
    manifestKey: `work-packages/issue-${workPackageId}-1.json`,
    jobId,
    assignmentId: `ASSIGN-${jobId}`,
    assignmentVersion: 1,
    assignmentCommandFingerprint: "a".repeat(64),
    assignmentAuthorityRequirementsSha256: sha256(canonicalJson(authorityRequirements)),
    issueRequestSha256: "b".repeat(64),
    workObjectType: "Roof Job",
    workObjectId: jobId,
    physicalContextType: "Roof Site",
    physicalContextId: jobId,
    assignmentAuthorityUser: owner.email,
    assignmentAuthorityRole: "IronWrap Owner",
    title: "Synthetic roof package",
    objective: "Complete the synthetic roof scope safely",
    boundaries: "Only the issued synthetic scope",
    prerequisites: "Crew and materials are present",
    expectedResult: "Installed roof is ready for review",
    stopConditions: "Stop on unsafe anchors or weather",
    makeSafeProcedure: "Secure the area and notify the office",
    issuedAt: at(0),
    expiresAt: at(24 * 60),
    releasedAt: at(0),
    releaseAttemptId: `attempt-${workPackageId}-1`,
    authorityRequirements,
    steps: [
      {
        sequence: 1,
        instruction: "Inspect the roof deck",
        requiredEvidence: "Deck photographs",
        acceptanceCriteria: "Deck is sound",
      },
    ],
    holdPoints: [
      {
        sequence: 1,
        holdPoint: "In-process quality hold",
        releasePhase: "In-process",
        releaseAuthority: "IronWrap Production",
        requiredEvidence: "Quality photographs",
        acceptanceCriteria: "Quality is released",
      },
    ],
    assignedWorkers: [{ sequence: 1, workerUser: crew.email, workerRole: "Installer", required: true }],
    issuedByUser: owner.email,
    issuedByRole: "IronWrap Owner",
    ...overrides,
  };
}

const AUTHORITY = new WeakMap<TestD1, Map<string, AuthorityCurrentPrecondition[]>>();

function envFor(env: TestEnv, tenantId: string): TestEnv {
  return tenantId === TENANT ? env : ({ ...env, APP_TENANT_ID: tenantId } as TestEnv);
}

async function issue(env: TestEnv, packet: NativeWorkPackageDefinition) {
  seedAssignmentSnapshot(env, packet);
  const scoped = envFor(env, packet.tenantId);
  await issueNativeWorkPackage(scoped, packet);
  await seedPacketAuthority(scoped, packet);
}

function seedAssignmentSnapshot(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  options: { jobOnly?: boolean } = {},
): void {
  const sqlite = env.DB.sqlite;
  const existing = sqlite
    .prepare("SELECT assignment_id FROM operating_job_assignments WHERE tenant_id = ? AND assignment_id = ?")
    .get(packet.tenantId, packet.assignmentId);
  if (existing) return;
  const suffix = sha256(`${packet.tenantId}:${packet.assignmentId}`).slice(0, 16);
  const now = packet.issuedAt;
  const envelopeId = `ow_wp_${suffix}`;
  const leadId = `lead:wp:${suffix}`;
  const customerId = `customer:wp:${suffix}`;
  const crewId = `crew:wp:${suffix}`;
  const rawKey = `raw/work-package/${suffix}.json`;
  const contactEmail = `customer-${suffix}@example.invalid`;
  const owner = packet.tenantId === TENANT ? USERS.owner : OTHER_USERS.owner;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO envelopes
        (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
         created_at, updated_at)
       VALUES (?, 'manual', 'Synthetic Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
    )
    .run(envelopeId, contactEmail, rawKey, now, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_leads
        (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
         contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'Synthetic Customer', ?, 'qualified', 1, ?, ?)`,
    )
    .run(leadId, packet.tenantId, envelopeId, rawKey, contactEmail, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_customers
        (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
         contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Synthetic Customer', ?, 'active', 1, ?, ?)`,
    )
    .run(customerId, packet.tenantId, envelopeId, rawKey, contactEmail, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_roof_jobs
        (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, source_raw_key, brand,
         job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified', 'ready', 1, ?, ?)`,
    )
    .run(packet.jobId, packet.tenantId, leadId, customerId, envelopeId, rawKey,
      `IW-${suffix.slice(0, 8)}`, now, now);
  // A job can arrive while work is held. That arrival clears no gate and grants no schedule.
  if (options.jobOnly) return;
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO operating_production_gates
          (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key, gate, state,
           owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, 'No active blocker', 1, ?, ?)`,
      )
      .run(`gate:wp:${suffix}:${gate.toLowerCase()}`, packet.tenantId, packet.jobId, envelopeId,
        rawKey, gate, owner.id, now, packet.expiresAt, now, now);
  }
  // Current gate evidence is recorded by people outside the assigned crew. The helper also
  // records the signed-copy receipt whose cancellation window permits Materials and scheduling.
  const attester = packet.tenantId === TENANT ? USERS.production : owner;
  clearScheduleGatesInLedger(sqlite, {
    tenantId: packet.tenantId,
    roofJobId: packet.jobId,
    ownerUserId: owner.id,
    attesterUserId: attester.id,
    attesterRole: attester === owner ? "owner" : "production",
  });
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO fleet_crews
        (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
       VALUES (?, ?, 'Synthetic Crew', 'Active', 1, ?, ?)`,
    )
    .run(crewId, packet.tenantId, now, now);
  const workerIds = packet.assignedWorkers.map((worker) => {
    const row = sqlite
      .prepare("SELECT user_id FROM app_users WHERE tenant_id = ? AND email_normalized = ?")
      .get(packet.tenantId, worker.workerUser) as { user_id: string };
    return row.user_id;
  });
  for (const [index, workerId] of workerIds.entries()) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO fleet_crew_members
          (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(`membership:wp:${suffix}:${index + 1}`, packet.tenantId, crewId, workerId, now, now);
  }
  // Crew is a policy receipt bound to this exact assignment and current crew, as in 0159.
  bindCrewInLedger(sqlite, {
    tenantId: packet.tenantId,
    roofJobId: packet.jobId,
    crewId,
    assignmentId: packet.assignmentId,
  });
  sqlite
    .prepare(
      `INSERT INTO operating_job_assignments
        (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
         crew_version, assigned_users_json, scheduled_start, scheduled_end,
         supersedes_assignment_id, correction_reason, actor_user_id, command_fingerprint,
         idempotency_key_hash, created_at, authority_requirements_json,
         authority_requirements_sha256)
       VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(packet.assignmentId, packet.tenantId, packet.jobId, packet.assignmentVersion, crewId,
      JSON.stringify(workerIds), packet.issuedAt, packet.expiresAt, owner.id,
      packet.assignmentCommandFingerprint, sha256(packet.assignmentId), packet.issuedAt,
      canonicalJson(packet.authorityRequirements), packet.assignmentAuthorityRequirementsSha256);
}

async function seedPacketAuthority(env: TestEnv, packet: NativeWorkPackageDefinition) {
  const preconditions: AuthorityCurrentPrecondition[] = [];
  const observer = packet.tenantId === TENANT ? USERS.owner : OTHER_USERS.owner;
  for (const [index, requirement] of packet.authorityRequirements.entries()) {
    const identity = sha256(`${packet.tenantId}:${packet.workPackageId}:${canonicalJson(requirement)}`).slice(0, 24);
    const readback = await recordAuthorityReadback(env, {
      readbackId: `Authority-Readback-${identity}`,
      tenantId: packet.tenantId,
      authorityRecordId: `Authority-Record-${identity}`,
      authorityVersion: 1,
      subjectType: requirement.subject_type,
      subjectRole: requirement.subject_role ?? "Worker",
      personUser: requirement.subject_type === "Person" ? requirement.subject_ref : null,
      organization: requirement.subject_type === "Organization" ? requirement.subject_ref : null,
      authorityKind: requirement.authority_kind,
      authorityScope: requirement.authority_scope ?? "field installation",
      scopeType: requirement.scope_type,
      scopeRef: requirement.scope_ref,
      roofJob: packet.jobId,
      scopeJson: "{}",
      issuerName: requirement.issuer_name ?? "IronWrap Production",
      issuerJurisdiction: requirement.issuer_jurisdiction ?? "AB-CA",
      issuerReference: requirement.issuer_reference ?? `internal:authority:${identity}`,
      issuerSourceVersion: requirement.source_version ?? "internal-competency-v1",
      verificationState: "verified",
      evidenceRefsJson: JSON.stringify([
        { ref: `r2://authority/${identity}.json`, sha256: sha256(`evidence:${identity}`) },
      ]),
      evidenceSha256: sha256(`evidence:${identity}`),
      authorityStateDigestSha256: sha256(`state:${identity}:${index}`),
      authorityEffectiveFrom: day(-30),
      authorityExpiresAt: day(365),
      authorityRevokedAt: null,
      supersedesAuthorityRecordId: null,
      authorityVerificationMethod: "Internal Competency Assessment",
      issuerReceiptSha256: null,
      observedByUserId: observer.id,
      observedAt: packet.issuedAt,
      actionId: null,
    });
    preconditions.push(authorityCurrentPrecondition(requirement, readback.readback));
  }
  const byPackage = AUTHORITY.get(env.DB) ?? new Map();
  byPackage.set(`${packet.workPackageId}:${packet.version}`, preconditions);
  AUTHORITY.set(env.DB, byPackage);
}

async function act(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  kind: "acknowledge" | "start_work" | "stop_work",
  deviceActionId: string,
  actor: FixtureUser = packet.tenantId === TENANT ? USERS.crew : OTHER_USERS.crew,
) {
  return await nativeWorkPackageAction(envFor(env, packet.tenantId), {
    kind,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: actor.email,
    actorRole: "field",
    deviceActionId,
    blockerReason: kind === "stop_work" ? "Synthetic loose anchor" : null,
    releaseAttemptId: packet.releaseAttemptId,
    workObjectType: packet.workObjectType,
    workObjectId: packet.workObjectId,
    physicalContextType: packet.physicalContextType,
    physicalContextId: packet.physicalContextId,
    manifestKey: `work-packages/${deviceActionId}.json`,
    ...(kind === "stop_work"
      ? {}
      : { authorityPreconditions: AUTHORITY.get(env.DB)?.get(`${packet.workPackageId}:${packet.version}`) ?? [] }),
  });
}

// --- Stops ---------------------------------------------------------------------------------------

let nextStop = 0;

/** A stop raised by `raiser` on `scope`, at minute `minute` of the fixture clock. */
async function raise(
  env: TestEnv,
  scope: SafetyScopeRef,
  raiser: FixtureUser = USERS.crew,
  options: { tenantId?: string; minute?: number } = {},
): Promise<string> {
  nextStop += 1;
  const occurrenceId = `so_hold_${String(nextStop).padStart(4, "0")}`;
  const minute = options.minute ?? 100 + nextStop;
  await reportSafetyOccurrence(envFor(env, options.tenantId ?? TENANT), {
    occurrenceId,
    tenantId: options.tenantId ?? TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope,
    reportedByUserId: raiser.id,
    reportedAt: at(minute),
    summary: `Ice on the north slope, stop ${nextStop}.`,
    rescueRequired: false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: at(minute),
  });
  return occurrenceId;
}

/** Make safe, investigate, control and release a stop the crew raised, by people who did not. */
async function lift(env: TestEnv, occurrenceId: string, occurredAt = at(200)) {
  await recordMakeSafe(env, {
    tenantId: TENANT, occurrenceId, actorUserId: USERS.crew.id, detail: "Crew off the roof.",
    evidence: null, capturedOffline: false, deviceActionId: null, occurredAt, now: occurredAt,
  });
  for (const command of ["investigation_opened", "controlled", "released"] as const) {
    await recordSafetyResponse(env, {
      tenantId: TENANT, occurrenceId, actorUserId: USERS.ops.id, command,
      detail: `Recorded ${command}.`, evidence: null, now: new Date().toISOString(),
    });
  }
}

/** Two jobs: A, worked by the crew and their mate, and B, worked by another crew. */
async function twoJobs(env: TestEnv) {
  const jobA = definition({
    jobId: "JOB-HOLD-A",
    assignedWorkers: [
      { sequence: 1, workerUser: USERS.crew.email, workerRole: "Installer", required: true },
      { sequence: 2, workerUser: USERS.mate.email, workerRole: "Installer", required: true },
    ],
  });
  const jobB = definition({
    jobId: "JOB-HOLD-B",
    assignedWorkers: [
      { sequence: 1, workerUser: USERS.other.email, workerRole: "Installer", required: true },
    ],
  });
  await issue(env, jobA);
  await issue(env, jobB);
  return { jobA, jobB };
}

let nextAction = 0;

/** Whether `actor` may acknowledge `packet` now, as D1 decides it: null, or the refusal. */
async function acknowledgeRefusal(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  actor: FixtureUser,
): Promise<string | null> {
  nextAction += 1;
  const sqlite = env.DB.sqlite;
  // Each probe rolls back, so a refused or admitted acknowledgement leaves the package as it was.
  sqlite.exec("SAVEPOINT probe");
  try {
    await act(env, packet, "acknowledge", `ack-probe-${String(nextAction).padStart(4, "0")}`, actor);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    sqlite.exec("ROLLBACK TO probe");
    sqlite.exec("RELEASE probe");
  }
}

/** The Worker's gate, with the chain the acknowledge route builds for this package. */
async function gate(env: TestEnv, packet: NativeWorkPackageDefinition, actor: FixtureUser) {
  return (await safetyReleaseGate(env, {
    tenantId: TENANT,
    scope: { type: "work_package", id: packet.workPackageId },
    jobId: packet.jobId,
    workObjectScope: {
      workObjectType: packet.workObjectType, workObjectId: packet.workObjectId,
      physicalContextType: packet.physicalContextType, physicalContextId: packet.physicalContextId,
    },
    subjectUserIds: [actor.id],
    consumer: "work_package_release",
    evaluatedByUserId: actor.id,
    decisionRef: `probe-${packet.workPackageId}-${actor.id}`,
    now: new Date().toISOString(),
  })).readiness;
}

/** Proves both the Worker and D1 hold (or admit) `packet` for `actor`, and returns the stops held. */
async function expectHeld(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  actor: FixtureUser,
  expected: Array<{ occurrence_id: string; scope: "job" | "tenant" }>,
  label: string,
) {
  const readiness = await gate(env, packet, actor);
  const stops = readiness.blockers
    .filter((blocker) => blocker.code === "safety_stop_active")
    .map((blocker) => blocker.stop);
  assert.deepEqual(
    stops.map((stop) => ({ occurrence_id: stop?.occurrence_id, scope: stop?.scope })),
    expected,
    `${label}: Worker`,
  );
  assert.equal(readiness.ready, expected.length === 0, `${label}: ready`);
  const refusal = await acknowledgeRefusal(env, packet, actor);
  if (expected.length === 0) assert.equal(refusal, null, `${label}: D1 admits`);
  else assert.match(String(refusal), /safety_stop_active/, `${label}: D1 refuses`);
}

const raiserName = USERS.crew.name;

/** A field session as the router hands it to a read: the crew member's own assigned view. */
function fieldAuth(user: FixtureUser): AuthContext {
  return {
    rawSessionToken: "",
    csrfToken: "",
    permissions: permissionsForRole("field"),
    session: {
      session_hash: "f".repeat(64),
      session_created_at: new Date(Date.now() - 60_000).toISOString(),
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: "device-synthetic-crew",
      device_proof_hash: null,
      user_id: user.id,
      tenant_id: TENANT,
      email_normalized: user.email,
      display_name: user.name,
      role: "field",
      frappe_user_id: user.frappe ?? null,
      active: 1,
      created_by: USERS.owner.email,
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

// --- Holds -------------------------------------------------------------------------------------

for (const scopeType of ["roof_job", "work_package"] as const) {
  for (const layer of ["Worker", "D1", "crew reads"] as const) {
    test(`unresolved ${scopeType} stays held after its target appears: ${layer}`, async () => {
      const env = testEnv({ reverseTriggers: layer === "D1" });
      const { jobA, jobB } = await twoJobs(env);
      const pending = definition({ jobId: "JOB-HOLD-PENDING" });
      // Prepare the assignment while work is still allowed, without issuing its package.
      // Once the stop exists, current Safety refuses any attempt to clear or schedule anew.
      if (scopeType === "work_package") seedAssignmentSnapshot(env, pending);
      const stop = await raise(env, {
        type: scopeType,
        id: scopeType === "roof_job" ? pending.jobId : pending.workPackageId,
      });
      await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], "before target exists");
      const clearances = env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get();
      // A job arrives through its guarded inserts; a package is issued against the assignment
      // prepared before the stop. Every guard stays enabled, and neither path clears a gate.
      if (scopeType === "roof_job") seedAssignmentSnapshot(env, pending, { jobOnly: true });
      else await issue(env, pending);
      assert.deepEqual(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get(), clearances);
      assert.deepEqual({ ...env.DB.sqlite.prepare(
        "SELECT state, version, stop_active FROM safety_occurrences WHERE occurrence_id = ?",
      ).get(stop) }, { state: "reported", version: 1, stop_active: 1 });
      assert.equal((env.DB.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM safety_occurrence_events WHERE occurrence_id = ? AND event_kind = 'released'",
      ).get(stop) as { count: number }).count, 0);
      if (layer === "Worker") {
        const readiness = await gate(env, jobA, USERS.mate);
        assert.equal(readiness.ready, false);
        assert.deepEqual(readiness.blockers.map((blocker) => [blocker.stop?.occurrence_id, blocker.stop?.scope]),
          [[stop, "tenant"]]);
      } else if (layer === "D1") {
        assert.match(String(await acknowledgeRefusal(env, jobA, USERS.mate)), /safety_stop_active/);
        assert.match(String(await acknowledgeRefusal(env, jobB, USERS.other)), /safety_stop_active/);
      } else {
        const today = await buildTodayReadModel(env, fieldAuth(USERS.other));
        assert.deepEqual(today.jobs.map((job) => [job.id, job.active_stops?.map((held) => [held.occurrence_id, held.scope])]),
          [[jobB.jobId, [[stop, "tenant"]]]]);
        const job = await buildJobReadModel(env, fieldAuth(USERS.mate), jobA.jobId);
        assert.deepEqual(job?.job.active_stops?.map((held) => [held.occurrence_id, held.scope]), [[stop, "tenant"]]);
      }
      await expectHeld(env, jobB, USERS.other, [{ occurrence_id: stop, scope: "tenant" }], "another crew stays held");
      await lift(env, stop);
      await expectHeld(env, jobA, USERS.mate, [], "only the existing person release lifts it");
    });
  }

  test(`migration preserves an existing unresolved ${scopeType} after its target appears`, async () => {
    const env = testEnv({ beforeStopMigration: true });
    const { jobA, jobB } = await twoJobs(env);
    const pending = definition({ jobId: "JOB-HOLD-MIGRATED" });
    if (scopeType === "work_package") seedAssignmentSnapshot(env, pending);
    const stop = await raise(env, {
      type: scopeType,
      id: scopeType === "roof_job" ? pending.jobId : pending.workPackageId,
    });
    // A resolved stop remains job-scoped when this migration upgrades an existing database.
    const resolved = await raise(env, { type: "roof_job", id: jobB.jobId });
    env.DB.sqlite.exec(readFileSync(new URL("../migrations/0170_safety_stop_route_gaps.sql", import.meta.url), "utf8"));
    const clearances = env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get();
    if (scopeType === "roof_job") seedAssignmentSnapshot(env, pending, { jobOnly: true });
    else await issue(env, pending);
    assert.deepEqual(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get(), clearances);
    await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], "backfilled unresolved scope");
    await lift(env, stop);
    await expectHeld(env, jobA, USERS.mate, [], "resolved stop still holds only its own job");
    await expectHeld(env, jobB, USERS.other, [{ occurrence_id: resolved, scope: "job" }], "existing resolved stop");
  });
}

test("a stop on a job that doesn't exist holds every job of the tenant, for every crew", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  await expectHeld(env, jobA, USERS.crew, [], "before any stop");
  const typo = await raise(env, { type: "roof_job", id: "JOB-HOLD-TYPO" });
  for (const [packet, actor, label] of [
    [jobA, USERS.crew, "the raiser's own job, the raiser"],
    [jobA, USERS.mate, "the same job, a second crew member"],
    [jobB, USERS.other, "a different job, another crew"],
  ] as const) {
    await expectHeld(env, packet, actor, [{ occurrence_id: typo, scope: "tenant" }], label);
  }
  // Stopping work itself is never refused.
  await act(env, jobB, "stop_work", "stop-job-b-under-typo", USERS.other);
  // Released, it holds nothing.
  await lift(env, typo);
  await expectHeld(env, jobA, USERS.mate, [], "after release");
});

test("D1 retains unresolved scope history and refuses direct narrowing", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  const stop = await raise(env, { type: "roof_job", id: "JOB-HOLD-MISSING" });
  const sqlite = env.DB.sqlite;
  const original = sqlite.prepare("SELECT * FROM safety_stop_unresolved_scopes WHERE occurrence_id = ?").get(stop);
  assert.ok(original);
  assert.throws(() => sqlite.prepare(
    "UPDATE safety_stop_unresolved_scopes SET latched_at = ? WHERE occurrence_id = ?",
  ).run(at(0), stop), /safety_stop_unresolved_scope_immutable/);
  assert.throws(() => sqlite.prepare("DELETE FROM safety_stop_unresolved_scopes WHERE occurrence_id = ?").run(stop),
    /safety_stop_unresolved_scope_immutable/);
  assert.throws(() => sqlite.prepare(
    "INSERT OR REPLACE INTO safety_stop_unresolved_scopes (occurrence_id, tenant_id) VALUES (?, ?)",
  ).run(stop, TENANT), /safety_stop_unresolved_scope_immutable/);
  assert.throws(() => sqlite.prepare(
    "UPDATE safety_occurrences SET scope_id = ?, version = version + 1 WHERE occurrence_id = ?",
  ).run(jobA.jobId, stop), /safety_occurrence_identity_immutable/);
  const resolved = await raise(env, { type: "roof_job", id: jobB.jobId });
  assert.throws(() => sqlite.prepare(
    "INSERT INTO safety_stop_unresolved_scopes (occurrence_id, tenant_id) VALUES (?, ?)",
  ).run(resolved, TENANT), /safety_stop_scope_not_unresolved/);
  assert.deepEqual(sqlite.prepare("SELECT * FROM safety_stop_unresolved_scopes WHERE occurrence_id = ?").get(stop), original);
  await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], "direct narrowing refused");
  await lift(env, stop);
  assert.deepEqual(sqlite.prepare("SELECT * FROM safety_stop_unresolved_scopes WHERE occurrence_id = ?").get(stop), original,
    "a release lifts the stop without erasing its unresolved history");
  await expectHeld(env, jobA, USERS.mate, [], "authorized release");
});

test("a resolved job that disappears cannot silently narrow its stop when restored", async () => {
  const env = testEnv({ reverseTriggers: true });
  const { jobA } = await twoJobs(env);
  const sqlite = env.DB.sqlite;
  const original = sqlite.prepare("SELECT * FROM operating_roof_jobs WHERE roof_job_id = ?").get(jobA.jobId)!;
  const restored = { ...original, roof_job_id: "JOB-HOLD-RESTORED", job_number: "IW-RESTORED" } as Record<string, unknown>;
  const columns = Object.keys(restored);
  const insert = () => sqlite.prepare(
    `INSERT INTO operating_roof_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((name) => restored[name] as never));
  insert();
  const stop = await raise(env, { type: "roof_job", id: restored.roof_job_id as string });
  await expectHeld(env, jobA, USERS.mate, [], "resolved target");
  // No package or assignment refers to this synthetic target, so the real FK rules permit removal.
  sqlite.prepare("DELETE FROM operating_roof_jobs WHERE roof_job_id = ?").run(restored.roof_job_id as string);
  await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], "target missing");
  insert();
  await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], "restoration is not scope authority");
  await lift(env, stop);
  await expectHeld(env, jobA, USERS.mate, [], "authorized release");
});

test("a stop on a Work Package that doesn't exist, or a tenant stop under any id, holds every job", async () => {
  for (const scope of [
    { type: "work_package" as const, id: "wp_hold_typo" },
    { type: "tenant" as const, id: TENANT },
    { type: "tenant" as const, id: "not-this-tenant" },
  ]) {
    const env = testEnv();
    const { jobA, jobB } = await twoJobs(env);
    const stop = await raise(env, scope);
    await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: stop, scope: "tenant" }], scope.id);
    await expectHeld(env, jobB, USERS.other, [{ occurrence_id: stop, scope: "tenant" }], scope.id);
    await lift(env, stop);
    await expectHeld(env, jobB, USERS.other, [], `${scope.id} released`);
  }
});

test("a stop on a job holds that job for every crew member and leaves other jobs free", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  const onA = await raise(env, { type: "roof_job", id: jobA.jobId });
  await expectHeld(env, jobA, USERS.crew, [{ occurrence_id: onA, scope: "job" }], "raiser");
  await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: onA, scope: "job" }], "second crew member");
  await expectHeld(env, jobB, USERS.other, [], "a different job");
  await lift(env, onA);
  await expectHeld(env, jobA, USERS.mate, [], "after release");
});

test("a stop on one Work Package holds every package of its job, Superseded included", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  // An earlier, Superseded package of job A; the stop names it, not the package the crew acts on.
  const sqlite = env.DB.sqlite;
  const columns = (sqlite.prepare("PRAGMA table_info(work_packages)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  const copied = columns.map((name) =>
    name === "work_package_id" ? "'wp_hold_job_a_superseded'"
      : name === "status" ? "'Superseded'"
      : name);
  // The row stands for what an earlier issue and supersession left, so the package guards that
  // shape a new issue are set aside while it is written, and restored exactly afterwards.
  const guards = sqlite.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'work_packages'",
  ).all() as Array<{ name: string; sql: string }>;
  for (const guard of guards) sqlite.exec(`DROP TRIGGER ${guard.name}`);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.prepare(
    `INSERT INTO work_packages (${columns.join(", ")})
     SELECT ${copied.join(", ")} FROM work_packages WHERE tenant_id = ? AND work_package_id = ?`,
  ).run(TENANT, jobA.workPackageId);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const guard of guards) sqlite.exec(guard.sql);
  const onSuperseded = await raise(env, { type: "work_package", id: "wp_hold_job_a_superseded" });
  await expectHeld(env, jobA, USERS.mate, [{ occurrence_id: onSuperseded, scope: "job" }],
    "a Superseded package of the job");
  await expectHeld(env, jobB, USERS.other, [], "a different job");
  // A stop on the very package the crew acts on holds it too.
  const onPackage = await raise(env, { type: "work_package", id: jobA.workPackageId });
  await expectHeld(env, jobA, USERS.crew, [
    { occurrence_id: onSuperseded, scope: "job" },
    { occurrence_id: onPackage, scope: "job" },
  ], "the package itself");
  await lift(env, onSuperseded);
  await lift(env, onPackage);
  await expectHeld(env, jobA, USERS.crew, [], "after both releases");
});

test("shop and vehicle stops, and another tenant's stops, hold no job", async () => {
  const env = testEnv();
  const { jobA } = await twoJobs(env);
  await raise(env, { type: "shop", id: "SHOP-1" });
  await raise(env, { type: "vehicle", id: "TRUCK-7" });
  await raise(env, { type: "roof_job", id: "JOB-HOLD-TYPO" }, OTHER_USERS.crew, { tenantId: OTHER_TENANT });
  await raise(env, { type: "tenant", id: OTHER_TENANT }, OTHER_USERS.crew, { tenantId: OTHER_TENANT });
  await expectHeld(env, jobA, USERS.crew, [], "shop, vehicle, other tenant");
  assert.deepEqual((await holdingSafetyStops(env, TENANT, [jobA.jobId])).get(jobA.jobId), []);
});

test("the crew read lists exactly the stops that hold each job, oldest first", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  const tenantWide = await raise(env, { type: "roof_job", id: "JOB-HOLD-TYPO" }, USERS.crew, { minute: 120 });
  const onA = await raise(env, { type: "roof_job", id: jobA.jobId }, USERS.mate, { minute: 110 });
  await raise(env, { type: "vehicle", id: "TRUCK-7" }, USERS.crew, { minute: 105 });
  await raise(env, { type: "roof_job", id: "JOB-HOLD-TYPO" }, OTHER_USERS.crew,
    { tenantId: OTHER_TENANT, minute: 100 });
  const lifted = await raise(env, { type: "roof_job", id: jobB.jobId }, USERS.other, { minute: 101 });
  await lift(env, lifted);
  const byJob = await holdingSafetyStops(env, TENANT, [jobA.jobId, jobB.jobId]);
  assert.deepEqual(byJob.get(jobA.jobId), [
    {
      occurrence_id: onA,
      scope: "job",
      reported_at: at(110),
      summary: `Ice on the north slope, stop ${Number(onA.slice(-4))}.`,
      raiser_display_name: USERS.mate.name,
    },
    {
      occurrence_id: tenantWide,
      scope: "tenant",
      reported_at: at(120),
      summary: `Ice on the north slope, stop ${Number(tenantWide.slice(-4))}.`,
      raiser_display_name: raiserName,
    },
  ]);
  assert.deepEqual(byJob.get(jobB.jobId)?.map((stop) => [stop.occurrence_id, stop.scope]),
    [[tenantWide, "tenant"]]);
  // The readiness refusal carries the same facts.
  const readiness = await evaluateSafetyReadiness(env, {
    tenantId: TENANT,
    scopes: [{ type: "tenant", id: TENANT }, { type: "roof_job", id: jobA.jobId }],
    subjectUserIds: [],
    now: new Date().toISOString(),
  });
  assert.deepEqual(readiness.blockers.map((blocker) => blocker.stop), byJob.get(jobA.jobId));
});

test("the crew Today and job reads carry each job's holding stops, and never another tenant's", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  const onA = await raise(env, { type: "roof_job", id: jobA.jobId }, USERS.mate, { minute: 110 });
  const tenantWide = await raise(env, { type: "work_package", id: "wp_hold_typo" }, USERS.crew, { minute: 120 });
  await raise(env, { type: "tenant", id: OTHER_TENANT }, OTHER_USERS.crew, { tenantId: OTHER_TENANT, minute: 100 });
  const crew = fieldAuth(USERS.crew);
  const today = await buildTodayReadModel(env, crew);
  assert.deepEqual(today.jobs.map((job) => [job.id, job.active_stops?.map((stop) => stop.occurrence_id)]),
    [[jobA.jobId, [onA, tenantWide]]]);
  assert.equal(today.stale_fields.includes("jobs.active_stops_unavailable"), false);
  const job = await buildJobReadModel(env, crew, jobA.jobId);
  assert.deepEqual(job?.job.active_stops, (await holdingSafetyStops(env, TENANT, [jobA.jobId])).get(jobA.jobId));
  const other = await buildJobReadModel(env, fieldAuth(USERS.other), jobB.jobId);
  assert.deepEqual(other?.job.active_stops?.map((stop) => [stop.occurrence_id, stop.scope]),
    [[tenantWide, "tenant"]]);
  // A stop read that fails says so, rather than looking like no stop.
  const broken = {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("AS held_work_scopes")) throw new Error("synthetic_read_failure");
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    },
  } as unknown as TestEnv;
  const degraded = await buildTodayReadModel(broken, crew);
  assert.deepEqual(degraded.jobs.map((row) => row.active_stops), [null]);
  assert.ok(degraded.stale_fields.includes("jobs.active_stops_unavailable"));
});

test("a readiness question about a Work Package alone finds the stops on its job", async () => {
  const env = testEnv();
  const { jobA, jobB } = await twoJobs(env);
  const onA = await raise(env, { type: "roof_job", id: jobA.jobId });
  // No job level in the chain: the package's own job is read from work_packages.
  const ask = async (packet: NativeWorkPackageDefinition) =>
    (await evaluateSafetyReadiness(env, {
      tenantId: TENANT,
      scopes: [{ type: "tenant", id: TENANT }, { type: "work_package", id: packet.workPackageId }],
      subjectUserIds: [],
      now: new Date().toISOString(),
    })).blockers.map((blocker) => blocker.stop?.occurrence_id);
  assert.deepEqual(await ask(jobA), [onA]);
  assert.deepEqual(await ask(jobB), []);
});

/** Admit the universal assignment through its real current-owner writer, without Roof Job setup. */
async function issueTyped(env: TestEnv, scope: WorkObjectScope, suffix: string) {
  const packet = definition({
    ...scope, jobId: scope.workObjectId, workPackageId: `wp_typed_${suffix}`,
  });
  const written = await recordOperatingWorkObjectAssignment(env, {
    ...scope, tenantId: TENANT, assignedUsers: [USERS.crew.id],
    authorityRequirements: packet.authorityRequirements!,
    scheduledStart: new Date(Date.now() + 3_600_000).toISOString(),
    authorityUserId: USERS.owner.id, authorityRole: "owner", actorUserId: USERS.owner.id,
    idempotencyKey: `typed-safety-assignment-${suffix}`,
  });
  assert.equal(written.kind, "created");
  packet.assignmentId = written.assignment.assignment_id;
  packet.assignmentVersion = written.assignment.assignment_version;
  packet.assignmentCommandFingerprint = written.assignment.command_fingerprint;
  packet.assignmentAuthorityRequirementsSha256 = written.assignment.authority_requirements_sha256!;
  packet.authorityRequirements = written.assignment.authority_requirements!;
  await issueNativeWorkPackage(env, packet);
  await seedPacketAuthority(env, packet);
  return packet;
}

function packetScope(packet: NativeWorkPackageDefinition): WorkObjectScope {
  return { workObjectType: packet.workObjectType, workObjectId: packet.workObjectId,
    physicalContextType: packet.physicalContextType, physicalContextId: packet.physicalContextId };
}

async function expectTypedSurfaces(
  env: TestEnv, packet: NativeWorkPackageDefinition, expected: string[],
) {
  const auth = fieldAuth(USERS.crew);
  const universal = await buildUniversalWorkPackageReadModel(env, auth, packetScope(packet));
  assert.ok(universal, "the actually admitted typed assignment stays readable");
  assert.deepEqual(universal.work_object, packetScope(packet));
  assert.deepEqual((universal.active_stops as Array<{ occurrence_id: string }>).map((s) => s.occurrence_id), expected);
  const today = await buildTodayReadModel(env, auth);
  const typed = today.work_objects.find((row) => row.assignment.id === packet.assignmentId);
  assert.ok(typed, "Today retains this admitted non-Roof assignment");
  assert.deepEqual(typed.active_stops?.map((s) => s.occurrence_id), expected);
  await expectHeld(env, packet, USERS.crew,
    expected.map((id) => ({ occurrence_id: id, scope: "job" })), "typed Worker and D1");
}

/** The real action handler, with the assignment resolved by its complete route scope. */
async function typedAcknowledgeRoute(env: TestEnv, packet: NativeWorkPackageDefinition) {
  const auth = fieldAuth(USERS.crew);
  const scope = packetScope(packet);
  const assignment = await activeAssignmentForWorkObject(env, auth, scope);
  assert.ok(assignment);
  const id = `typed-route-${++nextAction}`;
  return await handleWorkPackageAction(new Request("https://app.example.invalid/action", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": id,
      "x-device-action-id": id },
    body: JSON.stringify({ device_action_id: id, payload: {
      work_package_id: packet.workPackageId, work_package_version: packet.version,
      release_attempt_id: packet.releaseAttemptId, work_object_type: scope.workObjectType,
      work_object_id: scope.workObjectId, physical_context_type: scope.physicalContextType,
      physical_context_id: scope.physicalContextId,
    } }),
  }), env, auth, packet.jobId, assignment, "acknowledge", scope);
}

function productionGuardRefusals(env: TestEnv, packet: NativeWorkPackageDefinition) {
  const db = env.DB.sqlite;
  const probe = (run: () => void) => {
    db.exec("SAVEPOINT typed_production_probe");
    try { run(); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    finally { db.exec("ROLLBACK TO typed_production_probe; RELEASE typed_production_probe"); }
  };
  const safety = probe(() => {
    reverseGateInLedger(db, { tenantId: TENANT, roofJobId: packet.jobId,
      gate: "Safety", actorUserId: USERS.owner.id, actorRole: "owner" });
    attestGateInLedger(db, { tenantId: TENANT, roofJobId: packet.jobId,
      gate: "Safety", actorUserId: USERS.owner.id, actorRole: "owner" });
  });
  const schedule = probe(() => {
    const row = { ...db.prepare(
      "SELECT * FROM operating_job_assignments WHERE tenant_id = ? AND assignment_id = ?",
    ).get(TENANT, packet.assignmentId) };
    row.supersedes_assignment_id = row.assignment_id;
    row.assignment_id = `assignment-typed-probe-${++nextAction}`;
    row.assignment_version = Number(row.assignment_version) + 1;
    row.correction_reason = "Synthetic typed hold discriminator";
    row.command_fingerprint = sha256(String(row.assignment_id));
    row.idempotency_key_hash = sha256(`key:${row.assignment_id}`);
    const names = Object.keys(row);
    db.prepare(`INSERT INTO operating_job_assignments (${names.join(",")})
      VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row) as never[]);
  });
  return { safety, schedule };
}

for (const reverseTriggers of [false, true]) {
  test(`typed safety holds preserve full identity and explicit Roof Job parents (${reverseTriggers ? "reversed" : "normal"} triggers)`, async () => {
    const env = testEnv({ reverseTriggers });
    const { jobA } = await twoJobs(env);
    const shop = await issueTyped(env, { workObjectType: "Service Work", workObjectId: jobA.jobId,
      physicalContextType: "Shop", physicalContextId: "independent-shop-A" }, "shop-A");
    const otherType = await issueTyped(env, { ...packetScope(shop), workObjectType: "Shop Order" }, "other-type");
    const otherContext = await issueTyped(env, { ...packetScope(shop), physicalContextId: "independent-shop-B" }, "other-context");
    const parented = await issueTyped(env, { ...packetScope(shop), workObjectId: "SERVICE-ON-A",
      physicalContextType: "Roof Job", physicalContextId: jobA.jobId }, "parented");
    const onRoof = await raise(env, { type: "roof_job", id: jobA.jobId });
    await expectTypedSurfaces(env, shop, []);
    await expectTypedSurfaces(env, otherType, []);
    await expectTypedSurfaces(env, otherContext, []);
    await expectTypedSurfaces(env, parented, [onRoof]);
    const onShop = await raise(env, { type: "work_package", id: shop.workPackageId });
    await expectTypedSurfaces(env, shop, [onShop]);
    await expectTypedSurfaces(env, otherType, []);
    await expectTypedSurfaces(env, otherContext, []);
    await expectTypedSurfaces(env, parented, [onRoof]);
    // The handler consults the same complete identity before claiming an action.
    const refused = await typedAcknowledgeRoute(env, shop);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { error: string }).error, "safety_stop_active");
    const admitted = await typedAcknowledgeRoute(env, otherType);
    assert.equal(admitted.status, 200, await admitted.clone().text());
    // A direct native writer (the post-read race boundary) reports only the committed scope's stop.
    await assert.rejects(nativeWorkPackageWriter(env).persistAction({
      kind: "acknowledge", workPackageId: shop.workPackageId, workPackageVersion: shop.version,
      jobId: shop.jobId, assignmentId: shop.assignmentId, actorUser: USERS.crew.email, actorRole: "field",
      deviceActionId: `typed-native-${++nextAction}`, blockerReason: null,
      releaseAttemptId: shop.releaseAttemptId, ...packetScope(shop),
      manifestKey: "work-packages/typed-native-race.json",
      authorityPreconditions: AUTHORITY.get(env.DB)!.get(`${shop.workPackageId}:${shop.version}`)!,
    }), (error: unknown) => error instanceof FieldActionError && error.code === "safety_stop_active" &&
      JSON.stringify(error.details).includes(onShop) && !JSON.stringify(error.details).includes(onRoof));
    // A package stop on a genuine Roof Job child still holds other work on that Roof Job.
    const onChild = await raise(env, { type: "work_package", id: parented.workPackageId });
    await expectHeld(env, jobA, USERS.crew,
      [onRoof, onChild].map((id) => ({ occurrence_id: id, scope: "job" })), "real Roof Job relationship");
    await expectTypedSurfaces(env, otherContext, []);
  });

  test(`typed work keeps tenant and unresolved holds conservative (${reverseTriggers ? "reversed" : "normal"} triggers)`, async () => {
    const env = testEnv({ reverseTriggers });
    const packet = await issueTyped(env, { workObjectType: "Service Work", workObjectId: "INDEPENDENT-SERVICE",
      physicalContextType: "Shop", physicalContextId: "independent-shop" }, "unknown-control");
    await raise(env, { type: "tenant", id: OTHER_TENANT }, OTHER_USERS.crew, { tenantId: OTHER_TENANT });
    await expectTypedSurfaces(env, packet, []);
    const tenant = await raise(env, { type: "tenant", id: "tenant-alias" });
    const missing = await raise(env, { type: "roof_job", id: "JOB-TYPED-LATE" });
    const expected = [{ occurrence_id: tenant, scope: "tenant" as const },
      { occurrence_id: missing, scope: "tenant" as const }];
    await expectHeld(env, packet, USERS.crew, expected, "tenant/unresolved typed work");
    const late = definition({ jobId: "JOB-TYPED-LATE" });
    seedAssignmentSnapshot(env, late, { jobOnly: true });
    await expectHeld(env, packet, USERS.crew, expected, "late target cannot narrow typed hold");
    const read = await buildUniversalWorkPackageReadModel(env, fieldAuth(USERS.crew), packetScope(packet));
    assert.deepEqual((read!.active_stops as Array<{ occurrence_id: string; scope: string }>)
      .map((s) => ({ occurrence_id: s.occurrence_id, scope: s.scope })), expected);
    const mismatched = await safetyReadinessForScope(env, {
      tenantId: TENANT, scope: { type: "work_package", id: packet.workPackageId }, jobId: packet.jobId,
      workObjectScope: { ...packetScope(packet), physicalContextId: "wrong-context" },
      subjectUserIds: [USERS.crew.id], now: new Date().toISOString(),
    });
    assert.equal(mismatched.ready, false);
    assert.ok(mismatched.blockers.some((b) => b.code === "safety_event_uncontrolled"));
  });

  test(`production guards use typed relationships and never narrow latched stops (${reverseTriggers ? "reversed" : "normal"} triggers)`, async () => {
    const env = testEnv({ reverseTriggers });
    const { jobA, jobB } = await twoJobs(env);
    const shop = await issueTyped(env, { workObjectType: "Service Work", workObjectId: jobA.jobId,
      physicalContextType: "Shop", physicalContextId: "independent-shop" }, "production-shop");
    const child = await issueTyped(env, { workObjectType: "Service Work", workObjectId: "SERVICE-REAL-CHILD",
      physicalContextType: "Roof Job", physicalContextId: jobA.jobId }, "production-child");
    await raise(env, { type: "work_package", id: shop.workPackageId });
    assert.equal(await safetyStopActive(env, TENANT, jobA.jobId), false);
    assert.deepEqual(productionGuardRefusals(env, jobA), { safety: null, schedule: null },
      "a valid attestation and direct schedule stay admitted across an unrelated equal-ID Shop stop");
    await raise(env, { type: "work_package", id: child.workPackageId });
    assert.equal(await safetyStopActive(env, TENANT, jobA.jobId), true);
    assert.deepEqual(productionGuardRefusals(env, jobA), {
      safety: "production_gate_safety_stop_active", schedule: "operating_job_assignment_stop_active",
    }, "an explicit Roof Job physical relationship holds both D1 consumers");
    assert.equal(await safetyStopActive(env, TENANT, jobB.jobId), false);
    assert.deepEqual(productionGuardRefusals(env, jobB), { safety: null, schedule: null });
    const unresolved = await raise(env, { type: "roof_job", id: "JOB-PRODUCTION-LATE" });
    seedAssignmentSnapshot(env, definition({ jobId: "JOB-PRODUCTION-LATE" }), { jobOnly: true });
    assert.equal(await unknownJobStop(env, TENANT), unresolved);
    assert.equal(await safetyStopActive(env, TENANT, jobB.jobId), true);
    assert.deepEqual(productionGuardRefusals(env, jobB), {
      safety: "production_gate_stop_job_unknown", schedule: "operating_job_assignment_stop_job_unknown",
    }, "late target arrival cannot narrow the attestation or scheduling hold");
  });

  for (const scopeType of ["roof_job", "work_package"] as const) {
    test(`Owner Now keeps ${scopeType} uncertainty through target arrival until release (${reverseTriggers ? "reversed" : "normal"} triggers)`, async () => {
      const env = testEnv({ reverseTriggers });
      const { jobA, jobB } = await twoJobs(env);
      const pending = definition({ jobId: `JOB-OWNER-LATE-${scopeType}` });
      if (scopeType === "work_package") seedAssignmentSnapshot(env, pending);
      const owner = fieldAuth(USERS.owner);
      owner.session.role = "owner";
      owner.permissions = permissionsForRole("owner");
      const kind = scopeType === "roof_job" ? "stop_job_unknown" : "stop_work_package_unknown";
      const list = async () => (await buildOwnerNowReadModel(env, owner)).exceptions
        .filter((row) => row.kind === kind);
      const known = await raise(env, { type: scopeType,
        id: scopeType === "roof_job" ? jobA.jobId : jobA.workPackageId });
      const foreign = await raise(env, { type: scopeType, id: "FOREIGN-OWNER-MISSING" },
        OTHER_USERS.crew, { tenantId: OTHER_TENANT });
      assert.deepEqual(await list(), [], "resolved local and unresolved foreign targets are excluded");
      const stop = await raise(env, { type: scopeType,
        id: scopeType === "roof_job" ? pending.jobId : pending.workPackageId });
      const before = await list();
      assert.equal(before.length, 1);
      assert.equal(before[0]!.id, stop);
      assert.match(before[0]!.title, /doesn’t exist/, "still-missing approved copy stays accurate");
      const clearances = env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get();
      if (scopeType === "roof_job") seedAssignmentSnapshot(env, pending, { jobOnly: true });
      else await issue(env, pending);
      assert.deepEqual(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM production_gate_clearances").get(), clearances,
        "target arrival grants no gate clearance");
      const after = await list();
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, stop);
      assert.match(after[0]!.title, /still holds every job/);
      assert.doesNotMatch(after[0]!.title, /doesn’t exist/);
      assert.match(after[0]!.why ?? "", /history/);
      assert.deepEqual({ ...after[0], title: null, why: null }, { ...before[0], title: null, why: null },
        "all DTO identity, raiser, summary, timestamps, null controls and links stay unchanged");
      assert.equal(after[0]!.job_id, null);
      assert.equal(await (scopeType === "roof_job" ? unknownJobStop : unknownWorkPackageStop)(env, TENANT), stop);
      await expectHeld(env, jobB, USERS.other, [{ occurrence_id: stop, scope: "tenant" }],
        "named Owner Now exception agrees with the actual Worker/D1 global hold");
      await lift(env, stop, new Date().toISOString());
      assert.deepEqual(await list(), [], "an actual independent person release removes the active exception");
      assert.ok(env.DB.sqlite.prepare("SELECT 1 FROM safety_stop_unresolved_scopes WHERE occurrence_id = ?").get(stop),
        "release does not erase immutable uncertainty history");
      assert.equal(env.DB.sqlite.prepare("SELECT stop_active FROM safety_occurrences WHERE occurrence_id = ?").get(foreign)!.stop_active, 1);
      const holds = await holdingSafetyStops(env, TENANT, [jobA.jobId, jobB.jobId]);
      assert.deepEqual(holds.get(jobB.jobId), []);
      assert.ok(holds.get(jobA.jobId)!.some((row) => row.occurrence_id === known), "the genuine same-scope stop remains active");
    });
  }
}
