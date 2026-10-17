// Gateway configuration: routing, credentials by environment-variable name, ceilings, retry.
// Swapping a provider from a subscription sign-in to an API key is a change to `auth` here and
// nothing else. The file never holds a secret value.

import { readFileSync } from "node:fs";
import type { Effort, ProviderId, Route, Tier } from "./types.ts";

export const GATEWAY_CONFIG_SCHEMA = "ironwrap_agent_gateway_config_v2";

export interface Ceiling {
  calls: number;
  costUsd: number;
}

export interface SpecialistCeiling extends Ceiling {
  costUsdPerCall: number;
}

export interface SpecialistRouting {
  tiers: Tier[];
  /** A route id used instead of the tier's route for every run; null keeps the tier's. */
  route: string | null;
  /** Route ids by expected catalog action; a match wins over `route`. */
  actions: Record<string, string>;
}

export interface GatewayConfig {
  providers: {
    claude: {
      enabled: boolean;
      auth: "oauth" | "api_key";
      oauthTokenEnv: string;
      apiKeyEnv: string;
      executablePath: string | null;
    };
    codex: {
      enabled: boolean;
      auth: "chatgpt" | "api_key";
      apiKeyEnv: string;
      codexHomeEnv: string;
      signinMaxAgeHours: number;
      /** ChatGPT plans that include every routed Codex model; another signed-in plan is not ready. */
      chatgptPlans: string[];
    };
  };
  routes: Record<string, Route>;
  /** Route id per tier; `audit` serves an auditor run that reviews no other run. */
  tiers: Record<Tier, string>;
  /** Route id that audits work proposed on each family; always a route of another family. */
  auditRoutes: Partial<Record<ProviderId, string>>;
  pricingUsdPerMTok: Record<string, { input: number; cachedInput: number; output: number }>;
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
  /** `judge.default` scores Codex-proposed runs, `judge.for_claude_proposers` Claude-proposed ones. */
  judgeRoutes: { default: Route; for_claude_proposers: Route };
}

const TIERS: Tier[] = ["routine", "hard", "audit"];
const PROVIDERS: ProviderId[] = ["claude", "codex"];
export const AUDITOR = "independent_auditor";
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SPECIALIST_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ROUTE_ID = /^[a-z][a-z0-9_]{1,40}$/;
const ACTION_ID = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

export function loadGatewayConfig(path: string): GatewayConfig {
  return parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  const root = object(raw, "$");
  exactKeys(root, [
    "schema",
    "providers",
    "routes",
    "tiers",
    "audit_routes",
    "pricing_usd_per_mtok",
    "ceilings",
    "retry",
    "timeout_ms",
    "max_turns",
    "specialists",
  ], "$");
  if (root.schema !== GATEWAY_CONFIG_SCHEMA) fail("$.schema", `must be ${GATEWAY_CONFIG_SCHEMA}`);

  const providers = object(root.providers, "$.providers");
  exactKeys(providers, ["claude", "codex"], "$.providers");
  const claude = object(providers.claude, "$.providers.claude");
  exactKeys(claude, ["enabled", "auth", "oauth_token_env", "api_key_env", "executable_path"], "$.providers.claude");
  const codex = object(providers.codex, "$.providers.codex");
  exactKeys(codex, ["enabled", "auth", "api_key_env", "codex_home_env", "signin_max_age_hours", "chatgpt_plans"], "$.providers.codex");

  const routes = parseRoutes(root.routes);
  const config: GatewayConfig = {
    providers: {
      claude: {
        enabled: bool(claude.enabled, "$.providers.claude.enabled"),
        auth: oneOf(claude.auth, ["oauth", "api_key"] as const, "$.providers.claude.auth"),
        oauthTokenEnv: envName(claude.oauth_token_env, "$.providers.claude.oauth_token_env"),
        apiKeyEnv: envName(claude.api_key_env, "$.providers.claude.api_key_env"),
        executablePath:
          claude.executable_path === null ? null : text(claude.executable_path, "$.providers.claude.executable_path"),
      },
      codex: {
        enabled: bool(codex.enabled, "$.providers.codex.enabled"),
        auth: oneOf(codex.auth, ["chatgpt", "api_key"] as const, "$.providers.codex.auth"),
        apiKeyEnv: envName(codex.api_key_env, "$.providers.codex.api_key_env"),
        codexHomeEnv: envName(codex.codex_home_env, "$.providers.codex.codex_home_env"),
        signinMaxAgeHours: positive(codex.signin_max_age_hours, "$.providers.codex.signin_max_age_hours"),
        chatgptPlans: plans(codex.chatgpt_plans, "$.providers.codex.chatgpt_plans"),
      },
    },
    routes,
    tiers: parseTiers(root.tiers, routes),
    auditRoutes: parseAuditRoutes(root.audit_routes, routes),
    pricingUsdPerMTok: {},
    ceilings: parseCeilings(root.ceilings),
    retry: parseRetry(root.retry),
    timeoutMs: positive(root.timeout_ms, "$.timeout_ms"),
    maxTurns: positive(root.max_turns, "$.max_turns"),
    specialists: parseSpecialists(root.specialists, routes),
  };

  const pricing = object(root.pricing_usd_per_mtok, "$.pricing_usd_per_mtok");
  for (const [model, value] of Object.entries(pricing)) {
    const path = `$.pricing_usd_per_mtok.${model}`;
    if (!MODEL_ID.test(model)) fail(path, "is not a model id");
    const price = object(value, path);
    exactKeys(price, ["input", "cached_input", "output"], path);
    config.pricingUsdPerMTok[model] = {
      input: nonNegative(price.input, `${path}.input`),
      cachedInput: nonNegative(price.cached_input, `${path}.cached_input`),
      output: nonNegative(price.output, `${path}.output`),
    };
  }
  for (const [id, route] of Object.entries(config.routes)) {
    if (route.provider === "codex" && !Object.hasOwn(config.pricingUsdPerMTok, route.model)) {
      fail(`$.routes.${id}.model`, "codex models need a pricing_usd_per_mtok entry for cost ceilings");
    }
  }
  // Independence is per run: work proposed on a family is audited on that family's audit route,
  // so every family a proposer can run on needs one.
  for (const id of proposerRoutes(config)) {
    const family = config.routes[id].provider;
    if (!Object.hasOwn(config.auditRoutes, family)) fail(`$.audit_routes.${family}`, `is required: route ${id} proposes on ${family}`);
  }
  for (const id of Object.keys(config.ceilings.specialists)) {
    if (!Object.hasOwn(config.specialists, id)) fail(`$.ceilings.specialists.${id}`, "is not a registered specialist");
  }
  return config;
}

