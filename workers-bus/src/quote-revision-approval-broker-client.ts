import type { AppEnv } from "./app-types.ts";
import { brokerApprovalPreviewJson } from "./approval-snapshot.ts";
import type { QuoteRevisionApprovalRequestRecord } from "./quote-revision-approval-store.ts";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_LEASE_SECONDS = 45;
const PREVIEW_PATH = "/v1/quote-revision/preview";
const EXECUTE_PATH = "/v1/quote-revision/execute";

export interface QuoteRevisionApprovalBrokerConfig {
  baseUrl: string;
  keyId: string;
  sharedSecret: string;
  timeoutMs: number;
  executionLeaseSeconds: number;
}

export interface QuoteRevisionBrokerPreviewPacket {
  approvalRequestId: string;
  tenantId: string;
  requestKind: "quote_revision";
  writeTool: "request_create_quote_revision";
  dryRunTool: "dry_run_quote_revision";
  agentRole: "estimator-assistant";
  actorUser: string;
  siteId: string;
  targetDoctype: "Customer Quote";
  targetName: string;
  roofJobId: string;
  sourceCustomerQuoteId: string;
  sourceQuoteVersion: number;
  sourceQuoteStatus: "Draft" | "Needs Review" | "Approved" | "Rejected" | "Expired";
  sourceQuoteModified: string;
  targetCustomerQuoteId: string;
  targetQuoteVersion: number;
  correctionReason: string;
  requestText: string;
  writeArgsJson: string;
  previewJson: string;
  argsDigest: string;
  previewDigest: string;
  receiptPreviewDigest: string;
  dryRunReceipt: string;
  expiresAt: string;
  runId: string;
  intentFingerprint: string;
}

export interface QuoteRevisionBrokerExecutionOutcome {
  state: "executed" | "failed" | "audit_failed" | "execution_uncertain";
  hermesRunId: string | null;
  resultJson: string | null;
  errorCode: string | null;
}

export class QuoteRevisionApprovalBrokerError extends Error {
  readonly code: "quote_revision_broker_not_configured" | "quote_revision_broker_unavailable" | "quote_revision_broker_response_invalid";

