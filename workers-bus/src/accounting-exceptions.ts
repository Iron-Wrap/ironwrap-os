// accounting-exceptions.ts - the accountant queue of contract section 4.2.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S3. Every difference between what IronWrap
// bound locally and what the provider says is posted lands here. Nothing in this module changes a
// money fact: "never adjust local truth to match the provider. A difference is an exception, not a
// correction" (section 5.1), and the resolution vocabulary admits only provider-supported remedies
// (section 6) - void, credit memo, refund receipt, adjusting entry, or an explicit decision to
// accept what is posted. There is no code path here that deletes a row.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson } from "./newo-hash.ts";

export const ACCOUNTING_EXCEPTION_REASON_CODES = [
  "duplicate_provider_entity",
  "duplicate_provider_payment",
  "provider_overpayment",
  "provider_identity_conflict",
  "provider_entity_not_found",
  "provider_readback_drift",
  "expected_observed_mismatch",
  "settlement_invariant_violated",
  "unknown_effect_deadline_expired",
  "tax_rate_drift",
  // Declared by 0061 for slices S6 and S7, which have not shipped. A migration is never edited
  // after it ships, so the vocabulary has to be complete before those slices need it.
  "holdback_over_released",
  "payroll_posting_mismatch",
] as const;

export type AccountingExceptionReasonCode = (typeof ACCOUNTING_EXCEPTION_REASON_CODES)[number];

export const ACCOUNTING_EXCEPTION_RESOLUTIONS = [
  "void_provider_entity",
  "credit_memo_issued",
  "refund_issued",
  "adjusting_entry_posted",
  "accepted_as_posted",
  "superseded_by_new_intent",
] as const;

export type AccountingExceptionResolution = (typeof ACCOUNTING_EXCEPTION_RESOLUTIONS)[number];

export type AccountingExceptionStatus = "open" | "acknowledged" | "resolved";

export class AccountingExceptionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingExceptionError";
  }
}

export interface AccountingExceptionRecord {
  exception_id: string;
  tenant_id: string;
  subject_ref: string;
  intent_id: string | null;
  reason_code: AccountingExceptionReasonCode;
  expected_sha256: string | null;
  observed_sha256: string | null;
  detail_json: string;
  status: AccountingExceptionStatus;
  resolution_action: AccountingExceptionResolution | null;
  compensating_effect_id: string | null;
  acknowledged_by_user_id: string | null;
  acknowledged_at: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  opened_at: string;
  updated_at: string;
}

/** `subject_ref` for one money intent. Stable, so a re-raise finds the same live row. */
export function intentSubjectRef(intentId: string): string {
  return `accounting_intent:${intentId}`;
}

export interface RaiseAccountingExceptionInput {
  tenantId: string;
  subjectRef: string;
  intentId?: string | null;
  reasonCode: AccountingExceptionReasonCode;
  expectedSha256?: string | null;
  observedSha256?: string | null;
  /**
   * Identifiers, amounts, and the provider-supported remedies on offer. Never a provider payload
   * body and never a credential (section 6).
   */
  detail: unknown;
}

/**
 * Raise one exception, idempotently.
 *
 * A scheduled sweep re-reads the same drifted entity every time it runs, so raising has to be a
 * no-op when the same finding is already live. `idx_accounting_exceptions_live` makes that a
 * storage-layer guarantee rather than a check the handler could skip: at most one open or
 * acknowledged row per subject and reason.
 */
