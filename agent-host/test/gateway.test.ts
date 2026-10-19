import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ProviderGateway } from "../src/gateway/gateway.ts";
import { parseGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import { ProviderError, type GatewayRequest, type GatewayResult } from "../src/gateway/types.ts";
import { CONFIG_PATH, OUTPUT_SCHEMA, RELEASE, fakeAdapter, liveConfig, outcome, qualification, qualifications, shippedConfig, tempDir, type FakeAdapter } from "./helpers.ts";

// A live run of a specialist the Worker qualified on every shipped route at RELEASE.
const request = (overrides: Partial<GatewayRequest> = {}): GatewayRequest => ({
  specialist: "lead_concierge",
  tier: "routine",
  release: RELEASE,
  qualifications: qualifications(),
  system: "You are the lead concierge.",
  prompt: "<data>synthetic signal</data>",
  outputSchema: OUTPUT_SCHEMA,
  ...overrides,
});

interface Harness {
  gateway: ProviderGateway;
  claude: FakeAdapter;
  codex: FakeAdapter;
  stateDir: string;
  sleeps: number[];
  clock: { now: number };
  env: Record<string, string | undefined>;
}

function harness(t: TestContext, options: { config?: GatewayConfig; stateDir?: string; qualification?: { ledger: unknown; judge: unknown } } = {}): Harness {
  const stateDir = options.stateDir ?? tempDir(t);
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const sleeps: number[] = [];
  const clock = { now: 1_000_000_000_000 };
  // A ChatGPT business workspace sign-in claims its plan.
  codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: clock.now, plan: "business" };
  const env: Record<string, string | undefined> = {};
  const gateway = new ProviderGateway({
    config: options.config ?? liveConfig(),
    stateDir,
    env,
    adapters: { claude, codex },
    ...(options.qualification ? { qualification: options.qualification } : {}),
    now: () => clock.now,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { gateway, claude, codex, stateDir, sleeps, clock, env };
}

function abstained(result: GatewayResult) {
  assert.equal(result.status, "abstained", JSON.stringify(result));
  return result as Extract<GatewayResult, { status: "abstained" }>;
}

test("a routine run goes to Codex on the configured model and returns validated output with hashes", async (t) => {
  const h = harness(t);
  h.codex.steps.push(outcome());
  const result = await h.gateway.run(request());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" && result.output, { decision: "propose", note: null });
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-6.1-sol");
  assert.equal(result.authMode, "oauth");
  assert.equal(result.attempts, 1);
  assert.equal(result.costUsd, 0.25);
  assert.match(result.hashes.prompt, /^[0-9a-f]{64}$/);
  assert.equal(h.codex.calls[0].effort, "medium");
  assert.equal(h.codex.calls[0].maxCostUsd, 3);
  assert.equal((h.codex.calls[0].outputSchema.properties as Record<string, Record<string, unknown>>).note.maxLength, undefined);
  assert.equal(h.claude.calls.length, 0);
  const ledger = readFileSync(join(h.stateDir, "gateway-usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    ledger.map((record) => [record.specialist, record.outcome, record.calls, record.costUsd]),
    [["lead_concierge", "reserved", 1, 3], ["lead_concierge", "ok", 0, -2.75]],
  );
});

test("hard reasoning goes to Astra and the auditor goes to Claude", async (t) => {
  const h = harness(t);
  h.codex.steps.push(outcome());
  h.claude.steps.push(outcome());
  assert.equal((await h.gateway.run(request({ specialist: "billing_reconciliation", tier: "hard" }))).model, "gpt-6-astra");
  const audit = await h.gateway.run(request({ specialist: "independent_auditor", tier: "audit" }));
  assert.equal(audit.provider, "claude");
  assert.equal(audit.model, "claude-opus-5-5");
});

test("the kill switch stops every run before any provider call", async (t) => {
  const file = harness(t);
  writeFileSync(join(file.stateDir, "KILL"), "");
  assert.equal(abstained(await file.gateway.run(request())).reason, "kill_switch");
  const env = harness(t);
  env.env.AGENT_HOST_KILL = "1";
  assert.equal(abstained(await env.gateway.run(request())).reason, "kill_switch");
  assert.equal(file.codex.calls.length + env.codex.calls.length, 0);
  assert.deepEqual((await file.gateway.health()).alerts, ["kill_switch_engaged"]);
});

test("unregistered specialists and borrowed tiers abstain", async (t) => {
  const h = harness(t);
  assert.equal(abstained(await h.gateway.run(request({ specialist: "ghost" }))).reason, "unknown_specialist");
  assert.equal(abstained(await h.gateway.run(request({ tier: "audit" }))).reason, "tier_not_allowed");
  assert.equal(abstained(await h.gateway.run(request({ specialist: "independent_auditor" }))).reason, "tier_not_allowed");
  assert.equal(h.codex.calls.length + h.claude.calls.length, 0);
});

test("a disabled or signed-out provider makes its specialists abstain with no fallback", async (t) => {
  const config = liveConfig();
  config.providers.codex.enabled = false;
  const disabled = harness(t, { config });
  assert.equal(abstained(await disabled.gateway.run(request())).reason, "provider_disabled");
  const signedOut = harness(t);
  signedOut.codex.credentialState = { fingerprint: null };
  const result = abstained(await signedOut.gateway.run(request()));
  assert.equal(result.reason, "credential_missing");
  assert.equal(result.provider, "codex");
  assert.equal(disabled.claude.calls.length + signedOut.claude.calls.length + signedOut.codex.calls.length, 0);
});

test("a short rate limit is retried with backoff and the run succeeds", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("rate_limit", "429"), new ProviderError("transient", "overloaded"), outcome());
  const result = await h.gateway.run(request());
  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 3);
  assert.deepEqual(h.sleeps, [1500, 3000]);
});

test("a long rate limit cools the provider down and later runs abstain without calling it", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("rate_limit", "usage limit reached", { retryAfterMs: 3_600_000 }));
  const first = abstained(await h.gateway.run(request()));
  assert.equal(first.reason, "rate_limited");
  assert.equal(first.retryAt, h.clock.now + 3_600_000);
  const second = abstained(await h.gateway.run(request({ specialist: "estimator" })));
  assert.equal(second.reason, "rate_limited");
  assert.equal(h.codex.calls.length, 1);
  const health = await h.gateway.health();
  assert.equal(health.ready, false);
  assert.equal(health.providers.codex.state, "cooldown");
  assert.ok(health.alerts.includes("codex_cooldown"));
  h.clock.now += 3_600_001;
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request())).status, "ok");
});

