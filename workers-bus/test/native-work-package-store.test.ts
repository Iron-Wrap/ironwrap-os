import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  authorityCurrentPrecondition,
  recordAuthorityReadback,
  type AuthorityCurrentPrecondition,
} from "../src/authority-records.ts";
import {
  issueNativeWorkPackage as issueNativeWorkPackageStore,
  nativeAssignmentForWorkObject,
  nativeWorkPackageAction,
  nativeWorkPackageForAssignment,
  reconcileNativeWorkPackageActions,
  reviewNativeWorkPackageEvidence,
  releaseNativeWorkPackageHold,
  type NativeWorkPackageDefinition,
} from "../src/work-package-store.ts";

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  private eventInsertBarrier: { deviceActionId: string; arrivals: number; wait: Promise<void>; release: () => void } | null = null;

  pauseConcurrentEventInserts(deviceActionId: string) {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.eventInsertBarrier = { deviceActionId, arrivals: 0, wait, release };
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    const database = this;
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            return { results: sqlite.prepare(sql).all(...values) as T[] };
          },
          first<T>() {
            return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
          },
          run() {
            const execute = () => {
              const result = sqlite.prepare(sql).run(...values);
              return { meta: { changes: Number(result.changes) } };
            };
            const barrier = database.eventInsertBarrier;
            if (barrier && /INSERT INTO work_package_events/.test(sql) && values[14] === barrier.deviceActionId) {
              barrier.arrivals += 1;
              if (barrier.arrivals === 2) {
                database.eventInsertBarrier = null;
                barrier.release();
              }
              return barrier.wait.then(execute);
            }
            return execute();
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

const packetAuthorityPreconditions = new WeakMap<
  TestD1,
  Map<string, AuthorityCurrentPrecondition[]>
>();

test("concurrent evidence-review replay rejects correction rationale drift", async () => {
  const env = await testEnv();
  const packet = definition();
  await issueNativeWorkPackage(env, packet);
  insertCapture(env, packet, "step:1", "evi_native_race", "capture-native-race");
  const input = {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "owner@example.com",
    actorRole: "owner",
    deviceActionId: "review-native-race",
    evidenceEventId: "wpe_evi_native_race",
    evidenceItem: "evi_native_race",
    evidenceSlotId: "step:1",
    disposition: "Needs Correction",
    correctionReason: "Retake the deck photo",
    releaseAttemptId: packet.releaseAttemptId,
    ...scope(),
  } as const;
  env.DB.pauseConcurrentEventInserts(input.deviceActionId);
  const results = await Promise.allSettled([
    reviewNativeWorkPackageEvidence(env, input),
    reviewNativeWorkPackageEvidence(env, { ...input, correctionReason: "Use a wider angle" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /work_package_device_action_conflict/);
});

async function testEnv() {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of names) {
    DB.sqlite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, active,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_owner_native",
      "ironwrap",
      "owner@example.com",
      "Native Owner",
      "owner",
      "owner",
      "owner@example.com",
      "2026-08-20T08:00:00.000Z",
      "2026-08-20T08:00:00.000Z",
    );
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_crew_native",
      "ironwrap",
      "crew@example.com",
      "Native Crew",
      "field",
      "field",
      "crew@example.com",
      "owner@example.com",
      "2026-08-20T08:00:00.000Z",
      "2026-08-20T08:00:00.000Z",
    );
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, active,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_production_native",
      "ironwrap",
      "production@example.com",
      "Native Production",
      "ops",
      "production",
      "owner@example.com",
      "2026-08-20T08:00:00.000Z",
      "2026-08-20T08:00:00.000Z",
    );
  return { APP_TENANT_ID: "ironwrap", DB } as any;
}

function definition(): NativeWorkPackageDefinition {
  const authorityRequirements = [
    {
      subject_type: "Person" as const,
      subject_role: "Worker" as const,
      subject_ref: "crew@example.com",
      authority_kind: "Worker Competency" as const,
      authority_scope: "field installation",
      scope_type: "Work Package" as const,
      scope_ref: "wp_native_iro195",
      issuer_name: "IronWrap Production",
      issuer_jurisdiction: "AB-CA",
      issuer_reference: "internal:competency:crew@example.com",
      source_version: "2026-08-20",
    },
  ];
  return {
    tenantId: "ironwrap",
    workPackageId: "wp_native_iro195",
    version: 1,
    deviceActionId: "issue-native-195-1",
    manifestKey: "work-packages/issue-native-195-1.json",
    jobId: "JOB-NATIVE-195",
    assignmentId: "ASSIGN-NATIVE-195",
    assignmentVersion: 1,
    assignmentCommandFingerprint: "a".repeat(64),
    assignmentAuthorityRequirementsSha256: canonicalSha256(
      authorityRequirements,
    ),
    issueRequestSha256: "b".repeat(64),
    workObjectType: "Roof Job",
    workObjectId: "JOB-NATIVE-195",
    physicalContextType: "Roof Site",
    physicalContextId: "JOB-NATIVE-195",
    assignmentAuthorityUser: "owner@example.com",
    assignmentAuthorityRole: "IronWrap Owner",
    title: "Native work package",
    objective: "Complete the roof work safely",
    boundaries: "Only the issued roof scope",
    prerequisites: "Crew and materials are present",
    expectedResult: "Installed roof is ready for review",
    stopConditions: "Stop on unsafe conditions",
    makeSafeProcedure: "Secure the area and notify the owner",
    issuedAt: "2026-08-20T08:00:00.000Z",
    expiresAt: "2026-08-21T08:00:00.000Z",
    releasedAt: "2026-08-20T08:00:00.000Z",
    releaseAttemptId: "attempt-native-195",
    authorityRequirements,
    steps: [
      {
        sequence: 1,
        instruction: "Inspect the roof deck",
        requiredEvidence: "step evidence",
        acceptanceCriteria: "Deck is safe",
      },
    ],
    holdPoints: [
      {
        sequence: 1,
        holdPoint: "Pre-start safety release",
        releasePhase: "Pre-start",
        releaseAuthority: "IronWrap Production",
        requiredEvidence: "hold evidence",
        acceptanceCriteria: "Safety is released",
      },
    ],
    assignedWorkers: [
      {
        sequence: 1,
        workerUser: "crew@example.com",
        workerRole: "Installer",
        required: true,
      },
    ],
    issuedByUser: "owner@example.com",
    issuedByRole: "IronWrap Owner",
  };
}

async function issueNativeWorkPackage(
  env: any,
  packet: NativeWorkPackageDefinition,
) {
  seedAssignmentSnapshot(env, packet);
  const issued = await issueNativeWorkPackageStore(env, packet);
  await seedPacketAuthority(env, packet);
  return issued;
}

async function seedPacketAuthority(
  env: any,
  packet: NativeWorkPackageDefinition,
): Promise<void> {
  const preconditions: AuthorityCurrentPrecondition[] = [];
  for (const [index, requirement] of packet.authorityRequirements.entries()) {
    const identity = createHash("sha256")
      .update(
        `${packet.tenantId}:${packet.workPackageId}:${canonicalJson(requirement)}`,
      )
      .digest("hex")
      .slice(0, 24);
    const readback = await recordAuthorityReadback(env, {
      readbackId: `Authority-Readback-${identity}`,
      tenantId: packet.tenantId,
      authorityRecordId: `Authority-Record-${identity}`,
      authorityVersion: 1,
      subjectType: requirement.subject_type,
      subjectRole: requirement.subject_role ?? "Worker",
      personUser:
        requirement.subject_type === "Person" ? requirement.subject_ref : null,
      organization:
        requirement.subject_type === "Organization"
          ? requirement.subject_ref
          : null,
      authorityKind: requirement.authority_kind,
      authorityScope: requirement.authority_scope ?? "field installation",
      scopeType: requirement.scope_type,
      scopeRef: requirement.scope_ref,
      roofJob: packet.jobId,
      scopeJson: "{}",
      issuerName: requirement.issuer_name ?? "IronWrap Production",
      issuerJurisdiction: requirement.issuer_jurisdiction ?? "AB-CA",
      issuerReference:
        requirement.issuer_reference ?? `internal:authority:${identity}`,
      issuerSourceVersion: requirement.source_version ?? "2026-08-20",
      verificationState: "verified",
      evidenceRefsJson: JSON.stringify([
        {
          ref: `r2://authority/${identity}.json`,
          sha256: createHash("sha256")
            .update(`evidence:${identity}`)
            .digest("hex"),
        },
      ]),
      evidenceSha256: createHash("sha256")
        .update(`evidence:${identity}`)
        .digest("hex"),
      authorityStateDigestSha256: createHash("sha256")
        .update(`state:${identity}:${index}`)
        .digest("hex"),
      authorityEffectiveFrom: "2026-08-01",
      authorityExpiresAt: "2027-12-31",
      authorityRevokedAt: null,
      supersedesAuthorityRecordId: null,
      authorityVerificationMethod: "Internal Competency Assessment",
      issuerReceiptSha256: null,
      observedByUserId: "appu_owner_native",
      observedAt: packet.issuedAt,
      actionId: null,
    });
    preconditions.push(
      authorityCurrentPrecondition(requirement, readback.readback),
    );
  }
  const byPackage = packetAuthorityPreconditions.get(env.DB) ?? new Map();
  byPackage.set(packet.workPackageId, preconditions);
  packetAuthorityPreconditions.set(env.DB, byPackage);
}

function nativeAction(
  env: any,
  packet: NativeWorkPackageDefinition,
  input: Parameters<typeof nativeWorkPackageAction>[1],
) {
  return nativeWorkPackageAction(env, {
    ...input,
    ...(input.kind === "stop_work"
      ? {}
      : {
          authorityPreconditions:
            packetAuthorityPreconditions
              .get(env.DB)
              ?.get(packet.workPackageId) ?? [],
        }),
  });
}

function seedAssignmentSnapshot(
  env: any,
  packet: NativeWorkPackageDefinition,
): void {
  const sqlite = env.DB.sqlite as DatabaseSync;
  const existing = sqlite
    .prepare(
      "SELECT assignment_id FROM operating_job_assignments WHERE tenant_id = ? AND assignment_id = ?",
    )
    .get(packet.tenantId, packet.assignmentId);
  if (existing) return;
  const suffix = createHash("sha256")
    .update(`${packet.tenantId}:${packet.assignmentId}`)
    .digest("hex")
    .slice(0, 16);
  const now = packet.issuedAt;
  const envelopeId = `ow_wp_${suffix}`;
  const leadId = `lead:wp:${suffix}`;
  const customerId = `customer:wp:${suffix}`;
  const crewId = `crew:wp:${suffix}`;
  const rawKey = `raw/work-package/${suffix}.json`;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key,
        ts, status, created_at, updated_at)
     VALUES (?, 'manual', 'Work Package Customer', 'wp@example.invalid', '{}', ?,
             ?, 'reconciled', ?, ?)`,
    )
    .run(envelopeId, rawKey, now, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source,
        contact_name, contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', 'Work Package Customer', 'wp@example.invalid',
             'qualified', 1, ?, ?)`,
    )
    .run(leadId, packet.tenantId, envelopeId, rawKey, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
        contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Work Package Customer', 'wp@example.invalid',
             'active', 1, ?, ?)`,
    )
    .run(customerId, packet.tenantId, envelopeId, rawKey, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id,
        source_raw_key, brand, job_number, service_type, job_status,
        current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified',
             'ready', 1, ?, ?)`,
    )
    .run(
      packet.jobId,
      packet.tenantId,
      leadId,
      customerId,
      envelopeId,
      rawKey,
      `IW-${suffix.slice(0, 8)}`,
      now,
      now,
    );
  for (const gate of [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ]) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key,
          gate, state, owner_user, assigned_at, due_at, blocker_reason, version,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', 'appu_owner_native', ?, ?,
               'No active blocker', 1, ?, ?)`,
      )
      .run(
        `gate:wp:${suffix}:${gate.toLowerCase()}`,
        packet.tenantId,
        packet.jobId,
        envelopeId,
        rawKey,
        gate,
        now,
        packet.expiresAt,
        now,
        now,
      );
  }
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO fleet_crews
       (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES (?, ?, 'Work Package Crew', 'Active', 1, ?, ?)`,
    )
    .run(crewId, packet.tenantId, now, now);
  const workerIds = packet.assignedWorkers.map((worker) =>
    worker.workerUser === "crew@example.com"
      ? "appu_crew_native"
      : worker.workerUser === "crew-b@example.com"
        ? "appu_crew_native_b"
        : worker.workerUser,
  );
  for (const [index, workerId] of workerIds.entries()) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO fleet_crew_members
         (membership_id, tenant_id, crew_id, user_id, active, version,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(
        `membership:wp:${suffix}:${index + 1}`,
        packet.tenantId,
        crewId,
        workerId,
        now,
        now,
      );
  }
  sqlite
    .prepare(
      `INSERT INTO operating_job_assignments
       (assignment_id, tenant_id, roof_job_id, assignment_version,
        roof_job_version, crew_id, crew_version, assigned_users_json,
        scheduled_start, scheduled_end, supersedes_assignment_id,
        correction_reason, actor_user_id, command_fingerprint,
        idempotency_key_hash, created_at, authority_requirements_json,
        authority_requirements_sha256)
     VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, NULL, NULL, 'appu_owner_native',
             ?, ?, ?, ?, ?)`,
    )
    .run(
      packet.assignmentId,
      packet.tenantId,
      packet.jobId,
      packet.assignmentVersion,
      crewId,
      JSON.stringify(workerIds),
      packet.issuedAt,
      packet.expiresAt,
      packet.assignmentCommandFingerprint,
      createHash("sha256").update(packet.assignmentId).digest("hex"),
      packet.issuedAt,
      canonicalJson(packet.authorityRequirements),
      packet.assignmentAuthorityRequirementsSha256,
    );
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function insertCapture(
  env: any,
  packet: NativeWorkPackageDefinition,
  slotId: string,
  evidenceId: string,
  deviceActionId: string,
  correctionOf: string | null = null,
  itemCorrectionOf: string | null = null,
  correctionReason: string | null = null,
) {
  const sqlite = env.DB.sqlite as DatabaseSync;
  const now = "2026-08-20T09:00:00.000Z";
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
     ) VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deviceActionId,
      packet.tenantId,
      "appu_crew_native",
      packet.jobId,
      packet.assignmentId,
      "a".repeat(64),
      `checkin_${deviceActionId}`,
      `evidence/${evidenceId}`,
      JSON.stringify({ status: "verified" }),
      now,
      now,
      now,
      packet.workPackageId,
      packet.version,
      slotId,
      slotId === "step:1" ? packet.steps[0]!.requiredEvidence : packet.holdPoints[0]!.requiredEvidence,
      "photo",
      "device-native-195",
      "Current",
      "None",
      "Verified",
      "Open",
      correctionOf,
      itemCorrectionOf,
      packet.releaseAttemptId,
      correctionReason,
      packet.workObjectType,
      packet.workObjectId,
      packet.physicalContextType,
      packet.physicalContextId,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO field_action_media (
       device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256,
       content_type, content_length, r2_stored_at
     ) VALUES (?, ?, ?, ?, ?, 'image/jpeg', 1, ?)`,
    )
    .run(deviceActionId, `attachment_${deviceActionId}`, evidenceId, `evidence/${evidenceId}/raw`, "b".repeat(64), now);
}

function scope() {
  return {
    releaseAttemptId: "attempt-native-195",
    workObjectType: "Roof Job",
    workObjectId: "JOB-NATIVE-195",
    physicalContextType: "Roof Site",
    physicalContextId: "JOB-NATIVE-195",
    manifestKey: "work-packages/native-action-195.json",
  };
}

function insertCommandReceipt(env: any, packet: NativeWorkPackageDefinition, kind: string, deviceActionId: string) {
  (env.DB.sqlite as DatabaseSync).prepare(
    `INSERT INTO field_work_package_actions (
       device_action_id, tenant_id, user_id, job_id, assignment_id,
       work_package_id, action_kind, payload_hash, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
  ).run(
    deviceActionId,
    packet.tenantId,
    "appu_crew_native",
    packet.jobId,
    packet.assignmentId,
    packet.workPackageId,
    kind,
    "c".repeat(64),
    packet.issuedAt,
    packet.issuedAt,
  );
}

