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

/**
 * A webhook receipt proves delivery only.  Projection is a separately durable
 * per-entity concern: pending rows are retried, projected rows are never sent
 * again, and rejected rows remain auditable without reaching Frappe.
 */
export type QuickBooksProjectionStatus = "pending" | "projected" | "rejected";

export interface QuickBooksProjectionOutbox {
  payload_hash: string;
  event_index: number;
  realm_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  projection_status: QuickBooksProjectionStatus;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string;
  escalated_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  projected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewQuickBooksProjectionOutbox {
  event_index: number;
  realm_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  projection_status: QuickBooksProjectionStatus;
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

/** Idempotent operator incident for an exhausted measurement Queue message. */
export async function recordMeasurementDeadLetter(
  env: Env,
  receiptId: string,
  error: string,
): Promise<boolean> {
  const entry: DeadLetterEntry = {
    envelope_id: receiptId,
    stage: "measurement_processing",
    error,
    payload_json: JSON.stringify({ measurement_receipt_id: receiptId }),
  };
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
     VALUES (?,?,?,?,?,0)`,
  ).bind(
    nowIso(),
    entry.envelope_id,
    entry.stage,
    entry.error,
    redactedDeadLetterPayload(entry),
  ).run();
  return d1Changes(result) === 1;
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

/**
 * Atomically anchor the signed payload receipt and every entity's projection
 * intent.  A later webhook retry must never infer completion merely because a
 * receipt exists.
 */
export async function insertQuickBooksWebhookReceiptWithProjectionOutbox(
  env: Env,
  receipt: Omit<QuickBooksWebhookReceipt, "replay_count">,
  events: NewQuickBooksProjectionOutbox[],
): Promise<void> {
  const now = receipt.first_seen_at;
  await env.DB.batch([
    env.DB.prepare(
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
    ),
    ...events.map((event) => env.DB.prepare(
      `INSERT INTO quickbooks_projection_outbox
         (payload_hash, event_index, realm_id, entity_type, entity_id, operation, projection_status,
          attempt_count, last_error, last_attempt_at, next_attempt_at, escalated_at,
          lease_token, lease_expires_at, projected_at,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,NULL,NULL,?,NULL,NULL,NULL,NULL,?,?)`,
    ).bind(
      receipt.payload_hash,
      event.event_index,
      event.realm_id,
      event.entity_type,
      event.entity_id,
      event.operation,
      event.projection_status,
      now,
      now,
      now,
    )),
  ]);
}

export async function recordQuickBooksWebhookReplay(env: Env, payloadHash: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE quickbooks_webhook_receipts
     SET last_seen_at = ?, replay_count = replay_count + 1
     WHERE payload_hash = ?`,
  ).bind(nowIso(), payloadHash).run();
}

/** Only due, expired-or-unleased pending items are eligible for a projection attempt. */
export async function listReadyQuickBooksProjectionOutbox(
  env: Env,
  payloadHash: string,
  now: string,
): Promise<QuickBooksProjectionOutbox[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM quickbooks_projection_outbox
     WHERE payload_hash = ? AND projection_status = 'pending'
       AND next_attempt_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY event_index ASC`,
  ).bind(payloadHash, now, now).all<QuickBooksProjectionOutbox>();
  return result.results ?? [];
}

/** The frequent cron recovers due work even when the provider stops redelivering. */
export async function listDueQuickBooksProjectionOutbox(
  env: Env,
  now: string,
  limit: number,
): Promise<QuickBooksProjectionOutbox[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM quickbooks_projection_outbox
     WHERE projection_status = 'pending' AND next_attempt_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY next_attempt_at ASC, updated_at ASC, payload_hash ASC, event_index ASC
     LIMIT ?`,
  ).bind(now, now, limit).all<QuickBooksProjectionOutbox>();
  return result.results ?? [];
}

