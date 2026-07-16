import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createApprovalBroker,
  createNonceStore,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
} from "../src/approval-broker.mjs";
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

function config() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    tenantId: "ironwrap",
    keyId: "approval-test-key",
    sharedSecret: "s".repeat(48),
    approvalPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    dryRunSigningKey: "d".repeat(48),
    approverId: "owner@example.com",
    actorUser: "concierge@example.com",
    agentRole: "lead-concierge",
    siteId: "site-ironwrap",
    maxClockSkewMs: 60_000,
    maxApprovalLifetimeMs: 300_000,
  };
}

function request(config, path, body, nonce) {
  const raw = JSON.stringify(body);
  const timestamp = String(NOW);
  const signature = hmacBase64Url(config.sharedSecret, internalRequestSigningInput({
    keyId: config.keyId,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyHash: sha256Hex(raw),
  }));
  return new Request(`https://approval-broker.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": config.keyId,
      "x-ironwrap-internal-timestamp": timestamp,
      "x-ironwrap-internal-nonce": nonce,
      "x-ironwrap-internal-signature": signature,
    },
    body: raw,
  });
}

function previewInput() {
  return {
    approval_request_id: "approval_request_0001",
    tenant_id: "ironwrap",
    run_id: "run-lead-triage-0001",
    lead_envelope_id: "lead:001",
    triage_summary: "Urgent leak; verify property address before outreach.",
    request_text: "Approve this local triage annotation.",
    requested_by_user_id: "appu_owner_0001",
    requested_by_frappe_user: "owner@example.com",
  };
}

function invoker(config, options = {}) {
  const calls = [];
  const invokeMcp = async (name, args) => {
    calls.push({ name, args });
    if (name === "dry_run_mark_lead_triaged") {
      if (options.dryRunError) throw new Error(options.dryRunError);
      const preview = {
        would_write: false,
        required_tool: "request_mark_lead_triaged",
        target: { doctype: "Lead Envelope", name: args.lead_envelope_id },
        before: { triage_status: "Untriaged", triaged_by: "", triaged_at: "", triage_summary: "" },
        patch: {
          triage_status: "Triaged",
          triaged_by: config.approverId,
          triaged_at: NOW_ISO,
          triage_summary: args.triage_summary,
        },
        transport_status_unchanged: "pushed",
        communication_events_mutated: false,
      };
      const approvalRequest = {
        write_tool: "request_mark_lead_triaged",
        dry_run_tool: "dry_run_mark_lead_triaged",
        agent_role: config.agentRole,
        actor_user: config.actorUser,
        site_id: config.siteId,
        args_digest: digest(args),
        preview_digest: digest(semanticPreview(preview)),
        dry_run_receipt: signDryRunReceipt(config.dryRunSigningKey, {
          dry_run_tool: "dry_run_mark_lead_triaged",
          write_tool: "request_mark_lead_triaged",
          agent_role: config.agentRole,
          actor_user: config.actorUser,
          site_id: config.siteId,
          args_digest: digest(args),
          preview_digest: digest(semanticPreview(preview)),
          issued_at: NOW_ISO,
          expires_at: EXPIRES_AT,
        }),
        expires_at: EXPIRES_AT,
      };
      return { content: [{ type: "text", text: JSON.stringify({ ...preview, approval_request: approvalRequest }) }] };
    }
    if (name !== "request_mark_lead_triaged") throw new Error("unexpected_tool");
    if (options.writeError) throw new Error(options.writeError);
    verifyApprovalReceipt(config.approvalPublicKey, args.approval_receipt, {
      write_tool: "request_mark_lead_triaged",
      dry_run_receipt: args.dry_run_receipt,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      run_id: args.run_id,
      approved_by: config.approverId,
      args_digest: digest(approvedArgs(args)),
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          run_id: args.run_id,
          updated: true,
          audit_finalized: true,
          replayed: false,
          lead_envelope_id: args.lead_envelope_id,
          communication_events_mutated: false,
        }),
      }],
    };
  };
  return { invokeMcp, calls };
}

async function verifiedBody(response, config, path, requestBody, nonce) {
  const raw = await response.text();
  const responseTimestamp = response.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const signature = response.headers.get("x-ironwrap-internal-signature") ?? "";
  const expected = hmacBase64Url(config.sharedSecret, internalResponseSigningInput({
    keyId: config.keyId,
    status: response.status,
    path,
    requestTimestamp: String(NOW),
    nonce,
    requestBodyHash: sha256Hex(JSON.stringify(requestBody)),
    responseTimestamp,
    responseBodyHash: sha256Hex(raw),
  }));
  assert.equal(signature, expected, "broker response must be bound to this exact Worker request");
  return JSON.parse(raw);
}

test("broker produces a receipt-free trusted preview packet and rejects nonce replay", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  const nonce = "nonce-preview-00000001";
  const first = await broker.handle(request(brokerConfig, "/v1/lead-triage/preview", body, nonce));
  assert.equal(first.status, 200);
  const payload = await verifiedBody(first, brokerConfig, "/v1/lead-triage/preview", body, nonce);
  assert.equal(payload.packet.write_tool, "request_mark_lead_triaged");
  assert.equal(JSON.stringify(payload.packet.preview_json).includes("dry_run_receipt"), false);
  assert.equal(JSON.stringify(payload).includes("approval_receipt"), false);
  assert.deepEqual(calls.map((call) => call.name), ["dry_run_mark_lead_triaged"]);

  const replay = await broker.handle(request(brokerConfig, "/v1/lead-triage/preview", body, nonce));
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "internal_replay_detected" });
});

test("broker stops an ineligible lead before emitting an approval packet", async () => {
  const brokerConfig = config();
  const blocked = invoker(brokerConfig, { dryRunError: "lead_triage_not_preparable" });
  const broker = createApprovalBroker({
    config: brokerConfig,
    invokeMcp: blocked.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  const nonce = "nonce-preview-ineligible1";
  const response = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/preview",
    body,
    nonce,
  ));

  assert.equal(response.status, 422);
  assert.deepEqual(
    await verifiedBody(response, brokerConfig, "/v1/lead-triage/preview", body, nonce),
    { error: "broker_preview_rejected" },
  );
  assert.deepEqual(blocked.calls.map((call) => call.name), ["dry_run_mark_lead_triaged"]);
});

test("broker signs only the bound triage packet, executes once, and withholds the approval receipt", async () => {
  const brokerConfig = config();
  const { invokeMcp, calls } = invoker(brokerConfig);
  const broker = createApprovalBroker({
    config: brokerConfig,
    invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/preview",
    initial,
    "nonce-preview-00000002",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/lead-triage/preview",
    initial,
    "nonce-preview-00000002",
  );
  const packet = preview.packet;
  const executeBody = {
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
      lead_envelope_id: packet.lead_envelope_id,
      request_text: packet.request_text,
      write_args_json: packet.write_args_json,
      preview_json: packet.preview_json,
      args_digest: packet.args_digest,
      preview_digest: packet.preview_digest,
      dry_run_receipt: packet.dry_run_receipt,
      expires_at: packet.expires_at,
      run_id: packet.run_id,
      approved_by_frappe_user: "owner@example.com",
      decision_idempotency_key: "decision-key-0001",
    },
  };
  const executeResponse = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/execute",
    executeBody,
    "nonce-execute-00000001",
  ));
  const result = await verifiedBody(
    executeResponse,
    brokerConfig,
    "/v1/lead-triage/execute",
    executeBody,
    "nonce-execute-00000001",
  );
  assert.equal(result.outcome.state, "executed");
  assert.equal(result.outcome.result_json.includes("approval_receipt"), false);
  assert.deepEqual(calls.map((call) => call.name), [
    "dry_run_mark_lead_triaged",
    "request_mark_lead_triaged",
  ]);
});

test("broker fails closed before a tampered write and turns post-call ambiguity into reconciliation work", async () => {
  const brokerConfig = config();
  const normal = invoker(brokerConfig);
  const broker = createApprovalBroker({
    config: brokerConfig,
    invokeMcp: normal.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/preview",
    initial,
    "nonce-preview-00000003",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/lead-triage/preview",
    initial,
    "nonce-preview-00000003",
  );
  const packet = preview.packet;
  const executeRecord = {
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
    lead_envelope_id: packet.lead_envelope_id,
    request_text: packet.request_text,
    write_args_json: packet.write_args_json,
    preview_json: packet.preview_json,
    args_digest: packet.args_digest,
    preview_digest: packet.preview_digest,
    dry_run_receipt: packet.dry_run_receipt,
    expires_at: packet.expires_at,
    run_id: packet.run_id,
    approved_by_frappe_user: "owner@example.com",
    decision_idempotency_key: "decision-key-0001",
  };
  const tampered = { approval_request: { ...executeRecord, args_digest: "f".repeat(64) } };
  const rejected = await broker.handle(request(
    brokerConfig,
    "/v1/lead-triage/execute",
    tampered,
    "nonce-execute-00000002",
  ));
  const rejectedBody = await verifiedBody(
    rejected,
    brokerConfig,
    "/v1/lead-triage/execute",
    tampered,
    "nonce-execute-00000002",
  );
  assert.equal(rejectedBody.outcome.state, "failed");
  assert.deepEqual(normal.calls.map((call) => call.name), ["dry_run_mark_lead_triaged"]);

  const failing = invoker(brokerConfig, { writeError: "network timeout after submit" });
  const uncertainBroker = createApprovalBroker({
    config: brokerConfig,
    invokeMcp: failing.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const uncertain = await uncertainBroker.handle(request(
    brokerConfig,
    "/v1/lead-triage/execute",
    { approval_request: executeRecord },
    "nonce-execute-00000003",
  ));
  const uncertainBody = await verifiedBody(
    uncertain,
    brokerConfig,
    "/v1/lead-triage/execute",
    { approval_request: executeRecord },
    "nonce-execute-00000003",
  );
  assert.deepEqual(uncertainBody.outcome, {
    state: "execution_uncertain",
    hermes_run_id: "run-lead-triage-0001",
    result_json: null,
    error_code: "broker_mcp_call_ambiguous",
  });
});
