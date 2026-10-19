// Gateway configuration (v3): the tenant's provider accounts, each with its model registry, then
// routes with their declared fallbacks, ceilings and retry. One file per host is the tenant's
// configuration. Credentials are named by environment variable, never held. Moving an account from a
// subscription sign-in to an API key changes its `credential_mode`, `billing` and `compliance_ref`
// and nothing else. A v2 file is refused; `upgrade-config.ts` converts it.

import { readFileSync } from "node:fs";
import { COMPLIANCE_REFS, CONSUMER_CHATGPT_PLANS } from "./compliance.ts";
import { booksUsd, entryOf, familyOf } from "./registry.ts";
import { canonicalJson, sha256 } from "./schema.ts";
import type { Billing, CredentialMode, Effort, Family, Figure, ModelEntry, ProviderId, RiskAcceptance, Route, Tier, UsdPerMTok } from "./types.ts";

export const GATEWAY_CONFIG_SCHEMA = "ironwrap_agent_gateway_config_v3";
export const GATEWAY_CONFIG_SCHEMA_V2 = "ironwrap_agent_gateway_config_v2";

export interface Ceiling {
  calls: number;
  costUsd: number;
  /** Optional token ceiling; required wherever a model with no USD figure can book. */
  tokens?: number;
}

export interface SpecialistCeiling extends Ceiling {
  costUsdPerCall: number;
  /** Booked on each call when the ceiling has `tokens`. */
  tokensPerCall?: number;
}

export interface SpecialistRouting {
  tiers: Tier[];
  /** A route id used instead of the tier's route for every run; null keeps the tier's. */
  route: string | null;
  /** Route ids by expected catalog action; a match wins over `route`. */
  actions: Record<string, string>;
}

interface AccountBase {
  id: ProviderId;
  enabled: boolean;
  billing: Billing;
  credentialMode: CredentialMode;
  /** The docs/COMPLIANCE-REGISTER.md row the account is on; null serves no run. */
  complianceRef: string | null;
  /** The owner's written confirmation of the account's retention, for a ref that needs one. */
  confirmedRetention: { confirmedBy: "owner"; reference: string } | null;
  models: Record<string, ModelEntry>;
}

export interface ClaudeAccount extends AccountBase {
  adapter: "claude_agent_sdk";
  oauthTokenEnv: string;
  apiKeyEnv: string;
  executablePath: string | null;
}

export interface CodexAccount extends AccountBase {
  adapter: "codex";
  apiKeyEnv: string;
  codexHomeEnv: string;
  signinMaxAgeHours: number;
  /** ChatGPT plans that include every routed Codex model; another signed-in plan is not ready. */
  chatgptPlans: string[];
}

export type ProviderConfig = ClaudeAccount | CodexAccount;

export interface GatewayConfig {
  /** SHA-256 of the canonical JSON of the configuration, recorded on every run. */
  sha256: string;
  providers: Record<ProviderId, ProviderConfig>;
  routes: Record<string, Route>;
  /** Each route's declared fallback route id, or null. */
  fallbacks: Record<string, string | null>;
  /** Route id per tier; `audit` serves an auditor run that reviews no other run. */
  tiers: Record<Tier, string>;
  /** Route id that audits work proposed on each family; its whole chain is of another family. */
  auditRoutes: Record<Family, string>;
  ownerRiskAcceptances: RiskAcceptance[];
  ceilings: {
    windowHours: number;
    team: Ceiling;
    specialistDefault: SpecialistCeiling;
    specialists: Record<string, SpecialistCeiling>;
    /** Shadow runs spend only this budget, and never count toward the live ceilings. */
    shadow: { team: Ceiling; specialist: SpecialistCeiling };
  };
  /** `authProbeAfterMs`: how long a rejected credential is left alone before one probe call. */
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; authProbeAfterMs: number };
  timeoutMs: number;
  maxTurns: number;
  specialists: Record<string, SpecialistRouting>;
}

/** The isolated eval books of a qualification run (`agent-host/evals/qualification.v1.json`). */
export interface Qualification {
  windowHours: number;
  team: Ceiling;
  /** Every specialist's ceiling under `eval:<specialist>`. */
  specialist: SpecialistCeiling;
  /** Judge calls book under `eval:<judgeKey>`, which is no registered specialist. */
  judgeKey: string;
  judge: SpecialistCeiling;
  /** `judge.for_claude_proposers` scores runs proposed on the `anthropic` family, `judge.default` every other. */
  judgeRoutes: { default: Route; for_claude_proposers: Route };
}

