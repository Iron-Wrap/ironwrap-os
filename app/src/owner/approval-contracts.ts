import { z } from "zod";

const nullableText = z.string().min(1).nullable();

/**
 * The browser may prepare only a local lead-triage approval.  The Worker builds
 * the human-readable request and all broker-bound write data itself.
 */
export const leadTriageApprovalPreparationInputSchema = z
  .object({
    leadEnvelopeId: z.string().trim().min(1).max(140),
    triageSummary: z.string().trim().min(1).max(2_000),
  })
  .strict();

const approvalPreviewSchema = z
  .object({
    would_write: z.literal(false),
    target: z
      .object({
        doctype: z.literal("Lead Envelope"),
        name: z.string().min(1),
      })
      .strict(),
    before: z
      .object({
        triage_status: nullableText,
        triaged_by: nullableText,
        triaged_at: nullableText,
        triage_summary: nullableText,
      })
      .strict(),
    patch: z
      .object({
        triage_status: z.literal("Triaged"),
        triaged_by: z.string().min(1),
        triaged_at: nullableText,
        triage_summary: z.string().min(1),
      })
      .strict(),
    transport_status_unchanged: nullableText,
    communication_events_mutated: z.literal(false),
  })
  .strict();

const approvalOutcomeSchema = z
  .object({
    run_id: z.string().min(1),
    lead_envelope_id: z.string().min(1),
    updated: z.literal(true),
    audit_finalized: z.literal(true),
    replayed: z.boolean(),
    communication_events_mutated: z.literal(false),
  })
  .strict();

export const approvalRequestSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("lead_triage"),
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
    version: z.number().int().positive(),
    action: z.literal("mark_lead_triaged"),
    target: z
      .object({
        doctype: z.literal("Lead Envelope"),
        name: z.string().min(1),
        lead_envelope_id: z.string().min(1),
      })
      .strict(),
    request_text: z.string().min(1),
    preview: approvalPreviewSchema.nullable(),
    expires_at: z.string().min(1),
    requested_by: z
      .object({
        user_id: z.string().min(1),
        frappe_user: nullableText,
      })
      .strict(),
    approved_by: z
      .object({
        user_id: z.string().min(1),
        frappe_user: z.string().min(1),
        approved_at: z.string().min(1),
      })
      .strict()
      .nullable(),
    rejection_reason: nullableText,
    run_id: z.string().min(1),
    hermes_run_id: nullableText,
    outcome: approvalOutcomeSchema.nullable(),
    error_code: nullableText,
    reconciliation: z
      .object({
        at: z.string().min(1),
        by_user_id: z.string().min(1),
        by_frappe_user: z.string().min(1),
        outcome: z.enum(["executed", "not_executed", "inconclusive"]),
        evidence: z.string().min(1),
      })
      .strict()
      .nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    completed_at: nullableText,
  })
  .strict();

const approvalReadEnvelopeSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: z.string().min(1),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
  })
  .strict();

export const approvalListResponseSchema = approvalReadEnvelopeSchema
  .extend({
    approvals: z.array(approvalRequestSchema),
  })
  .strict();

export const approvalMutationResponseSchema = z
  .object({
    approval: approvalRequestSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;
export type ApprovalMutationResponse = z.infer<typeof approvalMutationResponseSchema>;
export type LeadTriageApprovalPreparationInput = z.infer<
  typeof leadTriageApprovalPreparationInputSchema
>;
