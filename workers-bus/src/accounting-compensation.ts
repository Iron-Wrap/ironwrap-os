// accounting-compensation.ts - credit memo and refund intents, and the plans that authorize them
// (slice S5).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.4 and 6, and the first entry under
// "Rejected alternatives": **auto-compensating a duplicate payment or an over-release is rejected**.
// So this module is deliberately three steps and not one -
//
//   plan   `planAccountingCompensation`   the system proposes: which live exception, which
//                                         provider-supported remedy, which amount
//   derive `deriveCompensationIntent`     the reversal becomes an ordinary money intent, bound to
//                                         the original, and enters `pending_review` like any other
//   submit `submitAccountingCompensation` the accountant has authorized; the reversal dispatches
//                                         as a compensating effect and closes the exception
//
// Nothing here reverses anything on its own. A plan is a proposal, the approval is a command
// receipt written by a human under section 6's authority table, and the reversal is a provider
// entity - never a local delete, which the append-only triggers make impossible anyway.
//
// **The ceiling is a magnitude, everywhere.** A credit memo and a refund are negative amounts. A
// signed `amount > maxAmount` comparison passes trivially for every negative number, which would
// exempt exactly the two kinds section 6 gates hardest from the ceiling that gates them. Every
// comparison in this module - and every amount it hands the port - is `abs()`, matching the
// convention `deriveAccountingIntent` and `0058`'s owner-authority trigger already established.

import type { AppEnv } from "./app-types.ts";
import type {
  MoneyEffectExecutor,
  MoneyEffectPort,
  MoneyActorType,
} from "./accounting-effect-port.ts";
import {
  AccountingIntentError,
  deriveAccountingIntent,
  readAccountingIntent,
  recordAccountingIntentCompensated,
  type AccountingIntentKind,
  type AccountingIntentRecord,
} from "./accounting-intents.ts";
import {
  intentSubjectRef,
  listAccountingExceptions,
  resolveAccountingException,
  type AccountingExceptionRecord,
  type AccountingExceptionReasonCode,
  type AccountingExceptionResolution,
} from "./accounting-exceptions.ts";
import { assertCompensationAllowed } from "./accounting-reconciliation.ts";
import { centsFromDecimal, decimalFromCents } from "./accounting-normalizers.ts";
import {
  magnitudeCents,
  submitAccountingIntent,
  type SubmitAccountingIntentResult,
} from "./accounting-submission.ts";

/** The two remedies that are a reversing *intent*, and the kind each one derives. */
export const REVERSAL_KIND_BY_REMEDY: Readonly<
  Partial<Record<AccountingExceptionResolution, Extract<AccountingIntentKind, "credit_memo" | "refund">>>
> = {
  credit_memo_issued: "credit_memo",
  refund_issued: "refund",
};

/**
 * Exception reasons a reversal can answer.
 *
 * `provider_identity_conflict` is absent on purpose and is not an oversight: reversing an entity
 * we cannot prove is ours is worse than the conflict (section 5.3), and both this module and
 * `accounting_exceptions_block_compensation` in `0061` refuse it.
 */
export const COMPENSABLE_REASON_CODES: readonly AccountingExceptionReasonCode[] = [
  "duplicate_provider_payment",
  "provider_overpayment",
  "duplicate_provider_entity",
  "expected_observed_mismatch",
  "provider_readback_drift",
];

export interface CompensationPlan {
  /** The intent being reversed. */
  intentId: string;
  exceptionId: string;
  reasonCode: AccountingExceptionReasonCode;
  remedy: AccountingExceptionResolution;
  reversalKind: "credit_memo" | "refund";
  providerEntityType: "CreditMemo" | "RefundReceipt";
  /** Negative, two-place decimal: a reversal moves money the other way. */
  totalAmount: string;
  /** The magnitude, for the ceiling comparison and for anything that renders an amount. */
  magnitudeAmount: string;
  /** What the plan is reversing, in the exception's own numbers. */
  basis: {
    originalTotal: string;
    observedSettled: string | null;
    surplus: string | null;
  };
}

