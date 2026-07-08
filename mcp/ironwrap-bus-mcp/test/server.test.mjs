import { test } from "node:test";
import assert from "node:assert/strict";
import { busGet, configFromEnv } from "../src/server.mjs";

test("configFromEnv requires bus URL and admin token", () => {
  assert.throws(() => configFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => configFromEnv({ IRONWRAP_BUS_BASE_URL: "https://bus.example" }), /IRONWRAP_ADMIN_TOKEN/);
  assert.deepEqual(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), { baseUrl: "https://bus.example", adminToken: "token" });
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
