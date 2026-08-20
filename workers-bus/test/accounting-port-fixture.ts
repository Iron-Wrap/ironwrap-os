// accounting-port-fixture.ts - the test binding for the money ports.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 3.1: an in-memory ledger implementing the
// same twelve states and the same UNIQUE (tenantId, idempotencyKey) rule, plus a fixed-token auth
// stub. Every S1..S10 scenario test runs against this, so the money slices are provable without
// the connection plane and without a single provider call.
//
// The behaviour deliberately mirrors `runExternalEffect`: the same propose -> authorize ->
// execute -> settle order, the same envelope hash over the same canonical JSON, and the same
// refusal codes. `accounting-port.test.ts` pins that correspondence.

import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import {
  MoneyEffectError,
  toExternalEffectShape,
  type MoneyAttemptState,
  type MoneyDispatchResult,
  type MoneyEffectExecutor,
  type MoneyEffectOutcome,
  type MoneyEffectPort,
  type MoneyEffectRequest,
  type MoneyEffectState,
  type MoneyReadback,
} from "../src/accounting-effect-port.ts";
import type {
  QuickBooksAuthPort,
  QuickBooksRealmBinding,
} from "../src/quickbooks-auth-port.ts";

interface LedgerRow {
  effectId: string;
  tenantId: string;
  action: string;
  idempotencyKey: string;
  envelopeHash: string;
  requestHash: string;
  deadlineAt: string;
  retryLimit: number;
  attemptCount: number;
  state: MoneyEffectState;
  providerExternalId: string | null;
  providerResponseHash: string | null;
  readbackHash: string | null;
  resultCode: string | null;
  expectedReadback: unknown;
  exceptions: Array<{ reasonCode: string; observedHash: string; status: "open" }>;
}

interface AttemptRow {
  attemptId: string;
  effectId: string;
  attemptNumber: number;
  state: MoneyAttemptState;
}

/**
 * In-memory money effect ledger. `UNIQUE (tenantId, idempotencyKey)` is the Map key, which is the
 * whole point: a duplicate business key cannot produce a second ledger row here either.
 */
export class TestMoneyEffectPort implements MoneyEffectPort {
  private readonly effects = new Map<string, LedgerRow>();
  private readonly attempts: AttemptRow[] = [];
  /** Every dispatch the port actually made, so a test can assert a provider was not called twice. */
  readonly dispatches: Array<{ effectId: string; attemptId: string; businessIdempotencyKey: string }> = [];
  /**
   * Every request the port was handed, accepted or refused. Slice S4 uses it to assert what the
   * money plane actually put in the envelope - notably that the authority amounts are magnitudes.
   */
  readonly requests: MoneyEffectRequest[] = [];
  ready = true;
  private sequence = 0;

  assertReady(): void {
    if (!this.ready) throw new MoneyEffectError("effect_runtime_required");
  }

  /** Read a settled row the way a reconciliation sweep would. */
  effect(effectId: string): LedgerRow | null {
    for (const row of this.effects.values()) if (row.effectId === effectId) return { ...row };
    return null;
  }

  attemptsFor(effectId: string): AttemptRow[] {
    return this.attempts.filter((attempt) => attempt.effectId === effectId).map((a) => ({ ...a }));
  }

  /**
   * Drive a lost-response effect to the state a deadline sweep would leave it in.
   * Contract section 5.4: `unknown` is never retried, only reconciled or escalated.
   */
  forceManualException(effectId: string, reasonCode: string): void {
    const row = this.mutable(effectId);
    if (row.state !== "unknown") throw new MoneyEffectError("effect_not_unknown");
    row.state = "manual_exception";
    row.resultCode = reasonCode;
  }

  /** Resolve an `unknown` effect by a provider query on the business idempotency key. */
  resolveUnknown(effectId: string, found: { providerExternalId: string; readbackHash: string } | null): void {
    const row = this.mutable(effectId);
    if (row.state !== "unknown") throw new MoneyEffectError("effect_not_unknown");
    if (!found) {
      row.state = "manual_exception";
      row.resultCode = "effect_unknown_not_found_at_deadline";
      return;
    }
    row.state = "succeeded";
    row.providerExternalId = found.providerExternalId;
    row.readbackHash = found.readbackHash;
    row.resultCode = null;
  }

  private mutable(effectId: string): LedgerRow {
    for (const row of this.effects.values()) if (row.effectId === effectId) return row;
    throw new MoneyEffectError("effect_missing");
  }

