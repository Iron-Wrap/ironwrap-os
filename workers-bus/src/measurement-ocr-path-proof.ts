/**
 * IRO-28 repository proof shape for one measurement-intake OCR path.
 *
 * This is not a live cloud receipt. A passing Worker test may populate it;
 * nothing here may claim Deployed, Runtime-verified, or Business-accepted.
 */

export type MeasurementReceiptId = string & { readonly __brand: "MeasurementReceiptId" };
export type MeasurementOcrEvidenceKey = string & { readonly __brand: "MeasurementOcrEvidenceKey" };

export const MEASUREMENT_OCR_PATH_PROOF_KIND = "ironwrap.measurement-ocr-path-proof.v1" as const;

export const MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY = false;

export type MeasurementOcrCreditOutcome =
  | "completed_via_omniroute_fallback"
  | "failed_closed_without_credits";

export interface MeasurementOcrPathProof {
  kind: typeof MEASUREMENT_OCR_PATH_PROOF_KIND;
  live_cloud_deploy: typeof MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY;
  fixture: "synthetic_pdf";
  receipt_id: MeasurementReceiptId;
  status: "retryable_error" | "unmatched" | "matched";
  ocr_status: "completed" | "failed";
  ocr_result_key: MeasurementOcrEvidenceKey | null;
  ocr_result_sha256: string | null;
  last_error: string;
  owner_exception_visible: boolean;
  owner_exception_reason: string;
  credit_outcome: MeasurementOcrCreditOutcome;
  anthropic_messages_calls: number;
  omniroute_messages_calls: number;
}

export function parseMeasurementReceiptId(value: string): MeasurementReceiptId | null {
  return /^[A-Za-z0-9._:-]{8,80}$/.test(value) ? (value as MeasurementReceiptId) : null;
}

export function parseMeasurementOcrEvidenceKey(value: string): MeasurementOcrEvidenceKey | null {
  return /^raw\/measurement-ocr\/[A-Za-z0-9._:-]+\/[0-9a-f]{64}\.json$/.test(value)
    ? (value as MeasurementOcrEvidenceKey)
    : null;
}

export function buildMeasurementOcrPathProof(input: {
  receiptId: string;
  status: MeasurementOcrPathProof["status"];
  ocrStatus: MeasurementOcrPathProof["ocr_status"];
  ocrResultKey: string | null;
  ocrResultSha256: string | null;
  lastError: string;
  ownerExceptionVisible: boolean;
  ownerExceptionReason: string;
  creditOutcome: MeasurementOcrCreditOutcome;
  anthropicMessagesCalls: number;
  omnirouteMessagesCalls: number;
}): MeasurementOcrPathProof {
  const receiptId = parseMeasurementReceiptId(input.receiptId);
  if (!receiptId) throw new Error("measurement_ocr_proof_receipt_id_invalid");
  if (!input.lastError.trim()) throw new Error("measurement_ocr_proof_last_error_required");
  if (!input.ownerExceptionVisible) throw new Error("measurement_ocr_proof_owner_exception_required");
  if (input.ocrStatus === "completed") {
    const key = input.ocrResultKey ? parseMeasurementOcrEvidenceKey(input.ocrResultKey) : null;
    if (!key || !input.ocrResultSha256 || !/^[0-9a-f]{64}$/.test(input.ocrResultSha256)) {
      throw new Error("measurement_ocr_proof_evidence_incomplete");
    }
    return {
      kind: MEASUREMENT_OCR_PATH_PROOF_KIND,
      live_cloud_deploy: MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY,
      fixture: "synthetic_pdf",
      receipt_id: receiptId,
      status: input.status,
      ocr_status: "completed",
      ocr_result_key: key,
      ocr_result_sha256: input.ocrResultSha256,
      last_error: input.lastError,
      owner_exception_visible: true,
      owner_exception_reason: input.ownerExceptionReason,
      credit_outcome: input.creditOutcome,
      anthropic_messages_calls: input.anthropicMessagesCalls,
      omniroute_messages_calls: input.omnirouteMessagesCalls,
    };
  }
  if (input.ocrResultKey !== null || input.ocrResultSha256 !== null) {
    throw new Error("measurement_ocr_proof_failed_must_omit_evidence");
  }
  return {
    kind: MEASUREMENT_OCR_PATH_PROOF_KIND,
    live_cloud_deploy: MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY,
    fixture: "synthetic_pdf",
    receipt_id: receiptId,
    status: input.status,
    ocr_status: "failed",
    ocr_result_key: null,
    ocr_result_sha256: null,
    last_error: input.lastError,
    owner_exception_visible: true,
    owner_exception_reason: input.ownerExceptionReason,
    credit_outcome: input.creditOutcome,
    anthropic_messages_calls: input.anthropicMessagesCalls,
    omniroute_messages_calls: input.omnirouteMessagesCalls,
  };
}