test("transient failures stop after the configured attempts", async (t) => {
  const h = harness(t);
  h.codex.steps.push(...[1, 2, 3].map(() => new ProviderError("transient", "socket hang up")));
  const result = abstained(await h.gateway.run(request()));
  assert.equal(result.reason, "provider_error");
  assert.equal(result.attempts, 3);
});

test("a rejected sign-in is not retried until the credential changes", async (t) => {
  const h = harness(t);
  h.claude.steps.push(new ProviderError("auth", "authentication_failed"));
  const audit = request({ specialist: "independent_auditor", tier: "audit" });
  assert.equal(abstained(await h.gateway.run(audit)).reason, "auth_failed");
  assert.equal(abstained(await h.gateway.run(audit)).reason, "auth_failed");
  assert.equal(h.claude.calls.length, 1);
  assert.ok((await h.gateway.health()).alerts.includes("claude_auth_failed"));
  h.claude.credentialState = { fingerprint: "claude-credential-2" };
  h.claude.steps.push(outcome());
  assert.equal((await h.gateway.run(audit)).status, "ok");
  assert.equal((await h.gateway.health()).providers.claude.state, "ready");
});

test("a credential refreshed during the run is retried once immediately", async (t) => {
  const h = harness(t);
  h.codex.steps.push(async () => {
    h.codex.credentialState = { fingerprint: "codex-credential-2" };
    throw new ProviderError("auth", "401 token expired");
  }, outcome());
  const result = await h.gateway.run(request());
  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  assert.deepEqual(h.sleeps, []);
});

test("output with an unknown field abstains even though the provider returned it", async (t) => {
  const h = harness(t);
  h.codex.steps.push(outcome({ decision: "propose", note: null, send_now: true }));
  const result = abstained(await h.gateway.run(request()));
  assert.equal(result.reason, "invalid_output");
  assert.match(result.detail, /unknown field send_now/);
});

test("a provider that answers with another model abstains instead of passing it off", async (t) => {
  const h = harness(t);
  const audit = request({ specialist: "independent_auditor", tier: "audit" });
  h.claude.steps.push({ ...outcome(), modelsUsed: ["claude-sonnet-5-5"] });
  const result = abstained(await h.gateway.run(audit));
  assert.equal(result.reason, "model_mismatch");
  assert.deepEqual(result.modelsUsed, ["claude-sonnet-5-5"]);
  h.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-5[1m]"] });
  assert.equal((await h.gateway.run(audit)).status, "ok");
});

test("call ceilings hold across a restart", async (t) => {
  const config = liveConfig();
  config.ceilings.specialists.estimator = { calls: 2, costUsd: 30, costUsdPerCall: 3 };
  const first = harness(t, { config });
  first.codex.steps.push(outcome(), outcome());
  await first.gateway.run(request({ specialist: "estimator" }));
  await first.gateway.run(request({ specialist: "estimator" }));
  const restarted = harness(t, { config, stateDir: first.stateDir });
  assert.equal(abstained(await restarted.gateway.run(request({ specialist: "estimator" }))).reason, "call_ceiling");
  restarted.codex.steps.push(outcome());
  assert.equal((await restarted.gateway.run(request({ specialist: "lead_concierge" }))).status, "ok");
  assert.equal(restarted.codex.calls.length, 1);
});

test("cost ceilings reserve the per-call ceiling so concurrent runs cannot overshoot", async (t) => {
  const config = liveConfig();
  config.ceilings.specialists.estimator = { calls: 100, costUsd: 6, costUsdPerCall: 3 };
  const h = harness(t, { config });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = async () => {
    await gate;
    return outcome();
  };
  h.codex.steps.push(held, held);
  const runs = [h.gateway.run(request({ specialist: "estimator" })), h.gateway.run(request({ specialist: "estimator" }))];
  const third = abstained(await h.gateway.run(request({ specialist: "estimator" })));
  assert.equal(third.reason, "cost_ceiling");
  release();
  assert.deepEqual((await Promise.all(runs)).map((r) => r.status), ["ok", "ok"]);
  assert.equal((await h.gateway.health()).usage.specialists.estimator.costUsd, 0.5);
});

test("a provider-side budget stop is reported as a cost ceiling", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("budget", "per-call ceiling", { costUsd: 3 }));
  const result = abstained(await h.gateway.run(request()));
  assert.equal(result.reason, "cost_ceiling");
  assert.equal(result.costUsd, 3);
});

test("cancelling a run abstains as aborted", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  h.codex.steps.push(async () => {
    controller.abort();
    throw new ProviderError("transient", "interrupted");
  });
  assert.equal(abstained(await h.gateway.run(request({ signal: controller.signal }))).reason, "aborted");
});

test("health raises an alert when the Codex sign-in stops refreshing", async (t) => {
  const h = harness(t);
  h.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: h.clock.now - 10 * 24 * 3_600_000 };
  const stale = await h.gateway.health();
  assert.equal(stale.providers.codex.signinStale, true);
  assert.deepEqual(stale.alerts, ["codex_signin_not_refreshing"]);
  h.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: h.clock.now - 3_600_000 };
  const fresh = await h.gateway.health();
  assert.deepEqual(fresh.alerts, []);
  assert.equal(fresh.ready, true);
});

test("abstention details never carry credential-shaped text", async (t) => {
  const h = harness(t);
  const leaked = ["Bearer", "abc.def", ["sk", "proj", "0123456789abcdef"].join("-"), "x".repeat(60)].join(" ");
  h.codex.steps.push(new ProviderError("fatal", `bad request ${leaked}`));
  const result = abstained(await h.gateway.run(request()));
  assert.doesNotMatch(result.detail, /abc\.def|proj-0123|xxxxxxxxxx/);
});

test("a caller schema outside the strict subset is a programming error", async (t) => {
  const h = harness(t);
  await assert.rejects(h.gateway.run(request({ outputSchema: { type: "object" } })), /additionalProperties/);
});

test("exhausted attempts with a rotated credential mark only the credential that was tried", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("transient", "overloaded"), new ProviderError("transient", "overloaded"), async () => {
    h.codex.credentialState = { fingerprint: "codex-credential-2", refreshedAt: h.clock.now, plan: "business" };
    throw new ProviderError("auth", "401 token expired");
  });
  assert.equal(abstained(await h.gateway.run(request())).reason, "auth_failed");
  assert.equal((await h.gateway.health()).providers.codex.state, "ready");
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request())).status, "ok");
});

test("a rejected credential is probed again once the probe interval passes", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("auth", "billing_error"));
  assert.equal(abstained(await h.gateway.run(request())).reason, "auth_failed");
  assert.equal(abstained(await h.gateway.run(request())).reason, "auth_failed");
  assert.equal(h.codex.calls.length, 1);
  h.clock.now += 900_000;
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request())).status, "ok");
  assert.equal(h.codex.calls.length, 2);
});

