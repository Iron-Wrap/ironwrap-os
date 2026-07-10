import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  approvedArgs,
  canonicalJson,
  digest,
  parseToolPayload,
  semanticPreview,
  signApprovalReceipt,
  verifyDryRunReceipt,
} from "./approval-contract.mjs";
import { configFromEnv } from "./server.mjs";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_APPROVAL_LIFETIME_MS = 5 * 60_000;
const LEAD_TRIAGE_PREVIEW_PATH = "/v1/lead-triage/preview";
const LEAD_TRIAGE_EXECUTE_PATH = "/v1/lead-triage/execute";
const LEAD_TRIAGE_WRITE_TOOL = "request_mark_lead_triaged";
const LEAD_TRIAGE_DRY_RUN_TOOL = "dry_run_mark_lead_triaged";

/**
 * Private approval policy enforcement point. It intentionally exposes only the
 * lead-triage preview and execute vertical. It is never an Internet-facing MCP
 * gateway and it never returns an approval receipt to its caller.
 */
export function createApprovalBroker({ config, invokeMcp, now = () => Date.now(), nonceStore }) {
  const nonces = nonceStore ?? createNonceStore({ now, ttlMs: config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS });
  const maxClockSkewMs = config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS;
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;

  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || ![LEAD_TRIAGE_PREVIEW_PATH, LEAD_TRIAGE_EXECUTE_PATH].includes(path)) {
        return json({ error: "not_found" }, 404);
      }
      const inbound = await verifyInternalRequest(request, config, { now, nonceStore: nonces, maxClockSkewMs, maxBodyBytes });
      if (!inbound.ok) return json({ error: inbound.error }, inbound.status);
      const respond = (status, body) => signedJson(status, body, config, inbound.binding, now);
      if (!inbound.body) return respond(400, { error: "invalid_json" });

      if (path === LEAD_TRIAGE_PREVIEW_PATH) {
        try {
          return respond(200, await previewLeadTriage(inbound.body, config, invokeMcp, now));
        } catch (error) {
          return respond(422, { error: safeBrokerError(error, "broker_preview_rejected") });
        }
      }

      try {
        return respond(200, await executeLeadTriage(inbound.body, config, invokeMcp, now));
      } catch (error) {
        return respond(200, {
          outcome: { state: "failed", error_code: safeBrokerError(error, "broker_contract_invalid") },
        });
      }
    },
  };
}

export function createNonceStore({ now = () => Date.now(), ttlMs = MAX_CLOCK_SKEW_MS } = {}) {
  const seen = new Map();
  return {
    claim(key) {
      const current = now();
      for (const [candidate, expiresAt] of seen) if (expiresAt <= current) seen.delete(candidate);
      if (seen.has(key)) return false;
      seen.set(key, current + ttlMs);
      return true;
    },
  };
}

export async function verifyInternalRequest(request, config, {
  now = () => Date.now(),
  nonceStore = createNonceStore({ now }),
  maxClockSkewMs = MAX_CLOCK_SKEW_MS,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  const keyId = request.headers.get("x-ironwrap-internal-key-id") ?? "";
  const timestamp = request.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const nonce = request.headers.get("x-ironwrap-internal-nonce") ?? "";
  const signature = request.headers.get("x-ironwrap-internal-signature") ?? "";
  if (request.headers.get("x-ironwrap-internal-version") !== INTERNAL_VERSION || keyId !== config.keyId) {
    return { ok: false, status: 401, error: "internal_auth_invalid" };
  }
  if (!/^[0-9]{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[A-Za-z0-9_-]{32,128}$/.test(signature)) {
    return { ok: false, status: 401, error: "internal_auth_invalid" };
  }
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now() - timestampMs) > maxClockSkewMs) {
    return { ok: false, status: 401, error: "internal_auth_stale" };
  }
  if (Number(request.headers.get("content-length") ?? "0") > maxBodyBytes) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) return { ok: false, status: 413, error: "payload_too_large" };
  const path = new URL(request.url).pathname;
  const bodyHash = sha256Hex(rawBody);
  const expected = hmacBase64Url(config.sharedSecret, internalRequestSigningInput({
    keyId,
    method: request.method,
    path,
    timestamp,
    nonce,
    bodyHash,
  }));
  if (!constantTimeEqual(signature, expected)) return { ok: false, status: 401, error: "internal_auth_invalid" };
  if (!nonceStore.claim(`${keyId}:${nonce}`)) return { ok: false, status: 409, error: "internal_replay_detected" };
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      ok: true,
      body: null,
      binding: { keyId, path, timestamp, nonce, bodyHash },
    };
  }
  if (!isRecord(body)) {
    return {
      ok: true,
      body: null,
      binding: { keyId, path, timestamp, nonce, bodyHash },
    };
  }
  return {
    ok: true,
    body,
    binding: { keyId, path, timestamp, nonce, bodyHash },
  };
}

