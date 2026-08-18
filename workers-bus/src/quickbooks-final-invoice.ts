import { sha256Hex } from "./app-auth.ts";
import { assertEffectLedgerReady, EffectRuntimeError, runExternalEffect } from "./effect-runtime.ts";
import { canonicalJson as canonicalEffectJson } from "./newo-hash.ts";
import type { AppEnv, AppRole } from "./app-types.ts";

export const QUICKBOOKS_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting" as const;
export const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2" as const;
export const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" as const;
export const QUICKBOOKS_RETURN_PATH = "/accounting/quickbooks" as const;
export const QUICKBOOKS_CALLBACK_PATH = "/oauth/quickbooks/callback" as const;

export type QuickBooksFinalInvoiceState =
  | "connection_required"
  | "blocked"
  | "pending_review"
  | "rejected"
  | "submission_pending"
  | "submitted"
  | "matched"
  | "failed"
  | "reconciliation_required";

export type QuickBooksFinalInvoiceAction =
  | "connect"
  | "approve"
  | "reject"
  | "reconcile"
  | "remove_from_ironwrap"
  | "refresh";

export const QUICKBOOKS_REJECTION_REASONS = [
  "evidence_incomplete",
  "commercial_values_disputed",
  "duplicate_or_already_billed",
  "mapping_requires_correction",
  "not_ready_to_invoice",
] as const;
export type QuickBooksRejectionReason = (typeof QUICKBOOKS_REJECTION_REASONS)[number];

export const QUICKBOOKS_BLOCKER_CODES = [
  "oauth_connection_required",
  "realm_mismatch",
  "customer_mapping_missing",
  "item_mapping_missing",
  "tax_mapping_missing",
  "terms_mapping_missing",
  "commercial_policy_hold",
  "candidate_invalid",
  "candidate_changed",
  "provider_response_uncertain",
  "provider_readback_drift",
  "provider_invoice_missing",
  "frappe_bind_pending",
  "frappe_resolver_pending",
] as const;
export type QuickBooksBlockerCode = (typeof QUICKBOOKS_BLOCKER_CODES)[number];

export const QUICKBOOKS_NEXT_STEPS = [
  "connect_quickbooks",
  "fix_frappe_mapping",
  "resolve_commercial_policy",
  "refresh_candidate",
  "reconcile_provider_invoice",
  "retry_frappe_projection",
] as const;
export type QuickBooksNextStep = (typeof QUICKBOOKS_NEXT_STEPS)[number];

type QuickBooksEnv = AppEnv & {
  QB_OAUTH_ENABLED?: string;
  QB_FINAL_INVOICE_ENABLED?: string;
  QB_API_ENVIRONMENT?: string;
  QB_API_MINOR_VERSION?: string;
  QB_CLIENT_ID?: string;
  QB_CLIENT_SECRET?: string;
  QB_TOKEN_ENCRYPTION_KEY?: string;
  QB_TOKEN_ENCRYPTION_KEY_VERSION?: string;
  QB_EXPECTED_REALM_ID?: string;
  QB_FINAL_INVOICE_FRAPPE_API_KEY?: string;
  QB_FINAL_INVOICE_FRAPPE_API_SECRET?: string;
  QB_API_TIMEOUT_MS?: string;
};

interface OAuthStateRow {
  state_sha256: string;
  tenant_id: string;
  user_id: string;
  redirect_uri: string;
  return_path: typeof QUICKBOOKS_RETURN_PATH;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  outcome_code: string | null;
}

interface ConnectionRow {
  connection_id: string;
  oauth_state_sha256: string;
  tenant_id: string;
  realm_id: string;
  state: "connected" | "revoked" | "reconciliation_required";
  encrypted_bundle_b64: string;
  bundle_iv_b64: string;
  encryption_key_version: string;
  bundle_version: number;
  access_expires_at: string;
  refresh_expires_at: string | null;
  refresh_lease_id: string | null;
  refresh_lease_expires_at: string | null;
  connected_by_user_id: string;
  connected_at: string;
  updated_at: string;
  revocation_idempotency_sha256: string | null;
  revocation_fingerprint_sha256: string | null;
  revoked_by_user_id: string | null;
  revoked_at: string | null;
}

export interface QuickBooksCitation {
  source: "Frappe" | "R2";
  doctype?: string;
  name?: string;
  key?: string;
  sha256: string;
}

export interface QuickBooksCandidate {
  roof_job_id: string;
  shop_order_id: string | null;
  qbo: {
    realm_id: string;
    customer_id: string;
    item_id: string;
    tax_code_id: string;
    terms_id: string;
  };
  commercial: {
    currency: "CAD";
    subtotal: string;
    tax_amount: string;
    total_amount: string;
    already_invoiced: "0.00";
    final_balance: string;
    tax_code: string;
    tax_rate: string;
    invoice_date: string;
    due_date: string;
    lines: Array<{
      source_type: "Customer Quote" | "Change Order";
      source_id: string;
      source_version: number;
      description_code: "RESIDENTIAL_ACCEPTED_QUOTE" | "RESIDENTIAL_ACCEPTED_CHANGE";
      amount: string;
    }>;
  };
  basis: {
    intent_id: string;
    basis_sha256: string;
    completion_packet_id: string;
    completion_version: string;
    completion_sha256: string;
    customer_quote_id: string;
    quote_version: number;
    quote_sha256: string;
    changes_sha256: string;
    evidence: QuickBooksCitation[];
  };
}

export interface QuickBooksCandidateBlocker {
  roof_job_id: string;
  code: string;
  message: string;
  citations: QuickBooksCitation[];
}

interface FinalInvoiceRow {
  intent_id: string;
  tenant_id: string;
  roof_job_id: string;
  shop_order_id: string | null;
  completion_packet_id: string;
  completion_version: number;
  completion_sha256: string;
  customer_quote_id: string;
  quote_version: number;
  quote_sha256: string;
  changes_sha256: string;
  basis_sha256: string;
  candidate_fingerprint_sha256: string;
  realm_id: string;
  customer_ref: string;
  item_ref: string;
  tax_code_ref: string;
  terms_ref: string;
  currency: "CAD";
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  already_invoiced: "0.00";
  final_balance: string;
  tax_code: string;
  tax_rate: string;
  invoice_date: string;
  due_date: string;
  lines_json: string;
  evidence_json: string;
  provider_payload_json: string;
  provider_payload_sha256: string;
  provider_request_id: string;
  state: QuickBooksFinalInvoiceState;
  version: number;
  blocker_code: QuickBooksBlockerCode | null;
  blocker_next_step: QuickBooksNextStep | null;
  reason_code: QuickBooksRejectionReason | null;
  approval_idempotency_sha256: string | null;
  approval_fingerprint_sha256: string | null;
  rejection_idempotency_sha256: string | null;
  rejection_fingerprint_sha256: string | null;
  reconcile_idempotency_sha256: string | null;
  reconcile_fingerprint_sha256: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  rejected_by_user_id: string | null;
  rejected_at: string | null;
  provider_invoice_id: string | null;
  provider_invoice_sha256: string | null;
  provider_submitted_at: string | null;
  provider_matched_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  effect_id: string;
  tenant_id: string;
  intent_id: string;
  operation: "submit" | "readback" | "bind" | "resolve";
  idempotency_key_sha256: string;
  request_fingerprint_sha256: string;
  provider_request_id: string | null;
  provider_payload_sha256: string | null;
  state: "pending" | "attempting" | "succeeded" | "failed" | "unknown";
  attempt_count: number;
}

interface ReadbackObservationRow {
  observation_id: string;
  provider_invoice_id: string;
  provider_readback_sha256: string;
  provider_facts_sha256: string;
  facts_json: string;
  balance_due: string;
  payment_status: PaymentStatus;
  checked_at: string;
}

type PaymentStatus =
  | "Not Due" | "Due" | "Partially Paid" | "Paid" | "Overdue" | "Voided" | "Unverified";

interface TokenBundle {
  access: string;
  refresh: string;
}

export interface QuickBooksFinalInvoiceProjection {
  intent_id: string;
  roof_job_id: string;
  shop_order_id: string | null;
  state: QuickBooksFinalInvoiceState;
  version: number;
  currency: "CAD";
  final_balance: string;
  blocker_code: QuickBooksBlockerCode | null;
  blocker_next_step: QuickBooksNextStep | null;
  rejection_reason: QuickBooksRejectionReason | null;
  evidence: QuickBooksCitation[];
  updated_at: string;
}

export interface QuickBooksCandidateHoldProjection {
  roof_job_id: string;
  blocker_code: string;
  citations: QuickBooksCitation[];
  updated_at: string;
}

export interface QuickBooksFinalInvoiceEnvelope {
  version: 1;
  read_model_generated_at: string;
  permissions: Array<"quickbooks:read" | "quickbooks:review" | "quickbooks:reconcile">;
  allowed_actions: QuickBooksFinalInvoiceAction[];
  connection: {
    state: "connected" | "connection_required" | "revoked" | "reconciliation_required";
    realm_id: string | null;
    last_connected_at: string | null;
  };
  intent: {
    id: string;
    job_id: string;
    shop_order_id: string | null;
    state: QuickBooksFinalInvoiceState;
    version: number;
    currency: "CAD";
    amounts: { subtotal: string; tax: string; already_invoiced: string; final_balance: string };
    tax: { code: string; rate: string };
    invoice_date: string;
    due_date: string;
    lines: Array<{ description_code: string; amount: string }>;
    basis: {
      basis_hash: string;
      completion_id: string;
      completion_version: number;
      completion_hash: string;
      quote_id: string;
      quote_version: number;
      quote_hash: string;
      changes_hash: string;
    };
    blocker: { code: QuickBooksBlockerCode; next_step: QuickBooksNextStep } | null;
    rejection_reason: QuickBooksRejectionReason | null;
    citations: Array<{
      id: string;
      label: "completion_packet" | "accepted_quote" | "accepted_change" | "commercial_policy";
      source: "Frappe" | "R2";
      source_ref: string;
      sha256: string;
    }>;
    provider: { invoice_id: string; submitted_at: string | null; matched_at: string | null } | null;
    created_at: string;
    updated_at: string;
  };
}

export type QuickBooksResult<T> =
  | { kind: "created" | "replayed" | "updated"; value: T }
  | { kind: "rejected"; code: string; status: 400 | 403 | 404 | 409 | 502 | 503 };

interface Config {
  tenantId: string;
  publicOrigin: string;
  redirectUri: string;
  environment: "sandbox" | "production";
  minorVersion: number;
  clientId: string;
  clientSecret: string;
  encryptionKey: Uint8Array;
  encryptionKeyVersion: string;
  expectedRealmId: string | null;
  frappeBaseUrl: string;
  frappeApiKey: string;
  frappeApiSecret: string;
  timeoutMs: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
const QBO_ID = /^[1-9][0-9]{0,31}$/;
const INTENT_ID = /^[A-Za-z0-9:_-]{16,160}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MONEY = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const TAX_RATE = /^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const REFRESH_LEASE_MS = 30 * 1_000;
const REFRESH_SKEW_MS = 2 * 60 * 1_000;
const RECOVERY_LIMIT = 10;
const DISCOVERY_LIMIT = 100;
const SAFE_RETRY_DELAY_MS = 30 * 1_000;
const STALE_EFFECT_LEASE_MS = 2 * 60 * 1_000;

class QuickBooksTokenExchangeRejected extends Error {}

export function quickBooksOAuthEnabled(env: AppEnv): boolean {
  return String((env as QuickBooksEnv).QB_OAUTH_ENABLED ?? "") === "true";
}

export function quickBooksFinalInvoiceEnabled(env: AppEnv): boolean {
  return String((env as QuickBooksEnv).QB_FINAL_INVOICE_ENABLED ?? "") === "true";
}

export function validQuickBooksIntentId(value: string): boolean {
  return INTENT_ID.test(value);
}

export async function requestQuickBooksConnect(
  env: AppEnv,
  input: {
    tenantId: string;
    actorUserId: string;
    returnPath: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<QuickBooksResult<{
  connect_url: string;
  return_path: typeof QUICKBOOKS_RETURN_PATH;
  callback_origin: string;
  redirect_uri: string;
  expires_at: string;
}>> {
  if (!quickBooksOAuthEnabled(env)) return rejected("quickbooks_oauth_disabled", 503);
  const config = configuration(env, false);
  if (!config) return rejected("quickbooks_oauth_not_configured", 503);
  if (input.tenantId !== config.tenantId || input.returnPath !== QUICKBOOKS_RETURN_PATH)
    return rejected("invalid_quickbooks_connect_request", 400);
  const now = input.now ?? new Date();
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    operation: "connect",
    tenant_id: input.tenantId,
    user_id: input.actorUserId,
    redirect_uri: config.redirectUri,
    return_path: QUICKBOOKS_RETURN_PATH,
  }));
  const previous = await env.DB.prepare(
    `SELECT request_fingerprint_sha256 FROM quickbooks_oauth_states
      WHERE tenant_id = ? AND idempotency_key_sha256 = ? LIMIT 1`,
  ).bind(input.tenantId, keyHash).first<{ request_fingerprint_sha256: string }>();
  if (previous) {
    return rejected(
      previous.request_fingerprint_sha256 === fingerprint
        ? "quickbooks_connect_handoff_already_requested"
        : "quickbooks_idempotency_conflict",
      409,
    );
  }
  const rawState = randomBase64Url(32);
  const stateHash = await sha256Hex(rawState);
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO quickbooks_oauth_states (
         state_sha256, tenant_id, user_id, redirect_uri, return_path,
         idempotency_key_sha256, request_fingerprint_sha256, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      stateHash, input.tenantId, input.actorUserId, config.redirectUri,
      QUICKBOOKS_RETURN_PATH, keyHash, fingerprint, now.toISOString(), expiresAt,
    ).run();
  } catch {
    const raced = await env.DB.prepare(
      `SELECT request_fingerprint_sha256 FROM quickbooks_oauth_states
        WHERE tenant_id = ? AND idempotency_key_sha256 = ? LIMIT 1`,
    ).bind(input.tenantId, keyHash).first<{ request_fingerprint_sha256: string }>().catch(() => null);
    if (!raced) return rejected("quickbooks_connect_store_unavailable", 503);
    return rejected(
      raced.request_fingerprint_sha256 === fingerprint
        ? "quickbooks_connect_handoff_already_requested"
        : "quickbooks_idempotency_conflict",
      409,
    );
  }
  const authorize = new URL(QUICKBOOKS_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("scope", QUICKBOOKS_ACCOUNTING_SCOPE);
  authorize.searchParams.set("redirect_uri", config.redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", rawState);
  return {
    kind: "created",
    value: {
      connect_url: authorize.toString(),
      return_path: QUICKBOOKS_RETURN_PATH,
      callback_origin: config.publicOrigin,
      redirect_uri: config.redirectUri,
      expires_at: expiresAt,
    },
  };
}

export async function handleQuickBooksOAuthCallback(
  req: Request,
  env: AppEnv,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<Response> {
  const config = quickBooksOAuthEnabled(env) ? configuration(env, false) : null;
  const fallbackOrigin = configuredPublicOrigin(env);
  if (!config || !fallbackOrigin) return fixedOAuthRedirect(fallbackOrigin, "error");
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== QUICKBOOKS_CALLBACK_PATH)
    return fixedOAuthRedirect(config.publicOrigin, "error");
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !["state", "code", "realmId", "error"].includes(key)))
    return fixedOAuthRedirect(config.publicOrigin, "error");
  const state = exactParam(url, "state", 20, 256);
  const code = exactParam(url, "code", 1, 2048);
  const realmId = exactParam(url, "realmId", 1, 32);
  const oauthError = exactParam(url, "error", 1, 100);
  const successShape = state && code && realmId && !oauthError && keys.length === 3;
  const errorShape = state && oauthError && !code && !realmId && keys.length === 2;
  if (!successShape && !errorShape) return fixedOAuthRedirect(config.publicOrigin, "error");
  const stateHash = await sha256Hex(state!);
  const stored = await env.DB.prepare(
    `SELECT * FROM quickbooks_oauth_states
      WHERE state_sha256 = ? AND tenant_id = ? LIMIT 1`,
  ).bind(stateHash, config.tenantId).first<OAuthStateRow>();
  if (!stored || stored.consumed_at !== null || stored.outcome_code !== null || stored.expires_at <= now.toISOString() ||
      stored.redirect_uri !== config.redirectUri || stored.return_path !== QUICKBOOKS_RETURN_PATH) {
    return fixedOAuthRedirect(config.publicOrigin, "error");
  }
  const user = await env.DB.prepare(
    `SELECT COALESCE(access_role, role) AS role FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1 LIMIT 1`,
  ).bind(stored.tenant_id, stored.user_id).first<{ role: string }>();
  if (user?.role !== "owner") return fixedOAuthRedirect(config.publicOrigin, "error");
  if (oauthError) {
    await env.DB.prepare(
      `UPDATE quickbooks_oauth_states SET consumed_at = ?, outcome_code = 'provider_denied'
        WHERE state_sha256 = ? AND tenant_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    ).bind(now.toISOString(), stateHash, stored.tenant_id, now.toISOString()).run();
    return fixedOAuthRedirect(config.publicOrigin, "error");
  }
  const claimed = await env.DB.prepare(
    `UPDATE quickbooks_oauth_states SET consumed_at = ?, outcome_code = 'exchange_started'
      WHERE state_sha256 = ? AND tenant_id = ? AND consumed_at IS NULL
        AND outcome_code IS NULL AND expires_at > ?`,
  ).bind(now.toISOString(), stateHash, stored.tenant_id, now.toISOString()).run();
  if (changes(claimed) !== 1) return fixedOAuthRedirect(config.publicOrigin, "error");
  if (!QBO_ID.test(realmId!) || (config.expectedRealmId && config.expectedRealmId !== realmId))
    return await finishOAuthFailure(env, config.publicOrigin, stateHash, "exchange_failed", now);
  const providerRealms = await env.DB.prepare(
    `SELECT DISTINCT realm_id FROM quickbooks_final_invoice_intents
      WHERE tenant_id = ? AND (provider_invoice_id IS NOT NULL OR provider_submitted_at IS NOT NULL)
      ORDER BY realm_id ASC LIMIT 2`,
  ).bind(stored.tenant_id).all<{ realm_id: string }>();
  const evidencedRealms = providerRealms.results ?? [];
  if (evidencedRealms.length > 1 ||
      (evidencedRealms.length === 1 && evidencedRealms[0]!.realm_id !== realmId)) {
    return await finishOAuthFailure(env, config.publicOrigin, stateHash, "exchange_failed", now);
  }
  if (evidencedRealms.length === 0) {
    const latest = await latestConnection(env, stored.tenant_id);
    if (latest?.state === "connected" && latest.realm_id !== realmId)
      return await finishOAuthFailure(env, config.publicOrigin, stateHash, "exchange_failed", now);
  }
  try {
    const token = await exchangeToken(config, { grant_type: "authorization_code", code: code!, redirect_uri: stored.redirect_uri }, fetcher);
    const connectionId = crypto.randomUUID();
    const encrypted = await encryptBundle(config, stored.tenant_id, connectionId, 1, token.bundle);
    const refreshExpiry = token.refreshExpiresIn === null
      ? null
      : new Date(now.getTime() + token.refreshExpiresIn * 1_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE quickbooks_oauth_states SET outcome_code = 'connected'
          WHERE state_sha256 = ? AND tenant_id = ? AND consumed_at = ?
            AND outcome_code = 'exchange_started'`,
      ).bind(stateHash, stored.tenant_id, now.toISOString()),
      env.DB.prepare(
        `UPDATE quickbooks_connections
            SET state = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?,
                revocation_idempotency_sha256 = ?, revocation_fingerprint_sha256 = ?
          WHERE tenant_id = ? AND state IN ('connected','reconciliation_required')
            AND EXISTS (
              SELECT 1 FROM quickbooks_oauth_states
               WHERE state_sha256 = ? AND tenant_id = ? AND consumed_at = ?
                 AND outcome_code = 'connected'
            )`,
      ).bind(stored.user_id, now.toISOString(), now.toISOString(), stateHash, stateHash,
        stored.tenant_id, stateHash, stored.tenant_id, now.toISOString()),
      env.DB.prepare(
        `INSERT INTO quickbooks_connections (
           connection_id, oauth_state_sha256, tenant_id, realm_id, state,
           encrypted_bundle_b64, bundle_iv_b64, encryption_key_version, bundle_version,
           access_expires_at, refresh_expires_at, connected_by_user_id, connected_at, updated_at
         )
         SELECT ?, ?, ?, ?, 'connected', ?, ?, ?, 1, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM quickbooks_oauth_states
             WHERE state_sha256 = ? AND tenant_id = ? AND consumed_at = ?
               AND outcome_code = 'connected'
          )`,
      ).bind(
        connectionId, stateHash, stored.tenant_id, realmId, encrypted.ciphertext,
        encrypted.iv, config.encryptionKeyVersion,
        new Date(now.getTime() + token.accessExpiresIn * 1_000).toISOString(),
        refreshExpiry, stored.user_id, now.toISOString(), now.toISOString(),
        stateHash, stored.tenant_id, now.toISOString(),
      ),
    ]);
    const connected = await env.DB.prepare(
      `SELECT c.connection_id FROM quickbooks_connections c
        JOIN quickbooks_oauth_states s ON s.state_sha256 = c.oauth_state_sha256
       WHERE c.oauth_state_sha256 = ? AND c.tenant_id = ? AND c.state = 'connected'
         AND s.outcome_code = 'connected' AND s.consumed_at = ? LIMIT 1`,
    ).bind(stateHash, stored.tenant_id, now.toISOString()).first<{ connection_id: string }>();
    if (!connected) throw new Error("quickbooks_oauth_connection_not_committed");
    return fixedOAuthRedirect(config.publicOrigin, "connected");
  } catch (error) {
    const outcome = error instanceof QuickBooksTokenExchangeRejected
      ? "exchange_failed" as const : "exchange_uncertain" as const;
    return await finishOAuthFailure(env, config.publicOrigin, stateHash, outcome, now);
  }
}

