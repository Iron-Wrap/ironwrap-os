import { trustedNewoTenantId, writeAdmittedNewoLookup, writeAdmittedNewoSession, type NewoBusinessAdmission } from "./newo-event-admission.ts";

export type NewoReceiptStatus = "processing" | "accepted" | "failed" | "dead";

export interface NewoEventReceipt {
  tenant_id: string | null;
  admission_json: string | null;
  event_id: string;
  session_id: string;
  event_type: string;
  payload_hash: string;
  raw_key: string;
  envelope_id: string | null;
  status: NewoReceiptStatus;
  response_json: string;
  attempts: number;
  last_error: string | null;
  first_seen_at: string;
  last_seen_at: string;
  completed_at: string | null;
}

export interface NewoSessionRecord {
  tenant_id?: string | null;
  tenant_binding_state?: "bound" | "unbound" | "conflict";
  tenant_binding_source?: string;
  tenant_binding_ref?: string | null;
  last_event_id?: string | null;
  session_id: string;
  project_id: string | null;
  agent_id: string | null;
  user_actor_id: string | null;
  conversation_id: string | null;
  channel: "phone" | "chat";
  direction: "inbound" | "outbound";
  status: string;
  outcome: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  matched_customer_id?: string | null;
  matched_property_id?: string | null;
  matched_roof_job_id?: string | null;
  verification_status?: string | null;
  division: string | null;
  service: string | null;
  urgency: string | null;
  lead_envelope_id: string | null;
  appointment_request_id: string | null;
  handoff_status: string | null;
  booking_status: string | null;
  summary: string | null;
  transcript_ref: string | null;
  recording_ref: string | null;
  ai_disclosed: number;
  recording_disclosed: number;
  structured_json: string;
  raw_key: string;
  payload_hash: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  report_expected_at: string | null;
  report_received_at: string | null;
  report_event_id: string | null;
  missing_report_detected_at: string | null;
  sync_updated_at: string | null;
  sync_status: "pending" | "synced" | "failed" | "dead";
  sync_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewoCallerAssociation {
  event_id: string;
  session_id: string;
  project_id: string | null;
  agent_id: string | null;
  contact_phone: string;
  address_line1: string | null;
  postal_code: string | null;
  matched_customer_id: string | null;
  matched_property_id: string | null;
  matched_roof_job_id: string | null;
  verification_status: "verified" | "not_found" | "verification_failed" | "ambiguous";
  structured_json: string;
  raw_key: string;
  payload_hash: string;
  occurred_at: string;
}

export interface NewoReconciliationRun {
  run_id: string;
  run_type: "five_minute" | "daily";
  status: "ok" | "degraded" | "failed";
  ran_at: string;
  retryable_syncs_requeued: number;
  missing_reports: number;
  failed_handoffs: number;
  pending_bookings: number;
  unresolved_incidents: number | null;
  drift_reasons_json: string;
  usage_status: "not_checked" | "within_limit" | "threshold_exceeded" | "unavailable_from_documented_api";
  usage_minutes: number | null;
  usage_limit_minutes: number | null;
  detail_json: string;
}

export async function recordNewoCallerAssociation(
  env: Env, association: NewoCallerAssociation,
): Promise<boolean> {
  return await writeAdmittedNewoLookup(env, association);
}

export async function getNewoReceipt(
  env: Env,
  eventId: string,
): Promise<NewoEventReceipt | null> {
  return await env.DB.prepare(
    "SELECT * FROM newo_event_receipts WHERE event_id = ?",
  ).bind(eventId).first<NewoEventReceipt>();
}

export async function claimNewoReceipt(
  env: Env,
  input: Pick<NewoEventReceipt, "event_id" | "session_id" | "event_type" | "payload_hash" | "raw_key" | "admission_json">,
  now: string,
): Promise<"claimed" | "existing"> {
  const result = await env.DB.prepare(
    `INSERT INTO newo_event_receipts
      (event_id, session_id, event_type, payload_hash, raw_key, tenant_id, admission_json, status, response_json,
       attempts, first_seen_at, last_seen_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, 'processing', '{}', 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM newo_event_receipts existing WHERE existing.event_id = ?)`,
  ).bind(
    input.event_id,
    input.session_id,
    input.event_type,
    input.payload_hash,
    input.raw_key,
    trustedNewoTenantId(env),
    input.admission_json,
    now,
    now,
    input.event_id,
  ).run();
  return Number(result.meta?.changes ?? 0) === 1 ? "claimed" : "existing";
}

export async function restartFailedNewoReceipt(
  env: Env,
  eventId: string,
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE newo_event_receipts
        SET status = 'processing', attempts = attempts + 1, last_error = NULL,
            last_seen_at = ?, completed_at = NULL
      WHERE event_id = ? AND tenant_id = ? AND status = 'failed'`,
  ).bind(now, eventId, trustedNewoTenantId(env)).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function touchNewoReceipt(
  env: Env,
  eventId: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE newo_event_receipts SET last_seen_at = ? WHERE event_id = ? AND tenant_id = ?",
  ).bind(now, eventId, trustedNewoTenantId(env)).run();
}

export async function completeNewoReceipt(
  env: Env,
  eventId: string,
  envelopeId: string | null,
  response: unknown,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE newo_event_receipts
        SET status = 'accepted', envelope_id = ?, response_json = ?, last_error = NULL,
            last_seen_at = ?, completed_at = ?
      WHERE event_id = ? AND tenant_id = ? AND status = 'processing'`,
  ).bind(envelopeId, JSON.stringify(response), now, now, eventId, trustedNewoTenantId(env)).run();
}

