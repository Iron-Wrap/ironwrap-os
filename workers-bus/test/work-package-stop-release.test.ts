import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import {
  authorityCurrentPrecondition,
  recordAuthorityReadback,
  type AuthorityCurrentPrecondition,
} from "../src/authority-records.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import { recordOperatingJobAssignment } from "../src/operating-job-assignment-store.ts";
import { handleWorkPackageAction } from "../src/work-package-actions.ts";
import {
  issueNativeWorkPackage,
  nativeWorkPackageAction,
  type NativeWorkPackageDefinition,
} from "../src/work-package-store.ts";
import { bindCrewInLedger, clearScheduleGatesInLedger } from "./production-gate-ledger-fixture.ts";

// Every fixture is synthetic: reserved example.invalid identities, and times relative to the run
// rather than calendar dates.
const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const PEPPER = "synthetic-stop-release-pepper-0123456789abcdef";
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
  owner: { id: "appu_owner_release", email: "owner@example.invalid", name: "Synthetic Owner", role: "owner", access: "owner" },
  ops: { id: "appu_ops_release", email: "ops@example.invalid", name: "Synthetic Ops", role: "ops", access: "ops" },
  production: { id: "appu_production_release", email: "production@example.invalid", name: "Synthetic Production", role: "ops", access: "production" },
  sales: { id: "appu_sales_release", email: "sales@example.invalid", name: "Synthetic Sales", role: "ops", access: "sales" },
  accounting: { id: "appu_accounting_release", email: "accounting@example.invalid", name: "Synthetic Accounting", role: "ops", access: "accounting" },
  crew: { id: "appu_crew_release", email: "crew@example.invalid", name: "Synthetic Crew", role: "field", access: "field", frappe: "crew@example.invalid" },
} satisfies Record<string, FixtureUser>;

