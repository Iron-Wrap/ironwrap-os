export type MeasurementIntakeStatus =
  "processing" | "matched" | "unmatched" | "retryable_error";

export const MAX_MEASUREMENT_INTAKE_ATTEMPTS = 12;

export interface MeasurementIntakeReceipt {
  receipt_id: string;
  idempotency_key_hash: string;
  payload_hash: string;
  key_strategy:
    | "request_header"
    | "provider_attachment"
    | "attachment_job"
    | "payload_hash";
  measurement_id: string;
  provider: string;
  job_number: string | null;
  raw_key: string;
  content_type: string;
  status: MeasurementIntakeStatus;
  lease_token: string | null;
  lease_expires_at: string | null;
  drive_report_url: string | null;
  drive_folder_url: string | null;
  frappe_measurement_id: string | null;
  frappe_evidence_id: string | null;
  frappe_error: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Operator-facing projection for the admin diagnostics surface. It deliberately omits the
 * idempotency/payload hashes and processing lease, while preserving the R2 pointer needed for
 * an authenticated operator to investigate a receipt.
 */
export interface MeasurementIntakeAdminException {
  receipt_id: string;
  measurement_id: string;
  provider: string;
  job_number: string | null;
  raw_key: string;
  status: "unmatched" | "retryable_error";
  drive_report_url: string | null;
  drive_folder_url: string | null;
  frappe_measurement_id: string | null;
  frappe_evidence_id: string | null;
  frappe_error: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Smaller owner/ops PWA projection. Browser sessions never need an R2 pointer, Frappe ids, or
 * provider error detail; only a bounded recovery disposition and optional Drive links are useful
 * for a human to decide whether a report needs a job match, can wait for retry, or needs recovery.
 */
export interface MeasurementIntakeOwnerException {
  id: string;
  provider: string;
  job_number: string | null;
  status: "unmatched" | "retryable_error";
  reason:
    | "job_number_missing"
    | "job_match_required"
    | "drive_not_configured"
    | "report_fetch_failed"
    | "raw_source_missing"
    | "frappe_sync_failed"
    | "retry_pending";
  drive_report_url: string | null;
  drive_folder_url: string | null;
  attempts: number;
  recovery_disposition:
    | "manual_review"
    | "retry_scheduled"
    | "recovery_blocked"
    | "retry_exhausted";
  created_at: string;
  updated_at: string;
}

export interface MeasurementIntakeIdentity {
  receiptId: string;
  idempotencyKeyHash: string;
  payloadHash: string;
  keyStrategy: MeasurementIntakeReceipt["key_strategy"];
  measurementId: string;
  provider: string;
  jobNumber: string | null;
  rawKey: string;
  contentType: string;
}

export function projectMeasurementIntakeAdminException(
  receipt: MeasurementIntakeReceipt,
): MeasurementIntakeAdminException {
  const status = exceptionStatus(receipt);
  return {
    receipt_id: receipt.receipt_id,
    measurement_id: receipt.measurement_id,
    provider: receipt.provider,
    job_number: receipt.job_number,
    raw_key: receipt.raw_key,
    status,
    drive_report_url: receipt.drive_report_url,
    drive_folder_url: receipt.drive_folder_url,
    frappe_measurement_id: receipt.frappe_measurement_id,
    frappe_evidence_id: receipt.frappe_evidence_id,
    frappe_error: receipt.frappe_error,
    last_error: receipt.last_error,
    attempts: receipt.attempts,
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
    completed_at: receipt.completed_at,
  };
}

export function projectMeasurementIntakeOwnerException(
  receipt: MeasurementIntakeReceipt,
): MeasurementIntakeOwnerException {
  const status = exceptionStatus(receipt);
  return {
    id: receipt.receipt_id,
    provider: receipt.provider,
    job_number: receipt.job_number,
    status,
    reason: ownerExceptionReason(status, receipt.last_error),
    drive_report_url: safeDriveUrl(receipt.drive_report_url),
    drive_folder_url: safeDriveUrl(receipt.drive_folder_url),
    attempts: receipt.attempts,
    recovery_disposition: ownerExceptionRecoveryDisposition(
      status,
      receipt.last_error,
      receipt.attempts,
    ),
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
  };
}

export type MeasurementIntakeClaim =
  | { kind: "claimed"; receipt: MeasurementIntakeReceipt }
  | { kind: "completed"; receipt: MeasurementIntakeReceipt }
  | { kind: "in_progress"; receipt: MeasurementIntakeReceipt }
  | { kind: "conflict"; receipt: MeasurementIntakeReceipt };

/**
 * Atomically reserve one canonical processing lease for one measurement identity.  A request
 * that reuses a key with a different raw payload never silently mutates the original report.
 */
export async function claimMeasurementIntakeReceipt(
  env: Env,
  input: MeasurementIntakeIdentity & {
    now: string;
    leaseToken: string;
    leaseExpiresAt: string;
  },
): Promise<MeasurementIntakeClaim> {
  const inserted = await env.DB.prepare(
    `INSERT INTO measurement_intake_receipts
       (receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
        job_number, raw_key, content_type, status, lease_token, lease_expires_at, attempts, created_at,
        updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, 1, ?, ?, NULL)
     ON CONFLICT(idempotency_key_hash) DO NOTHING`,
  )
    .bind(
      input.receiptId,
      input.idempotencyKeyHash,
      input.payloadHash,
      input.keyStrategy,
      input.measurementId,
      input.provider,
      input.jobNumber,
      input.rawKey,
      input.contentType,
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
      input.now,
    )
    .run();
  if (d1Changes(inserted) === 1) {
    const receipt = await getMeasurementIntakeReceipt(
      env,
      input.idempotencyKeyHash,
    );
    if (!receipt) throw new Error("measurement_receipt_insert_missing");
    return { kind: "claimed", receipt };
  }

  const existing = await getMeasurementIntakeReceipt(
    env,
    input.idempotencyKeyHash,
  );
  if (!existing) throw new Error("measurement_receipt_lookup_failed");
  if (existing.payload_hash !== input.payloadHash)
    return { kind: "conflict", receipt: existing };
  if (isCompleted(existing)) return { kind: "completed", receipt: existing };
  if (leaseActive(existing, input.now))
    return { kind: "in_progress", receipt: existing };

  const takeover = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = 'processing', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1,
         last_error = NULL, updated_at = ?
     WHERE idempotency_key_hash = ? AND payload_hash = ?
       AND status IN ('processing', 'retryable_error')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
      input.idempotencyKeyHash,
      input.payloadHash,
      input.now,
    )
    .run();
  if (d1Changes(takeover) === 1) {
    const receipt = await getMeasurementIntakeReceipt(
      env,
      input.idempotencyKeyHash,
    );
    if (!receipt) throw new Error("measurement_receipt_takeover_missing");
    return { kind: "claimed", receipt };
  }

