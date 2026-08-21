import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export type MeasurementIntakeStatus =
  "processing" | "matched" | "unmatched" | "retryable_error";

export const MAX_MEASUREMENT_INTAKE_ATTEMPTS = 12;
export const MAX_MEASUREMENT_OCR_ATTEMPTS = 3;

const MEASUREMENT_RECEIPT_COLUMNS = `
  receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
  job_number, raw_key, content_type, status, lease_token, lease_expires_at, drive_report_url,
  drive_folder_url, frappe_measurement_id, frappe_evidence_id, frappe_error, last_error,
  attempts, created_at, updated_at, completed_at, report_raw_key, report_sha256,
  report_content_type, ocr_status, ocr_model, ocr_result_key, ocr_result_sha256,
  ocr_job_number_candidate, ocr_job_number_source_ref, ocr_review_required, ocr_error,
  ocr_completed_at, tenant_id, native_roof_job_id, native_measurement_revision_id,
  native_projection_sha256`;

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
  report_raw_key: string | null;
  report_sha256: string | null;
  report_content_type: string | null;
  ocr_status: "not_requested" | "processing" | "completed" | "failed";
  ocr_model: string | null;
  ocr_result_key: string | null;
  ocr_result_sha256: string | null;
  ocr_job_number_candidate: string | null;
  ocr_job_number_source_ref: string | null;
  ocr_review_required: 0 | 1;
  ocr_error: string | null;
  ocr_completed_at: string | null;
  tenant_id: string | null;
  native_roof_job_id: string | null;
  native_measurement_revision_id: string | null;
  native_projection_sha256: string | null;
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
  native_tenant_id: string | null;
  native_roof_job_id: string | null;
  native_measurement_revision_id: string | null;
  native_projection_sha256: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Smaller owner/ops PWA projection. Browser sessions never need an R2 pointer, native revision
 * internals, or provider error detail; only a bounded recovery disposition and optional Drive links are useful
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
    | "ocr_review_required"
    | "ocr_failed"
    | "drive_not_configured"
    | "report_fetch_failed"
    | "raw_source_missing"
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
  tenantId: string;
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

export interface NativeMeasurementJobAnchor {
  tenant_id: string;
  roof_job_id: string;
  job_number: string;
  version: number;
}

export type NativeMeasurementJobResolution =
  | { state: "matched"; job: NativeMeasurementJobAnchor; error: null }
  | {
      state: "unmatched";
      job: null;
      error:
        | "no_job_number"
        | "roof_job_not_found"
        | "roof_job_tenant_mismatch"
        | "roof_job_ambiguous";
    };

export interface NativeMeasurementRevisionRecord {
  measurement_revision_id: string;
  tenant_id: string;
  receipt_id: string;
  measurement_id: string;
  provider: string;
  job_number: string | null;
  roof_job_id: string | null;
  operating_job_version: number | null;
  association_status: "matched" | "unmatched";
  association_error: string | null;
  receipt_status: "matched" | "unmatched";
  completion_reason: string | null;
  review_required: 0 | 1;
  root_measurement_id: string;
  revision_number: number;
  supersedes_measurement_revision_id: string | null;
  correction_reason: string | null;
  measurement_raw_key: string;
  measurement_raw_sha256: string;
  report_raw_key: string | null;
  report_sha256: string | null;
  ocr_result_key: string | null;
  ocr_result_sha256: string | null;
  projection_json: string;
  projection_sha256: string;
  command_fingerprint: string;
  created_at: string;
}

