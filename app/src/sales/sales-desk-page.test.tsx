import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadPipelines, placeCardOnPipeline } from "../pipeline/pipeline-api";
import type { PipelineListResponse } from "../pipeline/pipeline-contracts";
import { loadSales } from "./sales-api";
import type { SalesResponse } from "./sales-contracts";
import { SalesDeskPage } from "./sales-desk-page";

vi.mock("./sales-api", () => ({ loadSales: vi.fn() }));
vi.mock("../pipeline/pipeline-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/pipeline-api")>();
  return { ...actual, loadPipelines: vi.fn(), placeCardOnPipeline: vi.fn() };
});
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
          version: 1,
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
        proposal: {
          id: "pack_a",
          status: "Draft",
          prepared_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
          signed_at: null,
          has_published_pack: false,
          published_status: null,
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
        partial_fields: [],
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
        triage: { status: "Triaged", summary: null, version: 2 },
        job: null,
        estimate: null,
        quote: null,
        proposal: null,
        consent: { context: "no_linked_record", records: [] },
        partial_fields: [],
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

const pipelineList: PipelineListResponse = {
  version: 1,
  source_updated_at: "2026-07-11T12:00:00.000Z",
  read_model_generated_at: "2026-07-11T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.read"],
  pipelines: [
    {
      pipeline_id: "pipe-sales",
      key: "sales",
      name: "Sales",
      entity_type: "lead",
      owning_role: "sales",
      can_move: true,
      position: 0,
    },
  ],
};

