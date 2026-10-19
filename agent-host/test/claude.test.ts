import assert from "node:assert/strict";
import test from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter, type ClaudeQuery } from "../src/gateway/claude.ts";
import type { ClaudeAccount } from "../src/gateway/config.ts";
import { ProviderError, classifyText, limitResetMs, type ProviderCall } from "../src/gateway/types.ts";
import { OUTPUT_SCHEMA, entryOf, shippedConfig, tempDir } from "./helpers.ts";

const TOKEN = ["synthetic", "oauth", "value"].join("-");
const KEY = ["synthetic", "api", "value"].join("-");
/** The shipped Claude account; each call gets a fresh copy to change. */
const account = () => shippedConfig().providers.claude as ClaudeAccount;

function call(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    model: "claude-opus-5-5",
    entry: entryOf("claude", "claude-opus-5-5"),
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
  const adapter = createClaudeAdapter(account(), stateDir, env, scripted([result()], seen));
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
  const config = { ...account(), credentialMode: "api_key" as const, billing: "api" as const };
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY };
  const adapter = createClaudeAdapter(config, tempDir(t), env, scripted([result()], seen));
  assert.equal(adapter.authMode, "api_key");
  await adapter.call(call());
  assert.equal(seen[0].env?.ANTHROPIC_API_KEY, KEY);
  assert.equal(seen[0].env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("credentials are read by name on every call and fingerprinted, never returned", async (t) => {
  const env: Record<string, string | undefined> = {};
  const adapter = createClaudeAdapter(account(), tempDir(t), env, scripted([]));
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
  const adapter = createClaudeAdapter(account(), tempDir(t), env, scripted([assistant, result()], seen));
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
    const adapter = createClaudeAdapter(account(), tempDir(t), env, scripted(messages));
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
  const adapter = createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted(messages));
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
  const adapter = createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted([fallback, result()]));
  assert.deepEqual((await adapter.call(call())).modelsUsed, ["claude-opus-5-5", "claude-opus-5"]);
});

/** "Oct 24"-style month and day for a moment in Sofia, so date texts stay in the future. */
function sofiaDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", month: "short", day: "numeric" }).formatToParts(ms);
  return `${parts.find((part) => part.type === "month")?.value} ${parts.find((part) => part.type === "day")?.value}`;
}

test("a subscription limit that arrives only as text is a rate limit that waits for its reset", async (t) => {
  const inThreeDays = `You've hit your weekly limit · resets ${sofiaDate(Date.now() + 3 * 86_400_000)} at 8am (Europe/Sofia)`;
  for (const [text, minMs, maxMs] of [
    [inThreeDays, 2 * 86_400_000, 4 * 86_400_000],
    ["You've hit your session limit · resets 5:30am (Europe/Sofia)", 1, 86_400_000],
  ] as const) {
    const adapter = createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted([result({ is_error: true, result: text, structured_output: undefined })]));
    await assert.rejects(adapter.call(call()), (error: ProviderError) => {
      assert.equal(error.kind, "rate_limit", text);
      assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs >= minMs && error.retryAfterMs <= maxMs, `${text}: ${error.retryAfterMs}`);
      return true;
    });
  }
  // Without a parseable reset it is still a rate limit, never a provider fault; other limits are not.
  for (const text of ["You've hit your weekly limit", "You've hit your session limit · resets soon", "daily limit reached"]) assert.equal(classifyText(text), "rate_limit", text);
  for (const text of ["context limit exceeded", "output token limit", "file size limit", "session limitation", "per-session limits"]) assert.notEqual(classifyText(text), "rate_limit", text);
  // A crashed CLI that only printed the limit is a rate limit whenever its reset parses.
  const thrown: ClaudeQuery = async function* () {
    throw new Error("Claude Code returned an error result: You've hit your limit · resets 3pm (Europe/Sofia)");
  };
  await assert.rejects(createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, thrown).call(call()), (error: ProviderError) => {
    assert.equal(error.kind, "rate_limit");
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 0 && error.retryAfterMs <= 86_400_000);
    return true;
  });
  // The CLI's own rate-limit event wins over any text, also when the CLI then fails.
  const eventThenCrash: ClaudeQuery = async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } } as unknown as SDKMessage;
    throw new Error(`You've hit your weekly limit · resets ${sofiaDate(Date.now() + 3 * 86_400_000)} at 8am (Europe/Sofia)`);
  };
  await assert.rejects(createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, eventThenCrash).call(call()), (error: ProviderError) => {
    assert.equal(error.kind, "rate_limit");
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 3_500_000 && error.retryAfterMs <= 3_600_000, String(error.retryAfterMs));
    return true;
  });
  // The CLI's own rate-limit event wins over any text.
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const both = [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } } as unknown as SDKMessage,
    result({ is_error: true, result: `You've hit your weekly limit · resets ${sofiaDate(Date.now() + 3 * 86_400_000)} at 8am (Europe/Sofia)`, structured_output: undefined }),
  ];
  await assert.rejects(createClaudeAdapter(account(), tempDir(t), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, scripted(both)).call(call()), (error: ProviderError) => {
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 3_500_000 && error.retryAfterMs <= 3_600_000);
    return true;
  });
});

