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
  customerDecisionBackendConfigured,
  customerDecisionBackendEnabled,
  customerDecisionFrappeApiKey,
  customerDecisionFrappeApiSecret,
  customerDecisionHmacKey,
} from "./customer-decision-config.ts";
import {
  claimCustomerPortalAccessThrottle,
  findActiveCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import { r2ObjectStore } from "./field-actions.ts";
import {
  frappeBaseUrl,
  frappeRequestTimeout,
  listCustomerPortalFrappeResource,
} from "./frappe-read.ts";
import type { AppEnv, AuthRequestContext } from "./app-types.ts";

const MAX_BODY_BYTES = 2_048;
const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1_024;
const MAX_FRAPPE_DETAIL_CHARS = 500;
const FRAPPE_ATTEMPT_LEASE_MS = 90 * 1_000;
const DECISION_ACCESS_WINDOW_MS = 15 * 60 * 1_000;
const DECISION_ACCESS_IP_LIMIT = 120;
const DECISION_RECEIPT_CONTENT_TYPE = "application/json";

const RECORD_METHOD =
  "ironwrap_roofing.customer_decision_api.record_customer_portal_material_decision";

type DecisionState =
  | "receipt_pending"
  | "receipt_stored"
  | "recorded"
  | "uncertain"
  | "rejected";

interface SelectedOption {
  optionPackageId: string;
  tier: string | null;
  label: string;
}

interface DecisionIntent {
  decision_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  tenant_id: string;
  portal_link_id: string;
  roof_job_id: string;
  customer_id: string;
  option_package_id: string;
  option_tier: string | null;
  option_label: string;
  selected_at: string;
  selector_ip_hash: string;
  receipt_key: string;
  receipt_hash: string | null;
  receipt_content_length: number | null;
  state: DecisionState;
  frappe_attempted_at: string | null;
  frappe_attempt_lease_expires_at: string | null;
  result_json: string | null;
  response_status: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

type ClaimDecisionResult =
  | { kind: "claimed"; intent: DecisionIntent }
  | { kind: "existing"; intent: DecisionIntent }
  | { kind: "conflict" };

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

class FrappeDecisionHttpError extends Error {
  readonly status: number;
  /** Frappe's own reason, for the worker log only -- never for the customer. */
  readonly detail: string | null;

  constructor(status: number, detail: string | null = null) {
    super(`frappe_http_${status}`);
    this.name = "FrappeDecisionHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Pull Frappe's own reason out of an error body so a refusal is diagnosable from the worker log
 * alone.
 *
 * ELEC-95 spent a debugging session on this: a guard in `document_validation.py` refused every
 * customer's decision, and the only trace anywhere on our side was the generic
 * `decision_rejected` this route returns. The reason existed the whole time -- in the response
 * body we threw away. Frappe spreads it across `exception`, `_server_messages` (a JSON string of
 * JSON strings) and `message` depending on the throw, so try each.
 */
function frappeErrorDetail(raw: string): string | null {
  const clip = (value: unknown): string | null => {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? text.slice(0, MAX_FRAPPE_DETAIL_CHARS) : null;
  };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return clip(raw);
  }
  if (!body || typeof body !== "object") return clip(raw);
  const serverMessages = body._server_messages;
  if (typeof serverMessages === "string") {
    try {
      const entries = JSON.parse(serverMessages) as unknown[];
      for (const entry of entries) {
        const parsed = typeof entry === "string"
          ? JSON.parse(entry) as Record<string, unknown>
          : entry as Record<string, unknown>;
        const detail = clip(parsed?.message);
        if (detail) return detail;
      }
    } catch {
      // Fall through to the other shapes below.
    }
  }
  return clip(body.exception) ?? clip(body.message) ?? clip(body.exc_type);
}

class FrappeDecisionTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FrappeDecisionTransportError";
    this.code = code;
  }
}

/**
 * Record which curated Option Package a customer picked, from the same anonymous magic-link
 * capability that resolves the portal read model.
 *
 * The single-token shape is deliberate and is the one place this route knowingly departs from
 * contract acceptance next door. Acceptance earns its email challenge because it is a legal
 * commitment; a material preference is provisional -- an estimator confirms it before any quote
 * moves -- and an email round-trip before a customer may even say "I prefer the charcoal
 * standing-seam" would remove the interaction rather than protect it. What acceptance's shape
 * does buy is kept in full: trusted origin, a fixed two-key body, a required Idempotency-Key, an
 * immutable R2 receipt written before the Frappe effect is attempted, a single-attempt lease, and
 * a request-context re-check that stops a stolen key being replayed from elsewhere.
 */
export async function handleCustomerPortalDecision(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || !customerDecisionEnabled(env)) {
    return decisionNotFound();
  }
  if (!customerDecisionConfigured(env)) return decisionUnavailable();
  if (!trustedPortalOrigin(req, env)) return decisionNotFound();

  const request = await parseExactJson(req, ["token", "option_package_id"]);
  if (!request || !validToken(request.token)) return decisionNotFound();
  if (!validFrappeName(request.option_package_id)) {
    return decisionJson({ error: "invalid_option_package" }, 400);
  }
  const optionPackageId = request.option_package_id;
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (!validIdempotencyKey(idempotencyKey)) {
    return decisionJson({ error: "idempotency_key_required" }, 400);
  }

  const tenantId = configuredTenantId(env);
  if (!tenantId) return decisionUnavailable();
  const now = new Date();
  let requestContext: AuthRequestContext;
  let link: CustomerPortalLinkRecord | null;
  let selected: SelectedOption | null;
  let claim: ClaimDecisionResult;
  try {
    requestContext = await authRequestContext(req, env);
    const throttled = await claimCustomerPortalAccessThrottle(env, {
      tenantId,
      ipHash: requestContext.ip_hash,
      now: now.toISOString(),
      windowExpiresAt: new Date(
        now.getTime() + DECISION_ACCESS_WINDOW_MS,
      ).toISOString(),
      limit: DECISION_ACCESS_IP_LIMIT,
    });
    if (!throttled) return decisionNotFound();

    link = await findActiveCustomerPortalLink(
      env,
      await sha256Hex(request.token),
      tenantId,
      now.toISOString(),
    );
    // An unknown, expired, or revoked capability is indistinguishable from an unknown option, on
    // purpose: neither answer may tell a prober which half they got wrong.
    if (!link) return decisionNotFound();
    selected = await selectableOption(env, link, optionPackageId);
    if (!selected) return decisionNotFound();

    claim = await claimDecisionIntent(env, {
      decisionId: `decision_${crypto.randomUUID()}`,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      requestFingerprint: await sha256Hex(
        canonicalJson({
          option_package_id: optionPackageId,
          token: request.token,
        }),
      ),
      link,
      selected,
      selectorIpHash: requestContext.ip_hash,
      now: now.toISOString(),
    });
  } catch {
    // A Frappe or D1 outage says nothing about whether the supplied capability was valid.
    return decisionUnavailable();
  }
  if (claim.kind === "conflict") {
    return decisionJson({ error: "decision_idempotency_conflict" }, 409);
  }
  return await settleDecisionIntent(env, claim.intent, requestContext);
}

