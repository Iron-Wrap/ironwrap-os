import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const nullableText = (min: number, max: number) => boundedText(min, max).nullable();
const identifier = boundedText(1, 140);
const positiveVersion = z.number().int().positive();

/**
 * Publication makes the reviewed proposal visible on an already-issued customer
 * link. It is deliberately narrow: no message, no new link, no signature, no
 * quote or accounting change. The contract states each of those as a literal so
 * a widened server response fails the browser boundary rather than the reader.
 */
const noCustomerEffectsSchema = z
  .object({
    customer_delivery_mutated: z.literal(false),
    contract_acceptance_mutated: z.literal(false),
    customer_quote_mutated: z.literal(false),
  })
  .strict();

const targetPackSchema = z
  .object({
    doctype: z.literal("Proposal Evidence Pack"),
    proposal_evidence_pack_id: identifier,
  })
  .strict();

const proposalPublicationPreviewSchema = z
  .object({
    would_write: z.literal(false),
    target: targetPackSchema,
    before: z
      .object({
        proposal_evidence_pack_id: identifier,
        roof_job: identifier,
        quotation: identifier,
        status: boundedText(1, 80),
      })
      .strict(),
    publication: z.object({ status: z.literal("Approved") }).strict(),
    customer_portal: z
      .object({
        visible_after_publication: z.literal(true),
        portal_link_issued: z.literal(false),
        human_portal_link_issuance_required: z.literal(true),
      })
      .strict(),
    effects: noCustomerEffectsSchema,
  })
  .strict();

const proposalPublicationOutcomeSchema = z
  .object({
    run_id: boundedText(8, 256),
    published: z.literal(true),
    proposal_evidence_pack_id: identifier,
    customer_quote_id: identifier,
    status: z.literal("Approved"),
    audit_finalized: z.literal(true),
    customer_portal_link_issued: z.literal(false),
    ...noCustomerEffectsSchema.shape,
  })
  .strict();

const publicationReadEnvelopeSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: boundedText(1, 80),
    permissions: z.array(boundedText(1, 100)).max(100),
    allowed_actions: z
      .array(
        z.enum([
          "proposal_publication_approval.read",
          "proposal_publication_approval.prepare",
          "proposal_publication_approval.approve",
          "proposal_publication_approval.reject",
          "proposal_publication_approval.reconcile",
        ]),
      )
      .max(5),
  })
  .strict();

export const proposalPublicationPreparationInputSchema = z
  .object({
    roofJobId: identifier,
    proposalEvidencePackId: identifier,
  })
  .strict();

export const proposalPublicationApprovalRequestSchema = z
  .object({
    id: boundedText(1, 180),
    kind: z.literal("proposal_publication"),
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
    action: z.literal("publish_proposal_evidence_pack"),
    roof_job_id: identifier,
    proposal_evidence_pack_id: identifier,
    customer_quote_id: identifier,
    target: targetPackSchema,
    pack_status_before: boundedText(1, 80),
    request_text: boundedText(1, 4_000),
    preview: proposalPublicationPreviewSchema.nullable(),
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
    outcome: proposalPublicationOutcomeSchema.nullable(),
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
      target,
      proposal_evidence_pack_id: packId,
      customer_quote_id: quoteId,
      roof_job_id: roofJobId,
      pack_status_before: packStatusBefore,
      run_id: runId,
    } = approval;
    if (target.proposal_evidence_pack_id !== packId) {
      context.addIssue({
        code: "custom",
        message: "Publication target does not match its approval request.",
        path: ["target"],
      });
    }
    if (
      preview &&
      (preview.target.proposal_evidence_pack_id !== packId ||
        preview.before.proposal_evidence_pack_id !== packId ||
        preview.before.roof_job !== roofJobId ||
        preview.before.quotation !== quoteId ||
        preview.before.status !== packStatusBefore)
    ) {
      context.addIssue({
        code: "custom",
        message: "Publication preview does not match its approval request.",
        path: ["preview"],
      });
    }
    if (
      outcome &&
      (outcome.run_id !== runId ||
        outcome.proposal_evidence_pack_id !== packId ||
        outcome.customer_quote_id !== quoteId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Publication outcome does not match its approval request.",
        path: ["outcome"],
      });
    }
  });

export const proposalPublicationApprovalListResponseSchema = publicationReadEnvelopeSchema
  .extend({
    approvals: z.array(proposalPublicationApprovalRequestSchema),
  })
  .strict();

export const proposalPublicationApprovalDetailResponseSchema = publicationReadEnvelopeSchema
  .extend({
    approval: proposalPublicationApprovalRequestSchema,
  })
  .strict();

export const proposalPublicationApprovalMutationResponseSchema = z
  .object({
    approval: proposalPublicationApprovalRequestSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export type ProposalPublicationPreparationInput = z.infer<
  typeof proposalPublicationPreparationInputSchema
>;
export type ProposalPublicationApprovalRequest = z.infer<
  typeof proposalPublicationApprovalRequestSchema
>;
export type ProposalPublicationApprovalListResponse = z.infer<
  typeof proposalPublicationApprovalListResponseSchema
>;
export type ProposalPublicationApprovalDetailResponse = z.infer<
  typeof proposalPublicationApprovalDetailResponseSchema
>;
export type ProposalPublicationApprovalMutationResponse = z.infer<
  typeof proposalPublicationApprovalMutationResponseSchema
>;
