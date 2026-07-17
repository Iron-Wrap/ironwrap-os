import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createNonceStore,
  createProductionScheduleApprovalBroker,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
} from "../src/production-schedule-approval-broker.mjs";
import {
  approvedArgs,
  canonicalJson,
  digest,
  semanticPreview,
  signDryRunReceipt,
  verifyApprovalReceipt,
} from "../src/approval-contract.mjs";
import { executeProductionScheduleApproval } from "../../../workers-bus/src/production-schedule-approval-broker-client.ts";

const NOW = Date.now();
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRES_AT = new Date(NOW + 120_000).toISOString();
const GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];

function config() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    tenantId: "ironwrap",
    keyId: "production-schedule-test-key",
    sharedSecret: "p".repeat(48),
    approvalPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    dryRunSigningKey: "d".repeat(48),
    approverId: "owner@example.com",
    actorUser: "production-controller@example.com",
    agentRole: "production-controller",
    siteId: "site-ironwrap",
    maxClockSkewMs: 60_000,
    maxApprovalLifetimeMs: 300_000,
  };
}

function request(brokerConfig, path, body, nonce, timestamp = NOW) {
  const raw = JSON.stringify(body);
  const requestTimestamp = String(timestamp);
  const signature = hmacBase64Url(brokerConfig.sharedSecret, internalRequestSigningInput({
    keyId: brokerConfig.keyId,
    method: "POST",
    path,
    timestamp: requestTimestamp,
    nonce,
    bodyHash: sha256Hex(raw),
  }));
  return new Request(`https://production-schedule-broker.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": brokerConfig.keyId,
      "x-ironwrap-internal-timestamp": requestTimestamp,
      "x-ironwrap-internal-nonce": nonce,
      "x-ironwrap-internal-signature": signature,
    },
    body: raw,
  });
}

function previewInput() {
  return {
    approval_request_id: "approval-production-schedule-0001",
    tenant_id: "ironwrap",
    run_id: "run-production-schedule-0001",
    roof_job_id: "job:1",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-1",
    correction_reason: "Crew availability changed after the original assignment.",
    request_text: "Schedule the verified crew after owner review.",
    requested_by_user_id: "appu_owner_0001",
    requested_by_frappe_user: "owner@example.com",
  };
}

function gatePreview(eligible = true) {
  const gateRows = GATES.map((gate, index) => ({
    gate,
    state: eligible || index > 0 ? "Ready" : "Blocked",
  }));
  return {
    required: true,
    required_gates: GATES,
    allowed_states: ["Ready", "Done", "Waived"],
    gates: gateRows,
    missing_gates: [],
    duplicate_gates: [],
    state_ineligible_gates: eligible ? [] : [{ gate: "Deposit", state: "Blocked" }],
    state_eligible: eligible,
    snapshot_truncated: false,
    authoritative_enforcement: "frappe_document_policy",
  };
}

function fullPreview(args, state = {}) {
  const target = state.targetName ?? "assignment:job-1-production-crew-metal-1";
  const draft = {
    assignment_id: target,
    roof_job: args.roof_job_id,
    assignment_type: "Production",
    status: "Assigned",
    crew_profile: args.crew_profile_id,
    scheduled_start: args.scheduled_start,
    assigned_by: args.assigned_by,
    assigned_at: NOW_ISO,
    notes: "",
    ...(args.scheduled_end ? { scheduled_end: args.scheduled_end } : {}),
    ...(args.supersedes ? { supersedes: args.supersedes, correction_reason: args.correction_reason } : {}),
    ...(state.individualTarget ? { assigned_user: "person@example.com" } : {}),
  };
  return {
    would_write: false,
    required_tool: "request_create_job_assignment",
    target: { doctype: "Job Assignment", name: target },
    append_only: true,
    blocked_existing: state.blockedExisting === true,
    ...(state.blockedExisting ? { blocked_reason: "assignment_append_only" } : {}),
    draft,
    production_schedule_gate_preview: gatePreview(state.gateEligible !== false),
  };
}

function invoker(brokerConfig, state = {}) {
  const calls = [];
  let assignmentCreates = 0;
  let writeAttempts = 0;
  const invokeMcp = async (name, args) => {
    calls.push({ name, args });
    if (name === "dry_run_job_assignment") {
      const preview = fullPreview(args, state);
      const approvalRequest = {
        write_tool: "request_create_job_assignment",
        dry_run_tool: "dry_run_job_assignment",
        agent_role: brokerConfig.agentRole,
        actor_user: brokerConfig.actorUser,
        site_id: brokerConfig.siteId,
        args_digest: digest(args),
        preview_digest: digest(semanticPreview(preview)),
        dry_run_receipt: signDryRunReceipt(brokerConfig.dryRunSigningKey, {
          dry_run_tool: "dry_run_job_assignment",
          write_tool: "request_create_job_assignment",
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
    if (name !== "request_create_job_assignment") throw new Error("unexpected_tool");
    assert.equal(Object.hasOwn(args, "assignment_id"), false, "broker cannot choose a raw assignment id");
    assert.equal(Object.hasOwn(args, "assigned_user"), false, "crew-profile-only assignments are required");
    assert.equal(args.assignment_type, "Production");
    assert.equal(args.status, "Assigned");
    verifyApprovalReceipt(brokerConfig.approvalPublicKey, args.approval_receipt, {
      write_tool: "request_create_job_assignment",
      dry_run_receipt: args.dry_run_receipt,
      agent_role: brokerConfig.agentRole,
      actor_user: brokerConfig.actorUser,
      site_id: brokerConfig.siteId,
      run_id: args.run_id,
      approved_by: brokerConfig.approverId,
      args_digest: digest(approvedArgs(args)),
    });
    writeAttempts += 1;
    if (writeAttempts === 1) assignmentCreates += 1;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          run_id: args.run_id,
          assignment_id: "assignment:job-1-production-crew-metal-1",
          created: true,
          audit_finalized: true,
          replayed: writeAttempts > 1,
        }),
      }],
    };
  };
  return {
    invokeMcp,
    calls,
    counts: () => ({ assignmentCreates, writeAttempts }),
  };
}

async function verifiedBody(response, brokerConfig, path, requestBody, nonce, timestamp = NOW) {
  const raw = await response.text();
  const responseTimestamp = response.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const signature = response.headers.get("x-ironwrap-internal-signature") ?? "";
  const expected = hmacBase64Url(brokerConfig.sharedSecret, internalResponseSigningInput({
    keyId: brokerConfig.keyId,
    status: response.status,
    path,
    requestTimestamp: String(timestamp),
    nonce,
    requestBodyHash: sha256Hex(JSON.stringify(requestBody)),
    responseTimestamp,
    responseBodyHash: sha256Hex(raw),
  }));
  assert.equal(signature, expected, "response must bind this exact Worker request");
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
      crew_profile_id: packet.crew_profile_id,
      scheduled_start: packet.scheduled_start,
      scheduled_end: packet.scheduled_end,
      supersedes_assignment_id: packet.supersedes_assignment_id,
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
      decision_idempotency_key: "decision-production-schedule-0001",
    },
  };
}

function workerEnv(brokerConfig) {
  return {
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "http://127.0.0.1:8790",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: brokerConfig.keyId,
    APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS: "5000",
    APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS: "45",
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: brokerConfig.sharedSecret,
  };
}

function workerRequestRecord(preview) {
  const packet = preview.packet;
  return {
    production_schedule_approval_id: preview.approval_request_id,
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
    crew_profile_id: packet.crew_profile_id,
    scheduled_start: packet.scheduled_start,
    scheduled_end: packet.scheduled_end,
    supersedes_assignment_id: packet.supersedes_assignment_id,
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
    decision_idempotency_key: "decision-production-schedule-cross-boundary",
  };
}

test("production broker signs a narrow packet and rejects stale or replayed HMAC requests", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  const nonce = "nonce-production-preview-00001";
  const response = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    body,
    nonce,
  ));
  assert.equal(response.status, 200);
  const payload = await verifiedBody(response, brokerConfig, "/v1/production-schedule/preview", body, nonce);
  assert.deepEqual(JSON.parse(payload.packet.preview_json), {
    would_write: false,
    append_only: true,
    target: { doctype: "Job Assignment", name: "assignment:job-1-production-crew-metal-1" },
    assignment: {
      assignment_id: "assignment:job-1-production-crew-metal-1",
      roof_job_id: "job:1",
      crew_profile_id: "crew:metal-1",
      scheduled_start: "2026-07-18T14:00:00.000Z",
      scheduled_end: "2026-07-18T20:00:00.000Z",
      supersedes_assignment_id: "assignment:prior-1",
      correction_reason: "Crew availability changed after the original assignment.",
    },
    production_schedule_gate_preview: { required: true, state_eligible: true },
  });
  assert.equal(JSON.stringify(payload.packet).includes("required_gates"), false, "raw gates stay private");
  assert.deepEqual(runtime.calls.map(({ name }) => name), ["dry_run_job_assignment"]);

  const replay = await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, nonce));
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "internal_replay_detected" });

  const stale = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    body,
    "nonce-production-preview-stale",
    NOW - 60_001,
  ));
  assert.equal(stale.status, 401);
  assert.deepEqual(await stale.json(), { error: "internal_auth_stale" });
});

test("production broker rejects individual targets, ineligible gates, and existing assignments before packaging", async () => {
  for (const [index, state] of [
    { individualTarget: true },
    { gateEligible: false },
    { blockedExisting: true },
  ].entries()) {
    const brokerConfig = config();
    const runtime = invoker(brokerConfig, state);
    const broker = createProductionScheduleApprovalBroker({
      config: brokerConfig,
      invokeMcp: runtime.invokeMcp,
      now: () => NOW,
      nonceStore: createNonceStore({ now: () => NOW }),
    });
    const body = previewInput();
    const nonce = `nonce-production-invalid-${String(index).padStart(4, "0")}`;
    const response = await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, nonce));
    assert.equal(response.status, 422);
    const result = await verifiedBody(response, brokerConfig, "/v1/production-schedule/preview", body, nonce);
    assert.match(result.error, /^broker_production_schedule_/);
    assert.deepEqual(runtime.calls.map(({ name }) => name), ["dry_run_job_assignment"]);
  }
});

test("production broker revalidates the sealed packet and current gate before it can invoke a write", async () => {
  const brokerConfig = config();
  const state = {};
  const runtime = invoker(brokerConfig, state);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00002",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00002",
  );
  const tampered = executionBody(preview);
  const writeArgs = JSON.parse(tampered.approval_request.write_args_json);
  writeArgs.assigned_user = "person@example.com";
  tampered.approval_request.write_args_json = canonicalJson(writeArgs);
  const tamperResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/execute",
    tampered,
    "nonce-production-execute-tamper",
  ));
  const tamper = await verifiedBody(
    tamperResponse,
    brokerConfig,
    "/v1/production-schedule/execute",
    tampered,
    "nonce-production-execute-tamper",
  );
  assert.equal(tamper.outcome.state, "failed");
  assert.equal(tamper.outcome.error_code, "broker_production_schedule_execution_args_mismatch");
  assert.deepEqual(runtime.calls.map(({ name }) => name), ["dry_run_job_assignment"]);

  const gateState = {};
  const gateRuntime = invoker(brokerConfig, gateState);
  const gateBroker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: gateRuntime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const gatePreviewResponse = await gateBroker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00003",
  ));
  const gatePreview = await verifiedBody(
    gatePreviewResponse,
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00003",
  );
  gateState.gateEligible = false;
  const staleBody = executionBody(gatePreview);
  const staleResponse = await gateBroker.handle(request(
    brokerConfig,
    "/v1/production-schedule/execute",
    staleBody,
    "nonce-production-execute-gate",
  ));
  const stale = await verifiedBody(
    staleResponse,
    brokerConfig,
    "/v1/production-schedule/execute",
    staleBody,
    "nonce-production-execute-gate",
  );
  assert.deepEqual(stale.outcome, {
    state: "failed",
    hermes_run_id: null,
    result_json: null,
    error_code: "broker_production_schedule_source_stale",
  });
  assert.deepEqual(gateRuntime.calls.map(({ name }) => name), ["dry_run_job_assignment", "dry_run_job_assignment"]);
});

test("Worker store record maps production_schedule_approval_id to the broker's sealed execute wire field", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-cross",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-cross",
  );
  const stored = workerRequestRecord(preview);
  const outcome = await executeProductionScheduleApproval(workerEnv(brokerConfig), stored, {
    now: () => NOW,
    nonce: () => "nonce-production-execute-cross",
    fetch: async (input, init) => await broker.handle(input instanceof Request ? input : new Request(input, init)),
  });
  assert.equal(stored.production_schedule_approval_id, preview.approval_request_id);
  assert.equal(outcome.state, "executed");
  assert.deepEqual(JSON.parse(outcome.resultJson), {
    run_id: "run-production-schedule-0001",
    assignment_id: "assignment:job-1-production-crew-metal-1",
    roof_job_id: "job:1",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-1",
    created: true,
    audit_finalized: true,
    crew_notified: false,
    customer_notified: false,
    accounting_mutated: false,
  });
});

test("production broker signs exactly one append-only assignment and relies on Hermes Run replay", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const previewResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00004",
  ));
  const preview = await verifiedBody(
    previewResponse,
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    "nonce-production-preview-00004",
  );
  const body = executionBody(preview);
  const firstResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/execute",
    body,
    "nonce-production-execute-00001",
  ));
  const first = await verifiedBody(
    firstResponse,
    brokerConfig,
    "/v1/production-schedule/execute",
    body,
    "nonce-production-execute-00001",
  );
  assert.equal(first.outcome.state, "executed");
  assert.deepEqual(JSON.parse(first.outcome.result_json), {
    run_id: "run-production-schedule-0001",
    assignment_id: "assignment:job-1-production-crew-metal-1",
    roof_job_id: "job:1",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-1",
    created: true,
    audit_finalized: true,
    replayed: false,
    append_only: true,
    assigned_user_mutated: false,
    crew_notified: false,
    customer_notified: false,
    accounting_mutated: false,
  });

  const replayResponse = await broker.handle(request(
    brokerConfig,
    "/v1/production-schedule/execute",
    body,
    "nonce-production-execute-00002",
  ));
  const replay = await verifiedBody(
    replayResponse,
    brokerConfig,
    "/v1/production-schedule/execute",
    body,
    "nonce-production-execute-00002",
  );
  assert.equal(replay.outcome.state, "executed");
  assert.equal(JSON.parse(replay.outcome.result_json).replayed, true);
  assert.deepEqual(runtime.counts(), { assignmentCreates: 1, writeAttempts: 2 });
  assert.deepEqual(runtime.calls.map(({ name }) => name), [
    "dry_run_job_assignment",
    "dry_run_job_assignment",
    "request_create_job_assignment",
    "dry_run_job_assignment",
    "request_create_job_assignment",
  ]);
});

test("production broker never accepts another Hermes role", () => {
  const brokerConfig = config();
  brokerConfig.agentRole = "owner-operator";
  assert.throws(
    () => createProductionScheduleApprovalBroker({ config: brokerConfig, invokeMcp: async () => ({}) }),
    /production_schedule_broker_requires_production_controller_write_runtime/,
  );
});
