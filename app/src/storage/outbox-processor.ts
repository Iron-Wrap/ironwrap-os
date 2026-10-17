import { correctiveActionResponseSchema } from "../field/safety-contracts";
import { fleetCollisionResponseSchema } from "../field/fleet-contracts";
import { z } from "zod";

import { clearDeviceSecret, type DeviceProofProvider } from "../auth/device-credential";
import { evidenceProblemFor, isEvidenceSubmitCode } from "../evidence/evidence-messages";
import {
  evidenceRefFor,
  evidenceUploadResponseSchema,
  type EvidenceScope,
} from "../evidence/evidence-types";
import { evidenceTransferTimeoutMs } from "../evidence/evidence-upload";
import { API_PATHS } from "../lib/api-paths";

import { classifyOutboxFailure } from "./outbox-failure";
import {
  claimNextQueuedAction,
  getOutboxActionWithBlobs,
  markOutboxNeedsAttention,
  markOutboxVerified,
  OUTBOX_UPLOAD_HEARTBEAT_MS,
  recordOutboxEvidenceReceipt,
  recoverResumableOutboxActions,
  renewOutboxUploadLease,
  requeueOutboxAction,
} from "./outbox";
import type {
  JsonValue,
  OutboxAction,
  OutboxBlobRecord,
  OutboxConflict,
  OutboxErrorDetail,
} from "./outbox-types";

