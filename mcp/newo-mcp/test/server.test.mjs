import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertNewoWriteEnabled,
  buildServer,
  configFromEnv,
  newoGet,
  newoPost,
} from "../src/server.mjs";

test("configuration requires a bounded Worker endpoint, admin token, and canonical role", () => {
  assert.throws(() => configFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => configFromEnv({ IRONWRAP_BUS_BASE_URL: "https://bus.example" }), /IRONWRAP_ADMIN_TOKEN/);
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
  }), /HERMES_AGENT_ROLE/);
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
    HERMES_AGENT_ROLE: "unknown",
  }), /HERMES_AGENT_ROLE/);

  const owner = configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
    HERMES_AGENT_ROLE: "owner-operator",
    NEWO_MCP_WRITE_ENABLED: "true",
    NEWO_MCP_REQUEST_TIMEOUT_MS: "2500",
  });
  assert.equal(owner.baseUrl, "https://bus.example");
  assert.equal(owner.writeEnabled, true);
  assert.equal(owner.requestTimeoutMs, 2500);
  assert.ok(owner.allowedTools.includes("request_newo_control_action"));
});

test("configuration permits insecure HTTP only for explicitly enabled local development", () => {
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
    HERMES_AGENT_ROLE: "lead-concierge",
  }), /must use HTTPS/);
  assert.equal(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787/",
    IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: "true",
    IRONWRAP_ADMIN_TOKEN: "token",
    HERMES_AGENT_ROLE: "lead-concierge",
  }).baseUrl, "http://127.0.0.1:8787");
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://user:secret@bus.example?token=x",
    IRONWRAP_ADMIN_TOKEN: "token",
    HERMES_AGENT_ROLE: "lead-concierge",
  }), /must not include/);
});

test("Worker requests carry only the IronWrap admin credential and bounded route", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://bus.example/admin/newo/read");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer admin-token");
    assert.equal(init.headers["user-agent"], "newo-mcp/0.1.0");
    assert.deepEqual(JSON.parse(init.body), {
      operation: "webhooks.outgoing.list",
      args: {},
    });
    return json({ result: [] });
  });
  assert.deepEqual(await newoPost(
    { baseUrl: "https://bus.example", adminToken: "admin-token", requestTimeoutMs: 1000 },
    "/admin/newo/read",
    { operation: "webhooks.outgoing.list", args: {} },
  ), { result: [] });
});

test("Worker errors and timeouts fail closed without returning request credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ error: "newo_outbound_disabled" }, 403));
  await assert.rejects(
    () => newoGet({ baseUrl: "https://bus.example", adminToken: "secret" }, "/admin/newo/health"),
    (error) => error.message === "newo_mcp_http_403:newo_outbound_disabled" && !error.message.includes("secret"),
  );

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(
    () => newoGet({ baseUrl: "https://bus.example", adminToken: "secret", requestTimeoutMs: 10 }, "/admin/newo/health"),
    /newo_mcp_timeout_10ms/,
  );
});

test("MCP host write gate is independent of the Worker receipt and feature gates", () => {
  assert.throws(() => assertNewoWriteEnabled({ writeEnabled: false }), /newo_mcp_write_disabled/);
  assert.doesNotThrow(() => assertNewoWriteEnabled({ writeEnabled: true }));
});

test("runtime roles register only their canonical Newo tools", () => {
  const owner = buildServer({
    baseUrl: "https://bus.example",
    adminToken: "token",
    agentRole: "owner-operator",
  });
  assert.ok(owner._registeredTools.get_newo_health);
  assert.ok(owner._registeredTools.list_newo_user_actors);
  assert.ok(owner._registeredTools.dry_run_newo_control_action);
  assert.ok(owner._registeredTools.request_newo_control_approval);
  assert.ok(owner._registeredTools.request_newo_control_action);

  const support = buildServer({
    baseUrl: "https://bus.example",
    adminToken: "token",
    agentRole: "support-admin",
  });
  assert.ok(support._registeredTools.get_newo_health);
  assert.ok(support._registeredTools.list_newo_control_actions);
  assert.ok(support._registeredTools.list_newo_outgoing_webhooks);
  assert.equal(support._registeredTools.get_newo_chat_history, undefined);
  assert.equal(support._registeredTools.dry_run_newo_control_action, undefined);

  const lead = buildServer({
    baseUrl: "https://bus.example",
    adminToken: "token",
    agentRole: "lead-concierge",
  });
  assert.ok(lead._registeredTools.list_newo_sessions);
  assert.ok(lead._registeredTools.get_newo_chat_history);
  assert.ok(lead._registeredTools.list_newo_conversation_acts);
  assert.equal(lead._registeredTools.get_newo_health, undefined);
  assert.equal(lead._registeredTools.list_newo_agent_actors, undefined);
  assert.equal(lead._registeredTools.request_newo_control_action, undefined);

  const estimator = buildServer({
    baseUrl: "https://bus.example",
    adminToken: "token",
    agentRole: "estimator-assistant",
  });
  assert.equal(Object.keys(estimator._registeredTools).length, 0);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