const OTHER_USERS = {
  owner: { id: "appu_owner_other_tenant", email: "owner@other.example.invalid", name: "Other Owner", role: "owner", access: "owner" },
  crew: { id: "appu_crew_other_tenant", email: "crew@other.example.invalid", name: "Other Crew", role: "field", access: "field", frappe: "crew@other.example.invalid" },
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

function testEnv(): TestEnv {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of Object.values(USERS)) insertUser(DB, user, TENANT);
  for (const user of Object.values(OTHER_USERS)) insertUser(DB, user, OTHER_TENANT);
  return {
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
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

const evidenceId = (label: string) => `evi_${sha256(`evidence:${label}`).slice(0, 32)}`;
const mediaChecksum = (id: string) => sha256(`media:${id}`);
const stopEventIdFor = (deviceActionId: string, tenantId = TENANT) =>
  `wpe_${sha256(`${tenantId}:${deviceActionId}`).slice(0, 32)}`;

// --- Native Work Package fixtures --------------------------------------------------------------

function definition(overrides: Partial<NativeWorkPackageDefinition> = {}): NativeWorkPackageDefinition {
  const tenantId = overrides.tenantId ?? TENANT;
  const jobId = overrides.jobId ?? "JOB-STOP-RELEASE";
  const workPackageId = overrides.workPackageId ?? "wp_stop_release_package";
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

function seedAssignmentSnapshot(env: TestEnv, packet: NativeWorkPackageDefinition): void {
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
  // People on no crew clear the five gates a schedule rests on: production in this tenant, the
  // owner alone in the other one.
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
  // The schedule binds Crew by policy in the same write as its row (0159).
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
) {
  const crew = packet.tenantId === TENANT ? USERS.crew : OTHER_USERS.crew;
  return await nativeWorkPackageAction(envFor(env, packet.tenantId), {
    kind,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: crew.email,
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

/** The field receipt the stop route writes; `userId` is the person who reported the stop. */
function insertStopReceipt(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  deviceActionId: string,
  userId: string,
) {
  env.DB.sqlite
    .prepare(
      `INSERT INTO field_work_package_actions
        (device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id,
         action_kind, payload_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'stop_work', ?, 'processing', ?, ?)`,
    )
    .run(deviceActionId, packet.tenantId, userId, packet.jobId, packet.assignmentId,
      packet.workPackageId, "c".repeat(64), at(10), at(10));
}

async function stop(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  deviceActionId: string,
  reporterUserId: string = packet.tenantId === TENANT ? USERS.crew.id : OTHER_USERS.crew.id,
): Promise<string> {
  insertStopReceipt(env, packet, deviceActionId, reporterUserId);
  await act(env, packet, "stop_work", deviceActionId);
  return stopEventIdFor(deviceActionId, packet.tenantId);
}

/** The stop event's own time, as the ledger recorded it. */
function stopOccurredAt(env: TestEnv, stopEventId: string): string {
  return (
    env.DB.sqlite
      .prepare("SELECT occurred_at FROM work_package_events WHERE event_id = ?")
      .get(stopEventId) as { occurred_at: string }
  ).occurred_at;
}

/** The current time once the clock has passed `instant`, so a capture taken now is later. */
async function momentAfter(instant: string): Promise<string> {
  while (Date.now() <= Date.parse(instant)) await new Promise((resolve) => setTimeout(resolve, 1));
  return new Date().toISOString();
}

interface CaptureInput {
  tenantId?: string;
  jobId: string;
  workPackageId: string | null;
  version?: number;
  releaseAttemptId?: string;
  slotId?: string;
  userId?: string;
  evidenceId: string;
  deviceActionId: string;
  status?: "verified" | "r2_stored";
  manifested?: boolean;
  /** When the device finished the capture; null stores none, like a capture from before 0092. */
  capturedAt?: string | null;
  /** When the Worker received, verified and stored it; the capture time unless a test says. */
  receivedAt?: string;
}

/**
 * One stored field capture, verified and manifested unless a test says otherwise. Without a capture
 * time it was taken at minute 30 of the fixture clock, hours before any stop in this file, so it
 * releases no stop; a test that needs a correction times its capture after the stop.
 */
function insertCapture(env: TestEnv, input: CaptureInput) {
  const sqlite = env.DB.sqlite;
  const verified = (input.status ?? "verified") === "verified";
  const typed = input.workPackageId !== null;
  const capturedAt = input.capturedAt === undefined ? at(30) : input.capturedAt;
  const receivedAt = input.receivedAt ?? capturedAt ?? at(30);
  const startedAt =
    capturedAt === null ? null : new Date(Date.parse(capturedAt) - 60_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO field_actions (
         device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind,
         payload_hash, status, checkin_id, manifest_key, response_json,
         created_at, updated_at, verified_at, work_package_id, work_package_version,
         evidence_slot_id, evidence_requirement, evidence_source, evidence_device_id,
         evidence_freshness, evidence_conflict_state, evidence_verification,
         evidence_disposition, evidence_correction_of, evidence_item_correction_of,
         work_package_release_attempt_id, correction_reason, work_object_type,
         work_object_id, physical_context_type, physical_context_id,
         capture_started_at, capture_completed_at
       ) VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deviceActionId,
      input.tenantId ?? TENANT,
      input.userId ?? USERS.crew.id,
      input.jobId,
      `ASSIGN-${input.jobId}`,
      "a".repeat(64),
      input.status ?? "verified",
      `checkin_${input.deviceActionId}`,
      input.manifested === false ? null : `evidence/${input.deviceActionId}.json`,
      verified ? JSON.stringify({ status: "verified" }) : null,
      receivedAt,
      receivedAt,
      verified ? receivedAt : null,
      input.workPackageId,
      typed ? input.version ?? 1 : null,
      typed ? input.slotId ?? "step:1" : null,
      typed ? "Deck photographs" : null,
      typed ? "photo" : null,
      typed ? "device-synthetic-crew" : null,
      typed ? "Current" : null,
      typed ? "None" : null,
      typed ? "Verified" : null,
      typed ? "Open" : null,
      typed ? input.releaseAttemptId ?? "attempt-synthetic" : null,
      "Roof Job",
      input.jobId,
      "Roof Site",
      input.jobId,
      startedAt,
      capturedAt,
    );
  sqlite
    .prepare(
      `INSERT INTO field_action_media
        (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
         content_length, r2_stored_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', 128, ?)`,
    )
    .run(input.deviceActionId, `attachment-${input.deviceActionId}`, input.evidenceId,
      `evidence/raw/${input.deviceActionId}.jpg`, mediaChecksum(input.evidenceId), receivedAt);
}

function captureFor(
  env: TestEnv,
  packet: NativeWorkPackageDefinition,
  label: string,
  overrides: Partial<CaptureInput> = {},
): string {
  const id = evidenceId(label);
  insertCapture(env, {
    tenantId: packet.tenantId,
    jobId: packet.jobId,
    workPackageId: packet.workPackageId,
    version: packet.version,
    releaseAttemptId: packet.releaseAttemptId,
    evidenceId: id,
    deviceActionId: `capture-${label}`,
    ...overrides,
  });
  return id;
}

interface StoppedPackage {
  packet: NativeWorkPackageDefinition;
  stopEventId: string;
  stopDeviceActionId: string;
  evidence: string;
  /** When `evidence` was captured: strictly after the stop. */
  capturedAt: string;
}

async function stoppedPackage(
  env: TestEnv,
  options: {
    progress?: Array<"acknowledge" | "start_work">;
    overrides?: Partial<NativeWorkPackageDefinition>;
    reporterUserId?: string;
  } = {},
): Promise<StoppedPackage> {
  const packet = definition(options.overrides);
  await issue(env, packet);
  for (const kind of options.progress ?? [])
    await act(env, packet, kind, `${kind}-${packet.workPackageId}-${packet.version}`);
  const stopDeviceActionId = `stop-${packet.workPackageId}-${packet.version}`;
  const stopEventId = await stop(env, packet, stopDeviceActionId, options.reporterUserId);
  // The correction is captured after the stop; nothing captured earlier can release it.
  const capturedAt = await momentAfter(stopOccurredAt(env, stopEventId));
  const evidence = captureFor(env, packet, `${packet.workPackageId}-${packet.version}-fixed`, {
    capturedAt,
  });
  return { packet, stopEventId, stopDeviceActionId, evidence, capturedAt };
}

// --- Person sessions and requests --------------------------------------------------------------

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function personAuth(env: TestEnv, userId: string): Promise<AuthContext> {
  const token = randomToken();
  const now = Date.now();
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(await sessionHashFor(env, token), userId, TENANT, new Date(now - 60_000).toISOString(),
      new Date(now + 3_600_000).toISOString(), new Date(now - 60_000).toISOString(),
      "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** The context a desktop connector, agent host, or service credential would carry: no cookie token. */
function connectorAuth(role: "owner" | "production"): AuthContext {
  const user = role === "owner" ? USERS.owner : USERS.production;
  return {
    rawSessionToken: "",
    csrfToken: "",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "f".repeat(64),
      session_created_at: new Date(Date.now() - 60_000).toISOString(),
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: "device-synthetic-connector",
      device_proof_hash: null,
      user_id: user.id,
      tenant_id: TENANT,
      email_normalized: user.email,
      display_name: user.name,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: USERS.owner.email,
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

function releaseRequest(
  workPackageId: string,
  body: unknown,
  options: { key?: string | null; csrf?: string | null; deviceActionId?: string | null; method?: string; raw?: string } = {},
): Request {
  const key = options.key === undefined ? "stop-release-0001" : options.key;
  const deviceActionId = options.deviceActionId === undefined ? key : options.deviceActionId;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.csrf !== null && options.csrf !== undefined) headers["x-csrf-token"] = options.csrf;
  if (key !== null) headers["idempotency-key"] = key;
  if (deviceActionId !== null) headers["x-device-action-id"] = deviceActionId;
  return new Request(
    `https://app.example.invalid/api/v1/work-packages/${encodeURIComponent(workPackageId)}/stop-releases`,
    { method: options.method ?? "POST", headers, body: options.raw ?? JSON.stringify(body) },
  );
}

async function postRelease(
  env: TestEnv,
  auth: AuthContext,
  workPackageId: string,
  body: unknown,
  options: Parameters<typeof releaseRequest>[2] = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    releaseRequest(workPackageId, body, { csrf: auth.csrfToken, ...options }),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function getReleases(
  env: TestEnv,
  auth: AuthContext,
  workPackageId: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/work-packages/${encodeURIComponent(workPackageId)}/stop-releases`,
    ),
    env,
    auth,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function releaseBody(stopped: StoppedPackage, overrides: Record<string, unknown> = {}) {
  return {
    work_package_version: stopped.packet.version,
    stop_event_id: stopped.stopEventId,
    reason: "The loose anchor was replaced and the crew lead inspected the new anchor.",
    evidence_ids: [stopped.evidence],
    ...overrides,
  };
}

function packageStatus(env: TestEnv, workPackageId: string, version = 1, tenantId = TENANT): string {
  return (
    env.DB.sqlite
      .prepare("SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ? AND version = ?")
      .get(tenantId, workPackageId, version) as { status: string }
  ).status;
}

function releaseCount(env: TestEnv): number {
  return Number(
    (env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM work_package_stop_releases").get() as { count: number }).count,
  );
}

/** A complete release row for a direct D1 insert, valid unless a test overrides a fact. */
function directReleaseRow(
  stopped: StoppedPackage,
  restoredStatus: "Released" | "Acknowledged" | "In Progress",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const deviceActionId = String(overrides.device_action_id ?? `direct-release-${stopped.stopDeviceActionId}`);
  return {
    release_id: `wsr_${sha256(`direct:${deviceActionId}`).slice(0, 32)}`,
    tenant_id: stopped.packet.tenantId,
    device_action_id: deviceActionId,
    request_sha256: "c".repeat(64),
    work_package_id: stopped.packet.workPackageId,
    work_package_version: stopped.packet.version,
    job_id: stopped.packet.jobId,
    stop_event_id: stopped.stopEventId,
    stop_device_action_id: stopped.stopDeviceActionId,
    stop_actor_user_id: USERS.crew.id,
    stop_reporter_user_id: USERS.crew.id,
    restored_status: restoredStatus,
    released_by_user_id: USERS.production.id,
    released_by_role: "production",
    independence_json: canonicalJson({
      released_by_is_stop_actor: false,
      released_by_is_stop_reporter: false,
      released_in_person_session: true,
    }),
    evidence_refs_json: canonicalJson([
      { ref: `field-evidence://${stopped.evidence}`, sha256: mediaChecksum(stopped.evidence) },
    ]),
    reason: "Synthetic direct release",
    manifest_key: `work-packages/office-actions/${stopped.packet.tenantId}/${deviceActionId}.json`,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function insertReleaseRow(env: TestEnv, row: Record<string, unknown>, verb = "INSERT") {
  const columns = Object.keys(row);
  env.DB.sqlite
    .prepare(
      `${verb} INTO work_package_stop_releases (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...(Object.values(row) as never[]));
}

/** A supersession of the given version, attempted inside a transaction that is always rolled back. */
function attemptSupersession(env: TestEnv, packet: NativeWorkPackageDefinition): string {
  const sqlite = env.DB.sqlite;
  // One clock read: the row must carry created_at = occurred_at, and two reads straddle a
  // millisecond tick often enough to fail the CHECK under a loaded test run.
  const occurredAt = new Date().toISOString();
  sqlite.exec("BEGIN");
  try {
    sqlite
      .prepare(
        `INSERT INTO work_package_supersessions
          (supersession_id, tenant_id, device_action_id, command_sha256,
           prior_work_package_id, prior_work_package_version,
           replacement_work_package_id, replacement_work_package_version,
           job_id, assignment_id, work_object_type, work_object_id,
           physical_context_type, physical_context_id, actor_user_id, actor_role,
           correction_reason, manifest_key, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`wps_direct_${packet.workPackageId}`, packet.tenantId, `direct-supersede-${packet.workPackageId}`,
        "d".repeat(64), packet.workPackageId, packet.version, `${packet.workPackageId}_next`,
        packet.version + 1, packet.jobId, packet.assignmentId, packet.workObjectType,
        packet.workObjectId, packet.physicalContextType, packet.physicalContextId, USERS.owner.id,
        "IronWrap Owner", "Synthetic correction", "work-packages/direct-supersede.json",
        occurredAt, occurredAt);
    return packageStatus(env, packet.workPackageId, packet.version, packet.tenantId);
  } finally {
    sqlite.exec("ROLLBACK");
  }
}

function startEventTime(env: TestEnv, packet: NativeWorkPackageDefinition): string {
  return (
    env.DB.sqlite
      .prepare(
        `SELECT occurred_at FROM work_package_events
          WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
            AND event_kind = 'start_work'`,
      )
      .get(packet.tenantId, packet.workPackageId, packet.version) as { occurred_at: string }
  ).occurred_at;
}

// --- Tests -------------------------------------------------------------------------------------

test("an independent person releases the holding stop and the version resumes exactly where it stopped", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env, { progress: ["acknowledge", "start_work"] });
  const { packet } = stopped;
  const production = await personAuth(env, USERS.production.id);
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");

  const before = await getReleases(env, production, packet.workPackageId);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.work_package, {
    id: packet.workPackageId,
    version: 1,
    job_id: packet.jobId,
    status: "Blocked",
  });
  assert.equal(before.body.current_stop.stop_event_id, stopped.stopEventId);
  assert.equal(before.body.current_stop.stop_actor_user_id, USERS.crew.id);
  assert.equal(before.body.current_stop.blocker_reason, "Synthetic loose anchor");
  assert.deepEqual(before.body.releases, []);

  const released = await postRelease(env, production, packet.workPackageId, releaseBody(stopped), {
    key: "stop-release-in-progress-0001",
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.status, "verified");
  assert.equal(released.body.device_action_id, "stop-release-in-progress-0001");
  assert.equal(released.body.server_ref, packet.workPackageId);
  assert.match(released.body.cursor, /^wsr_[0-9a-f]{32}$/);
  assert.deepEqual(
    { ...released.body.release, created_at: undefined },
    {
      release_id: released.body.cursor,
      work_package_id: packet.workPackageId,
      work_package_version: 1,
      job_id: packet.jobId,
      stop_event_id: stopped.stopEventId,
      stop_device_action_id: stopped.stopDeviceActionId,
      stop_actor_user_id: USERS.crew.id,
      stop_reporter_user_id: USERS.crew.id,
      restored_status: "In Progress",
      released_by_user_id: USERS.production.id,
      released_by_role: "production",
      independence: {
        released_by_is_stop_actor: false,
        released_by_is_stop_reporter: false,
        released_in_person_session: true,
      },
      evidence_refs: [
        { ref: `field-evidence://${stopped.evidence}`, sha256: mediaChecksum(stopped.evidence) },
      ],
      reason: "The loose anchor was replaced and the crew lead inspected the new anchor.",
      created_at: undefined,
    },
  );

  // The record and the transition committed together: the version is back In Progress at the
  // instant of the release, and the immutable office-action manifest carries the same facts.
  const row = env.DB.sqlite
    .prepare("SELECT * FROM work_package_stop_releases WHERE release_id = ?")
    .get(released.body.cursor) as Record<string, any>;
  const projection = env.DB.sqlite
    .prepare("SELECT status, updated_at FROM work_packages WHERE work_package_id = ? AND version = 1")
    .get(packet.workPackageId) as { status: string; updated_at: string };
  assert.deepEqual({ ...projection }, { status: "In Progress", updated_at: row.created_at });
  assert.equal(row.manifest_key, `work-packages/office-actions/${TENANT}/stop-release-in-progress-0001.json`);
  const manifest = JSON.parse(env.RAW.objects.get(row.manifest_key)!.body);
  assert.equal(manifest.kind, "stop_release");
  assert.equal(manifest.user_id, USERS.production.id);
  assert.equal(manifest.target.release_id, row.release_id);
  assert.equal(manifest.target.restored_status, "In Progress");
  assert.equal(manifest.target.request_sha256, row.request_sha256);

  const after = await getReleases(env, production, packet.workPackageId);
  assert.equal(after.status, 200);
  assert.equal(after.body.work_package.status, "In Progress");
  assert.equal(after.body.current_stop, null);
  assert.deepEqual(after.body.releases, [released.body.release]);

  // The crew may stop the same version again; that stop holds the version until its own release.
  const secondStopEventId = await stop(env, packet, "stop-second-wp_stop_release_package");
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");
  const repeated = await postRelease(env, production, packet.workPackageId, releaseBody(stopped), {
    key: "stop-release-stale-stop-0001",
  });
  assert.equal(repeated.status, 409);
  assert.deepEqual(repeated.body, { error: "work_package_stop_already_released" });
  const owner = await personAuth(env, USERS.owner.id);
  // The fix that released the first stop was captured before the second one, so it cannot release
  // the second stop; a capture taken after it can.
  const reused = await postRelease(
    env,
    owner,
    packet.workPackageId,
    releaseBody(stopped, { stop_event_id: secondStopEventId }),
    { key: "stop-release-second-reused-0001" },
  );
  assert.equal(reused.status, 409);
  assert.deepEqual(reused.body, { error: "work_package_stop_release_evidence_before_stop" });
  const secondFix = captureFor(env, packet, "second-fix", {
    slotId: "hold:1",
    capturedAt: await momentAfter(stopOccurredAt(env, secondStopEventId)),
  });
  const second = await postRelease(
    env,
    owner,
    packet.workPackageId,
    releaseBody(stopped, { stop_event_id: secondStopEventId, evidence_ids: [secondFix] }),
    { key: "stop-release-second-0001" },
  );
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.release.released_by_role, "owner");
  assert.equal(second.body.release.restored_status, "In Progress");
  assert.equal(packageStatus(env, packet.workPackageId), "In Progress");
  const history = await getReleases(env, owner, packet.workPackageId);
  assert.deepEqual(
    history.body.releases.map((release: Record<string, unknown>) => release.stop_event_id),
    [stopped.stopEventId, secondStopEventId],
  );
});

test("a release restores exactly the status the stop interrupted", async () => {
  for (const [progress, expected] of [
    [[], "Released"],
    [["acknowledge"], "Acknowledged"],
  ] as const) {
    const env = testEnv();
    const stopped = await stoppedPackage(env, { progress: [...progress] });
    const ops = await personAuth(env, USERS.ops.id);
    const released = await postRelease(env, ops, stopped.packet.workPackageId, releaseBody(stopped));
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.release.restored_status, expected);
    assert.equal(released.body.release.released_by_role, "ops");
    assert.equal(packageStatus(env, stopped.packet.workPackageId), expected);
  }

  // D1 derives the status from the version's own ledger and refuses any other claim.
  const env = testEnv();
  const stopped = await stoppedPackage(env, { progress: ["acknowledge"] });
  for (const claimed of ["Released", "In Progress"] as const) {
    assert.throws(
      () => insertReleaseRow(env, directReleaseRow(stopped, claimed)),
      /work_package_stop_release_status_invalid/,
    );
  }
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, stopped.packet.workPackageId), "Blocked");
});

test("an exact replay returns the original release and a changed intent conflicts", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const second = captureFor(env, stopped.packet, "replay-second", {
    slotId: "hold:1",
    capturedAt: stopped.capturedAt,
  });
  const production = await personAuth(env, USERS.production.id);
  const body = releaseBody(stopped, { evidence_ids: [stopped.evidence, second] });

  const first = await postRelease(env, production, stopped.packet.workPackageId, body, {
    key: "stop-release-replay-0001",
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await postRelease(env, production, stopped.packet.workPackageId, body, {
    key: "stop-release-replay-0001",
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  // Evidence order is not part of the intent: the request is canonicalized before hashing.
  const reordered = await postRelease(
    env,
    production,
    stopped.packet.workPackageId,
    { ...body, evidence_ids: [...body.evidence_ids].reverse() },
    { key: "stop-release-replay-0001" },
  );
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body, first.body);

  for (const changed of [
    { ...body, reason: "A different account of the correction." },
    { ...body, evidence_ids: [stopped.evidence] },
  ]) {
    const conflict = await postRelease(env, production, stopped.packet.workPackageId, changed, {
      key: "stop-release-replay-0001",
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: "work_package_stop_release_replay_conflict" });
  }
  // The same key from another person is another intent, never a replay of this one.
  const owner = await personAuth(env, USERS.owner.id);
  const borrowed = await postRelease(env, owner, stopped.packet.workPackageId, body, {
    key: "stop-release-replay-0001",
  });
  assert.equal(borrowed.status, 409);
  assert.deepEqual(borrowed.body, { error: "work_package_stop_release_replay_conflict" });
  // A fresh key cannot release the same stop twice.
  const again = await postRelease(env, owner, stopped.packet.workPackageId, body, {
    key: "stop-release-replay-0002",
  });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: "work_package_stop_already_released" });
  assert.equal(releaseCount(env), 1);

  // A key already bound to a different office action conflicts before any D1 write.
  const other = testEnv();
  const otherStopped = await stoppedPackage(other);
  const otherProduction = await personAuth(other, USERS.production.id);
  other.RAW.objects.set(`work-packages/office-actions/${TENANT}/stop-release-shared-0001.json`, {
    body: "{\"kind\":\"hold_release\"}",
    size: 23,
    checksum: sha256("{\"kind\":\"hold_release\"}"),
    contentType: "application/json",
  });
  const shared = await postRelease(other, otherProduction, otherStopped.packet.workPackageId,
    releaseBody(otherStopped), { key: "stop-release-shared-0001" });
  assert.equal(shared.status, 409);
  assert.deepEqual(shared.body, { error: "work_package_stop_release_replay_conflict" });
  assert.equal(releaseCount(other), 0);
  assert.equal(packageStatus(other, otherStopped.packet.workPackageId), "Blocked");
});

test("only a person's own session in a releasing role may release, with distinct refusals", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const id = stopped.packet.workPackageId;
  const body = releaseBody(stopped);
  const production = await personAuth(env, USERS.production.id);
  // Each refusal is awaited before the next request starts, so every check sees the same state.
  const expect = async (
    label: string,
    pending: Promise<{ status: number; body: Record<string, any> }>,
    status: number,
    error: string,
  ) => {
    const result = await pending;
    assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body, { error }, label);
  };

  // Not a person: an agent, connector, service credential or effect runtime carries no cookie
  // token, a forged token does not hash to the session, a forged CSRF token is not derived from
  // it, and a revoked or borrowed session is not live for this user.
  await expect("connector context", postRelease(env, connectorAuth("owner"), id, body, { csrf: "" }), 403,
    "work_package_stop_release_person_required");
  await expect("token that is not this session", postRelease(env, { ...production, rawSessionToken: randomToken() },
    id, body), 403, "work_package_stop_release_person_required");
  await expect("CSRF token not derived from the session", postRelease(env,
    { ...production, csrfToken: "forged-csrf-token" }, id, body, { csrf: "forged-csrf-token" }), 403,
    "work_package_stop_release_person_required");
  await expect("session claimed for another user", postRelease(env,
    { ...production, session: { ...production.session, user_id: USERS.owner.id } }, id, body), 403,
    "work_package_stop_release_person_required");
  const revoked = await personAuth(env, USERS.owner.id);
  env.DB.sqlite.prepare("UPDATE app_sessions SET revoked_at = ? WHERE session_hash = ?")
    .run(new Date().toISOString(), revoked.session.session_hash);
  await expect("revoked session", postRelease(env, revoked, id, body), 403,
    "work_package_stop_release_person_required");

  // A person whose current role cannot release.
  await expect("sales", postRelease(env, await personAuth(env, USERS.sales.id), id, body), 403,
    "work_package_stop_release_role_required");
  await expect("accounting", postRelease(env, await personAuth(env, USERS.accounting.id), id, body), 403,
    "work_package_stop_release_role_required");

  // Request discipline.
  await expect("missing CSRF", postRelease(env, production, id, body, { csrf: null }), 403, "csrf_failed");
  await expect("missing Idempotency-Key", postRelease(env, production, id, body, { key: null }), 400,
    "idempotency_key_required");
  await expect("device action mismatch", postRelease(env, production, id, body, {
    deviceActionId: "stop-release-other-0001",
  }), 400, "device_action_id_mismatch");
  await expect("unknown field", postRelease(env, production, id, { ...body, restored_status: "Released" }), 400,
    "invalid_work_package_stop_release");
  await expect("blank reason", postRelease(env, production, id, { ...body, reason: "   " }), 400,
    "invalid_work_package_stop_release");
  await expect("malformed evidence id", postRelease(env, production, id, { ...body, evidence_ids: ["photo-1"] }),
    400, "invalid_work_package_stop_release");
  await expect("no evidence field", postRelease(env, production, id, { ...body, evidence_ids: undefined }), 400,
    "work_package_stop_release_evidence_required");
  await expect("empty evidence", postRelease(env, production, id, { ...body, evidence_ids: [] }), 400,
    "work_package_stop_release_evidence_required");
  await expect("invalid JSON", postRelease(env, production, id, null, { raw: "{" }), 400, "invalid_json");

  // Exact facts about the package and the stop.
  await expect("unknown package", postRelease(env, production, "wp_stop_release_missing", body), 404,
    "work_package_not_found");
  await expect("another version", postRelease(env, production, id, { ...body, work_package_version: 2 }), 409,
    "work_package_stop_release_version_conflict");
  await expect("another stop", postRelease(env, production, id, {
    ...body,
    stop_event_id: stopEventIdFor("stop-that-never-happened"),
  }), 409, "work_package_stop_release_stop_conflict");
  const running = definition({ workPackageId: "wp_stop_release_running", jobId: "JOB-STOP-RELEASE-RUNNING" });
  await issue(env, running);
  await expect("not Blocked", postRelease(env, production, running.workPackageId, {
    ...body,
    stop_event_id: stopped.stopEventId,
  }), 409, "work_package_not_blocked");

  const method = await handleAuthenticatedRoute(
    releaseRequest(id, body, { method: "PUT", csrf: production.csrfToken }),
    env,
    production,
  );
  assert.equal(method.status, 405);
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, id), "Blocked");

  // A read is open to the same releasing roles and nobody else.
  assert.equal((await getReleases(env, await personAuth(env, USERS.sales.id), id)).status, 403);
  assert.equal((await getReleases(env, production, "wp_stop_release_missing")).status, 404);
});

