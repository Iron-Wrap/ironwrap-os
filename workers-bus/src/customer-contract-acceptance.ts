import {
  appPublicOrigin,
  authRequestContext,
  configuredTenantId,
  randomToken,
  sha256Hex,
  validateAppOrigin,
} from "./app-auth.ts";
import {
  customerPortalConfigured,
  customerPortalEnabled,
} from "./customer-portal.ts";
import {
  customerAcceptanceBackendConfigured,
  customerAcceptanceBackendEnabled,
  customerAcceptanceFrappeApiKey,
  customerAcceptanceFrappeApiSecret,
  customerAcceptanceHmacKey,
} from "./customer-acceptance-config.ts";
import {
  findActiveCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import { r2ObjectStore } from "./field-actions.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";
import { sendGmail } from "./google.ts";
import type { AppEnv, AuthRequestContext } from "./app-types.ts";

const MAX_BODY_BYTES = 2_048;
const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1_024;
const CHALLENGE_TTL_MS = 15 * 60 * 1_000;
const FRAPPE_ATTEMPT_LEASE_MS = 90 * 1_000;
const ACCEPTANCE_RECEIPT_CONTENT_TYPE = "application/json";

const PREPARE_METHOD = "ironwrap_roofing.customer_contract_acceptance_api.prepare_customer_portal_contract_acceptance";
const COMMIT_METHOD = "ironwrap_roofing.customer_contract_acceptance_api.record_customer_portal_contract_acceptance";

type ChallengeState = "pending_delivery" | "sent" | "consumed" | "invalidated";
type IntentState = "receipt_pending" | "receipt_stored" | "accepted" | "uncertain" | "rejected";

interface PreparedContract {
  email: string;
  emailHash: string;
  displayName: string;
  roofJobId: string;
  customerId: string;
  quoteId: string;
  quoteVersion: number;
  proposalPackId: string;
  termsHash: string;
  termsJson: string;
}

interface AcceptanceChallenge {
  challenge_id: string;
  token_hash: string;
  tenant_id: string;
  portal_link_id: string;
  roof_job_id: string;
  customer_id: string;
  email_hash: string;
  quote_id: string;
  quote_version: number;
  proposal_pack_id: string;
  terms_hash: string;
  terms_json: string;
  state: ChallengeState;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  provider_message_id: string | null;
  consumed_at: string | null;
  invalidated_at: string | null;
}

interface AcceptanceIntent {
  acceptance_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  challenge_id: string;
  tenant_id: string;
  portal_link_id: string;
  roof_job_id: string;
  customer_id: string;
  email_hash: string;
  quote_id: string;
  quote_version: number;
  proposal_pack_id: string;
  terms_hash: string;
  terms_json: string;
  signer_name: string;
  signer_ip_hash: string;
  accepted_at: string;
  receipt_key: string;
  receipt_hash: string | null;
  receipt_content_length: number | null;
  state: IntentState;
  frappe_attempted_at: string | null;
  frappe_attempt_lease_expires_at: string | null;
  result_json: string | null;
  response_status: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

type ClaimIntentResult =
  | { kind: "claimed"; intent: AcceptanceIntent }
  | { kind: "existing"; intent: AcceptanceIntent }
  | { kind: "conflict" }
  | { kind: "challenge_missing" }
  | { kind: "challenge_used" };

class FrappeAcceptanceHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`customer_acceptance_frappe_http_${status}`);
    this.status = status;
  }
}

class FrappeAcceptanceTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function handleCustomerPortalAcceptanceChallenge(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || !customerAcceptanceEnabled(env)) return portalNotFound();
  if (!customerAcceptanceConfigured(env)) return portalUnavailable();
  if (!trustedPortalOrigin(req, env)) return portalNotFound();

  const request = await parseExactJson(req, ["token"]);
  if (!request || !validToken(request.token)) return portalNotFound();
  const tenantId = configuredTenantId(env);
  if (!tenantId) return portalUnavailable();

  const now = new Date();
  let link: CustomerPortalLinkRecord | null;
  try {
    link = await findActiveCustomerPortalLink(
      env,
      await sha256Hex(request.token),
      tenantId,
      now.toISOString(),
    );
  } catch {
    return portalUnavailable();
  }
  if (!link) return portalNotFound();

  const challengeId = `acceptance_challenge_${crypto.randomUUID()}`;
  let prepared: PreparedContract;
  try {
    prepared = await prepareContract(env, {
      tenant_id: tenantId,
      portal_link_id: link.link_id,
      roof_job_id: link.roof_job_id,
      customer_id: link.customer_id,
      challenge_id: challengeId,
    });
  } catch (error) {
    return error instanceof FrappeAcceptanceHttpError && error.status < 500
      ? portalNotFound()
      : portalUnavailable();
  }

  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  const rawChallengeToken = randomToken();
  try {
    const context = await authRequestContext(req, env);
    await replaceAcceptanceChallenge(env, {
      challengeId,
      tokenHash: await sha256Hex(rawChallengeToken),
      tenantId,
      link,
      prepared,
      request: context,
      createdAt: now.toISOString(),
      expiresAt,
    });
    const delivery = await sendChallengeEmail(env, prepared, rawChallengeToken, expiresAt);
    const sent = await markChallengeSent(
      env,
      challengeId,
      delivery.providerMessageId,
      new Date().toISOString(),
    );
    if (!sent) throw new Error("acceptance_challenge_delivery_ledger_failed");
  } catch {
    await invalidateAcceptanceChallenge(env, challengeId, new Date().toISOString()).catch(() => {});
    return acceptanceJson({ error: "acceptance_challenge_unavailable" }, 502);
  }
  return acceptanceJson({ status: "challenge_sent", expires_at: expiresAt });
}

export async function handleCustomerPortalAcceptanceConfirm(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || !customerAcceptanceEnabled(env)) return portalNotFound();
  if (!customerAcceptanceConfigured(env)) return portalUnavailable();
  if (!trustedPortalOrigin(req, env)) return portalNotFound();

  const request = await parseExactJson(req, ["token", "signer_name", "accepted"]);
  if (!request || !validToken(request.token)) return portalNotFound();
  if (request.accepted !== true || !validSignerName(request.signer_name)) {
    return acceptanceJson({ error: "invalid_acceptance_attestation" }, 400);
  }
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (!validIdempotencyKey(idempotencyKey)) {
    return acceptanceJson({ error: "idempotency_key_required" }, 400);
  }
  const signerIp = requestIp(req);
  if (!signerIp) return acceptanceJson({ error: "signer_ip_required" }, 400);

  const tenantId = configuredTenantId(env);
  if (!tenantId) return portalUnavailable();
  const now = new Date();
  let requestContext: AuthRequestContext;
  let claim: ClaimIntentResult;
  try {
    requestContext = await authRequestContext(req, env);
    claim = await claimAcceptanceIntent(env, {
      acceptanceId: `acceptance_${crypto.randomUUID()}`,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      requestFingerprint: await sha256Hex(
        canonicalJson({ accepted: true, signer_name: request.signer_name, token: request.token }),
      ),
      tokenHash: await sha256Hex(request.token),
      signerName: request.signer_name,
      signerIpHash: requestContext.ip_hash,
      now: now.toISOString(),
    });
  } catch {
    return portalUnavailable();
  }
  if (claim.kind === "conflict") return acceptanceJson({ error: "acceptance_idempotency_conflict" }, 409);
  if (claim.kind === "challenge_used") return acceptanceJson({ error: "acceptance_challenge_used" }, 409);
  if (claim.kind === "challenge_missing") return portalNotFound();

  return await settleAcceptanceIntent(env, claim.intent, requestContext, signerIp);
}

