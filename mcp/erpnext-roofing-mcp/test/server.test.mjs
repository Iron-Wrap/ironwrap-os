import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWriteApproved,
  buildGateUpdatePatch,
  buildAuditFinalizationIncidentDraft,
  buildMaterialTakeoffDraft,
  buildMaterialTakeoffStatusPatch,
  buildProposalEvidencePackDraft,
  buildSupplierOrderDraft,
  configFromEnv,
  erpGet,
  erpPut,
  executeAuditedWrite,
  materialTakeoffIdForRoofJob,
  normalizeFrappeBaseUrl,
  parseRequestTimeout,
  proposalPackIdForRoofJob,
  redactApprovalArgs,
  resourceListPath,
  resourcePath,
  supplierOrderIdForTakeoff,
} from "../src/server.mjs";

test("configFromEnv requires ERPNext URL and token parts", () => {
  assert.throws(() => configFromEnv({}), /ERPNEXT_BASE_URL/);
  assert.throws(() => configFromEnv({ ERPNEXT_BASE_URL: "https://erp.example" }), /ERPNEXT_API_KEY/);
  assert.throws(() => configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example",
    ERPNEXT_API_KEY: "key",
  }), /ERPNEXT_API_SECRET/);
  assert.deepEqual(configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  }), { baseUrl: "https://erp.example", apiKey: "key", apiSecret: "secret", writeEnabled: false, writeToken: undefined, requestTimeoutMs: 10_000 });
  assert.deepEqual(configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_WRITE_ENABLED: "true",
    HERMES_WRITE_TOKEN: "approve",
    ERPNEXT_REQUEST_TIMEOUT_MS: "2500",
  }), { baseUrl: "https://erp.example", apiKey: "key", apiSecret: "secret", writeEnabled: true, writeToken: "approve", requestTimeoutMs: 2500 });
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

  const completed = writes[1].body;
  assert.equal(writes[1].method, "PUT");
  assert.equal(completed.approval_status, "Executed");
  assert.equal(completed.result_status, "OK");
  assert.equal(completed.mutation_applied, 1);
  assert.equal(completed.audit_event_id, "audit:hr_policy_123");
  assert.equal(completed.request_correlation_id, "hr_policy_123");
  assert.match(completed.completed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(completed.after_target_ids), { state: "Ready" });
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
  assert.throws(() => assertWriteApproved({ writeEnabled: false }, "x"), /erpnext_write_disabled/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true }, "x"), /hermes_write_token_required/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "wrong"), /approval_token_invalid/);
  assert.doesNotThrow(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "right"));

  assert.deepEqual(buildGateUpdatePatch("Ready", "old reason"), { state: "Ready", blocker_reason: "" });
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

test("material takeoff draft converts measurement values into review-gated line items", () => {
  assert.equal(materialTakeoffIdForRoofJob("job:ow_1"), "takeoff:job:ow_1");

  const draft = buildMaterialTakeoffDraft({
    roofJobId: "job:ow_1",
    measurementReport: {
      name: "measurement:ow_1",
      measurement_id: "measurement:ow_1",
      provider: "RoofRuler",
      review_status: "Parsed",
      measurements: [
        { metric: "area_sqft", value: 1200, unit: "sqft", confidence: "parsed", source_ref: "raw#area", needs_review: 0 },
        { metric: "perimeter_ft", value: 140, unit: "ft", confidence: "parsed", source_ref: "raw#perimeter", needs_review: 0 },
      ],
    },
    nowIso: "2026-07-08T10:00:00.000Z",
  });

  assert.equal(draft.takeoff_id, "takeoff:job:ow_1");
  assert.equal(draft.roof_job, "job:ow_1");
  assert.equal(draft.measurement_report, "measurement:ow_1");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.prepared_at, "2026-07-08T10:00:00.000Z");
  assert.match(draft.assumptions, /estimator review/);
  assert.match(draft.exclusions, /supplier order/);
  assert.equal(draft.items.length, 2);
  assert.deepEqual(draft.items.map((item) => item.category), ["Roof Surface", "Linear Metal"]);
  assert.deepEqual(draft.items.map((item) => item.waste_factor), [10, 5]);
  assert.ok(draft.items.every((item) => item.needs_review === 1));

  const source = JSON.parse(draft.source_measurements_json);
  assert.equal(source.measurement_report, "measurement:ow_1");
  assert.equal(source.provider, "RoofRuler");
  assert.equal(source.measurements.length, 2);
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

test("proposal evidence pack draft links measurement and evidence proof", () => {
  assert.equal(proposalPackIdForRoofJob("job:ow_1"), "proposal:job:ow_1");

  const draft = buildProposalEvidencePackDraft({
    roofJobId: "job:ow_1",
    measurements: [{
      name: "measurement:ow_1",
      measurement_id: "measurement:ow_1",
      provider: "RoofRuler",
      source_file: "sample.pdf",
      raw_key: "measurements/ow_1/sample.pdf",
      review_status: "Parsed",
    }],
    evidence: [{
      name: "evidence:measurement:ow_1",
      evidence_id: "evidence:measurement:ow_1",
      evidence_type: "Measurement Report",
      source_system: "workers-bus",
      r2_key: "measurements/ow_1/sample.pdf",
      customer_safe: 1,
      summary: "RoofRuler measurement report synced from R2.",
    }],
    nowIso: "2026-07-08T10:00:00.000Z",
  });

  assert.equal(draft.pack_id, "proposal:job:ow_1");
  assert.equal(draft.roof_job, "job:ow_1");
  assert.equal(draft.status, "Draft");
  assert.equal(draft.prepared_at, "2026-07-08T10:00:00.000Z");
  assert.match(draft.assumptions, /estimator review/);
  assert.match(draft.exclusions, /binding quote/);
  assert.match(draft.customer_message, /final proposal/);

  const summary = JSON.parse(draft.evidence_summary_json);
  assert.deepEqual(summary.counts, { measurement_reports: 1, evidence_items: 1 });
  assert.equal(summary.measurement_reports[0].measurement_id, "measurement:ow_1");
  assert.equal(summary.evidence_items[0].evidence_id, "evidence:measurement:ow_1");
  assert.equal(summary.evidence_items[0].customer_safe, true);
});
