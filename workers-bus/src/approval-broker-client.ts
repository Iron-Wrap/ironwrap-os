import type { ApprovalRequestRecord } from "./approval-store.ts";
import type { AppEnv } from "./app-types.ts";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_AGE_SECONDS = 15 * 60;
const DEFAULT_EXECUTION_LEASE_SECONDS = 45;

export interface ApprovalBrokerConfig {
  baseUrl: string;
  keyId: string;
  sharedSecret: string;
  approverId: string;
  maxSessionAgeSeconds: number;
  timeoutMs: number;
  executionLeaseSeconds: number;
}

export interface ApprovalDecisionConfig {
  approverId: string;
  maxSessionAgeSeconds: number;
}

export interface BrokerPreviewPacket {
  approvalRequestId: string;
  tenantId: string;
  requestKind: "lead_triage";
  writeTool: "request_mark_lead_triaged";
  dryRunTool: "dry_run_mark_lead_triaged";
  agentRole: string;
  actorUser: string;
  siteId: string;
  targetDoctype: "Lead Envelope";
  targetName: string;
  leadEnvelopeId: string;
  requestText: string;
  writeArgsJson: string;
  previewJson: string;
  argsDigest: string;
  previewDigest: string;
  dryRunReceipt: string;
  expiresAt: string;
  runId: string;
  intentFingerprint: string;
}

export interface BrokerExecutionOutcome {
  state: "executed" | "failed" | "audit_failed" | "execution_uncertain";
  hermesRunId: string | null;
  resultJson: string | null;
  errorCode: string | null;
}

export class ApprovalBrokerError extends Error {
  readonly code: "approval_broker_not_configured" | "approval_broker_unavailable" | "approval_broker_response_invalid";

  constructor(code: "approval_broker_not_configured" | "approval_broker_unavailable" | "approval_broker_response_invalid") {
    super(code);
    this.code = code;
  }
}

export function approvalBrokerConfig(env: AppEnv): ApprovalBrokerConfig | null {
  const baseUrl = normalizedBrokerBaseUrl(env.APP_APPROVAL_BROKER_URL, String(env.APP_ALLOW_INSECURE_LOCAL) === "true");
  const keyId = env.APP_APPROVAL_BROKER_KEY_ID?.trim() ?? "";
  const sharedSecret = env.APPROVAL_BROKER_SHARED_SECRET?.trim() ?? "";
  const decision = approvalDecisionConfig(env);
  if (!baseUrl || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || sharedSecret.length < 32 || !decision) return null;
  const timeoutMs = boundedInt(env.APP_APPROVAL_BROKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  const executionLeaseSeconds = boundedInt(
    env.APP_APPROVAL_EXECUTION_LEASE_SECONDS,
    DEFAULT_EXECUTION_LEASE_SECONDS,
    15,
    120,
  );
  if (timeoutMs === null || executionLeaseSeconds === null) return null;
  return {
    baseUrl,
    keyId,
    sharedSecret,
    approverId: decision.approverId,
    maxSessionAgeSeconds: decision.maxSessionAgeSeconds,
    timeoutMs,
    executionLeaseSeconds,
  };
}

export function approvalDecisionConfig(env: AppEnv): ApprovalDecisionConfig | null {
  const approverId = env.APP_APPROVAL_APPROVER_ID?.trim() ?? "";
  const maxSessionAgeSeconds = boundedInt(
    env.APP_APPROVAL_MAX_SESSION_AGE_SECONDS,
    DEFAULT_SESSION_AGE_SECONDS,
    60,
    60 * 60,
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverId) || maxSessionAgeSeconds === null) return null;
  return { approverId, maxSessionAgeSeconds };
}

export function sessionIsRecentForApproval(
  sessionCreatedAt: string,
  config: Pick<ApprovalDecisionConfig, "maxSessionAgeSeconds">,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(sessionCreatedAt);
  return Number.isFinite(createdAt) && createdAt <= now && now - createdAt <= config.maxSessionAgeSeconds * 1000;
}

export async function previewLeadTriageApproval(
  env: AppEnv,
  input: {
    approvalRequestId: string;
    tenantId: string;
    runId: string;
    leadEnvelopeId: string;
    triageSummary: string;
    requestText: string;
    requestedByUserId: string;
    requestedByFrappeUser: string;
  },
  dependencies: BrokerDependencies = {},
): Promise<BrokerPreviewPacket> {
  const response = await callBroker(env, "/v1/lead-triage/preview", {
    approval_request_id: input.approvalRequestId,
    tenant_id: input.tenantId,
    run_id: input.runId,
    lead_envelope_id: input.leadEnvelopeId,
    triage_summary: input.triageSummary,
    request_text: input.requestText,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
  }, dependencies);
  return parsePreviewPacket(response, input, (dependencies.now ?? Date.now)());
}