const TIERS: Tier[] = ["routine", "hard", "audit"];
export const AUDITOR = "independent_auditor";
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const ADAPTERS = ["claude_agent_sdk", "codex"] as const;
const FIGURES: Figure[] = ["context_tokens", "max_output_tokens", "price"];
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SPECIALIST_ID = /^[a-z][a-z0-9_]{1,63}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_]{1,30}$/;
const FAMILY = /^[a-z][a-z0-9_]{1,31}$/;
const LABEL = /^[a-z][a-z0-9_]{1,40}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ROUTE_ID = /^[a-z][a-z0-9_]{1,40}$/;
const ACTION_ID = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
/** The Worker counts at most 10 attempts on a close: a run's whole chain must stay within them. */
const MAX_RUN_ATTEMPTS = 10;
const MAX_FALLBACK_DEPTH = 2;

export function loadGatewayConfig(path: string): GatewayConfig {
  return parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  const root = object(raw, "$");
  if (root.schema === GATEWAY_CONFIG_SCHEMA_V2) {
    fail("$.schema", `is ${GATEWAY_CONFIG_SCHEMA_V2}: convert the file with \`node src/gateway/upgrade-config.ts <file>\` and fill its registry from provider docs`);
  }
  exactKeys(root, ["schema", "providers", "routes", "tiers", "audit_routes", "owner_risk_acceptances", "ceilings", "retry", "timeout_ms", "max_turns", "specialists"], "$");
  if (root.schema !== GATEWAY_CONFIG_SCHEMA) fail("$.schema", `must be ${GATEWAY_CONFIG_SCHEMA}`);

  const providers = parseProviders(root.providers);
  const { routes, fallbacks } = parseRoutes(root.routes, providers);
  const config: GatewayConfig = {
    sha256: sha256(canonicalJson(raw)),
    providers,
    routes,
    fallbacks,
    tiers: parseTiers(root.tiers, routes),
    auditRoutes: {},
    ownerRiskAcceptances: parseAcceptances(root.owner_risk_acceptances),
    ceilings: parseCeilings(root.ceilings),
    retry: parseRetry(root.retry),
    timeoutMs: positive(root.timeout_ms, "$.timeout_ms"),
    maxTurns: positive(root.max_turns, "$.max_turns"),
    specialists: parseSpecialists(root.specialists, routes),
  };
  checkChains(config);
  config.auditRoutes = parseAuditRoutes(root.audit_routes, config);
  // Independence is per run: work proposed on a family is audited on that family's audit route,
  // so every family a proposer can run on, fallbacks included, needs one.
  for (const id of proposerRoutes(config)) {
    const family = familyOf(config, config.routes[id]);
    if (!Object.hasOwn(config.auditRoutes, family)) fail(`$.audit_routes.${family}`, `is required: route ${id} proposes on ${family}`);
  }
  for (const id of Object.keys(config.ceilings.specialists)) {
    if (!Object.hasOwn(config.specialists, id)) fail(`$.ceilings.specialists.${id}`, "is not a registered specialist");
  }
  const { ceilings } = config;
  const live = [ceilings.team, ceilings.specialistDefault, ...Object.values(ceilings.specialists), ceilings.shadow.team, ceilings.shadow.specialist];
  for (const [id, route] of Object.entries(config.routes)) requireBookable(config, route, live, `$.routes.${id}.model`);
  return config;
}

/**
 * Every route a proposing run can take: the routine and hard tiers', each proposer's own and action
 * routes, and their declared fallbacks.
 */
export function proposerRoutes(config: Pick<GatewayConfig, "tiers" | "specialists" | "fallbacks">): string[] {
  const ids = [config.tiers.routine, config.tiers.hard];
  for (const [id, specialist] of Object.entries(config.specialists)) {
    if (id === AUDITOR) continue;
    if (specialist.route !== null) ids.push(specialist.route);
    ids.push(...Object.values(specialist.actions));
  }
  return [...new Set(ids.flatMap((id) => chainOf(config, id)))];
}

/** A route and its declared fallbacks, in the order a production run tries them. */
export function chainOf(config: Pick<GatewayConfig, "fallbacks">, id: string): string[] {
  const chain = [id];
  for (let next = fallbackOf(config, id); next !== null; next = fallbackOf(config, next)) chain.push(next);
  return chain;
}

function fallbackOf(config: Pick<GatewayConfig, "fallbacks">, id: string): string | null {
  return Object.hasOwn(config.fallbacks, id) ? config.fallbacks[id] : null;
}

/**
 * Parses the `ledger` and `judge` blocks of the qualification config for an eval gateway. The eval
 * books must be isolated and tagged, and a judge route needs a registry entry like any route.
 */
