// store.ts — owned system of record (Cloudflare D1 + R2).
// The owned store IS the bus: every event is written here FIRST, before JobNimbus.

import type { EnvelopeRecord, Status } from "./core.ts";

export interface AuditEntry {
  automation: string;
  trigger: string;
  envelope_id: string | null;
  source_ids?: string | null;
  target_ids?: string | null;
  job_number?: string | null;
  action: string;
  result: "ok" | "error";
  error?: string | null;
  recovery_owner?: string | null;
  run_id?: string | null;
  approved_by?: string | null;
  reason?: string | null;
}

export interface DeadLetterEntry {
  envelope_id: string | null;
  stage: string;
  error: string;
  payload_json: string;
}

export interface DeadLetterRecord extends DeadLetterEntry {
  id: number;
  ts: string;
  recovered: number;
}

export interface QuickBooksWebhookReceipt {
  payload_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  envelope_id: string;
  raw_key: string;
  events_count: number;
  replay_count: number;
}

export type LeadAckOutcome = "provider_accepted" | "attempt_failed" | "no_eligible_channel";

export interface LeadAckReceipt {
  receipt_id: string;
  envelope_id: string;
  channel: "email" | "none";
  outcome: LeadAckOutcome;
  observed_at: string;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: string;
}

export interface LeadMctbEnvelope {
  envelope_id: string;
  received_at: string;
  bus_status: Status;
}

export interface DedupClaim {
  dedup_key: string;
  first_envelope_id: string;
  first_seen_at: string;
  updated_at: string;
}

export interface HeartbeatRecord {
  day: string;
  ran_at: string;
  reconciled: number;
  dead_letter_open: number;
}

export interface OperationalEnvelopeCounts {
  pending: number;
  stuck: number;
  frappe_errors: number;
}

export interface ReplayOperationalCounts {
  failed: number;
  stuck: number;
}

export interface ReplayRequestIdentity {
  run_id: string;
  selection: "targeted" | "bulk";
  envelope_id: string | null;
  approved_by: string;
  reason: string;
}

