// Gateway config v3 at run time: declared failover, the qualification gate, provider terms per run
// class, family independence per hop, the registry's fit and rate limits, and token ceilings.
// Fake adapters only; every account, credential and figure here is synthetic.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import type { DataClass } from "../src/gateway/compliance.ts";
import { ProviderGateway } from "../src/gateway/gateway.ts";
import { ProviderError, type GatewayRequest, type GatewayResult, type QualifiedRoute } from "../src/gateway/types.ts";
import { CONFIG_PATH, CONSUMER_CONFIG_PATH, OUTPUT_SCHEMA, RELEASE, fakeAdapter, liveConfig, outcome, qualification, qualifications, tempDir, type FakeAdapter } from "./helpers.ts";

const RETENTION = { confirmed_by: "owner", reference: "synthetic retention confirmation" };

/**
 * The shipped file with a second openai account behind the Codex adapter and declared fallbacks:
 * codex_sol falls back to the same model on that account, and the openai audit route to Sonnet.
 */
function chained(mutate: (raw: any) => void = () => {}): GatewayConfig {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  raw.providers.codex.confirmed_retention = RETENTION;
  raw.providers.codex_backup = { ...structuredClone(raw.providers.codex), secrets: { api_key_env: "CODEX_BACKUP_API_KEY", codex_home_env: "CODEX_BACKUP_HOME" } };
  raw.routes.backup_sol = { provider: "codex_backup", model: "gpt-6.1-sol", effort: "medium", fallback: null };
  raw.routes.codex_sol.fallback = "backup_sol";
  raw.routes.claude_sonnet = { provider: "claude", model: "claude-sonnet-5-5", effort: "high", fallback: null };
  raw.routes.claude_opus.fallback = "claude_sonnet";
  mutate(raw);
  return parseGatewayConfig(raw);
}

interface Harness {
  gateway: ProviderGateway;
  adapters: Record<string, FakeAdapter>;
  stateDir: string;
  clock: { now: number };
}

