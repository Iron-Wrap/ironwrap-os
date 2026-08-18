// quickbooks.ts — QuickBooks Online webhook receiver (Phase 3, spec 04 §WF4).
//
// Verifies Intuit's HMAC signature, records a raw receipt first, and opens bounded
// reconciliation work for supported finance identities. A webhook is not provider
// detail: it must never be used to infer paid, posted, reconciled, or amount facts.

import { newEnvelopeId } from "./core.ts";
import {
  assertQuickBooksProjectionReady,
  pushQuickBooksEventToErpNext,
  type ErpNextQuickBooksEventResult,
} from "./erpnext.ts";
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
  const expectedRealmId = configuredQuickBooksRealm(env);
  if (!expectedRealmId) return jsonResp({ error: "quickbooks_realm_not_configured" }, 503);
  if (!signature || !(await verifyIntuitSignature(env.QB_WEBHOOK_TOKEN, rawText, signature))) {
    return jsonResp({ error: "bad_signature" }, 401);
  }
  const payloadHash = await sha256Hex(rawText);
  const existing = await store.getQuickBooksWebhookReceipt(env, payloadHash);
  if (existing) return await replayResponse(env, existing);

  let parsed: unknown = {};
  try { parsed = JSON.parse(rawText); } catch { /* signed raw is retained after dependency preflight */ }
  const events = parseQbEvents(parsed);

  // Do not accept a new signed receipt into a dead projection route. Existing
  // receipts stay durable and retryable; Intuit can redeliver this one after a
  // bounded issuer/configuration deployment is repaired.
  if (events.some((event) => event.realmId === expectedRealmId)) {
    try {
      await assertQuickBooksProjectionReady(env);
    } catch {
      return jsonResp({ error: "quickbooks_projection_not_ready" }, 503);
    }
  }

  const id = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/quickbooks/${now.slice(0, 10)}/${id}.json`;
  await store.putRaw(env, rawKey, rawText, "application/json");

  const receipt: store.QuickBooksWebhookReceipt = {
    payload_hash: payloadHash,
    first_seen_at: now,
    last_seen_at: now,
    envelope_id: id,
    raw_key: rawKey,
    events_count: events.length,
    replay_count: 0,
  };
  try {
    await store.insertQuickBooksWebhookReceiptWithProjectionOutbox(env, receipt, events.map((event, eventIndex) => ({
      event_index: eventIndex,
      realm_id: event.realmId,
      entity_type: event.type,
      entity_id: event.id,
      operation: event.operation,
      // A valid Intuit signature does not authorize another company realm.
      projection_status: event.realmId === expectedRealmId ? "pending" : "rejected",
    })));
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const raced = await store.getQuickBooksWebhookReceipt(env, payloadHash);
      if (raced) return await replayResponse(env, raced);
    }
    throw err;
  }

  for (const event of events) {
    if (event.realmId !== expectedRealmId) {
      await store.recordAudit(env, {
        automation: "quickbooks",
        trigger: "webhook",
        envelope_id: id,
        source_ids: `${event.type}:${event.id}`,
        action: "realm_rejected",
        result: "ok",
      });
    }
  }
  return await projectReceipt(env, receipt, false);
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function replayResponse(env: Env, receipt: store.QuickBooksWebhookReceipt): Promise<Response> {
  await store.recordQuickBooksWebhookReplay(env, receipt.payload_hash);
  return await projectReceipt(env, receipt, true);
}

function configuredQuickBooksRealm(env: Env): string | null {
  const realmId = String(env.QB_EXPECTED_REALM_ID ?? "").trim();
  return QBO_ID.test(realmId) ? realmId : null;
}

const QUICKBOOKS_PROJECTION_LEASE_MS = 60_000;
const QUICKBOOKS_PROJECTION_RETRY_BASE_SECONDS = 60;
const QUICKBOOKS_PROJECTION_RETRY_MAX_SECONDS = 3_600;
const QUICKBOOKS_PROJECTION_ESCALATION_ATTEMPTS = 5;
const QUICKBOOKS_SCHEDULED_PROJECTION_LIMIT = 25;

type ProjectionTrigger = "webhook" | "scheduled";
type ProjectionOutcome =
  | { state: "projected"; erp: ErpNextQuickBooksEventResult }
  | { state: "rejected" }
  | { state: "pending"; escalated: boolean }
  | { state: "not_claimed" };

interface ProjectionBatch {
  paymentMilestoneIds: string[];
  reconciliationIds: string[];
  unresolvedReconciliationIds: string[];
  rejectedCount: number;
  pendingCount: number;
  escalatedCount: number;
}

/**
 * Project only due pending rows. A signed receipt remains pending after a
 * transient ERP failure, so a webhook replay (or cron) resumes exactly the
 * missing work rather than terminally acknowledging the whole payload.
 */
async function projectReceipt(
  env: Env,
  receipt: store.QuickBooksWebhookReceipt,
  replay: boolean,
): Promise<Response> {
  const now = new Date().toISOString();
  const pending = await store.listReadyQuickBooksProjectionOutbox(env, receipt.payload_hash, now);
  const projected = await projectOutboxItems(env, receipt, pending, "webhook");
  const pendingCount = await store.countPendingQuickBooksProjectionOutbox(env, receipt.payload_hash);
  await store.recordAudit(env, {
    automation: "quickbooks",
    trigger: "webhook",
    envelope_id: receipt.envelope_id,
    source_ids: `payload:${receipt.payload_hash.slice(0, 16)}`,
    action: replay ? "webhook_replay" : "webhook_projection",
    result: pendingCount > 0 ? "error" : "ok",
    error: pendingCount > 0 ? "quickbooks_projection_pending" : undefined,
  });
  if (pendingCount > 0) {
    return jsonResp({
      error: "quickbooks_projection_pending",
      replay,
      envelope_id: receipt.envelope_id,
      events: receipt.events_count,
      provider_truth_reconciled: false,
    }, 503);
  }
  return jsonResp({
    ok: true,
    replay,
    envelope_id: receipt.envelope_id,
    events: receipt.events_count,
    provider_truth_reconciled: false,
    erpnext_payment_milestone_ids: projected.paymentMilestoneIds,
    erpnext_reconciliation_ids: projected.reconciliationIds,
    unresolved_reconciliation_ids: projected.unresolvedReconciliationIds,
    rejected_projection_count: projected.rejectedCount,
    erpnext_error: null,
  });
}

/**
 * Scheduled recovery makes the owned outbox self-healing even if Intuit stops
 * redelivering. Claims remain leased and due-time selection observes capped
 * backoff, so a persistent outage is visible without being hammered.
 */
export async function recoverDueQuickBooksProjections(
  env: Env,
): Promise<{ due: number; projected: number; rejected: number; pending: number; escalated: number }> {
  const due = await store.listDueQuickBooksProjectionOutbox(
    env,
    new Date().toISOString(),
    QUICKBOOKS_SCHEDULED_PROJECTION_LIMIT,
  );
  let projected = 0;
  let rejected = 0;
  let pending = 0;
  let escalated = 0;
  for (const event of due) {
    const receipt = await store.getQuickBooksWebhookReceipt(env, event.payload_hash);
    if (!receipt) continue; // D1 foreign key prevents this; never infer a replacement receipt.
    const result = await projectOutboxItem(env, receipt, event, "scheduled");
    if (result.state === "projected") projected += 1;
    if (result.state === "rejected") rejected += 1;
    if (result.state === "pending") {
      pending += 1;
      if (result.escalated) escalated += 1;
    }
  }
  return { due: due.length, projected, rejected, pending, escalated };
}

async function projectOutboxItems(
  env: Env,
  receipt: store.QuickBooksWebhookReceipt,
  events: store.QuickBooksProjectionOutbox[],
  trigger: ProjectionTrigger,
): Promise<ProjectionBatch> {
  const batch: ProjectionBatch = {
    paymentMilestoneIds: [],
    reconciliationIds: [],
    unresolvedReconciliationIds: [],
    rejectedCount: 0,
    pendingCount: 0,
    escalatedCount: 0,
  };
  for (const event of events) {
    const result = await projectOutboxItem(env, receipt, event, trigger);
    if (result.state === "projected") {
      if (result.erp.paymentMilestoneName) batch.paymentMilestoneIds.push(result.erp.paymentMilestoneName);
      batch.reconciliationIds.push(result.erp.reconciliationName);
      if (result.erp.unresolved) batch.unresolvedReconciliationIds.push(result.erp.reconciliationName);
    } else if (result.state === "rejected") {
      batch.rejectedCount += 1;
    } else if (result.state === "pending") {
      batch.pendingCount += 1;
      if (result.escalated) batch.escalatedCount += 1;
    }
  }
  return batch;
}

async function projectOutboxItem(
  env: Env,
  receipt: store.QuickBooksWebhookReceipt,
  event: store.QuickBooksProjectionOutbox,
  trigger: ProjectionTrigger,
): Promise<ProjectionOutcome> {
  const leaseToken = crypto.randomUUID();
  const claimAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.parse(claimAt) + QUICKBOOKS_PROJECTION_LEASE_MS).toISOString();
  const claimed = await store.claimQuickBooksProjectionOutbox(env, event, leaseToken, claimAt, leaseExpiresAt);
  if (!claimed) return { state: "not_claimed" };

  try {
    const erp = await pushQuickBooksEventToErpNext(env, {
      realmId: event.realm_id,
      type: event.entity_type,
      id: event.entity_id,
      operation: event.operation,
      rawKey: receipt.raw_key,
      // Preserve first receipt time across redeliveries; it is source evidence.
      eventTs: receipt.first_seen_at,
      payloadHash: receipt.payload_hash,
      eventIndex: event.event_index,
    });
    const projectedAt = new Date().toISOString();
    if (!await store.markQuickBooksProjectionProjected(env, event, leaseToken, projectedAt)) {
      throw new Error("quickbooks_projection_lease_lost");
    }
    await store.recordAudit(env, {
      automation: "erpnext_quickbooks",
      trigger,
      envelope_id: receipt.envelope_id,
      source_ids: `${event.entity_type}:${event.entity_id}`,
      target_ids: `integration_reconciliation:${erp.reconciliationName}`,
      action: erp.reused ? "reuse_pending_reconciliation" : "create_pending_reconciliation",
      result: "ok",
    });
    await store.recordAudit(env, {
      automation: "quickbooks",
      trigger,
      envelope_id: receipt.envelope_id,
      source_ids: `${event.entity_type}:${event.entity_id}`,
      target_ids: `integration_reconciliation:${erp.reconciliationName}`,
      action: `qb_${event.operation}`.toLowerCase(),
      result: "ok",
    });
    return { state: "projected", erp };
  } catch (err) {
    // Never store upstream body text. Only the bounded issuer's explicit
    // immutable conflict may be terminally rejected; an unknown ledger outcome
    // stays pending but requires reconciliation before another provider write.
    const stableBusinessConflict = isStableQuickBooksBusinessConflict(err);
    const projectionError = String(err).includes("effect_unknown_requires_reconciliation")
      ? "effect_unknown_requires_reconciliation"
      : "erpnext_quickbooks_projection_failed";
    let terminalRejected = false;
    const attempts = event.attempt_count + 1;
    const escalated = !stableBusinessConflict && attempts >= QUICKBOOKS_PROJECTION_ESCALATION_ATTEMPTS && !event.escalated_at;
    try {
      if (stableBusinessConflict) {
        terminalRejected = await store.markQuickBooksProjectionRejected(
          env,
          event,
          leaseToken,
          "erpnext_quickbooks_projection_rejected",
          new Date().toISOString(),
        );
      }
      if (!terminalRejected) {
        const releasedAt = new Date().toISOString();
        await store.releaseQuickBooksProjectionOutbox(
          env,
          event,
          leaseToken,
          projectionError,
          releasedAt,
          quickBooksProjectionRetryAt(releasedAt, attempts),
          escalated,
        );
      }
    } catch {
      // The original pending lease expires shortly; either way this response
      // remains retryable and is never a terminal acknowledgement.
    }
    await store.recordAudit(env, {
      automation: "erpnext_quickbooks",
      trigger,
      envelope_id: receipt.envelope_id,
      source_ids: `${event.entity_type}:${event.entity_id}`,
      action: terminalRejected ? "projection_rejected" : "sync",
      result: "error",
      error: terminalRejected
        ? "erpnext_quickbooks_projection_rejected"
        : projectionError,
    });
    if (escalated && !terminalRejected) {
      await store.recordAudit(env, {
        automation: "erpnext_quickbooks",
        trigger,
        envelope_id: receipt.envelope_id,
        source_ids: `${event.entity_type}:${event.entity_id}`,
        action: "projection_escalated",
        result: "error",
        error: "erpnext_quickbooks_projection_retry_escalated",
      });
    }
    return terminalRejected
      ? { state: "rejected" }
      : { state: "pending", escalated: escalated && !terminalRejected };
  }
}

function quickBooksProjectionRetryAt(now: string, attempts: number): string {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  const seconds = Math.min(
    QUICKBOOKS_PROJECTION_RETRY_MAX_SECONDS,
    QUICKBOOKS_PROJECTION_RETRY_BASE_SECONDS * (2 ** exponent),
  );
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

/** The issuer documents this one code/status as a non-retryable immutable conflict. */
function isStableQuickBooksBusinessConflict(err: unknown): boolean {
  return /\berpnext_http_409:\s*[\s\S]*\bquickbooks_reconciliation_identity_conflict\b/.test(String(err));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isUniqueConstraintError(err: unknown): boolean {
  return /unique|constraint/i.test(String(err));
}