async function finishOAuthFailure(
  env: AppEnv,
  origin: string,
  stateHash: string,
  outcome: "exchange_failed" | "exchange_uncertain",
  now: Date,
): Promise<Response> {
  await env.DB.prepare(
    `UPDATE quickbooks_oauth_states SET outcome_code = ?
      WHERE state_sha256 = ? AND consumed_at IS NOT NULL AND outcome_code = 'exchange_started'`,
  ).bind(outcome, stateHash).run().catch(() => {});
  return fixedOAuthRedirect(origin, "error");
}

export async function removeQuickBooksFromIronWrap(
  env: AppEnv,
  input: { tenantId: string; actorUserId: string; expectedVersion: number; idempotencyKey: string; now?: Date },
): Promise<QuickBooksResult<{ connection_state: "revoked"; upstream_authorization: "may_remain"; next_step: "revoke_in_intuit_if_required" }>> {
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const latest = await latestConnection(env, input.tenantId);
  const fingerprint = latest ? await sha256Hex(JSON.stringify({
    operation: "remove_from_ironwrap",
    connection_id: latest.connection_id,
    version: input.expectedVersion,
  })) : "";
  if (latest?.revocation_idempotency_sha256 === keyHash) {
    return latest.revocation_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", value: revokedConnectionResult() }
      : rejected("quickbooks_idempotency_conflict", 409);
  }
  const row = latest && ["connected", "reconciliation_required"].includes(latest.state) ? latest : null;
  if (!row) return rejected("quickbooks_connection_not_found", 404);
  if (row.bundle_version !== input.expectedVersion) return rejected("quickbooks_connection_version_conflict", 409);
  const now = (input.now ?? new Date()).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE quickbooks_connections
        SET state = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?,
            revocation_idempotency_sha256 = ?, revocation_fingerprint_sha256 = ?
      WHERE connection_id = ? AND tenant_id = ?
        AND state IN ('connected','reconciliation_required') AND bundle_version = ?`,
  ).bind(input.actorUserId, now, now, keyHash, fingerprint,
    row.connection_id, input.tenantId, input.expectedVersion).run();
  if (changes(updated) !== 1) return rejected("quickbooks_connection_version_conflict", 409);
  return { kind: "updated", value: revokedConnectionResult() };
}

function revokedConnectionResult(): {
  connection_state: "revoked";
  upstream_authorization: "may_remain";
  next_step: "revoke_in_intuit_if_required";
} {
  return {
    connection_state: "revoked",
    upstream_authorization: "may_remain",
    next_step: "revoke_in_intuit_if_required",
  };
}

export async function quickBooksConnectionEnvelope(
  env: AppEnv,
  tenantId: string,
  role: AppRole,
): Promise<{
  version: 1;
  state: "connected" | "connection_required" | "revoked" | "reconciliation_required";
  connection_version: number | null;
  realm_id: string | null;
  last_connected_at: string | null;
  allowed_actions: Array<"connect" | "remove_from_ironwrap" | "refresh">;
}> {
  const connection = await latestConnection(env, tenantId);
  const state = connection?.state ?? "connection_required";
  const allowedActions: Array<"connect" | "remove_from_ironwrap" | "refresh"> = ["refresh"];
  if (role === "owner") {
    if (state === "connected") allowedActions.unshift("remove_from_ironwrap");
    else if ((state === "connection_required" || state === "revoked") && oauthConfigurationReady(env))
      allowedActions.unshift("connect");
  }
  return {
    version: 1,
    state,
    connection_version: connection ? Number(connection.bundle_version) : null,
    realm_id: state === "connected" ? connection!.realm_id : null,
    last_connected_at: state === "connected" ? connection!.connected_at : null,
    allowed_actions: allowedActions,
  };
}

export async function discoverQuickBooksFinalInvoiceCandidates(
  env: AppEnv,
  input: { roofJobId?: string; limit?: number; fetcher?: typeof fetch; now?: Date } = {},
): Promise<{ discovered: number; replayed: number; blocked: number }> {
  if (!quickBooksFinalInvoiceEnabled(env)) return { discovered: 0, replayed: 0, blocked: 0 };
  const config = configuration(env, true);
  if (!config) throw new Error("quickbooks_final_invoice_not_configured");
  if (input.roofJobId !== undefined && !SAFE_ID.test(input.roofJobId))
    throw new Error("quickbooks_candidate_request_invalid");
  const connection = await activeConnection(env, config.tenantId);
  if (!connection) return { discovered: 0, replayed: 0, blocked: 0 };
  const limit = boundedLimit(input.limit ?? 50, 100);
  const response = await frappeCall(config, "list_candidates", {
    request_json: JSON.stringify({
      ...(input.roofJobId ? { roof_job_id: input.roofJobId } : {}),
      limit,
      realm_id: connection.realm_id,
    }),
  }, input.fetcher ?? fetch);
  const listing = candidateListing(response);
  if (!listing) throw new Error("quickbooks_candidates_invalid_response");
  const candidates = listing.candidates.slice(0, limit).map(validateCandidate);
  if (candidates.some((candidate) => !candidate) ||
      candidates.some((candidate) => candidate!.qbo.realm_id !== connection.realm_id)) {
    // A malformed or cross-realm item makes the whole successful response unusable. Do not
    // partially persist it or resolve durable holds from a listing that was not fully trusted.
    throw new Error("quickbooks_candidate_invalid");
  }
  let discovered = 0;
  let replayed = 0;
  let blocked = listing.blockers.length;
  const now = input.now ?? new Date();
  const seenByJob = new Map<string, Set<string>>();
  for (const blocker of listing.blockers) {
    const fingerprint = await sha256Hex(canonicalJson({
      roof_job_id: blocker.roof_job_id,
      code: blocker.code,
      citations: blocker.citations,
    }));
    const citationsJson = canonicalJson(blocker.citations);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO quickbooks_final_invoice_candidate_holds (
           hold_id, tenant_id, roof_job_id, blocker_code, citations_json,
           observation_sha256, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, roof_job_id, blocker_code, observation_sha256) DO NOTHING`,
      ).bind(crypto.randomUUID(), config.tenantId, blocker.roof_job_id, blocker.code,
        citationsJson, fingerprint, now.toISOString()),
      env.DB.prepare(
        `INSERT INTO quickbooks_final_invoice_current_holds (
           tenant_id, roof_job_id, blocker_code, citations_json, observation_sha256,
           first_observed_at, last_observed_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(tenant_id, roof_job_id, blocker_code) DO UPDATE SET
           citations_json = excluded.citations_json,
           observation_sha256 = excluded.observation_sha256,
           last_observed_at = excluded.last_observed_at,
           resolved_at = NULL`,
      ).bind(config.tenantId, blocker.roof_job_id, blocker.code, citationsJson,
        fingerprint, now.toISOString(), now.toISOString()),
    ]);
    const codes = seenByJob.get(blocker.roof_job_id) ?? new Set<string>();
    codes.add(blocker.code);
    seenByJob.set(blocker.roof_job_id, codes);
  }
  for (const candidate of candidates as QuickBooksCandidate[]) {
    if (!seenByJob.has(candidate.roof_job_id)) seenByJob.set(candidate.roof_job_id, new Set());
    const outcome = await persistCandidate(env, config, candidate, now);
    if (outcome === "created") discovered += 1;
    else if (outcome === "replayed") replayed += 1;
    else blocked += 1;
  }
  if (input.roofJobId && !seenByJob.has(input.roofJobId)) seenByJob.set(input.roofJobId, new Set());
  for (const [roofJobId, blockerCodes] of seenByJob) {
    const open = await env.DB.prepare(
      `SELECT blocker_code FROM quickbooks_final_invoice_current_holds
        WHERE tenant_id = ? AND roof_job_id = ? AND resolved_at IS NULL`,
    ).bind(config.tenantId, roofJobId).all<{ blocker_code: string }>();
    for (const current of open.results ?? []) {
      if (blockerCodes.has(current.blocker_code)) continue;
      await env.DB.prepare(
        `UPDATE quickbooks_final_invoice_current_holds
            SET resolved_at = ?, last_observed_at = ?
          WHERE tenant_id = ? AND roof_job_id = ? AND blocker_code = ?
            AND resolved_at IS NULL AND last_observed_at <= ?`,
      ).bind(now.toISOString(), now.toISOString(), config.tenantId, roofJobId,
        current.blocker_code, now.toISOString()).run();
    }
  }
  return { discovered, replayed, blocked };
}

export async function approveQuickBooksFinalInvoice(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    actorRole: AppRole;
    expectedVersion: number;
    idempotencyKey: string;
    fetcher?: typeof fetch;
    now?: Date;
  },
): Promise<QuickBooksResult<FinalInvoiceRow>> {
  if (input.actorRole !== "owner" && input.actorRole !== "accounting")
    return rejected("quickbooks_review_role_required", 403);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    operation: "approve", intent_id: input.intentId, version: input.expectedVersion,
  }));
  const row = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!row) return rejected("quickbooks_final_invoice_not_found", 404);
  if (row.approval_idempotency_sha256 === keyHash) {
    return row.approval_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", value: row }
      : rejected("quickbooks_idempotency_conflict", 409);
  }
  if (row.version !== input.expectedVersion) return rejected("quickbooks_final_invoice_version_conflict", 409);
  if (row.state !== "pending_review") return rejected("quickbooks_final_invoice_not_reviewable", 409);
  if (!quickBooksFinalInvoiceEnabled(env)) return rejected("quickbooks_final_invoice_disabled", 503);
  const connection = await activeConnection(env, input.tenantId);
  if (!connection || connection.realm_id !== row.realm_id)
    return rejected("quickbooks_connection_required", 409);
  const config = configuration(env, true);
  if (!config) return rejected("quickbooks_final_invoice_not_configured", 503);
  const freshness = await checkCandidateFreshness(
    config, row, connection.realm_id, input.fetcher ?? fetch,
  ).catch(() => "unavailable" as const);
  const nowDate = input.now ?? new Date();
  if (freshness === "unavailable")
    return rejected("quickbooks_candidate_refresh_unavailable", 502);
  if (freshness !== "exact") {
    await blockChangedCandidate(env, row, nowDate);
    return rejected("quickbooks_candidate_changed", 409);
  }
  const recheckedConnection = await activeConnection(env, input.tenantId);
  if (!recheckedConnection || recheckedConnection.connection_id !== connection.connection_id ||
      recheckedConnection.realm_id !== row.realm_id)
    return rejected("quickbooks_connection_required", 409);
  const now = nowDate.toISOString();
  try {
    const updated = await env.DB.prepare(
      `UPDATE quickbooks_final_invoice_intents
          SET state = 'submission_pending', approval_idempotency_sha256 = ?,
              approval_fingerprint_sha256 = ?, approved_by_user_id = ?, approved_at = ?,
              blocker_code = NULL, blocker_next_step = NULL, error_code = NULL,
              version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND intent_id = ? AND state = 'pending_review' AND version = ?`,
    ).bind(keyHash, fingerprint, input.actorUserId, now, now,
      input.tenantId, input.intentId, input.expectedVersion).run();
    if (changes(updated) !== 1) return rejected("quickbooks_final_invoice_version_conflict", 409);
  } catch {
    const replay = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
    if (replay?.approval_idempotency_sha256 === keyHash && replay.approval_fingerprint_sha256 === fingerprint)
      return { kind: "replayed", value: replay };
    return rejected("quickbooks_idempotency_conflict", 409);
  }
  const value = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!value) throw new Error("quickbooks_final_invoice_approved_missing");
  return { kind: "updated", value };
}