/**
 * The frequent scheduled sweep only closes a Frappe attempt whose result can no longer be known.
 * It never replays a customer acceptance write. It also invalidates expired email challenges;
 * immutable acceptance receipts and events are intentionally retained.
 */
export async function reconcileCustomerContractAcceptanceAttempts(
  env: AppEnv,
  now = new Date(),
): Promise<void> {
  const nowValue = now.toISOString();
  const expired = await env.DB.prepare(
    `${acceptanceIntentSelect}
     WHERE state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL
       AND frappe_attempt_lease_expires_at <= ?`,
  ).bind(nowValue).all<AcceptanceIntent>();
  await Promise.all((expired.results ?? []).map((intent) =>
    finalizeAcceptanceIntent(env, intent, {
      state: "uncertain",
      response: { status: "uncertain", acceptance_id: intent.acceptance_id },
      responseStatus: 202,
      errorCode: "frappe_attempt_lease_expired",
      now: nowValue,
    }),
  ));
  await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'invalidated', invalidated_at = ?
     WHERE state IN ('pending_delivery', 'sent') AND expires_at <= ?`,
  ).bind(nowValue, nowValue).run();
}

async function settleAcceptanceIntent(
  env: AppEnv,
  initial: AcceptanceIntent,
  requestContext: AuthRequestContext,
  signerIp: string,
): Promise<Response> {
  let intent = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const terminal = storedTerminalResponse(intent);
    if (terminal) return terminal;
    if (intent.state === "receipt_pending") {
      if (intent.signer_ip_hash !== requestContext.ip_hash) {
        return acceptanceJson({ error: "acceptance_request_context_mismatch" }, 409);
      }
      const receipt = await receiptFor(intent);
      try {
        await r2ObjectStore(env.RAW).ensure(
          intent.receipt_key,
          receipt.body,
          ACCEPTANCE_RECEIPT_CONTENT_TYPE,
          receipt.hash,
        );
      } catch {
        return acceptanceJson({ error: "acceptance_receipt_unavailable" }, 503);
      }
      const stored = await markReceiptStored(env, intent, receipt, new Date().toISOString());
      intent = await getAcceptanceIntent(env, intent.acceptance_id) ?? intent;
      if (stored || intent.state !== "receipt_pending") continue;
      return acceptanceJson({ error: "acceptance_receipt_unavailable" }, 503);
    }

    if (intent.state !== "receipt_stored") return portalUnavailable();
    const now = new Date();
    if (intent.frappe_attempted_at) {
      if (
        intent.frappe_attempt_lease_expires_at &&
        intent.frappe_attempt_lease_expires_at > now.toISOString()
      ) {
        const response = acceptanceJson({ error: "acceptance_in_progress" }, 503);
        response.headers.set("retry-after", "3");
        return response;
      }
      const uncertain = await finalizeAcceptanceIntent(env, intent, {
        state: "uncertain",
        response: { status: "uncertain", acceptance_id: intent.acceptance_id },
        responseStatus: 202,
        errorCode: "frappe_attempt_lease_expired",
        now: now.toISOString(),
      });
      return uncertain ? acceptanceJson({ status: "uncertain", acceptance_id: intent.acceptance_id }, 202)
        : portalUnavailable();
    }
    if (intent.signer_ip_hash !== requestContext.ip_hash) {
      return acceptanceJson({ error: "acceptance_request_context_mismatch" }, 409);
    }
    const attemptAt = now.toISOString();
    const attemptClaimed = await markFrappeAttempted(
      env,
      intent.acceptance_id,
      attemptAt,
      new Date(now.getTime() + FRAPPE_ATTEMPT_LEASE_MS).toISOString(),
    );
    if (!attemptClaimed) {
      intent = await getAcceptanceIntent(env, intent.acceptance_id) ?? intent;
      continue;
    }
    try {
      await commitContractAcceptance(env, intent, signerIp);
      const accepted = { status: "accepted" as const, acceptance_id: intent.acceptance_id };
      const finalized = await finalizeAcceptanceIntent(env, intent, {
        state: "accepted",
        response: accepted,
        responseStatus: 200,
        errorCode: null,
        now: new Date().toISOString(),
      });
      return finalized ? acceptanceJson(accepted) : portalUnavailable();
    } catch (error) {
      if (error instanceof FrappeAcceptanceHttpError && error.status < 500) {
        const responseStatus = error.status === 400 ? 400 : 409;
        const rejected = { error: "acceptance_rejected" };
        const finalized = await finalizeAcceptanceIntent(env, intent, {
          state: "rejected",
          response: rejected,
          responseStatus,
          errorCode: `frappe_http_${error.status}`,
          now: new Date().toISOString(),
        });
        return finalized ? acceptanceJson(rejected, responseStatus) : portalUnavailable();
      }
      const uncertain = { status: "uncertain" as const, acceptance_id: intent.acceptance_id };
      const finalized = await finalizeAcceptanceIntent(env, intent, {
        state: "uncertain",
        response: uncertain,
        responseStatus: 202,
        errorCode: errorCode(error),
        now: new Date().toISOString(),
      });
      return finalized ? acceptanceJson(uncertain, 202) : portalUnavailable();
    }
  }
  return acceptanceJson({ error: "acceptance_in_progress" }, 503);
}

function customerAcceptanceConfigured(env: AppEnv): boolean {
  return customerPortalConfigured(env) && customerAcceptanceBackendConfigured(env);
}

function customerAcceptanceEnabled(env: AppEnv): boolean {
  return customerPortalEnabled(env) && customerAcceptanceBackendEnabled(env);
}

function trustedPortalOrigin(req: Request, env: AppEnv): boolean {
  const configuredOrigin = appPublicOrigin(env);
  const origin = validateAppOrigin(req, env, true);
  return origin.ok && !!configuredOrigin && origin.origin === configuredOrigin;
}

async function prepareContract(
  env: AppEnv,
  claim: Record<string, string>,
): Promise<PreparedContract> {
  const response = await frappeCustomerAcceptanceCall(env, PREPARE_METHOD, claim);
  const message = responseMessage(response);
  const email = validEmail(message.email) ? message.email.trim() : null;
  const emailHash = typeof message.email_hash === "string" && /^[0-9a-f]{64}$/.test(message.email_hash)
    ? message.email_hash
    : null;
  const displayName = boundedText(message.display_name, 1, 160);
  const roofJobId = boundedText(message.roof_job_id, 3, 140);
  const customerId = boundedText(message.customer_id, 3, 140);
  const quoteId = boundedText(message.quote_id, 3, 140);
  const quoteVersion = boundedInteger(message.quote_version, 1, 1_000_000);
  const proposalPackId = boundedText(message.proposal_pack_id, 3, 140);
  const termsHash = typeof message.terms_hash === "string" && /^[0-9a-f]{64}$/.test(message.terms_hash)
    ? message.terms_hash
    : null;
  if (
    !email || !emailHash || !displayName || roofJobId !== claim.roof_job_id ||
    customerId !== claim.customer_id || !quoteId || !quoteVersion || !proposalPackId ||
    !termsHash || !isRecord(message.terms) ||
    await sha256Hex(email.toLowerCase()) !== emailHash
  ) {
    throw new FrappeAcceptanceTransportError("frappe_prepare_invalid_shape");
  }
  const termsJson = canonicalJson(message.terms);
  if (termsJson.length > 48_000 || await sha256Hex(termsJson) !== termsHash) {
    throw new FrappeAcceptanceTransportError("frappe_prepare_terms_mismatch");
  }
  return {
    email,
    emailHash,
    displayName,
    roofJobId,
    customerId,
    quoteId,
    quoteVersion,
    proposalPackId,
    termsHash,
    termsJson,
  };
}

async function commitContractAcceptance(
  env: AppEnv,
  intent: AcceptanceIntent,
  signerIp: string,
): Promise<void> {
  const receipt = await receiptFor(intent);
  if (intent.receipt_hash !== receipt.hash || intent.receipt_content_length !== receipt.length) {
    throw new FrappeAcceptanceTransportError("acceptance_receipt_ledger_mismatch");
  }
  const response = await frappeCustomerAcceptanceCall(env, COMMIT_METHOD, {
    acceptance_id: intent.acceptance_id,
    challenge_id: intent.challenge_id,
    portal_link_id: intent.portal_link_id,
    tenant_id: intent.tenant_id,
    roof_job_id: intent.roof_job_id,
    customer_id: intent.customer_id,
    email_hash: intent.email_hash,
    quote_id: intent.quote_id,
    quote_version: intent.quote_version,
    proposal_pack_id: intent.proposal_pack_id,
    terms_hash: intent.terms_hash,
    signer_name: intent.signer_name,
    accepted_at: intent.accepted_at,
    receipt_key: intent.receipt_key,
    receipt_hash: receipt.hash,
    receipt_content_type: ACCEPTANCE_RECEIPT_CONTENT_TYPE,
    receipt_content_length: receipt.length,
    receipt_captured_at: intent.accepted_at,
    signer_ip: signerIp,
  });
  if (boundedText(responseMessage(response).acceptance_id, 16, 100) !== intent.acceptance_id) {
    throw new FrappeAcceptanceTransportError("frappe_commit_invalid_shape");
  }
}

async function frappeCustomerAcceptanceCall(
  env: AppEnv,
  method: string,
  claim: Record<string, unknown>,
): Promise<unknown> {
  const secret = customerAcceptanceHmacKey(env);
  const frappeApiKey = customerAcceptanceFrappeApiKey(env);
  const frappeApiSecret = customerAcceptanceFrappeApiSecret(env);
  if (!secret || !frappeApiKey || !frappeApiSecret) {
    throw new FrappeAcceptanceTransportError("frappe_acceptance_not_configured");
  }
  const claimJson = canonicalJson(claim);
  const path = `/api/method/${method}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomToken();
  const signature = await hmacBase64Url(
    secret,
    `POST\n${path}\n${timestamp}\n${nonce}\n${await sha256Hex(claimJson)}`,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(`${frappeBaseUrl(env)}${path}`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${frappeApiKey}:${frappeApiSecret}`,
        "content-type": "application/json",
        "user-agent": "ironwrap-customer-acceptance/1.0",
        "x-ironwrap-acceptance-timestamp": timestamp,
        "x-ironwrap-acceptance-nonce": nonce,
        "x-ironwrap-acceptance-signature": signature,
      },
      body: JSON.stringify({ customer_claim_json: claimJson }),
    });
    if (!response.ok) throw new FrappeAcceptanceHttpError(response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeAcceptanceTransportError("frappe_response_too_large");
    }
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeAcceptanceTransportError("frappe_response_too_large");
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new FrappeAcceptanceTransportError("frappe_response_invalid_json");
    }
  } catch (error) {
    if (error instanceof FrappeAcceptanceHttpError || error instanceof FrappeAcceptanceTransportError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new FrappeAcceptanceTransportError("frappe_request_timeout");
    }
    throw new FrappeAcceptanceTransportError("frappe_request_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function sendChallengeEmail(
  env: AppEnv,
  prepared: PreparedContract,
  rawToken: string,
  expiresAt: string,
): Promise<{ providerMessageId: string }> {
  const origin = appPublicOrigin(env);
  if (!origin) throw new Error("acceptance_email_origin_unavailable");
  const href = `${origin}/contract-accept#token=${encodeURIComponent(rawToken)}`;
  const greeting = escapeHtml(prepared.displayName);
  const expiry = escapeHtml(new Date(expiresAt).toLocaleString("en-CA", { timeZone: "America/Edmonton" }));
  return await sendGmail(
    env,
    prepared.email,
    "Confirm your contract acceptance",
    `<p>Hello ${greeting},</p><p><a href="${escapeHtml(href)}">Review and confirm your contract acceptance</a>.</p><p>This single-use link expires ${expiry}.</p>`,
  );
}

async function replaceAcceptanceChallenge(
  env: AppEnv,
  input: {
    challengeId: string;
    tokenHash: string;
    tenantId: string;
    link: CustomerPortalLinkRecord;
    prepared: PreparedContract;
    request: AuthRequestContext;
    createdAt: string;
    expiresAt: string;
  },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE customer_portal_acceptance_challenges
       SET state = 'invalidated', invalidated_at = ?
       WHERE portal_link_id = ? AND state IN ('pending_delivery', 'sent')`,
    ).bind(input.createdAt, input.link.link_id),
    env.DB.prepare(
      `INSERT INTO customer_portal_acceptance_challenges
         (challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id,
          email_hash, quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
          request_ip_hash, request_user_agent_hash, state, created_at, expires_at, sent_at,
          provider_message_id, consumed_at, invalidated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_delivery', ?, ?, NULL, NULL, NULL, NULL)`,
    ).bind(
      input.challengeId,
      input.tokenHash,
      input.tenantId,
      input.link.link_id,
      input.link.roof_job_id,
      input.link.customer_id,
      input.prepared.emailHash,
      input.prepared.quoteId,
      input.prepared.quoteVersion,
      input.prepared.proposalPackId,
      input.prepared.termsHash,
      input.prepared.termsJson,
      input.request.ip_hash,
      input.request.user_agent_hash,
      input.createdAt,
      input.expiresAt,
    ),
  ]);
}