test("a ledger that cannot be written stops spending instead of throwing or double counting", async (t) => {
  const h = harness(t);
  h.codex.steps.push(async () => {
    rmSync(join(h.stateDir, "gateway-usage.jsonl"), { force: true });
    mkdirSync(join(h.stateDir, "gateway-usage.jsonl"));
    return outcome();
  });
  const first = await h.gateway.run(request());
  assert.equal(first.status, "ok");
  const health = await h.gateway.health();
  assert.equal(health.usage.teams.live.calls, 1);
  assert.equal(health.usage.teams.live.costUsd, 0.25);
  assert.ok(health.alerts.includes("ledger_unavailable"));
  assert.equal(health.ready, false);
  assert.equal(abstained(await h.gateway.run(request())).reason, "ledger_unavailable");
  assert.equal(h.codex.calls.length, 1);
});

test("a crash between reservation and settlement keeps the reservation counted", async (t) => {
  const config = liveConfig();
  config.ceilings.specialists.estimator = { calls: 100, costUsd: 6, costUsdPerCall: 3 };
  const crashed = harness(t, { config });
  const hang = new AbortController();
  crashed.codex.steps.push((call) => new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("killed")))));
  const inFlight = crashed.gateway.run(request({ specialist: "estimator", signal: hang.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = harness(t, { config, stateDir: crashed.stateDir });
  assert.deepEqual((await restarted.gateway.health()).usage.specialists.estimator, { calls: 1, costUsd: 3 });
  restarted.codex.steps.push(outcome());
  assert.equal((await restarted.gateway.run(request({ specialist: "estimator" }))).status, "ok");
  assert.equal(abstained(await restarted.gateway.run(request({ specialist: "estimator" }))).reason, "cost_ceiling");
  hang.abort();
  await inFlight;
});

test("any model other than the configured one, including a refusal fallback, abstains", async (t) => {
  const h = harness(t);
  const audit = request({ specialist: "independent_auditor", tier: "audit" });
  h.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-5", "claude-opus-5"] });
  assert.equal(abstained(await h.gateway.run(audit)).reason, "model_mismatch");
  const config = liveConfig();
  config.providers.claude.models["claude-opus-5"] = config.providers.claude.models["claude-opus-5-5"];
  config.routes.claude_opus.model = "claude-opus-5";
  const shorter = harness(t, { config });
  const qualified = { ...audit, qualifications: qualifications(config) };
  shorter.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-5"] });
  assert.equal(abstained(await shorter.gateway.run(qualified)).reason, "model_mismatch");
  shorter.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-20260901"] });
  assert.equal((await shorter.gateway.run(qualified)).status, "ok");
  shorter.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-2026-09-01"] });
  assert.equal((await shorter.gateway.run(qualified)).status, "ok");
});

test("an unknown tier is a programming error", async (t) => {
  const h = harness(t);
  await assert.rejects(h.gateway.run(request({ tier: "constructor" as never })), /unknown tier/);
});

test("health keeps reporting a dead credential and the probe after the interval is a single call", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("auth", "401 Unauthorized"));
  await h.gateway.run(request());
  h.clock.now += 900_000;
  assert.equal((await h.gateway.health()).providers.codex.state, "auth_failed");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.codex.steps.push(async () => {
    await gate;
    throw new ProviderError("auth", "401 Unauthorized");
  });
  const probe = h.gateway.run(request());
  const others = await Promise.all([1, 2, 3].map(() => h.gateway.run(request())));
  assert.deepEqual(others.map((r) => abstained(r).reason), ["auth_failed", "auth_failed", "auth_failed"]);
  release();
  assert.equal(abstained(await probe).reason, "auth_failed");
  assert.equal(h.codex.calls.length, 2);
});

test("an unusable cost figure is booked at the full reservation", async (t) => {
  const h = harness(t);
  h.codex.steps.push({ ...outcome(), costUsd: Number.NaN });
  assert.equal((await h.gateway.run(request())).status, "ok");
  assert.deepEqual((await h.gateway.health()).usage.teams.live, { calls: 1, costUsd: 3 });
});

test("a ledger record that cannot be counted stops spending after a restart", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.stateDir, "gateway-usage.jsonl"), `${JSON.stringify({ at: h.clock.now, specialist: "estimator", costUsd: "x" })}\n`);
  const restarted = harness(t, { stateDir: h.stateDir });
  assert.equal(abstained(await restarted.gateway.run(request())).reason, "ledger_unavailable");
  assert.equal(restarted.codex.calls.length, 0);
});

test("a plan that does not include the model abstains actionably and keeps the provider not ready until the sign-in changes", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("plan", "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it"));
  const first = abstained(await h.gateway.run(request()));
  assert.equal(first.reason, "provider_error");
  assert.match(first.detail, /^codex: plan does not include model gpt-6\.1-sol;/);
  // The same sign-in is not spent again on the refused model.
  const second = abstained(await h.gateway.run(request()));
  assert.match(second.detail, /plan does not include model gpt-6\.1-sol; the provider refused it for this sign-in/);
  assert.equal(h.codex.calls.length, 1);
  const health = await h.gateway.health();
  assert.equal(health.ready, false);
  assert.equal(health.providers.codex.state, "plan_lacks_model");
  assert.ok(health.alerts.includes("codex_plan_lacks_model"), JSON.stringify(health.alerts));
  // A new sign-in (auth.json changed) clears it.
  h.codex.credentialState = { fingerprint: "codex-credential-2", refreshedAt: h.clock.now, plan: "business" };
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request())).status, "ok");
  assert.equal((await h.gateway.health()).ready, true);
});

test("a sign-in claiming a plan outside the configured plans is not ready and is not spent", async (t) => {
  const h = harness(t);
  h.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: h.clock.now, plan: "free" };
  const health = await h.gateway.health();
  assert.equal(health.ready, false);
  assert.equal(health.providers.codex.plan, "free");
  assert.deepEqual(health.alerts, ["codex_plan_lacks_model"]);
  const result = abstained(await h.gateway.run(request({ tier: "hard" })));
  assert.match(result.detail, /^codex: plan does not include model gpt-6-astra; the sign-in is on the free plan, configured plans are business, enterprise, team;/);
  assert.equal(h.codex.calls.length, 0);
  // The auditor's Claude route is unaffected.
  h.claude.steps.push(outcome());
  assert.equal((await h.gateway.run(request({ specialist: "independent_auditor", tier: "audit" }))).status, "ok");
});

