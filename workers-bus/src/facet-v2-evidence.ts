export type FacetV2EvidenceProjectionState =
  "awaiting_projection" | "projected" | "held" | "attention_required";

export interface FacetV2IntakeException {
  event_id: string;
  received_at: string;
  state: "awaiting_association" | "rejected";
  status_code: string;
  recovery: "automatic_reconciliation" | "governed_reissue_required";
}

type FacetV2ProjectionOutcome =
  | "projected_blank_draft"
  | "projected_terminal_hold"
  | "reconciled"
  | "rejected_frappe"
  | "uncertain"
  | "held_withdrawn"
  | "held_superseded";

export interface FacetV2WorkflowEvidence {
  event_id: string;
  tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  occurred_at: string;
  received_at: string;
  provenance: "customer_approved_v2";
  identity_assurance: "oidc";
  decision_kind: "approved" | "corrected" | "superseded" | "withdrawn";
  previous_event_id: string | null;
  roof_job_id: string;
  customer_quote_id: string;
  external_project_link_id: string;
  association_sha256: string;
  projection_state: FacetV2EvidenceProjectionState;
  status_code: string;
  projection: {
    outcome: FacetV2ProjectionOutcome;
    evidence_id: string | null;
    reconciliation_id: string | null;
    draft_customer_quote_id: string | null;
    draft_quote_version: number | null;
    error_code: string | null;
    attempted_at: string;
  } | null;
}

interface StoredFacetV2WorkflowEvidence {
  event_id: string;
  destination_tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  occurred_at: string;
  received_at: string;
  identity_assurance: "oidc";
  decision_kind: FacetV2WorkflowEvidence["decision_kind"];
  previous_event_id: string | null;
  roof_job_id: string;
  customer_quote_id: string;
  external_project_link_id: string;
  producer_identity_link_id: string;
  association_sha256: string;
  linked_external_project_link_id: string | null;
  linked_producer_identity_link_id: string | null;
  linked_destination_tenant_id: string | null;
  linked_source_tenant_id: string | null;
  linked_brand_id: string | null;
  linked_facet_project_id: string | null;
  linked_customer_party_ref: string | null;
  linked_external_customer_identity_link_id: string | null;
  linked_roof_job_id: string | null;
  linked_customer_quote_id: string | null;
  linked_association_sha256: string | null;
  source_tenant_id: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  revoked_link_count: number;
  projection_outcome: FacetV2ProjectionOutcome | null;
  evidence_id: string | null;
  reconciliation_id: string | null;
  draft_customer_quote_id: string | null;
  draft_quote_version: number | null;
  projection_error_code: string | null;
  attempted_at: string | null;
}

interface StoredFacetV2IntakeException {
  event_id: string;
  result: "accepted_unassociated" | "rejected";
  detail_code: string;
  received_at: string;
}

/**
 * Owner-visible Facet state comes only from the signed v2 decision chain and its immutable
 * projection receipts. Legacy bearer events and manual association tables are never queried.
 */
