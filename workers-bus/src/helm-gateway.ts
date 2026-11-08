// helm-gateway.ts — the thin, fail-closed client that binds consequential effects to the HELM
// gateway's admission.
//
// Every provider mutation claims an attempt through the effect runtime (effect-runtime.ts), in the
// Worker (`executeExternalEffect`) or from the MCP host (`claimExternalEffect`). Before either
// claims, the Worker proposes the attempt to the HELM gateway (`helm.gateway.v1.EffectGatewayService/Propose`,
// Connect unary JSON over fetch) and reads the decision: ADMITTED lets the attempt proceed,
// DENIED fails the effect with the gateway's reason code, ESCALATED means a person must approve in
// HELM first, and anything the client could not evaluate (no token, timeout, non-2xx, a body it
// does not understand) is `unreachable`. In `enforce` mode only `admitted` proceeds, so an
// unreachable gateway stops new effects rather than letting them through; in `shadow` mode the
// decision is recorded and nothing blocks; `off` never calls out. The decision is appended to
// external_effect_gateway_admissions (0210) in either live mode, with the receipt references the
// gateway returns (helm-tracker#276) once it returns them.
//
// One proposal per attempt: the idempotency key carries the attempt number, so a retry after a
// real provider attempt is a fresh admission (fresh mandate, limit and stop checks), while an
// escalation, which claims no attempt, is found again under the same key once a person approved
// it. A denial claims no attempt either, and the gateway answers the same key with the stored
// denial, so the key also carries the number of denials already recorded for that attempt: the
// next proposal after a denial is a fresh one (the budget may have rolled, the stop lifted), and a
// denial that stands is simply denied again. The gateway digests the exact argument bytes it
// receives, so the same bytes are digested here and recorded.
//
// What the gateway sees: the effect's identity (tenant, effect id, action, provider, actor,
// aggregate, intent, request hash, idempotency key, attempt number) as one canonical JSON object.
// Never the request payload: a customer's address or a mail body is evidence the Worker holds,
// not a thing the admission needs. A person's actor id is sent as a digest.
//
// Tenant, workspace and principal are claims of the bearer token (HELM_GATEWAY_TOKEN, sealed per
// tenant in the registry), never fields of the request. The token's principal is the Worker's
// service principal for that tenant; the acting specialist is named in the arguments for the
// receipt and audited there, while its mandate is the tenant service principal's (one principal
// per tenant until the identity issuer mints one per specialist). The Worker performs the effect
// itself after admission and never calls the gateway's Dispatch, so the gateway's dispatch-time
// re-checks (a stop or a narrowing landing between admission and execution) do not apply;
// every admission, new or stored, requires a parseable live permit. Its expiry is rechecked at
// consumption using the runtime's current clock, independently of the effect's audit timestamp.

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
  /** The gateway permit's expiry, retained for checks after asynchronous ledger/claim work. */
  permit_expires_at?: string;
}

export const PROPOSE_PATH = "/helm.gateway.v1.EffectGatewayService/Propose";
export const EFFECT_TYPE_PREFIX = "ironwrap.";
export const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const EFFECT_TYPE_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const STATE_PREFIX = /^EFFECT_ATTEMPT_STATE_/;

/** The gateway's attempt states that end a proposal, grouped as the Worker acts on them. */
const ADMITTED_STATES = new Set(["ADMITTED", "APPROVED"]);
const DENIED_STATES = new Set(["DENIED", "REJECTED", "EXPIRED", "CANCELLED"]);
const ESCALATED_STATES = new Set(["ESCALATED", "PROPOSED"]);
/** Actors whose id is a stable system identity; any other actor's id is a person's and is sent as a digest. */
const SYSTEM_ACTOR_TYPES = new Set(["agent", "worker", "device"]);

interface HelmGatewayEnv {
  HELM_GATEWAY_BINDING?: string;
  HELM_GATEWAY_URL?: string;
  HELM_GATEWAY_TIMEOUT_MS?: string;
  HELM_GATEWAY_TOKEN?: string;
}