export async function raiseAccountingException(
  env: AppEnv,
  input: RaiseAccountingExceptionInput,
  now: Date = new Date(),
): Promise<{ exception: AccountingExceptionRecord; raised: boolean }> {
  if (!ACCOUNTING_EXCEPTION_REASON_CODES.includes(input.reasonCode)) {
    throw new AccountingExceptionError("accounting_exception_reason_invalid");
  }
  const existing = await readLiveAccountingException(
    env,
    input.tenantId,
    input.subjectRef,
    input.reasonCode,
  );
  if (existing) return { exception: existing, raised: false };

  const timestamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO accounting_exceptions (
       exception_id, tenant_id, subject_ref, intent_id, reason_code, expected_sha256,
       observed_sha256, detail_json, status, opened_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.tenantId, input.subjectRef, input.intentId ?? null,
    input.reasonCode, input.expectedSha256 ?? null, input.observedSha256 ?? null,
    canonicalJson(input.detail), timestamp, timestamp,
  ).run();

  const raised = await readLiveAccountingException(
    env,
    input.tenantId,
    input.subjectRef,
    input.reasonCode,
  );
  if (!raised) throw new AccountingExceptionError("accounting_exception_raise_failed");
  return { exception: raised, raised: true };
}

/** The accountant has seen it. Acknowledgement is evidence, so it is written once. */
export async function acknowledgeAccountingException(
  env: AppEnv,
  input: { tenantId: string; exceptionId: string; actorUserId: string },
  now: Date = new Date(),
): Promise<AccountingExceptionRecord> {
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `UPDATE accounting_exceptions
        SET status = 'acknowledged', acknowledged_by_user_id = ?, acknowledged_at = ?,
            updated_at = ?
      WHERE tenant_id = ? AND exception_id = ? AND status = 'open'`,
  ).bind(input.actorUserId, timestamp, timestamp, input.tenantId, input.exceptionId).run();

  const applied = await readAccountingException(env, input.tenantId, input.exceptionId);
  if (!applied) throw new AccountingExceptionError("accounting_exception_missing");
  if (applied.status === "open") {
    throw new AccountingExceptionError("accounting_exception_transition_invalid");
  }
  return applied;
}

/** The remedies that move money at the provider, and therefore owe the ledger an effect. */
export const COMPENSATING_RESOLUTIONS: readonly AccountingExceptionResolution[] = [
  "void_provider_entity", "credit_memo_issued", "refund_issued", "adjusting_entry_posted",
];

/**
 * The remedies IronWrap can actually dispatch, and therefore actually verify.
 *
 * `credit_memo_issued` and `refund_issued` derive a reversing intent (`REVERSAL_KIND_BY_REMEDY` in
 * `accounting-compensation.ts`) that goes through the port and lands an `effect_id` on a row.
 * `void_provider_entity` and `adjusting_entry_posted` have no dispatch path in any shipped slice,
 * so there is no ledger evidence they could ever produce - and accepting a typed-in reference for
 * them is exactly the honour system ELEC-71 closed a real $240 exception with. They refuse by name
 * until a slice gives them a dispatch path, which is the same posture the holdback and payroll
 * routes take at `501`: an honest refusal beats a success that means nothing.
 */
export const DISPATCHABLE_RESOLUTIONS: readonly AccountingExceptionResolution[] = [
  "credit_memo_issued", "refund_issued",
];

/** The reversal states that count as "the ledger accepted it" (section 5.1: only a readback settles). */
const SETTLED_REVERSAL_STATES: readonly string[] = [
  "submitted", "partially_settled", "reconciled", "compensated",
];

/**
 * Close one exception with the remedy that was actually performed.
 *
 * `compensatingEffectId` is required for every remedy that reverses money at the provider, because
 * section 5.4 requires a remedy to be a compensating effect linked to the original - "the system
 * proposes; the accountant authorizes" - and an unlinked resolution would be an accountant saying
 * a reversal happened with nothing in the ledger to show for it.
 *
 * Requiring it is not the same as checking it, and until this slice only the requirement existed:
 * any 8-160 character string closed any exception, so the badge that reads "compensated" could be
 * shown to an office manager for money nobody reversed anywhere (ELEC-71, proven on the live UI
 * with the invented reference `credit-memo-cm-e2e-000001`). `verifyCompensatingEffect` below is the
 * check. It looks the claimed effect up in the only ledger that can prove a dispatch happened -
 * `accounting_intents.effect_id`, which is written from a settled `MoneyEffectOutcome` and from
 * nowhere else - and refuses a reference that is not a real, settled, matching reversal of *this*
 * exception's intent.
 */
