// notify.ts — instant-ack + alerts, via Gmail (Google Workspace, domain-wide delegation).
//
// Sender = FROM_EMAIL (impersonated). Credential-gated: without GOOGLE_SERVICE_ACCOUNT_JSON the
// sends throw, callers catch + log, and lead capture is unaffected. SMS is NOT sent here —
// prospect SMS is JobNimbus Engage's job (owner decision 2026-07-01; Twilio keeps the DID only).

import type { EnvelopeRecord } from "./core.ts";
import { sendGmail, gmailConfigured } from "./google.ts";

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!gmailConfigured(env)) throw new Error("email_not_configured"); // caller logs + continues
  await sendGmail(env, to, subject, html);
}

/** Interim instant-ack: prospect email + owner alert (<60s SLA leg). */
export async function sendInstantAck(env: Env, rec: EnvelopeRecord): Promise<void> {
  const name = rec.contact_name ? " " + escapeHtml(rec.contact_name) : "";
  const tasks: Promise<void>[] = [];
  if (rec.contact_email) {
    tasks.push(sendEmail(env, rec.contact_email, "Thanks — we got your message",
      `<p>Thanks${name}, we received your request and will reach out shortly.</p><p>— IronWrap Exteriors</p>`));
  }
  tasks.push(sendEmail(env, env.OWNER_ALERT_EMAIL,
    `New lead (${rec.source}) — ${rec.intent_queue ?? "unrouted"}`, ownerHtml(rec)));
  await Promise.all(tasks);
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