test("native Work Package issues, reads, releases, acknowledges, starts, and stops without Frappe", async () => {
  const env = await testEnv();
  const packet = definition();
  const issued = await issueNativeWorkPackage(env, packet);
  assert.equal(issued.document.status, "Released");
  assert.deepEqual(
    JSON.parse(String(issued.document.authority_requirements_json)),
    packet.authorityRequirements,
  );
  assert.deepEqual(issued.document.assigned_workers, [
    {
      sequence: 1,
      worker_user: "appu_crew_native",
      worker_role: "Installer",
      required: true,
    },
  ]);
  assert.equal(issued.document.hold_points[0]?.release_phase, "Pre-start");
  assert.equal(issued.holdReleases.length, 0);
  assert.equal(issued.acknowledgements.length, 0);
  const driftedRequirements = packet.authorityRequirements.map(
    (requirement) => ({ ...requirement, issuer_jurisdiction: "BC-CA" }),
  );
  await assert.rejects(
    () =>
      issueNativeWorkPackage(env, {
        ...packet,
        authorityRequirements: driftedRequirements,
        assignmentAuthorityRequirementsSha256:
          canonicalSha256(driftedRequirements),
      }),
    /work_package_device_action_conflict/,
  );
  insertCapture(
    env,
    packet,
    "hold:1",
    "evi_native_hold_195",
    "capture-native-hold-release",
  );

  const hold = await releaseNativeWorkPackageHold(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "production@example.com",
    actorRole: "production",
    deviceActionId: "hold-native-195-1",
    holdPointSequence: 1,
    evidenceItem: "evi_native_hold_195",
    ...scope(),
  });
  assert.equal(hold.workPackageName, packet.workPackageId);
  const holdReplay = await releaseNativeWorkPackageHold(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "production@example.com",
    actorRole: "production",
    deviceActionId: "hold-native-195-1",
    holdPointSequence: 1,
    evidenceItem: "evi_native_hold_195",
    ...scope(),
  });
  assert.deepEqual(holdReplay, hold);

  const ackInput = {
    kind: "acknowledge" as const,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "crew@example.com",
    actorRole: "field",
    deviceActionId: "ack-native-195-1",
    blockerReason: null,
    ...scope(),
  };
  insertCommandReceipt(env, packet, "acknowledge", ackInput.deviceActionId);
  const ack = await nativeAction(env, packet, ackInput);
  assert.equal(ack.workPackageName, packet.workPackageId);
  assert.equal(await reconcileNativeWorkPackageActions(env, packet.tenantId), 1);
  const boundReceipt = await env.DB.prepare(
    "SELECT status, event_id, work_package_version FROM field_work_package_actions WHERE device_action_id = ?",
  ).bind(ackInput.deviceActionId).first<{ status: string; event_id: string; work_package_version: number }>();
  assert.equal(boundReceipt?.status, "verified");
  assert.equal(boundReceipt?.event_id, ack.eventName);
  assert.equal(boundReceipt?.work_package_version, packet.version);
  assert.throws(
    () =>
      env.DB.prepare(
        "UPDATE field_work_package_actions SET physical_context_id = 'OTHER-SITE' WHERE device_action_id = ?",
      )
        .bind(ackInput.deviceActionId)
        .run(),
    /work_package_action_binding_immutable/,
  );
  assert.equal(await reconcileNativeWorkPackageActions(env, packet.tenantId), 0);
  assert.deepEqual(await nativeAction(env, packet, ackInput), ack);
  const acknowledged = await nativeWorkPackageForAssignment(env, packet.tenantId, packet.jobId, packet.assignmentId);
  assert.equal(acknowledged?.document.status, "Acknowledged");
  assert.equal(acknowledged?.acknowledgements.length, 1);
  assert.equal(acknowledged?.holdReleases.length, 1);

  const started = await nativeAction(env, packet, {
    ...ackInput,
    kind: "start_work",
    deviceActionId: "start-native-195-1",
  });
  assert.equal(started.workPackageName, packet.workPackageId);
  const assignment = await nativeAssignmentForWorkObject(env, packet.tenantId, packet.jobId, {
    workObjectType: packet.workObjectType,
    workObjectId: packet.workObjectId,
    physicalContextType: packet.physicalContextType,
    physicalContextId: packet.physicalContextId,
  });
  assert.equal(assignment?.assignment_id, packet.assignmentId);
  assert.equal(assignment?.work_package_version, packet.version);
  const stopped = await nativeAction(env, packet, {
    ...ackInput,
    kind: "stop_work",
    deviceActionId: "stop-native-195-1",
    blockerReason: "Weather hold",
  });
  assert.equal(stopped.workPackageName, packet.workPackageId);
  const blocked = await env.DB.prepare("SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ?")
    .bind(packet.tenantId, packet.workPackageId)
    .first<{ status: string }>();
  assert.equal(blocked?.status, "Blocked");
  const blockedPacket = await nativeWorkPackageForAssignment(
    env,
    packet.tenantId,
    packet.jobId,
    packet.assignmentId,
  );
  assert.equal(blockedPacket?.document.status, "Blocked");
});