export function parseQualification(raw: { ledger: unknown; judge: unknown }, config: GatewayConfig): Qualification {
  const ledgerPath = "qualification.ledger";
  const ledger = object(raw.ledger, ledgerPath);
  exactKeys(ledger, ["isolated", "namespace", "requires_run_tag", "per_stage", "window_hours", "team", "specialist", "judge_key", "judge"], ledgerPath);
  if (ledger.isolated !== true) fail(`${ledgerPath}.isolated`, "must be true: eval spend never shares the production books");
  if (ledger.namespace !== "eval") fail(`${ledgerPath}.namespace`, "must be eval");
  if (ledger.requires_run_tag !== "eval") fail(`${ledgerPath}.requires_run_tag`, "must be eval");
  bool(ledger.per_stage, `${ledgerPath}.per_stage`);
  const judgeKey = text(ledger.judge_key, `${ledgerPath}.judge_key`);
  if (!SPECIALIST_ID.test(judgeKey)) fail(`${ledgerPath}.judge_key`, "is not a ledger key");
  if (Object.hasOwn(config.specialists, judgeKey)) fail(`${ledgerPath}.judge_key`, "must not be a registered specialist");

  const judgePath = "qualification.judge";
  const judge = object(raw.judge, judgePath);
  exactKeys(judge, ["instructions", "default", "for_claude_proposers", "max_attempts"], judgePath);
  text(judge.instructions, `${judgePath}.instructions`);
  positive(judge.max_attempts, `${judgePath}.max_attempts`);
  const judgeRoutes = {
    default: parseRoute(judge.default, `${judgePath}.default`, config),
    for_claude_proposers: parseRoute(judge.for_claude_proposers, `${judgePath}.for_claude_proposers`, config),
  };
  const qualification: Qualification = {
    windowHours: positive(ledger.window_hours, `${ledgerPath}.window_hours`),
    team: teamCeiling(ledger.team, `${ledgerPath}.team`),
    specialist: specialistCeiling(ledger.specialist, `${ledgerPath}.specialist`),
    judgeKey,
    judge: specialistCeiling(ledger.judge, `${ledgerPath}.judge`),
    judgeRoutes,
  };
  const books = [qualification.team, qualification.specialist, qualification.judge];
  for (const [field, route] of Object.entries(judgeRoutes)) requireBookable(config, route, books, `${judgePath}.${field}.model`);
  for (const [id, route] of Object.entries(config.routes)) requireBookable(config, route, books, `$.routes.${id}.model (on the eval books)`);
  return qualification;
}

/**
 * A route of the registry: a configured provider, a model with an entry there, and an effort that
 * entry lists. Throws `gateway_config_invalid` naming the path otherwise.
 */
export function parseRoute(raw: unknown, path: string, config: Pick<GatewayConfig, "providers">): Route {
  const route = object(raw, path);
  exactKeys(route, ["provider", "model", "effort"], path);
  return routeOf(route, path, config.providers);
}

/**
 * A model with no USD figure books tokens instead, so every ceiling a route of it can book against
 * needs `tokens` (and a per-call `tokens_per_call`).
 */
export function requireBookable(config: Pick<GatewayConfig, "providers">, route: Route, ceilings: Array<Ceiling | SpecialistCeiling>, path: string): void {
  const entry = entryOf(config, route) as ModelEntry;
  if (booksUsd(config.providers[route.provider].adapter, entry)) return;
  const unbounded = ceilings.some((ceiling) => ceiling.tokens === undefined || ("costUsdPerCall" in ceiling && ceiling.tokensPerCall === undefined));
  if (unbounded) fail(path, `has no USD price, so every ceiling it can book against needs tokens and tokens_per_call`);
}

function routeOf(route: Record<string, unknown>, path: string, providers: Record<ProviderId, ProviderConfig>): Route {
  const provider = text(route.provider, `${path}.provider`);
  if (!Object.hasOwn(providers, provider)) fail(`${path}.provider`, "names no provider in $.providers");
  const model = text(route.model, `${path}.model`);
  if (!MODEL_ID.test(model)) fail(`${path}.model`, "is not a model id");
  const models = providers[provider].models;
  if (!Object.hasOwn(models, model)) fail(`${path}.model`, `has no registry entry in $.providers.${provider}.models; unregistered models are never routed`);
  const effort = text(route.effort, `${path}.effort`) as Effort;
  if (!EFFORTS.has(effort)) fail(`${path}.effort`, "is not an effort level");
  if (!Object.hasOwn(models[model].efforts, effort)) fail(`${path}.effort`, `is not an effort $.providers.${provider}.models.${model}.efforts lists`);
  return { provider, model, effort };
}

