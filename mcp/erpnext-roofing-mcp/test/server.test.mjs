import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWriteApproved,
  buildGateUpdatePatch,
  configFromEnv,
  erpGet,
  erpPut,
  redactApprovalArgs,
  resourceListPath,
  resourcePath,
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
  }), { baseUrl: "https://erp.example", apiKey: "key", apiSecret: "secret", writeEnabled: false, writeToken: undefined });
  assert.deepEqual(configFromEnv({
    ERPNEXT_BASE_URL: "https://erp.example/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_WRITE_ENABLED: "true",
    HERMES_WRITE_TOKEN: "approve",
  }), { baseUrl: "https://erp.example", apiKey: "key", apiSecret: "secret", writeEnabled: true, writeToken: "approve" });
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

  assert.deepEqual(redactApprovalArgs({
    gate_id: "gate_1",
    next_state: "Ready",
    approval_token: "secret",
  }), {
    gate_id: "gate_1",
    next_state: "Ready",
  });
});
