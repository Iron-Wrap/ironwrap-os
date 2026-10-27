export type NewoReceiptStatus = "processing" | "accepted" | "failed" | "dead";

export interface NewoEventReceipt {
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
  env: Env,
  association: NewoCallerAssociation,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO newo_sessions (
       session_id, project_id, agent_id, channel, direction, status, contact_phone,
       address_line1, postal_code, matched_customer_id, matched_property_id,
       matched_roof_job_id, verification_status, structured_json, raw_key, payload_hash,
       sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, 'phone', 'inbound', 'caller_lookup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'pending', ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_id = COALESCE(excluded.project_id, newo_sessions.project_id),
       agent_id = COALESCE(excluded.agent_id, newo_sessions.agent_id),
       contact_phone = excluded.contact_phone,
       address_line1 = excluded.address_line1,
       postal_code = excluded.postal_code,
       matched_customer_id = excluded.matched_customer_id,
       matched_property_id = excluded.matched_property_id,
       matched_roof_job_id = excluded.matched_roof_job_id,
       verification_status = excluded.verification_status,
       structured_json = excluded.structured_json,
       raw_key = excluded.raw_key,
       payload_hash = excluded.payload_hash,
       sync_status = 'pending',
       last_error = NULL,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= newo_sessions.updated_at`,
  ).bind(
    association.session_id,
    association.project_id,
    association.agent_id,
    association.contact_phone,
    association.address_line1,
    association.postal_code,
    association.matched_customer_id,
    association.matched_property_id,
    association.matched_roof_job_id,
    association.verification_status,
    association.structured_json,
    association.raw_key,
    association.payload_hash,
    now,
    association.occurred_at,
  ).run();
  return Number(result.meta?.changes ?? 0) === 1;
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
  input: Pick<NewoEventReceipt, "event_id" | "session_id" | "event_type" | "payload_hash" | "raw_key">,
  now: string,
): Promise<"claimed" | "existing"> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO newo_event_receipts
      (event_id, session_id, event_type, payload_hash, raw_key, status, response_json,
       attempts, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'processing', '{}', 1, ?, ?)`,
  ).bind(
    input.event_id,
    input.session_id,
    input.event_type,
    input.payload_hash,
    input.raw_key,
    now,
    now,
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
      WHERE event_id = ? AND status = 'failed'`,
  ).bind(now, eventId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function touchNewoReceipt(
  env: Env,
  eventId: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE newo_event_receipts SET last_seen_at = ? WHERE event_id = ?",
  ).bind(now, eventId).run();
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
      WHERE event_id = ? AND status = 'processing'`,
  ).bind(envelopeId, JSON.stringify(response), now, now, eventId).run();
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
      WHERE event_id = ? AND status = 'processing'`,
  ).bind(error.slice(0, 500), now, now, eventId).run();
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

const CALLBACK_RECORD_COLUMNS = `callback_id, tenant_id, session_id, event_id, reason, urgency,
       handoff_summary, contact_name, contact_phone, contact_email, address_line1, city, province,
       postal_code`;

/**
 * Writes the session snapshot and, when a callback is owed, its record, as one D1 batch: a session
 * that says a caller is owed a callback never lands without the record. The record is written once
 * per session; a later event of the same session adds nothing (never a REPLACE).
 */
export async function recordNewoSession(
  env: Env,
  rec: NewoSessionRecord,
  callback: NewoCallbackRecordInput | null,
): Promise<void> {
  if (!callback) {
    await upsertNewoSession(env, rec);
    return;
  }
  await env.DB.batch([
    newoSessionUpsert(env, rec),
    env.DB.prepare(
      `INSERT INTO newo_callback_records (${CALLBACK_RECORD_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM newo_callback_records existing
           WHERE existing.tenant_id = ? AND existing.session_id = ?
        )`,
    ).bind(
      callback.callback_id,
      callback.tenant_id,
      callback.session_id,
      callback.event_id,
      callback.reason,
      callback.urgency,
      callback.handoff_summary,
      callback.contact_name,
      callback.contact_phone,
      callback.contact_email,
      callback.address_line1,
      callback.city,
      callback.province,
      callback.postal_code,
      callback.tenant_id,
      callback.session_id,
    ),
  ]);
}

/** The session's callback record for this deployment's tenant, if one was written. */
export async function getNewoCallbackRecord(
  env: Env,
  sessionId: string,
): Promise<NewoCallbackRecord | null> {
  return await env.DB.prepare(
    `SELECT ${CALLBACK_RECORD_COLUMNS}, recorded_at
       FROM newo_callback_records
      WHERE tenant_id = ? AND session_id = ?`,
  ).bind(newoTenantId(env), sessionId).first<NewoCallbackRecord>();
}

/**
 * Upserts one session snapshot. A session keeps its highest urgency, never the latest one, and
 * its strongest handoff status: failed outranks requested, and no other value clears a requested
 * callback (callback only, owner decisions MD-05 and D-03).
 */
export async function upsertNewoSession(
  env: Env,
  rec: NewoSessionRecord,
): Promise<void> {
  await newoSessionUpsert(env, rec).run();
}

function newoSessionUpsert(env: Env, rec: NewoSessionRecord): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO newo_sessions (
       session_id, project_id, agent_id, user_actor_id, conversation_id, channel, direction,
       status, outcome, contact_name, contact_phone, contact_email, address_line1, city, province,
       postal_code, division, service, urgency, lead_envelope_id, appointment_request_id,
       handoff_status, booking_status, summary, transcript_ref, recording_ref, ai_disclosed,
       recording_disclosed, structured_json, raw_key, payload_hash, started_at, ended_at,
       duration_seconds, report_expected_at, report_received_at, report_event_id,
       missing_report_detected_at, sync_status, sync_attempts, last_error, sync_updated_at,
       created_at, updated_at
     ) VALUES (${Array.from({ length: 44 }, () => "?").join(", ")})
     ON CONFLICT(session_id) DO UPDATE SET
       project_id = COALESCE(excluded.project_id, newo_sessions.project_id),
       agent_id = COALESCE(excluded.agent_id, newo_sessions.agent_id),
       user_actor_id = COALESCE(excluded.user_actor_id, newo_sessions.user_actor_id),
       conversation_id = COALESCE(excluded.conversation_id, newo_sessions.conversation_id),
       channel = excluded.channel,
       direction = excluded.direction,
       status = excluded.status,
       outcome = COALESCE(excluded.outcome, newo_sessions.outcome),
       contact_name = COALESCE(excluded.contact_name, newo_sessions.contact_name),
       contact_phone = COALESCE(excluded.contact_phone, newo_sessions.contact_phone),
       contact_email = COALESCE(excluded.contact_email, newo_sessions.contact_email),
       address_line1 = COALESCE(excluded.address_line1, newo_sessions.address_line1),
       city = COALESCE(excluded.city, newo_sessions.city),
       province = COALESCE(excluded.province, newo_sessions.province),
       postal_code = COALESCE(excluded.postal_code, newo_sessions.postal_code),
       division = COALESCE(excluded.division, newo_sessions.division),
       service = COALESCE(excluded.service, newo_sessions.service),
       urgency = CASE
         WHEN 'emergency' IN (excluded.urgency, newo_sessions.urgency) THEN 'emergency'
         WHEN 'urgent' IN (excluded.urgency, newo_sessions.urgency) THEN 'urgent'
         ELSE COALESCE(excluded.urgency, newo_sessions.urgency)
       END,
       lead_envelope_id = COALESCE(excluded.lead_envelope_id, newo_sessions.lead_envelope_id),
       appointment_request_id = COALESCE(excluded.appointment_request_id, newo_sessions.appointment_request_id),
       handoff_status = CASE
         WHEN 'failed' IN (excluded.handoff_status, newo_sessions.handoff_status) THEN 'failed'
         WHEN 'requested' IN (excluded.handoff_status, newo_sessions.handoff_status) THEN 'requested'
         ELSE COALESCE(excluded.handoff_status, newo_sessions.handoff_status)
       END,
       booking_status = COALESCE(excluded.booking_status, newo_sessions.booking_status),
       summary = COALESCE(excluded.summary, newo_sessions.summary),
       transcript_ref = COALESCE(excluded.transcript_ref, newo_sessions.transcript_ref),
       recording_ref = COALESCE(excluded.recording_ref, newo_sessions.recording_ref),
       ai_disclosed = MAX(excluded.ai_disclosed, newo_sessions.ai_disclosed),
       recording_disclosed = MAX(excluded.recording_disclosed, newo_sessions.recording_disclosed),
       structured_json = excluded.structured_json,
       raw_key = excluded.raw_key,
       payload_hash = excluded.payload_hash,
       started_at = COALESCE(excluded.started_at, newo_sessions.started_at),
       ended_at = COALESCE(excluded.ended_at, newo_sessions.ended_at),
       duration_seconds = COALESCE(excluded.duration_seconds, newo_sessions.duration_seconds),
       report_expected_at = excluded.report_expected_at,
       report_received_at = COALESCE(excluded.report_received_at, newo_sessions.report_received_at),
       report_event_id = COALESCE(excluded.report_event_id, newo_sessions.report_event_id),
       missing_report_detected_at = CASE
         WHEN excluded.report_received_at IS NOT NULL THEN NULL
         ELSE newo_sessions.missing_report_detected_at
       END,
       sync_status = 'pending',
       last_error = NULL,
       sync_updated_at = excluded.sync_updated_at,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= newo_sessions.updated_at`,
  ).bind(
    rec.session_id,
    rec.project_id,
    rec.agent_id,
    rec.user_actor_id,
    rec.conversation_id,
    rec.channel,
    rec.direction,
    rec.status,
    rec.outcome,
    rec.contact_name,
    rec.contact_phone,
    rec.contact_email,
    rec.address_line1,
    rec.city,
    rec.province,
    rec.postal_code,
    rec.division,
    rec.service,
    rec.urgency,
    rec.lead_envelope_id,
    rec.appointment_request_id,
    rec.handoff_status,
    rec.booking_status,
    rec.summary,
    rec.transcript_ref,
    rec.recording_ref,
    rec.ai_disclosed,
    rec.recording_disclosed,
    rec.structured_json,
    rec.raw_key,
    rec.payload_hash,
    rec.started_at,
    rec.ended_at,
    rec.duration_seconds,
    rec.report_expected_at,
    rec.report_received_at,
    rec.report_event_id,
    rec.missing_report_detected_at,
    rec.sync_status,
    rec.sync_attempts,
    rec.last_error,
    rec.sync_updated_at,
    rec.created_at,
    rec.updated_at,
  );
}

