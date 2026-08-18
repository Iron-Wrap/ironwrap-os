import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const identifier = boundedText(1, 180);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const projectionSchema = z
  .object({
    outcome: z.enum([
      "projected_blank_draft",
      "reconciled",
      "rejected_frappe",
      "uncertain",
      "held_withdrawn",
      "held_superseded",
    ]),
    evidence_id: identifier.nullable(),
    reconciliation_id: identifier.nullable(),
    draft_customer_quote_id: identifier.nullable(),
    draft_quote_version: z.number().int().positive().nullable(),
    error_code: boundedText(1, 180).nullable(),
    attempted_at: boundedText(1, 80),
  })
  .strict();

export const facetDesignIntakeExceptionSchema = z
  .object({
    event_id: identifier,
    received_at: boundedText(1, 80),
    state: z.enum(["awaiting_association", "rejected"]),
    status_code: boundedText(1, 180),
    recovery: z.enum(["automatic_reconciliation", "governed_reissue_required"]),
  })
  .strict()
  .superRefine((exception, context) => {
    if (
      (exception.state === "awaiting_association") !==
      (exception.recovery === "automatic_reconciliation")
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Facet intake state and recovery contract disagree.",
      });
    }
  });

export const facetDesignEvidenceSchema = z
  .object({
    event_id: identifier,
    tenant_id: boundedText(1, 64),
    brand_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
    facet_project_id: identifier,
    design_revision_id: identifier,
    design_revision_sha256: sha256,
    frozen_evidence_sha256: sha256,
    occurred_at: boundedText(1, 80),
    received_at: boundedText(1, 80),
    provenance: z.literal("customer_approved_v2"),
    identity_assurance: z.literal("oidc"),
    decision_kind: z.enum(["approved", "corrected", "superseded", "withdrawn"]),
    previous_event_id: identifier.nullable(),
    roof_job_id: identifier,
    customer_quote_id: identifier,
    external_project_link_id: z.string().regex(/^ironwrap-project-v1:[0-9a-f]{64}$/),
    association_sha256: sha256,
    projection_state: z.enum(["awaiting_projection", "projected", "held", "attention_required"]),
    status_code: boundedText(1, 180),
    projection: projectionSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const isLifecycleHold =
      evidence.decision_kind === "withdrawn" || evidence.decision_kind === "superseded";
    if (isLifecycleHold !== (evidence.projection_state === "held")) {
      context.addIssue({
        code: "custom",
        path: ["projection_state"],
        message: "Facet decision lifecycle and projection hold disagree.",
      });
    }
    if (evidence.projection_state === "awaiting_projection" && evidence.projection !== null) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "Awaiting projection cannot carry a projection receipt.",
      });
    }
    if (
      evidence.projection_state === "projected" &&
      (!evidence.projection ||
        !["projected_blank_draft", "reconciled"].includes(evidence.projection.outcome) ||
        !evidence.projection.evidence_id ||
        !evidence.projection.reconciliation_id ||
        !evidence.projection.draft_customer_quote_id ||
        !evidence.projection.draft_quote_version)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "Projected Facet evidence requires a complete blank Draft receipt.",
      });
    }
  });

export const facetDesignEvidenceResponseSchema = z
  .object({
    version: z.literal(2),
    read_model_generated_at: boundedText(1, 80),
    permissions: z.array(boundedText(1, 100)).max(64),
    allowed_actions: z.array(z.literal("facet_design.read")).max(1),
    evidence: z.array(facetDesignEvidenceSchema).max(100),
    intake_exceptions: z.array(facetDesignIntakeExceptionSchema).max(100),
  })
  .strict();

export type FacetDesignEvidence = z.infer<typeof facetDesignEvidenceSchema>;
export type FacetDesignIntakeException = z.infer<typeof facetDesignIntakeExceptionSchema>;
export type FacetDesignEvidenceResponse = z.infer<typeof facetDesignEvidenceResponseSchema>;
