import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest, isAnswerLost } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { evidenceUploadResponseSchema, type EvidenceScope } from "./evidence-types";

/** A file's bytes, name and declared type, exactly as the first attempt sent them. */
export interface UploadableEvidence {
  name: string;
  blob: Blob;
}

export interface EvidenceUploadRequest {
  session: AuthenticatedSession;
  scope: EvidenceScope;
  /** One key per selected file, kept across every retry of it. */
  key: string;
  file: UploadableEvidence;
  signal?: AbortSignal | undefined;
  fetcher?: typeof fetch | undefined;
  /** Replaces the wait worked out from the file's size. For tests. */
  timeoutMs?: number | undefined;
}

export interface EvidenceUploadResult {
  receiptId: string;
  /** True when the Worker already held this exact upload and returned its original receipt. */
  replayed: boolean;
}

const EVIDENCE_UPLOAD_BASE_TIMEOUT_MS = 30_000;
const EVIDENCE_UPLOAD_MIN_TIMEOUT_MS = 120_000;
const EVIDENCE_UPLOAD_MAX_TIMEOUT_MS = 10 * 60_000;
/** About 256 kbit/s: slower than this is a link nobody can attach a photo over. */
const EVIDENCE_UPLOAD_MIN_BYTES_PER_SECOND = 32 * 1024;

/**
 * How long one file may take to go up or come down before it is given up on. A photo is up to
 * 8 MB, so the wait grows with the file: a slow but working link can finish, and a dead one is
 * not waited on for ever.
 */
export function evidenceTransferTimeoutMs(sizeBytes: number): number {
  const transferMs = (Math.max(0, sizeBytes) / EVIDENCE_UPLOAD_MIN_BYTES_PER_SECOND) * 1_000;
  return Math.min(
    EVIDENCE_UPLOAD_MAX_TIMEOUT_MS,
    Math.max(
      EVIDENCE_UPLOAD_MIN_TIMEOUT_MS,
      Math.ceil(EVIDENCE_UPLOAD_BASE_TIMEOUT_MS + transferMs),
    ),
  );
}

/** Transient failures are tried this many times in all, always with the same key. */
export const EVIDENCE_MAX_ATTEMPTS = 3;
/** Back-to-back "too many uploads" answers honoured before the person is asked to try again. */
export const EVIDENCE_MAX_RATE_LIMIT_WAITS = 4;
/** Used only when the Worker limits an upload without saying how long to wait. */
export const EVIDENCE_DEFAULT_WAIT_MS = 15_000;
const EVIDENCE_MAX_WAIT_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = [1_000, 3_000] as const;

/** One attempt: multipart with exactly the five fields, the upload key, CSRF and device proof. */
export async function uploadEvidenceFile(
  request: EvidenceUploadRequest,
): Promise<EvidenceUploadResult> {
  const { scope } = request;
  const form = new FormData();
  form.append("purpose", scope.purpose);
  form.append("target_id", scope.targetId);
  form.append("action", scope.action);
  form.append("operation_id", scope.operationId);
  // A File, not a bare Blob, so the name travels with the bytes in every environment.
  const file = new File([request.file.blob], request.file.name, { type: request.file.blob.type });
  form.append("file", file, request.file.name);
  const response = await apiRequest({
    path: API_PATHS.evidenceUploads,
    schema: evidenceUploadResponseSchema,
    method: "POST",
    body: form,
    csrfToken: request.session.csrf_token,
    idempotencyKey: request.key,
    deviceProof: request.session.user.role === "field" ? getDeviceSecret : undefined,
    signal: request.signal,
    timeoutMs: request.timeoutMs ?? evidenceTransferTimeoutMs(request.file.blob.size),
    fetcher: request.fetcher,
  });
  const receipt = response.receipt;
  // A receipt for another scope could never be submitted. Say so here rather than at submit time.
  if (
    receipt.purpose !== scope.purpose ||
    receipt.target_id !== scope.targetId ||
    receipt.action !== scope.action ||
    receipt.operation_id !== scope.operationId
  ) {
    throw new ApiError({
      status: 200,
      code: "evidence_receipt_mismatch",
      message: "The saved file does not match what was asked for.",
    });
  }
  return { receiptId: receipt.receipt_id, replayed: response.result === "replayed" };
}

export interface EvidenceWait {
  reason: "rate_limit" | "retry";
  /** Epoch milliseconds at which the next attempt starts. */
  until: number;
  /** How long the wait is, so a countdown can start from exactly that. */
  ms: number;
}

export interface EvidenceRetryOptions {
  /** Called when an attempt is waiting out a limit, and with `null` when it is under way again. */
  onWait?: (wait: EvidenceWait | null) => void;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * A dropped or flaky link and a busy store are worth another try. A timeout is not: the file was
 * given a generous wait already, so it stops with a plain reason and the person decides.
 */
function isTransient(error: unknown): boolean {
  // A 2xx whose body was lost or cut off may mean the file is already stored: the same bytes under
  // the same key make the Worker answer with the receipt it holds, so it is retried, not refused.
  return (
    error instanceof ApiError &&
    error.code !== "aborted" &&
    (isAnswerLost(error) ||
      (error.code !== "timeout" && error.status === 0) ||
      error.status === 408 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504)
  );
}

/**
 * Upload one file, riding out a flaky link or a busy store. Every attempt carries the same key,
 * name, type and bytes, so the Worker answers a repeat with the original receipt instead of
 * creating a second file. A "too many uploads" answer waits exactly as long as `Retry-After`
 * says; nothing in here knows or assumes how many uploads a window allows.
 */
export async function uploadEvidenceWithRetry(
  request: EvidenceUploadRequest,
  options: EvidenceRetryOptions = {},
): Promise<EvidenceUploadResult> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  let transientFailures = 0;
  let rateLimitWaits = 0;
  for (;;) {
    try {
      return await uploadEvidenceFile(request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      let wait: number | null = null;
      let reason: EvidenceWait["reason"] = "retry";
      if (error instanceof ApiError && error.status === 429) {
        rateLimitWaits += 1;
        if (rateLimitWaits > EVIDENCE_MAX_RATE_LIMIT_WAITS) throw error;
        wait = Math.min(
          Math.max(error.retryAfterMs ?? EVIDENCE_DEFAULT_WAIT_MS, 1_000),
          EVIDENCE_MAX_WAIT_MS,
        );
        reason = "rate_limit";
      } else if (isTransient(error)) {
        transientFailures += 1;
        if (transientFailures >= EVIDENCE_MAX_ATTEMPTS) throw error;
        wait = RETRY_BACKOFF_MS[Math.min(transientFailures, RETRY_BACKOFF_MS.length) - 1] ?? 3_000;
      }
      if (wait === null) throw error;
      options.onWait?.({ reason, until: now() + wait, ms: wait });
      try {
        await sleep(wait, request.signal);
      } finally {
        options.onWait?.(null);
      }
    }
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): ApiError {
  return new ApiError({
    status: 0,
    code: "aborted",
    message: "The request was cancelled.",
  });
}