test("a plan refusal latches only the refused model, and one probe per interval can lift it", async (t) => {
  const h = harness(t);
  const refusal = () => new ProviderError("plan", "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it");
  h.codex.steps.push(refusal());
  abstained(await h.gateway.run(request()));
  // The hard tier's model was not refused and still runs on the same sign-in.
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request({ tier: "hard" }))).status, "ok");
  assert.equal(h.codex.calls.length, 2);
  // Within the probe interval the refused model is not called again.
  abstained(await h.gateway.run(request()));
  assert.equal(h.codex.calls.length, 2);
  // Past it, exactly one run probes; a plan upgraded on the provider side then answers.
  h.clock.now += shippedConfig().retry.authProbeAfterMs;
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request())).status, "ok");
  assert.equal(h.codex.calls.length, 3);
  const health = await h.gateway.health();
  assert.equal(health.providers.codex.state, "ready");
  assert.equal(health.ready, true);
});

test("a plan refusal after an auth rejection reports the plan, not a dead credential", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("auth", "401 unauthorized"));
  assert.equal(abstained(await h.gateway.run(request())).reason, "auth_failed");
  h.clock.now += shippedConfig().retry.authProbeAfterMs;
  h.codex.steps.push(new ProviderError("plan", "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it"));
  abstained(await h.gateway.run(request()));
  const next = abstained(await h.gateway.run(request()));
  assert.equal(next.reason, "provider_error");
  assert.match(next.detail, /plan does not include model/);
  assert.equal((await h.gateway.health()).providers.codex.state, "plan_lacks_model");
});

test("past the probe interval concurrent runs make exactly one probe of a refused model", async (t) => {
  const h = harness(t);
  h.codex.steps.push(new ProviderError("plan", "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it"));
  abstained(await h.gateway.run(request()));
  h.clock.now += shippedConfig().retry.authProbeAfterMs;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.codex.steps.push(async () => {
    await gate;
    return outcome();
  });
  const runs = [h.gateway.run(request()), h.gateway.run(request()), h.gateway.run(request())];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(runs);
  assert.deepEqual(results.map((result) => result.status).sort(), ["abstained", "abstained", "ok"]);
  assert.equal(h.codex.calls.length, 2);
});

test("a credential rotated mid-run onto a plan outside the configured plans is not called", async (t) => {
  const h = harness(t);
  h.codex.steps.push(async () => {
    h.codex.credentialState = { fingerprint: "codex-credential-2", refreshedAt: h.clock.now, plan: "free" };
    throw new ProviderError("auth", "401 unauthorized");
  });
  const result = abstained(await h.gateway.run(request()));
  assert.match(result.detail, /^codex: plan does not include model gpt-6\.1-sol; the sign-in is on the free plan/);
  assert.equal(h.codex.calls.length, 1);
});

const programmingError = (pattern: RegExp) => (error: unknown) => error instanceof TypeError && pattern.test(error.message);
const ledgerRecords = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const audit = (family: string, runId = "run_0000000001") => request({ specialist: "independent_auditor", tier: "audit", reviewOf: { runId, family } });
const judging = (family: string) => {
  const { release: _release, qualifications: _qualifications, ...rest } = request({ scope: "eval", specialist: "eval_judge", tier: "audit", reviewOf: { runId: "case_01:1", family } });
  return rest;
};

test("a run takes its expected action's route, then its specialist's route, then its tier's", async (t) => {
  const config = liveConfig();
  config.specialists.estimator = { tiers: ["routine", "hard"], route: "codex_astra", actions: { "estimate.price": "claude_opus" } };
  const h = harness(t, { config });
  h.claude.steps.push(outcome());
  h.codex.steps.push(outcome(), outcome(), outcome());
  const priced = await h.gateway.run(request({ specialist: "estimator", action: "estimate.price" }));
  assert.deepEqual([priced.status, priced.routeId, priced.provider, priced.model], ["ok", "claude_opus", "claude", "claude-opus-5-5"]);
  assert.equal(h.claude.calls[0].effort, "high");
  const drafted = await h.gateway.run(request({ specialist: "estimator", action: "estimate.draft" }));
  assert.deepEqual([drafted.routeId, drafted.model], ["codex_astra", "gpt-6-astra"]);
  assert.equal((await h.gateway.run(request({ specialist: "estimator" }))).routeId, "codex_astra");
  const other = await h.gateway.run(request({ action: "estimate.price" }));
  assert.deepEqual([other.routeId, other.model], ["codex_sol", "gpt-6.1-sol"]);
  // A route never widens the tiers a specialist may use.
  assert.equal(abstained(await h.gateway.run(request({ specialist: "estimator", tier: "audit", action: "estimate.price" }))).reason, "tier_not_allowed");
  assert.equal(h.claude.calls.length, 1);
});

test("the auditor reviews a run on the other family's route, and runs on tiers.audit when it reviews none", async (t) => {
  const h = harness(t);
  h.claude.steps.push(outcome(), outcome());
  h.codex.steps.push(outcome());
  const ofCodex = await h.gateway.run(audit("openai", "run_0000000007"));
  assert.deepEqual([ofCodex.status, ofCodex.routeId, ofCodex.provider, ofCodex.family], ["ok", "claude_opus", "claude", "anthropic"]);
  assert.deepEqual(ofCodex.reviewOf, { runId: "run_0000000007", family: "openai" });
  const ofClaude = await h.gateway.run(audit("anthropic"));
  assert.deepEqual([ofClaude.status, ofClaude.routeId, ofClaude.provider, ofClaude.model], ["ok", "codex_astra", "codex", "gpt-6-astra"]);
  assert.equal(h.codex.calls[0].effort, "high");
  const unreviewed = await h.gateway.run(request({ specialist: "independent_auditor", tier: "audit" }));
  assert.deepEqual([unreviewed.routeId, unreviewed.provider, unreviewed.reviewOf], ["claude_opus", "claude", null]);
});

test("an audit with no route of another family abstains before any provider call or booking", async (t) => {
  const config = liveConfig();
  // Valid: no proposer runs on Claude, so the configuration needs no anthropic audit route.
  delete config.auditRoutes.anthropic;
  const h = harness(t, { config });
  const missing = abstained(await h.gateway.run(audit("anthropic", "run_0000000003")));
  assert.equal(missing.reason, "no_independent_route");
  assert.match(missing.detail, /no route of another family than anthropic may review run run_0000000003/);
  assert.deepEqual([missing.routeId, missing.provider, missing.model, missing.authMode, missing.retryAt], [null, null, null, null, undefined]);
  assert.deepEqual(missing.reviewOf, { runId: "run_0000000003", family: "anthropic" });
  // Checked per hop too: an audit route of the reviewed family that got past the configuration.
  config.auditRoutes.openai = "codex_astra";
  const same = abstained(await h.gateway.run(audit("openai")));
  assert.deepEqual([same.reason, same.routeId, same.failover.map((hop) => [hop.routeId, hop.reason])], ["no_independent_route", null, [["codex_astra", "no_independent_route"]]]);
  // A family the registry does not hold has no reviewer, and the v2 provider ids are no families.
  for (const family of ["google", "claude", "codex"]) assert.equal(abstained(await h.gateway.run(audit(family))).reason, "no_independent_route", family);
  assert.equal(h.claude.calls.length + h.codex.calls.length, 0);
  assert.equal(existsSync(join(h.stateDir, "gateway-usage.jsonl")), false);
});

