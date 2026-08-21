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

  it("shows signed OIDC evidence and the exact reconciled blank Draft receipt", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Customer designs" })).toBeVisible();
    expect(screen.getByText("Quote draft ready")).toBeVisible();
    expect(screen.getByText("facet-quote-revision:draft-1")).toBeVisible();
    expect(screen.getByText("Customer and job matched")).toBeVisible();
    expect(screen.getByText("facet-project-1")).not.toBeVisible();

    await user.click(screen.getByText("System details"));

    expect(screen.getByText("facet-project-1")).toBeVisible();
    expect(screen.getByText("Quote draft version")).toBeVisible();
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
            decision_kind: "corrected",
            projection_state: "awaiting_projection",
            status_code: "awaiting_blank_draft_projection",
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
              evidence_id: null,
              reconciliation_id: null,
              draft_customer_quote_id: null,
              draft_quote_version: null,
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

    expect((await screen.findAllByText("Waiting to start")).length).toBeGreaterThan(0);
    expect(screen.getByText("Customer changed this in Facet")).toBeVisible();
    expect(screen.getByText("Customer removed it")).toBeVisible();
    expect(screen.getAllByText("Needs help").length).toBeGreaterThan(0);
    expect(screen.getByText(/stopped before making a quote draft/i)).toBeVisible();
    expect(screen.getByText("Waiting for the right job")).toBeVisible();
    expect(screen.getByText("Design could not be linked")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Open sales" })).toHaveLength(2);
  });

  it("refreshes the complete evidence read model without a mutation route", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Quote draft ready");

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(loadFacetDesignEvidence).toHaveBeenCalledTimes(2));
  });

  it("shows a truthful empty state before the first signed delivery", async () => {
    vi.mocked(loadFacetDesignEvidence).mockResolvedValueOnce(model([]));
    renderPage();

    expect(await screen.findByText("No Facet design choices yet")).toBeVisible();
    expect(screen.getByText(/customer choice will show/i)).toBeVisible();
  });

  it("fails closed for field roles without loading office evidence", () => {
    renderPage(fieldSession);

    expect(
      screen.getByRole("heading", { name: "This work belongs to another role" }),
    ).toBeVisible();
    expect(loadFacetDesignEvidence).not.toHaveBeenCalled();
  });
});
