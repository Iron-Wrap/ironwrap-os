import { describe, expect, it, vi } from "vitest";

import { loadIntegrationReadiness } from "./integration-readiness-api";
import type { IntegrationReadinessResponse } from "./integration-readiness-contracts";

describe("integration readiness transport", () => {
  it("reads the source-addressed reference profile over the authenticated BFF", async () => {
    const fetcher = vi.fn(async () => Response.json(model())) as typeof fetch;

    const result = await loadIntegrationReadiness(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/integrations/readiness?profile=reference_journey",
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
    expect(result.configuration_mutations_available).toBe(false);
    expect(result.allowed_actions).toEqual(["integrations.readiness.read"]);
  });
});

function model(): IntegrationReadinessResponse {
  return {
    version: 1,
    tenant_id: "ironwrap",
    read_model_generated_at: "2026-08-24T12:00:00.000Z",
    allowed_actions: ["integrations.readiness.read"],
    configuration_mutations_available: false,
    profile: {
      key: "reference_journey",
      version: 1,
      state: "ready",
      blockers: [],
      dependencies: [
        { key: "core", minimum_version: 1, state: "ready" },
        { key: "commercial_closure", minimum_version: 1, state: "ready" },
        { key: "field_closure", minimum_version: 1, state: "ready" },
        { key: "accounting_closure", minimum_version: 1, state: "ready" },
      ],
    },
    capabilities: [capability("email_delivery", true, "ready")],
    verdict: "ready",
  };
}

function capability(
  id: IntegrationReadinessResponse["capabilities"][number]["id"],
  required: boolean,
  state: "ready" | "blocked",
): IntegrationReadinessResponse["capabilities"][number] {
  return {
    id,
    required,
    state,
    last_proof_at: "2026-08-24T00:00:00.000Z",
    proof_expires_at: "2026-08-25T00:00:00.000Z",
    fallback: "Use the existing human workflow.",
    blockers: [],
    manifest: {
      id: `manifest_${id}`,
      version: 1,
      provider: "provider",
      realm: "realm:ironwrap",
      direction: "bidirectional",
      owner_user_id: "appu_owner",
      source_repository: "Iron-Wrap/ironwrap-os",
      source_commit: "d71941e7f51ded5f677a6b497b09c64c5ca32baf",
    },
  };
}