export async function resolveAccountingException(
  env: AppEnv,
  input: {
    tenantId: string;
    exceptionId: string;
    actorUserId: string;
    resolutionAction: AccountingExceptionResolution;
    compensatingEffectId?: string | null;
  },
  now: Date = new Date(),
): Promise<AccountingExceptionRecord> {
  if (!ACCOUNTING_EXCEPTION_RESOLUTIONS.includes(input.resolutionAction)) {
    throw new AccountingExceptionError("accounting_exception_resolution_invalid");
  }
  if (COMPENSATING_RESOLUTIONS.includes(input.resolutionAction)) {
    if (!input.compensatingEffectId) {
      throw new AccountingExceptionError("accounting_exception_compensating_effect_required");
    }
    if (!DISPATCHABLE_RESOLUTIONS.includes(input.resolutionAction)) {
      throw new AccountingExceptionError("accounting_exception_remedy_dispatch_unavailable");
    }
    const exception = await readAccountingException(env, input.tenantId, input.exceptionId);
    if (!exception) throw new AccountingExceptionError("accounting_exception_missing");
    await verifyCompensatingEffect(env, {
      tenantId: input.tenantId,
      exception,
      compensatingEffectId: input.compensatingEffectId,
    });
  }

  const timestamp = now.toISOString();
  await env.DB.prepare(
    `UPDATE accounting_exceptions
        SET status = 'resolved', resolution_action = ?, compensating_effect_id = ?,
            resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
      WHERE tenant_id = ? AND exception_id = ? AND status IN ('open', 'acknowledged')`,
  ).bind(
    input.resolutionAction, input.compensatingEffectId ?? null, input.actorUserId, timestamp,
    timestamp, input.tenantId, input.exceptionId,
  ).run();

  const applied = await readAccountingException(env, input.tenantId, input.exceptionId);
  if (!applied) throw new AccountingExceptionError("accounting_exception_missing");
  if (applied.status !== "resolved") {
    throw new AccountingExceptionError("accounting_exception_transition_invalid");
  }
  return applied;
}

/** What the ledger says about a claimed reversal, or why it says nothing. */
export interface CompensatingEffectEvidence {
  effect_id: string;
  reversal_intent_id: string;
  compensates_intent_id: string | null;
  state: string;
  total_amount: string;
  provider_entity_id: string | null;
}

/**
 * Prove that a claimed `compensating_effect_id` names a reversal that really happened.
 *
 * The ledger of actually-dispatched money on this plane is `accounting_intents.effect_id`: it is
 * written by `recordAccountingIntentSubmission` from a settled `MoneyEffectOutcome` and by nothing
 * else, so a string that was typed into a form can never appear there. Five things have to hold,
 * and each refusal names which one did not:
 *
 *   1. the effect exists at all                    `..._unknown`
 *   2. it reverses *this* exception's intent       `..._intent_mismatch`
 *   3. the ledger accepted it                      `..._not_settled`
 *   4. a human authorized *this* exception's remedy `..._unauthorized`
 *   5. it is the amount that was authorized        `..._amount_mismatch`
 *
 * Rule 2 is the one that matters most in practice: without it, a real reversal of some other
 * invoice would close this exception, which is a subtler version of the same lie.
 */