async function markChallengeSent(
  env: AppEnv,
  challengeId: string,
  providerMessageId: string,
  sentAt: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'sent', sent_at = ?, provider_message_id = ?
     WHERE challenge_id = ? AND state = 'pending_delivery'`,
  ).bind(sentAt, providerMessageId, challengeId).run();
  return d1Changes(result) === 1;
}

async function invalidateAcceptanceChallenge(
  env: AppEnv,
  challengeId: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'invalidated', invalidated_at = ?
     WHERE challenge_id = ? AND state IN ('pending_delivery', 'sent')`,
  ).bind(now, challengeId).run();
}

async function claimAcceptanceIntent(
  env: AppEnv,
  input: {
    acceptanceId: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
    tokenHash: string;
    signerName: string;
    signerIpHash: string;
    now: string;
  },
): Promise<ClaimIntentResult> {
  const receiptKey = `customer-contract-acceptance/v1/${input.acceptanceId}.json`;
  const inserted = await env.DB.prepare(
    `INSERT INTO customer_portal_acceptance_intents
       (acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id, tenant_id,
        portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version, proposal_pack_id,
        terms_hash, terms_json, signer_name, signer_ip_hash, accepted_at,
        receipt_key, receipt_hash, receipt_content_length, state, frappe_attempted_at,
        frappe_attempt_lease_expires_at, result_json, response_status, error_code, created_at,
        updated_at, completed_at)
     SELECT ?, ?, ?, challenge_id, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
            quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
            ?, ?, ?, ?, NULL, NULL, 'receipt_pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
     FROM customer_portal_acceptance_challenges AS challenge
     WHERE challenge.token_hash = ? AND challenge.state = 'sent' AND challenge.expires_at > ?
       AND EXISTS (
         SELECT 1 FROM customer_portal_links AS link
         WHERE link.link_id = challenge.portal_link_id AND link.tenant_id = challenge.tenant_id
           AND link.roof_job_id = challenge.roof_job_id AND link.customer_id = challenge.customer_id
           AND link.revoked_at IS NULL AND link.expires_at > ?
       )
     ON CONFLICT DO NOTHING`,
  ).bind(
    input.acceptanceId,
    input.idempotencyKeyHash,
    input.requestFingerprint,
    input.signerName,
    input.signerIpHash,
    input.now,
    receiptKey,
    input.now,
    input.now,
    input.tokenHash,
    input.now,
    input.now,
  ).run();
  const existing = await getAcceptanceIntentByIdempotency(env, input.idempotencyKeyHash);
  if (existing) {
    if (existing.request_fingerprint !== input.requestFingerprint) return { kind: "conflict" };
    return d1Changes(inserted) > 0
      ? { kind: "claimed", intent: existing }
      : { kind: "existing", intent: existing };
  }
  const challenge = await getAcceptanceChallengeByTokenHash(env, input.tokenHash);
  return challenge?.state === "consumed"
    ? { kind: "challenge_used" }
    : { kind: "challenge_missing" };
}