/**
 * The transport the proposal travels on. It belongs to the runtime, not to the executor being
 * admitted: a provider adapter must not be able to answer its own admission. Tests swap it.
 */
const defaultTransport: typeof fetch = (input, init) => fetch(input, init);
let gatewayTransport: typeof fetch = defaultTransport;
let gatewayClock: () => number = () => Date.now();

/** Runtime-owned authority clock. Effect/executor input timestamps cannot extend a permit. */
export function setGatewayClockForTests(clock: (() => number) | null): void {
  gatewayClock = clock ?? (() => Date.now());
}

function parsePermitExpiry(value: unknown): number | null {
  if (typeof value !== "string") return null;
  // Protobuf Timestamp JSON is RFC3339, not Date.parse's permissive date/number grammar.
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const parsed = Date.parse(value);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number.isFinite(parsed) ? parsed : null;
}

/** A proposal can lose authority while its ledger write or claim readback is awaited. */
export function recheckGatewayAdmission<T extends Omit<GatewayAdmission, "mode">>(admission: T): T {
  if (admission.decision !== "admitted") return admission;
  const expiry = parsePermitExpiry(admission.permit_expires_at);
  if (expiry === null) return { ...admission, decision: "unreachable", reason_code: "gateway_permit_invalid" };
  let nowMs: number;
  try { nowMs = gatewayClock(); } catch { nowMs = NaN; }
  if (!Number.isFinite(nowMs)) return { ...admission, decision: "unreachable", reason_code: "gateway_clock_invalid" };
  return expiry <= nowMs ? { ...admission, decision: "denied", reason_code: "PERMIT_EXPIRED" } : admission;
}

export function setGatewayTransportForTests(transport: typeof fetch | null): void {
  gatewayTransport = transport ?? defaultTransport;
}

export function helmGatewayMode(env: HelmGatewayEnv): HelmGatewayMode {
  const raw = String(env.HELM_GATEWAY_BINDING ?? "").trim();
  // Unset and empty both mean the binding is not configured: off. A value nobody declared is the
  // strict one: an operator who misspelt `shadow` has not asked for effects to run unobserved.
  if (raw === "") return "off";
  return (HELM_GATEWAY_MODES as readonly string[]).includes(raw) ? (raw as HelmGatewayMode) : "enforce";
}

/** The gateway effect type for a Worker action: `ironwrap.` plus the action id. */
export function gatewayEffectType(action: string): string {
  const effectType = `${EFFECT_TYPE_PREFIX}${action}`;
  if (!EFFECT_TYPE_RE.test(effectType)) throw new Error("gateway_effect_type_invalid");
  return effectType;
}

/** The argument object the gateway digests: the effect's identity, never its payload. */
export async function gatewayArguments(effect: ExternalEffectRecord, attemptNumber: number): Promise<Record<string, unknown>> {
  // A person's id is digested with the effect id as salt, so the same person is not linkable
  // across effects from the digest alone (the id itself is still guessable from a dictionary;
  // the gateway sees who acted only through HELM's own approval records).
  const actor = SYSTEM_ACTOR_TYPES.has(effect.actor_type)
    ? { type: effect.actor_type, id: effect.actor_id }
    : { type: effect.actor_type, id_sha256: await sha256Hex(`${effect.effect_id}:${effect.actor_id}`) };
  return {
    schema: "ironwrap.gateway-effect.v1",
    tenant_id: effect.tenant_id,
    effect_id: effect.effect_id,
    action: effect.action,
    provider: effect.provider,
    actor,
    aggregate: { type: effect.aggregate_type, id: effect.aggregate_id, version: effect.aggregate_version },
    intent_id: effect.intent_id,
    request_hash: effect.request_hash,
    idempotency_key: effect.idempotency_key,
    attempt_number: attemptNumber,
  };
}

