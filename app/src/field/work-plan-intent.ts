import { ApiError } from "../lib/api";
import { deleteMeta, getMeta, setMeta } from "../storage/db";
import type { JsonValue } from "../storage/outbox-types";

/**
 * Start work and Finish work go straight to the office, never through saved work. When the answer
 * to one is lost (no connection, a timeout, a server fault), the work may already have started or
 * finished. A second press with a new device action ID would then be a second, different request
 * against a possibly stale plan.
 *
 * So the phone keeps the request exactly as sent, on the device like the outbox keeps its items,
 * until the office gives a definite answer. The next press resends it unchanged: same device action
 * ID, same idempotency key, same body. The Worker replays its recorded answer for a device action ID
 * it has already verified (`workers-bus/src/work-package-actions.ts`), so the work cannot start or
 * finish twice. A kept request is only ever resent against the plan it was built from: once a fresh
 * read shows a different plan (a new version, release or status), it is dropped, never replayed.
 */
export interface WorkPlanIntent {
  deviceActionId: string;
  path: string;
  body: { device_action_id: string; payload: JsonValue };
  /** The plan the request was built from (`workPlanIdentity`). */
  plan: string;
  createdAt: number;
}

/** What makes a plan the same plan for a resend: which one, which version, which release, where. */
export function workPlanIdentity(plan: {
  id: string;
  version: number;
  release_attempt_id?: string | null;
  status: string;
}): string {
  return JSON.stringify([plan.id, plan.version, plan.release_attempt_id ?? null, plan.status]);
}

export function workPlanIntentKey(
  principal: { tenantId: string; userId: string },
  path: string,
): string {
  return `work-plan-intent:${principal.tenantId}:${principal.userId}:${path}`;
}

/** The kept request for this plan, if any. One kept for a different plan is dropped. */
export async function keptWorkPlanIntent(
  key: string,
  plan: string,
): Promise<WorkPlanIntent | undefined> {
  const intent = await getMeta<WorkPlanIntent>(key);
  if (!intent) return undefined;
  if (intent.plan === plan) return intent;
  await deleteMeta(key);
  return undefined;
}

export async function keepWorkPlanIntent(key: string, intent: WorkPlanIntent): Promise<void> {
  await setMeta(key, intent);
}

export async function dropWorkPlanIntent(key: string): Promise<void> {
  await deleteMeta(key);
}

/** How long the Worker asks a phone to wait when the same request is still being processed. */
const IN_PROGRESS_WAIT_MS = 5_000;

/**
 * What a failed send means for the kept request (`resend`: it was already kept when this press
 * began, so an earlier send of it may have committed).
 *
 * - `drop`: a definite answer. The office refused the action itself (a domain refusal, or 409
 *   `idempotency_conflict`: this ID already belongs to a different request), so a new press is a new
 *   request. A 401 or 403 on a request sent for the first time is definite too: it never ran.
 * - `keep`: no definite answer. A lost answer or server fault, or a 401/403 (session ended, stale
 *   session token, role changed) on a resend: the Worker checks the session before it replays a
 *   verified answer, so the first send may still have committed. The exact request waits for the
 *   person to sign in again.
 * - `wait`: 503 `action_in_progress`, the same request is still being processed; send it again
 *   unchanged after the Worker's `Retry-After`.
 */
export function afterFailedSend(
  error: unknown,
  resend: boolean,
): "drop" | "keep" | { waitMs: number } {
  if (!(error instanceof ApiError)) return "keep";
  if (error.code === "action_in_progress") {
    return { waitMs: error.retryAfterMs ?? IN_PROGRESS_WAIT_MS };
  }
  if (error.status === 401 || error.status === 403) return resend ? "keep" : "drop";
  if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return "drop";
  }
  return "keep";
}
