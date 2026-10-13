import assert from "node:assert/strict";
import test from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter, type ClaudeQuery } from "../src/gateway/claude.ts";
import { ProviderError, type ProviderCall } from "../src/gateway/types.ts";
import { OUTPUT_SCHEMA, shippedConfig, tempDir } from "./helpers.ts";

const TOKEN = ["synthetic", "oauth", "value"].join("-");
const KEY = ["synthetic", "api", "value"].join("-");

function call(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    model: "claude-opus-5-5",
    effort: "high",
    system: "audit instructions",
    prompt: "<data>synthetic</data>",
    outputSchema: OUTPUT_SCHEMA,
    tools: undefined,
    maxTurns: 16,
    maxCostUsd: 3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: { decision: "propose", note: null },
    total_cost_usd: 0.42,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.42,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        canonicalModel: "claude-opus-5-5",
      },
    },
    ...overrides,
  } as unknown as SDKMessage;
}

function scripted(messages: SDKMessage[], seen: Options[] = []): ClaudeQuery {
  return async function* ({ options }) {
    if (options) seen.push(options);
    yield* messages;
  };
}

test("the Claude run is isolated and carries only the configured OAuth credential", async (t) => {
  const seen: Options[] = [];
  const stateDir = tempDir(t);
  const env = { PATH: "/usr/bin", HOME: "/home/agent", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY, IRONWRAP_ADMIN_TOKEN: "worker" };
  const adapter = createClaudeAdapter(shippedConfig(), stateDir, env, scripted([result()], seen));
  const outcome = await adapter.call(call());
  const options = seen[0];
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.maxBudgetUsd, 3);
  assert.equal(options.model, "claude-opus-5-5");
  assert.equal(options.effort, "high");
  assert.equal(options.systemPrompt, "audit instructions");
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema: OUTPUT_SCHEMA });
  assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env?.IRONWRAP_ADMIN_TOKEN, undefined);
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, `${stateDir}/claude-config`);
  assert.deepEqual(outcome.output, { decision: "propose", note: null });
  assert.deepEqual(outcome.usage, { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50 });
  assert.equal(outcome.costUsd, 0.42);
  assert.deepEqual(outcome.modelsUsed, ["claude-opus-5-5"]);
});

test("an API key replaces the sign-in by configuration alone", async (t) => {
  const seen: Options[] = [];
  const config = shippedConfig();
  config.providers.claude.auth = "api_key";
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY };
  const adapter = createClaudeAdapter(config, tempDir(t), env, scripted([result()], seen));
  assert.equal(adapter.authMode, "api_key");
  await adapter.call(call());
  assert.equal(seen[0].env?.ANTHROPIC_API_KEY, KEY);
  assert.equal(seen[0].env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("credentials are read by name on every call and fingerprinted, never returned", async (t) => {
  const env: Record<string, string | undefined> = {};
  const adapter = createClaudeAdapter(shippedConfig(), tempDir(t), env, scripted([]));
  assert.deepEqual(await adapter.credential(), { fingerprint: null });
  await assert.rejects(adapter.call(call()), (error: ProviderError) => error.kind === "auth");
  env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
  const first = await adapter.credential();
  assert.match(first.fingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(first).includes(TOKEN));
  env.CLAUDE_CODE_OAUTH_TOKEN = `${TOKEN}-rotated`;
  assert.notEqual((await adapter.credential()).fingerprint, first.fingerprint);
});

test("allowlisted MCP tools are the only tools, and their calls are reported", async (t) => {
  const seen: Options[] = [];
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, IRONWRAP_AGENT_TOKEN: "agent-token" };
  const assistant = {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "mcp__ironwrap__lead_get", input: { lead_id: "L-1" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "env" } },
      ],
    },
  } as unknown as SDKMessage;
  const adapter = createClaudeAdapter(shippedConfig(), tempDir(t), env, scripted([assistant, result()], seen));
  const server = { command: "node", args: ["server.mjs"], env: { MODE: "agent" }, passEnv: ["IRONWRAP_AGENT_TOKEN"] };
  const outcome = await adapter.call(call({ tools: { server, allowed: ["lead_get", "lead_qualify"] } }));
  assert.deepEqual(seen[0].allowedTools, ["mcp__ironwrap__lead_get", "mcp__ironwrap__lead_qualify"]);
  assert.deepEqual(seen[0].mcpServers, { ironwrap: { type: "stdio", command: "node", args: ["server.mjs"], env: { MODE: "agent" } } });
  assert.equal(seen[0].env?.IRONWRAP_AGENT_TOKEN, "agent-token");
  assert.deepEqual(outcome.toolCalls, [{ tool: "lead_get", arguments: { lead_id: "L-1" } }]);
});

test("provider failures are classified for the gateway", async (t) => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  const cases: Array<[string, SDKMessage[], string]> = [
    [
      "subscription rate limit",
      [
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } } as unknown as SDKMessage,
        result({ is_error: true, result: "limit reached", structured_output: undefined }),
      ],
      "rate_limit",
    ],
    [
      "rejected sign-in",
      [
        { type: "assistant", error: "authentication_failed", parent_tool_use_id: null, message: { content: [] } } as unknown as SDKMessage,
        result({ is_error: true, result: "Invalid bearer token", structured_output: undefined }),
      ],
      "auth",
    ],
    ["overloaded", [result({ is_error: true, api_error_status: 529, result: "Overloaded", structured_output: undefined })], "transient"],
    ["budget stop", [result({ subtype: "error_max_budget_usd", errors: [] })], "budget"],
    ["schema retries exhausted", [result({ subtype: "error_max_structured_output_retries", errors: [] })], "invalid_output"],
    ["no structured output", [result({ structured_output: undefined })], "invalid_output"],
    ["no result at all", [], "transient"],
  ];
  for (const [name, messages, kind] of cases) {
    const adapter = createClaudeAdapter(shippedConfig(), tempDir(t), env, scripted(messages));
    await assert.rejects(adapter.call(call()), (error: ProviderError) => {
      assert.equal(error.kind, kind, name);
      return true;
    });
  }
});

test("a rate limit carries the reset time so the gateway can cool down", async (t) => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const messages = [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } } as unknown as SDKMessage,
    result({ is_error: true, result: "limit", structured_output: undefined }),
  ];
  const adapter = createClaudeAdapter(shippedConfig(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted(messages));
  await assert.rejects(adapter.call(call()), (error: ProviderError) => {
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 3_500_000);
    return true;
  });
});

test("a refusal fallback to another model is reported in modelsUsed", async (t) => {
  const fallback = {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    original_model: "claude-opus-5-5",
    fallback_model: "claude-opus-5",
  } as unknown as SDKMessage;
  const adapter = createClaudeAdapter(shippedConfig(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted([fallback, result()]));
  assert.deepEqual((await adapter.call(call())).modelsUsed, ["claude-opus-5-5", "claude-opus-5"]);
});
