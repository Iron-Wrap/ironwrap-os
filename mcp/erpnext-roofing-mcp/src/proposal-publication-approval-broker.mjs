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
import { configFromEnv, proposalPackIdForCustomerQuote } from "./server.mjs";

const INTERNAL_VERSION = "1";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_APPROVAL_LIFETIME_MS = 5 * 60_000;

export const PROPOSAL_PUBLICATION_PREVIEW_PATH = "/v1/proposal-publication/preview";
export const PROPOSAL_PUBLICATION_EXECUTE_PATH = "/v1/proposal-publication/execute";
export const PROPOSAL_PUBLICATION_WRITE_TOOL = "request_publish_proposal_evidence_pack";
export const PROPOSAL_PUBLICATION_DRY_RUN_TOOL = "dry_run_publish_proposal_evidence_pack";
const PROPOSAL_PUBLICATION_AGENT_ROLE = "owner-operator";

const PROPOSAL_PUBLICATION_PREVIEW_KEYS = [
  "would_write",
  "required_tool",
  "target",
  "before",
  "publication",
  "customer_portal",
  "customer_delivery_mutated",
  "contract_acceptance_mutated",
  "customer_quote_mutated",
];
const PROPOSAL_PUBLICATION_FULL_BEFORE_KEYS = [
  "name",
  "pack_id",
  "roof_job",
  "quotation",
  "status",
  "prepared_at",
];
const PROPOSAL_PUBLICATION_SAFE_BEFORE_KEYS = [
  "pack_id",
  "roof_job",
  "quotation",
  "status",
];
const PROPOSAL_PUBLICATION_FULL_PUBLICATION_KEYS = [
  "status",
  "approved_by",
  "approved_at",
];
const PROPOSAL_PUBLICATION_PORTAL_KEYS = [
  "visible_after_publication",
  "portal_link_issued",
  "human_portal_link_issuance_required",
];

/**
 * A sealed approval surface for Draft -> Approved Proposal Evidence Pack
 * publication.
 *
 * Publication is the only step that makes quote terms customer-visible through
 * the private portal, so this broker is deliberately separate from the
 * lead-triage and quote-revision brokers: a fixed owner-operator runtime, two
 * fixed routes, one write pair. It never exposes an MCP gateway, never returns
 * an approval receipt to browser callers, and never issues a portal link,
 * sends a message, renders a PDF, signs, or touches the quote.
 */
export function createProposalPublicationApprovalBroker({ config, invokeMcp, now = () => Date.now(), nonceStore }) {
  assertProposalPublicationBrokerRuntime(config);
  const nonces = nonceStore ?? createNonceStore({ now, ttlMs: config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS });
  const maxClockSkewMs = config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS;
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;

  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" ||
          ![PROPOSAL_PUBLICATION_PREVIEW_PATH, PROPOSAL_PUBLICATION_EXECUTE_PATH].includes(path)) {
        return json({ error: "not_found" }, 404);
      }
      const inbound = await verifyInternalRequest(request, config, { now, nonceStore: nonces, maxClockSkewMs, maxBodyBytes });
      if (!inbound.ok) return json({ error: inbound.error }, inbound.status);
      const respond = (status, body) => signedJson(status, body, config, inbound.binding, now);
      if (!inbound.body) return respond(400, { error: "invalid_json" });

      if (path === PROPOSAL_PUBLICATION_PREVIEW_PATH) {
        try {
          return respond(200, await previewProposalPublication(inbound.body, config, invokeMcp, now));
        } catch (error) {
          return respond(422, { error: safeBrokerError(error, "broker_proposal_publication_preview_rejected") });
        }
      }

      try {
        return respond(200, await executeProposalPublication(inbound.body, config, invokeMcp, now));
      } catch (error) {
        return respond(200, {
          outcome: {
            state: "failed",
            hermes_run_id: null,
            result_json: null,
            error_code: safeBrokerError(error, "broker_proposal_publication_contract_invalid"),
          },
        });
      }
    },
  };
}