test("the person who raised or reported the stop can never release it", async () => {
  // Raised: the crew member who stopped is later promoted into a releasing role.
  const raisedEnv = testEnv();
  const raised = await stoppedPackage(raisedEnv);
  raisedEnv.DB.sqlite.prepare("UPDATE app_users SET access_role = 'production' WHERE user_id = ?")
    .run(USERS.crew.id);
  const promoted = await personAuth(raisedEnv, USERS.crew.id);
  assert.equal(promoted.session.role, "production");
  const byRaiser = await postRelease(raisedEnv, promoted, raised.packet.workPackageId, releaseBody(raised));
  assert.equal(byRaiser.status, 403);
  assert.deepEqual(byRaiser.body, { error: "work_package_stop_release_independence_required" });
  // D1 repeats the refusal for a direct write, under every identity the raiser carries.
  assert.throws(
    () => insertReleaseRow(raisedEnv, directReleaseRow(raised, "Released", { released_by_user_id: USERS.crew.id })),
    /work_package_stop_release_independence_required/,
  );
  assert.equal(releaseCount(raisedEnv), 0);
  assert.equal(packageStatus(raisedEnv, raised.packet.workPackageId), "Blocked");

  // Reported: the receipt names a production user as the person who submitted the stop.
  const reportedEnv = testEnv();
  const reported = await stoppedPackage(reportedEnv, { reporterUserId: USERS.production.id });
  const reporter = await personAuth(reportedEnv, USERS.production.id);
  const byReporter = await postRelease(reportedEnv, reporter, reported.packet.workPackageId,
    releaseBody(reported));
  assert.equal(byReporter.status, 403);
  assert.deepEqual(byReporter.body, { error: "work_package_stop_release_independence_required" });
  assert.throws(
    () => insertReleaseRow(reportedEnv, directReleaseRow(reported, "Released", {
      stop_reporter_user_id: USERS.production.id,
    })),
    /work_package_stop_release_independence_required/,
  );
  // An independent supervisor may release, and the record keeps who reported it.
  const ops = await personAuth(reportedEnv, USERS.ops.id);
  const independent = await postRelease(reportedEnv, ops, reported.packet.workPackageId,
    releaseBody(reported));
  assert.equal(independent.status, 200, JSON.stringify(independent.body));
  assert.equal(independent.body.release.stop_reporter_user_id, USERS.production.id);
  assert.equal(independent.body.release.stop_actor_user_id, USERS.crew.id);
});

