import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseGatewayConfig, parseQualification } from "../src/gateway/config.ts";
import { CONFIG_PATH, QUALIFICATION_PATH, qualification, shippedConfig } from "./helpers.ts";

const raw = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
/** An own enumerable key, as JSON.parse makes for `"__proto__"`, rather than a prototype change. */
const own = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

test("the shipped configuration names its routes, maps the tiers to them and audits each family on the other", () => {
  const config = shippedConfig();
  assert.deepEqual(config.routes, {
    codex_sol: { provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
    codex_astra: { provider: "codex", model: "gpt-6-astra", effort: "high" },
    claude_opus: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
  });
  assert.deepEqual(config.tiers, { routine: "codex_sol", hard: "codex_astra", audit: "claude_opus" });
  assert.deepEqual(config.auditRoutes, { codex: "claude_opus", claude: "codex_astra" });
  assert.equal(config.providers.claude.auth, "oauth");
  assert.equal(config.providers.codex.auth, "chatgpt");
  assert.equal(Object.keys(config.specialists).length, 16);
  assert.deepEqual(config.specialists.independent_auditor, { tiers: ["audit"], route: null, actions: {} });
  for (const [id, specialist] of Object.entries(config.specialists)) {
    if (id !== "independent_auditor") assert.deepEqual(specialist, { tiers: ["routine", "hard"], route: null, actions: {} }, id);
  }
  assert.deepEqual(config.ceilings.shadow, {
    team: { calls: 300, costUsd: 15 },
    specialist: { calls: 60, costUsd: 3, costUsdPerCall: 0.5 },
  });
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
  value.routes.claude_opus.model = "claude-sonnet-5-5";
  const config = parseGatewayConfig(value);
  assert.equal(config.routes[config.tiers.audit].model, "claude-sonnet-5-5");
});

test("a proposer may run on Claude: independence is checked per run, not by refusing the family", () => {
  const value = raw();
  value.tiers.hard = "claude_opus";
  value.specialists.estimator.route = "claude_opus";
  const config = parseGatewayConfig(value);
  assert.equal(config.routes[config.tiers.hard].provider, "claude");
  assert.equal(config.specialists.estimator.route, "claude_opus");
});

test("a specialist routes one expected action, or all its runs, to a named route", () => {
  const value = raw();
  value.specialists.estimator = { tiers: ["routine", "hard"], route: "codex_astra", actions: { "estimate.price": "claude_opus" } };
  assert.deepEqual(parseGatewayConfig(value).specialists.estimator, {
    tiers: ["routine", "hard"],
    route: "codex_astra",
    actions: { "estimate.price": "claude_opus" },
  });
});

test("configuration that would weaken the gateway is refused", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["a credential value instead of a name", (v) => (v.providers.claude.oauth_token_env = "sk-ant-oat01-abc"), /environment variable name/],
    ["an unknown provider field", (v) => (v.providers.codex.fallback_model = "gpt-5"), /fallback_model is not a known field/],
    ["an unknown top-level field", (v) => (v.fallback_routes = {}), /\$\.fallback_routes is not a known field/],
    ["an unknown route field", (v) => (v.routes.codex_sol.fallback_model = "gpt-5"), /routes\.codex_sol\.fallback_model is not a known field/],
    ["an unknown specialist field", (v) => (v.specialists.estimator.fallback = "claude_opus"), /specialists\.estimator\.fallback is not a known field/],
    ["a specialist without its action routes", (v) => delete v.specialists.estimator.actions, /specialists\.estimator\.actions is required/],
    ["a malformed route id", (v) => (v.routes["Codex-Sol"] = { provider: "codex", model: "gpt-6.1-sol", effort: "low" }), /routes\.Codex-Sol is not a route id/],
    ["a tier naming no route", (v) => (v.tiers.routine = "codex_turbo"), /tiers\.routine names no route/],
    ["a tier left out", (v) => delete v.tiers.hard, /tiers\.hard is required/],
    ["a specialist route naming no route", (v) => (v.specialists.estimator.route = "codex_turbo"), /specialists\.estimator\.route names no route/],
    ["an action route naming no route", (v) => (v.specialists.estimator.actions = { "estimate.price": "codex_turbo" }), /actions\.estimate\.price names no route/],
    ["an audit route naming no route", (v) => (v.audit_routes.codex = "codex_turbo"), /audit_routes\.codex names no route/],
    ["an action route keyed by no action id", (v) => (v.specialists.estimator.actions = { Estimate: "codex_astra" }), /actions\.Estimate is not an action id/],
    ["an audit route on the family it audits", (v) => (v.audit_routes.codex = "codex_astra"), /audit_routes\.codex must name a route of another family than codex/],
    ["an audit route for no known family", (v) => (v.audit_routes.gemini = "claude_opus"), /audit_routes\.gemini is not a model family/],
    ["no audit route for the proposers' family", (v) => delete v.audit_routes.codex, /audit_routes\.codex is required: route codex_sol proposes on codex/],
    [
      "a Claude action route without a Claude audit route",
      (v) => {
        delete v.audit_routes.claude;
        v.specialists.estimator.actions = { "estimate.price": "claude_opus" };
      },
      /audit_routes\.claude is required: route claude_opus proposes on claude/,
    ],
    [
      "a Claude specialist route without a Claude audit route",
      (v) => {
        delete v.audit_routes.claude;
        v.specialists.compliance.route = "claude_opus";
      },
      /audit_routes\.claude is required: route claude_opus proposes on claude/,
    ],
    ["a Codex route without a price", (v) => (v.routes.codex_sol.model = "gpt-7"), /routes\.codex_sol\.model codex models need a pricing_usd_per_mtok entry/],
    ["an unused Codex route without a price", (v) => (v.routes.codex_spare = { provider: "codex", model: "gpt-7", effort: "low" }), /routes\.codex_spare\.model codex models need/],
    ["an auditor with a route of its own", (v) => (v.specialists.independent_auditor.route = "codex_astra"), /routed by tiers\.audit and audit_routes only/],
    ["an auditor with an action route", (v) => (v.specialists.independent_auditor.actions = { "audit.review": "codex_astra" }), /routed by tiers\.audit and audit_routes only/],
    ["an auditor that may also propose", (v) => (v.specialists.independent_auditor.tiers = ["audit", "routine"]), /exactly the audit tier/],
    ["an auditor moved to a proposer tier", (v) => (v.specialists.independent_auditor.tiers = ["routine"]), /exactly the audit tier/],
    ["a proposer on the audit tier", (v) => (v.specialists.estimator.tiers = ["audit"]), /only the independent auditor/],
    ["no auditor at all", (v) => delete v.specialists.independent_auditor, /independent_auditor is required/],
    ["a ceiling for an unregistered specialist", (v) => (v.ceilings.specialists.ghost = { calls: 1, cost_usd: 1, cost_usd_per_call: 1 }), /not a registered specialist/],
    ["a per-call ceiling above the window ceiling", (v) => (v.ceilings.specialist_default.cost_usd_per_call = 99), /exceeds cost_usd/],
    ["no shadow budget", (v) => delete v.ceilings.shadow, /ceilings\.shadow is required/],
    ["an unknown shadow field", (v) => (v.ceilings.shadow.live_share = 1), /ceilings\.shadow\.live_share is not a known field/],
    ["a shadow per-call ceiling above its window ceiling", (v) => (v.ceilings.shadow.specialist.cost_usd_per_call = 4), /shadow\.specialist\.cost_usd_per_call exceeds cost_usd/],
    ["an unknown effort", (v) => (v.routes.codex_sol.effort = "ultra"), /effort level/],
    ["the v1 schema id", (v) => (v.schema = "ironwrap_agent_gateway_config_v1"), /schema must be ironwrap_agent_gateway_config_v2/],
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

test("prototype names are refused wherever the configuration keys or names a route, price, ceiling or specialist", () => {
  const route = { provider: "codex", model: "gpt-6.1-sol", effort: "low" };
  const ceiling = { calls: 1, cost_usd: 1, cost_usd_per_call: 1 };
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["a Codex model named toString", (v) => (v.routes.codex_sol.model = "toString"), /routes\.codex_sol\.model codex models need a pricing_usd_per_mtok entry/],
    ["a Codex model named constructor", (v) => (v.routes.codex_astra.model = "constructor"), /routes\.codex_astra\.model codex models need a pricing_usd_per_mtok entry/],
    ["a price keyed __proto__", (v) => own(v.pricing_usd_per_mtok, "__proto__", { input: 1, cached_input: 1, output: 1 }), /pricing_usd_per_mtok\.__proto__ is not a model id/],
    ["a ceiling keyed __proto__", (v) => own(v.ceilings.specialists, "__proto__", ceiling), /ceilings\.specialists\.__proto__ is not a specialist id/],
    ["a ceiling keyed constructor", (v) => own(v.ceilings.specialists, "constructor", ceiling), /ceilings\.specialists\.constructor is not a registered specialist/],
    ["a route keyed __proto__", (v) => own(v.routes, "__proto__", route), /routes\.__proto__ is not a route id/],
    ["a route keyed toString", (v) => own(v.routes, "toString", route), /routes\.toString is not a route id/],
    ["a tier naming constructor", (v) => (v.tiers.routine = "constructor"), /tiers\.routine names no route/],
    ["a tier naming __proto__", (v) => (v.tiers.hard = "__proto__"), /tiers\.hard names no route/],
    ["an audit route naming toString", (v) => (v.audit_routes.codex = "toString"), /audit_routes\.codex names no route/],
    ["an audit route keyed __proto__", (v) => own(v.audit_routes, "__proto__", "claude_opus"), /audit_routes\.__proto__ is not a model family/],
    ["an audit route keyed constructor", (v) => own(v.audit_routes, "constructor", "claude_opus"), /audit_routes\.constructor is not a model family/],
    ["a specialist route naming hasOwnProperty", (v) => (v.specialists.estimator.route = "hasOwnProperty"), /specialists\.estimator\.route names no route/],
    ["an action route naming constructor", (v) => (v.specialists.estimator.actions = { "estimate.price": "constructor" }), /actions\.estimate\.price names no route/],
    ["an action keyed __proto__", (v) => own(v.specialists.estimator.actions, "__proto__", "codex_astra"), /actions\.__proto__ is not an action id/],
    ["a specialist keyed __proto__", (v) => own(v.specialists, "__proto__", { tiers: ["routine"], route: null, actions: {} }), /specialists\.__proto__ is not a specialist id/],
  ];
  for (const [name, mutate, message] of cases) {
    const value = raw();
    mutate(value);
    assert.throws(() => parseGatewayConfig(value), message, name);
  }
  // A real route under such a name is looked up as an own entry like any other.
  const value = raw();
  own(value.routes, "constructor", route);
  value.tiers.routine = "constructor";
  const config = parseGatewayConfig(value);
  assert.deepEqual(config.routes[config.tiers.routine], route);
});

test("the shipped qualification blocks parse into isolated eval books", () => {
  const shipped = JSON.parse(readFileSync(QUALIFICATION_PATH, "utf8"));
  const parsed = parseQualification({ ledger: shipped.ledger, judge: shipped.judge }, shippedConfig());
  const ceiling = (value: { calls: number; cost_usd: number; cost_usd_per_call?: number }) => ({
    calls: value.calls,
    costUsd: value.cost_usd,
    ...(value.cost_usd_per_call === undefined ? {} : { costUsdPerCall: value.cost_usd_per_call }),
  });
  assert.equal(parsed.judgeKey, shipped.ledger.judge_key);
  assert.equal(parsed.windowHours, shipped.ledger.window_hours);
  assert.deepEqual(parsed.team, ceiling(shipped.ledger.team));
  assert.deepEqual(parsed.specialist, ceiling(shipped.ledger.specialist));
  assert.deepEqual(parsed.judge, ceiling(shipped.ledger.judge));
  assert.deepEqual(parsed.judgeRoutes, { default: shipped.judge.default, for_claude_proposers: shipped.judge.for_claude_proposers });
});

test("qualification blocks that would mix eval and production spend are refused", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["a ledger that is not isolated", (q) => (q.ledger.isolated = false), /qualification\.ledger\.isolated must be true/],
    ["another namespace", (q) => (q.ledger.namespace = "live"), /qualification\.ledger\.namespace must be eval/],
    ["no eval run tag", (q) => (q.ledger.requires_run_tag = "production"), /requires_run_tag must be eval/],
    ["an unknown ledger field", (q) => (q.ledger.shared_with = "production"), /qualification\.ledger\.shared_with is not a known field/],
    ["a judge key that is a specialist", (q) => (q.ledger.judge_key = "orchestrator"), /judge_key must not be a registered specialist/],
    ["a judge key that is no ledger key", (q) => (q.ledger.judge_key = "eval:judge"), /judge_key is not a ledger key/],
    ["a judge per-call ceiling above its window ceiling", (q) => (q.ledger.judge.cost_usd_per_call = 500), /qualification\.ledger\.judge\.cost_usd_per_call exceeds cost_usd/],
    ["an unknown judge field", (q) => (q.judge.fallback = q.judge.default), /qualification\.judge\.fallback is not a known field/],
    ["a judge route left out", (q) => delete q.judge.for_claude_proposers, /for_claude_proposers is required/],
    ["a Codex judge without a price", (q) => (q.judge.for_claude_proposers.model = "gpt-7"), /for_claude_proposers\.model codex models need a pricing_usd_per_mtok entry/],
    ["a Codex judge named toString", (q) => (q.judge.for_claude_proposers.model = "toString"), /for_claude_proposers\.model codex models need a pricing_usd_per_mtok entry/],
    ["a judge on no known family", (q) => (q.judge.default.provider = "gemini"), /qualification\.judge\.default\.provider must be one of/],
  ];
  for (const [name, mutate, message] of cases) {
    const value = qualification();
    mutate(value);
    assert.throws(() => parseQualification(value, shippedConfig()), message, name);
  }
});
