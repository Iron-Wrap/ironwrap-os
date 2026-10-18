// Provider gateway contract. A model run is an untrusted proposal: the gateway returns either a
// schema-valid output or an abstention with a stable reason. It never switches provider or model
// to rescue a call, and it never throws for provider failures.

export type ProviderId = "claude" | "codex";
export type Tier = "routine" | "hard" | "audit";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Which books a run spends from: the live ceilings, the low shadow budget, or an eval gateway's own. */
export type Scope = "production" | "eval" | "shadow";

export type JsonSchema = { [key: string]: unknown };

export interface Route {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

/** The run whose work is under review, and the model family (provider) that proposed it. */
export interface ReviewOf {
  runId: string;
  provider: ProviderId;
}

/** One stdio MCP server exposing the catalog actions a specialist may call. */
export interface McpStdioServer {
  command: string;
  args: string[];
  /** Non-secret environment for the server process. */
  env: Record<string, string>;
  /** Names of gateway-process variables forwarded to the server without putting values on argv. */
  passEnv: string[];
}

export interface GatewayRequest {
  specialist: string;
  tier: Tier;
  /** The run's single expected action; it selects the specialist's per-action route, if any. */
  action?: string;
  /**
   * The run under review. The independent auditor and an eval judge then run on a route of another
   * family than `reviewOf.provider`, or abstain (`no_independent_route`).
   */
  reviewOf?: ReviewOf;
  /** Default `production`. An eval gateway takes only `eval`; a production gateway never does. */
  scope?: Scope;
  /** Eval only: one batch's route for a proposing tier (the stage-0 model comparison). */
  tierRoutes?: Partial<Record<"routine" | "hard", Route>>;
  /** Trusted instructions (playbook and contract). */
  system: string;
  /** Context snapshot and signal, already labelled as data. */
  prompt: string;
  /** Strict subset JSON Schema for the final output; see schema.ts. */
  outputSchema: JsonSchema;
  /** Catalog actions exposed as MCP tools on one server named `ironwrap`. */
  tools?: { server: McpStdioServer; allowed: string[] };
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  tool: string;
  arguments: unknown;
}

export type AbstainReason =
  | "kill_switch"
  | "provider_disabled"
  | "unknown_specialist"
  | "tier_not_allowed"
  | "no_independent_route"
  | "credential_missing"
  | "auth_failed"
  | "rate_limited"
  | "call_ceiling"
  | "cost_ceiling"
  | "ledger_unavailable"
  | "provider_error"
  | "invalid_output"
  | "model_mismatch"
  | "aborted";

interface ResultBase {
  specialist: string;
  tier: Tier;
  /**
   * The route the run resolved to: a `routes` id, `judge.<field>` or `tier_routes.<tier>` on an
   * eval gateway. It, `provider`, `model` and `authMode` are null only for `no_independent_route`.
   */
  routeId: string | null;
  /** The run under review, as the request named it. */
  reviewOf: ReviewOf | null;
  provider: ProviderId | null;
  /** Configured model for the route. */
  model: string | null;
  /** Models the provider reported using; empty when the provider does not report them. */
  modelsUsed: string[];
  authMode: string | null;
  attempts: number;
  usage: Usage;
  /** Notional cost: provider estimate for Claude, configured price table for Codex. */
  costUsd: number;
  durationMs: number;
  hashes: { system: string; prompt: string; schema: string };
  toolCalls: ToolCall[];
}

export type GatewayResult =
  | (ResultBase & { status: "ok"; output: unknown })
  | (ResultBase & {
      status: "abstained";
      reason: AbstainReason;
      detail: string;
      /**
       * Epoch ms before which the same run would abstain again: the cooldown end for
       * `rate_limited`, the moment the oldest counted reservation leaves the window for a ledger
       * `call_ceiling` or `cost_ceiling`, the next probe for a model the provider refused for the
       * sign-in's plan, now plus the attempt's backoff for any other `provider_error` and for
       * `model_mismatch`. Absent when waiting alone cannot help.
       */
      retryAt?: number;
    });

export type ProviderErrorKind =
  | "rate_limit"
  | "auth"
  | "transient"
  | "budget"
  | "invalid_output"
  | "aborted"
  /** The signed-in subscription does not include the requested model. */
  | "plan"
  | "fatal";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | undefined;
  readonly usage: Usage;
  readonly costUsd: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    extra: { retryAfterMs?: number; usage?: Usage; costUsd?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterMs = extra.retryAfterMs;
    this.usage = extra.usage ?? zeroUsage();
    this.costUsd = extra.costUsd ?? 0;
  }
}

