import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  attestFrappeServicePrincipal,
  assertGateEvidenceForState,
  assertMaterialTakeoffReplaySafe,
  assertWriteApproved,
  buildGateUpdatePatch,
  buildAuditFinalizationIncidentDraft,
  buildMaterialTakeoffDraft,
  buildMaterialTakeoffDraftFromErp,
  buildMaterialTakeoffStatusPatch,
  buildProposalEvidencePackDraft,
  buildQuotePriceRuleSnapshot,
  buildSupplierOrderDraft,
  configFromEnv,
  erpGet,
  erpPost,
  erpPut,
  executeAuditedWrite,
  materialTakeoffIdForRoofJob,
  normalizeFrappeBaseUrl,
  normalizeEffectRuntimeBaseUrl,
  parseRequestTimeout,
  prepareMaterialTakeoffWriteFromErp,
  proposalPackIdForCustomerQuote,
  redactApprovalArgs,
  resourceListPath,
  resourcePath,
  selectUniqueEffectiveTakeoffPolicyId,
  selectUniqueGovernedMeasurementReport,
  supplierOrderIdForTakeoff,
} from "../src/server.mjs";

const { publicKey: approvalPublicKey } = generateKeyPairSync("ed25519");
const APPROVAL_PUBLIC_KEY = approvalPublicKey.export({ type: "spki", format: "pem" });
const ROLE_ENV = {
  HERMES_AGENT_ROLE: "owner-operator",
  HERMES_ACTOR_USER: "owner@example.com",
  HERMES_APPROVER_ID: "owner@example.com",
  ERPNEXT_TENANT_ID: "ironwrap",
};

test("MCP runtime explicitly supports direct governed Worker TypeScript imports", () => {
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.0.0");
});

test("configFromEnv requires ERPNext credentials, runtime role binding, and receipt keys", () => {
  assert.throws(() => configFromEnv({}), /ERPNEXT_BASE_URL/);
  assert.throws(() => configFromEnv({ ERPNEXT_BASE_URL: "https://erp.example" }), /ERPNEXT_API_KEY/);
  assert.throws(() => configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example",
    ERPNEXT_API_KEY: "key",
  }), /ERPNEXT_API_SECRET/);
  assert.throws(() => configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  }), /HERMES_AGENT_ROLE/);
  const readOnly = configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ...ROLE_ENV,
  });
  assert.equal(readOnly.baseUrl, "https://erp.example");
  assert.equal(readOnly.writeEnabled, false);
  assert.equal(readOnly.agentRole, "owner-operator");
  assert.equal(readOnly.actorUser, "owner@example.com");
  assert.equal(readOnly.tenantId, "ironwrap");
  assert.ok(readOnly.allowedTools.includes("request_update_gate"));

  const localReadOnly = configFromEnv({
    ERPNEXT_BASE_URL: "http://127.0.0.1:19090",
    ERPNEXT_ALLOW_INSECURE_LOCAL: "true",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ...ROLE_ENV,
  });
  assert.equal(localReadOnly.baseUrl, "http://127.0.0.1:19090");
  assert.equal(localReadOnly.allowInsecureLocal, true);

  assert.throws(() => configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_WRITE_ENABLED: "true",
    ...ROLE_ENV,
  }), /HERMES_DRY_RUN_SIGNING_KEY/);
  const writable = configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_WRITE_ENABLED: "true",
    ...ROLE_ENV,
    HERMES_DRY_RUN_SIGNING_KEY: "a".repeat(32),
    HERMES_APPROVAL_PUBLIC_KEY: APPROVAL_PUBLIC_KEY,
    ERPNEXT_REQUEST_TIMEOUT_MS: "2500",
    IRONWRAP_EFFECT_RUNTIME_URL: "https://bus.example",
    IRONWRAP_EFFECT_RUNTIME_TOKEN: "admin-token",
  });
  assert.equal(writable.requestTimeoutMs, 2500);
  assert.equal(writable.dryRunSigningKey, "a".repeat(32));
  assert.equal(writable.approvalPublicKey, APPROVAL_PUBLIC_KEY);
  assert.equal(writable.approverId, "owner@example.com");
  assert.equal(writable.effectRuntimeEnabled, true);
  assert.throws(() => configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_WRITE_ENABLED: "true",
    ...ROLE_ENV,
    HERMES_DRY_RUN_SIGNING_KEY: "a".repeat(32),
    HERMES_APPROVAL_PUBLIC_KEY: APPROVAL_PUBLIC_KEY,
  }), /IRONWRAP_EFFECT_RUNTIME_URL/);
});

test("Frappe endpoint configuration is HTTPS-only and timeout-bounded", () => {
  assert.equal(normalizeFrappeBaseUrl("https://erp.example/site/"), "https://erp.example/site");
  assert.equal(normalizeFrappeBaseUrl("http://127.0.0.1:8000", true), "http://127.0.0.1:8000");
  assert.throws(() => normalizeFrappeBaseUrl("http://erp.example"), /must use HTTPS/);
  assert.throws(() => normalizeFrappeBaseUrl("https://user:pass@erp.example"), /must not contain credentials/);
  assert.equal(parseRequestTimeout(undefined), 10_000);
  assert.equal(parseRequestTimeout("60000"), 60_000);
  assert.throws(() => parseRequestTimeout("999"), /1000 to 60000/);
  assert.throws(() => parseRequestTimeout("nope"), /1000 to 60000/);
  assert.equal(normalizeEffectRuntimeBaseUrl("https://bus.example/"), "https://bus.example");
  assert.throws(() => normalizeEffectRuntimeBaseUrl("http://bus.example"), /must use HTTPS/);
});

test("runtime-governed MCP Frappe writes claim, provider-write, read back, and settle one effect", async (t) => {
  const config = {
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    requestTimeoutMs: 2_500,
    tenantId: "ironwrap",
    actorUser: "owner@example.com",
    effectRuntimeUrl: "https://bus.example",
    effectRuntimeToken: "admin-token",
    effectRuntimeEnabled: true,
    __externalEffectContext: {
      runId: "run:effect-001",
      toolName: "request_update_gate",
      target: { doctype: "Production Gate State", name: "gate-001" },
      mutationApplied: false,
    },
  };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === "https://bus.example/admin/effects/claim") {
      return Response.json({
        effect: { effect_id: "effect:mcp-001" },
        attempt: { attempt_id: "effect:mcp-001:attempt:1" },
      });
    }
    if (target === "https://erp.example/api/resource/Production%20Gate%20State/gate-001" && init.method === "POST") {
      return Response.json({ data: { name: "gate-001" } });
    }
    if (target === "https://erp.example/api/resource/Production%20Gate%20State/gate-001" && init.method === "GET") {
      return Response.json({ data: { name: "gate-001", state: "Ready" } });
    }
    if (target === "https://bus.example/admin/effects/settle") {
      return Response.json({
        effect: { state: "succeeded", result_code: null },
        attempt: { state: "succeeded" },
        value: { data: { name: "gate-001" } },
      });
    }
    throw new Error(`unexpected_fetch:${target}`);
  });
  const result = await erpPost(config, "/api/resource/Production%20Gate%20State/gate-001", { state: "Ready" });
  assert.deepEqual(result, { data: { name: "gate-001" } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.headers.authorization, "Bearer admin-token");
  assert.equal(calls[1].init.headers.authorization, "token key:secret");
  assert.equal(calls[2].init.method, "GET");
  assert.equal(calls[3].init.headers.authorization, "Bearer admin-token");
  assert.equal(config.__externalEffectContext.mutationApplied, true);
});

