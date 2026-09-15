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
