import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  compileCrewAuthorityRequirements,
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
import {
  executeProductionScheduleApproval,
  previewProductionScheduleApproval,
} from "../../../workers-bus/src/production-schedule-approval-broker-client.ts";

const NOW = Date.now();
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRES_AT = new Date(NOW + 120_000).toISOString();
const GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
// The roster the compiler sees by default: two active installers, one who left.
const ROSTER_MEMBERS = [
  { crew_user: "lead@example.com", crew_role: "Lead", active: 1 },
  { crew_user: "installer@example.com", crew_role: "Installer", active: 1 },
  { crew_user: "departed@example.com", crew_role: "Helper", active: 0 },
];
const EXPECTED_REQUIREMENTS = [
  {
    subject_type: "Person",
    subject_role: "Worker",
    subject_ref: "lead@example.com",
    authority_kind: "Worker Competency",
    scope_type: "Roof Job",
    scope_ref: "job:1",
  },
  {
    subject_type: "Person",
    subject_role: "Worker",
    subject_ref: "installer@example.com",
    authority_kind: "Worker Competency",
    scope_type: "Roof Job",
    scope_ref: "job:1",
  },
];

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

/** The same request, in the camelCase shape the Worker's own preview entry point takes. */
function workerPreviewInput(body) {
  return {
    approvalRequestId: body.approval_request_id,
    tenantId: body.tenant_id,
    runId: body.run_id,
    roofJobId: body.roof_job_id,
    crewProfileId: body.crew_profile_id,
    scheduledStart: body.scheduled_start,
    scheduledEnd: body.scheduled_end,
    supersedesAssignmentId: body.supersedes_assignment_id,
    correctionReason: body.correction_reason,
    requestText: body.request_text,
    requestedByUserId: body.requested_by_user_id,
    requestedByFrappeUser: body.requested_by_frappe_user,
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
    // Mirrors `jobAssignmentDraftFromArgs`: the tool serialises exactly the array it
    // was handed, and only when it was handed one.
    ...(args.authority_requirements
      ? { authority_requirements_json: JSON.stringify(args.authority_requirements) }
      : {}),
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
    if (name === "get_crew_authority_roster") {
      if (state.rosterUnavailable) throw new Error("erpnext_http_404:Crew Profile");
      const members = state.rosterReads
        ? state.rosterReads[Math.min(calls.filter((call) => call.name === name).length - 1, state.rosterReads.length - 1)]
        : (state.roster ?? ROSTER_MEMBERS);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            data: {
              name: args.crew_profile_id,
              crew_profile_id: args.crew_profile_id,
              status: "Active",
              ...(state.rosterMalformed ? {} : { members }),
            },
          }),
        }],
      };
    }
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
    // The MCP child's refusal envelope: an errored result whose body is the structured
    // decision, emitted only when the audited write proved nothing was written.
    if (state.writeRefusal) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "domain_refusal", refusal: state.writeRefusal }) }],
      };
    }
    if (state.writeFailure) throw new Error(state.writeFailure);
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
  assert.deepEqual(runtime.calls.map(({ name }) => name), [
    "get_crew_authority_roster",
    "dry_run_job_assignment",
  ]);

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
    assert.deepEqual(runtime.calls.map(({ name }) => name), [
      "get_crew_authority_roster",
      "dry_run_job_assignment",
    ]);
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
  // The refused execute still re-read the roster: compiling the current requirement
  // list is part of rebuilding the args it compares against the approved ones.
  assert.deepEqual(runtime.calls.map(({ name }) => name), [
    "get_crew_authority_roster",
    "dry_run_job_assignment",
    "get_crew_authority_roster",
  ]);

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
  assert.deepEqual(gateRuntime.calls.map(({ name }) => name), [
    "get_crew_authority_roster",
    "dry_run_job_assignment",
    "get_crew_authority_roster",
    "dry_run_job_assignment",
  ]);
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
    "get_crew_authority_roster",
    "dry_run_job_assignment",
    "get_crew_authority_roster",
    "dry_run_job_assignment",
    "request_create_job_assignment",
    "get_crew_authority_roster",
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