  const current = await getMeasurementIntakeReceipt(
    env,
    input.idempotencyKeyHash,
  );
  if (!current) throw new Error("measurement_receipt_race_missing");
  if (current.payload_hash !== input.payloadHash)
    return { kind: "conflict", receipt: current };
  return isCompleted(current)
    ? { kind: "completed", receipt: current }
    : { kind: "in_progress", receipt: current };
}

export async function getMeasurementIntakeReceipt(
  env: Env,
  idempotencyKeyHash: string,
): Promise<MeasurementIntakeReceipt | null> {
  return await env.DB.prepare(
    `SELECT receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
            job_number, raw_key, content_type, status, lease_token, lease_expires_at, drive_report_url,
            drive_folder_url, frappe_measurement_id, frappe_evidence_id, frappe_error, last_error,
            attempts, created_at, updated_at, completed_at
     FROM measurement_intake_receipts
     WHERE idempotency_key_hash = ?
     LIMIT 1`,
  )
    .bind(idempotencyKeyHash)
    .first<MeasurementIntakeReceipt>();
}

export async function recordMeasurementDriveFiling(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    reportUrl: string | null;
    folderUrl: string | null;
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET drive_report_url = ?, drive_folder_url = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
      input.reportUrl,
      input.folderUrl,
      input.now,
      input.receiptId,
      input.leaseToken,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_receipt_lease_lost");
}

export async function completeMeasurementIntakeReceipt(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    status: "matched" | "unmatched";
    frappeMeasurementId: string | null;
    frappeEvidenceId: string | null;
    frappeError: string | null;
    lastError: string | null;
    now: string;
  },
): Promise<MeasurementIntakeReceipt> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = ?, lease_token = NULL, lease_expires_at = NULL,
         frappe_measurement_id = ?, frappe_evidence_id = ?, frappe_error = ?, last_error = ?,
         updated_at = ?, completed_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
      input.status,
      input.frappeMeasurementId,
      input.frappeEvidenceId,
      input.frappeError,
      input.lastError,
      input.now,
      input.now,
      input.receiptId,
      input.leaseToken,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_receipt_lease_lost");
  const receipt = await getMeasurementReceiptById(env, input.receiptId);
  if (!receipt) throw new Error("measurement_receipt_completion_missing");
  return receipt;
}

export async function markMeasurementIntakeRetryable(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    error: string;
    frappeError?: string | null;
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = 'retryable_error', lease_token = NULL, lease_expires_at = NULL,
         frappe_error = COALESCE(?, frappe_error), last_error = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
      input.frappeError?.slice(0, 500) ?? null,
      input.error.slice(0, 500),
      input.now,
      input.receiptId,
      input.leaseToken,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_receipt_lease_lost");
}

