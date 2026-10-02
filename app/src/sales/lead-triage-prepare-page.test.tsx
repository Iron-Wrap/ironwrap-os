import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadSalesLead, newCommercialLeadTriageKey, recordCommercialLeadTriage } from "./sales-api";
import type { SalesResponse, SalesLeadResponse } from "./sales-contracts";
import { LeadTriagePreparePage } from "./lead-triage-prepare-page";

const router = vi.hoisted(() => ({
  params: { leadId: `lead:ironwrap:${"a".repeat(64)}` } as { leadId?: string },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => router.params,
  useNavigate: () => router.navigate,
}));
vi.mock("./sales-api", () => ({
  loadSalesLead: vi.fn(),
  newCommercialLeadTriageKey: vi.fn(),
  recordCommercialLeadTriage: vi.fn(),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["sales:read", "approvals:read"],
  allowed_actions: ["sales.read", "commercial.lead_triage.record"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-12T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function salesModel(overrides: Partial<SalesResponse> = {}): SalesLeadResponse {
  const list: SalesResponse = {
    version: 1,
    source_updated_at: "2026-07-12T12:00:00.000Z",
    read_model_generated_at: "2026-07-12T12:00:01.000Z",
    stale_fields: [],
    permissions: ["sales:read", "approvals:read"],
    allowed_actions: ["sales.read", "commercial.lead_triage.record"],
    partial_sources: [],
    summary: {
      listed_leads: 1,
      triage_unresolved: 1,
      estimate_needs_review: 0,
      quote_needs_review: 0,
      quote_expired: 0,
      no_linked_consent_record: 0,
    },
    leads: [
      {
        id: `lead:ironwrap:${"a".repeat(64)}`,
        envelope_id: "bus-external-reference",
        source: "website",
        received_at: "2026-07-12T12:00:00.000Z",
        transport_status: "received",
        intent_queue: "Estimator",
        contact: {
          display_name: "Pat Prospect",
          phone: "+14035559999",
          email: "pat@example.invalid",
        },
        triage: { status: "Untriaged", summary: null, version: 1 },
        job: null,
        estimate: {
          id: "estimate-a",
          status: "Needs Review",
          service_type: "Roofing",
          range_low: 10000,
          range_high: 15000,
          estimate_total: null,
          confidence: "Preliminary",
          review_required: true,
          reviewed_at: null,
          approved_at: null,
          assumptions: null,
          exclusions: null,
        },
        quote: {
          id: "quote-a",
          version: 1,
          status: "Needs Review",
          quote_total: 15000,
          currency: "CAD",
          valid_until: null,
          payment_status: null,
          prepared_at: null,
          approved_at: null,
          accepted_at: null,
          scope_summary: "Never show this here.",
        },
        proposal: null,
        consent: { context: "recorded", records: [] },
        partial_fields: [],
        attention: ["triage_unresolved"],
      },
    ],
    ...overrides,
  };
  return {
    version: 1,
    read_model_generated_at: list.read_model_generated_at,
    permissions: list.permissions,
    allowed_actions: list.allowed_actions,
    stale_fields: [],
    partial_sources: [],
    lead: list.leads[0]!,
    intake: null,
  };
}

function renderPage(session = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <LeadTriagePreparePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("LeadTriagePreparePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    onlineManager.setOnline(true);
    fireEvent(window, new Event("online"));
    router.params = { leadId: `lead:ironwrap:${"a".repeat(64)}` };
    vi.mocked(loadSalesLead).mockResolvedValue(salesModel());
    vi.mocked(newCommercialLeadTriageKey).mockReturnValue("commercial-lead-triage:ui-001");
    vi.mocked(recordCommercialLeadTriage).mockResolvedValue({
      decision: {
        triage_decision_id: "commercial-triage:ui-001",
        lead_id: `lead:ironwrap:${"a".repeat(64)}`,
        lead_version: 2,
        lifecycle_status: "triaged",
        priority: "normal",
        category: "storm damage",
        summary: "Confirmed roof context.",
        next_action: "Verify access and book inspection.",
        decided_at: "2026-07-12T12:01:00.000Z",
      },
      replayed: false,
      permit: { permit_id: "commercial-permit:ui-001", replayed: false },
    });
  });

  it("records a complete native triage decision against the exact lead version", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();

    await screen.findByRole("heading", { name: "Lead review" });
    expect(screen.getByText(`lead:ironwrap:${"a".repeat(64)}`)).not.toBeVisible();
    await user.click(screen.getByText("Record details"));
    expect(screen.getByText(`lead:ironwrap:${"a".repeat(64)}`)).toBeVisible();
    expect(screen.getByText("bus-external-reference")).toBeVisible();
    expect(container.textContent).not.toMatch(/15000|Never show this/i);
    await user.type(screen.getByLabelText("Kind of work"), "storm damage");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Hail report received. Verify address, access, and inspection window before follow-up.",
    );
    await user.type(
      screen.getByLabelText("Next internal action"),
      "Verify access and book inspection.",
    );
    await user.click(screen.getByRole("button", { name: "Save lead review" }));

    await waitFor(() => {
      expect(recordCommercialLeadTriage).toHaveBeenCalledWith(
        ownerSession,
        {
          leadId: `lead:ironwrap:${"a".repeat(64)}`,
          expectedLeadVersion: 1,
          lifecycleStatus: "triaged",
          priority: "normal",
          category: "storm damage",
          summary:
            "Hail report received. Verify address, access, and inspection window before follow-up.",
          nextAction: "Verify access and book inspection.",
        },
        "commercial-lead-triage:ui-001",
      );
    });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/sales" });
  });

  it("does not infer recording authority when the Sales BFF omits the native action", async () => {
    vi.mocked(loadSalesLead).mockResolvedValue(salesModel({ allowed_actions: ["sales.read"] }));
    renderPage();

    expect(await screen.findByText("Review is not available")).toBeVisible();
    expect(screen.queryByLabelText("Summary for the next person")).not.toBeInTheDocument();
  });

  it("does not turn an Unknown record into a local triage request", async () => {
    const model = salesModel();
    vi.mocked(loadSalesLead).mockResolvedValue({
      ...model,
      lead: {
        ...model.lead,
        triage: { status: "Unknown", summary: null, version: 1 },
        attention: ["triage_unresolved"],
      },
    });
    renderPage();

    expect(await screen.findByText("Review is not available")).toBeVisible();
  });

  it("keeps commercial triage online-only and out of the field outbox", async () => {
    const offline = { ...ownerSession, csrf_token: "offline-session-no-csrf" };
    renderPage(offline);

    await screen.findByRole("heading", { name: "Lead review" });
    expect(screen.getByText(/never queued offline/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();
  });

  it("blocks a live disconnected browser and preserves the prepared review", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "Roof repair");
    await user.type(screen.getByLabelText("Summary for the next person"), "Review notes");
    await user.type(screen.getByLabelText("Next internal action"), "Confirm access");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    fireEvent(window, new Event("offline"));
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    expect(screen.getByLabelText("Summary for the next person")).toHaveValue("Review notes");
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();
  });

  it("locks preparation while it refreshes the current Sales record", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: SalesLeadResponse) => void) | undefined;
    renderPage();

    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "roofing inquiry");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Confirm current roofing context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    vi.mocked(loadSalesLead).mockImplementationOnce(
      () =>
        new Promise<SalesLeadResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh lead" }));

    expect(await screen.findByText("Checking the current lead")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();

    resolveRefresh?.(salesModel());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save lead review" })).toBeEnabled();
    });
  });

  it("requires a restart through Sales after an idempotency conflict", async () => {
    const user = userEvent.setup();
    vi.mocked(recordCommercialLeadTriage).mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: "commercial_triage_version_conflict",
        message: "The key is already bound to another request.",
      }),
    );
    renderPage();

    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "roofing inquiry");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Confirm roofing context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    await user.click(screen.getByRole("button", { name: "Save lead review" }));

    expect(await screen.findByText("Check the saved review")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh lead" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
  });
  it("continues a triaged lead to qualified using the freshly read version", async () => {
    const base = salesModel();
    vi.mocked(loadSalesLead).mockResolvedValue({
      ...base,
      lead: {
        ...base.lead,
        triage: { status: "Triaged", summary: "Earlier review", version: 7 },
        attention: [],
      },
    });
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Lead review" });
    expect(screen.queryByRole("radio", { name: /Needs more information/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Qualified/ })).not.toBeChecked();
    await user.type(screen.getByLabelText("Kind of work"), "roofing");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Confirmed roof context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Qualified/ }));
    await user.click(screen.getByRole("button", { name: "Save lead review" }));
    await waitFor(() =>
      expect(recordCommercialLeadTriage).toHaveBeenCalledWith(
        ownerSession,
        expect.objectContaining({ expectedLeadVersion: 7, lifecycleStatus: "qualified" }),
        expect.any(String),
      ),
    );
  });

  it("rejects an exact response belonging to another lead", async () => {
    const base = salesModel();
    vi.mocked(loadSalesLead).mockResolvedValue({
      ...base,
      lead: { ...base.lead, id: `lead:ironwrap:${"b".repeat(64)}` },
    });
    renderPage();
    expect(await screen.findByText("This is not the requested lead")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save lead review" })).not.toBeInTheDocument();
  });

  it("keeps a populated review locked after a failed refresh", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "roofing");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Confirmed roof context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    vi.mocked(loadSalesLead).mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Refresh lead" }));
    expect(await screen.findByText("This lead could not be refreshed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    expect(screen.getByLabelText("Summary for the next person")).toHaveValue(
      "Confirmed roof context.",
    );
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();
  });

  it("requires a new explicit outcome after a lost Needs-more-information save becomes Triaged", async () => {
    vi.mocked(recordCommercialLeadTriage).mockRejectedValueOnce(new Error("response lost"));
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "roofing");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Still need the access details.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    await user.click(screen.getByRole("radio", { name: /Needs more information/ }));
    await user.click(screen.getByRole("button", { name: "Save lead review" }));
    expect(await screen.findByText("Check the saved review")).toBeVisible();
    expect(vi.mocked(recordCommercialLeadTriage).mock.calls[0]![1].lifecycleStatus).toBe("triaged");
    const base = salesModel();
    vi.mocked(loadSalesLead).mockResolvedValueOnce({
      ...base,
      lead: {
        ...base.lead,
        triage: { status: "Triaged", summary: "Still need the access details.", version: 2 },
      },
    });
    await user.click(screen.getByRole("button", { name: "Refresh lead" }));
    await waitFor(() => expect(screen.getByLabelText("Kind of work")).toBeEnabled());
    expect(screen.getByLabelText("Summary for the next person")).toHaveValue(
      "Still need the access details.",
    );
    expect(screen.getByRole("radio", { name: /Qualified/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Decline this work/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Save lead review" }).closest("form")!);
    expect(recordCommercialLeadTriage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("radio", { name: /Qualified/ }));
    await user.click(screen.getByRole("button", { name: "Save lead review" }));
    await waitFor(() => expect(recordCommercialLeadTriage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(recordCommercialLeadTriage).mock.calls[1]![1]).toMatchObject({
      expectedLeadVersion: 2,
      lifecycleStatus: "qualified",
    });
  });

  it("checks a lost save acknowledgement without a second write", async () => {
    vi.mocked(recordCommercialLeadTriage).mockRejectedValueOnce(new Error("response lost"));
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Lead review" });
    await user.type(screen.getByLabelText("Kind of work"), "roofing");
    await user.type(
      screen.getByLabelText("Summary for the next person"),
      "Confirmed roof context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    await user.click(screen.getByRole("button", { name: "Save lead review" }));
    expect(await screen.findByText("Check the saved review")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save lead review" })).toBeDisabled();
    expect(screen.getByLabelText("Kind of work")).toBeDisabled();
    const base = salesModel();
    vi.mocked(loadSalesLead).mockResolvedValueOnce({
      ...base,
      lead: { ...base.lead, triage: { status: "Qualified", summary: "Saved", version: 2 } },
    });
    await user.click(screen.getByRole("button", { name: "Refresh lead" }));
    expect(await screen.findByText("Review is not available")).toBeVisible();
    expect(recordCommercialLeadTriage).toHaveBeenCalledTimes(1);
  });
});
