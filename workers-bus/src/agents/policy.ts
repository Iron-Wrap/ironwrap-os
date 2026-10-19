// Deterministic step policy. A proposed step is checked against the catalog, the registry, the
// run's context snapshot and the owner's delegation, in a fixed order; the first failing check
// decides. A model's confidence never enters: the same inputs always give the same decision.
//
// Order: run ceilings, registered action, owner scope, people-only, the request behind an action
// only a person may request, registered arguments, strict arguments and the rules across them,
// citations (present, in the snapshot at the cited version, current, fresh), handoff limits, then
// class and delegation.

import { catalogAction, catalogSpecialist, type Autonomy, type CatalogAction } from "./catalog.ts";
import { registryEntry, type RegistryEntry } from "./registry.ts";
import { validate } from "./schema.ts";

export const STEP_POLICY_ID = "ironwrap.agent_step_policy";
export const STEP_POLICY_VERSION = "5";

export interface SnapshotFact {
  fact_id: string;
  version: number;
  hash: string;
  trust: "owned" | "external_verified" | "external_unverified" | "untrusted_text";
  fresh_until: string | null;
}

export interface Citation {
  fact_id: string;
  version: number;
}

/** The owner's current setting for one specialist and action; `off` turns an action off. */
export interface DelegationSetting {
  delegation_id: string;
  setting: "asks_first" | "within_limits" | "off";
}

export interface StepCeilings {
  stepsPerRun: number;
  wallTimeMs: number;
  handoffDepth: number;
  sameHandoff: number;
}

export const DEFAULT_CEILINGS: StepCeilings = { stepsPerRun: 12, wallTimeMs: 10 * 60_000, handoffDepth: 4, sameHandoff: 2 };

/** Pause and auditor hold are independent; one must never mask the other's restriction. */
export interface SpecialistState {
  readonly paused: boolean;
  readonly held: boolean;
}

export interface StepInput {
  specialistId: string;
  specialistState: SpecialistState;
  actionId: string;
  args: unknown;
  citations: Citation[];
  snapshot: Map<string, SnapshotFact>;
  /** Current versions read again just before the decision; null when the fact cannot be read. */
  currentVersions: Map<string, number | null>;
  delegation: DelegationSetting | null;
  /** Whether the step stays inside the within-limits setting's ceiling (count, amount, recipients). */
  withinCeiling?: boolean;
  stepsOnRun: number;
  runStartedAt: number;
  now: number;
  handoff: { depth: number; samePair: number } | null;
  ceilings?: StepCeilings;
  /** The registry to consult; tests pass their own. */
  registry?: (actionId: string) => RegistryEntry | null;
  /**
   * For an action only a person's own request may start: the signal the run answers, as the Worker
   * recorded it. That is the run's own signal, or for a handoff the signal at the root of its chain
   * (store.ts `runRequest`); `actor` is face.ts `signalActor`. Null when the chain has no root.
   */
  requester?: {
    signal_ref: string;
    kind: string;
    source: string;
    actor: { type: string; authenticated: boolean } | null;
    /** The action a press on a view's action asked for (ask.ts postRequest); null for an ask. */
    expected_action_id?: string | null;
  } | null;
}

/**
 * Actions proposed only on a signed-in owner's or staff member's own ask or request through the app,
 * never from a field worker, an outside sender's text or any other signal (contract "Inbound text is
 * data"). The step cites that request; a handoff run answers the request at the root of its chain.
 * An access change is prepared on an ask or a request and names it in `request_ref`; a competency
 * record answers only a press on compliance's view, a `request` (contract `authority.record`).
 */
export const PERSON_REQUEST_ONLY: ReadonlyMap<string, { sources: ReadonlySet<string>; named: boolean; pressFor: boolean }> = new Map([
  // No view offers an access change to press (ask.ts actionRequestKind), so any press may start one.
  ["access.prepare_change", { sources: new Set(["ask", "request"]), named: true, pressFor: false }],
  // The press is on compliance's view for this action, never one for another action.
  ["authority.record", { sources: new Set(["request"]), named: false, pressFor: true }],
]);

