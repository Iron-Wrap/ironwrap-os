import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { isReservedEvidenceUploadReference } from "./evidence-upload-reference.ts";

export const EXTERNAL_EFFECT_STATES = [
  "proposed", "authorized", "executing", "reconciling", "succeeded",
  "failed", "unknown", "reconciled", "retry", "compensating",
  "compensated", "manual_exception",
] as const;

export type ExternalEffectState = (typeof EXTERNAL_EFFECT_STATES)[number];
export type EffectReconciliationOutcome = "executed" | "not_executed" | "inconclusive";
export type EffectActorType = "agent" | "worker" | "customer" | "external_authority" | "device" | "owner";

export interface EffectAuthority {
  permitRef: string;
  policyRef: string;
  policyVersion: string;
  tenantId: string;
  actorType: EffectActorType;
  actorId: string;
  expiresAt: string;
  allowedActions: readonly string[];
  maxAttempts?: number;
  /** Optional policy ceiling for money-bearing actions. */
  amount?: number;
  maxAmount?: number;
}

export interface ExternalEffectRequest {
  effectId?: string;
  tenantId: string;
  actor: { type: EffectActorType; id: string };
  taskId: string;
  authority: Pick<EffectAuthority, "permitRef" | "policyRef" | "policyVersion">;
  aggregate: { type: string; id: string; version: number };
  intentId: string;
  action: string;
  request: unknown;
  requestHash?: string;
  provider: string;
  providerAccountRef?: string | null;
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
  now?: string;
}

export interface ExternalEffectRecord {
  effect_id: string;
  tenant_id: string;
  actor_type: EffectActorType;
  actor_id: string;
  task_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  intent_id: string;
  action: string;
  request_hash: string;
  envelope_hash: string;
  provider: string;
  provider_account_ref: string | null;
  idempotency_key: string;
  deadline_at: string;
  lease_expires_at: string | null;
  preconditions_json: string;
  evidence_refs_json: string;
  expected_readback_json: string;
  retry_limit: number;
  compensation_plan_json: string;
  correlation_id: string;
  parent_effect_id: string | null;
  compensates_effect_id: string | null;
  state: ExternalEffectState;
  attempt_count: number;
  provider_external_id: string | null;
  provider_response_hash: string | null;
  readback_hash: string | null;
  result_code: string | null;
  exception_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalEffectAttempt {
  attempt_id: string;
  effect_id: string;
  attempt_number: number;
  business_idempotency_key: string;
  request_hash: string;
  state: "executing" | "reconciling" | "succeeded" | "failed" | "unknown" | "reconciled";
  provider_external_id: string | null;
  provider_response_hash: string | null;
  readback_hash: string | null;
  result_code: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface EffectReadback {
  status: "match" | "conflict" | "not_found" | "unavailable";
  providerExternalId?: string | null;
  observed?: unknown;
  detailCode?: string | null;
}

export interface EffectDispatchResult<T = unknown> {
  outcome: "accepted" | "rejected" | "unknown";
  value?: T;
  providerExternalId?: string | null;
  providerResponse?: unknown;
  detailCode?: string | null;
  readback?: EffectReadback;
}

export interface EffectExecutor<T = unknown> {
  /** Check the aggregate/version and any adapter-specific preconditions before dispatch. */
  preconditions?(input: { effect: ExternalEffectRecord }): Promise<{
    ok: boolean;
    detailCode?: string;
  }>;
  dispatch(input: {
    effect: ExternalEffectRecord;
    attempt: ExternalEffectAttempt;
    attemptId: string;
    businessIdempotencyKey: string;
  }): Promise<EffectDispatchResult<T>>;
  readback?(input: {
    effect: ExternalEffectRecord;
    attempt: ExternalEffectAttempt;
    providerExternalId: string | null;
  }): Promise<EffectReadback>;
  replay?(input: { effect: ExternalEffectRecord }): Promise<T>;
}

export interface ReplayableEffectExecutor<T = unknown> extends EffectExecutor<T> {
  /** Rehydrate the caller result from durable provider state on an exact replay. */
  replay(input: { effect: ExternalEffectRecord }): Promise<T>;
}

export interface EffectExecutionResult<T = unknown> {
  effect: ExternalEffectRecord;
  attempt: ExternalEffectAttempt;
  value?: T;
}

export interface ExternalEffectSettlement<T = unknown> {
  attemptId: string;
  outcome: EffectDispatchResult<T>["outcome"];
  value?: T;
  providerExternalId?: string | null;
  providerResponse?: unknown;
  readback?: EffectReadback;
  detailCode?: string | null;
  now?: string;
}

export class EffectRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "EffectRuntimeError";
  }
}

function assertNoUploadEvidenceRefs(refs: readonly string[] | undefined): void {
  if (refs?.some(isReservedEvidenceUploadReference)) {
    throw new EffectRuntimeError("effect_evidence_ref_reserved");
  }
}

/**
 * How long one attempt holds its lease. A provider answer that is merely late still arrives inside
 * it, so an `unknown` outcome younger than this may yet be settled by the provider itself.
 */
export const EFFECT_ATTEMPT_LEASE_MS = 2 * 60_000;

export function effectLedgerAvailable(env: unknown): boolean {
  const db = (env as { DB?: { prepare?: (sql: string) => { bind?: (...args: unknown[]) => unknown } } })?.DB;
  if (typeof db?.prepare !== "function") return false;
  try {
    const statement = db.prepare("SELECT 1");
    if (typeof statement?.bind !== "function") return false;
    const bound = statement.bind() as { first?: unknown };
    return typeof bound.first === "function";
  } catch {
    return false;
  }
}