async function markReceiptStored(
  env: AppEnv,
  intent: AcceptanceIntent,
  receipt: { hash: string; length: number },
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_intents
     SET receipt_hash = ?, receipt_content_length = ?, state = 'receipt_stored', updated_at = ?
     WHERE acceptance_id = ? AND state = 'receipt_pending'`,
  ).bind(receipt.hash, receipt.length, now, intent.acceptance_id).run();
  return d1Changes(result) > 0;
}

async function markFrappeAttempted(
  env: AppEnv,
  acceptanceId: string,
  attemptedAt: string,
  leaseExpiresAt: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_intents
     SET frappe_attempted_at = ?, frappe_attempt_lease_expires_at = ?, updated_at = ?
     WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NULL`,
  ).bind(attemptedAt, leaseExpiresAt, attemptedAt, acceptanceId).run();
  return d1Changes(result) > 0;
}

async function finalizeAcceptanceIntent(
  env: AppEnv,
  intent: AcceptanceIntent,
  input: {
    state: "accepted" | "uncertain" | "rejected";
    response: Record<string, string>;
    responseStatus: number;
    errorCode: string | null;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_intents
     SET state = ?, frappe_attempt_lease_expires_at = NULL, result_json = ?, response_status = ?,
         error_code = ?, completed_at = ?, updated_at = ?
     WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL`,
  ).bind(
    input.state,
    canonicalJson(input.response),
    input.responseStatus,
    input.errorCode,
    input.now,
    input.now,
    intent.acceptance_id,
  ).run();
  return d1Changes(result) > 0;
}

async function getAcceptanceIntent(
  env: AppEnv,
  acceptanceId: string,
): Promise<AcceptanceIntent | null> {
  return await env.DB.prepare(`${acceptanceIntentSelect} WHERE acceptance_id = ? LIMIT 1`)
    .bind(acceptanceId)
    .first<AcceptanceIntent>();
}

async function getAcceptanceIntentByIdempotency(
  env: AppEnv,
  idempotencyKeyHash: string,
): Promise<AcceptanceIntent | null> {
  return await env.DB.prepare(`${acceptanceIntentSelect} WHERE idempotency_key_hash = ? LIMIT 1`)
    .bind(idempotencyKeyHash)
    .first<AcceptanceIntent>();
}

async function getAcceptanceChallengeByTokenHash(
  env: AppEnv,
  tokenHash: string,
): Promise<AcceptanceChallenge | null> {
  return await env.DB.prepare(
    `SELECT challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
            quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
            state, created_at, expires_at, sent_at, provider_message_id, consumed_at, invalidated_at
     FROM customer_portal_acceptance_challenges WHERE token_hash = ? LIMIT 1`,
  ).bind(tokenHash).first<AcceptanceChallenge>();
}

const acceptanceIntentSelect = `SELECT acceptance_id, idempotency_key_hash, request_fingerprint,
  challenge_id, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version,
  proposal_pack_id, terms_hash, terms_json, signer_name, signer_ip_hash,
  accepted_at, receipt_key, receipt_hash, receipt_content_length, state, frappe_attempted_at,
  frappe_attempt_lease_expires_at, result_json, response_status, error_code, created_at, updated_at,
  completed_at FROM customer_portal_acceptance_intents`;

async function receiptFor(intent: AcceptanceIntent): Promise<{ body: string; hash: string; length: number }> {
  let terms: unknown;
  try {
    terms = JSON.parse(intent.terms_json) as unknown;
  } catch {
    throw new FrappeAcceptanceTransportError("acceptance_terms_ledger_invalid");
  }
  if (!isRecord(terms) || await sha256Hex(canonicalJson(terms)) !== intent.terms_hash) {
    throw new FrappeAcceptanceTransportError("acceptance_terms_ledger_mismatch");
  }
  const body = canonicalJson({
    version: 1,
    kind: "customer_contract_acceptance",
    acceptance_id: intent.acceptance_id,
    challenge_id: intent.challenge_id,
    portal_link_id: intent.portal_link_id,
    tenant_id: intent.tenant_id,
    roof_job_id: intent.roof_job_id,
    customer_id: intent.customer_id,
    email_hash: intent.email_hash,
    quote_id: intent.quote_id,
    quote_version: Number(intent.quote_version),
    proposal_pack_id: intent.proposal_pack_id,
    terms,
    terms_hash: intent.terms_hash,
    signer_name: intent.signer_name,
    signer_ip_hash: intent.signer_ip_hash,
    accepted: true,
    accepted_at: intent.accepted_at,
  });
  return {
    body,
    hash: await sha256Hex(body),
    length: new TextEncoder().encode(body).byteLength,
  };
}

function storedTerminalResponse(intent: AcceptanceIntent): Response | null {
  if (!(["accepted", "uncertain", "rejected"] as string[]).includes(intent.state)) return null;
  if (!intent.result_json || !intent.response_status) return portalUnavailable();
  try {
    const body = JSON.parse(intent.result_json) as unknown;
    if (!isRecord(body)) return portalUnavailable();
    if (
      intent.state === "accepted" && body.status === "accepted" &&
      body.acceptance_id === intent.acceptance_id
    ) return acceptanceJson(body, 200);
    if (
      intent.state === "uncertain" && body.status === "uncertain" &&
      body.acceptance_id === intent.acceptance_id
    ) return acceptanceJson(body, 202);
    if (intent.state === "rejected" && body.error === "acceptance_rejected") {
      return acceptanceJson(body, intent.response_status);
    }
  } catch {
    // A corrupt ledger must not become a retryable Frappe write.
  }
  return portalUnavailable();
}

function responseMessage(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : null;
  const message = root && isRecord(root.message) ? root.message : null;
  if (!message) throw new FrappeAcceptanceTransportError("frappe_response_invalid_shape");
  return message;
}

async function parseExactJson(
  req: Request,
  keys: readonly string[],
): Promise<Record<string, unknown> | null> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !sameKeys(value, keys)) return null;
    return value;
  } catch {
    return null;
  }
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non_finite_json_number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported_json_value");
  return encoded;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validSignerName(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() &&
    value.length >= 1 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function boundedText(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value === value.trim() &&
    value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function requestIp(req: Request): string | null {
  const value = (req.headers.get("cf-connecting-ip") ?? "").trim();
  return value && value.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(value) ? value : null;
}

function errorCode(error: unknown): string {
  if (error instanceof FrappeAcceptanceTransportError) return error.code;
  if (error instanceof FrappeAcceptanceHttpError) return `frappe_http_${error.status}`;
  return "frappe_request_unknown";
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
  ));
}

function portalNotFound(): Response {
  return acceptanceJson({ error: "not_found" }, 404);
}

function portalUnavailable(): Response {
  return acceptanceJson({ error: "portal_unavailable" }, 503);
}

function acceptanceJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
