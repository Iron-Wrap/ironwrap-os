import type { AppEnv } from "./app-types.ts";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_LEASE_SECONDS = 45;
const PREVIEW_PATH = "/v1/production-schedule/preview";
const EXECUTE_PATH = "/v1/production-schedule/execute";

type ProductionScheduleBrokerEnv = AppEnv & {
  APP_PRODUCTION_SCHEDULE_BROKER_URL?: string;
  APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID?: string;
  APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS?: string;
  APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS?: string;
  PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET?: string;
};

export interface ProductionScheduleApprovalBrokerConfig {
  baseUrl: string;
  keyId: string;
  sharedSecret: string;
  timeoutMs: number;
  executionLeaseSeconds: number;
}

export interface ProductionScheduleGatePreview {
  required: true;
  stateEligible: true;
}

export interface ProductionScheduleBrokerPreviewPacket {
  approvalRequestId: string;
  tenantId: string;
  requestKind: "production_schedule";
  writeTool: "request_create_job_assignment";
  dryRunTool: "dry_run_job_assignment";
  agentRole: "production-controller";
  actorUser: string;
  siteId: string;
  targetDoctype: "Job Assignment";
  targetName: string;
  roofJobId: string;
  crewProfileId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
  requestText: string;
  productionScheduleGatePreview: ProductionScheduleGatePreview;
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

export interface ProductionScheduleApprovalRequestRecord {
  production_schedule_approval_id: string;
  tenant_id: string;
  request_kind: "production_schedule";
  write_tool: "request_create_job_assignment";
  dry_run_tool: "dry_run_job_assignment";
  agent_role: "production-controller";
  actor_user: string;
  site_id: string;
  target_doctype: "Job Assignment";
  target_name: string;
  roof_job_id: string;
  crew_profile_id: string;
  scheduled_start: string;
  scheduled_end: string | null;
  supersedes_assignment_id: string | null;
  correction_reason: string | null;
  request_text: string;
  write_args_json: string;
  preview_json: string;
  args_digest: string;
  preview_digest: string;
  receipt_preview_digest: string;
  dry_run_receipt: string;
  expires_at: string;
  run_id: string;
  approved_by_frappe_user: string | null;
  decision_idempotency_key: string | null;
}

export interface ProductionScheduleBrokerExecutionOutcome {
  state: "executed" | "failed" | "audit_failed" | "execution_uncertain";
  hermesRunId: string | null;
  resultJson: string | null;
  errorCode: string | null;
}

export class ProductionScheduleApprovalBrokerError extends Error {
  readonly code:
    | "production_schedule_broker_not_configured"
    | "production_schedule_broker_unavailable"
    | "production_schedule_broker_response_invalid";