export interface PlanAccountingCompensationInput {
  tenantId: string;
  intentId: string;
  /** The remedy the accountant chose from the ones the exception offered. */
  remedy: AccountingExceptionResolution;
  /**
   * Magnitude to reverse, two-place decimal. Omitted means the whole surplus for an over-payment
   * or duplicate payment, and the whole intent for a mismatch, which is the only defensible
   * default in each case.
   */
  amount?: string;
}

/**
 * Propose one compensation. Writes nothing.
 *
 * A plan is refused rather than trimmed when it does not fit: a remedy the exception never offered,
 * a reversal larger than what was posted, or any live identity conflict. Silently clamping an
 * over-sized reversal would produce a partial refund nobody authorized.
 */
export async function planAccountingCompensation(
  env: AppEnv,
  input: PlanAccountingCompensationInput,
): Promise<CompensationPlan> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");

  // Section 5.3 in both layers: the storage-layer trigger refuses the command receipt, and this
  // refuses before a plan is even shown to the accountant.
  await assertCompensationAllowed(env, input.tenantId, input.intentId);

  const exception = await liveCompensableException(env, input.tenantId, input.intentId);
  if (!exception) throw new AccountingIntentError("accounting_compensation_no_live_exception");

  const offered = offeredRemedies(exception);
  if (!offered.includes(input.remedy)) {
    throw new AccountingIntentError("accounting_compensation_remedy_not_offered");
  }
  const reversalKind = REVERSAL_KIND_BY_REMEDY[input.remedy];
  if (!reversalKind) {
    // `void_provider_entity`, `accepted_as_posted` and `superseded_by_new_intent` are real remedies
    // and are resolved directly on the exception; they simply do not derive a reversing intent.
    throw new AccountingIntentError("accounting_compensation_remedy_not_reversal");
  }

  const detail = exceptionDetail(exception);
  const originalCents = centsFromDecimal(intent.total_amount) ?? 0;
  const observedSettled = typeof detail.observedSettled === "string" ? detail.observedSettled : null;
  const settledCents = centsFromDecimal(observedSettled);
  const surplusCents = settledCents === null
    ? null
    : settledCents - Math.abs(originalCents);

  const requestedCents = input.amount === undefined
    ? (surplusCents !== null && surplusCents > 0 ? surplusCents : Math.abs(originalCents))
    : magnitudeCents(input.amount);
  if (requestedCents <= 0) {
    throw new AccountingIntentError("accounting_compensation_amount_invalid");
  }
  // Magnitude, not sign. A reversal may never exceed what was posted in the first place.
  if (requestedCents > Math.abs(originalCents)) {
    throw new AccountingIntentError("accounting_compensation_amount_exceeds_original");
  }

  return {
    intentId: intent.intent_id,
    exceptionId: exception.exception_id,
    reasonCode: exception.reason_code,
    remedy: input.remedy,
    reversalKind,
    providerEntityType: reversalKind === "credit_memo" ? "CreditMemo" : "RefundReceipt",
    totalAmount: decimalFromCents(-requestedCents),
    magnitudeAmount: decimalFromCents(requestedCents),
    basis: {
      originalTotal: intent.total_amount,
      observedSettled,
      surplus: surplusCents === null ? null : decimalFromCents(surplusCents),
    },
  };
}

/**
 * Which authority a plan needs (contract section 8.1: "owner-gated above ceiling").
 *
 * Compared by magnitude, like every other money comparison on this lane: `authority_max_amount` is
 * a magnitude by schema and a reversal is negative by construction, so a signed compare would
 * exempt exactly the reversals the ceiling exists to gate. Section 6 reads "the same authority
 * that authorized the original, or higher", so an accountant may reverse inside the ceiling and
 * only a breach of it escalates to the owner.
 */
export function compensationAuthorityLevel(
  plan: CompensationPlan,
  original: AccountingIntentRecord,
): "accounting" | "owner" {
  return magnitudeCents(plan.totalAmount) > magnitudeCents(original.authority_max_amount)
    ? "owner"
    : "accounting";
}