test("independence holds across aliases: the raiser or reporter under another identity is refused", async () => {
  // Each alias ties the production releaser to the crew member who raised the stop, or to the ops
  // user on its receipt, through a Frappe login equal to the other person's email.
  for (const [label, stopper, aliasedUserId, login] of [
    ["the releaser's Frappe login is the raiser's email", "raiser", USERS.production.id, USERS.crew.email],
    ["the raiser's Frappe login is the releaser's email", "raiser", USERS.crew.id, USERS.production.email],
    ["the releaser's Frappe login is the reporter's email", "reporter", USERS.production.id, USERS.ops.email],
    ["the reporter's Frappe login is the releaser's email", "reporter", USERS.ops.id, USERS.production.email],
  ] as const) {
    const env = testEnv();
    const reporter = stopper === "reporter" ? USERS.ops.id : USERS.crew.id;
    const stopped = await stoppedPackage(env, { reporterUserId: reporter });
    env.DB.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?")
      .run(login, aliasedUserId);
    const production = await personAuth(env, USERS.production.id);
    const refused = await postRelease(env, production, stopped.packet.workPackageId, releaseBody(stopped), {
      key: "stop-release-alias-0001",
    });
    assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body, { error: "work_package_stop_release_independence_required" }, label);
    // The route refuses before it writes anything, and D1 joins the same identities itself.
    assert.equal(env.RAW.objects.has(`work-packages/office-actions/${TENANT}/stop-release-alias-0001.json`),
      false, label);
    assert.throws(
      () => insertReleaseRow(env, directReleaseRow(stopped, "Released", { stop_reporter_user_id: reporter })),
      /work_package_stop_release_independence_required/,
      label,
    );
    assert.equal(releaseCount(env), 0, label);
    // A releaser no alias ties to the stop still may.
    const owner = await personAuth(env, USERS.owner.id);
    const independent = await postRelease(env, owner, stopped.packet.workPackageId, releaseBody(stopped), {
      key: "stop-release-alias-0002",
    });
    assert.equal(independent.status, 200, `${label}: ${JSON.stringify(independent.body)}`);
  }
});