export class NativeMeasurementStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "NativeMeasurementStoreError";
    this.code = code;
  }
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
    native_tenant_id: receipt.tenant_id,
    native_roof_job_id: receipt.native_roof_job_id,
    native_measurement_revision_id: receipt.native_measurement_revision_id,
    native_projection_sha256: receipt.native_projection_sha256,
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
       (receipt_id, tenant_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider,
        job_number, raw_key, content_type, status, lease_token, lease_expires_at, attempts, created_at,
        updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, 1, ?, ?, NULL)
     ON CONFLICT(idempotency_key_hash) DO NOTHING`,
  )
    .bind(
      input.receiptId,
      input.tenantId,
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
  if (
    existing.payload_hash !== input.payloadHash ||
    existing.tenant_id !== input.tenantId
  )
    return { kind: "conflict", receipt: existing };
  if (isCompleted(existing)) return { kind: "completed", receipt: existing };
  if (leaseActive(existing, input.now))
    return { kind: "in_progress", receipt: existing };

  const takeover = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = 'processing', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1,
         last_error = NULL, updated_at = ?
     WHERE idempotency_key_hash = ? AND payload_hash = ? AND tenant_id = ?
       AND status IN ('processing', 'retryable_error')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
      input.idempotencyKeyHash,
      input.payloadHash,
      input.tenantId,
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
  if (
    current.payload_hash !== input.payloadHash ||
    current.tenant_id !== input.tenantId
  )
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
    `SELECT ${MEASUREMENT_RECEIPT_COLUMNS}
     FROM measurement_intake_receipts
     WHERE idempotency_key_hash = ?
     LIMIT 1`,
  )
    .bind(idempotencyKeyHash)
    .first<MeasurementIntakeReceipt>();
}

export async function getMeasurementIntakeReceiptById(
  env: Env,
  receiptId: string,
): Promise<MeasurementIntakeReceipt | null> {
  return await getMeasurementReceiptById(env, receiptId);
}

export async function resolveNativeMeasurementJob(
  env: Env,
  tenantId: string,
  jobNumber: string | null,
): Promise<NativeMeasurementJobResolution> {
  if (!jobNumber)
    return { state: "unmatched", job: null, error: "no_job_number" };
  const rows = await env.DB.prepare(
    `SELECT tenant_id, roof_job_id, job_number, version
       FROM operating_roof_jobs
      WHERE tenant_id = ? AND job_number = ?
      ORDER BY roof_job_id ASC
      LIMIT 2`,
  )
    .bind(tenantId, jobNumber)
    .all<NativeMeasurementJobAnchor>();
  const matches = rows.results ?? [];
  if (matches.length === 1) {
    return { state: "matched", job: matches[0]!, error: null };
  }
  if (matches.length > 1) {
    return { state: "unmatched", job: null, error: "roof_job_ambiguous" };
  }
  const foreignTenant = await env.DB.prepare(
    `SELECT tenant_id FROM operating_roof_jobs
      WHERE tenant_id != ? AND job_number = ? LIMIT 1`,
  )
    .bind(tenantId, jobNumber)
    .first<{ tenant_id: string }>();
  return {
    state: "unmatched",
    job: null,
    error: foreignTenant ? "roof_job_tenant_mismatch" : "roof_job_not_found",
  };
}

export async function getNativeMeasurementRevisionByReceipt(
  env: Env,
  receiptId: string,
): Promise<NativeMeasurementRevisionRecord | null> {
  const row = await nativeMeasurementRevisionByReceipt(env, receiptId);
  if (!row) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.projection_json) as Record<string, unknown>;
  } catch {
    throw new NativeMeasurementStoreError(
      "native_measurement_projection_invalid",
    );
  }
  if (
    canonicalJson(parsed) !== row.projection_json ||
    (await sha256Hex(row.projection_json)) !== row.projection_sha256 ||
    parsed.schema_version !== "ironwrap.native-measurement.v1" ||
    parsed.tenant_id !== row.tenant_id ||
    parsed.receipt_id !== row.receipt_id ||
    parsed.measurement_id !== row.measurement_id
  ) {
    throw new NativeMeasurementStoreError(
      "native_measurement_projection_drift",
    );
  }
  return row;
}

export async function recordNativeMeasurementRevision(
  env: Env,
  input: {
    receipt: MeasurementIntakeReceipt;
    tenantId: string;
    job: NativeMeasurementJobAnchor | null;
    associationError: NativeMeasurementJobResolution["error"];
    receiptStatus: "matched" | "unmatched";
    completionReason: string | null;
    reviewReasons: string[];
    supersedesMeasurementId: string | null;
    correctionReason: string | null;
    evidence: Readonly<Record<string, unknown>>;
    now: string;
  },
): Promise<{
  kind: "created" | "replayed";
  revision: NativeMeasurementRevisionRecord;
}> {
  const correctionReason = input.correctionReason?.trim() || null;
  if (Boolean(input.supersedesMeasurementId) !== Boolean(correctionReason)) {
    throw new NativeMeasurementStoreError("measurement_correction_incomplete");
  }
  const commandFingerprint = await sha256Hex(
    canonicalJson({
      tenant_id: input.tenantId,
      receipt_id: input.receipt.receipt_id,
      measurement_id: input.receipt.measurement_id,
      provider: input.receipt.provider,
      job_number: input.receipt.job_number,
      roof_job_id: input.job?.roof_job_id ?? null,
      operating_job_version: input.job?.version ?? null,
      association_error: input.associationError,
      receipt_status: input.receiptStatus,
      completion_reason: input.completionReason,
      review_reasons: input.reviewReasons,
      supersedes_measurement_id: input.supersedesMeasurementId,
      correction_reason: correctionReason,
      evidence: input.evidence,
    }),
  );
  const replay = await nativeMeasurementRevisionByReceipt(
    env,
    input.receipt.receipt_id,
  );
  if (replay) {
    if (replay.command_fingerprint !== commandFingerprint) {
      throw new NativeMeasurementStoreError(
        "native_measurement_replay_collision",
      );
    }
    return {
      kind: "replayed",
      revision: await requireValidRevision(env, replay),
    };
  }

  let rootMeasurementId = input.receipt.measurement_id;
  let revisionNumber = 1;
  let supersedesRevisionId: string | null = null;
  if (input.supersedesMeasurementId) {
    const predecessor = await nativeMeasurementRevisionByMeasurementId(
      env,
      input.tenantId,
      input.supersedesMeasurementId,
    );
    if (!predecessor) {
      throw new NativeMeasurementStoreError(
        "measurement_correction_predecessor_missing",
      );
    }
    const successor = await nativeMeasurementSuccessor(
      env,
      input.tenantId,
      predecessor.measurement_revision_id,
    );
    if (successor) {
      throw new NativeMeasurementStoreError("measurement_correction_stale");
    }
    if (
      predecessor.roof_job_id &&
      predecessor.roof_job_id !== input.job?.roof_job_id
    ) {
      throw new NativeMeasurementStoreError(
        "measurement_correction_job_mismatch",
      );
    }
    rootMeasurementId = predecessor.root_measurement_id;
    revisionNumber = Number(predecessor.revision_number) + 1;
    supersedesRevisionId = predecessor.measurement_revision_id;
  }

  const projection = {
    schema_version: "ironwrap.native-measurement.v1",
    tenant_id: input.tenantId,
    receipt_id: input.receipt.receipt_id,
    measurement_id: input.receipt.measurement_id,
    provider: input.receipt.provider,
    association: {
      status: input.job ? "matched" : "unmatched",
      job_number: input.receipt.job_number,
      roof_job_id: input.job?.roof_job_id ?? null,
      operating_job_version: input.job?.version ?? null,
      error: input.associationError,
    },
    lineage: {
      root_measurement_id: rootMeasurementId,
      revision_number: revisionNumber,
      supersedes_measurement_revision_id: supersedesRevisionId,
      correction_reason: correctionReason,
    },
    receipt_status: input.receiptStatus,
    completion_reason: input.completionReason,
    review: {
      required: input.reviewReasons.length > 0,
      reasons: input.reviewReasons,
    },
    evidence: input.evidence,
  };
  const projectionJson = canonicalJson(projection);
  const projectionSha256 = await sha256Hex(projectionJson);
  const revisionId = `mrev_${await sha256Hex(
    canonicalJson({
      tenant_id: input.tenantId,
      receipt_id: input.receipt.receipt_id,
    }),
  )}`;
  const statement = env.DB.prepare(
    `INSERT INTO native_measurement_revisions (
       measurement_revision_id, tenant_id, receipt_id, measurement_id, provider, job_number,
       roof_job_id, operating_job_version, association_status, association_error, receipt_status,
       completion_reason, review_required, root_measurement_id, revision_number,
       supersedes_measurement_revision_id, correction_reason, measurement_raw_key,
       measurement_raw_sha256, report_raw_key, report_sha256, ocr_result_key, ocr_result_sha256,
       projection_json, projection_sha256, command_fingerprint, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    revisionId,
    input.tenantId,
    input.receipt.receipt_id,
    input.receipt.measurement_id,
    input.receipt.provider,
    input.receipt.job_number,
    input.job?.roof_job_id ?? null,
    input.job?.version ?? null,
    input.job ? "matched" : "unmatched",
    input.associationError,
    input.receiptStatus,
    input.completionReason,
    input.reviewReasons.length > 0 ? 1 : 0,
    rootMeasurementId,
    revisionNumber,
    supersedesRevisionId,
    correctionReason,
    input.receipt.raw_key,
    input.receipt.payload_hash,
    input.receipt.report_raw_key,
    input.receipt.report_sha256,
    input.receipt.ocr_result_key,
    input.receipt.ocr_result_sha256,
    projectionJson,
    projectionSha256,
    commandFingerprint,
    input.now,
  );
  try {
    await statement.run();
  } catch (error) {
    const concurrent = await nativeMeasurementRevisionByReceipt(
      env,
      input.receipt.receipt_id,
    );
    if (concurrent) {
      if (concurrent.command_fingerprint !== commandFingerprint) {
        throw new NativeMeasurementStoreError(
          "native_measurement_replay_collision",
        );
      }
      return {
        kind: "replayed",
        revision: await requireValidRevision(env, concurrent),
      };
    }
    if (
      supersedesRevisionId &&
      (await nativeMeasurementSuccessor(
        env,
        input.tenantId,
        supersedesRevisionId,
      ))
    ) {
      throw new NativeMeasurementStoreError("measurement_correction_stale");
    }
    const detail = String(error);
    if (detail.includes("native_measurement_receipt_evidence_mismatch")) {
      throw new NativeMeasurementStoreError(
        "native_measurement_receipt_evidence_mismatch",
      );
    }
    if (detail.includes("native_measurement_job_anchor_mismatch")) {
      throw new NativeMeasurementStoreError(
        "native_measurement_job_anchor_mismatch",
      );
    }
    throw new NativeMeasurementStoreError("native_measurement_write_failed");
  }
  const revision = await getNativeMeasurementRevisionByReceipt(
    env,
    input.receipt.receipt_id,
  );
  if (!revision)
    throw new NativeMeasurementStoreError("native_measurement_write_missing");
  return { kind: "created", revision };
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

