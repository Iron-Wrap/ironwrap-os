// notify.ts — instant-ack + alerts, via Gmail (Google Workspace, domain-wide delegation).
//
// Sender = FROM_EMAIL (impersonated). Credential-gated: without GOOGLE_SERVICE_ACCOUNT_JSON the
// sends throw, callers catch + log, and lead capture is unaffected. SMS is NOT sent here —
// prospect SMS is JobNimbus Engage's job (owner decision 2026-07-01; Twilio keeps the DID only).

import type { EnvelopeRecord } from "./core.ts";
import { recordLeadAckReceipt } from "./store.ts";
import { sendGmail, gmailConfigured, type GmailSendReceipt } from "./google.ts";

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<GmailSendReceipt> {
  if (!gmailConfigured(env)) throw new Error("email_not_configured"); // caller logs + continues
  return await sendGmail(env, to, subject, html);
}

export interface InstantAckResult {
  prospect: "provider_accepted" | "attempt_failed" | "no_eligible_channel";
  owner_alert: "provider_accepted" | "attempt_failed";
}

export interface InstantAckDependencies {
  sendEmail?: (env: Env, to: string, subject: string, html: string) => Promise<GmailSendReceipt>;
  recordReceipt?: typeof recordLeadAckReceipt;
  now?: () => Date;
  receiptId?: () => string;
}

/**
 * Interim instant-ack: prospect email + owner alert. The receipt is intentionally provider
 * acceptance evidence, not a claim that the customer received/read the message or that a human
 * followed up. Each leg settles independently so an owner-alert failure cannot erase a valid
 * prospect receipt (or vice versa).
 */
export async function sendInstantAck(
  env: Env,
  rec: EnvelopeRecord,
  dependencies: InstantAckDependencies = {},
): Promise<InstantAckResult> {
  const send = dependencies.sendEmail ?? sendEmail;
  const record = dependencies.recordReceipt ?? recordLeadAckReceipt;
  const now = dependencies.now ?? (() => new Date());
  const receiptId = dependencies.receiptId ?? ackReceiptId;
  const name = rec.contact_name ? " " + escapeHtml(rec.contact_name) : "";
  const prospectAttempt = rec.contact_email
    ? settledAt(
      Promise.resolve().then(() => send(env, rec.contact_email!, "Thanks — we got your message",
        `<p>Thanks${name}, we received your request and will reach out shortly.</p><p>— IronWrap Exteriors</p>`)),
      now,
    )
    : Promise.resolve({ result: null, observedAt: now().toISOString() });
  // Start the owner alert concurrently, but do not let a slow/misconfigured owner mailbox delay
  // the prospect's provider-receipt timestamp or its 60-second SLA evidence.
  const ownerAttempt = settledAt(
    Promise.resolve().then(() => send(env, env.OWNER_ALERT_EMAIL,
      `New lead (${rec.source}) — ${rec.intent_queue ?? "unrouted"}`, ownerHtml(rec))),
    now,
  );
  const prospect = await prospectAttempt;
  if (prospect.result === null) {
    await record(env, {
      receipt_id: receiptId(), envelope_id: rec.envelope_id, channel: "none",
      outcome: "no_eligible_channel", observed_at: prospect.observedAt, provider_message_id: null, error_code: null,
    });
  } else if (prospect.result.status === "fulfilled") {
    await record(env, {
      receipt_id: receiptId(), envelope_id: rec.envelope_id, channel: "email",
      outcome: "provider_accepted", observed_at: prospect.observedAt,
      provider_message_id: prospect.result.value.providerMessageId, error_code: null,
    });
  } else {
    await record(env, {
      receipt_id: receiptId(), envelope_id: rec.envelope_id, channel: "email",
      outcome: "attempt_failed", observed_at: prospect.observedAt,
      provider_message_id: null, error_code: ackErrorCode(prospect.result.reason),
    });
  }
  const owner = await ownerAttempt;
  return {
    prospect: prospect.result === null
      ? "no_eligible_channel"
      : prospect.result.status === "fulfilled" ? "provider_accepted" : "attempt_failed",
    owner_alert: owner.result.status === "fulfilled" ? "provider_accepted" : "attempt_failed",
  };
}

export async function sendOwnerAlert(env: Env, subject: string, html: string): Promise<void> {
  await Promise.all([
    sendEmail(env, env.OWNER_ALERT_EMAIL, subject, html),
    env.BACKUP_ALERT_EMAIL && (env.BACKUP_ALERT_EMAIL as string) !== (env.OWNER_ALERT_EMAIL as string)
      ? sendEmail(env, env.BACKUP_ALERT_EMAIL, subject, html)
      : Promise.resolve(),
  ]);
}

/** Daily reconciliation digest → owner + backup. Its ARRIVAL is the heartbeat; absence ⇒ escalate. */
export async function sendDailyDigest(env: Env, subject: string, html: string): Promise<void> {
  await sendOwnerAlert(env, subject, html);
}

function ownerHtml(rec: EnvelopeRecord): string {
  const p = safeJson(rec.payload_json);
  return `<p>New lead via <b>${escapeHtml(rec.source)}</b>${p.brand ? " (brand: " + escapeHtml(String(p.brand)) + ")" : ""}.</p>
    <ul>
      <li>Name: ${escapeHtml(rec.contact_name ?? "—")}</li>
      <li>Phone: ${escapeHtml(rec.contact_phone ?? "—")}</li>
      <li>Email: ${escapeHtml(rec.contact_email ?? "—")}</li>
      <li>Queue: ${escapeHtml(rec.intent_queue ?? "—")}</li>
      <li>Envelope: ${escapeHtml(rec.envelope_id)}</li>
    </ul>`;
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function ackReceiptId(): string {
  return `ack_${crypto.randomUUID()}`;
}

type SettledAt<T> = {
  result: PromiseSettledResult<T>;
  observedAt: string;
};

function settledAt<T>(attempt: Promise<T>, now: () => Date): Promise<SettledAt<T>> {
  return attempt.then(
    (value) => ({ result: { status: "fulfilled", value }, observedAt: now().toISOString() }),
    (reason) => ({ result: { status: "rejected", reason }, observedAt: now().toISOString() }),
  );
}

function ackErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "ack_attempt_failed";
  const code = message.match(/^[A-Za-z0-9_-]{1,80}/)?.[0];
  return code ?? "ack_attempt_failed";
}
