// accounting-effect-port.ts - the only money-side dependency on the external effect runtime.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 3.1: every IRO-52 module depends on this
// narrow port, never on `effect-runtime.ts` directly. The port carries no runtime import, so a
// test binding and the production binding are interchangeable without rewriting a slice.
//
// The shape is field-for-field compatible with `ExternalEffectRequest & { authority }`: the
// production binding is a pure projection, proved by `toExternalEffectShape` below and asserted
// against the runtime's own types in `test/accounting-port.test.ts`.

/**
 * The twelve ledger states, restated so the accounting plane owns no runtime import.
 * `test/accounting-port.test.ts` asserts this list stays identical to
 * `EXTERNAL_EFFECT_STATES`; a divergence is a failing test, not a silent drift.
 */
export const MONEY_EFFECT_STATES = [
  "proposed", "authorized", "executing", "reconciling", "succeeded",
  "failed", "unknown", "reconciled", "retry", "compensating",
  "compensated", "manual_exception",
] as const;

export type MoneyEffectState = (typeof MONEY_EFFECT_STATES)[number];

export const MONEY_ATTEMPT_STATES = [
  "executing", "reconciling", "succeeded", "failed", "unknown", "reconciled",
] as const;

export type MoneyAttemptState = (typeof MONEY_ATTEMPT_STATES)[number];

export type MoneyActorType =
  | "agent" | "worker" | "customer" | "external_authority" | "device" | "owner";

/**
 * The authority proof for one money mutation. `tenantId`, `actorType` and `actorId` are absent
 * because the runtime derives them from the request's own subject and rejects a mismatch with
 * `effect_authority_subject_mismatch`; restating them here would let a caller contradict itself.
 */
export interface MoneyEffectAuthority {
  permitRef: string;
  policyRef: string;
  policyVersion: string;
  expiresAt: string;
  allowedActions: readonly string[];
  /** Optional attempt ceiling; the runtime rejects a retry limit above it. */
  maxAttempts?: number;
  /** The money this authority covers, and the ceiling it may not breach. */
  amount?: number;
  maxAmount?: number;
}

export interface MoneyEffectRequest {
  tenantId: string;
  actor: { type: MoneyActorType; id: string };
  taskId: string;
  authority: MoneyEffectAuthority;
  aggregate: { type: string; id: string; version: number };
  intentId: string;
  /** Normalized provider action, e.g. `quickbooks.payment.create`. */
  action: string;
  /** Normalized provider intent. Hashed by the runtime; never logged verbatim. */
  request: unknown;
  provider: "quickbooks";
  /** The QuickBooks realm this mutation targets, or null for a realm-free action. */
  providerAccountRef: string | null;
  /** Business key, stable across retries. Unique per tenant in the ledger. */
  idempotencyKey: string;
  deadlineAt: string;
  preconditions?: unknown;
  evidenceRefs?: readonly string[];
  /** The normalized fact set we expect an authenticated readback to return. */
  expectedReadback?: unknown;
  retryLimit?: number;
  /** Provider-supported reversal only. Never a local delete. */
  compensationPlan?: unknown;
  correlationId: string;
  parentEffectId?: string | null;
  /**
   * Set when this effect reverses another one. Contract section 5.4 requires every remedy
   * (void, credit memo, refund receipt, adjusting entry) to carry the effect it compensates.
   */
  compensatesEffectId?: string | null;
}

export interface MoneyReadback {
  status: "match" | "conflict" | "not_found" | "unavailable";
  providerExternalId?: string | null;
  observed?: unknown;
  detailCode?: string | null;
}

export interface MoneyDispatchResult<T> {
  outcome: "accepted" | "rejected" | "unknown";
  value?: T;
  providerExternalId?: string | null;
  providerResponse?: unknown;
  detailCode?: string | null;
  readback?: MoneyReadback;
}

/**
 * The provider adapter. It receives identifiers only: the accounting module already holds the
 * intent row that produced the effect, so passing the ledger record would couple the money plane
 * to the runtime's storage shape for no gain.
 */
export interface MoneyEffectExecutor<T> {
  preconditions?(input: { effectId: string }): Promise<{ ok: boolean; detailCode?: string }>;
  dispatch(input: {
    effectId: string;
    attemptId: string;
    businessIdempotencyKey: string;
  }): Promise<MoneyDispatchResult<T>>;
  /**
   * Required, unlike the runtime's optional readback: contract section 5.1 states that only an
   * authenticated provider-detail read can reach a settled state, so a money executor that cannot
   * read back is not a legal money executor.
   */
  readback(input: {
    effectId: string;
    providerExternalId: string | null;
  }): Promise<MoneyReadback>;
  /** Rehydrate the caller result on an exact replay of an already-succeeded effect. */
  replay(input: { effectId: string }): Promise<T>;
}

/** The settled projection of one ledger row, carrying the evidence a money intent records. */
export interface MoneyEffectOutcome<T> {
  effectId: string;
  state: MoneyEffectState;
  attemptId: string | null;
  attemptState: MoneyAttemptState | null;
  providerExternalId: string | null;
  requestHash: string;
  providerResponseHash: string | null;
  readbackHash: string | null;
  resultCode: string | null;
  value?: T;
}

export interface MoneyEffectPort {
  /** Refuse to run at all when the ledger is missing or disabled. Never a fallback to a direct call. */
  assertReady(): void;
  run<T>(
    input: MoneyEffectRequest,
    executor: MoneyEffectExecutor<T>,
    now?: Date,
  ): Promise<MoneyEffectOutcome<T>>;
}

/**
 * The error vocabulary the money plane may observe from the port. Restated for the same reason as
 * the state list, and asserted against the runtime's thrown codes in the port conformance test.
 */
export const MONEY_EFFECT_ERROR_CODES = [
  "effect_runtime_required",
  "effect_ledger_unavailable",
  "effect_idempotency_conflict",
  "effect_unknown_requires_reconciliation",
  "effect_manual_exception",
  "effect_in_flight",
  "effect_replay_required",
  "effect_policy_action_denied",
  "effect_policy_amount_ceiling_exceeded",
  "effect_policy_retry_ceiling_exceeded",
  "effect_authority_expired",
  "effect_deadline_expired",
] as const;

export class MoneyEffectError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "MoneyEffectError";
  }
}

/**
 * Project a money request onto the runtime's request shape. Pure and dependency-free: the
 * production binding (slice S11) is this projection plus a call to `runExternalEffect`, which is
 * what "the adapter is a pass-through" has to mean to be checkable rather than asserted.
 *
 * The three fields the money authority omits are filled from the request's own subject, so the
 * runtime's `effect_authority_subject_mismatch` guard can never fire on a projected request.
 */
export function toExternalEffectShape(input: MoneyEffectRequest): {
  tenantId: string;
  actor: { type: MoneyActorType; id: string };
  taskId: string;
  authority: MoneyEffectAuthority & {
    tenantId: string;
    actorType: MoneyActorType;
    actorId: string;
  };
  aggregate: { type: string; id: string; version: number };
  intentId: string;
  action: string;
  request: unknown;
  provider: string;
  providerAccountRef: string | null;
  idempotencyKey: string;
  deadlineAt: string;
  preconditions?: unknown;
  evidenceRefs?: readonly string[];
  expectedReadback?: unknown;
  retryLimit?: number;
  compensationPlan?: unknown;
  correlationId: string;
  parentEffectId?: string | null;
  compensatesEffectId?: string | null;
} {
  return {
    ...input,
    authority: {
      ...input.authority,
      tenantId: input.tenantId,
      actorType: input.actor.type,
      actorId: input.actor.id,
    },
  };
}
