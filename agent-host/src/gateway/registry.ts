// The capability registry: one entry per model at each provider account
// (`providers.<id>.models.<model>`), because the same model has other capabilities, limits and
// prices behind another account. It is the authority for a route's family, its fit to a run and
// the price a call books. A model without an entry is never routed.

import type { GatewayConfig } from "./config.ts";
import type { AdapterKind, Family, JsonSchema, ModelEntry, Route, UsdPerMTok } from "./types.ts";

/**
 * The v2 provider ids, which doubled as family names before v3. Only the converter and the
 * Worker's legacy review hint (`review_of.provider`) read them; no v3 family may take either name.
 */
export const LEGACY_FAMILIES: Readonly<Record<string, Family>> = Object.freeze({ claude: "anthropic", codex: "openai" });

/** The legacy family of a v2 provider id, or undefined (own keys only, so `constructor` names none). */
export function legacyFamily(provider: string): Family | undefined {
  return Object.hasOwn(LEGACY_FAMILIES, provider) ? LEGACY_FAMILIES[provider] : undefined;
}

export function entryOf(config: Pick<GatewayConfig, "providers">, route: Route): ModelEntry | undefined {
  const account = Object.hasOwn(config.providers, route.provider) ? config.providers[route.provider] : undefined;
  return account && Object.hasOwn(account.models, route.model) ? account.models[route.model] : undefined;
}

export function familyOf(config: Pick<GatewayConfig, "providers">, route: Route): Family {
  const entry = entryOf(config, route);
  if (!entry) throw new Error(`${route.provider}/${route.model} has no registry entry`);
  return entry.family;
}

/** Characters per token for the input estimate: low on purpose, so the estimate errs large. */
const CHARS_PER_TOKEN = 3;

export function inputEstimate(run: { system: string; prompt: string; outputSchema: JsonSchema }): number {
  return Math.ceil((run.system.length + run.prompt.length + JSON.stringify(run.outputSchema).length) / CHARS_PER_TOKEN);
}

/**
 * Why the model cannot carry this run, or null: a run with tools needs tool use, the estimated
 * input plus the maximum output must fit the context window, and the input must fit a per-minute
 * input limit at all.
 */
export function fit(entry: ModelEntry, run: { system: string; prompt: string; outputSchema: JsonSchema; tools?: unknown }): string | null {
  if (run.tools !== undefined && !entry.tools) return "the run has tools and the model takes none";
  const estimate = inputEstimate(run);
  if (estimate + entry.maxOutputTokens > entry.contextTokens) {
    return `about ${estimate} input tokens and ${entry.maxOutputTokens} output tokens exceed its ${entry.contextTokens}-token context window`;
  }
  const perMinute = entry.rateLimits.inputTokensPerMinute;
  if (perMinute !== null && estimate > perMinute) return `about ${estimate} input tokens exceed its limit of ${perMinute} input tokens per minute`;
  return null;
}

/** USD for one call's usage. `inputTokens` includes cache reads and writes; writes cost `cacheWrite`, else the input price. */
export function costOf(price: UsdPerMTok, usage: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number }): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
  return (
    (uncached * price.input + usage.cachedInputTokens * price.cachedInput + usage.cacheWriteTokens * (price.cacheWrite ?? price.input) + usage.outputTokens * price.output) /
    1_000_000
  );
}

/** Whether a model's calls book USD: the Claude Agent SDK reports its own estimate, any other adapter needs a price. */
export function booksUsd(adapter: AdapterKind, entry: ModelEntry): boolean {
  return adapter === "claude_agent_sdk" || entry.price.usdPerMTok !== null;
}