export async function rejectQuickBooksFinalInvoice(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    actorRole: AppRole;
    expectedVersion: number;
    reasonCode: QuickBooksRejectionReason;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<QuickBooksResult<FinalInvoiceRow>> {
  if (input.actorRole !== "owner" && input.actorRole !== "accounting")
    return rejected("quickbooks_review_role_required", 403);
  if (!(QUICKBOOKS_REJECTION_REASONS as readonly string[]).includes(input.reasonCode))
    return rejected("quickbooks_rejection_reason_invalid", 400);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    operation: "reject", intent_id: input.intentId, version: input.expectedVersion,
    reason_code: input.reasonCode,
  }));
  const row = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!row) return rejected("quickbooks_final_invoice_not_found", 404);
  if (row.rejection_idempotency_sha256 === keyHash) {
    return row.rejection_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", value: row }
      : rejected("quickbooks_idempotency_conflict", 409);
  }
  if (row.version !== input.expectedVersion) return rejected("quickbooks_final_invoice_version_conflict", 409);
  if (row.state !== "pending_review") return rejected("quickbooks_final_invoice_not_reviewable", 409);
  const now = (input.now ?? new Date()).toISOString();
  try {
    const updated = await env.DB.prepare(
      `UPDATE quickbooks_final_invoice_intents
          SET state = 'rejected', rejection_idempotency_sha256 = ?,
              rejection_fingerprint_sha256 = ?, rejected_by_user_id = ?, rejected_at = ?,
              reason_code = ?, version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND intent_id = ? AND state = 'pending_review' AND version = ?`,
    ).bind(keyHash, fingerprint, input.actorUserId, now, input.reasonCode, now,
      input.tenantId, input.intentId, input.expectedVersion).run();
    if (changes(updated) !== 1) return rejected("quickbooks_final_invoice_version_conflict", 409);
  } catch {
    const replay = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
    if (replay?.rejection_idempotency_sha256 === keyHash &&
        replay.rejection_fingerprint_sha256 === fingerprint)
      return { kind: "replayed", value: replay };
    return rejected("quickbooks_idempotency_conflict", 409);
  }
  const value = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!value) throw new Error("quickbooks_final_invoice_rejected_missing");
  return { kind: "updated", value };
}

export async function requestQuickBooksFinalInvoiceReconciliation(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    actorRole: AppRole;
    expectedVersion: number;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<QuickBooksResult<FinalInvoiceRow>> {
  if (input.actorRole !== "owner" && input.actorRole !== "accounting")
    return rejected("quickbooks_reconcile_role_required", 403);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    operation: "reconcile", intent_id: input.intentId, version: input.expectedVersion,
  }));
  const receipt = await env.DB.prepare(
    `SELECT intent_id, request_fingerprint_sha256 FROM quickbooks_final_invoice_command_receipts
      WHERE tenant_id = ? AND idempotency_key_sha256 = ? LIMIT 1`,
  ).bind(input.tenantId, keyHash).first<{ intent_id: string; request_fingerprint_sha256: string }>();
  const row = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!row) return rejected("quickbooks_final_invoice_not_found", 404);
  if (receipt) {
    return receipt.intent_id === input.intentId && receipt.request_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", value: row }
      : rejected("quickbooks_idempotency_conflict", 409);
  }
  if (row.version !== input.expectedVersion) return rejected("quickbooks_final_invoice_version_conflict", 409);
  if (!row.provider_invoice_id || !["submitted", "reconciliation_required"].includes(row.state))
    return rejected("quickbooks_final_invoice_not_reconcilable", 409);
  const now = (input.now ?? new Date()).toISOString();
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_command_receipts (
         receipt_id, tenant_id, intent_id, operation, idempotency_key_sha256,
         request_fingerprint_sha256, requested_version, actor_user_id, created_at
       ) SELECT ?, ?, ?, 'reconcile', ?, ?, ?, ?, ?
          FROM quickbooks_final_invoice_intents
         WHERE tenant_id = ? AND intent_id = ? AND version = ?
           AND state IN ('submitted','reconciliation_required')
           AND provider_invoice_id IS NOT NULL`,
    ).bind(crypto.randomUUID(), input.tenantId, input.intentId, keyHash,
      fingerprint, input.expectedVersion, input.actorUserId, now,
      input.tenantId, input.intentId, input.expectedVersion).run();
    if (changes(inserted) !== 1)
      return rejected("quickbooks_final_invoice_version_conflict", 409);
  } catch {
    const raced = await env.DB.prepare(
      `SELECT intent_id, request_fingerprint_sha256 FROM quickbooks_final_invoice_command_receipts
        WHERE tenant_id = ? AND idempotency_key_sha256 = ? LIMIT 1`,
    ).bind(input.tenantId, keyHash).first<{ intent_id: string; request_fingerprint_sha256: string }>();
    return raced?.intent_id === input.intentId && raced.request_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", value: (await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId))! }
      : rejected("quickbooks_idempotency_conflict", 409);
  }
  const value = await getQuickBooksFinalInvoice(env, input.tenantId, input.intentId);
  if (!value) throw new Error("quickbooks_final_invoice_reconcile_missing");
  return { kind: "updated", value };
}

export async function getQuickBooksFinalInvoice(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<FinalInvoiceRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM quickbooks_final_invoice_intents
      WHERE tenant_id = ? AND intent_id = ? LIMIT 1`,
  ).bind(tenantId, intentId).first<FinalInvoiceRow>();
}