export async function verifyCompensatingEffect(
  env: AppEnv,
  input: {
    tenantId: string;
    exception: AccountingExceptionRecord;
    compensatingEffectId: string;
  },
): Promise<CompensatingEffectEvidence> {
  // Every row carrying this effect id, not just the first: the id is unique per ledger but the
  // money plane must not depend on that to answer "does this reverse *my* intent". Selecting the
  // candidate by what it reverses is both the stronger check and the order-independent one.
  const candidates = await env.DB.prepare(
    `SELECT effect_id, intent_id AS reversal_intent_id, compensates_intent_id, state,
            total_amount, provider_entity_id
       FROM accounting_intents
      WHERE tenant_id = ? AND effect_id = ?
      ORDER BY intent_id`,
  ).bind(input.tenantId, input.compensatingEffectId).all<CompensatingEffectEvidence>();
  const rows = candidates.results ?? [];

  if (rows.length === 0) {
    throw new AccountingExceptionError("accounting_exception_compensating_effect_unknown");
  }
  const reversal = input.exception.intent_id === null
    ? rows[0]!
    : rows.find((row) => row.compensates_intent_id === input.exception.intent_id);
  if (!reversal) {
    throw new AccountingExceptionError(
      "accounting_exception_compensating_effect_intent_mismatch",
    );
  }
  if (!SETTLED_REVERSAL_STATES.includes(reversal.state)) {
    throw new AccountingExceptionError("accounting_exception_compensating_effect_not_settled");
  }

  // The amount is checked against what a human authorized, not against what the reversal happens
  // to say: the authorization row is the signed decision (section 6), and a reversal that drifted
  // from it is not the remedy anybody approved.
  //
  // A missing authorization is a refusal, not a skipped check (ELEC-73 finding 3). Falling back to
  // "reverses the same original intent, and is settled" is too weak to be the whole test: two
  // exceptions raised against one intent could each be closed by pointing at the same single
  // reversal, and a sibling exception's reversal could close the wrong one whenever the amounts
  // happened to agree. Every path through `POST /compensate` writes the authorization first, so an
  // exception being closed without one is a resolution nobody authorized - which section 5.4
  // ("the system proposes; the accountant authorizes") says is exactly what must not close.
  const authorization = await readAuthorizedMagnitude(
    env, input.tenantId, input.exception.exception_id,
  );
  if (authorization === null) {
    throw new AccountingExceptionError(
      "accounting_exception_compensating_effect_unauthorized",
    );
  }
  if (magnitude(reversal.total_amount) !== magnitude(authorization)) {
    throw new AccountingExceptionError("accounting_exception_compensating_effect_amount_mismatch");
  }
  return reversal;
}

/**
 * The magnitude the accountant authorized for this exception, or null when none was recorded.
 *
 * Read with a bare query rather than through `accounting-compensation-authorizations.ts` so this
 * module keeps no import back into the compensation plane, which imports this one.
 */
async function readAuthorizedMagnitude(
  env: AppEnv,
  tenantId: string,
  exceptionId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT magnitude_amount FROM accounting_compensation_authorizations
      WHERE tenant_id = ? AND exception_id = ?`,
  ).bind(tenantId, exceptionId).first<{ magnitude_amount: string }>();
  return row?.magnitude_amount ?? null;
}

/** Absolute integer cents. Two decimal places are a column CHECK, so this is exact. */
function magnitude(value: string): number {
  return Math.abs(Number.parseInt(value.replace(".", ""), 10));
}

export async function readAccountingException(
  env: AppEnv,
  tenantId: string,
  exceptionId: string,
): Promise<AccountingExceptionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_exceptions WHERE tenant_id = ? AND exception_id = ?`,
  ).bind(tenantId, exceptionId).first<AccountingExceptionRecord>();
}

/** The live row for one subject and reason, if the queue already holds this finding. */
export async function readLiveAccountingException(
  env: AppEnv,
  tenantId: string,
  subjectRef: string,
  reasonCode: AccountingExceptionReasonCode,
): Promise<AccountingExceptionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_exceptions
      WHERE tenant_id = ? AND subject_ref = ? AND reason_code = ? AND status != 'resolved'`,
  ).bind(tenantId, subjectRef, reasonCode).first<AccountingExceptionRecord>();
}

/** The accountant's queue, oldest first: section 8.2's exception screen reads this. */
export async function listAccountingExceptions(
  env: AppEnv,
  tenantId: string,
  filter: { status?: AccountingExceptionStatus; intentId?: string } = {},
): Promise<AccountingExceptionRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_exceptions
      WHERE tenant_id = ?
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR intent_id = ?)
      ORDER BY opened_at, exception_id`,
  ).bind(
    tenantId, filter.status ?? null, filter.status ?? null,
    filter.intentId ?? null, filter.intentId ?? null,
  ).all<AccountingExceptionRecord>();
  return rows.results ?? [];
}
