// Gateway configuration: routing, credentials by environment-variable name, ceilings, retry.
// Swapping a provider from a subscription sign-in to an API key is a change to `auth` here and
// nothing else. The file never holds a secret value.

import { readFileSync } from "node:fs";
import type { Effort, ProviderId, Tier } from "./types.ts";

export const GATEWAY_CONFIG_SCHEMA = "ironwrap_agent_gateway_config_v1";

export interface Route {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

export interface Ceiling {
  calls: number;
  costUsd: number;
}

export interface SpecialistCeiling extends Ceiling {
  costUsdPerCall: number;
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
  routes: Record<Tier, Route>;
  pricingUsdPerMTok: Record<string, { input: number; cachedInput: number; output: number }>;
  ceilings: {
    windowHours: number;
    team: Ceiling;
    specialistDefault: SpecialistCeiling;
    specialists: Record<string, SpecialistCeiling>;
  };
  /** `authProbeAfterMs`: how long a rejected credential is left alone before one probe call. */
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; authProbeAfterMs: number };
  timeoutMs: number;
  maxTurns: number;
  specialists: Record<string, Tier[]>;
}

const TIERS: Tier[] = ["routine", "hard", "audit"];
export const AUDITOR = "independent_auditor";
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SPECIALIST_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function loadGatewayConfig(path: string): GatewayConfig {
  return parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  const root = object(raw, "$");
  exactKeys(root, [
    "schema",
    "providers",
    "routes",
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
    routes: parseRoutes(root.routes),
    pricingUsdPerMTok: {},
    ceilings: parseCeilings(root.ceilings),
    retry: parseRetry(root.retry),
    timeoutMs: positive(root.timeout_ms, "$.timeout_ms"),
    maxTurns: positive(root.max_turns, "$.max_turns"),
    specialists: parseSpecialists(root.specialists),
  };

  const pricing = object(root.pricing_usd_per_mtok, "$.pricing_usd_per_mtok");
  for (const [model, value] of Object.entries(pricing)) {
    const path = `$.pricing_usd_per_mtok.${model}`;
    const price = object(value, path);
    exactKeys(price, ["input", "cached_input", "output"], path);
    config.pricingUsdPerMTok[model] = {
      input: nonNegative(price.input, `${path}.input`),
      cachedInput: nonNegative(price.cached_input, `${path}.cached_input`),
      output: nonNegative(price.output, `${path}.output`),
    };
  }

  // The independent auditor must run on a different model family than every proposer.
  for (const tier of ["routine", "hard"] as const) {
    if (config.routes.audit.provider === config.routes[tier].provider) {
      fail("$.routes.audit.provider", `must differ from the ${tier} provider`);
    }
  }
  for (const tier of TIERS) {
    const route = config.routes[tier];
    if (route.provider === "codex" && !config.pricingUsdPerMTok[route.model]) {
      fail(`$.routes.${tier}.model`, "codex models need a pricing_usd_per_mtok entry for cost ceilings");
    }
  }
  for (const id of Object.keys(config.ceilings.specialists)) {
    if (!config.specialists[id]) fail(`$.ceilings.specialists.${id}`, "is not a registered specialist");
  }
  return config;
}

function parseRoutes(raw: unknown): Record<Tier, Route> {
  const routes = object(raw, "$.routes");
  exactKeys(routes, TIERS, "$.routes");
  const result = {} as Record<Tier, Route>;
  for (const tier of TIERS) {
    const path = `$.routes.${tier}`;
    const route = object(routes[tier], path);
    exactKeys(route, ["provider", "model", "effort"], path);
    const model = text(route.model, `${path}.model`);
    if (!MODEL_ID.test(model)) fail(`${path}.model`, "is not a model id");
    const effort = text(route.effort, `${path}.effort`) as Effort;
    if (!EFFORTS.has(effort)) fail(`${path}.effort`, "is not an effort level");
    result[tier] = {
      provider: oneOf(route.provider, ["claude", "codex"] as const, `${path}.provider`),
      model,
      effort,
    };
  }
  return result;
}

function parseCeilings(raw: unknown): GatewayConfig["ceilings"] {
  const ceilings = object(raw, "$.ceilings");
  exactKeys(ceilings, ["window_hours", "team", "specialist_default", "specialists"], "$.ceilings");
  const specialists: Record<string, SpecialistCeiling> = {};
  for (const [id, value] of Object.entries(object(ceilings.specialists, "$.ceilings.specialists"))) {
    specialists[id] = specialistCeiling(value, `$.ceilings.specialists.${id}`);
  }
  const team = object(ceilings.team, "$.ceilings.team");
  exactKeys(team, ["calls", "cost_usd"], "$.ceilings.team");
  return {
    windowHours: positive(ceilings.window_hours, "$.ceilings.window_hours"),
    team: { calls: positive(team.calls, "$.ceilings.team.calls"), costUsd: positive(team.cost_usd, "$.ceilings.team.cost_usd") },
    specialistDefault: specialistCeiling(ceilings.specialist_default, "$.ceilings.specialist_default"),
    specialists,
  };
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

function parseSpecialists(raw: unknown): Record<string, Tier[]> {
  const specialists = object(raw, "$.specialists");
  const result: Record<string, Tier[]> = {};
  for (const [id, tiers] of Object.entries(specialists)) {
    const path = `$.specialists.${id}`;
    if (!SPECIALIST_ID.test(id)) fail(path, "is not a specialist id");
    if (!Array.isArray(tiers) || tiers.length === 0) fail(path, "must list at least one tier");
    const parsed = tiers.map((tier, index) => oneOf(tier, TIERS, `${path}[${index}]`));
    if (new Set(parsed).size !== parsed.length) fail(path, "lists a tier twice");
    // The auditor runs only on the audit tier, and nobody else does, so audit and proposal never
    // share a model family.
    if (id === AUDITOR && (parsed.length !== 1 || parsed[0] !== "audit")) {
      fail(path, "the independent auditor must use exactly the audit tier");
    }
    if (id !== AUDITOR && parsed.includes("audit")) fail(path, "only the independent auditor may use the audit tier");
    result[id] = parsed;
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