const verifiedResponseSchema = z.object({
  device_action_id: z.string().min(1),
  status: z.literal("verified"),
  server_ref: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

/**
 * The governed record-value route answers `{ outcome, value }`, not the field-action envelope
 * (`workers-bus/src/schema-forms-api.ts:427`). It predates the outbox and is used by online
 * callers too, so it is not going to grow a second shape to satisfy this client.
 *
 * Accepting its own answer costs nothing that the envelope was buying. What the envelope proves is
 * "the server verified THIS exact saved item", and here the same proof comes from the route's
 * idempotency: the upload sends `Idempotency-Key: <deviceActionId>`, so a first send and every
 * replay of it resolve to one value revision. `outcome: "replayed"` is that guarantee answering
 * out loud, which is why it counts as verified rather than as a duplicate.
 */
const schemaFieldValueResponseSchema = z.object({
  outcome: z.enum(["created", "replayed"]),
  value: z.object({ value_revision_id: z.string().min(1) }).passthrough(),
});

/** A file that has timed out this many attempts in a row is held for the person to retry. */
const EVIDENCE_SLOW_UPLOAD_ATTEMPTS = 3;

export interface FlushOutboxOptions {
  fetcher?: typeof fetch;
  csrfToken?: string | (() => string | undefined);
  deviceProof?: DeviceProofProvider;
  tenantId?: string;
  userId?: string;
  now?: () => number;
  random?: () => number;
  maxActions?: number;
  signal?: AbortSignal;
  /** Replaces the wait worked out from each file's size before it is tried again later. */
  evidenceTimeoutMs?: number;
}

export interface FlushOutboxResult {
  processed: number;
  verified: number;
  requeued: number;
  needsAttention: number;
}

interface UploadFailure {
  kind: "retry" | "attention" | "conflict";
  error: OutboxErrorDetail;
  retryAfterMs?: number;
  conflict?: OutboxConflict;
}

const activeFlushes = new Map<string, Promise<FlushOutboxResult>>();

export function flushOutbox(options: FlushOutboxOptions = {}): Promise<FlushOutboxResult> {
  const principal = principalFrom(options);
  if (!principal) return Promise.resolve(emptyResult());
  const key = `${principal.tenantId}\u0000${principal.userId}`;
  const active = activeFlushes.get(key);
  if (active) return active;
  const now = options.now ?? Date.now;
  const next = recoverResumableOutboxActions(principal, now())
    .then(() => executeFlush(options, principal))
    .finally(() => {
      activeFlushes.delete(key);
    });
  activeFlushes.set(key, next);
  return next;
}

export function initializeOutbox(options: FlushOutboxOptions = {}): Promise<FlushOutboxResult> {
  return flushOutbox(options);
}

async function executeFlush(
  options: FlushOutboxOptions,
  principal: { tenantId: string; userId: string },
): Promise<FlushOutboxResult> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const result = emptyResult();
  const maxActions = options.maxActions ?? 50;
  const csrfToken =
    typeof options.csrfToken === "function" ? options.csrfToken() : options.csrfToken;
  if (!csrfToken || csrfToken === "offline-session-no-csrf") return result;
  if (typeof navigator !== "undefined" && !navigator.onLine) return result;
  const deviceProof = await options.deviceProof?.();

  while (result.processed < maxActions && !options.signal?.aborted) {
    const action = await claimNextQueuedAction(principal, now());
    if (!action) break;
    result.processed += 1;
    const withBlobs = await getOutboxActionWithBlobs(action.deviceActionId);
    if (!withBlobs) continue;

    const stopLeaseHeartbeat = startUploadLeaseHeartbeat(action, now);
    let outcome: Awaited<ReturnType<typeof uploadAction>>;
    try {
      outcome = await uploadAction(
        withBlobs.action,
        withBlobs.blobs,
        options.fetcher ?? fetch,
        csrfToken,
        deviceProof,
        options.signal,
        now(),
        action.uploadLeaseId,
        options.evidenceTimeoutMs,
      );
    } finally {
      stopLeaseHeartbeat();
    }
    if (outcome.ok) {
      const verified = await markOutboxVerified(
        action.deviceActionId,
        {
          verifiedAt: now(),
          ...(outcome.serverRef ? { serverRef: outcome.serverRef } : {}),
          ...(outcome.cursor ? { cursor: outcome.cursor } : {}),
        },
        now(),
        action.uploadLeaseId,
      );
      if (verified) result.verified += 1;
      continue;
    }

    if (outcome.failure.kind === "retry") {
      const retryAt =
        now() + (outcome.failure.retryAfterMs ?? retryDelayMilliseconds(action.attempts, random));
      const requeued = await requeueOutboxAction(
        action.deviceActionId,
        { error: outcome.failure.error, nextAttemptAt: retryAt },
        now(),
        action.uploadLeaseId,
      );
      if (requeued) result.requeued += 1;
    } else {
      const needsAttention = await markOutboxNeedsAttention(
        action.deviceActionId,
        { error: outcome.failure.error, conflict: outcome.failure.conflict },
        now(),
        action.uploadLeaseId,
      );
      if (needsAttention) result.needsAttention += 1;
    }
  }
  return result;
}

function startUploadLeaseHeartbeat(
  action: OutboxAction & { uploadLeaseId: string },
  now: () => number,
): () => void {
  const interval = setInterval(() => {
    void renewOutboxUploadLease(action.deviceActionId, action.uploadLeaseId, now()).catch(() => {});
  }, OUTBOX_UPLOAD_HEARTBEAT_MS);
  return () => clearInterval(interval);
}

function principalFrom(options: FlushOutboxOptions): { tenantId: string; userId: string } | null {
  const tenantId = options.tenantId?.trim();
  const userId = options.userId?.trim();
  return tenantId && userId ? { tenantId, userId } : null;
}

function emptyResult(): FlushOutboxResult {
  return { processed: 0, verified: 0, requeued: 0, needsAttention: 0 };
}

async function uploadAction(
  action: OutboxAction,
  blobs: OutboxBlobRecord[],
  fetcher: typeof fetch,
  csrfToken: string,
  deviceProof: string | undefined,
  signal: AbortSignal | undefined,
  now: number,
  leaseId?: string,
  evidenceTimeoutMs?: number,
): Promise<
  { ok: true; serverRef?: string; cursor?: string } | { ok: false; failure: UploadFailure }
> {
  const headers = new Headers({
    Accept: "application/json",
    "Idempotency-Key": action.deviceActionId,
    "X-Device-Action-Id": action.deviceActionId,
    "X-CSRF-Token": csrfToken,
  });
  if (deviceProof) headers.set("X-IronWrap-Device-Proof", deviceProof);

  // Files first. The action is only sent once every file it carries has a confirmed receipt, so a
  // lost response, a retry or a second flush can never submit a file the Worker has not stored.
  // An item saved before files were uploaded has no files to send first: it goes out exactly as it
  // was saved (replay-safe under its own ids), and the Worker's own rule decides whether it is
  // still accepted.
  let receiptIds: string[] | undefined;
  if (carriesEvidence(action) && action.evidence) {
    const uploaded = await uploadQueuedEvidence({
      action,
      evidence: action.evidence,
      blobs,
      fetcher,
      csrfToken,
      deviceProof,
      signal,
      now,
      leaseId,
      timeoutMs: evidenceTimeoutMs,
    });
    if (!uploaded.ok) return uploaded;
    receiptIds = uploaded.receiptIds;
  }

  let body: BodyInit;
  if (
    action.kind === "inventory_command" ||
    action.kind === "inventory_scan" ||
    action.kind === "schema_field_value" ||
    action.kind === "safety_corrective_evidence" ||
    action.kind === "fleet_collision_report"
  ) {
    headers.set("Content-Type", "application/json");
    // Inventory routes accept the durable business-intent body directly.
    // Wrapping it in the generic field-action envelope would hide the
    // transition and make replay unverifiable. The record-value route is the
    // same case: its body IS the governed command the server fingerprints.
    body = JSON.stringify(
      receiptIds
        ? { ...(action.payload as Record<string, JsonValue>), evidence_receipt_ids: receiptIds }
        : action.payload,
    );
  } else if (action.attachments.length === 0 && action.kind !== "field_checkin") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({ device_action_id: action.deviceActionId, payload: action.payload });
  } else {
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        device_action_id: action.deviceActionId,
        payload: action.payload,
        attachments: action.attachments.map(({ blobKey: _blobKey, ...attachment }) => attachment),
      }),
    );
    for (const attachment of action.attachments) {
      const record = blobs.find((blob) => blob.blobKey === attachment.blobKey);
      if (!record) {
        return {
          ok: false,
          failure: attentionFailure(
            "attachment_missing",
            `Saved file ${attachment.fileName} is missing. Keep this item for office review.`,
            now,
          ),
        };
      }
      form.append("attachments", record.blob, attachment.fileName);
    }
    body = form;
  }

  let response: Response;
  try {
    response = await fetcher(action.endpoint, {
      method: action.method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body,
      signal,
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "retry",
        error: {
          code: signal?.aborted ? "upload_cancelled" : "network_error",
          message: signal?.aborted
            ? "Upload paused. It remains queued on this device."
            : "Signal dropped. The saved item will retry while the app is open.",
          occurredAt: now,
        },
      },
    };
  }

  if (response.ok) {
    if (action.kind === "fleet_collision_report") {
      // The route answers a first send and an exact replay alike with the stored record. Only that
      // record, for this exact report, settles the saved item.
      const answer = fleetCollisionResponseSchema.safeParse(await safeJson(response));
      const sent = action.payload as {
        collision_id: string;
        occurred_at: string;
        severity: string;
        description: string;
      };
      const record = answer.success ? answer.data.collision : undefined;
      if (
        !record ||
        record.collision_id !== sent.collision_id ||
        record.severity !== sent.severity ||
        record.description !== sent.description.trim() ||
        Date.parse(String(record.occurred_at)) !== Date.parse(sent.occurred_at)
      ) {
        return {
          ok: false,
          failure: attentionFailure(
            "verification_mismatch",
            "The server answered, but did not confirm this exact collision report. Nothing was discarded.",
            now,
            response.status,
          ),
        };
      }
      return { ok: true, serverRef: record.collision_id };
    }
    if (action.kind === "safety_corrective_evidence") {
      const responseBody = correctiveActionResponseSchema.safeParse(await safeJson(response));
      const expectedId = action.endpoint.split("/")[5];
      const record = responseBody.success ? responseBody.data.corrective_action : undefined;
      // The record must list exactly the files this device confirmed, no more and no fewer (or,
      // for an item saved before files were uploaded, exactly the reference and digest it sent).
      const confirmsEvidence = record
        ? receiptIds
          ? sameEvidenceRefs(record.evidence_refs_json, receiptIds)
          : sameSavedReference(record, action.payload)
        : false;
      if (
        !record ||
        encodeURIComponent(record.corrective_action_id) !== expectedId ||
        record.evidence_captured_by_user_id !== action.userId ||
        !confirmsEvidence ||
        record.state === "open"
      ) {
        return {
          ok: false,
          failure: attentionFailure(
            "verification_mismatch",
            "The server did not confirm this exact evidence. The saved submission remains on this device.",
            now,
            response.status,
          ),
        };
      }
      return {
        ok: true,
        serverRef: record.corrective_action_id,
        cursor: `${record.corrective_action_id}:${record.version}`,
      };
    }
    if (action.kind === "schema_field_value") {
      const value = schemaFieldValueResponseSchema.safeParse(await safeJson(response));
      if (!value.success) {
        return {
          ok: false,
          failure: attentionFailure(
            "verification_mismatch",
            "The server answered, but did not confirm this exact saved value. Nothing was discarded.",
            now,
            response.status,
          ),
        };
      }
      return { ok: true, serverRef: value.data.value.value_revision_id };
    }
    const parsed = verifiedResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success || parsed.data.device_action_id !== action.deviceActionId) {
      return {
        ok: false,
        failure: attentionFailure(
          "verification_mismatch",
          "The server answered, but did not verify this exact saved item. Nothing was discarded.",
          now,
          response.status,
        ),
      };
    }
    return {
      ok: true,
      ...(parsed.data.server_ref ? { serverRef: parsed.data.server_ref } : {}),
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    };
  }

  const payload = await safeJson(response);
  if (response.status === 401 && deviceProof) await clearDeviceSecret();
  const refusedCode = responseCode(payload) ?? `http_${response.status}`;
  // A refused file says so in everyday words; the Worker's code only picks the sentence.
  const message = isEvidenceSubmitCode(refusedCode)
    ? evidenceProblemFor({ status: response.status, code: refusedCode }).message
    : responseMessage(payload);
  // A file the Worker could not confirm is not the office copy changing underneath this item.
  if ((response.status === 409 || response.status === 412) && !isEvidenceSubmitCode(refusedCode)) {
    const status = response.status;
    const conflict: OutboxConflict = {
      status,
      code: refusedCode,
      message: message ?? "The office copy changed. Review both versions before retrying.",
      serverVersion: jsonValue(payload),
      detectedAt: now,
    };
    return {
      ok: false,
      failure: {
        kind: "conflict",
        error: {
          code: conflict.code,
          message: conflict.message,
          status,
          occurredAt: now,
        },
        conflict,
      },
    };
  }
  const code = refusedCode;
  // Status decides on its own, except where the code says the refusal is a rule this device
  // cannot satisfy. A constraint violation wrapped in a 5xx would otherwise retry for ever
  // behind a "Waiting" label the crew member reads as "still trying" (ELEC-211).
  if (classifyOutboxFailure({ status: response.status, code }) === "retryable") {
    return {
      ok: false,
      failure: {
        kind: "retry",
        error: {
          code,
          message: message ?? "The server is busy. This saved item will retry automatically.",
          status: response.status,
          occurredAt: now,
        },
        retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After"), now),
      },
    };
  }
  return {
    ok: false,
    failure: attentionFailure(
      code,
      message ?? "The office needs to review this saved item before it can sync.",
      now,
      response.status,
    ),
  };
}

