import { getDeviceSecret } from "../auth/device-credential";
import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import type { EvidenceSubmission } from "../evidence/evidence-uploads";
import { cacheFieldModel, getCachedFieldModel } from "../field/field-cache";
import {
  correctiveActionDetailSchema,
  correctiveActionResponseSchema,
  correctiveEvidenceSchema,
  type CorrectiveEvidence,
} from "../field/safety-contracts";
import { apiRequest, isRetryableApiError } from "../lib/api";
import { PlainError } from "../lib/plain-error";
import {
  getOutboxAction,
  listOutboxActionsByKind,
  queueOutboxAction,
  retryOutboxAction,
  saveOutboxAction,
} from "../storage/outbox";
import { outboxFailureGuidance } from "../storage/outbox-failure";
import { flushOutbox } from "../storage/outbox-processor";

const actionPath = (id: string) => `/api/v1/safety/corrective-actions/${encodeURIComponent(id)}`;

export async function loadCorrectiveAction(session: AuthenticatedSession, id: string) {
  const key = `${session.tenant.id}:${session.user.id}:corrective-action:${id}`;
  try {
    const response = await apiRequest({
      path: actionPath(id),
      schema: correctiveActionDetailSchema,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
    await cacheFieldModel(key, response, null);
    return { response, offline: false };
  } catch (error) {
    if (!isRetryableApiError(error)) throw error;
    const cached = correctiveActionDetailSchema.safeParse(await getCachedFieldModel(key));
    if (!cached.success) throw error;
    return { response: cached.data, offline: true };
  }
}

/**
 * Evidence this device has saved for the action and the server has not yet confirmed. Read on
 * every visit so a reload or a second opening of the page never invites the same evidence twice.
 */
export async function listQueuedCorrectiveEvidence(session: AuthenticatedSession, id: string) {
  const endpoint = `${actionPath(id)}/evidence`;
  const queued = await listOutboxActionsByKind(
    { tenantId: session.tenant.id, userId: session.user.id },
    "safety_corrective_evidence",
  );
  return queued.filter((action) => action.endpoint === endpoint);
}

/**
 * Saves what was fixed together with the files that show it, then sends it if there is signal.
 * The files are uploaded first, under the keys they were given, and the submission only goes up
 * with their confirmed receipts; with no signal everything waits on the device in the outbox.
 * A submission that carries a typed digest reference instead has no files to save.
 */
export async function queueCorrectiveEvidence(
  session: AuthenticatedSession,
  id: string,
  input: CorrectiveEvidence,
  evidence?: EvidenceSubmission,
) {
  const saved = await saveOutboxAction({
    tenantId: session.tenant.id,
    userId: session.user.id,
    kind: "safety_corrective_evidence",
    endpoint: `${actionPath(id)}/evidence`,
    payload: correctiveEvidenceSchema.parse(input),
    ...(evidence ? { evidence } : {}),
  });
  await queueOutboxAction(saved.deviceActionId);
  if (navigator.onLine && !isOfflineSession(session)) {
    await flushOutbox({
      tenantId: session.tenant.id,
      userId: session.user.id,
      csrfToken: session.csrf_token,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
  }
  const record = await getOutboxAction(saved.deviceActionId);
  if (!record)
    throw new PlainError(
      "The saved evidence could not be found on this device. Check Saved work before trying again.",
    );
  const guidance = record.state === "needs_attention" ? outboxFailureGuidance(record) : undefined;
  return {
    deviceActionId: record.deviceActionId,
    state: record.state,
    ...(evidence ? { fileCount: evidence.files.length } : {}),
    ...(guidance ? { guidance } : {}),
  };
}

/**
 * Sends a stopped submission again, the same saved item with the same files and keys, for a stop
 * that waiting out can clear (a slow link, a busy store). It never makes a copy.
 */
export async function retryQueuedCorrectiveEvidence(
  session: AuthenticatedSession,
  deviceActionId: string,
) {
  await retryOutboxAction(deviceActionId);
  if (navigator.onLine && !isOfflineSession(session)) {
    await flushOutbox({
      tenantId: session.tenant.id,
      userId: session.user.id,
      csrfToken: session.csrf_token,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
  }
}

export function decideCorrectiveAction(
  session: AuthenticatedSession,
  id: string,
  decision: "verify" | "reject" | "close",
  detail: string,
) {
  return apiRequest({
    path: `${actionPath(id)}/${decision === "close" ? "closure" : "verification"}`,
    method: "POST",
    csrfToken: session.csrf_token,
    body:
      decision === "close"
        ? { detail }
        : { detail, verdict: decision === "verify" ? "verified" : "rejected" },
    schema: correctiveActionResponseSchema,
  });
}