export interface ReplayRequestRecord extends ReplayRequestIdentity {
  status: "running" | "completed" | "failed";
  matched: number | null;
  requeued: number | null;
  last_error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type ReplayRequestClaim =
  | { kind: "claimed" }
  | { kind: "completed"; matched: number; requeued: number }
  | { kind: "conflict" }
  | { kind: "in_progress" };

export interface AuditFailureRecord {
  id: number;
  ts: string;
  automation: string | null;
  trigger: string | null;
  envelope_id: string | null;
  action: string | null;
  result: "error";
  error: string | null;
  recovery_owner: string | null;
  run_id: string | null;
  approved_by: string | null;
  reason: string | null;
}

const nowIso = () => new Date().toISOString();

/** Archive the raw inbound body to R2 FIRST, so nothing is lost if later steps fail. */
export async function putRaw(env: Env, key: string, body: string, contentType: string): Promise<void> {
  await env.RAW.put(key, body, { httpMetadata: { contentType } });
}

export async function insertEnvelope(env: Env, rec: EnvelopeRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO envelopes (envelope_id, source, contact_name, contact_phone, contact_email,
       job_ref, payload_json, raw_key, ts, status, dedup_key, dup_of, attempts, last_error,
       jn_contact_id, jn_job_id, estimate_submission_key, intent_queue, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    rec.envelope_id, rec.source, rec.contact_name, rec.contact_phone, rec.contact_email,
    rec.job_ref, rec.payload_json, rec.raw_key, rec.ts, rec.status, rec.dedup_key, rec.dup_of,
    rec.attempts, rec.last_error, rec.jn_contact_id, rec.jn_job_id,
    rec.estimate_submission_key ?? null, rec.intent_queue,
    rec.created_at, rec.updated_at,
  ).run();
}

export async function getEnvelope(env: Env, id: string): Promise<EnvelopeRecord | null> {
  return await env.DB.prepare(`SELECT * FROM envelopes WHERE envelope_id = ?`)
    .bind(id).first<EnvelopeRecord>();
}

/**
 * Append one privacy-minimized receipt for the automated prospect-ack attempt. The receipt is
 * evidence of provider acceptance only, never a claim of customer delivery or human follow-up.
 */
export async function recordLeadAckReceipt(
  env: Env,
  receipt: Omit<LeadAckReceipt, "created_at">,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lead_ack_receipts (
       receipt_id, envelope_id, channel, outcome, observed_at, provider_message_id, error_code, created_at
     ) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(
    receipt.receipt_id,
    receipt.envelope_id,
    receipt.channel,
    receipt.outcome,
    receipt.observed_at,
    receipt.provider_message_id,
    receipt.error_code,
    nowIso(),
  ).run();
}

/** Read only the owned timing/transport facts and receipt evidence needed for MCTB truth. */
export async function listLeadMctbEvidence(
  env: Env,
  envelopeIds: readonly string[],
): Promise<{ envelopes: LeadMctbEnvelope[]; receipts: LeadAckReceipt[] }> {
  const ids = [...new Set(envelopeIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return { envelopes: [], receipts: [] };
  if (ids.length > 100) throw new Error("lead_mctb_too_many_envelopes");
  const placeholders = ids.map(() => "?").join(",");
  const [envelopes, receipts] = await Promise.all([
    env.DB.prepare(
      `SELECT envelope_id, ts AS received_at, status AS bus_status
       FROM envelopes WHERE envelope_id IN (${placeholders})`,
    ).bind(...ids).all<LeadMctbEnvelope>(),
    env.DB.prepare(
      `SELECT receipt_id, envelope_id, channel, outcome, observed_at, provider_message_id, error_code, created_at
       FROM lead_ack_receipts WHERE envelope_id IN (${placeholders})
       ORDER BY envelope_id ASC, observed_at ASC, receipt_id ASC`,
    ).bind(...ids).all<LeadAckReceipt>(),
  ]);
  return { envelopes: envelopes.results ?? [], receipts: receipts.results ?? [] };
}

export async function listRecentEnvelopes(env: Env, limit: number): Promise<EnvelopeRecord[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM envelopes ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all<EnvelopeRecord>();
  return res.results ?? [];
}

/**
 * Find an earlier non-duplicate envelope with the same dedup key inside the window.
 * Idempotency/dedup keyed on phone/email across ALL inbound paths (spec 06).
 */
export async function findDuplicate(env: Env, key: string, sinceIso: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT envelope_id FROM envelopes
     WHERE dedup_key = ? AND status != 'duplicate' AND created_at >= ?
     ORDER BY created_at ASC LIMIT 1`,
  ).bind(key, sinceIso).first<{ envelope_id: string }>();
  return row?.envelope_id ?? null;
}

export async function claimDedup(
  env: Env,
  key: string,
  envelopeId: string,
  nowIsoValue: string,
  sinceIso: string,
): Promise<string | null> {
  const existing = await getDedupClaim(env, key);
  if (existing && existing.first_seen_at >= sinceIso) return existing.first_envelope_id;

  if (existing) {
    const res = await env.DB.prepare(
      `UPDATE dedup_claims
       SET first_envelope_id = ?, first_seen_at = ?, updated_at = ?
       WHERE dedup_key = ? AND first_seen_at < ?`,
    ).bind(envelopeId, nowIsoValue, nowIsoValue, key, sinceIso).run();
    if (Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) return null;

    const raced = await getDedupClaim(env, key);
    return raced && raced.first_seen_at >= sinceIso ? raced.first_envelope_id : null;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO dedup_claims (dedup_key, first_envelope_id, first_seen_at, updated_at)
       VALUES (?,?,?,?)`,
    ).bind(key, envelopeId, nowIsoValue, nowIsoValue).run();
    return null;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const raced = await getDedupClaim(env, key);
    return raced && raced.first_seen_at >= sinceIso ? raced.first_envelope_id : null;
  }
}

async function getDedupClaim(env: Env, key: string): Promise<DedupClaim | null> {
  return await env.DB.prepare(
    `SELECT * FROM dedup_claims WHERE dedup_key = ?`,
  ).bind(key).first<DedupClaim>();
}

function isUniqueConstraintError(err: unknown): boolean {
  return /unique|constraint/i.test(String(err));
}

export async function findEstimateSubmission(env: Env, key: string): Promise<EnvelopeRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM envelopes
     WHERE estimate_submission_key = ?
     ORDER BY created_at ASC LIMIT 1`,
  ).bind(key).first<EnvelopeRecord>();
}

export async function setStatus(
  env: Env, id: string, status: Status, patch: Partial<EnvelopeRecord> = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE envelopes SET status = ?, job_ref = COALESCE(?, job_ref),
       jn_contact_id = COALESCE(?, jn_contact_id),
       jn_job_id = COALESCE(?, jn_job_id), dup_of = COALESCE(?, dup_of),
       last_error = ?, updated_at = ? WHERE envelope_id = ?`,
  ).bind(
    status, patch.job_ref ?? null, patch.jn_contact_id ?? null, patch.jn_job_id ?? null, patch.dup_of ?? null,
    patch.last_error ?? null, nowIso(), id,
  ).run();
}