export function proposalPublicationBrokerConfigFromEnv(env = process.env) {
  const runtime = configFromEnv(env);
  const privateKeyPath = requiredText(env.HERMES_APPROVAL_PRIVATE_KEY_FILE, "HERMES_APPROVAL_PRIVATE_KEY_FILE");
  const privateKey = readFileSync(privateKeyPath, "utf8");
  const tenantId = requiredText(env.PROPOSAL_PUBLICATION_BROKER_TENANT_ID, "PROPOSAL_PUBLICATION_BROKER_TENANT_ID");
  const sharedSecret = requiredText(env.PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET, "PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET");
  const keyId = requiredText(env.PROPOSAL_PUBLICATION_BROKER_KEY_ID, "PROPOSAL_PUBLICATION_BROKER_KEY_ID");
  if (sharedSecret.length < 32) throw new Error("proposal_publication_broker_shared_secret_too_short");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("proposal_publication_broker_key_id_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tenantId)) throw new Error("proposal_publication_broker_tenant_invalid");
  if (!runtime.writeEnabled || runtime.agentRole !== PROPOSAL_PUBLICATION_AGENT_ROLE) {
    throw new Error("proposal_publication_broker_requires_owner_operator_write_runtime");
  }
  if (!runtime.allowedTools.includes(PROPOSAL_PUBLICATION_DRY_RUN_TOOL) ||
      !runtime.allowedTools.includes(PROPOSAL_PUBLICATION_WRITE_TOOL)) {
    throw new Error("proposal_publication_broker_role_tools_missing");
  }
  const expectedSiteId = digest({ frappe_base_url: runtime.baseUrl });
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const configuredPublic = createPublicKey(runtime.approvalPublicKey).export({ type: "spki", format: "der" });
  if (!timingSafeEqual(privatePublic, configuredPublic)) throw new Error("proposal_publication_broker_keypair_mismatch");
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
    mcpEnv: proposalPublicationMcpChildEnvironment(env, runtime),
    requestTimeoutMs: runtime.requestTimeoutMs,
    maxClockSkewMs: parseBoundedMs(
      env.PROPOSAL_PUBLICATION_BROKER_MAX_CLOCK_SKEW_MS,
      MAX_CLOCK_SKEW_MS,
      10_000,
      120_000,
    ),
    maxApprovalLifetimeMs: parseBoundedMs(
      env.PROPOSAL_PUBLICATION_BROKER_MAX_APPROVAL_LIFETIME_MS,
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
    const client = new Client({ name: "ironwrap-proposal-publication-approval-broker", version: "0.1.0" }, { capabilities: {} });
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

async function previewProposalPublication(body, config, invokeMcp, now) {
  const input = parsePreviewInput(body, config);
  const current = await loadProposalPublicationPreview(input, config, invokeMcp, now);
  assertExact(current.roofJobId, input.roofJobId, "broker_proposal_publication_roof_job_mismatch");
  const writeArgs = {
    proposal_evidence_pack_id: input.proposalEvidencePackId,
    request_text: input.requestText,
    approved_by: config.approverId,
    run_id: input.runId,
  };
  const writeArgsJson = canonicalJson(writeArgs);
  const argsDigest = digest(approvedArgs(writeArgs));
  const previewJson = canonicalJson(current.preview);
  const intentFingerprint = digest({
    request_kind: "proposal_publication",
    tenant_id: input.tenantId,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
    write_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
    dry_run_tool: PROPOSAL_PUBLICATION_DRY_RUN_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    target: { doctype: "Proposal Evidence Pack", name: current.targetName },
    source: {
      roof_job_id: current.roofJobId,
      proposal_evidence_pack_id: input.proposalEvidencePackId,
      customer_quote_id: current.customerQuoteId,
    },
    approved_intent: {
      proposal_evidence_pack_id: input.proposalEvidencePackId,
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
      request_kind: "proposal_publication",
      write_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
      dry_run_tool: PROPOSAL_PUBLICATION_DRY_RUN_TOOL,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      target: { doctype: "Proposal Evidence Pack", name: current.targetName },
      roof_job_id: current.roofJobId,
      proposal_evidence_pack_id: input.proposalEvidencePackId,
      customer_quote_id: current.customerQuoteId,
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

async function executeProposalPublication(body, config, invokeMcp, now) {
  const record = parseExecutionInput(body, config, now);
  // A fresh dry run is the pre-write source fence: publication is legal only
  // from Draft, and a pack that moved on must not be republished. It does not
  // replace the stored receipt: the write below still verifies that receipt.
  let current;
  try {
    current = await loadProposalPublicationPreview({
      proposalEvidencePackId: record.proposalEvidencePackId,
    }, config, invokeMcp, now);
  } catch {
    throw new Error("broker_proposal_publication_source_stale");
  }
  if (current.previewDigest !== record.previewDigest ||
      current.receiptPreviewDigest !== record.receiptPreviewDigest ||
      current.targetName !== record.targetName ||
      current.roofJobId !== record.roofJobId ||
      current.customerQuoteId !== record.customerQuoteId) {
    throw new Error("broker_proposal_publication_source_stale");
  }

  const approvalExpiresAt = boundedApprovalExpiry(
    record.expiresAt,
    now,
    config.maxApprovalLifetimeMs ?? MAX_APPROVAL_LIFETIME_MS,
  );
  const approvalReceipt = signApprovalReceipt(config.approvalPrivateKey, {
    write_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
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
    const result = await invokeMcp(PROPOSAL_PUBLICATION_WRITE_TOOL, {
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

async function loadProposalPublicationPreview(input, config, invokeMcp, now) {
  const baseArgs = { proposal_evidence_pack_id: input.proposalEvidencePackId };
  const result = await invokeMcp(PROPOSAL_PUBLICATION_DRY_RUN_TOOL, baseArgs);
  const payload = parseToolPayload(result);
  const approval = requiredObject(payload.approval_request, "broker_proposal_publication_dry_run_receipt_missing");
  const fullPreview = { ...payload };
  delete fullPreview.approval_request;
  const { safePreview, ...invariants } = assertProposalPublicationDryRunPreview(fullPreview, input, config);
  const dryRunReceipt = requiredText(approval.dry_run_receipt, "broker_proposal_publication_dry_run_receipt_missing");
  const expiresAt = requiredFutureIso(approval.expires_at, now, "broker_proposal_publication_dry_run_expired");
  const receiptPreviewDigest = digest(semanticPreview(fullPreview));
  const previewDigest = digest(semanticPreview(safePreview));
  assertOnlyKeys(approval, [
    "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "args_digest", "preview_digest",
    "dry_run_receipt", "expires_at", "note",
  ]);
  assertExact(approval.write_tool, PROPOSAL_PUBLICATION_WRITE_TOOL, "broker_proposal_publication_dry_run_tool_mismatch");
  assertExact(approval.dry_run_tool, PROPOSAL_PUBLICATION_DRY_RUN_TOOL, "broker_proposal_publication_dry_run_tool_mismatch");
  assertExact(approval.agent_role, config.agentRole, "broker_proposal_publication_dry_run_role_mismatch");
  assertExact(approval.actor_user, config.actorUser, "broker_proposal_publication_dry_run_actor_mismatch");
  assertExact(approval.site_id, config.siteId, "broker_proposal_publication_dry_run_site_mismatch");
  assertExact(approval.args_digest, digest(baseArgs), "broker_proposal_publication_dry_run_args_digest_mismatch");
  assertExact(
    approval.preview_digest,
    receiptPreviewDigest,
    "broker_proposal_publication_dry_run_preview_digest_mismatch",
  );
  if (previewDigest === receiptPreviewDigest) {
    throw new Error("broker_proposal_publication_safe_preview_not_redacted");
  }
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: PROPOSAL_PUBLICATION_DRY_RUN_TOOL,
    write_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
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
    "approval_request_id", "tenant_id", "run_id", "roof_job_id", "proposal_evidence_pack_id",
    "request_text", "requested_by_user_id", "requested_by_frappe_user",
  ]);
  const tenantId = boundedText(body.tenant_id, 2, 64, "broker_proposal_publication_tenant_invalid");
  assertExact(tenantId, config.tenantId, "broker_proposal_publication_tenant_mismatch");
  return {
    approvalRequestId: idText(body.approval_request_id, "broker_proposal_publication_approval_request_id_invalid"),
    tenantId,
    runId: idText(body.run_id, "broker_proposal_publication_run_id_invalid"),
    roofJobId: idText(body.roof_job_id, "broker_proposal_publication_roof_job_id_invalid"),
    proposalEvidencePackId: idText(body.proposal_evidence_pack_id, "broker_proposal_publication_pack_id_invalid"),
    requestText: boundedText(body.request_text, 1, 4000, "broker_proposal_publication_request_text_invalid"),
    requestedByUserId: idText(body.requested_by_user_id, "broker_proposal_publication_requested_by_invalid"),
    requestedByFrappeUser: boundedText(
      body.requested_by_frappe_user,
      3,
      140,
      "broker_proposal_publication_requested_frappe_user_invalid",
    ),
  };
}

function parseExecutionInput(body, config, now) {
  assertOnlyKeys(body, ["approval_request"]);
  const record = requiredObject(body.approval_request, "broker_proposal_publication_execution_record_invalid");
  assertOnlyKeys(record, [
    "approval_request_id", "tenant_id", "request_kind", "write_tool", "dry_run_tool", "agent_role",
    "actor_user", "site_id", "target_doctype", "target_name", "roof_job_id", "proposal_evidence_pack_id",
    "customer_quote_id", "request_text", "write_args_json", "preview_json", "args_digest", "preview_digest",
    "receipt_preview_digest", "dry_run_receipt", "expires_at", "run_id", "approved_by_frappe_user",
    "decision_idempotency_key",
  ]);
  assertExact(record.tenant_id, config.tenantId, "broker_proposal_publication_execution_tenant_mismatch");
  assertExact(record.request_kind, "proposal_publication", "broker_proposal_publication_execution_kind_mismatch");
  assertExact(record.write_tool, PROPOSAL_PUBLICATION_WRITE_TOOL, "broker_proposal_publication_execution_tool_mismatch");
  assertExact(record.dry_run_tool, PROPOSAL_PUBLICATION_DRY_RUN_TOOL, "broker_proposal_publication_execution_tool_mismatch");
  assertExact(record.agent_role, config.agentRole, "broker_proposal_publication_execution_role_mismatch");
  assertExact(record.actor_user, config.actorUser, "broker_proposal_publication_execution_actor_mismatch");
  assertExact(record.site_id, config.siteId, "broker_proposal_publication_execution_site_mismatch");
  assertExact(record.target_doctype, "Proposal Evidence Pack", "broker_proposal_publication_execution_target_mismatch");
  const approvalRequestId = idText(record.approval_request_id, "broker_proposal_publication_execution_request_id_invalid");
  const roofJobId = idText(record.roof_job_id, "broker_proposal_publication_execution_roof_job_id_invalid");
  const proposalEvidencePackId = idText(
    record.proposal_evidence_pack_id,
    "broker_proposal_publication_execution_pack_id_invalid",
  );
  const customerQuoteId = idText(record.customer_quote_id, "broker_proposal_publication_execution_quote_id_invalid");
  const targetName = idText(record.target_name, "broker_proposal_publication_execution_target_name_invalid");
  assertExact(targetName, proposalEvidencePackId, "broker_proposal_publication_execution_target_mismatch");
  const runId = idText(record.run_id, "broker_proposal_publication_execution_run_id_invalid");
  const requestText = boundedText(record.request_text, 1, 4000, "broker_proposal_publication_execution_request_text_invalid");
  assertExact(record.approved_by_frappe_user, config.approverId, "broker_proposal_publication_execution_approver_mismatch");
  boundedText(record.decision_idempotency_key, 8, 140, "broker_proposal_publication_execution_decision_invalid");
  const expiresAt = requiredFutureIso(record.expires_at, now, "broker_proposal_publication_execution_expired");
  const argsDigest = hexDigest(record.args_digest, "broker_proposal_publication_execution_args_digest_invalid");
  const previewDigest = hexDigest(record.preview_digest, "broker_proposal_publication_execution_preview_digest_invalid");
  const receiptPreviewDigest = hexDigest(
    record.receipt_preview_digest,
    "broker_proposal_publication_execution_receipt_preview_digest_invalid",
  );
  const dryRunReceipt = boundedText(
    record.dry_run_receipt,
    32,
    8192,
    "broker_proposal_publication_execution_dry_run_receipt_invalid",
  );
  const writeArgs = parseCanonicalObject(record.write_args_json, "broker_proposal_publication_execution_args_invalid");
  const preview = parseCanonicalObject(record.preview_json, "broker_proposal_publication_execution_preview_invalid");
  if (Object.hasOwn(preview, "approval_request")) {
    throw new Error("broker_proposal_publication_execution_preview_capability_present");
  }
  assertSafeProposalPublicationPreview(preview, { roofJobId, proposalEvidencePackId, customerQuoteId });
  const expectedWriteArgs = {
    proposal_evidence_pack_id: proposalEvidencePackId,
    request_text: requestText,
    approved_by: config.approverId,
    run_id: runId,
  };
  if (canonicalJson(writeArgs) !== canonicalJson(expectedWriteArgs)) {
    throw new Error("broker_proposal_publication_execution_args_mismatch");
  }
  assertExact(
    argsDigest,
    digest(approvedArgs(expectedWriteArgs)),
    "broker_proposal_publication_execution_args_digest_mismatch",
  );
  assertExact(
    previewDigest,
    digest(semanticPreview(preview)),
    "broker_proposal_publication_execution_preview_digest_mismatch",
  );
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: PROPOSAL_PUBLICATION_DRY_RUN_TOOL,
    write_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest({ proposal_evidence_pack_id: proposalEvidencePackId }),
    preview_digest: receiptPreviewDigest,
  });
  return {
    approvalRequestId,
    roofJobId,
    proposalEvidencePackId,
    customerQuoteId,
    targetName,
    runId,
    expiresAt,
    argsDigest,
    previewDigest,
    receiptPreviewDigest,
    dryRunReceipt,
    writeArgs: expectedWriteArgs,
  };
}

function assertProposalPublicationDryRunPreview(preview, input, config) {
  assertOnlyKeys(preview, PROPOSAL_PUBLICATION_PREVIEW_KEYS);
  assertExact(preview.would_write, false, "broker_proposal_publication_preview_write_flag_invalid");
  assertExact(preview.required_tool, PROPOSAL_PUBLICATION_WRITE_TOOL, "broker_proposal_publication_preview_tool_mismatch");
  assertExact(preview.customer_delivery_mutated, false, "broker_proposal_publication_preview_delivery_flag_invalid");
  assertExact(preview.contract_acceptance_mutated, false, "broker_proposal_publication_preview_acceptance_flag_invalid");
  assertExact(preview.customer_quote_mutated, false, "broker_proposal_publication_preview_quote_flag_invalid");
  const target = requiredObject(preview.target, "broker_proposal_publication_preview_target_invalid");
  assertOnlyKeys(target, ["doctype", "name"]);
  assertExact(target.doctype, "Proposal Evidence Pack", "broker_proposal_publication_preview_target_mismatch");
  const targetName = idText(target.name, "broker_proposal_publication_preview_target_name_invalid");
  assertExact(targetName, input.proposalEvidencePackId, "broker_proposal_publication_preview_target_mismatch");
  const before = requiredObject(preview.before, "broker_proposal_publication_preview_before_invalid");
  assertOnlyKeys(before, PROPOSAL_PUBLICATION_FULL_BEFORE_KEYS);
  const packId = idText(before.pack_id, "broker_proposal_publication_preview_pack_id_invalid");
  const roofJobId = idText(before.roof_job, "broker_proposal_publication_preview_roof_job_invalid");
  const customerQuoteId = idText(before.quotation, "broker_proposal_publication_preview_quotation_invalid");
  assertExact(packId, input.proposalEvidencePackId, "broker_proposal_publication_preview_pack_mismatch");
  assertExact(before.name, input.proposalEvidencePackId, "broker_proposal_publication_preview_pack_mismatch");
  // Publication is only ever legal out of Draft; anything else is a stale intent.
  assertExact(before.status, "Draft", "broker_proposal_publication_preview_status_not_draft");
  // The pack id is derived from its Customer Quote. A pack whose id does not
  // match its own quotation anchor is not the reviewed proposal for that quote.
  assertExact(
    packId,
    proposalPackIdForCustomerQuote(customerQuoteId),
    "broker_proposal_publication_preview_pack_id_not_deterministic",
  );
  if (before.prepared_at !== undefined && before.prepared_at !== "") {
    requiredIso(before.prepared_at, "broker_proposal_publication_preview_prepared_at_invalid");
  }
  const publication = requiredObject(preview.publication, "broker_proposal_publication_preview_publication_invalid");
  assertOnlyKeys(publication, PROPOSAL_PUBLICATION_FULL_PUBLICATION_KEYS);
  assertExact(publication.status, "Approved", "broker_proposal_publication_preview_publication_status_invalid");
  assertExact(publication.approved_by, config.approverId, "broker_proposal_publication_preview_approver_mismatch");
  const portal = requiredObject(preview.customer_portal, "broker_proposal_publication_preview_portal_invalid");
  assertOnlyKeys(portal, PROPOSAL_PUBLICATION_PORTAL_KEYS);
  assertExact(portal.visible_after_publication, true, "broker_proposal_publication_preview_portal_visibility_invalid");
  assertExact(portal.portal_link_issued, false, "broker_proposal_publication_preview_portal_link_flag_invalid");
  assertExact(
    portal.human_portal_link_issuance_required,
    true,
    "broker_proposal_publication_preview_portal_human_flag_invalid",
  );
  return {
    targetName,
    roofJobId,
    customerQuoteId,
    // The browser-facing copy drops the approver identity and the duplicate
    // Frappe row name: neither is the owner's decision material, and dropping
    // them keeps the stored preview digest distinct from the receipt digest.
    safePreview: {
      would_write: false,
      required_tool: PROPOSAL_PUBLICATION_WRITE_TOOL,
      target: { doctype: "Proposal Evidence Pack", name: targetName },
      before: {
        pack_id: packId,
        roof_job: roofJobId,
        quotation: customerQuoteId,
        status: "Draft",
      },
      publication: { status: "Approved" },
      customer_portal: {
        visible_after_publication: true,
        portal_link_issued: false,
        human_portal_link_issuance_required: true,
      },
      customer_delivery_mutated: false,
      contract_acceptance_mutated: false,
      customer_quote_mutated: false,
    },
  };
}

function assertSafeProposalPublicationPreview(preview, input) {
  assertOnlyKeys(preview, PROPOSAL_PUBLICATION_PREVIEW_KEYS);
  assertExact(preview.would_write, false, "broker_proposal_publication_safe_preview_write_flag_invalid");
  assertExact(
    preview.required_tool,
    PROPOSAL_PUBLICATION_WRITE_TOOL,
    "broker_proposal_publication_safe_preview_tool_mismatch",
  );
  assertExact(preview.customer_delivery_mutated, false, "broker_proposal_publication_safe_preview_delivery_flag_invalid");
  assertExact(preview.contract_acceptance_mutated, false, "broker_proposal_publication_safe_preview_acceptance_flag_invalid");
  assertExact(preview.customer_quote_mutated, false, "broker_proposal_publication_safe_preview_quote_flag_invalid");
  const target = requiredObject(preview.target, "broker_proposal_publication_safe_preview_target_invalid");
  assertOnlyKeys(target, ["doctype", "name"]);
  assertExact(target.doctype, "Proposal Evidence Pack", "broker_proposal_publication_safe_preview_target_mismatch");
  assertExact(target.name, input.proposalEvidencePackId, "broker_proposal_publication_safe_preview_target_mismatch");
  const before = requiredObject(preview.before, "broker_proposal_publication_safe_preview_before_invalid");
  assertOnlyKeys(before, PROPOSAL_PUBLICATION_SAFE_BEFORE_KEYS);
  assertExact(before.pack_id, input.proposalEvidencePackId, "broker_proposal_publication_safe_preview_pack_mismatch");
  assertExact(before.roof_job, input.roofJobId, "broker_proposal_publication_safe_preview_roof_job_mismatch");
  assertExact(before.quotation, input.customerQuoteId, "broker_proposal_publication_safe_preview_quotation_mismatch");
  assertExact(before.status, "Draft", "broker_proposal_publication_safe_preview_status_not_draft");
  const publication = requiredObject(preview.publication, "broker_proposal_publication_safe_preview_publication_invalid");
  assertOnlyKeys(publication, ["status"]);
  assertExact(publication.status, "Approved", "broker_proposal_publication_safe_preview_publication_status_invalid");
  const portal = requiredObject(preview.customer_portal, "broker_proposal_publication_safe_preview_portal_invalid");
  assertOnlyKeys(portal, PROPOSAL_PUBLICATION_PORTAL_KEYS);
  assertExact(portal.visible_after_publication, true, "broker_proposal_publication_safe_preview_portal_visibility_invalid");
  assertExact(portal.portal_link_issued, false, "broker_proposal_publication_safe_preview_portal_link_flag_invalid");
  assertExact(
    portal.human_portal_link_issuance_required,
    true,
    "broker_proposal_publication_safe_preview_portal_human_flag_invalid",
  );
}

function safeExecutedResult(payload, record) {
  if (!isRecord(payload) || payload.published !== true || payload.audit_finalized !== true) {
    throw new Error("broker_proposal_publication_execution_result_invalid");
  }
  assertExact(payload.run_id, record.runId, "broker_proposal_publication_execution_run_mismatch");
  assertExact(
    payload.proposal_evidence_pack_id,
    record.proposalEvidencePackId,
    "broker_proposal_publication_execution_pack_mismatch",
  );
  assertExact(
    payload.customer_delivery_mutated,
    false,
    "broker_proposal_publication_execution_delivery_flag_invalid",
  );
  assertExact(
    payload.customer_portal_link_issued,
    false,
    "broker_proposal_publication_execution_portal_link_flag_invalid",
  );
  assertExact(
    payload.contract_acceptance_mutated,
    false,
    "broker_proposal_publication_execution_acceptance_flag_invalid",
  );
  return {
    run_id: record.runId,
    proposal_evidence_pack_id: record.proposalEvidencePackId,
    roof_job_id: record.roofJobId,
    customer_quote_id: record.customerQuoteId,
    status: "Approved",
    published: true,
    audit_finalized: true,
    replayed: payload.replayed === true,
    customer_delivery_mutated: false,
    customer_portal_link_issued: false,
    contract_acceptance_mutated: false,
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

function assertProposalPublicationBrokerRuntime(config) {
  if (!config || config.agentRole !== PROPOSAL_PUBLICATION_AGENT_ROLE) {
    throw new Error("proposal_publication_broker_requires_owner_operator_write_runtime");
  }
  if (!config.approvalPrivateKey || !config.dryRunSigningKey || !config.approverId || !config.actorUser || !config.siteId) {
    throw new Error("proposal_publication_broker_config_incomplete");
  }
}

function proposalPublicationMcpChildEnvironment(env, runtime) {
  // The child inherits the runtime it needs to build a write-enabled server and
  // nothing else. ERPNEXT_TENANT_ID and the effect-runtime coordinates are part
  // of that minimum: configFromEnv refuses a write runtime without them, so a
  // child started without them cannot answer a single tool call.
  const allow = [
    "ERPNEXT_BASE_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "ERPNEXT_REQUEST_TIMEOUT_MS",
    "ERPNEXT_ALLOW_INSECURE_LOCAL", "ERPNEXT_TENANT_ID",
    "IRONWRAP_EFFECT_RUNTIME_ENABLED", "IRONWRAP_EFFECT_RUNTIME_URL", "IRONWRAP_EFFECT_RUNTIME_TOKEN",
    "HERMES_ROLE_POLICY_PATH", "HERMES_DRY_RUN_SIGNING_KEY", "HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "HERMES_APPROVAL_PUBLIC_KEY",
  ];
  const child = {};
  for (const key of allow) if (typeof env[key] === "string" && env[key]) child[key] = env[key];
  child.ERPNEXT_WRITE_ENABLED = "true";
  child.HERMES_AGENT_ROLE = PROPOSAL_PUBLICATION_AGENT_ROLE;
  child.HERMES_ACTOR_USER = runtime.actorUser;
  child.HERMES_APPROVER_ID = runtime.approverId;
  child.PATH = process.env.PATH ?? "/usr/bin:/bin";
  return child;
}

function boundedApprovalExpiry(expiresAt, now, maxLifetimeMs) {
  const expiresMs = Date.parse(expiresAt);
  const current = now();
  if (!Number.isFinite(expiresMs) || expiresMs <= current) throw new Error("broker_proposal_publication_execution_expired");
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
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("proposal_publication_broker_timeout_invalid");
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
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("broker_proposal_publication_unexpected_field");
  }
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

async function runHttpProposalPublicationBroker() {
  const config = proposalPublicationBrokerConfigFromEnv();
  const broker = createProposalPublicationApprovalBroker({ config, invokeMcp: createStdioMcpInvoker(config) });
  const host = process.env.PROPOSAL_PUBLICATION_BROKER_LISTEN_HOST ?? "127.0.0.1";
  const port = Number(process.env.PROPOSAL_PUBLICATION_BROKER_PORT ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("proposal_publication_broker_port_invalid");
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
    // undici rejects a body on GET/HEAD; a stray probe must never crash the broker.
    const method = request.method ?? "GET";
    const inbound = new Request(`http://${host}:${port}${request.url ?? "/"}`, {
      method,
      headers: request.headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks).toString("utf8"),
    });
    try {
      const outbound = await broker.handle(inbound);
      response.writeHead(outbound.status, Object.fromEntries(outbound.headers));
      response.end(await outbound.text());
    } catch {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "broker_internal_error" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await runHttpProposalPublicationBroker();
