/**
 * IRO-52 leftover: holdback and payroll fail closed until policy + credentials exist.
 *
 * S6/S7/S10/S12 are specified. They are not implemented. This module names that
 * refusal so a caller cannot invent a QuickBooks posting target or treat a 501
 * as accountant acceptance.
 */

export const HOLDBACK_SLICE = "S6" as const;
export const PAYROLL_SLICE = "S7" as const;
export const HOLDBACK_PAYROLL_REVIEW_SLICE = "S10" as const;
export const QUICKBOOKS_SANDBOX_ACCEPTANCE_SLICE = "S12" as const;

export const HOLDBACK_NOT_IMPLEMENTED = "accounting_holdback_not_implemented" as const;
export const PAYROLL_NOT_IMPLEMENTED = "accounting_payroll_not_implemented" as const;

export const HOLDBACK_PAYROLL_HTTP_STATUS = 501 as const;

export type HoldbackPayrollSlice =
  | typeof HOLDBACK_SLICE
  | typeof PAYROLL_SLICE
  | typeof HOLDBACK_PAYROLL_REVIEW_SLICE
  | typeof QUICKBOOKS_SANDBOX_ACCEPTANCE_SLICE;

export type HoldbackPayrollIntentKind = "holdback_release" | "payroll_journal";

export type HoldbackPayrollPostingTarget = null;

export interface HoldbackPayrollFailClosedRefusal {
  status: typeof HOLDBACK_PAYROLL_HTTP_STATUS;
  error: typeof HOLDBACK_NOT_IMPLEMENTED | typeof PAYROLL_NOT_IMPLEMENTED;
  slice: typeof HOLDBACK_SLICE | typeof PAYROLL_SLICE;
  live_accountant_acceptance: false;
  live_quickbooks_call: false;
  posting_target: HoldbackPayrollPostingTarget;
}

const REFUSAL_BY_KIND = {
  holdback_release: {
    status: HOLDBACK_PAYROLL_HTTP_STATUS,
    error: HOLDBACK_NOT_IMPLEMENTED,
    slice: HOLDBACK_SLICE,
    live_accountant_acceptance: false,
    live_quickbooks_call: false,
    posting_target: null,
  },
  payroll_journal: {
    status: HOLDBACK_PAYROLL_HTTP_STATUS,
    error: PAYROLL_NOT_IMPLEMENTED,
    slice: PAYROLL_SLICE,
    live_accountant_acceptance: false,
    live_quickbooks_call: false,
    posting_target: null,
  },
} as const satisfies Record<HoldbackPayrollIntentKind, HoldbackPayrollFailClosedRefusal>;

export function isHoldbackPayrollIntentKind(value: string): value is HoldbackPayrollIntentKind {
  return value === "holdback_release" || value === "payroll_journal";
}

export function holdbackPayrollFailClosedRefusal(
  kind: HoldbackPayrollIntentKind,
): HoldbackPayrollFailClosedRefusal {
  return REFUSAL_BY_KIND[kind];
}

export function holdbackPayrollPostingTarget(): HoldbackPayrollPostingTarget {
  // Open question 2 in docs/ACCOUNTING-RECONCILIATION-CONTRACT.md is unanswered.
  // Do not guess JournalEntry vs external payroll handoff.
  return null;
}