export async function quickBooksFinalInvoiceEnvelope(
  env: AppEnv,
  row: FinalInvoiceRow,
  role: AppRole,
  now = new Date(),
): Promise<QuickBooksFinalInvoiceEnvelope> {
  const connection = await latestConnection(env, row.tenant_id);
  const permissions: QuickBooksFinalInvoiceEnvelope["permissions"] = ["quickbooks:read"];
  if (role === "owner" || role === "accounting") permissions.push("quickbooks:review", "quickbooks:reconcile");
  const actions: QuickBooksFinalInvoiceAction[] = ["refresh"];
  const exactConnection = connection?.state === "connected" && connection.realm_id === row.realm_id;
  if (role === "owner" && connection?.state === "connected") actions.push("remove_from_ironwrap");
  if (role === "owner" && (connection === null || connection.state === "revoked") && oauthConfigurationReady(env))
    actions.push("connect");
  if ((role === "owner" || role === "accounting") && row.state === "pending_review") {
    if (exactConnection && invoiceConfigurationReady(env)) actions.push("approve");
    actions.push("reject");
  }
  if ((role === "owner" || role === "accounting") && row.provider_invoice_id &&
      ["submitted", "reconciliation_required"].includes(row.state)) actions.push("reconcile");
  return {
    version: 1,
    read_model_generated_at: now.toISOString(),
    permissions,
    allowed_actions: actions,
    connection: {
      state: connection?.state ?? "connection_required",
      realm_id: connection?.state === "connected" ? connection.realm_id : null,
      last_connected_at: connection?.state === "connected" ? connection.connected_at : null,
    },
    intent: {
      id: row.intent_id,
      job_id: row.roof_job_id,
      shop_order_id: row.shop_order_id,
      state: row.state,
      version: Number(row.version),
      currency: "CAD",
      amounts: {
        subtotal: row.subtotal,
        tax: row.tax_amount,
        already_invoiced: row.already_invoiced,
        final_balance: row.final_balance,
      },
      tax: { code: row.tax_code, rate: row.tax_rate },
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      lines: parseLines(row.lines_json).map((line) => ({
        description_code: line.description_code,
        amount: line.amount,
      })),
      basis: {
        basis_hash: row.basis_sha256,
        completion_id: row.completion_packet_id,
        completion_version: Number(row.completion_version),
        completion_hash: row.completion_sha256,
        quote_id: row.customer_quote_id,
        quote_version: Number(row.quote_version),
        quote_hash: row.quote_sha256,
        changes_hash: row.changes_sha256,
      },
      blocker: row.blocker_code && row.blocker_next_step
        ? { code: row.blocker_code, next_step: row.blocker_next_step }
        : null,
      rejection_reason: row.reason_code,
      citations: projectCitations(parseEvidence(row.evidence_json)),
      provider: row.provider_invoice_id ? {
        invoice_id: row.provider_invoice_id,
        submitted_at: row.provider_submitted_at,
        matched_at: row.provider_matched_at,
      } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export async function listQuickBooksFinalInvoiceActionable(
  env: AppEnv,
  tenantId: string,
  limit = 6,
): Promise<QuickBooksFinalInvoiceProjection[]> {
  const result = await env.DB.prepare(
    `SELECT intent_id, roof_job_id, shop_order_id, state, version, currency,
            final_balance, blocker_code, blocker_next_step, reason_code, evidence_json, updated_at
       FROM quickbooks_final_invoice_intents
      WHERE tenant_id = ? AND state != 'matched'
        AND state != 'rejected'
      ORDER BY updated_at ASC LIMIT ?`,
  ).bind(tenantId, boundedLimit(limit, 20)).all<FinalInvoiceRow>();
  return (result.results ?? []).map((row) => ({
    intent_id: row.intent_id,
    roof_job_id: row.roof_job_id,
    shop_order_id: row.shop_order_id,
    state: row.state,
    version: Number(row.version),
    currency: "CAD",
    final_balance: row.final_balance,
    blocker_code: row.blocker_code,
    blocker_next_step: row.blocker_next_step,
    rejection_reason: row.reason_code,
    evidence: parseEvidence(row.evidence_json).slice(0, 2),
    updated_at: row.updated_at,
  }));
}

export async function listQuickBooksCandidateHolds(
  env: AppEnv,
  tenantId: string,
  limit = 6,
): Promise<QuickBooksCandidateHoldProjection[]> {
  const result = await env.DB.prepare(
    `SELECT roof_job_id, blocker_code, citations_json, last_observed_at
       FROM quickbooks_final_invoice_current_holds
      WHERE tenant_id = ? AND resolved_at IS NULL
      ORDER BY last_observed_at ASC LIMIT ?`,
  ).bind(tenantId, boundedLimit(limit, 20)).all<{
    roof_job_id: string;
    blocker_code: string;
    citations_json: string;
    last_observed_at: string;
  }>();
  return (result.results ?? []).map((row) => ({
    roof_job_id: row.roof_job_id,
    blocker_code: row.blocker_code,
    citations: parseEvidence(row.citations_json).slice(0, 2),
    updated_at: row.last_observed_at,
  }));
}

export async function recoverQuickBooksFinalInvoices(
  env: AppEnv,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<{ discovered: number; effects_processed: number }> {
  if (!quickBooksFinalInvoiceEnabled(env)) return { discovered: 0, effects_processed: 0 };
  let discovered = 0;
  try {
    discovered = (await discoverQuickBooksFinalInvoiceCandidates(env, {
      limit: DISCOVERY_LIMIT,
      fetcher,
      now,
    })).discovered;
  } catch {
    // Discovery is independent of replaying already-durable effects.
  }
  await recoverStaleEffects(env, now);
  await repairSuccessorEffects(env, now);
  const due = await env.DB.prepare(
    `SELECT * FROM quickbooks_final_invoice_outbox
      WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT ?`,
  ).bind(now.toISOString(), RECOVERY_LIMIT).all<OutboxRow>();
  let effectsProcessed = 0;
  for (const effect of due.results ?? []) {
    if (await processEffect(env, effect, fetcher, now)) effectsProcessed += 1;
  }
  return { discovered, effects_processed: effectsProcessed };
}

export async function quickBooksFinalInvoiceOperationalCounts(env: AppEnv): Promise<{
  outbound_pending: number;
  outbound_uncertain: number;
  outbound_failed: number;
  inbound_pending: number;
  inbound_rejected: number;
  unresolved_reconciliation: number;
  connection_uncertain: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN o.state IN ('pending','attempting') THEN 1 ELSE 0 END) AS outbound_pending,
       SUM(CASE WHEN o.state = 'unknown' THEN 1 ELSE 0 END) AS outbound_uncertain,
       SUM(CASE WHEN o.state = 'failed' THEN 1 ELSE 0 END) AS outbound_failed,
       (SELECT COUNT(*) FROM quickbooks_projection_outbox WHERE projection_status = 'pending') AS inbound_pending,
       (SELECT COUNT(*) FROM quickbooks_projection_outbox WHERE projection_status = 'rejected') AS inbound_rejected,
       (SELECT COUNT(*) FROM quickbooks_final_invoice_intents WHERE state = 'reconciliation_required') AS unresolved_reconciliation,
       (SELECT COUNT(*) FROM quickbooks_connections WHERE state = 'reconciliation_required') AS connection_uncertain
     FROM quickbooks_final_invoice_outbox o`,
  ).first<Record<string, number | null>>();
  return {
    outbound_pending: Number(row?.outbound_pending ?? 0),
    outbound_uncertain: Number(row?.outbound_uncertain ?? 0),
    outbound_failed: Number(row?.outbound_failed ?? 0),
    inbound_pending: Number(row?.inbound_pending ?? 0),
    inbound_rejected: Number(row?.inbound_rejected ?? 0),
    unresolved_reconciliation: Number(row?.unresolved_reconciliation ?? 0),
    connection_uncertain: Number(row?.connection_uncertain ?? 0),
  };
}

async function persistCandidate(
  env: AppEnv,
  config: Config,
  candidate: QuickBooksCandidate,
  now: Date,
): Promise<"created" | "replayed" | "blocked"> {
  const canonicalCandidate = canonicalJson(candidate);
  const fingerprint = await sha256Hex(canonicalCandidate);
  const existing = await getQuickBooksFinalInvoice(env, config.tenantId, candidate.basis.intent_id);
  if (existing) {
    if (existing.candidate_fingerprint_sha256 === fingerprint) {
      if (["connection_required", "blocked"].includes(existing.state)) {
        const connection = await activeConnection(env, config.tenantId);
        const realmMismatch = (config.expectedRealmId && config.expectedRealmId !== candidate.qbo.realm_id) ||
          (connection && connection.realm_id !== candidate.qbo.realm_id);
        if (connection && !realmMismatch) {
          await env.DB.prepare(
            `UPDATE quickbooks_final_invoice_intents
                SET state = 'pending_review', blocker_code = NULL, blocker_next_step = NULL,
                    error_code = NULL, version = version + 1, updated_at = ?
              WHERE tenant_id = ? AND intent_id = ? AND version = ?
                AND state IN ('connection_required','blocked')`,
          ).bind(now.toISOString(), existing.tenant_id, existing.intent_id, existing.version).run();
        }
      }
      return "replayed";
    }
    if (["connection_required", "blocked", "pending_review"].includes(existing.state)) {
      await env.DB.prepare(
        `UPDATE quickbooks_final_invoice_intents
            SET state = 'blocked', blocker_code = 'candidate_changed',
                blocker_next_step = 'refresh_candidate', error_code = 'quickbooks_candidate_changed',
                version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND intent_id = ? AND version = ?`,
      ).bind(now.toISOString(), existing.tenant_id, existing.intent_id, existing.version).run();
    }
    return "blocked";
  }
  const connection = await activeConnection(env, config.tenantId);
  const realmMismatch = (config.expectedRealmId && config.expectedRealmId !== candidate.qbo.realm_id) ||
    (connection && connection.realm_id !== candidate.qbo.realm_id);
  const state: QuickBooksFinalInvoiceState = realmMismatch
    ? "blocked"
    : connection ? "pending_review" : "connection_required";
  const blockerCode: QuickBooksBlockerCode | null = realmMismatch
    ? "realm_mismatch"
    : connection ? null : "oauth_connection_required";
  const blockerNextStep: QuickBooksNextStep | null = realmMismatch
    ? "fix_frappe_mapping"
    : connection ? null : "connect_quickbooks";
  const payload = providerPayload(candidate);
  const payloadJson = canonicalJson(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const requestId = `iwfi-${(await sha256Hex(
    `${config.tenantId}\n${candidate.qbo.realm_id}\n${candidate.basis.intent_id}\n${payloadHash}`,
  )).slice(0, 43)}`;
  try {
    await env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_intents (
         intent_id, tenant_id, roof_job_id, shop_order_id,
         completion_packet_id, completion_version, completion_sha256,
         customer_quote_id, quote_version, quote_sha256, changes_sha256, basis_sha256,
         candidate_fingerprint_sha256, realm_id, customer_ref, item_ref, tax_code_ref,
         terms_ref, currency, subtotal, tax_amount, total_amount, already_invoiced,
         final_balance, tax_code, tax_rate, invoice_date, due_date, lines_json, evidence_json,
         provider_payload_json, provider_payload_sha256, provider_request_id,
         state, blocker_code, blocker_next_step, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      candidate.basis.intent_id, config.tenantId, candidate.roof_job_id, candidate.shop_order_id,
      candidate.basis.completion_packet_id, Number(candidate.basis.completion_version), candidate.basis.completion_sha256,
      candidate.basis.customer_quote_id, candidate.basis.quote_version, candidate.basis.quote_sha256,
      candidate.basis.changes_sha256, candidate.basis.basis_sha256, fingerprint,
      candidate.qbo.realm_id, candidate.qbo.customer_id, candidate.qbo.item_id,
      candidate.qbo.tax_code_id, candidate.qbo.terms_id, candidate.commercial.currency,
      candidate.commercial.subtotal, candidate.commercial.tax_amount, candidate.commercial.total_amount,
      candidate.commercial.already_invoiced, candidate.commercial.final_balance,
      candidate.commercial.tax_code, candidate.commercial.tax_rate,
      candidate.commercial.invoice_date, candidate.commercial.due_date,
      JSON.stringify(candidate.commercial.lines), JSON.stringify(candidate.basis.evidence),
      payloadJson, payloadHash, requestId, state, blockerCode, blockerNextStep,
      now.toISOString(), now.toISOString(),
    ).run();
    return "created";
  } catch {
    const raced = await getQuickBooksFinalInvoice(env, config.tenantId, candidate.basis.intent_id);
    return raced?.candidate_fingerprint_sha256 === fingerprint ? "replayed" : "blocked";
  }
}

function providerPayload(candidate: QuickBooksCandidate): Record<string, unknown> {
  return {
    CustomerRef: { value: candidate.qbo.customer_id },
    CurrencyRef: { value: "CAD" },
    TxnDate: candidate.commercial.invoice_date,
    DueDate: candidate.commercial.due_date,
    SalesTermRef: { value: candidate.qbo.terms_id },
    Line: candidate.commercial.lines.map((line) => ({
      Amount: Number(line.amount),
      Description: qboLineLabel(line.description_code),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: { value: candidate.qbo.item_id },
        TaxCodeRef: { value: candidate.qbo.tax_code_id },
      },
    })),
  };
}

async function processEffect(
  env: AppEnv,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<boolean> {
  let row = await getQuickBooksFinalInvoice(env, effect.tenant_id, effect.intent_id);
  const config = configuration(env, true);
  if (!row || !config) {
    const claimed = await claimEffect(env, effect, now);
    if (!claimed) return false;
    await finishEffect(env, effect, "failed", "invalid_response", null,
      "quickbooks_effect_context_missing", now);
    return true;
  }
  if (effect.operation === "submit") {
    if (row.state !== "submission_pending" || row.provider_invoice_id) {
      await failUnclaimedEffect(env, effect, "quickbooks_submit_state_invalid", now);
      return true;
    }
    const connection = await activeConnection(env, row.tenant_id);
    if (!connection || connection.realm_id !== row.realm_id) {
      await deferUnclaimedEffect(env, effect, "quickbooks_connection_required", now);
      return true;
    }
    let freshness: "exact" | "changed" | "unavailable";
    try {
      freshness = await checkCandidateFreshness(config, row, connection.realm_id, fetcher);
    } catch {
      freshness = "unavailable";
    }
    if (freshness === "unavailable") {
      await deferUnclaimedEffect(env, effect, "quickbooks_candidate_refresh_unavailable", now);
      return true;
    }
    if (freshness === "changed") {
      await blockStaleSubmissionEffect(env, row, effect, now);
      return true;
    }
    const rechecked = await activeConnection(env, row.tenant_id);
    if (!rechecked || rechecked.connection_id !== connection.connection_id ||
        rechecked.realm_id !== row.realm_id) {
      await deferUnclaimedEffect(env, effect, "quickbooks_connection_required", now);
      return true;
    }
  }
  if (!await claimEffect(env, effect, now)) return false;
  row = await getQuickBooksFinalInvoice(env, effect.tenant_id, effect.intent_id);
  if (!row) {
    await finishEffect(env, effect, "failed", "invalid_response", null,
      "quickbooks_effect_context_missing", now);
    return true;
  }
  if (effect.operation === "submit") await submitInvoice(env, config, row, effect, fetcher, now);
  else if (effect.operation === "readback") await readbackInvoice(env, config, row, effect, fetcher, now);
  else if (effect.operation === "bind") await bindInvoice(env, config, row, effect, fetcher, now);
  else await resolveInvoice(env, config, row, effect, fetcher, now);
  return true;
}

async function claimEffect(env: AppEnv, effect: OutboxRow, now: Date): Promise<boolean> {
  const claimed = await env.DB.prepare(
    `UPDATE quickbooks_final_invoice_outbox
        SET state = 'attempting', attempt_count = attempt_count + 1, updated_at = ?
      WHERE effect_id = ? AND state = 'pending' AND attempt_count < 3`,
  ).bind(now.toISOString(), effect.effect_id).run();
  return changes(claimed) === 1;
}

async function deferUnclaimedEffect(
  env: AppEnv,
  effect: OutboxRow,
  detailCode: string,
  now: Date,
): Promise<void> {
  const nextAttemptAt = new Date(now.getTime() + SAFE_RETRY_DELAY_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE quickbooks_final_invoice_outbox
        SET next_attempt_at = ?, response_class = 'frappe_rejected', detail_code = ?, updated_at = ?
      WHERE effect_id = ? AND state = 'pending' AND attempt_count = ?`,
  ).bind(nextAttemptAt, detailCode, now.toISOString(), effect.effect_id, effect.attempt_count).run();
  if (changes(result) !== 1) throw new Error("quickbooks_effect_defer_conflict");
}

async function failUnclaimedEffect(
  env: AppEnv,
  effect: OutboxRow,
  detailCode: string,
  now: Date,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_final_invoice_outbox
        SET state = 'failed', response_class = 'invalid_response', detail_code = ?, updated_at = ?
      WHERE effect_id = ? AND state = 'pending' AND attempt_count = ?`,
  ).bind(detailCode, now.toISOString(), effect.effect_id, effect.attempt_count).run();
  if (changes(result) !== 1) throw new Error("quickbooks_effect_completion_conflict");
}

async function blockStaleSubmissionEffect(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  now: Date,
): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_intents
          SET state = 'blocked', error_code = 'quickbooks_candidate_changed',
              blocker_code = 'candidate_changed', blocker_next_step = 'refresh_candidate',
              version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND intent_id = ? AND state = 'submission_pending'
          AND provider_invoice_id IS NULL AND version = ?`,
    ).bind(now.toISOString(), row.tenant_id, row.intent_id, row.version),
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'failed', response_class = 'invalid_response',
              detail_code = 'quickbooks_candidate_changed', updated_at = ?
        WHERE effect_id = ? AND state = 'pending' AND attempt_count = ?`,
    ).bind(now.toISOString(), effect.effect_id, effect.attempt_count),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1)
    throw new Error("quickbooks_candidate_block_transition_conflict");
}

async function submitInvoice(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  if (effect.provider_request_id !== row.provider_request_id ||
      effect.provider_payload_sha256 !== row.provider_payload_sha256) {
    await finishEffect(env, effect, "failed", "invalid_response", null, "quickbooks_payload_conflict", now);
    await transitionIntent(env, row, "failed", "quickbooks_payload_conflict", now);
    return;
  }
  assertEffectLedgerReady(env);
  const universal = await submitInvoiceThroughRuntime(env, config, row, effect, fetcher, now);
    if (universal.state === "unknown") {
      await finishEffect(env, effect, "unknown", universal.responseClass, universal.responseStatus,
        universal.detailCode ?? "quickbooks_create_response_unknown", now, universal.tid);
      await transitionIntent(env, row, "reconciliation_required",
        universal.detailCode ?? "quickbooks_create_response_unknown", now,
        "provider_response_uncertain", "reconcile_provider_invoice");
      return;
    }
    if (universal.state === "failed") {
      const body = universal.value?.body ?? null;
      const providerIdentityConflict = qboFaultCode(body) === "600";
      const transient = !providerIdentityConflict && universal.responseStatus !== null &&
        (universal.responseStatus === 408 || universal.responseStatus === 429 || universal.responseStatus >= 500);
      if (transient) {
        await retryOrFinishSubmit(env, row, effect, "http_rejected", universal.responseStatus,
          "quickbooks_create_response_unknown", now, universal.tid);
      } else {
        const detail = providerIdentityConflict
          ? "quickbooks_create_identity_conflict" : "quickbooks_create_rejected";
        await finishEffect(env, effect, "failed", "http_rejected", universal.responseStatus, detail, now, universal.tid);
        await transitionIntent(env, row, providerIdentityConflict ? "reconciliation_required" : "failed", detail, now,
          providerIdentityConflict ? "provider_response_uncertain" : null,
          providerIdentityConflict ? "reconcile_provider_invoice" : null);
      }
      return;
    }
    const invoice = universal.value?.invoice;
    if (!invoice) {
      await retryOrFinishSubmit(env, row, effect, "invalid_response", universal.responseStatus,
        "quickbooks_create_response_invalid", now, universal.tid);
      return;
    }
    const observationHash = await sha256Hex(invoice.hashSource);
  await completeSubmitEffect(env, row, effect, invoice.Id, observationHash,
    universal.responseStatus ?? 200, universal.tid, now);
}

interface QuickBooksSubmitValue {
  body: unknown;
  invoice: { Id: string; hashSource: string } | null;
  tid?: string | null;
  responseStatus?: number | null;
}

interface QuickBooksUniversalSubmitResult {
  state: "succeeded" | "failed" | "unknown";
  responseClass: "accepted" | "http_rejected" | "network_unknown" | "invalid_response";
  responseStatus: number | null;
  detailCode: string | null;
  tid: string | null;
  value?: QuickBooksSubmitValue;
}

async function submitInvoiceThroughRuntime(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<QuickBooksUniversalSubmitResult> {
  const tenantId = row.tenant_id;
  const request = {
    realm_id: row.realm_id,
    provider_request_id: row.provider_request_id,
    provider_payload_sha256: row.provider_payload_sha256,
    provider_payload_json: row.provider_payload_json,
  };
  const requestHash = await sha256Hex(canonicalEffectJson(request));
  const idempotencyKey = `quickbooks:invoice:${row.provider_request_id}:${row.provider_payload_sha256}`;
  const deadlineAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const actorId = row.approved_by_user_id ?? "quickbooks-adapter";
  const actorType = row.approved_by_user_id ? "owner" as const : "agent" as const;
  const approvalRef = row.approval_idempotency_sha256 ?? effect.idempotency_key_sha256;
  const result = await runExternalEffect<QuickBooksSubmitValue>(env, {
    tenantId,
    actor: { type: actorType, id: actorId },
    taskId: `quickbooks:${row.intent_id}:submit`,
    authority: {
      permitRef: `quickbooks:approval:${approvalRef}`,
      policyRef: "quickbooks.final_invoice.submit",
      policyVersion: "v1",
      tenantId,
      actorType,
      actorId,
      expiresAt: deadlineAt,
      allowedActions: ["accounting.invoice.submit"],
      maxAttempts: 1,
      amount: Number(row.final_balance),
      maxAmount: Number(row.final_balance),
    },
    aggregate: { type: "quickbooks_final_invoice", id: row.intent_id, version: row.version },
    intentId: row.intent_id,
    action: "accounting.invoice.submit",
    request,
    requestHash,
    provider: "quickbooks",
    providerAccountRef: row.realm_id,
    idempotencyKey,
    deadlineAt,
    expectedReadback: {},
    retryLimit: 0,
    compensationPlan: {},
    correlationId: effect.effect_id,
  }, {
    async dispatch() {
      const access = await accessToken(env, config, row.tenant_id, fetcher, now);
      const url = `${providerBase(config)}/v3/company/${encodeURIComponent(row.realm_id)}/invoice?minorversion=${config.minorVersion}&requestid=${encodeURIComponent(row.provider_request_id)}`;
      const response = await timedFetch(fetcher, url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        body: row.provider_payload_json,
      }, config.timeoutMs);
      const tid = safeTid(response.headers.get("intuit_tid"));
      const body = await boundedJson(response).catch(() => null);
      if (!response.ok) {
        return {
          outcome: "rejected" as const,
          value: { body, invoice: null, tid, responseStatus: response.status },
          providerResponse: body,
          detailCode: "quickbooks_create_rejected",
        };
      }
      const invoice = createInvoiceIdentity(body, row.final_balance);
      if (!invoice) {
        return {
          outcome: "unknown" as const,
          value: { body, invoice: null, tid, responseStatus: response.status },
          providerResponse: body,
          detailCode: "quickbooks_create_response_invalid",
        };
      }
      return {
        outcome: "accepted" as const,
        value: { body, invoice, tid, responseStatus: response.status },
        providerExternalId: invoice.Id,
        providerResponse: body,
      };
    },
    async readback({ providerExternalId }) {
      if (!providerExternalId) return { status: "unavailable" as const, detailCode: "quickbooks_provider_invoice_missing" };
      try {
        const access = await accessToken(env, config, row.tenant_id, fetcher, now);
        const response = await timedFetch(fetcher,
          `${providerBase(config)}/v3/company/${encodeURIComponent(row.realm_id)}/invoice/${encodeURIComponent(providerExternalId)}?minorversion=${config.minorVersion}`,
          { method: "GET", redirect: "manual", headers: { Accept: "application/json", Authorization: `Bearer ${access}` } },
          config.timeoutMs);
        if (response.status === 404) return { status: "not_found" as const, detailCode: "quickbooks_provider_invoice_missing" };
        if (!response.ok) return { status: "unavailable" as const, detailCode: `quickbooks_readback_${response.status}` };
        const value = await boundedJson(response).catch(() => null);
        const normalized = normalizeReadback(value);
        if (!normalized) return { status: "conflict" as const, observed: value, detailCode: "quickbooks_readback_unverified" };
        const expected = expectedReadback({ ...row, provider_invoice_id: providerExternalId });
        if (canonicalJson(normalized.compare) !== canonicalJson(expected)) {
          return { status: "conflict" as const, observed: normalized.compare, detailCode: "quickbooks_readback_drift" };
        }
        return { status: "match" as const, providerExternalId, observed: normalized.compare };
      } catch {
        return { status: "unavailable" as const, detailCode: "quickbooks_readback_unknown" };
      }
    },
    async replay({ effect }) {
      if (!effect.provider_external_id) throw new Error("quickbooks_replay_provider_invoice_missing");
      try {
        const access = await accessToken(env, config, row.tenant_id, fetcher, now);
        const response = await timedFetch(fetcher,
          `${providerBase(config)}/v3/company/${encodeURIComponent(row.realm_id)}/invoice/${encodeURIComponent(effect.provider_external_id)}?minorversion=${config.minorVersion}`,
          { method: "GET", redirect: "manual", headers: { Accept: "application/json", Authorization: `Bearer ${access}` } },
          config.timeoutMs);
        if (!response.ok) throw new Error(`quickbooks_replay_readback_${response.status}`);
        const body = await boundedJson(response);
        const normalized = normalizeReadback(body);
        const expected = expectedReadback({ ...row, provider_invoice_id: effect.provider_external_id });
        if (!normalized || canonicalJson(normalized.compare) !== canonicalJson(expected)) {
          throw new Error("quickbooks_replay_readback_drift");
        }
        const invoice = createInvoiceIdentity(body, row.final_balance);
        if (!invoice) throw new Error("quickbooks_replay_invoice_invalid");
        return {
          body,
          invoice,
          tid: safeTid(response.headers.get("intuit_tid")),
          responseStatus: response.status,
        };
      } catch {
        throw new Error("quickbooks_replay_readback_failed");
      }
    },
  }, now);
  const value = result.value as QuickBooksSubmitValue | undefined;
  if (result.effect.state === "succeeded") {
    return { state: "succeeded", responseClass: "accepted", responseStatus: value?.responseStatus ?? 200, detailCode: null, tid: value?.tid ?? null, value };
  }
  if (result.effect.state === "failed") {
    return { state: "failed", responseClass: "http_rejected", responseStatus: value?.responseStatus ?? null, detailCode: result.effect.result_code, tid: value?.tid ?? null, value };
  }
  return { state: "unknown", responseClass: "network_unknown", responseStatus: value?.responseStatus ?? null, detailCode: result.effect.result_code, tid: value?.tid ?? null, value };
}

async function retryOrFinishSubmit(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  responseClass: string,
  responseStatus: number | null,
  detailCode: string,
  now: Date,
  tid: string | null = null,
): Promise<void> {
  if (await retrySafeEffect(env, effect, responseClass, responseStatus, detailCode, now, tid)) return;
  await finishEffect(env, effect, "unknown", responseClass, responseStatus, detailCode, now, tid);
  await transitionIntent(env, row, "reconciliation_required", detailCode, now,
    "provider_response_uncertain", "reconcile_provider_invoice");
}

async function completeSubmitEffect(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  providerInvoiceId: string,
  observationHash: string,
  responseStatus: number,
  tid: string | null,
  now: Date,
): Promise<void> {
  const bind = await systemEffectValues(row, "bind", `bind:${providerInvoiceId}`, now);
  let results: unknown[] = [];
  try { results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_intents
          SET state = 'submitted', provider_invoice_id = ?, provider_invoice_sha256 = ?,
              provider_submitted_at = ?, error_code = NULL, blocker_code = NULL,
              blocker_next_step = NULL, version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND intent_id = ? AND state = 'submission_pending' AND version = ?`,
    ).bind(providerInvoiceId, observationHash, now.toISOString(), now.toISOString(),
      row.tenant_id, row.intent_id, row.version),
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'succeeded', response_class = 'accepted', response_status = ?,
              detail_code = NULL, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ?`,
    ).bind(responseStatus, now.toISOString(), effect.effect_id, effect.attempt_count + 1),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, intuit_tid, provider_invoice_id,
         provider_observation_sha256, occurred_at
       ) VALUES (?, ?, ?, 'submit', ?, 'finished', ?, ?, ?, 'accepted', ?, ?, ?, ?, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.attempt_count + 1,
      effect.request_fingerprint_sha256, effect.provider_request_id,
      effect.provider_payload_sha256, responseStatus, tid, providerInvoiceId,
      observationHash, now.toISOString()),
    systemEffectInsert(env, bind),
  ]); } catch { /* A commit acknowledgement can be lost; exact readback below is authoritative. */ }
  const current = await getQuickBooksFinalInvoice(env, row.tenant_id, row.intent_id);
  const receipt = await env.DB.prepare(
    `SELECT state FROM quickbooks_final_invoice_outbox WHERE effect_id = ? LIMIT 1`,
  ).bind(effect.effect_id).first<{ state: string }>();
  if ((changes(results[0]) === 1 && changes(results[1]) === 1 || receipt?.state === "succeeded") &&
      current?.provider_invoice_id === providerInvoiceId &&
      current.provider_invoice_sha256 === observationHash && receipt?.state === "succeeded" &&
      await exactSystemEffectExists(env, bind)) return;
  throw new Error("quickbooks_submit_receipt_conflict");
}

async function bindInvoice(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  if (!row.provider_invoice_id || !row.provider_submitted_at) {
    await finishEffect(env, effect, "failed", "invalid_response", null, "quickbooks_bind_identity_missing", now);
    return;
  }
  try {
    const response = await frappeMutationCall(env, config, "bind_provider_invoice", {
      binding_json: JSON.stringify(bindingPayload(row)),
    }, fetcher, now);
    const message = unwrapMessage(response);
    if (!validBindResponse(message, row)) throw new Error("quickbooks_bind_invalid_response");
    await completeEffectWithSuccessor(
      env, row, effect, "frappe_accepted", 200, now,
      "readback", `readback:${row.provider_invoice_id}`,
    );
  } catch (error) {
    if (error instanceof EffectRuntimeError && error.code === "effect_unknown_requires_reconciliation") {
      await finishEffect(env, effect, "unknown", "network_error", null, "quickbooks_frappe_bind_unknown", now);
      await transitionIntent(env, row, "reconciliation_required", "quickbooks_frappe_bind_unknown", now,
        "frappe_bind_pending", "retry_frappe_projection");
      return;
    }
    const retrying = await retrySafeEffect(env, effect, "frappe_rejected", null,
      "quickbooks_frappe_bind_pending", now);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_frappe_bind_pending", now,
      "frappe_bind_pending", "retry_frappe_projection");
    if (!retrying)
      await finishEffect(env, effect, "failed", "frappe_rejected", null,
        "quickbooks_frappe_bind_pending", now);
  }
}

async function readbackInvoice(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  if (!row.provider_invoice_id) {
    await finishEffect(env, effect, "failed", "missing", null, "quickbooks_provider_invoice_missing", now);
    return;
  }
  let response: Response;
  try {
    const access = await accessToken(env, config, row.tenant_id, fetcher, now);
    const url = `${providerBase(config)}/v3/company/${encodeURIComponent(row.realm_id)}/invoice/${encodeURIComponent(row.provider_invoice_id)}?minorversion=${config.minorVersion}`;
    response = await timedFetch(fetcher, url, {
      method: "GET", redirect: "manual",
      headers: { Accept: "application/json", Authorization: `Bearer ${access}` },
    }, config.timeoutMs);
  } catch {
    await recordObservation(env, row, "ambiguous", null, null, now);
    const retrying = await retrySafeEffect(env, effect, "network_unknown", null,
      "quickbooks_readback_unknown", now);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_readback_unknown", now,
      "provider_response_uncertain", "reconcile_provider_invoice");
    if (!retrying)
      await finishEffect(env, effect, "failed", "network_unknown", null,
        "quickbooks_readback_unknown", now);
    return;
  }
  const tid = safeTid(response.headers.get("intuit_tid"));
  if (response.status === 404) {
    await recordObservation(env, row, "missing", null, tid, now);
    await finishEffect(env, effect, "failed", "missing", 404, "quickbooks_provider_invoice_missing", now, tid);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_provider_invoice_missing", now,
      "provider_invoice_missing", "reconcile_provider_invoice");
    return;
  }
  if (!response.ok) {
    await recordObservation(env, row, "ambiguous", null, tid, now);
    const transient = response.status === 408 || response.status === 429 || response.status >= 500;
    const retrying = transient && await retrySafeEffect(env, effect, "http_rejected",
      response.status, "quickbooks_readback_rejected", now, tid);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_readback_rejected", now,
      "provider_response_uncertain", "reconcile_provider_invoice");
    if (!retrying)
      await finishEffect(env, effect, "failed", "http_rejected", response.status,
        "quickbooks_readback_rejected", now, tid);
    return;
  }
  const body = await boundedJson(response).catch(() => null);
  const normalized = normalizeReadback(body);
  const expected = expectedReadback(row);
  const exact = !!normalized && canonicalJson(normalized.compare) === canonicalJson(expected);
  if (normalized) {
    normalized.resolve.lines_sha256 = await sha256Hex(
      string(normalized.compare.lines_sha256_source),
    );
  }
  const normalizedHash = normalized ? await sha256Hex(canonicalJson(normalized.compare)) : null;
  const voided = normalized?.resolve.payment_status === "Voided";
  const verified = !!exact && !voided;
  if (!exact || !normalized || voided) {
    await recordObservation(env, row, "drift", normalizedHash, tid, now,
      normalized ? string(normalized.resolve.balance_due) : null,
      normalized ? paymentStatus(normalized.resolve.payment_status) : null);
    await finishEffect(env, effect, "failed", "drift", response.status,
      "quickbooks_readback_drift", now, tid, row.provider_invoice_id, normalizedHash);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_readback_drift", now,
      "provider_readback_drift", "reconcile_provider_invoice");
    return;
  }
  const factsJson = canonicalJson(normalized.resolve);
  const factsHash = await sha256Hex(factsJson);
  const readbackHash = await sha256Hex(normalized.invoiceHashSource);
  await completeReadbackEffect(
    env, row, effect, normalized, normalizedHash!, readbackHash, factsJson, factsHash,
    response.status, tid, now,
  );
}

async function resolveInvoice(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  const observation = await env.DB.prepare(
    `SELECT observation_id, provider_invoice_id, provider_readback_sha256,
            provider_facts_sha256, facts_json, balance_due, payment_status, checked_at
       FROM quickbooks_final_invoice_observations
      WHERE tenant_id = ? AND intent_id = ? AND outcome_code = 'exact_match'
        AND provider_readback_sha256 = ?
      ORDER BY checked_at ASC, observation_id ASC LIMIT 1`,
  ).bind(row.tenant_id, row.intent_id, effect.request_fingerprint_sha256)
    .first<ReadbackObservationRow>();
  if (!observation || observation.provider_invoice_id !== row.provider_invoice_id) {
    await finishEffect(env, effect, "failed", "invalid_response", null,
      "quickbooks_resolve_observation_missing", now);
    await transitionIntent(env, row, "reconciliation_required",
      "quickbooks_resolve_observation_missing", now,
      "frappe_resolver_pending", "retry_frappe_projection");
    return;
  }
  await resolvePersistedObservation(env, config, row, effect, observation, fetcher, now);
}

async function resolvePersistedObservation(
  env: AppEnv,
  config: Config,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  observation: ReadbackObservationRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  const facts = record(JSON.parse(observation.facts_json) as unknown);
  if (!facts || await sha256Hex(canonicalJson(facts)) !== observation.provider_facts_sha256 ||
      paymentStatus(facts.payment_status) !== observation.payment_status ||
      facts.balance_due !== observation.balance_due) {
    await finishEffect(env, effect, "failed", "invalid_response", null,
      "quickbooks_resolve_observation_invalid", now);
    return;
  }
  const readback = {
    ...bindingPayload(row),
    provider_readback_sha256: observation.provider_readback_sha256,
    provider_facts_sha256: observation.provider_facts_sha256,
    provider_read_at: observation.checked_at,
    ...facts,
  };
  let message: unknown;
  try {
    message = unwrapMessage(await frappeMutationCall(env, config, "resolve_provider_invoice_readback", {
      readback_json: JSON.stringify(readback),
    }, fetcher, now));
  } catch (error) {
    if (error instanceof EffectRuntimeError && error.code === "effect_unknown_requires_reconciliation") {
      await finishEffect(env, effect, "unknown", "network_error", null, "quickbooks_resolver_unknown", now);
      await transitionIntent(env, row, "reconciliation_required", "quickbooks_resolver_unknown", now,
        "frappe_resolver_pending", "retry_frappe_projection");
      return;
    }
    const retrying = await retrySafeEffect(env, effect, "frappe_rejected", null,
      "quickbooks_resolver_pending", now);
    await transitionIntent(env, row, "reconciliation_required", "quickbooks_resolver_pending", now,
      "frappe_resolver_pending", "retry_frappe_projection");
    if (!retrying)
      await finishEffect(env, effect, "failed", "frappe_rejected", null,
        "quickbooks_resolver_pending", now);
    return;
  }
  if (!validResolverResponse(message)) {
    const retrying = await retrySafeEffect(env, effect, "invalid_response", 200,
      "quickbooks_resolver_invalid_response", now);
    await transitionIntent(env, row, "reconciliation_required",
      "quickbooks_resolver_invalid_response", now,
      "frappe_resolver_pending", "retry_frappe_projection");
    if (!retrying)
      await finishEffect(env, effect, "failed", "invalid_response", 200,
        "quickbooks_resolver_invalid_response", now);
    return;
  }
  if (message.outcome !== "Matched") {
    const detail = message.outcome === "Mismatch"
      ? "quickbooks_resolver_mismatch" : "quickbooks_resolver_pending";
    const retrying = message.outcome === "Pending" &&
      await retrySafeEffect(env, effect, "frappe_rejected", 200, detail, now);
    await transitionIntent(env, row, "reconciliation_required",
      detail, now,
      message.outcome === "Mismatch" ? "provider_readback_drift" : "frappe_resolver_pending",
      message.outcome === "Mismatch" ? "reconcile_provider_invoice" : "retry_frappe_projection");
    if (!retrying)
      await finishEffect(env, effect, "failed", "frappe_rejected", 200, detail, now);
    return;
  }
  await completeResolveEffect(env, row, effect, now);
}

async function completeResolveEffect(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  now: Date,
): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_intents
          SET state = 'matched', provider_matched_at = ?, error_code = NULL,
              blocker_code = NULL, blocker_next_step = NULL,
              version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND intent_id = ? AND state IN ('submitted','reconciliation_required')
          AND provider_invoice_id = ? AND version = ?`,
    ).bind(now.toISOString(), now.toISOString(), row.tenant_id, row.intent_id,
      row.provider_invoice_id, row.version),
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'succeeded', response_class = 'frappe_accepted', response_status = 200,
              detail_code = NULL, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ?`,
    ).bind(now.toISOString(), effect.effect_id, effect.attempt_count + 1),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, occurred_at
       ) VALUES (?, ?, ?, 'resolve', ?, 'finished', ?, ?, ?, 'frappe_accepted', 200, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.attempt_count + 1,
      effect.request_fingerprint_sha256, effect.provider_request_id,
      effect.provider_payload_sha256, now.toISOString()),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1)
    throw new Error("quickbooks_resolve_receipt_conflict");
}

async function repairSuccessorEffects(env: AppEnv, now: Date): Promise<void> {
  const submitted = await env.DB.prepare(
    `SELECT i.* FROM quickbooks_final_invoice_intents i
      WHERE i.state IN ('submitted','reconciliation_required')
        AND i.provider_invoice_id IS NOT NULL AND i.provider_submitted_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM quickbooks_final_invoice_outbox o
           WHERE o.tenant_id = i.tenant_id AND o.intent_id = i.intent_id AND o.operation = 'bind'
        )
      ORDER BY i.updated_at ASC LIMIT ?`,
  ).bind(RECOVERY_LIMIT).all<FinalInvoiceRow>();
  for (const row of submitted.results ?? [])
    await enqueueSystemEffect(env, row, "bind", `bind:${row.provider_invoice_id}`, now);

  const bound = await env.DB.prepare(
    `SELECT i.* FROM quickbooks_final_invoice_intents i
      WHERE i.provider_invoice_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM quickbooks_final_invoice_outbox o
           WHERE o.tenant_id = i.tenant_id AND o.intent_id = i.intent_id
             AND o.operation = 'bind' AND o.state = 'succeeded'
        )
        AND NOT EXISTS (
          SELECT 1 FROM quickbooks_final_invoice_outbox o
           WHERE o.tenant_id = i.tenant_id AND o.intent_id = i.intent_id AND o.operation = 'readback'
        )
      ORDER BY i.updated_at ASC LIMIT ?`,
  ).bind(RECOVERY_LIMIT).all<FinalInvoiceRow>();
  for (const row of bound.results ?? [])
    await enqueueSystemEffect(env, row, "readback", `readback:${row.provider_invoice_id}`, now);

  const observations = await env.DB.prepare(
    `SELECT i.*, ob.provider_readback_sha256
       FROM quickbooks_final_invoice_intents i
       JOIN quickbooks_final_invoice_observations ob
         ON ob.tenant_id = i.tenant_id AND ob.intent_id = i.intent_id
        AND ob.provider_invoice_id = i.provider_invoice_id AND ob.outcome_code = 'exact_match'
      WHERE NOT EXISTS (
        SELECT 1 FROM quickbooks_final_invoice_outbox o
         WHERE o.tenant_id = i.tenant_id AND o.intent_id = i.intent_id
           AND o.operation = 'resolve'
           AND o.request_fingerprint_sha256 = ob.provider_readback_sha256
      )
      ORDER BY ob.checked_at ASC LIMIT ?`,
  ).bind(RECOVERY_LIMIT).all<FinalInvoiceRow & { provider_readback_sha256: string }>();
  for (const row of observations.results ?? [])
    await enqueueSystemEffect(env, row, "resolve",
      `resolve:${row.provider_invoice_id}:${row.provider_readback_sha256}`,
      now, undefined, row.provider_readback_sha256);
}

async function recoverStaleEffects(env: AppEnv, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_EFFECT_LEASE_MS).toISOString();
  const stale = await env.DB.prepare(
    `SELECT * FROM quickbooks_final_invoice_outbox
      WHERE state = 'attempting' AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ?`,
  ).bind(cutoff, RECOVERY_LIMIT).all<OutboxRow>();
  for (const effect of stale.results ?? []) {
    const retry = effect.attempt_count < 3;
    const terminalState = effect.operation === "submit" ? "unknown" : "failed";
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE quickbooks_final_invoice_outbox
            SET state = ?, next_attempt_at = ?, response_class = 'network_unknown',
                detail_code = 'quickbooks_worker_interrupted', updated_at = ?
          WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ? AND updated_at <= ?`,
      ).bind(retry ? "pending" : terminalState, retry ? now.toISOString() : null,
        now.toISOString(), effect.effect_id, effect.attempt_count, cutoff),
      env.DB.prepare(
        `INSERT INTO quickbooks_final_invoice_attempts (
           effect_id, tenant_id, intent_id, operation, attempt_number, phase,
           request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
           response_class, detail_code, occurred_at
         ) VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, 'network_unknown',
           'quickbooks_worker_interrupted', ?)`,
      ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.operation,
        effect.attempt_count, effect.request_fingerprint_sha256,
        effect.provider_request_id, effect.provider_payload_sha256, now.toISOString()),
    ]);
    if (changes(results[0]) !== 1) continue;
    if (!retry && effect.operation === "submit") {
      const row = await getQuickBooksFinalInvoice(env, effect.tenant_id, effect.intent_id);
      if (row?.state === "submission_pending")
        await transitionIntent(env, row, "reconciliation_required",
          "quickbooks_worker_interrupted", now,
          "provider_response_uncertain", "reconcile_provider_invoice");
    }
  }
}

