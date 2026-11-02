/**
 * Optional OmniRoute gateway adapter (https://github.com/diegosouzapw/OmniRoute).
 *
 * OmniRoute is a self-hosted free-tier aggregator: OpenAI `/v1/chat/completions`,
 * Anthropic `/v1/messages`, Gemini `/v1beta/models/{model}:generateContent`.
 * Auth is `Authorization: Bearer <dashboard API key>` (also `x-api-key`).
 * There is no public multi-tenant API; `OMNIROUTE_URL` must be a reachable origin.
 *
 * This module is deliberately fetch-free. Callers keep their IRO-38 inventory
 * classification and inject `fetch` themselves.
 */

export const OMNIROUTE_FALLBACK_MODEL = "auto";
export const OMNIROUTE_ANTHROPIC_VERSION = "2023-06-01";

export type OmniRouteConfig = {
  baseUrl: string;
  apiKey: string;
};

export type OmniRouteEnv = {
  OMNIROUTE_URL?: string;
  OMNIROUTE_API_KEY?: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function omnirouteConfigFrom(env: OmniRouteEnv): OmniRouteConfig | null {
  const apiKey = env.OMNIROUTE_API_KEY?.trim() ?? "";
  const baseUrl = parseOmniRouteBaseUrl(env.OMNIROUTE_URL ?? "");
  if (!apiKey || !baseUrl) return null;
  return { baseUrl, apiKey };
}

function parseOmniRouteBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && local) return url.origin;
  return null;
}

export function omnirouteMessagesUrl(baseUrl: string): string {
  return `${baseUrl}/v1/messages`;
}

export function omnirouteGeminiGenerateContentUrl(baseUrl: string, model: string): string {
  return `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export function omnirouteAuthHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "anthropic-version": OMNIROUTE_ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

/** Paid-provider refusals that mean "no usable balance / key", not generic faults. */
export function isCreditOrAuthExhausted(status: number, bodyText: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  if (status !== 429) return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient quota") ||
    lower.includes("credit") ||
    lower.includes("billing") ||
    (/\bquota\b/.test(lower) &&
      (lower.includes("exceed") || lower.includes("exhaust") || lower.includes("balance")))
  );
}
