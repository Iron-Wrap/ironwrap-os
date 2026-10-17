// The provider gateway: one interface over Claude (Agent SDK) and Codex (Codex SDK).
//
// Order of checks for every run: kill switch, registered specialist and tier, a route of another
// family for work under review, provider enabled, provider cooldown, credential present and not
// already rejected, call and cost ceilings. A failed check is an abstention with a stable reason;
// the gateway never falls back to another provider or model, so a specialist whose provider is
// unavailable abstains and its receipt says why.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AUDITOR, parseQualification, parseRoute, proposerRoutes, type GatewayConfig, type Qualification } from "./config.ts";
import { UsageLedger, type Limits } from "./ledger.ts";
import { assertStrictSchema, canonicalJson, providerSchema, sha256, validate } from "./schema.ts";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import {
  ProviderError,
  zeroUsage,
  type AbstainReason,
  type CredentialState,
  type GatewayRequest,
  type GatewayResult,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ProviderId,
  type Route,
  type Scope,
  type Tier,
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
  /**
   * The `ledger` and `judge` blocks of `agent-host/evals/qualification.v1.json`. They make this an
   * eval gateway: it serves only `scope: "eval"` requests and books them, the judge's included,
   * in `<state>/gateway-usage-eval.jsonl` under `eval:` keys against the block's ceilings.
   */
  qualification?: { ledger: unknown; judge: unknown };
}

/** A run's route, or why no route may run it. */
type Resolution = { id: string; route: Route } | { id: null; route: null; refused: string };

export type ProviderStateName = "ready" | "disabled" | "credential_missing" | "auth_failed" | "plan_lacks_model" | "cooldown";

export interface ProviderHealth {
  enabled: boolean;
  authMode: string;
  state: ProviderStateName;
  credentialPresent: boolean;
  signinRefreshedAt: number | null;
  signinStale: boolean;
  /** The subscription plan a Codex ChatGPT sign-in claims; null when it claims none. */
  plan: string | null;
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
  /** Routed models the provider refused for the sign-in's plan: the credential and when. */
  planRefused: Map<string, { fingerprint: string; at: number }>;
  lastSuccessAt: number | null;
  lastErrorKind: ProviderErrorKind | null;
}

