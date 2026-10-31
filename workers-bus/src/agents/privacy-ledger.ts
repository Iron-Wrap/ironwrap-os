// Independent, create-only agent erasure commitments. This namespace is outside D1/RAW restore.
// Markers contain opaque record identities and commitments, never contacts or erased field text.
import { sha256Hex } from "../app-auth.ts";
import { canonicalJson } from "./schema.ts";

export interface PrivacyEnv { PRIVACY_LEDGER?: R2Bucket }
export interface ErasureDecision {
  erasure_id: string;
  tenant_id: string;
  /** Digest of the client's idempotency key, not the original header. */
  idempotency_key: string;
  request_sha256: string;
  customer_id: string;
  customer_version: number;
  scope_json: string;
  signal_seq_ceiling: number;
  requested_at: string;
  requested_by: string;
  verification_method: "on_file_phone" | "on_file_email";
  verification_ref_sha256: string;
}
export interface SignalErasureMarker {
  version: 1;
  type: "signal";
  tenant_id: string;
  erasure_id: string;
  decision_sha256: string;
  signal_id: string;
  content_sha256: string;
  kind: "event" | "owner_request" | "handoff";
  subject_aggregate: string | null;
  subject_id: string | null;
  received_at: string;
  signal_seq_at_decision: number;
  recorded_at: string;
}
export interface RequestErasureMarker { version: 1; type: "request"; decision: ErasureDecision }
export class AgentPrivacyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = "privacy_ledger_unavailable", status = 503) { super(code); this.code = code; this.status = status; }
}

export const ERASURE_SCOPE_LIMIT = 64;
const MAX_MARKER_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECISION_KEYS = ["erasure_id", "tenant_id", "idempotency_key", "request_sha256", "customer_id", "customer_version", "scope_json", "signal_seq_ceiling", "requested_at", "requested_by", "verification_method", "verification_ref_sha256"];
const SIGNAL_KEYS = ["version", "type", "tenant_id", "erasure_id", "decision_sha256", "signal_id", "content_sha256", "kind", "subject_aggregate", "subject_id", "received_at", "signal_seq_at_decision", "recorded_at"];
const conflict = (): never => { throw new AgentPrivacyError("privacy_marker_conflict"); };
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && TIME.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;

export interface ErasureScope { customer_id: string; leads: string[]; jobs: string[]; signals: Array<{ signal_id: string; content_sha256: string }> }
export function parseErasureScope(value: string): ErasureScope {
  let scope: unknown;
  try { scope = JSON.parse(value); } catch { return conflict(); }
  if (!exact(scope, ["customer_id", "leads", "jobs", "signals"]) || !id(scope.customer_id) ||
      !Array.isArray(scope.leads) || !Array.isArray(scope.jobs) || scope.leads.length + scope.jobs.length + 1 > ERASURE_SCOPE_LIMIT ||
      [...scope.leads, ...scope.jobs].some((v) => !id(v)) ||
      new Set(scope.leads).size !== scope.leads.length || new Set(scope.jobs).size !== scope.jobs.length ||
      !Array.isArray(scope.signals) || scope.signals.length > 100 || scope.signals.some((entry) => !exact(entry, ["signal_id", "content_sha256"]) || !id(entry.signal_id) || !hash(entry.content_sha256)) ||
      new Set(scope.signals.map((entry) => entry.signal_id)).size !== scope.signals.length) return conflict();
  return scope as unknown as ErasureScope;
}

export function validateDecision(value: unknown, tenantId: string, erasureId: string): ErasureDecision {
  if (!exact(value, DECISION_KEYS) || value.tenant_id !== tenantId || !TENANT.test(tenantId) || value.erasure_id !== erasureId ||
      !/^era_[0-9a-f]{64}$/.test(erasureId) || !hash(value.idempotency_key) || !hash(value.request_sha256) || !id(value.customer_id) ||
      !integer(value.customer_version, 1) || !integer(value.signal_seq_ceiling) || !instant(value.requested_at) || !id(value.requested_by) ||
      !["on_file_phone", "on_file_email"].includes(value.verification_method as string) || !hash(value.verification_ref_sha256) ||
      typeof value.scope_json !== "string" || new TextEncoder().encode(value.scope_json).length > MAX_MARKER_BYTES - 2048) return conflict();
  if (parseErasureScope(value.scope_json).customer_id !== value.customer_id) return conflict();
  return value as unknown as ErasureDecision;
}

