import type { EvidenceScope } from "../evidence/evidence-types";

export const outboxStates = [
  "saved_locally",
  "queued",
  "uploading",
  "verified",
  "needs_attention",
] as const;

export type OutboxState = (typeof outboxStates)[number];
export const outboxActionKinds = [
  "field_checkin",
  "work_package_acknowledgement",
  "work_package_stop",
  "inventory_command",
  "inventory_scan",
  // Reporting a hazard, making an area safe, condemning equipment, and calling
  // for rescue are worker rights, so they queue durably like any other field
  // action and never depend on a live connection.
  "safety_action",
  "safety_corrective_evidence",
  "fleet_pre_trip_inspection",
  "fleet_post_trip_inspection",
  "fleet_defect_report",
  // A vehicle collision, reported from the cab with no signal. The route takes its own body and
  // keys it by the client's collision_id, so one saved report replays to one record.
  "fleet_collision_report",
  // An administrator-defined job-card field, filled in on a roof with no signal. The value is a
  // governed append-only command, so replaying it is safe: the server keys it by idempotency and
  // refuses it outright if the card moved on underneath.
  "schema_field_value",
] as const;
export type OutboxActionKind = (typeof outboxActionKinds)[number];
export type OutboxMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const outboxStateLabels: Record<OutboxState, string> = {
  saved_locally: "Saved here",
  queued: "Waiting",
  uploading: "Sending",
  verified: "Sent",
  needs_attention: "Needs a check",
};

export interface OutboxAttachment {
  attachmentId: string;
  blobKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified?: number;
}

/**
 * Evidence files an action carries. Each file's upload key and bytes are kept until the Worker has
 * confirmed the whole action, so a refused action still has its files on the phone; the action
 * itself is sent only after every file has a receipt. A JSON outbox must never stand in a file
 * name or a digest for an uploaded file.
 */
export interface OutboxEvidenceFile {
  /** One key per file, kept across every retry so a lost response never makes a second file. */
  uploadKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** The bytes wait in `outbox_blobs` under it, until the action is confirmed. */
  attachmentId?: string;
  /** Set once the Worker confirmed the file; the upload is then never repeated. */
  receiptId?: string;
}

export interface OutboxEvidence {
  scope: EvidenceScope;
  files: OutboxEvidenceFile[];
}

export interface OutboxEvidenceInput {
  scope: EvidenceScope;
  files: Array<{
    uploadKey: string;
    fileName: string;
    mimeType: string;
    size: number;
    /** Already confirmed by the Worker, so only the action itself still has to be sent. */
    receiptId?: string;
    /** Always kept, with or without a receipt, until the action is confirmed. */
    blob: Blob;
  }>;
}

export interface OutboxErrorDetail {
  code: string;
  message: string;
  status?: number;
  occurredAt: number;
}

export interface OutboxConflict {
  status: 409 | 412;
  code: string;
  message: string;
  serverVersion?: JsonValue;
  detectedAt: number;
}

export interface OutboxVerification {
  serverRef?: string;
  cursor?: string;
  verifiedAt: number;
  /**
   * Set when a person in the office, not the upload's own answer, confirmed that the office
   * holds this exact item (`GET /api/v1/field-item-resolutions`).
   */
  officeResolution?: OutboxOfficeResolution;
}

export interface OutboxOfficeResolution {
  resolutionId: string;
  resolution: "arrived" | "duplicate";
  linkedRecord: { type: string; id: string };
  /** Set once the person read the office's answer on Today; the notice there then leaves. */
  seenAt?: number;
}

export interface OutboxAction {
  deviceActionId: string;
  tenantId: string;
  userId: string;
  kind: OutboxActionKind;
  endpoint: string;
  method: OutboxMethod;
  payload: JsonValue;
  attachments: OutboxAttachment[];
  /** Files to upload first, for the kinds that carry evidence (stock actions, corrective evidence). */
  evidence?: OutboxEvidence;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: number;
  /** Optional so uploads created before client leases are treated as stale on recovery. */
  uploadLeaseId?: string;
  uploadLeaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: OutboxErrorDetail;
  conflict?: OutboxConflict;
  verification?: OutboxVerification;
  /**
   * The office answered "it did not arrive" and this phone has used its one resend for that
   * answer. A later answer with another id allows one more; the same answer never does.
   */
  officeResend?: { resolutionId: string; requeuedAt: number };
  version: 2;
}

export interface OutboxBlobRecord {
  blobKey: string;
  deviceActionId: string;
  attachmentId: string;
  blob: Blob;
}

export interface OutboxAttachmentInput {
  blob: Blob;
  fileName: string;
  lastModified?: number;
  attachmentId?: string;
}

export interface SaveOutboxActionInput {
  deviceActionId?: string;
  tenantId: string;
  userId: string;
  kind: OutboxActionKind;
  endpoint: string;
  method?: OutboxMethod;
  payload: JsonValue;
  attachments?: OutboxAttachmentInput[];
  evidence?: OutboxEvidenceInput;
}

export interface OutboxSummary {
  savedLocally: number;
  queued: number;
  uploading: number;
  verified: number;
  needsAttention: number;
  unclaimed: number;
  pending: number;
  total: number;
}
