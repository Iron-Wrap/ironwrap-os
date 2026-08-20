import { z } from "zod";

// The browser's half of the money desk contract (IRO-52 slice S9).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2. Every envelope the bus emits under
// `/api/v1/accounting/` is parsed here before a screen sees it, so a server that changed shape
// fails loudly at the boundary rather than rendering `undefined` where an amount should be.
//
// Two rules the schemas encode rather than document:
//
//  1. **The badge is the server's.** `badge` and `next_step` arrive on the wire, derived from the
//     intent's own state by `accounting-desk.ts`. The browser never re-derives them, because a
//     second mapping is a second thing to drift.
//  2. **Nothing here declares a tenant id or a provider payload body.** Both are absent from the
//     envelopes on purpose (section 6); the bus asserts they never appear on the wire, and no
//     schema here has a field for them, so no screen can render one even if one arrived.

export const accountingBadges = [
  "pending",
  "in_flight",
  "uncertain",
  "mismatched",
  "compensated",
  "reconciled",
  "rejected",
  "failed",
] as const;

export type AccountingBadge = (typeof accountingBadges)[number];

export const accountingIntentKinds = [
  "deposit_invoice",
  "progress_invoice",
  "payment",
  "credit_memo",
  "refund",
  "holdback_release",
  "tax_remittance_proposal",
  "payroll_journal",
] as const;

export type AccountingIntentKind = (typeof accountingIntentKinds)[number];

export const accountingRejectionReasons = [
  "amount_disputed",
  "paperwork_missing",
  "customer_mapping_missing",
  "item_mapping_missing",
  "tax_mapping_missing",
  "terms_mapping_missing",
  "superseded_by_new_figures",
  "not_owed",
] as const;

export type AccountingRejectionReason = (typeof accountingRejectionReasons)[number];

export const accountingRemedies = [
  "void_provider_entity",
  "credit_memo_issued",
  "refund_issued",
  "adjusting_entry_posted",
  "accepted_as_posted",
  "superseded_by_new_intent",
] as const;

export type AccountingRemedy = (typeof accountingRemedies)[number];

export const accountingQueues = [
  "needs_approval",
  "awaiting_provider",
  "mismatched",
  "exceptions",
] as const;

export type AccountingQueue = (typeof accountingQueues)[number];