export async function listFacetV2WorkflowEvidence(
  env: Pick<Env, "DB">,
  tenantId: string,
  limit = 50,
): Promise<FacetV2WorkflowEvidence[]> {
  const result = await env.DB.prepare(
    `SELECT decision.event_id, decision.destination_tenant_id, decision.brand_id,
            decision.facet_project_id, decision.design_revision_id,
            decision.design_revision_sha256, decision.frozen_evidence_sha256,
            decision.occurred_at, decision.received_at, decision.identity_assurance,
            decision.decision_kind, decision.previous_event_id, decision.roof_job_id,
            decision.customer_quote_id, decision.external_project_link_id,
            decision.producer_identity_link_id, decision.association_sha256,
            decision.source_tenant_id, decision.customer_party_ref,
            decision.external_customer_identity_link_id,
            project.external_project_link_id AS linked_external_project_link_id,
            project.producer_identity_link_id AS linked_producer_identity_link_id,
            project.destination_tenant_id AS linked_destination_tenant_id,
            project.source_tenant_id AS linked_source_tenant_id,
            project.brand_id AS linked_brand_id,
            project.facet_project_id AS linked_facet_project_id,
            project.customer_party_ref AS linked_customer_party_ref,
            project.external_customer_identity_link_id AS linked_external_customer_identity_link_id,
            project.roof_job_id AS linked_roof_job_id,
            project.customer_quote_id AS linked_customer_quote_id,
            project.association_sha256 AS linked_association_sha256,
            (SELECT COUNT(*) FROM facet_v2_link_revocations AS revoked
              WHERE (revoked.link_kind = 'project'
                     AND revoked.link_id = decision.external_project_link_id)
                 OR (revoked.link_kind = 'producer_identity'
                     AND revoked.link_id = decision.producer_identity_link_id)
                 OR (revoked.link_kind = 'customer_identity'
                     AND revoked.link_id = decision.external_customer_identity_link_id))
              AS revoked_link_count,
            attempt.outcome AS projection_outcome, attempt.evidence_id,
            attempt.reconciliation_id, attempt.draft_customer_quote_id,
            attempt.draft_quote_version, attempt.error_code AS projection_error_code,
            attempt.attempted_at
       FROM facet_v2_customer_decisions AS decision
       LEFT JOIN facet_v2_project_links AS project
         ON project.external_project_link_id = decision.external_project_link_id
       LEFT JOIN facet_v2_projection_attempts AS attempt
         ON attempt.event_id = decision.event_id
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_projection_attempts AS later
          WHERE later.event_id = attempt.event_id
            AND (later.attempted_at > attempt.attempted_at
                 OR (later.attempted_at = attempt.attempted_at
                     AND later.attempt_id > attempt.attempt_id))
        )
       WHERE decision.destination_tenant_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM facet_v2_customer_decisions AS child
           WHERE child.previous_event_id = decision.event_id
         )
       ORDER BY decision.occurred_at DESC, decision.event_id DESC
       LIMIT ?`,
  )
    .bind(tenantId, Math.max(1, Math.min(100, limit)))
    .all<StoredFacetV2WorkflowEvidence>();
  return (result.results ?? []).map(workflowProjection);
}

/**
 * Lists only verified, signed-v2 deliveries that still need an association or were rejected by
 * lifecycle policy. Raw payloads, customer identity, hashes, nonces, and transport secrets stay
 * out of the owner read model. A later reconciled receipt removes the original hold from this list.
 */
export async function listFacetV2IntakeExceptions(
  env: Pick<Env, "DB">,
  tenantId: string,
  limit = 50,
): Promise<FacetV2IntakeException[]> {
  const result = await env.DB.prepare(
    `SELECT intake.event_id, intake.result, intake.detail_code, intake.received_at
       FROM facet_v2_raw_intakes AS intake
       WHERE intake.destination_tenant_id = ?
         AND intake.result IN ('accepted_unassociated', 'rejected')
         AND EXISTS (
           SELECT 1 FROM facet_v2_consumer_receipts AS signed
           WHERE signed.intake_id = intake.intake_id
             AND signed.event_id = intake.event_id
             AND signed.event_body_sha256 = intake.event_body_sha256
             AND signed.result = intake.result
             AND signed.detail_code = intake.detail_code
         )
         AND (
           intake.result = 'rejected'
           OR (
             NOT EXISTS (
               SELECT 1 FROM facet_v2_customer_decisions AS decision
               WHERE decision.event_id = intake.event_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM facet_v2_consumer_receipts AS reconciled
               WHERE reconciled.intake_id = intake.intake_id
                 AND reconciled.result IN ('accepted_associated', 'reconciled')
             )
           )
         )
       ORDER BY intake.received_at DESC, intake.intake_id DESC
       LIMIT ?`,
  )
    .bind(tenantId, Math.max(1, Math.min(100, limit)))
    .all<StoredFacetV2IntakeException>();
  return (result.results ?? []).map((row) => ({
    event_id: row.event_id,
    received_at: row.received_at,
    state:
      row.result === "accepted_unassociated"
        ? "awaiting_association"
        : "rejected",
    status_code: row.detail_code,
    recovery:
      row.result === "accepted_unassociated"
        ? "automatic_reconciliation"
        : "governed_reissue_required",
  }));
}