  constructor(code: ProductionScheduleApprovalBrokerError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface ProductionScheduleBrokerDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

export function productionScheduleApprovalBrokerConfig(
  env: AppEnv,
): ProductionScheduleApprovalBrokerConfig | null {
  const configured = env as ProductionScheduleBrokerEnv;
  const baseUrl = normalizedBrokerBaseUrl(
    configured.APP_PRODUCTION_SCHEDULE_BROKER_URL,
    String(configured.APP_ALLOW_INSECURE_LOCAL) === "true",
  );
  const keyId = configured.APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID?.trim() ?? "";
  const sharedSecret = configured.PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET?.trim() ?? "";
  const timeoutMs = boundedInt(
    configured.APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    30_000,
  );
  const executionLeaseSeconds = boundedInt(
    configured.APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS,
    DEFAULT_EXECUTION_LEASE_SECONDS,
    15,
    120,
  );
  if (!baseUrl || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || sharedSecret.length < 32 ||
      timeoutMs === null || executionLeaseSeconds === null) return null;
  return { baseUrl, keyId, sharedSecret, timeoutMs, executionLeaseSeconds };
}

export async function previewProductionScheduleApproval(
  env: AppEnv,
  input: {
    approvalRequestId: string;
    tenantId: string;
    runId: string;
    roofJobId: string;
    crewProfileId: string;
    scheduledStart: string;
    scheduledEnd?: string | null;
    supersedesAssignmentId?: string | null;
    correctionReason?: string | null;
    requestText: string;
    requestedByUserId: string;
    requestedByFrappeUser: string;
  },
  dependencies: ProductionScheduleBrokerDependencies = {},
): Promise<ProductionScheduleBrokerPreviewPacket> {
  const normalized = normalizePreviewInput(input);
  const response = await callBroker(env, PREVIEW_PATH, {
    approval_request_id: normalized.approvalRequestId,
    tenant_id: normalized.tenantId,
    run_id: normalized.runId,
    roof_job_id: normalized.roofJobId,
    crew_profile_id: normalized.crewProfileId,
    scheduled_start: normalized.scheduledStart,
    scheduled_end: normalized.scheduledEnd,
    supersedes_assignment_id: normalized.supersedesAssignmentId,
    correction_reason: normalized.correctionReason,
    request_text: normalized.requestText,
    requested_by_user_id: normalized.requestedByUserId,
    requested_by_frappe_user: normalized.requestedByFrappeUser,
  }, dependencies);
  return parsePreviewPacket(response, normalized, (dependencies.now ?? Date.now)());
}

export async function executeProductionScheduleApproval(
  env: AppEnv,
  request: ProductionScheduleApprovalRequestRecord,
  dependencies: ProductionScheduleBrokerDependencies = {},
): Promise<ProductionScheduleBrokerExecutionOutcome> {
  if (!request.approved_by_frappe_user || !request.decision_idempotency_key) {
    throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_response_invalid");
  }
  const response = await callBroker(env, EXECUTE_PATH, {
    approval_request: {
      approval_request_id: request.production_schedule_approval_id,
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
      crew_profile_id: request.crew_profile_id,
      scheduled_start: request.scheduled_start,
      scheduled_end: request.scheduled_end,
      supersedes_assignment_id: request.supersedes_assignment_id,
      correction_reason: request.correction_reason,
      request_text: request.request_text,
      write_args_json: request.write_args_json,
      preview_json: request.preview_json,
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
  dependencies: ProductionScheduleBrokerDependencies,
): Promise<Record<string, unknown>> {
  const config = productionScheduleApprovalBrokerConfig(env);
  if (!config) throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_not_configured");
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
    throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_unavailable");
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
  if (!verified) throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_response_invalid");
  if (!response.ok) throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_unavailable");
  try {
    const parsed = record(JSON.parse(rawResponse));
    if (!parsed) throw new Error("not_object");
    return parsed;
  } catch {
    throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_response_invalid");
  }
}

async function validBrokerResponse(
  response: Response,
  rawResponse: string,
  config: ProductionScheduleApprovalBrokerConfig,
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
  input: NormalizedPreviewInput,
  now: number,
): ProductionScheduleBrokerPreviewPacket {
  assertOnlyKeys(response, ["approval_request_id", "tenant_id", "packet"]);
  const packet = record(response.packet);
  if (!packet) invalid();
  assertOnlyKeys(packet, [
    "request_kind", "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "target",
    "roof_job_id", "crew_profile_id", "scheduled_start", "scheduled_end", "supersedes_assignment_id",
    "correction_reason", "request_text", "write_args_json", "preview_json", "args_digest", "preview_digest",
    "receipt_preview_digest", "dry_run_receipt", "expires_at", "run_id", "intent_fingerprint",
  ]);
  const target = record(packet.target);
  if (!target || response.approval_request_id !== input.approvalRequestId || response.tenant_id !== input.tenantId ||
      packet.request_kind !== "production_schedule" || packet.write_tool !== "request_create_job_assignment" ||
      packet.dry_run_tool !== "dry_run_job_assignment" || packet.agent_role !== "production-controller" ||
      target.doctype !== "Job Assignment" || packet.roof_job_id !== input.roofJobId ||
      packet.crew_profile_id !== input.crewProfileId || packet.scheduled_start !== input.scheduledStart ||
      packet.scheduled_end !== input.scheduledEnd || packet.supersedes_assignment_id !== input.supersedesAssignmentId ||
      packet.correction_reason !== input.correctionReason || packet.request_text !== input.requestText ||
      packet.run_id !== input.runId) invalid();

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
  if (!writeArgs || !matchesExactWriteArgs(writeArgs, input, actorUser)) invalid();
  const productionScheduleGatePreview = parseSafePreview(previewJson, input, targetName);
  return {
    approvalRequestId: input.approvalRequestId,
    tenantId: input.tenantId,
    requestKind: "production_schedule",
    writeTool: "request_create_job_assignment",
    dryRunTool: "dry_run_job_assignment",
    agentRole: "production-controller",
    actorUser,
    siteId,
    targetDoctype: "Job Assignment",
    targetName,
    roofJobId: input.roofJobId,
    crewProfileId: input.crewProfileId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    supersedesAssignmentId: input.supersedesAssignmentId,
    correctionReason: input.correctionReason,
    requestText: input.requestText,
    productionScheduleGatePreview,
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
  input: NormalizedPreviewInput,
  actorUser: string,
): boolean {
  const keys = [
    "roof_job_id", "assignment_type", "status", "crew_profile_id", "scheduled_start", "assigned_by", "notes",
    "request_text", "approved_by", "run_id",
    ...(input.scheduledEnd ? ["scheduled_end"] : []),
    ...(input.supersedesAssignmentId ? ["supersedes", "correction_reason"] : []),
  ];
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) &&
    value.roof_job_id === input.roofJobId && value.assignment_type === "Production" && value.status === "Assigned" &&
    value.crew_profile_id === input.crewProfileId && value.scheduled_start === input.scheduledStart &&
    value.assigned_by === actorUser && value.notes === "" && value.request_text === input.requestText &&
    text(value.approved_by, 3, 140) !== null && value.run_id === input.runId &&
    (input.scheduledEnd === null || value.scheduled_end === input.scheduledEnd) &&
    (input.supersedesAssignmentId === null ||
      (value.supersedes === input.supersedesAssignmentId && value.correction_reason === input.correctionReason));
}

function parseSafePreview(
  previewJson: string,
  input: NormalizedPreviewInput,
  targetName: string,
): ProductionScheduleGatePreview {
  const preview = parseObjectJson(previewJson);
  if (!preview) invalid();
  assertOnlyKeys(preview, ["would_write", "append_only", "target", "assignment", "production_schedule_gate_preview"]);
  const target = record(preview.target);
  const assignment = record(preview.assignment);
  if (!target || !assignment || preview.would_write !== false || preview.append_only !== true ||
      target.doctype !== "Job Assignment" || target.name !== targetName ||
      !matchesExactSafeAssignment(assignment, input, targetName)) invalid();
  return parseEligibleGatePreview(preview.production_schedule_gate_preview);
}

function matchesExactSafeAssignment(
  assignment: Record<string, unknown>,
  input: NormalizedPreviewInput,
  targetName: string,
): boolean {
  const keys = [
    "assignment_id", "roof_job_id", "crew_profile_id", "scheduled_start", "scheduled_end",
    "supersedes_assignment_id", "correction_reason",
  ];
  return Object.keys(assignment).length === keys.length && keys.every((key) => Object.hasOwn(assignment, key)) &&
    assignment.assignment_id === targetName && assignment.roof_job_id === input.roofJobId &&
    assignment.crew_profile_id === input.crewProfileId && assignment.scheduled_start === input.scheduledStart &&
    assignment.scheduled_end === input.scheduledEnd &&
    assignment.supersedes_assignment_id === input.supersedesAssignmentId &&
    assignment.correction_reason === input.correctionReason;
}

function parseEligibleGatePreview(value: unknown): ProductionScheduleGatePreview {
  const preview = record(value);
  if (!preview) invalid();
  assertOnlyKeys(preview, ["required", "state_eligible"]);
  if (preview.required !== true || preview.state_eligible !== true) invalid();
  return { required: true, stateEligible: true };
}

function parseExecutionOutcome(
  response: Record<string, unknown>,
  request: ProductionScheduleApprovalRequestRecord,
): ProductionScheduleBrokerExecutionOutcome {
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

function safeExecutedResult(raw: string, request: ProductionScheduleApprovalRequestRecord): string {
  const parsed = parseObjectJson(raw);
  if (!parsed) invalid();
  assertOnlyKeys(parsed, [
    "run_id", "assignment_id", "roof_job_id", "crew_profile_id", "scheduled_start", "scheduled_end",
    "supersedes_assignment_id", "created", "audit_finalized", "replayed", "append_only",
    "assigned_user_mutated", "crew_notified", "customer_notified", "accounting_mutated",
  ]);
  if (parsed.run_id !== request.run_id || parsed.assignment_id !== request.target_name ||
      parsed.roof_job_id !== request.roof_job_id || parsed.crew_profile_id !== request.crew_profile_id ||
      parsed.scheduled_start !== request.scheduled_start || parsed.scheduled_end !== request.scheduled_end ||
      parsed.supersedes_assignment_id !== request.supersedes_assignment_id || parsed.created !== true ||
      parsed.audit_finalized !== true || parsed.append_only !== true || typeof parsed.replayed !== "boolean" ||
      parsed.assigned_user_mutated !== false || parsed.crew_notified !== false || parsed.customer_notified !== false ||
      parsed.accounting_mutated !== false) invalid();
  return JSON.stringify({
    run_id: request.run_id,
    assignment_id: request.target_name,
    roof_job_id: request.roof_job_id,
    crew_profile_id: request.crew_profile_id,
    scheduled_start: request.scheduled_start,
    scheduled_end: request.scheduled_end,
    supersedes_assignment_id: request.supersedes_assignment_id,
    created: true,
    audit_finalized: true,
    crew_notified: false,
    customer_notified: false,
    accounting_mutated: false,
  });
}

interface NormalizedPreviewInput {
  approvalRequestId: string;
  tenantId: string;
  runId: string;
  roofJobId: string;
  crewProfileId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
  requestText: string;
  requestedByUserId: string;
  requestedByFrappeUser: string;
}

function normalizePreviewInput(input: {
  approvalRequestId: string;
  tenantId: string;
  runId: string;
  roofJobId: string;
  crewProfileId: string;
  scheduledStart: string;
  scheduledEnd?: string | null;
  supersedesAssignmentId?: string | null;
  correctionReason?: string | null;
  requestText: string;
  requestedByUserId: string;
  requestedByFrappeUser: string;
}): NormalizedPreviewInput {
  const approvalRequestId = idText(input.approvalRequestId);
  const tenantId = idText(input.tenantId);
  const runId = text(input.runId, 8, 128);
  const roofJobId = idText(input.roofJobId);
  const crewProfileId = idText(input.crewProfileId);
  const scheduledStart = safeIso(input.scheduledStart);
  const scheduledEnd = input.scheduledEnd == null ? null : safeIso(input.scheduledEnd);
  const supersedesAssignmentId = input.supersedesAssignmentId == null ? null : idText(input.supersedesAssignmentId);
  const correctionReason = input.correctionReason == null ? null : text(input.correctionReason, 1, 2_000);
  const requestText = text(input.requestText, 1, 4_000);
  const requestedByUserId = idText(input.requestedByUserId);
  const requestedByFrappeUser = text(input.requestedByFrappeUser, 3, 140);
  if (!approvalRequestId || !tenantId || !runId || !roofJobId || !crewProfileId || !scheduledStart ||
      (input.scheduledEnd != null && !scheduledEnd) || (scheduledEnd && Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) ||
      (input.supersedesAssignmentId != null && !supersedesAssignmentId) ||
      (input.correctionReason != null && !correctionReason) ||
      (supersedesAssignmentId === null) !== (correctionReason === null) || !requestText || !requestedByUserId ||
      !requestedByFrappeUser) invalid();
  return {
    approvalRequestId,
    tenantId,
    runId,
    roofJobId,
    crewProfileId,
    scheduledStart,
    scheduledEnd,
    supersedesAssignmentId,
    correctionReason,
    requestText,
    requestedByUserId,
    requestedByFrappeUser,
  };
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

function nullableErrorCode(value: unknown): string | null {
  return value === null ? null : typeof value === "string" && /^[a-z][a-z0-9_:-]{2,119}$/.test(value) ? value : null;
}

function invalid(): never {
  throw new ProductionScheduleApprovalBrokerError("production_schedule_broker_response_invalid");
}