/**
 * `A1` actions that prepare a people-only act (contract "Autonomy classes"): the draft is stored as
 * proposed and names the person who performs the act in their own screen, so it lands in their
 * Needs you rather than among finished work. The agent never performs the act.
 */
export const PREPARES_PEOPLE_ONLY: ReadonlyMap<string, { act: string; person: string }> = new Map([
  ["access.prepare_change", { act: "access.change", person: "owner" }],
  ["delegation.propose_change", { act: "delegation.set", person: "owner" }],
  ["payee.unfreeze_prepare", { act: "payee.unfreeze", person: "owner" }],
  // Released by an owner, ops or production person who did not raise the stop; production is named.
  ["safety_stop.release_prepare", { act: "safety_stop.release", person: "production" }],
]);

export type Outcome = "succeeded" | "failed" | "unknown" | "abstained";

export interface PolicyDecision {
  result: "allow" | "needs_approval" | "deny";
  outcome: Outcome | null;
  reason_codes: string[];
  checks: Array<{ check: string; passed: boolean }>;
  permit_kind: "none" | "draft" | "within_limits" | "asks_first";
  delegation_id: string | null;
  autonomy: Autonomy | null;
  /** Who must act next when the step waits on a person. */
  reviewer_role: string | null;
}

export function evaluateStep(input: StepInput): PolicyDecision {
  const ceilings = input.ceilings ?? DEFAULT_CEILINGS;
  const checks: Array<{ check: string; passed: boolean }> = [];
  const action = catalogAction(input.actionId);
  // An abstention stops and names who takes it over (contract "Abstention"); a refusal does not.
  const stop = (outcome: "abstained" | "failed", reason: string, check: string): PolicyDecision => {
    checks.push({ check, passed: false });
    return {
      result: "deny",
      outcome,
      reason_codes: [reason],
      checks,
      permit_kind: "none",
      delegation_id: null,
      autonomy: action?.autonomy ?? null,
      reviewer_role: outcome === "abstained" ? reviewerFor(action, input.specialistId) : null,
    };
  };
  const pass = (check: string) => checks.push({ check, passed: true });

  if (input.now - input.runStartedAt > ceilings.wallTimeMs || input.stepsOnRun >= ceilings.stepsPerRun) {
    return stop("abstained", "ceiling_reached", "budget");
  }
  pass("budget");
  if (!action) return stop("abstained", "action_unregistered", "scope");
  if (!action.owners.includes(input.specialistId)) return stop("failed", "policy_denied", "scope");
  if (action.autonomy === "H" || action.human_only) return stop("failed", "policy_denied", "scope");
  pass("scope");
  const personRequest = PERSON_REQUEST_ONLY.get(input.actionId);
  if (personRequest) {
    const request = input.requester;
    const person = request?.actor;
    if (
      !request ||
      request.kind !== "owner_request" ||
      !personRequest.sources.has(request.source) ||
      person?.authenticated !== true ||
      (person.type !== "owner" && person.type !== "staff") ||
      (personRequest.pressFor && request.expected_action_id !== input.actionId) ||
      (personRequest.named && (input.args as { request_ref?: unknown } | null)?.request_ref !== request.signal_ref) ||
      !input.citations.some((citation) => citation.fact_id === request.signal_ref)
    )
      return stop("abstained", "out_of_scope", "requester");
    pass("requester");
  }

  const entry = (input.registry ?? registryEntry)(input.actionId);
  if (!entry) return stop("abstained", "policy_missing", "schema");
  if (validate(entry.args, input.args).length > 0 || entry.argsError?.(input.args))
    return stop("abstained", "action_unregistered", "schema");
  // Closed machine codes and forbidden targets are contract data, never model descriptions.
  const args = input.args as Record<string, unknown>;
  if (action.reason_codes && !action.reason_codes.includes(args.reason_code as string)) return stop("abstained", "action_unregistered", "schema");
  if (action.never_targets?.includes(args.specialist_id as string)) return stop("failed", "policy_denied", "scope");
  if (entry.binding.kind === "unavailable") return stop("abstained", "policy_missing", "schema");
  pass("schema");

  if (action.requires_citations && input.citations.length === 0) return stop("abstained", "citation_unverifiable", "cited");
  for (const citation of input.citations) {
    const fact = input.snapshot.get(citation.fact_id);
    if (!fact || fact.version !== citation.version) return stop("abstained", "citation_unverifiable", "cited");
  }
  pass("cited");
  for (const citation of input.citations) {
    const fact = input.snapshot.get(citation.fact_id) as SnapshotFact;
    const current = input.currentVersions.get(citation.fact_id);
    if (current === undefined || current === null) return stop("abstained", "citation_unverifiable", "fresh");
    if (current !== citation.version) return stop("abstained", "fact_stale", "fresh");
    if (fact.fresh_until !== null && Date.parse(fact.fresh_until) < input.now) return stop("abstained", "fact_stale", "fresh");
  }
  pass("fresh");

  if (input.handoff) {
    // Depth counts handoffs from the original signal: at most `handoffDepth` of them.
    if (input.handoff.depth > ceilings.handoffDepth || input.handoff.samePair >= ceilings.sameHandoff) {
      return stop("abstained", "ceiling_reached", "handoff_limits");
    }
    pass("handoff_limits");
  }

  const allowed = (permit: PolicyDecision["permit_kind"], outcome: Outcome | null, reviewerRole: string | null): PolicyDecision => ({
    result: permit === "asks_first" ? "needs_approval" : "allow",
    outcome,
    reason_codes: [],
    checks,
    permit_kind: permit,
    delegation_id: permit === "within_limits" ? (input.delegation?.delegation_id ?? null) : null,
    autonomy: action.autonomy,
    reviewer_role: reviewerRole,
  });

  // A prepared people-only act always names the person who performs it, under a hold too.
  const reviewer =
    input.actionId === "exception.escalate"
      ? (args.route_to as string)
      : (PREPARES_PEOPLE_ONLY.get(input.actionId)?.person ?? reviewerFor(action, input.specialistId));
  const setting = effectiveDelegation(action, input);
  // A hold adds review; it never turns an explicitly revoked action back on.
  if (!action.protective && setting === "off") return stop("failed", "policy_denied", "delegation");
  // Pause stops drafting even when a simultaneous hold would otherwise ask for review.
  if (!action.protective && input.specialistState.paused && action.autonomy === "A1")
    return stop("failed", "policy_denied", "delegation");
  // Every other non-protective action asks first under either independent restriction.
  if (!action.protective && (input.specialistState.paused || input.specialistState.held))
    return allowed("asks_first", null, reviewer);
  if (action.autonomy === "A0") return allowed("none", "succeeded", null);
  if (action.autonomy === "A1") return allowed("draft", "succeeded", PREPARES_PEOPLE_ONLY.get(input.actionId)?.person ?? null);

  // Protective steps never wait for approval, and keep running while a specialist is paused. Until
  // their machine path is proven they stay open for the named person to act on, never asks first.
  if (action.protective) return allowed("within_limits", null, entry.binding.kind === "exception" || !entry.machinePermitProven ? reviewer : null);

  pass("delegation");
  // A step above the setting's ceiling asks first; so does any step before the path is proven.
  if (setting === "within_limits" && entry.machinePermitProven && input.withinCeiling === true) {
    pass("amount_ceiling");
    return allowed("within_limits", null, null);
  }
  return allowed("asks_first", null, reviewer);
}

/**
 * The setting in force. A non-delegable action, and any action of a paused or held specialist,
 * asks first; an action that starts off stays off until the owner turns it on.
 */
export function effectiveDelegation(
  action: CatalogAction,
  input: Pick<StepInput, "delegation" | "specialistState">,
): "asks_first" | "within_limits" | "off" {
  const owner = input.delegation?.setting ?? null;
  if (owner === "off" || (owner === null && action.default_delegation === "off_until_enabled")) return "off";
  if (!action.delegable || input.specialistState.paused || input.specialistState.held) return "asks_first";
  if (owner) return owner;
  return action.default_delegation === "within_limits" ? "within_limits" : "asks_first";
}

function reviewerFor(action: CatalogAction | null, specialistId: string): string {
  return action?.reviewer_role ?? catalogSpecialist(specialistId)?.reviewer_role ?? "owner";
}