test("erpGet sends Frappe token auth and parses JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://erp.example/api/resource/Roof%20Job/job%3Aow_1");
    assert.equal(init.headers.authorization, "token key:secret");
    return new Response(JSON.stringify({ data: { name: "job:ow_1" } }), { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await erpGet({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, resourcePath("Roof Job", "job:ow_1")), {
    data: { name: "job:ow_1" },
  });
});

test("Frappe service-key principal attestation succeeds only for the configured Hermes actor", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://erp.example/api/method/frappe.auth.get_logged_user");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "token key:secret");
    return Response.json({ message: "owner@example.com" });
  });

  assert.equal(await attestFrappeServicePrincipal({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    actorUser: "owner@example.com",
  }), "owner@example.com");
});

test("Frappe service-key principal attestation fails closed on actor mismatch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "different-user@example.com" }));

  await assert.rejects(() => attestFrappeServicePrincipal({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    actorUser: "owner@example.com",
  }), /frappe_service_principal_mismatch/);
});

test("erpGet reports non-2xx ERPNext responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 403 }));
  await assert.rejects(() => erpGet({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "bad",
  }, "/api/resource/Roof%20Job/job%3Aow_1"), /erpnext_http_403/);
});

test("erpGet rejects a successful non-JSON response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>login</html>", { status: 200 }));
  await assert.rejects(() => erpGet({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, "/api/resource/Roof%20Job/job_1"), /erpnext_invalid_json_200/);
});

test("executeAuditedWrite returns a completed run without repeating the mutation", async (t) => {
  let executeCount = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(url, "https://erp.example/api/resource/Hermes%20Run/hr_retry_123");
    return new Response(JSON.stringify({ data: {
      run_id: "hr_retry_123",
      agent_role: "Production Controller",
      tool_name: "request_update_gate",
      target_doctype: "Production Gate State",
      target_name: "gate_1",
      tool_args_json: JSON.stringify({
        run_id: "hr_retry_123",
        gate_id: "gate_1",
        request_text: "approved gate transition",
        approved_by: "owner@example.com",
      }),
      approval_status: "Executed",
      result_status: "OK",
      result_json: JSON.stringify({ data: { name: "gate_1", state: "Ready" } }),
    } }), { headers: { "content-type": "application/json" } });
  });

  const result = await executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_retry_123",
    now: "2026-07-10T10:00:00.000Z",
    args: {
      run_id: "hr_retry_123",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
      approval_token: "redacted",
    },
    agentRole: "Production Controller",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    roofJob: "job_1",
    dryRun: { patch: { state: "Ready" } },
    beforeSummary: { state: "Blocked" },
    afterSummary: { state: "Ready" },
    execute: async () => {
      executeCount += 1;
      return { data: { name: "gate_1" } };
    },
  });

  assert.equal(result.replayed, true);
  assert.equal(result.audit_finalized, true);
  assert.equal(result.result.data.state, "Ready");
  assert.equal(executeCount, 0);
});

test("executeAuditedWrite never executes a run another caller has already claimed", async (t) => {
  let executeCount = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: {
    run_id: "hr_inflight_1",
    agent_role: "Owner Operator",
    tool_name: "request_update_gate",
    target_doctype: "Production Gate State",
    target_name: "gate_1",
    tool_args_json: JSON.stringify({
      run_id: "hr_inflight_1",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
    }),
    approval_status: "Approved",
    result_status: "",
    mutation_applied: 0,
  } }), { headers: { "content-type": "application/json" } }));

  await assert.rejects(() => executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_inflight_1",
    now: "2026-07-10T10:00:00.000Z",
    args: {
      run_id: "hr_inflight_1",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
    },
    agentRole: "Owner Operator",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    dryRun: { patch: { state: "Ready" } },
    beforeSummary: { state: "Blocked" },
    afterSummary: { state: "Ready" },
    execute: async () => {
      executeCount += 1;
      return { data: { name: "gate_1" } };
    },
  }), /run_id_claimed_not_replayable/);
  assert.equal(executeCount, 0);
});

test("executeAuditedWrite never repeats a mutation whose audit finalization failed", async (t) => {
  let executeCount = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: {
    run_id: "hr_audit_failed_1",
    agent_role: "Production Controller",
    tool_name: "request_update_gate",
    target_doctype: "Production Gate State",
    target_name: "gate_1",
    tool_args_json: JSON.stringify({
      run_id: "hr_audit_failed_1",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
    }),
    approval_status: "Audit Failed",
    result_status: "Error",
    mutation_applied: 1,
    audit_incident_id: "incident:audit:hr_audit_failed_1",
    result_json: JSON.stringify({ data: { name: "gate_1", state: "Ready" } }),
  } }), { headers: { "content-type": "application/json" } }));

  await assert.rejects(() => executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_audit_failed_1",
    now: "2026-07-10T10:00:00.000Z",
    args: {
      run_id: "hr_audit_failed_1",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
      approval_token: "redacted",
    },
    agentRole: "Production Controller",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    roofJob: "job_1",
    dryRun: { patch: { state: "Ready" } },
    beforeSummary: { state: "Blocked" },
    afterSummary: { state: "Ready" },
    execute: async () => {
      executeCount += 1;
      return { data: { name: "gate_1" } };
    },
  }), /run_id_mutation_already_applied_audit_failed:hr_audit_failed_1/);
  assert.equal(executeCount, 0);
});

test("executeAuditedWrite records the complete Frappe policy and mutation audit contract", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "GET") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    writes.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { name: "hr_policy_123", state: "Ready" } }), {
      headers: { "content-type": "application/json" },
    });
  });

  const result = await executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_policy_123",
    now: "2026-07-10T10:00:00.000Z",
    args: {
      run_id: "hr_policy_123",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
      approval_token: "must-never-be-audited",
    },
    agentRole: "Production Controller",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    roofJob: "job_1",
    dryRun: { patch: { state: "Ready" } },
    beforeSummary: { state: "Blocked" },
    afterSummary: { state: "Ready" },
    execute: async () => ({ data: { name: "gate_1", state: "Ready" } }),
  });

  assert.equal(result.audit_finalized, true);
  assert.equal(writes.length, 2);
  const draft = writes[0].body;
  assert.equal(writes[0].method, "POST");
  assert.equal(JSON.parse(draft.policy_check_json).allowed, true);
  assert.equal(draft.policy_checked_by, "owner@example.com");
  assert.equal(draft.request_correlation_id, "hr_policy_123");
  assert.equal(draft.mutation_applied, 0);
  assert.equal(draft.tool_args_json.includes("must-never-be-audited"), false);
  // MariaDB DATETIME columns reject ISO-8601 "T…Z" text: audit rows use Frappe format.
  assert.match(draft.run_ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // An omitted Select defaults to its first option in Frappe; the draft pins the
  // explicit empty result_status so the pre-execution state stays honest.
  assert.equal(draft.result_status, "");

  const completed = writes[1].body;
  assert.equal(writes[1].method, "PUT");
  assert.equal(completed.approval_status, "Executed");
  assert.equal(completed.result_status, "OK");
  assert.equal(completed.mutation_applied, 1);
  assert.equal(completed.audit_event_id, "audit:hr_policy_123");
  assert.equal(completed.request_correlation_id, "hr_policy_123");
  assert.match(completed.completed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(JSON.parse(completed.after_target_ids), { state: "Ready" });
});