export async function failNewoReceipt(
  env: Env,
  eventId: string,
  error: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE newo_event_receipts
        SET status = 'failed', last_error = ?, last_seen_at = ?, completed_at = ?
      WHERE event_id = ? AND tenant_id = ? AND status = 'processing'`,
  ).bind(error.slice(0, 500), now, now, eventId, trustedNewoTenantId(env)).run();
}

/**
 * Why a caller is owed a callback (migration 0168): the receptionist requested one, the handoff
 * failed, or the session failed while the session knows how to reach the caller.
 */
export type NewoCallbackReason = "callback_requested" | "handoff_failed" | "session_failed";

/**
 * The callback a Newo caller is owed (migration 0168): one append-only row per tenant and session,
 * written in the same D1 batch as the session by the accepted event that leaves a callback owed.
 * D1 stamps `recorded_at`; the Worker never sends a time.
 */
export interface NewoCallbackRecordInput {
  callback_id: string;
  tenant_id: string;
  session_id: string;
  /** The event whose acceptance wrote the record. */
  event_id: string;
  reason: NewoCallbackReason;
  urgency: "routine" | "urgent" | "emergency";
  /** The receptionist's handoff summary, when the event carried one. */
  handoff_summary: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
}

export interface NewoCallbackRecord extends NewoCallbackRecordInput {
  recorded_at: string;
}

export interface NewoCallbackAlertRecord extends NewoCallbackRecord {
  alert_kind: "handoff" | "failure";
  alert_urgency: NewoCallbackRecord["urgency"];
}

/**
 * Bounded, tenant-scoped traversal of every callback still owed, including failed handoffs.
 * An accepted late failure still owes its alert when a newer session projection is healthy.
 * Read that durable receipt only through the session's owned envelope and matching tenant;
 * raw input, unaccepted receipts and receipts of another session/envelope do not count.
 */
export async function listNewoCallbacksForAlert(
  env: Env,
  afterCallbackId: string | null,
  limit: number,
): Promise<NewoCallbackAlertRecord[]> {
  const result = await env.DB.prepare(
    `SELECT callback.*,
        CASE WHEN session.status = 'failed' OR session.handoff_status = 'failed'
          OR callback.reason <> 'callback_requested'
          OR EXISTS (
            SELECT 1 FROM newo_event_receipts failure
            JOIN envelopes envelope ON envelope.envelope_id = failure.envelope_id
             WHERE failure.session_id = callback.session_id
               AND failure.event_type = 'session_failed' AND failure.status = 'accepted'
               AND failure.tenant_id = callback.tenant_id
               AND failure.envelope_id = session.lead_envelope_id
               AND envelope.tenant_id = callback.tenant_id
          )
          OR EXISTS (SELECT 1 FROM newo_event_admissions admitted
            WHERE admitted.session_id = callback.session_id AND admitted.tenant_id = callback.tenant_id
              AND (admitted.event_type = 'session_failed' OR admitted.callback_reason = 'handoff_failed'))
          THEN 'failure' ELSE 'handoff' END AS alert_kind,
        CASE WHEN 'emergency' IN (callback.urgency, session.urgency) THEN 'emergency'
          WHEN 'urgent' IN (callback.urgency, session.urgency) THEN 'urgent'
          ELSE 'routine' END AS alert_urgency
       FROM newo_callback_records callback
       JOIN newo_sessions session ON session.session_id = callback.session_id
        AND session.tenant_id = callback.tenant_id AND session.tenant_binding_state = 'bound'
      WHERE callback.tenant_id = ? AND callback.callback_id > ?
        AND NOT EXISTS (
          SELECT 1 FROM newo_handoff_resolutions resolution
           WHERE resolution.tenant_id = callback.tenant_id
             AND resolution.session_id = callback.session_id
        )
      ORDER BY callback.callback_id ASC LIMIT ?`,
  ).bind(newoTenantId(env), afterCallbackId ?? "", limit).all<NewoCallbackAlertRecord>();
  return result.results ?? [];
}

const CALLBACK_RECORD_COLUMNS = `callback_id, tenant_id, session_id, event_id, reason, urgency,
       handoff_summary, contact_name, contact_phone, contact_email, address_line1, city, province,
       postal_code`;

/**
 * Writes the session snapshot and, when a callback is owed, its record, as one D1 batch: a session
 * that says a caller is owed a callback never lands without the record. The record is written once
 * per session; a later event of the same session adds nothing (never a REPLACE).
 */
export async function recordNewoSession(
  env: Env, rec: NewoSessionRecord, eventId: string, handoffSummary: string | null,
): Promise<NewoBusinessAdmission> {
  return await writeAdmittedNewoSession(env, rec, eventId, handoffSummary);
}

/** The session's callback record for this deployment's tenant, if one was written. */
export async function getNewoCallbackRecord(
  env: Env,
  sessionId: string,
): Promise<NewoCallbackRecord | null> {
  return await env.DB.prepare(
    `SELECT ${CALLBACK_RECORD_COLUMNS}, recorded_at
       FROM newo_callback_records
      WHERE tenant_id = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM newo_sessions session WHERE session.session_id = newo_callback_records.session_id
          AND session.tenant_id = newo_callback_records.tenant_id AND session.tenant_binding_state = 'bound')`,
  ).bind(newoTenantId(env), sessionId).first<NewoCallbackRecord>();
}

export async function getNewoSession(
  env: Env,
  sessionId: string,
): Promise<NewoSessionRecord | null> {
  return await env.DB.prepare("SELECT * FROM newo_sessions WHERE session_id = ? AND tenant_id = ? AND tenant_binding_state = 'bound'")
    .bind(sessionId, newoTenantId(env)).first<NewoSessionRecord>();
}

export async function listRecentNewoSessions(
  env: Env,
  limit: number,
): Promise<NewoSessionRecord[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM newo_sessions WHERE tenant_id = ? AND tenant_binding_state = 'bound' ORDER BY updated_at DESC LIMIT ?",
  ).bind(newoTenantId(env), limit).all<NewoSessionRecord>();
  return result.results ?? [];
}

export async function markNewoSessionSync(
  env: Env,
  sessionId: string,
  status: "synced" | "failed" | "dead",
  error: string | null,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE newo_sessions
        SET sync_status = ?, sync_attempts = sync_attempts + 1, last_error = ?, sync_updated_at = ?
      WHERE session_id = ? AND tenant_id = ? AND tenant_binding_state = 'bound'`,
  ).bind(status, error?.slice(0, 500) ?? null, now, sessionId, newoTenantId(env)).run();
}

