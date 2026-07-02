// notify.ts — instant-ack + alerts.
//
// Email via Microsoft 365 Graph (the spec's brand-mailbox decision) with a Resend fallback;
// prospect SMS via Twilio once A2P is approved. Everything is CREDENTIAL-GATED: with no creds
// set, sends are skipped (the caller logs + continues), so the bus deploys and captures leads
// regardless. Add the secrets when ready — no code change needed.
//
// Secrets (wrangler secret put): MS365 → MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET (Azure app
// with Mail.Send application permission for FROM_EMAIL's mailbox). OR Resend → RESEND_API_KEY
// (verify the brand domain). SMS → TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.

import { isOn, type EnvelopeRecord } from "./core.ts";

// ---------------------------------------------------------------- email
async function getGraphToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`ms_token_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Send one email via MS365 Graph (preferred) or Resend; throw if neither is configured. */
async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) {
    const token = await getGraphToken(env);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.FROM_EMAIL)}/sendMail`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: { subject, body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address: to } }] },
          saveToSentItems: false,
        }),
      },
    );
    if (!res.ok && res.status !== 202) throw new Error(`graph_send_${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) throw new Error(`resend_${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error("email_not_configured"); // no MS365/Resend creds yet — caller logs + continues
}

// ---------------------------------------------------------------- SMS (prospect leg, post-A2P)
async function sendProspectSms(env: Env, to: string, bodyText: string): Promise<void> {
  if (!isOn(env.A2P_SMS_ENABLED)) return; // gated until A2P 10DLC approval
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    throw new Error("twilio_not_configured");
  }
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: bodyText }),
    },
  );
  if (!res.ok) throw new Error(`twilio_${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------- public
/** Interim instant-ack: prospect email + owner alert; prospect SMS too once A2P is on. */
export async function sendInstantAck(env: Env, rec: EnvelopeRecord): Promise<void> {
  const name = rec.contact_name ? " " + escapeHtml(rec.contact_name) : "";
  const tasks: Promise<void>[] = [];
  if (rec.contact_email) {
    tasks.push(sendEmail(env, rec.contact_email, "Thanks — we got your message",
      `<p>Thanks${name}, we received your request and will reach out shortly.</p><p>— IronWrap Exteriors</p>`));
  }
  tasks.push(sendEmail(env, env.OWNER_ALERT_EMAIL,
    `New lead (${rec.source}) — ${rec.intent_queue ?? "unrouted"}`, ownerHtml(rec)));
  if (isOn(env.A2P_SMS_ENABLED) && rec.contact_phone) {
    tasks.push(sendProspectSms(env, rec.contact_phone,
      "Thanks for contacting IronWrap — we'll be in touch shortly. Reply STOP to opt out."));
  }
  await Promise.all(tasks);
}

export async function sendOwnerAlert(env: Env, subject: string, html: string): Promise<void> {
  await Promise.all([
    sendEmail(env, env.OWNER_ALERT_EMAIL, subject, html),
    env.BACKUP_ALERT_EMAIL ? sendEmail(env, env.BACKUP_ALERT_EMAIL, subject, html) : Promise.resolve(),
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