test("correction evidence must be verified, stored captures of this tenant and job", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const { packet } = stopped;
  const production = await personAuth(env, USERS.production.id);
  const otherJob = evidenceId("other-job");
  insertCapture(env, {
    jobId: "JOB-STOP-RELEASE-ELSEWHERE",
    workPackageId: "wp_stop_release_elsewhere",
    evidenceId: otherJob,
    deviceActionId: "capture-other-job",
  });
  const otherTenant = evidenceId("other-tenant");
  insertCapture(env, {
    tenantId: OTHER_TENANT,
    jobId: packet.jobId,
    workPackageId: packet.workPackageId,
    userId: OTHER_USERS.crew.id,
    evidenceId: otherTenant,
    deviceActionId: "capture-other-tenant",
  });
  const unverified = captureFor(env, packet, "unverified", { slotId: "hold:1", status: "r2_stored" });
  const unmanifested = captureFor(env, packet, "unmanifested", {
    slotId: "step:1",
    userId: USERS.ops.id,
    manifested: false,
  });
  const untyped = evidenceId("untyped");
  insertCapture(env, {
    jobId: packet.jobId,
    workPackageId: null,
    evidenceId: untyped,
    deviceActionId: "capture-untyped",
  });
  const ambiguous = captureFor(env, packet, "ambiguous", { slotId: "hold:1", userId: USERS.ops.id });
  insertCapture(env, {
    jobId: packet.jobId,
    workPackageId: packet.workPackageId,
    releaseAttemptId: packet.releaseAttemptId,
    slotId: "hold:1",
    userId: USERS.owner.id,
    evidenceId: ambiguous,
    deviceActionId: "capture-ambiguous-copy",
  });

  for (const [label, ids] of [
    ["another job", [otherJob]],
    ["another tenant", [otherTenant]],
    ["not verified", [unverified]],
    ["not manifested", [unmanifested]],
    ["not a Work Package capture", [untyped]],
    ["ambiguous evidence id", [ambiguous]],
    ["never captured", [evidenceId("never-captured")]],
    ["one good, one foreign", [stopped.evidence, otherJob]],
  ] as const) {
    const result = await postRelease(env, production, packet.workPackageId,
      releaseBody(stopped, { evidence_ids: [...ids] }), { key: `stop-release-evidence-${ids.join("-").slice(4, 40)}` });
    assert.equal(result.status, 409, `${label}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body, { error: "work_package_stop_release_evidence_invalid" }, label);
  }
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");

  // D1 checks every reference itself, including the stored checksum.
  for (const [label, refs] of [
    ["checksum", [{ ref: `field-evidence://${stopped.evidence}`, sha256: "0".repeat(64) }]],
    ["foreign job", [{ ref: `field-evidence://${otherJob}`, sha256: mediaChecksum(otherJob) }]],
    ["foreign tenant", [{ ref: `field-evidence://${otherTenant}`, sha256: mediaChecksum(otherTenant) }]],
    ["empty", []],
    ["duplicate", [
      { ref: `field-evidence://${stopped.evidence}`, sha256: mediaChecksum(stopped.evidence) },
      { ref: `field-evidence://${stopped.evidence}`, sha256: mediaChecksum(stopped.evidence) },
    ]],
    ["extra key", [{ ref: `field-evidence://${stopped.evidence}`, sha256: mediaChecksum(stopped.evidence), note: "x" }]],
    ["not an object", [`field-evidence://${stopped.evidence}`]],
  ] as const) {
    assert.throws(
      () => insertReleaseRow(env, directReleaseRow(stopped, "Released", { evidence_refs_json: JSON.stringify(refs) })),
      /work_package_stop_release_evidence_invalid/,
      label,
    );
  }

  const accepted = await postRelease(env, production, packet.workPackageId, releaseBody(stopped), {
    key: "stop-release-evidence-accepted",
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
});

test("a verified capture taken before the stop never releases it, on the route or in D1", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const { packet } = stopped;
  const production = await personAuth(env, USERS.production.id);
  // Every capture is verified, manifested and stored on this job; only its capture time is wrong.
  const before = captureFor(env, packet, "before-stop", { slotId: "hold:1" });
  const uploadedAfter = captureFor(env, packet, "uploaded-after-stop", {
    slotId: "step:1",
    userId: USERS.ops.id,
    receivedAt: stopped.capturedAt,
  });
  const atStop = captureFor(env, packet, "at-stop", {
    slotId: "hold:1",
    userId: USERS.ops.id,
    capturedAt: stopOccurredAt(env, stopped.stopEventId),
  });
  const legacy = captureFor(env, packet, "no-device-time", {
    slotId: "step:1",
    userId: USERS.owner.id,
    capturedAt: null,
  });
  const cases = [
    ["captured before the stop", [before]],
    ["captured before the stop and uploaded after it", [uploadedAfter]],
    ["captured at the stop's own instant", [atStop]],
    ["no device time, received before the stop", [legacy]],
    ["one capture after the stop and one before it", [stopped.evidence, before]],
  ] as const;
  for (const [index, [label, ids]] of cases.entries()) {
    const key = `stop-release-before-stop-${index}`;
    const result = await postRelease(env, production, packet.workPackageId,
      releaseBody(stopped, { evidence_ids: [...ids] }), { key });
    assert.equal(result.status, 409, `${label}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body, { error: "work_package_stop_release_evidence_before_stop" }, label);
    // The route refuses before it writes anything, the office-action manifest included.
    assert.equal(env.RAW.objects.has(`work-packages/office-actions/${TENANT}/${key}.json`), false, label);
    // D1 refuses the same citation on a direct insert.
    assert.throws(
      () => insertReleaseRow(env, directReleaseRow(stopped, "Released", {
        evidence_refs_json: canonicalJson(
          ids.map((id) => ({ ref: `field-evidence://${id}`, sha256: mediaChecksum(id) })),
        ),
      })),
      /work_package_stop_release_evidence_before_stop/,
      label,
    );
  }
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");

  // The correction captured after the stop releases it.
  const released = await postRelease(env, production, packet.workPackageId, releaseBody(stopped), {
    key: "stop-release-after-stop",
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(packageStatus(env, packet.workPackageId), "Released");
});