export function internalRequestSigningInput({ keyId, method, path, timestamp, nonce, bodyHash }) {
  return [INTERNAL_VERSION, keyId, method, path, timestamp, nonce, bodyHash].join("\n");
}

export function internalResponseSigningInput({ keyId, status, path, requestTimestamp, nonce, requestBodyHash, responseTimestamp, responseBodyHash }) {
  return [
    INTERNAL_VERSION,
    keyId,
    String(status),
    path,
    requestTimestamp,
    nonce,
    requestBodyHash,
    responseTimestamp,
    responseBodyHash,
  ].join("\n");
}

export function hmacBase64Url(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function brokerConfigFromEnv(env = process.env) {
  const runtime = configFromEnv(env);
  const privateKeyPath = requiredText(env.HERMES_APPROVAL_PRIVATE_KEY_FILE, "HERMES_APPROVAL_PRIVATE_KEY_FILE");
  const privateKey = readFileSync(privateKeyPath, "utf8");
  const tenantId = requiredText(env.APPROVAL_BROKER_TENANT_ID, "APPROVAL_BROKER_TENANT_ID");
  const sharedSecret = requiredText(env.APPROVAL_BROKER_SHARED_SECRET, "APPROVAL_BROKER_SHARED_SECRET");
  const keyId = requiredText(env.APPROVAL_BROKER_KEY_ID, "APPROVAL_BROKER_KEY_ID");
  if (sharedSecret.length < 32) throw new Error("approval_broker_shared_secret_too_short");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("approval_broker_key_id_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tenantId)) throw new Error("approval_broker_tenant_invalid");
  if (!runtime.writeEnabled || runtime.agentRole !== "lead-concierge") {
    throw new Error("approval_broker_requires_lead_concierge_write_runtime");
  }
  const expectedSiteId = digest({ frappe_base_url: runtime.baseUrl });
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const configuredPublic = createPublicKey(runtime.approvalPublicKey).export({ type: "spki", format: "der" });
  if (!timingSafeEqual(privatePublic, configuredPublic)) throw new Error("approval_broker_keypair_mismatch");
  return {
    tenantId,
    keyId,
    sharedSecret,
    approvalPrivateKey: privateKey,
    dryRunSigningKey: runtime.dryRunSigningKey,
    approverId: runtime.approverId,
    actorUser: runtime.actorUser,
    agentRole: runtime.agentRole,
    siteId: expectedSiteId,
    mcpEnv: mcpChildEnvironment(env, runtime),
    requestTimeoutMs: runtime.requestTimeoutMs,
    maxClockSkewMs: parseBoundedMs(env.APPROVAL_BROKER_MAX_CLOCK_SKEW_MS, MAX_CLOCK_SKEW_MS, 10_000, 120_000),
    maxApprovalLifetimeMs: parseBoundedMs(
      env.APPROVAL_BROKER_MAX_APPROVAL_LIFETIME_MS,
      MAX_APPROVAL_LIFETIME_MS,
      30_000,
      10 * 60_000,
    ),
  };
}

export function createStdioMcpInvoker(config) {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  return async (name, args) => {
    const client = new Client({ name: "ironwrap-approval-broker", version: "0.1.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: config.mcpEnv,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: config.requestTimeoutMs });
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

async function previewLeadTriage(body, config, invokeMcp, now) {
  const input = parsePreviewInput(body, config);
  const result = await invokeMcp(LEAD_TRIAGE_DRY_RUN_TOOL, {
    lead_envelope_id: input.leadEnvelopeId,
    triage_summary: input.triageSummary,
  });
  const payload = parseToolPayload(result);
  const approval = requiredObject(payload.approval_request, "broker_dry_run_receipt_missing");
  const preview = { ...payload };
  delete preview.approval_request;
  const dryRunReceipt = requiredText(approval.dry_run_receipt, "broker_dry_run_receipt_missing");
  const expiresAt = requiredFutureIso(approval.expires_at, now, "broker_dry_run_expired");
  const previewDigest = digest(semanticPreview(preview));
  const baseArgs = { lead_envelope_id: input.leadEnvelopeId, triage_summary: input.triageSummary };
  assertExact(approval.write_tool, LEAD_TRIAGE_WRITE_TOOL, "broker_dry_run_tool_mismatch");
  assertExact(approval.dry_run_tool, LEAD_TRIAGE_DRY_RUN_TOOL, "broker_dry_run_tool_mismatch");
  assertExact(approval.agent_role, config.agentRole, "broker_dry_run_role_mismatch");
  assertExact(approval.actor_user, config.actorUser, "broker_dry_run_actor_mismatch");
  assertExact(approval.site_id, config.siteId, "broker_dry_run_site_mismatch");
  assertExact(approval.args_digest, digest(baseArgs), "broker_dry_run_args_digest_mismatch");
  assertExact(approval.preview_digest, previewDigest, "broker_dry_run_preview_digest_mismatch");
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: LEAD_TRIAGE_DRY_RUN_TOOL,
    write_tool: LEAD_TRIAGE_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(baseArgs),
    preview_digest: previewDigest,
  });

  const writeArgs = {
    lead_envelope_id: input.leadEnvelopeId,
    triage_summary: input.triageSummary,
    request_text: input.requestText,
    approved_by: config.approverId,
    run_id: input.runId,
  };
  const writeArgsJson = canonicalJson(writeArgs);
  const argsDigest = digest(approvedArgs(writeArgs));
  const previewJson = canonicalJson(preview);
  const intentFingerprint = digest({
    request_kind: "lead_triage",
    tenant_id: input.tenantId,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
    write_tool: LEAD_TRIAGE_WRITE_TOOL,
    dry_run_tool: LEAD_TRIAGE_DRY_RUN_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    target: { doctype: "Lead Envelope", name: input.leadEnvelopeId },
    write_args: writeArgs,
    args_digest: argsDigest,
    preview_digest: previewDigest,
  });
  return {
    approval_request_id: input.approvalRequestId,
    tenant_id: input.tenantId,
    packet: {
      request_kind: "lead_triage",
      write_tool: LEAD_TRIAGE_WRITE_TOOL,
      dry_run_tool: LEAD_TRIAGE_DRY_RUN_TOOL,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      target: { doctype: "Lead Envelope", name: input.leadEnvelopeId },
      lead_envelope_id: input.leadEnvelopeId,
      request_text: input.requestText,
      write_args_json: writeArgsJson,
      preview_json: previewJson,
      args_digest: argsDigest,
      preview_digest: previewDigest,
      dry_run_receipt: dryRunReceipt,
      expires_at: expiresAt,
      run_id: input.runId,
      intent_fingerprint: intentFingerprint,
    },
  };
}

async function executeLeadTriage(body, config, invokeMcp, now) {
  const record = parseExecutionInput(body, config, now);
  const approvalExpiresAt = boundedApprovalExpiry(record.expiresAt, now, config.maxApprovalLifetimeMs ?? MAX_APPROVAL_LIFETIME_MS);
  const approvalReceipt = signApprovalReceipt(config.approvalPrivateKey, {
    write_tool: LEAD_TRIAGE_WRITE_TOOL,
    dry_run_receipt: record.dryRunReceipt,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    run_id: record.runId,
    approved_by: config.approverId,
    args_digest: record.argsDigest,
    issued_at: new Date(now()).toISOString(),
    expires_at: approvalExpiresAt,
  });

  try {
    const result = await invokeMcp(LEAD_TRIAGE_WRITE_TOOL, {
      ...record.writeArgs,
      dry_run_receipt: record.dryRunReceipt,
      approval_receipt: approvalReceipt,
    });
    const payload = parseToolPayload(result);
    const safeResult = safeExecutedResult(payload, record);
    return {
      outcome: {
        state: "executed",
        hermes_run_id: record.runId,
        result_json: canonicalJson(safeResult),
        error_code: null,
      },
    };
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("audit_failed") || message.includes("audit_finalization")) {
      return { outcome: { state: "audit_failed", hermes_run_id: record.runId, result_json: null, error_code: "audit_finalization_failed" } };
    }
    return { outcome: { state: "execution_uncertain", hermes_run_id: record.runId, result_json: null, error_code: "broker_mcp_call_ambiguous" } };
  }
}

function parsePreviewInput(body, config) {
  assertOnlyKeys(body, [
    "approval_request_id", "tenant_id", "run_id", "lead_envelope_id", "triage_summary", "request_text",
    "requested_by_user_id", "requested_by_frappe_user",
  ]);
  const tenantId = boundedText(body.tenant_id, 2, 64, "broker_tenant_invalid");
  assertExact(tenantId, config.tenantId, "broker_tenant_mismatch");
  return {
    approvalRequestId: idText(body.approval_request_id, "broker_approval_request_id_invalid"),
    tenantId,
    runId: idText(body.run_id, "broker_run_id_invalid"),
    leadEnvelopeId: idText(body.lead_envelope_id, "broker_lead_envelope_id_invalid"),
    triageSummary: boundedText(body.triage_summary, 1, 2000, "broker_triage_summary_invalid"),
    requestText: boundedText(body.request_text, 1, 4000, "broker_request_text_invalid"),
    requestedByUserId: idText(body.requested_by_user_id, "broker_requested_by_invalid"),
    requestedByFrappeUser: boundedText(body.requested_by_frappe_user, 3, 140, "broker_requested_frappe_user_invalid"),
  };
}

function parseExecutionInput(body, config, now) {
  assertOnlyKeys(body, ["approval_request"]);
  const record = requiredObject(body.approval_request, "broker_execution_record_invalid");
  assertOnlyKeys(record, [
    "approval_request_id", "tenant_id", "request_kind", "write_tool", "dry_run_tool", "agent_role",
    "actor_user", "site_id", "target_doctype", "target_name", "lead_envelope_id", "request_text",
    "write_args_json", "preview_json", "args_digest", "preview_digest", "dry_run_receipt", "expires_at",
    "run_id", "approved_by_frappe_user", "decision_idempotency_key",
  ]);
  assertExact(record.tenant_id, config.tenantId, "broker_execution_tenant_mismatch");
  assertExact(record.request_kind, "lead_triage", "broker_execution_kind_mismatch");
  assertExact(record.write_tool, LEAD_TRIAGE_WRITE_TOOL, "broker_execution_tool_mismatch");
  assertExact(record.dry_run_tool, LEAD_TRIAGE_DRY_RUN_TOOL, "broker_execution_tool_mismatch");
  assertExact(record.agent_role, config.agentRole, "broker_execution_role_mismatch");
  assertExact(record.actor_user, config.actorUser, "broker_execution_actor_mismatch");
  assertExact(record.site_id, config.siteId, "broker_execution_site_mismatch");
  assertExact(record.target_doctype, "Lead Envelope", "broker_execution_target_mismatch");
  const approvalRequestId = idText(record.approval_request_id, "broker_execution_request_id_invalid");
  const leadEnvelopeId = idText(record.lead_envelope_id, "broker_execution_lead_invalid");
  assertExact(record.target_name, leadEnvelopeId, "broker_execution_target_mismatch");
  const runId = idText(record.run_id, "broker_execution_run_id_invalid");
  const requestText = boundedText(record.request_text, 1, 4000, "broker_execution_request_text_invalid");
  assertExact(record.approved_by_frappe_user, config.approverId, "broker_execution_approver_mismatch");
  boundedText(record.decision_idempotency_key, 8, 140, "broker_execution_decision_invalid");
  const expiresAt = requiredFutureIso(record.expires_at, now, "broker_execution_expired");
  const argsDigest = hexDigest(record.args_digest, "broker_execution_args_digest_invalid");
  const previewDigest = hexDigest(record.preview_digest, "broker_execution_preview_digest_invalid");
  const dryRunReceipt = boundedText(record.dry_run_receipt, 32, 8192, "broker_execution_dry_run_receipt_invalid");
  const writeArgs = parseCanonicalObject(record.write_args_json, "broker_execution_args_invalid");
  const preview = parseCanonicalObject(record.preview_json, "broker_execution_preview_invalid");
  if (Object.hasOwn(preview, "approval_request")) throw new Error("broker_execution_preview_capability_present");
  const expectedWriteArgs = {
    lead_envelope_id: leadEnvelopeId,
    triage_summary: boundedText(writeArgs.triage_summary, 1, 2000, "broker_execution_triage_summary_invalid"),
    request_text: requestText,
    approved_by: config.approverId,
    run_id: runId,
  };
  if (canonicalJson(writeArgs) !== canonicalJson(expectedWriteArgs)) throw new Error("broker_execution_args_mismatch");
  assertExact(argsDigest, digest(approvedArgs(expectedWriteArgs)), "broker_execution_args_digest_mismatch");
  assertExact(previewDigest, digest(semanticPreview(preview)), "broker_execution_preview_digest_mismatch");
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: LEAD_TRIAGE_DRY_RUN_TOOL,
    write_tool: LEAD_TRIAGE_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest({ lead_envelope_id: leadEnvelopeId, triage_summary: expectedWriteArgs.triage_summary }),
    preview_digest: previewDigest,
  });
  return {
    approvalRequestId,
    runId,
    leadEnvelopeId,
    expiresAt,
    argsDigest,
    dryRunReceipt,
    writeArgs: expectedWriteArgs,
  };
}

function safeExecutedResult(payload, record) {
  if (!isRecord(payload) || payload.updated !== true || payload.audit_finalized !== true) {
    throw new Error("broker_execution_result_invalid");
  }
  assertExact(payload.run_id, record.runId, "broker_execution_run_mismatch");
  assertExact(payload.lead_envelope_id, record.leadEnvelopeId, "broker_execution_lead_mismatch");
  if (payload.communication_events_mutated !== false) throw new Error("broker_execution_scope_mismatch");
  return {
    run_id: record.runId,
    lead_envelope_id: record.leadEnvelopeId,
    updated: true,
    audit_finalized: true,
    replayed: payload.replayed === true,
    communication_events_mutated: false,
  };
}

function signedJson(status, body, config, binding, now) {
  const responseText = JSON.stringify(body);
  const responseTimestamp = String(now());
  const signature = hmacBase64Url(config.sharedSecret, internalResponseSigningInput({
    keyId: binding.keyId,
    status,
    path: binding.path,
    requestTimestamp: binding.timestamp,
    nonce: binding.nonce,
    requestBodyHash: binding.bodyHash,
    responseTimestamp,
    responseBodyHash: sha256Hex(responseText),
  }));
  return new Response(responseText, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-ironwrap-internal-version": INTERNAL_VERSION,
      "x-ironwrap-internal-key-id": binding.keyId,
      "x-ironwrap-internal-timestamp": responseTimestamp,
      "x-ironwrap-internal-request-timestamp": binding.timestamp,
      "x-ironwrap-internal-nonce": binding.nonce,
      "x-ironwrap-internal-signature": signature,
    },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function mcpChildEnvironment(env, runtime) {
  const allow = [
    "ERPNEXT_BASE_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "ERPNEXT_REQUEST_TIMEOUT_MS",
    "HERMES_ROLE_POLICY_PATH", "HERMES_DRY_RUN_SIGNING_KEY", "HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "HERMES_APPROVAL_PUBLIC_KEY",
  ];
  const child = {};
  for (const key of allow) if (typeof env[key] === "string" && env[key]) child[key] = env[key];
  child.ERPNEXT_WRITE_ENABLED = "true";
  child.HERMES_AGENT_ROLE = "lead-concierge";
  child.HERMES_ACTOR_USER = runtime.actorUser;
  child.HERMES_APPROVER_ID = runtime.approverId;
  child.PATH = process.env.PATH ?? "/usr/bin:/bin";
  return child;
}

function boundedApprovalExpiry(expiresAt, now, maxLifetimeMs) {
  const expiresMs = Date.parse(expiresAt);
  const current = now();
  if (!Number.isFinite(expiresMs) || expiresMs <= current) throw new Error("broker_execution_expired");
  if (expiresMs > current + maxLifetimeMs) return new Date(current + maxLifetimeMs).toISOString();
  return new Date(expiresMs).toISOString();
}

function parseCanonicalObject(value, errorCode) {
  if (typeof value !== "string" || value.length < 2 || value.length > 16_000) throw new Error(errorCode);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) throw new Error(errorCode);
  return parsed;
}

function requiredFutureIso(value, now, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now()) throw new Error(errorCode);
  return new Date(parsed).toISOString();
}

