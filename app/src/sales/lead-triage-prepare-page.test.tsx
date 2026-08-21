import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadSales, newCommercialLeadTriageKey, recordCommercialLeadTriage } from "./sales-api";
import type { SalesResponse } from "./sales-contracts";
import { LeadTriagePreparePage } from "./lead-triage-prepare-page";

const router = vi.hoisted(() => ({
  params: { leadId: "LEAD-A" } as { leadId?: string },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => router.params,
  useNavigate: () => router.navigate,
}));
vi.mock("./sales-api", () => ({
  loadSales: vi.fn(),
  newCommercialLeadTriageKey: vi.fn(),
  recordCommercialLeadTriage: vi.fn(),
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
  permissions: ["sales:read", "approvals:read"],
  allowed_actions: ["sales.read", "commercial.lead_triage.record"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-12T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function salesModel(overrides: Partial<SalesResponse> = {}): SalesResponse {
  return {
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
        id: "LEAD-A",
        envelope_id: "bus-external-reference",
        source: "website",
        received_at: "2026-07-12T12:00:00.000Z",
        transport_status: "received",
        intent_queue: "Estimator",
        contact: {
          display_name: "Pat Prospect",
          phone: "+14035559999",
          email: "pat@example.com",
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
    router.params = { leadId: "LEAD-A" };
    vi.mocked(loadSales).mockResolvedValue(salesModel());
    vi.mocked(newCommercialLeadTriageKey).mockReturnValue("commercial-lead-triage:ui-001");
    vi.mocked(recordCommercialLeadTriage).mockResolvedValue({
      decision: {
        triage_decision_id: "commercial-triage:ui-001",
        lead_id: "LEAD-A",
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

    await screen.findByRole("heading", { name: "Record native triage" });
    expect(screen.getAllByText("LEAD-A").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(
      /\+14035559999|pat@example\.com|15000|Never show this/i,
    );
    await user.type(screen.getByLabelText("Category"), "storm damage");
    await user.type(
      screen.getByLabelText("Internal triage summary"),
      "Hail report received. Verify address, access, and inspection window before follow-up.",
    );
    await user.type(
      screen.getByLabelText("Next internal action"),
      "Verify access and book inspection.",
    );
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    await waitFor(() => {
      expect(recordCommercialLeadTriage).toHaveBeenCalledWith(
        ownerSession,
        {
          leadId: "LEAD-A",
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
    vi.mocked(loadSales).mockResolvedValue(salesModel({ allowed_actions: ["sales.read"] }));
    renderPage();

    expect(await screen.findByText("Triage recording is not available")).toBeVisible();
    expect(screen.queryByLabelText("Internal triage summary")).not.toBeInTheDocument();
  });

  it("does not turn an Unknown record into a local triage request", async () => {
    const model = salesModel();
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      leads: [
        {
          ...model.leads[0]!,
          triage: { status: "Unknown", summary: null, version: 1 },
          attention: ["triage_unresolved"],
        },
      ],
    });
    renderPage();

    expect(await screen.findByText("Triage recording is not available")).toBeVisible();
  });

  it("keeps commercial triage online-only and out of the field outbox", async () => {
    const offline = { ...ownerSession, csrf_token: "offline-session-no-csrf" };
    renderPage(offline);

    await screen.findByRole("heading", { name: "Record native triage" });
    expect(screen.getByText(/never queued offline/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Record triage" })).toBeDisabled();
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();
  });

  it("locks preparation while it refreshes the current Sales record", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: SalesResponse) => void) | undefined;
    renderPage();

    await screen.findByRole("heading", { name: "Record native triage" });
    await user.type(screen.getByLabelText("Category"), "roofing inquiry");
    await user.type(
      screen.getByLabelText("Internal triage summary"),
      "Confirm current roofing context.",
    );
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    vi.mocked(loadSales).mockImplementationOnce(
      () =>
        new Promise<SalesResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh context" }));

    expect(await screen.findByText("Checking current Sales context")).toBeVisible();
    expect(screen.getByRole("button", { name: "Record triage" })).toBeDisabled();
    expect(recordCommercialLeadTriage).not.toHaveBeenCalled();

    resolveRefresh?.(salesModel());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record triage" })).toBeEnabled();
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

    await screen.findByRole("heading", { name: "Record native triage" });
    await user.type(screen.getByLabelText("Category"), "roofing inquiry");
    await user.type(screen.getByLabelText("Internal triage summary"), "Confirm roofing context.");
    await user.type(screen.getByLabelText("Next internal action"), "Verify access.");
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    expect(await screen.findByRole("link", { name: "Reopen in Sales" })).toHaveAttribute(
      "href",
      "/sales",
    );
    expect(screen.getByRole("button", { name: "Record triage" })).toBeDisabled();
  });
});
