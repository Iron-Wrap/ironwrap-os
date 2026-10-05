import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadFacetDesignEvidence } from "./facet-design-api";
import type {
  FacetDesignEvidence,
  FacetDesignEvidenceResponse,
  FacetDesignIntakeException,
} from "./facet-design-contracts";
import { FacetDesignPage } from "./facet-design-page";

vi.mock("./facet-design-api", () => ({ loadFacetDesignEvidence: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["facet:read"],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2026-08-14T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-13T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const fieldSession = {
  ...ownerSession,
  user: {
    ...ownerSession.user,
    id: "appu_field",
    email: "crew@ironwrapexteriors.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@ironwrapexteriors.com",
  },
} satisfies AuthenticatedSession;

const projected = {
  event_id: "facet-event-1",
  tenant_id: "ironwrap",
  brand_id: "ironwrap-exteriors",
  facet_project_id: "facet-project-1",
  design_revision_id: `facet-json-v1:${"a".repeat(64)}`,
  design_revision_sha256: "a".repeat(64),
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
  status_code: "native_design_projected",
  projection: {
    outcome: "projected_native_design",
    projection_id: "facet-native-design-v2:projection-1",
    projection_sha256: "e".repeat(64),
    source_quote_revision_id: "quote-revision:accepted-1",
    source_quote_version: 2,
    source_proposal_revision_id: "proposal-revision:accepted-1",
    source_publication_event_id: "publication-event:accepted-1",
    source_acceptance_binding_id: "acceptance-binding:accepted-1",
    launch_intent_sha256: "f".repeat(64),
    design_sequence: 1,
    design_state: "active",
    error_code: null,
    attempted_at: "2026-08-13T10:02:00.000Z",
  },
} satisfies FacetDesignEvidence;

function model(
  evidence: FacetDesignEvidence[] = [projected],
  intakeExceptions: FacetDesignIntakeException[] = [],
): FacetDesignEvidenceResponse {
  return {
    version: 2,
    read_model_generated_at: "2026-08-13T12:00:00.000Z",
    permissions: ["facet:read"],
    allowed_actions: ["facet_design.read"],
    evidence,
    intake_exceptions: intakeExceptions,
  };
}

function renderPage(session: AuthenticatedSession = ownerSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <FacetDesignPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("FacetDesignPage", () => {
  beforeEach(() => {
    vi.mocked(loadFacetDesignEvidence).mockReset();
    vi.mocked(loadFacetDesignEvidence).mockResolvedValue(model());
  });

  it("shows signed OIDC evidence and the exact native design authority", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Customer design evidence" })).toBeVisible();
    expect(screen.getByText("Native design ready")).toBeVisible();
    expect(screen.getByText("quote-revision:accepted-1")).toBeVisible();
    expect(screen.getByText("Version 2")).toBeVisible();
    expect(screen.getByText("1 · active")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Design for ROOF-JOB-1" })).toBeVisible();
    expect(screen.getByText("facet-project-1")).not.toBeVisible();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("facet-project-1")).toBeVisible();
    expect(screen.getByText("facet-native-design-v2:projection-1")).toBeVisible();
    expect(screen.getByText("Google OIDC · exact project link")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect|prepare/i })).not.toBeInTheDocument();
  });

  it("renders awaiting, lifecycle-held, and fail-closed attention states honestly", async () => {
    vi.mocked(loadFacetDesignEvidence).mockResolvedValueOnce(
      model(
        [
          {
            ...projected,
            event_id: "facet-awaiting",
            facet_project_id: "facet-project-awaiting",
            projection_state: "awaiting_projection",
            status_code: "awaiting_native_design_projection",
            projection: null,
          },
          {
            ...projected,
            event_id: "facet-withdrawn",
            facet_project_id: "facet-project-withdrawn",
            decision_kind: "withdrawn",
            previous_event_id: "facet-event-1",
            projection_state: "held",
            status_code: "customer_withdrew_design",
            projection: {
              outcome: "held_withdrawn",
              projection_id: "facet-native-design-v2:projection-withdrawn",
              projection_sha256: "1".repeat(64),
              source_quote_revision_id: "quote-revision:accepted-1",
              source_quote_version: 2,
              source_proposal_revision_id: "proposal-revision:accepted-1",
              source_publication_event_id: "publication-event:accepted-1",
              source_acceptance_binding_id: "acceptance-binding:accepted-1",
              launch_intent_sha256: "2".repeat(64),
              design_sequence: 2,
              design_state: "withdrawn",
              error_code: null,
              attempted_at: "2026-08-13T10:03:00.000Z",
            },
          },
          {
            ...projected,
            event_id: "facet-attention",
            facet_project_id: "facet-project-attention",
            projection_state: "attention_required",
            status_code: "facet_v2_authority_drift",
            projection: null,
          },
        ],
        [
          {
            event_id: "facet-unassociated",
            received_at: "2026-08-13T10:04:00.000Z",
            state: "awaiting_association",
            status_code: "awaiting_exact_project_identity_association",
            recovery: "automatic_reconciliation",
          },
          {
            event_id: "facet-rejected",
            received_at: "2026-08-13T10:05:00.000Z",
            state: "rejected",
            status_code: "decision_customer_identity_mismatch",
            recovery: "governed_reissue_required",
          },
        ],
      ),
    );

    renderPage();

    expect((await screen.findAllByText("Awaiting projection")).length).toBeGreaterThan(0);
    expect(screen.getByText("Lifecycle hold")).toBeVisible();
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/failed closed before claiming native design authority/i),
    ).toBeVisible();
    expect(screen.getByText("Waiting for the exact project link")).toBeVisible();
    expect(screen.getByText("Signed delivery rejected")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Open the governed sales path" })).toHaveLength(2);
  });

  it("refreshes the complete evidence read model without a mutation route", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Native design ready");

    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));

    await waitFor(() => expect(loadFacetDesignEvidence).toHaveBeenCalledTimes(2));
  });

  it("shows a truthful empty state before the first signed delivery", async () => {
    vi.mocked(loadFacetDesignEvidence).mockResolvedValueOnce(model([]));
    renderPage();

    expect(await screen.findByText("No signed Facet decisions yet")).toBeVisible();
    expect(screen.getByText(/signed producer delivery is accepted/i)).toBeVisible();
  });

  it("fails closed for field roles without loading office evidence", () => {
    renderPage(fieldSession);

    expect(
      screen.getByRole("heading", { name: "This work belongs to another role" }),
    ).toBeVisible();
    expect(loadFacetDesignEvidence).not.toHaveBeenCalled();
  });
});
