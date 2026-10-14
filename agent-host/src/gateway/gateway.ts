// The provider gateway: one interface over Claude (Agent SDK) and Codex (Codex SDK).
//
// Order of checks for every run: kill switch, registered specialist and tier, provider enabled,
// provider cooldown, credential present and not already rejected, call and cost ceilings. A failed
// check is an abstention with a stable reason; the gateway never falls back to another provider
// or model, so a specialist whose provider is unavailable abstains and its receipt says why.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "./config.ts";
import { UsageLedger } from "./ledger.ts";
import { assertStrictSchema, canonicalJson, providerSchema, sha256, validate } from "./schema.ts";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import {
  ProviderError,
  zeroUsage,
  type AbstainReason,
  type GatewayRequest,
  type GatewayResult,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ProviderId,
  type ToolCall,
  type Usage,
} from "./types.ts";

export const KILL_SWITCH_FILE = "KILL";
export const KILL_SWITCH_ENV = "AGENT_HOST_KILL";

export type Env = Record<string, string | undefined>;

export interface GatewayOptions {
  config: GatewayConfig;
  /** Persistent, writable directory owned by the agent host. */
  stateDir: string;
  /** Process environment; credentials are read from it by name on every call. */
  env: Env;
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export type ProviderStateName = "ready" | "disabled" | "credential_missing" | "auth_failed" | "cooldown";

export interface ProviderHealth {
  enabled: boolean;
  authMode: string;
  state: ProviderStateName;
  credentialPresent: boolean;
  signinRefreshedAt: number | null;
  signinStale: boolean;
  cooldownUntil: number | null;
  lastSuccessAt: number | null;
  lastErrorKind: ProviderErrorKind | null;
}

export interface GatewayHealth {
  ready: boolean;
  killed: boolean;
  alerts: string[];
  providers: Record<ProviderId, ProviderHealth>;
  usage: ReturnType<UsageLedger["snapshot"]>;
}

interface ProviderState {
  cooldownUntil: number;
  rejectedFingerprint: string | null;
  rejectedAt: number;
  lastSuccessAt: number | null;
  lastErrorKind: ProviderErrorKind | null;
}

export class ProviderGateway {
  private readonly config: GatewayConfig;
  private readonly stateDir: string;
  private readonly env: Env;
  private readonly adapters: Record<ProviderId, ProviderAdapter>;
  private readonly ledger: UsageLedger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly state: Record<ProviderId, ProviderState> = {
    claude: freshState(),
    codex: freshState(),
  };

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.adapters = {
      claude: options.adapters?.claude ?? createClaudeAdapter(options.config, options.stateDir, options.env),
      codex: options.adapters?.codex ?? createCodexAdapter(options.config, options.stateDir, options.env),
    };
    this.ledger = new UsageLedger(options.config.ceilings, join(options.stateDir, "gateway-usage.jsonl"), this.now);
  }