/**
 * Every provider mutation requires the universal ledger. Missing or disabled
 * configuration is never permission to call a provider directly.
 */
export function assertEffectLedgerReady(env: unknown): void {
  const configured = (env as { EFFECT_RUNTIME_ENABLED?: string } | null)?.EFFECT_RUNTIME_ENABLED;
  if (configured !== "true") {
    throw new EffectRuntimeError("effect_runtime_required");
  }
  if (!effectLedgerAvailable(env)) throw new EffectRuntimeError("effect_ledger_unavailable");
}

/**
 * The adapter policy is deliberately narrow: one provider, one action, one
 * tenant, one bounded deadline. A caller that has a stronger authority must
 * pass it explicitly to `runExternalEffect`; this helper is only the shared
 * compatibility ceiling for already feature-flagged provider adapters.
 */
export function adapterAuthority(input: {
  tenantId: string;
  provider: string;
  action: string;
  actorId?: string;
  deadlineAt: string;
  retryLimit?: number;
}): EffectAuthority {
  return {
    permitRef: `adapter:${input.provider}:enabled`,
    policyRef: `adapter:${input.provider}:${input.action}`,
    policyVersion: "v1",
    tenantId: input.tenantId,
    actorType: "agent",
    actorId: input.actorId ?? "integration-worker",
    expiresAt: input.deadlineAt,
    allowedActions: [input.action],
    maxAttempts: (input.retryLimit ?? 0) + 1,
  };
}

async function effectEnvelopeHash(
  input: ExternalEffectRequest,
  requestHash: string,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    tenantId: input.tenantId,
    actor: input.actor,
    taskId: input.taskId,
    authority: {
      permitRef: input.authority.permitRef,
      policyRef: input.authority.policyRef,
      policyVersion: input.authority.policyVersion,
    },
    aggregate: input.aggregate,
    intentId: input.intentId,
    action: input.action,
    requestHash,
    provider: input.provider,
    providerAccountRef: input.providerAccountRef ?? null,
    idempotencyKey: input.idempotencyKey,
    deadlineAt: input.deadlineAt,
    preconditions: input.preconditions ?? {},
    evidenceRefs: input.evidenceRefs ?? [],
    expectedReadback: input.expectedReadback ?? {},
    retryLimit: input.retryLimit ?? 0,
    compensationPlan: input.compensationPlan ?? {},
    correlationId: input.correlationId,
    parentEffectId: input.parentEffectId ?? null,
    compensatesEffectId: input.compensatesEffectId ?? null,
  }));
}

/** Propose, authorize, execute, and return one provider result through the shared ledger. */
export async function runExternalEffect<T = unknown>(
  env: AppEnv,
  input: ExternalEffectRequest & { authority: EffectAuthority },
  executor: ReplayableEffectExecutor<T>,
  now = new Date(),
): Promise<EffectExecutionResult<T>> {
  assertNoUploadEvidenceRefs(input.evidenceRefs);
  const computedRequestHash = await sha256Hex(canonicalJson(input.request));
  if (input.requestHash !== undefined && input.requestHash !== computedRequestHash) {
    throw new EffectRuntimeError("effect_request_hash_mismatch");
  }
  const requestHash = computedRequestHash;
  let existing = await getExternalEffectByIdempotency(env, input.tenantId, input.idempotencyKey);
  // A retry cannot extend or replace the stored deadline. Adapter callers may
  // compute a fresh candidate deadline, so compare the rest of their envelope
  // against the immutable deadline already accepted for this business key.
  const envelopeHash = await effectEnvelopeHash(
    existing ? { ...input, deadlineAt: existing.deadline_at } : input,
    requestHash,
  );
  if (existing) {
    if (existing.envelope_hash !== envelopeHash) throw new EffectRuntimeError("effect_idempotency_conflict");
    if (existing.state === "unknown") throw new EffectRuntimeError("effect_unknown_requires_reconciliation");
    if (existing.state === "manual_exception") throw new EffectRuntimeError("effect_manual_exception");
    if (existing.state === "failed") {
      existing = await retryExternalEffect(env, existing.effect_id, now.toISOString());
    }
    if (existing.state === "succeeded") {
      if (typeof executor.replay !== "function") {
        throw new EffectRuntimeError("effect_replay_required");
      }
      return {
        effect: existing,
        attempt: (await latestAttempt(env, existing.effect_id)) ?? syntheticAttempt(existing),
        value: await executor.replay({ effect: existing }),
      };
    }
    if (existing.state !== "proposed" && existing.state !== "authorized" && existing.state !== "retry") {
      throw new EffectRuntimeError("effect_in_flight");
    }
  }
  const proposed = existing ?? await proposeExternalEffect(env, {
    ...input,
    requestHash,
    now: input.now ?? now.toISOString(),
  });
  const authorized = proposed.state === "proposed"
    ? await authorizeExternalEffect(env, proposed.effect_id, input.authority, now.toISOString())
    : proposed;
  return await executeExternalEffect(env, authorized.effect_id, executor, now);
}

