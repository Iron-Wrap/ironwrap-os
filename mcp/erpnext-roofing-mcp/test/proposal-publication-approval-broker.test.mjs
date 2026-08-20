import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createNonceStore,
  createProposalPublicationApprovalBroker,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
} from "../src/proposal-publication-approval-broker.mjs";
import {
  approvedArgs,
  digest,
  semanticPreview,
  signDryRunReceipt,
  verifyApprovalReceipt,
} from "../src/approval-contract.mjs";

const NOW = Date.now();
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRES_AT = new Date(NOW + 120_000).toISOString();
const CUSTOMER_QUOTE = "cq:1";
const PACK = `proposal:${CUSTOMER_QUOTE}`;

function config() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    tenantId: "ironwrap",
    keyId: "proposal-publication-test-key",
    sharedSecret: "p".repeat(48),
    approvalPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    dryRunSigningKey: "d".repeat(48),
    approverId: "owner@example.com",
    actorUser: "owner-operator@example.com",
    agentRole: "owner-operator",
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
  return new Request(`https://proposal-publication-broker.example${path}`, {
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
    approval_request_id: "approval_proposal_publication_0001",
    tenant_id: "ironwrap",
    run_id: "run-proposal-publication-0001",
    roof_job_id: "job:1",
    proposal_evidence_pack_id: PACK,
    request_text: "Publish the reviewed Draft proposal to the private customer portal.",
    requested_by_user_id: "appu_owner_0001",
    requested_by_frappe_user: "owner@example.com",
  };
}

function fullPreview(args, brokerConfig, state = {}) {
  return {
    would_write: false,
    required_tool: "request_publish_proposal_evidence_pack",
    target: { doctype: "Proposal Evidence Pack", name: args.proposal_evidence_pack_id },
    before: {
      name: args.proposal_evidence_pack_id,
      pack_id: args.proposal_evidence_pack_id,
      roof_job: state.roofJobId ?? "job:1",
      quotation: state.quotation ?? CUSTOMER_QUOTE,
      status: state.status ?? "Draft",
      prepared_at: NOW_ISO,
    },
    publication: {
      status: "Approved",
      approved_by: brokerConfig.approverId,
      approved_at: "Frappe server time at execution",
    },
    customer_portal: {
      visible_after_publication: true,
      portal_link_issued: false,
      human_portal_link_issuance_required: true,
    },
    customer_delivery_mutated: false,
    contract_acceptance_mutated: false,
    customer_quote_mutated: false,
  };
}

