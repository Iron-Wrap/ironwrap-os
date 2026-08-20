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

/**
 * Close one exception with the remedy that was actually performed.
 *
 * `compensatingEffectId` is required for every remedy that reverses money at the provider, because
 * section 5.4 requires a remedy to be a compensating effect linked to the original - "the system
 * proposes; the accountant authorizes" - and an unlinked resolution would be an accountant saying
 * a reversal happened with nothing in the ledger to show for it.
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
  const compensating: readonly AccountingExceptionResolution[] = [
    "void_provider_entity", "credit_memo_issued", "refund_issued", "adjusting_entry_posted",
  ];
  if (compensating.includes(input.resolutionAction) && !input.compensatingEffectId) {
    throw new AccountingExceptionError("accounting_exception_compensating_effect_required");
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