function parseProviders(raw: unknown): Record<ProviderId, ProviderConfig> {
  const providers = object(raw, "$.providers");
  if (Object.keys(providers).length === 0) fail("$.providers", "must name at least one provider account");
  const result: Record<ProviderId, ProviderConfig> = {};
  for (const [id, value] of Object.entries(providers)) {
    const path = `$.providers.${id}`;
    // Checked before the key is stored: a `__proto__` key would replace the record's prototype.
    if (!PROVIDER_ID.test(id)) fail(path, "is not a provider id");
    const entry = object(value, path);
    const adapter = oneOf(entry.adapter, ADAPTERS, `${path}.adapter`);
    const own = adapter === "claude_agent_sdk" ? ["executable_path"] : ["signin_max_age_hours", "chatgpt_plans"];
    keys(entry, ["adapter", "enabled", "billing", "credential_mode", "secrets", "compliance_ref", "models", ...own], ["confirmed_retention"], path);
    const credentialMode = oneOf(entry.credential_mode, ["oauth", "api_key"] as const, `${path}.credential_mode`);
    const billing = oneOf(entry.billing, ["subscription", "api"] as const, `${path}.billing`);
    // A sign-in bills the subscription; an API key bills per token.
    const expected: Billing = credentialMode === "oauth" ? "subscription" : "api";
    if (billing !== expected) fail(`${path}.billing`, `must be ${expected} with credential_mode ${credentialMode}`);
    const secrets = object(entry.secrets, `${path}.secrets`);
    exactKeys(secrets, adapter === "claude_agent_sdk" ? ["oauth_token_env", "api_key_env"] : ["api_key_env", "codex_home_env"], `${path}.secrets`);
    const complianceRef = entry.compliance_ref === null ? null : oneOf(entry.compliance_ref, Object.keys(COMPLIANCE_REFS), `${path}.compliance_ref`);
    if (complianceRef !== null) {
      const ref = COMPLIANCE_REFS[complianceRef];
      if (ref.adapter !== adapter || ref.credentialMode !== credentialMode) {
        fail(`${path}.compliance_ref`, `${complianceRef} is an account behind ${ref.adapter} with credential_mode ${ref.credentialMode}`);
      }
    }
    const base = {
      id,
      enabled: bool(entry.enabled, `${path}.enabled`),
      billing,
      credentialMode,
      complianceRef,
      confirmedRetention: parseRetention(entry.confirmed_retention, complianceRef, `${path}.confirmed_retention`),
      models: parseModels(entry.models, `${path}.models`, adapter, billing),
    };
    if (adapter === "claude_agent_sdk") {
      result[id] = {
        ...base,
        adapter,
        oauthTokenEnv: envName(secrets.oauth_token_env, `${path}.secrets.oauth_token_env`),
        apiKeyEnv: envName(secrets.api_key_env, `${path}.secrets.api_key_env`),
        executablePath: entry.executable_path === null ? null : text(entry.executable_path, `${path}.executable_path`),
      };
    } else {
      const chatgptPlans = plans(entry.chatgpt_plans, `${path}.chatgpt_plans`);
      const consumer = chatgptPlans.filter((plan) => CONSUMER_CHATGPT_PLANS.has(plan));
      if (complianceRef === "ai.openai.chatgpt-commercial" && consumer.length > 0) {
        fail(`${path}.chatgpt_plans`, `lists consumer plans (${consumer.join(", ")}), which ${complianceRef} does not cover`);
      }
      result[id] = {
        ...base,
        adapter,
        apiKeyEnv: envName(secrets.api_key_env, `${path}.secrets.api_key_env`),
        codexHomeEnv: envName(secrets.codex_home_env, `${path}.secrets.codex_home_env`),
        signinMaxAgeHours: positive(entry.signin_max_age_hours, `${path}.signin_max_age_hours`),
        chatgptPlans,
      };
    }
  }
  return result;
}

function parseRetention(raw: unknown, complianceRef: string | null, path: string): AccountBase["confirmedRetention"] {
  if (raw === undefined || raw === null) return null;
  if (complianceRef === null || !COMPLIANCE_REFS[complianceRef].retentionConfirmation) fail(path, "applies only to a compliance_ref that needs a retention confirmation");
  const value = object(raw, path);
  exactKeys(value, ["confirmed_by", "reference"], path);
  if (value.confirmed_by !== "owner") fail(`${path}.confirmed_by`, "must be owner");
  const reference = text(value.reference, `${path}.reference`);
  if (reference.length > 300) fail(`${path}.reference`, "must be at most 300 characters");
  return { confirmedBy: "owner", reference };
}

