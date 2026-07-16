import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createNonceStore,
  createQuoteRevisionApprovalBroker,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
} from "../src/quote-revision-approval-broker.mjs";
import {
  approvedArgs,
  canonicalJson,
  digest,
  semanticPreview,
  signDryRunReceipt,
  verifyApprovalReceipt,
} from "../src/approval-contract.mjs";

const NOW = Date.now();
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRES_AT = new Date(NOW + 120_000).toISOString();

function config() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    tenantId: "ironwrap",
    keyId: "quote-revision-test-key",
    sharedSecret: "q".repeat(48),
    approvalPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    dryRunSigningKey: "d".repeat(48),
    approverId: "owner@example.com",
    actorUser: "estimator@example.com",
    agentRole: "estimator-assistant",
    siteId: "site-ironwrap",
    maxClockSkewMs: 60_000,
    maxApprovalLifetimeMs: 300_000,
  };
}

function request(brokerConfig, path, body, nonce) {
  const raw = JSON.stringify(body);
  const timestamp = String(NOW);
  const signature = hmacBase64Url(brokerConfig.sharedSecret, internalRequestSigningInput({
    keyId: brokerConfig.keyId,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyHash: sha256Hex(raw),
  }));
  return new Request(`https://quote-revision-broker.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": brokerConfig.keyId,
      "x-ironwrap-internal-timestamp": timestamp,
      "x-ironwrap-internal-nonce": nonce,
      "x-ironwrap-internal-signature": signature,
    },
    body: raw,
  });
}

function previewInput() {
  return {
    approval_request_id: "approval_quote_revision_0001",
    tenant_id: "ironwrap",
    run_id: "run-quote-revision-0001",
    roof_job_id: "job:1",
    customer_quote_id: "cq:1",
    correction_reason: "Fresh field and supplier review are required.",
    request_text: "Create a blank revision shell after evidence review.",
    requested_by_user_id: "appu_owner_0001",
    requested_by_frappe_user: "owner@example.com",
  };
}

function fullPreview(args, state = {}) {
  const sourceVersion = state.sourceVersion ?? 1;
  const quoteVersion = state.quoteVersion ?? sourceVersion + 1;
  const target = `quote-revision:job-1-v${quoteVersion}`;
  const draft = {
    customer_quote_id: target,
    roof_job: args.roof_job_id,
    customer: "customer:1",
    quote_version: quoteVersion,
    status: "Draft",
    supersedes: args.customer_quote_id,
    correction_reason: args.correction_reason,
    prepared_at: NOW_ISO,
    ...(state.extraDraft ?? {}),
  };
  return {
    would_write: false,
    required_tool: "request_create_quote_revision",
    target: { doctype: "Customer Quote", name: target },
    append_only: true,
    source: {
      name: args.customer_quote_id,
      customer_quote_id: args.customer_quote_id,
      roof_job: args.roof_job_id,
      customer: "customer:1",
      quote_version: sourceVersion,
      status: "Approved",
      price_book_version: "retail-2026-07",
      pricing_effective_at: "2026-07-10T12:00:00.000Z",
      quote_total: state.quoteTotal ?? 25_000,
      currency: "CAD",
      valid_until: "2026-07-20",
      supersedes: "",
      modified: state.modified ?? "2026-07-10T12:05:00.000Z",
    },
    observed_quote_count: state.observedQuoteCount ?? 1,
    draft,
  };
}

function invoker(brokerConfig, state = {}, options = {}) {
  const calls = [];
  const invokeMcp = async (name, args) => {
    calls.push({ name, args });
    if (name === "dry_run_quote_revision") {
      const preview = fullPreview(args, state);
      const approvalRequest = {
        write_tool: "request_create_quote_revision",
        dry_run_tool: "dry_run_quote_revision",
        agent_role: brokerConfig.agentRole,
        actor_user: brokerConfig.actorUser,
        site_id: brokerConfig.siteId,
        args_digest: digest(args),
        preview_digest: digest(semanticPreview(preview)),
        dry_run_receipt: signDryRunReceipt(brokerConfig.dryRunSigningKey, {
          dry_run_tool: "dry_run_quote_revision",
          write_tool: "request_create_quote_revision",
          agent_role: brokerConfig.agentRole,
          actor_user: brokerConfig.actorUser,
          site_id: brokerConfig.siteId,
          args_digest: digest(args),
          preview_digest: digest(semanticPreview(preview)),
          issued_at: NOW_ISO,
          expires_at: EXPIRES_AT,
        }),
        expires_at: EXPIRES_AT,
        note: "Only a separately authenticated approver can issue an approval receipt.",
      };
      return { content: [{ type: "text", text: JSON.stringify({ ...preview, approval_request: approvalRequest }) }] };
    }
    if (name !== "request_create_quote_revision") throw new Error("unexpected_tool");
    if (options.writeError) throw new Error(options.writeError);
    verifyApprovalReceipt(brokerConfig.approvalPublicKey, args.approval_receipt, {
      write_tool: "request_create_quote_revision",
      dry_run_receipt: args.dry_run_receipt,
      agent_role: brokerConfig.agentRole,
      actor_user: brokerConfig.actorUser,
      site_id: brokerConfig.siteId,
      run_id: args.run_id,
      approved_by: brokerConfig.approverId,
      args_digest: digest(approvedArgs(args)),
    });
    const quoteVersion = state.quoteVersion ?? (state.sourceVersion ?? 1) + 1;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          run_id: args.run_id,
          created: true,
          audit_finalized: true,
          replayed: false,
          customer_quote_id: `quote-revision:job-1-v${quoteVersion}`,
          quote_version: quoteVersion,
          supersedes: args.customer_quote_id,
        }),
      }],
    };
  };
  return { invokeMcp, calls };
}

async function verifiedBody(response, brokerConfig, path, requestBody, nonce) {
  const raw = await response.text();
  const responseTimestamp = response.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const signature = response.headers.get("x-ironwrap-internal-signature") ?? "";
  const expected = hmacBase64Url(brokerConfig.sharedSecret, internalResponseSigningInput({
    keyId: brokerConfig.keyId,
    status: response.status,
    path,
    requestTimestamp: String(NOW),
    nonce,
    requestBodyHash: sha256Hex(JSON.stringify(requestBody)),
    responseTimestamp,
    responseBodyHash: sha256Hex(raw),
  }));
  assert.equal(signature, expected, "broker response must bind this exact Worker request");
  return JSON.parse(raw);
}

function executionBody(preview) {
  const packet = preview.packet;
  return {
    approval_request: {
      approval_request_id: preview.approval_request_id,
      tenant_id: preview.tenant_id,
      request_kind: packet.request_kind,
      write_tool: packet.write_tool,
      dry_run_tool: packet.dry_run_tool,
      agent_role: packet.agent_role,
      actor_user: packet.actor_user,
      site_id: packet.site_id,
      target_doctype: packet.target.doctype,
      target_name: packet.target.name,
      roof_job_id: packet.roof_job_id,
      customer_quote_id: packet.customer_quote_id,
      correction_reason: packet.correction_reason,
      request_text: packet.request_text,
      write_args_json: packet.write_args_json,
      preview_json: packet.preview_json,
      args_digest: packet.args_digest,
      preview_digest: packet.preview_digest,
      receipt_preview_digest: packet.receipt_preview_digest,
      dry_run_receipt: packet.dry_run_receipt,
      expires_at: packet.expires_at,
      run_id: packet.run_id,
      approved_by_frappe_user: "owner@example.com",
      decision_idempotency_key: "decision-key-quote-revision-0001",
    },
  };
}

test("quote-revision broker emits a redacted, receipt-bound preview packet and rejects nonce replay", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createQuoteRevisionApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  const nonce = "nonce-quote-preview-000001";
  const response = await broker.handle(request(brokerConfig, "/v1/quote-revision/preview", body, nonce));
  assert.equal(response.status, 200);
  const payload = await verifiedBody(response, brokerConfig, "/v1/quote-revision/preview", body, nonce);
  const packetText = JSON.stringify(payload.packet);
  assert.equal(payload.packet.write_tool, "request_create_quote_revision");
  assert.equal(payload.packet.dry_run_tool, "dry_run_quote_revision");
  assert.equal(payload.packet.agent_role, "estimator-assistant");
  assert.equal(payload.packet.target.name, "quote-revision:job-1-v2");
  assert.match(payload.packet.receipt_preview_digest, /^[0-9a-f]{64}$/);
  assert.equal(packetText.includes("approval_receipt"), false);
  assert.equal(packetText.includes("customer:1"), false, "customer identity must not enter the packet preview");
  for (const forbidden of [
    "price_book_version", "pricing_effective_at", "quote_total", "currency", "valid_until",
    "tax_", "payment_", "acceptance", "scope_summary", "assumptions", "exclusions",
  ]) assert.equal(packetText.includes(forbidden), false, `${forbidden} must not enter the packet preview`);
  const safePreview = JSON.parse(payload.packet.preview_json);
  assert.deepEqual(Object.keys(safePreview.source).sort(), ["customer_quote_id", "modified", "quote_version", "roof_job", "status"]);
  assert.deepEqual(
    Object.keys(safePreview.draft).sort(),
    ["correction_reason", "customer_quote_id", "quote_version", "roof_job", "status", "supersedes"],
  );
  assert.deepEqual(calls.map((call) => call.name), ["dry_run_quote_revision"]);

  const wrongSurface = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/preview",
    body,
    "nonce-quote-wrong-surface1",
  ));
  assert.equal(wrongSurface.status, 404, "the quote broker must not inherit lead-triage routes");

  const replay = await broker.handle(request(brokerConfig, "/v1/quote-revision/preview", body, nonce));
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "internal_replay_detected" });
});

test("quote-revision broker verifies a fresh source fence, signs once, and returns only a safe execution result", async () => {
  const brokerConfig = config();
  const state = {};
  const { invokeMcp, calls } = invoker(brokerConfig, state);
  const broker = createQuoteRevisionApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000002",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000002",
  );
  const body = executionBody(preview);
  const executionResponse = await broker.handle(request(
    brokerConfig,
    "/v1/quote-revision/execute",
    body,
    "nonce-quote-execute-00001",
  ));
  const result = await verifiedBody(
    executionResponse,
    brokerConfig,
    "/v1/quote-revision/execute",
    body,
    "nonce-quote-execute-00001",
  );
  assert.equal(result.outcome.state, "executed");
  const safe = JSON.parse(result.outcome.result_json);
  assert.deepEqual(safe, {
    run_id: "run-quote-revision-0001",
    customer_quote_id: "quote-revision:job-1-v2",
    roof_job_id: "job:1",
    source_customer_quote_id: "cq:1",
    quote_version: 2,
    supersedes: "cq:1",
    created: true,
    audit_finalized: true,
    replayed: false,
    append_only: true,
    commercial_fields_mutated: false,
  });
  assert.equal(JSON.stringify(result).includes("approval_receipt"), false);
  assert.deepEqual(calls.map((call) => call.name), [
    "dry_run_quote_revision",
    "dry_run_quote_revision",
    "request_create_quote_revision",
  ]);
});

test("quote-revision broker fails closed on source drift or commercial draft leakage before calling the write", async () => {
  const brokerConfig = config();
  const state = {};
  const initialInvoker = invoker(brokerConfig, state);
  const broker = createQuoteRevisionApprovalBroker({
    config: brokerConfig,
    invokeMcp: initialInvoker.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000003",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000003",
  );
  state.modified = "2026-07-10T12:06:00.000Z";
  const staleBody = executionBody(preview);
  const staleResponse = await broker.handle(request(
    brokerConfig,
    "/v1/quote-revision/execute",
    staleBody,
    "nonce-quote-execute-00002",
  ));
  const stale = await verifiedBody(
    staleResponse,
    brokerConfig,
    "/v1/quote-revision/execute",
    staleBody,
    "nonce-quote-execute-00002",
  );
  assert.deepEqual(stale.outcome, {
    state: "failed",
    hermes_run_id: null,
    result_json: null,
    error_code: "broker_quote_revision_source_stale",
  });
  assert.deepEqual(initialInvoker.calls.map((call) => call.name), [
    "dry_run_quote_revision",
    "dry_run_quote_revision",
  ]);

  const targetInvoker = invoker(brokerConfig);
  const targetBroker = createQuoteRevisionApprovalBroker({
    config: brokerConfig,
    invokeMcp: targetInvoker.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const targetPreviewResponse = await targetBroker.handle(request(
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000005",
  ));
  const targetPreview = await verifiedBody(
    targetPreviewResponse,
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000005",
  );
  const targetTamper = executionBody(targetPreview);
  targetTamper.approval_request.target_name = "quote-revision:job-1-v3";
  const targetTamperResponse = await targetBroker.handle(request(
    brokerConfig,
    "/v1/quote-revision/execute",
    targetTamper,
    "nonce-quote-execute-00003",
  ));
  const targetTamperResult = await verifiedBody(
    targetTamperResponse,
    brokerConfig,
    "/v1/quote-revision/execute",
    targetTamper,
    "nonce-quote-execute-00003",
  );
  assert.equal(targetTamperResult.outcome.state, "failed");
  assert.equal(targetTamperResult.outcome.error_code, "broker_quote_revision_execution_target_mismatch");
  assert.deepEqual(targetInvoker.calls.map((call) => call.name), ["dry_run_quote_revision"]);

  const leaking = invoker(brokerConfig, { extraDraft: { quote_total: 25_000 } });
  const leakingBroker = createQuoteRevisionApprovalBroker({
    config: brokerConfig,
    invokeMcp: leaking.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const leakResponse = await leakingBroker.handle(request(
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000004",
  ));
  assert.equal(leakResponse.status, 422);
  const leak = await verifiedBody(
    leakResponse,
    brokerConfig,
    "/v1/quote-revision/preview",
    initial,
    "nonce-quote-preview-000004",
  );
  assert.equal(leak.error, "broker_quote_revision_unexpected_field");
  assert.deepEqual(leaking.calls.map((call) => call.name), ["dry_run_quote_revision"]);
});

test("quote-revision broker never accepts the lead-concierge runtime", () => {
  const brokerConfig = config();
  brokerConfig.agentRole = "lead-concierge";
  assert.throws(
    () => createQuoteRevisionApprovalBroker({ config: brokerConfig, invokeMcp: async () => ({}) }),
    /quote_revision_broker_requires_estimator_assistant_write_runtime/,
  );
});
