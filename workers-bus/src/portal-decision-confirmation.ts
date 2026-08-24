// portal-decision-confirmation.ts - IRO-51 thin confirmation after a recorded
// material decision. Uses the existing Gmail / local-dev outbox path. A send
// failure never unrecords the customer's choice.

import { appPublicOrigin, devOutboxCapture } from "./app-auth.ts";
import { gmailConfigured, sendGmail, type GmailSendReceipt } from "./google.ts";
import type { AppEnv } from "./app-types.ts";

export interface PortalDecisionConfirmationInput {
  tenantId: string;
  decisionId: string;
  portalLinkId: string;
  roofJobId: string;
  customerId: string;
  optionPackageId: string;
  optionLabel: string;
}

export interface PortalDecisionConfirmationResult {
  outcome: "provider_accepted" | "dev_captured" | "skipped_no_recipient" | "attempt_failed";
  channel: "email" | "dev_outbox" | "none";
  recipient: string;
  providerMessageId: string | null;
  errorCode: string | null;
}

export interface PortalDecisionConfirmationDeps {
  sendEmail?: (
    env: AppEnv,
    to: string,
    subject: string,
    html: string,
  ) => Promise<GmailSendReceipt>;
  lookupRecipient?: (env: AppEnv, tenantId: string, customerId: string) => Promise<string | null>;
  now?: () => string;
}

export async function recordPortalDecisionConfirmation(
  env: AppEnv,
  input: PortalDecisionConfirmationInput,
  deps: PortalDecisionConfirmationDeps = {},
): Promise<PortalDecisionConfirmationResult | null> {
  const existing = await env.DB.prepare(
    `SELECT confirmation_id, outcome FROM portal_decision_confirmations
      WHERE tenant_id = ? AND decision_id = ? LIMIT 1`,
  )
    .bind(input.tenantId, input.decisionId)
    .first<{ confirmation_id: string; outcome: PortalDecisionConfirmationResult["outcome"] }>();
  if (existing && (existing.outcome === "provider_accepted" || existing.outcome === "dev_captured")) {
    return null;
  }

  const lookup = deps.lookupRecipient ?? lookupCustomerEmail;
  const recipient = (await lookup(env, input.tenantId, input.customerId))?.trim().toLowerCase() ?? "";
  const now = deps.now?.() ?? new Date().toISOString();
  if (!recipient) {
    // No recipient is an honest non-send result, but it is not a successful confirmation. Do not
    // consume the decision's unique confirmation slot: the scheduled decision sweep must be able
    // to retry after the customer's contact record is repaired.
    return {
      outcome: "skipped_no_recipient",
      channel: "none",
      recipient: "none@example.invalid",
      providerMessageId: null,
      errorCode: null,
    };
  }

  const origin = appPublicOrigin(env) ?? "https://app.invalid";
  const href = `${origin}/portal?decision=${encodeURIComponent(input.decisionId)}`;
  const subject = "We recorded your material choice";
  const html =
    `<p>We recorded your selection: ${escapeHtml(input.optionLabel)}.</p>` +
    `<p>The office will confirm this on the estimate before any quote changes.</p>`;

  const captured = await devOutboxCapture(env, "portal_decision_confirmation", recipient, href);
  if (captured) {
    return await insertConfirmation(env, input, {
      outcome: "dev_captured",
      channel: "dev_outbox",
      recipient,
      providerMessageId: null,
      errorCode: null,
      now,
    });
  }

  if (!gmailConfigured(env) && !deps.sendEmail) {
    return {
      outcome: "attempt_failed",
      channel: "email",
      recipient,
      providerMessageId: null,
      errorCode: "email_not_configured",
    };
  }

  try {
    const receipt = deps.sendEmail
      ? await deps.sendEmail(env, recipient, subject, html)
      : await sendGmail(env, recipient, subject, html, {
        idempotencyKey: `portal-decision-confirmation:${input.tenantId}:${input.decisionId}:${recipient}`,
        taskId: `portal-decision-confirmation:${input.tenantId}:${input.decisionId}`,
      });
    return await insertConfirmation(env, input, {
      outcome: "provider_accepted",
      channel: "email",
      recipient,
      providerMessageId: receipt.providerMessageId,
      errorCode: null,
      now,
    });
  } catch (error) {
    // A provider or DB failure is deliberately not written to the unique confirmation row. The
    // decision remains recorded, while the scheduled sweep can retry; Gmail's effect ledger makes
    // a retry with the same envelope replay/read back an accepted send instead of duplicating it.
    return {
      outcome: "attempt_failed",
      channel: "email",
      recipient,
      providerMessageId: null,
      errorCode: confirmationErrorCode(error),
    };
  }
}

async function lookupCustomerEmail(
  env: AppEnv,
  tenantId: string,
  customerId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT contact_email FROM operating_customers
      WHERE tenant_id = ? AND customer_id = ? LIMIT 1`,
  )
    .bind(tenantId, customerId)
    .first<{ contact_email: string | null }>();
  return row?.contact_email ?? null;
}

async function insertConfirmation(
  env: AppEnv,
  input: PortalDecisionConfirmationInput,
  recorded: PortalDecisionConfirmationResult & { now: string },
): Promise<PortalDecisionConfirmationResult | null> {
  const confirmationId = `pdc_${input.decisionId}`.slice(0, 140);
  try {
    await env.DB.prepare(
      `INSERT INTO portal_decision_confirmations
         (confirmation_id, tenant_id, decision_id, portal_link_id, roof_job_id, customer_id,
          recipient, channel, option_package_id, option_label, outcome, provider_message_id,
          error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        confirmationId,
        input.tenantId,
        input.decisionId,
        input.portalLinkId,
        input.roofJobId,
        input.customerId,
        recorded.recipient,
        recorded.channel,
        input.optionPackageId,
        input.optionLabel,
        recorded.outcome,
        recorded.providerMessageId,
        recorded.errorCode,
        recorded.now,
      )
      .run();
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return null;
    throw error;
  }
  return {
    outcome: recorded.outcome,
    channel: recorded.channel,
    recipient: recorded.recipient,
    providerMessageId: recorded.providerMessageId,
    errorCode: recorded.errorCode,
  };
}

function confirmationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^[a-z0-9_]{3,80}/i);
  return match ? match[0].slice(0, 120) : "confirmation_send_failed";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
