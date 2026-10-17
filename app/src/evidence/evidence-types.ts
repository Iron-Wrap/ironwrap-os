import { z } from "zod";

/**
 * File evidence, as the Worker defines it (`workers-bus/README.md`, "File evidence contract").
 * One selected file is uploaded on its own, scoped to the one stock, service or safety action it
 * supports, and the confirmed receipt ids are what the action itself carries. The browser never
 * computes a digest or a storage key for these requests.
 */

export const EVIDENCE_MAX_FILES = 4;
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

export const evidenceMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;
export type EvidenceMimeType = (typeof evidenceMimeTypes)[number];

export type EvidencePurpose = "stock" | "service_intake" | "service_step" | "corrective_action";

/** Exactly what an upload is scoped to. A receipt only works for a mutation with the same scope. */
export interface EvidenceScope {
  purpose: EvidencePurpose;
  targetId: string;
  action: string;
  operationId: string;
}

/** The Worker's identifier shapes, so a scope that cannot be accepted is held back, not sent. */
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const UPLOAD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;

export function isUploadKey(value: string): boolean {
  return UPLOAD_KEY.test(value);
}

/** A scope the Worker can accept. An incomplete one keeps the picker waiting instead of failing. */
export function isUploadableScope(scope: EvidenceScope | null | undefined): scope is EvidenceScope {
  if (!scope) return false;
  if (!TARGET_ID.test(scope.targetId)) return false;
  return scope.operationId === "" ? true : TARGET_ID.test(scope.operationId);
}

export function evidenceScopeKey(scope: EvidenceScope | null | undefined): string {
  return scope
    ? JSON.stringify([scope.purpose, scope.targetId, scope.action, scope.operationId])
    : "";
}

/** One upload key per selected file, kept across retries. 8 to 120 characters on the Worker. */
export function newEvidenceUploadKey(): string {
  return `evidence-${crypto.randomUUID()}`;
}

export const evidenceReceiptIdSchema = z.string().regex(/^evu_[0-9a-f]{64}$/);

/** A tolerant read of the one fact the browser needs back: which receipt this upload became. */
// These module-level schemas are in the crew boot bundle, so the objects are built on first use.
export const evidenceUploadResponseSchema = z.lazy(() =>
  z
    .object({
      result: z.enum(["stored", "replayed"]),
      receipt: z
        .object({
          receipt_id: evidenceReceiptIdSchema,
          purpose: z.string(),
          target_id: z.string(),
          action: z.string(),
          operation_id: z.string(),
        })
        .passthrough(),
    })
    .passthrough(),
);

/**
 * A file attached to a stock action, a service call or a corrective action, as the three detail
 * reads list it. Strictly shaped on purpose, because the Worker's contract names exactly these
 * four fields: a list with anything else in it does not read, so the detail read fails as a whole
 * and the page says the record could not be loaded, rather than showing a file it cannot vouch
 * for. The array is empty for older evidence that was only ever a digest.
 */
export const evidenceFileRefSchema = z.lazy(() =>
  z
    .object({
      receipt_id: evidenceReceiptIdSchema,
      file_name: z.string().min(1).max(180),
      content_type: z.enum(evidenceMimeTypes),
      byte_size: z.number().int().min(1).max(EVIDENCE_MAX_BYTES),
    })
    .strict(),
);
export type EvidenceFileRef = z.infer<typeof evidenceFileRefSchema>;

/** Optional, so a Worker that does not send the list yet still reads. */
export const evidenceFilesSchema = z.lazy(() => z.array(evidenceFileRefSchema)).optional();

/**
 * True when the record read but its file list could not be checked: the list is then empty for
 * that reason, not because nothing was attached. Optional for a Worker that does not send it yet.
 */
export const evidenceFilesUnavailableSchema = z.boolean().optional();

/** "Photo · 2.1 MB" or "PDF · 340 KB". */
export function describeEvidenceFile(file: Pick<EvidenceFileRef, "content_type" | "byte_size">) {
  return `${file.content_type === "application/pdf" ? "PDF" : "Photo"} · ${formatFileSize(file.byte_size)}`;
}

/** How the Worker names an uploaded file inside a submitted action's evidence list. */
export const EVIDENCE_REF_PREFIX = "evidence-upload://";

export function evidenceRefFor(receiptId: string): string {
  return `${EVIDENCE_REF_PREFIX}${receiptId}`;
}

/** The request field every evidence-carrying action sends, in selection order. */
export function evidenceReceiptIdsField(receiptIds: readonly string[]): {
  evidence_receipt_ids: string[];
} {
  return { evidence_receipt_ids: [...receiptIds] };
}

export function formatFileSize(bytes: number): string {
  // A count of bytes means nothing to a person; anything this small is just small.
  if (bytes < 1024) return "under 1 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