export interface DeriveCompensationIntentInput {
  tenantId: string;
  plan: CompensationPlan;
  reversalIntentId: string;
  roofJobId: string;
  basis: unknown;
  sourceDocuments: unknown;
  /** The fact envelope the reversal's own readback must return, from `providerFactEnvelope`. */
  expected: unknown;
  realmId: string;
  providerPayload: unknown;
  providerRequestId: string;
  subtotal: string;
  taxAmount: string;
  /** A credit memo carries tax and therefore must bind a snapshot; a refund receipt does not. */
  taxPolicySnapshotSha256?: string | null;
  authority: {
    permitRef: string;
    policyRef: string;
    policyVersion: string;
    /** Compared by magnitude. A negative ceiling would be as meaningless as a signed compare. */
    maxAmount: string;
  };
  effectIdempotencyKey: string;
  derivedBy: { actorKind: "agent" | "owner" | "accounting"; userId?: string | null };
  /** The ledger effect the original intent settled on, so the reversal names what it reverses. */
  compensatesEffectId?: string | null;
}

/**
 * Derive the reversing intent.
 *
 * It is an ordinary money intent - same aggregate, same state machine, same approval - carrying
 * `compensates_intent_id` and `compensates_effect_id` so section 5.4's "both remain visible" is a
 * property of the rows rather than of a report that joins them.
 */
export async function deriveCompensationIntent(
  env: AppEnv,
  input: DeriveCompensationIntentInput,
  now: Date = new Date(),
): Promise<AccountingIntentRecord> {
  if (magnitudeCents(input.subtotal) + magnitudeCents(input.taxAmount)
    !== magnitudeCents(input.plan.totalAmount)) {
    throw new AccountingIntentError("accounting_compensation_amount_invalid");
  }
  return await deriveAccountingIntent(env, {
    tenantId: input.tenantId,
    intentId: input.reversalIntentId,
    kind: input.plan.reversalKind,
    roofJobId: input.roofJobId,
    basis: input.basis,
    sourceDocuments: input.sourceDocuments,
    expected: input.expected,
    taxPolicySnapshotSha256: input.taxPolicySnapshotSha256 ?? null,
    realmId: input.realmId,
    providerPayload: input.providerPayload,
    providerRequestId: input.providerRequestId,
    subtotal: input.subtotal,
    taxAmount: input.taxAmount,
    totalAmount: input.plan.totalAmount,
    authority: input.authority,
    effectIdempotencyKey: input.effectIdempotencyKey,
    derivedBy: input.derivedBy,
    compensatesIntentId: input.plan.intentId,
    compensatesEffectId: input.compensatesEffectId ?? null,
  }, now);
}

export interface SubmitAccountingCompensationInput<T> {
  tenantId: string;
  plan: CompensationPlan;
  reversalIntentId: string;
  port: MoneyEffectPort;
  executor: MoneyEffectExecutor<T>;
  actor: { type: MoneyActorType; id: string };
  /** The accountant closing the exception. Section 6: `owner` where a money reversal is involved. */
  resolvedByUserId: string;
  taskId: string;
  correlationId: string;
  deadlineAt: string;
  authorityExpiresAt: string;
  expectedReadback: unknown;
  retryLimit?: number;
  maxAttempts?: number;
  evidenceRefs?: readonly string[];
}

export interface SubmitAccountingCompensationResult<T> {
  submission: SubmitAccountingIntentResult<T>;
  /** The reversing intent after dispatch. */
  reversal: AccountingIntentRecord;
  /** The original, `compensated` once the reversal was accepted. */
  original: AccountingIntentRecord;
  exception: AccountingExceptionRecord;
}

/**
 * Dispatch an authorized reversal.
 *
 * Ordering is the contract: the reversal reaches the provider first, and only a dispatch the
 * ledger accepted closes the exception and marks the original `compensated`. Closing first would
 * leave a queue that says "handled" pointing at money that never moved.
 *
 * The caller has already run the `compensate` command on the original (which is where the
 * accountant's authority and the identity-conflict block are enforced), so the original is in
 * `compensating` when this is called.
 */