test("a release is invisible and impossible across tenants", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const foreign = await stoppedPackage(env, {
    overrides: {
      tenantId: OTHER_TENANT,
      workPackageId: "wp_stop_release_foreign",
      jobId: "JOB-STOP-RELEASE-FOREIGN",
    },
  });
  const production = await personAuth(env, USERS.production.id);

  // The other tenant's package does not exist for this tenant's session.
  const post = await postRelease(env, production, foreign.packet.workPackageId, releaseBody(foreign));
  assert.equal(post.status, 404);
  assert.deepEqual(post.body, { error: "work_package_not_found" });
  const read = await getReleases(env, production, foreign.packet.workPackageId);
  assert.equal(read.status, 404);
  assert.deepEqual(read.body, { error: "work_package_not_found" });

  // A session of another tenant never reaches this tenant's Worker routes.
  const visitor: AuthContext = {
    ...production,
    session: { ...production.session, tenant_id: OTHER_TENANT },
  };
  assert.deepEqual(
    (await postRelease(env, visitor, stopped.packet.workPackageId, releaseBody(stopped))).body,
    { error: "not_found" },
  );
  assert.equal((await getReleases(env, visitor, stopped.packet.workPackageId)).status, 404);

  // D1 keeps every fact inside one tenant: a record under another tenant cannot name this
  // tenant's version and stop, and this tenant cannot be released by another tenant's user.
  assert.throws(
    () => insertReleaseRow(env, directReleaseRow(stopped, "Released", {
      tenant_id: OTHER_TENANT,
      released_by_user_id: OTHER_USERS.owner.id,
      released_by_role: "owner",
    })),
    /work_package_stop_release_scope_invalid/,
  );
  assert.throws(
    () => insertReleaseRow(env, directReleaseRow(stopped, "Released", {
      released_by_user_id: OTHER_USERS.owner.id,
      released_by_role: "owner",
    })),
    /work_package_stop_release_actor_invalid/,
  );
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, stopped.packet.workPackageId), "Blocked");
  assert.equal(packageStatus(env, foreign.packet.workPackageId, 1, OTHER_TENANT), "Blocked");
});

test("D1 re-checks the releaser, the stop and the record facts on every direct insert", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  for (const [label, overrides, error] of [
    ["role the releaser does not hold", { released_by_role: "owner" }, "work_package_stop_release_actor_invalid"],
    ["role that never releases", { released_by_user_id: USERS.sales.id, released_by_role: "sales" },
      "CHECK constraint failed: released_by_role"],
    ["wrong stop device action", { stop_device_action_id: "stop-device-elsewhere" }, "work_package_stop_release_scope_invalid"],
    ["wrong stop actor", { stop_actor_user_id: USERS.ops.id }, "work_package_stop_release_scope_invalid"],
    ["reporter omitted", { stop_reporter_user_id: null }, "work_package_stop_release_scope_invalid"],
    ["wrong job", { job_id: "JOB-STOP-RELEASE-ELSEWHERE" }, "work_package_stop_release_scope_invalid"],
    ["released before the stop", { created_at: at(-1) }, "work_package_stop_release_scope_invalid"],
    ["independence not asserted", {
      independence_json: canonicalJson({ released_by_is_stop_actor: false, released_by_is_stop_reporter: false }),
    }, "work_package_stop_release_independence_required"],
    ["independence contradicted", {
      independence_json: canonicalJson({
        released_by_is_stop_actor: false,
        released_by_is_stop_reporter: false,
        released_in_person_session: false,
      }),
    }, "work_package_stop_release_independence_required"],
  ] as const) {
    assert.throws(
      () => insertReleaseRow(env, directReleaseRow(stopped, "Released", { ...overrides })),
      new RegExp(error),
      label,
    );
  }
  env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.ops.id);
  assert.throws(
    () => insertReleaseRow(env, directReleaseRow(stopped, "Released", {
      released_by_user_id: USERS.ops.id,
      released_by_role: "ops",
    })),
    /work_package_stop_release_actor_invalid/,
  );
  // A version that was never stopped has nothing to release.
  const running = definition({ workPackageId: "wp_stop_release_never_stopped", jobId: "JOB-STOP-RELEASE-QUIET" });
  await issue(env, running);
  assert.throws(
    () => insertReleaseRow(env, directReleaseRow({ ...stopped, packet: running }, "Released", {
      job_id: running.jobId,
    })),
    /work_package_stop_release_scope_invalid/,
  );
  assert.equal(releaseCount(env), 0);
  assert.equal(packageStatus(env, stopped.packet.workPackageId), "Blocked");

  // The valid direct record commits and restores the version in the same statement.
  insertReleaseRow(env, directReleaseRow(stopped, "Released"));
  assert.equal(packageStatus(env, stopped.packet.workPackageId), "Released");
});

test("the release ledger is append-only: no update, delete, replace, or second release of a stop", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const production = await personAuth(env, USERS.production.id);
  const released = await postRelease(env, production, stopped.packet.workPackageId, releaseBody(stopped));
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const original = env.DB.sqlite.prepare("SELECT * FROM work_package_stop_releases").get() as Record<string, unknown>;

  assert.throws(
    () => env.DB.sqlite.prepare("UPDATE work_package_stop_releases SET reason = 'rewritten'").run(),
    /work_package_stop_release_append_only/,
  );
  assert.throws(
    () => env.DB.sqlite.prepare("DELETE FROM work_package_stop_releases").run(),
    /work_package_stop_release_append_only/,
  );
  assert.throws(
    () => insertReleaseRow(env, { ...original, reason: "replaced" }, "INSERT OR REPLACE"),
    /work_package_stop_release_append_only/,
  );
  assert.throws(
    () => insertReleaseRow(env, { ...original, release_id: `wsr_${"1".repeat(32)}` }, "INSERT OR REPLACE"),
    /work_package_stop_release_append_only/,
  );
  assert.throws(
    () => insertReleaseRow(env, {
      ...original,
      release_id: `wsr_${"2".repeat(32)}`,
      device_action_id: "stop-release-second-intent",
    }),
    /work_package_stop_already_released/,
  );
  assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM work_package_stop_releases").all(), [original]);
});