export async function getNewoSession(
  env: Env,
  sessionId: string,
): Promise<NewoSessionRecord | null> {
  return await env.DB.prepare("SELECT * FROM newo_sessions WHERE session_id = ?")
    .bind(sessionId).first<NewoSessionRecord>();
}

export async function getNewoSessionByAppointment(
  env: Env,
  appointmentRequestId: string,
): Promise<NewoSessionRecord | null> {
  return await env.DB.prepare(
    "SELECT * FROM newo_sessions WHERE appointment_request_id = ?",
  ).bind(appointmentRequestId).first<NewoSessionRecord>();
}

export async function listRecentNewoSessions(
  env: Env,
  limit: number,
): Promise<NewoSessionRecord[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM newo_sessions ORDER BY updated_at DESC LIMIT ?",
  ).bind(limit).all<NewoSessionRecord>();
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
      WHERE session_id = ?`,
  ).bind(status, error?.slice(0, 500) ?? null, now, sessionId).run();
}

export async function listRetryableNewoEventIds(
  env: Env,
  updatedBefore: string,
  limit: number,
): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT r.event_id
       FROM newo_sessions s
       JOIN newo_event_receipts r ON r.event_id = (
         SELECT latest.event_id
           FROM newo_event_receipts latest
          WHERE latest.session_id = s.session_id AND latest.status = 'accepted'
          ORDER BY latest.last_seen_at DESC, latest.event_id DESC
          LIMIT 1
       )
      WHERE s.sync_status IN ('pending','failed') AND COALESCE(s.sync_updated_at, s.updated_at) <= ?
      ORDER BY COALESCE(s.sync_updated_at, s.updated_at) ASC
      LIMIT ?`,
  ).bind(updatedBefore, limit).all<{ event_id: string }>();
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
      WHERE report_expected_at IS NOT NULL AND report_expected_at <= ?
        AND report_received_at IS NULL AND missing_report_detected_at IS NULL
      ORDER BY report_expected_at ASC
      LIMIT ?`,
  ).bind(now, limit).all<Pick<NewoSessionRecord, "session_id" | "lead_envelope_id" | "report_expected_at">>();
  const claimed: Array<Pick<NewoSessionRecord, "session_id" | "lead_envelope_id" | "report_expected_at">> = [];
  for (const candidate of candidates.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE newo_sessions
          SET missing_report_detected_at = ?
        WHERE session_id = ? AND report_received_at IS NULL
          AND missing_report_detected_at IS NULL AND report_expected_at <= ?`,
    ).bind(now, candidate.session_id, now).run();
    if (Number(result.meta?.changes ?? 0) === 1) claimed.push(candidate);
  }
  return claimed;
}