test("a limit's reset text resolves to the next such local time in its zone", () => {
  // Sofia is UTC+3 in summer (EEST) and UTC+2 in winter (EET).
  const summer = Date.UTC(2026, 9, 18, 10, 0); // 13:00 in Sofia
  assert.equal(limitResetMs("resets Oct 24 at 8am (Europe/Sofia)", summer), Date.UTC(2026, 9, 24, 5, 0));
  assert.equal(limitResetMs("resets 5:30pm (Europe/Sofia)", summer), Date.UTC(2026, 9, 18, 14, 30));
  assert.equal(limitResetMs("resets 12pm (Europe/Sofia)", Date.UTC(2026, 9, 18, 6, 0)), Date.UTC(2026, 9, 18, 9, 0));
  // On the night summer time ends (Sofia leaves UTC+3 at 01:00 UTC), 2am is still summer time, and
  // 3:30am, which happens twice, resolves to its later instant so a retry never comes early.
  assert.equal(limitResetMs("resets Oct 25 at 2am (Europe/Sofia)", summer), Date.UTC(2026, 9, 24, 23, 0));
  assert.equal(limitResetMs("resets Oct 25 at 3:30am (Europe/Sofia)", summer), Date.UTC(2026, 9, 25, 1, 30));
  // West of UTC too: Denver's repeated 1:30am is the MST one, not the MDT one. (Edmonton left the
  // Mountain daylight-saving rules in tzdata 2026c, so it no longer repeats an hour.)
  assert.equal(limitResetMs("resets Nov 1 at 1:30am (America/Denver)", summer), Date.UTC(2026, 10, 1, 8, 30));
  // A time already past today means tomorrow.
  assert.equal(limitResetMs("resets 5:30am (Europe/Sofia)", summer), Date.UTC(2026, 9, 19, 2, 30));
  const winter = Date.UTC(2026, 11, 20, 10, 0);
  assert.equal(limitResetMs("resets Dec 21 at 12am (Europe/Sofia)", winter), Date.UTC(2026, 11, 20, 22, 0));
  // A date already past this year means next year, within the 31-day horizon.
  assert.equal(limitResetMs("resets Jan 2 at 9am (Europe/Sofia)", winter), Date.UTC(2027, 0, 2, 7, 0));
  // An impossible date never rolls over into the next month, even when that would be close.
  assert.equal(limitResetMs("resets Feb 30 at 8am (Europe/Sofia)", Date.UTC(2027, 1, 20, 10, 0)), undefined);
  // No zone, an unknown zone, an impossible time or date, a past or far-off reset: no guess, the
  // caller keeps its backoff.
  for (const text of [
    "resets 5:30am",
    "resets 5:30am (Mars/Olympus)",
    "resets 13pm (Europe/Sofia)",
    "resets Feb 30 at 8am (Europe/Sofia)",
    "resets Apr 31 at 8am (Europe/Sofia)",
    "resets Oct 18 at 8am (Europe/Sofia)",
    "resets Dec 24 at 8am (Europe/Sofia)",
    "resets Oct 24, 2025 at 8am (Europe/Sofia)",
    "you've hit your usage limit",
  ]) assert.equal(limitResetMs(text, summer), undefined, text);
});
