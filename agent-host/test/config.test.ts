import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chainOf, parseGatewayConfig, parseQualification, proposerRoutes } from "../src/gateway/config.ts";
import { COMPLIANCE_REFS } from "../src/gateway/compliance.ts";
import { upgradeConfig } from "../src/gateway/upgrade-config.ts";
import { CONFIG_PATH, CONSUMER_CONFIG_PATH, QUALIFICATION_PATH, qualification, shippedConfig } from "./helpers.ts";

const raw = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const V2_PATH = fileURLToPath(new URL("./fixtures/gateway.v2.json", import.meta.url));
const CONVERTER = fileURLToPath(new URL("../src/gateway/upgrade-config.ts", import.meta.url));
/** An own enumerable key, as JSON.parse makes for `"__proto__"`, rather than a prototype change. */
const own = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
/** A registry entry a route may point at, cited like the shipped ones. */
const entry = (family: string, extra: Record<string, unknown> = {}) => ({
  family,
  tools: true,
  json_schema: "native",
  context_tokens: 400000,
  max_output_tokens: 32000,
  efforts: { medium: {}, high: {} },
  price: { subscription: "chatgpt", list_usd_per_mtok: { input: 1, cached_input: 0.1, output: 5 } },
  rate_limits: { requests_per_minute: null, input_tokens_per_minute: null, output_tokens_per_minute: null },
  unverified: [],
  sources: { context_tokens: "synthetic doc, read on a synthetic day", max_output_tokens: "synthetic doc", price: "synthetic doc" },
  ...extra,
});