/** Record an intent without granting execution authority. */
export async function proposeExternalEffect(
  env: AppEnv,
  input: ExternalEffectRequest,
): Promise<ExternalEffectRecord> {
  assertNoUploadEvidenceRefs(input.evidenceRefs);
  const now = input.now ?? new Date().toISOString();
  const computedRequestHash = await sha256Hex(canonicalJson(input.request));
  if (input.requestHash !== undefined && input.requestHash !== computedRequestHash) {
    throw new EffectRuntimeError("effect_request_hash_mismatch");
  }
  const requestHash = computedRequestHash;
  const envelopeHash = await effectEnvelopeHash(input, requestHash);
  if (!/^[0-9a-f]{64}$/.test(requestHash)) throw new EffectRuntimeError("effect_request_hash_invalid");
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(input.deadlineAt)) || Date.parse(input.deadlineAt) <= Date.parse(now)) {
    throw new EffectRuntimeError("effect_deadline_invalid");
  }
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw new EffectRuntimeError("effect_idempotency_key_invalid");
  }
  const effectId = input.effectId ?? `effect:${crypto.randomUUID()}`;
  const values = [
    effectId, input.tenantId, input.actor.type, input.actor.id, input.taskId,
    input.authority.permitRef, input.authority.policyRef, input.authority.policyVersion,
    input.aggregate.type, input.aggregate.id, input.aggregate.version,
    input.intentId, input.action, requestHash, envelopeHash, input.provider, input.providerAccountRef ?? null,
    input.idempotencyKey, input.deadlineAt, JSON.stringify(input.preconditions ?? {}),
    JSON.stringify(input.evidenceRefs ?? []), JSON.stringify(input.expectedReadback ?? {}),
    input.retryLimit ?? 0, JSON.stringify(input.compensationPlan ?? {}), input.correlationId,
    input.parentEffectId ?? null, input.compensatesEffectId ?? null, "proposed", 0,
    now, now,
  ];
  try {
    await env.DB.prepare(
      `INSERT INTO external_effects (
        effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
        policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
        request_hash, envelope_hash, provider, provider_account_ref, idempotency_key, deadline_at,
        preconditions_json, evidence_refs_json, expected_readback_json, retry_limit,
        compensation_plan_json, correlation_id, parent_effect_id, compensates_effect_id,
        state, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...values).run();
  } catch (error) {
    const existing = await getExternalEffectByIdempotency(env, input.tenantId, input.idempotencyKey);
    if (!existing) {
      // D1 refused a second proposal send while the last one is unconfirmed (0156); keep the cause.
      if (error instanceof Error && error.message.includes("proposal_delivery_unconfirmed")) {
        throw new EffectRuntimeError("effect_proposal_delivery_unconfirmed");
      }
      throw new EffectRuntimeError("effect_proposal_failed");
    }
    if (existing.envelope_hash !== envelopeHash) throw new EffectRuntimeError("effect_idempotency_conflict");
    return existing;
  }
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_proposal_missing");
  return effect;
}

/** Grant a transition-specific, versioned policy ceiling to one proposed effect. */
export async function authorizeExternalEffect(
  env: AppEnv,
  effectId: string,
  authority: EffectAuthority,
  now = new Date().toISOString(),
): Promise<ExternalEffectRecord> {
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "proposed") throw new EffectRuntimeError("effect_not_proposed");
  if (effect.tenant_id !== authority.tenantId || effect.actor_type !== authority.actorType || effect.actor_id !== authority.actorId) {
    throw new EffectRuntimeError("effect_authority_subject_mismatch");
  }
  if (effect.authority_ref !== authority.permitRef || effect.policy_ref !== authority.policyRef || effect.policy_version !== authority.policyVersion) {
    throw new EffectRuntimeError("effect_authority_binding_mismatch");
  }
  if (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.parse(now)) {
    throw new EffectRuntimeError("effect_authority_expired");
  }
  if (Date.parse(effect.deadline_at) > Date.parse(authority.expiresAt)) {
    throw new EffectRuntimeError("effect_authority_deadline_exceeded");
  }
  if (!authority.allowedActions.includes(effect.action)) throw new EffectRuntimeError("effect_policy_action_denied");
  if (authority.maxAttempts !== undefined && effect.retry_limit + 1 > authority.maxAttempts) {
    throw new EffectRuntimeError("effect_policy_retry_ceiling_exceeded");
  }
  if (authority.amount !== undefined && authority.maxAmount !== undefined && authority.amount > authority.maxAmount) {
    throw new EffectRuntimeError("effect_policy_amount_ceiling_exceeded");
  }
  await transitionEffect(env, effect, "authorized", now);
  const authorized = await getExternalEffect(env, effectId);
  if (!authorized) throw new EffectRuntimeError("effect_authorization_missing");
  return authorized;
}

/**
 * Claim one execution attempt: flip the effect to executing and record its attempt row in a single
 * atomic batch.
 *
 * `< 1`, not `!== 1`: D1's `meta.changes` is a `total_changes()` delta and therefore *includes rows
 * written by triggers*, and `0042` writes an `external_effect_events` row on every state change.
 * The CAS is the `WHERE ... AND state IN (...)` clause - `effect_id` is the primary key, so it
 * matches one row or none - so zero means the lease was lost and anything else means this caller
 * won it. Asserting exactly 1 meant every transition against real D1 threw while succeeding
 * (ELEC-75, proven on the local stack: the ledger recorded the transition and the caller was told
 * it conflicted).
 *
 * The batch is what the claim path needs beyond that guard. A claim that commits without its
 * attempt row can never leave 'executing': `external_effect_attempt_projection` RAISEs on every
 * later transition when the attempt row is missing, so the lease sweep cannot recover it either.
 * Running the UPDATE and the attempt INSERT as one `env.DB.batch` closes that window, and the
 * `INSERT ... SELECT` re-checks ownership so a lost race inserts nothing rather than attaching an
 * orphan attempt to a claim it does not own.
 */
async function claimEffectAttempt(
  env: AppEnv,
  effect: ExternalEffectRecord,
  attemptId: string,
  attemptNumber: number,
  leaseExpiresAt: string,
  nowIso: string,
): Promise<void> {
  const [claim, attempt] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE external_effects
         SET state = 'executing', attempt_count = ?, lease_expires_at = ?, result_code = NULL, updated_at = ?
       WHERE effect_id = ? AND state IN ('authorized', 'retry') AND attempt_count = ?`,
    ).bind(attemptNumber, leaseExpiresAt, nowIso, effect.effect_id, effect.attempt_count),
    // Re-select the freshly claimed row, so a lost claim inserts nothing
    // instead of attaching an orphan attempt to a claim it does not own.
    env.DB.prepare(
      `INSERT INTO external_effect_attempts (
        attempt_id, effect_id, attempt_number, business_idempotency_key, request_hash,
        state, started_at
      ) SELECT ?, effect_id, ?, idempotency_key, request_hash, 'executing', ?
          FROM external_effects
         WHERE effect_id = ? AND state = 'executing' AND attempt_count = ? AND lease_expires_at = ?`,
    ).bind(attemptId, attemptNumber, nowIso, effect.effect_id, attemptNumber, leaseExpiresAt),
  ]);
  if (Number(claim.meta?.changes ?? 0) < 1 || Number(attempt.meta?.changes ?? 0) < 1) {
    throw new EffectRuntimeError("effect_lease_lost");
  }
}

