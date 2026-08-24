import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStub } from "../admin/admin-link-stub";
import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { loadIntegrationReadiness } from "./integration-readiness-api";
import type { IntegrationReadinessResponse } from "./integration-readiness-contracts";
import { IntegrationReadinessPage } from "./integration-readiness-page";

vi.mock("./integration-readiness-api", () => ({ loadIntegrationReadiness: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

describe("IntegrationReadinessPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a ready profile only when the server evaluator says every required rail is ready", async () => {
    vi.mocked(loadIntegrationReadiness).mockResolvedValue(model());
    renderWithSession(<IntegrationReadinessPage />, sessionFor("owner"));

    expect(await screen.findByRole("heading", { name: "Integration readiness" })).toBeVisible();
    expect(screen.getByText("Reference journey is ready")).toBeVisible();
    expect(screen.getByText("1 of 1 ready")).toBeVisible();
    expect(screen.getByLabelText("Email Delivery ready")).toBeVisible();
    expect(screen.getByText("Recorded proof passes repository checks")).toBeVisible();
    expect(screen.getByText("2026-08-24 00:00 UTC")).toBeVisible();
    expect(screen.getByText("2026-08-25 00:00 UTC")).toBeVisible();
    expect(screen.getByText("realm:freshco")).toBeVisible();
    expect(screen.getByText("Iron-Wrap/ironwrap-os@d71941e7f51d")).toBeVisible();
    expect(
      screen.getByText(
        "Live signals are required where the repository has a runtime probe; evidence-only rails use fresh recorded readback proof.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Current proof verified")).toBeNull();
    expect(screen.getByText("Read-only control surface")).toBeVisible();
    expect(screen.queryByRole("button", { name: /connect|enable|configure|delete/i })).toBeNull();
  });

  it("keeps exact blockers and safe fallback visible", async () => {
    const blocked = model();
    blocked.verdict = "blocked";
    blocked.profile.state = "blocked";
    blocked.capabilities[0]!.state = "blocked";
    blocked.capabilities[0]!.blockers = ["proof_expired", "provider_identity_unverified"];
    vi.mocked(loadIntegrationReadiness).mockResolvedValue(blocked);
    renderWithSession(<IntegrationReadinessPage />, sessionFor("ops"));

    expect(await screen.findByText("Reference journey is blocked")).toBeVisible();
    expect(screen.getByLabelText("Email Delivery blocked")).toBeVisible();
    expect(screen.getByText("• Provider proof expired")).toBeVisible();
    expect(screen.getByText("• Provider or sender identity unverified")).toBeVisible();
    expect(screen.getByText("Fallback: Use the existing human workflow.")).toBeVisible();
  });

  it("makes the initial loading state explicit", () => {
    vi.mocked(loadIntegrationReadiness).mockReturnValue(new Promise(() => {}));
    renderWithSession(<IntegrationReadinessPage />, sessionFor("owner"));

    expect(screen.getByRole("status")).toHaveTextContent("Checking integrations and proof…");
  });

  it("makes an unavailable read explicit and retryable", async () => {
    vi.mocked(loadIntegrationReadiness).mockRejectedValue(new Error("unavailable"));
    renderWithSession(<IntegrationReadinessPage />, sessionFor("owner"));

    expect(
      await screen.findByRole("heading", { name: "Integration readiness could not load" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("does not issue the read for a field role", () => {
    vi.mocked(loadIntegrationReadiness).mockResolvedValue(model());
    renderWithSession(<IntegrationReadinessPage />, sessionFor("field"));

    expect(
      screen.getByRole("heading", { name: "This work belongs to another role" }),
    ).toBeVisible();
    expect(loadIntegrationReadiness).not.toHaveBeenCalled();
  });
});

function model(): IntegrationReadinessResponse {
  return {
    version: 1,
    tenant_id: "freshco",
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
    capabilities: [
      {
        id: "email_delivery",
        required: true,
        state: "ready",
        last_proof_at: "2026-08-24T00:00:00.000Z",
        proof_expires_at: "2026-08-25T00:00:00.000Z",
        fallback: "Use the existing human workflow.",
        blockers: [],
        manifest: {
          id: "capability_manifest_email_delivery",
          version: 1,
          provider: "gmail",
          realm: "realm:freshco",
          direction: "bidirectional",
          owner_user_id: "appu_owner",
          source_repository: "Iron-Wrap/ironwrap-os",
          source_commit: "d71941e7f51ded5f677a6b497b09c64c5ca32baf",
        },
      },
    ],
    verdict: "ready",
  };
}