export async function listRetryableNewoEventIds(
  env: Env,
  updatedBefore: string,
  limit: number,
): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT r.event_id
       FROM newo_sessions s
       JOIN newo_event_receipts r ON r.event_id = COALESCE(s.last_event_id, (
         SELECT latest.event_id FROM newo_event_receipts latest
          WHERE latest.session_id = s.session_id AND latest.tenant_id = s.tenant_id AND latest.status = 'accepted'
            AND latest.payload_hash = s.payload_hash AND latest.raw_key = s.raw_key
            AND latest.envelope_id IS s.lead_envelope_id
          ORDER BY latest.last_seen_at DESC, latest.event_id DESC LIMIT 1
       ))
      WHERE s.tenant_id = ? AND s.tenant_binding_state = 'bound' AND r.tenant_id = s.tenant_id
        AND (s.last_event_id IS NULL OR EXISTS (SELECT 1 FROM newo_event_admissions admitted
          WHERE admitted.event_id = r.event_id AND admitted.tenant_id = s.tenant_id AND admitted.session_id = s.session_id))
        AND s.sync_status IN ('pending','failed') AND COALESCE(s.sync_updated_at, s.updated_at) <= ?
      ORDER BY COALESCE(s.sync_updated_at, s.updated_at) ASC LIMIT ?`,
  ).bind(newoTenantId(env), updatedBefore, limit).all<{ event_id: string }>();
  return (result.results ?? []).map((row) => row.event_id);
}

export async function markNewoMissingReports(
  env: Env,
  now: string,
  limit: number,
): Promise<Array<Pick<NewoSessionRecord, "session_id" | "lead_envelope_id" | "report_expected_at">>> {
  const candidates = await env.DB.prepare(
    `SELECT session_id, lead_envelope_id, report_expected_at
       FROM newo_sessions
      WHERE tenant_id = ? AND tenant_binding_state = 'bound'
        AND report_expected_at IS NOT NULL AND report_expected_at <= ?
        AND report_received_at IS NULL AND missing_report_detected_at IS NULL
      ORDER BY report_expected_at ASC
      LIMIT ?`,
  ).bind(newoTenantId(env), now, limit).all<Pick<NewoSessionRecord, "session_id" | "lead_envelope_id" | "report_expected_at">>();
  const claimed: Array<Pick<NewoSessionRecord, "session_id" | "lead_envelope_id" | "report_expected_at">> = [];
  for (const candidate of candidates.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE newo_sessions
          SET missing_report_detected_at = ?
        WHERE session_id = ? AND report_received_at IS NULL
          AND missing_report_detected_at IS NULL AND report_expected_at <= ?
          AND tenant_id = ? AND tenant_binding_state = 'bound'`,
    ).bind(now, candidate.session_id, now, newoTenantId(env)).run();
    if (Number(result.meta?.changes ?? 0) === 1) claimed.push(candidate);
  }
  return claimed;
}

