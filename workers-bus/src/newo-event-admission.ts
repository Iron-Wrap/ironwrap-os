import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { NewoCallerAssociation, NewoSessionRecord } from "./newo-store.ts";

export interface NewoAdmissionInput {
  schema: "newo.admission.v1";
  event_id: string;
  session_id: string;
  event_type: string;
  occurred_at: string;
  reported_handoff_status: "requested" | "failed" | null;
  reported_urgency: "routine" | "urgent" | "emergency";
  event_has_contact: 0 | 1;
}

export interface NewoBusinessAdmission {
  event_id: string;
  tenant_id: string;
  session_id: string;
  event_type: string;
  payload_sha256: string;
  raw_key: string;
  occurred_at: string;
  envelope_id: string | null;
  callback_reason: "callback_requested" | "handoff_failed" | "session_failed" | null;
  effective_urgency: "routine" | "urgent" | "emergency" | null;
  effective_handoff_status: "requested" | "failed" | null;
  projected_status: string;
}

export function trustedNewoTenantId(env: Env): string {
  const value = env.APP_TENANT_ID;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value.trim())) {
    throw new Error("newo_tenant_identity_required");
  }
  return value.trim();
}

export function newoAdmissionJson(input: Omit<NewoAdmissionInput, "schema">): string {
  return canonicalJson({ schema: "newo.admission.v1", ...input });
}

/** A later caller is never authority to bind an old session. This read precedes raw/claim writes. */
export async function newoProducerTenantCheck(env: Env, sessionId: string): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: 404 | 409 | 503; error: string }
> {
  let tenantId: string;
  try { tenantId = trustedNewoTenantId(env); }
  catch { return { ok: false, status: 503, error: "newo_tenant_identity_required" }; }
  try {
    const session = await env.DB.prepare(
      "SELECT tenant_id, tenant_binding_state FROM newo_sessions WHERE session_id = ?",
    ).bind(sessionId).first<{ tenant_id: string | null; tenant_binding_state: string }>();
    if (session && (session.tenant_binding_state !== "bound" || !session.tenant_id)) {
      return { ok: false, status: 409, error: "newo_session_tenant_unresolved" };
    }
    if (session && session.tenant_id !== tenantId) {
      return { ok: false, status: 404, error: "newo_session_tenant_mismatch" };
    }
    return { ok: true, tenantId };
  } catch { return { ok: false, status: 503, error: "newo_tenant_schema_unavailable" }; }
}

const PROJECTION_COLUMNS = [
  "session_id", "project_id", "agent_id", "user_actor_id", "conversation_id", "channel", "direction",
  "status", "outcome", "contact_name", "contact_phone", "contact_email", "address_line1", "city", "province",
  "postal_code", "division", "service", "urgency", "lead_envelope_id", "appointment_request_id",
  "handoff_status", "booking_status", "summary", "transcript_ref", "recording_ref", "ai_disclosed",
  "recording_disclosed", "structured_json", "raw_key", "payload_hash", "started_at", "ended_at",
  "duration_seconds", "report_expected_at", "report_received_at", "report_event_id",
  "missing_report_detected_at", "sync_status", "sync_attempts", "last_error", "sync_updated_at", "created_at", "updated_at",
] as const satisfies readonly (keyof NewoSessionRecord)[];
const ASSOCIATION_COLUMNS = ["matched_customer_id", "matched_property_id", "matched_roof_job_id", "verification_status"] as const;
const DERIVED: Readonly<Record<string, string>> = {
  status: "admission.projected_status", urgency: "admission.effective_urgency",
  handoff_status: "admission.effective_handoff_status", lead_envelope_id: "admission.envelope_id",
  payload_hash: "admission.payload_sha256", raw_key: "admission.raw_key", updated_at: "admission.occurred_at",
};