/**
 * The scheduled sweep only closes a Frappe attempt whose outcome can no longer be known. It never
 * replays a customer's selection; immutable receipts are intentionally retained.
 */
export async function reconcileCustomerPortalDecisionAttempts(
  env: AppEnv,
  now = new Date(),
): Promise<void> {
  const nowValue = now.toISOString();
  const expired = await env.DB.prepare(
    `${decisionIntentSelect}
     WHERE state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL
       AND frappe_attempt_lease_expires_at <= ?`,
  ).bind(nowValue).all<DecisionIntent>();
  await Promise.all((expired.results ?? []).map((intent) =>
    finalizeDecisionIntent(env, intent, {
      state: "uncertain",
      response: { status: "uncertain", decision_id: intent.decision_id },
      responseStatus: 202,
      errorCode: "frappe_attempt_lease_expired",
      now: nowValue,
    })
  ));
}

async function settleDecisionIntent(
  env: AppEnv,
  initial: DecisionIntent,
  requestContext: AuthRequestContext,
): Promise<Response> {
  let intent = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const terminal = storedTerminalResponse(intent);
    if (terminal) return terminal;

    if (intent.state === "receipt_pending") {
      if (intent.selector_ip_hash !== requestContext.ip_hash) {
        return decisionJson({ error: "decision_request_context_mismatch" }, 409);
      }
      const receipt = await receiptFor(intent);
      try {
        // Evidence precedes the effect: the receipt is durable before anything in Frappe is
        // asked to change, so an interrupted write always leaves a provable customer intent.
        await r2ObjectStore(env.RAW).ensure(
          intent.receipt_key,
          receipt.body,
          DECISION_RECEIPT_CONTENT_TYPE,
          receipt.hash,
        );
      } catch {
        return decisionJson({ error: "decision_receipt_unavailable" }, 503);
      }
      const stored = await markReceiptStored(
        env,
        intent,
        receipt,
        new Date().toISOString(),
      );
      intent = await getDecisionIntent(env, intent.decision_id) ?? intent;
      if (stored || intent.state !== "receipt_pending") continue;
      return decisionJson({ error: "decision_receipt_unavailable" }, 503);
    }

    if (intent.state !== "receipt_stored") return decisionUnavailable();
    const now = new Date();
    if (intent.frappe_attempted_at) {
      if (
        intent.frappe_attempt_lease_expires_at &&
        intent.frappe_attempt_lease_expires_at > now.toISOString()
      ) {
        const response = decisionJson({ error: "decision_in_progress" }, 503);
        response.headers.set("retry-after", "3");
        return response;
      }
      const uncertain = await finalizeDecisionIntent(env, intent, {
        state: "uncertain",
        response: { status: "uncertain", decision_id: intent.decision_id },
        responseStatus: 202,
        errorCode: "frappe_attempt_lease_expired",
        now: now.toISOString(),
      });
      return uncertain
        ? decisionJson(
          { status: "uncertain", decision_id: intent.decision_id },
          202,
        )
        : decisionUnavailable();
    }
    if (intent.selector_ip_hash !== requestContext.ip_hash) {
      return decisionJson({ error: "decision_request_context_mismatch" }, 409);
    }
    const attemptAt = now.toISOString();
    const attemptClaimed = await markFrappeAttempted(
      env,
      intent.decision_id,
      attemptAt,
      new Date(now.getTime() + FRAPPE_ATTEMPT_LEASE_MS).toISOString(),
    );
    if (!attemptClaimed) {
      intent = await getDecisionIntent(env, intent.decision_id) ?? intent;
      continue;
    }
    try {
      await commitDecision(env, intent);
      const recorded = {
        status: "recorded" as const,
        decision_id: intent.decision_id,
      };
      const finalized = await finalizeDecisionIntent(env, intent, {
        state: "recorded",
        response: recorded,
        responseStatus: 200,
        errorCode: null,
        now: new Date().toISOString(),
      });
      return finalized ? decisionJson(recorded) : decisionUnavailable();
    } catch (error) {
      if (error instanceof FrappeDecisionHttpError && error.status < 500) {
        const responseStatus = error.status === 400 ? 400 : 409;
        const rejected = { error: "decision_rejected" };
        // The customer keeps the generic message; the operator gets Frappe's actual reason.
        log({
          at: "customer_portal_decision_rejected",
          decision_id: intent.decision_id,
          roof_job_id: intent.roof_job_id,
          option_package_id: intent.option_package_id,
          frappe_status: error.status,
          frappe_detail: error.detail,
        });
        const finalized = await finalizeDecisionIntent(env, intent, {
          state: "rejected",
          response: rejected,
          responseStatus,
          errorCode: `frappe_http_${error.status}`,
          now: new Date().toISOString(),
        });
        return finalized
          ? decisionJson(rejected, responseStatus)
          : decisionUnavailable();
      }
      const uncertain = {
        status: "uncertain" as const,
        decision_id: intent.decision_id,
      };
      log({
        at: "customer_portal_decision_uncertain",
        decision_id: intent.decision_id,
        roof_job_id: intent.roof_job_id,
        error_code: errorCode(error),
        frappe_detail: error instanceof FrappeDecisionHttpError
          ? error.detail
          : null,
      });
      const finalized = await finalizeDecisionIntent(env, intent, {
        state: "uncertain",
        response: uncertain,
        responseStatus: 202,
        errorCode: errorCode(error),
        now: new Date().toISOString(),
      });
      return finalized ? decisionJson(uncertain, 202) : decisionUnavailable();
    }
  }
  return decisionJson({ error: "decision_in_progress" }, 503);
}