export interface ErpNextSyncPatch {
  leadEnvelopeId: string;
  roofingPropertyId?: string | null;
  roofJobId?: string | null;
  instantEstimateSessionId?: string | null;
}

export async function setErpNextSync(env: Env, id: string, patch: ErpNextSyncPatch): Promise<void> {
  await env.DB.prepare(
    `UPDATE envelopes SET erpnext_lead_envelope_id = ?,
       erpnext_roofing_property_id = COALESCE(?, erpnext_roofing_property_id),
       erpnext_roof_job_id = COALESCE(?, erpnext_roof_job_id),
       erpnext_instant_estimate_session_id = COALESCE(?, erpnext_instant_estimate_session_id),
       erpnext_synced_at = ?,
       erpnext_error = NULL, updated_at = ? WHERE envelope_id = ?`,
  ).bind(
    patch.leadEnvelopeId,
    patch.roofingPropertyId ?? null,
    patch.roofJobId ?? null,
    patch.instantEstimateSessionId ?? null,
    nowIso(),
    nowIso(),
    id,
  ).run();
}

export async function setErpNextError(env: Env, id: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE envelopes SET erpnext_error = ?, updated_at = ? WHERE envelope_id = ?`,
  ).bind(error, nowIso(), id).run();
}

/**
 * Stamp a failed ERPNext mirror attempt without changing `last_error`.
 *
 * `last_error` represents an intake/bridge failure that changes the envelope's primary
 * workflow state. Estimate intake is already durably accepted, so a transient mirror
 * outage must remain separately observable and retryable rather than making the intake
 * look invalid on a later idempotent request.
 */
export async function bumpErpNextMirrorAttempt(env: Env, id: string, error: string): Promise<number> {
  await env.DB.prepare(
    `UPDATE envelopes SET attempts = attempts + 1, erpnext_error = ?, updated_at = ? WHERE envelope_id = ?`,
  ).bind(error, nowIso(), id).run();
  const row = await env.DB.prepare(`SELECT attempts FROM envelopes WHERE envelope_id = ?`)
    .bind(id).first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

/** Atomically bump attempts and stamp the error; returns the new attempt count. */
export async function bumpAttempt(env: Env, id: string, error: string): Promise<number> {
  await env.DB.prepare(
    `UPDATE envelopes SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE envelope_id = ?`,
  ).bind(error, nowIso(), id).run();
  const row = await env.DB.prepare(`SELECT attempts FROM envelopes WHERE envelope_id = ?`)
    .bind(id).first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

export async function recordAudit(env: Env, e: AuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (ts, automation, trigger, envelope_id, source_ids, target_ids,
       job_number, action, result, error, recovery_owner, run_id, approved_by, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    nowIso(), e.automation, e.trigger, e.envelope_id, e.source_ids ?? null, e.target_ids ?? null,
    e.job_number ?? null, e.action, e.result, e.error ?? null, e.recovery_owner ?? null,
    e.run_id ?? null, e.approved_by ?? null, e.reason ?? null,
  ).run();
}

export async function recordDeadLetter(env: Env, e: DeadLetterEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
     VALUES (?,?,?,?,?,0)`,
  ).bind(nowIso(), e.envelope_id, e.stage, e.error, redactedDeadLetterPayload(e)).run();
}

function redactedDeadLetterPayload(e: DeadLetterEntry): string {
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(e.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) keys = Object.keys(parsed).slice(0, 25);
  } catch {
    keys = [];
  }
  return JSON.stringify({
    redacted: true,
    envelope_id: e.envelope_id,
    payload_keys: keys,
    recovery: "Use /admin/envelope/:id for the canonical payload.",
  });
}

export async function getQuickBooksWebhookReceipt(
  env: Env,
  payloadHash: string,
): Promise<QuickBooksWebhookReceipt | null> {
  return await env.DB.prepare(
    `SELECT * FROM quickbooks_webhook_receipts WHERE payload_hash = ?`,
  ).bind(payloadHash).first<QuickBooksWebhookReceipt>();
}

export async function insertQuickBooksWebhookReceipt(
  env: Env,
  receipt: Omit<QuickBooksWebhookReceipt, "replay_count">,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO quickbooks_webhook_receipts
       (payload_hash, first_seen_at, last_seen_at, envelope_id, raw_key, events_count, replay_count)
     VALUES (?,?,?,?,?,?,0)`,
  ).bind(
    receipt.payload_hash,
    receipt.first_seen_at,
    receipt.last_seen_at,
    receipt.envelope_id,
    receipt.raw_key,
    receipt.events_count,
  ).run();
}

export async function recordQuickBooksWebhookReplay(env: Env, payloadHash: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE quickbooks_webhook_receipts
     SET last_seen_at = ?, replay_count = replay_count + 1
     WHERE payload_hash = ?`,
  ).bind(nowIso(), payloadHash).run();
}