export async function executeLeadTriageApproval(
  env: AppEnv,
  request: ApprovalRequestRecord,
  dependencies: BrokerDependencies = {},
): Promise<BrokerExecutionOutcome> {
  if (!request.approved_by_frappe_user || !request.decision_idempotency_key) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  const response = await callBroker(env, "/v1/lead-triage/execute", {
    approval_request: {
      approval_request_id: request.approval_request_id,
      tenant_id: request.tenant_id,
      request_kind: request.request_kind,
      write_tool: request.write_tool,
      dry_run_tool: request.dry_run_tool,
      agent_role: request.agent_role,
      actor_user: request.actor_user,
      site_id: request.site_id,
      target_doctype: request.target_doctype,
      target_name: request.target_name,
      lead_envelope_id: request.lead_envelope_id,
      request_text: request.request_text,
      write_args_json: request.write_args_json,
      preview_json: request.preview_json,
      args_digest: request.args_digest,
      preview_digest: request.preview_digest,
      dry_run_receipt: request.dry_run_receipt,
      expires_at: request.expires_at,
      run_id: request.run_id,
      approved_by_frappe_user: request.approved_by_frappe_user,
      decision_idempotency_key: request.decision_idempotency_key,
    },
  }, dependencies);
  return parseExecutionOutcome(response, request);
}

export interface BrokerDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

async function callBroker(
  env: AppEnv,
  path: "/v1/lead-triage/preview" | "/v1/lead-triage/execute",
  body: Record<string, unknown>,
  dependencies: BrokerDependencies,
): Promise<Record<string, unknown>> {
  const config = approvalBrokerConfig(env);
  if (!config) throw new ApprovalBrokerError("approval_broker_not_configured");
  const now = dependencies.now ?? Date.now;
  const nonce = dependencies.nonce?.() ?? randomNonce();
  const rawBody = JSON.stringify(body);
  const timestamp = String(now());
  const bodyHash = await sha256Hex(rawBody);
  const signature = await hmacBase64Url(config.sharedSecret, internalRequestSigningInput({
    keyId: config.keyId,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyHash,
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-ironwrap-internal-version": INTERNAL_VERSION,
        "x-ironwrap-internal-key-id": config.keyId,
        "x-ironwrap-internal-timestamp": timestamp,
        "x-ironwrap-internal-nonce": nonce,
        "x-ironwrap-internal-signature": signature,
      },
      body: rawBody,
    });
  } catch {
    throw new ApprovalBrokerError("approval_broker_unavailable");
  } finally {
    clearTimeout(timer);
  }
  const rawResponse = await readBoundedResponse(response);
  if (!await validBrokerResponse(response, rawResponse, config, {
    path,
    requestTimestamp: timestamp,
    nonce,
    requestBodyHash: bodyHash,
    now,
  })) throw new ApprovalBrokerError("approval_broker_response_invalid");
  if (!response.ok) throw new ApprovalBrokerError("approval_broker_unavailable");
  try {
    const parsed: unknown = JSON.parse(rawResponse);
    const parsedRecord = record(parsed);
    if (!parsedRecord) throw new Error("not_object");
    return parsedRecord;
  } catch {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
}

async function validBrokerResponse(
  response: Response,
  rawResponse: string,
  config: ApprovalBrokerConfig,
  binding: {
    path: string;
    requestTimestamp: string;
    nonce: string;
    requestBodyHash: string;
    now: () => number;
  },
): Promise<boolean> {
  const responseTimestamp = response.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const responseSignature = response.headers.get("x-ironwrap-internal-signature") ?? "";
  if (response.headers.get("x-ironwrap-internal-version") !== INTERNAL_VERSION ||
      response.headers.get("x-ironwrap-internal-key-id") !== config.keyId ||
      response.headers.get("x-ironwrap-internal-request-timestamp") !== binding.requestTimestamp ||
      response.headers.get("x-ironwrap-internal-nonce") !== binding.nonce ||
      !/^[0-9]{13}$/.test(responseTimestamp) || !/^[A-Za-z0-9_-]{32,128}$/.test(responseSignature)) return false;
  const timestampMs = Number(responseTimestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(binding.now() - timestampMs) > 60_000) return false;
  const expected = await hmacBase64Url(config.sharedSecret, internalResponseSigningInput({
    keyId: config.keyId,
    status: response.status,
    path: binding.path,
    requestTimestamp: binding.requestTimestamp,
    nonce: binding.nonce,
    requestBodyHash: binding.requestBodyHash,
    responseTimestamp,
    responseBodyHash: await sha256Hex(rawResponse),
  }));
  return constantTimeEqual(responseSignature, expected);
}