  constructor(code: QuoteRevisionApprovalBrokerError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface QuoteRevisionBrokerDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

export function quoteRevisionApprovalBrokerConfig(env: AppEnv): QuoteRevisionApprovalBrokerConfig | null {
  const baseUrl = normalizedBrokerBaseUrl(
    env.APP_QUOTE_REVISION_BROKER_URL,
    String(env.APP_ALLOW_INSECURE_LOCAL) === "true",
  );
  const keyId = env.APP_QUOTE_REVISION_BROKER_KEY_ID?.trim() ?? "";
  const sharedSecret = env.QUOTE_REVISION_BROKER_SHARED_SECRET?.trim() ?? "";
  const timeoutMs = boundedInt(env.APP_QUOTE_REVISION_BROKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  const executionLeaseSeconds = boundedInt(
    env.APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS,
    DEFAULT_EXECUTION_LEASE_SECONDS,
    15,
    120,
  );
  if (!baseUrl || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || sharedSecret.length < 32 ||
      timeoutMs === null || executionLeaseSeconds === null) return null;
  return { baseUrl, keyId, sharedSecret, timeoutMs, executionLeaseSeconds };
}

export async function previewQuoteRevisionApproval(
  env: AppEnv,
  input: {
    approvalRequestId: string;
    tenantId: string;
    runId: string;
    roofJobId: string;
    customerQuoteId: string;
    correctionReason: string;
    requestText: string;
    requestedByUserId: string;
    requestedByFrappeUser: string;
  },
  dependencies: QuoteRevisionBrokerDependencies = {},
): Promise<QuoteRevisionBrokerPreviewPacket> {
  const response = await callBroker(env, PREVIEW_PATH, {
    approval_request_id: input.approvalRequestId,
    tenant_id: input.tenantId,
    run_id: input.runId,
    roof_job_id: input.roofJobId,
    customer_quote_id: input.customerQuoteId,
    correction_reason: input.correctionReason,
    request_text: input.requestText,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
  }, dependencies);
  return parsePreviewPacket(response, input, (dependencies.now ?? Date.now)());
}

export async function executeQuoteRevisionApproval(
  env: AppEnv,
  request: QuoteRevisionApprovalRequestRecord,
  dependencies: QuoteRevisionBrokerDependencies = {},
): Promise<QuoteRevisionBrokerExecutionOutcome> {
  if (!request.approved_by_frappe_user || !request.decision_idempotency_key) {
    throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_response_invalid");
  }
  const response = await callBroker(env, EXECUTE_PATH, {
    approval_request: {
      approval_request_id: request.quote_revision_approval_id,
      tenant_id: request.tenant_id,
      request_kind: request.request_kind,
      write_tool: request.write_tool,
      dry_run_tool: request.dry_run_tool,
      agent_role: request.agent_role,
      actor_user: request.actor_user,
      site_id: request.site_id,
      target_doctype: request.target_doctype,
      target_name: request.target_name,
      roof_job_id: request.roof_job_id,
      customer_quote_id: request.source_customer_quote_id,
      correction_reason: request.correction_reason,
      request_text: request.request_text,
      write_args_json: request.write_args_json,
      preview_json: brokerApprovalPreviewJson(request.preview_json),
      args_digest: request.args_digest,
      preview_digest: request.preview_digest,
      receipt_preview_digest: request.receipt_preview_digest,
      dry_run_receipt: request.dry_run_receipt,
      expires_at: request.expires_at,
      run_id: request.run_id,
      approved_by_frappe_user: request.approved_by_frappe_user,
      decision_idempotency_key: request.decision_idempotency_key,
    },
  }, dependencies);
  return parseExecutionOutcome(response, request);
}

async function callBroker(
  env: AppEnv,
  path: typeof PREVIEW_PATH | typeof EXECUTE_PATH,
  body: Record<string, unknown>,
  dependencies: QuoteRevisionBrokerDependencies,
): Promise<Record<string, unknown>> {
  const config = quoteRevisionApprovalBrokerConfig(env);
  if (!config) throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_not_configured");
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
    throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_unavailable");
  } finally {
    clearTimeout(timer);
  }
  const rawResponse = await readBoundedResponse(response);
  const verified = await validBrokerResponse(response, rawResponse, config, {
    path,
    requestTimestamp: timestamp,
    nonce,
    requestBodyHash: bodyHash,
    now,
  });
  if (!verified) throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_response_invalid");
  if (!response.ok) throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_unavailable");
  try {
    const parsed: unknown = JSON.parse(rawResponse);
    const parsedRecord = record(parsed);
    if (!parsedRecord) throw new Error("not_object");
    return parsedRecord;
  } catch {
    throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_response_invalid");
  }
}

async function validBrokerResponse(
  response: Response,
  rawResponse: string,
  config: QuoteRevisionApprovalBrokerConfig,
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

function parsePreviewPacket(
  response: Record<string, unknown>,
  input: {
    approvalRequestId: string;
    tenantId: string;
    runId: string;
    roofJobId: string;
    customerQuoteId: string;
    correctionReason: string;
    requestText: string;
  },
  now: number,
): QuoteRevisionBrokerPreviewPacket {
  assertOnlyKeys(response, ["approval_request_id", "tenant_id", "packet"]);
  const packet = record(response.packet);
  if (!packet) invalid();
  assertOnlyKeys(packet, [
    "request_kind", "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "target",
    "roof_job_id", "customer_quote_id", "correction_reason", "request_text", "write_args_json",
    "preview_json", "args_digest", "preview_digest", "receipt_preview_digest", "dry_run_receipt",
    "expires_at", "run_id", "intent_fingerprint",
  ]);
  const target = record(packet.target);
  if (!target || response.approval_request_id !== input.approvalRequestId || response.tenant_id !== input.tenantId ||
      packet.request_kind !== "quote_revision" || packet.write_tool !== "request_create_quote_revision" ||
      packet.dry_run_tool !== "dry_run_quote_revision" || packet.agent_role !== "estimator-assistant" ||
      target.doctype !== "Customer Quote" || packet.roof_job_id !== input.roofJobId ||
      packet.customer_quote_id !== input.customerQuoteId || packet.correction_reason !== input.correctionReason ||
      packet.request_text !== input.requestText || packet.run_id !== input.runId) invalid();

  const targetName = idText(target.name);
  const actorUser = text(packet.actor_user, 3, 140);
  const siteId = text(packet.site_id, 1, 280);
  const writeArgsJson = jsonText(packet.write_args_json);
  const previewJson = jsonText(packet.preview_json);
  const argsDigest = hexDigest(packet.args_digest);
  const previewDigest = hexDigest(packet.preview_digest);
  const receiptPreviewDigest = hexDigest(packet.receipt_preview_digest);
  const dryRunReceipt = text(packet.dry_run_receipt, 32, 8192);
  const expiresAt = futureIso(packet.expires_at, now);
  const intentFingerprint = hexDigest(packet.intent_fingerprint);
  if (!targetName || !actorUser || !siteId || !writeArgsJson || !previewJson || !argsDigest || !previewDigest ||
      !receiptPreviewDigest || !dryRunReceipt || !expiresAt || !intentFingerprint || receiptPreviewDigest === previewDigest) invalid();

  const writeArgs = parseObjectJson(writeArgsJson);
  if (!writeArgs || !matchesExactWriteArgs(writeArgs, input)) invalid();
  const preview = parseSafePreview(previewJson, input, targetName);
  return {
    approvalRequestId: input.approvalRequestId,
    tenantId: input.tenantId,
    requestKind: "quote_revision",
    writeTool: "request_create_quote_revision",
    dryRunTool: "dry_run_quote_revision",
    agentRole: "estimator-assistant",
    actorUser,
    siteId,
    targetDoctype: "Customer Quote",
    targetName,
    roofJobId: input.roofJobId,
    sourceCustomerQuoteId: input.customerQuoteId,
    sourceQuoteVersion: preview.source.quoteVersion,
    sourceQuoteStatus: preview.source.status,
    sourceQuoteModified: preview.source.modified,
    targetCustomerQuoteId: targetName,
    targetQuoteVersion: preview.draft.quoteVersion,
    correctionReason: input.correctionReason,
    requestText: input.requestText,
    writeArgsJson,
    previewJson,
    argsDigest,
    previewDigest,
    receiptPreviewDigest,
    dryRunReceipt,
    expiresAt,
    runId: input.runId,
    intentFingerprint,
  };
}

function matchesExactWriteArgs(
  value: Record<string, unknown>,
  input: { roofJobId: string; customerQuoteId: string; correctionReason: string; requestText: string; runId: string },
): boolean {
  const keys = ["roof_job_id", "customer_quote_id", "correction_reason", "request_text", "approved_by", "run_id"];
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) &&
    value.roof_job_id === input.roofJobId && value.customer_quote_id === input.customerQuoteId &&
    value.correction_reason === input.correctionReason && value.request_text === input.requestText &&
    typeof value.approved_by === "string" && text(value.approved_by, 3, 140) !== null && value.run_id === input.runId;
}

function parseSafePreview(
  previewJson: string,
  input: { roofJobId: string; customerQuoteId: string; correctionReason: string },
  targetName: string,
): {
  source: {
    quoteVersion: number;
    status: "Draft" | "Needs Review" | "Approved" | "Rejected" | "Expired";
    modified: string;
  };
  draft: { quoteVersion: number };
} {
  const preview = parseObjectJson(previewJson);
  if (!preview) invalid();
  assertOnlyKeys(preview, ["would_write", "required_tool", "target", "append_only", "source", "observed_quote_count", "draft"]);
  const target = record(preview.target);
  const source = record(preview.source);
  const draft = record(preview.draft);
  if (!target || !source || !draft || preview.would_write !== false || preview.required_tool !== "request_create_quote_revision" ||
      preview.append_only !== true || !Number.isSafeInteger(preview.observed_quote_count) ||
      Number(preview.observed_quote_count) < 0 || Number(preview.observed_quote_count) >= 100) invalid();
  assertOnlyKeys(target, ["doctype", "name"]);
  assertOnlyKeys(source, ["customer_quote_id", "roof_job", "quote_version", "status", "modified"]);
  assertOnlyKeys(draft, ["customer_quote_id", "roof_job", "quote_version", "status", "supersedes", "correction_reason"]);
  const sourceVersion = positiveInteger(source.quote_version);
  const targetVersion = positiveInteger(draft.quote_version);
  const sourceStatus = quoteStatus(source.status);
  const sourceModified = safeIso(source.modified);
  if (!sourceVersion || !targetVersion || !sourceStatus || !sourceModified ||
      target.doctype !== "Customer Quote" || target.name !== targetName ||
      source.customer_quote_id !== input.customerQuoteId || source.roof_job !== input.roofJobId ||
      draft.customer_quote_id !== targetName || draft.roof_job !== input.roofJobId ||
      draft.status !== "Draft" || draft.supersedes !== input.customerQuoteId ||
      draft.correction_reason !== input.correctionReason || targetVersion <= sourceVersion) invalid();
  return {
    source: { quoteVersion: sourceVersion, status: sourceStatus, modified: sourceModified },
    draft: { quoteVersion: targetVersion },
  };
}

function parseExecutionOutcome(
  response: Record<string, unknown>,
  request: QuoteRevisionApprovalRequestRecord,
): QuoteRevisionBrokerExecutionOutcome {
  assertOnlyKeys(response, ["outcome"]);
  const outcome = record(response.outcome);
  if (!outcome) invalid();
  assertOnlyKeys(outcome, ["state", "hermes_run_id", "result_json", "error_code"]);
  const state = outcome.state;
  if (state !== "executed" && state !== "failed" && state !== "audit_failed" && state !== "execution_uncertain") invalid();
  const hermesRunId = nullableText(outcome.hermes_run_id, 8, 128);
  const errorCode = nullableErrorCode(outcome.error_code);
  if (state === "executed") {
    const rawResult = nullableJsonText(outcome.result_json);
    if (!hermesRunId || hermesRunId !== request.run_id || !rawResult || errorCode) invalid();
    return {
      state,
      hermesRunId,
      resultJson: safeExecutedResult(rawResult, request),
      errorCode: null,
    };
  }
  if (outcome.result_json !== null || !errorCode || (hermesRunId !== null && hermesRunId !== request.run_id)) invalid();
  return { state, hermesRunId, resultJson: null, errorCode };
}

function safeExecutedResult(raw: string, request: QuoteRevisionApprovalRequestRecord): string {
  const parsed = parseObjectJson(raw);
  if (!parsed) invalid();
  assertOnlyKeys(parsed, [
    "run_id", "customer_quote_id", "roof_job_id", "source_customer_quote_id", "quote_version", "supersedes",
    "created", "audit_finalized", "replayed", "append_only", "commercial_fields_mutated",
  ]);
  if (parsed.run_id !== request.run_id || parsed.customer_quote_id !== request.target_customer_quote_id ||
      parsed.roof_job_id !== request.roof_job_id || parsed.source_customer_quote_id !== request.source_customer_quote_id ||
      parsed.quote_version !== request.target_quote_version || parsed.supersedes !== request.source_customer_quote_id ||
      parsed.created !== true || parsed.audit_finalized !== true || parsed.append_only !== true ||
      parsed.commercial_fields_mutated !== false || typeof parsed.replayed !== "boolean") invalid();
  return JSON.stringify({
    run_id: request.run_id,
    customer_quote_id: request.target_customer_quote_id,
    quote_version: request.target_quote_version,
    supersedes: request.source_customer_quote_id,
    created: true,
    audit_finalized: true,
    customer_notified: false,
    commercial_terms_copied: false,
    proposal_sent: false,
    accounting_mutated: false,
  });
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
  if (Number(response.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) invalid();
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) invalid();
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
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function idText(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,140}$/.test(value) ? value : null;
}

function nullableText(value: unknown, min: number, max: number): string | null {
  return value === null ? null : text(value, min, max);
}

function jsonText(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 16_000) return null;
  return parseObjectJson(value) ? value : null;
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

function safeIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseObjectJson(value: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function quoteStatus(value: unknown): QuoteRevisionBrokerPreviewPacket["sourceQuoteStatus"] | null {
  return value === "Draft" || value === "Needs Review" || value === "Approved" || value === "Rejected" || value === "Expired"
    ? value
    : null;
}

function nullableErrorCode(value: unknown): string | null {
  return value === null ? null : typeof value === "string" && /^[a-z][a-z0-9_:-]{2,119}$/.test(value) ? value : null;
}

function invalid(): never {
  throw new QuoteRevisionApprovalBrokerError("quote_revision_broker_response_invalid");
}