describe("SalesDeskPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(loadSales).mockResolvedValue(salesModel());
    vi.mocked(loadPipelines).mockResolvedValue(pipelineList);
  });

  it("shows source-backed review context without inventing a send, quote, or payment action", async () => {
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByText(/Check each lead before you call or send anything/i)).toBeVisible();
    expect(screen.getByText("Pat Prospect")).toBeVisible();
    expect(screen.getByText("Lead check needed")).toBeVisible();
    expect(screen.getByText("Not final")).toBeVisible();
    expect(screen.getByText("Customer view")).toBeVisible();
    expect(screen.getByText("Not shown to customer")).toBeVisible();
    expect(screen.getByText(/cannot show quote terms to the customer/i)).toBeVisible();
    expect(screen.getByText("Email · Estimate Follow-up · Granted")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open lead reviews" })).toHaveAttribute(
      "href",
      "/approvals",
    );
    expect(screen.queryByRole("link", { name: /start lead check/i })).not.toBeInTheDocument();
    expect(screen.getByText("lead_a")).not.toBeVisible();
    await userEvent.setup().click(screen.getByText("System details"));
    expect(screen.getByText("lead_a")).toBeVisible();
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
    expect(screen.getByText("No contact rule was found.")).toBeVisible();

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
    expect(screen.queryByText("Not final", { exact: true })).not.toBeInTheDocument();
  });

  it("does not invent a missing proposal state when its source hit the bounded read limit", async () => {
    const model = salesModel();
    const firstLead = model.leads[0]!;
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      partial_sources: ["commercial_proposal_revisions"],
      leads: [
        {
          ...firstLead,
          proposal: null,
          partial_fields: ["proposal", "proposal_publication", "proposal_acceptance"],
          attention: [...firstLead.attention, "source_partial"],
        },
      ],
    });
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByText(/Do not say the customer can see it/i)).toBeVisible();
    expect(screen.queryByText(/No customer view was found/i)).not.toBeInTheDocument();
  });

  it("keeps a returned proposal publication-inconclusive when its bounded source is partial", async () => {
    const model = salesModel();
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      partial_sources: ["commercial_proposal_publication_events"],
      leads: [
        {
          ...model.leads[0]!,
          proposal: {
            ...model.leads[0]!.proposal!,
            has_published_pack: null,
            published_status: null,
          },
          partial_fields: ["proposal_publication"],
          attention: [...model.leads[0]!.attention, "source_partial"],
        },
      ],
    });
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByText("Customer view is not known")).toBeVisible();
    expect(screen.getByText(/Do not say the customer can see it/i)).toBeVisible();
    expect(screen.queryByText("Customer view saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Not shown to customer")).not.toBeInTheDocument();
  });

  it("keeps a recorded publication visible when a newer office draft exists", async () => {
    const model = salesModel();
    const firstLead = model.leads[0]!;
    vi.mocked(loadSales).mockResolvedValue({
      ...model,
      leads: [
        {
          ...firstLead,
          proposal: {
            ...firstLead.proposal!,
            has_published_pack: true,
            published_status: "Approved",
          },
        },
      ],
    });
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByText("Customer view saved")).toBeVisible();
    expect(screen.getByText(/newest office version is Draft/i)).toBeVisible();
  });

  it("opens the source workbench only when the BFF grants estimator review", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "estimator.read"],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByRole("link", { name: /open roof work/i })).toHaveAttribute(
      "href",
      "/estimator/jobs/JOB-A",
    );
  });

  it("offers triage preparation only for an explicitly untriaged lead when the BFF grants it", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "commercial.lead_triage.record"],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.getByRole("link", { name: /start lead check/i })).toHaveAttribute(
      "href",
      "/sales/leads/LEAD-A/triage",
    );
  });

  it("does not turn an Unknown triage record into a preparation action", async () => {
    const model = salesModel({
      allowed_actions: ["sales.read", "approval.read", "commercial.lead_triage.record"],
      leads: [
        {
          ...salesModel().leads[0]!,
          triage: { status: "Unknown", summary: null, version: 1 },
          attention: ["triage_unresolved"],
        },
      ],
    });
    vi.mocked(loadSales).mockResolvedValue(model);
    renderSales();

    await screen.findByRole("heading", { name: "Sales desk" });
    expect(screen.queryByRole("link", { name: /start lead check/i })).not.toBeInTheDocument();
  });

  // The gap ELEC-202 closes: before this, a lead created here could never reach a board
  // because nothing in the product called the card-placement route.
  describe("putting a lead on a board", () => {
    it("offers the action once the server names a board that takes a lead", async () => {
      renderSales();

      expect(
        await screen.findByRole("button", { name: "Add Pat Prospect to a board" }),
      ).toBeVisible();
    });

    it("places the lead the person is looking at, by its own id", async () => {
      const user = userEvent.setup();
      vi.mocked(placeCardOnPipeline).mockResolvedValue({
        card_id: "plc_1",
        pipeline_id: "pipe-sales",
        entity_type: "lead",
        entity_id: "LEAD-A",
        replayed: false,
      });
      renderSales();

      await user.click(await screen.findByRole("button", { name: "Add Pat Prospect to a board" }));
      await user.click(await screen.findByRole("button", { name: /^Sales/ }));

      await screen.findByText(/Pat Prospect is on Sales/);
      expect(vi.mocked(placeCardOnPipeline).mock.calls[0]?.[1]).toMatchObject({
        pipelineId: "pipe-sales",
        entityType: "lead",
        entityId: "LEAD-A",
      });
    });

    it("does not offer the action when no board this session can write takes a lead", async () => {
      vi.mocked(loadPipelines).mockResolvedValue({
        ...pipelineList,
        pipelines: [{ ...pipelineList.pipelines[0]!, can_move: false }],
      });
      renderSales();

      await screen.findByRole("heading", { name: "Sales desk" });
      expect(screen.queryByRole("button", { name: /to a board$/ })).not.toBeInTheDocument();
    });

    it("offers a job board the linked job, not the lead", async () => {
      vi.mocked(loadPipelines).mockResolvedValue({
        ...pipelineList,
        pipelines: [
          {
            pipeline_id: "pipe-shop",
            key: "shop",
            name: "Shop",
            entity_type: "job",
            owning_role: "production",
            can_move: true,
            position: 0,
          },
        ],
      });
      const user = userEvent.setup();
      renderSales();

      await user.click(await screen.findByRole("button", { name: "Add Pat Prospect to a board" }));

      expect(await screen.findByRole("button", { name: /^Shop/ })).toHaveTextContent(
        "Adds job IW-1001",
      );
      // The lead with no job never gets the affordance for a job-only board.
      expect(
        screen.queryByRole("button", { name: "Add Morgan Homeowner to a board" }),
      ).not.toBeInTheDocument();
    });
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