/** Execute exactly one leased attempt. Unknown provider outcomes are never retried here. */
export async function executeExternalEffect<T = unknown>(
  env: AppEnv,
  effectId: string,
  executor: EffectExecutor<T>,
  now = new Date(),
): Promise<EffectExecutionResult<T>> {
  let effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "authorized" && effect.state !== "retry") throw new EffectRuntimeError("effect_not_executable");
  if (Date.parse(effect.deadline_at) <= now.getTime()) throw new EffectRuntimeError("effect_deadline_expired");
  const attemptNumber = effect.attempt_count + 1;
  if (attemptNumber > effect.retry_limit + 1) throw new EffectRuntimeError("effect_retry_exhausted");
  if (executor.preconditions) {
    let check: { ok: boolean; detailCode?: string };
    try {
      check = await executor.preconditions({ effect });
    } catch {
      check = { ok: false, detailCode: "effect_preconditions_unavailable" };
    }
    if (!check.ok) {
      await transitionEffect(env, effect, "failed", now.toISOString(), {
        resultCode: check.detailCode ?? "effect_preconditions_failed",
      });
      const failed = (await getExternalEffect(env, effectId))!;
      return { effect: failed, attempt: syntheticAttempt(failed, "failed") };
    }
  }
  const attemptId = `${effect.effect_id}:attempt:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + EFFECT_ATTEMPT_LEASE_MS).toISOString();
  await claimEffectAttempt(env, effect, attemptId, attemptNumber, leaseExpiresAt, now.toISOString());
  effect = (await getExternalEffect(env, effectId))!;
  let attempt = await getExternalEffectAttempt(env, attemptId);
  if (!attempt) throw new EffectRuntimeError("effect_attempt_missing");

  let dispatched: EffectDispatchResult<T>;
  try {
    dispatched = await executor.dispatch({ effect, attempt, attemptId, businessIdempotencyKey: effect.idempotency_key });
  } catch {
    dispatched = { outcome: "unknown", detailCode: "effect_dispatch_unknown" };
  }
  const providerResponseHash = dispatched.providerResponse === undefined
    ? null
    : await sha256Hex(canonicalJson(dispatched.providerResponse));
  if (dispatched.outcome === "rejected") {
    await settleAttempt(env, effect, attempt, "failed", dispatched.detailCode ?? "provider_rejected", now.toISOString(), dispatched.providerExternalId ?? null, providerResponseHash);
    return { effect: (await getExternalEffect(env, effectId))!, attempt: (await getExternalEffectAttempt(env, attemptId))!, value: dispatched.value };
  }
  await updateAttemptAndEffect(env, effect, attempt, "reconciling", "reconciling", now.toISOString(), dispatched.providerExternalId ?? null, providerResponseHash);
  effect = (await getExternalEffect(env, effectId))!;
  attempt = (await getExternalEffectAttempt(env, attemptId))!;
  let readback = dispatched.readback;
  if (!readback && executor.readback) {
    try {
      readback = await executor.readback({ effect, attempt, providerExternalId: dispatched.providerExternalId ?? null });
    } catch {
      readback = { status: "unavailable", detailCode: "provider_readback_unavailable" };
    }
  }
  if (readback?.status === "match" && !readbackMatchesExpected(effect.expected_readback_json, readback.observed)) {
    readback = { ...readback, status: "conflict", detailCode: "provider_readback_conflict" };
  }
  let value = dispatched.value;
  if (!readback || readback.status === "unavailable" || readback.status === "not_found") {
    await settleAttempt(env, effect, attempt, "unknown", readback?.detailCode ?? dispatched.detailCode ?? "effect_outcome_unknown", now.toISOString(), dispatched.providerExternalId ?? null, providerResponseHash);
  } else if (readback.status === "conflict") {
    const exception = await openEffectException(
      env,
      effect,
      readback.detailCode ?? "provider_readback_conflict",
      readback.observed ?? {},
      now.toISOString(),
    );
    await updateAttemptAndEffect(env, effect, attempt, "unknown", "manual_exception", now.toISOString(), dispatched.providerExternalId ?? null, providerResponseHash, exception.observedHash, exception.exceptionId, readback.detailCode ?? "provider_readback_conflict");
  } else {
    const readbackHash = await sha256Hex(canonicalJson(readback.observed ?? { providerExternal_id: readback.providerExternalId ?? dispatched.providerExternalId ?? null }));
    await settleAttempt(env, effect, attempt, "succeeded", null, now.toISOString(), readback.providerExternalId ?? dispatched.providerExternalId ?? null, providerResponseHash, readbackHash);
    if (value === undefined && executor.replay) {
      value = await executor.replay({ effect: (await getExternalEffect(env, effectId))! });
    }
  }
  return { effect: (await getExternalEffect(env, effectId))!, attempt: (await getExternalEffectAttempt(env, attemptId))!, value };
}

/** Claim one leased attempt for an executor that runs outside the Worker isolate.
 * The caller must settle the attempt with provider evidence; a lost/expired lease
 * becomes unknown and is never retried as if the provider had not been called.
 */
export async function claimExternalEffect(
  env: AppEnv,
  effectId: string,
  now = new Date(),
): Promise<EffectExecutionResult<never>> {
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "authorized" && effect.state !== "retry") throw new EffectRuntimeError("effect_not_executable");
  if (Date.parse(effect.deadline_at) <= now.getTime()) throw new EffectRuntimeError("effect_deadline_expired");
  const attemptNumber = effect.attempt_count + 1;
  if (attemptNumber > effect.retry_limit + 1) throw new EffectRuntimeError("effect_retry_exhausted");
  const attemptId = `${effect.effect_id}:attempt:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + EFFECT_ATTEMPT_LEASE_MS).toISOString();
  await claimEffectAttempt(env, effect, attemptId, attemptNumber, leaseExpiresAt, now.toISOString());
  const claimed = await getExternalEffect(env, effectId);
  const attempt = await getExternalEffectAttempt(env, attemptId);
  if (!claimed || !attempt) throw new EffectRuntimeError("effect_attempt_missing");
  return { effect: claimed, attempt };
}