function carriesEvidence(action: OutboxAction): boolean {
  return action.kind === "inventory_command" || action.kind === "safety_corrective_evidence";
}

/** The server's list of attached files holds exactly these receipts. Order does not matter. */
function sameEvidenceRefs(refsJson: string | null, receiptIds: readonly string[]): boolean {
  if (!refsJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(refsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const stored = parsed.map((entry) =>
    entry && typeof entry === "object" ? Reflect.get(entry, "ref") : undefined,
  );
  const expected = receiptIds.map(evidenceRefFor);
  return (
    stored.length === expected.length &&
    new Set(stored).size === stored.length &&
    expected.every((ref) => stored.includes(ref))
  );
}

/** An item saved before files were uploaded: the read-back must show the reference it carried. */
function sameSavedReference(
  record: { evidence_refs_json: string | null; evidence_sha256: string | null },
  payload: JsonValue,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const sent = payload as Record<string, JsonValue>;
  return (
    typeof sent.evidence_refs_json === "string" &&
    typeof sent.evidence_sha256 === "string" &&
    record.evidence_refs_json === sent.evidence_refs_json &&
    record.evidence_sha256 === sent.evidence_sha256
  );
}

type QueuedEvidenceOutcome =
  { ok: true; receiptIds: string[] } | { ok: false; failure: UploadFailure };

/**
 * Uploads each saved file that has no receipt yet, one at a time, under the key it was given when
 * it was chosen. Progress is recorded after every file, so a stop halfway resumes where it left
 * off, and a repeat of a file the Worker already holds returns its original receipt.
 */
async function uploadQueuedEvidence(input: {
  action: OutboxAction;
  evidence: NonNullable<OutboxAction["evidence"]>;
  blobs: OutboxBlobRecord[];
  fetcher: typeof fetch;
  csrfToken: string;
  deviceProof: string | undefined;
  signal: AbortSignal | undefined;
  now: number;
  leaseId: string | undefined;
  /** Replaces the wait worked out from the file's size. */
  timeoutMs: number | undefined;
}): Promise<QueuedEvidenceOutcome> {
  const { action, evidence, now, fetcher } = input;
  const receiptIds: string[] = [];
  for (const file of evidence.files) {
    if (file.receiptId) {
      receiptIds.push(file.receiptId);
      continue;
    }
    const saved = input.blobs.find((blob) => blob.attachmentId === file.attachmentId);
    if (!saved) {
      return {
        ok: false,
        failure: attentionFailure(
          "attachment_missing",
          `Saved file ${file.fileName} is missing. Keep this item for office review.`,
          now,
        ),
      };
    }
    const form = new FormData();
    form.append("purpose", evidence.scope.purpose);
    form.append("target_id", evidence.scope.targetId);
    form.append("action", evidence.scope.action);
    form.append("operation_id", evidence.scope.operationId);
    form.append(
      "file",
      new File([saved.blob], file.fileName, { type: file.mimeType }),
      file.fileName,
    );
    const headers = new Headers({
      Accept: "application/json",
      "Idempotency-Key": file.uploadKey,
      "X-CSRF-Token": input.csrfToken,
    });
    if (input.deviceProof) headers.set("X-IronWrap-Device-Proof", input.deviceProof);

    // A stalled connection must not hold the saved item for ever: after the timeout the file is
    // tried again later, under the same key. The wait grows with the file; a file that keeps
    // timing out stops with a plain reason instead of sending up to 8 MB again and again.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort("timeout");
      },
      input.timeoutMs ?? evidenceTransferTimeoutMs(file.size),
    );
    const forwardAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    // The timer and the abort stay armed until the whole answer has been read: a reply whose
    // headers arrive but whose body stalls must not hold the outbox and its lease for ever.
    const disarm = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", forwardAbort);
    };
    let response: Response;
    try {
      // Called on its own, not as `input.fetcher(...)`: a browser's `fetch` refuses to run with
      // any `this` other than the window ("Illegal invocation").
      response = await fetcher(API_PATHS.evidenceUploads, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch {
      disarm();
      if (timedOut && !input.signal?.aborted) {
        if (action.attempts >= EVIDENCE_SLOW_UPLOAD_ATTEMPTS) {
          return {
            ok: false,
            failure: attentionFailure(
              "upload_too_slow",
              "A file is taking too long to upload on this connection.",
              now,
              408,
            ),
          };
        }
        return {
          ok: false,
          failure: {
            kind: "retry",
            error: {
              code: "upload_timeout",
              message: "The upload is slow. The saved item will try again by itself.",
              occurredAt: now,
            },
          },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "retry",
          error: {
            code: input.signal?.aborted ? "upload_cancelled" : "network_error",
            message: input.signal?.aborted
              ? "Upload paused. It remains queued on this device."
              : "Signal dropped. The saved item will retry while the app is open.",
            occurredAt: now,
          },
        },
      };
    }

    let payload: unknown;
    let answerLost = false;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      // A body that stalls past the timeout, breaks off, or arrives truncated.
      answerLost = true;
    } finally {
      disarm();
    }

    if (response.ok && answerLost) {
      // The file may already be stored. Sending the same bytes under the same key again makes the
      // Worker answer with the receipt it already holds, so this is a retry, never a new upload.
      if (input.signal?.aborted) {
        return {
          ok: false,
          failure: {
            kind: "retry",
            error: {
              code: "upload_cancelled",
              message: "Upload paused. It remains queued on this device.",
              occurredAt: now,
            },
          },
        };
      }
      if (action.attempts >= EVIDENCE_SLOW_UPLOAD_ATTEMPTS) {
        return {
          ok: false,
          failure: attentionFailure(
            "upload_unconfirmed",
            "The office did not confirm a file after several tries.",
            now,
            response.status,
          ),
        };
      }
      return {
        ok: false,
        failure: {
          kind: "retry",
          error: {
            code: "response_lost",
            message: "The answer to an upload was lost. The saved item will check again by itself.",
            status: response.status,
            occurredAt: now,
          },
        },
      };
    }

    if (!response.ok) {
      if (response.status === 401 && input.deviceProof) await clearDeviceSecret();
      const code = responseCode(payload) ?? `http_${response.status}`;
      const problem = evidenceProblemFor({ status: response.status, code });
      if (classifyOutboxFailure({ status: response.status, code }) === "retryable") {
        return {
          ok: false,
          failure: {
            kind: "retry",
            error: {
              code,
              message:
                response.status === 429
                  ? "Too many uploads right now. This saved item will try again by itself."
                  : "The server is busy. This saved item will retry automatically.",
              status: response.status,
              occurredAt: now,
            },
            retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After"), now),
          },
        };
      }
      // A refused file is kept, never dropped; the person decides what to do with it.
      return {
        ok: false,
        failure: attentionFailure(code, problem.message, now, response.status),
      };
    }

    const confirmed = evidenceUploadResponseSchema.safeParse(payload);
    const receipt = confirmed.success ? confirmed.data.receipt : undefined;
    if (!receipt || !receiptMatchesScope(receipt, evidence.scope)) {
      return {
        ok: false,
        failure: attentionFailure(
          "verification_mismatch",
          "The server did not confirm this exact file. The saved item remains on this device.",
          now,
          response.status,
        ),
      };
    }
    const recorded = await recordOutboxEvidenceReceipt(
      action.deviceActionId,
      file.uploadKey,
      receipt.receipt_id,
      now,
      input.leaseId,
    );
    if (!recorded) {
      // Another tab took this item over. Leave it to them; a repeat upload is harmless.
      return {
        ok: false,
        failure: {
          kind: "retry",
          error: {
            code: "upload_interrupted",
            message: "Upload was interrupted. It is queued safely for another try.",
            occurredAt: now,
          },
        },
      };
    }
    receiptIds.push(receipt.receipt_id);
  }
  return { ok: true, receiptIds };
}

function receiptMatchesScope(
  receipt: { purpose: string; target_id: string; action: string; operation_id: string },
  scope: EvidenceScope,
): boolean {
  return (
    receipt.purpose === scope.purpose &&
    receipt.target_id === scope.targetId &&
    receipt.action === scope.action &&
    receipt.operation_id === scope.operationId
  );
}

export function retryDelayMilliseconds(attempts: number, random = Math.random): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
  return base + Math.floor(random() * 1_000);
}

function attentionFailure(
  code: string,
  message: string,
  occurredAt: number,
  status?: number,
): UploadFailure {
  return {
    kind: "attention",
    error: { code, message, occurredAt, ...(status === undefined ? {} : { status }) },
  };
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function responseCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = Reflect.get(value, "code") ?? Reflect.get(value, "error");
  return typeof code === "string" ? code : undefined;
}

function responseMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = Reflect.get(value, "message");
  return typeof message === "string" ? message : undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  try {
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JsonValue);
  } catch {
    return undefined;
  }
}
