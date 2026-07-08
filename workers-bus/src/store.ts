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
       job_number, action, result, error, recovery_owner)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    nowIso(), e.automation, e.trigger, e.envelope_id, e.source_ids ?? null, e.target_ids ?? null,
    e.job_number ?? null, e.action, e.result, e.error ?? null, e.recovery_owner ?? null,
  ).run();
}

export async function recordDeadLetter(env: Env, e: DeadLetterEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
     VALUES (?,?,?,?,?,0)`,
  ).bind(nowIso(), e.envelope_id, e.stage, e.error, e.payload_json).run();
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

/** Envelopes still pending past the threshold — the retry sweep re-drives these. */
export async function listStuck(env: Env, thresholdMin: number, limit: number): Promise<EnvelopeRecord[]> {
  const cutoff = new Date(Date.now() - thresholdMin * 60_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT * FROM envelopes WHERE status = 'pending_jn_push' AND updated_at < ?
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

export async function listOpenDeadLetters(env: Env, limit: number): Promise<DeadLetterRecord[]> {
  const res = await env.DB.prepare(
    `SELECT id, ts, envelope_id, stage, error, payload_json, recovered
     FROM dead_letter WHERE recovered = 0 ORDER BY ts ASC LIMIT ?`,
  ).bind(limit).all<DeadLetterRecord>();
  return res.results ?? [];
}

export async function writeHeartbeat(env: Env, day: string, reconciled: boolean, openDlq: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeat (day, ran_at, reconciled, dead_letter_open) VALUES (?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET ran_at = excluded.ran_at, reconciled = excluded.reconciled,
       dead_letter_open = excluded.dead_letter_open`,
  ).bind(day, nowIso(), reconciled ? 1 : 0, openDlq).run();
}