/** Non-mutating D1/schema probe used by the public readiness route. */
export async function checkDatabaseReadiness(env: Env): Promise<boolean> {
  const artifacts = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'table' AND name IN
         ('envelopes','audit_log','dead_letter','source_counts','heartbeat',
          'quickbooks_webhook_receipts','dedup_claims','replay_requests','app_users',
          'app_magic_links','app_sessions','app_auth_throttles','app_auth_audit',
          'field_actions','field_action_media','app_action_throttles','app_device_pairings',
          'app_devices','lead_ack_receipts','approval_requests','approval_request_events',
          'quote_revision_approval_requests','quote_revision_approval_request_events',
          'production_schedule_approval_requests','production_schedule_approval_request_events',
          'customer_portal_links','customer_portal_access_throttles',
          'measurement_intake_receipts','public_estimate_rate_limits',
          'newo_event_receipts','newo_sessions','newo_control_actions','newo_slot_reservations',
          'newo_reconciliation_runs') THEN 1 ELSE 0 END), 0) AS table_count,
       COALESCE(SUM(CASE WHEN type = 'index' AND name IN
         ('idx_dead_letter_open_envelope','idx_audit_result_ts','idx_envelopes_operational',
          'idx_envelopes_erpnext_error_open','idx_heartbeat_ran_at','idx_qb_receipts_last_seen',
          'idx_audit_run_id','idx_replay_requests_status_updated',
          'idx_app_users_tenant_role_active','idx_app_magic_links_user_expiry',
          'idx_app_sessions_user_expiry','idx_app_auth_throttles_expiry',
          'idx_app_auth_audit_tenant_created','idx_field_actions_job_created',
          'idx_field_actions_recovery','idx_field_action_media_evidence',
          'idx_app_action_throttles_expiry','idx_app_sessions_device_active',
          'idx_app_device_pairings_user_expiry','idx_app_devices_tenant_user_active',
          'idx_lead_ack_receipts_envelope_observed','idx_approval_requests_tenant_state_updated',
          'idx_approval_requests_state_lease','idx_approval_requests_pending_expiry',
          'idx_approval_request_events_tenant_created',
          'idx_quote_revision_approvals_tenant_state_updated',
          'idx_quote_revision_approvals_state_lease','idx_quote_revision_approvals_pending_expiry',
          'idx_quote_revision_approvals_active_target',
          'idx_quote_revision_approval_events_tenant_created',
          'idx_production_schedule_approvals_tenant_state_updated',
          'idx_production_schedule_approvals_state_lease',
          'idx_production_schedule_approvals_pending_expiry',
          'idx_production_schedule_approvals_active_target',
          'idx_production_schedule_approval_events_tenant_created',
          'idx_customer_portal_links_tenant_job_active',
          'idx_customer_portal_access_throttles_expiry',
          'idx_measurement_intake_receipts_exception_updated',
          'idx_public_estimate_rate_limits_expiry',
          'idx_newo_receipts_session','idx_newo_receipts_status',
          'idx_newo_sessions_status','idx_newo_sessions_sync','idx_newo_sessions_phone',
          'idx_newo_sessions_appointment','idx_newo_sessions_verified_job',
          'idx_newo_control_status','idx_newo_slots_expiry',
          'idx_newo_sessions_missing_report','idx_newo_reconciliation_runs_at')
         THEN 1 ELSE 0 END), 0) AS index_count,
       COALESCE(SUM(CASE WHEN type = 'trigger' AND name IN
         ('validate_source_count_insert','validate_source_count_update',
          'prevent_lead_ack_receipts_update','prevent_lead_ack_receipts_delete',
          'prevent_approval_request_binding_rewrite','enforce_approval_request_transition',
          'enforce_approval_request_reconciliation','append_approval_request_created_event',
          'append_approval_request_transition_event','append_approval_request_reconciliation_event',
          'prevent_approval_request_event_update','prevent_approval_request_event_delete',
          'prevent_approval_request_delete',
          'prevent_quote_revision_approval_binding_rewrite',
          'enforce_quote_revision_approval_transition',
          'enforce_quote_revision_approval_reconciliation',
          'append_quote_revision_approval_created_event',
          'append_quote_revision_approval_transition_event',
          'append_quote_revision_approval_reconciliation_event',
          'prevent_quote_revision_approval_event_update',
          'prevent_quote_revision_approval_event_delete',
          'prevent_quote_revision_approval_delete',
          'prevent_production_schedule_approval_binding_rewrite',
          'enforce_production_schedule_approval_transition',
          'enforce_production_schedule_approval_reconciliation',
          'append_production_schedule_approval_created_event',
          'append_production_schedule_approval_transition_event',
          'append_production_schedule_approval_reconciliation_event',
          'prevent_production_schedule_approval_event_update',
          'prevent_production_schedule_approval_event_delete',
          'prevent_production_schedule_approval_delete') THEN 1 ELSE 0 END), 0) AS trigger_count
     FROM sqlite_master`,
  ).first<{ table_count: number; index_count: number; trigger_count: number }>();

  // This zero-row join proves every table/column used by readiness, status, and replay queries
  // exists without reading customer data.
  await env.DB.prepare(
    `SELECT e.envelope_id, e.status, e.updated_at, e.erpnext_error, e.estimate_submission_key,
            a.ts AS audit_ts, a.result AS audit_result, a.run_id, a.approved_by, a.reason,
            d.envelope_id AS dead_envelope_id, d.recovered,
            s.day AS source_day, s.channel, s.count AS source_count,
            h.ran_at, h.reconciled, h.dead_letter_open,
            q.last_seen_at, q.events_count, q.replay_count,
            lar.receipt_id AS lead_ack_receipt_id, lar.outcome AS lead_ack_outcome,
            c.dedup_key,
            rr.run_id AS replay_run_id, rr.selection AS replay_selection,
            rr.status AS replay_status, rr.attempt_count AS replay_attempt_count,
            au.user_id AS app_user_id, au.tenant_id AS app_tenant_id, au.role AS app_role,
            ml.token_hash AS magic_link_hash, ml.expires_at AS magic_link_expires_at,
            aps.session_hash AS app_session_hash, aps.expires_at AS app_session_expires_at,
            dp.token_hash AS device_pairing_hash, dp.expires_at AS device_pairing_expires_at,
            ad.device_id AS app_device_id, ad.paired_at AS app_device_paired_at,
            at.key_hash AS auth_throttle_hash, at.attempts AS auth_throttle_attempts,
            aa.event AS auth_audit_event, aa.outcome AS auth_audit_outcome,
            fa.device_action_id AS field_action_id, fa.payload_hash AS field_payload_hash,
            fam.attachment_id AS field_attachment_id, fam.checksum_sha256 AS field_media_checksum,
            aat.scope AS action_throttle_scope, aat.attempts AS action_throttle_attempts,
            ar.approval_request_id, ar.state AS approval_state, ar.run_id AS approval_run_id,
            are.event_type AS approval_event_type, are.request_version AS approval_event_version,
            qrar.quote_revision_approval_id,
            qrar.state AS quote_revision_approval_state,
            qrar.run_id AS quote_revision_approval_run_id,
            qrare.event_type AS quote_revision_approval_event_type,
            qrare.request_version AS quote_revision_approval_event_version,
            psar.production_schedule_approval_id,
            psar.state AS production_schedule_approval_state,
            psar.run_id AS production_schedule_approval_run_id,
            psare.event_type AS production_schedule_approval_event_type,
            psare.request_version AS production_schedule_approval_event_version,
            cpl.link_id AS customer_portal_link_id,
            cpl.expires_at AS customer_portal_expires_at,
            cpat.ip_hash AS customer_portal_throttle_ip_hash,
            cpat.attempts AS customer_portal_throttle_attempts,
            mir.receipt_id AS measurement_receipt_id,
            mir.status AS measurement_receipt_status,
            mir.measurement_id AS measurement_receipt_measurement_id,
            perl.scope AS public_estimate_rate_limit_scope,
            perl.attempts AS public_estimate_rate_limit_attempts,
            ner.event_id AS newo_event_id, ner.payload_hash AS newo_event_payload_hash,
            ns.session_id AS newo_session_id, ns.verification_status AS newo_verification_status,
            ns.report_expected_at AS newo_report_expected_at,
            ns.report_received_at AS newo_report_received_at,
            ns.report_event_id AS newo_report_event_id,
            ns.missing_report_detected_at AS newo_missing_report_detected_at,
            ns.sync_updated_at AS newo_sync_updated_at,
            nca.action_id AS newo_control_action_id, nca.approval_reason AS newo_approval_reason,
            nca.consumed_at AS newo_control_consumed_at,
            nsr.reservation_id AS newo_slot_reservation_id,
            nrr.run_id AS newo_reconciliation_run_id,
            nrr.usage_status AS newo_usage_status
     FROM envelopes e
     LEFT JOIN audit_log a ON 1 = 0
     LEFT JOIN dead_letter d ON 1 = 0
     LEFT JOIN source_counts s ON 1 = 0
     LEFT JOIN heartbeat h ON 1 = 0
     LEFT JOIN quickbooks_webhook_receipts q ON 1 = 0
     LEFT JOIN lead_ack_receipts lar ON 1 = 0
     LEFT JOIN dedup_claims c ON 1 = 0
     LEFT JOIN replay_requests rr ON 1 = 0
     LEFT JOIN app_users au ON 1 = 0
     LEFT JOIN app_magic_links ml ON 1 = 0
     LEFT JOIN app_sessions aps ON 1 = 0
     LEFT JOIN app_device_pairings dp ON 1 = 0
     LEFT JOIN app_devices ad ON 1 = 0
     LEFT JOIN app_auth_throttles at ON 1 = 0
     LEFT JOIN app_auth_audit aa ON 1 = 0
     LEFT JOIN field_actions fa ON 1 = 0
     LEFT JOIN field_action_media fam ON 1 = 0
     LEFT JOIN app_action_throttles aat ON 1 = 0
     LEFT JOIN approval_requests ar ON 1 = 0
     LEFT JOIN approval_request_events are ON 1 = 0
     LEFT JOIN quote_revision_approval_requests qrar ON 1 = 0
     LEFT JOIN quote_revision_approval_request_events qrare ON 1 = 0
     LEFT JOIN production_schedule_approval_requests psar ON 1 = 0
     LEFT JOIN production_schedule_approval_request_events psare ON 1 = 0
     LEFT JOIN customer_portal_links cpl ON 1 = 0
     LEFT JOIN customer_portal_access_throttles cpat ON 1 = 0
     LEFT JOIN measurement_intake_receipts mir ON 1 = 0
     LEFT JOIN public_estimate_rate_limits perl ON 1 = 0
     LEFT JOIN newo_event_receipts ner ON 1 = 0
     LEFT JOIN newo_sessions ns ON 1 = 0
     LEFT JOIN newo_control_actions nca ON 1 = 0
     LEFT JOIN newo_slot_reservations nsr ON 1 = 0
     LEFT JOIN newo_reconciliation_runs nrr ON 1 = 0
     LIMIT 0`,
  ).all();
  return Number(artifacts?.table_count ?? 0) === 34 &&
    Number(artifacts?.index_count ?? 0) === 50 &&
    Number(artifacts?.trigger_count ?? 0) === 31;
}

/** Envelopes still pending past the threshold — the retry sweep re-drives these. */
export async function listStuck(env: Env, thresholdMin: number, limit: number): Promise<EnvelopeRecord[]> {
  const cutoff = new Date(Date.now() - thresholdMin * 60_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT * FROM envelopes WHERE status = 'pending_jn_push' AND updated_at < ?
     ORDER BY updated_at ASC LIMIT ?`,
  ).bind(cutoff, limit).all<EnvelopeRecord>();
  return res.results ?? [];
}

