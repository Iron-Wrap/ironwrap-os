import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CodexOptions, RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { createCodexAdapter, type CodexFactory } from "../src/gateway/codex.ts";
import { ProviderError, classifyText, type ProviderCall } from "../src/gateway/types.ts";
import { OUTPUT_SCHEMA, shippedConfig, tempDir } from "./helpers.ts";

const KEY = ["synthetic", "codex", "value"].join("-");

interface Seen {
  codex: CodexOptions[];
  thread: ThreadOptions[];
  turn: TurnOptions[];
  input: string[];
}

function factory(answer: RunResult | Error, seen: Seen): CodexFactory {
  return (options) => {
    seen.codex.push(options);
    return {
      startThread(threadOptions) {
        seen.thread.push(threadOptions);
        return {
          async run(input, turnOptions) {
            seen.input.push(input);
            seen.turn.push(turnOptions);
            if (answer instanceof Error) throw answer;
            return answer;
          },
        };
      },
    };
  };
}

const newSeen = (): Seen => ({ codex: [], thread: [], turn: [], input: [] });

function turn(finalResponse = JSON.stringify({ decision: "propose", note: null }), items: RunResult["items"] = []): RunResult {
  return {
    items,
    finalResponse,
    usage: { input_tokens: 10_000, cached_input_tokens: 4_000, cache_write_input_tokens: 0, output_tokens: 1_000, reasoning_output_tokens: 300 },
  };
}

function call(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    model: "gpt-6.1-sol",
    effort: "medium",
    system: "lead concierge instructions",
    prompt: "<data>synthetic</data>",
    outputSchema: OUTPUT_SCHEMA,
    tools: undefined,
    maxTurns: 16,
    maxCostUsd: 3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function signedIn(home: string, lastRefresh = "2026-01-01T00:00:00Z"): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic" }, last_refresh: lastRefresh }));
}

test("the Codex run uses the ChatGPT sign-in in CODEX_HOME with every tool but MCP disabled", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const seen = newSeen();
  const env = { PATH: "/usr/bin", HOME: "/home/agent", CODEX_HOME: home, CODEX_API_KEY: KEY, IRONWRAP_ADMIN_TOKEN: "worker" };
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), env, factory(turn(), seen));
  const outcome = await adapter.call(call());
  const options = seen.codex[0];
  assert.equal(options.apiKey, undefined);
  assert.deepEqual(options.env, { CODEX_HOME: home, PATH: "/usr/bin", HOME: "/home/agent" });
  assert.equal(options.config?.developer_instructions, "lead concierge instructions");
  assert.equal(options.config?.forced_login_method, "chatgpt");
  assert.equal(options.config?.project_doc_max_bytes, 0);
  assert.deepEqual(options.config?.history, { persistence: "none" });
  const features = options.config?.features as Record<string, boolean>;
  for (const key of ["shell_tool", "unified_exec", "apps", "hooks", "memories", "multi_agent", "goals", "remote_plugin", "skill_mcp_dependency_install", "view_image"]) {
    assert.equal(features[key], false, key);
  }
  // Keys must exist in the pinned CLI's config schema; `tools` takes no view_image there.
  assert.deepEqual(Object.keys(options.config ?? {}).sort(), [
    "cli_auth_credentials_store",
    "developer_instructions",
    "features",
    "forced_login_method",
    "history",
    "project_doc_max_bytes",
  ]);
  assert.equal(options.config?.mcp_servers, undefined);
  const thread = seen.thread[0];
  assert.equal(thread.model, "gpt-6.1-sol");
  assert.equal(thread.sandboxMode, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.networkAccessEnabled, false);
  assert.equal(thread.webSearchMode, "disabled");
  assert.equal(thread.modelReasoningEffort, "medium");
  assert.deepEqual(seen.turn[0].outputSchema, OUTPUT_SCHEMA);
  assert.equal(seen.input[0], "<data>synthetic</data>");
  assert.deepEqual(outcome.output, { decision: "propose", note: null });
  assert.deepEqual(outcome.usage, { inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 1_000 });
  // (6000 * 2 + 4000 * 0.2 + 1000 * 10) / 1e6
  assert.equal(outcome.costUsd, 0.0228);
});