/** Every route a proposing run can take: the routine and hard tiers', and each proposer's own and action routes. */
export function proposerRoutes(config: GatewayConfig): string[] {
  const ids = [config.tiers.routine, config.tiers.hard];
  for (const [id, specialist] of Object.entries(config.specialists)) {
    if (id === AUDITOR) continue;
    if (specialist.route !== null) ids.push(specialist.route);
    ids.push(...Object.values(specialist.actions));
  }
  return ids;
}

/**
 * Parses the `ledger` and `judge` blocks of the qualification config for an eval gateway. The
 * eval books must be isolated and tagged, and a Codex judge needs a price like any Codex route.
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
    default: parseRoute(judge.default, `${judgePath}.default`),
    for_claude_proposers: parseRoute(judge.for_claude_proposers, `${judgePath}.for_claude_proposers`),
  };
  for (const [field, route] of Object.entries(judgeRoutes)) {
    if (route.provider === "codex" && !Object.hasOwn(config.pricingUsdPerMTok, route.model)) {
      fail(`${judgePath}.${field}.model`, "codex models need a pricing_usd_per_mtok entry for cost ceilings");
    }
  }
  return {
    windowHours: positive(ledger.window_hours, `${ledgerPath}.window_hours`),
    team: teamCeiling(ledger.team, `${ledgerPath}.team`),
    specialist: specialistCeiling(ledger.specialist, `${ledgerPath}.specialist`),
    judgeKey,
    judge: specialistCeiling(ledger.judge, `${ledgerPath}.judge`),
    judgeRoutes,
  };
}

export function parseRoute(raw: unknown, path: string): Route {
  const route = object(raw, path);
  exactKeys(route, ["provider", "model", "effort"], path);
  const model = text(route.model, `${path}.model`);
  if (!MODEL_ID.test(model)) fail(`${path}.model`, "is not a model id");
  const effort = text(route.effort, `${path}.effort`) as Effort;
  if (!EFFORTS.has(effort)) fail(`${path}.effort`, "is not an effort level");
  return { provider: oneOf(route.provider, PROVIDERS, `${path}.provider`), model, effort };
}

function parseRoutes(raw: unknown): Record<string, Route> {
  const routes = object(raw, "$.routes");
  const result: Record<string, Route> = {};
  for (const [id, value] of Object.entries(routes)) {
    if (!ROUTE_ID.test(id)) fail(`$.routes.${id}`, "is not a route id");
    result[id] = parseRoute(value, `$.routes.${id}`);
  }
  return result;
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

function parseAuditRoutes(raw: unknown, routes: Record<string, Route>): Partial<Record<ProviderId, string>> {
  const auditRoutes = object(raw, "$.audit_routes");
  const result: Partial<Record<ProviderId, string>> = {};
  for (const [family, value] of Object.entries(auditRoutes)) {
    const path = `$.audit_routes.${family}`;
    if (!PROVIDERS.includes(family as ProviderId)) fail(path, `is not a model family (${PROVIDERS.join(", ")})`);
    const id = routeRef(value, routes, path);
    if (routes[id].provider === family) fail(path, `must name a route of another family than ${family}`);
    result[family as ProviderId] = id;
  }
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
  exactKeys(team, ["calls", "cost_usd"], path);
  return { calls: positive(team.calls, `${path}.calls`), costUsd: positive(team.cost_usd, `${path}.cost_usd`) };
}

function specialistCeiling(raw: unknown, path: string): SpecialistCeiling {
  const value = object(raw, path);
  exactKeys(value, ["calls", "cost_usd", "cost_usd_per_call"], path);
  const ceiling = {
    calls: positive(value.calls, `${path}.calls`),
    costUsd: positive(value.cost_usd, `${path}.cost_usd`),
    costUsdPerCall: positive(value.cost_usd_per_call, `${path}.cost_usd_per_call`),
  };
  if (ceiling.costUsdPerCall > ceiling.costUsd) fail(`${path}.cost_usd_per_call`, "exceeds cost_usd");
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
  if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts > 10) fail("$.retry.max_attempts", "must be 1-10");
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

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a known field");
  }
  for (const key of allowed) {
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
  const list = value as unknown[];
  for (const plan of list) if (typeof plan !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(plan)) fail(path, "must hold plan names such as pro");
  if (new Set(list).size !== list.length) fail(path, "must not repeat a plan");
  return list as string[];
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value as boolean;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(path, "must be a positive number");
  return value as number;
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