/**
 * Re-read the option through the customer read contract rather than trusting the request. A
 * package that is not Approved, or belongs to another job, is not selectable no matter what the
 * browser sent.
 */
async function selectableOption(
  env: AppEnv,
  link: CustomerPortalLinkRecord,
  optionPackageId: string,
): Promise<SelectedOption | null> {
  const rows = await listCustomerPortalFrappeResource(
    env,
    "Option Package",
    [
      ["Option Package", "roof_job", "=", link.roof_job_id],
      ["Option Package", "status", "=", "Approved"],
    ],
    10,
  );
  const row = rows.find(
    (candidate) =>
      (boundedText(candidate.option_package_id, 3, 140) ??
        boundedText(candidate.name, 3, 140)) === optionPackageId,
  );
  if (
    !row ||
    boundedText(row.roof_job, 3, 140) !== link.roof_job_id ||
    boundedText(row.status, 1, 80) !== "Approved"
  ) {
    return null;
  }
  const tier = boundedText(row.tier, 1, 40);
  const label = boundedText(row.package_name, 1, 200) ?? tier ?? optionPackageId;
  return {
    optionPackageId,
    tier: tier && OPTION_TIERS.includes(tier) ? tier : null,
    label,
  };
}

async function commitDecision(
  env: AppEnv,
  intent: DecisionIntent,
): Promise<void> {
  const receipt = await receiptFor(intent);
  if (
    intent.receipt_hash !== receipt.hash ||
    intent.receipt_content_length !== receipt.length
  ) {
    throw new FrappeDecisionTransportError("decision_receipt_ledger_mismatch");
  }
  const response = await frappeCustomerDecisionCall(env, RECORD_METHOD, {
    decision_id: intent.decision_id,
    portal_link_id: intent.portal_link_id,
    tenant_id: intent.tenant_id,
    roof_job_id: intent.roof_job_id,
    customer_id: intent.customer_id,
    option_package_id: intent.option_package_id,
    option_label: intent.option_label,
    selected_at: intent.selected_at,
    receipt_key: intent.receipt_key,
    receipt_hash: receipt.hash,
    receipt_content_type: DECISION_RECEIPT_CONTENT_TYPE,
    receipt_content_length: receipt.length,
    receipt_captured_at: intent.selected_at,
  });
  if (
    boundedText(responseMessage(response).decision_id, 16, 100) !==
      intent.decision_id
  ) {
    throw new FrappeDecisionTransportError("frappe_record_invalid_shape");
  }
}

