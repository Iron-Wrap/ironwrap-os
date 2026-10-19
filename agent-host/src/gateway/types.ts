// Provider gateway contract. A model run is an untrusted proposal: the gateway returns either a
// schema-valid output or an abstention with a stable reason. It never throws for provider failures
// and never switches provider or model to rescue a call, except along a route's declared fallback
// chain (same family, production scope only), and it records every hop it passed over.

/** A provider entry in the gateway configuration: one tenant account behind one adapter. */
export type ProviderId = string;
/** A model family (`anthropic`, `openai`, `google`, ...); the registry entry of a model names it. */
export type Family = string;
export type AdapterKind = "claude_agent_sdk" | "codex";
export type Billing = "api" | "subscription";
export type CredentialMode = "oauth" | "api_key";
export type Tier = "routine" | "hard" | "audit";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Which books a run spends from: the live ceilings, the low shadow budget, or an eval gateway's own. */
export type Scope = "production" | "eval" | "shadow";
/**
 * What data a run carries, which decides the provider accounts that may serve it
 * (docs/COMPLIANCE-REGISTER.md "AI model providers"): live and shadow runs on business data, eval
 * runs on real pseudonymised history, and synthetic runs (golden and red-team cases, a QA or dev host).
 */
export type RunClass = "live" | "shadow" | "eval_history" | "synthetic";

export type JsonSchema = { [key: string]: unknown };

export interface Route {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

/** The run whose work is under review, and the model family that proposed it. */
export interface ReviewOf {
  runId: string;
  family: Family;
}

/** One owner-recorded qualification the Worker holds for the run's specialist (`agent_qualifications`). */
export interface QualifiedRoute {
  /** The Worker's `qualification_id`, recorded on the run as its `qualification_ref`. */
  id: string;
  provider: ProviderId;
  model: string;
  effort: Effort;
  /** `release_sha256` (host/release.ts) the qualification was recorded at. */
  release: string;
}

export interface UsdPerMTok {
  input: number;
  cachedInput: number;
  output: number;
  /** Tokens written to the prompt cache; the input price when the provider lists none. */
  cacheWrite?: number;
}

export type Figure = "context_tokens" | "max_output_tokens" | "price";

/** A model's capability registry entry at one provider account (`providers.<id>.models.<model>`). */
export interface ModelEntry {
  family: Family;
  tools: boolean;
  /** `native`: the provider enforces the output schema; `validated`: only the gateway does. */
  jsonSchema: "native" | "validated";
  contextTokens: number;
  maxOutputTokens: number;
  /** The efforts the model takes, each with the request fragment it adds (none for the SDK adapters). */
  efforts: Partial<Record<Effort, Record<string, unknown>>>;
  /**
   * `subscription` names the plan a subscription account is billed under, null on API billing.
   * `usdPerMTok` is what a call books: the API price, or a subscription's list price; null when a
   * subscription model has no USD figure (it then books tokens against token ceilings).
   */
  price: { subscription: string | null; usdPerMTok: UsdPerMTok | null };
  /** In-memory limits over a sliding minute per provider and model; null is no gateway limit. */
  rateLimits: { requestsPerMinute: number | null; inputTokensPerMinute: number | null; outputTokensPerMinute: number | null };
  /** Figures not yet checked against provider docs; a live run refuses an entry that has any. */
  unverified: Figure[];
  /** Where each checked figure comes from, and when it was read. */
  sources: Partial<Record<Figure, string>>;
}

/** An owner risk acceptance: one consumer ref may serve one more run class (COMPLIANCE-REGISTER.md "Recorded exceptions"). */
export interface RiskAcceptance {
  ref: string;
  runClass: "eval_history";
  reason: string;
}

/** A hop a run did not answer on: refused before any call, or failed after its attempts. */
export interface FailoverHop {
  routeId: string;
  provider: ProviderId;
  model: string;
  reason: AbstainReason;
  retryAt: number | null;
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
   * family than `reviewOf.family`, or abstain (`no_independent_route`).
   */
  reviewOf?: ReviewOf;
  /** Default `production`. An eval gateway takes only `eval`; a production gateway never does. */
  scope?: Scope;
  /** Eval only: one batch's route for a proposing tier (the stage-0 model comparison). */
  tierRoutes?: Partial<Record<"routine" | "hard", Route>>;
  /** The specialist's `release_sha256` (host/release.ts); a live or shadow run's qualification names it. */
  release?: string;
  /**
   * The Worker's qualifications for the specialist. A live or shadow run takes only a hop that one
   * of them names exactly (provider, model, effort, release); eval and synthetic runs need none.
   */
  qualifications?: QualifiedRoute[];
  /** Eval only: the cases' data, `synthetic` (golden, red team) or `history`; unset reads as `history`. */
  data?: "synthetic" | "history";
  /** The provider ids the run may use; any other hop is unavailable (`provider_disabled`). */
  providers?: ProviderId[];
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
  | "no_qualified_route"
  | "aborted";

interface ResultBase {
  specialist: string;
  tier: Tier;
  /**
   * The route the result describes: a `routes` id, `judge.<field>` or `tier_routes.<tier>` on an
   * eval gateway. It, `provider`, `model`, `authMode`, `family`, `adapter` and `billing` are null
   * only when no route was resolved (the kill switch, an unknown specialist, `no_independent_route`).
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
  family: Family | null;
  adapter: AdapterKind | null;
  billing: Billing | null;
  /** `primary` or `declared_fallback`: the hop the route fields describe; null with no route. */
  route: "primary" | "declared_fallback" | null;
  /** The Worker qualification the hop that ran matched; null when the run needed none. */
  qualificationRef: string | null;
  /** Every hop the run passed over or failed on, in order; empty when the primary answered. */
  failover: FailoverHop[];
  runClass: RunClass;
  /** The compliance ref of the account the route fields describe; null with no route or no ref. */
  complianceRef: string | null;
  /** The owner risk acceptance that let a consumer account serve this run, if one did. */
  riskAcceptance: RiskAcceptance | null;
  /** SHA-256 of the gateway configuration the run was routed by. */
  gatewayConfigSha256: string;
  /** Every attempt on every hop. */
  attempts: number;
  usage: Usage;
  /** Notional cost: the provider estimate for Claude, the registry price for Codex. */
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
       * Epoch ms before which the same run would abstain again: the cooldown or rate-window end for
       * `rate_limited`, the moment the oldest counted reservation leaves the window for a ledger
       * `call_ceiling` or `cost_ceiling`, the next probe for a model the provider refused for the
       * sign-in's plan, now plus the attempt's backoff for any other `provider_error` and for
       * `model_mismatch`. After a failover, the earliest such time of any hop. Absent when waiting
       * alone cannot help.
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
  /** The model's registry entry at this provider account. */
  entry: ModelEntry;
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