interface SystemEffectValues {
  effectId: string;
  tenantId: string;
  intentId: string;
  operation: OutboxRow["operation"];
  keyHash: string;
  fingerprint: string;
  at: string;
}

async function systemEffectValues(
  row: FinalInvoiceRow,
  operation: OutboxRow["operation"],
  idempotency: string,
  now: Date,
  fingerprintOverride?: string,
): Promise<SystemEffectValues> {
  return {
    effectId: crypto.randomUUID(),
    tenantId: row.tenant_id,
    intentId: row.intent_id,
    operation,
    keyHash: await scopedHash(row.tenant_id, idempotency),
    fingerprint: fingerprintOverride ?? await sha256Hex(JSON.stringify({
      operation, intent_id: row.intent_id, provider_invoice_id: row.provider_invoice_id,
    })),
    at: now.toISOString(),
  };
}

function systemEffectInsert(env: AppEnv, value: SystemEffectValues): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO quickbooks_final_invoice_outbox (
       effect_id, tenant_id, intent_id, operation, idempotency_key_sha256,
       request_fingerprint_sha256, state, attempt_count, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).bind(value.effectId, value.tenantId, value.intentId, value.operation,
    value.keyHash, value.fingerprint, value.at, value.at, value.at);
}

async function exactSystemEffectExists(env: AppEnv, value: SystemEffectValues): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT intent_id, operation, request_fingerprint_sha256
       FROM quickbooks_final_invoice_outbox
      WHERE tenant_id = ? AND idempotency_key_sha256 = ? LIMIT 1`,
  ).bind(value.tenantId, value.keyHash).first<{
    intent_id: string;
    operation: string;
    request_fingerprint_sha256: string;
  }>();
  return existing?.intent_id === value.intentId && existing.operation === value.operation &&
    existing.request_fingerprint_sha256 === value.fingerprint;
}

async function completeEffectWithSuccessor(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  responseClass: "frappe_accepted",
  responseStatus: number,
  now: Date,
  successorOperation: OutboxRow["operation"],
  successorIdempotency: string,
): Promise<void> {
  const successor = await systemEffectValues(row, successorOperation, successorIdempotency, now);
  let results: unknown[] = [];
  try { results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'succeeded', response_class = ?, response_status = ?,
              detail_code = NULL, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ?`,
    ).bind(responseClass, responseStatus, now.toISOString(), effect.effect_id,
      effect.attempt_count + 1),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, occurred_at
       ) VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.operation,
      effect.attempt_count + 1, effect.request_fingerprint_sha256,
      effect.provider_request_id, effect.provider_payload_sha256, responseClass,
      responseStatus, now.toISOString()),
    systemEffectInsert(env, successor),
  ]); } catch { /* Read the exact durable outcome below. */ }
  const current = await env.DB.prepare(
    `SELECT state FROM quickbooks_final_invoice_outbox WHERE effect_id = ? LIMIT 1`,
  ).bind(effect.effect_id).first<{ state: string }>();
  if ((changes(results[0]) === 1 || current?.state === "succeeded") &&
      await exactSystemEffectExists(env, successor)) return;
  throw new Error("quickbooks_effect_successor_conflict");
}

