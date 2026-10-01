import {
  classifyIntent,
  dedupKey,
  newEnvelopeId,
  normalizeEnvelope,
  parseBody,
  validateInbound,
  type EnvelopeRecord,
} from "./core.ts";
import { materializeOperatingCore, type OperatingCoreResult } from "./operating-core.ts";
import * as store from "./store.ts";

const ESTIMATE_OPERATING_RETRY_BATCH_SIZE = 25;
const OPERATING_RETRY_PREFIX = "native_operating_core:retry:";
const OPERATING_TERMINAL_PREFIX = "native_operating_core:terminal:";

type OperatingTrigger = "estimator" | "idempotent_replay" | "scheduled_retry";
type OperatingAttempt =
  | { ok: true; value: OperatingCoreResult }
  | { ok: false; retryable: boolean };

export async function handleEstimateIngest(
  env: Env,
  rawText: string,
  contentType: string | null,
  requestIdempotencyKey?: string | null,
  // Release-smoke scope (IRO-264). This path has no acknowledgement email and no
  // JobNimbus queue push, so the scope only marks the row; the native
  // materialization is an owned write and still runs.
  releaseSmoke = false,
): Promise<Response> {
  const raw = parseBody(rawText, contentType);
  const payload = normalizeEstimatorPayload(raw);
  const estimateSubmissionKey = estimateIdempotencyKey(payload, requestIdempotencyKey);
  if (estimateSubmissionKey) {
    const existing = await store.findEstimateSubmission(env, estimateSubmissionKey);
    if (existing) return await idempotentEstimateResponse(env, existing);
  }

  const id = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/estimates/${now.slice(0, 10)}/${id}.json`;

  await store.putRaw(env, rawKey, rawText, contentType ?? "application/json");

  const envelope = normalizeEnvelope("website", payload, now);
  const valid = validateInbound(envelope);
  const rec: EnvelopeRecord = {
    envelope_id: id,
    source: "website",
    contact_name: envelope.contact.name ?? null,
    contact_phone: envelope.contact.phone ?? null,
    contact_email: envelope.contact.email ?? null,
    job_ref: envelope.job_ref,
    payload_json: JSON.stringify(envelope.payload),
    raw_key: rawKey,
    ts: now,
    status: "received",
    dedup_key: dedupKey(envelope.contact),
    dup_of: null,
    attempts: 0,
    last_error: valid.ok ? null : valid.reason ?? null,
    jn_contact_id: null,
    jn_job_id: null,
    estimate_submission_key: estimateSubmissionKey,
    intent_queue: classifyIntent(`${payload.service ?? ""} ${payload.service_intent ?? ""}`),
    release_smoke: releaseSmoke ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  try {
    await store.insertEnvelope(env, rec);
  } catch (err) {
    if (estimateSubmissionKey && isUniqueConstraintError(err)) {
      const existing = await store.findEstimateSubmission(env, estimateSubmissionKey);
      if (existing) return await idempotentEstimateResponse(env, existing);
    }
    throw err;
  }
  await store.recordAudit(env, {
    automation: "estimate",
    trigger: "estimator",
    envelope_id: id,
    action: "received",
    result: valid.ok ? "ok" : "error",
    error: rec.last_error,
  });

  if (!valid.ok) return json({ envelope_id: id, error: valid.reason }, 400);

  const operating = await tryMaterializeEstimate(env, rec, "estimator");
  return operating.ok
    ? operatingResponse(id, operating.value)
    : operating.retryable
      ? retryPendingResponse(id)
      : rejectedResponse(id);
}

/**
 * Re-drive durably accepted estimator submissions whose native operating graph is incomplete.
 * Unlike lead intake, estimator submissions have no JobNimbus queue to trigger a later retry.
 */
export async function retryEstimateOperatingCoreMaterializations(env: Env): Promise<void> {
  const thresholdMin = retryThresholdMinutes(env);
  const candidates = await store.listRetryableEstimateOperatingCoreMaterializations(
    env,
    thresholdMin,
    ESTIMATE_OPERATING_RETRY_BATCH_SIZE,
  );

  for (const rec of candidates) {
    await tryMaterializeEstimate(env, rec, "scheduled_retry");
  }
}

function normalizeEstimatorPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const projectId = raw.estimate_project_id ?? raw.project_id ?? raw.projectId ?? raw.id;
  return {
    ...raw,
    source_detail: raw.source_detail ?? "ironwrap_3d_configurator",
    instant_estimate: true,
    estimate_type: "instant",
    ...(typeof projectId === "string" && projectId.trim() ? { estimate_project_id: projectId.trim() } : {}),
    ...(raw.job_ref ?? raw.job_number ?? raw.jobNumber ? {} : typeof projectId === "string" && projectId.trim() ? { job_ref: projectId.trim() } : {}),
    service: raw.service ?? raw.service_type ?? serviceText(raw),
  };
}

function estimateIdempotencyKey(payload: Record<string, unknown>, requestKey?: string | null): string | null {
  const projectKey = cleanKey(payload.estimate_project_id ?? payload.project_id ?? payload.projectId ?? payload.configurator_project_id);
  if (projectKey) return `estimate:project:${projectKey}`;
  const explicitKey = cleanKey(requestKey);
  if (explicitKey) return `estimate:request:${explicitKey}`;
  const urlKey = cleanKey(payload.project_url ?? payload.configurator_url ?? payload.url);
  return urlKey ? `estimate:url:${urlKey}` : null;
}

function cleanKey(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  return value ? value.slice(0, 160) : null;
}

async function idempotentEstimateResponse(env: Env, rec: EnvelopeRecord): Promise<Response> {
  if (rec.last_error && !isOperatingError(rec.last_error)) {
    await store.recordAudit(env, {
      automation: "estimate",
      trigger: "estimator",
      envelope_id: rec.envelope_id,
      action: "idempotent_replay",
      result: "error",
      error: rec.last_error,
    });
    return json({
      envelope_id: rec.envelope_id,
      idempotent_replay: true,
      error: rec.last_error,
    }, 400);
  }
  const operating = await tryMaterializeEstimate(env, rec, "idempotent_replay");
  return operating.ok
    ? operatingResponse(rec.envelope_id, operating.value, true)
    : operating.retryable
      ? retryPendingResponse(rec.envelope_id, true)
      : rejectedResponse(rec.envelope_id, true);
}

async function tryMaterializeEstimate(
  env: Env,
  rec: EnvelopeRecord,
  trigger: OperatingTrigger,
): Promise<OperatingAttempt> {
  try {
    const operating = await materializeOperatingCore(env, rec);
    await recordEstimateOperatingCoreSuccess(env, rec, operating, trigger);
    return { ok: true, value: operating };
  } catch (error) {
    const retryable = !terminalOperatingError(error);
    const prefix = retryable ? OPERATING_RETRY_PREFIX : OPERATING_TERMINAL_PREFIX;
    await recordEstimateOperatingCoreFailure(env, rec, trigger, `${prefix} ${String(error)}`);
    return { ok: false, retryable };
  }
}

async function recordEstimateOperatingCoreSuccess(
  env: Env,
  rec: EnvelopeRecord,
  operating: OperatingCoreResult,
  trigger: OperatingTrigger,
): Promise<void> {
  await store.setStatus(env, rec.envelope_id, rec.status, { last_error: null });
  await store.recordAudit(env, {
    automation: "estimate_operating_core",
    trigger,
    envelope_id: rec.envelope_id,
    target_ids: [
      `lead:${operating.leadId}`,
      `customer:${operating.customerId}`,
      operating.propertyId ? `property:${operating.propertyId}` : null,
      `roof_job:${operating.roofJobId}`,
      operating.instantEstimateId ? `instant_estimate:${operating.instantEstimateId}` : null,
    ].filter(Boolean).join(","),
    action: trigger === "scheduled_retry"
      ? (operating.reused ? "retry_readback" : "retry_materialize")
      : trigger === "idempotent_replay"
        ? "idempotent_readback"
        : (operating.reused ? "readback" : "materialize"),
    result: "ok",
  });
}

async function recordEstimateOperatingCoreFailure(
  env: Env,
  rec: EnvelopeRecord,
  trigger: OperatingTrigger,
  error: string,
): Promise<void> {
  const attempt = await store.bumpAttempt(env, rec.envelope_id, error);
  await store.recordAudit(env, {
    automation: "estimate_operating_core",
    trigger,
    envelope_id: rec.envelope_id,
    action: trigger === "scheduled_retry" ? `retry_attempt_${attempt}` : `materialize_attempt_${attempt}`,
    result: "error",
    error,
    recovery_owner: env.OWNER_ALERT_EMAIL,
  });
}

function operatingResponse(
  envelopeId: string,
  operating: OperatingCoreResult,
  idempotentReplay = false,
): Response {
  return json({
    ok: true,
    envelope_id: envelopeId,
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
    operating_lead_id: operating.leadId,
    operating_customer_id: operating.customerId,
    operating_property_id: operating.propertyId,
    operating_roof_job_id: operating.roofJobId,
    operating_instant_estimate_id: operating.instantEstimateId,
  });
}

function retryPendingResponse(envelopeId: string, idempotentReplay = false): Response {
  return json({
    accepted: true,
    completed: false,
    envelope_id: envelopeId,
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
    operating_core_status: "retry_pending",
  }, 202);
}

function rejectedResponse(envelopeId: string, idempotentReplay = false): Response {
  return json({
    accepted: false,
    completed: false,
    envelope_id: envelopeId,
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
    error: "native_operating_core_rejected",
  }, 422);
}

function isOperatingError(error: string): boolean {
  return error.startsWith(OPERATING_RETRY_PREFIX) || error.startsWith(OPERATING_TERMINAL_PREFIX);
}

function terminalOperatingError(error: unknown): boolean {
  const detail = String(error);
  return detail.includes("operating_core_") &&
    !detail.includes("operating_core_db_missing") &&
    !detail.includes("operating_core_tenant_invalid");
}

function retryThresholdMinutes(env: Env): number {
  const configured = Number(env.STUCK_THRESHOLD_MIN ?? "15");
  return Number.isFinite(configured) && configured > 0 ? configured : 15;
}

function isUniqueConstraintError(err: unknown): boolean {
  return /unique|constraint/i.test(String(err));
}

function serviceText(raw: Record<string, unknown>): string {
  const services = raw.selected_services ?? raw.services;
  return Array.isArray(services) ? services.filter((x) => typeof x === "string").join(" ") : "metal roof siding";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
