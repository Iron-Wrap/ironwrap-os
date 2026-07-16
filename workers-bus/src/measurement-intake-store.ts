export type MeasurementIntakeStatus =
  | "processing"
  | "matched"
  | "unmatched"
  | "retryable_error";

export interface MeasurementIntakeReceipt {
  receipt_id: string;
  idempotency_key_hash: string;
  payload_hash: string;
  key_strategy: "request_header" | "provider_attachment" | "attachment_job" | "payload_hash";
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
  input: MeasurementIntakeIdentity & { now: string; leaseToken: string; leaseExpiresAt: string },
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
    const receipt = await getMeasurementIntakeReceipt(env, input.idempotencyKeyHash);
    if (!receipt) throw new Error("measurement_receipt_insert_missing");
    return { kind: "claimed", receipt };
  }

  const existing = await getMeasurementIntakeReceipt(env, input.idempotencyKeyHash);
  if (!existing) throw new Error("measurement_receipt_lookup_failed");
  if (existing.payload_hash !== input.payloadHash) return { kind: "conflict", receipt: existing };
  if (isCompleted(existing)) return { kind: "completed", receipt: existing };
  if (leaseActive(existing, input.now)) return { kind: "in_progress", receipt: existing };

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
    const receipt = await getMeasurementIntakeReceipt(env, input.idempotencyKeyHash);
    if (!receipt) throw new Error("measurement_receipt_takeover_missing");
    return { kind: "claimed", receipt };
  }

  const current = await getMeasurementIntakeReceipt(env, input.idempotencyKeyHash);
  if (!current) throw new Error("measurement_receipt_race_missing");
  if (current.payload_hash !== input.payloadHash) return { kind: "conflict", receipt: current };
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
    .bind(input.reportUrl, input.folderUrl, input.now, input.receiptId, input.leaseToken)
    .run();
  if (d1Changes(result) !== 1) throw new Error("measurement_receipt_lease_lost");
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
  if (d1Changes(result) !== 1) throw new Error("measurement_receipt_lease_lost");
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
  if (d1Changes(result) !== 1) throw new Error("measurement_receipt_lease_lost");
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
     WHERE (status = 'retryable_error' AND attempts < 12)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     ORDER BY updated_at ASC, receipt_id ASC
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<MeasurementIntakeReceipt>();
  return rows.results ?? [];
}

export async function pruneMeasurementIntakeReceipts(
  env: Env,
  now = new Date(),
): Promise<void> {
  const completedCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000).toISOString();
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

function isCompleted(receipt: MeasurementIntakeReceipt): boolean {
  return receipt.status === "matched" || receipt.status === "unmatched";
}

function leaseActive(receipt: MeasurementIntakeReceipt, now: string): boolean {
  return receipt.status === "processing" &&
    !!receipt.lease_token &&
    !!receipt.lease_expires_at &&
    receipt.lease_expires_at > now;
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