function harness(t: TestContext, options: { config?: GatewayConfig; dataClass?: DataClass; qualification?: { ledger: unknown; judge: unknown } } = {}): Harness {
  const config = options.config ?? liveConfig();
  const stateDir = tempDir(t);
  const clock = { now: 1_000_000_000_000 };
  const adapters = Object.fromEntries(Object.keys(config.providers).map((id) => [id, fakeAdapter(id)]));
  // Each Codex sign-in claims the first plan its account lists.
  for (const [id, adapter] of Object.entries(adapters)) {
    const account = config.providers[id];
    adapter.credentialState = { fingerprint: `${id}-credential-1`, refreshedAt: clock.now, ...(account.adapter === "codex" ? { plan: account.chatgptPlans[0] } : {}) };
  }
  const gateway = new ProviderGateway({
    config,
    stateDir,
    env: {},
    adapters,
    ...(options.dataClass ? { dataClass: options.dataClass } : {}),
    ...(options.qualification ? { qualification: options.qualification } : {}),
    now: () => clock.now,
    random: () => 0.5,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  return { gateway, adapters, stateDir, clock };
}

/** A live run of a specialist the Worker qualified on every route of `config` at RELEASE. */
const request = (config: GatewayConfig, overrides: Partial<GatewayRequest> = {}): GatewayRequest => ({
  specialist: "lead_concierge",
  tier: "routine",
  release: RELEASE,
  qualifications: qualifications(config),
  system: "You are the lead concierge.",
  prompt: "<data>synthetic signal</data>",
  outputSchema: OUTPUT_SCHEMA,
  ...overrides,
});

function abstained(result: GatewayResult) {
  assert.equal(result.status, "abstained", JSON.stringify(result));
  return result as Extract<GatewayResult, { status: "abstained" }>;
}

const hops = (result: GatewayResult) => result.failover.map((hop) => [hop.routeId, hop.reason]);
const ledger = (h: Harness, file = "gateway-usage.jsonl") => {
  const path = join(h.stateDir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
const longLimit = () => new ProviderError("rate_limit", "usage limit reached", { retryAfterMs: 3_600_000 });
const calls = (h: Harness) => Object.fromEntries(Object.entries(h.adapters).map(([id, adapter]) => [id, adapter.calls.length]));

test("a rate-limited primary fails over to its declared fallback, which answers; both hops are booked and recorded", async (t) => {
  const config = chained();
  const h = harness(t, { config });
  h.adapters.codex.steps.push(longLimit());
  h.adapters.codex_backup.steps.push(outcome());
  const result = await h.gateway.run(request(config));
  assert.equal(result.status, "ok");
  assert.deepEqual(
    [result.routeId, result.provider, result.family, result.route, result.qualificationRef, result.attempts, result.complianceRef, result.runClass],
    ["backup_sol", "codex_backup", "openai", "declared_fallback", "q-backup_sol", 2, "ai.openai.chatgpt-commercial", "live"],
  );
  assert.deepEqual(result.failover, [{ routeId: "codex_sol", provider: "codex", model: "gpt-6.1-sol", family: "openai", reason: "rate_limited", retryAt: h.clock.now + 3_600_000 }]);
  assert.equal(result.gatewayConfigSha256, config.sha256);
  assert.deepEqual(
    ledger(h).map((record) => [record.routeId, record.route, record.provider, record.outcome, record.billing, record.runClass, record.complianceRef]),
    [
      ["codex_sol", "primary", "codex", "reserved", "subscription", "live", "ai.openai.chatgpt-commercial"],
      ["codex_sol", "primary", "codex", "rate_limit", "subscription", "live", "ai.openai.chatgpt-commercial"],
      ["backup_sol", "declared_fallback", "codex_backup", "reserved", "subscription", "live", "ai.openai.chatgpt-commercial"],
      ["backup_sol", "declared_fallback", "codex_backup", "ok", "subscription", "live", "ai.openai.chatgpt-commercial"],
    ],
  );
  // The primary is cooling down now: the next run skips it without a call or a booking.
  h.adapters.codex_backup.steps.push(outcome());
  const next = await h.gateway.run(request(config));
  assert.deepEqual([next.status, next.routeId, hops(next)], ["ok", "backup_sol", [["codex_sol", "rate_limited"]]]);
  assert.deepEqual(calls(h), { claude: 0, codex: 1, codex_backup: 2 });
  assert.equal(ledger(h).filter((record) => record.routeId === "codex_sol" && record.calls === 1).length, 1);
});

test("each listed reason moves a production run on to its fallback", async (t) => {
  const setups: Array<[string, (config: GatewayConfig, h: Harness) => void]> = [
    ["provider_error", (_, h) => h.adapters.codex.steps.push(...[1, 2, 3].map(() => new ProviderError("transient", "overloaded")))],
    ["auth_failed", (_, h) => h.adapters.codex.steps.push(new ProviderError("auth", "401 unauthorized"))],
    ["credential_missing", (_, h) => (h.adapters.codex.credentialState = { fingerprint: null })],
    ["provider_disabled", (config) => (config.providers.codex.enabled = false)],
    // A live run on an account whose terms do not serve it, like any refusal of the account.
    ["provider_disabled", (config) => (config.providers.codex.complianceRef = "ai.openai.chatgpt-consumer")],
  ];
  for (const [reason, setup] of setups) {
    const config = chained();
    const h = harness(t, { config });
    setup(config, h);
    h.adapters.codex_backup.steps.push(outcome());
    const result = await h.gateway.run(request(config));
    assert.deepEqual([result.status, result.routeId, result.route, hops(result)], ["ok", "backup_sol", "declared_fallback", [["codex_sol", reason]]], reason);
  }
});

test("reasons outside the failover list end the run on the hop that hit them", async (t) => {
  const endings: Array<[string, (config: GatewayConfig, h: Harness) => void]> = [
    ["invalid_output", (_, h) => h.adapters.codex.steps.push(outcome({ decision: "propose", note: null, send_now: true }))],
    ["model_mismatch", (_, h) => h.adapters.codex.steps.push({ ...outcome(), modelsUsed: ["gpt-5"] })],
    ["cost_ceiling", (_, h) => h.adapters.codex.steps.push(new ProviderError("budget", "per-call ceiling", { costUsd: 3 }))],
    ["call_ceiling", (config) => (config.ceilings.specialists.lead_concierge = { calls: 0.5, costUsd: 40, costUsdPerCall: 3 })],
  ];
  for (const [reason, setup] of endings) {
    const config = chained();
    const h = harness(t, { config });
    setup(config, h);
    const result = abstained(await h.gateway.run(request(config)));
    assert.deepEqual([result.reason, result.routeId, result.route, hops(result)], [reason, "codex_sol", "primary", [["codex_sol", reason]]], reason);
    assert.equal(h.adapters.codex_backup.calls.length, 0, reason);
  }
  const aborted = chained();
  const h = harness(t, { config: aborted });
  const cancel = new AbortController();
  h.adapters.codex.steps.push(async () => {
    cancel.abort();
    throw new ProviderError("transient", "interrupted");
  });
  assert.equal(abstained(await h.gateway.run(request(aborted, { signal: cancel.signal }))).reason, "aborted");
  assert.equal(h.adapters.codex_backup.calls.length, 0);
});

test("with every hop spent the run abstains with the primary's reason and the earliest retry time any hop named", async (t) => {
  const config = chained();
  const h = harness(t, { config });
  h.adapters.codex.steps.push(longLimit());
  h.adapters.codex_backup.steps.push(new ProviderError("rate_limit", "429", { retryAfterMs: 120_000 }));
  const result = abstained(await h.gateway.run(request(config)));
  assert.deepEqual([result.reason, result.routeId, result.route, result.retryAt], ["rate_limited", "codex_sol", "primary", h.clock.now + 120_000]);
  assert.deepEqual(result.failover.map((hop) => [hop.routeId, hop.reason, hop.retryAt]), [
    ["codex_sol", "rate_limited", h.clock.now + 3_600_000],
    ["backup_sol", "rate_limited", h.clock.now + 120_000],
  ]);
  // The whole chain's attempts stay within the ten the Worker counts.
  const deep = chained((raw) => (raw.routes.backup_sol.fallback = "codex_astra"));
  const spent = harness(t, { config: deep });
  for (const id of ["codex", "codex_backup", "codex"]) spent.adapters[id].steps.push(...[1, 2, 3].map(() => new ProviderError("transient", "socket hang up")));
  const all = abstained(await spent.gateway.run(request(deep)));
  assert.deepEqual([all.reason, all.attempts, hops(all)], ["provider_error", 9, [["codex_sol", "provider_error"], ["backup_sol", "provider_error"], ["codex_astra", "provider_error"]]]);
});

test("an unqualified fallback is skipped and recorded, never called", async (t) => {
  const config = chained();
  const h = harness(t, { config });
  h.adapters.codex.steps.push(longLimit());
  const unqualified = qualifications(config).filter((row) => row.id !== "q-backup_sol");
  const result = abstained(await h.gateway.run(request(config, { qualifications: unqualified })));
  assert.deepEqual([result.reason, result.retryAt, hops(result)], ["rate_limited", h.clock.now + 3_600_000, [["codex_sol", "rate_limited"], ["backup_sol", "no_qualified_route"]]]);
  assert.equal(h.adapters.codex_backup.calls.length, 0);
});

test("a live or shadow run with no qualification for its primary's provider, model, effort and release abstains no_qualified_route, without failover", async (t) => {
  const config = chained();
  const sol = qualifications(config).find((row) => row.id === "q-codex_sol") as QualifiedRoute;
  const others = qualifications(config).filter((row) => row.id !== "q-codex_sol");
  const variants: Array<[string, Partial<GatewayRequest>]> = [
    ["no qualifications at all", { qualifications: [] }],
    ["none for the primary", { qualifications: others }],
    ["another effort", { qualifications: [...others, { ...sol, effort: "high" }] }],
    ["another release", { qualifications: [...others, { ...sol, release: "f".repeat(64) }] }],
    ["another model", { qualifications: [...others, { ...sol, model: "gpt-6-astra" }] }],
    ["another provider", { qualifications: [...others, { ...sol, provider: "codex_backup" }] }],
    ["no release on the run", { release: undefined }],
  ];
  for (const scope of ["production", "shadow"] as const) {
    for (const [name, overrides] of variants) {
      const h = harness(t, { config });
      const result = abstained(await h.gateway.run(request(config, { scope, ...overrides })));
      assert.deepEqual([result.reason, result.routeId, hops(result), result.retryAt], ["no_qualified_route", "codex_sol", [["codex_sol", "no_qualified_route"]], undefined], `${scope}: ${name}`);
      assert.match(result.detail, /no qualification of codex\/gpt-6\.1-sol at medium effort for release/, name);
      assert.deepEqual(calls(h), { claude: 0, codex: 0, codex_backup: 0 }, name);
      assert.deepEqual(ledger(h), [], name);
    }
  }
  // The matching qualification is recorded on the run.
  const h = harness(t, { config });
  h.adapters.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request(config))).qualificationRef, "q-codex_sol");
});

test("eval runs need no qualification, never fail over, and record none", async (t) => {
  const config = chained();
  const h = harness(t, { config, qualification: qualification() });
  h.adapters.codex.steps.push(outcome());
  const ok = await h.gateway.run(request(config, { scope: "eval", data: "synthetic", qualifications: [], release: undefined }));
  assert.deepEqual([ok.status, ok.qualificationRef, ok.runClass], ["ok", null, "synthetic"]);
  h.adapters.codex.steps.push(longLimit());
  const limited = abstained(await h.gateway.run(request(config, { scope: "eval", data: "synthetic" })));
  assert.deepEqual([limited.reason, hops(limited)], ["rate_limited", [["codex_sol", "rate_limited"]]]);
  assert.equal(h.adapters.codex_backup.calls.length, 0);
  // Shadow runs stay on their primary too.
  const shadow = harness(t, { config });
  shadow.adapters.codex.steps.push(longLimit());
  assert.deepEqual(hops(abstained(await shadow.gateway.run(request(config, { scope: "shadow" })))), [["codex_sol", "rate_limited"]]);
  assert.equal(shadow.adapters.codex_backup.calls.length, 0);
});

test("an audit fails over within its route's family and never onto the family under review", async (t) => {
  const config = chained();
  const audit = (h: Harness) => h.gateway.run(request(config, { specialist: "independent_auditor", tier: "audit", reviewOf: { runId: "run_0000000009", family: "openai" } }));
  const h = harness(t, { config });
  h.adapters.claude.steps.push(longLimit(), outcome());
  const result = await audit(h);
  assert.deepEqual([result.status, result.routeId, result.family, result.route, hops(result)], ["ok", "claude_sonnet", "anthropic", "declared_fallback", [["claude_opus", "rate_limited"]]]);
  // The result names the effort of the route that answered, and the hop it passed over its family.
  assert.deepEqual([result.effort, result.failover.map((hop) => hop.family)], ["high", ["anthropic"]]);
  assert.equal(h.adapters.claude.calls[1].model, "claude-sonnet-5-5");
  // A chain that reaches the reviewed family past the configuration skips that hop per run.
  config.fallbacks.claude_opus = "codex_astra";
  const crossed = harness(t, { config });
  crossed.adapters.claude.steps.push(longLimit());
  const refused = abstained(await audit(crossed));
  assert.deepEqual([refused.reason, refused.routeId, hops(refused)], ["rate_limited", "claude_opus", [["claude_opus", "rate_limited"], ["codex_astra", "no_independent_route"]]]);
  assert.equal(crossed.adapters.codex.calls.length, 0);
  // So does a proposer fallback of another family than its primary.
  config.fallbacks.claude_opus = null;
  config.fallbacks.codex_sol = "claude_opus";
  const proposer = harness(t, { config });
  proposer.adapters.codex.steps.push(longLimit());
  const stayed = abstained(await proposer.gateway.run(request(config)));
  assert.deepEqual(hops(stayed), [["codex_sol", "rate_limited"], ["claude_opus", "no_qualified_route"]]);
  assert.equal(proposer.adapters.claude.calls.length, 0);
});

test("live and shadow runs on consumer accounts are refused provider_disabled, and only eval_history may be accepted by the owner", async (t) => {
  const consumer = () => parseGatewayConfig(JSON.parse(readFileSync(CONSUMER_CONFIG_PATH, "utf8")));
  for (const scope of ["production", "shadow"] as const) {
    const config = consumer();
    const h = harness(t, { config });
    const result = abstained(await h.gateway.run(request(config, { scope })));
    assert.deepEqual([result.reason, result.complianceRef, result.runClass], ["provider_disabled", "ai.openai.chatgpt-consumer", scope === "shadow" ? "shadow" : "live"], scope);
    assert.match(result.detail, new RegExp(`codex is on ai\\.openai\\.chatgpt-consumer, which does not serve ${scope === "shadow" ? "shadow" : "live"} runs`));
    assert.deepEqual([h.adapters.codex.calls.length, ledger(h)], [0, []]);
  }
  // Eval runs on real history need the owner's acceptance of the consumer ref; synthetic ones do not.
  const raw = JSON.parse(readFileSync(CONSUMER_CONFIG_PATH, "utf8"));
  raw.owner_risk_acceptances = [{ ref: "ai.openai.chatgpt-consumer", run_class: "eval_history", accepted_by: "owner", reason: "Synthetic acceptance for the test." }];
  const accepted = parseGatewayConfig(raw);
  const h = harness(t, { config: accepted, qualification: qualification() });
  h.adapters.codex.steps.push(outcome(), outcome());
  const history = await h.gateway.run(request(accepted, { scope: "eval" }));
  assert.deepEqual([history.status, history.runClass, history.riskAcceptance], ["ok", "eval_history", { ref: "ai.openai.chatgpt-consumer", runClass: "eval_history", reason: "Synthetic acceptance for the test." }]);
  const synthetic = await h.gateway.run(request(accepted, { scope: "eval", data: "synthetic" }));
  assert.deepEqual([synthetic.status, synthetic.runClass, synthetic.riskAcceptance], ["ok", "synthetic", null]);
  assert.deepEqual(
    ledger(h, "gateway-usage-eval.jsonl").map((record) => [record.runClass, record.riskAcceptance?.ref ?? null]),
    [["eval_history", "ai.openai.chatgpt-consumer"], ["eval_history", "ai.openai.chatgpt-consumer"], ["synthetic", null], ["synthetic", null]],
  );
  // The acceptance never reaches live or shadow runs on that ref.
  for (const scope of ["production", "shadow"] as const) {
    const business = harness(t, { config: accepted });
    assert.equal(abstained(await business.gateway.run(request(accepted, { scope }))).reason, "provider_disabled", scope);
    assert.equal(business.adapters.codex.calls.length, 0, scope);
  }
  // The Claude consumer ref has no acceptance, so its eval_history run is refused.
  const judged = abstained(await h.gateway.run(request(accepted, { scope: "eval", specialist: "eval_judge", tier: "audit", reviewOf: { runId: "case_02:1", family: "openai" } })));
  assert.deepEqual([judged.reason, judged.routeId, judged.complianceRef], ["provider_disabled", "judge.default", "ai.anthropic.claude-consumer"]);
});

test("the ChatGPT commercial ref waits for the owner's confirmed retention before live and shadow runs, and an account with no ref serves nothing", async (t) => {
  const shipped = () => parseGatewayConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  for (const scope of ["production", "shadow"] as const) {
    const config = shipped();
    const h = harness(t, { config });
    const result = abstained(await h.gateway.run(request(config, { scope })));
    assert.equal(result.reason, "provider_disabled");
    assert.match(result.detail, /codex is on ai\.openai\.chatgpt-commercial, which serves (live|shadow) runs only after the owner's confirmed_retention is recorded/);
  }
  // Eval and synthetic runs on it need no confirmation.
  const config = shipped();
  const evaluation = harness(t, { config, qualification: qualification() });
  evaluation.adapters.codex.steps.push(outcome());
  assert.equal((await evaluation.gateway.run(request(config, { scope: "eval" }))).status, "ok");
  const synthetic = harness(t, { config, dataClass: "synthetic" });
  synthetic.adapters.codex.steps.push(outcome());
  assert.deepEqual([(await synthetic.gateway.run(request(config))).runClass], ["synthetic"]);
  // An account with no ref serves no run class at all.
  const unlabelled = shipped();
  unlabelled.providers.codex.complianceRef = null;
  for (const [options, overrides] of [[{}, {}], [{ dataClass: "synthetic" as const }, {}], [{ qualification: qualification() }, { scope: "eval" as const, data: "synthetic" as const }]] as const) {
    const h = harness(t, { config: unlabelled, ...options });
    const refused = abstained(await h.gateway.run(request(unlabelled, overrides)));
    assert.deepEqual([refused.reason, refused.complianceRef], ["provider_disabled", null]);
    assert.match(refused.detail, /codex names no compliance_ref, so it serves no run/);
    assert.equal(h.adapters.codex.calls.length, 0);
  }
  // A ref the register does not hold, prototype names included, serves nothing either.
  for (const name of ["ai.openai.enterprise", "toString", "__proto__"]) {
    const unknown = shipped();
    unknown.providers.codex.complianceRef = name;
    const h = harness(t, { config: unknown, dataClass: "synthetic" });
    assert.equal(abstained(await h.gateway.run(request(unknown))).reason, "provider_disabled", name);
  }
});

test("a hop must fit the run, and a live run takes only checked registry figures", async (t) => {
  const config = liveConfig();
  const sol = config.providers.codex.models["gpt-6.1-sol"];
  const tools = { server: { command: "node", args: ["tool-server.mjs"], env: {}, passEnv: [] }, allowed: ["lead_qualify"] };
  sol.tools = false;
  const noTools = harness(t, { config });
  const refused = abstained(await noTools.gateway.run(request(config, { tools })));
  assert.deepEqual([refused.reason, hops(refused)], ["no_qualified_route", [["codex_sol", "no_qualified_route"]]]);
  assert.match(refused.detail, /codex\/gpt-6\.1-sol does not fit the run: the run has tools and the model takes none/);
  sol.tools = true;
  sol.contextTokens = 128_100;
  const big = harness(t, { config });
  assert.match(abstained(await big.gateway.run(request(config, { prompt: "x".repeat(600) }))).detail, /exceed its 128100-token context window/);
  sol.contextTokens = 1_050_000;
  sol.rateLimits = { requestsPerMinute: null, inputTokensPerMinute: 10, outputTokensPerMinute: null };
  const perMinute = harness(t, { config });
  assert.match(abstained(await perMinute.gateway.run(request(config))).detail, /input tokens exceed its limit of 10 input tokens per minute/);
  sol.rateLimits = { requestsPerMinute: null, inputTokensPerMinute: null, outputTokensPerMinute: null };
  sol.unverified = ["context_tokens"];
  const live = harness(t, { config });
  assert.match(abstained(await live.gateway.run(request(config))).detail, /registry figures not checked against provider docs \(context_tokens\); live runs take checked figures only/);
  for (const options of [{ dataClass: "synthetic" as const }, {}]) {
    const h = harness(t, { config, ...options });
    h.adapters.codex.steps.push(outcome());
    const scope = "dataClass" in options ? "production" : "shadow";
    assert.equal((await h.gateway.run(request(config, { scope }))).status, "ok", scope);
  }
  assert.equal(noTools.adapters.codex.calls.length + big.adapters.codex.calls.length + live.adapters.codex.calls.length, 0);
});

test("a full per-minute window abstains rate_limited until its oldest call leaves it, without a call or a booking", async (t) => {
  const config = liveConfig();
  const sol = config.providers.codex.models["gpt-6.1-sol"];
  sol.rateLimits = { requestsPerMinute: 1, inputTokensPerMinute: null, outputTokensPerMinute: null };
  const h = harness(t, { config });
  h.adapters.codex.steps.push(outcome(), outcome());
  const first = h.clock.now;
  assert.equal((await h.gateway.run(request(config))).status, "ok");
  const full = abstained(await h.gateway.run(request(config)));
  assert.deepEqual([full.reason, full.retryAt], ["rate_limited", first + 60_000]);
  assert.equal(ledger(h).length, 2);
  h.clock.now = first + 60_000;
  assert.equal((await h.gateway.run(request(config))).status, "ok");
  // Output tokens count toward their own limit.
  sol.rateLimits = { requestsPerMinute: null, inputTokensPerMinute: null, outputTokensPerMinute: 100 };
  const output = harness(t, { config });
  output.adapters.codex.steps.push(outcome());
  await output.gateway.run(request(config));
  assert.equal(abstained(await output.gateway.run(request(config))).reason, "rate_limited");
  assert.equal(output.adapters.codex.calls.length, 1);
});

test("a run may use only the providers it names, as for a Worker that records legacy provider ids", async (t) => {
  const config = chained();
  const h = harness(t, { config });
  h.adapters.codex.steps.push(longLimit());
  const result = abstained(await h.gateway.run(request(config, { providers: ["claude", "codex"] })));
  assert.deepEqual(hops(result), [["codex_sol", "rate_limited"], ["backup_sol", "provider_disabled"]]);
  assert.equal(h.adapters.codex_backup.calls.length, 0);
});

test("a model with no USD figure books tokens, not dollars, and stops at its token ceiling", async (t) => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  raw.providers.codex.confirmed_retention = RETENTION;
  raw.providers.codex.models["gpt-6.1-sol"].price.list_usd_per_mtok = null;
  const { ceilings } = raw;
  for (const team of [ceilings.team, ceilings.shadow.team]) team.tokens = 1_000_000;
  for (const own of [ceilings.specialist_default, ceilings.shadow.specialist, ...Object.values(ceilings.specialists)] as Array<Record<string, number>>) {
    own.tokens = 3_000;
    own.tokens_per_call = 2_000;
  }
  const config = parseGatewayConfig(raw);
  const h = harness(t, { config });
  h.adapters.codex.steps.push({ ...outcome(), costUsd: 0 });
  const first = h.clock.now;
  assert.equal((await h.gateway.run(request(config))).status, "ok");
  assert.deepEqual(ledger(h).map((record) => [record.calls, record.costUsd, record.tokens]), [[1, 0, 2000], [0, 0, -900]]);
  const full = abstained(await h.gateway.run(request(config)));
  assert.deepEqual([full.reason, full.retryAt], ["cost_ceiling", first + config.ceilings.windowHours * 3_600_000 + 1]);
  assert.match(full.detail, /^lead_concierge reached its token ceiling/);
  assert.equal(h.adapters.codex.calls.length, 1);
});

test("health reports every configured provider account", async (t) => {
  const config = chained();
  const h = harness(t, { config });
  h.adapters.codex_backup.credentialState = { fingerprint: null };
  const health = await h.gateway.health();
  assert.deepEqual(Object.keys(health.providers).sort(), ["claude", "codex", "codex_backup"]);
  assert.deepEqual([health.providers.codex_backup.state, health.ready, health.alerts], ["credential_missing", false, ["codex_backup_credential_missing"]]);
});

test("the rate window holds across concurrent runs and retries: it is checked and entered on every attempt with no await between", async (t) => {
  const config = liveConfig();
  config.providers.codex.models["gpt-6.1-sol"].rateLimits = { requestsPerMinute: 1, inputTokensPerMinute: null, outputTokensPerMinute: null };
  const h = harness(t, { config });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.adapters.codex.steps.push(async () => {
    await gate;
    return outcome();
  });
  const runs = [1, 2, 3, 4].map(() => h.gateway.run(request(config)));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(runs);
  assert.deepEqual(results.map((result) => (result.status === "ok" ? "ok" : result.reason)).sort(), ["ok", "rate_limited", "rate_limited", "rate_limited"]);
  assert.equal(h.adapters.codex.calls.length, 1);
  // A retry inside one hop meets the same window.
  const retried = harness(t, { config });
  retried.adapters.codex.steps.push(new ProviderError("transient", "overloaded"), outcome());
  const limited = abstained(await retried.gateway.run(request(config)));
  assert.deepEqual([limited.reason, limited.attempts, retried.adapters.codex.calls.length], ["rate_limited", 1, 1]);
});

test("the kill switch and a cancellation stop a run between attempts and hops, before the next hop books anything", async (t) => {
  const config = chained();
  const killed = harness(t, { config });
  killed.adapters.codex.steps.push(async () => {
    writeFileSync(join(killed.stateDir, "KILL"), "");
    throw longLimit();
  });
  const stopped = abstained(await killed.gateway.run(request(config)));
  assert.deepEqual([stopped.reason, hops(stopped)], ["kill_switch", [["codex_sol", "rate_limited"], ["backup_sol", "kill_switch"]]]);
  assert.equal(killed.adapters.codex_backup.calls.length, 0);
  assert.equal(ledger(killed).filter((record) => record.routeId === "backup_sol").length, 0);
  // A cancellation that lands while the fallback is screened (its credential is read) stops the
  // run before that hop books anything.
  const cancel = new AbortController();
  const aborted = harness(t, { config });
  aborted.adapters.codex.steps.push(longLimit());
  const backup = aborted.adapters.codex_backup;
  const signedIn = backup.credentialState;
  backup.credential = async () => {
    cancel.abort();
    return signedIn;
  };
  const ended = abstained(await aborted.gateway.run(request(config, { signal: cancel.signal })));
  assert.equal(ended.reason, "aborted");
  assert.deepEqual([aborted.adapters.codex_backup.calls.length, ledger(aborted).filter((record) => record.routeId === "backup_sol").length], [0, 0]);
});

test("live and shadow runs on the ChatGPT commercial ref need the sign-in to claim a plan; synthetic runs do not", async (t) => {
  const config = liveConfig();
  for (const scope of ["production", "shadow"] as const) {
    const h = harness(t, { config });
    h.adapters.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: h.clock.now };
    const refused = abstained(await h.gateway.run(request(config, { scope })));
    assert.equal(refused.reason, "provider_disabled", scope);
    assert.match(refused.detail, /codex's ChatGPT sign-in claims no plan, so it cannot show the business workspace ai\.openai\.chatgpt-commercial needs/);
    assert.equal(h.adapters.codex.calls.length, 0, scope);
  }
  const synthetic = harness(t, { config, dataClass: "synthetic" });
  synthetic.adapters.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: synthetic.clock.now };
  synthetic.adapters.codex.steps.push(outcome());
  assert.equal((await synthetic.gateway.run(request(config))).status, "ok");
});