/** A conditional update gives concurrent Intuit redeliveries one projection owner. */
export async function claimQuickBooksProjectionOutbox(
  env: Env,
  item: Pick<QuickBooksProjectionOutbox, "payload_hash" | "event_index">,
  leaseToken: string,
  now: string,
  leaseExpiresAt: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_projection_outbox
     SET lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
         last_attempt_at = ?, last_error = NULL, updated_at = ?
     WHERE payload_hash = ? AND event_index = ? AND projection_status = 'pending'
       AND next_attempt_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).bind(
    leaseToken,
    leaseExpiresAt,
    now,
    now,
    item.payload_hash,
    item.event_index,
    now,
    now,
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function markQuickBooksProjectionProjected(
  env: Env,
  item: Pick<QuickBooksProjectionOutbox, "payload_hash" | "event_index">,
  leaseToken: string,
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_projection_outbox
     SET projection_status = 'projected', lease_token = NULL, lease_expires_at = NULL,
         last_error = NULL, projected_at = ?, updated_at = ?
     WHERE payload_hash = ? AND event_index = ? AND projection_status = 'pending' AND lease_token = ?`,
  ).bind(now, now, item.payload_hash, item.event_index, leaseToken).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** A non-retryable projection rejection is retained for operator follow-up. */
export async function markQuickBooksProjectionRejected(
  env: Env,
  item: Pick<QuickBooksProjectionOutbox, "payload_hash" | "event_index">,
  leaseToken: string,
  error: string,
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_projection_outbox
     SET projection_status = 'rejected', lease_token = NULL, lease_expires_at = NULL,
         last_error = ?, updated_at = ?
     WHERE payload_hash = ? AND event_index = ? AND projection_status = 'pending' AND lease_token = ?`,
  ).bind(error, now, item.payload_hash, item.event_index, leaseToken).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** Leave the item pending after a transient Frappe/D1 failure; no terminal ack is implied. */
export async function releaseQuickBooksProjectionOutbox(
  env: Env,
  item: Pick<QuickBooksProjectionOutbox, "payload_hash" | "event_index">,
  leaseToken: string,
  error: string,
  now: string,
  nextAttemptAt: string,
  escalate: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE quickbooks_projection_outbox
     SET lease_token = NULL, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?,
         escalated_at = CASE WHEN ? = 1 AND escalated_at IS NULL THEN ? ELSE escalated_at END,
         updated_at = ?
     WHERE payload_hash = ? AND event_index = ? AND projection_status = 'pending' AND lease_token = ?`,
  ).bind(
    error,
    nextAttemptAt,
    escalate ? 1 : 0,
    now,
    now,
    item.payload_hash,
    item.event_index,
    leaseToken,
  ).run();
}

export async function countPendingQuickBooksProjectionOutbox(env: Env, payloadHash: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS pending_count FROM quickbooks_projection_outbox
     WHERE payload_hash = ? AND projection_status = 'pending'`,
  ).bind(payloadHash).first<{ pending_count: number }>();
  return Number(row?.pending_count ?? 0);
}

export type ReadinessColumnProbe = { table: string; columns: readonly string[] };

/**
 * Every table and column the readiness, status, and replay queries read. Held as
 * data, not as one join, because D1 refuses any result set wider than 100 columns:
 * the single zero-row join this replaced had grown to 122 and failed outright with
 * `too many columns in result set`, which took `/ready` red on every fresh stack.
 */