/**
 * Estimate intake does not use the JobNimbus queue, so ERPNext mirror failures need their
 * own durable retry sweep. The partial error index keeps this bounded by unresolved rows.
 */
export async function listRetryableEstimateErpNextSyncs(
  env: Env,
  thresholdMin: number,
  limit: number,
): Promise<EnvelopeRecord[]> {
  const cutoff = new Date(Date.now() - thresholdMin * 60_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT * FROM envelopes INDEXED BY idx_envelopes_erpnext_error_open
     WHERE estimate_submission_key IS NOT NULL
       AND erpnext_error IS NOT NULL AND trim(erpnext_error) != ''
       AND updated_at < ?
     ORDER BY updated_at ASC LIMIT ?`,
  ).bind(cutoff, limit).all<EnvelopeRecord>();
  return res.results ?? [];
}

/** Envelopes landed per channel for a given UTC day (the "records landed" side of reconcile). */
export async function countLandedByChannel(env: Env, day: string): Promise<Record<string, number>> {
  const res = await env.DB.prepare(
    `SELECT source AS channel, COUNT(*) AS n FROM envelopes
     WHERE substr(created_at, 1, 10) = ? GROUP BY source`,
  ).bind(day).all<{ channel: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.channel] = r.n;
  return out;
}

/** Independent ground-truth counts (Twilio call logs, form-provider/Cloudflare logs, GBP) — operator/cron writes these. */
export async function getSourceCounts(env: Env, day: string): Promise<Record<string, number>> {
  const res = await env.DB.prepare(`SELECT channel, count FROM source_counts WHERE day = ?`)
    .bind(day).all<{ channel: string; count: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.channel] = r.count;
  return out;
}

export async function putSourceCount(env: Env, day: string, channel: string, count: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO source_counts (day, channel, count) VALUES (?,?,?)
     ON CONFLICT(day, channel) DO UPDATE SET count = excluded.count`,
  ).bind(day, channel, count).run();
}