function parseModels(raw: unknown, path: string, adapter: ProviderConfig["adapter"], billing: Billing): Record<string, ModelEntry> {
  const models = object(raw, path);
  if (Object.keys(models).length === 0) fail(path, "must hold at least one model");
  const result: Record<string, ModelEntry> = {};
  for (const [model, value] of Object.entries(models)) {
    const at = `${path}.${model}`;
    if (!MODEL_ID.test(model)) fail(at, "is not a model id");
    const entry = object(value, at);
    exactKeys(entry, ["family", "tools", "json_schema", "context_tokens", "max_output_tokens", "efforts", "price", "rate_limits", "unverified", "sources"], at);
    const family = text(entry.family, `${at}.family`);
    if (!FAMILY.test(family)) fail(`${at}.family`, "is not a family name");
    if (family === "claude" || family === "codex") fail(`${at}.family`, `is a v2 provider id; the family is ${family === "claude" ? "anthropic" : "openai"}`);
    const contextTokens = figure(entry.context_tokens, `${at}.context_tokens`);
    const maxOutputTokens = figure(entry.max_output_tokens, `${at}.max_output_tokens`);
    if (maxOutputTokens >= contextTokens) fail(`${at}.max_output_tokens`, "must be below context_tokens");
    const efforts = object(entry.efforts, `${at}.efforts`);
    if (Object.keys(efforts).length === 0) fail(`${at}.efforts`, "must list at least one effort");
    const parsedEfforts: ModelEntry["efforts"] = {};
    for (const [effort, fragment] of Object.entries(efforts)) {
      if (!EFFORTS.has(effort as Effort)) fail(`${at}.efforts.${effort}`, "is not an effort level");
      // The SDK adapters pass the effort natively; request fragments are for HTTP adapters.
      if (Object.keys(object(fragment, `${at}.efforts.${effort}`)).length > 0) fail(`${at}.efforts.${effort}`, `must be {}: ${adapter} takes the effort itself`);
      parsedEfforts[effort as Effort] = {};
    }
    const price = parsePrice(entry.price, `${at}.price`, billing);
    const unverified = list(entry.unverified, `${at}.unverified`).map((name, index) => oneOf(name, FIGURES, `${at}.unverified[${index}]`));
    if (new Set(unverified).size !== unverified.length) fail(`${at}.unverified`, "lists a figure twice");
    const sources: ModelEntry["sources"] = {};
    for (const [name, source] of Object.entries(object(entry.sources, `${at}.sources`))) {
      const key = oneOf(name, FIGURES, `${at}.sources.${name}`);
      const citation = text(source, `${at}.sources.${name}`);
      if (citation.length > 300) fail(`${at}.sources.${name}`, "must be at most 300 characters");
      if (unverified.includes(key)) fail(`${at}.sources.${name}`, "cites a figure listed as unverified");
      sources[key] = citation;
    }
    // Every figure is either cited (source and date read) or marked unverified; a price with no USD
    // figure has nothing to cite.
    const cited: Figure[] = price.usdPerMTok === null ? ["context_tokens", "max_output_tokens"] : FIGURES;
    for (const name of cited) {
      if (!unverified.includes(name) && !Object.hasOwn(sources, name)) fail(`${at}.sources.${name}`, "is required: cite the provider doc and the date it was read, or list the figure in unverified");
    }
    result[model] = {
      family,
      tools: bool(entry.tools, `${at}.tools`),
      jsonSchema: oneOf(entry.json_schema, ["native", "validated"] as const, `${at}.json_schema`),
      contextTokens,
      maxOutputTokens,
      efforts: parsedEfforts,
      price,
      rateLimits: parseRateLimits(entry.rate_limits, `${at}.rate_limits`),
      unverified,
      sources,
    };
  }
  return result;
}

function parsePrice(raw: unknown, path: string, billing: Billing): ModelEntry["price"] {
  const price = object(raw, path);
  if (billing === "api") {
    exactKeys(price, ["usd_per_mtok"], path);
    return { subscription: null, usdPerMTok: usdPerMTok(price.usd_per_mtok, `${path}.usd_per_mtok`) };
  }
  exactKeys(price, ["subscription", "list_usd_per_mtok"], path);
  const subscription = text(price.subscription, `${path}.subscription`);
  if (!LABEL.test(subscription)) fail(`${path}.subscription`, "must name the subscription, such as chatgpt");
  return { subscription, usdPerMTok: price.list_usd_per_mtok === null ? null : usdPerMTok(price.list_usd_per_mtok, `${path}.list_usd_per_mtok`) };
}

