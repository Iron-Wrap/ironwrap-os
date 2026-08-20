import type { AuthenticatedSession } from "../auth/session";
import type {
  AccountingCommandResponse,
  AccountingExceptionListResponse,
  AccountingExceptionRow,
  AccountingIntentDetailResponse,
  AccountingIntentRow,
  AccountingSummaryResponse,
} from "./money-contracts";

// Shared money-desk fixtures (IRO-52 slice S9). Everything here is synthetic: a reserved
// `example.invalid` identity, a fake QuickBooks realm, and hashes that are obviously placeholders.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

export const ALL_ACCOUNTING_ACTIONS = [
  "accounting.read",
  "accounting.intent.approve",
  "accounting.intent.reject",
  "accounting.intent.reconcile",
  "accounting.intent.compensate",
  "accounting.exception.resolve",
];

export function accountingSession(
  role: "accounting" | "owner" | "ops" = "accounting",
): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: "appu_accounting",
      email: "accounting@example.invalid",
      display_name: "Accounting",
      role,
      frappe_user_id: null,
    },
    tenant: {
      id: "ironwrap",
      name: "IronWrap Exteriors",
      brand: "IronWrap Exteriors",
      locale: "en-CA",
      time_zone: "America/Edmonton",
      currency: "CAD",
    },
    permissions: [],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-08-19T10:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    stale_fields: [],
  } as AuthenticatedSession;
}

export function intentRow(overrides: Partial<AccountingIntentRow> = {}): AccountingIntentRow {
  return {
    intent_id: "acct-intent:job-0001:deposit_invoice",
    kind: "deposit_invoice",
    roof_job_id: "job-0001",
    customer_ref: "CUST-0001",
    currency: "CAD",
    total_amount: "1260.00",
    settled_amount: null,
    state: "pending_review",
    badge: "pending",
    next_step: "Check the amount against the approved paperwork, then approve or reject it.",
    version: 1,
    blocker_code: null,
    reason_code: null,
    derived_at: "2026-08-19T12:00:00.000Z",
    updated_at: "2026-08-19T12:00:00.000Z",
    age_seconds: 3600,
    compensates_intent_id: null,
    ...overrides,
  };
}

export function exceptionRow(
  overrides: Partial<AccountingExceptionRow> = {},
): AccountingExceptionRow {
  return {
    exception_id: "acct-exc-0001",
    intent_id: "acct-intent:job-0001:deposit_invoice",
    subject_ref: "accounting_intent:acct-intent:job-0001:deposit_invoice",
    reason_code: "provider_overpayment",
    status: "open",
    expected_sha256: SHA_A,
    observed_sha256: SHA_B,
    remedies: [
      { action: "void_provider_entity", alternatives: [] },
      { action: "credit_memo_issued", alternatives: ["refund_issued"] },
    ],
    detail: { observedSettled: "1500.00", invoiceTotal: "1260.00" },
    resolution_action: null,
    opened_at: "2026-08-19T12:10:00.000Z",
    updated_at: "2026-08-19T12:10:00.000Z",
    age_seconds: 7200,
    offered_remedies: ["void_provider_entity", "credit_memo_issued", "refund_issued"],
    ...overrides,
  };
}

export function summaryResponse(
  overrides: Partial<AccountingSummaryResponse> = {},
): AccountingSummaryResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: [...ALL_ACCOUNTING_ACTIONS],
    summary: {
      queues: {
        needs_approval: { count: 1, oldest_age_seconds: 3600 },
        awaiting_provider: { count: 0, oldest_age_seconds: null },
        mismatched: { count: 1, oldest_age_seconds: 7200 },
        exceptions: { count: 1, oldest_age_seconds: 7200 },
      },
      reconciliation_health: {
        open_exceptions: 1,
        acknowledged_exceptions: 0,
        oldest_open_exception_age_seconds: 7200,
        oldest_unreconciled_intent_id: "acct-intent:job-0001:deposit_invoice",
        oldest_unreconciled_age_seconds: 7200,
        stale_observation_count: 2,
        stale_after_seconds: 86_400,
        unobserved_intent_count: 1,
      },
    },
    queues: {
      needs_approval: [intentRow()],
      awaiting_provider: [],
      mismatched: [
        intentRow({
          intent_id: "acct-intent:job-0002:deposit_invoice",
          roof_job_id: "job-0002",
          state: "mismatch",
          badge: "mismatched",
          next_step:
            "QuickBooks does not agree with our figures. Open the detail and pick a remedy.",
          version: 4,
        }),
      ],
      exceptions: [exceptionRow()],
    },
    ...overrides,
  };
}