export class ProviderGateway {
  private readonly config: GatewayConfig;
  private readonly stateDir: string;
  private readonly env: Env;
  private readonly adapters: Record<ProviderId, ProviderAdapter>;
  private readonly qualification: Qualification | null;
  /** Why an audit that names no run under review may not use tiers.audit, or null when it may. */
  private readonly unreviewedAudit: string | null;
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
    this.qualification = options.qualification ? parseQualification(options.qualification, options.config) : null;
    // Such an audit cannot be checked per run, so tiers.audit serves it only while no proposer
    // route is on that route's family.
    const audit = options.config.tiers.audit;
    const family = options.config.routes[audit].provider;
    const shared = proposerRoutes(options.config).find((id) => options.config.routes[id].provider === family);
    this.unreviewedAudit =
      shared === undefined ? null : `tiers.audit (${audit}) runs on ${family} like proposer route ${shared}; name the run under review`;
    this.adapters = {
      claude: options.adapters?.claude ?? createClaudeAdapter(options.config, options.stateDir, options.env),
      codex: options.adapters?.codex ?? createCodexAdapter(options.config, options.stateDir, options.env),
    };
    // Eval spend gets its own file as well as its own keys, so an eval run never touches the
    // production books.
    this.ledger = this.qualification
      ? new UsageLedger(join(options.stateDir, "gateway-usage-eval.jsonl"), this.qualification.windowHours, this.now)
      : new UsageLedger(join(options.stateDir, "gateway-usage.jsonl"), options.config.ceilings.windowHours, this.now);
  }

  async run(request: GatewayRequest): Promise<GatewayResult> {
    assertStrictSchema(request.outputSchema);
    if (!Object.hasOwn(this.config.tiers, request.tier)) throw new TypeError(`unknown tier ${String(request.tier)}`);
    const scope = this.scopeOf(request);
    const batch = this.batchRoutes(request.tierRoutes);
    const judge = this.qualification !== null && request.specialist === this.qualification.judgeKey;
    if (judge && !request.reviewOf) throw new TypeError("a judge request names the run it scores in reviewOf");
    const started = this.now();
    const resolved = this.resolve(request, judge, batch);
    let usage: Usage = zeroUsage();
    let costUsd = 0;
    let attempts = 0;
    let modelsUsed: string[] = [];
    let toolCalls: ToolCall[] = [];
    const base = () => ({
      specialist: request.specialist,
      tier: request.tier,
      routeId: resolved.id,
      reviewOf: request.reviewOf ? { runId: request.reviewOf.runId, provider: request.reviewOf.provider } : null,
      provider: resolved.route?.provider ?? null,
      model: resolved.route?.model ?? null,
      modelsUsed,
      authMode: resolved.route ? this.adapters[resolved.route.provider].authMode : null,
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
    // Waiting out the next backoff is all a provider failure or a wrong served model allows.
    const afterBackoff = () => this.now() + this.backoff(Math.max(attempts, 1));

    if (this.killed()) return abstain("kill_switch", "the agent host kill switch is engaged");
    // A judge is no specialist: it scores one run, on the route the run's family dictates.
    if (!judge) {
      const specialist = Object.hasOwn(this.config.specialists, request.specialist) ? this.config.specialists[request.specialist] : null;
      if (!specialist) return abstain("unknown_specialist", `${request.specialist} is not a registered specialist`);
      if (!specialist.tiers.includes(request.tier)) {
        return abstain("tier_not_allowed", `${request.specialist} may not run on the ${request.tier} tier`);
      }
    }
    if (resolved.route === null) return abstain("no_independent_route", resolved.refused);
    const route = resolved.route;
    const adapter = this.adapters[route.provider];
    const state = this.state[route.provider];
    const books = this.books(request.specialist, scope, judge);
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
    const planGap = this.planGap(route.provider, route.model, credential, true);
    if (planGap) return abstain("provider_error", planGap.detail, planGap.retryAt);

    const { maxAttempts, maxDelayMs } = this.config.retry;
    for (;;) {
      const reserved = this.ledger.reserve(books.key, books.limits, route.provider, route.model);
      if ("refusal" in reserved) {
        const detail =
          reserved.refusal === "ledger_unavailable"
            ? "the usage ledger cannot be written, so no ceiling can be enforced"
            : `${books.key} reached its ${reserved.refusal.replace("_", " ")}`;
        return abstain(reserved.refusal, detail, reserved.retryAt);
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
        state.planRefused.delete(route.model);
        if (modelsUsed.some((used) => !sameModel(used, route.model))) {
          return abstain("model_mismatch", `${route.provider} answered with ${modelsUsed.join(", ")} instead of ${route.model}`, afterBackoff());
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
          if (attempts >= maxAttempts) return abstain("provider_error", failure.message, afterBackoff());
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
            const freshGap = this.planGap(route.provider, route.model, credential, true);
            if (freshGap) return abstain("provider_error", freshGap.detail, freshGap.retryAt);
            continue;
          }
          state.rejectedFingerprint = credential.fingerprint;
          state.rejectedAt = this.now();
          return abstain("auth_failed", failure.message);
        }
        case "plan": {
          // The call proved the credential is accepted, so an older auth rejection no longer holds.
          // The same sign-in is refused for this model until it changes or one probe per
          // `auth_probe_after_ms` succeeds, which also notices a plan upgraded on the provider side.
          if (state.rejectedFingerprint === credential.fingerprint) state.rejectedFingerprint = null;
          if (!credential.fingerprint) return abstain("provider_error", failure.message);
          const at = this.now();
          state.planRefused.set(route.model, { fingerprint: credential.fingerprint, at });
          return abstain("provider_error", failure.message, at + this.config.retry.authProbeAfterMs);
        }
        case "budget":
          // One call outgrew its per-call ceiling: the same run would again, so no retry time.
          return abstain("cost_ceiling", failure.message);
        case "invalid_output":
          return abstain("invalid_output", failure.message);
        case "aborted":
          return abstain("aborted", failure.message);
        default:
          return abstain("provider_error", failure.message, afterBackoff());
      }
    }
  }

  /** A request for the wrong books is a programming error, like an unknown tier. */
  private scopeOf(request: GatewayRequest): Scope {
    const scope = request.scope ?? "production";
    if (scope !== "production" && scope !== "shadow" && scope !== "eval") throw new TypeError(`unknown scope ${String(scope)}`);
    if (this.qualification && scope !== "eval") throw new TypeError(`an eval gateway serves only eval requests, not ${scope}`);
    if (!this.qualification && scope === "eval") throw new TypeError("an eval request needs an eval gateway (the qualification option)");
    if (request.tierRoutes !== undefined && scope !== "eval") throw new TypeError("tierRoutes is for eval requests only");
    return scope;
  }

  /** An eval batch's routes, held to the same rules as configured routes. */
  private batchRoutes(tierRoutes: GatewayRequest["tierRoutes"]): Partial<Record<Tier, Route>> {
    const batch: Partial<Record<Tier, Route>> = {};
    for (const [tier, raw] of Object.entries(tierRoutes ?? {})) {
      if (tier !== "routine" && tier !== "hard") throw new TypeError(`tierRoutes.${tier}: only the routine and hard tiers take a batch route`);
      let route: Route;
      try {
        route = parseRoute(raw, `tierRoutes.${tier}`);
      } catch (error) {
        throw new TypeError((error as Error).message);
      }
      if (route.provider === "codex" && !Object.hasOwn(this.config.pricingUsdPerMTok, route.model)) {
        throw new TypeError(`tierRoutes.${tier}: codex model ${route.model} has no pricing_usd_per_mtok entry`);
      }
      batch[tier] = route;
    }
    return batch;
  }

  /**
   * Work under review goes to a route of another family than the work's: the judge's route on an
   * eval gateway, `audit_routes` for the auditor; with none there is no route. An audit naming no
   * run under review gets no route while a proposer route shares tiers.audit's family. Otherwise an
   * eval batch route for the tier wins, so a comparison runs every case on the compared model; then
   * the specialist's route for the expected action, the specialist's own route, and the tier's.
   */
  private resolve(request: GatewayRequest, judge: boolean, batch: Partial<Record<Tier, Route>>): Resolution {
    const review = request.reviewOf;
    if (review && (judge || request.specialist === AUDITOR)) {
      let id: string | undefined;
      let route: Route | undefined;
      if (this.qualification && judge) {
        const field = review.provider === "claude" ? "for_claude_proposers" : review.provider === "codex" ? "default" : undefined;
        if (field) {
          id = `judge.${field}`;
          route = this.qualification.judgeRoutes[field];
        }
      } else if (Object.hasOwn(this.config.auditRoutes, review.provider)) {
        id = this.config.auditRoutes[review.provider];
        route = id === undefined ? undefined : this.config.routes[id];
      }
      // Checked per run as well as in the configuration: no route may review its own family's work.
      if (id === undefined || route === undefined || route.provider === review.provider) {
        return { id: null, route: null, refused: `no route of another family than ${String(review.provider)} may review run ${String(review.runId)}` };
      }
      return { id, route };
    }
    if (request.specialist === AUDITOR && !review && this.unreviewedAudit !== null) {
      return { id: null, route: null, refused: this.unreviewedAudit };
    }
    const tierBatch = batch[request.tier];
    if (tierBatch) return { id: `tier_routes.${request.tier}`, route: tierBatch };
    const specialist = Object.hasOwn(this.config.specialists, request.specialist) ? this.config.specialists[request.specialist] : undefined;
    const action =
      specialist && request.action !== undefined && Object.hasOwn(specialist.actions, request.action) ? specialist.actions[request.action] : undefined;
    const id = action ?? specialist?.route ?? this.config.tiers[request.tier];
    return { id, route: this.config.routes[id] };
  }

  /** The ledger key and ceilings of a run: live, shadow and eval spend never share a ceiling. */
  private books(specialist: string, scope: Scope, judge: boolean): { key: string; limits: Limits } {
    const qualification = this.qualification;
    if (qualification) {
      return { key: `eval:${specialist}`, limits: { own: judge ? qualification.judge : qualification.specialist, team: qualification.team } };
    }
    const ceilings = this.config.ceilings;
    if (scope === "shadow") return { key: `shadow:${specialist}`, limits: { own: ceilings.shadow.specialist, team: ceilings.shadow.team } };
    const own = Object.hasOwn(ceilings.specialists, specialist) ? ceilings.specialists[specialist] : ceilings.specialistDefault;
    return { key: specialist, limits: { own, team: ceilings.team } };
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
      else if (this.routedModels(id).some((model) => this.planGap(id, model, credential))) name = "plan_lacks_model";
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
        plan: credential.plan ?? null,
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

  private routedModels(id: ProviderId): string[] {
    return Object.values(this.config.routes)
      .filter((route) => route.provider === id)
      .map((route) => route.model);
  }

  /**
   * Why this Codex ChatGPT sign-in cannot run the model, or null. A model the provider refused for
   * the sign-in waits for the next probe (`retryAt`); a plan outside the configured plans waits for
   * a new sign-in, like a rejected credential, so it has no retry time.
   */
  private planGap(
    id: ProviderId,
    model: string,
    credential: CredentialState,
    claimProbe = false,
  ): { detail: string; retryAt?: number } | null {
    if (id !== "codex" || this.adapters.codex.authMode !== "chatgpt" || !credential.fingerprint) return null;
    const action = `sign the agent host's ${this.config.providers.codex.codexHomeEnv} in with a ChatGPT plan that includes it`;
    const probeAfter = this.config.retry.authProbeAfterMs;
    const refused = this.state.codex.planRefused.get(model);
    if (refused?.fingerprint === credential.fingerprint) {
      // Past the probe interval one run may try again; claiming the probe keeps the others out.
      if (claimProbe && this.now() - refused.at >= probeAfter) refused.at = this.now();
      else {
        return {
          detail: `codex: plan does not include model ${model}; the provider refused it for this sign-in; ${action}`,
          retryAt: refused.at + probeAfter,
        };
      }
    }
    const plans = this.config.providers.codex.chatgptPlans;
    if (credential.plan !== undefined && !plans.includes(credential.plan)) {
      return {
        detail: `codex: plan does not include model ${model}; the sign-in is on the ${credential.plan} plan, configured plans are ${plans.join(", ")}; ${action}`,
      };
    }
    return null;
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
  return { cooldownUntil: 0, rejectedFingerprint: null, rejectedAt: 0, planRefused: new Map(), lastSuccessAt: null, lastErrorKind: null };
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