/** Server-minted, path-safe, and never composed in the browser. */
export const accountingIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const decimalSchema = z.string().regex(/^-?\d+\.\d{2}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const accountingIntentRowSchema = z.object({
  intent_id: z.string(),
  kind: z.enum(accountingIntentKinds),
  roof_job_id: z.string(),
  customer_ref: z.string().nullable(),
  currency: z.string(),
  total_amount: decimalSchema,
  settled_amount: decimalSchema.nullable(),
  state: z.string(),
  badge: z.enum(accountingBadges),
  next_step: z.string(),
  version: z.number().int().positive(),
  blocker_code: z.string().nullable(),
  reason_code: z.string().nullable(),
  derived_at: z.string(),
  updated_at: z.string(),
  age_seconds: z.number().int().nonnegative(),
  compensates_intent_id: z.string().nullable(),
});

export type AccountingIntentRow = z.infer<typeof accountingIntentRowSchema>;

export const accountingExceptionRowSchema = z.object({
  exception_id: z.string(),
  intent_id: z.string().nullable(),
  subject_ref: z.string(),
  reason_code: z.string(),
  status: z.enum(["open", "acknowledged", "resolved"]),
  expected_sha256: sha256Schema.nullable(),
  observed_sha256: sha256Schema.nullable(),
  remedies: z.unknown(),
  detail: z.record(z.string(), z.unknown()),
  resolution_action: z.string().nullable(),
  opened_at: z.string(),
  updated_at: z.string(),
  age_seconds: z.number().int().nonnegative(),
  offered_remedies: z.array(z.enum(accountingRemedies)).optional(),
});

export type AccountingExceptionRow = z.infer<typeof accountingExceptionRowSchema>;

const queueCountSchema = z.object({
  count: z.number().int().nonnegative(),
  oldest_age_seconds: z.number().int().nonnegative().nullable(),
});

export const reconciliationHealthSchema = z.object({
  open_exceptions: z.number().int().nonnegative(),
  acknowledged_exceptions: z.number().int().nonnegative(),
  oldest_open_exception_age_seconds: z.number().int().nonnegative().nullable(),
  oldest_unreconciled_intent_id: z.string().nullable(),
  oldest_unreconciled_age_seconds: z.number().int().nonnegative().nullable(),
  stale_observation_count: z.number().int().nonnegative(),
  stale_after_seconds: z.number().int().positive(),
  unobserved_intent_count: z.number().int().nonnegative(),
});

export type ReconciliationHealth = z.infer<typeof reconciliationHealthSchema>;

const envelopeSchema = z.object({
  version: z.number().int().positive(),
  read_model_generated_at: z.string(),
  allowed_actions: z.array(z.string()),
});

export const accountingSummaryResponseSchema = envelopeSchema.extend({
  summary: z.object({
    queues: z.object({
      needs_approval: queueCountSchema,
      awaiting_provider: queueCountSchema,
      mismatched: queueCountSchema,
      exceptions: queueCountSchema,
    }),
    reconciliation_health: reconciliationHealthSchema,
  }),
  queues: z.object({
    needs_approval: z.array(accountingIntentRowSchema),
    awaiting_provider: z.array(accountingIntentRowSchema),
    mismatched: z.array(accountingIntentRowSchema),
    exceptions: z.array(accountingExceptionRowSchema),
  }),
});

export type AccountingSummaryResponse = z.infer<typeof accountingSummaryResponseSchema>;

export const accountingIntentListResponseSchema = envelopeSchema.extend({
  intents: z.array(accountingIntentRowSchema),
});

export type AccountingIntentListResponse = z.infer<typeof accountingIntentListResponseSchema>;

export const accountingComparisonSchema = z.object({
  expected_sha256: sha256Schema,
  observed_sha256: sha256Schema.nullable(),
  verdict_observed_sha256: sha256Schema.nullable(),
  hashes_agree: z.boolean(),
  awaiting_readback: z.boolean(),
  fields: z.array(
    z.object({
      field: z.string(),
      expected: z.unknown(),
      observed: z.unknown(),
      agrees: z.boolean(),
    }),
  ),
  observed_facts: z.unknown(),
  read_at: z.string().nullable(),
  read_source: z.string().nullable(),
});

export type AccountingComparison = z.infer<typeof accountingComparisonSchema>;

export const accountingIntentDetailResponseSchema = envelopeSchema.extend({
  intent: accountingIntentRowSchema,
  basis: z.unknown(),
  source_documents: z.unknown(),
  evidence: z.object({
    basis_sha256: sha256Schema,
    expected_sha256: sha256Schema,
    observed_sha256: sha256Schema.nullable(),
    provider_payload_sha256: sha256Schema,
    provider_request_id: z.string(),
    provider: z.string(),
    realm_id: z.string(),
    provider_entity_type: z.string().nullable(),
    provider_entity_id: z.string().nullable(),
    tax_policy_snapshot_sha256: sha256Schema.nullable(),
    effect_id: z.string().nullable(),
    compensates_effect_id: z.string().nullable(),
    authority_permit_ref: z.string(),
    authority_policy_ref: z.string(),
    authority_policy_version: z.string(),
    authority_max_amount: decimalSchema,
    provider_submitted_at: z.string().nullable(),
    provider_reconciled_at: z.string().nullable(),
  }),
  comparison: accountingComparisonSchema,
  events: z.array(
    z.object({
      event_seq: z.number().int(),
      intent_version: z.number().int(),
      event_type: z.string(),
      state_from: z.string().nullable(),
      state_to: z.string(),
      actor_kind: z.string(),
      actor_user_id: z.string().nullable(),
      detail_code: z.string().nullable(),
      occurred_at: z.string(),
    }),
  ),
  reconciliations: z.array(
    z.object({
      reconciliation_id: z.string(),
      verdict: z.string(),
      reason_code: z.string().nullable(),
      settled_amount: decimalSchema.nullable(),
      expected_sha256: sha256Schema,
      observed_sha256: sha256Schema.nullable(),
      decided_at: z.string(),
    }),
  ),
  observations: z.array(
    z.object({
      observation_id: z.string(),
      entity_type: z.string(),
      entity_id: z.string(),
      observed_sha256: sha256Schema,
      total_amount_cents: z.number().int().nullable(),
      balance_cents: z.number().int().nullable(),
      read_at: z.string(),
      source: z.string(),
    }),
  ),
  tax_bindings: z.array(
    z.object({
      snapshot_id: z.string(),
      snapshot_sha256: sha256Schema,
      jurisdiction: z.string(),
      tax_code: z.string(),
      bound_at: z.string(),
    }),
  ),
  exceptions: z.array(accountingExceptionRowSchema),
});

export type AccountingIntentDetailResponse = z.infer<typeof accountingIntentDetailResponseSchema>;

export const accountingExceptionListResponseSchema = envelopeSchema.extend({
  exceptions: z.array(accountingExceptionRowSchema),
});

export type AccountingExceptionListResponse = z.infer<typeof accountingExceptionListResponseSchema>;

export const compensationPlanSchema = z.object({
  intentId: z.string(),
  exceptionId: z.string(),
  reasonCode: z.string(),
  remedy: z.enum(accountingRemedies),
  reversalKind: z.enum(["credit_memo", "refund"]),
  providerEntityType: z.enum(["CreditMemo", "RefundReceipt"]),
  totalAmount: decimalSchema,
  magnitudeAmount: decimalSchema,
  basis: z.object({
    originalTotal: decimalSchema,
    observedSettled: decimalSchema.nullable(),
    surplus: decimalSchema.nullable(),
  }),
});

export type CompensationPlan = z.infer<typeof compensationPlanSchema>;

export const accountingCommandResponseSchema = envelopeSchema.extend({
  intent: accountingIntentRowSchema,
  replayed: z.boolean(),
  compensation_plan: compensationPlanSchema.optional(),
});

export type AccountingCommandResponse = z.infer<typeof accountingCommandResponseSchema>;

export const accountingExceptionResolveResponseSchema = envelopeSchema.extend({
  exception: accountingExceptionRowSchema,
});

export type AccountingExceptionResolveResponse = z.infer<
  typeof accountingExceptionResolveResponseSchema
>;

/**
 * The badge's own label and tone.
 *
 * The sentence a user acts on comes from the server as `next_step`; this is only how the badge
 * looks. Keeping the wording server-side is what stops the screen and the aggregate drifting.
 */
export const badgePresentation: Record<AccountingBadge, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "border-warning/40 bg-warning-soft text-warning" },
  in_flight: { label: "In flight", tone: "border-info/40 bg-info-soft text-info" },
  uncertain: { label: "Uncertain", tone: "border-warning/40 bg-warning-soft text-warning" },
  mismatched: { label: "Mismatched", tone: "border-danger/40 bg-danger-soft text-danger" },
  compensated: { label: "Compensated", tone: "border-info/40 bg-info-soft text-info" },
  reconciled: { label: "Reconciled", tone: "border-ok/40 bg-ok-soft text-ok" },
  rejected: { label: "Not approved", tone: "border-border bg-surface-muted text-muted" },
  failed: { label: "Failed", tone: "border-danger/40 bg-danger-soft text-danger" },
};