export interface ProviderCall {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  outputSchema: JsonSchema;
  tools: { server: McpStdioServer; allowed: string[] } | undefined;
  maxTurns: number;
  maxCostUsd: number;
  signal: AbortSignal;
}

export interface ProviderOutcome {
  output: unknown;
  usage: Usage;
  costUsd: number;
  modelsUsed: string[];
  toolCalls: ToolCall[];
}

export interface CredentialState {
  /** Changes whenever the credential changes; null when no credential is configured. */
  fingerprint: string | null;
  /** Codex ChatGPT sign-in only: when the CLI last refreshed auth.json, in epoch ms. */
  refreshedAt?: number;
  /** Codex ChatGPT sign-in only: the subscription plan the sign-in claims, such as `pro`. */
  plan?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly authMode: string;
  credential(): Promise<CredentialState>;
  call(request: ProviderCall): Promise<ProviderOutcome>;
}

export function zeroUsage(): Usage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

/** Last resort for errors that arrive only as text (a crashed subprocess, a network failure). */
export function classifyText(text: string): ProviderErrorKind {
  // Codex's exact refusal of a model for the ChatGPT sign-in's plan; nothing looser.
  if (/model is not supported when using codex with a chatgpt account/i.test(text)) return "plan";
  if (/\b429\b|rate.?limit|too many requests|\b(?:usage|session|weekly|daily|monthly|hourly) limit\b/i.test(text)) return "rate_limit";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|not logged in|log ?in again|token (?:expired|invalid|revoked)|refresh token/i.test(text)) {
    return "auth";
  }
  if (/\b5\d\d\b|overloaded|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(text)) {
    return "transient";
  }
  return "fatal";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const MAX_RESET_MS = 31 * 24 * 60 * 60_000;

/**
 * When a subscription limit lifts, from text like "resets 5:30am (Europe/Sofia)" or "resets Oct 24
 * at 8am (Europe/Sofia)": the next such local time in that zone. A wall time that occurs twice (the
 * hour summer time ends) resolves to its later instant, and one that does not exist to the instant
 * after the gap, so a retry never comes early. Undefined when the text names no time zone, does not
 * parse, names an impossible date or lies in the past or more than 31 days ahead, so the caller
 * keeps its own backoff.
 */
export function limitResetMs(text: string, nowMs: number): number | undefined {
  const match = /resets\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)/i.exec(text);
  if (!match) return undefined;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = match;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  let local: Intl.DateTimeFormat;
  try {
    local = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch {
    return undefined;
  }
  const parts = (ms: number) => Object.fromEntries(local.formatToParts(ms).map((part) => [part.type, Number(part.value)])) as Record<string, number>;
  const offsetAt = (ms: number) => {
    const p = parts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  // The UTC instant of a local wall time in the zone: every offset the zone uses around that day,
  // keeping the latest instant that shows that wall time (or the latest at all, inside a gap).
  const instant = (year: number, month: number, day: number) => {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const candidates = [wall - 86_400_000, wall, wall + 86_400_000].map((probe) => wall - offsetAt(probe));
    const shown = candidates.filter((ms) => offsetAt(ms) + ms === wall);
    return Math.max(...(shown.length > 0 ? shown : candidates));
  };
  const within = (ms: number) => (ms > nowMs && ms - nowMs <= MAX_RESET_MS ? ms : undefined);
  const today = parts(nowMs);
  if (monthName === undefined) {
    const at = instant(today.year, today.month, today.day);
    return within(at > nowMs ? at : instant(today.year, today.month, today.day + 1));
  }
  const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
  const day = Number(dayText);
  const real = (year: number) => month > 0 && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (yearText !== undefined) return real(Number(yearText)) ? within(instant(Number(yearText), month, day)) : undefined;
  const year = real(today.year) && instant(today.year, month, day) > nowMs ? today.year : today.year + 1;
  return real(year) ? within(instant(year, month, day)) : undefined;
}