test("native Work Package issuance is atomic and rejects inactive or wrong-role participants", async () => {
  const atomicEnv = await testEnv();
  atomicEnv.DB.sqlite.exec(
    `CREATE TRIGGER test_reject_issued_event
       BEFORE INSERT ON work_package_events
       WHEN NEW.event_kind = 'issued'
       BEGIN SELECT RAISE(ABORT, 'test_issued_event_failure'); END;`,
  );
  await assert.rejects(() => issueNativeWorkPackage(atomicEnv, definition()), /test_issued_event_failure/);
  assert.equal(
    atomicEnv.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM work_packages").get().count,
    0,
  );

  const actorEnv = await testEnv();
  seedAssignmentSnapshot(actorEnv, definition());
  actorEnv.DB.sqlite
    .prepare("UPDATE app_users SET active = 0 WHERE user_id = 'appu_crew_native'")
    .run();
  await assert.rejects(
    () => issueNativeWorkPackage(actorEnv, definition()),
    /work_package_actor_identity_invalid/,
  );
  actorEnv.DB.sqlite
    .prepare("UPDATE app_users SET active = 1, access_role = 'sales' WHERE user_id = 'appu_crew_native'")
    .run();
  await assert.rejects(
    () => issueNativeWorkPackage(actorEnv, definition()),
    /work_package_worker_authority_invalid/,
  );
});