export async function countOpenDeadLetter(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letter WHERE recovered = 0`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getLatestHeartbeat(env: Env): Promise<HeartbeatRecord | null> {
  return await env.DB.prepare(
    `SELECT day, ran_at, reconciled, dead_letter_open
     FROM heartbeat ORDER BY ran_at DESC LIMIT 1`,
  ).first<HeartbeatRecord>();
}

export async function getOperationalEnvelopeCounts(
  env: Env,
  stuckCutoffIso: string,
): Promise<OperationalEnvelopeCounts> {
  const [pendingRow, frappeRow] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS pending,
         COALESCE(SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END), 0) AS stuck
       FROM envelopes WHERE status = 'pending_jn_push'`,
    ).bind(stuckCutoffIso).first<{ pending: number; stuck: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS frappe_errors FROM envelopes INDEXED BY idx_envelopes_erpnext_error_open
       WHERE erpnext_error IS NOT NULL AND trim(erpnext_error) != ''`,
    ).first<{ frappe_errors: number }>(),
  ]);
  return {
    pending: Number(pendingRow?.pending ?? 0),
    stuck: Number(pendingRow?.stuck ?? 0),
    frappe_errors: Number(frappeRow?.frappe_errors ?? 0),
  };
}

export async function listRecentAuditFailures(
  env: Env,
  sinceIso: string,
  limit: number,
): Promise<AuditFailureRecord[]> {
  const res = await env.DB.prepare(
    `SELECT id, ts, automation, trigger, envelope_id, action, result, error, recovery_owner,
            run_id, approved_by, reason
     FROM audit_log WHERE result = 'error' AND ts >= ?
     ORDER BY ts DESC LIMIT ?`,
  ).bind(sinceIso, limit).all<AuditFailureRecord>();
  return res.results ?? [];
}

export async function getLatestQuickBooksWebhookReceipt(
  env: Env,
): Promise<QuickBooksWebhookReceipt | null> {
  return await env.DB.prepare(
    `SELECT payload_hash, first_seen_at, last_seen_at, envelope_id, raw_key, events_count, replay_count
     FROM quickbooks_webhook_receipts ORDER BY last_seen_at DESC LIMIT 1`,
  ).first<QuickBooksWebhookReceipt>();
}

export async function getReplayRequest(env: Env, runId: string): Promise<ReplayRequestRecord | null> {
  return await env.DB.prepare(
    `SELECT run_id, selection, envelope_id, approved_by, reason, status, matched, requeued,
            last_error, attempt_count, created_at, updated_at, completed_at
     FROM replay_requests WHERE run_id = ?`,
  ).bind(runId).first<ReplayRequestRecord>();
}

/**
 * Claim a new run id, replay a failed exact intent, or return the immutable completed outcome.
 * The INSERT primary key plus failed->running conditional UPDATE are the concurrency boundary.
 */
export async function claimReplayRequest(
  env: Env,
  identity: ReplayRequestIdentity,
): Promise<ReplayRequestClaim> {
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO replay_requests
         (run_id, selection, envelope_id, approved_by, reason, status, matched, requeued,
          last_error, attempt_count, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,'running',NULL,NULL,NULL,1,?,?,NULL)`,
    ).bind(
      identity.run_id,
      identity.selection,
      identity.envelope_id,
      identity.approved_by,
      identity.reason,
      now,
      now,
    ).run();
    return { kind: "claimed" };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }

  const existing = await getReplayRequest(env, identity.run_id);
  if (!existing) throw new Error("replay_request_claim_race_missing");
  if (!sameReplayIdentity(existing, identity)) return { kind: "conflict" };
  if (existing.status === "completed") {
    if (existing.matched === null || existing.requeued === null) throw new Error("replay_request_outcome_missing");
    return { kind: "completed", matched: Number(existing.matched), requeued: Number(existing.requeued) };
  }
  if (existing.status === "running") return { kind: "in_progress" };

  const reclaimed = await env.DB.prepare(
    `UPDATE replay_requests
     SET status = 'running', matched = NULL, requeued = NULL, last_error = NULL,
         attempt_count = attempt_count + 1, updated_at = ?, completed_at = NULL
     WHERE run_id = ? AND status = 'failed'`,
  ).bind(now, identity.run_id).run();
  if (d1Changes(reclaimed) === 1) return { kind: "claimed" };

  // Another exact retry won the failed->running CAS, or finished while this request waited.
  const raced = await getReplayRequest(env, identity.run_id);
  if (!raced) throw new Error("replay_request_reclaim_race_missing");
  if (!sameReplayIdentity(raced, identity)) return { kind: "conflict" };
  if (raced.status === "completed") {
    if (raced.matched === null || raced.requeued === null) throw new Error("replay_request_outcome_missing");
    return { kind: "completed", matched: Number(raced.matched), requeued: Number(raced.requeued) };
  }
  return { kind: "in_progress" };
}