async function completeReadbackEffect(
  env: AppEnv,
  row: FinalInvoiceRow,
  effect: OutboxRow,
  normalized: { compare: Record<string, unknown>; resolve: Record<string, unknown> },
  normalizedHash: string,
  readbackHash: string,
  factsJson: string,
  factsHash: string,
  responseStatus: number,
  tid: string | null,
  now: Date,
): Promise<void> {
  const successor = await systemEffectValues(
    row, "resolve", `resolve:${row.provider_invoice_id}:${readbackHash}`, now, readbackHash,
  );
  const observationId = crypto.randomUUID();
  let results: unknown[] = [];
  try { results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_observations (
         observation_id, tenant_id, intent_id, provider_invoice_id, normalized_sha256,
         provider_readback_sha256, provider_facts_sha256, facts_json, outcome_code,
         balance_due, payment_status, intuit_tid, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exact_match', ?, ?, ?, ?)`,
    ).bind(observationId, row.tenant_id, row.intent_id, row.provider_invoice_id,
      normalizedHash, readbackHash, factsHash, factsJson,
      string(normalized.resolve.balance_due), paymentStatus(normalized.resolve.payment_status),
      tid, now.toISOString()),
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'succeeded', response_class = 'exact_match', response_status = ?,
              detail_code = NULL, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ?`,
    ).bind(responseStatus, now.toISOString(), effect.effect_id, effect.attempt_count + 1),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, intuit_tid, provider_invoice_id,
         provider_observation_sha256, occurred_at
       ) VALUES (?, ?, ?, 'readback', ?, 'finished', ?, ?, ?, 'exact_match', ?, ?, ?, ?, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.attempt_count + 1,
      effect.request_fingerprint_sha256, effect.provider_request_id,
      effect.provider_payload_sha256, responseStatus, tid, row.provider_invoice_id,
      readbackHash, now.toISOString()),
    systemEffectInsert(env, successor),
  ]); } catch { /* Read the exact durable outcome below. */ }
  const current = await env.DB.prepare(
    `SELECT state FROM quickbooks_final_invoice_outbox WHERE effect_id = ? LIMIT 1`,
  ).bind(effect.effect_id).first<{ state: string }>();
  const observation = await env.DB.prepare(
    `SELECT 1 AS present FROM quickbooks_final_invoice_observations
      WHERE observation_id = ? AND provider_readback_sha256 = ?
        AND provider_facts_sha256 = ? LIMIT 1`,
  ).bind(observationId, readbackHash, factsHash).first<{ present: number }>();
  if ((changes(results[0]) === 1 && changes(results[1]) === 1 || current?.state === "succeeded") &&
      observation && await exactSystemEffectExists(env, successor)) return;
  throw new Error("quickbooks_readback_receipt_conflict");
}

async function enqueueSystemEffect(
  env: AppEnv,
  row: FinalInvoiceRow,
  operation: OutboxRow["operation"],
  idempotency: string,
  now: Date,
  payloadJson?: string,
  payloadHash?: string,
): Promise<void> {
  const values = await systemEffectValues(row, operation, idempotency, now, payloadHash);
  void payloadJson;
  try { await systemEffectInsert(env, values).run(); } catch { /* Verify exact replay below. */ }
  if (!await exactSystemEffectExists(env, values))
    throw new Error("quickbooks_effect_idempotency_conflict");
}

function bindingPayload(row: FinalInvoiceRow): Record<string, unknown> {
  return {
    intent_id: row.intent_id,
    basis_sha256: row.basis_sha256,
    completion_packet_id: row.completion_packet_id,
    completion_version: String(row.completion_version),
    completion_sha256: row.completion_sha256,
    customer_quote_id: row.customer_quote_id,
    quote_version: row.quote_version,
    quote_sha256: row.quote_sha256,
    changes_sha256: row.changes_sha256,
    roof_job_id: row.roof_job_id,
    shop_order_id: row.shop_order_id,
    realm_id: row.realm_id,
    provider_invoice_id: row.provider_invoice_id,
    provider_request_sha256: row.provider_payload_sha256,
    provider_create_response_sha256: row.provider_invoice_sha256,
    provider_created_at: row.provider_submitted_at,
  };
}

function expectedReadback(row: FinalInvoiceRow): Record<string, unknown> {
  const lines = parseLines(row.lines_json).map((line) => ({
    amount: line.amount,
    description_code: line.description_code,
    item_id: row.item_ref,
    tax_code_id: row.tax_code_ref,
  }));
  return {
    id: row.provider_invoice_id,
    customer_id: row.customer_ref,
    item_id: row.item_ref,
    tax_code_id: row.tax_code_ref,
    terms_id: row.terms_ref,
    currency: row.currency,
    subtotal: row.subtotal,
    tax_amount: row.tax_amount,
    total_amount: row.total_amount,
    tax_rate: row.tax_rate,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    lines_sha256_source: canonicalJson(lines),
  };
}

function normalizeReadback(value: unknown): {
  compare: Record<string, unknown>;
  resolve: Record<string, unknown>;
  invoiceHashSource: string;
} | null {
  const root = record(value);
  const invoice = record(root?.Invoice);
  if (!invoice || !QBO_ID.test(string(invoice.Id))) return null;
  const customer = refValue(invoice.CustomerRef);
  const currency = refValue(invoice.CurrencyRef);
  const terms = refValue(invoice.SalesTermRef);
  const dueDate = string(invoice.DueDate);
  const invoiceDate = string(invoice.TxnDate);
  const total = qboMoney(invoice.TotalAmt);
  const balance = qboMoney(invoice.Balance);
  const taxDetail = record(invoice.TxnTaxDetail);
  const tax = qboMoney(taxDetail?.TotalTax);
  const linesRaw = Array.isArray(invoice.Line) ? invoice.Line : null;
  if (!customer || currency !== "CAD" || !terms || !isoDate(invoiceDate) ||
      !isoDate(dueDate) || dueDate < invoiceDate ||
      !tax || !total || !balance || !linesRaw) return null;
  const lines: Array<{ amount: string; description_code: string; item_id: string; tax_code_id: string }> = [];
  let subtotalLine: string | null = null;
  for (const value of linesRaw) {
    const line = record(value);
    if (line?.DetailType === "SubTotalLineDetail") {
      const amount = qboMoney(line.Amount);
      if (!amount || subtotalLine !== null || !record(line.SubTotalLineDetail)) return null;
      subtotalLine = amount;
      continue;
    }
    const detail = record(line?.SalesItemLineDetail);
    const amount = qboMoney(line?.Amount);
    const description = qboDescriptionCode(string(line?.Description));
    const item = refValue(detail?.ItemRef);
    const taxCode = refValue(detail?.TaxCodeRef);
    if (line?.DetailType !== "SalesItemLineDetail" || !amount || !description || !item || !taxCode)
      return null;
    if (!description)
      return null;
    lines.push({ amount, description_code: description, item_id: item, tax_code_id: taxCode });
  }
  if (lines.length < 1) return null;
  const subtotal = moneyFromCents(lines.reduce((sum, line) => sum + cents(line.amount), 0));
  if (subtotalLine !== subtotal) return null;
  const itemIds = new Set(lines.map((line) => line.item_id));
  const taxCodes = new Set(lines.map((line) => line.tax_code_id));
  if (itemIds.size !== 1 || taxCodes.size !== 1) return null;
  const taxRate = extractTaxRate(taxDetail);
  const paymentStatus = Object.hasOwn(invoice, "invoiceStatus")
    ? normalizeInvoiceStatus(invoice.invoiceStatus)
    : balance === total ? "Unverified" : null;
  if (!taxRate || !paymentStatus) return null;
  const linesSource = canonicalJson(lines);
  return {
    compare: {
      id: string(invoice.Id), customer_id: customer, item_id: [...itemIds][0],
      tax_code_id: [...taxCodes][0], terms_id: terms, currency,
      subtotal, tax_amount: tax, total_amount: total,
      tax_rate: taxRate, invoice_date: invoiceDate, due_date: dueDate, lines_sha256_source: linesSource,
    },
    resolve: {
      customer_id: customer, item_id: [...itemIds][0], tax_code_id: [...taxCodes][0],
      terms_id: terms, currency, subtotal, tax_amount: tax, total_amount: total,
      balance_due: balance, lines_sha256: "", tax_rate: taxRate,
      invoice_date: invoiceDate, due_date: dueDate,
      payment_status: paymentStatus,
    },
    invoiceHashSource: canonicalJson(invoice),
  };
}

function extractTaxRate(taxDetail: Record<string, unknown> | null): string | null {
  const taxLines = Array.isArray(taxDetail?.TaxLine) ? taxDetail.TaxLine : [];
  const rates = new Set<string>();
  for (const raw of taxLines) {
    const line = record(raw);
    const detail = record(line?.TaxLineDetail);
    const rate = qboDecimal(detail?.TaxPercent);
    if (rate) rates.add(rate);
  }
  return rates.size === 1 ? [...rates][0]! : null;
}

function normalizeInvoiceStatus(value: unknown):
  PaymentStatus | null {
  if (typeof value !== "string") return null;
  if (value === "NOT_DUE") return "Not Due";
  if (["DUE_VIEWED", "DUE_NOT_SENT", "DUE_SENT"].includes(value)) return "Due";
  if (value.startsWith("OVERDUE_")) return "Overdue";
  if (value === "PARTIALLY_PAID") return "Partially Paid";
  if (value === "PAID_NOT_DEPOSITED" || value === "DEPOSITED") return "Paid";
  if (value === "VOIDED" || value === "REVERSED") return "Voided";
  return null;
}

function paymentStatus(value: unknown):
  PaymentStatus | null {
  return ["Not Due", "Due", "Partially Paid", "Paid", "Overdue", "Voided", "Unverified"].includes(string(value))
    ? value as PaymentStatus
    : null;
}

async function recordObservation(
  env: AppEnv,
  row: FinalInvoiceRow,
  outcome: "exact_match" | "drift" | "missing" | "ambiguous" | "invalid_response",
  hash: string | null,
  tid: string | null,
  now: Date,
  balanceDue: string | null = null,
  paymentState: PaymentStatus | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO quickbooks_final_invoice_observations (
       observation_id, tenant_id, intent_id, provider_invoice_id,
       normalized_sha256, outcome_code, balance_due, payment_status, intuit_tid, checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), row.tenant_id, row.intent_id, row.provider_invoice_id,
    hash, outcome, balanceDue, paymentState, tid, now.toISOString()).run();
}

async function transitionIntent(
  env: AppEnv,
  row: FinalInvoiceRow,
  state: QuickBooksFinalInvoiceState,
  errorCode: string,
  now: Date,
  blockerCode: QuickBooksBlockerCode | null = null,
  nextStep: QuickBooksNextStep | null = null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_final_invoice_intents
        SET state = ?, error_code = ?, blocker_code = ?, blocker_next_step = ?,
            version = version + 1, updated_at = ?
      WHERE tenant_id = ? AND intent_id = ? AND version = ?`,
  ).bind(state, errorCode, blockerCode, nextStep, now.toISOString(),
    row.tenant_id, row.intent_id, row.version).run();
  if (changes(result) !== 1) throw new Error("quickbooks_intent_transition_conflict");
}

async function blockChangedCandidate(env: AppEnv, row: FinalInvoiceRow, now: Date): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_final_invoice_intents
        SET state = 'blocked', error_code = 'quickbooks_candidate_changed',
            blocker_code = 'candidate_changed', blocker_next_step = 'refresh_candidate',
            version = version + 1, updated_at = ?
      WHERE tenant_id = ? AND intent_id = ? AND version = ?
        AND state IN ('pending_review','submission_pending')
        AND provider_invoice_id IS NULL`,
  ).bind(now.toISOString(), row.tenant_id, row.intent_id, row.version).run();
  if (changes(result) !== 1) throw new Error("quickbooks_candidate_block_transition_conflict");
}

async function finishEffect(
  env: AppEnv,
  effect: OutboxRow,
  state: "succeeded" | "failed" | "unknown",
  responseClass: string,
  responseStatus: number | null,
  detailCode: string | null,
  now: Date,
  tid: string | null = null,
  providerInvoiceId: string | null = null,
  observationHash: string | null = null,
): Promise<void> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = ?, response_class = ?, response_status = ?, detail_code = ?, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting'`,
    ).bind(state, responseClass, responseStatus, detailCode, now.toISOString(), effect.effect_id),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, intuit_tid, provider_invoice_id,
         provider_observation_sha256, detail_code, occurred_at
       ) VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.operation,
      effect.attempt_count + 1, effect.request_fingerprint_sha256,
      effect.provider_request_id, effect.provider_payload_sha256, responseClass,
      responseStatus, tid, providerInvoiceId, observationHash, detailCode, now.toISOString()),
  ]);
  if (changes(results[0]) !== 1) throw new Error("quickbooks_effect_completion_conflict");
}

async function retrySafeEffect(
  env: AppEnv,
  effect: OutboxRow,
  responseClass: string,
  responseStatus: number | null,
  detailCode: string,
  now: Date,
  tid: string | null = null,
): Promise<boolean> {
  if (effect.attempt_count + 1 >= 3) return false;
  const nextAttemptAt = new Date(
    now.getTime() + SAFE_RETRY_DELAY_MS * (effect.attempt_count + 1),
  ).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quickbooks_final_invoice_outbox
          SET state = 'pending', next_attempt_at = ?, response_class = ?,
              response_status = ?, detail_code = ?, updated_at = ?
        WHERE effect_id = ? AND state = 'attempting' AND attempt_count = ?`,
    ).bind(nextAttemptAt, responseClass, responseStatus, detailCode, now.toISOString(),
      effect.effect_id, effect.attempt_count + 1),
    env.DB.prepare(
      `INSERT INTO quickbooks_final_invoice_attempts (
         effect_id, tenant_id, intent_id, operation, attempt_number, phase,
         request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
         response_class, response_status, intuit_tid, detail_code, occurred_at
       ) VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(effect.effect_id, effect.tenant_id, effect.intent_id, effect.operation,
      effect.attempt_count + 1, effect.request_fingerprint_sha256,
      effect.provider_request_id, effect.provider_payload_sha256, responseClass,
      responseStatus, tid, detailCode, now.toISOString()),
  ]);
  if (changes(results[0]) !== 1) throw new Error("quickbooks_effect_retry_conflict");
  return true;
}