export async function listMeasurementIntakeExceptions(
  env: Env,
  limit: number,
): Promise<MeasurementIntakeReceipt[]> {
  const rows = await env.DB.prepare(
    `SELECT receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
            job_number, raw_key, content_type, status, lease_token, lease_expires_at, drive_report_url,
            drive_folder_url, frappe_measurement_id, frappe_evidence_id, frappe_error, last_error,
            attempts, created_at, updated_at, completed_at
     FROM measurement_intake_receipts
     WHERE status IN ('unmatched', 'retryable_error')
     ORDER BY updated_at DESC, receipt_id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<MeasurementIntakeReceipt>();
  return rows.results ?? [];
}

/** Bounded retry candidates, including abandoned processing leases. Callers claim before effects. */
export async function listRetryableMeasurementIntakeReceipts(
  env: Env,
  now: string,
  limit: number,
): Promise<MeasurementIntakeReceipt[]> {
  const rows = await env.DB.prepare(
    `SELECT receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
            job_number, raw_key, content_type, status, lease_token, lease_expires_at, drive_report_url,
            drive_folder_url, frappe_measurement_id, frappe_evidence_id, frappe_error, last_error,
            attempts, created_at, updated_at, completed_at
     FROM measurement_intake_receipts
     WHERE (status = 'retryable_error' AND attempts < ?)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     ORDER BY updated_at ASC, receipt_id ASC
     LIMIT ?`,
  )
    .bind(MAX_MEASUREMENT_INTAKE_ATTEMPTS, now, limit)
    .all<MeasurementIntakeReceipt>();
  return rows.results ?? [];
}

export async function pruneMeasurementIntakeReceipts(
  env: Env,
  now = new Date(),
): Promise<void> {
  const completedCutoff = new Date(
    now.getTime() - 365 * 24 * 60 * 60_000,
  ).toISOString();
  await Promise.all([
    env.DB.prepare(
      `DELETE FROM measurement_intake_receipts
       WHERE status = 'matched' AND completed_at <= ?`,
    )
      .bind(completedCutoff)
      .run(),
    // Keep operator-visible failures for the same retention period as completed receipts.
    // Unmatched records are intentionally retained until a human assigns or rejects them.
    env.DB.prepare(
      `DELETE FROM measurement_intake_receipts
       WHERE status = 'retryable_error' AND updated_at <= ?`,
    )
      .bind(completedCutoff)
      .run(),
  ]);
}

function exceptionStatus(
  receipt: MeasurementIntakeReceipt,
): "unmatched" | "retryable_error" {
  if (receipt.status !== "unmatched" && receipt.status !== "retryable_error") {
    throw new Error("measurement_exception_status_invalid");
  }
  return receipt.status;
}

function ownerExceptionReason(
  status: MeasurementIntakeOwnerException["status"],
  lastError: string | null,
): MeasurementIntakeOwnerException["reason"] {
  if (status === "unmatched") {
    return lastError === "no_job_number"
      ? "job_number_missing"
      : "job_match_required";
  }
  if (lastError === "drive_not_configured") return "drive_not_configured";
  if (lastError === "raw_source_missing") return "raw_source_missing";
  if (lastError === "frappe_measurement_sync_failed")
    return "frappe_sync_failed";
  if (/^report_fetch_status_[45]\d\d$/.test(lastError ?? ""))
    return "report_fetch_failed";
  return "retry_pending";
}

function ownerExceptionRecoveryDisposition(
  status: MeasurementIntakeOwnerException["status"],
  lastError: string | null,
  attempts: number,
): MeasurementIntakeOwnerException["recovery_disposition"] {
  if (status === "unmatched") return "manual_review";
  if (retryNeedsHumanRecovery(lastError)) return "recovery_blocked";
  if (attempts >= MAX_MEASUREMENT_INTAKE_ATTEMPTS) return "retry_exhausted";
  return "retry_scheduled";
}

function retryNeedsHumanRecovery(lastError: string | null): boolean {
  if (!lastError) return false;
  if (/^report_fetch_status_4\d\d$/.test(lastError)) return true;
  return new Set([
    "drive_not_configured",
    "raw_source_missing",
    "raw_payload_hash_mismatch",
    "receipt_submission_mismatch",
    "report_url_invalid",
    "report_redirect_invalid",
    "report_too_large",
    "report_body_missing",
  ]).has(lastError);
}

function safeDriveUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (
      url.hostname !== "drive.google.com" &&
      url.hostname !== "docs.google.com"
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function isCompleted(receipt: MeasurementIntakeReceipt): boolean {
  return receipt.status === "matched" || receipt.status === "unmatched";
}

function leaseActive(receipt: MeasurementIntakeReceipt, now: string): boolean {
  return (
    receipt.status === "processing" &&
    !!receipt.lease_token &&
    !!receipt.lease_expires_at &&
    receipt.lease_expires_at > now
  );
}

async function getMeasurementReceiptById(
  env: Env,
  receiptId: string,
): Promise<MeasurementIntakeReceipt | null> {
  return await env.DB.prepare(
    `SELECT receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
            job_number, raw_key, content_type, status, lease_token, lease_expires_at, drive_report_url,
            drive_folder_url, frappe_measurement_id, frappe_evidence_id, frappe_error, last_error,
            attempts, created_at, updated_at, completed_at
     FROM measurement_intake_receipts
     WHERE receipt_id = ?
     LIMIT 1`,
  )
    .bind(receiptId)
    .first<MeasurementIntakeReceipt>();
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}
