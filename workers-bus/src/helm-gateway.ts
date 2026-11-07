// helm-gateway.ts — the thin, fail-closed client that binds consequential effects to the HELM
// gateway's admission.
//
// Every provider mutation passes `executeExternalEffect` (effect-runtime.ts). Before the Worker
// claims an attempt it proposes the effect to the HELM gateway (`helm.gateway.v1.EffectGatewayService/Propose`,
// Connect unary JSON over fetch) and reads the decision: ADMITTED lets the attempt proceed,
// DENIED fails the effect with the gateway's reason code, ESCALATED means a person must approve in
// HELM first, and anything the client could not evaluate (no token, timeout, non-2xx, a body it
// does not understand) is `unreachable`. In `enforce` mode only `admitted` proceeds, so an
// unreachable gateway stops new effects rather than letting them through; in `shadow` mode the
// decision is recorded and nothing blocks; `off` never calls out. The decision is appended to
// external_effect_gateway_admissions (0210) in either live mode, with the receipt references the
// gateway returns (helm-tracker#276) once it returns them.
//
// What the gateway sees: the effect's identity (tenant, effect id, action, provider, aggregate,
// intent, request hash, idempotency key, attempt number) as one canonical JSON object. Never the
// request payload: a customer's address or a mail body is evidence the Worker holds, not a thing
// the admission needs. The gateway digests the exact bytes it receives, so the same bytes are
// digested here and recorded, and `idempotency_key` is stable across attempts of one effect: an
// escalation a person approves in HELM is found again by the next attempt's proposal.
//
// Tenant, workspace and principal are claims of the bearer token (HELM_GATEWAY_TOKEN, sealed per
// tenant in the registry), never fields of the request. The token's principal is the Worker's
// service principal for that tenant; the acting specialist is named in the arguments for the
// receipt and audited there, while its mandate is the tenant service principal's (one principal
// per tenant until the identity issuer mints one per specialist).

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { Ceiling } from "./agents/control.ts";
import type { ExternalEffectRecord } from "./effect-runtime.ts";

export const HELM_GATEWAY_MODES = ["off", "shadow", "enforce"] as const;
export type HelmGatewayMode = (typeof HELM_GATEWAY_MODES)[number];

export type GatewayDecision = "admitted" | "denied" | "escalated" | "unreachable";

export interface GatewayReceiptRef {
  chain_id: string;
  seq: number;
  receipt_hash: string;
  kid: string;
}

export interface GatewayAdmission {
  mode: HelmGatewayMode;
  decision: GatewayDecision;
  reason_code: string | null;
  effect_type: string;
  gateway_attempt_id: string | null;
  gateway_state: string | null;
  argument_digest: string;
  receipts: GatewayReceiptRef[] | null;
}

export const PROPOSE_PATH = "/helm.gateway.v1.EffectGatewayService/Propose";
export const EFFECT_TYPE_PREFIX = "ironwrap.";
export const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const EFFECT_TYPE_RE = /^[a-z][a-z0-9_.-]{0,127}$/;

/** The gateway's attempt states that end a proposal, grouped as the Worker acts on them. */
const ADMITTED_STATES = new Set(["ADMITTED", "APPROVED"]);
const DENIED_STATES = new Set(["DENIED", "REJECTED", "EXPIRED", "CANCELLED"]);
const ESCALATED_STATES = new Set(["ESCALATED", "PROPOSED", "ESCALATED_TO_HUMAN"]);

interface HelmGatewayEnv {
  HELM_GATEWAY_BINDING?: string;
  HELM_GATEWAY_URL?: string;
  HELM_GATEWAY_TIMEOUT_MS?: string;
  HELM_GATEWAY_TOKEN?: string;
}

export function helmGatewayMode(env: HelmGatewayEnv): HelmGatewayMode {
  const raw = String(env.HELM_GATEWAY_BINDING ?? "off").trim();
  // A mode nobody declared is the strict one: an operator who misspelt `shadow` has not asked
  // for effects to run unobserved.
  return (HELM_GATEWAY_MODES as readonly string[]).includes(raw) ? (raw as HelmGatewayMode) : "enforce";
}

/** The gateway effect type for a Worker action: `ironwrap.` plus the action id. */
export function gatewayEffectType(action: string): string {
  const effectType = `${EFFECT_TYPE_PREFIX}${action}`;
  if (!EFFECT_TYPE_RE.test(effectType)) throw new Error("gateway_effect_type_invalid");
  return effectType;
}

/** The argument object the gateway digests: the effect's identity, never its payload. */
export function gatewayArguments(effect: ExternalEffectRecord, attemptNumber: number): Record<string, unknown> {
  return {
    schema: "ironwrap.gateway-effect.v1",
    tenant_id: effect.tenant_id,
    effect_id: effect.effect_id,
    action: effect.action,
    provider: effect.provider,
    actor: { type: effect.actor_type, id: effect.actor_id },
    aggregate: { type: effect.aggregate_type, id: effect.aggregate_id, version: effect.aggregate_version },
    intent_id: effect.intent_id,
    request_hash: effect.request_hash,
    idempotency_key: effect.idempotency_key,
    attempt_number: attemptNumber,
  };
}