export async function completeReplayRequest(
  env: Env,
  runId: string,
  matched: number,
  requeued: number,
): Promise<boolean> {
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE replay_requests
     SET status = 'completed', matched = ?, requeued = ?, last_error = NULL,
         updated_at = ?, completed_at = ?
     WHERE run_id = ? AND status = 'running'`,
  ).bind(matched, requeued, now, now, runId).run();
  return d1Changes(result) === 1;
}

export async function failReplayRequest(env: Env, runId: string, error: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE replay_requests
     SET status = 'failed', last_error = ?, updated_at = ?, completed_at = NULL
     WHERE run_id = ? AND status = 'running'`,
  ).bind(error.slice(0, 500), nowIso(), runId).run();
  return d1Changes(result) === 1;
}

export async function getReplayOperationalCounts(env: Env, stuckCutoffIso: string): Promise<ReplayOperationalCounts> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'running' AND updated_at < ? THEN 1 ELSE 0 END), 0) AS stuck
     FROM replay_requests`,
  ).bind(stuckCutoffIso).first<ReplayOperationalCounts>();
  return { failed: Number(row?.failed ?? 0), stuck: Number(row?.stuck ?? 0) };
}

export async function listOpenDeadLetters(env: Env, limit: number): Promise<DeadLetterRecord[]> {
  const res = await env.DB.prepare(
    `SELECT id, ts, envelope_id, stage, error, payload_json, recovered
     FROM dead_letter WHERE recovered = 0 ORDER BY ts ASC LIMIT ?`,
  ).bind(limit).all<DeadLetterRecord>();
  return res.results ?? [];
}

/** Only open dead letters whose canonical envelope is currently dead are replayable. */
export async function listReplayableDeadEnvelopeIds(
  env: Env,
  envelopeId?: string,
): Promise<string[]> {
  const selected = envelopeId ?? null;
  const res = await env.DB.prepare(
    `SELECT d.envelope_id
     FROM dead_letter d
     INNER JOIN envelopes e ON e.envelope_id = d.envelope_id
     WHERE d.recovered = 0 AND e.status = 'dead' AND d.envelope_id IS NOT NULL
       AND (? IS NULL OR d.envelope_id = ?)
     GROUP BY d.envelope_id
     ORDER BY MIN(d.ts) ASC`,
  ).bind(selected, selected).all<{ envelope_id: string }>();
  return (res.results ?? []).map((row) => row.envelope_id);
}

/** Claim a dead envelope for replay without clearing its forensic error state. */
export async function markEnvelopeReplayPending(env: Env, envelopeId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE envelopes SET status = 'pending_jn_push', updated_at = ?
     WHERE envelope_id = ? AND status = 'dead'`,
  ).bind(nowIso(), envelopeId).run();
  return d1Changes(result) === 1;
}