test("requests for the wrong books, and eval-only fields outside eval, are programming errors", async (t) => {
  const production = harness(t);
  const batch = { routine: { provider: "claude", model: "claude-opus-5-5", effort: "high" } } as const;
  await assert.rejects(production.gateway.run(request({ scope: "eval" })), programmingError(/needs an eval gateway/));
  await assert.rejects(production.gateway.run(request({ scope: "staging" as never })), programmingError(/unknown scope staging/));
  await assert.rejects(production.gateway.run(request({ tierRoutes: batch })), programmingError(/tierRoutes is for eval requests only/));
  await assert.rejects(production.gateway.run(request({ scope: "shadow", tierRoutes: batch })), programmingError(/tierRoutes is for eval requests only/));
  const evaluation = harness(t, { qualification: qualification() });
  await assert.rejects(evaluation.gateway.run(request()), programmingError(/serves only eval requests, not production/));
  await assert.rejects(evaluation.gateway.run(request({ scope: "shadow" })), programmingError(/not shadow/));
  await assert.rejects(evaluation.gateway.run(request({ scope: "eval", specialist: "eval_judge" })), programmingError(/names the run it scores in reviewOf/));
  await assert.rejects(
    evaluation.gateway.run(request({ scope: "eval", tierRoutes: { audit: batch.routine } as never })),
    programmingError(/tierRoutes\.audit: only the routine and hard tiers/),
  );
  await assert.rejects(
    evaluation.gateway.run(request({ scope: "eval", tierRoutes: { routine: { provider: "codex", model: "gpt-7", effort: "high" } } })),
    programmingError(/tierRoutes\.routine\.model has no registry entry in \$\.providers\.codex\.models/),
  );
  await assert.rejects(production.gateway.run(request({ data: "synthetic" })), programmingError(/data is for eval requests only/));
  await assert.rejects(evaluation.gateway.run(request({ scope: "eval", data: "real" as never })), programmingError(/unknown eval data real/));
  await assert.rejects(
    evaluation.gateway.run(request({ scope: "eval", tierRoutes: { hard: { ...batch.routine, fallback: "x" } as never } })),
    programmingError(/tierRoutes\.hard\.fallback is not a known field/),
  );
  assert.throws(() => harness(t, { qualification: { ...qualification(), ledger: { ...qualification().ledger, isolated: false } } }), /isolated must be true/);
  assert.equal(production.codex.calls.length + production.claude.calls.length + evaluation.codex.calls.length + evaluation.claude.calls.length, 0);
});

test("an eval gateway books its runs in its own file under eval keys, against the qualification ceilings", async (t) => {
  const stateDir = tempDir(t);
  const block = qualification();
  block.ledger.specialist = { calls: 1, cost_usd: 6, cost_usd_per_call: 2 };
  const evaluation = harness(t, { stateDir, qualification: block });
  evaluation.codex.steps.push(outcome());
  const first = await evaluation.gateway.run(request({ scope: "eval" }));
  assert.deepEqual([first.status, first.routeId], ["ok", "codex_sol"]);
  assert.equal(evaluation.codex.calls[0].maxCostUsd, 2);
  const evalFile = join(stateDir, "gateway-usage-eval.jsonl");
  assert.deepEqual(ledgerRecords(evalFile).map((record) => [record.specialist, record.calls]), [["eval:lead_concierge", 1], ["eval:lead_concierge", 0]]);
  assert.equal(existsSync(join(stateDir, "gateway-usage.jsonl")), false);
  // The qualification ceiling holds, not the production one (lead_concierge has 600 calls there).
  const second = abstained(await evaluation.gateway.run(request({ scope: "eval" })));
  assert.equal(second.reason, "call_ceiling");
  assert.match(second.detail, /^eval:lead_concierge reached its call ceiling/);
  // Production on the same state directory neither sees eval spend nor writes the eval file.
  const before = readFileSync(evalFile, "utf8");
  const production = harness(t, { stateDir });
  production.codex.steps.push(outcome());
  assert.equal((await production.gateway.run(request())).status, "ok");
  const zero = { calls: 0, costUsd: 0 };
  assert.deepEqual((await production.gateway.health()).usage.teams, { live: { calls: 1, costUsd: 0.25 }, shadow: zero, eval: zero });
  assert.deepEqual((await evaluation.gateway.health()).usage.teams, { live: zero, shadow: zero, eval: { calls: 1, costUsd: 0.25 } });
  assert.equal(readFileSync(evalFile, "utf8"), before);
});

test("a judge runs on the judge route of the other family, books under its key and counts toward the eval team", async (t) => {
  const block = qualification();
  block.ledger.team = { calls: 2, cost_usd: 450 };
  const h = harness(t, { qualification: block });
  h.claude.steps.push(outcome());
  h.codex.steps.push(outcome());
  const ofCodex = await h.gateway.run(judging("openai"));
  assert.deepEqual([ofCodex.status, ofCodex.routeId, ofCodex.provider, ofCodex.model], ["ok", "judge.default", "claude", "claude-sonnet-5-5"]);
  assert.deepEqual([h.claude.calls[0].effort, h.claude.calls[0].maxCostUsd], ["medium", 1]);
  // A judge is no specialist, so no tier allowlist applies to it.
  const ofClaude = await h.gateway.run({ ...judging("anthropic"), tier: "routine" });
  assert.deepEqual([ofClaude.status, ofClaude.routeId, ofClaude.provider, ofClaude.model], ["ok", "judge.for_claude_proposers", "codex", "gpt-6.1-sol"]);
  assert.deepEqual([h.codex.calls[0].effort, h.codex.calls[0].maxCostUsd], ["high", 1]);
  assert.deepEqual([...new Set(ledgerRecords(join(h.stateDir, "gateway-usage-eval.jsonl")).map((record) => record.specialist))], ["eval:eval_judge"]);
  const third = abstained(await h.gateway.run(request({ scope: "eval" })));
  assert.equal(third.reason, "call_ceiling");
});