test("native Work Package issue aborts atomically when the assignment snapshot is superseded", async () => {
  const env = await testEnv();
  const packet = definition();
  seedAssignmentSnapshot(env, packet);
  const sqlite = env.DB.sqlite as DatabaseSync;
  const current = sqlite
    .prepare(
      `SELECT crew_id, assigned_users_json, authority_requirements_json,
              authority_requirements_sha256
         FROM operating_job_assignments
        WHERE tenant_id = ? AND assignment_id = ?`,
    )
    .get(packet.tenantId, packet.assignmentId) as Record<string, string>;
  sqlite
    .prepare(
      `INSERT INTO operating_job_assignments
       (assignment_id, tenant_id, roof_job_id, assignment_version,
        roof_job_version, crew_id, crew_version, assigned_users_json,
        scheduled_start, scheduled_end, supersedes_assignment_id,
        correction_reason, actor_user_id, command_fingerprint,
        idempotency_key_hash, created_at, authority_requirements_json,
        authority_requirements_sha256)
     VALUES ('ASSIGN-NATIVE-195-V2', ?, ?, 2, 1, ?, 1, ?, ?, ?, ?,
             'Replace the frozen assignment before package issue.',
             'appu_owner_native', ?, ?, ?, ?, ?)`,
    )
    .run(
      packet.tenantId,
      packet.jobId,
      current.crew_id,
      current.assigned_users_json,
      "2026-08-21T09:00:00.000Z",
      "2026-08-22T09:00:00.000Z",
      packet.assignmentId,
      "c".repeat(64),
      "d".repeat(64),
      "2026-08-20T08:30:00.000Z",
      current.authority_requirements_json,
      current.authority_requirements_sha256,
    );

  await assert.rejects(
    () => issueNativeWorkPackageStore(env, packet),
    /work_package_assignment_snapshot_stale/,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM work_packages").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM work_package_events").get()
      .count,
    0,
  );
});