test("executeAuditedWrite records a verified no-op replay without claiming target mutation", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.method === "GET") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    writes.push({ method: init.method, body: JSON.parse(init.body) });
    return Response.json({ data: { name: "hr_takeoff_replay_1" } });
  });

  const result = await executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_takeoff_replay_1",
    now: "2026-09-15T10:00:00.000Z",
    args: {
      run_id: "hr_takeoff_replay_1",
      roof_job_id: "job:ow_1",
      request_text: "replay exact historical takeoff",
      approved_by: "owner@example.com",
    },
    agentRole: "Estimator",
    toolName: "request_create_material_takeoff",
    target: { doctype: "Material Takeoff", name: "takeoff:job:ow_1" },
    roofJob: "job:ow_1",
    dryRun: { operation: "replay", target_mutation: false },
    beforeSummary: { calculation_digest: "a".repeat(64) },
    afterSummary: { calculation_digest: "a".repeat(64) },
    targetMutation: false,
    execute: async () => ({ name: "takeoff:job:ow_1", calculation_digest: "a".repeat(64) }),
  });

  assert.equal(result.audit_finalized, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.mutation_applied, 0);
  assert.equal(writes[1].body.mutation_applied, 0);
});

test("audit-finalization incidents match the owned Automation Incident schema", () => {
  const draft = buildAuditFinalizationIncidentDraft({
    incidentId: "incident:audit:hr_policy_123",
    runId: "hr_policy_123",
    now: "2026-07-10T10:00:00.000Z",
    roofJob: "job_1",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    auditError: "frappe timeout",
  });
  assert.equal(draft.severity, "High");
  assert.equal(draft.record_ref, "Hermes Run:hr_policy_123");
  assert.equal(draft.correlation_id, "hr_policy_123");
  assert.equal("hermes_run" in draft, false);
  assert.deepEqual(JSON.parse(draft.details).target, {
    doctype: "Production Gate State",
    name: "gate_1",
  });
});