test("a judge route of the reviewed family abstains as no_independent_route", async (t) => {
  const block = qualification();
  block.judge.default = { provider: "codex", model: "gpt-6.1-sol", effort: "high" };
  const h = harness(t, { qualification: block });
  const same = abstained(await h.gateway.run(judging("openai")));
  assert.deepEqual([same.reason, same.routeId, same.provider], ["no_independent_route", null, null]);
  assert.equal(abstained(await h.gateway.run(judging("google"))).reason, "no_independent_route");
  assert.equal(h.codex.calls.length + h.claude.calls.length, 0);
});

test("an eval batch route replaces a proposing tier's route, ahead of action routes, and leaves the auditor alone", async (t) => {
  const config = liveConfig();
  config.specialists.estimator = { tiers: ["routine", "hard"], route: null, actions: { "estimate.price": "codex_astra" } };
  const h = harness(t, { config, qualification: qualification() });
  h.claude.steps.push(outcome(), outcome(), outcome());
  h.codex.steps.push(outcome());
  const batch = { routine: { provider: "claude", model: "claude-opus-5-5", effort: "high" } } as const;
  const compared = await h.gateway.run(request({ scope: "eval", specialist: "estimator", action: "estimate.price", tierRoutes: batch }));
  assert.deepEqual([compared.status, compared.routeId, compared.provider, compared.model], ["ok", "tier_routes.routine", "claude", "claude-opus-5-5"]);
  const hard = await h.gateway.run(request({ scope: "eval", tier: "hard", tierRoutes: batch }));
  assert.deepEqual([hard.routeId, hard.model], ["codex_astra", "gpt-6-astra"]);
  // The auditor keeps its production routing in an eval batch, independence included.
  const audited = await h.gateway.run({ ...audit("openai"), scope: "eval", tierRoutes: batch });
  assert.deepEqual([audited.routeId, audited.provider], ["claude_opus", "claude"]);
  const unreviewed = await h.gateway.run(request({ scope: "eval", specialist: "independent_auditor", tier: "audit", tierRoutes: batch }));
  assert.equal(unreviewed.routeId, "claude_opus");
});

test("shadow runs spend only the shadow budget and live runs only the live one", async (t) => {
  const config = liveConfig();
  // Different sizes, so a run held to the other namespace's ceiling shows.
  config.ceilings.specialists.estimator = { calls: 2, costUsd: 30, costUsdPerCall: 3 };
  config.ceilings.shadow.specialist = { calls: 1, costUsd: 3, costUsdPerCall: 0.5 };
  const h = harness(t, { config });
  h.codex.steps.push(outcome(), outcome(), outcome());
  assert.equal((await h.gateway.run(request({ specialist: "estimator", scope: "shadow" }))).status, "ok");
  assert.equal(h.codex.calls[0].maxCostUsd, 0.5);
  const shadowFull = abstained(await h.gateway.run(request({ specialist: "estimator", scope: "shadow" })));
  assert.equal(shadowFull.reason, "call_ceiling");
  assert.match(shadowFull.detail, /^shadow:estimator reached its call ceiling/);
  assert.equal((await h.gateway.run(request({ specialist: "estimator" }))).status, "ok");
  assert.equal(h.codex.calls[1].maxCostUsd, 3);
  assert.equal((await h.gateway.run(request({ specialist: "estimator" }))).status, "ok");
  assert.equal(abstained(await h.gateway.run(request({ specialist: "estimator" }))).reason, "call_ceiling");
  const usage = (await h.gateway.health()).usage;
  assert.deepEqual(usage.teams, { live: { calls: 2, costUsd: 0.5 }, shadow: { calls: 1, costUsd: 0.25 }, eval: { calls: 0, costUsd: 0 } });
  assert.deepEqual(Object.keys(usage.specialists).sort(), ["estimator", "shadow:estimator"]);
  assert.equal(h.codex.calls.length, 3);
});

test("team ceilings are kept per namespace in both directions", async (t) => {
  const config = liveConfig();
  config.ceilings.team = { calls: 2, costUsd: 300 };
  config.ceilings.shadow.team = { calls: 1, costUsd: 15 };
  const h = harness(t, { config });
  h.codex.steps.push(outcome(), outcome(), outcome());
  assert.equal((await h.gateway.run(request({ scope: "shadow" }))).status, "ok");
  assert.equal(abstained(await h.gateway.run(request({ specialist: "estimator", scope: "shadow" }))).reason, "call_ceiling");
  assert.equal((await h.gateway.run(request({ specialist: "estimator" }))).status, "ok");
  assert.equal((await h.gateway.run(request({ specialist: "market_analyst" }))).status, "ok");
  assert.equal(abstained(await h.gateway.run(request())).reason, "call_ceiling");
  assert.equal(h.codex.calls.length, 3);
});

test("ledger records without a namespace stay live, and a namespace this version does not know stops spending", async (t) => {
  const h = harness(t);
  const record = { at: h.clock.now, reservation: "r-1", specialist: "estimator", provider: "codex", model: "gpt-6.1-sol", outcome: "reserved", calls: 1, costUsd: 3, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
  writeFileSync(join(h.stateDir, "gateway-usage.jsonl"), `${JSON.stringify(record)}\n`);
  const restarted = harness(t, { stateDir: h.stateDir });
  const usage = (await restarted.gateway.health()).usage;
  assert.deepEqual([usage.teams.live, usage.teams.shadow], [{ calls: 1, costUsd: 3 }, { calls: 0, costUsd: 0 }]);
  for (const key of ["future:estimator", "__proto__", "eval:__proto__", "shadow:"]) {
    writeFileSync(join(h.stateDir, "gateway-usage.jsonl"), `${JSON.stringify({ ...record, specialist: key })}\n`);
    const unknown = harness(t, { stateDir: h.stateDir });
    assert.equal(abstained(await unknown.gateway.run(request())).reason, "ledger_unavailable", key);
    await unknown.gateway.health();
    assert.equal(unknown.codex.calls.length, 0, key);
  }
  assert.equal(Object.hasOwn(Object.prototype, "calls"), false);
});

test("a ledger ceiling says when the oldest reservation counted against it leaves the window", async (t) => {
  const config = liveConfig();
  config.ceilings.specialists.estimator = { calls: 2, costUsd: 30, costUsdPerCall: 3 };
  config.ceilings.specialists.lead_concierge = { calls: 100, costUsd: 6, costUsdPerCall: 3 };
  const window = config.ceilings.windowHours * 3_600_000;
  const h = harness(t, { config });
  const first = h.clock.now;
  h.codex.steps.push(outcome(), outcome(), { ...outcome(), costUsd: 3 }, { ...outcome(), costUsd: 3 });
  await h.gateway.run(request({ specialist: "estimator" }));
  await h.gateway.run(request({ specialist: "lead_concierge" }));
  h.clock.now += 60_000;
  await h.gateway.run(request({ specialist: "estimator" }));
  await h.gateway.run(request({ specialist: "lead_concierge" }));
  const calls = abstained(await h.gateway.run(request({ specialist: "estimator" })));
  assert.deepEqual([calls.reason, calls.retryAt], ["call_ceiling", first + window + 1]);
  const cost = abstained(await h.gateway.run(request({ specialist: "lead_concierge" })));
  assert.deepEqual([cost.reason, cost.retryAt], ["cost_ceiling", first + window + 1]);
  // Not a millisecond early: the run gets its slot exactly then.
  h.clock.now = first + window;
  assert.equal(abstained(await h.gateway.run(request({ specialist: "estimator" }))).reason, "call_ceiling");
  h.clock.now = first + window + 1;
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request({ specialist: "estimator" }))).status, "ok");
});