/**
 * One key per attempt and per denial already recorded for it: a retry is a fresh admission, an
 * escalation (no attempt claimed, no denial) is found again, and the proposal after a denial is new.
 */
export function gatewayIdempotencyKey(effect: ExternalEffectRecord, attemptNumber: number, priorDenials = 0): string {
  const suffix = priorDenials > 0 ? `:d${priorDenials}` : "";
  return `ironwrap:${effect.tenant_id}:${effect.effect_id}:${attemptNumber}${suffix}`.slice(0, 255);
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

/** protojson writes lowerCamelCase; a server configured otherwise writes the proto names. Read both. */
function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] !== undefined ? record[camel] : record[snake];
}

function receiptRefs(raw: unknown): GatewayReceiptRef[] | null {
  if (!Array.isArray(raw)) return null;
  const refs: GatewayReceiptRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const ref = entry as Record<string, unknown>;
    const chainId = field(ref, "chainId", "chain_id");
    const receiptHash = field(ref, "receiptHash", "receipt_hash");
    const rawSeq = ref.seq;
    const seq = typeof rawSeq === "number" ? rawSeq : typeof rawSeq === "string" ? Number(rawSeq) : NaN;
    if (typeof chainId !== "string" || typeof receiptHash !== "string" || typeof ref.kid !== "string" || !Number.isInteger(seq)) return null;
    refs.push({ chain_id: chainId, seq, receipt_hash: receiptHash, kid: ref.kid });
  }
  return refs;
}

/** The body, read within the same timeout as the request and never past the size cap. */
async function readBounded(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = new Promise<never>((_, reject) => {
    const stop = () => {
      reader.cancel().catch(() => {});
      reject(new Error("aborted"));
    };
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
  });
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), abort]);
    // A cancelled reader reports `done` too; an aborted read is a timeout, never an empty body.
    if (signal.aborted) throw new Error("aborted");
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Propose one effect attempt to the gateway and classify its answer. Never throws: every failure
 * to obtain a decision is the `unreachable` decision with the reason the client saw.
 */