/** Roll back only an unconsumed replay claim after queue publication fails or is uncertain. */
export async function restoreEnvelopeReplayDead(env: Env, envelopeId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE envelopes SET status = 'dead', updated_at = ?
     WHERE envelope_id = ? AND status = 'pending_jn_push'`,
  ).bind(nowIso(), envelopeId).run();
  return d1Changes(result) === 1;
}

/** Recovery is completion-time and envelope-scoped; unrelated dead-letter rows are untouched. */
export async function markDeadLettersRecovered(env: Env, envelopeId: string): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE dead_letter SET recovered = 1
     WHERE envelope_id = ? AND recovered = 0`,
  ).bind(envelopeId).run();
  return d1Changes(result);
}

export async function writeHeartbeat(env: Env, day: string, reconciled: boolean, openDlq: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeat (day, ran_at, reconciled, dead_letter_open) VALUES (?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET ran_at = excluded.ran_at, reconciled = excluded.reconciled,
       dead_letter_open = excluded.dead_letter_open`,
  ).bind(day, nowIso(), reconciled ? 1 : 0, openDlq).run();
}

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

function sameReplayIdentity(a: ReplayRequestIdentity, b: ReplayRequestIdentity): boolean {
  return a.run_id === b.run_id &&
    a.selection === b.selection &&
    a.envelope_id === b.envelope_id &&
    a.approved_by === b.approved_by &&
    a.reason === b.reason;
}