test("an API key replaces the ChatGPT sign-in by configuration alone", async (t) => {
  const config = shippedConfig();
  config.providers.codex.auth = "api_key";
  const seen = newSeen();
  const adapter = createCodexAdapter(config, tempDir(t), { CODEX_HOME: tempDir(t), CODEX_API_KEY: KEY }, factory(turn(), seen));
  assert.equal(adapter.authMode, "api_key");
  await adapter.call(call());
  assert.equal(seen.codex[0].apiKey, KEY);
  assert.equal(seen.codex[0].config?.forced_login_method, "api");
  assert.equal(seen.codex[0].env?.CODEX_API_KEY, undefined);
});

test("an API-key run without CODEX_HOME gets a private home under the state directory", async (t) => {
  const config = shippedConfig();
  config.providers.codex.auth = "api_key";
  const stateDir = tempDir(t);
  const seen = newSeen();
  const adapter = createCodexAdapter(config, stateDir, { CODEX_API_KEY: KEY }, factory(turn(), seen));
  await adapter.call(call());
  assert.equal(seen.codex[0].env?.CODEX_HOME, join(stateDir, "codex-home"));
});

test("the sign-in fingerprint follows auth.json refreshes and reports when it last refreshed", async (t) => {
  const home = tempDir(t);
  const env: Record<string, string | undefined> = {};
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), env, factory(turn(), newSeen()));
  assert.deepEqual(await adapter.credential(), { fingerprint: null });
  env.CODEX_HOME = home;
  assert.deepEqual(await adapter.credential(), { fingerprint: null });
  signedIn(home, "2026-01-01T00:00:00Z");
  const first = await adapter.credential();
  assert.equal(first.refreshedAt, Date.parse("2026-01-01T00:00:00Z"));
  signedIn(home, "2026-01-02T00:00:00Z");
  const second = await adapter.credential();
  assert.notEqual(second.fingerprint, first.fingerprint);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ last_refresh: "2026-01-02T00:00:00Z" }));
  assert.deepEqual(await adapter.credential(), { fingerprint: null });
});

test("allowlisted MCP tools are configured without secrets on argv and their calls are reported", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const seen = newSeen();
  const items = [
    { id: "i1", type: "mcp_tool_call", server: "ironwrap", tool: "lead_get", arguments: { lead_id: "L-1" }, status: "completed" },
    { id: "i2", type: "mcp_tool_call", server: "other", tool: "x", arguments: {}, status: "completed" },
  ] as RunResult["items"];
  const env = { CODEX_HOME: home, IRONWRAP_AGENT_TOKEN: "agent-token" };
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), env, factory(turn(undefined, items), seen));
  const server = { command: "node", args: ["server.mjs"], env: { MODE: "agent" }, passEnv: ["IRONWRAP_AGENT_TOKEN"] };
  const outcome = await adapter.call(call({ tools: { server, allowed: ["lead_get"] } }));
  assert.deepEqual(seen.codex[0].config?.mcp_servers, {
    ironwrap: { command: "node", args: ["server.mjs"], env: { MODE: "agent" }, env_vars: ["IRONWRAP_AGENT_TOKEN"], enabled_tools: ["lead_get"], required: true },
  });
  assert.equal(seen.codex[0].env?.IRONWRAP_AGENT_TOKEN, "agent-token");
  assert.ok(!JSON.stringify(seen.codex[0].config).includes("agent-token"));
  assert.deepEqual(outcome.toolCalls, [{ tool: "lead_get", arguments: { lead_id: "L-1" } }]);
});

test("Codex failures are classified for the gateway", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const cases: Array<[RunResult | Error, string]> = [
    [new Error("Codex Exec exited with code 1: 429 Too Many Requests"), "rate_limit"],
    [new Error("You've hit your usage limit"), "rate_limit"],
    [new Error("401 Unauthorized: refresh token was revoked"), "auth"],
    [new Error("stream disconnected: ECONNRESET"), "transient"],
    [new Error("model not supported"), "fatal"],
    [turn("not json"), "invalid_output"],
  ];
  for (const [answer, kind] of cases) {
    const adapter = createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, factory(answer, newSeen()));
    await assert.rejects(adapter.call(call()), (error: ProviderError) => {
      assert.equal(error.kind, kind, String(answer instanceof Error ? answer.message : answer.finalResponse));
      return true;
    });
  }
});

test("a run that costs more than the per-call ceiling is refused after the fact", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, factory(turn(), newSeen()));
  await assert.rejects(adapter.call(call({ maxCostUsd: 0.01 })), (error: ProviderError) => {
    assert.equal(error.kind, "budget");
    assert.equal(error.costUsd, 0.0228);
    return true;
  });
});