test("a team ceiling's retry time comes from its own namespace", async (t) => {
  const config = liveConfig();
  config.ceilings.team = { calls: 2, costUsd: 300 };
  const window = config.ceilings.windowHours * 3_600_000;
  const h = harness(t, { config });
  h.codex.steps.push(outcome(), outcome(), outcome());
  await h.gateway.run(request({ scope: "shadow" }));
  h.clock.now += 1_000;
  const oldestLive = h.clock.now;
  await h.gateway.run(request());
  h.clock.now += 1_000;
  await h.gateway.run(request({ specialist: "estimator" }));
  const full = abstained(await h.gateway.run(request({ specialist: "market_analyst" })));
  assert.deepEqual([full.reason, full.retryAt], ["call_ceiling", oldestLive + window + 1]);
});

test("provider failures and a wrong served model retry after the attempt's backoff", async (t) => {
  const exhausted = harness(t);
  exhausted.codex.steps.push(...[1, 2, 3].map(() => new ProviderError("transient", "socket hang up")));
  const transient = abstained(await exhausted.gateway.run(request()));
  // Third attempt: min(max_delay, 2000 * 2^2) = 8000, half of it plus half again at random 0.5.
  assert.deepEqual([transient.reason, transient.retryAt], ["provider_error", exhausted.clock.now + 6000]);
  const fatal = harness(t);
  fatal.codex.steps.push(new ProviderError("fatal", "bad request"));
  const failed = abstained(await fatal.gateway.run(request()));
  assert.deepEqual([failed.reason, failed.retryAt], ["provider_error", fatal.clock.now + 1500]);
  const mismatch = harness(t);
  mismatch.claude.steps.push({ ...outcome(), modelsUsed: ["claude-sonnet-5-5"] });
  const served = abstained(await mismatch.gateway.run(request({ specialist: "independent_auditor", tier: "audit" })));
  assert.deepEqual([served.reason, served.retryAt], ["model_mismatch", mismatch.clock.now + 1500]);
});

test("abstentions that waiting cannot fix carry no retry time", async (t) => {
  const results: GatewayResult[] = [];
  const killed = harness(t);
  killed.env.AGENT_HOST_KILL = "1";
  results.push(await killed.gateway.run(request()));
  const h = harness(t);
  results.push(await h.gateway.run(request({ specialist: "ghost" })), await h.gateway.run(request({ tier: "audit" })));
  const config = liveConfig();
  config.providers.codex.enabled = false;
  results.push(await harness(t, { config }).gateway.run(request()));
  const signedOut = harness(t);
  signedOut.codex.credentialState = { fingerprint: null };
  results.push(await signedOut.gateway.run(request()));
  h.codex.steps.push(
    new ProviderError("auth", "401 unauthorized"),
    outcome({ decision: "propose", note: null, send_now: true }),
    new ProviderError("budget", "per-call ceiling", { costUsd: 3 }),
  );
  results.push(await h.gateway.run(request()));
  h.codex.credentialState = { fingerprint: "codex-credential-2", refreshedAt: h.clock.now, plan: "business" };
  results.push(await h.gateway.run(request()), await h.gateway.run(request()));
  const cancelled = new AbortController();
  h.codex.steps.push(async () => {
    cancelled.abort();
    throw new ProviderError("transient", "interrupted");
  });
  results.push(await h.gateway.run(request({ signal: cancelled.signal })));
  writeFileSync(join(h.stateDir, "gateway-usage.jsonl"), `${JSON.stringify({ at: h.clock.now, specialist: "estimator", costUsd: "x" })}\n`);
  results.push(await harness(t, { stateDir: h.stateDir }).gateway.run(request()));
  const reasons = results.map((result) => abstained(result)).map((result) => [result.reason, result.retryAt]);
  assert.deepEqual(reasons, [
    ["kill_switch", undefined],
    ["unknown_specialist", undefined],
    ["tier_not_allowed", undefined],
    ["provider_disabled", undefined],
    ["credential_missing", undefined],
    ["auth_failed", undefined],
    ["invalid_output", undefined],
    ["cost_ceiling", undefined],
    ["aborted", undefined],
    ["ledger_unavailable", undefined],
  ]);
});

/** The shipped file, with a synthetic retention confirmation on the Codex account so live runs reach it. */
const rawConfig = () => {
  const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  value.providers.codex.confirmed_retention = { confirmed_by: "owner", reference: "synthetic retention confirmation" };
  return value;
};

test("an audit naming no run under review abstains while a proposer route shares the audit route's family", async (t) => {
  const proposersOnClaude: Array<(value: any) => void> = [
    (v) => (v.specialists.estimator.route = "claude_opus"),
    (v) => (v.specialists.estimator.actions = { "estimate.price": "claude_opus" }),
    (v) => (v.tiers.hard = "claude_opus"),
  ];
  for (const mutate of proposersOnClaude) {
    const value = rawConfig();
    mutate(value);
    const h = harness(t, { config: parseGatewayConfig(value) });
    const unreviewed = abstained(await h.gateway.run(request({ specialist: "independent_auditor", tier: "audit" })));
    assert.deepEqual([unreviewed.reason, unreviewed.routeId, unreviewed.provider, unreviewed.retryAt], ["no_independent_route", null, null, undefined]);
    assert.match(unreviewed.detail, /^tiers\.audit \(claude_opus\) runs on anthropic like proposer route claude_opus; name the run under review/);
    // Work under review still gets the route of the other family.
    h.codex.steps.push(outcome());
    assert.equal((await h.gateway.run(audit("anthropic"))).routeId, "codex_astra");
    assert.equal(h.claude.calls.length, 0);
  }
});