export async function listMissingNewoReports(env: Env, limit: number): Promise<NewoSessionRecord[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM newo_sessions
      WHERE missing_report_detected_at IS NOT NULL AND report_received_at IS NULL
      ORDER BY missing_report_detected_at ASC LIMIT ?`,
  ).bind(limit).all<NewoSessionRecord>();
  return result.results ?? [];
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
 * The tenant whose people resolve this deployment's failed Newo handoffs. A Newo session carries
 * no tenant of its own: one deployment serves one tenant and the app session is bound to it, so
 * only that tenant's resolutions retire a failed handoff.
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
export const UNRESOLVED_FAILED_HANDOFF = `handoff_status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM newo_handoff_resolutions resolution
            WHERE resolution.tenant_id = ? AND resolution.session_id = newo_sessions.session_id
         )`;

/**
 * A callback record stays open until a person of this deployment's tenant records how it ended
 * (the same 0151 resolution). A callback whose session's handoff failed is counted once, as a
 * failed handoff, so each caller owed a call appears in one list; a requested callback and a
 * failed session's callback are open callbacks. Alias the callback record `callback` and bind
 * `newoTenantId` to the placeholder.
 */
export const OPEN_CALLBACK = `callback.tenant_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM newo_handoff_resolutions resolution
            WHERE resolution.tenant_id = callback.tenant_id
              AND resolution.session_id = callback.session_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM newo_sessions failed
            WHERE failed.session_id = callback.session_id AND failed.handoff_status = 'failed'
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
    `SELECT
       (SELECT COUNT(*) FROM newo_sessions) AS sessions,
       (SELECT COUNT(*) FROM newo_sessions WHERE sync_status = 'pending') AS pending_sync,
       (SELECT COUNT(*) FROM newo_sessions WHERE sync_status IN ('failed','dead')) AS failed_sync,
       (SELECT COUNT(*) FROM newo_event_receipts WHERE status IN ('failed','dead')) AS failed_events,
       (SELECT COUNT(*) FROM newo_sessions WHERE missing_report_detected_at IS NOT NULL
          AND report_received_at IS NULL) AS missing_reports,
       (SELECT COUNT(*) FROM newo_sessions WHERE ${UNRESOLVED_FAILED_HANDOFF}) AS failed_handoffs,
       (SELECT COUNT(*) FROM newo_callback_records callback WHERE ${OPEN_CALLBACK}) AS open_callbacks,
       (SELECT COUNT(*) FROM newo_sessions WHERE booking_status = 'requested') AS pending_bookings,
       (SELECT COUNT(*) FROM newo_control_actions WHERE status = 'failed') AS control_failures,
       (SELECT MAX(last_seen_at) FROM newo_event_receipts) AS last_event_at,
       (SELECT MAX(report_received_at) FROM newo_sessions) AS last_report_at`,
  ).bind(newoTenantId(env), newoTenantId(env)).first<Record<string, unknown>>();
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
