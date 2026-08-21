import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const identifier = boundedText(1, 180);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const projectionSchema = z
  .object({
    outcome: z.enum([
      "projected_native_design",
      "reconciled_native_design",
      "rejected",
      "uncertain",
      "held_withdrawn",
      "held_superseded",
    ]),
    projection_id: identifier.nullable(),
    projection_sha256: sha256.nullable(),
    source_quote_revision_id: identifier.nullable(),
    source_quote_version: z.number().int().positive().nullable(),
    source_proposal_revision_id: identifier.nullable(),
    source_publication_event_id: identifier.nullable(),
    source_acceptance_binding_id: identifier.nullable(),
    launch_intent_sha256: sha256.nullable(),
    design_sequence: z.number().int().positive().max(100).nullable(),
    design_state: z.enum(["active", "withdrawn", "superseded"]).nullable(),
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
    if (evidence.projection_state === "held" && !isLifecycleHold) {
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
        !["projected_native_design", "reconciled_native_design"].includes(
          evidence.projection.outcome,
        ) ||
        !hasCompleteNativeProjection(evidence.projection) ||
        evidence.projection.design_state !== "active")
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "Projected Facet evidence requires complete native design authority.",
      });
    }
    if (
      evidence.projection_state === "held" &&
      (!evidence.projection ||
        !hasCompleteNativeProjection(evidence.projection) ||
        evidence.projection.design_state !== evidence.decision_kind ||
        evidence.projection.outcome !== `held_${evidence.decision_kind}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message: "Held Facet evidence requires the matching native terminal state.",
      });
    }
  });

function hasCompleteNativeProjection(projection: z.infer<typeof projectionSchema>): boolean {
  return Boolean(
    projection.projection_id &&
    projection.projection_sha256 &&
    projection.source_quote_revision_id &&
    projection.source_quote_version &&
    projection.source_proposal_revision_id &&
    projection.source_publication_event_id &&
    projection.source_acceptance_binding_id &&
    projection.launch_intent_sha256 &&
    projection.design_sequence &&
    projection.design_state,
  );
}

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
