import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWriteApproved, busGet, busPost, busReadiness, configFromEnv } from "../src/server.mjs";

test("configFromEnv requires bus URL and admin token", () => {
  assert.throws(() => configFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => configFromEnv({ IRONWRAP_BUS_BASE_URL: "https://bus.example" }), /IRONWRAP_ADMIN_TOKEN/);
  assert.deepEqual(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), { baseUrl: "https://bus.example", adminToken: "token", writeEnabled: false, writeToken: undefined, requestTimeoutMs: 10_000 });
  assert.deepEqual(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
    IRONWRAP_BUS_WRITE_ENABLED: "true",
    HERMES_WRITE_TOKEN: "approve",
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "2500",
  }), { baseUrl: "https://bus.example", adminToken: "token", writeEnabled: true, writeToken: "approve", requestTimeoutMs: 2500 });
});

test("configFromEnv requires HTTPS except explicitly enabled localhost", () => {
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), /must use HTTPS/);
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), /must use HTTPS/);
  assert.equal(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787/",
    IRONWRAP_ADMIN_TOKEN: "token",
    IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: "true",
  }).baseUrl, "http://127.0.0.1:8787");
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://user:secret@bus.example?token=x",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), /must not include/);
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "0",
  }), /must be an integer/);
});

test("busGet sends bearer token and parses JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://bus.example/admin/envelopes?limit=1");
    assert.equal(init.headers.authorization, "Bearer token");
    return new Response(JSON.stringify({ envelopes: [] }), { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await busGet({ baseUrl: "https://bus.example", adminToken: "token" }, "/admin/envelopes?limit=1"), {
    envelopes: [],
  });
});

test("busGet reports non-2xx bus responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 401 }));
  await assert.rejects(() => busGet({ baseUrl: "https://bus.example", adminToken: "bad" }, "/admin/envelopes"), /bus_http_401/);
});

test("busPost sends bearer token, approval context, and parses JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://bus.example/admin/replay");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer token");
    assert.equal(init.headers["content-type"], "application/json");
    assert.equal(init.headers["x-request-id"], "run-12345678");
    assert.deepEqual(JSON.parse(init.body), {
      envelope_id: "ow_00000000-0000-4000-8000-000000000000",
      run_id: "run-12345678",
      approved_by: "owner@example.com",
      reason: "Retry after credential recovery",
    });
    return new Response(JSON.stringify({ requeued: 2 }), { headers: { "content-type": "application/json" } });
  });

  const body = {
    envelope_id: "ow_00000000-0000-4000-8000-000000000000",
    run_id: "run-12345678",
    approved_by: "owner@example.com",
    reason: "Retry after credential recovery",
  };
  assert.deepEqual(await busPost(
    { baseUrl: "https://bus.example", adminToken: "token" },
    "/admin/replay",
    body,
    body.run_id,
  ), {
    requeued: 2,
  });
});

test("readiness preserves a structured 503 result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    ok: false,
    status: "not_ready",
    checks: { d1: false },
  }), { status: 503, headers: { "content-type": "application/json" } }));
  assert.deepEqual(await busReadiness({ baseUrl: "https://bus.example", adminToken: "token" }), {
    ok: false,
    status: "not_ready",
    checks: { d1: false },
  });
});

test("bus requests fail closed on timeout and invalid JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(() => busGet({
    baseUrl: "https://bus.example",
    adminToken: "token",
    requestTimeoutMs: 10,
  }, "/admin/envelopes"), /bus_timeout_10ms/);

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("not json", { status: 200 }));
  await assert.rejects(() => busGet({ baseUrl: "https://bus.example", adminToken: "token" }, "/health"), /bus_invalid_json_200/);
});

test("write approval helper gates replay mutations", () => {
  assert.throws(() => assertWriteApproved({ writeEnabled: false }, "x"), /bus_write_disabled/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true }, "x"), /bus_write_token_required/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "wrong"), /approval_token_invalid/);
  assert.doesNotThrow(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "right"));
});
