import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWriteApproved, busGet, busPost, configFromEnv } from "../src/server.mjs";

test("configFromEnv requires bus URL and admin token", () => {
  assert.throws(() => configFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => configFromEnv({ IRONWRAP_BUS_BASE_URL: "https://bus.example" }), /IRONWRAP_ADMIN_TOKEN/);
  assert.deepEqual(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), { baseUrl: "https://bus.example", adminToken: "token", writeEnabled: false, writeToken: undefined });
  assert.deepEqual(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
    IRONWRAP_BUS_WRITE_ENABLED: "true",
    HERMES_WRITE_TOKEN: "approve",
  }), { baseUrl: "https://bus.example", adminToken: "token", writeEnabled: true, writeToken: "approve" });
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

test("busPost sends bearer token and parses JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://bus.example/admin/replay");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer token");
    return new Response(JSON.stringify({ requeued: 2 }), { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await busPost({ baseUrl: "https://bus.example", adminToken: "token" }, "/admin/replay"), {
    requeued: 2,
  });
});

test("write approval helper gates replay mutations", () => {
  assert.throws(() => assertWriteApproved({ writeEnabled: false }, "x"), /bus_write_disabled/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true }, "x"), /bus_write_token_required/);
  assert.throws(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "wrong"), /approval_token_invalid/);
  assert.doesNotThrow(() => assertWriteApproved({ writeEnabled: true, writeToken: "right" }, "right"));
});
