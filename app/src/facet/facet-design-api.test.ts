import { describe, expect, it, vi } from "vitest";

import { loadFacetDesignEvidence } from "./facet-design-api";
import {
  facetDesignEvidenceResponseSchema,
  type FacetDesignEvidence,
} from "./facet-design-contracts";

const sha = "a".repeat(64);

export const projectedEvidence = {
  event_id: "facet-event-1",
  tenant_id: "ironwrap",
  brand_id: "ironwrap-exteriors",
  facet_project_id: "facet-project-1",
  design_revision_id: `facet-json-v1:${sha}`,
  design_revision_sha256: sha,
  frozen_evidence_sha256: "b".repeat(64),
  occurred_at: "2026-08-13T10:00:00.000Z",
  received_at: "2026-08-13T10:01:00.000Z",
  provenance: "customer_approved_v2",
  identity_assurance: "oidc",
  decision_kind: "approved",
  previous_event_id: null,
  roof_job_id: "ROOF-JOB-1",
  customer_quote_id: "QUOTE-1",
  external_project_link_id: `ironwrap-project-v1:${"c".repeat(64)}`,
  association_sha256: "d".repeat(64),
  projection_state: "projected",
  status_code: "blank_draft_projected",
  projection: {
    outcome: "projected_blank_draft",
    evidence_id: "facet-design:evidence-1",
    reconciliation_id: "facet-design-projection:receipt-1",
    draft_customer_quote_id: "facet-quote-revision:draft-1",
    draft_quote_version: 3,
    error_code: null,
    attempted_at: "2026-08-13T10:02:00.000Z",
  },
} satisfies FacetDesignEvidence;

function response(evidence: unknown = projectedEvidence) {
  return {
    version: 2,
    read_model_generated_at: "2026-08-13T12:00:00.000Z",
    permissions: ["facet:read"],
    allowed_actions: ["facet_design.read"],
    evidence: [evidence],
    intake_exceptions: [],
  };
}

describe("Facet design API", () => {
  it("loads only the signed-v2 evidence and projection read model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));

    const model = await loadFacetDesignEvidence(fetcher);

    expect(model.evidence[0]).toEqual(projectedEvidence);
    expect(model.allowed_actions).toEqual(["facet_design.read"]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/facet-design-evidence");
    expect(fetcher.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("rejects the legacy bearer-capability response instead of rendering it as v2", async () => {
    const legacy = {
      ...projectedEvidence,
      provenance: "customer_approved",
      identity_assurance: "bearer_capability_only",
      association_state: "associated",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...response(legacy), version: 1 }));

    await expect(loadFacetDesignEvidence(fetcher)).rejects.toThrow();
  });

  it("rejects a projected claim without complete blank Draft receipt anchors", () => {
    expect(() =>
      facetDesignEvidenceResponseSchema.parse(
        response({
          ...projectedEvidence,
          projection: { ...projectedEvidence.projection, reconciliation_id: null },
        }),
      ),
    ).toThrow();
  });

  it("accepts only fail-closed signed-v2 intake recovery states", () => {
    expect(
      facetDesignEvidenceResponseSchema.parse({
        ...response(),
        intake_exceptions: [
          {
            event_id: "facet-event-unassociated",
            received_at: "2026-08-13T10:03:00.000Z",
            state: "awaiting_association",
            status_code: "awaiting_exact_project_identity_association",
            recovery: "automatic_reconciliation",
          },
          {
            event_id: "facet-event-rejected",
            received_at: "2026-08-13T10:04:00.000Z",
            state: "rejected",
            status_code: "decision_customer_identity_mismatch",
            recovery: "governed_reissue_required",
          },
        ],
      }).intake_exceptions,
    ).toHaveLength(2);
    expect(() =>
      facetDesignEvidenceResponseSchema.parse({
        ...response(),
        intake_exceptions: [
          {
            event_id: "facet-event-invalid",
            received_at: "2026-08-13T10:05:00.000Z",
            state: "rejected",
            status_code: "decision_customer_identity_mismatch",
            recovery: "automatic_reconciliation",
          },
        ],
      }),
    ).toThrow();
  });
});