export async function submitAccountingCompensation<T>(
  env: AppEnv,
  input: SubmitAccountingCompensationInput<T>,
  now: Date = new Date(),
): Promise<SubmitAccountingCompensationResult<T>> {
  const original = await readAccountingIntent(env, input.tenantId, input.plan.intentId);
  if (!original) throw new AccountingIntentError("accounting_intent_missing");
  if (original.state !== "compensating") {
    throw new AccountingIntentError("accounting_intent_not_compensating");
  }
  // Re-checked at dispatch, not only at plan time: a conflict can be raised by a sweep between the
  // accountant reading the proposal and authorizing it.
  await assertCompensationAllowed(env, input.tenantId, input.plan.intentId);

  const submission = await submitAccountingIntent<T>(env, {
    tenantId: input.tenantId,
    intentId: input.reversalIntentId,
    port: input.port,
    executor: input.executor,
    actor: input.actor,
    taskId: input.taskId,
    correlationId: input.correlationId,
    deadlineAt: input.deadlineAt,
    authorityExpiresAt: input.authorityExpiresAt,
    expectedReadback: input.expectedReadback,
    retryLimit: input.retryLimit,
    maxAttempts: input.maxAttempts,
    evidenceRefs: input.evidenceRefs,
    // Section 5.4: every remedy carries the plan it executes, so the ledger envelope records what
    // the accountant authorized rather than only what was sent.
    compensationPlan: {
      exceptionId: input.plan.exceptionId,
      reasonCode: input.plan.reasonCode,
      remedy: input.plan.remedy,
      compensatesIntentId: input.plan.intentId,
      amount: input.plan.totalAmount,
    },
  }, now);

  if (submission.status !== "submitted") {
    // Nothing is closed and nothing is marked compensated. An uncertain or failed reversal is
    // still an open exception, which is exactly what the accountant needs to see.
    const exception = await readExceptionOrThrow(env, input.tenantId, input.plan.exceptionId);
    return { submission, reversal: submission.intent, original, exception };
  }

  const exception = await resolveAccountingException(env, {
    tenantId: input.tenantId,
    exceptionId: input.plan.exceptionId,
    actorUserId: input.resolvedByUserId,
    resolutionAction: input.plan.remedy,
    compensatingEffectId: submission.outcome?.effectId ?? null,
  }, now);

  const compensated = await recordAccountingIntentCompensated(env, {
    tenantId: input.tenantId,
    intentId: input.plan.intentId,
    reasonCode: input.plan.remedy,
  }, now);

  return { submission, reversal: submission.intent, original: compensated, exception };
}

/** The live exception a reversal may answer, oldest first when more than one is open. */
export async function liveCompensableException(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<AccountingExceptionRecord | null> {
  const open = await listAccountingExceptions(env, tenantId, { intentId });
  return open.find((candidate) =>
    candidate.status !== "resolved"
    && candidate.subject_ref === intentSubjectRef(intentId)
    && COMPENSABLE_REASON_CODES.includes(candidate.reason_code)) ?? null;
}

/** The remedies this exception actually offered, as `accounting-reconciliation.ts` wrote them. */
export function offeredRemedies(
  exception: AccountingExceptionRecord,
): AccountingExceptionResolution[] {
  const detail = exceptionDetail(exception);
  const remedies = Array.isArray(detail.remedies) ? detail.remedies : [];
  const offered: AccountingExceptionResolution[] = [];
  for (const remedy of remedies) {
    const record = remedy as { action?: unknown; alternatives?: unknown };
    if (typeof record?.action === "string") offered.push(record.action as AccountingExceptionResolution);
    for (const alternative of Array.isArray(record?.alternatives) ? record.alternatives : []) {
      if (typeof alternative === "string") {
        offered.push(alternative as AccountingExceptionResolution);
      }
    }
  }
  return offered;
}

function exceptionDetail(exception: AccountingExceptionRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(exception.detail_json) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readExceptionOrThrow(
  env: AppEnv,
  tenantId: string,
  exceptionId: string,
): Promise<AccountingExceptionRecord> {
  const row = await env.DB.prepare(
    `SELECT * FROM accounting_exceptions WHERE tenant_id = ? AND exception_id = ?`,
  ).bind(tenantId, exceptionId).first<AccountingExceptionRecord>();
  if (!row) throw new AccountingIntentError("accounting_exception_missing");
  return row;
}
