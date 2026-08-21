import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  issueNativeWorkPackage,
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
  return {
    tenantId: "ironwrap",
    workPackageId: "wp_native_iro195",
    version: 1,
    deviceActionId: "issue-native-195-1",
    manifestKey: "work-packages/issue-native-195-1.json",
    jobId: "JOB-NATIVE-195",
    assignmentId: "ASSIGN-NATIVE-195",
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
  const ack = await nativeWorkPackageAction(env, ackInput);
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
  assert.deepEqual(await nativeWorkPackageAction(env, ackInput), ack);
  const acknowledged = await nativeWorkPackageForAssignment(env, packet.tenantId, packet.jobId, packet.assignmentId);
  assert.equal(acknowledged?.document.status, "Acknowledged");
  assert.equal(acknowledged?.acknowledgements.length, 1);
  assert.equal(acknowledged?.holdReleases.length, 1);

  const started = await nativeWorkPackageAction(env, {
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
  const stopped = await nativeWorkPackageAction(env, {
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
      nativeWorkPackageAction(env, {
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
  await nativeWorkPackageAction(env, {
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
  await nativeWorkPackageAction(env, {
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
      nativeWorkPackageAction(env, {
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
  const complete = await nativeWorkPackageAction(env, {
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