test("the compiler declares one Worker Competency per active crew member, scoped to the job", () => {
  const roster = {
    members: [
      { crew_user: "lead@example.com", crew_role: "Lead", active: 1 },
      { crew_user: "installer@example.com", crew_role: "Installer", active: 1 },
    ],
  };
  assert.deepEqual(compileCrewAuthorityRequirements(roster, "job:1"), EXPECTED_REQUIREMENTS);

  // Roof Job scope, not Assignment: one competency record covers every assignment
  // and work package on the job (ELEC-124 §2).
  for (const requirement of compileCrewAuthorityRequirements(roster, "job:1")) {
    assert.equal(requirement.scope_type, "Roof Job");
    assert.equal(requirement.scope_ref, "job:1");
    assert.equal(requirement.authority_kind, "Worker Competency");
  }

  // Deterministic in roster order, and a repeated member declares one requirement,
  // not two - the preview/execute digest guard reads any change as roster drift, so
  // the same roster has to compile to the same bytes every time.
  const duplicated = {
    members: [...roster.members, { crew_user: "lead@example.com", crew_role: "Safety Lead", active: 1 }],
  };
  assert.equal(
    JSON.stringify(compileCrewAuthorityRequirements(duplicated, "job:1")),
    JSON.stringify(EXPECTED_REQUIREMENTS),
  );

  // Nothing is compiled for the kinds ELEC-124 §3 left on the compliance-record path.
  assert.deepEqual(
    compileCrewAuthorityRequirements(roster, "job:1").map(({ authority_kind }) => authority_kind),
    ["Worker Competency", "Worker Competency"],
  );
});

test("an inactive or nameless crew member declares no authority", () => {
  assert.deepEqual(
    compileCrewAuthorityRequirements({
      members: [
        { crew_user: "departed@example.com", crew_role: "Helper", active: 0 },
        { crew_user: "installer@example.com", crew_role: "Installer", active: 1 },
      ],
    }, "job:1"),
    [EXPECTED_REQUIREMENTS[1]],
  );

  // Frappe Check fields arrive as 1/0; a JSON caller may send booleans. Both mean
  // the same thing, and neither `false` nor a blank crew_user gets a requirement.
  assert.deepEqual(
    compileCrewAuthorityRequirements({
      members: [
        { crew_user: "lead@example.com", crew_role: "Lead", active: true },
        { crew_user: "ghost@example.com", crew_role: "Helper", active: false },
        { crew_user: "   ", crew_role: "Helper", active: 1 },
        "not-an-object",
      ],
    }, "job:1"),
    [EXPECTED_REQUIREMENTS[0]],
  );

  // An entirely inactive roster compiles to nothing rather than to a refusal here:
  // `missing_authority_requirements` is Frappe's call to make at the write.
  assert.deepEqual(compileCrewAuthorityRequirements({ members: [] }, "job:1"), []);
});

test("the compiled roster reaches the approved write args and the previewed draft", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore(),
  });
  const body = previewInput();
  const preview = await verifiedBody(
    await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, "nonce-authority-preview")),
    brokerConfig,
    "/v1/production-schedule/preview",
    body,
    "nonce-authority-preview",
  );

  const dryRunCall = runtime.calls.find(({ name }) => name === "dry_run_job_assignment");
  assert.deepEqual(dryRunCall.args.authority_requirements, EXPECTED_REQUIREMENTS);
  assert.deepEqual(
    JSON.parse(preview.packet.write_args_json).authority_requirements,
    EXPECTED_REQUIREMENTS,
  );

  // The safe preview the Worker stores and shows stays free of worker identities;
  // the requirement list travels only in the approved write args.
  assert.equal(JSON.parse(preview.packet.preview_json).assignment.authority_requirements, undefined);
  assert.equal(preview.packet.preview_json.includes("installer@example.com"), false);

  const executed = await verifiedBody(
    await broker.handle(request(
      brokerConfig,
      "/v1/production-schedule/execute",
      executionBody(preview),
      "nonce-authority-execute",
    )),
    brokerConfig,
    "/v1/production-schedule/execute",
    executionBody(preview),
    "nonce-authority-execute",
  );
  assert.equal(executed.outcome.state, "executed");
  const write = runtime.calls.find(({ name }) => name === "request_create_job_assignment");
  assert.deepEqual(write.args.authority_requirements, EXPECTED_REQUIREMENTS);
});