export async function decisionDigest(decision: ErasureDecision): Promise<string> { return sha256Hex(canonicalJson(decision)); }
export async function signalMarkerDigest(marker: SignalErasureMarker): Promise<string> { return sha256Hex(canonicalJson(marker)); }
export function privacyPrefix(tenantId: string, kind: "requests" | "signals"): string {
  if (!TENANT.test(tenantId)) return conflict();
  return `agent-subject-erasures/v1/${tenantId}/${kind}/`;
}
export function requestMarkerKey(tenantId: string, erasureId: string): string {
  if (!/^era_[0-9a-f]{64}$/.test(erasureId)) return conflict();
  return `${privacyPrefix(tenantId, "requests")}${erasureId}.json`;
}
export function signalMarkerKey(tenantId: string, signalId: string): string {
  if (!id(signalId)) return conflict();
  return `${privacyPrefix(tenantId, "signals")}${signalId}.json`;
}
function bucket(env: PrivacyEnv): R2Bucket {
  if (!env.PRIVACY_LEDGER) throw new AgentPrivacyError();
  return env.PRIVACY_LEDGER;
}
async function read(env: PrivacyEnv, key: string): Promise<unknown | null> {
  let object: R2ObjectBody | null;
  try { object = await bucket(env).get(key); } catch { throw new AgentPrivacyError(); }
  if (!object) return null;
  if (!Number.isSafeInteger(object.size) || object.size < 2 || object.size > MAX_MARKER_BYTES) return conflict();
  let bytes: ArrayBuffer;
  try { bytes = await object.arrayBuffer(); } catch { throw new AgentPrivacyError(); }
  if (bytes.byteLength !== object.size || bytes.byteLength > MAX_MARKER_BYTES) return conflict();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return conflict(); }
}
export async function readRequestMarker(env: PrivacyEnv, tenantId: string, erasureId: string): Promise<RequestErasureMarker | null> {
  const value = await read(env, requestMarkerKey(tenantId, erasureId));
  if (value === null) return null;
  if (!exact(value, ["version", "type", "decision"]) || value.version !== 1 || value.type !== "request") return conflict();
  const decision = validateDecision(value.decision, tenantId, erasureId);
  if (erasureId !== `era_${await sha256Hex(canonicalJson([tenantId, decision.idempotency_key]))}`) return conflict();
  return { version: 1, type: "request", decision };
}
export async function readSignalMarker(env: PrivacyEnv, tenantId: string, signalId: string): Promise<SignalErasureMarker | null> {
  const value = await read(env, signalMarkerKey(tenantId, signalId));
  if (value === null) return null;
  if (!exact(value, SIGNAL_KEYS) || value.version !== 1 || value.type !== "signal" || value.tenant_id !== tenantId || value.signal_id !== signalId ||
      !/^era_[0-9a-f]{64}$/.test(value.erasure_id as string) || !hash(value.decision_sha256) || !hash(value.content_sha256) ||
      !["event", "owner_request", "handoff"].includes(value.kind as string) || !integer(value.signal_seq_at_decision, 1) ||
      !(value.subject_aggregate === null || id(value.subject_aggregate)) || !(value.subject_id === null || id(value.subject_id)) ||
      !instant(value.received_at) || !instant(value.recorded_at)) return conflict();
  return value as unknown as SignalErasureMarker;
}
async function create(env: PrivacyEnv, key: string, marker: RequestErasureMarker | SignalErasureMarker): Promise<void> {
  try {
    await bucket(env).put(key, canonicalJson(marker), { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } });
  } catch { throw new AgentPrivacyError(); }
}
export async function ensureRequestMarker(env: PrivacyEnv, decision: ErasureDecision): Promise<void> {
  const expected: RequestErasureMarker = { version: 1, type: "request", decision };
  await create(env, requestMarkerKey(decision.tenant_id, decision.erasure_id), expected);
  const actual = await readRequestMarker(env, decision.tenant_id, decision.erasure_id);
  if (!actual) throw new AgentPrivacyError();
  if (canonicalJson(actual) !== canonicalJson(expected)) return conflict();
}
export async function ensureSignalMarker(env: PrivacyEnv, marker: SignalErasureMarker): Promise<void> {
  await create(env, signalMarkerKey(marker.tenant_id, marker.signal_id), marker);
  const actual = await readSignalMarker(env, marker.tenant_id, marker.signal_id);
  if (!actual) throw new AgentPrivacyError();
  if (canonicalJson(actual) !== canonicalJson(marker)) return conflict();
}

/** Opaque cursor is passed through only after exact page/key validation; no R2 payload is trusted. */
export async function listPrivacyMarkers(env: PrivacyEnv, tenantId: string, kind: "requests" | "signals", limit: number, cursor?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || (cursor !== undefined && (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor)))) throw new AgentPrivacyError("invalid_query", 400);
  const prefix = privacyPrefix(tenantId, kind);
  let page: R2Objects;
  try { page = await bucket(env).list({ prefix, limit, ...(cursor ? { cursor } : {}) }); } catch { throw new AgentPrivacyError(); }
  if (!Array.isArray(page.objects) || page.objects.length > limit || typeof page.truncated !== "boolean" ||
      (page.truncated && (typeof page.cursor !== "string" || !page.cursor || page.cursor === cursor || page.cursor.length > 2048))) throw new AgentPrivacyError();
  const keys = new Set<string>();
  const markers: Array<RequestErasureMarker | SignalErasureMarker> = [];
  for (const object of page.objects) {
    if (typeof object.key !== "string" || !object.key.startsWith(prefix) || !object.key.endsWith(".json") || keys.has(object.key)) return conflict();
    keys.add(object.key);
    const identity = object.key.slice(prefix.length, -5);
    if (object.key !== (kind === "requests" ? requestMarkerKey(tenantId, identity) : signalMarkerKey(tenantId, identity))) return conflict();
    const marker = kind === "requests" ? await readRequestMarker(env, tenantId, identity) : await readSignalMarker(env, tenantId, identity);
    if (!marker) throw new AgentPrivacyError();
    markers.push(marker);
  }
  return { markers, next_cursor: page.truncated ? page.cursor! : null };
}