test("the shipped configuration keeps its routes on the two SDK accounts, audits each family on the other and names commercial refs", () => {
  const config = shippedConfig();
  assert.deepEqual(config.routes, {
    codex_sol: { provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
    codex_astra: { provider: "codex", model: "gpt-6-astra", effort: "high" },
    claude_opus: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
  });
  assert.deepEqual(config.fallbacks, { codex_sol: null, codex_astra: null, claude_opus: null });
  assert.deepEqual(config.tiers, { routine: "codex_sol", hard: "codex_astra", audit: "claude_opus" });
  assert.deepEqual(config.auditRoutes, { openai: "claude_opus", anthropic: "codex_astra" });
  const { claude, codex } = config.providers;
  assert.deepEqual([claude.adapter, claude.credentialMode, claude.billing, claude.complianceRef], ["claude_agent_sdk", "oauth", "subscription", "ai.anthropic.claude-commercial"]);
  assert.deepEqual([codex.adapter, codex.credentialMode, codex.billing, codex.complianceRef], ["codex", "oauth", "subscription", "ai.openai.chatgpt-commercial"]);
  // Written retention is not confirmed yet, so live and shadow Codex runs stay refused.
  assert.equal(codex.confirmedRetention, null);
  assert.deepEqual(config.ownerRiskAcceptances, []);
  assert.deepEqual(
    Object.fromEntries(Object.values(config.providers).flatMap((account) => Object.entries(account.models).map(([model, value]) => [model, value.family]))),
    { "claude-opus-5-5": "anthropic", "claude-sonnet-5-5": "anthropic", "gpt-6.1-sol": "openai", "gpt-6-astra": "openai" },
  );
  assert.equal(Object.keys(config.specialists).length, 16);
  assert.deepEqual(config.specialists.independent_auditor, { tiers: ["audit"], route: null, actions: {} });
  for (const [id, specialist] of Object.entries(config.specialists)) {
    if (id !== "independent_auditor") assert.deepEqual(specialist, { tiers: ["routine", "hard"], route: null, actions: {} }, id);
  }
  assert.deepEqual(config.ceilings.shadow, {
    team: { calls: 300, costUsd: 15 },
    specialist: { calls: 60, costUsd: 3, costUsdPerCall: 0.5 },
  });
  assert.match(config.sha256, /^[0-9a-f]{64}$/);
  // The hash covers content, not layout.
  assert.equal(parseGatewayConfig(JSON.parse(JSON.stringify(raw()))).sha256, config.sha256);
});

test("every shipped registry figure is cited with the provider doc and the day it was read, and none is unverified", () => {
  for (const account of Object.values(shippedConfig().providers)) {
    for (const [model, value] of Object.entries(account.models)) {
      assert.deepEqual(value.unverified, [], model);
      for (const figure of ["context_tokens", "max_output_tokens", "price"] as const) {
        assert.match(value.sources[figure] ?? "", /^https:\/\/[a-z.]+\/\S+.*read \d{4}-\d{2}-\d{2}$/, `${model} ${figure}`);
      }
      assert.ok(value.maxOutputTokens < value.contextTokens, model);
      assert.ok(value.price.usdPerMTok !== null, model);
    }
  }
});

test("moving an account to an API key is a change to its credential mode, billing and compliance ref only", () => {
  const value = raw();
  Object.assign(value.providers.claude, { credential_mode: "api_key", billing: "api", compliance_ref: "ai.anthropic.api" });
  Object.assign(value.providers.codex, { credential_mode: "api_key", billing: "api", compliance_ref: "ai.openai.api" });
  delete value.providers.codex.confirmed_retention;
  for (const account of [value.providers.claude, value.providers.codex]) {
    for (const model of Object.values(account.models) as Array<{ price: Record<string, unknown> }>) model.price = { usd_per_mtok: model.price.list_usd_per_mtok };
  }
  const config = parseGatewayConfig(value);
  assert.deepEqual([config.providers.claude.credentialMode, config.providers.claude.billing], ["api_key", "api"]);
  assert.equal(config.providers.claude.adapter === "claude_agent_sdk" && config.providers.claude.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(config.providers.codex.adapter === "codex" && config.providers.codex.apiKeyEnv, "CODEX_API_KEY");
  assert.equal(config.providers.codex.models["gpt-6.1-sol"].price.subscription, null);
});

test("the auditor can drop to another Claude model the registry holds without code changes", () => {
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

test("a route declares a same-family fallback chain of at most two hops, and the chain counts as proposer routes", () => {
  const value = raw();
  value.providers.codex.models["gpt-6.1-sol-mini"] = entry("openai");
  value.routes.codex_mini = { provider: "codex", model: "gpt-6.1-sol-mini", effort: "medium", fallback: null };
  value.routes.codex_sol.fallback = "codex_astra";
  value.routes.codex_astra.fallback = "codex_mini";
  const config = parseGatewayConfig(value);
  assert.deepEqual(chainOf(config, "codex_sol"), ["codex_sol", "codex_astra", "codex_mini"]);
  assert.ok(proposerRoutes(config).includes("codex_mini"));
});

test("configuration that would weaken the gateway is refused", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["the v2 schema, which names the converter", (v) => (v.schema = "ironwrap_agent_gateway_config_v2"), /schema is ironwrap_agent_gateway_config_v2: convert the file with `node src\/gateway\/upgrade-config\.ts/],
    ["another schema id", (v) => (v.schema = "ironwrap_agent_gateway_config_v4"), /schema must be ironwrap_agent_gateway_config_v3/],
    ["a credential value instead of a name", (v) => (v.providers.claude.secrets.oauth_token_env = "sk-ant-oat01-abc"), /environment variable name/],
    ["an unknown provider field", (v) => (v.providers.codex.fallback_model = "gpt-5"), /fallback_model is not a known field/],
    ["an unknown top-level field", (v) => (v.fallback_routes = {}), /\$\.fallback_routes is not a known field/],
    ["a v2 price table", (v) => (v.pricing_usd_per_mtok = {}), /\$\.pricing_usd_per_mtok is not a known field/],
    ["an unknown route field", (v) => (v.routes.codex_sol.fallback_model = "gpt-5"), /routes\.codex_sol\.fallback_model is not a known field/],
    ["a route without its fallback", (v) => delete v.routes.codex_sol.fallback, /routes\.codex_sol\.fallback is required/],
    ["an unknown specialist field", (v) => (v.specialists.estimator.fallback = "claude_opus"), /specialists\.estimator\.fallback is not a known field/],
    ["a specialist without its action routes", (v) => delete v.specialists.estimator.actions, /specialists\.estimator\.actions is required/],
    ["a malformed route id", (v) => (v.routes["Codex-Sol"] = { provider: "codex", model: "gpt-6.1-sol", effort: "low", fallback: null }), /routes\.Codex-Sol is not a route id/],
    ["a malformed provider id", (v) => (v.providers["Codex-2"] = v.providers.codex), /providers\.Codex-2 is not a provider id/],
    ["no provider at all", (v) => (v.providers = {}), /\$\.providers must name at least one provider account/],
    ["an adapter this host does not have", (v) => (v.providers.codex.adapter = "openai_compatible"), /adapter must be one of claude_agent_sdk, codex/],
    ["a route on no provider", (v) => (v.routes.codex_sol.provider = "openai"), /routes\.codex_sol\.provider names no provider/],
    ["a route on an unregistered model", (v) => (v.routes.codex_sol.model = "gpt-7"), /routes\.codex_sol\.model has no registry entry in \$\.providers\.codex\.models; unregistered models are never routed/],
    ["a model registered at another account", (v) => (v.routes.claude_opus.model = "gpt-6.1-sol"), /routes\.claude_opus\.model has no registry entry in \$\.providers\.claude\.models/],
    ["an effort the registry does not list", (v) => (v.providers.codex.models["gpt-6.1-sol"].efforts = { high: {} }), /routes\.codex_sol\.effort is not an effort \$\.providers\.codex\.models\.gpt-6\.1-sol\.efforts lists/],
    ["an unknown effort", (v) => (v.routes.codex_sol.effort = "ultra"), /effort is not an effort level/],
    ["an effort fragment on an SDK adapter", (v) => (v.providers.codex.models["gpt-6.1-sol"].efforts.medium = { reasoning_effort: "medium" }), /efforts\.medium must be \{\}: codex takes the effort itself/],
    ["a tier naming no route", (v) => (v.tiers.routine = "codex_turbo"), /tiers\.routine names no route/],
    ["a tier left out", (v) => delete v.tiers.hard, /tiers\.hard is required/],
    ["a specialist route naming no route", (v) => (v.specialists.estimator.route = "codex_turbo"), /specialists\.estimator\.route names no route/],
    ["an action route naming no route", (v) => (v.specialists.estimator.actions = { "estimate.price": "codex_turbo" }), /actions\.estimate\.price names no route/],
    ["an audit route naming no route", (v) => (v.audit_routes.openai = "codex_turbo"), /audit_routes\.openai names no route/],
    ["an action route keyed by no action id", (v) => (v.specialists.estimator.actions = { Estimate: "codex_astra" }), /actions\.Estimate is not an action id/],
    ["an audit route on the family it audits", (v) => (v.audit_routes.openai = "codex_astra"), /audit_routes\.openai must name a route whose whole chain is of another family than openai/],
    ["an audit route keyed by a v2 provider id", (v) => (v.audit_routes.codex = v.audit_routes.openai), /audit_routes\.codex is keyed by a v2 provider id; audit_routes are keyed by family/],
    ["an audit route for no family of the registry", (v) => (v.audit_routes.google = "claude_opus"), /audit_routes\.google is not a model family of the registry/],
    ["no audit route for the proposers' family", (v) => delete v.audit_routes.openai, /audit_routes\.openai is required: route codex_sol proposes on openai/],
    [
      "a Claude action route without an anthropic audit route",
      (v) => {
        delete v.audit_routes.anthropic;
        v.specialists.estimator.actions = { "estimate.price": "claude_opus" };
      },
      /audit_routes\.anthropic is required: route claude_opus proposes on anthropic/,
    ],
    ["a family named like a v2 provider", (v) => (v.providers.codex.models["gpt-6.1-sol"].family = "codex"), /family is a v2 provider id; the family is openai/],
    ["a registry figure left unfilled", (v) => (v.providers.codex.models["gpt-6.1-sol"].context_tokens = null), /context_tokens is not filled: take it from the provider's docs/],
    ["an output limit at the context window", (v) => (v.providers.codex.models["gpt-6.1-sol"].max_output_tokens = 1050000), /max_output_tokens must be below context_tokens/],
    ["a figure neither cited nor marked unverified", (v) => delete v.providers.codex.models["gpt-6.1-sol"].sources.price, /sources\.price is required: cite the provider doc/],
    [
      "a figure both cited and marked unverified",
      (v) => (v.providers.codex.models["gpt-6.1-sol"].unverified = ["price"]),
      /sources\.price cites a figure listed as unverified/,
    ],
    ["an unknown figure", (v) => (v.providers.codex.models["gpt-6.1-sol"].unverified = ["latency"]), /unverified\[0\] must be one of context_tokens, max_output_tokens, price/],
    ["an API price on a subscription account", (v) => (v.providers.codex.models["gpt-6.1-sol"].price = { usd_per_mtok: { input: 1, cached_input: 0, output: 1 } }), /price\.usd_per_mtok is not a known field/],
    ["a malformed rate limit", (v) => (v.providers.codex.models["gpt-6.1-sol"].rate_limits.requests_per_minute = 0), /requests_per_minute must be a positive integer/],
    ["a billing that does not match the credential", (v) => (v.providers.claude.billing = "api"), /claude\.billing must be subscription with credential_mode oauth/],
    ["an unknown compliance ref", (v) => (v.providers.claude.compliance_ref = "ai.anthropic.enterprise"), /compliance_ref must be one of ai\.anthropic\.api/],
    ["a compliance ref of another adapter", (v) => (v.providers.claude.compliance_ref = "ai.openai.chatgpt-commercial"), /ai\.openai\.chatgpt-commercial is an account behind codex/],
    ["an API ref on a sign-in", (v) => (v.providers.claude.compliance_ref = "ai.anthropic.api"), /ai\.anthropic\.api is an account behind claude_agent_sdk with credential_mode api_key/],
    ["a personal plan under the commercial ref", (v) => (v.providers.codex.chatgpt_plans = ["business", "pro"]), /chatgpt_plans lists consumer plans \(pro\), which ai\.openai\.chatgpt-commercial does not cover/],
    ["a retention confirmation on a ref that needs none", (v) => (v.providers.claude.confirmed_retention = { confirmed_by: "owner", reference: "x" }), /claude\.confirmed_retention applies only to a compliance_ref that needs a retention confirmation/],
    ["a retention confirmation not by the owner", (v) => (v.providers.codex.confirmed_retention = { confirmed_by: "ops", reference: "x" }), /confirmed_retention\.confirmed_by must be owner/],
    ["a risk acceptance on a commercial ref", (v) => (v.owner_risk_acceptances = [{ ref: "ai.openai.chatgpt-commercial", run_class: "eval_history", accepted_by: "owner", reason: "x" }]), /owner_risk_acceptances\[0\]\.ref must be one of ai\.anthropic\.claude-consumer, ai\.openai\.chatgpt-consumer/],
    ["a risk acceptance for live runs", (v) => (v.owner_risk_acceptances = [{ ref: "ai.openai.chatgpt-consumer", run_class: "live", accepted_by: "owner", reason: "x" }]), /run_class must be eval_history: live and shadow runs on a consumer ref are never accepted/],
    ["a risk acceptance by anyone but the owner", (v) => (v.owner_risk_acceptances = [{ ref: "ai.openai.chatgpt-consumer", run_class: "eval_history", accepted_by: "ops", reason: "x" }]), /accepted_by must be owner/],
    ["no risk acceptance list", (v) => delete v.owner_risk_acceptances, /\$\.owner_risk_acceptances is required/],
    ["a fallback naming no route", (v) => (v.routes.codex_sol.fallback = "codex_turbo"), /routes\.codex_sol\.fallback names no route/],
    ["a fallback to itself", (v) => (v.routes.codex_sol.fallback = "codex_sol"), /routes\.codex_sol\.fallback chain loops back to codex_sol/],
    [
      "a fallback cycle",
      (v) => {
        v.routes.codex_sol.fallback = "codex_astra";
        v.routes.codex_astra.fallback = "codex_sol";
      },
      /chain loops back to codex_sol/,
    ],
    [
      "a fallback chain three hops deep",
      (v) => {
        v.providers.codex.models.a1 = entry("openai");
        v.providers.codex.models.a2 = entry("openai");
        v.routes.spare_one = { provider: "codex", model: "a1", effort: "high", fallback: "spare_two" };
        v.routes.spare_two = { provider: "codex", model: "a2", effort: "high", fallback: null };
        v.routes.codex_sol.fallback = "codex_astra";
        v.routes.codex_astra.fallback = "spare_one";
      },
      /routes\.codex_sol\.fallback chain is deeper than 2 fallbacks/,
    ],
    ["a proposer fallback on another family", (v) => (v.routes.codex_sol.fallback = "claude_opus"), /chain reaches claude_opus on anthropic; a fallback stays on its route's family \(openai\)/],
    [
      "a chain whose attempts the Worker would not count",
      (v) => {
        v.retry.max_attempts = 4;
        v.routes.codex_sol.fallback = "codex_astra";
        v.providers.codex.models.a1 = entry("openai");
        v.routes.spare_one = { provider: "codex", model: "a1", effort: "high", fallback: null };
        v.routes.codex_astra.fallback = "spare_one";
      },
      /max_attempts times the 3 hops of the longest fallback chain exceeds the 10 attempts a run may take/,
    ],
    ["an auditor with a route of its own", (v) => (v.specialists.independent_auditor.route = "codex_astra"), /routed by tiers\.audit and audit_routes only/],
    ["an auditor with an action route", (v) => (v.specialists.independent_auditor.actions = { "audit.review": "codex_astra" }), /routed by tiers\.audit and audit_routes only/],
    ["an auditor that may also propose", (v) => (v.specialists.independent_auditor.tiers = ["audit", "routine"]), /exactly the audit tier/],
    ["an auditor moved to a proposer tier", (v) => (v.specialists.independent_auditor.tiers = ["routine"]), /exactly the audit tier/],
    ["a proposer on the audit tier", (v) => (v.specialists.estimator.tiers = ["audit"]), /only the independent auditor/],
    ["no auditor at all", (v) => delete v.specialists.independent_auditor, /independent_auditor is required/],
    ["a ceiling for an unregistered specialist", (v) => (v.ceilings.specialists.ghost = { calls: 1, cost_usd: 1, cost_usd_per_call: 1 }), /not a registered specialist/],
    ["a per-call ceiling above the window ceiling", (v) => (v.ceilings.specialist_default.cost_usd_per_call = 99), /exceeds cost_usd/],
    ["a token ceiling without its per-call share", (v) => (v.ceilings.specialist_default.tokens = 1000), /specialist_default sets tokens and tokens_per_call together or neither/],
    ["no shadow budget", (v) => delete v.ceilings.shadow, /ceilings\.shadow is required/],
    ["an unknown shadow field", (v) => (v.ceilings.shadow.live_share = 1), /ceilings\.shadow\.live_share is not a known field/],
    ["a shadow per-call ceiling above its window ceiling", (v) => (v.ceilings.shadow.specialist.cost_usd_per_call = 4), /shadow\.specialist\.cost_usd_per_call exceeds cost_usd/],
    ["more attempts than the Worker counts", (v) => (v.retry.max_attempts = 11), /max_attempts must be 1-10/],
    ["no ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = []), /chatgpt_plans must list at least one plan/],
    ["a malformed ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = ["Pro Plan"]), /chatgpt_plans must hold plan names/],
    ["a repeated ChatGPT plan", (v) => (v.providers.codex.chatgpt_plans = ["business", "business"]), /chatgpt_plans must not repeat/],
    ["no ChatGPT plan list", (v) => delete v.providers.codex.chatgpt_plans, /chatgpt_plans is required/],
  ];
  for (const [name, mutate, message] of cases) {
    const value = raw();
    mutate(value);
    assert.throws(() => parseGatewayConfig(value), message, name);
  }
});

test("a model with no USD figure books against token ceilings, so every ceiling it can reach must have them", () => {
  const noPrice = (v: any) => (v.providers.codex.models["gpt-6.1-sol"].price.list_usd_per_mtok = null);
  const value = raw();
  noPrice(value);
  assert.throws(() => parseGatewayConfig(value), /routes\.codex_sol\.model has no USD price, so every ceiling it can book against needs tokens and tokens_per_call/);
  const bounded = raw();
  noPrice(bounded);
  const { ceilings } = bounded;
  for (const team of [ceilings.team, ceilings.shadow.team]) team.tokens = 50_000_000;
  for (const own of [ceilings.specialist_default, ceilings.shadow.specialist, ...Object.values(ceilings.specialists)] as Array<Record<string, number>>) {
    own.tokens = 5_000_000;
    own.tokens_per_call = 400_000;
  }
  const config = parseGatewayConfig(bounded);
  assert.equal(config.providers.codex.models["gpt-6.1-sol"].price.usdPerMTok, null);
  assert.deepEqual([config.ceilings.specialistDefault.tokens, config.ceilings.specialistDefault.tokensPerCall], [5_000_000, 400_000]);
  // The eval books of qualification.v1.json have no token ceilings, so an eval gateway refuses that route.
  assert.throws(() => parseQualification(qualification(), config), /for_claude_proposers\.model has no USD price/);
  const judgedElsewhere = qualification();
  judgedElsewhere.judge.for_claude_proposers = { provider: "codex", model: "gpt-6-astra", effort: "high" };
  assert.throws(() => parseQualification(judgedElsewhere, config), /routes\.codex_sol\.model \(on the eval books\) has no USD price/);
  // The Claude Agent SDK reports its own cost, so a Claude model needs no list price.
  const sdk = raw();
  sdk.providers.claude.models["claude-opus-5-5"].price.list_usd_per_mtok = null;
  delete sdk.providers.claude.models["claude-opus-5-5"].sources.price;
  assert.equal(parseGatewayConfig(sdk).providers.claude.models["claude-opus-5-5"].price.usdPerMTok, null);
});

test("prototype names are refused wherever the configuration keys or names a route, model, ceiling or specialist", () => {
  const route = { provider: "codex", model: "gpt-6.1-sol", effort: "low", fallback: null };
  const ceiling = { calls: 1, cost_usd: 1, cost_usd_per_call: 1 };
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["a model named toString", (v) => (v.routes.codex_sol.model = "toString"), /routes\.codex_sol\.model has no registry entry/],
    ["a model named constructor", (v) => (v.routes.codex_astra.model = "constructor"), /routes\.codex_astra\.model has no registry entry/],
    ["a provider named constructor", (v) => (v.routes.codex_sol.provider = "constructor"), /routes\.codex_sol\.provider names no provider/],
    ["a provider keyed __proto__", (v) => own(v.providers, "__proto__", v.providers.codex), /providers\.__proto__ is not a provider id/],
    ["a model keyed __proto__", (v) => own(v.providers.codex.models, "__proto__", entry("openai")), /models\.__proto__ is not a model id/],
    ["a ceiling keyed __proto__", (v) => own(v.ceilings.specialists, "__proto__", ceiling), /ceilings\.specialists\.__proto__ is not a specialist id/],
    ["a ceiling keyed constructor", (v) => own(v.ceilings.specialists, "constructor", ceiling), /ceilings\.specialists\.constructor is not a registered specialist/],
    ["a route keyed __proto__", (v) => own(v.routes, "__proto__", route), /routes\.__proto__ is not a route id/],
    ["a route keyed toString", (v) => own(v.routes, "toString", route), /routes\.toString is not a route id/],
    ["a tier naming constructor", (v) => (v.tiers.routine = "constructor"), /tiers\.routine names no route/],
    ["a tier naming __proto__", (v) => (v.tiers.hard = "__proto__"), /tiers\.hard names no route/],
    ["a fallback naming hasOwnProperty", (v) => (v.routes.codex_sol.fallback = "hasOwnProperty"), /routes\.codex_sol\.fallback names no route/],
    ["an audit route naming toString", (v) => (v.audit_routes.openai = "toString"), /audit_routes\.openai names no route/],
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
  assert.deepEqual(config.routes[config.tiers.routine], { provider: "codex", model: "gpt-6.1-sol", effort: "low" });
  assert.deepEqual(chainOf(config, "constructor"), ["constructor"]);
});

test("the shipped qualification blocks parse into isolated eval books with registry judge routes", () => {
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
  assert.ok(shipped.gateway_reasons.stop.includes("no_qualified_route"));
});

test("qualification blocks that would mix eval and production spend, or judge off the registry, are refused", () => {
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
    ["a judge on an unregistered model", (q) => (q.judge.for_claude_proposers.model = "gpt-7"), /for_claude_proposers\.model has no registry entry in \$\.providers\.codex\.models/],
    ["a judge model named toString", (q) => (q.judge.for_claude_proposers.model = "toString"), /for_claude_proposers\.model has no registry entry/],
    ["a judge on no configured provider", (q) => (q.judge.default.provider = "gemini"), /qualification\.judge\.default\.provider names no provider in \$\.providers/],
  ];
  for (const [name, mutate, message] of cases) {
    const value = qualification();
    mutate(value);
    assert.throws(() => parseQualification(value, shippedConfig()), message, name);
  }
});

test("the converter turns the shipped v2 file into the committed v3 once an operator fills what v2 never held", () => {
  const v2 = JSON.parse(readFileSync(V2_PATH, "utf8"));
  const converted = upgradeConfig(v2) as any;
  // The runtime refuses the raw output: its figures and refs are the operator's to fill.
  assert.throws(() => parseGatewayConfig(converted), /context_tokens is not filled/);
  assert.deepEqual(converted.audit_routes, { openai: "claude_opus", anthropic: "codex_astra" });
  assert.ok(Object.values(converted.routes).every((route: any) => route.fallback === null));
  // v2's prices move into the registry, uncited.
  assert.deepEqual(converted.providers.codex.models["gpt-6.1-sol"].price, { subscription: "chatgpt", list_usd_per_mtok: { input: 2, cached_input: 0.2, output: 10 } });
  assert.deepEqual(converted.providers.codex.models["gpt-6.1-sol"].unverified, ["price"]);
  assert.deepEqual([converted.providers.claude.compliance_ref, converted.providers.codex.compliance_ref], [null, null]);
  // What the operator filled: compliance refs and plans from the register, figures from provider
  // docs, and the judge's own model. Everything else is the converter's.
  const committed = raw();
  for (const [id, account] of Object.entries(converted.providers) as Array<[string, any]>) {
    const target = committed.providers[id];
    for (const key of ["compliance_ref", "confirmed_retention", "chatgpt_plans"]) {
      if (Object.hasOwn(target, key)) account[key] = target[key];
    }
    for (const [model, filled] of Object.entries(target.models) as Array<[string, any]>) {
      if (!Object.hasOwn(account.models, model)) {
        account.models[model] = filled;
        continue;
      }
      for (const key of ["context_tokens", "max_output_tokens", "efforts", "price", "unverified", "sources"]) account.models[model][key] = filled[key];
    }
  }
  assert.deepEqual(converted, committed);
});

test("the converter runs as a command, writing v3 to stdout and refusing anything but a v2 file", () => {
  const ok = spawnSync(process.execPath, [CONVERTER, V2_PATH], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), upgradeConfig(JSON.parse(readFileSync(V2_PATH, "utf8"))));
  const v3 = spawnSync(process.execPath, [CONVERTER, CONFIG_PATH], { encoding: "utf8" });
  assert.equal(v3.status, 2);
  assert.match(v3.stderr, /schema must be ironwrap_agent_gateway_config_v2/);
  const none = spawnSync(process.execPath, [CONVERTER], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: node src\/gateway\/upgrade-config\.ts/);
});

test("the consumer configuration differs from the shipped one only in its accounts' labels", () => {
  const consumer = JSON.parse(readFileSync(CONSUMER_CONFIG_PATH, "utf8"));
  const shipped = raw();
  const parsed = parseGatewayConfig(consumer);
  assert.deepEqual([parsed.providers.claude.complianceRef, parsed.providers.codex.complianceRef], ["ai.anthropic.claude-consumer", "ai.openai.chatgpt-consumer"]);
  assert.ok(parsed.providers.codex.adapter === "codex" && parsed.providers.codex.chatgptPlans.includes("pro"));
  for (const ref of ["ai.anthropic.claude-consumer", "ai.openai.chatgpt-consumer"]) assert.equal(COMPLIANCE_REFS[ref].consumer, true);
  for (const config of [consumer, shipped]) {
    for (const account of Object.values(config.providers) as Array<Record<string, unknown>>) {
      for (const key of ["compliance_ref", "confirmed_retention", "chatgpt_plans"]) delete account[key];
    }
  }
  assert.deepEqual(consumer, shipped);
});