/** Settle a remotely claimed attempt using the same readback/conflict rules as local execution. */
export async function settleExternalEffect<T = unknown>(
  env: AppEnv,
  effectId: string,
  input: ExternalEffectSettlement<T>,
): Promise<EffectExecutionResult<T>> {
  if (typeof input.attemptId !== "string" || !input.attemptId) {
    throw new EffectRuntimeError("effect_attempt_invalid");
  }
  if (input.outcome !== "accepted" && input.outcome !== "rejected" && input.outcome !== "unknown") {
    throw new EffectRuntimeError("effect_settlement_outcome_invalid");
  }
  if (input.readback && !["match", "conflict", "not_found", "unavailable"].includes(input.readback.status)) {
    throw new EffectRuntimeError("effect_readback_invalid");
  }
  let effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "executing" && effect.state !== "reconciling") throw new EffectRuntimeError("effect_not_settleable");
  let attempt = await getExternalEffectAttempt(env, input.attemptId);
  if (!attempt || attempt.effect_id !== effectId || (attempt.state !== "executing" && attempt.state !== "reconciling")) {
    throw new EffectRuntimeError("effect_attempt_invalid");
  }
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new EffectRuntimeError("effect_settlement_time_invalid");
  const providerExternalId = input.providerExternalId ?? null;
  const providerResponseHash = input.providerResponse === undefined
    ? null
    : await sha256Hex(canonicalJson(input.providerResponse));
  if (effect.state === "executing") {
    await updateAttemptAndEffect(
      env,
      effect,
      attempt,
      "reconciling",
      "reconciling",
      now,
      providerExternalId,
      providerResponseHash,
    );
    effect = (await getExternalEffect(env, effectId))!;
    attempt = (await getExternalEffectAttempt(env, input.attemptId))!;
  }
  if (input.outcome === "rejected") {
    await settleAttempt(env, effect, attempt, "failed", input.detailCode ?? "provider_rejected", now, providerExternalId, providerResponseHash);
  } else if (input.outcome === "unknown" || !input.readback || input.readback.status === "unavailable" || input.readback.status === "not_found") {
    await settleAttempt(env, effect, attempt, "unknown", input.detailCode ?? input.readback?.detailCode ?? "effect_outcome_unknown", now, providerExternalId, providerResponseHash);
  } else if (input.readback.status === "conflict" || !readbackMatchesExpected(effect.expected_readback_json, input.readback.observed)) {
    const exception = await openEffectException(
      env,
      effect,
      input.readback.detailCode ?? "provider_readback_conflict",
      input.readback.observed ?? {},
      now,
    );
    await updateAttemptAndEffect(env, effect, attempt, "unknown", "manual_exception", now, providerExternalId, providerResponseHash, exception.observedHash, exception.exceptionId, input.readback.detailCode ?? "provider_readback_conflict");
  } else {
    const readbackHash = await sha256Hex(canonicalJson(input.readback.observed ?? { provider_external_id: input.readback.providerExternalId ?? providerExternalId }));
    await settleAttempt(env, effect, attempt, "succeeded", null, now, input.readback.providerExternalId ?? providerExternalId, providerResponseHash, readbackHash);
  }
  const settled = await getExternalEffect(env, effectId);
  const settledAttempt = await getExternalEffectAttempt(env, input.attemptId);
  if (!settled || !settledAttempt) throw new EffectRuntimeError("effect_settlement_missing");
  return { effect: settled, attempt: settledAttempt, value: input.value };
}