test("the re-created 0143 guards still hold a stop until a matching release exists", async () => {
  // Without a record, neither a status replay nor a supersession lifts the stop.
  const env = testEnv();
  const stopped = await stoppedPackage(env, { progress: ["acknowledge", "start_work"] });
  const { packet } = stopped;
  const replayStart = () =>
    env.DB.sqlite
      .prepare(
        `UPDATE work_packages SET status = 'In Progress', updated_at = ?
          WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
      )
      .run(startEventTime(env, packet), packet.tenantId, packet.workPackageId, packet.version);
  assert.throws(replayStart, /work_package_stop_release_required/);
  assert.throws(() => attemptSupersession(env, packet), /work_package_stop_release_required/);
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");

  // With a matching record (the transition trigger removed so the version stays Blocked), the
  // supersession guard admits a replacement and the status guard admits exactly the release.
  const held = testEnv();
  const heldStopped = await stoppedPackage(held, { progress: ["acknowledge", "start_work"] });
  held.DB.sqlite.exec("DROP TRIGGER work_package_stop_releases_apply");
  const record = directReleaseRow(heldStopped, "In Progress");
  insertReleaseRow(held, record);
  assert.equal(packageStatus(held, heldStopped.packet.workPackageId), "Blocked");
  assert.equal(attemptSupersession(held, heldStopped.packet), "Superseded");
  // The record restores only its own status at its own instant, never another status.
  assert.throws(
    () => held.DB.sqlite
      .prepare("UPDATE work_packages SET status = 'Released', updated_at = ? WHERE work_package_id = ?")
      .run(record.created_at, heldStopped.packet.workPackageId),
    /work_package_projection_without_fact/,
  );
  held.DB.sqlite
    .prepare("UPDATE work_packages SET status = 'In Progress', updated_at = ? WHERE work_package_id = ?")
    .run(record.created_at, heldStopped.packet.workPackageId);
  assert.equal(packageStatus(held, heldStopped.packet.workPackageId), "In Progress");

  // A record for an earlier stop on the same version does not unlock a later stop.
  const production = await personAuth(env, USERS.production.id);
  const first = await postRelease(env, production, packet.workPackageId, releaseBody(stopped));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await stop(env, packet, "stop-again-wp_stop_release_package");
  assert.equal(packageStatus(env, packet.workPackageId), "Blocked");
  assert.throws(replayStart, /work_package_stop_release_required/);
  assert.throws(() => attemptSupersession(env, packet), /work_package_stop_release_required/);

  // A record for another version does not unlock this one: version 1 is released and reissued,
  // then version 2 of the same package stops.
  const versions = testEnv();
  const v1 = await stoppedPackage(versions);
  const versionsProduction = await personAuth(versions, USERS.production.id);
  assert.equal(
    (await postRelease(versions, versionsProduction, v1.packet.workPackageId, releaseBody(v1))).status,
    200,
  );
  const v2 = definition({
    version: 2,
    deviceActionId: "issue-wp_stop_release_package-2",
    manifestKey: "work-packages/issue-wp_stop_release_package-2.json",
    releaseAttemptId: "attempt-wp_stop_release_package-2",
    issuedAt: at(60),
    releasedAt: at(60),
    supersedesId: v1.packet.workPackageId,
    supersedesVersion: 1,
    correctionReason: "The anchor layout was corrected after the stop.",
  });
  await issueNativeWorkPackage(versions, v2);
  assert.equal(packageStatus(versions, v1.packet.workPackageId, 1), "Superseded");
  await stop(versions, v2, "stop-wp_stop_release_package-2");
  assert.equal(packageStatus(versions, v2.workPackageId, 2), "Blocked");
  assert.throws(
    () => versions.DB.sqlite
      .prepare("UPDATE work_packages SET status = 'Released', updated_at = ? WHERE work_package_id = ? AND version = 2")
      .run(new Date().toISOString(), v2.workPackageId),
    /work_package_stop_release_required/,
  );
  assert.throws(() => attemptSupersession(versions, v2), /work_package_stop_release_required/);
  assert.equal(packageStatus(versions, v2.workPackageId, 2), "Blocked");
});

// --- Office reissue end to end -----------------------------------------------------------------

const OFFICE_JOB = "JOB-STOP-RELEASE-OFFICE";
const OFFICE_ASSIGNMENT_KEY = "stop-release-office-assignment-0001";
const OFFICE_ASSIGNMENT_ID = `assignment:${sha256(`${TENANT}:${sha256(OFFICE_ASSIGNMENT_KEY)}`).slice(0, 40)}`;
const officeWorkPackageId = (version: number) =>
  `wp_${sha256(`${TENANT}:${OFFICE_JOB}:${OFFICE_ASSIGNMENT_ID}:${version}`).slice(0, 32)}`;

async function seedOfficeAssignment(env: TestEnv) {
  const sqlite = env.DB.sqlite;
  const now = at(-5);
  sqlite
    .prepare(
      `INSERT INTO envelopes
        (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
         created_at, updated_at)
       VALUES ('ow_stop_release_office', 'manual', 'Synthetic Customer', 'customer@example.invalid',
               '{}', 'raw/stop-release/office.json', ?, 'reconciled', ?, ?)`,
    )
    .run(now, now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_leads
        (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
         contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES ('lead:stop-release:office', ?, 'ow_stop_release_office', 'raw/stop-release/office.json',
               'manual', 'Synthetic Customer', 'customer@example.invalid', 'qualified', 1, ?, ?)`,
    )
    .run(TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_customers
        (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name, contact_email,
         lifecycle_status, version, created_at, updated_at)
       VALUES ('customer:stop-release:office', ?, 'ow_stop_release_office',
               'raw/stop-release/office.json', 'Synthetic Customer', 'customer@example.invalid',
               'active', 1, ?, ?)`,
    )
    .run(TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_roof_jobs
        (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, source_raw_key, brand,
         job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES (?, ?, 'lead:stop-release:office', 'customer:stop-release:office',
               'ow_stop_release_office', 'raw/stop-release/office.json', 'ironwrap', 'IW-SR-1',
               'roof_replacement', 'qualified', 'ready', 1, ?, ?)`,
    )
    .run(OFFICE_JOB, TENANT, now, now);
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    sqlite
      .prepare(
        `INSERT INTO operating_production_gates
          (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key, gate, state,
           owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
         VALUES (?, ?, ?, 'ow_stop_release_office', 'raw/stop-release/office.json', ?, 'blocked', ?,
                 ?, ?, 'No active blocker', 1, ?, ?)`,
      )
      .run(`gate:stop-release:${gate.toLowerCase()}`, TENANT, OFFICE_JOB, gate, USERS.owner.id, now,
        at(24 * 60), now, now);
  }
  clearScheduleGatesInLedger(sqlite, {
    tenantId: TENANT,
    roofJobId: OFFICE_JOB,
    ownerUserId: USERS.owner.id,
    attesterUserId: USERS.production.id,
    attesterRole: "production",
  });
  sqlite
    .prepare(
      `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
       VALUES ('crew:stop-release:office', ?, 'Synthetic Crew', 'Active', 1, ?, ?)`,
    )
    .run(TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO fleet_crew_members
        (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES ('membership:stop-release:office', ?, 'crew:stop-release:office', ?, 1, 1, ?, ?)`,
    )
    .run(TENANT, USERS.crew.id, now, now);
  return (
    await recordOperatingJobAssignment(
      env,
      {
        tenantId: TENANT,
        roofJobId: OFFICE_JOB,
        expectedRoofJobVersion: 1,
        crewId: "crew:stop-release:office",
        expectedCrewVersion: 1,
        authorityRequirements: [
          {
            subject_type: "Person",
            subject_role: "Worker",
            subject_ref: USERS.crew.email,
            authority_kind: "Worker Competency",
            authority_scope: "field installation",
            scope_type: "Work Package",
            scope_ref: officeWorkPackageId(1),
            issuer_name: "IronWrap Production",
            issuer_jurisdiction: "AB-CA",
            issuer_reference: `internal:competency:${USERS.crew.id}`,
            source_version: "internal-competency-v1",
          },
        ],
        scheduledStart: at(0),
        actorUserId: USERS.owner.id,
        idempotencyKey: OFFICE_ASSIGNMENT_KEY,
      },
      new Date(BASE - 5 * 60_000),
    )
  ).assignment;
}

function officeIssueRequest(
  auth: AuthContext,
  assignment: { assignment_id: string; created_at: string },
  version: number,
  key: string,
): Request {
  const issuedAt = new Date().toISOString();
  return new Request(`https://app.example.invalid/api/v1/jobs/${OFFICE_JOB}/work-package`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": auth.csrfToken,
      "idempotency-key": key,
      "x-device-action-id": key,
    },
    body: JSON.stringify({
      assignment_id: assignment.assignment_id,
      assignment_modified: assignment.created_at,
      version,
      issued_at: issuedAt,
      expires_at: new Date(Date.parse(issuedAt) + 8 * 60 * 60 * 1_000).toISOString(),
      title: "Synthetic office package",
      objective: "Complete the synthetic roof scope safely",
      boundaries: "Only the issued synthetic scope",
      prerequisites: "Crew and materials are present",
      expected_result: "Installed roof is ready for review",
      stop_conditions: "Stop on unsafe anchors or weather",
      make_safe_procedure: "Secure the area and notify the office",
      correction_reason: version === 1 ? null : "The anchor layout was corrected after the stop.",
      steps: [
        {
          instruction: "Inspect the roof deck",
          required_evidence: "Deck photographs",
          acceptance_criteria: "Deck is sound",
        },
      ],
      hold_points: [
        {
          hold_point: "Pre-start safety release",
          release_phase: "Pre-start",
          release_authority: "IronWrap Production",
          required_evidence: "Safety inspection photographs",
          acceptance_criteria: "Safety is released",
        },
      ],
    }),
  });
}