const kindLabels: Record<AccountingIntentKind, string> = {
  deposit_invoice: "Deposit invoice",
  progress_invoice: "Progress invoice",
  payment: "Payment",
  credit_memo: "Credit memo",
  refund: "Refund",
  holdback_release: "Holdback release",
  tax_remittance_proposal: "Tax remittance",
  payroll_journal: "Payroll posting",
};

export function kindLabel(kind: AccountingIntentKind): string {
  return kindLabels[kind];
}

const remedyLabels: Record<AccountingRemedy, string> = {
  // Never "delete". Reversal is always a provider-supported entity (section 8.2).
  void_provider_entity: "Void it in QuickBooks",
  credit_memo_issued: "Issue a credit memo",
  refund_issued: "Issue a refund",
  adjusting_entry_posted: "Post an adjusting entry",
  accepted_as_posted: "Accept what QuickBooks holds",
  superseded_by_new_intent: "Replace it with new figures",
};

export function remedyLabel(remedy: AccountingRemedy): string {
  return remedyLabels[remedy];
}

const reasonLabels: Record<string, string> = {
  duplicate_provider_entity: "QuickBooks holds a duplicate of this",
  duplicate_provider_payment: "Two payments landed against one invoice",
  provider_overpayment: "More was paid than was invoiced",
  provider_identity_conflict: "We cannot prove this entity is ours",
  provider_entity_not_found: "QuickBooks has no record of this",
  provider_readback_drift: "QuickBooks changed after we matched it",
  expected_observed_mismatch: "QuickBooks does not match our figures",
  settlement_invariant_violated: "The amounts do not add up",
  unknown_effect_deadline_expired: "We never learned whether this reached QuickBooks",
  tax_rate_drift: "QuickBooks is using a different tax rate",
  holdback_over_released: "More holdback was released than was withheld",
  payroll_posting_mismatch: "The payroll posting does not match the approved run",
};

/** A reason code in words. Falls back to the code so an unseen one is legible, never blank. */
export function reasonLabel(reasonCode: string): string {
  return reasonLabels[reasonCode] ?? reasonCode.replace(/_/gu, " ");
}

/** A whole-second age as something a person reads at a glance on a phone. */
export function ageLabel(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** An amount as the office manager's own currency, with the sign a reversal really carries. */
export function amountLabel(amount: string, currency: string): string {
  const negative = amount.startsWith("-");
  const magnitude = negative ? amount.slice(1) : amount;
  return `${negative ? "−" : ""}${currency} ${magnitude}`;
}