export const READINESS_COLUMN_PROBES: readonly ReadinessColumnProbe[] = [
  {
    table: "envelopes",
    columns: ["envelope_id", "status", "updated_at", "erpnext_error", "estimate_submission_key"],
  },
  { table: "audit_log", columns: ["ts", "result", "run_id", "approved_by", "reason"] },
  { table: "dead_letter", columns: ["envelope_id", "recovered"] },
  { table: "source_counts", columns: ["day", "channel", "count"] },
  { table: "heartbeat", columns: ["ran_at", "reconciled", "dead_letter_open"] },
  {
    table: "quickbooks_webhook_receipts",
    columns: ["last_seen_at", "events_count", "replay_count"],
  },
  { table: "quickbooks_projection_outbox", columns: ["projection_status", "attempt_count"] },
  { table: "lead_ack_receipts", columns: ["receipt_id", "outcome"] },
  { table: "dedup_claims", columns: ["dedup_key"] },
  { table: "replay_requests", columns: ["run_id", "selection", "status", "attempt_count"] },
  { table: "app_users", columns: ["user_id", "tenant_id", "role", "access_role"] },
  { table: "app_magic_links", columns: ["token_hash", "expires_at"] },
  { table: "app_sessions", columns: ["session_hash", "expires_at"] },
  { table: "app_device_pairings", columns: ["token_hash", "expires_at"] },
  { table: "app_devices", columns: ["device_id", "paired_at"] },
  { table: "app_auth_throttles", columns: ["key_hash", "attempts"] },
  { table: "app_auth_audit", columns: ["event", "outcome"] },
  { table: "field_actions", columns: ["device_action_id", "payload_hash"] },
  { table: "field_action_media", columns: ["attachment_id", "checksum_sha256"] },
  { table: "field_work_package_actions", columns: ["device_action_id", "work_package_id"] },
  { table: "app_action_throttles", columns: ["scope", "attempts"] },
  { table: "approval_requests", columns: ["approval_request_id", "state", "run_id"] },
  { table: "approval_request_events", columns: ["event_type", "request_version"] },
  { table: "governed_transitions", columns: ["transition_id", "subject_ref"] },
  { table: "governed_transition_outbox", columns: ["outbox_id", "state", "attempt_count"] },
  { table: "governed_transition_outbox_events", columns: ["event_type"] },
  {
    table: "quote_revision_approval_requests",
    columns: ["quote_revision_approval_id", "state", "run_id"],
  },
  { table: "quote_revision_approval_request_events", columns: ["event_type", "request_version"] },
  {
    table: "production_schedule_approval_requests",
    columns: ["production_schedule_approval_id", "state", "run_id"],
  },
  {
    table: "production_schedule_approval_request_events",
    columns: ["event_type", "request_version"],
  },
  { table: "customer_portal_links", columns: ["link_id", "expires_at"] },
  { table: "customer_portal_access_throttles", columns: ["ip_hash", "attempts"] },
  {
    table: "measurement_intake_receipts",
    columns: ["receipt_id", "status", "measurement_id", "report_raw_key", "report_sha256",
      "ocr_status", "ocr_result_key", "ocr_review_required"],
  },
  { table: "public_estimate_rate_limits", columns: ["scope", "attempts"] },
  { table: "newo_event_receipts", columns: ["event_id", "payload_hash"] },
  {
    table: "newo_sessions",
    columns: ["session_id", "verification_status", "report_expected_at", "report_received_at",
      "report_event_id", "missing_report_detected_at", "sync_updated_at"],
  },
  { table: "newo_control_actions", columns: ["action_id", "approval_reason", "consumed_at"] },
  { table: "newo_slot_reservations", columns: ["reservation_id"] },
  { table: "newo_reconciliation_runs", columns: ["run_id", "usage_status"] },
  { table: "hermes_desktop_pairings", columns: ["pairing_id", "token_sha256", "consumed_at"] },
  { table: "hermes_desktop_devices", columns: ["device_id", "access_token_sha256", "revoked_at"] },
  { table: "hermes_desktop_envelopes", columns: ["envelope_id", "context_sha256", "state"] },
  { table: "hermes_desktop_contexts", columns: ["context_id", "context_sha256", "staged_at"] },
  { table: "hermes_desktop_results", columns: ["result_id", "result_json", "recorded_at"] },
  { table: "hermes_desktop_events", columns: ["event_id", "detail_sha256", "created_at"] },
];

/**
 * Columns per probe statement. Deliberately far below D1's 100-column ceiling so
 * that adding a table to the list above cannot walk the probe back over the limit.
 */
export const READINESS_PROBE_COLUMN_BUDGET = 64;

/**
 * Group the probes into zero-row selects that each stay inside the budget. A probe
 * wider than the budget on its own still gets its own statement rather than being
 * silently dropped — the budget is enforced by test, not by truncating coverage.
 */
export function buildReadinessColumnProbeSql(
  probes: readonly ReadinessColumnProbe[] = READINESS_COLUMN_PROBES,
  budget: number = READINESS_PROBE_COLUMN_BUDGET,
): string[] {
  const groups: ReadinessColumnProbe[][] = [];
  let current: ReadinessColumnProbe[] = [];
  let width = 0;
  for (const probe of probes) {
    if (current.length > 0 && width + probe.columns.length > budget) {
      groups.push(current);
      current = [];
      width = 0;
    }
    current.push(probe);
    width += probe.columns.length;
  }
  if (current.length > 0) groups.push(current);
  return groups.map(renderReadinessProbeSql);
}

/** One zero-row select: every listed column, no row, no customer data read. */
function renderReadinessProbeSql(group: readonly ReadinessColumnProbe[]): string {
  const columns = group.flatMap((probe, index) =>
    probe.columns.map((column) => `p${index}.${column} AS p${index}_${column}`),
  );
  const sources = group.map((probe, index) =>
    index === 0 ? `${probe.table} p0` : `LEFT JOIN ${probe.table} p${index} ON 1 = 0`,
  );
  return `SELECT ${columns.join(", ")} FROM ${sources.join(" ")} LIMIT 0`;
}

