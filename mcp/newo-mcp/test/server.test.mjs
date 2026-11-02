import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  assertNewoWriteEnabled,
  buildServer,
  configFromEnv,
  newoGet,
  newoPost,
} from "../src/server.mjs";

test("configuration requires a bounded Worker endpoint, admin token, and an explicit tool grant", () => {
  assert.throws(() => configFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => configFromEnv({ IRONWRAP_BUS_BASE_URL: "https://bus.example" }), /IRONWRAP_ADMIN_TOKEN/);
  for (const MCP_ALLOWED_TOOLS of [undefined, "", " , ", "get_newo_health,newo/raw"]) {
    assert.throws(() => configFromEnv({
      IRONWRAP_BUS_BASE_URL: "https://bus.example",
      IRONWRAP_ADMIN_TOKEN: "token",
      MCP_ALLOWED_TOOLS,
    }), /MCP_ALLOWED_TOOLS must list/);
  }

  const owner = configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example/",
    IRONWRAP_ADMIN_TOKEN: "token",
    MCP_ALLOWED_TOOLS: "dry_run_newo_control_action, request_newo_control_action",
    NEWO_MCP_WRITE_ENABLED: "true",
    NEWO_MCP_REQUEST_TIMEOUT_MS: "2500",
  });
  assert.equal(owner.baseUrl, "https://bus.example");
  assert.equal(owner.writeEnabled, true);
  assert.equal(owner.requestTimeoutMs, 2500);
  assert.deepEqual(owner.allowedTools, ["dry_run_newo_control_action", "request_newo_control_action"]);
});

test("configuration permits insecure HTTP only for explicitly enabled local development", () => {
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://bus.example",
    IRONWRAP_ADMIN_TOKEN: "token",
    MCP_ALLOWED_TOOLS: "list_newo_sessions",
  }), /must use HTTPS/);
  assert.equal(configFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787/",
    IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: "true",
    IRONWRAP_ADMIN_TOKEN: "token",
    MCP_ALLOWED_TOOLS: "list_newo_sessions",
  }).baseUrl, "http://127.0.0.1:8787");
  assert.throws(() => configFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://user:secret@bus.example?token=x",
    IRONWRAP_ADMIN_TOKEN: "token",
    MCP_ALLOWED_TOOLS: "list_newo_sessions",
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

test("the server registers exactly the Newo tools the launching host grants and refuses anything else", () => {
  const base = { baseUrl: "https://bus.example", adminToken: "token" };
  assert.throws(() => buildServer(base), /mcp_allowed_tools_required/);
  assert.throws(() => buildServer({ ...base, allowedTools: [] }), /mcp_allowed_tools_required/);
  assert.throws(
    () => buildServer({ ...base, allowedTools: ["get_newo_health", "proxy_newo_request"] }),
    /mcp_allowed_tools_unknown:proxy_newo_request/,
  );

  const reader = buildServer({
    ...base,
    allowedTools: ["list_newo_sessions", "get_newo_chat_history", "list_newo_conversation_acts"],
  });
  assert.deepEqual(
    Object.keys(reader._registeredTools).sort(),
    ["get_newo_chat_history", "list_newo_conversation_acts", "list_newo_sessions"],
  );
  assert.equal(reader._registeredTools.get_newo_health, undefined);
  assert.equal(reader._registeredTools.request_newo_control_action, undefined);

  const control = buildServer({
    ...base,
    allowedTools: [
      "get_newo_health",
      "dry_run_newo_control_action",
      "request_newo_control_approval",
      "request_newo_control_action",
    ],
  });
  assert.ok(control._registeredTools.get_newo_health);
  assert.ok(control._registeredTools.dry_run_newo_control_action);
  assert.ok(control._registeredTools.request_newo_control_approval);
  assert.ok(control._registeredTools.request_newo_control_action);
  assert.equal(control._registeredTools.list_newo_sessions, undefined);
});

test("the reviewed Newo tool contract holds: bounded reads, one dry run, receipt-bound writes, no provider proxy", () => {
  const source = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const names = [...source.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(names.length, 20, "Newo MCP inventory stays at the reviewed 20-tool contract");
  assert.equal(names.filter((name) => /^(get|list|check)_/.test(name)).length, 17);
  assert.deepEqual(names.filter((name) => name.startsWith("dry_run_")), ["dry_run_newo_control_action"]);
  assert.deepEqual(
    names.filter((name) => name.startsWith("request_")),
    ["request_newo_control_approval", "request_newo_control_action"],
  );

  const server = buildServer({ baseUrl: "https://bus.example", adminToken: "token", allowedTools: names });
  assert.equal(Object.keys(server._registeredTools).length, 20);
  for (const name of ["request_newo_control_approval", "request_newo_control_action"]) {
    const shape = server._registeredTools[name].inputSchema.shape;
    for (const field of ["run_id", "approved_by", "dry_run_receipt"]) {
      assert.ok(shape[field], `${name} must require ${field}`);
      assert.equal(shape[field].isOptional(), false, `${name}.${field} must not be optional`);
    }
  }
  assert.ok(server._registeredTools.request_newo_control_action.inputSchema.shape.approval_receipt);

  assert.match(source, /assertNewoWriteEnabled\(config\)/, "an MCP-host write gate stays in front of the Worker gates");
  assert.match(source, /assertBoundResult\(result, run_id, approved_by\)/, "results stay bound to the reviewed action and approver");
  assert.doesNotMatch(source, /NEWO_API_KEY|api\.newo\.ai/, "the server never holds the provider key or calls the provider");
  assert.doesNotMatch(source, /path\s*:\s*z\.|method\s*:\s*z\./, "no caller-controlled provider path or HTTP method");
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