test("a roster that changes between approval and execution refuses the write", async () => {
  const brokerConfig = config();
  // Preview sees both installers; by execution time the second one has left.
  const state = {
    rosterReads: [
      ROSTER_MEMBERS,
      [ROSTER_MEMBERS[0], { ...ROSTER_MEMBERS[1], active: 0 }, ROSTER_MEMBERS[2]],
    ],
  };
  const runtime = invoker(brokerConfig, state);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore(),
  });
  const body = previewInput();
  const preview = await verifiedBody(
    await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, "nonce-drift-preview")),
    brokerConfig,
    "/v1/production-schedule/preview",
    body,
    "nonce-drift-preview",
  );
  assert.deepEqual(JSON.parse(preview.packet.write_args_json).authority_requirements, EXPECTED_REQUIREMENTS);

  const executeBody = executionBody(preview);
  const executed = await verifiedBody(
    await broker.handle(request(
      brokerConfig,
      "/v1/production-schedule/execute",
      executeBody,
      "nonce-drift-execute",
    )),
    brokerConfig,
    "/v1/production-schedule/execute",
    executeBody,
    "nonce-drift-execute",
  );
  // The existing byte-for-byte guard, not a new one: the recompiled list differs from
  // the approved one, so the args no longer match what the approver signed off.
  assert.deepEqual(executed.outcome, {
    state: "failed",
    hermes_run_id: null,
    result_json: null,
    error_code: "broker_production_schedule_execution_args_mismatch",
  });
  assert.equal(runtime.counts().writeAttempts, 0);
});

test("an empty active roster is left for Frappe to refuse, and an unreadable one stops the broker", async () => {
  const brokerConfig = config();
  const emptyRuntime = invoker(brokerConfig, { roster: [{ ...ROSTER_MEMBERS[0], active: 0 }] });
  const emptyBroker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: emptyRuntime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore(),
  });
  const body = previewInput();
  const preview = await verifiedBody(
    await emptyBroker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, "nonce-empty-roster")),
    brokerConfig,
    "/v1/production-schedule/preview",
    body,
    "nonce-empty-roster",
  );
  // No requirement list, no invented one: the write carries no
  // `authority_requirements`, and `domain_policy._require_canonical_authorities`
  // answers `missing_authority_requirements` - which is the refusal that belongs to
  // the domain policy, not to this broker.
  assert.equal(Object.hasOwn(JSON.parse(preview.packet.write_args_json), "authority_requirements"), false);
  assert.equal(
    Object.hasOwn(
      emptyRuntime.calls.find(({ name }) => name === "dry_run_job_assignment").args,
      "authority_requirements",
    ),
    false,
  );

  for (const [state, nonce] of [
    [{ rosterUnavailable: true }, "nonce-roster-unavailable"],
    [{ rosterMalformed: true }, "nonce-roster-malformed"],
  ]) {
    const runtime = invoker(brokerConfig, state);
    const broker = createProductionScheduleApprovalBroker({
      config: brokerConfig,
      invokeMcp: runtime.invokeMcp,
      now: () => NOW,
      nonceStore: createNonceStore(),
    });
    const response = await broker.handle(request(
      brokerConfig,
      "/v1/production-schedule/preview",
      body,
      nonce,
    ));
    assert.equal(response.status, 422);
    const failure = await verifiedBody(response, brokerConfig, "/v1/production-schedule/preview", body, nonce);
    assert.match(failure.error, /^broker_production_schedule_crew_roster_(unavailable|invalid)$/);
    // It never reached the dry run: an assignment whose authority cannot be
    // compiled is not previewed at all.
    assert.deepEqual(runtime.calls.map(({ name }) => name), ["get_crew_authority_roster"]);
  }
});

// ELEC-128 defect 2. `#105` added `authority_requirements` to the broker's write args
// and nothing updated the Worker's `matchesExactWriteArgs` key list. Its length check
// is exact, so EVERY real packet failed it: `parsePreviewPacket` threw a plain error,
// the caller's fallback answered `502 production_schedule_broker_unavailable`, and the
// production-schedule rail was permanently unreachable while the broker itself was
// answering correctly. The broker-only test above passed throughout - it never asked
// the Worker to read what the broker had just produced.
//
// These two hold the seam itself, in both directions.