test("native Work Package assignment snapshot remains immutable after issuance", async () => {
  const env = await testEnv();
  const packet = definition();
  await issueNativeWorkPackage(env, packet);

  assert.throws(
    () =>
      env.DB.sqlite
        .prepare(
          `UPDATE work_packages
              SET assignment_authority_requirements_sha256 = ?
            WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
        )
        .run(
          "f".repeat(64),
          packet.tenantId,
          packet.workPackageId,
          packet.version,
        ),
    /work_package_definition_immutable/,
  );
  const stored = env.DB.sqlite
    .prepare(
      `SELECT assignment_version, assignment_command_fingerprint,
              assignment_authority_requirements_sha256
         FROM work_packages
        WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
    )
    .get(
      packet.tenantId,
      packet.workPackageId,
      packet.version,
    ) as Record<string, unknown>;
  assert.equal(stored.assignment_version, packet.assignmentVersion);
  assert.equal(
    stored.assignment_command_fingerprint,
    packet.assignmentCommandFingerprint,
  );
  assert.equal(
    stored.assignment_authority_requirements_sha256,
    packet.assignmentAuthorityRequirementsSha256,
  );
});

test("native Work Package supersession is one atomic append-only fact", async () => {
  const env = await testEnv();
  const first = definition();
  await issueNativeWorkPackage(env, first);
  const replacement: NativeWorkPackageDefinition = {
    ...first,
    workPackageId: "wp_native_iro195_v2",
    version: 2,
    deviceActionId: "issue-native-195-2",
    manifestKey: "work-packages/issue-native-195-2.json",
    releaseAttemptId: "attempt-native-195-v2",
    issuedAt: "2026-08-20T10:00:00.000Z",
    releasedAt: "2026-08-20T10:00:00.000Z",
    expiresAt: "2026-08-21T10:00:00.000Z",
    supersedesId: first.workPackageId,
    supersedesVersion: first.version,
    correctionReason: "Weather changed the safe installation sequence",
  };
  const issued = await issueNativeWorkPackage(env, replacement);
  assert.equal(issued.document.name, replacement.workPackageId);
  assert.equal(issued.document.status, "Released");
  assert.deepEqual(await issueNativeWorkPackage(env, replacement), issued);
  const prior = env.DB.sqlite
    .prepare(
      "SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ? AND version = ?",
    )
    .get(first.tenantId, first.workPackageId, first.version) as {
    status: string;
  };
  assert.equal(prior.status, "Superseded");
  const supersession = env.DB.sqlite
    .prepare(
      `SELECT prior_work_package_id, prior_work_package_version,
              replacement_work_package_id, replacement_work_package_version,
              command_sha256, manifest_key
         FROM work_package_supersessions`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...supersession },
    {
      prior_work_package_id: first.workPackageId,
      prior_work_package_version: first.version,
      replacement_work_package_id: replacement.workPackageId,
      replacement_work_package_version: replacement.version,
      command_sha256: (
        env.DB.sqlite
          .prepare(
            "SELECT json_extract(payload_json, '$.definition_sha256') AS hash FROM work_package_events WHERE device_action_id = ?",
          )
          .get(replacement.deviceActionId) as { hash: string }
      ).hash,
      manifest_key: replacement.manifestKey,
    },
  );
  assert.throws(
    () =>
      env.DB.sqlite
        .prepare(
          "UPDATE work_package_supersessions SET correction_reason = 'rewritten'",
        )
        .run(),
    /work_package_supersessions_append_only/,
  );
  assert.throws(
    () =>
      env.DB.sqlite
        .prepare(
          "UPDATE work_packages SET objective = 'rewritten' WHERE work_package_id = ?",
        )
        .run(replacement.workPackageId),
    /work_package_definition_immutable/,
  );
  await assert.rejects(
    () =>
      issueNativeWorkPackage(env, {
        ...replacement,
        deviceActionId: "issue-native-195-2-conflict",
      }),
    /work_package_definition_conflict/,
  );
});