test("audit finalization failure preserves that the target mutation happened", async (t) => {
  const writes = [];
  let hermesPutCount = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "GET") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(init.body);
    writes.push({ url, method: init.method, body });
    if (init.method === "PUT" && url.includes("Hermes%20Run")) {
      hermesPutCount += 1;
      if (hermesPutCount === 1) {
        return new Response(JSON.stringify({ error: "audit store unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ data: { name: body.incident_id ?? "hr_audit_failure_1" } }), {
      headers: { "content-type": "application/json" },
    });
  });

  await assert.rejects(() => executeAuditedWrite({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, {
    runId: "hr_audit_failure_1",
    now: "2026-07-10T10:00:00.000Z",
    args: {
      run_id: "hr_audit_failure_1",
      gate_id: "gate_1",
      request_text: "approved gate transition",
      approved_by: "owner@example.com",
      approval_token: "redacted",
    },
    agentRole: "Production Controller",
    toolName: "request_update_gate",
    target: { doctype: "Production Gate State", name: "gate_1" },
    roofJob: "job_1",
    dryRun: { patch: { state: "Ready" } },
    beforeSummary: { state: "Blocked" },
    afterSummary: { state: "Ready" },
    execute: async () => ({ data: { name: "gate_1", state: "Ready" } }),
  }), /audit_finalize_failed:hr_audit_failure_1:incident=incident:audit:hr_audit_failure_1/);

  const incident = writes.find((write) => write.url.endsWith("/api/resource/Automation%20Incident") && write.method === "POST");
  assert.equal(incident.body.incident_id, "incident:audit:hr_audit_failure_1");
  const auditFailed = writes.find((write) => write.body.approval_status === "Audit Failed");
  assert.equal(auditFailed.body.result_status, "Error");
  assert.equal(auditFailed.body.mutation_applied, 1);
  assert.equal(auditFailed.body.audit_incident_id, "incident:audit:hr_audit_failure_1");
  assert.deepEqual(JSON.parse(auditFailed.body.result_json), { data: { name: "gate_1", state: "Ready" } });
  assert.equal(writes.some((write) => write.body.approval_status === "Failed"), false);
});

test("erpPut sends JSON body with Frappe token auth", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://erp.example/api/resource/Production%20Gate%20State/gate_1");
    assert.equal(init.method, "PUT");
    assert.equal(init.headers.authorization, "token key:secret");
    assert.equal(init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { state: "Ready", blocker_reason: "" });
    return new Response(JSON.stringify({ data: { name: "gate_1" } }), { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await erpPut({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, resourcePath("Production Gate State", "gate_1"), { state: "Ready", blocker_reason: "" }), {
    data: { name: "gate_1" },
  });
});

test("resource paths encode Frappe DocTypes, names, fields, and filters", () => {
  assert.equal(resourcePath("Lead Envelope", "ow_1"), "/api/resource/Lead%20Envelope/ow_1");
  const path = resourceListPath("Production Gate State", {
    fields: ["name", "roof_job", "state"],
    filters: [["Production Gate State", "state", "=", "Blocked"]],
    limit: 5,
    orderBy: "modified desc",
  });
  assert.match(path, /^\/api\/resource\/Production%20Gate%20State\?/);
  assert.match(path, /limit_page_length=5/);
  assert.match(path, /order_by=modified\+desc/);
  const params = new URLSearchParams(path.split("?")[1]);
  assert.deepEqual(JSON.parse(params.get("fields")), ["name", "roof_job", "state"]);
  assert.deepEqual(JSON.parse(params.get("filters")), [["Production Gate State", "state", "=", "Blocked"]]);
  assert.equal(resourcePath("Hermes Run", "hr_1"), "/api/resource/Hermes%20Run/hr_1");
  assert.equal(resourcePath("Measurement Report", "measurement:ow_1"), "/api/resource/Measurement%20Report/measurement%3Aow_1");
  assert.equal(resourcePath("Material Takeoff", "takeoff:job:ow_1"), "/api/resource/Material%20Takeoff/takeoff%3Ajob%3Aow_1");
  assert.equal(resourcePath("Supplier Order", "supplier:takeoff:job:ow_1"), "/api/resource/Supplier%20Order/supplier%3Atakeoff%3Ajob%3Aow_1");
  assert.equal(resourcePath("Instant Estimate Session", "estimate:ow_1"), "/api/resource/Instant%20Estimate%20Session/estimate%3Aow_1");
  assert.equal(resourcePath("Evidence Item", "evidence:measurement:ow_1"), "/api/resource/Evidence%20Item/evidence%3Ameasurement%3Aow_1");
  assert.equal(resourcePath("Field Check-in", "field:ow_1"), "/api/resource/Field%20Check-in/field%3Aow_1");
  assert.equal(resourcePath("Proposal Evidence Pack", "proposal:job:ow_1"), "/api/resource/Proposal%20Evidence%20Pack/proposal%3Ajob%3Aow_1");
  assert.equal(resourcePath("Payment Milestone", "qb:R1:Invoice:42"), "/api/resource/Payment%20Milestone/qb%3AR1%3AInvoice%3A42");
});

test("write approval and gate patch helpers enforce narrow mutation rules", () => {
  assert.throws(() => assertWriteApproved({ writeEnabled: false }, {}), /erpnext_write_disabled/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true }, {}), /hermes_dry_run_signing_key_required/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true, dryRunSigningKey: "a".repeat(32) }, {}), /hermes_approval_public_key_required/);
  assert.throws(() => assertWriteApproved({
    writeEnabled: true,
    dryRunSigningKey: "a".repeat(32),
    approvalPublicKey: APPROVAL_PUBLIC_KEY,
  }, {}), /dry_run_receipt_required/);
  assert.doesNotThrow(() => assertWriteApproved({
    writeEnabled: true,
    dryRunSigningKey: "a".repeat(32),
    approvalPublicKey: APPROVAL_PUBLIC_KEY,
  }, { dry_run_receipt: "receipt", approval_receipt: "receipt" }));

  assert.deepEqual(buildGateUpdatePatch("Ready", "old reason", undefined, undefined, "evidence:ready-1"), {
    state: "Ready",
    blocker_reason: "",
    evidence_item: "evidence:ready-1",
  });
  assert.deepEqual(buildGateUpdatePatch("Done", undefined, undefined, undefined, "evidence:done-1"), {
    state: "Done",
    blocker_reason: "",
    evidence_item: "evidence:done-1",
  });
  assert.deepEqual(buildGateUpdatePatch("Blocked", "waiting on deposit"), { state: "Blocked", blocker_reason: "waiting on deposit" });
  assert.deepEqual(buildGateUpdatePatch("Waived", "owner override", "owner@example.com", "2026-07-08T10:00:00.000Z"), {
    state: "Waived",
    blocker_reason: "",
    waiver_reason: "owner override",
    waived_by: "owner@example.com",
    waived_at: "2026-07-08T10:00:00.000Z",
  });
  assert.throws(() => buildGateUpdatePatch("Blocked", ""), /reason_required/);
  assert.throws(() => buildGateUpdatePatch("Waived", ""), /reason_required/);
  assert.throws(() => buildGateUpdatePatch("Ready", ""), /evidence_item_required/);
  assert.throws(() => buildGateUpdatePatch("Done", "", undefined, undefined, ""), /evidence_item_required/);

  assert.deepEqual(buildMaterialTakeoffStatusPatch("Needs Review", "more photos needed"), {
    status: "Needs Review",
    approval_note: "more photos needed",
    approved_by: "",
    approved_at: "",
  });
  assert.deepEqual(buildMaterialTakeoffStatusPatch("Approved", "matches RoofRuler report", "estimator@example.com", "2026-07-08T10:00:00.000Z"), {
    status: "Approved",
    approval_note: "matches RoofRuler report",
    approved_by: "estimator@example.com",
    approved_at: "2026-07-08T10:00:00.000Z",
  });
  assert.deepEqual(buildMaterialTakeoffStatusPatch("Rejected", "missing eave length", "estimator@example.com", "2026-07-08T10:00:00.000Z"), {
    status: "Rejected",
    approval_note: "missing eave length",
    approved_by: "",
    approved_at: "",
  });
  assert.throws(() => buildMaterialTakeoffStatusPatch("Approved", ""), /reason_required/);
  assert.throws(() => buildMaterialTakeoffStatusPatch("Rejected", ""), /reason_required/);

  assert.deepEqual(redactApprovalArgs({
    gate_id: "gate_1",
    next_state: "Ready",
    approval_token: "secret",
  }), {
    gate_id: "gate_1",
    next_state: "Ready",
  });
});

test("gate readiness evidence is verified and bound to the gate Roof Job", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://erp.example/api/resource/Evidence%20Item/evidence%3Aready-1");
    return new Response(JSON.stringify({ data: {
      name: "evidence:ready-1",
      roof_job: "job-1",
      sync_state: "Verified",
      content_checksum: "a".repeat(64),
      checksum_algorithm: "SHA-256",
      verified_at: "2026-07-10 10:01:00",
      verification_source: "ironwrap-worker-r2-frappe",
      r2_key: "field/v1/job-1/evidence.jpg",
      proof_slot: "Production",
    } }), { headers: { "content-type": "application/json" } });
  });
  await assert.doesNotReject(assertGateEvidenceForState({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
  }, "Ready", "evidence:ready-1", "job-1"));
});

const ROOF_GRAPH_SHA = "a".repeat(64);
const POLICY_EVIDENCE_SHA = "b".repeat(64);

function governedRoofGraph({ needsReview = false } = {}) {
  const points = [
    { id: "P1", x: 0, y: 0, z: 0 },
    { id: "P2", x: 10, y: 0, z: 0 },
    { id: "P3", x: 10, y: 10, z: 0 },
    { id: "P4", x: 0, y: 10, z: 0 },
  ];
  const edges = [
    { id: "L1", from: "P1", to: "P2", type: "FASCIA", lengthDeclared: 10, lengthComputed: 10, deviation: 0 },
    { id: "L2", from: "P2", to: "P3", type: "FASCIA", lengthDeclared: 10, lengthComputed: 10, deviation: 0 },
    { id: "L3", from: "P3", to: "P4", type: "FASCIA", lengthDeclared: 10, lengthComputed: 10, deviation: 0 },
    { id: "L4", from: "P4", to: "P1", type: "FASCIA", lengthDeclared: 10, lengthComputed: 10, deviation: 0 },
  ];
  return {
    schema_version: "roof_graph/v1",
    revision: ROOF_GRAPH_SHA,
    source: {
      raw_key: "measurements/synthetic/job-1.xml",
      raw_sha256: ROOF_GRAPH_SHA,
      provider: "AppliCad",
      ingested_at: "2026-08-12T10:00:00.000Z",
      capture: { captured_at: null, provenance: "not_supplied" },
    },
    coordinate_system: { kind: "local_3d", crs: null, transform: null, provenance: "not_declared_by_source" },
    points,
    edges,
    facets: [{
      id: "F1",
      lineIds: edges.map((edge) => edge.id),
      contours: { outer: { role: "outer", lineIds: edges.map((edge) => edge.id), pointIds: points.map((point) => point.id), topologyIssues: [] }, holes: [] },
      areaDeclared: 100,
      areaComputed: 100,
      deviation: 0,
      pitch: 0,
      orientation: 0,
      pitchComputed: 0,
      orientationComputed: 0,
      planarityResidual: 0,
      material: null,
      type: "Roof",
      ringClosed: true,
    }],
    checks: [],
    needs_review: needsReview,
    measurements: { roof_area: 100, fascia_length: 40 },
    source_refs: { roof_area: "POLYGON recomputed", fascia_length: "LINE[type=FASCIA] recomputed" },
  };
}

