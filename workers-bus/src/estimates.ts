import {
  classifyIntent,
  dedupKey,
  newEnvelopeId,
  normalizeEnvelope,
  parseBody,
  validateInbound,
  type EnvelopeRecord,
} from "./core.ts";
import { pushToErpNext } from "./erpnext.ts";
import * as store from "./store.ts";

export async function handleEstimateIngest(
  env: Env,
  rawText: string,
  contentType: string | null,
  requestIdempotencyKey?: string | null,
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

  try {
    const erp = await pushToErpNext(env, rec);
    if (erp) {
      await store.setErpNextSync(env, id, {
        leadEnvelopeId: erp.name,
        roofingPropertyId: erp.roofingPropertyName ?? null,
        roofJobId: erp.roofJobName ?? null,
        instantEstimateSessionId: erp.instantEstimateSessionName ?? null,
      });
      await store.recordAudit(env, {
        automation: "erpnext_estimate",
        trigger: "estimator",
        envelope_id: id,
        target_ids: [
          `lead_envelope:${erp.name}`,
          erp.roofingPropertyName ? `roofing_property:${erp.roofingPropertyName}` : null,
          erp.roofJobName ? `roof_job:${erp.roofJobName}` : null,
          erp.instantEstimateSessionName ? `instant_estimate:${erp.instantEstimateSessionName}` : null,
        ].filter(Boolean).join(","),
        action: erp.reused ? "upsert_existing" : "create",
        result: "ok",
      });
    }
    return json({
      ok: true,
      envelope_id: id,
      erpnext_lead_envelope_id: erp?.name ?? null,
      erpnext_roof_job_id: erp?.roofJobName ?? null,
      erpnext_instant_estimate_id: erp?.instantEstimateSessionName ?? null,
    });
  } catch (err) {
    const error = `erpnext_estimate: ${String(err)}`;
    await store.setErpNextError(env, id, error).catch(() => {});
    await store.recordAudit(env, {
      automation: "erpnext_estimate",
      trigger: "estimator",
      envelope_id: id,
      action: "push",
      result: "error",
      error,
    });
    return json({ ok: true, envelope_id: id, erpnext_error: error });
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
  await store.recordAudit(env, {
    automation: "estimate",
    trigger: "estimator",
    envelope_id: rec.envelope_id,
    action: "idempotent_replay",
    result: "ok",
  });
  if (rec.last_error) {
    return json({
      envelope_id: rec.envelope_id,
      idempotent_replay: true,
      error: rec.last_error,
    }, 400);
  }
  return json({
    ok: true,
    envelope_id: rec.envelope_id,
    idempotent_replay: true,
    erpnext_lead_envelope_id: rec.erpnext_lead_envelope_id ?? null,
    erpnext_roof_job_id: rec.erpnext_roof_job_id ?? null,
    erpnext_instant_estimate_id: rec.erpnext_instant_estimate_session_id ?? null,
  });
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