test("the Worker parses the real broker packet, compiled authority requirements and all", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();

  // The Worker's OWN parse of the broker's OWN output - the step nothing covered.
  const packet = await previewProductionScheduleApproval(
    workerEnv(brokerConfig),
    workerPreviewInput(body),
    {
      now: () => NOW,
      nonce: () => "nonce-worker-parses-authority",
      fetch: async (input, init) => await broker.handle(input instanceof Request ? input : new Request(input, init)),
    },
  );

  assert.equal(packet.targetName, "assignment:job-1-production-crew-metal-1");
  assert.deepEqual(
    JSON.parse(packet.writeArgsJson).authority_requirements,
    EXPECTED_REQUIREMENTS,
    "the parsed packet must carry the exact compiled requirement list",
  );
  assert.deepEqual(packet.productionScheduleGatePreview, { required: true, stateEligible: true });
});

test("the broker's write-arg key set and the Worker's expected key set match in both directions", async () => {
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();

  // Direction 1 - the broker grew a key. Reading the key set back through the WORKER's
  // parse, not the broker's response, is what makes this direction real: a key added to
  // `writeArgsFromInput` without teaching `matchesExactWriteArgs` fails here, which is
  // precisely what #105 shipped and no test caught.
  const parsed = await previewProductionScheduleApproval(
    workerEnv(brokerConfig),
    workerPreviewInput(body),
    {
      now: () => NOW,
      nonce: () => "nonce-keyset-drift",
      fetch: async (input, init) => await broker.handle(input instanceof Request ? input : new Request(input, init)),
    },
  );
  const produced = Object.keys(JSON.parse(parsed.writeArgsJson)).sort();
  assert.deepEqual(produced, [
    "approved_by",
    "assigned_by",
    "assignment_type",
    "authority_requirements",
    "correction_reason",
    "crew_profile_id",
    "notes",
    "request_text",
    "roof_job_id",
    "run_id",
    "scheduled_end",
    "scheduled_start",
    "status",
    "supersedes",
  ]);

  // Direction 2 - the Worker expects a key the broker does not send. A parser that
  // required `authority_requirements` would refuse the legitimate empty-roster packet,
  // which the broker deliberately leaves for Frappe to refuse by its own authority.
  const emptyRosterRuntime = invoker(brokerConfig, { roster: [] });
  const emptyRosterBroker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: emptyRosterRuntime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const packet = await previewProductionScheduleApproval(
    workerEnv(brokerConfig),
    workerPreviewInput(body),
    {
      now: () => NOW,
      nonce: () => "nonce-keyset-empty-roster",
      fetch: async (input, init) =>
        await emptyRosterBroker.handle(input instanceof Request ? input : new Request(input, init)),
    },
  );
  assert.equal(
    Object.hasOwn(JSON.parse(packet.writeArgsJson), "authority_requirements"),
    false,
    "an empty active roster compiles to no requirements and the key is omitted",
  );
});

test("the Worker refuses authority requirements scoped to another job", async () => {
  // The compiled list travels inside the approved write args, so a broker that widened
  // it to another job's authority would be approving something the packet does not say.
  const brokerConfig = config();
  const runtime = invoker(brokerConfig);
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const body = previewInput();
  await assert.rejects(
    previewProductionScheduleApproval(
      workerEnv(brokerConfig),
      workerPreviewInput(body),
      {
        now: () => NOW,
        nonce: () => "nonce-foreign-scope",
        fetch: async (input, init) => {
          const response = await broker.handle(input instanceof Request ? input : new Request(input, init));
          const payload = JSON.parse(await response.text());
          const writeArgs = JSON.parse(payload.packet.write_args_json);
          writeArgs.authority_requirements = writeArgs.authority_requirements.map((row) => ({
            ...row,
            scope_ref: "job:someone-elses",
          }));
          payload.packet.write_args_json = JSON.stringify(writeArgs);
          return new Response(JSON.stringify(payload), {
            status: response.status,
            headers: response.headers,
          });
        },
      },
    ),
    /production_schedule_broker_response_invalid/,
  );
});

