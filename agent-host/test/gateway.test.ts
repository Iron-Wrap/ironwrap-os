import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ProviderGateway } from "../src/gateway/gateway.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";
import { ProviderError, type GatewayRequest, type GatewayResult } from "../src/gateway/types.ts";
import { OUTPUT_SCHEMA, fakeAdapter, outcome, shippedConfig, tempDir, type FakeAdapter } from "./helpers.ts";

const request = (overrides: Partial<GatewayRequest> = {}): GatewayRequest => ({
  specialist: "lead_concierge",
  tier: "routine",
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

function harness(t: TestContext, options: { config?: GatewayConfig; stateDir?: string } = {}): Harness {
  const stateDir = options.stateDir ?? tempDir(t);
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const sleeps: number[] = [];
  const clock = { now: 1_000_000_000_000 };
  codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: clock.now };
  const env: Record<string, string | undefined> = {};
  const gateway = new ProviderGateway({
    config: options.config ?? shippedConfig(),
    stateDir,
    env,
    adapters: { claude, codex },
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
  assert.equal(result.authMode, "chatgpt");
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
  const config = shippedConfig();
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
  const config = shippedConfig();
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
  const config = shippedConfig();
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
    h.codex.credentialState = { fingerprint: "codex-credential-2", refreshedAt: h.clock.now };
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
  assert.equal(health.usage.team.calls, 1);
  assert.equal(health.usage.team.costUsd, 0.25);
  assert.ok(health.alerts.includes("ledger_unavailable"));
  assert.equal(health.ready, false);
  assert.equal(abstained(await h.gateway.run(request())).reason, "ledger_unavailable");
  assert.equal(h.codex.calls.length, 1);
});

test("a crash between reservation and settlement keeps the reservation counted", async (t) => {
  const config = shippedConfig();
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
  const config = shippedConfig();
  config.routes.audit.model = "claude-opus-5";
  const shorter = harness(t, { config });
  shorter.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-5"] });
  assert.equal(abstained(await shorter.gateway.run(audit)).reason, "model_mismatch");
  shorter.claude.steps.push({ ...outcome(), modelsUsed: ["claude-opus-5-20260901"] });
  assert.equal((await shorter.gateway.run(audit)).status, "ok");
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
  assert.deepEqual((await h.gateway.health()).usage.team, { calls: 1, costUsd: 3 });
});

test("a ledger record that cannot be counted stops spending after a restart", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.stateDir, "gateway-usage.jsonl"), `${JSON.stringify({ at: h.clock.now, specialist: "estimator", costUsd: "x" })}\n`);
  const restarted = harness(t, { stateDir: h.stateDir });
  assert.equal(abstained(await restarted.gateway.run(request())).reason, "ledger_unavailable");
  assert.equal(restarted.codex.calls.length, 0);
});