function usdPerMTok(raw: unknown, path: string): UsdPerMTok {
  const value = object(raw, path);
  keys(value, ["input", "cached_input", "output"], ["cache_write"], path);
  return {
    input: nonNegative(value.input, `${path}.input`),
    cachedInput: nonNegative(value.cached_input, `${path}.cached_input`),
    output: nonNegative(value.output, `${path}.output`),
    ...(value.cache_write === undefined ? {} : { cacheWrite: nonNegative(value.cache_write, `${path}.cache_write`) }),
  };
}

function parseRateLimits(raw: unknown, path: string): ModelEntry["rateLimits"] {
  const limits = object(raw, path);
  exactKeys(limits, ["requests_per_minute", "input_tokens_per_minute", "output_tokens_per_minute"], path);
  const limit = (value: unknown, at: string) => (value === null ? null : count(value, at));
  return {
    requestsPerMinute: limit(limits.requests_per_minute, `${path}.requests_per_minute`),
    inputTokensPerMinute: limit(limits.input_tokens_per_minute, `${path}.input_tokens_per_minute`),
    outputTokensPerMinute: limit(limits.output_tokens_per_minute, `${path}.output_tokens_per_minute`),
  };
}

function parseRoutes(raw: unknown, providers: Record<ProviderId, ProviderConfig>): Pick<GatewayConfig, "routes" | "fallbacks"> {
  const entries = object(raw, "$.routes");
  const routes: Record<string, Route> = {};
  const fallbacks: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(entries)) {
    const path = `$.routes.${id}`;
    if (!ROUTE_ID.test(id)) fail(path, "is not a route id");
    const route = object(value, path);
    exactKeys(route, ["provider", "model", "effort", "fallback"], path);
    routes[id] = routeOf(route, path, providers);
  }
  for (const [id, value] of Object.entries(entries)) {
    const fallback = (value as Record<string, unknown>).fallback;
    fallbacks[id] = fallback === null ? null : routeRef(fallback, routes, `$.routes.${id}.fallback`);
  }
  return { routes, fallbacks };
}

/**
 * Fallback chains are acyclic, at most two hops deep, of one family, and short enough that the
 * whole chain's attempts stay within the Worker's per-run count.
 */
function checkChains(config: GatewayConfig): void {
  let deepest = 0;
  for (const id of Object.keys(config.routes)) {
    const seen = new Set([id]);
    const family = familyOf(config, config.routes[id]);
    for (let next = config.fallbacks[id]; next !== null; next = config.fallbacks[next]) {
      if (seen.has(next)) fail(`$.routes.${id}.fallback`, `chain loops back to ${next}`);
      seen.add(next);
      if (seen.size - 1 > MAX_FALLBACK_DEPTH) fail(`$.routes.${id}.fallback`, `chain is deeper than ${MAX_FALLBACK_DEPTH} fallbacks`);
      const hop = familyOf(config, config.routes[next]);
      if (hop !== family) fail(`$.routes.${id}.fallback`, `chain reaches ${next} on ${hop}; a fallback stays on its route's family (${family})`);
    }
    deepest = Math.max(deepest, seen.size - 1);
  }
  if (config.retry.maxAttempts * (deepest + 1) > MAX_RUN_ATTEMPTS) {
    fail("$.retry.max_attempts", `times the ${deepest + 1} hops of the longest fallback chain exceeds the ${MAX_RUN_ATTEMPTS} attempts a run may take`);
  }
}

function routeRef(value: unknown, routes: Record<string, Route>, path: string): string {
  const id = text(value, path);
  if (!Object.hasOwn(routes, id)) fail(path, `names no route in $.routes`);
  return id;
}

function parseTiers(raw: unknown, routes: Record<string, Route>): Record<Tier, string> {
  const tiers = object(raw, "$.tiers");
  exactKeys(tiers, TIERS, "$.tiers");
  return {
    routine: routeRef(tiers.routine, routes, "$.tiers.routine"),
    hard: routeRef(tiers.hard, routes, "$.tiers.hard"),
    audit: routeRef(tiers.audit, routes, "$.tiers.audit"),
  };
}

