// Provider gateway contract. A model run is an untrusted proposal: the gateway returns either a
// schema-valid output or an abstention with a stable reason. It never switches provider or model
// to rescue a call, and it never throws for provider failures.

export type ProviderId = "claude" | "codex";
export type Tier = "routine" | "hard" | "audit";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type JsonSchema = { [key: string]: unknown };

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
  provider: ProviderId;
  /** Configured model for the route. */
  model: string;
  /** Models the provider reported using; empty when the provider does not report them. */
  modelsUsed: string[];
  authMode: string;
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
  | (ResultBase & { status: "abstained"; reason: AbstainReason; detail: string; retryAt?: number });

export type ProviderErrorKind =
  | "rate_limit"
  | "auth"
  | "transient"
  | "budget"
  | "invalid_output"
  | "aborted"
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
  if (/\b429\b|rate.?limit|too many requests|usage limit/i.test(text)) return "rate_limit";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|not logged in|log ?in again|token (?:expired|invalid|revoked)|refresh token/i.test(text)) {
    return "auth";
  }
  if (/\b5\d\d\b|overloaded|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(text)) {
    return "transient";
  }
  return "fatal";
}