function parseBoundedMs(raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("approval_broker_timeout_invalid");
  return value;
}

function requiredText(value, errorCode) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${errorCode}_required`);
  return value.trim();
}

function hexDigest(value, errorCode) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(errorCode);
  return value;
}

function idText(value, errorCode) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,140}$/.test(value)) throw new Error(errorCode);
  return value;
}

function boundedText(value, min, max, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error(errorCode);
  return text;
}

function assertOnlyKeys(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("broker_unexpected_field");
}

function requiredObject(value, errorCode) {
  if (!isRecord(value)) throw new Error(errorCode);
  return value;
}

function assertExact(value, expected, errorCode) {
  if (value !== expected) throw new Error(errorCode);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeBrokerError(error, fallback) {
  const message = String(error?.message ?? error).toLowerCase();
  const match = message.match(/\b(broker_[a-z0-9_:-]{2,119})\b/);
  return match?.[1] ?? fallback;
}

async function runHttpBroker() {
  const config = brokerConfigFromEnv();
  const broker = createApprovalBroker({ config, invokeMcp: createStdioMcpInvoker(config) });
  const host = process.env.APPROVAL_BROKER_LISTEN_HOST ?? "127.0.0.1";
  const port = Number(process.env.APPROVAL_BROKER_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("approval_broker_port_invalid");
  const server = createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }
      chunks.push(chunk);
    }
    const inbound = new Request(`http://${host}:${port}${request.url ?? "/"}`, {
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const outbound = await broker.handle(inbound);
    response.writeHead(outbound.status, Object.fromEntries(outbound.headers));
    response.end(await outbound.text());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await runHttpBroker();