async function accessToken(
  env: AppEnv,
  config: Config,
  tenantId: string,
  fetcher: typeof fetch,
  now: Date,
): Promise<string> {
  let connection = await activeConnection(env, tenantId);
  if (!connection) throw new Error("quickbooks_connection_required");
  if (Date.parse(connection.access_expires_at) > now.getTime() + REFRESH_SKEW_MS) {
    try {
      return (await decryptBundle(config, connection)).access;
    } catch (error) {
      await markConnectionRefreshUncertain(env, connection, now, null);
      throw error;
    }
  }
  const leaseId = crypto.randomUUID();
  const leaseExpiry = new Date(now.getTime() + REFRESH_LEASE_MS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE quickbooks_connections
        SET refresh_lease_id = ?, refresh_lease_expires_at = ?, updated_at = ?
      WHERE connection_id = ? AND tenant_id = ? AND state = 'connected'
        AND bundle_version = ? AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= ?)`,
  ).bind(leaseId, leaseExpiry, now.toISOString(), connection.connection_id,
    tenantId, connection.bundle_version, now.toISOString()).run();
  if (changes(claimed) !== 1) {
    connection = await activeConnection(env, tenantId);
    if (!connection || Date.parse(connection.access_expires_at) <= now.getTime())
      throw new Error("quickbooks_refresh_in_progress");
    return (await decryptBundle(config, connection)).access;
  }
  try {
    const previous = await decryptBundle(config, connection);
    const token = await exchangeToken(config, { grant_type: "refresh_token", refresh_token: previous.refresh }, fetcher);
    const nextVersion = connection.bundle_version + 1;
    const encrypted = await encryptBundle(config, tenantId, connection.connection_id, nextVersion, token.bundle);
    const updated = await env.DB.prepare(
      `UPDATE quickbooks_connections
          SET encrypted_bundle_b64 = ?, bundle_iv_b64 = ?, encryption_key_version = ?,
              bundle_version = ?, access_expires_at = ?, refresh_expires_at = ?,
              refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = ?
        WHERE connection_id = ? AND tenant_id = ? AND state = 'connected'
          AND bundle_version = ? AND refresh_lease_id = ?`,
    ).bind(encrypted.ciphertext, encrypted.iv, config.encryptionKeyVersion, nextVersion,
      new Date(now.getTime() + token.accessExpiresIn * 1_000).toISOString(),
      token.refreshExpiresIn === null ? connection.refresh_expires_at :
        new Date(now.getTime() + token.refreshExpiresIn * 1_000).toISOString(),
      now.toISOString(), connection.connection_id, tenantId, connection.bundle_version, leaseId).run();
    if (changes(updated) !== 1) throw new Error("quickbooks_refresh_cas_lost");
    return token.bundle.access;
  } catch (error) {
    await markConnectionRefreshUncertain(env, connection, now, leaseId);
    throw error;
  }
}

async function markConnectionRefreshUncertain(
  env: AppEnv,
  connection: ConnectionRow,
  now: Date,
  leaseId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE quickbooks_connections
        SET state = 'reconciliation_required', refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL, updated_at = ?
      WHERE connection_id = ? AND tenant_id = ? AND state = 'connected'
        AND bundle_version = ? AND refresh_lease_id IS ?`,
  ).bind(now.toISOString(), connection.connection_id, connection.tenant_id,
    connection.bundle_version, leaseId).run();
  if (changes(result) === 1) return;
  const current = await env.DB.prepare(
    `SELECT state FROM quickbooks_connections
      WHERE connection_id = ? AND tenant_id = ? LIMIT 1`,
  ).bind(connection.connection_id, connection.tenant_id).first<{ state: string }>();
  if (current?.state !== "reconciliation_required" && current?.state !== "revoked")
    throw new Error("quickbooks_refresh_uncertainty_receipt_conflict");
}