export async function recordNewoReconciliationRun(
  env: Env,
  run: NewoReconciliationRun,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO newo_reconciliation_runs (
       run_id, run_type, status, ran_at, retryable_syncs_requeued, missing_reports,
       failed_handoffs, pending_bookings, unresolved_incidents, drift_reasons_json,
       usage_status, usage_minutes, usage_limit_minutes, detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    run.run_id,
    run.run_type,
    run.status,
    run.ran_at,
    run.retryable_syncs_requeued,
    run.missing_reports,
    run.failed_handoffs,
    run.pending_bookings,
    run.unresolved_incidents,
    run.drift_reasons_json,
    run.usage_status,
    run.usage_minutes,
    run.usage_limit_minutes,
    run.detail_json,
  ).run();
}

export async function getLatestNewoReconciliationRun(
  env: Env,
  runType?: NewoReconciliationRun["run_type"],
): Promise<NewoReconciliationRun | null> {
  if (runType) {
    return await env.DB.prepare(
      "SELECT * FROM newo_reconciliation_runs WHERE run_type = ? ORDER BY ran_at DESC LIMIT 1",
    ).bind(runType).first<NewoReconciliationRun>();
  }
  return await env.DB.prepare(
    "SELECT * FROM newo_reconciliation_runs ORDER BY ran_at DESC LIMIT 1",
  ).first<NewoReconciliationRun>();
}

