import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentConfigFromEnv, buildAgentServer, loadRunTools } from "../src/agent-server.mjs";

const TOKEN = "t".repeat(40);
const RUN_ID = "run_00000000-0000-4000-8000-000000000001";
const ARGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lead_id"],
  properties: { lead_id: { type: "string" } },
};
const TOOLS = [
  { action_id: "lead.qualify", tool_name: "lead_qualify", autonomy: "A1", description: "Record a qualification.", args_schema: ARGS_SCHEMA },
  { action_id: "comms.send", tool_name: "comms_send", autonomy: "A3", description: "Send a message.", args_schema: ARGS_SCHEMA },
];

const env = (overrides = {}) => ({
  IRONWRAP_BUS_BASE_URL: "https://bus.example.invalid",
  AGENT_HOST_WORKER_TOKEN: TOKEN,
  AGENT_RUN_ID: RUN_ID,
  AGENT_ALLOWED_ACTIONS: "lead.qualify",
  ...overrides,
});

function fakeWorker(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body } = typeof answer === "function" ? answer(url, init) : answer;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

async function connect(config, tools, fetchImpl) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildAgentServer(config, tools, fetchImpl).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("configuration needs an HTTPS Worker, the host token, a run id and an allowlist", () => {
  assert.throws(() => agentConfigFromEnv(env({ IRONWRAP_BUS_BASE_URL: "http://bus.example.invalid" })), /HTTPS/);
  assert.throws(() => agentConfigFromEnv(env({ AGENT_HOST_WORKER_TOKEN: "" })), /AGENT_HOST_WORKER_TOKEN/);
  assert.throws(() => agentConfigFromEnv(env({ AGENT_RUN_ID: "x" })), /AGENT_RUN_ID/);
  assert.throws(() => agentConfigFromEnv(env({ AGENT_ALLOWED_ACTIONS: "" })), /AGENT_ALLOWED_ACTIONS/);
  const local = agentConfigFromEnv(env({ IRONWRAP_BUS_BASE_URL: "http://localhost:8787", IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: "true" }));
  assert.equal(local.baseUrl, "http://localhost:8787");
});

test("only the Worker's tools whose action the host allowlisted are exposed", async () => {
  const config = agentConfigFromEnv(env());
  const worker = fakeWorker({ body: { tools: TOOLS } });
  const tools = await loadRunTools(config, worker.fetchImpl);
  assert.deepEqual(tools.map((tool) => tool.tool_name), ["lead_qualify"]);
  // A Worker that renames a tool onto an allowlisted name cannot widen the set: actions decide.
  const renamed = fakeWorker({ body: { tools: [{ ...TOOLS[1], tool_name: "lead_qualify" }] } });
  assert.deepEqual(await loadRunTools(config, renamed.fetchImpl), []);
  assert.equal(worker.calls[0].url, `https://bus.example.invalid/api/v1/agents/runs/${RUN_ID}/tools`);
  assert.equal(worker.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  const client = await connect(config, tools, worker.fetchImpl);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["lead_qualify"]);
  assert.deepEqual(listed.tools[0].inputSchema.properties.args, ARGS_SCHEMA);
  assert.deepEqual(listed.tools[0].inputSchema.required, ["args", "citations"]);
});

test("a tool call is a proposed step and the Worker's decision is returned verbatim", async () => {
  const config = agentConfigFromEnv(env());
  const decision = { step_id: "step_1", decision: "recorded", reason_codes: [] };
  const worker = fakeWorker({ body: decision });
  const client = await connect(config, [TOOLS[0]], worker.fetchImpl);
  const result = await client.callTool({
    name: "lead_qualify",
    arguments: { args: { lead_id: "L-1001" }, citations: [{ fact_id: "lead:L-1001", version: 3 }] },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), decision);
  assert.equal(worker.calls[0].url, `https://bus.example.invalid/api/v1/agents/runs/${RUN_ID}/steps`);
  const { step_key: stepKey, ...step } = worker.calls[0].body;
  assert.deepEqual(step, {
    action_id: "lead.qualify",
    args: { lead_id: "L-1001" },
    citations: [{ fact_id: "lead:L-1001", version: 3 }],
  });
  assert.match(stepKey, /^[0-9a-f]{64}$/);
  await client.callTool({
    name: "lead_qualify",
    arguments: { citations: [{ version: 3, fact_id: "lead:L-1001" }], args: { lead_id: "L-1001" } },
  });
  assert.equal(worker.calls[1].body.step_key, stepKey, "a repeated proposal carries the same key");
});

test("unknown tools, malformed calls and Worker refusals come back as tool errors", async () => {
  const config = agentConfigFromEnv(env());
  const worker = fakeWorker({ status: 422, body: { error: "stale_context" } });
  const client = await connect(config, [TOOLS[0]], worker.fetchImpl);
  const unknown = await client.callTool({ name: "comms_send", arguments: { args: {}, citations: [] } });
  assert.equal(unknown.isError, true);
  assert.equal(JSON.parse(unknown.content[0].text).error, "unknown_tool");
  const malformed = await client.callTool({ name: "lead_qualify", arguments: { args: {} } });
  assert.equal(JSON.parse(malformed.content[0].text).error, "invalid_arguments");
  const refused = await client.callTool({ name: "lead_qualify", arguments: { args: { lead_id: "L-1" }, citations: [] } });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).error, "stale_context");
  assert.equal(worker.calls.length, 1);
});

test("the variables the agent host sets are exactly the ones this server reads", async () => {
  const { actionServerSpec } = await import("../../../agent-host/src/host/action-server.ts");
  const spec = actionServerSpec(
    { actionServerPath: "/srv/agent-server.mjs", workerUrl: "https://bus.example.invalid", allowInsecureLocal: false },
    RUN_ID,
    ["lead.qualify", "comms.send"],
  );
  const passed = Object.fromEntries(spec.passEnv.map((name) => [name, TOKEN]));
  const config = agentConfigFromEnv({ ...spec.env, ...passed });
  assert.equal(config.baseUrl, "https://bus.example.invalid");
  assert.equal(config.runId, RUN_ID);
  assert.equal(config.token, TOKEN);
  assert.deepEqual([...config.allowed], ["lead.qualify", "comms.send"]);
  assert.ok(!Object.values(spec.env).includes(TOKEN), "the token travels by name, not in the server env");
});