function approvedTakeoffPolicy(overrides = {}) {
  return {
    name: "mtp:ironwrap:metal-roofing:ss16:v1",
    policy_id: "mtp:ironwrap:metal-roofing:ss16:v1",
    tenant: "ironwrap",
    brand: "ironwrap",
    service_type: "Metal Roofing",
    material_system: "standing_seam_16",
    policy_version: 1,
    status: "Approved",
    effective_from: "2026-08-01",
    effective_to: "",
    source_evidence: "evidence:mtp:ss16:v1",
    approved_by: "engineer@example.invalid",
    approved_at: "2026-08-01 12:00:00",
    approval_note: "Approved from engineered installation schedule IW-SS16-2026-01.",
    policy_json: JSON.stringify({
      schema_version: "material_takeoff_policy/v1",
      calculation_version: "material_takeoff/v1",
      options: {
        panel_item_id: "panel:ss16",
        coverage_width_ft: 1.25,
        length_increment_ft: 1 / 12,
        max_panel_length_ft: 40,
        mode: "coil",
        stock_lengths_ft: [],
        min_reusable_offcut_ft: 2,
        coil_allowances: { setup_ft: 5, tail_ft: 3, scrap_factor: 0.02 },
        trim_stock_ft: 10,
        trim_lap_ft: 0.5,
        trim_profiles: { FASCIA: "trim:eave_drip" },
        clip_spacing_ft: 2,
        screws_per_clip: 1,
        trim_screw_spacing_ft: 1.5,
        fastener_item_ids: { clip: "fastener:clip", clip_screw: "fastener:clip_screw", trim_screw: "fastener:trim_screw" },
      },
    }),
    ...overrides,
  };
}

const verifiedPolicyEvidence = () => ({
  name: "evidence:mtp:ss16:v1",
  evidence_id: "evidence:mtp:ss16:v1",
  sync_state: "Verified",
  checksum_algorithm: "SHA-256",
  content_checksum: POLICY_EVIDENCE_SHA,
  verified_at: "2026-08-01 11:50:00",
  verification_source: "ironwrap-owner-review",
});

test("material takeoff policy selection rejects ambiguity and a truncated authority window", () => {
  const effectiveAt = "2026-08-12T10:00:00.000Z";
  assert.equal(
    selectUniqueEffectiveTakeoffPolicyId([approvedTakeoffPolicy()], effectiveAt),
    "mtp:ironwrap:metal-roofing:ss16:v1",
  );
  assert.throws(
    () => selectUniqueEffectiveTakeoffPolicyId([
      approvedTakeoffPolicy(),
      approvedTakeoffPolicy({ name: "mtp:ironwrap:metal-roofing:ss16:v2", policy_id: "mtp:ironwrap:metal-roofing:ss16:v2", policy_version: 2 }),
    ], effectiveAt),
    /material_takeoff_policy_ambiguous/,
  );
  assert.throws(
    () => selectUniqueEffectiveTakeoffPolicyId(
      Array.from({ length: 101 }, (_, index) => approvedTakeoffPolicy({
        name: `mtp:ironwrap:metal-roofing:ss16:v${index + 1}`,
        policy_id: `mtp:ironwrap:metal-roofing:ss16:v${index + 1}`,
        policy_version: index + 1,
      })),
      effectiveAt,
    ),
    /material_takeoff_policy_selection_window_exceeded/,
  );
});

test("implicit measurement selection is unique, bounded, and never first-row-wins", () => {
  const valid = {
    name: "measurement:ow_1:v1",
    measurement_id: "measurement:ow_1:v1",
    roof_job: "job:ow_1",
    roof_graph_revision: ROOF_GRAPH_SHA,
    roof_graph_json: JSON.stringify(governedRoofGraph()),
  };
  assert.equal(
    selectUniqueGovernedMeasurementReport([valid], { roofJobId: "job:ow_1", truncated: false }),
    valid,
  );
  assert.throws(
    () => selectUniqueGovernedMeasurementReport([
      valid,
      { ...valid, name: "measurement:ow_1:v2", measurement_id: "measurement:ow_1:v2" },
    ], { roofJobId: "job:ow_1", truncated: false }),
    /material_takeoff_measurement_ambiguous/,
  );
  assert.throws(
    () => selectUniqueGovernedMeasurementReport([], { roofJobId: "job:ow_1", truncated: true }),
    /material_takeoff_measurement_window_truncated/,
  );
  assert.throws(
    () => selectUniqueGovernedMeasurementReport([valid], { roofJobId: "job:ow_1", truncated: true }),
    /material_takeoff_measurement_window_truncated/,
  );
});

