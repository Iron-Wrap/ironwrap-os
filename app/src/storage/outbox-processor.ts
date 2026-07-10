import { z } from "zod";

import {
  claimNextQueuedAction,
  getOutboxActionWithBlobs,
  markOutboxNeedsAttention,
  markOutboxVerified,
  recoverInterruptedUploads,
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

export interface FlushOutboxOptions {
  fetcher?: typeof fetch;
  csrfToken?: string | (() => string | undefined);
  now?: () => number;
  random?: () => number;
  maxActions?: number;
  signal?: AbortSignal;
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

let activeFlush: Promise<FlushOutboxResult> | undefined;

export function flushOutbox(options: FlushOutboxOptions = {}): Promise<FlushOutboxResult> {
  activeFlush ??= executeFlush(options).finally(() => {
    activeFlush = undefined;
  });
  return activeFlush;
}

export async function initializeOutbox(
  options: FlushOutboxOptions = {},
): Promise<FlushOutboxResult> {
  await recoverInterruptedUploads(options.now?.() ?? Date.now());
  return flushOutbox(options);
}

async function executeFlush(options: FlushOutboxOptions): Promise<FlushOutboxResult> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const result: FlushOutboxResult = { processed: 0, verified: 0, requeued: 0, needsAttention: 0 };
  const maxActions = options.maxActions ?? 50;
  const csrfToken =
    typeof options.csrfToken === "function" ? options.csrfToken() : options.csrfToken;
  if (!csrfToken || csrfToken === "offline-session-no-csrf") return result;
  if (typeof navigator !== "undefined" && !navigator.onLine) return result;

  while (result.processed < maxActions && !options.signal?.aborted) {
    const action = await claimNextQueuedAction(now());
    if (!action) break;
    result.processed += 1;
    const withBlobs = await getOutboxActionWithBlobs(action.deviceActionId);
    if (!withBlobs) continue;

    const outcome = await uploadAction(
      withBlobs.action,
      withBlobs.blobs,
      options.fetcher ?? fetch,
      csrfToken,
      options.signal,
      now(),
    );
    if (outcome.ok) {
      await markOutboxVerified(
        action.deviceActionId,
        {
          verifiedAt: now(),
          ...(outcome.serverRef ? { serverRef: outcome.serverRef } : {}),
          ...(outcome.cursor ? { cursor: outcome.cursor } : {}),
        },
        now(),
      );
      result.verified += 1;
      continue;
    }

    if (outcome.failure.kind === "retry") {
      const retryAt =
        now() + (outcome.failure.retryAfterMs ?? retryDelayMilliseconds(action.attempts, random));
      await requeueOutboxAction(
        action.deviceActionId,
        { error: outcome.failure.error, nextAttemptAt: retryAt },
        now(),
      );
      result.requeued += 1;
    } else {
      await markOutboxNeedsAttention(
        action.deviceActionId,
        { error: outcome.failure.error, conflict: outcome.failure.conflict },
        now(),
      );
      result.needsAttention += 1;
    }
  }
  return result;
}

async function uploadAction(
  action: OutboxAction,
  blobs: OutboxBlobRecord[],
  fetcher: typeof fetch,
  csrfToken: string,
  signal: AbortSignal | undefined,
  now: number,
): Promise<
  { ok: true; serverRef?: string; cursor?: string } | { ok: false; failure: UploadFailure }
> {
  const headers = new Headers({
    Accept: "application/json",
    "Idempotency-Key": action.deviceActionId,
    "X-Device-Action-Id": action.deviceActionId,
    "X-CSRF-Token": csrfToken,
  });
  let body: BodyInit;
  if (action.attachments.length === 0) {
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
  const message = responseMessage(payload);
  if (response.status === 409 || response.status === 412) {
    const status = response.status;
    const conflict: OutboxConflict = {
      status,
      code: responseCode(payload) ?? `http_${status}`,
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
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      failure: {
        kind: "retry",
        error: {
          code: responseCode(payload) ?? `http_${response.status}`,
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
      responseCode(payload) ?? `http_${response.status}`,
      message ?? "The office needs to review this saved item before it can sync.",
      now,
      response.status,
    ),
  };
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
