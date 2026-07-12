import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const nullableText = (min: number, max: number) => boundedText(min, max).nullable();
const identifier = boundedText(1, 140);
const positiveVersion = z.number().int().positive();

const noCommercialEffectsSchema = z
  .object({
    customer_notified: z.literal(false),
    commercial_terms_copied: z.literal(false),
    proposal_sent: z.literal(false),
    accounting_mutated: z.literal(false),
  })
  .strict();

const sourceQuoteSchema = z
  .object({
    customer_quote_id: identifier,
    quote_version: positiveVersion,
    status: boundedText(1, 32),
    modified: boundedText(1, 80),
  })
  .strict();

const targetQuoteSchema = z
  .object({
    doctype: z.literal("Customer Quote"),
    customer_quote_id: identifier,
    quote_version: positiveVersion,
  })
  .strict();

const quoteRevisionApprovalPreviewSchema = z
  .object({
    would_write: z.literal(false),
    append_only: z.literal(true),
    target: targetQuoteSchema,
    source: sourceQuoteSchema,
    draft: z
      .object({
        customer_quote_id: identifier,
        quote_version: positiveVersion,
        status: z.literal("Draft"),
        supersedes: identifier,
        correction_reason: boundedText(1, 2_000),
      })
      .strict(),
    observed_quote_count: z.number().int().nonnegative().nullable(),
    effects: noCommercialEffectsSchema,
  })
  .strict();

const quoteRevisionApprovalOutcomeSchema = z
  .object({
    run_id: boundedText(8, 256),
    created: z.literal(true),
    customer_quote_id: identifier,
    quote_version: positiveVersion,
    supersedes: identifier,
    audit_finalized: z.literal(true),
    ...noCommercialEffectsSchema.shape,
  })
  .strict();

const approvalReadEnvelopeSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: boundedText(1, 80),
    permissions: z.array(boundedText(1, 100)).max(100),
    allowed_actions: z
      .array(
        z.enum([
          "quote_revision_approval.read",
          "quote_revision_approval.prepare",
          "quote_revision_approval.approve",
          "quote_revision_approval.reject",
          "quote_revision_approval.reconcile",
        ]),
      )
      .max(5),
  })
  .strict();

export const quoteRevisionApprovalPreparationInputSchema = z
  .object({
    roofJobId: identifier,
    customerQuoteId: identifier,
    correctionReason: boundedText(1, 2_000),
  })
  .strict();

export const quoteRevisionApprovalRequestSchema = z
  .object({
    id: boundedText(1, 180),
    kind: z.literal("quote_revision"),
    state: z.enum([
      "pending",
      "executing",
      "executed",
      "denied",
      "expired",
      "failed",
      "audit_failed",
      "execution_uncertain",
    ]),
    version: positiveVersion,
    action: z.literal("create_quote_revision_draft"),
    roof_job_id: identifier,
    source: sourceQuoteSchema,
    target: targetQuoteSchema,
    correction_reason: boundedText(1, 2_000),
    request_text: boundedText(1, 4_000),
    preview: quoteRevisionApprovalPreviewSchema.nullable(),
    expires_at: boundedText(1, 80),
    requested_by: z
      .object({
        user_id: boundedText(1, 140),
        frappe_user: nullableText(1, 256),
      })
      .strict(),
    approved_by: z
      .object({
        user_id: boundedText(1, 140),
        frappe_user: boundedText(1, 256),
        approved_at: boundedText(1, 80),
      })
      .strict()
      .nullable(),
    rejection_reason: nullableText(3, 1_000),
    run_id: boundedText(8, 256),
    hermes_run_id: nullableText(1, 256),
    outcome: quoteRevisionApprovalOutcomeSchema.nullable(),
    error_code: nullableText(1, 160),
    reconciliation: z
      .object({
        at: boundedText(1, 80),
        by_user_id: boundedText(1, 140),
        by_frappe_user: boundedText(1, 256),
        outcome: z.enum(["executed", "not_executed", "inconclusive"]),
        evidence: boundedText(3, 1_000),
      })
      .strict()
      .nullable(),
    created_at: boundedText(1, 80),
    updated_at: boundedText(1, 80),
    completed_at: nullableText(1, 80),
  })
  .strict()
  .superRefine((approval, context) => {
    const {
      preview,
      outcome,
      source,
      target,
      correction_reason: correctionReason,
      run_id: runId,
    } = approval;
    if (preview) {
      if (
        preview.target.customer_quote_id !== target.customer_quote_id ||
        preview.target.quote_version !== target.quote_version ||
        preview.source.customer_quote_id !== source.customer_quote_id ||
        preview.source.quote_version !== source.quote_version ||
        preview.source.status !== source.status ||
        preview.source.modified !== source.modified ||
        preview.draft.customer_quote_id !== target.customer_quote_id ||
        preview.draft.quote_version !== target.quote_version ||
        preview.draft.supersedes !== source.customer_quote_id ||
        preview.draft.correction_reason !== correctionReason
      ) {
        context.addIssue({
          code: "custom",
          message: "Quote revision preview does not match its approval request.",
          path: ["preview"],
        });
      }
    }
    if (
      outcome &&
      (outcome.run_id !== runId ||
        outcome.customer_quote_id !== target.customer_quote_id ||
        outcome.quote_version !== target.quote_version ||
        outcome.supersedes !== source.customer_quote_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Quote revision outcome does not match its approval request.",
        path: ["outcome"],
      });
    }
  });

export const quoteRevisionApprovalListResponseSchema = approvalReadEnvelopeSchema
  .extend({
    approvals: z.array(quoteRevisionApprovalRequestSchema),
  })
  .strict();

export const quoteRevisionApprovalDetailResponseSchema = approvalReadEnvelopeSchema
  .extend({
    approval: quoteRevisionApprovalRequestSchema,
  })
  .strict();

export const quoteRevisionApprovalMutationResponseSchema = z
  .object({
    approval: quoteRevisionApprovalRequestSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export type QuoteRevisionApprovalPreparationInput = z.infer<
  typeof quoteRevisionApprovalPreparationInputSchema
>;
export type QuoteRevisionApprovalRequest = z.infer<typeof quoteRevisionApprovalRequestSchema>;
export type QuoteRevisionApprovalListResponse = z.infer<
  typeof quoteRevisionApprovalListResponseSchema
>;
export type QuoteRevisionApprovalDetailResponse = z.infer<
  typeof quoteRevisionApprovalDetailResponseSchema
>;
export type QuoteRevisionApprovalMutationResponse = z.infer<
  typeof quoteRevisionApprovalMutationResponseSchema
>;