  async run<T>(
    input: MoneyEffectRequest,
    executor: MoneyEffectExecutor<T>,
    now: Date = new Date(),
  ): Promise<MoneyEffectOutcome<T>> {
    this.assertReady();
    this.requests.push(input);
    const projected = toExternalEffectShape(input);
    const requestHash = await sha256Hex(canonicalJson(input.request));
    const key = `${input.tenantId}\0${input.idempotencyKey}`;
    const existing = this.effects.get(key);
    // A retry may not extend the stored deadline, so the envelope is hashed against the
    // deadline already accepted for this business key. Same rule as the runtime.
    const envelopeHash = await this.envelopeHash(
      existing ? { ...input, deadlineAt: existing.deadlineAt } : input,
      requestHash,
    );

    if (existing) {
      if (existing.envelopeHash !== envelopeHash) throw new MoneyEffectError("effect_idempotency_conflict");
      if (existing.state === "unknown") throw new MoneyEffectError("effect_unknown_requires_reconciliation");
      if (existing.state === "manual_exception") throw new MoneyEffectError("effect_manual_exception");
      if (existing.state === "succeeded") {
        return this.outcome(existing, await executor.replay({ effectId: existing.effectId }));
      }
      if (existing.state === "failed") existing.state = "retry";
      if (!["proposed", "authorized", "retry"].includes(existing.state)) {
        throw new MoneyEffectError("effect_in_flight");
      }
    }

    if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
      throw new MoneyEffectError("effect_idempotency_key_invalid");
    }
    if (Date.parse(input.deadlineAt) <= now.getTime()) {
      throw new MoneyEffectError("effect_deadline_invalid");
    }

    const row: LedgerRow = existing ?? {
      effectId: `effect:${input.tenantId}:${++this.sequence}`,
      tenantId: input.tenantId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      envelopeHash,
      requestHash,
      deadlineAt: input.deadlineAt,
      retryLimit: input.retryLimit ?? 0,
      attemptCount: 0,
      state: "proposed",
      providerExternalId: null,
      providerResponseHash: null,
      readbackHash: null,
      resultCode: null,
      expectedReadback: input.expectedReadback ?? {},
      exceptions: [],
    };
    this.effects.set(key, row);