test("a collapsed refusal logs its real cause while the caller still gets the narrow code", async () => {
  // ELEC-128's "open the error masks". The narrow code is deliberate - a caller must not
  // learn Frappe's internals from a refusal - but it was also the ONLY thing anyone could
  // see, so reading the real error took child-process interception plus container logs.
  // The cause belongs in the operator's log; the response must not change.
  const brokerConfig = config();
  const runtime = invoker(brokerConfig, { rosterUnavailable: true });
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });

  const logged = [];
  const realError = console.error;
  console.error = (...parts) => logged.push(parts.map(String).join(" "));
  let preview;
  try {
    const body = previewInput();
    preview = await verifiedBody(
      await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", body, "nonce-mask-opened-log")),
      brokerConfig,
      "/v1/production-schedule/preview",
      body,
      "nonce-mask-opened-log",
    );
  } finally {
    console.error = realError;
  }

  // Unchanged for the caller.
  assert.equal(preview.error, "broker_production_schedule_crew_roster_unavailable");
  assert.equal(
    JSON.stringify(preview).includes("erpnext_http_404"),
    false,
    "the underlying provider error must never reach the caller",
  );

  // Visible to whoever is holding the pager.
  const crewLog = logged.find((line) => line.includes("crew_roster failed"));
  assert.ok(crewLog, "the swallowed roster failure must be logged");
  assert.ok(crewLog.includes("erpnext_http_404"), "the log must carry the real cause");
  assert.ok(crewLog.includes("crew_profile_id=crew:metal-1"), "and the identity it failed on");
});

/** Drive preview + execute once and return the verified execute body. */
async function executeOnce(brokerConfig, runtime, nonce) {
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });
  const initial = previewInput();
  const preview = await verifiedBody(
    await broker.handle(request(brokerConfig, "/v1/production-schedule/preview", initial, `${nonce}-preview`)),
    brokerConfig,
    "/v1/production-schedule/preview",
    initial,
    `${nonce}-preview`,
  );
  const body = executionBody(preview);
  const outcome = await verifiedBody(
    await broker.handle(request(brokerConfig, "/v1/production-schedule/execute", body, `${nonce}-execute`)),
    brokerConfig,
    "/v1/production-schedule/execute",
    body,
    `${nonce}-execute`,
  );
  return { outcome, preview, body };
}

const AUTHORITY_REFUSAL = {
  code: "authority_missing_current_authority",
  message:
    "the exact tenant-scoped Authority Record requirements are not satisfied: no current authority " +
    "matches the exact tenant, subject, kind, and scope: Worker Competency for installer@example.com " +
    "scoped to Roof Job job:1",
  mutation_applied: false,
};

test("a crew member with no competency record is refused, and the approver is told which one", async () => {
  // ELEC-132's second negative proof. The gate already refused correctly; what it could
  // not do was say why. `execution_uncertain` was doubly wrong here - it told the approver
  // a deliberate decision was an unknown outcome, and it queued reconciliation work for a
  // write that provably never happened.
  const brokerConfig = config();
  const runtime = invoker(brokerConfig, { writeRefusal: AUTHORITY_REFUSAL });
  const logged = [];
  const realError = console.error;
  console.error = (...parts) => logged.push(parts.map(String).join(" "));
  let outcome;
  try {
    ({ outcome } = await executeOnce(brokerConfig, runtime, "nonce-production-refusal-1"));
  } finally {
    console.error = realError;
  }

  assert.equal(outcome.outcome.state, "failed");
  assert.equal(outcome.outcome.error_code, "broker_production_schedule_refused");
  assert.equal(outcome.outcome.result_json, null);
  assert.equal(outcome.outcome.refusal.code, "authority_missing_current_authority");
  assert.match(outcome.outcome.refusal.message, /^the exact tenant-scoped/);
  assert.match(outcome.outcome.refusal.message, /Worker Competency/);
  assert.match(outcome.outcome.refusal.message, /installer@example\.com/);
  // No assignment was created, and the refusal is still logged for whoever holds the pager.
  assert.equal(runtime.counts().assignmentCreates, 0);
  assert.ok(logged.find((line) => line.includes("write failed") && line.includes("authority_missing_current_authority")));
});