test("a CODEX_HOME with its own config.toml is refused, so no personal MCP server or profile leaks in", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  writeFileSync(join(home, "config.toml"), "[mcp_servers.personal]\ncommand = \"x\"\n");
  const seen = newSeen();
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, factory(turn(), seen));
  await assert.rejects(adapter.call(call()), (error: ProviderError) => {
    assert.equal(error.kind, "fatal");
    assert.match(error.message, /dedicated home/);
    return true;
  });
  assert.equal(seen.codex.length, 0);
});

/** A synthetic unsigned id token carrying only a plan claim. */
function idToken(plan: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })}.`;
}

test("the sign-in reports the plan its id token claims and nothing else from it", async (t) => {
  const home = tempDir(t);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: idToken("free"), access_token: "synthetic" }, last_refresh: "2026-01-01T00:00:00Z" }));
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home });
  const credential = await adapter.credential();
  assert.equal(credential.plan, "free");
  assert.deepEqual(Object.keys(credential).sort(), ["fingerprint", "plan", "refreshedAt"]);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: "not-a-jwt", access_token: "synthetic" } }));
  assert.equal((await adapter.credential()).plan, undefined);
});

test("a model the ChatGPT plan does not include is a plan refusal with an actionable detail", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const refusal = new Error('unexpected status 400 Bad Request: {"detail":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}');
  const adapter = createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, factory(refusal, newSeen()));
  await assert.rejects(adapter.call(call()), (error: ProviderError) => {
    assert.equal(error.kind, "plan");
    assert.equal(error.message, "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it");
    return true;
  });
});

test("the models used come from the thread's session rollout", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const now = new Date();
  const day = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(day, { recursive: true });
  const thread = "01a149bc-ac0b-7ec1-a79d-ec01007bd63a";
  const records = [
    { type: "session_meta", payload: { model_provider: "openai" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "medium" } },
    { type: "event_msg", payload: { type: "token_count" } },
  ];
  writeFileSync(join(day, `rollout-2026-01-01T00-00-00-${thread}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n{"type":"turn_con`);
  writeFileSync(join(day, "rollout-2026-01-01T00-00-00-another-thread.jsonl"), `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-other" } })}\n`);
  // A name that ends in the thread id without the separating dash is another thread's rollout.
  writeFileSync(join(day, `rollout-2026-01-01T00-00-00-x${thread}.jsonl`), `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-decoy" } })}\n`);
  const withThread = (id: string | null): CodexFactory => (options) => {
    const inner = factory(turn(), newSeen())(options);
    return { startThread: (threadOptions) => ({ ...inner.startThread(threadOptions), id }) };
  };
  const used = await createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, withThread(thread)).call(call());
  assert.deepEqual(used.modelsUsed, ["gpt-6.1-sol"]);
  // No thread id, or no rollout for it, reports no model rather than a guess.
  assert.deepEqual((await createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, withThread(null)).call(call())).modelsUsed, []);
  assert.deepEqual((await createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, withThread("missing")).call(call())).modelsUsed, []);
});

test("only Codex's exact plan refusal is a plan outcome", () => {
  assert.equal(classifyText("unexpected status 400: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."), "plan");
  assert.equal(classifyText("WARN memories not available on your plan\nERROR stream disconnected: 503 Service Unavailable"), "transient");
  assert.equal(classifyText("429 usage limit reached; this feature is not available on your plan"), "rate_limit");
});

test("an unreadable session rollout loses the model, never the billed answer", async (t) => {
  const home = tempDir(t);
  signedIn(home);
  const now = new Date();
  const day = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  const { mkdirSync } = await import("node:fs");
  const thread = "01a149bc-ac0b-7ec1-a79d-ec01007bd63b";
  // A directory where the rollout file should be makes the read fail (EISDIR).
  mkdirSync(join(day, `rollout-2026-01-01T00-00-00-${thread}.jsonl`), { recursive: true });
  const withThread: CodexFactory = (options) => {
    const inner = factory(turn(), newSeen())(options);
    return { startThread: (threadOptions) => ({ ...inner.startThread(threadOptions), id: thread }) };
  };
  const result = await createCodexAdapter(shippedConfig(), tempDir(t), { CODEX_HOME: home }, withThread).call(call());
  assert.deepEqual(result.modelsUsed, []);
  assert.equal(result.costUsd, 0.0228);
  assert.deepEqual(result.output, { decision: "propose", note: null });
});