async function frappeCustomerDecisionCall(
  env: AppEnv,
  method: string,
  claim: Record<string, unknown>,
): Promise<unknown> {
  const secret = customerDecisionHmacKey(env);
  const frappeApiKey = customerDecisionFrappeApiKey(env);
  const frappeApiSecret = customerDecisionFrappeApiSecret(env);
  if (!secret || !frappeApiKey || !frappeApiSecret) {
    throw new FrappeDecisionTransportError("frappe_decision_not_configured");
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
        "user-agent": "ironwrap-customer-decision/1.0",
        "x-ironwrap-decision-timestamp": timestamp,
        "x-ironwrap-decision-nonce": nonce,
        "x-ironwrap-decision-signature": signature,
      },
      body: JSON.stringify({ customer_claim_json: claimJson }),
    });
    if (!response.ok) {
      // Read the body before discarding it: it carries the only statement of why Frappe refused.
      const body = await response.text().catch(() => "");
      throw new FrappeDecisionHttpError(
        response.status,
        frappeErrorDetail(body.slice(0, MAX_FRAPPE_RESPONSE_BYTES)),
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeDecisionTransportError("frappe_response_too_large");
    }
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeDecisionTransportError("frappe_response_too_large");
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new FrappeDecisionTransportError("frappe_response_invalid_json");
    }
  } catch (error) {
    if (
      error instanceof FrappeDecisionHttpError ||
      error instanceof FrappeDecisionTransportError
    ) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new FrappeDecisionTransportError("frappe_request_timeout");
    }
    throw new FrappeDecisionTransportError("frappe_request_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function claimDecisionIntent(
  env: AppEnv,
  input: {
    decisionId: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
    link: CustomerPortalLinkRecord;
    selected: SelectedOption;
    selectorIpHash: string;
    now: string;
  },
): Promise<ClaimDecisionResult> {
  const receiptKey = `customer-portal-decision/v1/${input.decisionId}.json`;
  const inserted = await env.DB.prepare(
    `INSERT INTO customer_portal_decision_intents
       (decision_id, idempotency_key_hash, request_fingerprint, tenant_id, portal_link_id,
        roof_job_id, customer_id, option_package_id, option_tier, option_label, selected_at,
        selector_ip_hash, receipt_key, receipt_hash, receipt_content_length, state,
        frappe_attempted_at, frappe_attempt_lease_expires_at, result_json, response_status,
        error_code, created_at, updated_at, completed_at)
     SELECT ?, ?, ?, link.tenant_id, link.link_id, link.roof_job_id, link.customer_id,
            ?, ?, ?, ?, ?, ?, NULL, NULL, 'receipt_pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
     FROM customer_portal_links AS link
     WHERE link.link_id = ? AND link.tenant_id = ? AND link.revoked_at IS NULL
       AND link.expires_at > ?
     ON CONFLICT DO NOTHING`,
  ).bind(
    input.decisionId,
    input.idempotencyKeyHash,
    input.requestFingerprint,
    input.selected.optionPackageId,
    input.selected.tier,
    input.selected.label,
    input.now,
    input.selectorIpHash,
    receiptKey,
    input.now,
    input.now,
    input.link.link_id,
    input.link.tenant_id,
    input.now,
  ).run();
  const existing = await getDecisionIntentByIdempotency(
    env,
    input.idempotencyKeyHash,
  );
  if (!existing) throw new Error("customer_portal_decision_claim_failed");
  // The same key re-used for a different option is a client bug, not a retry: answering it with
  // the first option's result would silently record a choice the customer did not just make.
  if (existing.request_fingerprint !== input.requestFingerprint) {
    return { kind: "conflict" };
  }
  return d1Changes(inserted) > 0
    ? { kind: "claimed", intent: existing }
    : { kind: "existing", intent: existing };
}