  async run(request: GatewayRequest): Promise<GatewayResult> {
    assertStrictSchema(request.outputSchema);
    if (!Object.hasOwn(this.config.routes, request.tier)) throw new TypeError(`unknown tier ${String(request.tier)}`);
    const started = this.now();
    const route = this.config.routes[request.tier];
    const adapter = this.adapters[route.provider];
    const state = this.state[route.provider];
    let usage: Usage = zeroUsage();
    let costUsd = 0;
    let attempts = 0;
    let modelsUsed: string[] = [];
    let toolCalls: ToolCall[] = [];
    const base = () => ({
      specialist: request.specialist,
      tier: request.tier,
      provider: route.provider,
      model: route.model,
      modelsUsed,
      authMode: adapter.authMode,
      attempts,
      usage,
      costUsd,
      durationMs: this.now() - started,
      hashes: {
        system: sha256(request.system),
        prompt: sha256(request.prompt),
        schema: sha256(canonicalJson(request.outputSchema)),
      },
      toolCalls,
    });
    const abstain = (reason: AbstainReason, detail: string, retryAt?: number): GatewayResult => ({
      ...base(),
      status: "abstained",
      reason,
      detail: redact(detail),
      ...(retryAt === undefined ? {} : { retryAt }),
    });

    if (this.killed()) return abstain("kill_switch", "the agent host kill switch is engaged");
    const tiers = this.config.specialists[request.specialist];
    if (!tiers) return abstain("unknown_specialist", `${request.specialist} is not a registered specialist`);
    if (!tiers.includes(request.tier)) {
      return abstain("tier_not_allowed", `${request.specialist} may not run on the ${request.tier} tier`);
    }
    if (!this.config.providers[route.provider].enabled) {
      return abstain("provider_disabled", `${route.provider} is disabled in the gateway configuration`);
    }
    if (state.cooldownUntil > this.now()) {
      return abstain("rate_limited", `${route.provider} is cooling down after a rate limit`, state.cooldownUntil);
    }
    let credential = await adapter.credential();
    if (!credential.fingerprint) {
      return abstain("credential_missing", `${route.provider} ${adapter.authMode} credential is not configured`);
    }
    if (this.stillRejected(state, credential.fingerprint)) {
      return abstain("auth_failed", `${route.provider} rejected this ${adapter.authMode} credential; refresh or replace it`);
    }
    // Past the probe interval the rejected credential gets exactly one probe: claiming it here
    // keeps concurrent runs abstaining until the probe answers.
    if (state.rejectedFingerprint === credential.fingerprint) state.rejectedAt = this.now();

    const { maxAttempts, maxDelayMs } = this.config.retry;
    for (;;) {
      const reserved = this.ledger.reserve(request.specialist, route.provider, route.model);
      if ("refusal" in reserved) {
        const detail =
          reserved.refusal === "ledger_unavailable"
            ? "the usage ledger cannot be written, so no ceiling can be enforced"
            : `${request.specialist} reached its ${reserved.refusal.replace("_", " ")}`;
        return abstain(reserved.refusal, detail);
      }
      attempts += 1;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
      let failure: ProviderError;
      let settled = false;
      try {
        const outcome = await adapter.call({
          model: route.model,
          effort: route.effort,
          system: request.system,
          prompt: request.prompt,
          outputSchema: providerSchema(request.outputSchema),
          tools: request.tools,
          maxTurns: request.maxTurns ?? this.config.maxTurns,
          maxCostUsd: reserved.reservation.costUsd,
          signal,
        });
        usage = addUsage(usage, outcome.usage);
        costUsd += finite(outcome.costUsd);
        modelsUsed = outcome.modelsUsed;
        toolCalls = outcome.toolCalls;
        this.ledger.settle(reserved.reservation, "ok", outcome.costUsd, outcome.usage);
        settled = true;
        state.lastSuccessAt = this.now();
        state.rejectedFingerprint = null;
        if (modelsUsed.some((used) => !sameModel(used, route.model))) {
          return abstain("model_mismatch", `${route.provider} answered with ${modelsUsed.join(", ")} instead of ${route.model}`);
        }
        const errors = validate(request.outputSchema, outcome.output);
        if (errors.length > 0) return abstain("invalid_output", errors.join("; "));
        return { ...base(), status: "ok", output: outcome.output };
      } catch (error) {
        failure =
          error instanceof ProviderError
            ? error
            : new ProviderError(timeout.signal.aborted ? "transient" : "fatal", String(error));
        if (request.signal?.aborted) failure = new ProviderError("aborted", "the run was cancelled", failure);
        else if (timeout.signal.aborted && failure.kind !== "transient") {
          failure = new ProviderError("transient", `no answer within ${this.config.timeoutMs} ms`, failure);
        }
        if (settled) throw error;
        usage = addUsage(usage, failure.usage);
        costUsd += finite(failure.costUsd);
        this.ledger.settle(reserved.reservation, failure.kind, failure.costUsd, failure.usage);
        state.lastErrorKind = failure.kind;
      } finally {
        clearTimeout(timer);
      }

      const backoff = this.backoff(attempts);
      switch (failure.kind) {
        case "rate_limit": {
          const wait = failure.retryAfterMs ?? backoff;
          if (attempts >= maxAttempts || wait > maxDelayMs) {
            state.cooldownUntil = this.now() + Math.max(wait, backoff);
            return abstain("rate_limited", failure.message, state.cooldownUntil);
          }
          if (!(await this.pause(wait, request.signal))) return abstain("aborted", "the run was cancelled");
          continue;
        }
        case "transient": {
          if (attempts >= maxAttempts) return abstain("provider_error", failure.message);
          if (!(await this.pause(backoff, request.signal))) return abstain("aborted", "the run was cancelled");
          continue;
        }
        case "auth": {
          // A refreshed or rotated credential is picked up without a restart. The rejected one is
          // left alone until it changes or the probe interval passes, so a dead sign-in costs one
          // provider call per interval, not a storm. Only the credential actually tried is marked.
          const fresh = await adapter.credential();
          if (fresh.fingerprint && fresh.fingerprint !== credential.fingerprint && attempts < maxAttempts) {
            credential = fresh;
            continue;
          }
          state.rejectedFingerprint = credential.fingerprint;
          state.rejectedAt = this.now();
          return abstain("auth_failed", failure.message);
        }
        case "budget":
          return abstain("cost_ceiling", failure.message);
        case "invalid_output":
          return abstain("invalid_output", failure.message);
        case "aborted":
          return abstain("aborted", failure.message);
        default:
          return abstain("provider_error", failure.message);
      }
    }
  }

