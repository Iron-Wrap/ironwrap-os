// The provider gateway: one interface over the configured provider accounts, each behind its
// adapter (the Claude Agent SDK, the Codex SDK).
//
// A run resolves to one route. In production scope the route's declared fallbacks follow it (same
// family, at most two); shadow and eval runs keep the one route, so their measurements stay on one
// model. Before any booking each hop is screened, in this order:
// - a hop of the family whose work the run reviews is skipped;
// - a live or shadow run takes only a hop the Worker's qualifications name exactly (provider, model,
//   effort, the specialist's release), and every run only a hop that fits it (tools, context
//   window; a live run also needs checked registry figures). Otherwise the primary abstains
//   `no_qualified_route` and a fallback is skipped;
// - the provider must be one the run may use, enabled, and on terms that serve the run's class
//   (`provider_disabled`), not cooling down or at its rate window (`rate_limited`), with a credential
//   that is present and not rejected, on a plan that includes the model.
// A hop that passes runs the attempt loop. Only `rate_limited`, `provider_error`, `auth_failed`,
// `credential_missing` and `provider_disabled` move on to the next hop; any other reason ends the
// run. With every hop spent the run abstains with the primary's reason and the earliest retry time
// any hop named, or `no_independent_route` when every hop was of the reviewed family.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AUDITOR, chainOf, parseQualification, parseRoute, proposerRoutes, requireBookable, type GatewayConfig, type ProviderConfig, type Qualification } from "./config.ts";
import { complianceOf, runClassOf, type DataClass } from "./compliance.ts";
import { UsageLedger, type Limits } from "./ledger.ts";
import { booksUsd, entryOf, familyOf, fit, inputEstimate } from "./registry.ts";
import { assertStrictSchema, canonicalJson, providerSchema, sha256, validate } from "./schema.ts";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import {
  ProviderError,
  zeroUsage,
  type AbstainReason,
  type CredentialState,
  type FailoverHop,
  type Family,
  type GatewayRequest,
  type GatewayResult,
  type ModelEntry,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ProviderId,
  type RiskAcceptance,
  type Route,
  type RunClass,
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
  /** The host's `AGENT_HOST_DATA_CLASS`: on `synthetic`, every live and shadow run is a synthetic run. Default `business`. */
  dataClass?: DataClass;
  /** Adapters by provider id; the configured adapter of every other provider is created. */
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
type Resolution = { id: string; route: Route; reviewing: boolean } | { id: null; route: null; refused: string };

interface Hop {
  id: string;
  route: Route;
  /** Undefined only when the route lost its registry entry after the configuration was parsed. */
  entry: ModelEntry | undefined;
  /** 0 for the primary. */
  index: number;
}

type Screened =
  | { ok: true; credential: CredentialState; qualificationRef: string | null; riskAcceptance: RiskAcceptance | null }
  | { ok: false; reason: AbstainReason; detail: string; retryAt?: number; gate?: true; family?: true };

type Ended = { ok: true; output: unknown } | { ok: false; reason: AbstainReason; detail: string; retryAt?: number };

/** Reasons a production run moves on to its next hop; any other ends the run. */
const FAILOVER = new Set<AbstainReason>(["rate_limited", "provider_error", "auth_failed", "credential_missing", "provider_disabled"]);

const MINUTE_MS = 60_000;

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
  /** The latest cooldown end of any of the provider's models. */
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
  /** Cooldown end per model after a rate limit too long to wait out. */
  cooldownUntil: Map<string, number>;
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
  private readonly dataClass: DataClass;
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();
  private readonly qualification: Qualification | null;
  /** Why an audit that names no run under review may not use tiers.audit, or null when it may. */
  private readonly unreviewedAudit: string | null;
  /** Every family the registry holds; work under review on any other family has no reviewer. */
  private readonly families: Set<Family>;
  private readonly ledger: UsageLedger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly state = new Map<ProviderId, ProviderState>();
  /** Calls started within the last minute per provider and model, for the registry's rate limits. */
  private readonly windows = new Map<string, Array<{ at: number; input: number; output: number }>>();

  constructor(options: GatewayOptions) {
    const { config } = options;
    this.config = config;
    this.stateDir = options.stateDir;
    this.env = options.env;
    this.dataClass = options.dataClass ?? "business";
    if (this.dataClass !== "business" && this.dataClass !== "synthetic") throw new TypeError(`unknown data class ${String(this.dataClass)}`);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.qualification = options.qualification ? parseQualification(options.qualification, config) : null;
    // Such an audit cannot be checked per run, so tiers.audit serves it only while no proposer
    // route is on that route's family.
    const audit = config.tiers.audit;
    const family = familyOf(config, config.routes[audit]);
    const shared = proposerRoutes(config).find((id) => familyOf(config, config.routes[id]) === family);
    this.unreviewedAudit =
      shared === undefined ? null : `tiers.audit (${audit}) runs on ${family} like proposer route ${shared}; name the run under review`;
    this.families = new Set(Object.values(config.providers).flatMap((account) => Object.values(account.models).map((entry) => entry.family)));
    for (const [id, account] of Object.entries(config.providers)) {
      const injected = options.adapters && Object.hasOwn(options.adapters, id) ? options.adapters[id] : undefined;
      this.adapters.set(id, injected ?? createAdapter(account, options.stateDir, options.env));
      this.state.set(id, freshState());
    }
    // Eval spend gets its own file as well as its own keys, so an eval run never touches the
    // production books.
    this.ledger = this.qualification
      ? new UsageLedger(join(options.stateDir, "gateway-usage-eval.jsonl"), this.qualification.windowHours, this.now)
      : new UsageLedger(join(options.stateDir, "gateway-usage.jsonl"), config.ceilings.windowHours, this.now);
  }

  async run(request: GatewayRequest): Promise<GatewayResult> {
    assertStrictSchema(request.outputSchema);
    if (!Object.hasOwn(this.config.tiers, request.tier)) throw new TypeError(`unknown tier ${String(request.tier)}`);
    const scope = this.scopeOf(request);
    const runClass = runClassOf(scope, this.dataClass, request.data);
    const batch = this.batchRoutes(request.tierRoutes);
    const judge = this.qualification !== null && request.specialist === this.qualification.judgeKey;
    if (judge && !request.reviewOf) throw new TypeError("a judge request names the run it scores in reviewOf");
    const started = this.now();
    const resolved = this.resolve(request, judge, batch);
    const hops = resolved.route === null ? [] : this.hopsOf(resolved, scope);
    // The hop the result describes: the one that ran last, else the primary.
    let shown: Hop | null = hops[0] ?? null;
    let qualificationRef: string | null = null;
    let riskAcceptance: RiskAcceptance | null = null;
    const failover: FailoverHop[] = [];
    let usage: Usage = zeroUsage();
    let costUsd = 0;
    let attempts = 0;
    let modelsUsed: string[] = [];
    let toolCalls: ToolCall[] = [];
    const base = () => {
      const account = shown ? this.config.providers[shown.route.provider] : undefined;
      return {
        specialist: request.specialist,
        tier: request.tier,
        routeId: shown?.id ?? null,
        reviewOf: request.reviewOf ? { runId: request.reviewOf.runId, family: request.reviewOf.family } : null,
        provider: shown?.route.provider ?? null,
        model: shown?.route.model ?? null,
        modelsUsed,
        authMode: shown ? this.adapterOf(shown.route.provider).authMode : null,
        family: shown?.entry?.family ?? null,
        adapter: account?.adapter ?? null,
        billing: account?.billing ?? null,
        route: routeKind(shown),
        qualificationRef,
        failover: [...failover],
        runClass,
        complianceRef: account?.complianceRef ?? null,
        riskAcceptance,
        gatewayConfigSha256: this.config.sha256,
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
      };
    };
    const abstain = (reason: AbstainReason, detail: string, retryAt?: number): GatewayResult => ({
      ...base(),
      status: "abstained",
      reason,
      detail: redact(detail),
      ...(retryAt === undefined ? {} : { retryAt }),
    });

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
    const books = this.books(request.specialist, scope, judge);

    // One hop's attempt loop: the run's usage, cost and attempts add up over every hop.
    const runHop = async (hop: Hop, entry: ModelEntry, admitted: CredentialState): Promise<Ended> => {
      const { route } = hop;
      const account = this.config.providers[route.provider];
      const adapter = this.adapterOf(route.provider);
      const state = this.stateOf(route.provider);
      let credential = admitted;
      let hopAttempts = 0;
      const fail = (reason: AbstainReason, detail: string, retryAt?: number): Ended => ({ ok: false, reason, detail, ...(retryAt === undefined ? {} : { retryAt }) });
      // Waiting out the next backoff is all a provider failure or a wrong served model allows.
      const afterBackoff = () => this.now() + this.backoff(Math.max(hopAttempts, 1));
      const { maxAttempts, maxDelayMs } = this.config.retry;
      const estimate = inputEstimate(request);
      for (;;) {
        // Checked again before every attempt, retries and later hops included: the kill switch and
        // a cancellation end the run, and the rate window is checked and entered with no await in
        // between, so concurrent runs cannot all pass it.
        if (this.killed()) return fail("kill_switch", "the agent host kill switch is engaged");
        if (request.signal?.aborted) return fail("aborted", "the run was cancelled");
        const windowEnd = this.windowEnd(route, entry, estimate);
        if (windowEnd !== null) return fail("rate_limited", `${route.provider}/${route.model} reached its per-minute rate limit`, windowEnd);
        const reserved = this.ledger.reserve(books.key, books.limits, {
          provider: route.provider,
          model: route.model,
          routeId: hop.id,
          route: hop.index === 0 ? "primary" : "declared_fallback",
          billing: account.billing,
          usd: booksUsd(account.adapter, entry),
          runClass,
          complianceRef: account.complianceRef,
          riskAcceptance,
        });
        if ("refusal" in reserved) {
          const detail =
            reserved.refusal === "ledger_unavailable"
              ? "the usage ledger cannot be written, so no ceiling can be enforced"
              : `${books.key} reached its ${reserved.ceiling === "token" ? "token ceiling" : reserved.refusal.replace("_", " ")}`;
          return fail(reserved.refusal, detail, reserved.retryAt);
        }
        attempts += 1;
        hopAttempts += 1;
        const windowed = this.enterWindow(route, estimate);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
        let failure: ProviderError;
        let settled = false;
        try {
          const outcome = await adapter.call({
            model: route.model,
            entry,
            effort: route.effort,
            system: request.system,
            prompt: request.prompt,
            outputSchema: providerSchema(request.outputSchema),
            tools: request.tools,
            maxTurns: request.maxTurns ?? this.config.maxTurns,
            maxCostUsd: books.limits.own.costUsdPerCall,
            signal,
          });
          usage = addUsage(usage, outcome.usage);
          costUsd += finite(outcome.costUsd);
          modelsUsed = outcome.modelsUsed;
          toolCalls = outcome.toolCalls;
          this.ledger.settle(reserved.reservation, "ok", outcome.costUsd, outcome.usage);
          settled = true;
          windowed.input = finite(outcome.usage.inputTokens);
          windowed.output = finite(outcome.usage.outputTokens);
          state.lastSuccessAt = this.now();
          state.rejectedFingerprint = null;
          state.planRefused.delete(route.model);
          if (modelsUsed.some((used) => !sameModel(used, route.model))) {
            return fail("model_mismatch", `${route.provider} answered with ${modelsUsed.join(", ")} instead of ${route.model}`, afterBackoff());
          }
          const errors = validate(request.outputSchema, outcome.output);
          if (errors.length > 0) return fail("invalid_output", errors.join("; "));
          return { ok: true, output: outcome.output };
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
          windowed.input = Math.max(windowed.input, finite(failure.usage.inputTokens));
          windowed.output = finite(failure.usage.outputTokens);
          state.lastErrorKind = failure.kind;
        } finally {
          clearTimeout(timer);
        }

        const backoff = this.backoff(hopAttempts);
        switch (failure.kind) {
          case "rate_limit": {
            const wait = failure.retryAfterMs ?? backoff;
            if (hopAttempts >= maxAttempts || wait > maxDelayMs) {
              const until = this.now() + Math.max(wait, backoff);
              state.cooldownUntil.set(route.model, until);
              return fail("rate_limited", failure.message, until);
            }
            if (!(await this.pause(wait, request.signal))) return fail("aborted", "the run was cancelled");
            continue;
          }
          case "transient": {
            if (hopAttempts >= maxAttempts) return fail("provider_error", failure.message, afterBackoff());
            if (!(await this.pause(backoff, request.signal))) return fail("aborted", "the run was cancelled");
            continue;
          }
          case "auth": {
            // A refreshed or rotated credential is picked up without a restart. The rejected one is
            // left alone until it changes or the probe interval passes, so a dead sign-in costs one
            // provider call per interval, not a storm. Only the credential actually tried is marked.
            const fresh = await adapter.credential();
            if (fresh.fingerprint && fresh.fingerprint !== credential.fingerprint && hopAttempts < maxAttempts) {
              credential = fresh;
              const freshGap = this.planGap(route.provider, route.model, credential, true);
              if (freshGap) return fail("provider_error", freshGap.detail, freshGap.retryAt);
              continue;
            }
            state.rejectedFingerprint = credential.fingerprint;
            state.rejectedAt = this.now();
            return fail("auth_failed", failure.message);
          }
          case "plan": {
            // The call proved the credential is accepted, so an older auth rejection no longer holds.
            // The same sign-in is refused for this model until it changes or one probe per
            // `auth_probe_after_ms` succeeds, which also notices a plan upgraded on the provider side.
            if (state.rejectedFingerprint === credential.fingerprint) state.rejectedFingerprint = null;
            if (!credential.fingerprint) return fail("provider_error", failure.message);
            const at = this.now();
            state.planRefused.set(route.model, { fingerprint: credential.fingerprint, at });
            return fail("provider_error", failure.message, at + this.config.retry.authProbeAfterMs);
          }
          case "budget":
            // One call outgrew its per-call ceiling: the same run would again, so no retry time.
            return fail("cost_ceiling", failure.message);
          case "invalid_output":
            return fail("invalid_output", failure.message);
          case "aborted":
            return fail("aborted", failure.message);
          default:
            return fail("provider_error", failure.message, afterBackoff());
        }
      }
    };

    const details: string[] = [];
    const admitted: Array<{ qualificationRef: string | null; riskAcceptance: RiskAcceptance | null } | null> = [];
    let familySkips = 0;
    for (const hop of hops) {
      const screened = await this.screen(hop, hops[0], request, runClass, resolved.reviewing);
      if (!screened.ok) {
        failover.push(hopRecord(hop, screened.reason, screened.retryAt));
        details.push(screened.detail);
        admitted.push(null);
        if (screened.family) familySkips += 1;
        // An unqualified or unfit primary is no outage to route around: the run abstains.
        if (screened.gate && hop.index === 0) return abstain(screened.reason, screened.detail);
        continue;
      }
      shown = hop;
      qualificationRef = screened.qualificationRef;
      riskAcceptance = screened.riskAcceptance;
      admitted.push({ qualificationRef, riskAcceptance });
      const ended = await runHop(hop, hop.entry as ModelEntry, screened.credential);
      if (ended.ok) return { ...base(), status: "ok", output: ended.output };
      failover.push(hopRecord(hop, ended.reason, ended.retryAt));
      details.push(ended.detail);
      if (!FAILOVER.has(ended.reason)) return abstain(ended.reason, ended.detail, ended.retryAt);
    }
    if (familySkips === hops.length) {
      shown = null;
      qualificationRef = null;
      riskAcceptance = null;
      return abstain("no_independent_route", details[0]);
    }
    // Every hop was refused or failed: the primary's reason, and the earliest time any hop frees.
    shown = hops[0];
    qualificationRef = admitted[0]?.qualificationRef ?? null;
    riskAcceptance = admitted[0]?.riskAcceptance ?? null;
    const first = failover.findIndex((hop) => hop.reason !== "no_independent_route");
    const times = failover.map((hop) => hop.retryAt).filter((at): at is number => at !== null);
    return abstain(failover[first].reason, details[first], times.length > 0 ? Math.min(...times) : undefined);
  }

  /** A request for the wrong books is a programming error, like an unknown tier. */
  private scopeOf(request: GatewayRequest): Scope {
    const scope = request.scope ?? "production";
    if (scope !== "production" && scope !== "shadow" && scope !== "eval") throw new TypeError(`unknown scope ${String(scope)}`);
    if (this.qualification && scope !== "eval") throw new TypeError(`an eval gateway serves only eval requests, not ${scope}`);
    if (!this.qualification && scope === "eval") throw new TypeError("an eval request needs an eval gateway (the qualification option)");
    if (request.tierRoutes !== undefined && scope !== "eval") throw new TypeError("tierRoutes is for eval requests only");
    if (request.data !== undefined && scope !== "eval") throw new TypeError("data is for eval requests only");
    if (request.data !== undefined && request.data !== "synthetic" && request.data !== "history") throw new TypeError(`unknown eval data ${String(request.data)}`);
    return scope;
  }

  /** An eval batch's routes, held to the same rules as configured routes. */
  private batchRoutes(tierRoutes: GatewayRequest["tierRoutes"]): Partial<Record<Tier, Route>> {
    const batch: Partial<Record<Tier, Route>> = {};
    for (const [tier, raw] of Object.entries(tierRoutes ?? {})) {
      if (tier !== "routine" && tier !== "hard") throw new TypeError(`tierRoutes.${tier}: only the routine and hard tiers take a batch route`);
      try {
        const route = parseRoute(raw, `tierRoutes.${tier}`, this.config);
        const books = this.qualification as Qualification;
        requireBookable(this.config, route, [books.team, books.specialist], `tierRoutes.${tier}.model`);
        batch[tier] = route;
      } catch (error) {
        throw new TypeError((error as Error).message);
      }
    }
    return batch;
  }

  /**
   * Work under review goes to a route of another family than the work's: the judge's route on an
   * eval gateway (`for_claude_proposers` for anthropic work, `default` for any other family),
   * `audit_routes` for the auditor; with none there is no route. An audit naming no run under
   * review gets no route while a proposer route shares tiers.audit's family. Otherwise an eval batch
   * route for the tier wins, so a comparison runs every case on the compared model; then the
   * specialist's route for the expected action, the specialist's own route, and the tier's.
   */
  private resolve(request: GatewayRequest, judge: boolean, batch: Partial<Record<Tier, Route>>): Resolution {
    const review = request.reviewOf;
    if (review && (judge || request.specialist === AUDITOR)) {
      const refused = { id: null, route: null, refused: `no route of another family than ${String(review.family)} may review run ${String(review.runId)}` } as const;
      if (!this.families.has(review.family)) return refused;
      if (this.qualification && judge) {
        const field = review.family === "anthropic" ? "for_claude_proposers" : "default";
        return { id: `judge.${field}`, route: this.qualification.judgeRoutes[field], reviewing: true };
      }
      if (!Object.hasOwn(this.config.auditRoutes, review.family)) return refused;
      const id = this.config.auditRoutes[review.family];
      return { id, route: this.config.routes[id], reviewing: true };
    }
    if (request.specialist === AUDITOR && !review && this.unreviewedAudit !== null) {
      return { id: null, route: null, refused: this.unreviewedAudit };
    }
    const tierBatch = batch[request.tier];
    if (tierBatch) return { id: `tier_routes.${request.tier}`, route: tierBatch, reviewing: false };
    const specialist = Object.hasOwn(this.config.specialists, request.specialist) ? this.config.specialists[request.specialist] : undefined;
    const action =
      specialist && request.action !== undefined && Object.hasOwn(specialist.actions, request.action) ? specialist.actions[request.action] : undefined;
    const id = action ?? specialist?.route ?? this.config.tiers[request.tier];
    return { id, route: this.config.routes[id], reviewing: false };
  }

  /** The resolved route and, in production scope only, its declared fallback chain. */
  private hopsOf(resolved: { id: string; route: Route }, scope: Scope): Hop[] {
    const ids = scope === "production" && Object.hasOwn(this.config.routes, resolved.id) ? chainOf(this.config, resolved.id) : [resolved.id];
    return ids.map((id, index) => {
      const route = index === 0 ? resolved.route : this.config.routes[id];
      return { id, route, entry: entryOf(this.config, route), index };
    });
  }

  /** Every check one hop must pass before it books anything; see the order at the top of the file. */
  private async screen(hop: Hop, primary: Hop, request: GatewayRequest, runClass: RunClass, reviewing: boolean): Promise<Screened> {
    const { id: routeId, route, entry } = hop;
    const provider = route.provider;
    const where = `${provider}/${route.model}`;
    const gate = (detail: string): Screened => ({ ok: false, reason: "no_qualified_route", detail, gate: true });
    const unavailable = (reason: AbstainReason, detail: string, retryAt?: number): Screened => ({ ok: false, reason, detail, ...(retryAt === undefined ? {} : { retryAt }) });
    const review = request.reviewOf;
    // Checked per hop as well as in the configuration: no hop reviews its own family's work.
    if (reviewing && review && entry?.family === review.family) {
      return { ok: false, reason: "no_independent_route", detail: `no route of another family than ${review.family} may review run ${review.runId}`, family: true };
    }
    if (!entry) return gate(`${where} has no registry entry; unregistered models are never routed`);
    if (hop.index > 0 && entry.family !== primary.entry?.family) return gate(`fallback ${routeId} is on ${entry.family}, not its primary's family`);
    let qualificationRef: string | null = null;
    if (runClass === "live" || runClass === "shadow") {
      const qualified = (request.qualifications ?? []).find(
        (row) => request.release !== undefined && row.provider === provider && row.model === route.model && row.effort === route.effort && row.release === request.release,
      );
      if (!qualified) {
        // The release's first 12 hex digits name it; the whole hash would read as a credential to redact().
        return gate(`no qualification of ${where} at ${route.effort} effort for release ${request.release?.slice(0, 12) ?? "(none)"} of ${request.specialist}; ${runClass} runs take qualified routes only`);
      }
      qualificationRef = qualified.id;
    }
    const unfit = fit(entry, request);
    if (unfit) return gate(`${where} does not fit the run: ${unfit}`);
    if (runClass === "live" && entry.unverified.length > 0) {
      return gate(`${where} has registry figures not checked against provider docs (${entry.unverified.join(", ")}); live runs take checked figures only`);
    }
    if (request.providers !== undefined && !request.providers.includes(provider)) return unavailable("provider_disabled", `${provider} is not a provider this run may use`);
    const account = this.config.providers[provider];
    if (!account.enabled) return unavailable("provider_disabled", `${provider} is disabled in the gateway configuration`);
    const terms = complianceOf(account, runClass, this.config.ownerRiskAcceptances);
    if ("refused" in terms) return unavailable("provider_disabled", terms.refused);
    const state = this.stateOf(provider);
    const cooling = state.cooldownUntil.get(route.model) ?? 0;
    if (cooling > this.now()) return unavailable("rate_limited", `${provider} is cooling down after a rate limit on ${route.model}`, cooling);
    const windowEnd = this.windowEnd(route, entry, inputEstimate(request));
    if (windowEnd !== null) return unavailable("rate_limited", `${where} reached its per-minute rate limit`, windowEnd);
    const adapter = this.adapterOf(provider);
    const credential = await adapter.credential();
    if (!credential.fingerprint) return unavailable("credential_missing", `${provider} ${adapter.authMode} credential is not configured`);
    if (this.stillRejected(state, credential.fingerprint)) {
      return unavailable("auth_failed", `${provider} rejected this ${adapter.authMode} credential; refresh or replace it`);
    }
    // Past the probe interval the rejected credential gets exactly one probe: claiming it here
    // keeps concurrent runs abstaining until the probe answers.
    if (state.rejectedFingerprint === credential.fingerprint) state.rejectedAt = this.now();
    const planGap = this.planGap(provider, route.model, credential, true);
    if (planGap) return unavailable("provider_error", planGap.detail, planGap.retryAt);
    // The plan claim is the only evidence a ChatGPT sign-in is the business workspace its ref
    // names, so live and shadow work on that ref needs one (planGap holds it to chatgpt_plans).
    if ((runClass === "live" || runClass === "shadow") && account.complianceRef === "ai.openai.chatgpt-commercial" && credential.plan === undefined) {
      return unavailable("provider_disabled", `${provider}'s ChatGPT sign-in claims no plan, so it cannot show the business workspace ai.openai.chatgpt-commercial needs for ${runClass} runs`);
    }
    return { ok: true, credential, qualificationRef, riskAcceptance: terms.acceptance };
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
    const providers: Record<ProviderId, ProviderHealth> = {};
    for (const [id, account] of Object.entries(this.config.providers)) {
      const adapter = this.adapterOf(id);
      const state = this.stateOf(id);
      const credential = await adapter.credential();
      const refreshedAt = credential.refreshedAt ?? null;
      const signinStale =
        account.adapter === "codex" &&
        account.credentialMode === "oauth" &&
        credential.fingerprint !== null &&
        (refreshedAt === null || this.now() - refreshedAt > account.signinMaxAgeHours * 3_600_000);
      const cooldownUntil = Math.max(0, ...state.cooldownUntil.values());
      let name: ProviderStateName = "ready";
      if (!account.enabled) name = "disabled";
      else if (!credential.fingerprint) name = "credential_missing";
      else if (state.rejectedFingerprint === credential.fingerprint) name = "auth_failed";
      else if (this.routedModels(id).some((model) => this.planGap(id, model, credential))) name = "plan_lacks_model";
      else if (cooldownUntil > this.now()) name = "cooldown";
      if (name !== "ready" && name !== "disabled") alerts.push(`${id}_${name}`);
      if (signinStale) alerts.push(`${id}_signin_not_refreshing`);
      providers[id] = {
        enabled: account.enabled,
        authMode: adapter.authMode,
        state: name,
        credentialPresent: credential.fingerprint !== null,
        signinRefreshedAt: refreshedAt,
        signinStale,
        plan: credential.plan ?? null,
        cooldownUntil: cooldownUntil > this.now() ? cooldownUntil : null,
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
    const account = this.config.providers[id];
    if (account.adapter !== "codex" || account.credentialMode !== "oauth" || !credential.fingerprint) return null;
    const action = `sign the agent host's ${account.codexHomeEnv} in with a ChatGPT plan that includes it`;
    const probeAfter = this.config.retry.authProbeAfterMs;
    const refused = this.stateOf(id).planRefused.get(model);
    if (refused?.fingerprint === credential.fingerprint) {
      // Past the probe interval one run may try again; claiming the probe keeps the others out.
      if (claimProbe && this.now() - refused.at >= probeAfter) refused.at = this.now();
      else {
        return {
          detail: `${id}: plan does not include model ${model}; the provider refused it for this sign-in; ${action}`,
          retryAt: refused.at + probeAfter,
        };
      }
    }
    const plans = account.chatgptPlans;
    if (credential.plan !== undefined && !plans.includes(credential.plan)) {
      return {
        detail: `${id}: plan does not include model ${model}; the sign-in is on the ${credential.plan} plan, configured plans are ${plans.join(", ")}; ${action}`,
      };
    }
    return null;
  }

  /** When a full rate window of the model frees, or null when the next call fits it. */
  private windowEnd(route: Route, entry: ModelEntry, estimate: number): number | null {
    const { requestsPerMinute, inputTokensPerMinute, outputTokensPerMinute } = entry.rateLimits;
    if (requestsPerMinute === null && inputTokensPerMinute === null && outputTokensPerMinute === null) return null;
    const calls = this.windowOf(route);
    const input = calls.reduce((total, call) => total + call.input, 0);
    const output = calls.reduce((total, call) => total + call.output, 0);
    const full =
      (requestsPerMinute !== null && calls.length >= requestsPerMinute) ||
      (inputTokensPerMinute !== null && input + estimate > inputTokensPerMinute) ||
      (outputTokensPerMinute !== null && output >= outputTokensPerMinute);
    // fit() refuses an estimate above the whole input limit, so a full window holds a call.
    return full && calls.length > 0 ? calls[0].at + MINUTE_MS : null;
  }

  private enterWindow(route: Route, estimate: number): { at: number; input: number; output: number } {
    const call = { at: this.now(), input: estimate, output: 0 };
    this.windowOf(route).push(call);
    return call;
  }

  private windowOf(route: Route): Array<{ at: number; input: number; output: number }> {
    const key = `${route.provider}\u0000${route.model}`;
    const since = this.now() - MINUTE_MS;
    const calls = (this.windows.get(key) ?? []).filter((call) => call.at > since);
    this.windows.set(key, calls);
    return calls;
  }

  private adapterOf(id: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new TypeError(`no adapter for provider ${id}`);
    return adapter;
  }

  private stateOf(id: ProviderId): ProviderState {
    const state = this.state.get(id);
    if (!state) throw new TypeError(`no state for provider ${id}`);
    return state;
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

function createAdapter(account: ProviderConfig, stateDir: string, env: Env): ProviderAdapter {
  return account.adapter === "claude_agent_sdk" ? createClaudeAdapter(account, stateDir, env) : createCodexAdapter(account, stateDir, env);
}

function routeKind(hop: Hop | null): GatewayResult["route"] {
  if (hop === null) return null;
  return hop.index === 0 ? "primary" : "declared_fallback";
}

function hopRecord(hop: Hop, reason: AbstainReason, retryAt: number | undefined): FailoverHop {
  return { routeId: hop.id, provider: hop.route.provider, model: hop.route.model, reason, retryAt: retryAt ?? null };
}

/**
 * Providers may report a dated (`-20260901`, `-2026-09-01`) or context-suffixed (`[1m]`) id for
 * the configured model.
 */
function sameModel(used: string, configured: string): boolean {
  if (!used.startsWith(configured)) return false;
  return /^(?:-\d{8}|-\d{4}-\d{2}-\d{2})?(?:\[[^\]]+\])?$/.test(used.slice(configured.length));
}

function freshState(): ProviderState {
  return { cooldownUntil: new Map(), rejectedFingerprint: null, rejectedAt: 0, planRefused: new Map(), lastSuccessAt: null, lastErrorKind: null };
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
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\b(sk|sess|rt|ak)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_\-+/=.]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