function admissionInsert(
  env: Env, eventId: string, rec: NewoSessionRecord, association?: NewoCallerAssociation,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO newo_event_admissions (
      event_id, tenant_id, session_id, event_type, payload_sha256, raw_key, occurred_at, envelope_id,
      reported_handoff_status, reported_urgency, event_has_contact, prior_status, prior_handoff_status,
      prior_urgency, prior_has_contact, matched_customer_id, matched_property_id, matched_roof_job_id, verification_status
    ) SELECT receipt.event_id, receipt.tenant_id, receipt.session_id, receipt.event_type, receipt.payload_hash,
      receipt.raw_key, json_extract(receipt.admission_json, '$.occurred_at'),
      COALESCE(prior.lead_envelope_id, ?), json_extract(receipt.admission_json, '$.reported_handoff_status'),
      json_extract(receipt.admission_json, '$.reported_urgency'), json_extract(receipt.admission_json, '$.event_has_contact'),
      prior.status, prior.handoff_status, prior.urgency,
      CASE WHEN length(trim(COALESCE(prior.contact_phone, ''))) > 0
             OR length(trim(COALESCE(prior.contact_email, ''))) > 0 THEN 1 ELSE 0 END,
      CASE WHEN receipt.event_type = 'caller_lookup' THEN ? ELSE prior.matched_customer_id END,
      CASE WHEN receipt.event_type = 'caller_lookup' THEN ? ELSE prior.matched_property_id END,
      CASE WHEN receipt.event_type = 'caller_lookup' THEN ? ELSE prior.matched_roof_job_id END,
      CASE WHEN receipt.event_type = 'caller_lookup' THEN ? ELSE prior.verification_status END
      FROM newo_event_receipts receipt LEFT JOIN newo_sessions prior ON prior.session_id = receipt.session_id
     WHERE receipt.event_id = ? AND receipt.tenant_id = ? AND receipt.session_id = ?
       AND NOT EXISTS (SELECT 1 FROM newo_event_admissions existing WHERE existing.event_id = receipt.event_id)`)
    .bind(rec.lead_envelope_id, association?.matched_customer_id ?? null, association?.matched_property_id ?? null,
      association?.matched_roof_job_id ?? null, association?.verification_status ?? null,
      eventId, trustedNewoTenantId(env), rec.session_id);
}

function sessionInsert(env: Env, eventId: string, rec: NewoSessionRecord): D1PreparedStatement {
  const args: unknown[] = [];
  const expressions = PROJECTION_COLUMNS.map((name) => {
    if (DERIVED[name]) return DERIVED[name];
    args.push(rec[name] ?? null);
    return "?";
  });
  const columns = [...PROJECTION_COLUMNS, ...ASSOCIATION_COLUMNS,
    "tenant_id", "tenant_binding_state", "tenant_binding_source", "tenant_binding_ref", "last_event_id"];
  expressions.push(...ASSOCIATION_COLUMNS.map((name) => `admission.${name}`),
    "admission.tenant_id", "'bound'", "'producer'", "admission.event_id", "admission.event_id");
  return env.DB.prepare(`INSERT INTO newo_sessions (${columns.join(", ")})
    SELECT ${expressions.join(", ")} FROM newo_event_admissions admission
     WHERE admission.event_id = ? AND admission.tenant_id = ? AND admission.session_id = ?
       AND NOT EXISTS (SELECT 1 FROM newo_sessions existing WHERE existing.session_id = admission.session_id)`)
    .bind(...args, eventId, trustedNewoTenantId(env), rec.session_id);
}

function sessionUpdate(env: Env, eventId: string, rec: NewoSessionRecord, lookup: boolean): D1PreparedStatement {
  const args: unknown[] = [];
  const assignments: string[] = [];
  const lookupFields = new Set(["project_id", "agent_id", "contact_phone", "address_line1", "postal_code",
    "structured_json", "sync_status", "last_error", "sync_updated_at"]);
  const merge = new Set(["project_id", "agent_id", "user_actor_id", "conversation_id", "outcome", "contact_name",
    "contact_phone", "contact_email", "address_line1", "city", "province", "postal_code", "division", "service",
    "appointment_request_id", "booking_status", "summary", "transcript_ref", "recording_ref", "started_at", "ended_at", "duration_seconds"]);
  for (const name of PROJECTION_COLUMNS) {
    if (name === "session_id" || name === "created_at" || name === "sync_attempts") continue;
    if (DERIVED[name]) { assignments.push(`${name} = ${DERIVED[name]}`); continue; }
    if (lookup && !lookupFields.has(name)) continue;
    if (name === "sync_status") { assignments.push("sync_status = 'pending'"); continue; }
    if (name === "last_error") { assignments.push("last_error = NULL"); continue; }
    if (name === "report_event_id") {
      assignments.push("report_event_id = CASE WHEN admission.event_type IN ('session_ended', 'session_failed', 'missed_call') THEN admission.event_id ELSE session.report_event_id END");
      continue;
    }
    if (name === "missing_report_detected_at") {
      assignments.push("missing_report_detected_at = CASE WHEN admission.event_type IN ('session_ended', 'session_failed', 'missed_call') THEN NULL ELSE session.missing_report_detected_at END");
      continue;
    }
    if (name === "report_received_at") {
      assignments.push("report_received_at = CASE WHEN admission.event_type IN ('session_ended', 'session_failed', 'missed_call') THEN ? ELSE session.report_received_at END");
      args.push(rec[name]); continue;
    }
    if (lookup && ["contact_phone", "address_line1", "postal_code"].includes(name)) {
      assignments.push(`${name} = ?`);
    } else assignments.push(`${name} = ${merge.has(name) ? `COALESCE(?, session.${name})` : "?"}`);
    args.push(rec[name] ?? null);
  }
  assignments.push(...ASSOCIATION_COLUMNS.map((name) => `${name} = admission.${name}`), "last_event_id = admission.event_id");
  return env.DB.prepare(`UPDATE newo_sessions AS session SET ${assignments.join(", ")}
    FROM newo_event_admissions admission
   WHERE admission.event_id = ? AND admission.tenant_id = ? AND admission.session_id = ?
     AND session.session_id = admission.session_id AND session.tenant_id = admission.tenant_id
     AND session.tenant_binding_state = 'bound' AND admission.occurred_at >= session.updated_at`)
    .bind(...args, eventId, trustedNewoTenantId(env), rec.session_id);
}

function bounded(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? "";
  return text ? text.slice(0, max) : null;
}

async function callbackInsert(
  env: Env, eventId: string, rec: NewoSessionRecord, handoffSummary: string | null,
): Promise<D1PreparedStatement> {
  const tenant = trustedNewoTenantId(env);
  const callbackId = `ncb_${(await sha256Hex(`${tenant}:${rec.session_id}:newo-callback-record`)).slice(0, 32)}`;
  const fields = [
    ["contact_name", 160], ["contact_phone", 40], ["contact_email", 254], ["address_line1", 240],
    ["city", 120], ["province", 80], ["postal_code", 24],
  ] as const;
  return env.DB.prepare(`INSERT INTO newo_callback_records (
      callback_id, tenant_id, session_id, event_id, reason, urgency, handoff_summary,
      ${fields.map(([name]) => name).join(", ")}
    ) SELECT ?, admission.tenant_id, admission.session_id, admission.event_id, admission.callback_reason,
      COALESCE(admission.effective_urgency, 'routine'), ?,
      ${fields.map(([name, max]) => `COALESCE(?, substr(NULLIF(trim(session.${name}), ''), 1, ${max}))`).join(", ")}
      FROM newo_event_admissions admission JOIN newo_sessions session
        ON session.session_id = admission.session_id AND session.tenant_id = admission.tenant_id
     WHERE admission.event_id = ? AND admission.tenant_id = ? AND admission.session_id = ?
       AND admission.callback_reason IS NOT NULL AND session.tenant_binding_state = 'bound'
       AND NOT EXISTS (SELECT 1 FROM newo_callback_records existing
         WHERE existing.tenant_id = admission.tenant_id AND existing.session_id = admission.session_id)`)
    .bind(callbackId, bounded(handoffSummary, 1000), ...fields.map(([name, max]) => bounded(rec[name], max)),
      eventId, tenant, rec.session_id);
}

/** One owned business transaction; final transport acknowledgement remains a separate step. */
export async function writeAdmittedNewoSession(
  env: Env, rec: NewoSessionRecord, eventId: string, handoffSummary: string | null,
  association?: NewoCallerAssociation,
): Promise<NewoBusinessAdmission> {
  await env.DB.batch([
    admissionInsert(env, eventId, rec, association), sessionInsert(env, eventId, rec),
    sessionUpdate(env, eventId, rec, !!association), await callbackInsert(env, eventId, rec, handoffSummary),
  ]);
  const admission = await env.DB.prepare(
    "SELECT * FROM newo_event_admissions WHERE event_id = ? AND tenant_id = ? AND session_id = ?",
  ).bind(eventId, trustedNewoTenantId(env), rec.session_id).first<NewoBusinessAdmission>();
  if (!admission) throw new Error("newo_business_admission_readback_invalid");
  return admission;
}

export async function writeAdmittedNewoLookup(env: Env, association: NewoCallerAssociation): Promise<boolean> {
  const now = new Date().toISOString();
  const rec: NewoSessionRecord = {
    session_id: association.session_id, project_id: association.project_id, agent_id: association.agent_id,
    user_actor_id: null, conversation_id: null, channel: "phone", direction: "inbound", status: "caller_lookup", outcome: null,
    contact_name: null, contact_phone: association.contact_phone, contact_email: null,
    address_line1: association.address_line1, city: null, province: null, postal_code: association.postal_code,
    division: null, service: null, urgency: null, lead_envelope_id: null, appointment_request_id: null,
    handoff_status: null, booking_status: null, summary: null, transcript_ref: null, recording_ref: null,
    ai_disclosed: 0, recording_disclosed: 0, structured_json: association.structured_json,
    raw_key: association.raw_key, payload_hash: association.payload_hash, started_at: null, ended_at: null,
    duration_seconds: null, report_expected_at: null, report_received_at: null, report_event_id: null,
    missing_report_detected_at: null, sync_updated_at: now, sync_status: "pending", sync_attempts: 0,
    last_error: null, created_at: now, updated_at: association.occurred_at,
  };
  await writeAdmittedNewoSession(env, rec, association.event_id, null, association);
  const current = await env.DB.prepare(
    "SELECT last_event_id, payload_hash, updated_at FROM newo_sessions WHERE session_id = ? AND tenant_id = ? AND tenant_binding_state = 'bound'",
  ).bind(association.session_id, trustedNewoTenantId(env)).first<{ last_event_id: string; payload_hash: string; updated_at: string }>();
  return current?.last_event_id === association.event_id && current.payload_hash === association.payload_hash
    && current.updated_at === association.occurred_at;
}
