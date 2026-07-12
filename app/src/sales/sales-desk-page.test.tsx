import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadSales } from "./sales-api";
import type { SalesResponse } from "./sales-contracts";
import { SalesDeskPage } from "./sales-desk-page";

vi.mock("./sales-api", () => ({ loadSales: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string; leadId?: string };
  }) => (
    <a
      href={to
        .replace("$jobId", params?.jobId ?? "$jobId")
        .replace("$leadId", params?.leadId ?? "$leadId")}
    >
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
  permissions: ["sales:read"],
  allowed_actions: ["sales.read", "approval.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-11T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function salesModel(overrides: Partial<SalesResponse> = {}): SalesResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-11T12:00:00.000Z",
    read_model_generated_at: "2026-07-11T12:00:01.000Z",
    stale_fields: [],
    permissions: ["sales:read"],
    allowed_actions: ["sales.read", "approval.read"],
    partial_sources: [],
    summary: {
      listed_leads: 2,
      triage_unresolved: 1,
      estimate_needs_review: 1,
      quote_needs_review: 1,
      quote_expired: 0,
      no_linked_consent_record: 1,
    },
    leads: [
      {
        id: "LEAD-A",
        envelope_id: "lead_a",
        source: "website",
        received_at: "2026-07-11T12:00:00.000Z",
        transport_status: "received",
        intent_queue: "Estimator",
        contact: { display_name: "Pat Prospect", phone: "+14035559999", email: "pat@example.com" },
        triage: {
          status: "Untriaged",
          summary: "Confirm the inspection window before a final scope.",
        },
        job: {
          id: "JOB-A",
          job_number: "IW-1001",
          status: "Proposal",
          service_type: "Roofing",
          workflow_profile: "Residential Retail",
        },
        estimate: {
          id: "estimate_a",
          status: "Needs Review",
          service_type: "Roofing",
          range_low: 12400,
          range_high: 15900,
          estimate_total: null,
          confidence: "Preliminary",
          review_required: true,
          reviewed_at: null,
          approved_at: null,
          assumptions: "Pitch still needs verification.",
          exclusions: "No final contract.",
        },
        quote: {
          id: "quote_a",
          version: 2,
          status: "Needs Review",
          quote_total: 14750,
          currency: "CAD",
          valid_until: "2026-07-20",
          payment_status: "Not Due",
          prepared_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
          accepted_at: null,
          scope_summary: "Replace affected roof system.",
        },
        consent: {
          context: "recorded",
          records: [
            {
              id: "consent_a",
              channel: "Email",
              purpose: "Estimate Follow-up",
              status: "Granted",
              jurisdiction: "AB",
              basis: "Express",
              captured_at: "2026-07-11T12:00:00.000Z",
              effective_from: "2026-07-11T12:00:00.000Z",
              expires_at: null,
              revoked_at: null,
            },
          ],
        },
        attention: ["triage_unresolved", "estimate_needs_review", "quote_needs_review"],
      },
      {
        id: "LEAD-B",
        envelope_id: "lead_b",
        source: "referral",
        received_at: "2026-07-10T12:00:00.000Z",
        transport_status: "reconciled",
        intent_queue: null,
        contact: { display_name: "Morgan Homeowner", phone: null, email: null },
        triage: { status: "Triaged", summary: null },
        job: null,
        estimate: null,
        quote: null,
        consent: { context: "no_linked_record", records: [] },
        attention: [],
      },
    ],
    ...overrides,
  };
}

function renderSales({ session = ownerSession }: { session?: AuthenticatedSession } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <SalesDeskPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("SalesDeskPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSales).mockResolvedValue(salesModel());
  });

  it("shows source-backed review context without inventing a send, quote, or payment action", async () => {
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(
      screen.getByText(/does not send a message, issue a quote, or alter a customer record/i),
    ).toBeVisible();
    expect(screen.getByText("Pat Prospect")).toBeVisible();
    expect(screen.getByText("Triage unresolved")).toBeVisible();
    expect(screen.getByText("Non-binding")).toBeVisible();
    expect(screen.getByText("Email · Estimate Follow-up · Granted")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review approvals" })).toHaveAttribute(
      "href",
      "/approvals",
    );
    expect(screen.queryByRole("link", { name: /prepare triage review/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send|call|email|issue quote|collect payment/i }),
    ).not.toBeInTheDocument();
  });

  it("filters the queue without masking source records and keeps the no-consent state precise", async () => {
    const user = userEvent.setup();
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    await user.click(screen.getByRole("button", { name: /all leads/i }));
    expect(screen.getByText("Pat Prospect")).toBeVisible();
    expect(screen.getByText("Morgan Homeowner")).toBeVisible();
    expect(screen.getByText("No linked communication record returned.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /quotes/i }));
    expect(screen.getByText("Pat Prospect")).toBeVisible();
    expect(screen.queryByText("Morgan Homeowner")).not.toBeInTheDocument();
  });

  it("does not keep calling an approved estimate non-binding merely because its historical review flag remains set", async () => {
    const model = salesModel();
    const firstLead = model.leads[0]!;
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      summary: { ...model.summary, estimate_needs_review: 0 },
      leads: [
        {
          ...firstLead,
          estimate: {
            ...firstLead.estimate!,
            status: "Approved",
            approved_at: "2026-07-11T12:05:00.000Z",
          },
          attention: ["triage_unresolved", "quote_needs_review"],
        },
      ],
    });
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByText("Approved", { exact: true })).toBeVisible();
    expect(screen.queryByText("Non-binding", { exact: true })).not.toBeInTheDocument();
  });

  it("opens the source workbench only when the BFF grants estimator review", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "estimator.read"],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByRole("link", { name: /open measurement workbench/i })).toHaveAttribute(
      "href",
      "/estimator/jobs/JOB-A",
    );
  });

  it("offers triage preparation only for an explicitly untriaged lead when the BFF grants it", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "approval.prepare"],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByRole("link", { name: /prepare triage review/i })).toHaveAttribute(
      "href",
      "/sales/leads/LEAD-A/triage",
    );
  });

  it("does not turn an Unknown triage record into a preparation action", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "approval.prepare"],
      leads: [
        {
          ...salesModel().leads[0]!,
          triage: { status: "Unknown", summary: null },
          attention: ["triage_unresolved"],
        },
      ],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.queryByRole("link", { name: /prepare triage review/i })).not.toBeInTheDocument();
  });

  it("keeps the sales payload out of field devices before it asks the BFF", async () => {
    const fieldSession = {
      ...ownerSession,
      user: { ...ownerSession.user, role: "field" as const },
    };
    renderSales({ session: fieldSession });

    expect(await screen.findByText("This work belongs to another role")).toBeVisible();
    expect(loadSales).not.toHaveBeenCalled();
  });
});
