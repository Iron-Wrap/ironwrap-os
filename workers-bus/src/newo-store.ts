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
  sync_status: "pending" | "synced" | "failed" | "dead";
  sync_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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

export async function upsertNewoSession(
  env: Env,
  rec: NewoSessionRecord,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO newo_sessions (
       session_id, project_id, agent_id, user_actor_id, conversation_id, channel, direction,
       status, outcome, contact_name, contact_phone, contact_email, address_line1, city, province,
       postal_code, division, service, urgency, lead_envelope_id, appointment_request_id,
       handoff_status, booking_status, summary, transcript_ref, recording_ref, ai_disclosed,
       recording_disclosed, structured_json, raw_key, payload_hash, started_at, ended_at,
       duration_seconds, sync_status, sync_attempts, last_error, created_at, updated_at
     ) VALUES (${Array.from({ length: 39 }, () => "?").join(", ")})
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
       urgency = COALESCE(excluded.urgency, newo_sessions.urgency),
       lead_envelope_id = COALESCE(excluded.lead_envelope_id, newo_sessions.lead_envelope_id),
       appointment_request_id = COALESCE(excluded.appointment_request_id, newo_sessions.appointment_request_id),
       handoff_status = COALESCE(excluded.handoff_status, newo_sessions.handoff_status),
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
       sync_status = 'pending',
       last_error = NULL,
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
    rec.sync_status,
    rec.sync_attempts,
    rec.last_error,
    rec.created_at,
    rec.updated_at,
  ).run();
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
        SET sync_status = ?, sync_attempts = sync_attempts + 1, last_error = ?, updated_at = ?
      WHERE session_id = ?`,
  ).bind(status, error?.slice(0, 500) ?? null, now, sessionId).run();
}

export async function newoOperationalCounts(env: Env): Promise<{
  sessions: number;
  pending_sync: number;
  failed_sync: number;
  failed_events: number;
  last_event_at: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM newo_sessions) AS sessions,
       (SELECT COUNT(*) FROM newo_sessions WHERE sync_status = 'pending') AS pending_sync,
       (SELECT COUNT(*) FROM newo_sessions WHERE sync_status IN ('failed','dead')) AS failed_sync,
       (SELECT COUNT(*) FROM newo_event_receipts WHERE status IN ('failed','dead')) AS failed_events,
       (SELECT MAX(last_seen_at) FROM newo_event_receipts) AS last_event_at`,
  ).first<Record<string, unknown>>();
  return {
    sessions: Number(row?.sessions ?? 0),
    pending_sync: Number(row?.pending_sync ?? 0),
    failed_sync: Number(row?.failed_sync ?? 0),
    failed_events: Number(row?.failed_events ?? 0),
    last_event_at: typeof row?.last_event_at === "string" ? row.last_event_at : null,
  };
}
