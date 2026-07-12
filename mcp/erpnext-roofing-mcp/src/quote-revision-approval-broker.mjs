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
import { configFromEnv, customerQuoteRevisionIdForRoofJob } from "./server.mjs";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_APPROVAL_LIFETIME_MS = 5 * 60_000;

export const QUOTE_REVISION_PREVIEW_PATH = "/v1/quote-revision/preview";
export const QUOTE_REVISION_EXECUTE_PATH = "/v1/quote-revision/execute";
export const QUOTE_REVISION_WRITE_TOOL = "request_create_quote_revision";
export const QUOTE_REVISION_DRY_RUN_TOOL = "dry_run_quote_revision";
const QUOTE_REVISION_AGENT_ROLE = "estimator-assistant";

const QUOTE_REVISION_PREVIEW_KEYS = [
  "would_write",
  "required_tool",
  "target",
  "append_only",
  "source",
  "observed_quote_count",
  "draft",
];
const QUOTE_REVISION_FULL_DRAFT_KEYS = [
  "customer_quote_id",
  "roof_job",
  "customer",
  "quote_version",
  "status",
  "supersedes",
  "correction_reason",
  "prepared_at",
];
const QUOTE_REVISION_FULL_SOURCE_KEYS = [
  "name",
  "customer_quote_id",
  "roof_job",
  "customer",
  "quote_version",
  "status",
  "price_book_version",
  "pricing_effective_at",
  "quote_total",
  "currency",
  "valid_until",
  "supersedes",
  "modified",
];
const QUOTE_REVISION_SAFE_SOURCE_KEYS = [
  "customer_quote_id",
  "roof_job",
  "quote_version",
  "status",
  "modified",
];
const QUOTE_REVISION_SAFE_DRAFT_KEYS = [
  "customer_quote_id",
  "roof_job",
  "quote_version",
  "status",
  "supersedes",
  "correction_reason",
];

/**
 * A sealed approval surface for append-only Customer Quote revision shells.
 *
 * This is intentionally separate from the lead-triage broker: it has a fixed
 * estimator runtime, two fixed routes, and a single write pair. It never
 * exposes an MCP gateway or returns an approval receipt to browser callers.
 */
export function createQuoteRevisionApprovalBroker({ config, invokeMcp, now = () => Date.now(), nonceStore }) {
  assertQuoteRevisionBrokerRuntime(config);
  const nonces = nonceStore ?? createNonceStore({ now, ttlMs: config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS });
  const maxClockSkewMs = config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS;
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;

  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || ![QUOTE_REVISION_PREVIEW_PATH, QUOTE_REVISION_EXECUTE_PATH].includes(path)) {
        return json({ error: "not_found" }, 404);
      }
      const inbound = await verifyInternalRequest(request, config, { now, nonceStore: nonces, maxClockSkewMs, maxBodyBytes });
      if (!inbound.ok) return json({ error: inbound.error }, inbound.status);
      const respond = (status, body) => signedJson(status, body, config, inbound.binding, now);
      if (!inbound.body) return respond(400, { error: "invalid_json" });

      if (path === QUOTE_REVISION_PREVIEW_PATH) {
        try {
          return respond(200, await previewQuoteRevision(inbound.body, config, invokeMcp, now));
        } catch (error) {
          return respond(422, { error: safeBrokerError(error, "broker_quote_revision_preview_rejected") });
        }
      }

      try {
        return respond(200, await executeQuoteRevision(inbound.body, config, invokeMcp, now));
      } catch (error) {
        return respond(200, {
          outcome: {
            state: "failed",
            hermes_run_id: null,
            result_json: null,
            error_code: safeBrokerError(error, "broker_quote_revision_contract_invalid"),
          },
        });
      }
    },
  };
}

