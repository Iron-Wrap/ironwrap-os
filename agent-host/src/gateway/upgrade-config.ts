// Converts a gateway configuration from v2 to v3:
//
//   node src/gateway/upgrade-config.ts v2.json > v3.json
//
// v2 named two fixed providers and keyed audit routes by them; v3 holds provider accounts with
// model registries and keys audit routes by family. The converter keeps every route, tier,
// ceiling, retry setting and specialist, maps `claude` to the anthropic family and `codex` to
// openai, gives every route `fallback: null`, and moves v2's prices into the registry, marked
// unverified. It cannot know what v2 never held, so its output does not parse until an operator
// fills it: each model's context window and output limit, cited with the provider doc and the date
// it was read; each account's `compliance_ref` (docs/COMPLIANCE-REGISTER.md); and a registry entry
// for any model that only a judge route names. The runtime reads v3 only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GATEWAY_CONFIG_SCHEMA, GATEWAY_CONFIG_SCHEMA_V2 } from "./config.ts";
import { legacyFamily } from "./registry.ts";

type Json = Record<string, unknown>;

export function upgradeConfig(raw: unknown): Json {
  const v2 = record(raw, "$");
  if (v2.schema !== GATEWAY_CONFIG_SCHEMA_V2) throw new Error(`upgrade-config: $.schema must be ${GATEWAY_CONFIG_SCHEMA_V2}`);
  const providers = record(v2.providers, "$.providers");
  const claude = record(providers.claude, "$.providers.claude");
  const codex = record(providers.codex, "$.providers.codex");
  const pricing = record(v2.pricing_usd_per_mtok, "$.pricing_usd_per_mtok");
  // A subscription sign-in (`oauth`, `chatgpt`) bills the subscription; an API key bills per token.
  const signedIn = { claude: claude.auth === "oauth", codex: codex.auth === "chatgpt" };
  const accounts: Record<string, Json & { models: Record<string, Json> }> = {
    claude: {
      adapter: "claude_agent_sdk",
      enabled: claude.enabled,
      billing: signedIn.claude ? "subscription" : "api",
      credential_mode: signedIn.claude ? "oauth" : "api_key",
      secrets: { oauth_token_env: claude.oauth_token_env, api_key_env: claude.api_key_env },
      executable_path: claude.executable_path,
      compliance_ref: null,
      models: {},
    },
    codex: {
      adapter: "codex",
      enabled: codex.enabled,
      billing: signedIn.codex ? "subscription" : "api",
      credential_mode: signedIn.codex ? "oauth" : "api_key",
      secrets: { api_key_env: codex.api_key_env, codex_home_env: codex.codex_home_env },
      signin_max_age_hours: codex.signin_max_age_hours,
      chatgpt_plans: codex.chatgpt_plans,
      compliance_ref: null,
      models: {},
    },
  };
  const routes: Record<string, Json> = {};
  for (const [id, value] of Object.entries(record(v2.routes, "$.routes"))) {
    const route = record(value, `$.routes.${id}`);
    const provider = String(route.provider);
    if (provider !== "claude" && provider !== "codex") throw new Error(`upgrade-config: $.routes.${id}.provider must be claude or codex`);
    const models = accounts[provider].models;
    const model = String(route.model);
    if (!Object.hasOwn(models, model)) {
      const price = Object.hasOwn(pricing, model) ? record(pricing[model], `$.pricing_usd_per_mtok.${model}`) : null;
      models[model] = modelEntry(provider, signedIn[provider], price);
    }
    (models[model].efforts as Json)[String(route.effort)] = {};
    routes[id] = { provider, model, effort: route.effort, fallback: null };
  }
  const auditRoutes = Object.entries(record(v2.audit_routes, "$.audit_routes")).map(([key, id]) => [legacyFamily(key) ?? key, id]);
  return {
    schema: GATEWAY_CONFIG_SCHEMA,
    providers: accounts,
    routes,
    tiers: v2.tiers,
    audit_routes: Object.fromEntries(auditRoutes),
    owner_risk_acceptances: [],
    ceilings: v2.ceilings,
    retry: v2.retry,
    timeout_ms: v2.timeout_ms,
    max_turns: v2.max_turns,
    specialists: v2.specialists,
  };
}

/** A registry entry from what v2 knew: the family, both SDKs' tool use and native schemas, its price. */
function modelEntry(provider: "claude" | "codex", subscription: boolean, price: Json | null): Json {
  return {
    family: legacyFamily(provider),
    tools: true,
    json_schema: "native",
    context_tokens: null,
    max_output_tokens: null,
    efforts: {},
    price: subscription ? { subscription: provider === "claude" ? "claude" : "chatgpt", list_usd_per_mtok: price } : { usd_per_mtok: price },
    rate_limits: { requests_per_minute: null, input_tokens_per_minute: null, output_tokens_per_minute: null },
    // v2 recorded no source for its prices.
    unverified: price === null ? [] : ["price"],
    sources: {},
  };
}

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`upgrade-config: ${path} must be an object`);
  return value as Json;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length > 0) {
    process.stderr.write("usage: node src/gateway/upgrade-config.ts <v2.json> > <v3.json>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(upgradeConfig(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