export function gatewayIdempotencyKey(effect: ExternalEffectRecord): string {
  return `ironwrap:${effect.tenant_id}:${effect.effect_id}`.slice(0, 255);
}

function timeoutMs(env: HelmGatewayEnv): number {
  const raw = Number(env.HELM_GATEWAY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

function gatewayUrl(env: HelmGatewayEnv): URL | null {
  const raw = String(env.HELM_GATEWAY_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function receiptRefs(raw: unknown): GatewayReceiptRef[] | null {
  if (!Array.isArray(raw)) return null;
  const refs: GatewayReceiptRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const ref = entry as Record<string, unknown>;
    const seq = typeof ref.seq === "number" ? ref.seq : typeof ref.seq === "string" ? Number(ref.seq) : NaN;
    if (typeof ref.chain_id !== "string" || typeof ref.receipt_hash !== "string" || typeof ref.kid !== "string" || !Number.isInteger(seq)) return null;
    refs.push({ chain_id: ref.chain_id, seq, receipt_hash: ref.receipt_hash, kid: ref.kid });
  }
  return refs;
}

/**
 * Propose one effect attempt to the gateway and classify its answer. Never throws: every failure
 * to obtain a decision is the `unreachable` decision with the reason the client saw.
 */
export async function proposeToGateway(
  env: HelmGatewayEnv,
  effect: ExternalEffectRecord,
  attemptNumber: number,
  fetcher: typeof fetch = fetch,
): Promise<Omit<GatewayAdmission, "mode">> {
  const effectType = gatewayEffectType(effect.action);
  const argumentBytes = new TextEncoder().encode(canonicalJson(gatewayArguments(effect, attemptNumber)));
  const argumentDigest = await sha256Hex(new TextDecoder().decode(argumentBytes));
  const base = {
    effect_type: effectType,
    argument_digest: argumentDigest,
    gateway_attempt_id: null,
    gateway_state: null,
    receipts: null,
  };
  const unreachable = (reason: string): Omit<GatewayAdmission, "mode"> => ({ ...base, decision: "unreachable", reason_code: reason });

  const url = gatewayUrl(env);
  if (!url) return unreachable("gateway_url_missing");
  const token = String(env.HELM_GATEWAY_TOKEN ?? "").trim();
  if (!token) return unreachable("gateway_token_missing");

  const body = {
    idempotency_key: gatewayIdempotencyKey(effect),
    case_id: effect.correlation_id.slice(0, 255),
    effect: {
      effect_type: effectType,
      target: `${effect.aggregate_type}:${effect.aggregate_id}`.slice(0, 512),
      arguments: toBase64(argumentBytes),
    },
    quote: [{ unit: "count", amount: "1" }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  let response: Response;
  try {
    response = await fetcher(new URL(PROPOSE_PATH, url).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return unreachable(controller.signal.aborted ? "gateway_timeout" : "gateway_network_error");
  }
  clearTimeout(timer);

  let text: string;
  try {
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return unreachable("gateway_response_too_large");
    text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return unreachable("gateway_response_too_large");
  } catch {
    return unreachable("gateway_response_unreadable");
  }
  let parsed: unknown = null;
  let malformed = false;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    malformed = true;
  }
  if (!response.ok) {
    // A Connect error carries `code` and the kernel's reason code in its details; the gateway
    // could not evaluate the request, which is not a decision and must not pass.
    const code = parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string"
      ? (parsed as { code: string }).code.replace(/[^a-z_]/g, "")
      : null;
    return unreachable(code ? `gateway_http_${response.status}_${code}`.slice(0, 120) : `gateway_http_${response.status}`);
  }
  if (malformed) return unreachable("gateway_response_malformed");
  const attempt = parsed && typeof parsed === "object" ? (parsed as { attempt?: unknown }).attempt : undefined;
  if (!attempt || typeof attempt !== "object") return unreachable("gateway_response_shape");
  const record = attempt as Record<string, unknown>;
  const state = typeof record.state === "string" ? record.state.replace(/^EFFECT_ATTEMPT_STATE_/, "") : null;
  const reason = typeof record.reason_code === "string" && record.reason_code ? record.reason_code.slice(0, 120) : null;
  const attemptId = typeof record.attempt_id === "string" ? record.attempt_id.slice(0, 200) : null;
  const common = { ...base, gateway_attempt_id: attemptId, gateway_state: state, receipts: receiptRefs(record.receipts) };
  if (state && ADMITTED_STATES.has(state)) return { ...common, decision: "admitted", reason_code: reason };
  if (state && DENIED_STATES.has(state)) return { ...common, decision: "denied", reason_code: reason ?? state };
  if (state && ESCALATED_STATES.has(state)) return { ...common, decision: "escalated", reason_code: reason ?? "APPROVAL_REQUIRED" };
  return { ...common, decision: "unreachable", reason_code: state ? `gateway_state_${state}`.slice(0, 120) : "gateway_response_shape" };
}

/**
 * The admission step of `executeExternalEffect`: propose, record, and say whether the attempt may
 * proceed. `off` records nothing and always proceeds. In `shadow` the decision is recorded and the
 * attempt always proceeds. In `enforce` only `admitted` proceeds.
 */
export async function admitExternalEffect(
  env: AppEnv & HelmGatewayEnv,
  effect: ExternalEffectRecord,
  attemptNumber: number,
  now: string,
  fetcher: typeof fetch = fetch,
): Promise<GatewayAdmission> {
  const mode = helmGatewayMode(env);
  if (mode === "off") {
    return {
      mode,
      decision: "admitted",
      reason_code: null,
      effect_type: gatewayEffectType(effect.action),
      gateway_attempt_id: null,
      gateway_state: null,
      argument_digest: "",
      receipts: null,
    };
  }
  const proposed = await proposeToGateway(env, effect, attemptNumber, fetcher);
  const admission: GatewayAdmission = { mode, ...proposed };
  try {
    await env.DB.prepare(
      `INSERT INTO external_effect_gateway_admissions
         (admission_id, effect_id, tenant_id, attempt_number, mode, decision, reason_code, effect_type,
          gateway_attempt_id, gateway_state, argument_digest, receipt_ref_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${effect.effect_id}:gateway:${crypto.randomUUID()}`,
      effect.effect_id,
      effect.tenant_id,
      attemptNumber,
      mode,
      admission.decision,
      admission.reason_code,
      admission.effect_type,
      admission.gateway_attempt_id,
      admission.gateway_state,
      admission.argument_digest,
      admission.receipts ? JSON.stringify(admission.receipts) : null,
      now,
    ).run();
  } catch (error) {
    // The decision could not be recorded. In enforce mode an unrecorded admission is no
    // admission: the attempt does not proceed on evidence that does not exist.
    if (mode === "enforce") return { ...admission, decision: "unreachable", reason_code: "gateway_admission_unrecorded" };
    console.log(JSON.stringify({ at: "helm_gateway_admission_unrecorded", effect_id: effect.effect_id, error: String(error) }));
  }
  return admission;
}

// --- earned autonomy as mandates ---------------------------------------------------------------

export type DelegationSetting = "asks_first" | "within_limits" | "off";

/**
 * One mandate fragment for the HELM provisioning plan (`helm.authority.provision.v1`), derived
 * from one IronWrap delegation setting. The HELM side provisions mandates for the tenant's service
 * principal; this is the shape the Worker's own delegation rules take there:
 *
 * | IronWrap delegation        | mandate                                                        |
 * |----------------------------|----------------------------------------------------------------|
 * | `off`                      | no mandate names the effect type (`EFFECT_OUT_OF_SCOPE`)       |
 * | `asks_first`               | the effect type with `approval_threshold` 0: every call escalates |
 * | `within_limits` + ceiling  | `per_call_limit` = the amount ceiling, `approval_threshold` one |
 * |                            | above it, a `count` limit per the ceiling's window               |
 *
 * A demotion (`afterCatastrophe`, agents/shadow.ts) moves a setting back to `asks_first`, which
 * here is a narrowing (`helm.authority.narrow.v1`) to threshold 0.
 */
export interface GatewayMandateFragment {
  schema: "ironwrap.gateway-mandate.v1";
  tenant_id: string;
  specialist_id: string;
  effect_type: string;
  delegation: DelegationSetting;
  in_scope: boolean;
  per_call_limit: number | null;
  approval_threshold: number | null;
  limits: Array<{ unit: "count"; measure: "count"; window_kind: "hour" | "day"; span: number; limit_value: number }>;
}

export function gatewayMandateFor(input: {
  tenantId: string;
  specialistId: string;
  actionId: string;
  delegation: DelegationSetting;
  ceiling: Ceiling | null;
}): GatewayMandateFragment {
  const base: GatewayMandateFragment = {
    schema: "ironwrap.gateway-mandate.v1",
    tenant_id: input.tenantId,
    specialist_id: input.specialistId,
    effect_type: gatewayEffectType(input.actionId),
    delegation: input.delegation,
    in_scope: false,
    per_call_limit: null,
    approval_threshold: null,
    limits: [],
  };
  if (input.delegation === "off") return base;
  if (input.delegation === "asks_first" || !input.ceiling) {
    return { ...base, in_scope: true, approval_threshold: 0 };
  }
  const amount = input.ceiling.amount?.max_minor ?? null;
  // The gateway counts a week as seven day windows; its window kinds stop at `day` and `month`.
  const window: { window_kind: "hour" | "day"; span: number } = input.ceiling.count.per === "hour"
    ? { window_kind: "hour", span: 1 }
    : input.ceiling.count.per === "day"
    ? { window_kind: "day", span: 1 }
    : { window_kind: "day", span: 7 };
  return {
    ...base,
    in_scope: true,
    per_call_limit: amount,
    approval_threshold: amount === null ? null : amount + 1,
    limits: [{ unit: "count", measure: "count", ...window, limit_value: input.ceiling.count.max }],
  };
}
