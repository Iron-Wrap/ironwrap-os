import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { newLeadTriageApprovalPrepareKey, prepareLeadTriageApproval } from "../owner/approval-api";
import { loadSales } from "./sales-api";
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
vi.mock("./sales-api", () => ({ loadSales: vi.fn() }));
vi.mock("../owner/approval-api", () => ({
  newLeadTriageApprovalPrepareKey: vi.fn(),
  prepareLeadTriageApproval: vi.fn(),
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
  allowed_actions: ["sales.read", "approval.prepare"],
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
    allowed_actions: ["sales.read", "approval.prepare"],
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
        triage: { status: "Untriaged", summary: null },
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
    vi.mocked(newLeadTriageApprovalPrepareKey).mockReturnValue(
      "lead-triage-approval:prepare-ui-001",
    );
    vi.mocked(prepareLeadTriageApproval).mockResolvedValue({
      approval: {
        id: "approval:ui-001",
      },
    } as never);
  });

  it("submits only the Frappe Lead Envelope name and factual summary before opening the existing review queue", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();

    await screen.findByRole("heading", { name: "Prepare local triage" });
    expect(screen.getAllByText("LEAD-A").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(
      /\+14035559999|pat@example\.com|15000|Never show this/i,
    );
    await user.type(
      screen.getByLabelText("Internal triage summary"),
      "Hail report received. Verify address, access, and inspection window before follow-up.",
    );
    await user.click(screen.getByRole("button", { name: "Prepare triage review" }));

    await waitFor(() => {
      expect(prepareLeadTriageApproval).toHaveBeenCalledWith(
        ownerSession,
        {
          leadEnvelopeId: "LEAD-A",
          triageSummary:
            "Hail report received. Verify address, access, and inspection window before follow-up.",
        },
        "lead-triage-approval:prepare-ui-001",
      );
    });
    expect(router.navigate).toHaveBeenCalledWith({ to: "/approvals" });
  });

  it("does not infer preparation authority when the Sales BFF omits approval.prepare", async () => {
    vi.mocked(loadSales).mockResolvedValue(salesModel({ allowed_actions: ["sales.read"] }));
    renderPage();

    expect(await screen.findByText("Triage preparation is not available")).toBeVisible();
    expect(screen.queryByLabelText("Internal triage summary")).not.toBeInTheDocument();
  });

  it("does not turn an Unknown record into a local triage request", async () => {
    const model = salesModel();
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      leads: [
        {
          ...model.leads[0]!,
          triage: { status: "Unknown", summary: null },
          attention: ["triage_unresolved"],
        },
      ],
    });
    renderPage();

    expect(await screen.findByText("Triage preparation is not available")).toBeVisible();
  });

  it("keeps local triage preparation online-only and out of the field outbox", async () => {
    const offline = { ...ownerSession, csrf_token: "offline-session-no-csrf" };
    renderPage(offline);

    await screen.findByRole("heading", { name: "Prepare local triage" });
    expect(screen.getByText(/never queued offline/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Prepare triage review" })).toBeDisabled();
    expect(prepareLeadTriageApproval).not.toHaveBeenCalled();
  });

  it("locks preparation while it refreshes the current Sales record", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: SalesResponse) => void) | undefined;
    renderPage();

    await screen.findByRole("heading", { name: "Prepare local triage" });
    await user.type(
      screen.getByLabelText("Internal triage summary"),
      "Confirm current roofing context.",
    );
    vi.mocked(loadSales).mockImplementationOnce(
      () =>
        new Promise<SalesResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh context" }));

    expect(await screen.findByText("Checking current Sales context")).toBeVisible();
    expect(screen.getByRole("button", { name: "Prepare triage review" })).toBeDisabled();
    expect(prepareLeadTriageApproval).not.toHaveBeenCalled();

    resolveRefresh?.(salesModel());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Prepare triage review" })).toBeEnabled();
    });
  });

  it("requires a restart through Sales after an idempotency conflict", async () => {
    const user = userEvent.setup();
    vi.mocked(prepareLeadTriageApproval).mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: "idempotency_conflict",
        message: "The key is already bound to another request.",
      }),
    );
    renderPage();

    await screen.findByRole("heading", { name: "Prepare local triage" });
    await user.type(screen.getByLabelText("Internal triage summary"), "Confirm roofing context.");
    await user.click(screen.getByRole("button", { name: "Prepare triage review" }));

    expect(await screen.findByRole("link", { name: "Reopen in Sales" })).toHaveAttribute(
      "href",
      "/sales",
    );
    expect(screen.getByRole("button", { name: "Prepare triage review" })).toBeDisabled();
  });
});