export async function countOpenNewoDeadLetters(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM dead_letter WHERE recovered = 0 AND stage GLOB 'newo_*'",
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * The deployment tenant used by bounded reads. Producer admission requires an explicit trusted
 * binding through trustedNewoTenantId; historical fallback here grants no session ownership.
 */
export function newoTenantId(env: Env): string {
  return (env.APP_TENANT_ID ?? "ironwrap").trim();
}

/**
 * A failed handoff stays open until a person of this deployment's tenant records how it ended
 * (migration 0151). There is no lookback window: an old failure nobody resolved is still open.
 * The reconcile count and the operations list share this one predicate; bind `newoTenantId` to
 * its placeholder.
 */
export const UNRESOLVED_FAILED_HANDOFF = `tenant_id = ? AND tenant_binding_state = 'bound' AND handoff_status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM newo_handoff_resolutions resolution
            WHERE resolution.tenant_id = newo_sessions.tenant_id AND resolution.session_id = newo_sessions.session_id
         )`;

/**
 * A callback record stays open until a person of this deployment's tenant records how it ended
 * (the same 0151 resolution). A callback whose session's handoff failed is counted once, as a
 * failed handoff, so each caller owed a call appears in one list; a requested callback and a
 * failed session's callback are open callbacks. Alias the callback record `callback` and bind
 * `newoTenantId` to the placeholder.
 */
export const OPEN_CALLBACK = `callback.tenant_id = ?
         AND EXISTS (SELECT 1 FROM newo_sessions owner WHERE owner.session_id = callback.session_id
           AND owner.tenant_id = callback.tenant_id AND owner.tenant_binding_state = 'bound')
         AND NOT EXISTS (
           SELECT 1 FROM newo_handoff_resolutions resolution
            WHERE resolution.tenant_id = callback.tenant_id
              AND resolution.session_id = callback.session_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM newo_sessions failed
            WHERE failed.session_id = callback.session_id AND failed.tenant_id = callback.tenant_id
              AND failed.tenant_binding_state = 'bound' AND failed.handoff_status = 'failed'
         )`;

/**
 * `failed_handoffs` counts only the failed handoffs no person has resolved; `open_callbacks` the
 * other callbacks no person has closed (requested ones and failed sessions').
 */
export async function newoOperationalCounts(env: Env): Promise<{
  sessions: number;
  pending_sync: number;
  failed_sync: number;
  failed_events: number;
  missing_reports: number;
  failed_handoffs: number;
  open_callbacks: number;
  pending_bookings: number;
  control_failures: number;
  last_event_at: string | null;
  last_report_at: string | null;
}> {
  const row = await env.DB.prepare(
    `WITH owned_tenant AS (SELECT ? AS id)
     SELECT
       (SELECT COUNT(*) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound') AS sessions,
       (SELECT COUNT(*) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound' AND sync_status = 'pending') AS pending_sync,
       (SELECT COUNT(*) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound' AND sync_status IN ('failed','dead')) AS failed_sync,
       (SELECT COUNT(*) FROM newo_event_receipts WHERE tenant_id = (SELECT id FROM owned_tenant) AND status IN ('failed','dead')) AS failed_events,
       (SELECT COUNT(*) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound'
          AND missing_report_detected_at IS NOT NULL AND report_received_at IS NULL) AS missing_reports,
       (SELECT COUNT(*) FROM newo_sessions WHERE ${UNRESOLVED_FAILED_HANDOFF.replace("?", "(SELECT id FROM owned_tenant)")}) AS failed_handoffs,
       (SELECT COUNT(*) FROM newo_callback_records callback WHERE ${OPEN_CALLBACK.replace("?", "(SELECT id FROM owned_tenant)")}) AS open_callbacks,
       (SELECT COUNT(*) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound' AND booking_status = 'requested') AS pending_bookings,
       (SELECT COUNT(*) FROM newo_control_actions WHERE status = 'failed') AS control_failures,
       (SELECT MAX(last_seen_at) FROM newo_event_receipts WHERE tenant_id = (SELECT id FROM owned_tenant)) AS last_event_at,
       (SELECT MAX(report_received_at) FROM newo_sessions WHERE tenant_id = (SELECT id FROM owned_tenant) AND tenant_binding_state = 'bound') AS last_report_at`,
  ).bind(newoTenantId(env)).first<Record<string, unknown>>();
  return {
    sessions: Number(row?.sessions ?? 0),
    pending_sync: Number(row?.pending_sync ?? 0),
    failed_sync: Number(row?.failed_sync ?? 0),
    failed_events: Number(row?.failed_events ?? 0),
    missing_reports: Number(row?.missing_reports ?? 0),
    failed_handoffs: Number(row?.failed_handoffs ?? 0),
    open_callbacks: Number(row?.open_callbacks ?? 0),
    pending_bookings: Number(row?.pending_bookings ?? 0),
    control_failures: Number(row?.control_failures ?? 0),
    last_event_at: typeof row?.last_event_at === "string" ? row.last_event_at : null,
    last_report_at: typeof row?.last_report_at === "string" ? row.last_report_at : null,
  };
}

/** Both reconciliation schedules stay degraded while any callback is still owed to a caller. */
export function newoReconciliationNeedsAttention(
  counts: Awaited<ReturnType<typeof newoOperationalCounts>>,
): boolean {
  return counts.failed_events > 0 || counts.failed_sync > 0 || counts.missing_reports > 0 ||
    counts.control_failures > 0 || counts.open_callbacks > 0 || counts.failed_handoffs > 0;
}