/** Resolve an unknown result from authoritative provider evidence before any retry. */
export async function reconcileExternalEffect(
  env: AppEnv,
  effectId: string,
  input: { outcome: EffectReconciliationOutcome; evidence: unknown; detailCode?: string; now?: string },
): Promise<ExternalEffectRecord> {
  if (input.outcome !== "executed" && input.outcome !== "not_executed" && input.outcome !== "inconclusive") {
    throw new EffectRuntimeError("effect_reconciliation_outcome_invalid");
  }
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "unknown" && effect.state !== "failed") throw new EffectRuntimeError("effect_not_reconcilable");
  const now = input.now ?? new Date().toISOString();
  const evidenceHash = await sha256Hex(canonicalJson(input.evidence));
  if (input.outcome === "inconclusive") {
    const exception = await openEffectException(
      env,
      effect,
      input.detailCode ?? "effect_reconciliation_inconclusive",
      input.evidence,
      now,
    );
    await transitionEffect(env, effect, "manual_exception", now, {
      readbackHash: evidenceHash,
      resultCode: input.detailCode ?? "effect_reconciliation_inconclusive",
      exceptionRef: exception.exceptionId,
    });
  } else if (input.outcome === "executed" && effect.state === "failed") {
    const exception = await openEffectException(
      env,
      effect,
      input.detailCode ?? "effect_reconciliation_conflicts_with_failure",
      input.evidence,
      now,
    );
    await transitionEffect(env, effect, "manual_exception", now, {
      readbackHash: evidenceHash,
      resultCode: input.detailCode ?? "effect_reconciliation_conflicts_with_failure",
      exceptionRef: exception.exceptionId,
    });
  } else if (input.outcome === "executed") {
    await transitionEffect(env, effect, "succeeded", now, { readbackHash: evidenceHash, resultCode: input.detailCode ?? "reconciled_executed" });
  } else {
    await transitionEffect(env, effect, "reconciled", now, { readbackHash: evidenceHash, resultCode: "reconciled_not_executed" });
  }
  const reconciled = await getExternalEffect(env, effectId);
  if (!reconciled) throw new EffectRuntimeError("effect_reconciliation_missing");
  return reconciled;
}

/** Move an abandoned leased attempt to unknown so provider evidence is required before retry. */
export async function recoverExpiredExternalEffect(
  env: AppEnv,
  effectId: string,
  now = new Date().toISOString(),
): Promise<ExternalEffectRecord> {
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "executing" && effect.state !== "reconciling") {
    throw new EffectRuntimeError("effect_lease_not_active");
  }
  if (!effect.lease_expires_at || Date.parse(effect.lease_expires_at) > Date.parse(now)) {
    throw new EffectRuntimeError("effect_lease_not_expired");
  }
  await transitionEffect(env, effect, "unknown", now, { resultCode: "effect_lease_expired" });
  const recovered = await getExternalEffect(env, effectId);
  if (!recovered) throw new EffectRuntimeError("effect_recovery_missing");
  return recovered;
}

/** Sweep abandoned remote/local leases into unknown reconciliation work. */
export async function recoverExpiredExternalEffects(
  env: AppEnv,
  now = new Date().toISOString(),
  limit = 100,
): Promise<{ scanned: number; recovered: number; failed: number; failures: Array<{ effect_id: string; error: string }> }> {
  if (!Number.isFinite(Date.parse(now))) throw new EffectRuntimeError("effect_recovery_time_invalid");
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100;
  const rows = await env.DB.prepare(
    `SELECT effect_id FROM external_effects
      WHERE state IN ('executing', 'reconciling')
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC LIMIT ?`,
  ).bind(now, boundedLimit).all<{ effect_id: string }>();
  let recovered = 0;
  let failed = 0;
  const failures: Array<{ effect_id: string; error: string }> = [];
  for (const row of rows.results ?? []) {
    try {
      await recoverExpiredExternalEffect(env, row.effect_id, now);
      recovered += 1;
    } catch (error) {
      const code = error instanceof EffectRuntimeError ? error.code : "";
      if (code === "effect_lease_not_active" || code === "effect_lease_not_expired" || code === "effect_transition_conflict") continue;
      // One unrecoverable row must not abort the rest of the sweep; report it
      // in the result instead of rethrowing, keeping the identity of the first
      // few so an operator can tell a poisoned row from a transient outage.
      failed += 1;
      if (failures.length < 10) failures.push({ effect_id: row.effect_id, error: String(error) });
    }
  }
  return { scanned: rows.results?.length ?? 0, recovered, failed, failures };
}

/** Permit another attempt only after the prior unknown result has been reconciled. */
export async function retryExternalEffect(
  env: AppEnv,
  effectId: string,
  now = new Date().toISOString(),
): Promise<ExternalEffectRecord> {
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "reconciled" && effect.state !== "failed") throw new EffectRuntimeError("effect_reconciliation_required");
  if (effect.state === "reconciled" && effect.result_code !== "reconciled_not_executed") {
    throw new EffectRuntimeError("effect_reconciliation_not_retryable");
  }
  if (!Number.isFinite(Date.parse(now)) || Date.parse(effect.deadline_at) <= Date.parse(now)) {
    throw new EffectRuntimeError("effect_deadline_expired");
  }
  if (effect.attempt_count >= effect.retry_limit + 1) throw new EffectRuntimeError("effect_retry_exhausted");
  await transitionEffect(env, effect, "retry", now, { resultCode: "retry_authorized_after_reconciliation" });
  const retried = await getExternalEffect(env, effectId);
  if (!retried) throw new EffectRuntimeError("effect_retry_missing");
  return retried;
}