function invoker(brokerConfig, state = {}, options = {}) {
  const calls = [];
  const invokeMcp = async (name, args) => {
    calls.push({ name, args });
    if (name === "dry_run_publish_proposal_evidence_pack") {
      const preview = fullPreview(args, brokerConfig, calls.length > 1 ? (state.second ?? state) : state);
      const approvalRequest = {
        write_tool: "request_publish_proposal_evidence_pack",
        dry_run_tool: "dry_run_publish_proposal_evidence_pack",
        agent_role: brokerConfig.agentRole,
        actor_user: brokerConfig.actorUser,
        site_id: brokerConfig.siteId,
        args_digest: digest(args),
        preview_digest: digest(semanticPreview(preview)),
        dry_run_receipt: signDryRunReceipt(brokerConfig.dryRunSigningKey, {
          dry_run_tool: "dry_run_publish_proposal_evidence_pack",
          write_tool: "request_publish_proposal_evidence_pack",
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
    if (name !== "request_publish_proposal_evidence_pack") throw new Error("unexpected_tool");
    if (options.writeError) throw new Error(options.writeError);
    verifyApprovalReceipt(brokerConfig.approvalPublicKey, args.approval_receipt, {
      write_tool: "request_publish_proposal_evidence_pack",
      dry_run_receipt: args.dry_run_receipt,
      agent_role: brokerConfig.agentRole,
      actor_user: brokerConfig.actorUser,
      site_id: brokerConfig.siteId,
      run_id: args.run_id,
      approved_by: brokerConfig.approverId,
      args_digest: digest(approvedArgs(args)),
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          run_id: args.run_id,
          published: true,
          audit_finalized: true,
          replayed: false,
          proposal_evidence_pack_id: args.proposal_evidence_pack_id,
          customer_delivery_mutated: false,
          customer_portal_link_issued: false,
          contract_acceptance_mutated: false,
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
      proposal_evidence_pack_id: packet.proposal_evidence_pack_id,
      customer_quote_id: packet.customer_quote_id,
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
      decision_idempotency_key: "decision-key-proposal-publication-1",
    },
  };
}

async function preparedPacket(broker, brokerConfig, nonce, input = previewInput()) {
  const response = await broker.handle(
    request(brokerConfig, "/v1/proposal-publication/preview", input, nonce),
  );
  assert.equal(response.status, 200);
  return await verifiedBody(response, brokerConfig, "/v1/proposal-publication/preview", input, nonce);
}

test("publication broker emits a redacted, receipt-bound packet and rejects nonce replay", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createProposalPublicationApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  const nonce = "nonce-publication-preview1";
  const payload = await preparedPacket(broker, brokerConfig, nonce, body);
  const packetText = JSON.stringify(payload.packet);
  assert.equal(payload.packet.write_tool, "request_publish_proposal_evidence_pack");
  assert.equal(payload.packet.dry_run_tool, "dry_run_publish_proposal_evidence_pack");
  assert.equal(payload.packet.agent_role, "owner-operator");
  assert.equal(payload.packet.target.name, PACK);
  assert.equal(payload.packet.customer_quote_id, CUSTOMER_QUOTE);
  assert.match(payload.packet.receipt_preview_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(
    payload.packet.preview_digest,
    payload.packet.receipt_preview_digest,
    "the browser-safe preview must be genuinely narrower than the receipt-bound one",
  );
  assert.equal(packetText.includes("approval_receipt"), false);
  const safePreview = JSON.parse(payload.packet.preview_json);
  assert.deepEqual(Object.keys(safePreview.before).sort(), ["pack_id", "quotation", "roof_job", "status"]);
  assert.deepEqual(Object.keys(safePreview.publication), ["status"]);
  assert.equal(
    JSON.stringify(safePreview).includes(brokerConfig.approverId),
    false,
    "the approver identity must never enter the browser-facing preview",
  );
  assert.equal(safePreview.customer_portal.portal_link_issued, false);
  assert.equal(safePreview.customer_quote_mutated, false);
  assert.deepEqual(calls.map((call) => call.name), ["dry_run_publish_proposal_evidence_pack"]);

  const wrongSurface = await broker.handle(request(
    brokerConfig,
    "/v1/quote-revision/preview",
    body,
    "nonce-publication-wrong-01",
  ));
  assert.equal(wrongSurface.status, 404, "the publication broker must not inherit other broker routes");

  const replay = await broker.handle(request(brokerConfig, "/v1/proposal-publication/preview", body, nonce));
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "internal_replay_detected" });
});

test("publication broker re-fences the source, signs once, and returns only a safe result", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createProposalPublicationApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const preview = await preparedPacket(broker, brokerConfig, "nonce-publication-preview2");
  const body = executionBody(preview);
  const executionResponse = await broker.handle(
    request(brokerConfig, "/v1/proposal-publication/execute", body, "nonce-publication-execute1"),
  );
  const result = await verifiedBody(
    executionResponse,
    brokerConfig,
    "/v1/proposal-publication/execute",
    body,
    "nonce-publication-execute1",
  );
  assert.equal(result.outcome.state, "executed");
  assert.deepEqual(JSON.parse(result.outcome.result_json), {
    run_id: "run-proposal-publication-0001",
    proposal_evidence_pack_id: PACK,
    roof_job_id: "job:1",
    customer_quote_id: CUSTOMER_QUOTE,
    status: "Approved",
    published: true,
    audit_finalized: true,
    replayed: false,
    customer_delivery_mutated: false,
    customer_portal_link_issued: false,
    contract_acceptance_mutated: false,
  });
  assert.equal(
    JSON.stringify(result).includes("approval_receipt"),
    false,
    "no signed capability may return to the Worker",
  );
  assert.deepEqual(calls.map((call) => call.name), [
    "dry_run_publish_proposal_evidence_pack",
    "dry_run_publish_proposal_evidence_pack",
    "request_publish_proposal_evidence_pack",
  ], "execution must re-run the dry run as a source fence before signing");
  const write = calls.at(-1).args;
  assert.deepEqual(Object.keys(write).sort(), [
    "approval_receipt", "approved_by", "dry_run_receipt", "proposal_evidence_pack_id", "request_text", "run_id",
  ]);
  assert.equal(write.approved_by, brokerConfig.approverId);
});

test("a pack that left Draft between preparation and confirmation is never published", async () => {
  const brokerConfig = config();
  const state = { status: "Draft", second: { status: "Approved" } };
  const { invokeMcp, calls } = invoker(brokerConfig, state);
  const broker = createProposalPublicationApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const preview = await preparedPacket(broker, brokerConfig, "nonce-publication-preview3");
  const body = executionBody(preview);
  const response = await broker.handle(
    request(brokerConfig, "/v1/proposal-publication/execute", body, "nonce-publication-execute2"),
  );
  const result = await verifiedBody(
    response,
    brokerConfig,
    "/v1/proposal-publication/execute",
    body,
    "nonce-publication-execute2",
  );
  assert.equal(result.outcome.state, "failed");
  assert.equal(result.outcome.error_code, "broker_proposal_publication_source_stale");
  assert.equal(
    calls.some((call) => call.name === "request_publish_proposal_evidence_pack"),
    false,
    "a stale source must never reach the publication command",
  );
});

test("a tampered execution record is refused before any receipt is signed", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createProposalPublicationApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const preview = await preparedPacket(broker, brokerConfig, "nonce-publication-preview4");
  const body = executionBody(preview);
  body.approval_request.proposal_evidence_pack_id = "proposal:cq:someone-elses-quote";
  const response = await broker.handle(
    request(brokerConfig, "/v1/proposal-publication/execute", body, "nonce-publication-execute3"),
  );
  const result = await verifiedBody(
    response,
    brokerConfig,
    "/v1/proposal-publication/execute",
    body,
    "nonce-publication-execute3",
  );
  assert.equal(result.outcome.state, "failed");
  assert.equal(
    calls.some((call) => call.name === "request_publish_proposal_evidence_pack"),
    false,
  );
});

test("an ambiguous write becomes reconciliation-only uncertainty, never a retry", async () => {
  const brokerConfig = config();
  const { invokeMcp } = invoker(brokerConfig, {}, { writeError: "socket hang up" });
  const broker = createProposalPublicationApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const preview = await preparedPacket(broker, brokerConfig, "nonce-publication-preview5");
  const body = executionBody(preview);
  const response = await broker.handle(
    request(brokerConfig, "/v1/proposal-publication/execute", body, "nonce-publication-execute4"),
  );
  const result = await verifiedBody(
    response,
    brokerConfig,
    "/v1/proposal-publication/execute",
    body,
    "nonce-publication-execute4",
  );
  assert.equal(result.outcome.state, "execution_uncertain");
  assert.equal(result.outcome.error_code, "broker_mcp_call_ambiguous");
  assert.equal(result.outcome.hermes_run_id, "run-proposal-publication-0001");
  assert.equal(result.outcome.result_json, null);
});

test("the broker refuses any runtime that is not an owner-operator write runtime", () => {
  const brokerConfig = config();
  assert.throws(
    () => createProposalPublicationApprovalBroker({
      config: { ...brokerConfig, agentRole: "estimator-assistant" },
      invokeMcp: async () => ({}),
    }),
    /proposal_publication_broker_requires_owner_operator_write_runtime/,
  );
  assert.throws(
    () => createProposalPublicationApprovalBroker({
      config: { ...brokerConfig, approvalPrivateKey: "" },
      invokeMcp: async () => ({}),
    }),
    /proposal_publication_broker_config_incomplete/,
  );
});
