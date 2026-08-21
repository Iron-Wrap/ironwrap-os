import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BROKER_MCP_CHILD_FORWARDED_KEYS,
  brokerMcpChildEnvironment,
} from "../src/approval-contract.mjs";
import { configFromEnv } from "../src/server.mjs";

// ELEC-128 defect 1. Three of the four brokers forwarded an allowlist copied from
// the template that predates the tenant and effect-runtime requirements, so their
// per-call child died inside `configFromEnv` at process boot - before a tool name
// was read - and every broker catch site reported that crash as a domain refusal.
// These tests hold the child environment to the only bar that matters: a real
// `server.mjs` built from it must boot and answer.

const AGENT_ROLE = "production-controller";
const ACTOR_USER = "production-controller@example.com";
const APPROVER_ID = "owner@example.com";

/** The env a deployed broker process actually holds, plus noise it must not forward. */
function brokerProcessEnv() {
  return {
    ERPNEXT_BASE_URL: "http://localhost:8000",
    ERPNEXT_API_KEY: "test-api-key",
    ERPNEXT_API_SECRET: "test-api-secret",
    ERPNEXT_ALLOW_INSECURE_LOCAL: "true",
    ERPNEXT_TENANT_ID: "ironwrap",
    IRONWRAP_EFFECT_RUNTIME_URL: "http://localhost:8787",
    IRONWRAP_EFFECT_RUNTIME_TOKEN: "t".repeat(40),
    HERMES_DRY_RUN_SIGNING_KEY: "d".repeat(48),
    HERMES_APPROVAL_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nnot-read-at-boot\n-----END PUBLIC KEY-----\n",
    // Secrets a broker holds for its OWN HTTP rail. The child has no business with
    // them, and forwarding them would widen a spawned process's blast radius.
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: "s".repeat(48),
    HERMES_APPROVAL_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nsigning\n-----END PRIVATE KEY-----\n",
    AWS_SECRET_ACCESS_KEY: "must-not-reach-the-child",
  };
}

function childEnv(overrides = {}) {
  return brokerMcpChildEnvironment(
    { ...brokerProcessEnv(), ...overrides },
    { agentRole: AGENT_ROLE, actorUser: ACTOR_USER, approverId: APPROVER_ID },
  );
}

test("the broker child environment builds a write-enabled runtime configFromEnv accepts", () => {
  // The exact call the spawned child makes at boot. Before the fix this threw
  // `ERPNEXT_TENANT_ID is required and must be a stable tenant id`.
  const config = configFromEnv(childEnv());
  assert.equal(config.writeEnabled, true);
  assert.equal(config.tenantId, "ironwrap");
  assert.equal(config.agentRole, AGENT_ROLE);
  assert.equal(config.actorUser, ACTOR_USER);
  assert.equal(config.approverId, APPROVER_ID);
  assert.equal(config.effectRuntimeToken, "t".repeat(40));
  assert.ok(config.effectRuntimeUrl, "the child must carry effect-runtime coordinates");
});

test("every env var the child's write runtime requires is on the forwarded allowlist", () => {
  // Derived, not asserted from memory: withhold one var at a time from the BROKER's
  // env and see whether the child can still be built. Anything whose absence breaks
  // the boot is load-bearing and must therefore be forwarded. This is the check that
  // fails the day `configFromEnv` starts requiring a var nobody added to the list.
  const loadBearing = [];
  for (const key of Object.keys(brokerProcessEnv())) {
    const env = brokerProcessEnv();
    delete env[key];
    try {
      configFromEnv(
        brokerMcpChildEnvironment(env, {
          agentRole: AGENT_ROLE,
          actorUser: ACTOR_USER,
          approverId: APPROVER_ID,
        }),
      );
    } catch {
      loadBearing.push(key);
    }
  }
  assert.ok(loadBearing.length > 0, "the probe must find at least one required var");
  const missing = loadBearing.filter((key) => !BROKER_MCP_CHILD_FORWARDED_KEYS.includes(key));
  assert.deepEqual(missing, [], `these vars are required at child boot but never forwarded: ${missing}`);
});

test("the child environment forwards the runtime and withholds the broker's own secrets", () => {
  const child = childEnv();
  assert.deepEqual(Object.keys(child).sort(), [
    "ERPNEXT_ALLOW_INSECURE_LOCAL",
    "ERPNEXT_API_KEY",
    "ERPNEXT_API_SECRET",
    "ERPNEXT_BASE_URL",
    "ERPNEXT_TENANT_ID",
    "ERPNEXT_WRITE_ENABLED",
    "HERMES_ACTOR_USER",
    "HERMES_AGENT_ROLE",
    "HERMES_APPROVAL_PUBLIC_KEY",
    "HERMES_APPROVER_ID",
    "HERMES_DRY_RUN_SIGNING_KEY",
    "IRONWRAP_EFFECT_RUNTIME_TOKEN",
    "IRONWRAP_EFFECT_RUNTIME_URL",
    "PATH",
  ]);
  assert.equal(child.PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET, undefined);
  assert.equal(child.HERMES_APPROVAL_PRIVATE_KEY, undefined);
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
});

test("a real MCP child spawned with exactly this environment boots and serves its tools", async () => {
  // The end-to-end shape of ELEC-128 defect 1: the failure was never in the tool,
  // it was that the process never reached one. Listing tools proves the child got
  // past `configFromEnv` AND past service-principal attestation, and finished
  // building a write-enabled server.
  //
  // The stub answers exactly the one endpoint boot calls. It is a boot fixture, not
  // a Frappe mock: no tool is invoked here, so no domain behaviour is being faked.
  const frappe = createServer((req, res) => {
    if (req.url?.startsWith("/api/method/frappe.auth.get_logged_user")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: ACTOR_USER }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: null }));
  });
  await new Promise((resolve) => frappe.listen(0, "127.0.0.1", resolve));
  const { port } = frappe.address();

  const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const client = new Client({ name: "broker-child-env-test", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: childEnv({ ERPNEXT_BASE_URL: `http://127.0.0.1:${port}` }),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools({}, { timeout: 20_000 });
    const names = tools.map((tool) => tool.name);
    assert.ok(
      names.includes("dry_run_job_assignment") && names.includes("request_create_job_assignment"),
      "the child must serve the production-schedule rail's own tools",
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => frappe.close(resolve));
  }
});

test("a child environment missing the tenant id fails loudly instead of booting", () => {
  // The pre-fix allowlist, reconstructed: this is what three brokers shipped.
  const legacy = childEnv();
  delete legacy.ERPNEXT_TENANT_ID;
  assert.throws(() => configFromEnv(legacy), /ERPNEXT_TENANT_ID is required/);
});

test("a child environment missing the effect runtime fails loudly instead of booting", () => {
  const legacy = childEnv();
  delete legacy.IRONWRAP_EFFECT_RUNTIME_URL;
  delete legacy.IRONWRAP_EFFECT_RUNTIME_TOKEN;
  assert.throws(
    () => configFromEnv(legacy),
    /IRONWRAP_EFFECT_RUNTIME_URL and IRONWRAP_EFFECT_RUNTIME_TOKEN are required/,
  );
});