export async function proposeToGateway(
  env: HelmGatewayEnv,
  effect: ExternalEffectRecord,
  attemptNumber: number,
  options: { priorDenials?: number; transport?: typeof fetch } = {},
): Promise<Omit<GatewayAdmission, "mode">> {
  const transport = options.transport ?? gatewayTransport;
  const argumentBytes = new TextEncoder().encode(canonicalJson(await gatewayArguments(effect, attemptNumber)));
  const argumentDigest = await sha256Hex(new TextDecoder().decode(argumentBytes));
  const base = { effect_type: "", argument_digest: argumentDigest, gateway_attempt_id: null, gateway_state: null, receipts: null };
  const unreachable = (reason: string, extra: Partial<Omit<GatewayAdmission, "mode">> = {}): Omit<GatewayAdmission, "mode"> =>
    ({ ...base, ...extra, decision: "unreachable", reason_code: reason.slice(0, 120) });

  let effectType: string;
  try {
    effectType = gatewayEffectType(effect.action);
  } catch {
    return unreachable("gateway_effect_type_invalid");
  }
  const identity = { effect_type: effectType, argument_digest: argumentDigest };

  const url = gatewayUrl(env);
  if (!url) return unreachable("gateway_url_missing", identity);
  const token = String(env.HELM_GATEWAY_TOKEN ?? "").trim();
  if (!token) return unreachable("gateway_token_missing", identity);

  const body = {
    idempotency_key: gatewayIdempotencyKey(effect, attemptNumber, options.priorDenials ?? 0),
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
  try {
    let response: Response;
    try {
      response = await transport(new URL(PROPOSE_PATH, url).toString(), {
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
    } catch {
      return unreachable(controller.signal.aborted ? "gateway_timeout" : "gateway_network_error", identity);
    }
    let text: string | null;
    try {
      text = await readBounded(response, controller.signal);
    } catch {
      return unreachable(controller.signal.aborted ? "gateway_timeout" : "gateway_response_unreadable", identity);
    }
    if (text === null) return unreachable("gateway_response_too_large", identity);
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
      return unreachable(code ? `gateway_http_${response.status}_${code}` : `gateway_http_${response.status}`, identity);
    }
    if (malformed) return unreachable("gateway_response_malformed", identity);
    const attempt = parsed && typeof parsed === "object" ? (parsed as { attempt?: unknown }).attempt : undefined;
    if (!attempt || typeof attempt !== "object") return unreachable("gateway_response_shape", identity);
    const record = attempt as Record<string, unknown>;
    const rawState = record.state;
    const state = typeof rawState === "string" ? rawState.replace(STATE_PREFIX, "").slice(0, 64) : null;
    const rawReason = field(record, "reasonCode", "reason_code");
    const reason = typeof rawReason === "string" && rawReason ? rawReason.slice(0, 120) : null;
    const rawAttemptId = field(record, "attemptId", "attempt_id");
    const attemptId = typeof rawAttemptId === "string" ? rawAttemptId.slice(0, 200) : null;
    const common = { ...identity, gateway_attempt_id: attemptId, gateway_state: state, receipts: receiptRefs(record.receipts) };
    if (state && ADMITTED_STATES.has(state)) {
      // ADMITTED/APPROVED is a state, not authority without a live permit. `existing` only says
      // whether the answer was stored; it cannot exempt a newly returned permit from expiry.
      const permit = record.permit && typeof record.permit === "object" && !Array.isArray(record.permit) ? record.permit as Record<string, unknown> : null;
      const permitExpiry = permit ? field(permit, "expiresAt", "expires_at") : undefined;
      if (parsePermitExpiry(permitExpiry) === null || (permit?.expiresAt !== undefined && permit.expires_at !== undefined && permit.expiresAt !== permit.expires_at)) {
        return { ...common, decision: "unreachable", reason_code: "gateway_permit_invalid" };
      }
      return recheckGatewayAdmission({ ...common, decision: "admitted", reason_code: reason, permit_expires_at: permitExpiry as string });
    }
    if (state && DENIED_STATES.has(state)) return { ...common, decision: "denied", reason_code: reason ?? state };
    if (state && ESCALATED_STATES.has(state)) return { ...common, decision: "escalated", reason_code: reason ?? "APPROVAL_REQUIRED" };
    return { ...common, decision: "unreachable", reason_code: state ? `gateway_state_${state}`.slice(0, 120) : "gateway_response_shape" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The admission step before an attempt is claimed: propose, record, and say whether the attempt
 * may proceed. `off` records nothing and always proceeds. In `shadow` the decision is recorded
 * and the attempt always proceeds. In `enforce` only `admitted` proceeds.
 */
export async function admitExternalEffect(
  env: AppEnv & HelmGatewayEnv,
  effect: ExternalEffectRecord,
  attemptNumber: number,
  now: string,
): Promise<GatewayAdmission> {
  const mode = helmGatewayMode(env);
  if (mode === "off") {
    return { mode, decision: "admitted", reason_code: null, effect_type: "", gateway_attempt_id: null, gateway_state: null, argument_digest: "", receipts: null };
  }
  // Denials already recorded for this attempt make the next proposal a new key (see the header),
  // except a person's rejection: that answer is final for the attempt, so the stored REJECTED is
  // what the same key finds again, and nobody is asked twice for the same thing.
  let priorDenials = 0;
  try {
    const counted = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM external_effect_gateway_admissions
        WHERE effect_id = ? AND attempt_number = ? AND decision = 'denied'
          AND COALESCE(gateway_state, '') <> 'REJECTED' AND COALESCE(reason_code, '') <> 'APPROVAL_REJECTED'`,
    ).bind(effect.effect_id, attemptNumber).first<{ n: number }>();
    priorDenials = Number(counted?.n ?? 0);
  } catch (error) {
    // The ledger could not be read. In enforce mode that is no admission; shadow proceeds on a
    // first-proposal key and logs.
    if (mode === "enforce") {
      return { mode, decision: "unreachable", reason_code: "gateway_admission_unrecorded", effect_type: "", gateway_attempt_id: null, gateway_state: null, argument_digest: "", receipts: null };
    }
    console.log(JSON.stringify({ at: "helm_gateway_admissions_unreadable", effect_id: effect.effect_id, error: String(error) }));
  }
  const proposed = await proposeToGateway(env, effect, attemptNumber, { priorDenials });
  const admission: GatewayAdmission = { mode, ...proposed };
  try {
    await recordAdmission(env, effect, attemptNumber, admission, now);
    const current = recheckGatewayAdmission(admission);
    // Keep the proposal fact and append its loss of authority; never revise the first row.
    if (current !== admission) await recordAdmission(env, effect, attemptNumber, current, now);
    return current;
  } catch (error) {
    // The decision could not be recorded. In enforce mode an unrecorded admission is no
    // admission: the attempt does not proceed on evidence that does not exist.
    if (mode === "enforce") return { ...admission, decision: "unreachable", reason_code: "gateway_admission_unrecorded" };
    console.log(JSON.stringify({ at: "helm_gateway_admission_unrecorded", effect_id: effect.effect_id, error: String(error) }));
  }
  return admission;
}

async function recordAdmission(env: AppEnv, effect: ExternalEffectRecord, attemptNumber: number, admission: GatewayAdmission, now: string): Promise<void> {
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
    admission.mode,
    admission.decision,
    admission.reason_code,
    admission.effect_type || "unresolved",
    admission.gateway_attempt_id,
    admission.gateway_state,
    admission.argument_digest,
    admission.receipts ? JSON.stringify(admission.receipts) : null,
    now,
    ).run();
}

// --- earned autonomy as mandates ---------------------------------------------------------------

export type DelegationSetting = "asks_first" | "within_limits" | "off";

/**
 * One mandate fragment for the HELM provisioning plan (`helm.authority.provision.v1`), derived
 * from one IronWrap delegation setting. The HELM side provisions mandates for the tenant's service
 * principal; this is the shape the Worker's own delegation rules take there:
 *
 * | IronWrap delegation        | mandate                                                          |
 * |----------------------------|------------------------------------------------------------------|
 * | `off`                      | no mandate names the effect type (`EFFECT_OUT_OF_SCOPE`)         |
 * | `asks_first`               | the effect type with `approval_threshold` 0: every call escalates |
 * | `within_limits` + ceiling  | `approval_threshold` one above the amount ceiling, so a call above |
 * |                            | it escalates (asks first) as it does in the Worker, never a      |
 * |                            | `per_call_limit`, which would deny it; a `count` limit per the    |
 * |                            | ceiling's window, which the gateway denies (`BUDGET_EXCEEDED`)    |
 * |                            | where the Worker asks first: a difference to keep in mind         |
 *
 * The amount is compared against the proposal's quote, and the Worker quotes `count=1` only until
 * money effects carry their amount into the proposal, so today the amount threshold is enforced by
 * the Worker's own authority ceiling and the gateway sees the count. Recipients are not mapped.
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
  // The gateway's window kinds stop at hour, day and month; a week is seven day windows.
  const window: { window_kind: "hour" | "day"; span: number } = input.ceiling.count.per === "hour"
    ? { window_kind: "hour", span: 1 }
    : input.ceiling.count.per === "day"
    ? { window_kind: "day", span: 1 }
    : { window_kind: "day", span: 7 };
  return {
    ...base,
    in_scope: true,
    per_call_limit: null,
    approval_threshold: amount === null ? null : amount + 1,
    limits: [{ unit: "count", measure: "count", ...window, limit_value: input.ceiling.count.max }],
  };
}