test("a plan refusal retries at the next probe, and a sign-in on an unconfigured plan has no retry time", async (t) => {
  const probeAfter = shippedConfig().retry.authProbeAfterMs;
  const h = harness(t);
  h.codex.steps.push(new ProviderError("plan", "codex: plan does not include model gpt-6.1-sol; sign the agent host's CODEX_HOME in with a ChatGPT plan that includes it"));
  const refusedAt = h.clock.now;
  const refused = abstained(await h.gateway.run(request()));
  assert.deepEqual([refused.reason, refused.retryAt], ["provider_error", refusedAt + probeAfter]);
  h.clock.now += 60_000;
  const latched = abstained(await h.gateway.run(request()));
  assert.deepEqual([latched.reason, latched.retryAt, h.codex.calls.length], ["provider_error", refusedAt + probeAfter, 1]);
  // Past the interval one run claims the probe; the others wait for the probe after it.
  h.clock.now = refusedAt + probeAfter;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.codex.steps.push(async () => {
    await gate;
    return outcome();
  });
  const probe = h.gateway.run(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abstained(await h.gateway.run(request())).retryAt, refusedAt + 2 * probeAfter);
  release();
  assert.equal((await probe).status, "ok");
  const unconfigured = harness(t);
  unconfigured.codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: unconfigured.clock.now, plan: "free" };
  const gap = abstained(await unconfigured.gateway.run(request()));
  assert.deepEqual([gap.reason, gap.retryAt, unconfigured.codex.calls.length], ["provider_error", undefined, 0]);
});

test("prototype names as specialist, action or reviewed provider abstain or fall back, and never throw", async (t) => {
  const config = liveConfig();
  config.specialists.estimator = { tiers: ["routine", "hard"], route: null, actions: { "estimate.price": "codex_astra" } };
  const h = harness(t, { config });
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(abstained(await h.gateway.run(request({ specialist: name }))).reason, "unknown_specialist", name);
    assert.equal(abstained(await h.gateway.run(request({ specialist: name, action: "estimate.price" }))).reason, "unknown_specialist", name);
    assert.equal(abstained(await h.gateway.run(audit(name))).reason, "no_independent_route", name);
    h.codex.steps.push(outcome());
    const fallback = await h.gateway.run(request({ specialist: "estimator", action: name }));
    assert.deepEqual([fallback.status, fallback.routeId], ["ok", "codex_sol"], name);
  }
  const evaluation = harness(t, { qualification: qualification() });
  await assert.rejects(
    evaluation.gateway.run(request({ scope: "eval", tierRoutes: { routine: { provider: "codex", model: "toString", effort: "high" } } })),
    programmingError(/tierRoutes\.routine\.model has no registry entry/),
  );
  assert.equal(Object.hasOwn(Object.prototype, "tiers"), false);
});

test("a specialist registered under a prototype name gets the default ceiling and its own usage entry", async (t) => {
  const value = rawConfig();
  value.specialists.constructor = { tiers: ["routine", "hard"], route: null, actions: {} };
  const h = harness(t, { config: parseGatewayConfig(value) });
  h.codex.steps.push(outcome());
  assert.equal((await h.gateway.run(request({ specialist: "constructor" }))).status, "ok");
  assert.equal(h.codex.calls[0].maxCostUsd, shippedConfig().ceilings.specialistDefault.costUsdPerCall);
  assert.deepEqual((await h.gateway.health()).usage.specialists.constructor, { calls: 1, costUsd: 0.25 });
  assert.equal(Object.hasOwn(Object, "calls"), false);
});

test("an eval gateway keeps the qualification window, not the production one", async (t) => {
  const block = qualification();
  block.ledger.window_hours = 1;
  block.ledger.specialist = { calls: 1, cost_usd: 6, cost_usd_per_call: 2 };
  const h = harness(t, { qualification: block });
  h.codex.steps.push(outcome(), outcome());
  const first = h.clock.now;
  assert.equal((await h.gateway.run(request({ scope: "eval" }))).status, "ok");
  const full = abstained(await h.gateway.run(request({ scope: "eval" })));
  assert.deepEqual([full.reason, full.retryAt], ["call_ceiling", first + 3_600_000 + 1]);
  h.clock.now = first + 3_600_000 + 1;
  assert.equal((await h.gateway.run(request({ scope: "eval" }))).status, "ok");
});

test("a ledger retry time is the latest across the refusing ceilings, absent when none has a reservation to free", async (t) => {
  const config = liveConfig();
  config.ceilings.team = { calls: 2, costUsd: 300 };
  config.ceilings.specialists.estimator = { calls: 1, costUsd: 30, costUsdPerCall: 3 };
  const window = config.ceilings.windowHours * 3_600_000;
  const both = harness(t, { config });
  both.codex.steps.push(outcome(), outcome());
  const teamOldest = both.clock.now;
  await both.gateway.run(request());
  both.clock.now += 60_000;
  const ownOldest = both.clock.now;
  await both.gateway.run(request({ specialist: "estimator" }));
  // Both the estimator's and the team's call ceilings refuse; only the later time frees both.
  const refused = abstained(await both.gateway.run(request({ specialist: "estimator" })));
  assert.deepEqual([refused.reason, refused.retryAt], ["call_ceiling", ownOldest + window + 1]);
  assert.ok(teamOldest < ownOldest);
  // A team cost ceiling below the per-call reservation has nothing counted that could free it.
  const tight = liveConfig();
  tight.ceilings.team = { calls: 6000, costUsd: 2 };
  const never = abstained(await harness(t, { config: tight }).gateway.run(request()));
  assert.deepEqual([never.reason, never.retryAt], ["cost_ceiling", undefined]);
});

test("a team cost ceiling refuses as cost_ceiling and frees with its own oldest reservation", async (t) => {
  const config = liveConfig();
  config.ceilings.team = { calls: 6000, costUsd: 6 };
  const window = config.ceilings.windowHours * 3_600_000;
  const h = harness(t, { config });
  h.codex.steps.push({ ...outcome(), costUsd: 3 }, { ...outcome(), costUsd: 3 });
  const oldest = h.clock.now;
  await h.gateway.run(request());
  h.clock.now += 60_000;
  await h.gateway.run(request({ specialist: "estimator" }));
  // market_analyst has spent nothing: only the team's cost ceiling is in the way.
  const refused = abstained(await h.gateway.run(request({ specialist: "market_analyst" })));
  assert.deepEqual([refused.reason, refused.retryAt], ["cost_ceiling", oldest + window + 1]);
  assert.match(refused.detail, /^market_analyst reached its cost ceiling/);
});
