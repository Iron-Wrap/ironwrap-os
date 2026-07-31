// quickbooks.ts — QuickBooks Online webhook receiver (Phase 3, spec 04 §WF4).
//
// Verifies Intuit's HMAC signature, records a raw receipt first, and opens bounded
// reconciliation work for supported finance identities. A webhook is not provider
// detail: it must never be used to infer paid, posted, reconciled, or amount facts.

import { newEnvelopeId } from "./core.ts";
import { pushQuickBooksEventToErpNext } from "./erpnext.ts";
import * as store from "./store.ts";

export interface QbEntityEvent { realmId: string; type: string; id: string; operation: string }

const FINANCE_ENTITY_TYPES = new Set(["Invoice", "Payment", "CreditMemo", "RefundReceipt"]);
const FINANCE_OPERATIONS = new Set(["Create", "Update", "Delete", "Void"]);
const QBO_ID = /^[1-9][0-9]{0,31}$/;

/** Pull the flat list of entity changes out of an Intuit webhook payload. Pure. */
export function parseQbEvents(raw: unknown): QbEntityEvent[] {
  const out: QbEntityEvent[] = [];
  const notes = (raw as { eventNotifications?: unknown[] })?.eventNotifications;
  for (const n of Array.isArray(notes) ? notes : []) {
    const realmId = String((n as { realmId?: unknown })?.realmId ?? "").trim();
    const entities = (n as { dataChangeEvent?: { entities?: unknown[] } })?.dataChangeEvent?.entities;
    for (const e of Array.isArray(entities) ? entities : []) {
      const ent = e as { name?: unknown; id?: unknown; operation?: unknown };
      const type = String(ent.name ?? "").trim();
      const id = String(ent.id ?? "").trim();
      const operation = String(ent.operation ?? "").trim();
      if (QBO_ID.test(realmId) && QBO_ID.test(id) && FINANCE_ENTITY_TYPES.has(type) && FINANCE_OPERATIONS.has(operation)) {
        out.push({ realmId, type, id, operation });
      }
    }
  }
  return out;
}

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify Intuit's `intuit-signature` header: base64(HMAC-SHA256(body, verifierToken)). */
export async function verifyIntuitSignature(token: string, body: string, signature: string): Promise<boolean> {
  if (!token || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqualStr(computed, signature.trim());
}

/** POST /webhook/quickbooks handler. No bearer — authenticity is the Intuit signature. */
export async function handleQuickbooksWebhook(env: Env, rawText: string, signature: string | null): Promise<Response> {
  if (!env.QB_WEBHOOK_TOKEN) return jsonResp({ error: "quickbooks_not_configured" }, 503);
  if (!signature || !(await verifyIntuitSignature(env.QB_WEBHOOK_TOKEN, rawText, signature))) {
    return jsonResp({ error: "bad_signature" }, 401);
  }
  const payloadHash = await sha256Hex(rawText);
  const existing = await store.getQuickBooksWebhookReceipt(env, payloadHash);
  if (existing) return await replayResponse(env, existing);

  const id = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/quickbooks/${now.slice(0, 10)}/${id}.json`;
  await store.putRaw(env, rawKey, rawText, "application/json");

  let parsed: unknown = {};
  try { parsed = JSON.parse(rawText); } catch { /* keep {} — raw is already stored */ }
  const events = parseQbEvents(parsed);
  try {
    await store.insertQuickBooksWebhookReceipt(env, {
      payload_hash: payloadHash,
      first_seen_at: now,
      last_seen_at: now,
      envelope_id: id,
      raw_key: rawKey,
      events_count: events.length,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const raced = await store.getQuickBooksWebhookReceipt(env, payloadHash);
      if (raced) return await replayResponse(env, raced);
    }
    throw err;
  }

  const erpnextPaymentMilestoneIds: string[] = [];
  const erpnextReconciliationIds: string[] = [];
  const unresolvedReconciliationIds: string[] = [];
  let erpnextError: string | null = null;
  for (const [eventIndex, e] of events.entries()) {
    const erp = await syncQuickBooksEventToErpNext(env, id, e, rawKey, now, payloadHash, eventIndex);
    if (erp.paymentMilestoneName) erpnextPaymentMilestoneIds.push(erp.paymentMilestoneName);
    if (erp.reconciliationName) erpnextReconciliationIds.push(erp.reconciliationName);
    if (erp.unresolved && erp.reconciliationName) unresolvedReconciliationIds.push(erp.reconciliationName);
    if (erp.error) erpnextError = erp.error;
    await store.recordAudit(env, { automation: "quickbooks", trigger: "webhook", envelope_id: id,
      source_ids: `${e.type}:${e.id}`, target_ids: erp.reconciliationName ? `integration_reconciliation:${erp.reconciliationName}` : undefined,
      action: `qb_${e.operation}`.toLowerCase(),
      result: erp.error ? "error" : "ok" });
  }
  return jsonResp({
    ok: true,
    events: events.length,
    provider_truth_reconciled: false,
    erpnext_payment_milestone_ids: erpnextPaymentMilestoneIds,
    erpnext_reconciliation_ids: erpnextReconciliationIds,
    unresolved_reconciliation_ids: unresolvedReconciliationIds,
    erpnext_error: erpnextError,
  });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function replayResponse(env: Env, receipt: store.QuickBooksWebhookReceipt): Promise<Response> {
  await store.recordQuickBooksWebhookReplay(env, receipt.payload_hash);
  await store.recordAudit(env, {
    automation: "quickbooks",
    trigger: "webhook",
    envelope_id: receipt.envelope_id,
    source_ids: `payload:${receipt.payload_hash.slice(0, 16)}`,
    action: "webhook_replay",
    result: "ok",
  });
  return jsonResp({
    ok: true,
    replay: true,
    envelope_id: receipt.envelope_id,
    events: receipt.events_count,
    provider_truth_reconciled: false,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isUniqueConstraintError(err: unknown): boolean {
  return /unique|constraint/i.test(String(err));
}

async function syncQuickBooksEventToErpNext(
  env: Env,
  envelopeId: string,
  event: QbEntityEvent,
  rawKey: string,
  eventTs: string,
  payloadHash: string,
  eventIndex: number,
): Promise<{ paymentMilestoneName: string | null; reconciliationName: string | null; unresolved: boolean; error: string | null }> {
  try {
    const erp = await pushQuickBooksEventToErpNext(env, {
      realmId: event.realmId,
      type: event.type,
      id: event.id,
      operation: event.operation,
      rawKey,
      eventTs,
      payloadHash,
      eventIndex,
    });
    if (erp) {
      await store.recordAudit(env, { automation: "erpnext_quickbooks", trigger: "webhook",
        envelope_id: envelopeId, source_ids: `${event.type}:${event.id}`,
        target_ids: `integration_reconciliation:${erp.reconciliationName}`,
        action: erp.reused ? "reuse_pending_reconciliation" : "create_pending_reconciliation", result: "ok" });
    }
    return {
      paymentMilestoneName: erp?.paymentMilestoneName ?? null,
      reconciliationName: erp?.reconciliationName ?? null,
      unresolved: erp?.unresolved ?? false,
      error: null,
    };
  } catch (err) {
    const error = `erpnext_quickbooks: ${String(err)}`;
    await store.recordAudit(env, { automation: "erpnext_quickbooks", trigger: "webhook",
      envelope_id: envelopeId, source_ids: `${event.type}:${event.id}`, action: "sync", result: "error", error });
    return { paymentMilestoneName: null, reconciliationName: null, unresolved: true, error };
  }
}