export async function recordMeasurementReportEvidence(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    rawKey: string;
    sha256: string;
    contentType: string;
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET report_raw_key = ?, report_sha256 = ?, report_content_type = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?
       AND (report_raw_key IS NULL OR (report_raw_key = ? AND report_sha256 = ?))`,
  )
    .bind(
      input.rawKey,
      input.sha256,
      input.contentType,
      input.now,
      input.receiptId,
      input.leaseToken,
      input.rawKey,
      input.sha256,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_report_evidence_update_lost");
}

export async function recordMeasurementOcrStarted(
  env: Env,
  input: { receiptId: string; leaseToken: string; model: string; now: string },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET ocr_status = 'processing', ocr_model = ?, ocr_error = NULL, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?
       AND ocr_status IN ('not_requested', 'processing', 'failed')`,
  )
    .bind(input.model, input.now, input.receiptId, input.leaseToken)
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_ocr_start_update_lost");
}

export async function recordMeasurementOcrResult(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    model: string;
    resultKey: string;
    resultSha256: string;
    jobNumberCandidate: string | null;
    jobNumberSourceRef: string | null;
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET ocr_status = 'completed', ocr_model = ?, ocr_result_key = ?, ocr_result_sha256 = ?,
         ocr_job_number_candidate = ?, ocr_job_number_source_ref = ?, ocr_review_required = 1,
         ocr_error = NULL, ocr_completed_at = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?
       AND ocr_status = 'processing'`,
  )
    .bind(
      input.model,
      input.resultKey,
      input.resultSha256,
      input.jobNumberCandidate,
      input.jobNumberSourceRef,
      input.now,
      input.now,
      input.receiptId,
      input.leaseToken,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_ocr_result_update_lost");
}

export async function recordMeasurementOcrFailure(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    model: string;
    error: string;
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET ocr_status = 'failed', ocr_model = ?, ocr_review_required = 1, ocr_error = ?,
         updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
      input.model,
      input.error.slice(0, 500),
      input.now,
      input.receiptId,
      input.leaseToken,
    )
    .run();
  if (d1Changes(result) !== 1)
    throw new Error("measurement_ocr_failure_update_lost");
}

export async function completeMeasurementIntakeReceipt(
  env: Env,
  input: {
    receiptId: string;
    leaseToken: string;
    tenantId: string;
    status: "matched" | "unmatched";
    nativeRoofJobId: string | null;
    nativeMeasurementRevisionId: string;
    nativeProjectionSha256: string;
    lastError: string | null;
    now: string;
  },
): Promise<MeasurementIntakeReceipt> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = ?, lease_token = NULL, lease_expires_at = NULL,
         native_roof_job_id = ?, native_measurement_revision_id = ?,
         native_projection_sha256 = ?, last_error = ?,
         updated_at = ?, completed_at = ?
     WHERE receipt_id = ? AND tenant_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
      input.status,
      input.nativeRoofJobId,
      input.nativeMeasurementRevisionId,
      input.nativeProjectionSha256,
      input.lastError,
      input.now,
      input.now,
      input.receiptId,
      input.tenantId,
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
    now: string;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE measurement_intake_receipts
     SET status = 'retryable_error', lease_token = NULL, lease_expires_at = NULL,
         last_error = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'processing' AND lease_token = ?`,
  )
    .bind(
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
    `SELECT ${MEASUREMENT_RECEIPT_COLUMNS}
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
    `SELECT ${MEASUREMENT_RECEIPT_COLUMNS}
     FROM measurement_intake_receipts
     WHERE (status = 'retryable_error' AND attempts < CASE
              WHEN last_error GLOB 'measurement_ocr_*' THEN ? ELSE ? END)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     ORDER BY updated_at ASC, receipt_id ASC
     LIMIT ?`,
  )
    .bind(
      MAX_MEASUREMENT_OCR_ATTEMPTS,
      MAX_MEASUREMENT_INTAKE_ATTEMPTS,
      now,
      limit,
    )
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
       WHERE status = 'matched' AND completed_at <= ?
         AND native_measurement_revision_id IS NULL`,
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
    if (lastError === "ocr_review_required") return "ocr_review_required";
    return lastError === "no_job_number"
      ? "job_number_missing"
      : "job_match_required";
  }
  if (lastError?.startsWith("measurement_ocr_")) return "ocr_failed";
  if (lastError === "drive_not_configured") return "drive_not_configured";
  if (lastError === "raw_source_missing") return "raw_source_missing";
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
  if (measurementRetryNeedsHumanRecovery(lastError)) return "recovery_blocked";
  if (attempts >= measurementRetryAttemptLimit(lastError))
    return "retry_exhausted";
  return "retry_scheduled";
}