async function markReceiptStored(
  env: AppEnv,
  intent: DecisionIntent,
  receipt: { hash: string; length: number },
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_decision_intents
     SET receipt_hash = ?, receipt_content_length = ?, state = 'receipt_stored', updated_at = ?
     WHERE decision_id = ? AND state = 'receipt_pending'`,
  ).bind(receipt.hash, receipt.length, now, intent.decision_id).run();
  return d1Changes(result) > 0;
}

async function markFrappeAttempted(
  env: AppEnv,
  decisionId: string,
  attemptedAt: string,
  leaseExpiresAt: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_decision_intents
     SET frappe_attempted_at = ?, frappe_attempt_lease_expires_at = ?, updated_at = ?
     WHERE decision_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NULL`,
  ).bind(attemptedAt, leaseExpiresAt, attemptedAt, decisionId).run();
  return d1Changes(result) > 0;
}

async function finalizeDecisionIntent(
  env: AppEnv,
  intent: DecisionIntent,
  input: {
    state: "recorded" | "uncertain" | "rejected";
    response: Record<string, string>;
    responseStatus: number;
    errorCode: string | null;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_decision_intents
     SET state = ?, frappe_attempt_lease_expires_at = NULL, result_json = ?, response_status = ?,
         error_code = ?, completed_at = ?, updated_at = ?
     WHERE decision_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL`,
  ).bind(
    input.state,
    canonicalJson(input.response),
    input.responseStatus,
    input.errorCode,
    input.now,
    input.now,
    intent.decision_id,
  ).run();
  return d1Changes(result) > 0;
}

async function getDecisionIntent(
  env: AppEnv,
  decisionId: string,
): Promise<DecisionIntent | null> {
  return await env.DB.prepare(
    `${decisionIntentSelect} WHERE decision_id = ? LIMIT 1`,
  ).bind(decisionId).first<DecisionIntent>();
}

async function getDecisionIntentByIdempotency(
  env: AppEnv,
  idempotencyKeyHash: string,
): Promise<DecisionIntent | null> {
  return await env.DB.prepare(
    `${decisionIntentSelect} WHERE idempotency_key_hash = ? LIMIT 1`,
  ).bind(idempotencyKeyHash).first<DecisionIntent>();
}

const decisionIntentSelect =
  `SELECT decision_id, idempotency_key_hash, request_fingerprint, tenant_id, portal_link_id,
  roof_job_id, customer_id, option_package_id, option_tier, option_label, selected_at,
  selector_ip_hash, receipt_key, receipt_hash, receipt_content_length, state, frappe_attempted_at,
  frappe_attempt_lease_expires_at, result_json, response_status, error_code, created_at, updated_at,
  completed_at FROM customer_portal_decision_intents`;

async function receiptFor(
  intent: DecisionIntent,
): Promise<{ body: string; hash: string; length: number }> {
  const body = canonicalJson({
    version: 1,
    kind: "customer_portal_material_decision",
    decision_id: intent.decision_id,
    portal_link_id: intent.portal_link_id,
    tenant_id: intent.tenant_id,
    roof_job_id: intent.roof_job_id,
    customer_id: intent.customer_id,
    option_package_id: intent.option_package_id,
    option_tier: intent.option_tier,
    option_label: intent.option_label,
    selector_ip_hash: intent.selector_ip_hash,
    // Named for what it is. A preference is not an approval, and the receipt must not be
    // readable later as one.
    provisional: true,
    selected_at: intent.selected_at,
  });
  return {
    body,
    hash: await sha256Hex(body),
    length: new TextEncoder().encode(body).byteLength,
  };
}

function storedTerminalResponse(intent: DecisionIntent): Response | null {
  if (
    !(["recorded", "uncertain", "rejected"] as string[]).includes(intent.state)
  ) {
    return null;
  }
  if (!intent.result_json || !intent.response_status) {
    return decisionUnavailable();
  }
  try {
    const body = JSON.parse(intent.result_json) as unknown;
    if (!isRecord(body)) return decisionUnavailable();
    if (
      intent.state === "recorded" && body.status === "recorded" &&
      body.decision_id === intent.decision_id
    ) return decisionJson(body, 200);
    if (
      intent.state === "uncertain" && body.status === "uncertain" &&
      body.decision_id === intent.decision_id
    ) return decisionJson(body, 202);
    if (intent.state === "rejected" && body.error === "decision_rejected") {
      return decisionJson(body, intent.response_status);
    }
  } catch {
    // A corrupt ledger must not become a retryable Frappe write.
  }
  return decisionUnavailable();
}

function customerDecisionEnabled(env: AppEnv): boolean {
  return customerPortalEnabled(env) && customerDecisionBackendEnabled(env);
}

function customerDecisionConfigured(env: AppEnv): boolean {
  return customerPortalConfigured(env) && customerDecisionBackendConfigured(env);
}

function trustedPortalOrigin(req: Request, env: AppEnv): boolean {
  const configuredOrigin = appPublicOrigin(env);
  const origin = validateAppOrigin(req, env, true);
  return origin.ok && !!configuredOrigin && origin.origin === configuredOrigin;
}

function responseMessage(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : null;
  const message = root && isRecord(root.message) ? root.message : null;
  if (!message) {
    throw new FrappeDecisionTransportError("frappe_response_invalid_shape");
  }
  return message;
}

async function parseExactJson(
  req: Request,
  keys: readonly string[],
): Promise<Record<string, unknown> | null> {
  if (
    !req.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) return null;
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
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("non_finite_json_number");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported_json_value");
  return encoded;
}

const OPTION_TIERS = ["Good", "Better", "Best", "Custom"];

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validFrappeName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{3,140}$/.test(value);
}

function boundedText(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value === value.trim() &&
      value.length >= min && value.length <= max &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function errorCode(error: unknown): string {
  if (error instanceof FrappeDecisionTransportError) return error.code;
  if (error instanceof FrappeDecisionHttpError) {
    return `frappe_http_${error.status}`;
  }
  return "frappe_request_unknown";
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function decisionNotFound(): Response {
  return decisionJson({ error: "not_found" }, 404);
}

function decisionUnavailable(): Response {
  return decisionJson({ error: "portal_unavailable" }, 503);
}

function decisionJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
