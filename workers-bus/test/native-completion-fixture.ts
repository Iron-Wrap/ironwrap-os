// native-completion-fixture.ts - a roof job's finished work, written into the real tables.
//
// The final-invoice producer reads a job's current assignment, its completed Work Package, the
// package's events and the verified evidence captured for each slot. Those rows are made by the
// native Work Package store (issue, hold release, acknowledgement, start, capture, review,
// completion), whose own suite proves that path end to end. A case that needs a finished job on a
// database built from every migration writes the rows straight into those tables instead: the
// guards on them are lifted for this write and restored exactly as they were, in their creation
// order, the way production-gate-ledger-fixture.ts records legacy gates. Columns, CHECKs and
// foreign keys still apply. No product path does this.

import type { DatabaseSync } from "node:sqlite";

const COMPLETION_TABLES = [
  "operating_job_assignments",
  "work_packages",
  "work_package_events",
  "field_actions",
] as const;

export interface CompletedRoofJobWork {
  assignmentId: string;
  workPackageId: string;
  completedAt: string;
}

export function recordCompletedRoofJobWork(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    /** An active owner, ops or production user who made the assignment. */
    assignedByUserId: string;
    /** Minutes before now the work completed; issue, captures and reviews come before it. */
    completedMinutesAgo?: number;
  },
): CompletedRoofJobWork {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const done = input.completedMinutesAgo ?? 30;
  const issuedAt = at(done + 120);
  const completedAt = at(done);
  const suffix = input.roofJobId.replace(/[^A-Za-z0-9]/g, "").slice(-12);
  const assignmentId = `assignment-fixture-${suffix}`;
  const workPackageId = `wp_fixture_${suffix}`;
  const releaseAttemptId = `release-fixture-${suffix}`;
  const crewId = `crew:fixture:${suffix}`;
  const workerUserId = `appu_fixture_crew_${suffix}`;
  const workerEmail = `crew-${suffix}@example.invalid`;
  const job = db.prepare(
    "SELECT version FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?",
  ).get(input.tenantId, input.roofJobId) as { version: number };
  const scope = {
    job_id: input.roofJobId,
    assignment_id: assignmentId,
    work_object_type: "Roof Job",
    work_object_id: input.roofJobId,
    physical_context_type: "Roof Site",
    physical_context_id: input.roofJobId,
  };
  const definition = {
    tenant_id: input.tenantId,
    work_package_id: workPackageId,
    version: 1,
    ...scope,
    title: "Install the approved roof",
    objective: "Complete the roofing scope safely",
    boundaries: "Only the accepted roof scope",
    prerequisites: "Crew, materials and access are ready",
    expected_result: "The installed roof is ready for review",
    stop_conditions: "Stop on unsafe conditions",
    make_safe_procedure: "Secure the area and notify the office",
    issued_at: issuedAt,
    expires_at: at(done - 24 * 60),
    released_at: issuedAt,
    release_attempt_id: releaseAttemptId,
    supersedes_id: null,
    correction_reason: null,
    steps: [{ sequence: 1, instruction: "Install the roof", required_evidence: "installed roof photo" }],
    hold_points: [{ sequence: 1, hold_point: "Pre-start safety release", release_phase: "Pre-start" }],
    assigned_workers: [{ sequence: 1, worker_user: workerEmail, required: true }],
  };
  const captures = [
    { slot: "hold:1", evidenceId: `evi_${"1".repeat(32)}`, eventId: `wpe_${"1".repeat(32)}`, minutesAgo: done + 100 },
    { slot: "step:1", evidenceId: `evi_${"2".repeat(32)}`, eventId: `wpe_${"2".repeat(32)}`, minutesAgo: done + 40 },
  ];

  const guards = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (${COMPLETION_TABLES.map(() => "?").join(", ")})
      ORDER BY rowid`,
  ).all(...COMPLETION_TABLES) as Array<{ name: string; sql: string }>;
  for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
  try {
    db.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Fixture Crew', 'field', 'field', ?, 1, 'test-seed', ?, ?)`,
    ).run(workerUserId, input.tenantId, workerEmail, workerEmail, issuedAt, issuedAt);
    db.prepare(
      `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
       VALUES (?, ?, 'Fixture Crew', 'Active', 1, ?, ?)`,
    ).run(crewId, input.tenantId, issuedAt, issuedAt);
    db.prepare(
      `INSERT INTO operating_job_assignments
         (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
          crew_version, assigned_users_json, scheduled_start, scheduled_end, supersedes_assignment_id,
          correction_reason, actor_user_id, command_fingerprint, idempotency_key_hash, created_at)
       VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      assignmentId, input.tenantId, input.roofJobId, job.version, crewId, JSON.stringify([workerUserId]),
      issuedAt, completedAt, input.assignedByUserId, "a".repeat(64), "b".repeat(64), issuedAt,
    );
    db.prepare(
      `INSERT INTO work_packages
         (work_package_id, tenant_id, version, job_id, assignment_id, work_object_type,
          work_object_id, physical_context_type, physical_context_id, status, title, objective,
          boundaries, prerequisites, expected_result, stop_conditions, make_safe_procedure,
          definition_json, issued_at, expires_at, released_at, release_attempt_id, completed_at,
          created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 'Roof Job', ?, 'Roof Site', ?, 'Completed', ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?)`,
    ).run(
      workPackageId, input.tenantId, input.roofJobId, assignmentId, input.roofJobId, input.roofJobId,
      definition.title, definition.objective, definition.boundaries, definition.prerequisites,
      definition.expected_result, definition.stop_conditions, definition.make_safe_procedure,
      JSON.stringify(definition), issuedAt, definition.expires_at, issuedAt, releaseAttemptId,
      completedAt, issuedAt, completedAt,
    );
    const event = db.prepare(
      `INSERT INTO work_package_events
         (event_id, tenant_id, work_package_id, work_package_version, job_id, assignment_id,
          work_object_type, work_object_id, physical_context_type, physical_context_id,
          release_attempt_id, event_kind, actor_user_id, actor_role, occurred_at, payload_json,
          created_at)
       VALUES (?, ?, ?, 1, ?, ?, 'Roof Job', ?, 'Roof Site', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const append = (eventId: string, kind: string, actor: string, role: string, occurredAt: string, payload: unknown) =>
      event.run(
        eventId, input.tenantId, workPackageId, input.roofJobId, assignmentId, input.roofJobId,
        input.roofJobId, releaseAttemptId, kind, actor, role, occurredAt, JSON.stringify(payload), occurredAt,
      );
    append(`wpe_issued_${suffix}`, "issued", input.assignedByUserId, "owner", issuedAt, {});
    for (const capture of captures) {
      const capturedAt = at(capture.minutesAgo);
      db.prepare(
        `INSERT INTO field_actions
           (device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind, payload_hash,
            status, checkin_id, manifest_key, response_json, created_at, updated_at, verified_at,
            work_package_id, work_package_version, evidence_slot_id, evidence_requirement,
            evidence_source, evidence_device_id, evidence_freshness, evidence_conflict_state,
            evidence_verification, evidence_disposition, work_package_release_attempt_id,
            work_object_type, work_object_id, physical_context_type, physical_context_id,
            capture_started_at, capture_completed_at)
         VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, 'verified', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'photo',
                 ?, 'Current', 'None', 'Verified', 'Open', ?, 'Roof Job', ?, 'Roof Site', ?, ?, ?)`,
      ).run(
        `capture-${capture.slot.replace(":", "-")}-${suffix}`, input.tenantId, workerUserId, input.roofJobId,
        assignmentId, "c".repeat(64), `checkin-${capture.slot.replace(":", "-")}-${suffix}`,
        `evidence/${capture.evidenceId}/manifest.json`, JSON.stringify({ status: "verified" }), capturedAt,
        capturedAt, capturedAt, workPackageId, capture.slot, "roof evidence", `device-${suffix}`,
        releaseAttemptId, input.roofJobId, input.roofJobId, capturedAt, capturedAt,
      );
      db.prepare(
        `INSERT INTO field_action_media
           (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
            content_length, r2_stored_at)
         VALUES (?, ?, ?, ?, ?, 'image/jpeg', 1, ?)`,
      ).run(
        `capture-${capture.slot.replace(":", "-")}-${suffix}`, `attachment-${capture.slot.replace(":", "-")}`,
        capture.evidenceId, `evidence/${capture.evidenceId}/raw.jpg`, "d".repeat(64), capturedAt,
      );
      append(`wpe_review_${capture.slot.replace(":", "_")}_${suffix}`, "evidence_reviewed", input.assignedByUserId, "owner",
        at(capture.minutesAgo - 5), {
          target_event_id: capture.eventId,
          evidence_item: capture.evidenceId,
          evidence_slot_id: capture.slot,
          disposition: "Accepted",
        });
      if (capture.slot === "hold:1") {
        append(`wpe_hold_${suffix}`, "hold_released", input.assignedByUserId, "production", at(capture.minutesAgo - 10), {
          hold_point_sequence: 1,
          evidence_item: capture.evidenceId,
        });
      }
    }
    append(`wpe_complete_${suffix}`, "complete_work", input.assignedByUserId, "owner", completedAt, {});
  } finally {
    for (const guard of guards) db.exec(guard.sql);
  }
  return { assignmentId, workPackageId, completedAt };
}