test("implicit measurement reads one bounded sentinel while an explicit report stays exact", async (t) => {
  const measurementReport = {
    name: "measurement:ow_1:v1",
    measurement_id: "measurement:ow_1:v1",
    roof_job: "job:ow_1",
    provider: "AppliCad",
    review_status: "Approved",
    roof_graph_revision: ROOF_GRAPH_SHA,
    roof_graph_json: JSON.stringify(governedRoofGraph()),
  };
  const policy = approvedTakeoffPolicy();
  const requestedUrls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    requestedUrls.push(parsed);
    const encoded = (doctype, name) => `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
    if (parsed.pathname === "/api/resource/Measurement%20Report" || parsed.pathname === "/api/resource/Measurement Report") {
      return Response.json({ data: [
        { name: measurementReport.name, measurement_id: measurementReport.measurement_id },
        { name: "measurement:ow_1:v2", measurement_id: "measurement:ow_1:v2" },
      ] });
    }
    const records = new Map([
      [encoded("White-Label Tenant", "ironwrap"), { name: "ironwrap", tenant_id: "ironwrap", status: "Active" }],
      [encoded("Roof Job", "job:ow_1"), { name: "job:ow_1", brand: "ironwrap", service_type: "Metal Roofing" }],
      [encoded("Measurement Report", measurementReport.name), measurementReport],
      [encoded("Material Takeoff Policy", policy.policy_id), policy],
      [encoded("Evidence Item", policy.source_evidence), verifiedPolicyEvidence()],
    ]);
    const data = records.get(parsed.pathname);
    assert.ok(data, `unexpected exact measurement read ${parsed.pathname}`);
    return Response.json({ data });
  });

  const config = {
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    tenantId: "ironwrap",
    requestTimeoutMs: 10_000,
  };
  await assert.rejects(() => buildMaterialTakeoffDraftFromErp(config, "job:ow_1", {
    materialSystem: "standing_seam_16",
    takeoffPolicyId: policy.policy_id,
    limit: 1,
    nowIso: "2026-08-12T10:00:00.000Z",
  }), /material_takeoff_measurement_window_truncated/);
  const listReadsBeforeExact = requestedUrls.filter((url) => url.searchParams.has("limit_page_length"));
  assert.equal(listReadsBeforeExact.length, 1);
  assert.equal(listReadsBeforeExact[0].searchParams.get("limit_page_length"), "2");

  const exact = await buildMaterialTakeoffDraftFromErp(config, "job:ow_1", {
    materialSystem: "standing_seam_16",
    measurementReportId: measurementReport.name,
    takeoffPolicyId: policy.policy_id,
    limit: 1,
    nowIso: "2026-08-12T10:00:00.000Z",
  });
  assert.equal(exact.measurementReport.measurement_id, measurementReport.measurement_id);
  assert.equal(requestedUrls.filter((url) => url.searchParams.has("limit_page_length")).length, 1);
});

test("material takeoff draft computes governed geometry and persists replay bindings", () => {
  assert.equal(materialTakeoffIdForRoofJob("job:ow_1"), "takeoff:job:ow_1");

  const draft = buildMaterialTakeoffDraft({
    roofJobId: "job:ow_1",
    tenantId: "ironwrap",
    materialSystem: "standing_seam_16",
    roofJob: { name: "job:ow_1", brand: "ironwrap", service_type: "Metal Roofing" },
    measurementReport: {
      name: "measurement:ow_1",
      measurement_id: "measurement:ow_1",
      roof_job: "job:ow_1",
      provider: "AppliCad",
      review_status: "Approved",
      roof_graph_revision: ROOF_GRAPH_SHA,
      roof_graph_json: JSON.stringify(governedRoofGraph()),
    },
    takeoffPolicy: approvedTakeoffPolicy(),
    policyEvidence: verifiedPolicyEvidence(),
    nowIso: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(draft.takeoff_id, "takeoff:job:ow_1");
  assert.equal(draft.roof_job, "job:ow_1");
  assert.equal(draft.measurement_report, "measurement:ow_1");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.prepared_at, "2026-08-12T10:00:00.000Z");
  assert.equal(draft.calculation_schema, "material_takeoff/v1");
  assert.equal(draft.geometry_revision, ROOF_GRAPH_SHA);
  assert.equal(draft.source_raw_sha256, ROOF_GRAPH_SHA);
  assert.equal(draft.takeoff_policy, "mtp:ironwrap:metal-roofing:ss16:v1");
  assert.match(draft.policy_digest, /^[a-f0-9]{64}$/);
  assert.match(draft.options_digest, /^[a-f0-9]{64}$/);
  assert.match(draft.calculation_digest, /^[a-f0-9]{64}$/);
  assert.equal(draft.stock_mode, "coil");
  assert.match(draft.waste_basis, /setup=5ft/);
  assert.match(draft.assumptions, /approved Material Takeoff Policy/);
  assert.match(draft.exclusions, /supplier order/);
  assert.ok(draft.items.length >= 5);
  assert.deepEqual(draft.items.map((item) => item.item_name), [
    "panel:ss16",
    "trim:eave_drip",
    "fastener:clip",
    "fastener:clip_screw",
    "fastener:trim_screw",
  ]);
  assert.ok(draft.items.every((item) => item.calculation_digest === draft.calculation_digest));
  assert.ok(draft.items.every((item) => item.policy_digest === draft.policy_digest));
  assert.ok(draft.items.every((item) => item.geometry_revision === ROOF_GRAPH_SHA));

  const source = JSON.parse(draft.source_measurements_json);
  assert.equal(source.measurement_report, "measurement:ow_1");
  assert.equal(source.raw_sha256, ROOF_GRAPH_SHA);
  assert.equal(source.geometry_measurements.roof_area, 100);
  const envelope = JSON.parse(draft.calculation_json);
  assert.equal(envelope.source.raw_sha256, ROOF_GRAPH_SHA);
  assert.equal(envelope.policy.source_evidence_sha256, POLICY_EVIDENCE_SHA);
  assert.equal(envelope.options.coilSetupAllowanceFt, 5);
  assert.equal(envelope.result.panelNest.wastePct > 0, true);
  assert.doesNotThrow(() => assertMaterialTakeoffReplaySafe(draft, { ...draft, prepared_at: "later" }));
  assert.throws(
    () => assertMaterialTakeoffReplaySafe({ ...draft, calculation_digest: "c".repeat(64) }, draft),
    /material_takeoff_existing_binding_mismatch/,
  );
  assert.throws(
    () => assertMaterialTakeoffReplaySafe({ status: "Needs Review" }, draft),
    /material_takeoff_legacy_state_requires_preflight/,
  );
});

test("material takeoff fails closed on missing policy, cross-tenant rules, and contradictory evidence", () => {
  const base = {
    roofJobId: "job:ow_1",
    tenantId: "ironwrap",
    materialSystem: "standing_seam_16",
    roofJob: { name: "job:ow_1", brand: "ironwrap", service_type: "Metal Roofing" },
    measurementReport: {
      name: "measurement:ow_1",
      roof_job: "job:ow_1",
      roof_graph_revision: ROOF_GRAPH_SHA,
      roof_graph_json: JSON.stringify(governedRoofGraph()),
    },
    takeoffPolicy: approvedTakeoffPolicy(),
    policyEvidence: verifiedPolicyEvidence(),
    nowIso: "2026-08-12T10:00:00.000Z",
  };
  assert.throws(() => buildMaterialTakeoffDraft({ ...base, takeoffPolicy: undefined }), /material_takeoff_policy_required/);
  assert.throws(
    () => buildMaterialTakeoffDraft({ ...base, takeoffPolicy: approvedTakeoffPolicy({ tenant: "iroof" }) }),
    /material_takeoff_policy_tenant_mismatch/,
  );
  assert.throws(
    () => buildMaterialTakeoffDraft({ ...base, policyEvidence: { ...verifiedPolicyEvidence(), content_checksum: "bad" } }),
    /material_takeoff_policy_evidence_invalid/,
  );
  assert.throws(
    () => buildMaterialTakeoffDraft({
      ...base,
      measurementReport: { ...base.measurementReport, roof_graph_revision: "c".repeat(64) },
    }),
    /material_takeoff_geometry_revision_mismatch/,
  );
  assert.throws(
    () => buildMaterialTakeoffDraft({
      ...base,
      takeoffPolicy: approvedTakeoffPolicy({ status: "Retired", effective_to: "2026-08-31" }),
    }),
    /material_takeoff_policy_approved_required/,
  );
});

test("material takeoff replay binds historical time and retired policy after expiry and rotation", async (t) => {
  const preparedAt = "2026-08-12T10:00:00.000Z";
  const historicalApproved = approvedTakeoffPolicy({ effective_to: "2026-08-31" });
  const measurementReport = {
    name: "measurement:ow_1",
    measurement_id: "measurement:ow_1",
    roof_job: "job:ow_1",
    provider: "AppliCad",
    review_status: "Approved",
    roof_graph_revision: ROOF_GRAPH_SHA,
    roof_graph_json: JSON.stringify(governedRoofGraph()),
  };
  const existing = buildMaterialTakeoffDraft({
    roofJobId: "job:ow_1",
    tenantId: "ironwrap",
    materialSystem: "standing_seam_16",
    roofJob: { name: "job:ow_1", brand: "ironwrap", service_type: "Metal Roofing" },
    measurementReport,
    takeoffPolicy: historicalApproved,
    policyEvidence: verifiedPolicyEvidence(),
    nowIso: preparedAt,
  });
  const historicalRetired = { ...historicalApproved, status: "Retired" };
  const requestedUrls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrls.push(String(url));
    const path = new URL(String(url)).pathname;
    const encoded = (doctype, name) => `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
    const records = new Map([
      [encoded("Material Takeoff", existing.takeoff_id), existing],
      [encoded("White-Label Tenant", "ironwrap"), { name: "ironwrap", tenant_id: "ironwrap", status: "Active" }],
      [encoded("Roof Job", "job:ow_1"), { name: "job:ow_1", brand: "ironwrap", service_type: "Metal Roofing" }],
      [encoded("Measurement Report", "measurement:ow_1"), measurementReport],
      [encoded("Material Takeoff Policy", historicalRetired.policy_id), historicalRetired],
      [encoded("Evidence Item", historicalRetired.source_evidence), verifiedPolicyEvidence()],
    ]);
    const data = records.get(path);
    assert.ok(data, `unexpected replay read ${path}`);
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  });

  const plan = await prepareMaterialTakeoffWriteFromErp({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    tenantId: "ironwrap",
    requestTimeoutMs: 10_000,
  }, "job:ow_1", {
    materialSystem: "standing_seam_16",
    takeoffId: existing.takeoff_id,
    nowIso: "2026-09-15T10:00:00.000Z",
  });

  assert.equal(plan.operation, "replay");
  assert.equal(plan.targetMutation, false);
  assert.equal(plan.draft.prepared_at, preparedAt);
  assert.equal(plan.draft.takeoff_policy, historicalRetired.policy_id);
  assert.equal(plan.draft.calculation_digest, existing.calculation_digest);
  assert.deepEqual(plan.before, existing);
  assert.equal(requestedUrls.some((url) => url.includes("Material%20Takeoff%20Policy?")), false);
  await assert.rejects(
    () => prepareMaterialTakeoffWriteFromErp({
      baseUrl: "https://erp.example",
      apiKey: "key",
      apiSecret: "secret",
      tenantId: "ironwrap",
      requestTimeoutMs: 10_000,
    }, "job:ow_1", {
      materialSystem: "standing_seam_16",
      takeoffId: existing.takeoff_id,
      takeoffPolicyId: "mtp:ironwrap:metal-roofing:ss16:v2",
      nowIso: "2026-09-15T10:00:00.000Z",
    }),
    /material_takeoff_existing_binding_mismatch/,
  );
  await assert.rejects(
    () => prepareMaterialTakeoffWriteFromErp({
      baseUrl: "https://erp.example",
      apiKey: "key",
      apiSecret: "secret",
      tenantId: "iroof",
      requestTimeoutMs: 10_000,
    }, "job:ow_1", {
      materialSystem: "standing_seam_16",
      takeoffId: existing.takeoff_id,
      nowIso: "2026-09-15T10:00:00.000Z",
    }),
    /material_takeoff_existing_binding_mismatch/,
  );
  assert.throws(
    () => assertMaterialTakeoffReplaySafe(existing, {
      ...plan.draft,
      takeoff_policy: "mtp:ironwrap:metal-roofing:ss16:v2",
    }),
    /material_takeoff_existing_binding_mismatch/,
  );
});