  async health(): Promise<GatewayHealth> {
    const killed = this.killed();
    const alerts: string[] = [];
    if (killed) alerts.push("kill_switch_engaged");
    const providers = {} as Record<ProviderId, ProviderHealth>;
    for (const id of ["claude", "codex"] as const) {
      const adapter = this.adapters[id];
      const state = this.state[id];
      const credential = await adapter.credential();
      const enabled = this.config.providers[id].enabled;
      const refreshedAt = credential.refreshedAt ?? null;
      const signinStale =
        id === "codex" &&
        adapter.authMode === "chatgpt" &&
        credential.fingerprint !== null &&
        (refreshedAt === null || this.now() - refreshedAt > this.config.providers.codex.signinMaxAgeHours * 3_600_000);
      let name: ProviderStateName = "ready";
      if (!enabled) name = "disabled";
      else if (!credential.fingerprint) name = "credential_missing";
      else if (state.rejectedFingerprint === credential.fingerprint) name = "auth_failed";
      else if (state.cooldownUntil > this.now()) name = "cooldown";
      if (name !== "ready" && name !== "disabled") alerts.push(`${id}_${name}`);
      if (signinStale) alerts.push(`${id}_signin_not_refreshing`);
      providers[id] = {
        enabled,
        authMode: adapter.authMode,
        state: name,
        credentialPresent: credential.fingerprint !== null,
        signinRefreshedAt: refreshedAt,
        signinStale,
        cooldownUntil: state.cooldownUntil > this.now() ? state.cooldownUntil : null,
        lastSuccessAt: state.lastSuccessAt,
        lastErrorKind: state.lastErrorKind,
      };
    }
    const degraded = this.ledger.isDegraded();
    if (degraded) alerts.push("ledger_unavailable");
    const routed = new Set(Object.values(this.config.routes).map((route) => route.provider));
    const ready = !killed && !degraded && [...routed].every((id) => providers[id].state === "ready");
    return { ready, killed, alerts, providers, usage: this.ledger.snapshot() };
  }

  private stillRejected(state: ProviderState, fingerprint: string | null): boolean {
    return (
      fingerprint !== null &&
      state.rejectedFingerprint === fingerprint &&
      this.now() - state.rejectedAt < this.config.retry.authProbeAfterMs
    );
  }

  private killed(): boolean {
    return this.env[KILL_SWITCH_ENV] === "1" || existsSync(join(this.stateDir, KILL_SWITCH_FILE));
  }

  private backoff(attempt: number): number {
    const { baseDelayMs, maxDelayMs } = this.config.retry;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  private async pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await this.sleep(ms, signal ?? new AbortController().signal);
      return !signal?.aborted;
    } catch {
      return false;
    }
  }
}

/** Providers may report a dated (`-20260901`) or context-suffixed (`[1m]`) id for the configured model. */
function sameModel(used: string, configured: string): boolean {
  if (!used.startsWith(configured)) return false;
  return /^(?:-\d{8})?(?:\[[^\]]+\])?$/.test(used.slice(configured.length));
}

function freshState(): ProviderState {
  return { cooldownUntil: 0, rejectedFingerprint: null, rejectedAt: 0, lastSuccessAt: null, lastErrorKind: null };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + finite(b.inputTokens),
    cachedInputTokens: a.cachedInputTokens + finite(b.cachedInputTokens),
    outputTokens: a.outputTokens + finite(b.outputTokens),
  };
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Abstention details reach receipts; strip anything credential-shaped and bound the length. */
export function redact(detail: string): string {
  return detail
    .replace(/\b(sk|sess|rt|ak)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_\-+/=.]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