export function measurementRetryAttemptLimit(lastError: string | null): number {
  return lastError?.startsWith("measurement_ocr_")
    ? MAX_MEASUREMENT_OCR_ATTEMPTS
    : MAX_MEASUREMENT_INTAKE_ATTEMPTS;
}

export function measurementRetryNeedsHumanRecovery(
  lastError: string | null,
): boolean {
  if (!lastError) return false;
  if (/^report_fetch_status_4\d\d$/.test(lastError)) return true;
  if (/^measurement_ocr_http_4\d\d$/.test(lastError)) return true;
  return new Set([
    "drive_not_configured",
    "raw_source_missing",
    "raw_payload_hash_mismatch",
    "receipt_submission_mismatch",
    "report_url_invalid",
    "report_redirect_invalid",
    "report_too_large",
    "report_body_missing",
    "measurement_report_evidence_incomplete",
    "measurement_report_evidence_missing",
    "measurement_report_evidence_hash_mismatch",
    "measurement_ocr_not_configured",
    "measurement_ocr_model_not_allowed",
    "measurement_ocr_pdf_too_large",
    "measurement_ocr_response_invalid",
    "measurement_ocr_tool_result_missing",
    "measurement_ocr_tool_result_invalid",
    "measurement_ocr_evidence_incomplete",
    "measurement_ocr_evidence_missing",
    "measurement_ocr_evidence_too_large",
    "measurement_ocr_evidence_hash_mismatch",
    "measurement_ocr_evidence_invalid",
    "measurement_ocr_evidence_model_mismatch",
    "measurement_ocr_report_hash_mismatch",
    "measurement_receipt_tenant_missing",
    "measurement_receipt_tenant_mismatch",
    "measurement_correction_incomplete",
    "measurement_correction_predecessor_missing",
    "measurement_correction_stale",
    "measurement_correction_job_mismatch",
    "native_measurement_receipt_evidence_mismatch",
    "native_measurement_job_anchor_mismatch",
    "native_measurement_projection_invalid",
    "native_measurement_projection_drift",
    "native_measurement_replay_collision",
    "native_measurement_write_failed",
    "native_measurement_write_missing",
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
    `SELECT ${MEASUREMENT_RECEIPT_COLUMNS}
     FROM measurement_intake_receipts
     WHERE receipt_id = ?
     LIMIT 1`,
  )
    .bind(receiptId)
    .first<MeasurementIntakeReceipt>();
}

async function nativeMeasurementRevisionByReceipt(
  env: Env,
  receiptId: string,
): Promise<NativeMeasurementRevisionRecord | null> {
  return await env.DB.prepare(
    `SELECT measurement_revision_id, tenant_id, receipt_id, measurement_id, provider,
            job_number, roof_job_id, operating_job_version, association_status,
            association_error, receipt_status, completion_reason, review_required,
            root_measurement_id, revision_number, supersedes_measurement_revision_id,
            correction_reason, measurement_raw_key, measurement_raw_sha256, report_raw_key,
            report_sha256, ocr_result_key, ocr_result_sha256, projection_json,
            projection_sha256, command_fingerprint, created_at
       FROM native_measurement_revisions WHERE receipt_id = ? LIMIT 1`,
  )
    .bind(receiptId)
    .first<NativeMeasurementRevisionRecord>();
}

async function nativeMeasurementRevisionByMeasurementId(
  env: Env,
  tenantId: string,
  measurementId: string,
): Promise<NativeMeasurementRevisionRecord | null> {
  return await env.DB.prepare(
    `SELECT measurement_revision_id, tenant_id, receipt_id, measurement_id, provider,
            job_number, roof_job_id, operating_job_version, association_status,
            association_error, receipt_status, completion_reason, review_required,
            root_measurement_id, revision_number, supersedes_measurement_revision_id,
            correction_reason, measurement_raw_key, measurement_raw_sha256, report_raw_key,
            report_sha256, ocr_result_key, ocr_result_sha256, projection_json,
            projection_sha256, command_fingerprint, created_at
       FROM native_measurement_revisions
      WHERE tenant_id = ? AND measurement_id = ? LIMIT 1`,
  )
    .bind(tenantId, measurementId)
    .first<NativeMeasurementRevisionRecord>();
}

async function nativeMeasurementSuccessor(
  env: Env,
  tenantId: string,
  revisionId: string,
): Promise<{ measurement_revision_id: string } | null> {
  return await env.DB.prepare(
    `SELECT measurement_revision_id FROM native_measurement_revisions
      WHERE tenant_id = ? AND supersedes_measurement_revision_id = ? LIMIT 1`,
  )
    .bind(tenantId, revisionId)
    .first<{ measurement_revision_id: string }>();
}

async function requireValidRevision(
  env: Env,
  revision: NativeMeasurementRevisionRecord,
): Promise<NativeMeasurementRevisionRecord> {
  const verified = await getNativeMeasurementRevisionByReceipt(
    env,
    revision.receipt_id,
  );
  if (!verified) {
    throw new NativeMeasurementStoreError("native_measurement_write_missing");
  }
  return verified;
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}