function parseAuditRoutes(raw: unknown, config: GatewayConfig): Record<Family, string> {
  const auditRoutes = object(raw, "$.audit_routes");
  const families = new Set(Object.values(config.providers).flatMap((account) => Object.values(account.models).map((entry) => entry.family)));
  const result: Record<Family, string> = {};
  for (const [family, value] of Object.entries(auditRoutes)) {
    const path = `$.audit_routes.${family}`;
    if (family === "claude" || family === "codex") {
      fail(path, "is keyed by a v2 provider id; audit_routes are keyed by family (convert v2 files with src/gateway/upgrade-config.ts)");
    }
    if (!FAMILY.test(family) || !families.has(family)) fail(path, `is not a model family of the registry (${[...families].join(", ")})`);
    const id = routeRef(value, config.routes, path);
    for (const hop of chainOf(config, id)) {
      if (familyOf(config, config.routes[hop]) === family) fail(path, `must name a route whose whole chain is of another family than ${family}`);
    }
    result[family] = id;
  }
  return result;
}

function parseAcceptances(raw: unknown): RiskAcceptance[] {
  const path = "$.owner_risk_acceptances";
  const consumer = Object.entries(COMPLIANCE_REFS).filter(([, ref]) => ref.consumer).map(([name]) => name);
  const result: RiskAcceptance[] = list(raw, path).map((value, index) => {
    const at = `${path}[${index}]`;
    const entry = object(value, at);
    exactKeys(entry, ["ref", "run_class", "accepted_by", "reason"], at);
    const ref = oneOf(entry.ref, consumer, `${at}.ref`);
    if (entry.run_class !== "eval_history") fail(`${at}.run_class`, "must be eval_history: live and shadow runs on a consumer ref are never accepted");
    if (entry.accepted_by !== "owner") fail(`${at}.accepted_by`, "must be owner");
    const reason = text(entry.reason, `${at}.reason`);
    if (reason.length > 500) fail(`${at}.reason`, "must be at most 500 characters");
    return { ref, runClass: "eval_history", reason };
  });
  if (new Set(result.map((entry) => entry.ref)).size !== result.length) fail(path, "accepts a ref twice");
  return result;
}

function parseCeilings(raw: unknown): GatewayConfig["ceilings"] {
  const ceilings = object(raw, "$.ceilings");
  exactKeys(ceilings, ["window_hours", "team", "specialist_default", "specialists", "shadow"], "$.ceilings");
  const specialists: Record<string, SpecialistCeiling> = {};
  for (const [id, value] of Object.entries(object(ceilings.specialists, "$.ceilings.specialists"))) {
    // Checked before the key is stored: a `__proto__` key would replace the record's prototype.
    if (!SPECIALIST_ID.test(id)) fail(`$.ceilings.specialists.${id}`, "is not a specialist id");
    specialists[id] = specialistCeiling(value, `$.ceilings.specialists.${id}`);
  }
  const shadow = object(ceilings.shadow, "$.ceilings.shadow");
  exactKeys(shadow, ["team", "specialist"], "$.ceilings.shadow");
  return {
    windowHours: positive(ceilings.window_hours, "$.ceilings.window_hours"),
    team: teamCeiling(ceilings.team, "$.ceilings.team"),
    specialistDefault: specialistCeiling(ceilings.specialist_default, "$.ceilings.specialist_default"),
    specialists,
    shadow: {
      team: teamCeiling(shadow.team, "$.ceilings.shadow.team"),
      specialist: specialistCeiling(shadow.specialist, "$.ceilings.shadow.specialist"),
    },
  };
}

function teamCeiling(raw: unknown, path: string): Ceiling {
  const team = object(raw, path);
  keys(team, ["calls", "cost_usd"], ["tokens"], path);
  return {
    calls: positive(team.calls, `${path}.calls`),
    costUsd: positive(team.cost_usd, `${path}.cost_usd`),
    ...(team.tokens === undefined ? {} : { tokens: count(team.tokens, `${path}.tokens`) }),
  };
}

function specialistCeiling(raw: unknown, path: string): SpecialistCeiling {
  const value = object(raw, path);
  keys(value, ["calls", "cost_usd", "cost_usd_per_call"], ["tokens", "tokens_per_call"], path);
  const ceiling: SpecialistCeiling = {
    calls: positive(value.calls, `${path}.calls`),
    costUsd: positive(value.cost_usd, `${path}.cost_usd`),
    costUsdPerCall: positive(value.cost_usd_per_call, `${path}.cost_usd_per_call`),
  };
  if (ceiling.costUsdPerCall > ceiling.costUsd) fail(`${path}.cost_usd_per_call`, "exceeds cost_usd");
  if ((value.tokens === undefined) !== (value.tokens_per_call === undefined)) fail(path, "sets tokens and tokens_per_call together or neither");
  if (value.tokens !== undefined) {
    ceiling.tokens = count(value.tokens, `${path}.tokens`);
    ceiling.tokensPerCall = count(value.tokens_per_call, `${path}.tokens_per_call`);
    if (ceiling.tokensPerCall > ceiling.tokens) fail(`${path}.tokens_per_call`, "exceeds tokens");
  }
  return ceiling;
}