function parsePreviewPacket(response: Record<string, unknown>, input: {
  approvalRequestId: string;
  tenantId: string;
  runId: string;
  leadEnvelopeId: string;
  triageSummary: string;
  requestText: string;
}, now: number): BrokerPreviewPacket {
  assertOnlyKeys(response, ["approval_request_id", "tenant_id", "packet"]);
  const packet = record(response.packet);
  if (!packet) throw new ApprovalBrokerError("approval_broker_response_invalid");
  assertOnlyKeys(packet, [
    "request_kind", "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "target",
    "lead_envelope_id", "request_text", "write_args_json", "preview_json", "args_digest", "preview_digest",
    "dry_run_receipt", "expires_at", "run_id", "intent_fingerprint",
  ]);
  const target = record(packet.target);
  if (!target || response.approval_request_id !== input.approvalRequestId || response.tenant_id !== input.tenantId ||
      packet.request_kind !== "lead_triage" || packet.write_tool !== "request_mark_lead_triaged" ||
      packet.dry_run_tool !== "dry_run_mark_lead_triaged" || target.doctype !== "Lead Envelope" ||
      target.name !== input.leadEnvelopeId || packet.lead_envelope_id !== input.leadEnvelopeId ||
      packet.request_text !== input.requestText || packet.run_id !== input.runId) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  const strings = {
    agentRole: text(packet.agent_role, 3, 140),
    actorUser: text(packet.actor_user, 3, 140),
    siteId: text(packet.site_id, 1, 280),
    writeArgsJson: jsonText(packet.write_args_json),
    previewJson: jsonText(packet.preview_json),
    argsDigest: hexDigest(packet.args_digest),
    previewDigest: hexDigest(packet.preview_digest),
    dryRunReceipt: text(packet.dry_run_receipt, 32, 8192),
    expiresAt: futureIso(packet.expires_at, now),
    intentFingerprint: hexDigest(packet.intent_fingerprint),
  };
  if (Object.values(strings).some((value) => !value)) throw new ApprovalBrokerError("approval_broker_response_invalid");
  const writeArgs = parseObjectJson(strings.writeArgsJson!);
  if (!writeArgs || writeArgs.lead_envelope_id !== input.leadEnvelopeId ||
      writeArgs.triage_summary !== input.triageSummary || writeArgs.request_text !== input.requestText) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  return {
    approvalRequestId: input.approvalRequestId,
    tenantId: input.tenantId,
    requestKind: "lead_triage",
    writeTool: "request_mark_lead_triaged",
    dryRunTool: "dry_run_mark_lead_triaged",
    agentRole: strings.agentRole!,
    actorUser: strings.actorUser!,
    siteId: strings.siteId!,
    targetDoctype: "Lead Envelope",
    targetName: input.leadEnvelopeId,
    leadEnvelopeId: input.leadEnvelopeId,
    requestText: input.requestText,
    writeArgsJson: strings.writeArgsJson!,
    previewJson: strings.previewJson!,
    argsDigest: strings.argsDigest!,
    previewDigest: strings.previewDigest!,
    dryRunReceipt: strings.dryRunReceipt!,
    expiresAt: strings.expiresAt!,
    runId: input.runId,
    intentFingerprint: strings.intentFingerprint!,
  };
}

function parseExecutionOutcome(response: Record<string, unknown>, request: ApprovalRequestRecord): BrokerExecutionOutcome {
  assertOnlyKeys(response, ["outcome"]);
  const outcome = record(response.outcome);
  if (!outcome) throw new ApprovalBrokerError("approval_broker_response_invalid");
  assertOnlyKeys(outcome, ["state", "hermes_run_id", "result_json", "error_code"]);
  const state = outcome.state;
  if (state !== "executed" && state !== "failed" && state !== "audit_failed" && state !== "execution_uncertain") {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  const hermesRunId = nullableText(outcome.hermes_run_id, 8, 128);
  const resultJson = nullableJsonText(outcome.result_json);
  const errorCode = nullableErrorCode(outcome.error_code);
  if (state === "executed" && (!hermesRunId || hermesRunId !== request.run_id || !resultJson || errorCode)) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  if (state !== "executed" && !errorCode) throw new ApprovalBrokerError("approval_broker_response_invalid");
  return { state, hermesRunId, resultJson, errorCode };
}

function normalizedBrokerBaseUrl(raw: string | undefined, allowInsecureLocal: boolean): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function internalRequestSigningInput(input: {
  keyId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [INTERNAL_VERSION, input.keyId, input.method, input.path, input.timestamp, input.nonce, input.bodyHash].join("\n");
}

function internalResponseSigningInput(input: {
  keyId: string;
  status: number;
  path: string;
  requestTimestamp: string;
  nonce: string;
  requestBodyHash: string;
  responseTimestamp: string;
  responseBodyHash: string;
}): string {
  return [
    INTERNAL_VERSION, input.keyId, String(input.status), input.path, input.requestTimestamp, input.nonce,
    input.requestBodyHash, input.responseTimestamp, input.responseBodyHash,
  ].join("\n");
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return base64Url(signature);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new ApprovalBrokerError("approval_broker_response_invalid");
  }
  return body;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ApprovalBrokerError("approval_broker_response_invalid");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function nullableText(value: unknown, min: number, max: number): string | null {
  return value === null ? null : text(value, min, max);
}

function jsonText(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 16_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ? value : null;
  } catch {
    return null;
  }
}

function nullableJsonText(value: unknown): string | null {
  return value === null ? null : jsonText(value);
}

function hexDigest(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function futureIso(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now && parsed <= now + 15 * 60 * 1000
    ? new Date(parsed).toISOString()
    : null;
}

function parseObjectJson(value: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function nullableErrorCode(value: unknown): string | null {
  return value === null ? null : typeof value === "string" && /^[a-z][a-z0-9_:-]{2,119}$/.test(value) ? value : null;
}
