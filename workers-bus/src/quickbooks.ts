// quickbooks.ts — QuickBooks Online webhook receiver (Phase 3, spec 04 §WF4).
//
// Verifies Intuit's HMAC signature, then records each invoice/payment change so nothing is lost.
// Mirroring the status onto the JobNimbus job needs QB OAuth to fetch entity detail — that's a
// credential-gated FOLLOW-UP; this receiver captures + audits the events now. Credential-gated on
// QB_WEBHOOK_TOKEN (the Intuit "verifier token"). Raw is stored FIRST.

import { newEnvelopeId } from "./core.ts";
import * as store from "./store.ts";

export interface QbEntityEvent { realmId: string; type: string; id: string; operation: string }

/** Pull the flat list of entity changes out of an Intuit webhook payload. Pure. */
export function parseQbEvents(raw: unknown): QbEntityEvent[] {
  const out: QbEntityEvent[] = [];
  const notes = (raw as { eventNotifications?: unknown[] })?.eventNotifications;
  for (const n of Array.isArray(notes) ? notes : []) {
    const realmId = String((n as { realmId?: unknown })?.realmId ?? "");
    const entities = (n as { dataChangeEvent?: { entities?: unknown[] } })?.dataChangeEvent?.entities;
    for (const e of Array.isArray(entities) ? entities : []) {
      const ent = e as { name?: unknown; id?: unknown; operation?: unknown };
      out.push({ realmId, type: String(ent.name ?? ""), id: String(ent.id ?? ""), operation: String(ent.operation ?? "") });
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
  const id = newEnvelopeId();
  const now = new Date().toISOString();
  await store.putRaw(env, `raw/quickbooks/${now.slice(0, 10)}/${id}.json`, rawText, "application/json");

  let parsed: unknown = {};
  try { parsed = JSON.parse(rawText); } catch { /* keep {} — raw is already stored */ }
  const events = parseQbEvents(parsed);
  for (const e of events) {
    await store.recordAudit(env, { automation: "quickbooks", trigger: "webhook", envelope_id: id,
      source_ids: `${e.type}:${e.id}`, action: `qb_${e.operation}`.toLowerCase(),
      result: "ok", error: "jn_sync_pending_oauth" }); // status mirror lands once QB OAuth is wired
  }
  return jsonResp({ ok: true, events: events.length });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