async function exchangeToken(
  config: Config,
  values: Record<string, string>,
  fetcher: typeof fetch,
): Promise<{ bundle: TokenBundle; accessExpiresIn: number; refreshExpiresIn: number | null }> {
  const response = await timedFetch(fetcher, QUICKBOOKS_TOKEN_URL, {
    method: "POST", redirect: "manual",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${base64Utf8(`${config.clientId}:${config.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
  }, config.timeoutMs);
  if (!response.ok) throw new QuickBooksTokenExchangeRejected("quickbooks_token_exchange_rejected");
  const body = record(await boundedJson(response));
  const access = secretText(body?.access_token, 1, 8192);
  const refresh = secretText(body?.refresh_token, 1, 8192);
  const tokenType = string(body?.token_type);
  const accessExpiresIn = seconds(body?.expires_in, 60, 86_400);
  const refreshExpiresIn = body?.x_refresh_token_expires_in === undefined
    ? null : seconds(body.x_refresh_token_expires_in, 60, 20_000_000);
  if (!access || !refresh || tokenType?.toLowerCase() !== "bearer" || !accessExpiresIn ||
      (body?.x_refresh_token_expires_in !== undefined && !refreshExpiresIn))
    throw new Error("quickbooks_token_exchange_invalid");
  return { bundle: { access, refresh }, accessExpiresIn, refreshExpiresIn };
}

async function encryptBundle(
  config: Config,
  tenantId: string,
  connectionId: string,
  version: number,
  bundle: TokenBundle,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey("raw", config.encryptionKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv,
    additionalData: utf8(`${tenantId}\n${connectionId}\n${version}`),
  }, key, utf8(canonicalJson(bundle)));
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

async function decryptBundle(config: Config, row: ConnectionRow): Promise<TokenBundle> {
  if (row.encryption_key_version !== config.encryptionKeyVersion)
    throw new Error("quickbooks_encryption_key_version_unavailable");
  const key = await crypto.subtle.importKey("raw", config.encryptionKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: fromBase64Url(row.bundle_iv_b64),
    additionalData: utf8(`${row.tenant_id}\n${row.connection_id}\n${row.bundle_version}`),
  }, key, fromBase64Url(row.encrypted_bundle_b64));
  const value = record(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
  const access = secretText(value?.access, 1, 8192);
  const refresh = secretText(value?.refresh, 1, 8192);
  if (!access || !refresh) throw new Error("quickbooks_encrypted_bundle_invalid");
  return { access, refresh };
}

function configuration(env: AppEnv, requireFrappe: boolean): Config | null {
  const q = env as QuickBooksEnv;
  const tenantId = text(q.APP_TENANT_ID, 2, 64);
  const publicOrigin = configuredPublicOrigin(env);
  const environment = q.QB_API_ENVIRONMENT === "sandbox" || q.QB_API_ENVIRONMENT === "production"
    ? q.QB_API_ENVIRONMENT : null;
  const minorVersion = Number(q.QB_API_MINOR_VERSION);
  const clientId = secretText(q.QB_CLIENT_ID, 1, 256);
  const clientSecret = secretText(q.QB_CLIENT_SECRET, 1, 512);
  const encryptionKey = decodeKey(q.QB_TOKEN_ENCRYPTION_KEY);
  const encryptionKeyVersion = text(q.QB_TOKEN_ENCRYPTION_KEY_VERSION, 1, 32);
  const expectedRealmId = q.QB_EXPECTED_REALM_ID?.trim() || null;
  const frappeBaseUrl = httpsBase(q.ERPNEXT_BASE_URL);
  const frappeApiKey = secretText(q.QB_FINAL_INVOICE_FRAPPE_API_KEY, 1, 256);
  const frappeApiSecret = secretText(q.QB_FINAL_INVOICE_FRAPPE_API_SECRET, 1, 512);
  if (!tenantId || !publicOrigin || !environment || !Number.isInteger(minorVersion) || minorVersion < 75 ||
      minorVersion > 999 || !clientId || !clientSecret || !encryptionKey || !encryptionKeyVersion ||
      (expectedRealmId !== null && !QBO_ID.test(expectedRealmId)) ||
      (requireFrappe && (!frappeBaseUrl || !frappeApiKey || !frappeApiSecret))) return null;
  const timeoutMs = boundedNumber(q.QB_API_TIMEOUT_MS, 10_000, 1_000, 20_000);
  return {
    tenantId, publicOrigin, redirectUri: `${publicOrigin}${QUICKBOOKS_CALLBACK_PATH}`,
    environment, minorVersion, clientId, clientSecret, encryptionKey,
    encryptionKeyVersion, expectedRealmId, frappeBaseUrl: frappeBaseUrl ?? "",
    frappeApiKey: frappeApiKey ?? "", frappeApiSecret: frappeApiSecret ?? "", timeoutMs,
  };
}

function oauthConfigurationReady(env: AppEnv): boolean {
  return quickBooksOAuthEnabled(env) && configuration(env, false) !== null;
}

function invoiceConfigurationReady(env: AppEnv): boolean {
  return quickBooksFinalInvoiceEnabled(env) && configuration(env, true) !== null;
}

function configuredPublicOrigin(env: AppEnv): string | null {
  try {
    const url = new URL(env.APP_PUBLIC_ORIGIN ?? "");
    const local = (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      String(env.APP_ALLOW_INSECURE_LOCAL ?? "") === "true";
    if ((!local && url.protocol !== "https:") || (local && !["http:", "https:"].includes(url.protocol)) ||
        url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
        (!local && !!url.port)) return null;
    return url.origin;
  } catch { return null; }
}

async function frappeMutationCall(
  env: AppEnv,
  config: Config,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  now: Date,
): Promise<unknown> {
  assertEffectLedgerReady(env);
  const tenantId = env.APP_TENANT_ID ?? "ironwrap";
  const request = { method, body };
  const requestHash = await sha256Hex(canonicalEffectJson(request));
  const idempotencyKey = `quickbooks:frappe:${method}:${requestHash}`;
  const deadlineAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const expectedReadback = {
    material_sha256: await sha256Hex(canonicalEffectJson(quickBooksProjectionExpected(body))),
  };
  const result = await runExternalEffect(env, {
    tenantId,
    actor: { type: "agent", id: "quickbooks-frappe-adapter" },
    taskId: `quickbooks:frappe:${method}`,
    authority: {
      permitRef: `quickbooks:projection:${method}`,
      policyRef: `quickbooks.frappe.${method}`,
      policyVersion: "v1",
      tenantId,
      actorType: "agent",
      actorId: "quickbooks-frappe-adapter",
      expiresAt: deadlineAt,
      allowedActions: [`quickbooks.frappe.${method}`],
      maxAttempts: 1,
    },
    aggregate: { type: "quickbooks_frappe_projection", id: requestHash.slice(0, 32), version: 0 },
    intentId: idempotencyKey,
    action: `quickbooks.frappe.${method}`,
    request,
    requestHash,
    provider: "frappe",
    idempotencyKey,
    deadlineAt,
    expectedReadback,
    retryLimit: 0,
    compensationPlan: {},
    correlationId: idempotencyKey,
  }, {
    async dispatch() {
      const value = await frappeCall(config, method, body, fetcher);
      const message = record(unwrapMessage(value));
      const providerExternalId = typeof message?.reconciliation_id === "string"
        ? message.reconciliation_id
        : typeof message?.payment_milestone_id === "string"
          ? message.payment_milestone_id
          : null;
      return { outcome: "accepted" as const, value, providerExternalId, providerResponse: value };
    },
    async readback({ providerExternalId }) {
      return await frappeProjectionReadback(config, method, body, providerExternalId, fetcher);
    },
    async replay({ effect }) {
      const readback = await frappeProjectionReadback(config, method, body, effect.provider_external_id, fetcher);
      if (readback.status !== "match" || !readback.observed || typeof readback.observed !== "object") {
        throw new Error(readback.detailCode ?? "quickbooks_frappe_replay_failed");
      }
      const observed = readback.observed as Record<string, unknown>;
      const expected = quickBooksProjectionExpected(body);
      const reconciliationId = effect.provider_external_id;
      const paymentMilestoneId = typeof observed.payment_milestone_id === "string"
        ? observed.payment_milestone_id
        : null;
      if (!reconciliationId || !paymentMilestoneId) throw new Error("quickbooks_frappe_replay_shape_invalid");
      if (method === "bind_provider_invoice") {
        return {
          message: {
            ok: true,
            idempotent_replay: true,
            roof_job_id: expected.roof_job_id,
            shop_order_id: expected.shop_order_id,
            provider_invoice_id: expected.provider_invoice_id,
            payment_milestone_id: paymentMilestoneId,
            reconciliation_id: reconciliationId,
            basis_sha256: expected.basis_sha256,
          },
        };
      }
      const outcome = typeof observed.outcome === "string" ? observed.outcome : null;
      if (!outcome || !["Matched", "Mismatch", "Pending"].includes(outcome)) {
        throw new Error("quickbooks_frappe_replay_outcome_invalid");
      }
      const reasonCode = typeof observed.reason_code === "string" ? observed.reason_code : null;
      return {
        message: {
          ok: true,
          idempotent_replay: true,
          outcome,
          payment_milestone_id: paymentMilestoneId,
          reconciliation_id: reconciliationId,
          reason_code: reasonCode,
          owner: outcome === "Matched" ? null : "IronWrap Finance",
          next_step: outcome === "Matched" ? null : "reconcile_provider_invoice",
        },
      };
    },
  }, now);
  if (result.effect.state === "succeeded" && result.value !== undefined) return result.value;
  if (result.effect.state === "unknown") throw new EffectRuntimeError("effect_unknown_requires_reconciliation");
  throw new Error(result.effect.result_code ?? "quickbooks_frappe_projection_failed");
}

async function frappeProjectionReadback(
  config: Config,
  method: string,
  body: Record<string, unknown>,
  providerExternalId: string | null,
  fetcher: typeof fetch,
): Promise<{ status: "match" | "conflict" | "unavailable" | "not_found"; providerExternalId?: string; observed?: unknown; detailCode?: string }> {
  if (!providerExternalId) return { status: "unavailable", detailCode: "quickbooks_frappe_readback_id_missing" };
  try {
    const response = await timedFetch(fetcher,
      `${config.frappeBaseUrl}/api/resource/Integration%20Reconciliation/${encodeURIComponent(providerExternalId)}`,
      { method: "GET", redirect: "manual", headers: {
        Accept: "application/json", Authorization: `token ${config.frappeApiKey}:${config.frappeApiSecret}`,
      } }, config.timeoutMs);
    if (response.status === 404) return { status: "not_found", detailCode: "quickbooks_frappe_readback_not_found" };
    if (!response.ok) return { status: "unavailable", detailCode: `quickbooks_frappe_readback_${response.status}` };
    const payload = record(record(await boundedJson(response))?.data);
    if (!payload) return { status: "conflict", observed: {}, detailCode: "quickbooks_frappe_readback_invalid" };
    const paymentMilestoneId = typeof payload.local_name === "string" ? payload.local_name : null;
    if (!paymentMilestoneId) {
      return {
        status: "conflict",
        providerExternalId,
        observed: {},
        detailCode: "quickbooks_frappe_readback_milestone_missing",
      };
    }
    const milestoneResponse = await timedFetch(fetcher,
      `${config.frappeBaseUrl}/api/resource/Payment%20Milestone/${encodeURIComponent(paymentMilestoneId)}`,
      { method: "GET", redirect: "manual", headers: {
        Accept: "application/json", Authorization: `token ${config.frappeApiKey}:${config.frappeApiSecret}`,
      } }, config.timeoutMs);
    if (!milestoneResponse.ok) {
      return { status: "unavailable", detailCode: `quickbooks_frappe_milestone_readback_${milestoneResponse.status}` };
    }
    const milestone = record(record(await boundedJson(milestoneResponse))?.data);
    if (!milestone) {
      return {
        status: "conflict",
        providerExternalId,
        observed: {},
        detailCode: "quickbooks_frappe_milestone_readback_invalid",
      };
    }
    const expected = quickBooksProjectionExpected(body);
    const providerMaterial = quickBooksProjectionObserved(payload, milestone);
    const material = Object.fromEntries(Object.keys(expected).map((field) => [field, providerMaterial[field]]));
    const materialSha256 = await sha256Hex(canonicalEffectJson(material));
    const expectedSha256 = await sha256Hex(canonicalEffectJson(expected));
    if (payload.name !== providerExternalId || materialSha256 !== expectedSha256) {
      return { status: "conflict", providerExternalId, observed: payload, detailCode: "quickbooks_frappe_readback_conflict" };
    }
    const outcome = payload.status;
    let reasonCode: string | null = null;
    if (typeof payload.diff_json === "string") {
      try {
        const diff = record(JSON.parse(payload.diff_json));
        reasonCode =
          typeof diff?.reason_code === "string" ? diff.reason_code : null;
      } catch {
        /* malformed diff remains a conflict below */
      }
    }
    if (
      method === "resolve_provider_invoice_readback" &&
      (!["Matched", "Mismatch", "Pending"].includes(String(outcome)) ||
        (outcome !== "Matched" && !reasonCode))
    ) {
      return {
        status: "conflict",
        providerExternalId,
        observed: payload,
        detailCode: "quickbooks_frappe_readback_outcome_invalid",
      };
    }
    return {
      status: "match",
      providerExternalId,
      observed: {
        material_sha256: materialSha256,
        payment_milestone_id: paymentMilestoneId,
        ...(method === "resolve_provider_invoice_readback"
          ? { outcome, reason_code: reasonCode }
          : {}),
      },
    };
  } catch {
    return { status: "unavailable", detailCode: "quickbooks_frappe_readback_unavailable" };
  }
}

function quickBooksProjectionExpected(body: Record<string, unknown>): Record<string, unknown> {
  const encoded = typeof body.binding_json === "string" ? body.binding_json : body.readback_json;
  let request: Record<string, unknown> = {};
  try {
    request = typeof encoded === "string" ? record(JSON.parse(encoded)) ?? {} : {};
  } catch {
    return {};
  }
  const fields = [
    "intent_id", "basis_sha256", "completion_packet_id", "completion_version", "completion_sha256",
    "customer_quote_id", "quote_version", "quote_sha256", "changes_sha256", "roof_job_id",
    "shop_order_id", "realm_id", "provider_invoice_id", "provider_request_sha256",
    "provider_create_response_sha256", "provider_created_at", "provider_readback_sha256",
    "provider_facts_sha256", "provider_read_at",
  ];
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(request, field)).map((field) => [field, request[field]]));
}

function quickBooksProjectionObserved(
  reconciliation: Record<string, unknown>,
  milestone: Record<string, unknown>,
): Record<string, unknown> {
  let basis: Record<string, unknown> = {};
  try {
    basis = typeof milestone.billing_basis_json === "string"
      ? record(JSON.parse(milestone.billing_basis_json)) ?? {}
      : {};
  } catch {
    /* invalid basis cannot match the expected material hash */
  }
  return {
    intent_id: reconciliation.invoice_intent_id,
    basis_sha256: reconciliation.billing_basis_sha256,
    completion_packet_id: basis.completion_packet_id,
    completion_version: basis.completion_version,
    completion_sha256: basis.completion_sha256,
    customer_quote_id: basis.customer_quote_id,
    quote_version: basis.quote_version,
    quote_sha256: basis.quote_sha256,
    changes_sha256: basis.changes_sha256,
    roof_job_id: reconciliation.roof_job,
    shop_order_id: milestone.shop_order ?? null,
    realm_id: reconciliation.realm_id,
    provider_invoice_id: reconciliation.external_entity_id,
    provider_request_sha256: reconciliation.provider_request_sha256,
    provider_create_response_sha256: reconciliation.provider_create_response_sha256,
    provider_created_at: reconciliation.provider_created_at,
    ...(reconciliation.provider_readback_sha256 ? { provider_readback_sha256: reconciliation.provider_readback_sha256 } : {}),
    ...(reconciliation.provider_facts_sha256 ? { provider_facts_sha256: reconciliation.provider_facts_sha256 } : {}),
    ...(reconciliation.provider_read_at ? { provider_read_at: reconciliation.provider_read_at } : {}),
  };
}

async function frappeCall(config: Config, method: string, body: Record<string, unknown>, fetcher: typeof fetch): Promise<unknown> {
  if (!["list_candidates", "bind_provider_invoice", "resolve_provider_invoice_readback"].includes(method))
    throw new Error("quickbooks_frappe_method_invalid");
  const response = await timedFetch(fetcher,
    `${config.frappeBaseUrl}/api/method/ironwrap_roofing.quickbooks_final_invoice_api.${method}`,
    { method: "POST", redirect: "manual", headers: {
      Accept: "application/json", Authorization: `token ${config.frappeApiKey}:${config.frappeApiSecret}`,
      "Content-Type": "application/json",
    }, body: JSON.stringify(body) }, config.timeoutMs);
  if (!response.ok) throw new Error("quickbooks_frappe_rejected");
  return await boundedJson(response);
}

function candidateListing(value: unknown): { candidates: unknown[]; blockers: QuickBooksCandidateBlocker[] } | null {
  const inner = record(unwrapMessage(value));
  if (!inner || !onlyKeys(inner, ["candidates", "blockers"]) ||
      !Array.isArray(inner.candidates) || !Array.isArray(inner.blockers) ||
      inner.candidates.length > 100 || inner.blockers.length > 100) return null;
  const blockers = inner.blockers.filter(validBlocker) as QuickBooksCandidateBlocker[];
  if (blockers.length !== inner.blockers.length) return null;
  return { candidates: inner.candidates, blockers };
}

async function checkCandidateFreshness(
  config: Config,
  row: FinalInvoiceRow,
  realmId: string,
  fetcher: typeof fetch,
): Promise<"exact" | "changed"> {
  const response = await frappeCall(config, "list_candidates", {
    request_json: JSON.stringify({ roof_job_id: row.roof_job_id, limit: 1, realm_id: realmId }),
  }, fetcher);
  const listing = candidateListing(response);
  if (!listing || listing.blockers.length !== 0 || listing.candidates.length !== 1) return "changed";
  const candidate = validateCandidate(listing.candidates[0]);
  if (!candidate || candidate.qbo.realm_id !== realmId || candidate.basis.intent_id !== row.intent_id)
    return "changed";
  return await sha256Hex(canonicalJson(candidate)) === row.candidate_fingerprint_sha256
    ? "exact" : "changed";
}

function validateCandidate(value: unknown): QuickBooksCandidate | null {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, ["roof_job_id", "shop_order_id", "qbo", "commercial", "basis"])) return null;
  const qbo = record(candidate.qbo); const commercial = record(candidate.commercial); const basis = record(candidate.basis);
  if (!qbo || !commercial || !basis ||
      !exactKeys(qbo, ["realm_id", "customer_id", "item_id", "tax_code_id", "terms_id"]) ||
      !exactKeys(commercial, ["currency", "subtotal", "tax_amount", "total_amount", "already_invoiced", "final_balance", "tax_code", "tax_rate", "invoice_date", "due_date", "lines"]) ||
      !exactKeys(basis, ["intent_id", "basis_sha256", "completion_packet_id", "completion_version", "completion_sha256", "customer_quote_id", "quote_version", "quote_sha256", "changes_sha256", "evidence"])) return null;
  if (!SAFE_ID.test(string(candidate.roof_job_id)) ||
      !(candidate.shop_order_id === null || SAFE_ID.test(string(candidate.shop_order_id))) ||
      !QBO_ID.test(string(qbo.realm_id)) || !QBO_ID.test(string(qbo.customer_id)) ||
      !QBO_ID.test(string(qbo.item_id)) || !QBO_ID.test(string(qbo.tax_code_id)) ||
      !QBO_ID.test(string(qbo.terms_id)) || commercial.currency !== "CAD" ||
      !MONEY.test(string(commercial.subtotal)) || !MONEY.test(string(commercial.tax_amount)) ||
      !MONEY.test(string(commercial.total_amount)) || commercial.already_invoiced !== "0.00" ||
      !MONEY.test(string(commercial.final_balance)) || !SAFE_ID.test(string(commercial.tax_code)) ||
      !TAX_RATE.test(string(commercial.tax_rate)) ||
      !isoDate(string(commercial.invoice_date)) ||
      !isoDate(string(commercial.due_date)) ||
      string(commercial.due_date) < string(commercial.invoice_date) ||
      !Array.isArray(commercial.lines) || commercial.lines.length < 1 || commercial.lines.length > 50 ||
      !INTENT_ID.test(string(basis.intent_id)) || !SHA256.test(string(basis.basis_sha256)) ||
      !SAFE_ID.test(string(basis.completion_packet_id)) || !/^[1-9][0-9]{0,9}$/.test(string(basis.completion_version)) ||
      !SHA256.test(string(basis.completion_sha256)) || !SAFE_ID.test(string(basis.customer_quote_id)) ||
      !positiveInt(basis.quote_version) || !SHA256.test(string(basis.quote_sha256)) ||
      !SHA256.test(string(basis.changes_sha256)) || !Array.isArray(basis.evidence) ||
      basis.evidence.length < 2 || basis.evidence.length > 50 || basis.evidence.some((item) => !validCitation(item))) return null;
  let lineCents = 0;
  for (const raw of commercial.lines) {
    const line = record(raw);
    if (!line || !exactKeys(line, ["source_type", "source_id", "source_version", "description_code", "amount"]) ||
        !["Customer Quote", "Change Order"].includes(string(line.source_type)) ||
        !SAFE_ID.test(string(line.source_id)) || !positiveInt(line.source_version) ||
        !["RESIDENTIAL_ACCEPTED_QUOTE", "RESIDENTIAL_ACCEPTED_CHANGE"].includes(string(line.description_code)) ||
        !MONEY.test(string(line.amount))) return null;
    lineCents += cents(string(line.amount));
  }
  const subtotal = cents(string(commercial.subtotal));
  const tax = cents(string(commercial.tax_amount));
  const total = cents(string(commercial.total_amount));
  if (lineCents !== subtotal || subtotal + tax !== total ||
      cents(string(commercial.final_balance)) !== total) return null;
  return value as QuickBooksCandidate;
}

function validBlocker(value: unknown): value is QuickBooksCandidateBlocker {
  const v = record(value);
  return !!v && exactKeys(v, ["roof_job_id", "code", "message", "citations"]) &&
    SAFE_ID.test(string(v.roof_job_id)) && SAFE_ID.test(string(v.code)) &&
    typeof v.message === "string" && v.message.length >= 1 && v.message.length <= 500 &&
    Array.isArray(v.citations) && v.citations.length <= 50 && v.citations.every(validCitation);
}

function validCitation(value: unknown): value is QuickBooksCitation {
  const citation = record(value);
  if (!citation || !SHA256.test(string(citation.sha256))) return false;
  if (citation.source === "Frappe") return exactKeys(citation, ["source", "doctype", "name", "sha256"]) &&
    /^[A-Za-z][A-Za-z0-9 ]{0,79}$/.test(string(citation.doctype)) && SAFE_ID.test(string(citation.name));
  return citation.source === "R2" && exactKeys(citation, ["source", "key", "sha256"]) &&
    validR2Key(citation.key);
}

function validBindResponse(value: unknown, row: FinalInvoiceRow): boolean {
  const v = record(value);
  return !!v && exactKeys(v, ["ok", "idempotent_replay", "roof_job_id", "shop_order_id", "provider_invoice_id", "payment_milestone_id", "reconciliation_id", "basis_sha256"]) &&
    v.ok === true && typeof v.idempotent_replay === "boolean" && v.roof_job_id === row.roof_job_id &&
    v.shop_order_id === row.shop_order_id && v.provider_invoice_id === row.provider_invoice_id &&
    v.basis_sha256 === row.basis_sha256 && SAFE_ID.test(string(v.payment_milestone_id)) &&
    SAFE_ID.test(string(v.reconciliation_id));
}

function validResolverResponse(value: unknown): value is Record<string, unknown> & { outcome: "Matched" | "Mismatch" | "Pending" } {
  const v = record(value);
  return !!v && exactKeys(v, ["ok", "idempotent_replay", "outcome", "payment_milestone_id", "reconciliation_id", "reason_code", "owner", "next_step"]) &&
    v.ok === true && typeof v.idempotent_replay === "boolean" &&
    ["Matched", "Mismatch", "Pending"].includes(string(v.outcome)) &&
    SAFE_ID.test(string(v.payment_milestone_id)) && SAFE_ID.test(string(v.reconciliation_id)) &&
    nullableSafe(v.reason_code) && nullableSafe(v.owner) && nullableSafe(v.next_step);
}

function createInvoiceIdentity(
  value: unknown,
  approvedBalance: string,
): { Id: string; hashSource: string } | null {
  const invoice = record(record(value)?.Invoice);
  if (!invoice || !QBO_ID.test(string(invoice.Id))) return null;
  if (Object.hasOwn(invoice, "Balance") && qboMoney(invoice.Balance) !== approvedBalance) return null;
  return invoice
    ? { Id: string(invoice.Id), hashSource: canonicalJson(invoice) }
    : null;
}

function qboFaultCode(value: unknown): string | null {
  const fault = record(record(value)?.Fault);
  const errors = Array.isArray(fault?.Error) ? fault.Error : [];
  if (errors.length !== 1) return null;
  const error = record(errors[0]);
  const code = string(error?.code);
  return /^[0-9]{1,8}$/.test(code) ? code : null;
}

async function activeConnection(env: AppEnv, tenantId: string): Promise<ConnectionRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM quickbooks_connections
      WHERE tenant_id = ? AND state = 'connected' ORDER BY connected_at DESC LIMIT 1`,
  ).bind(tenantId).first<ConnectionRow>();
}

async function latestConnection(env: AppEnv, tenantId: string): Promise<ConnectionRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM quickbooks_connections WHERE tenant_id = ? ORDER BY connected_at DESC LIMIT 1`,
  ).bind(tenantId).first<ConnectionRow>();
}

function fixedOAuthRedirect(origin: string | null, status: "connected" | "error"): Response {
  if (!origin) return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  const target = new URL(QUICKBOOKS_RETURN_PATH, origin);
  target.searchParams.set("quickbooks", status);
  return new Response(null, { status: 303, headers: {
    Location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

function providerBase(config: Config): string {
  return config.environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

async function timedFetch(fetcher: typeof fetch, input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try { return await fetcher(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("quickbooks_response_too_large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("quickbooks_response_too_large");
  return JSON.parse(text) as unknown;
}

function unwrapMessage(value: unknown): unknown {
  const object = record(value);
  return object && Object.hasOwn(object, "message") ? object.message : value;
}

function parseLines(value: string): QuickBooksCandidate["commercial"]["lines"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as QuickBooksCandidate["commercial"]["lines"] : [];
  } catch { return []; }
}

function parseEvidence(value: string): QuickBooksCitation[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validCitation).slice(0, 50) : [];
  } catch { return []; }
}

function projectCitations(values: QuickBooksCitation[]): QuickBooksFinalInvoiceEnvelope["intent"]["citations"] {
  return values.map((citation) => {
    const reference = citation.source === "Frappe"
      ? `Frappe:${citation.doctype}:${citation.name}`
      : `R2:${citation.key}`;
    const kind = citation.source === "Frappe" ? citation.doctype ?? "" : citation.key ?? "";
    const label = /completion/i.test(kind) ? "completion_packet" :
      /change/i.test(kind) ? "accepted_change" :
      /quote/i.test(kind) ? "accepted_quote" : "commercial_policy";
    return {
      id: `qbo-citation:${citation.sha256.slice(0, 24)}`,
      label,
      source: citation.source,
      source_ref: reference,
      sha256: citation.sha256,
    };
  });
}

function exactParam(url: URL, name: string, min: number, max: number): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0]!.length >= min && values[0]!.length <= max
    ? values[0]! : null;
}

function decodeKey(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try { const bytes = fromBase64Url(value); return bytes.length === 32 ? bytes : null; }
  catch { return null; }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of utf8(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function randomBase64Url(length: number): string { return base64Url(crypto.getRandomValues(new Uint8Array(length))); }
function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function text(value: unknown, min: number, max: number): string | null {
  const v = string(value).trim(); return v.length >= min && v.length <= max ? v : null;
}
function secretText(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\r\n]/.test(value)
    ? value : null;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function nullableSafe(value: unknown): boolean { return value === null || SAFE_ID.test(string(value)); }
function positiveInt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function cents(value: string): number { const [whole, fraction] = value.split("."); return Number(whole) * 100 + Number(fraction); }
function qboMoney(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value);
  if (!/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(raw)) return null;
  const number = Number(raw); if (!Number.isSafeInteger(Math.round(number * 100))) return null;
  return number.toFixed(2);
}
function isoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}
function qboDecimal(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return number.toFixed(4);
}
function qboLineLabel(code: "RESIDENTIAL_ACCEPTED_QUOTE" | "RESIDENTIAL_ACCEPTED_CHANGE"): string {
  return code === "RESIDENTIAL_ACCEPTED_QUOTE"
    ? "Residential roofing contract"
    : "Accepted change order";
}
function qboDescriptionCode(value: string):
  | "RESIDENTIAL_ACCEPTED_QUOTE" | "RESIDENTIAL_ACCEPTED_CHANGE" | null {
  if (value === "Residential roofing contract") return "RESIDENTIAL_ACCEPTED_QUOTE";
  if (value === "Accepted change order") return "RESIDENTIAL_ACCEPTED_CHANGE";
  return null;
}
function moneyFromCents(value: number): string { return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`; }
function refValue(value: unknown): string | null { const ref = record(value); return ref && SAFE_ID.test(string(ref.value)) ? string(ref.value) : null; }
function seconds(value: unknown, min: number, max: number): number | null {
  const number = Number(value); return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
function safeTid(value: string | null): string | null { return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null; }
function validR2Key(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 300 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) && !value.includes("..");
}
function httpsBase(value: unknown): string | null {
  try { const url = new URL(string(value)); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.toString().replace(/\/+$/, "") : null; }
  catch { return null; }
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value); return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}
function boundedLimit(value: number, max: number): number { return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : 1; }
function changes(result: unknown): number { return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0); }
function rejected<T>(code: string, status: 400 | 403 | 404 | 409 | 502 | 503): QuickBooksResult<T> {
  return { kind: "rejected", code, status };
}
async function scopedHash(tenantId: string, value: string): Promise<string> { return await sha256Hex(`${tenantId}\n${value}`); }
