import {
  appPublicOrigin,
  authRequestContext,
  configuredTenantId,
  sha256Hex,
  validateAppOrigin,
} from "./app-auth.ts";
import {
  customerPortalConfigured,
  customerPortalEnabled,
} from "./customer-portal.ts";
import {
  customerDecisionBackendEnabled,
} from "./customer-decision-config.ts";
import {
  claimCustomerPortalAccessThrottle,
  findActiveCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import { r2ObjectStore } from "./field-actions.ts";
import { recordPortalDecisionConfirmation } from "./portal-decision-confirmation.ts";
import type { AppEnv, AuthRequestContext } from "./app-types.ts";

const MAX_BODY_BYTES = 2_048;
const DECISION_COMMIT_LEASE_MS = 90 * 1_000;
const DECISION_ACCESS_WINDOW_MS = 15 * 60 * 1_000;
const DECISION_ACCESS_IP_LIMIT = 120;
const DECISION_RECEIPT_CONTENT_TYPE = "application/json";
const PORTAL_CONFIRMATION_RECONCILE_BATCH_SIZE = 25;

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
  // Legacy 0069 schema names retained only in storage while the append-only event/transition
  // contract still uses them; runtime semantics are a bounded native D1 commit lease.
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

class DecisionCommitTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DecisionCommitTransportError";
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
 * immutable R2 receipt written before the native D1 commit is attempted, a single-attempt lease,
 * and a request-context re-check that stops a stolen key being replayed from elsewhere.
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
  if (!validOptionPackageId(request.option_package_id)) {
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
    // A storage/runtime outage says nothing about whether the supplied capability was valid.
    return decisionUnavailable();
  }
  if (claim.kind === "conflict") {
    return decisionJson({ error: "decision_idempotency_conflict" }, 409);
  }
  return await settleDecisionIntent(env, claim.intent, requestContext);
}

export async function reconcileCustomerPortalDecisionAttempts(
  env: AppEnv,
  now = new Date(),
  confirmationDeps: import("./portal-decision-confirmation.ts").PortalDecisionConfirmationDeps = {},
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
      errorCode: "native_commit_lease_expired",
      now: nowValue,
    })
  ));

  const pendingConfirmations = await env.DB.prepare(
    `${decisionIntentSelect}
     WHERE state = 'recorded'
       AND NOT EXISTS (
         SELECT 1 FROM portal_decision_confirmations confirmation
          WHERE confirmation.tenant_id = customer_portal_decision_intents.tenant_id
            AND confirmation.decision_id = customer_portal_decision_intents.decision_id
            AND confirmation.outcome IN ('provider_accepted', 'dev_captured')
     )
     ORDER BY updated_at ASC, decision_id ASC
     LIMIT ?`,
  ).bind(PORTAL_CONFIRMATION_RECONCILE_BATCH_SIZE).all<DecisionIntent>();
  for (const intent of pendingConfirmations.results ?? []) {
    try {
      await recordPortalDecisionConfirmation(env, {
        tenantId: intent.tenant_id,
        decisionId: intent.decision_id,
        portalLinkId: intent.portal_link_id,
        roofJobId: intent.roof_job_id,
        customerId: intent.customer_id,
        optionPackageId: intent.option_package_id,
        optionLabel: intent.option_label,
      }, confirmationDeps);
    } catch (error) {
      log({
        at: "customer_portal_decision_confirmation_reconcile_failed",
        decision_id: intent.decision_id,
        error: String(error),
      });
    }
  }
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
        // Evidence precedes the commit: the receipt is durable before the D1 intent is finalized,
        // so an interrupted write always leaves a provable customer intent.
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
        errorCode: "native_commit_lease_expired",
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
    const attemptClaimed = await markDecisionCommitStarted(
      env,
      intent.decision_id,
      attemptAt,
      new Date(now.getTime() + DECISION_COMMIT_LEASE_MS).toISOString(),
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
      if (finalized) {
        await recordPortalDecisionConfirmation(env, {
          tenantId: intent.tenant_id,
          decisionId: intent.decision_id,
          portalLinkId: intent.portal_link_id,
          roofJobId: intent.roof_job_id,
          customerId: intent.customer_id,
          optionPackageId: intent.option_package_id,
          optionLabel: intent.option_label,
        }).catch((error) => {
          log({
            at: "customer_portal_decision_confirmation_failed",
            decision_id: intent.decision_id,
            error: String(error),
          });
        });
        return decisionJson(recorded);
      }
      return decisionUnavailable();
    } catch (error) {
      const uncertain = {
        status: "uncertain" as const,
        decision_id: intent.decision_id,
      };
      log({
        at: "customer_portal_decision_uncertain",
        decision_id: intent.decision_id,
        roof_job_id: intent.roof_job_id,
        error_code: errorCode(error),
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
  const row = await env.DB.prepare(
    `SELECT option_id, job_id, title, tier, status
       FROM operating_option_packages
      WHERE tenant_id = ? AND job_id = ? AND option_id = ? AND status = 'approved'
      LIMIT 1`,
  ).bind(link.tenant_id, link.roof_job_id, optionPackageId).first<{
    option_id: string;
    job_id: string;
    title: string;
    tier: string | null;
    status: string;
  }>();
  if (
    !row ||
    row.option_id !== optionPackageId ||
    row.job_id !== link.roof_job_id ||
    row.status !== "approved"
  ) {
    return null;
  }
  const tier = boundedText(row.tier, 1, 40);
  const label = boundedText(row.title, 1, 200) ?? tier ?? optionPackageId;
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
    throw new DecisionCommitTransportError("decision_receipt_ledger_mismatch");
  }
  await r2ObjectStore(env.RAW).ensure(
    intent.receipt_key,
    receipt.body,
    DECISION_RECEIPT_CONTENT_TYPE,
    receipt.hash,
  );
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

async function markDecisionCommitStarted(
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
    // A corrupt ledger must not become a retryable native commit.
  }
  return decisionUnavailable();
}

function customerDecisionEnabled(env: AppEnv): boolean {
  return customerPortalEnabled(env) && customerDecisionBackendEnabled(env);
}

function customerDecisionConfigured(env: AppEnv): boolean {
  return customerPortalConfigured(env) && customerDecisionBackendEnabled(env);
}

function trustedPortalOrigin(req: Request, env: AppEnv): boolean {
  const configuredOrigin = appPublicOrigin(env);
  const origin = validateAppOrigin(req, env, true);
  return origin.ok && !!configuredOrigin && origin.origin === configuredOrigin;
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

function validOptionPackageId(value: unknown): value is string {
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
  if (error instanceof DecisionCommitTransportError) return error.code;
  return "decision_commit_unknown";
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