    if (row.state === "proposed") this.authorize(row, projected.authority, now);
    return await this.execute(row, executor, now);
  }

  private authorize(
    row: LedgerRow,
    authority: ReturnType<typeof toExternalEffectShape>["authority"],
    now: Date,
  ): void {
    if (Date.parse(authority.expiresAt) <= now.getTime()) {
      throw new MoneyEffectError("effect_authority_expired");
    }
    if (!authority.allowedActions.includes(row.action)) {
      throw new MoneyEffectError("effect_policy_action_denied");
    }
    if (authority.maxAttempts !== undefined && row.retryLimit + 1 > authority.maxAttempts) {
      throw new MoneyEffectError("effect_policy_retry_ceiling_exceeded");
    }
    // The money ceiling the contract relies on instead of building a second one.
    if (
      authority.maxAmount !== undefined &&
      authority.amount !== undefined &&
      authority.amount > authority.maxAmount
    ) {
      throw new MoneyEffectError("effect_policy_amount_ceiling_exceeded");
    }
    row.state = "authorized";
  }

  private async execute<T>(
    row: LedgerRow,
    executor: MoneyEffectExecutor<T>,
    now: Date,
  ): Promise<MoneyEffectOutcome<T>> {
    if (Date.parse(row.deadlineAt) <= now.getTime()) throw new MoneyEffectError("effect_deadline_expired");
    const attemptNumber = row.attemptCount + 1;
    if (attemptNumber > row.retryLimit + 1) throw new MoneyEffectError("effect_retry_exhausted");

    if (executor.preconditions) {
      let check: { ok: boolean; detailCode?: string };
      try {
        check = await executor.preconditions({ effectId: row.effectId });
      } catch {
        check = { ok: false, detailCode: "effect_preconditions_unavailable" };
      }
      if (!check.ok) {
        row.state = "failed";
        row.resultCode = check.detailCode ?? "effect_preconditions_failed";
        return this.outcome(row, undefined);
      }
    }

    const attempt: AttemptRow = {
      attemptId: `${row.effectId}:attempt:${attemptNumber}`,
      effectId: row.effectId,
      attemptNumber,
      state: "executing",
    };
    this.attempts.push(attempt);
    row.attemptCount = attemptNumber;
    row.state = "executing";
    row.resultCode = null;

    let dispatched: MoneyDispatchResult<T>;
    this.dispatches.push({
      effectId: row.effectId,
      attemptId: attempt.attemptId,
      businessIdempotencyKey: row.idempotencyKey,
    });
    try {
      dispatched = await executor.dispatch({
        effectId: row.effectId,
        attemptId: attempt.attemptId,
        businessIdempotencyKey: row.idempotencyKey,
      });
    } catch {
      dispatched = { outcome: "unknown", detailCode: "effect_dispatch_unknown" };
    }

    row.providerResponseHash = dispatched.providerResponse === undefined
      ? null
      : await sha256Hex(canonicalJson(dispatched.providerResponse));

    if (dispatched.outcome === "rejected") {
      return this.settle(row, attempt, "failed", dispatched.detailCode ?? "provider_rejected", dispatched.providerExternalId ?? null, null, dispatched.value);
    }

    row.state = "reconciling";
    attempt.state = "reconciling";
    row.providerExternalId = dispatched.providerExternalId ?? null;

    let readback: MoneyReadback | undefined = dispatched.readback;
    if (!readback) {
      try {
        readback = await executor.readback({
          effectId: row.effectId,
          providerExternalId: dispatched.providerExternalId ?? null,
        });
      } catch {
        readback = { status: "unavailable", detailCode: "provider_readback_unavailable" };
      }
    }
    if (readback.status === "match" && !matchesExpected(row.expectedReadback, readback.observed)) {
      readback = { ...readback, status: "conflict", detailCode: "provider_readback_conflict" };
    }

    if (readback.status === "unavailable" || readback.status === "not_found") {
      // Lost response. Never a retry: only a provider query can resolve it.
      return this.settle(row, attempt, "unknown", readback.detailCode ?? dispatched.detailCode ?? "effect_outcome_unknown", dispatched.providerExternalId ?? null, null, dispatched.value);
    }
    if (readback.status === "conflict") {
      const observedHash = await sha256Hex(canonicalJson(readback.observed ?? {}));
      const reasonCode = readback.detailCode ?? "provider_readback_conflict";
      if (!row.exceptions.some((exception) => exception.reasonCode === reasonCode)) {
        row.exceptions.push({ reasonCode, observedHash, status: "open" });
      }
      attempt.state = "unknown";
      row.state = "manual_exception";
      row.readbackHash = observedHash;
      row.resultCode = reasonCode;
      return this.outcome(row, dispatched.value);
    }

    const readbackHash = await sha256Hex(canonicalJson(
      readback.observed ?? { providerExternal_id: readback.providerExternalId ?? dispatched.providerExternalId ?? null },
    ));
    const settled = this.settle(row, attempt, "succeeded", null, readback.providerExternalId ?? dispatched.providerExternalId ?? null, readbackHash, dispatched.value);
    if (dispatched.value === undefined) {
      return { ...(await settled), value: await executor.replay({ effectId: row.effectId }) };
    }
    return await settled;
  }

  private async settle<T>(
    row: LedgerRow,
    attempt: AttemptRow,
    attemptState: "succeeded" | "failed" | "unknown",
    detailCode: string | null,
    providerExternalId: string | null,
    readbackHash: string | null,
    value: T | undefined,
  ): Promise<MoneyEffectOutcome<T>> {
    attempt.state = attemptState;
    row.state = attemptState;
    row.resultCode = detailCode;
    row.providerExternalId = providerExternalId;
    row.readbackHash = readbackHash;
    return this.outcome(row, value);
  }

  private outcome<T>(row: LedgerRow, value: T | undefined): MoneyEffectOutcome<T> {
    const attempt = this.attempts.filter((a) => a.effectId === row.effectId).at(-1) ?? null;
    return {
      effectId: row.effectId,
      state: row.state,
      attemptId: attempt?.attemptId ?? null,
      attemptState: attempt?.state ?? null,
      providerExternalId: row.providerExternalId,
      requestHash: row.requestHash,
      providerResponseHash: row.providerResponseHash,
      readbackHash: row.readbackHash,
      resultCode: row.resultCode,
      value,
    };
  }

  private async envelopeHash(input: MoneyEffectRequest, requestHash: string): Promise<string> {
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
}

function matchesExpected(expected: unknown, observed: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length === 0) {
    return true;
  }
  return deepMatches(expected, observed);
}

function deepMatches(expected: unknown, observed: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(observed)
      && expected.length === observed.length
      && expected.every((value, index) => deepMatches(value, observed[index]));
  }
  if (expected && typeof expected === "object") {
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      deepMatches(value, (observed as Record<string, unknown>)[key]));
  }
  return Object.is(expected, observed);
}

/**
 * Fixed-token auth stub. No OAuth, no refresh, no encrypted bundle, no network: the money slices
 * need a realm and a token to build a request, and nothing about their behaviour depends on how
 * those were obtained.
 */
export class TestQuickBooksAuthPort implements QuickBooksAuthPort {
  private readonly binding: QuickBooksRealmBinding;
  private failure: string | null = null;
  readonly calls: string[] = [];

  constructor(overrides: Partial<QuickBooksRealmBinding> = {}) {
    this.binding = {
      realmId: "4620816365000000000",
      accessToken: "test-access-token",
      apiBase: "https://sandbox-quickbooks.api.example.invalid",
      minorVersion: "75",
      connectionId: "11111111-2222-4333-8444-555555555555",
      ...overrides,
    };
  }

  /** Make the next resolution fail, so a caller's blocked path is testable. */
  failWith(code: string | null): void {
    this.failure = code;
  }

  async activeRealm(tenantId: string): Promise<QuickBooksRealmBinding> {
    this.calls.push(tenantId);
    if (this.failure) throw new Error(this.failure);
    return { ...this.binding };
  }
}