function parseRetry(raw: unknown): GatewayConfig["retry"] {
  const retry = object(raw, "$.retry");
  exactKeys(retry, ["max_attempts", "base_delay_ms", "max_delay_ms", "auth_probe_after_ms"], "$.retry");
  const parsed = {
    maxAttempts: positive(retry.max_attempts, "$.retry.max_attempts"),
    baseDelayMs: positive(retry.base_delay_ms, "$.retry.base_delay_ms"),
    maxDelayMs: positive(retry.max_delay_ms, "$.retry.max_delay_ms"),
    authProbeAfterMs: positive(retry.auth_probe_after_ms, "$.retry.auth_probe_after_ms"),
  };
  if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts > MAX_RUN_ATTEMPTS) fail("$.retry.max_attempts", `must be 1-${MAX_RUN_ATTEMPTS}`);
  return parsed;
}

function parseSpecialists(raw: unknown, routes: Record<string, Route>): Record<string, SpecialistRouting> {
  const specialists = object(raw, "$.specialists");
  const result: Record<string, SpecialistRouting> = {};
  for (const [id, value] of Object.entries(specialists)) {
    const path = `$.specialists.${id}`;
    if (!SPECIALIST_ID.test(id)) fail(path, "is not a specialist id");
    const entry = object(value, path);
    exactKeys(entry, ["tiers", "route", "actions"], path);
    const tiers = entry.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) fail(`${path}.tiers`, "must list at least one tier");
    const parsed = (tiers as unknown[]).map((tier, index) => oneOf(tier, TIERS, `${path}.tiers[${index}]`));
    if (new Set(parsed).size !== parsed.length) fail(`${path}.tiers`, "lists a tier twice");
    // The auditor runs only on the audit tier, and nobody else does, so an audit is always an
    // auditor run and its route is picked per run by the work under review.
    if (id === AUDITOR && (parsed.length !== 1 || parsed[0] !== "audit")) {
      fail(`${path}.tiers`, "the independent auditor must use exactly the audit tier");
    }
    if (id !== AUDITOR && parsed.includes("audit")) fail(`${path}.tiers`, "only the independent auditor may use the audit tier");
    const route = entry.route === null ? null : routeRef(entry.route, routes, `${path}.route`);
    const actions: Record<string, string> = {};
    for (const [action, ref] of Object.entries(object(entry.actions, `${path}.actions`))) {
      if (!ACTION_ID.test(action)) fail(`${path}.actions.${action}`, "is not an action id");
      actions[action] = routeRef(ref, routes, `${path}.actions.${action}`);
    }
    if (id === AUDITOR && (route !== null || Object.keys(actions).length > 0)) {
      fail(path, "the independent auditor is routed by tiers.audit and audit_routes only");
    }
    result[id] = { tiers: parsed, route, actions };
  }
  if (!result[AUDITOR]) fail(`$.specialists.${AUDITOR}`, "is required");
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value as unknown[];
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  keys(value, allowed, [], path);
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, "is not a known field");
  }
  for (const key of required) {
    if (!(key in value)) fail(`${path}.${key}`, "is required");
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value as string;
}

function envName(value: unknown, path: string): string {
  const name = text(value, path);
  if (!ENV_NAME.test(name)) fail(path, "must be an environment variable name, never a value");
  return name;
}

function plans(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, "must list at least one plan");
  const items = value as unknown[];
  for (const plan of items) if (typeof plan !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(plan)) fail(path, "must hold plan names such as business");
  if (new Set(items).size !== items.length) fail(path, "must not repeat a plan");
  return items as string[];
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value as boolean;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(path, "must be a positive number");
  return value as number;
}

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path, "must be a positive integer");
  return value as number;
}

/** A registry figure; the converter writes null, which only provider docs can fill. */
function figure(value: unknown, path: string): number {
  if (value === null) fail(path, "is not filled: take it from the provider's docs and cite them in sources");
  return count(value, path);
}

function nonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path, "must be zero or more");
  return value as number;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) fail(path, `must be one of ${options.join(", ")}`);
  return value as T;
}

function fail(path: string, message: string): never {
  throw new Error(`gateway_config_invalid: ${path} ${message}`);
}