/** Start a new, separately auditable compensation effect; never erase the original. */
export async function compensateExternalEffect(
  env: AppEnv,
  effectId: string,
  input: Omit<ExternalEffectRequest, "parentEffectId" | "compensatesEffectId">,
): Promise<ExternalEffectRecord> {
  const effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  if (effect.state !== "succeeded") throw new EffectRuntimeError("effect_not_compensable");
  if (effect.compensation_plan_json === "{}" || effect.compensation_plan_json === "null") throw new EffectRuntimeError("effect_compensation_not_declared");
  let compensationPlan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(effect.compensation_plan_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    compensationPlan = parsed as Record<string, unknown>;
  } catch {
    throw new EffectRuntimeError("effect_compensation_plan_invalid");
  }
  if (compensationPlan.action !== input.action) throw new EffectRuntimeError("effect_compensation_action_denied");
  if (input.tenantId !== effect.tenant_id || input.correlationId !== effect.correlation_id) {
    throw new EffectRuntimeError("effect_compensation_binding_mismatch");
  }
  const now = input.now ?? new Date().toISOString();
  return await proposeExternalEffect(env, {
    ...input,
    now,
    parentEffectId: effect.effect_id,
    compensatesEffectId: effect.effect_id,
  });
}

export async function markExternalEffectCompensated(
  env: AppEnv,
  effectId: string,
  compensationEffectId: string,
  now = new Date().toISOString(),
): Promise<ExternalEffectRecord> {
  let effect = await getExternalEffect(env, effectId);
  if (!effect) throw new EffectRuntimeError("effect_missing");
  const compensation = await getExternalEffect(env, compensationEffectId);
  if (!compensation) throw new EffectRuntimeError("effect_compensation_missing");
  if (
    compensation.compensates_effect_id !== effect.effect_id ||
    compensation.parent_effect_id !== effect.effect_id ||
    compensation.tenant_id !== effect.tenant_id ||
    compensation.correlation_id !== effect.correlation_id
  ) {
    throw new EffectRuntimeError("effect_compensation_binding_mismatch");
  }
  if (compensation.state !== "succeeded" || !compensation.readback_hash) {
    throw new EffectRuntimeError("effect_compensation_not_reconciled");
  }
  if (effect.state === "succeeded") {
    await transitionEffect(env, effect, "compensating", now, { resultCode: "compensation_succeeded" });
    effect = (await getExternalEffect(env, effectId))!;
  }
  if (effect.state !== "compensating") throw new EffectRuntimeError("effect_not_compensating");
  await transitionEffect(env, effect, "compensated", now, {
    readbackHash: compensation.readback_hash,
    resultCode: "compensation_reconciled",
  });
  const compensated = await getExternalEffect(env, effectId);
  if (!compensated) throw new EffectRuntimeError("effect_compensation_missing");
  return compensated;
}

export async function getExternalEffect(env: AppEnv, effectId: string): Promise<ExternalEffectRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM external_effects WHERE effect_id = ? LIMIT 1").bind(effectId).first<ExternalEffectRecord>();
  return row ? normalizeEffect(row) : null;
}

export async function getExternalEffectByIdempotency(env: AppEnv, tenantId: string, idempotencyKey: string): Promise<ExternalEffectRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM external_effects WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1").bind(tenantId, idempotencyKey).first<ExternalEffectRecord>();
  return row ? normalizeEffect(row) : null;
}

export async function getExternalEffectAttempt(env: AppEnv, attemptId: string): Promise<ExternalEffectAttempt | null> {
  return await env.DB.prepare("SELECT * FROM external_effect_attempts WHERE attempt_id = ? LIMIT 1").bind(attemptId).first<ExternalEffectAttempt>();
}

async function latestAttempt(env: AppEnv, effectId: string): Promise<ExternalEffectAttempt | null> {
  return await env.DB.prepare(
    "SELECT * FROM external_effect_attempts WHERE effect_id = ? ORDER BY attempt_number DESC LIMIT 1",
  ).bind(effectId).first<ExternalEffectAttempt>();
}

function syntheticAttempt(
  effect: ExternalEffectRecord,
  state: ExternalEffectAttempt["state"] = "succeeded",
): ExternalEffectAttempt {
  return {
    attempt_id: `${effect.effect_id}:attempt:replayed`,
    effect_id: effect.effect_id,
    attempt_number: effect.attempt_count,
    business_idempotency_key: effect.idempotency_key,
    request_hash: effect.request_hash,
    state,
    provider_external_id: effect.provider_external_id,
    provider_response_hash: effect.provider_response_hash,
    readback_hash: effect.readback_hash,
    result_code: effect.result_code,
    started_at: effect.created_at,
    ended_at: effect.updated_at,
  };
}