test("supplier order draft requires approved takeoff and keeps supplier action review-gated", () => {
  assert.equal(supplierOrderIdForTakeoff("takeoff:job:ow_1"), "supplier:takeoff:job:ow_1");

  const materialTakeoff = {
    name: "takeoff:job:ow_1",
    takeoff_id: "takeoff:job:ow_1",
    roof_job: "job:ow_1",
    status: "Approved",
    items: [
      { category: "Roof Surface", item_name: "Roof surface from area_sqft", quantity: 1200, unit: "sqft", source_ref: "raw#area" },
      { category: "Linear Metal", item_name: "Linear metal from perimeter_ft", quantity: 140, unit: "ft", source_ref: "raw#perimeter" },
    ],
  };
  const draft = buildSupplierOrderDraft({
    materialTakeoff,
    supplier: "Metal Supplier Ltd.",
    requestedDeliveryDate: "2026-07-20",
    nowIso: "2026-07-08T10:00:00.000Z",
  });

  assert.equal(draft.supplier_order_id, "supplier:takeoff:job:ow_1");
  assert.equal(draft.roof_job, "job:ow_1");
  assert.equal(draft.material_takeoff, "takeoff:job:ow_1");
  assert.equal(draft.supplier, "Metal Supplier Ltd.");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.prepared_at, "2026-07-08T10:00:00.000Z");
  assert.equal(draft.requested_delivery_date, "2026-07-20");
  assert.match(draft.assumptions, /owner review/);
  assert.match(draft.exclusions, /does not place an order/);
  assert.equal(draft.items.length, 2);
  assert.ok(draft.items.every((item) => item.status === "Draft" && item.needs_review === 1));

  const summary = JSON.parse(draft.order_summary_json);
  assert.equal(summary.material_takeoff, "takeoff:job:ow_1");
  assert.equal(summary.takeoff_status, "Approved");
  assert.equal(summary.item_count, 2);
  assert.throws(() => buildSupplierOrderDraft({ materialTakeoff: { ...materialTakeoff, status: "Needs Review" } }), /approved_required/);
});

