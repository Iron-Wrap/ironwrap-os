import type { DatabaseSync } from "node:sqlite";

/** Synthetic stored field capture; exercises the real schema and all capture constraints. */
export function seedStopPhoto(
  db: DatabaseSync,
  input: {
    userId: string;
    tenantId?: string;
    jobId: string;
    evidenceId: string;
    actionId?: string;
    capturedAt: string;
    status?: string;
    manifested?: boolean;
    source?: string;
    contentType?: string;
    checksum?: string;
  },
): string {
  const actionId = input.actionId ?? `capture-${input.evidenceId}`;
  const row = {
    device_action_id: actionId,
    tenant_id: input.tenantId ?? "ironwrap",
    user_id: input.userId,
    job_id: input.jobId,
    assignment_id: `ASSIGN-${input.jobId}`,
    action_kind: "field_checkin",
    payload_hash: "a".repeat(64),
    status: input.status ?? "verified",
    checkin_id: `checkin_${actionId}`,
    manifest_key: input.manifested === false ? null : `evidence/${actionId}.json`,
    response_json: JSON.stringify({ status: "verified" }),
    created_at: input.capturedAt,
    updated_at: input.capturedAt,
    verified_at: input.capturedAt,
    work_package_id: `wp-${input.jobId}`,
    work_package_version: 1,
    evidence_slot_id: `step:${actionId}`,
    evidence_requirement: "Synthetic correction photograph",
    evidence_source: input.source ?? "photo",
    evidence_device_id: "device-synthetic-crew",
    evidence_freshness: "Current",
    evidence_conflict_state: "None",
    evidence_verification: "Verified",
    evidence_disposition: "Open",
    work_package_release_attempt_id: "attempt-synthetic",
    work_object_type: "Roof Job",
    work_object_id: input.jobId,
    physical_context_type: "Roof Site",
    physical_context_id: input.jobId,
    capture_started_at: new Date(Date.parse(input.capturedAt) - 1000).toISOString(),
    capture_completed_at: input.capturedAt,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO field_actions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(row));
  db.prepare(`INSERT INTO field_action_media
    (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
     content_length, r2_stored_at) VALUES (?, ?, ?, ?, ?, ?, 128, ?)`)
    .run(actionId, `attachment-${actionId}`, input.evidenceId, `evidence/raw/${actionId}`,
      input.checksum ?? "b".repeat(64), input.contentType ?? "image/jpeg", input.capturedAt);
  return input.evidenceId;
}