test("native Work Package rejects scope confusion, unauthorized actors, and mutable event history", async () => {
  const env = await testEnv();
  const packet = definition();
  await issueNativeWorkPackage(env, packet);
  await assert.rejects(
    () =>
      releaseNativeWorkPackageHold(env, {
        tenantId: packet.tenantId,
        workPackageId: packet.workPackageId,
        workPackageVersion: packet.version,
        jobId: packet.jobId,
        assignmentId: packet.assignmentId,
        actorUser: "crew@example.com",
        actorRole: "field",
        deviceActionId: "hold-native-195-bad",
        holdPointSequence: 1,
        evidenceItem: "evi_native_hold_bad",
        ...scope(),
      }),
    /work_package_hold_release_authority_required/,
  );
  assert.throws(
    () =>
      env.DB.sqlite
        .prepare(
          `INSERT INTO work_package_events
            (event_id, tenant_id, work_package_id, work_package_version, job_id,
             assignment_id, work_object_type, work_object_id, physical_context_type,
             physical_context_id, release_attempt_id, event_kind, actor_user_id,
             actor_role, device_action_id, occurred_at, manifest_key, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold_released', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wpe_direct_owner_hold",
          packet.tenantId,
          packet.workPackageId,
          packet.version,
          packet.jobId,
          packet.assignmentId,
          packet.workObjectType,
          packet.workObjectId,
          packet.physicalContextType,
          packet.physicalContextId,
          packet.releaseAttemptId,
          "appu_owner_native",
          "IronWrap Owner",
          "direct-owner-hold",
          "2026-08-20T09:00:00.000Z",
          "work-packages/direct-owner-hold.json",
          JSON.stringify({
            hold_point_sequence: 1,
            evidence_item: "evi_direct_owner_hold",
          }),
          "2026-08-20T09:00:00.000Z",
        ),
    /work_package_hold_release_authority_required/,
  );
  await assert.rejects(
    () =>
      nativeAction(env, packet, {
        kind: "acknowledge",
        workPackageId: packet.workPackageId,
        workPackageVersion: packet.version,
        jobId: packet.jobId,
        assignmentId: packet.assignmentId,
        actorUser: "crew@example.com",
        actorRole: "field",
        deviceActionId: "ack-native-195-cross-scope",
        blockerReason: null,
        ...scope(),
        physicalContextId: "OTHER-SITE",
      }),
    /work_package_scope_conflict/,
  );
  assert.throws(() => env.DB.prepare("DELETE FROM work_package_events WHERE event_kind = 'issued'").bind().run(), /work_package_event_append_only/);
  assert.throws(
    () => env.DB.prepare("UPDATE work_package_events SET actor_user_id = 'attacker@example.com' WHERE event_kind = 'issued'").bind().run(),
    /work_package_event_append_only/,
  );
});

test("native Work Package reviews current D1 evidence and completes only after every slot is accepted", async () => {
  const env = await testEnv();
  const packet = definition();
  await issueNativeWorkPackage(env, packet);
  insertCapture(
    env,
    packet,
    "hold:1",
    "evi_native_hold_capture",
    "capture-native-hold",
  );
  await releaseNativeWorkPackageHold(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "production@example.com",
    actorRole: "production",
    deviceActionId: "hold-native-195-review",
    holdPointSequence: 1,
    evidenceItem: "evi_native_hold_capture",
    ...scope(),
  });
  await nativeAction(env, packet, {
    kind: "acknowledge",
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "crew@example.com",
    actorRole: "field",
    deviceActionId: "ack-native-195-review",
    blockerReason: null,
    ...scope(),
  });
  await nativeAction(env, packet, {
    kind: "start_work",
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "crew@example.com",
    actorRole: "field",
    deviceActionId: "start-native-195-review",
    blockerReason: null,
    ...scope(),
  });
  insertCapture(
    env,
    packet,
    "step:1",
    "evi_native_step_review",
    "capture-native-step",
  );
  const evidence = await nativeWorkPackageForAssignment(
    env,
    packet.tenantId,
    packet.jobId,
    packet.assignmentId,
  );
  assert.equal(
    evidence?.evidence.filter((row) => row.event_type === "Evidence Captured")
      .length,
    2,
  );
  const stepReviewInput = {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "owner@example.com",
    actorRole: "owner",
    deviceActionId: "review-native-step",
    evidenceEventId: "wpe_evi_native_step_review",
    evidenceItem: "evi_native_step_review",
    evidenceSlotId: "step:1",
    disposition: "Needs Correction",
    correctionReason: "Retake the deck photo",
    releaseAttemptId: packet.releaseAttemptId,
    ...scope(),
  } as const;
  const stepReview = await reviewNativeWorkPackageEvidence(env, stepReviewInput);
  assert.equal(stepReview.workPackageName, packet.workPackageId);
  await assert.rejects(
    () =>
      reviewNativeWorkPackageEvidence(env, {
        ...stepReviewInput,
        correctionReason: "Use a wider angle for the replacement photo",
      }),
    /work_package_device_action_conflict/,
  );
  const holdReview = await reviewNativeWorkPackageEvidence(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "owner@example.com",
    actorRole: "owner",
    deviceActionId: "review-native-hold",
    evidenceEventId: "wpe_evi_native_hold_capture",
    evidenceItem: "evi_native_hold_capture",
    evidenceSlotId: "hold:1",
    disposition: "Accepted",
    releaseAttemptId: packet.releaseAttemptId,
    ...scope(),
  });
  assert.equal(holdReview.workPackageName, packet.workPackageId);
  await assert.rejects(
    () =>
      nativeAction(env, packet, {
        kind: "complete_work",
        workPackageId: packet.workPackageId,
        workPackageVersion: packet.version,
        jobId: packet.jobId,
        assignmentId: packet.assignmentId,
        actorUser: "owner@example.com",
        actorRole: "owner",
        deviceActionId: "complete-native-195-before-correction",
        blockerReason: null,
        ...scope(),
      }),
    /work_package_completion_not_ready/,
  );
  insertCapture(
    env,
    packet,
    "step:1",
    "evi_native_step_corrected",
    "capture-native-step-corrected",
    "wpe_evi_native_step_review",
    "evi_native_step_review",
    "Retake the deck photo",
  );
  const correctedReview = await reviewNativeWorkPackageEvidence(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "owner@example.com",
    actorRole: "owner",
    deviceActionId: "review-native-step-corrected",
    evidenceEventId: "wpe_evi_native_step_corrected",
    evidenceItem: "evi_native_step_corrected",
    evidenceSlotId: "step:1",
    disposition: "Accepted",
    releaseAttemptId: packet.releaseAttemptId,
    ...scope(),
  });
  assert.equal(correctedReview.workPackageName, packet.workPackageId);
  const complete = await nativeAction(env, packet, {
    kind: "complete_work",
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "owner@example.com",
    actorRole: "owner",
    deviceActionId: "complete-native-195-review",
    blockerReason: null,
    ...scope(),
  });
  assert.equal(complete.workPackageName, packet.workPackageId);
  const completed = await env.DB.prepare("SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ?")
    .bind(packet.tenantId, packet.workPackageId)
    .first<{ status: string }>();
  assert.equal(completed?.status, "Completed");
});

test("two required workers each acknowledge before start, and the snapshot ledger keeps both", async () => {
  const env = await testEnv();
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_crew_native_b",
      "ironwrap",
      "crew-b@example.com",
      "Native Crew B",
      "field",
      "field",
      "crew-b@example.com",
      "owner@example.com",
      "2026-08-20T08:00:00.000Z",
      "2026-08-20T08:00:00.000Z",
    );
  const packet = {
    ...definition(),
    workPackageId: "wp_native_multi_ack",
    jobId: "JOB-NATIVE-MULTI",
    assignmentId: "ASSIGN-NATIVE-MULTI",
    workObjectId: "JOB-NATIVE-MULTI",
    physicalContextId: "JOB-NATIVE-MULTI",
    deviceActionId: "issue-native-multi-1",
    releaseAttemptId: "attempt-native-multi",
    assignedWorkers: [
      { sequence: 1, workerUser: "crew@example.com", workerRole: "Installer", required: true },
      { sequence: 2, workerUser: "crew-b@example.com", workerRole: "Spotter", required: true },
    ],
  };
  await issueNativeWorkPackage(env, packet);
  insertCapture(env, packet, "hold:1", "evi_native_multi_hold", "capture-native-multi-hold");
  await releaseNativeWorkPackageHold(env, {
    tenantId: packet.tenantId,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "production@example.com",
    actorRole: "production",
    deviceActionId: "hold-native-multi-1",
    holdPointSequence: 1,
    evidenceItem: "evi_native_multi_hold",
    releaseAttemptId: packet.releaseAttemptId,
    workObjectType: packet.workObjectType,
    workObjectId: packet.workObjectId,
    physicalContextType: packet.physicalContextType,
    physicalContextId: packet.physicalContextId,
    manifestKey: "work-packages/native-multi.json",
  });

  const ackA = {
    kind: "acknowledge" as const,
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "crew@example.com",
    actorRole: "field" as const,
    deviceActionId: "ack-native-multi-a",
    blockerReason: null,
    releaseAttemptId: packet.releaseAttemptId,
    workObjectType: packet.workObjectType,
    workObjectId: packet.workObjectId,
    physicalContextType: packet.physicalContextType,
    physicalContextId: packet.physicalContextId,
    manifestKey: "work-packages/native-multi.json",
  };
  insertCommandReceipt(env, packet, "acknowledge", ackA.deviceActionId);
  await nativeAction(env, packet, ackA);
  await assert.rejects(
    nativeAction(env, packet, {
      ...ackA,
      kind: "start_work",
      deviceActionId: "start-native-multi-too-soon",
    }),
    /work_package_event_transition_invalid|work_package_action_not_allowed/,
  );

  env.DB.sqlite.prepare(
    `INSERT INTO field_work_package_actions (
       device_action_id, tenant_id, user_id, job_id, assignment_id,
       work_package_id, action_kind, payload_hash, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
  ).run(
    "ack-native-multi-b",
    packet.tenantId,
    "appu_crew_native_b",
    packet.jobId,
    packet.assignmentId,
    packet.workPackageId,
    "acknowledge",
    "d".repeat(64),
    packet.issuedAt,
    packet.issuedAt,
  );
  await nativeAction(env, packet, {
    ...ackA,
    actorUser: "crew-b@example.com",
    deviceActionId: "ack-native-multi-b",
  });

  const snapshot = env.DB.sqlite
    .prepare(
      `SELECT actor_user_id FROM work_package_worker_acknowledgements
        WHERE tenant_id = ? AND work_package_id = ? ORDER BY actor_user_id`,
    )
    .all(packet.tenantId, packet.workPackageId) as Array<{ actor_user_id: string }>;
  assert.deepEqual(
    snapshot.map((row) => row.actor_user_id).sort(),
    ["appu_crew_native", "appu_crew_native_b"].sort(),
  );

  const started = await nativeAction(env, packet, {
    ...ackA,
    kind: "start_work",
    deviceActionId: "start-native-multi-1",
  });
  assert.equal(started.workPackageName, packet.workPackageId);
  const row = await env.DB.prepare(
    "SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ?",
  )
    .bind(packet.tenantId, packet.workPackageId)
    .first<{ status: string }>();
  assert.equal(row?.status, "In Progress");
});