function fieldAuth(): AuthContext {
  return {
    rawSessionToken: "",
    csrfToken: "field-csrf",
    permissions: permissionsForRole("field"),
    session: {
      session_hash: "9".repeat(64),
      session_created_at: new Date(Date.now() - 60_000).toISOString(),
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: "device-synthetic-crew",
      device_proof_hash: null,
      user_id: USERS.crew.id,
      tenant_id: TENANT,
      email_normalized: USERS.crew.email,
      display_name: USERS.crew.name,
      role: "field",
      frappe_user_id: USERS.crew.frappe,
      active: 1,
      created_by: USERS.owner.email,
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

test("office reissue of a stopped package is refused until a person releases the stop, then succeeds", async () => {
  const env = testEnv();
  const assignment = await seedOfficeAssignment(env);
  const owner = await personAuth(env, USERS.owner.id);
  const issued = await handleAuthenticatedRoute(
    officeIssueRequest(owner, assignment, 1, "stop-release-office-issue-1"),
    env,
    owner,
  );
  assert.equal(issued.status, 200, await issued.clone().text());
  const v1 = officeWorkPackageId(1);
  const { release_attempt_id: releaseAttemptId } = env.DB.sqlite
    .prepare("SELECT release_attempt_id FROM work_packages WHERE work_package_id = ?")
    .get(v1) as { release_attempt_id: string };

  const stopKey = "stop-release-office-field-stop";
  const stopped = await handleWorkPackageAction(
    new Request("https://app.example.invalid/api/v1/work-package-action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": stopKey,
        "x-device-action-id": stopKey,
      },
      body: JSON.stringify({
        device_action_id: stopKey,
        payload: {
          work_package_id: v1,
          work_package_version: 1,
          release_attempt_id: releaseAttemptId,
          blocker_reason: "Synthetic loose anchor",
        },
      }),
    }),
    env,
    fieldAuth(),
    OFFICE_JOB,
    { name: assignment.assignment_id },
    "stop_work",
  );
  assert.equal(stopped.status, 200, await stopped.clone().text());
  assert.equal(packageStatus(env, v1), "Blocked");

  const refused = await handleAuthenticatedRoute(
    officeIssueRequest(owner, assignment, 2, "stop-release-office-issue-2-before"),
    env,
    owner,
  );
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "work_package_stop_release_required" });
  assert.equal(
    (env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM work_package_supersessions").get() as { count: number }).count,
    0,
  );

  const evidence = evidenceId("office-fixed-anchor");
  insertCapture(env, {
    jobId: OFFICE_JOB,
    workPackageId: v1,
    releaseAttemptId,
    evidenceId: evidence,
    deviceActionId: "capture-office-fixed-anchor",
    capturedAt: await momentAfter(stopOccurredAt(env, stopEventIdFor(stopKey))),
  });
  const production = await personAuth(env, USERS.production.id);
  const release = await postRelease(env, production, v1, {
    work_package_version: 1,
    stop_event_id: stopEventIdFor(stopKey),
    reason: "The loose anchor was replaced and inspected before reissue.",
    evidence_ids: [evidence],
  }, { key: "stop-release-office-release" });
  assert.equal(release.status, 200, JSON.stringify(release.body));
  assert.equal(release.body.release.stop_reporter_user_id, USERS.crew.id);
  assert.equal(release.body.release.restored_status, "Released");
  assert.equal(packageStatus(env, v1), "Released");

  const reissued = await handleAuthenticatedRoute(
    officeIssueRequest(owner, assignment, 2, "stop-release-office-issue-2-after"),
    env,
    owner,
  );
  assert.equal(reissued.status, 200, await reissued.clone().text());
  assert.equal(((await reissued.json()) as { server_ref: string }).server_ref, officeWorkPackageId(2));
  assert.equal(packageStatus(env, v1), "Superseded");
  assert.equal(packageStatus(env, officeWorkPackageId(2), 2), "Released");
  assert.deepEqual(
    env.DB.sqlite
      .prepare(
        `SELECT prior_work_package_id, prior_work_package_version, replacement_work_package_version
           FROM work_package_supersessions`,
      )
      .all()
      .map((row) => ({ ...row })),
    [{ prior_work_package_id: v1, prior_work_package_version: 1, replacement_work_package_version: 2 }],
  );
});

// --- A4 (0159): a stop that applies to the job holds the next schedule ---------------------------

/** The next schedule revision of a packet's job, by the owner, for the crew it was scheduled to. */
function scheduleRevision(env: TestEnv, packet: NativeWorkPackageDefinition, key: string) {
  const suffix = sha256(`${packet.tenantId}:${packet.assignmentId}`).slice(0, 16);
  return recordOperatingJobAssignment(envFor(env, packet.tenantId), {
    tenantId: packet.tenantId,
    roofJobId: packet.jobId,
    expectedRoofJobVersion: 1,
    crewId: `crew:wp:${suffix}`,
    expectedCrewVersion: 1,
    authorityRequirements: packet.authorityRequirements,
    scheduledStart: at(24 * 60),
    supersedesAssignmentId: packet.assignmentId,
    correctionReason: "Synthetic schedule revision while a stop may hold the job.",
    actorUserId: USERS.owner.id,
    idempotencyKey: key,
  });
}

async function scheduleRefused(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

test("a crew's stop on a Work Package of the job holds the next schedule until a person releases it", async () => {
  const env = testEnv();
  const stopped = await stoppedPackage(env);
  const { packet } = stopped;
  await scheduleRefused(scheduleRevision(env, packet, "schedule-crew-stop-0001"), "operating_job_assignment_stop_active");
  const production = await personAuth(env, USERS.production.id);
  const released = await postRelease(env, production, packet.workPackageId, releaseBody(stopped), {
    key: "stop-release-schedule-0001",
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const revised = await scheduleRevision(env, packet, "schedule-crew-stop-0002");
  assert.equal(revised.kind, "created");
});

test("a safety stop on a Work Package of the job holds the next schedule", async () => {
  const env = testEnv();
  const packet = definition();
  await issue(env, packet);
  env.DB.sqlite.prepare(
    `INSERT INTO safety_occurrences
       (occurrence_id, tenant_id, occurrence_kind, severity, scope_type, scope_id,
        reported_by_user_id, reported_at, summary, report_fingerprint_sha256, created_at,
        updated_at)
     VALUES ('occurrence.wp.schedule', ?, 'hazard', 'high', 'work_package', ?, ?, ?,
             'Synthetic hazard report for repository proof only.', ?, ?, ?)`,
  ).run(TENANT, packet.workPackageId, USERS.crew.id, at(5), sha256("wp-schedule-stop"), at(5), at(5));
  await scheduleRefused(scheduleRevision(env, packet, "schedule-wp-stop-0001"), "operating_job_assignment_stop_active");
});