test("proposal evidence pack draft is quote-scoped and persists only redacted verified proof", () => {
  assert.equal(proposalPackIdForCustomerQuote("quote:ow_1"), "proposal:quote:ow_1");

  const draft = buildProposalEvidencePackDraft({
    roofJobId: "job:ow_1",
    customerQuote: {
      name: "quote:ow_1",
      roof_job: "job:ow_1",
      quote_version: 3,
      status: "Approved",
      price_rule_snapshot_json: "{\"bound\":true}",
    },
    measurements: [{
      name: "measurement:ow_1",
      measurement_id: "measurement:ow_1",
      provider: "RoofRuler",
      source_file: "sample.pdf",
      raw_key: "measurements/ow_1/sample.pdf",
      review_status: "Approved",
      approved_at: "2026-07-08T09:00:00.000Z",
    }],
    evidence: [
      {
        name: "evidence:measurement:ow_1",
        evidence_id: "evidence:measurement:ow_1",
        evidence_type: "Measurement Report",
        source_uri: "r2://raw/measurements/ow_1/sample.pdf",
        r2_key: "raw/measurements/ow_1/sample.pdf",
        customer_safe: 1,
        proof_slot: "Measurement",
        sync_state: "Verified",
        checksum_algorithm: "SHA-256",
        content_checksum: "a".repeat(64),
        verified_at: "2026-07-08T09:01:00.000Z",
        verification_source: "worker-checksum",
        summary: "RoofRuler measurement report synced from R2.",
      },
      {
        name: "evidence:private",
        evidence_id: "evidence:private",
        evidence_type: "Photo",
        source_uri: "r2://private/photo.jpg",
        customer_safe: "0",
        proof_slot: "Production",
        sync_state: "Verified",
        checksum_algorithm: "SHA-256",
        content_checksum: "b".repeat(64),
        verified_at: "2026-07-08T09:01:00.000Z",
        verification_source: "worker-checksum",
        summary: "Private homeowner note.",
      },
      {
        name: "evidence:unverified",
        evidence_id: "evidence:unverified",
        evidence_type: "Photo",
        source_uri: "r2://unverified/photo.jpg",
        customer_safe: true,
        proof_slot: "Production",
        sync_state: "Uploaded",
        checksum_algorithm: "SHA-256",
        content_checksum: "c".repeat(64),
      },
    ],
    nowIso: "2026-07-08T10:00:00.000Z",
  });

  assert.equal(draft.pack_id, "proposal:quote:ow_1");
  assert.equal(draft.roof_job, "job:ow_1");
  assert.equal(draft.quotation, "quote:ow_1");
  assert.equal(draft.status, "Draft");
  assert.equal(draft.prepared_at, "2026-07-08T10:00:00.000Z");
  assert.match(draft.assumptions, /estimator review/);
  assert.match(draft.exclusions, /binding quote/);
  assert.equal("customer_message" in draft, false);

  const summary = JSON.parse(draft.evidence_summary_json);
  assert.deepEqual(summary.counts, {
    measurement_reports: 1,
    eligible_evidence: 1,
    withheld_evidence: 2,
  });
  assert.equal(summary.quotation, "quote:ow_1");
  assert.equal(summary.quote_version, 3);
  assert.equal(summary.measurement_reports[0].measurement_id, "measurement:ow_1");
  assert.equal(summary.eligible_evidence[0].evidence_id, "evidence:measurement:ow_1");
  assert.deepEqual(summary.withheld_evidence, {
    not_customer_safe: 1,
    unverified_or_incomplete: 1,
    identity_missing: 0,
  });
  expectNoSensitiveProofPointers(JSON.stringify(draft));

  assert.throws(() => buildProposalEvidencePackDraft({
    roofJobId: "job:ow_1",
    customerQuote: { name: "quote:ow_1", roof_job: "job:other", status: "Approved" },
    measurements: [{ name: "measurement:ow_1", review_status: "Approved" }],
    evidence: [],
  }), /customer_quote_roof_job_mismatch/);
  assert.throws(() => buildProposalEvidencePackDraft({
    roofJobId: "job:ow_1",
    customerQuote: { name: "quote:ow_1", roof_job: "job:ow_1", status: "Needs Review" },
    measurements: [{ name: "measurement:ow_1", review_status: "Approved" }],
    evidence: [],
  }), /customer_quote_not_approved/);
  assert.throws(() => buildProposalEvidencePackDraft({
    roofJobId: "job:ow_1",
    customerQuote: { name: "quote:ow_1", roof_job: "job:ow_1", status: "Approved" },
  }), /customer_quote_price_rule_snapshot_required/);
});

test("quote price-rule snapshot is immutable, effective, and source-complete", () => {
  const quote = {
    name: "quote:ow_1",
    customer_quote_id: "quote:ow_1",
    roof_job: "job:ow_1",
    quote_version: 3,
    status: "Needs Review",
    price_book_version: "retail-2026-07",
    pricing_effective_at: "2026-07-10T10:00:00.000Z",
  };
  const rule = {
    name: "rule:b",
    price_rule_id: "rule:b",
    rule_name: "Standing seam panel",
    rule_type: "Material",
    status: "Approved",
    service_type: "Metal reroof",
    material_system: "24ga standing seam",
    unit: "sqft",
    unit_cost: 8,
    unit_price: 12.5,
    minimum_quantity: 0,
    currency: "CAD",
    source_ref: "supplier-sheet-2026-07",
    rule_json: '{"unit_price":12.5}',
    effective_from: "2026-07-01",
    effective_to: "",
    assumptions: "Standard colour.",
    exclusions: "Freight.",
    approved_by: "owner@example.com",
    approved_at: "2026-07-10T09:00:00.000Z",
  };
  const snapshot = buildQuotePriceRuleSnapshot({
    roofJobId: "job:ow_1",
    customerQuote: quote,
    priceRules: [{ ...rule, name: "rule:a", price_rule_id: "rule:a" }, rule],
    nowIso: "2026-07-10T10:01:00.000Z",
  });
  assert.deepEqual(snapshot.quote, {
    customer_quote_id: "quote:ow_1",
    quote_version: 3,
    price_book_version: "retail-2026-07",
    pricing_effective_at: "2026-07-10T10:00:00.000Z",
  });
  assert.deepEqual(snapshot.rules.map((item) => item.price_rule_id), ["rule:a", "rule:b"]);
  assert.equal(snapshot.rules[0].unit_price, "12.5");
  assert.deepEqual(snapshot.rules[0].rule_json, { unit_price: 12.5 });
  assert.throws(() => buildQuotePriceRuleSnapshot({
    roofJobId: "job:ow_1",
    customerQuote: { ...quote, price_rule_snapshot_json: "{}" },
    priceRules: [rule],
    nowIso: "2026-07-10T10:01:00.000Z",
  }), /already_bound/);
  assert.throws(() => buildQuotePriceRuleSnapshot({
    roofJobId: "job:ow_1",
    customerQuote: quote,
    priceRules: [{ ...rule, status: "Retired" }],
    nowIso: "2026-07-10T10:01:00.000Z",
  }), /price_rule_not_approved/);
  assert.throws(() => buildQuotePriceRuleSnapshot({
    roofJobId: "job:ow_1",
    customerQuote: quote,
    priceRules: [{ ...rule, effective_from: "2026-08-01" }],
    nowIso: "2026-07-10T10:01:00.000Z",
  }), /price_rule_not_effective_for_quote/);
});

function expectNoSensitiveProofPointers(value) {
  for (const forbidden of [
    "raw/measurements/ow_1/sample.pdf",
    "r2://raw/measurements/ow_1/sample.pdf",
    "Private homeowner note.",
    "r2://private/photo.jpg",
    "r2://unverified/photo.jpg",
    "sample.pdf",
  ]) {
    assert.equal(value.includes(forbidden), false, `must omit ${forbidden}`);
  }
}