export function quoteRevisionBrokerConfigFromEnv(env = process.env) {
  const runtime = configFromEnv(env);
  const privateKeyPath = requiredText(env.HERMES_APPROVAL_PRIVATE_KEY_FILE, "HERMES_APPROVAL_PRIVATE_KEY_FILE");
  const privateKey = readFileSync(privateKeyPath, "utf8");
  const tenantId = requiredText(env.QUOTE_REVISION_BROKER_TENANT_ID, "QUOTE_REVISION_BROKER_TENANT_ID");
  const sharedSecret = requiredText(env.QUOTE_REVISION_BROKER_SHARED_SECRET, "QUOTE_REVISION_BROKER_SHARED_SECRET");
  const keyId = requiredText(env.QUOTE_REVISION_BROKER_KEY_ID, "QUOTE_REVISION_BROKER_KEY_ID");
  if (sharedSecret.length < 32) throw new Error("quote_revision_broker_shared_secret_too_short");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("quote_revision_broker_key_id_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tenantId)) throw new Error("quote_revision_broker_tenant_invalid");
  if (!runtime.writeEnabled || runtime.agentRole !== QUOTE_REVISION_AGENT_ROLE) {
    throw new Error("quote_revision_broker_requires_estimator_assistant_write_runtime");
  }
  if (!runtime.allowedTools.includes(QUOTE_REVISION_DRY_RUN_TOOL) || !runtime.allowedTools.includes(QUOTE_REVISION_WRITE_TOOL)) {
    throw new Error("quote_revision_broker_role_tools_missing");
  }
  const expectedSiteId = digest({ frappe_base_url: runtime.baseUrl });
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const configuredPublic = createPublicKey(runtime.approvalPublicKey).export({ type: "spki", format: "der" });
  if (!timingSafeEqual(privatePublic, configuredPublic)) throw new Error("quote_revision_broker_keypair_mismatch");
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
    mcpEnv: quoteRevisionMcpChildEnvironment(env, runtime),
    requestTimeoutMs: runtime.requestTimeoutMs,
    maxClockSkewMs: parseBoundedMs(
      env.QUOTE_REVISION_BROKER_MAX_CLOCK_SKEW_MS,
      MAX_CLOCK_SKEW_MS,
      10_000,
      120_000,
    ),
    maxApprovalLifetimeMs: parseBoundedMs(
      env.QUOTE_REVISION_BROKER_MAX_APPROVAL_LIFETIME_MS,
      MAX_APPROVAL_LIFETIME_MS,
      30_000,
      10 * 60_000,
    ),
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
    return { ok: true, body: null, binding: { keyId, path, timestamp, nonce, bodyHash } };
  }
  if (!isRecord(body)) return { ok: true, body: null, binding: { keyId, path, timestamp, nonce, bodyHash } };
  return { ok: true, body, binding: { keyId, path, timestamp, nonce, bodyHash } };
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

export function createStdioMcpInvoker(config) {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  return async (name, args) => {
    const client = new Client({ name: "ironwrap-quote-revision-approval-broker", version: "0.1.0" }, { capabilities: {} });
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

async function previewQuoteRevision(body, config, invokeMcp, now) {
  const input = parsePreviewInput(body, config);
  const current = await loadQuoteRevisionPreview(input, config, invokeMcp, now);
  const writeArgs = {
    roof_job_id: input.roofJobId,
    customer_quote_id: input.customerQuoteId,
    correction_reason: input.correctionReason,
    request_text: input.requestText,
    approved_by: config.approverId,
    run_id: input.runId,
  };
  const writeArgsJson = canonicalJson(writeArgs);
  const argsDigest = digest(approvedArgs(writeArgs));
  const previewJson = canonicalJson(current.preview);
  const intentFingerprint = digest({
    request_kind: "quote_revision",
    tenant_id: input.tenantId,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
    write_tool: QUOTE_REVISION_WRITE_TOOL,
    dry_run_tool: QUOTE_REVISION_DRY_RUN_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    target: { doctype: "Customer Quote", name: current.targetName },
    source: {
      roof_job_id: input.roofJobId,
      customer_quote_id: input.customerQuoteId,
    },
    approved_intent: {
      roof_job_id: input.roofJobId,
      customer_quote_id: input.customerQuoteId,
      correction_reason: input.correctionReason,
      request_text: input.requestText,
      approved_by: config.approverId,
    },
    args_digest: argsDigest,
    preview_digest: current.previewDigest,
    receipt_preview_digest: current.receiptPreviewDigest,
  });
  return {
    approval_request_id: input.approvalRequestId,
    tenant_id: input.tenantId,
    packet: {
      request_kind: "quote_revision",
      write_tool: QUOTE_REVISION_WRITE_TOOL,
      dry_run_tool: QUOTE_REVISION_DRY_RUN_TOOL,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      target: { doctype: "Customer Quote", name: current.targetName },
      roof_job_id: input.roofJobId,
      customer_quote_id: input.customerQuoteId,
      correction_reason: input.correctionReason,
      request_text: input.requestText,
      write_args_json: writeArgsJson,
      preview_json: previewJson,
      args_digest: argsDigest,
      preview_digest: current.previewDigest,
      receipt_preview_digest: current.receiptPreviewDigest,
      dry_run_receipt: current.dryRunReceipt,
      expires_at: current.expiresAt,
      run_id: input.runId,
      intent_fingerprint: intentFingerprint,
    },
  };
}

async function executeQuoteRevision(body, config, invokeMcp, now) {
  const record = parseExecutionInput(body, config, now);
  // A fresh dry run is a pre-write source/target fence. It does not replace the
  // stored receipt: the following write still verifies that exact receipt.
  let current;
  try {
    current = await loadQuoteRevisionPreview({
      roofJobId: record.roofJobId,
      customerQuoteId: record.customerQuoteId,
      correctionReason: record.correctionReason,
    }, config, invokeMcp, now);
  } catch {
    throw new Error("broker_quote_revision_source_stale");
  }
  if (current.previewDigest !== record.previewDigest ||
      current.receiptPreviewDigest !== record.receiptPreviewDigest || current.targetName !== record.targetName ||
      current.quoteVersion !== record.quoteVersion || current.supersedes !== record.customerQuoteId) {
    throw new Error("broker_quote_revision_source_stale");
  }

  const approvalExpiresAt = boundedApprovalExpiry(
    record.expiresAt,
    now,
    config.maxApprovalLifetimeMs ?? MAX_APPROVAL_LIFETIME_MS,
  );
  const approvalReceipt = signApprovalReceipt(config.approvalPrivateKey, {
    write_tool: QUOTE_REVISION_WRITE_TOOL,
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
    const result = await invokeMcp(QUOTE_REVISION_WRITE_TOOL, {
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
      return {
        outcome: {
          state: "audit_failed",
          hermes_run_id: record.runId,
          result_json: null,
          error_code: "audit_finalization_failed",
        },
      };
    }
    // Once the write invocation begins, the broker cannot prove whether Frappe
    // accepted it. The caller must reconcile the immutable Hermes Run, never retry.
    return {
      outcome: {
        state: "execution_uncertain",
        hermes_run_id: record.runId,
        result_json: null,
        error_code: "broker_mcp_call_ambiguous",
      },
    };
  }
}

async function loadQuoteRevisionPreview(input, config, invokeMcp, now) {
  const baseArgs = {
    roof_job_id: input.roofJobId,
    customer_quote_id: input.customerQuoteId,
    correction_reason: input.correctionReason,
  };
  const result = await invokeMcp(QUOTE_REVISION_DRY_RUN_TOOL, baseArgs);
  const payload = parseToolPayload(result);
  const approval = requiredObject(payload.approval_request, "broker_quote_revision_dry_run_receipt_missing");
  const fullPreview = { ...payload };
  delete fullPreview.approval_request;
  const { safePreview, ...invariants } = assertQuoteRevisionDryRunPreview(fullPreview, input);
  const dryRunReceipt = requiredText(approval.dry_run_receipt, "broker_quote_revision_dry_run_receipt_missing");
  const expiresAt = requiredFutureIso(approval.expires_at, now, "broker_quote_revision_dry_run_expired");
  const receiptPreviewDigest = digest(semanticPreview(fullPreview));
  const previewDigest = digest(semanticPreview(safePreview));
  assertOnlyKeys(approval, [
    "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "args_digest", "preview_digest",
    "dry_run_receipt", "expires_at", "note",
  ]);
  assertExact(approval.write_tool, QUOTE_REVISION_WRITE_TOOL, "broker_quote_revision_dry_run_tool_mismatch");
  assertExact(approval.dry_run_tool, QUOTE_REVISION_DRY_RUN_TOOL, "broker_quote_revision_dry_run_tool_mismatch");
  assertExact(approval.agent_role, config.agentRole, "broker_quote_revision_dry_run_role_mismatch");
  assertExact(approval.actor_user, config.actorUser, "broker_quote_revision_dry_run_actor_mismatch");
  assertExact(approval.site_id, config.siteId, "broker_quote_revision_dry_run_site_mismatch");
  assertExact(approval.args_digest, digest(baseArgs), "broker_quote_revision_dry_run_args_digest_mismatch");
  assertExact(
    approval.preview_digest,
    receiptPreviewDigest,
    "broker_quote_revision_dry_run_preview_digest_mismatch",
  );
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: QUOTE_REVISION_DRY_RUN_TOOL,
    write_tool: QUOTE_REVISION_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(baseArgs),
    preview_digest: receiptPreviewDigest,
  });
  return {
    ...invariants,
    preview: safePreview,
    previewDigest,
    receiptPreviewDigest,
    dryRunReceipt,
    expiresAt,
  };
}

function parsePreviewInput(body, config) {
  assertOnlyKeys(body, [
    "approval_request_id", "tenant_id", "run_id", "roof_job_id", "customer_quote_id", "correction_reason",
    "request_text", "requested_by_user_id", "requested_by_frappe_user",
  ]);
  const tenantId = boundedText(body.tenant_id, 2, 64, "broker_quote_revision_tenant_invalid");
  assertExact(tenantId, config.tenantId, "broker_quote_revision_tenant_mismatch");
  return {
    approvalRequestId: idText(body.approval_request_id, "broker_quote_revision_approval_request_id_invalid"),
    tenantId,
    runId: idText(body.run_id, "broker_quote_revision_run_id_invalid"),
    roofJobId: idText(body.roof_job_id, "broker_quote_revision_roof_job_id_invalid"),
    customerQuoteId: idText(body.customer_quote_id, "broker_quote_revision_customer_quote_id_invalid"),
    correctionReason: boundedText(body.correction_reason, 1, 2000, "broker_quote_revision_correction_reason_invalid"),
    requestText: boundedText(body.request_text, 1, 4000, "broker_quote_revision_request_text_invalid"),
    requestedByUserId: idText(body.requested_by_user_id, "broker_quote_revision_requested_by_invalid"),
    requestedByFrappeUser: boundedText(
      body.requested_by_frappe_user,
      3,
      140,
      "broker_quote_revision_requested_frappe_user_invalid",
    ),
  };
}

function parseExecutionInput(body, config, now) {
  assertOnlyKeys(body, ["approval_request"]);
  const record = requiredObject(body.approval_request, "broker_quote_revision_execution_record_invalid");
  assertOnlyKeys(record, [
    "approval_request_id", "tenant_id", "request_kind", "write_tool", "dry_run_tool", "agent_role",
    "actor_user", "site_id", "target_doctype", "target_name", "roof_job_id", "customer_quote_id",
    "correction_reason", "request_text", "write_args_json", "preview_json", "args_digest", "preview_digest",
    "receipt_preview_digest", "dry_run_receipt", "expires_at", "run_id", "approved_by_frappe_user",
    "decision_idempotency_key",
  ]);
  assertExact(record.tenant_id, config.tenantId, "broker_quote_revision_execution_tenant_mismatch");
  assertExact(record.request_kind, "quote_revision", "broker_quote_revision_execution_kind_mismatch");
  assertExact(record.write_tool, QUOTE_REVISION_WRITE_TOOL, "broker_quote_revision_execution_tool_mismatch");
  assertExact(record.dry_run_tool, QUOTE_REVISION_DRY_RUN_TOOL, "broker_quote_revision_execution_tool_mismatch");
  assertExact(record.agent_role, config.agentRole, "broker_quote_revision_execution_role_mismatch");
  assertExact(record.actor_user, config.actorUser, "broker_quote_revision_execution_actor_mismatch");
  assertExact(record.site_id, config.siteId, "broker_quote_revision_execution_site_mismatch");
  assertExact(record.target_doctype, "Customer Quote", "broker_quote_revision_execution_target_mismatch");
  const approvalRequestId = idText(record.approval_request_id, "broker_quote_revision_execution_request_id_invalid");
  const roofJobId = idText(record.roof_job_id, "broker_quote_revision_execution_roof_job_id_invalid");
  const customerQuoteId = idText(record.customer_quote_id, "broker_quote_revision_execution_customer_quote_id_invalid");
  const correctionReason = boundedText(
    record.correction_reason,
    1,
    2000,
    "broker_quote_revision_execution_correction_reason_invalid",
  );
  const targetName = idText(record.target_name, "broker_quote_revision_execution_target_name_invalid");
  const runId = idText(record.run_id, "broker_quote_revision_execution_run_id_invalid");
  const requestText = boundedText(record.request_text, 1, 4000, "broker_quote_revision_execution_request_text_invalid");
  assertExact(record.approved_by_frappe_user, config.approverId, "broker_quote_revision_execution_approver_mismatch");
  boundedText(record.decision_idempotency_key, 8, 140, "broker_quote_revision_execution_decision_invalid");
  const expiresAt = requiredFutureIso(record.expires_at, now, "broker_quote_revision_execution_expired");
  const argsDigest = hexDigest(record.args_digest, "broker_quote_revision_execution_args_digest_invalid");
  const previewDigest = hexDigest(record.preview_digest, "broker_quote_revision_execution_preview_digest_invalid");
  const receiptPreviewDigest = hexDigest(
    record.receipt_preview_digest,
    "broker_quote_revision_execution_receipt_preview_digest_invalid",
  );
  const dryRunReceipt = boundedText(
    record.dry_run_receipt,
    32,
    8192,
    "broker_quote_revision_execution_dry_run_receipt_invalid",
  );
  const writeArgs = parseCanonicalObject(record.write_args_json, "broker_quote_revision_execution_args_invalid");
  const preview = parseCanonicalObject(record.preview_json, "broker_quote_revision_execution_preview_invalid");
  if (Object.hasOwn(preview, "approval_request")) throw new Error("broker_quote_revision_execution_preview_capability_present");
  const invariants = assertSafeQuoteRevisionPreview(preview, { roofJobId, customerQuoteId, correctionReason });
  assertExact(targetName, invariants.targetName, "broker_quote_revision_execution_target_mismatch");
  const expectedWriteArgs = {
    roof_job_id: roofJobId,
    customer_quote_id: customerQuoteId,
    correction_reason: correctionReason,
    request_text: requestText,
    approved_by: config.approverId,
    run_id: runId,
  };
  if (canonicalJson(writeArgs) !== canonicalJson(expectedWriteArgs)) {
    throw new Error("broker_quote_revision_execution_args_mismatch");
  }
  assertExact(
    argsDigest,
    digest(approvedArgs(expectedWriteArgs)),
    "broker_quote_revision_execution_args_digest_mismatch",
  );
  assertExact(
    previewDigest,
    digest(semanticPreview(preview)),
    "broker_quote_revision_execution_preview_digest_mismatch",
  );
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: QUOTE_REVISION_DRY_RUN_TOOL,
    write_tool: QUOTE_REVISION_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest({
      roof_job_id: roofJobId,
      customer_quote_id: customerQuoteId,
      correction_reason: correctionReason,
    }),
    preview_digest: receiptPreviewDigest,
  });
  return {
    approvalRequestId,
    roofJobId,
    customerQuoteId,
    correctionReason,
    targetName,
    quoteVersion: invariants.quoteVersion,
    supersedes: invariants.supersedes,
    runId,
    expiresAt,
    argsDigest,
    previewDigest,
    receiptPreviewDigest,
    dryRunReceipt,
    writeArgs: expectedWriteArgs,
  };
}

function assertQuoteRevisionDryRunPreview(preview, input) {
  assertOnlyKeys(preview, QUOTE_REVISION_PREVIEW_KEYS);
  assertExact(preview.would_write, false, "broker_quote_revision_preview_write_flag_invalid");
  assertExact(preview.required_tool, QUOTE_REVISION_WRITE_TOOL, "broker_quote_revision_preview_tool_mismatch");
  assertExact(preview.append_only, true, "broker_quote_revision_preview_append_only_required");
  const target = requiredObject(preview.target, "broker_quote_revision_preview_target_invalid");
  assertOnlyKeys(target, ["doctype", "name"]);
  assertExact(target.doctype, "Customer Quote", "broker_quote_revision_preview_target_mismatch");
  const targetName = idText(target.name, "broker_quote_revision_preview_target_name_invalid");
  const source = requiredObject(preview.source, "broker_quote_revision_preview_source_invalid");
  assertOnlyKeys(source, QUOTE_REVISION_FULL_SOURCE_KEYS);
  const sourceId = idText(
    source.customer_quote_id ?? source.name,
    "broker_quote_revision_preview_source_customer_quote_id_invalid",
  );
  const sourceRoofJob = idText(source.roof_job, "broker_quote_revision_preview_source_roof_job_id_invalid");
  const sourceVersion = positiveInteger(source.quote_version, "broker_quote_revision_preview_source_version_invalid");
  const sourceModified = requiredIso(source.modified, "broker_quote_revision_preview_source_modified_invalid");
  assertExact(sourceId, input.customerQuoteId, "broker_quote_revision_preview_source_mismatch");
  assertExact(sourceRoofJob, input.roofJobId, "broker_quote_revision_preview_source_roof_job_mismatch");
  if (source.status === "Accepted") throw new Error("broker_quote_revision_preview_accepted_source");
  if (!Number.isInteger(preview.observed_quote_count) || preview.observed_quote_count < 0 || preview.observed_quote_count >= 100) {
    throw new Error("broker_quote_revision_preview_version_window_invalid");
  }
  const draft = requiredObject(preview.draft, "broker_quote_revision_preview_draft_invalid");
  assertOnlyKeys(draft, QUOTE_REVISION_FULL_DRAFT_KEYS);
  const customerQuoteId = idText(draft.customer_quote_id, "broker_quote_revision_preview_draft_id_invalid");
  const roofJobId = idText(draft.roof_job, "broker_quote_revision_preview_draft_roof_job_invalid");
  const customer = boundedText(draft.customer, 1, 140, "broker_quote_revision_preview_draft_customer_invalid");
  const quoteVersion = positiveInteger(draft.quote_version, "broker_quote_revision_preview_draft_version_invalid");
  const supersedes = idText(draft.supersedes, "broker_quote_revision_preview_draft_supersedes_invalid");
  const correctionReason = boundedText(
    draft.correction_reason,
    1,
    2000,
    "broker_quote_revision_preview_draft_correction_reason_invalid",
  );
  if (draft.prepared_at !== undefined) requiredIso(draft.prepared_at, "broker_quote_revision_preview_draft_prepared_at_invalid");
  assertExact(roofJobId, input.roofJobId, "broker_quote_revision_preview_draft_roof_job_mismatch");
  assertExact(supersedes, input.customerQuoteId, "broker_quote_revision_preview_draft_supersedes_mismatch");
  assertExact(correctionReason, input.correctionReason, "broker_quote_revision_preview_draft_correction_reason_mismatch");
  assertExact(draft.status, "Draft", "broker_quote_revision_preview_draft_status_invalid");
  if (quoteVersion <= sourceVersion) throw new Error("broker_quote_revision_preview_draft_version_not_increased");
  const expectedTarget = customerQuoteRevisionIdForRoofJob(input.roofJobId, quoteVersion);
  assertExact(customerQuoteId, expectedTarget, "broker_quote_revision_preview_draft_id_not_deterministic");
  assertExact(targetName, expectedTarget, "broker_quote_revision_preview_target_mismatch");
  return {
    targetName,
    quoteVersion,
    supersedes,
    customer,
    safePreview: {
      would_write: false,
      required_tool: QUOTE_REVISION_WRITE_TOOL,
      target: { doctype: "Customer Quote", name: targetName },
      append_only: true,
      source: {
        customer_quote_id: sourceId,
        roof_job: sourceRoofJob,
        quote_version: sourceVersion,
        status: boundedText(source.status, 1, 80, "broker_quote_revision_preview_source_status_invalid"),
        modified: sourceModified,
      },
      observed_quote_count: preview.observed_quote_count,
      draft: {
        customer_quote_id: customerQuoteId,
        roof_job: roofJobId,
        quote_version: quoteVersion,
        status: "Draft",
        supersedes,
        correction_reason: correctionReason,
      },
    },
  };
}

function assertSafeQuoteRevisionPreview(preview, input) {
  assertOnlyKeys(preview, QUOTE_REVISION_PREVIEW_KEYS);
  assertExact(preview.would_write, false, "broker_quote_revision_safe_preview_write_flag_invalid");
  assertExact(preview.required_tool, QUOTE_REVISION_WRITE_TOOL, "broker_quote_revision_safe_preview_tool_mismatch");
  assertExact(preview.append_only, true, "broker_quote_revision_safe_preview_append_only_required");
  const target = requiredObject(preview.target, "broker_quote_revision_safe_preview_target_invalid");
  assertOnlyKeys(target, ["doctype", "name"]);
  assertExact(target.doctype, "Customer Quote", "broker_quote_revision_safe_preview_target_mismatch");
  const targetName = idText(target.name, "broker_quote_revision_safe_preview_target_name_invalid");
  const source = requiredObject(preview.source, "broker_quote_revision_safe_preview_source_invalid");
  assertOnlyKeys(source, QUOTE_REVISION_SAFE_SOURCE_KEYS);
  const sourceId = idText(source.customer_quote_id, "broker_quote_revision_safe_preview_source_customer_quote_id_invalid");
  const sourceRoofJob = idText(source.roof_job, "broker_quote_revision_safe_preview_source_roof_job_id_invalid");
  const sourceVersion = positiveInteger(source.quote_version, "broker_quote_revision_safe_preview_source_version_invalid");
  requiredIso(source.modified, "broker_quote_revision_safe_preview_source_modified_invalid");
  boundedText(source.status, 1, 80, "broker_quote_revision_safe_preview_source_status_invalid");
  assertExact(sourceId, input.customerQuoteId, "broker_quote_revision_safe_preview_source_mismatch");
  assertExact(sourceRoofJob, input.roofJobId, "broker_quote_revision_safe_preview_source_roof_job_mismatch");
  if (source.status === "Accepted") throw new Error("broker_quote_revision_safe_preview_accepted_source");
  if (!Number.isInteger(preview.observed_quote_count) || preview.observed_quote_count < 0 || preview.observed_quote_count >= 100) {
    throw new Error("broker_quote_revision_safe_preview_version_window_invalid");
  }
  const draft = requiredObject(preview.draft, "broker_quote_revision_safe_preview_draft_invalid");
  assertOnlyKeys(draft, QUOTE_REVISION_SAFE_DRAFT_KEYS);
  const customerQuoteId = idText(draft.customer_quote_id, "broker_quote_revision_safe_preview_draft_id_invalid");
  const roofJobId = idText(draft.roof_job, "broker_quote_revision_safe_preview_draft_roof_job_invalid");
  const quoteVersion = positiveInteger(draft.quote_version, "broker_quote_revision_safe_preview_draft_version_invalid");
  const supersedes = idText(draft.supersedes, "broker_quote_revision_safe_preview_draft_supersedes_invalid");
  const correctionReason = boundedText(
    draft.correction_reason,
    1,
    2000,
    "broker_quote_revision_safe_preview_draft_correction_reason_invalid",
  );
  assertExact(roofJobId, input.roofJobId, "broker_quote_revision_safe_preview_draft_roof_job_mismatch");
  assertExact(supersedes, input.customerQuoteId, "broker_quote_revision_safe_preview_draft_supersedes_mismatch");
  assertExact(correctionReason, input.correctionReason, "broker_quote_revision_safe_preview_draft_correction_reason_mismatch");
  assertExact(draft.status, "Draft", "broker_quote_revision_safe_preview_draft_status_invalid");
  if (quoteVersion <= sourceVersion) throw new Error("broker_quote_revision_safe_preview_draft_version_not_increased");
  const expectedTarget = customerQuoteRevisionIdForRoofJob(input.roofJobId, quoteVersion);
  assertExact(customerQuoteId, expectedTarget, "broker_quote_revision_safe_preview_draft_id_not_deterministic");
  assertExact(targetName, expectedTarget, "broker_quote_revision_safe_preview_target_mismatch");
  return { targetName, quoteVersion, supersedes };
}

function safeExecutedResult(payload, record) {
  if (!isRecord(payload) || payload.created !== true || payload.audit_finalized !== true) {
    throw new Error("broker_quote_revision_execution_result_invalid");
  }
  assertExact(payload.run_id, record.runId, "broker_quote_revision_execution_run_mismatch");
  assertExact(payload.customer_quote_id, record.targetName, "broker_quote_revision_execution_customer_quote_mismatch");
  assertExact(Number(payload.quote_version), record.quoteVersion, "broker_quote_revision_execution_version_mismatch");
  assertExact(payload.supersedes, record.customerQuoteId, "broker_quote_revision_execution_supersedes_mismatch");
  return {
    run_id: record.runId,
    customer_quote_id: record.targetName,
    roof_job_id: record.roofJobId,
    source_customer_quote_id: record.customerQuoteId,
    quote_version: record.quoteVersion,
    supersedes: record.customerQuoteId,
    created: true,
    audit_finalized: true,
    replayed: payload.replayed === true,
    append_only: true,
    commercial_fields_mutated: false,
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

function assertQuoteRevisionBrokerRuntime(config) {
  if (!config || config.agentRole !== QUOTE_REVISION_AGENT_ROLE) {
    throw new Error("quote_revision_broker_requires_estimator_assistant_write_runtime");
  }
  if (!config.approvalPrivateKey || !config.dryRunSigningKey || !config.approverId || !config.actorUser || !config.siteId) {
    throw new Error("quote_revision_broker_config_incomplete");
  }
}

function quoteRevisionMcpChildEnvironment(env, runtime) {
  const allow = [
    "ERPNEXT_BASE_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "ERPNEXT_REQUEST_TIMEOUT_MS",
    "HERMES_ROLE_POLICY_PATH", "HERMES_DRY_RUN_SIGNING_KEY", "HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "HERMES_APPROVAL_PUBLIC_KEY",
  ];
  const child = {};
  for (const key of allow) if (typeof env[key] === "string" && env[key]) child[key] = env[key];
  child.ERPNEXT_WRITE_ENABLED = "true";
  child.HERMES_AGENT_ROLE = QUOTE_REVISION_AGENT_ROLE;
  child.HERMES_ACTOR_USER = runtime.actorUser;
  child.HERMES_APPROVER_ID = runtime.approverId;
  child.PATH = process.env.PATH ?? "/usr/bin:/bin";
  return child;
}

function boundedApprovalExpiry(expiresAt, now, maxLifetimeMs) {
  const expiresMs = Date.parse(expiresAt);
  const current = now();
  if (!Number.isFinite(expiresMs) || expiresMs <= current) throw new Error("broker_quote_revision_execution_expired");
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

function requiredIso(value, errorCode) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(errorCode);
  return new Date(value).toISOString();
}

function parseBoundedMs(raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("quote_revision_broker_timeout_invalid");
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

function positiveInteger(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function assertOnlyKeys(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("broker_quote_revision_unexpected_field");
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

async function runHttpQuoteRevisionBroker() {
  const config = quoteRevisionBrokerConfigFromEnv();
  const broker = createQuoteRevisionApprovalBroker({ config, invokeMcp: createStdioMcpInvoker(config) });
  const host = process.env.QUOTE_REVISION_BROKER_LISTEN_HOST ?? "127.0.0.1";
  const port = Number(process.env.QUOTE_REVISION_BROKER_PORT ?? "8789");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("quote_revision_broker_port_invalid");
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

if (import.meta.url === `file://${process.argv[1]}`) await runHttpQuoteRevisionBroker();