function workflowProjection(
  row: StoredFacetV2WorkflowEvidence,
): FacetV2WorkflowEvidence {
  const authorityMatches =
    Number(row.revoked_link_count) === 0 &&
    row.linked_external_project_link_id === row.external_project_link_id &&
    row.linked_producer_identity_link_id === row.producer_identity_link_id &&
    row.linked_destination_tenant_id === row.destination_tenant_id &&
    row.linked_source_tenant_id === row.source_tenant_id &&
    row.linked_brand_id === row.brand_id &&
    row.linked_facet_project_id === row.facet_project_id &&
    row.linked_customer_party_ref === row.customer_party_ref &&
    row.linked_external_customer_identity_link_id ===
      row.external_customer_identity_link_id &&
    row.linked_roof_job_id === row.roof_job_id &&
    row.linked_customer_quote_id === row.customer_quote_id &&
    row.linked_association_sha256 === row.association_sha256;
  const projection =
    row.projection_outcome && row.attempted_at
      ? {
          outcome: row.projection_outcome,
          evidence_id: row.evidence_id,
          reconciliation_id: row.reconciliation_id,
          draft_customer_quote_id: row.draft_customer_quote_id,
          draft_quote_version:
            row.draft_quote_version === null
              ? null
              : Number(row.draft_quote_version),
          error_code: row.projection_error_code,
          attempted_at: row.attempted_at,
        }
      : null;
  const [projectionState, statusCode] = evidenceState(
    row,
    projection,
    authorityMatches,
  );
  return {
    event_id: row.event_id,
    tenant_id: row.destination_tenant_id,
    brand_id: row.brand_id,
    facet_project_id: row.facet_project_id,
    design_revision_id: row.design_revision_id,
    design_revision_sha256: row.design_revision_sha256,
    frozen_evidence_sha256: row.frozen_evidence_sha256,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    provenance: "customer_approved_v2",
    identity_assurance: "oidc",
    decision_kind: row.decision_kind,
    previous_event_id: row.previous_event_id,
    roof_job_id: row.roof_job_id,
    customer_quote_id: row.customer_quote_id,
    external_project_link_id: row.external_project_link_id,
    association_sha256: row.association_sha256,
    projection_state: projectionState,
    status_code: statusCode,
    projection,
  };
}

function evidenceState(
  row: StoredFacetV2WorkflowEvidence,
  projection: FacetV2WorkflowEvidence["projection"],
  authorityMatches: boolean,
): [FacetV2EvidenceProjectionState, string] {
  if (!authorityMatches)
    return ["attention_required", "facet_v2_authority_drift"];
  if (!projection)
    return ["awaiting_projection", "awaiting_blank_draft_projection"];
  if (
    projection.outcome === "projected_terminal_hold" &&
    projection.evidence_id &&
    projection.reconciliation_id &&
    projection.draft_customer_quote_id &&
    Number.isSafeInteger(projection.draft_quote_version) &&
    Number(projection.draft_quote_version) > 0
  ) {
    return [
      "held",
      row.decision_kind === "withdrawn"
        ? "customer_withdrew_design"
        : "customer_superseded_design",
    ];
  }
  if (
    (projection.outcome === "projected_blank_draft" ||
      projection.outcome === "reconciled") &&
    projection.evidence_id &&
    projection.reconciliation_id &&
    projection.draft_customer_quote_id &&
    Number.isSafeInteger(projection.draft_quote_version) &&
    Number(projection.draft_quote_version) > 0
  )
    return ["projected", "blank_draft_projected"];
  if (projection.outcome === "uncertain")
    return [
      "attention_required",
      projection.error_code ?? "projection_uncertain",
    ];
  if (projection.outcome === "rejected_frappe")
    return [
      "attention_required",
      projection.error_code ?? "projection_rejected",
    ];
  return ["attention_required", "projection_receipt_inconsistent"];
}