/** Non-mutating D1/schema probe used by the public readiness route. */
export async function checkDatabaseReadiness(env: Env): Promise<boolean> {
  const artifacts = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'table' AND name IN
         ('envelopes','audit_log','dead_letter','source_counts','heartbeat',
          'quickbooks_webhook_receipts','quickbooks_projection_outbox','dedup_claims','replay_requests','app_users',
          'app_magic_links','app_sessions','app_auth_throttles','app_auth_audit',
          'field_actions','field_action_media','field_work_package_actions','app_action_throttles','app_device_pairings',
          'app_devices','lead_ack_receipts','approval_requests','approval_request_events',
          'governed_transitions','governed_transition_outbox','governed_transition_outbox_events',
          'quote_revision_approval_requests','quote_revision_approval_request_events',
          'production_schedule_approval_requests','production_schedule_approval_request_events',
          'customer_portal_links','customer_portal_access_throttles',
          'measurement_intake_receipts','public_estimate_rate_limits',
          'newo_event_receipts','newo_sessions','newo_control_actions','newo_slot_reservations',
          'newo_reconciliation_runs','hermes_desktop_pairings','hermes_desktop_devices',
          'hermes_desktop_envelopes','hermes_desktop_contexts','hermes_desktop_results',
          'hermes_desktop_events') THEN 1 ELSE 0 END), 0) AS table_count,
       COALESCE(SUM(CASE WHEN type = 'index' AND name IN
         ('idx_dead_letter_open_envelope','idx_audit_result_ts','idx_envelopes_operational',
          'idx_envelopes_erpnext_error_open','idx_heartbeat_ran_at','idx_qb_receipts_last_seen',
          'idx_qb_projection_outbox_pending',
          'idx_audit_run_id','idx_replay_requests_status_updated',
          'idx_app_users_tenant_role_active','idx_app_users_tenant_access_role_active',
          'idx_app_magic_links_user_expiry',
          'idx_app_sessions_user_expiry','idx_app_auth_throttles_expiry',
          'idx_app_auth_audit_tenant_created','idx_field_actions_job_created',
          'idx_field_actions_recovery','idx_field_action_media_evidence',
          'idx_field_work_package_actions_job_created','idx_field_work_package_actions_recovery',
          'idx_app_action_throttles_expiry','idx_app_sessions_device_active',
          'idx_app_device_pairings_user_expiry','idx_app_devices_tenant_user_active',
          'idx_lead_ack_receipts_envelope_observed','idx_approval_requests_tenant_state_updated',
          'idx_approval_requests_state_lease','idx_approval_requests_pending_expiry',
          'idx_approval_request_events_tenant_created',
          'idx_governed_transitions_tenant_created','idx_governed_transition_outbox_pending',
          'idx_governed_transition_outbox_events_tenant_created',
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
          'idx_measurement_intake_receipts_ocr_review',
          'idx_dead_letter_open_measurement',
          'idx_public_estimate_rate_limits_expiry',
          'idx_newo_receipts_session','idx_newo_receipts_status',
          'idx_newo_sessions_status','idx_newo_sessions_sync','idx_newo_sessions_phone',
          'idx_newo_sessions_appointment','idx_newo_sessions_verified_job',
          'idx_newo_control_status','idx_newo_slots_expiry',
          'idx_newo_sessions_missing_report','idx_newo_reconciliation_runs_at',
          'idx_hermes_desktop_pairings_user_expiry','idx_hermes_desktop_devices_binding_active',
          'idx_hermes_desktop_envelopes_device_state_expiry',
          'idx_hermes_desktop_events_tenant_created')
         THEN 1 ELSE 0 END), 0) AS index_count,
       COALESCE(SUM(CASE WHEN type = 'trigger' AND name IN
         ('validate_source_count_insert','validate_source_count_update',
          'prevent_lead_ack_receipts_update','prevent_lead_ack_receipts_delete',
          'prevent_approval_request_binding_rewrite','enforce_approval_request_transition',
          'enforce_approval_request_reconciliation','append_approval_request_created_event',
          'append_approval_request_transition_event','append_approval_request_reconciliation_event',
          'prevent_approval_request_event_update','prevent_approval_request_event_delete',
          'prevent_approval_request_delete',
          'prevent_governed_transition_update','prevent_governed_transition_delete',
          'enforce_governed_transition_outbox_update','prevent_governed_transition_outbox_delete',
          'append_governed_transition_outbox_intent_event',
          'append_governed_transition_outbox_state_event',
          'renew_approval_execution_lease_from_governed_outbox_claim',
          'prevent_governed_transition_outbox_event_update',
          'prevent_governed_transition_outbox_event_delete',
          'enqueue_governed_transition_from_approval_claim',
          'project_governed_transition_outbox_terminal',
          'project_governed_transition_outbox_reconciliation',
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
          'prevent_production_schedule_approval_delete',
          'facet_design_evidence_associations_validate_insert',
          'hermes_desktop_contexts_immutable_delete','hermes_desktop_contexts_immutable_update',
          'hermes_desktop_devices_binding_immutable','hermes_desktop_envelopes_binding_immutable',
          'hermes_desktop_envelopes_state_transition','hermes_desktop_events_immutable_delete',
          'hermes_desktop_events_immutable_update','hermes_desktop_pairings_binding_immutable',
          'hermes_desktop_results_append_only_delete',
          'hermes_desktop_results_append_only_update') THEN 1 ELSE 0 END), 0) AS trigger_count
     FROM sqlite_master`,
  ).first<{ table_count: number; index_count: number; trigger_count: number }>();

  const authority = await env.DB.prepare(
    `SELECT
       (SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_app_users_tenant_access_role_active')
         AS access_role_index_sql,
       (SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'facet_design_evidence_associations_validate_insert')
         AS facet_association_trigger_sql,
       (SELECT COUNT(*) FROM app_users WHERE active = 1 AND access_role IS NULL)
         AS unresolved_access_roles`,
  ).first<{
    access_role_index_sql: string | null;
    facet_association_trigger_sql: string | null;
    unresolved_access_roles: number;
  }>();
  const accessRoleIndexSql = normalizeSchemaSql(authority?.access_role_index_sql);
  const facetAssociationTriggerSql = normalizeSchemaSql(
    authority?.facet_association_trigger_sql,
  );
  const authoritySchemaReady =
    accessRoleIndexSql.includes(
      "createindexidx_app_users_tenant_access_role_activeonapp_users(tenant_id,active,access_role,updated_at)",
    ) &&
    [
      "beforeinsertonfacet_design_evidence_associations",
      "event.event_type='facet.design.customer_approved.v2'",
      "event.schema_version=2",
      "event.approval_actor_type='customer_capability'",
      "event.identity_assurance='bearer_capability_only'",
      "actor.user_id=new.associated_by_user_id",
      "actor.tenant_id=new.tenant_id",
      "actor.active=1",
      "actor.access_rolein('owner','ops')",
      "raise(abort,'facet_design_association_office_actor_required')",
    ].every((fragment) => facetAssociationTriggerSql.includes(fragment)) &&
    !facetAssociationTriggerSql.includes("coalesce(") &&
    Number(authority?.unresolved_access_roles ?? -1) === 0;

  // The zero-row probes prove every table and column readiness, status, and replay
  // depend on, without reading a single customer row.
  for (const sql of buildReadinessColumnProbeSql()) await env.DB.prepare(sql).all();
  return Number(artifacts?.table_count ?? 0) === 45 &&
    Number(artifacts?.index_count ?? 0) === 63 &&
    Number(artifacts?.trigger_count ?? 0) === 54 &&
    authoritySchemaReady;
}

function normalizeSchemaSql(sql: string | null | undefined): string {
  return (sql ?? "").toLowerCase().replace(/\s+/g, "").replaceAll("ifnotexists", "");
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

/** Ledger identity every automated sweep replay is booked under, and the key its attempt count is derived from. */
export const DEAD_LETTER_SWEEP_APPROVER = "cron@dead-letter-sweep";

/**
 * Ledger outcomes that mean "nothing was left to replay", not "the replay failed".
 *
 * `executeReplayRequest` books both when a targeted replay matches or requeues nothing, which for
 * the sweep means an admin replay claimed the envelope first. Excluding them from the attempt
 * count keeps a race from burning one of the envelope's bounded automatic attempts.
 */
export const REPLAY_NOOP_ERRORS = [
  "dead_letter_not_replayable",
  "dead_letter_replay_conflict",
] as const;

export interface AutoReplayCandidate {
  envelope_id: string;
  /** Sweep replays booked for the CURRENT outage episode; the attempt cap counts these. */
  attempts: number;
  /** Most recent sweep replay of the current episode, or null when it has not been touched yet. */
  last_attempt_at: string | null;
  /** Oldest open dead-letter row, which opens the episode and is the pre-first-attempt clock. */
  dead_since: string;
}

/**
 * Dead envelopes the sweep may consider, carrying the ledger facts its cap and backoff need.
 *
 * Deliberately a separate query rather than a filter on `listReplayableDeadEnvelopeIds`: that one
 * also backs the admin replay endpoint, so narrowing it would make manual replay impossible for
 * exactly the envelopes that exhausted their automatic attempts and need a human most.
 *
 * ## Why `dead_letter` is collapsed before the ledger is joined (ELEC-137 defect 1)
 *
 * `dead_letter` holds one row per dead-letter EVENT, so one envelope in one outage accumulates a
 * fresh open row every time a replay re-dies. Joining `replay_requests` straight onto that table
 * multiplies rows: two open dead-letter rows against one real attempt reported `attempts = 2`, and
 * the cap fired at roughly half its configured budget. The `ep` sub-select reduces the envelope to
 * exactly one row first, so `COUNT(r.run_id)` counts ledger rows and nothing else.
 *
 * ## Why the ledger join is bounded by `dead_since` (ELEC-137 defect 2)
 *
 * The cap is per outage episode, not per lifetime. An episode opens with the envelope's oldest
 * OPEN dead-letter row and closes when `markDeadLettersRecovered` closes every row it owns — which
 * is why the boundary is `MIN(ts)` over open rows and not the newest row: a re-death mid-outage
 * belongs to the episode already running. Without `r.created_at >= ep.dead_since` an envelope that
 * ever exhausted its attempts inherited that spent count forever, and a later unrelated death was
 * given up with zero automatic attempts — permanently manual from then on.
 */
export async function listAutoReplayCandidates(
  env: Env,
  limit: number,
): Promise<AutoReplayCandidate[]> {
  const res = await env.DB.prepare(
    `SELECT ep.envelope_id AS envelope_id,
            COUNT(r.run_id) AS attempts,
            MAX(r.created_at) AS last_attempt_at,
            ep.dead_since AS dead_since
     FROM (
       SELECT d.envelope_id AS envelope_id, MIN(d.ts) AS dead_since
       FROM dead_letter d
       WHERE d.recovered = 0 AND d.envelope_id IS NOT NULL
       GROUP BY d.envelope_id
     ) ep
     INNER JOIN envelopes e ON e.envelope_id = ep.envelope_id
     LEFT JOIN replay_requests r
            ON r.envelope_id = ep.envelope_id
           AND r.approved_by = ?
           AND r.created_at >= ep.dead_since
           AND (r.last_error IS NULL OR r.last_error NOT IN (?, ?))
     WHERE e.status = 'dead'
     GROUP BY ep.envelope_id, ep.dead_since
     ORDER BY ep.dead_since ASC
     LIMIT ?`,
  ).bind(
    DEAD_LETTER_SWEEP_APPROVER,
    REPLAY_NOOP_ERRORS[0],
    REPLAY_NOOP_ERRORS[1],
    limit,
  ).all<{ envelope_id: string; attempts: number; last_attempt_at: string | null; dead_since: string }>();
  return (res.results ?? []).map((row) => ({
    envelope_id: row.envelope_id,
    attempts: Number(row.attempts ?? 0),
    last_attempt_at: row.last_attempt_at ?? null,
    dead_since: row.dead_since,
  }));
}

/**
 * Envelopes the sweep replayed that have since reached a settled outcome.
 *
 * `pending_jn_push` is excluded on purpose: that is a replay still in flight, not a recovery.
 */
export async function countRecoveredAutoReplays(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT r.envelope_id) AS n
     FROM replay_requests r
     INNER JOIN envelopes e ON e.envelope_id = r.envelope_id
     WHERE r.approved_by = ? AND r.envelope_id IS NOT NULL
       AND e.status NOT IN ('dead', 'pending_jn_push')`,
  ).bind(DEAD_LETTER_SWEEP_APPROVER).first<{ n: number }>();
  return Number(row?.n ?? 0);
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