async function transitionEffect(
  env: AppEnv,
  effect: ExternalEffectRecord,
  state: ExternalEffectState,
  now: string,
  patch: { providerExternalId?: string | null; providerResponseHash?: string | null; readbackHash?: string | null; resultCode?: string | null; exceptionRef?: string | null } = {},
): Promise<void> {
  const resetAttemptEvidence = state === "retry" ? 1 : 0;
  const result = await env.DB.prepare(
    `UPDATE external_effects SET state = ?, lease_expires_at = NULL,
       provider_external_id = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, provider_external_id) END,
       provider_response_hash = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, provider_response_hash) END,
       readback_hash = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, readback_hash) END,
       result_code = ?,
       exception_ref = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, exception_ref) END,
       updated_at = ?
     WHERE effect_id = ? AND state = ?`,
  ).bind(
    state,
    resetAttemptEvidence, patch.providerExternalId ?? null,
    resetAttemptEvidence, patch.providerResponseHash ?? null,
    resetAttemptEvidence, patch.readbackHash ?? null,
    patch.resultCode ?? null,
    resetAttemptEvidence, patch.exceptionRef ?? null,
    now, effect.effect_id, effect.state,
  ).run();
  // See the lease claim above: D1 counts triggered writes, so a successful state transition
  // reports 2 (the effect row plus its `external_effect_events` row). Zero is the only value that
  // means the compare-and-set lost.
  if (Number(result.meta?.changes ?? 0) < 1) throw new EffectRuntimeError("effect_transition_conflict");
}

async function updateAttemptAndEffect(
  env: AppEnv,
  effect: ExternalEffectRecord,
  attempt: ExternalEffectAttempt,
  attemptState: ExternalEffectAttempt["state"],
  effectState: ExternalEffectState,
  now: string,
  providerExternalId: string | null = null,
  providerResponseHash: string | null = null,
  readbackHash: string | null = null,
  exceptionRef: string | null = null,
  resultCode: string | null = null,
): Promise<void> {
  if (attempt.effect_id !== effect.effect_id || attempt.attempt_number !== effect.attempt_count) {
    throw new EffectRuntimeError("effect_attempt_binding_mismatch");
  }
  const projectedState = effectState === "manual_exception" ? "unknown" : effectState;
  if (projectedState !== attemptState) throw new EffectRuntimeError("effect_attempt_state_mismatch");
  await transitionEffect(env, effect, effectState, now, { providerExternalId, providerResponseHash, readbackHash, exceptionRef, resultCode });
}

async function settleAttempt(
  env: AppEnv,
  effect: ExternalEffectRecord,
  attempt: ExternalEffectAttempt,
  attemptState: "succeeded" | "failed" | "unknown",
  detailCode: string | null,
  now: string,
  providerExternalId: string | null = null,
  providerResponseHash: string | null = null,
  readbackHash: string | null = null,
): Promise<void> {
  const effectState: ExternalEffectState = attemptState === "succeeded" ? "succeeded" : attemptState;
  await updateAttemptAndEffect(env, effect, attempt, attemptState, effectState, now, providerExternalId, providerResponseHash, readbackHash, null, detailCode);
}

async function openEffectException(
  env: AppEnv,
  effect: ExternalEffectRecord,
  reasonCode: string,
  observed: unknown,
  now: string,
): Promise<{ exceptionId: string; observedHash: string }> {
  const expectedHash = await sha256Hex(effect.expected_readback_json);
  const observedHash = await sha256Hex(canonicalJson(observed));
  const existing = await env.DB.prepare(
    `SELECT exception_id, expected_hash, observed_hash
       FROM external_effect_exceptions
      WHERE effect_id = ? AND reason_code = ? AND status = 'open' LIMIT 1`,
  ).bind(effect.effect_id, reasonCode).first<{
    exception_id: string;
    expected_hash: string | null;
    observed_hash: string | null;
  }>();
  if (existing) {
    if (existing.expected_hash !== expectedHash || existing.observed_hash !== observedHash) {
      throw new EffectRuntimeError("effect_exception_evidence_conflict");
    }
    return { exceptionId: existing.exception_id, observedHash };
  }
  const exceptionId = `effect-exception:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO external_effect_exceptions (
      exception_id, effect_id, tenant_id, reason_code, expected_hash, observed_hash,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).bind(exceptionId, effect.effect_id, effect.tenant_id, reasonCode, expectedHash, observedHash, now).run();
  return { exceptionId, observedHash };
}

function normalizeEffect(row: ExternalEffectRecord): ExternalEffectRecord {
  return {
    ...row,
    state: EXTERNAL_EFFECT_STATES.includes(row.state) ? row.state : "manual_exception",
    aggregate_version: Number(row.aggregate_version),
    retry_limit: Number(row.retry_limit),
    attempt_count: Number(row.attempt_count),
    provider_account_ref: nullable(row.provider_account_ref),
    lease_expires_at: nullable(row.lease_expires_at),
    parent_effect_id: nullable(row.parent_effect_id),
    compensates_effect_id: nullable(row.compensates_effect_id),
    provider_external_id: nullable(row.provider_external_id),
    provider_response_hash: nullable(row.provider_response_hash),
    readback_hash: nullable(row.readback_hash),
    result_code: nullable(row.result_code),
    exception_ref: nullable(row.exception_ref),
  };
}

function nullable(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readbackMatchesExpected(expectedJson: string, observed: unknown): boolean {
  let expected: unknown;
  try {
    expected = JSON.parse(expectedJson);
  } catch {
    return false;
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length === 0) return true;
  return matchesExpected(expected, observed);
}

function matchesExpected(expected: unknown, observed: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(observed) && expected.length === observed.length && expected.every((value, index) => matchesExpected(value, observed[index]));
  }
  if (expected && typeof expected === "object") {
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matchesExpected(value, (observed as Record<string, unknown>)[key]));
  }
  return Object.is(expected, observed);
}