test("a failure that is not a decision is still an uncertain execution", async () => {
  // The narrow default has to survive the new path: only a refusal that carried its own
  // proof of non-application may claim `failed`. Everything else keeps the ambiguity,
  // because a write that started may have landed.
  const brokerConfig = config();
  const runtime = invoker(brokerConfig, { writeFailure: "erpnext_timeout_10000ms" });
  const realError = console.error;
  console.error = () => {};
  let outcome;
  try {
    ({ outcome } = await executeOnce(brokerConfig, runtime, "nonce-production-refusal-2"));
  } finally {
    console.error = realError;
  }

  assert.equal(outcome.outcome.state, "execution_uncertain");
  assert.equal(outcome.outcome.error_code, "broker_mcp_call_ambiguous");
  assert.equal(Object.hasOwn(outcome.outcome, "refusal"), false);
  // And the provider's own error text never reaches the caller.
  assert.equal(JSON.stringify(outcome).includes("erpnext_timeout"), false);
});

test("the Worker re-derives the refusal it shows an approver", async () => {
  // The cross-boundary half: the real broker response, parsed by the real Worker client.
  // Everything the approver is shown is re-derived here under a fixed key set and a plain
  // character class - the broker is private and signed, but a refusal is the one part of a
  // failed execution that reaches a human as prose.
  const brokerConfig = config();
  const runtime = invoker(brokerConfig, { writeRefusal: AUTHORITY_REFUSAL });
  const broker = createProductionScheduleApprovalBroker({
    config: brokerConfig,
    invokeMcp: runtime.invokeMcp,
    now: () => NOW,
    nonceStore: createNonceStore({ now: () => NOW }),
  });

  const realError = console.error;
  console.error = () => {};
  let outcome;
  try {
    const brokerFetch = async (input, init) =>
      await broker.handle(input instanceof Request ? input : new Request(input, init));
    const packet = await previewProductionScheduleApproval(
      workerEnv(brokerConfig),
      workerPreviewInput(previewInput()),
      { fetch: brokerFetch, now: () => NOW, nonce: () => "nonce-worker-refusal-preview" },
    );
    outcome = await executeProductionScheduleApproval(
      workerEnv(brokerConfig),
      {
        production_schedule_approval_id: packet.approvalRequestId,
        tenant_id: packet.tenantId,
        request_kind: packet.requestKind,
        write_tool: packet.writeTool,
        dry_run_tool: packet.dryRunTool,
        agent_role: packet.agentRole,
        actor_user: packet.actorUser,
        site_id: packet.siteId,
        target_doctype: packet.targetDoctype,
        target_name: packet.targetName,
        roof_job_id: packet.roofJobId,
        crew_profile_id: packet.crewProfileId,
        scheduled_start: packet.scheduledStart,
        scheduled_end: packet.scheduledEnd,
        supersedes_assignment_id: packet.supersedesAssignmentId,
        correction_reason: packet.correctionReason,
        request_text: packet.requestText,
        write_args_json: packet.writeArgsJson,
        preview_json: packet.previewJson,
        args_digest: packet.argsDigest,
        preview_digest: packet.previewDigest,
        receipt_preview_digest: packet.receiptPreviewDigest,
        dry_run_receipt: packet.dryRunReceipt,
        expires_at: packet.expiresAt,
        run_id: packet.runId,
        approved_by_frappe_user: "owner@example.com",
        decision_idempotency_key: "decision-production-schedule-refusal",
      },
      { fetch: brokerFetch, now: () => NOW, nonce: () => "nonce-worker-refusal-execute" },
    );
  } finally {
    console.error = realError;
  }

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.errorCode, "broker_production_schedule_refused");
  assert.equal(outcome.resultJson, null);
  assert.equal(outcome.refusal.code, "authority_missing_current_authority");
  assert.match(outcome.refusal.message, /^the exact tenant-scoped/);
  assert.match(outcome.refusal.message, /Worker Competency/);
  assert.match(outcome.refusal.message, /installer@example\.com/);
});