export function detailResponse(
  overrides: Partial<AccountingIntentDetailResponse> = {},
): AccountingIntentDetailResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: [...ALL_ACCOUNTING_ACTIONS],
    intent: intentRow(),
    basis: { roofJob: "job-0001", customerRef: "CUST-0001" },
    source_documents: [{ id: "quote-0001", version: 3 }],
    evidence: {
      basis_sha256: SHA_A,
      expected_sha256: SHA_A,
      observed_sha256: null,
      provider_payload_sha256: SHA_B,
      provider_request_id: "req-0001",
      provider: "quickbooks",
      realm_id: "4620816365000000000",
      provider_entity_type: "Invoice",
      provider_entity_id: null,
      tax_policy_snapshot_sha256: SHA_B,
      effect_id: null,
      compensates_effect_id: null,
      authority_permit_ref: "permit:accounting:money",
      authority_policy_ref: "policy:accounting:money.create",
      authority_policy_version: "v1",
      authority_max_amount: "5000.00",
      provider_submitted_at: null,
      provider_reconciled_at: null,
    },
    comparison: {
      expected_sha256: SHA_A,
      observed_sha256: null,
      verdict_observed_sha256: null,
      hashes_agree: false,
      awaiting_readback: true,
      fields: [
        { field: "realm_id", expected: "4620816365000000000", observed: null, agrees: false },
        { field: "provider_entity_id", expected: null, observed: null, agrees: true },
        { field: "total_amount", expected: "1260.00", observed: null, agrees: false },
      ],
      observed_facts: null,
      read_at: null,
      read_source: null,
    },
    events: [
      {
        event_seq: 1,
        intent_version: 1,
        event_type: "derived",
        state_from: null,
        state_to: "pending_review",
        actor_kind: "agent",
        actor_user_id: null,
        detail_code: null,
        occurred_at: "2026-08-19T12:00:00.000Z",
      },
    ],
    reconciliations: [],
    observations: [],
    tax_bindings: [
      {
        snapshot_id: "tax-snap:CA-AB:GST:v1",
        snapshot_sha256: SHA_B,
        jurisdiction: "CA-AB",
        tax_code: "GST",
        bound_at: "2026-08-19T12:00:00.000Z",
      },
    ],
    exceptions: [],
    ...overrides,
  };
}

/** A mismatched intent with a live over-payment exception, so a reversal is on offer. */
export function mismatchedDetail(): AccountingIntentDetailResponse {
  return detailResponse({
    intent: intentRow({
      state: "mismatch",
      badge: "mismatched",
      version: 4,
      next_step: "QuickBooks does not agree with our figures. Open the detail and pick a remedy.",
    }),
    comparison: {
      expected_sha256: SHA_A,
      observed_sha256: SHA_B,
      verdict_observed_sha256: SHA_B,
      hashes_agree: false,
      awaiting_readback: false,
      fields: [
        { field: "total_amount", expected: "1260.00", observed: "1500.00", agrees: false },
        {
          field: "provider_entity_id",
          expected: "2001",
          observed: "2001",
          agrees: true,
        },
      ],
      observed_facts: { TotalAmt: 1500 },
      read_at: "2026-08-19T12:10:00.000Z",
      read_source: "sweep",
    },
    exceptions: [exceptionRow()],
  });
}

export function commandResponse(
  overrides: Partial<AccountingCommandResponse> = {},
): AccountingCommandResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: [...ALL_ACCOUNTING_ACTIONS],
    intent: intentRow({ state: "submission_pending", badge: "in_flight", version: 2 }),
    replayed: false,
    ...overrides,
  };
}

export function exceptionListResponse(
  exceptions: AccountingExceptionRow[] = [exceptionRow()],
): AccountingExceptionListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: [...ALL_ACCOUNTING_ACTIONS],
    exceptions,
  };
}
