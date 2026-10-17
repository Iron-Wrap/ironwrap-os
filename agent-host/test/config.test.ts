import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseGatewayConfig } from "../src/gateway/config.ts";
import { CONFIG_PATH, shippedConfig } from "./helpers.ts";

const raw = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

test("the shipped configuration routes proposers to Codex and the auditor to Claude", () => {
  const config = shippedConfig();
  assert.deepEqual(config.routes.routine, { provider: "codex", model: "gpt-6.1-sol", effort: "medium" });
  assert.deepEqual(config.routes.hard, { provider: "codex", model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(config.routes.audit, { provider: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.equal(config.providers.claude.auth, "oauth");
  assert.equal(config.providers.codex.auth, "chatgpt");
  assert.equal(Object.keys(config.specialists).length, 16);
  assert.deepEqual(config.specialists.independent_auditor, ["audit"]);
  for (const [id, tiers] of Object.entries(config.specialists)) {
    if (id !== "independent_auditor") assert.deepEqual(tiers, ["routine", "hard"], id);
  }
});

test("switching either provider to an API key is a configuration change only", () => {
  const value = raw();
  value.providers.claude.auth = "api_key";
  value.providers.codex.auth = "api_key";
  const config = parseGatewayConfig(value);
  assert.equal(config.providers.claude.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(config.providers.codex.apiKeyEnv, "CODEX_API_KEY");
});

test("the auditor can drop to another Claude model without code changes", () => {
  const value = raw();
  value.routes.audit.model = "claude-sonnet-5-5";
  assert.equal(parseGatewayConfig(value).routes.audit.model, "claude-sonnet-5-5");
});

test("configuration that would weaken the gateway is refused", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["audit on the proposer family", (v) => (v.routes.audit.provider = "codex"), /routes\.audit\.provider must differ/],
    ["proposer on the auditor family", (v) => (v.routes.hard.provider = "claude"), /must differ from the hard provider/],
    ["a credential value instead of a name", (v) => (v.providers.claude.oauth_token_env = "sk-ant-oat01-abc"), /environment variable name/],
    ["an unknown field", (v) => (v.providers.codex.fallback_model = "gpt-5"), /fallback_model is not a known field/],
    ["a Codex model without a price", (v) => (v.routes.routine.model = "gpt-7"), /pricing_usd_per_mtok/],
    ["an auditor that may also propose", (v) => (v.specialists.independent_auditor = ["audit", "routine"]), /exactly the audit tier/],
    ["an auditor moved to the proposer family", (v) => (v.specialists.independent_auditor = ["routine"]), /exactly the audit tier/],
    ["a proposer on the audit tier", (v) => (v.specialists.estimator = ["audit"]), /only the independent auditor/],
    ["no auditor at all", (v) => delete v.specialists.independent_auditor, /independent_auditor is required/],
    ["a ceiling for an unregistered specialist", (v) => (v.ceilings.specialists.ghost = { calls: 1, cost_usd: 1, cost_usd_per_call: 1 }), /not a registered specialist/],
    ["a per-call ceiling above the window ceiling", (v) => (v.ceilings.specialist_default.cost_usd_per_call = 99), /exceeds cost_usd/],
    ["an unknown effort", (v) => (v.routes.routine.effort = "ultra"), /effort level/],
    ["a wrong schema id", (v) => (v.schema = "v0"), /schema must be/],
    ["no ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = []), /chatgpt_plans must list at least one plan/],
    ["a malformed ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = ["Pro Plan"]), /chatgpt_plans must hold plan names/],
    ["a repeated ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = ["pro", "pro"]), /chatgpt_plans must not repeat/],
    ["no ChatGPT plan list", (v) => delete v.providers.codex.chatgpt_plans, /chatgpt_plans is required/],
  ];
  for (const [name, mutate, message] of cases) {
    const value = raw();
    mutate(value);
    assert.throws(() => parseGatewayConfig(value), message, name);
  }
});
