import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadEstimatorWorkbench } from "./estimator-api";
import type { EstimatorWorkbenchResponse } from "./estimator-contracts";
import { EstimatorWorkbenchPage } from "./estimator-workbench-page";

vi.mock("./estimator-api", () => ({ loadEstimatorWorkbench: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ jobId: "JOB-A" }),
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
  permissions: ["sales:read", "estimator:read"],
  allowed_actions: ["sales.read", "estimator.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T18:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-11T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function workbenchModel(
  overrides: Partial<EstimatorWorkbenchResponse> = {},
): EstimatorWorkbenchResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-11T12:00:00.000Z",
    read_model_generated_at: "2026-07-11T12:00:01.000Z",
    stale_fields: [],
    permissions: ["sales:read", "estimator:read"],
    allowed_actions: ["job.read", "estimator.read"],
    partial_sources: [],
    job: {
      id: "JOB-A",
      roof_job_id: "roof_job_a",
      job_number: "IW-1001",
      brand: "ironwrap",
      service_type: "Roof replacement",
      status: "Proposal",
      workflow_profile: "Residential Retail",
    },
    lineage: {
      measurement_to_takeoff: "linked",
      quote_to_proposal: "linked",
    },
    measurements: {
      reports: [
        {
          id: "measure_a",
          provider: "AppliCad",
          review_status: "Needs Review",
          parsed_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
        },
      ],
      selected: {
        id: "measure_a",
        provider: "AppliCad",
        review_status: "Needs Review",
        parsed_at: "2026-07-11T12:00:00.000Z",
        approved_at: null,
        metrics: [
          {
            metric: "roof_area",
            value: 100,
            unit: "sq ft",
            confidence: "deterministic",
            source_ref: "POLYGON[type=Roof]",
            needs_review: true,
          },
        ],
        metrics_truncated: false,
        geometry: {
          state: "needs_review",
          reason: null,
          check_count: 1,
          failed_check_count: 1,
          checks_truncated: false,
          facet_count: 1,
          facets_truncated: false,
          metrics_truncated: false,
          checks: [
            {
              check: "line_length_recompute",
              target: "L4",
              ok: false,
              detail: "declared 12 vs computed 10.0000 (16.7%)",
            },
          ],
          facets: [
            {
              id: "F1",
              type: "Roof",
              material: "Asphalt",
              pitch: 6,
              orientation: null,
              declared_area: 100,
              computed_area: 100,
              deviation: 0,
              ring_closed: true,
            },
          ],
          metrics: [
            { metric: "roof_area", value: 100, source_ref: "POLYGON[type=Roof] sum(size)" },
          ],
        },
      },
    },
    takeoffs: {
      records: [
        {
          id: "takeoff_a",
          measurement_report_id: "MEASURE-A",
          status: "Needs Review",
          prepared_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
        },
      ],
      selected: {
        id: "takeoff_a",
        measurement_report_id: "MEASURE-A",
        status: "Needs Review",
        prepared_at: "2026-07-11T12:00:00.000Z",
        approved_at: null,
        assumptions: "Waste includes valleys.",
        exclusions: "Deck repairs require separate approval.",
        items_truncated: false,
        items: [
          {
            category: "Shingle",
            item_name: "Architectural shingles",
            quantity: 12.5,
            unit: "squares",
            waste_factor: 12,
            source_ref: "roof_area",
            confidence: "deterministic",
            needs_review: true,
          },
        ],
      },
    },
    quote: {
      id: "quote_a",
      version: 3,
      status: "Needs Review",
      price_book_version: "2026-07-11",
      pricing_effective_at: "2026-07-11T12:00:00.000Z",
      subtotal: 12000,
      tax_amount: 600,
      tax_code: "GST",
      tax_rate: 5,
      quote_total: 12600,
      currency: "CAD",
      deposit_amount: 2500,
      amount_due: 2500,
      amount_paid: 0,
      balance_due: 12600,
      payment_status: "Not Due",
      payment_due_date: null,
      valid_until: "2026-07-25",
      prepared_at: "2026-07-11T12:00:00.000Z",
      approved_at: null,
      accepted_at: null,
      scope_summary: "Replace roof system and flashings.",
      assumptions: "One existing layer.",
      exclusions: "Deck repairs excluded.",
      supersedes: "QUOTE-OLD",
      correction_reason: "Supplier price notice",
    },
    pricing_snapshot: {
      state: "review_required",
      quote_id: "quote_a",
      quote_version: 3,
      price_book_version: "2026-07-11",
      pricing_effective_at: "2026-07-11T12:00:00.000Z",
      valid_until: "2026-07-25",
    },
    quote_revision: {
      state: "prior_quote_missing",
      prior_quote: null,
      delta: null,
    },
    proposal: {
      id: "pack_a",
      quote_id: "QUOTE-A",
      status: "Draft",
      prepared_at: "2026-07-11T12:00:00.000Z",
      approved_at: null,
      signed_at: null,
      assumptions: "One existing layer.",
      exclusions: "Deck repairs excluded.",
    },
    scope_changes: [],
    proposal_readiness: {
      state: "review_required",
      reasons: ["measurement_source_review_required", "takeoff_not_approved", "quote_not_approved"],
    },
    scope_clauses: [
      {
        id: "clause_a",
        type: "Risk",
        title: "Deck condition",
        text: "Hidden deck conditions require evidence and written approval.",
        version: "v2",
        status: "Approved",
        source_ref: "Alberta contract policy",
        customer_visible: true,
        approved_at: "2026-07-11T12:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderWorkbench(session: AuthenticatedSession = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <EstimatorWorkbenchPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("EstimatorWorkbenchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbenchModel());
  });

  it("renders source geometry, takeoff lineage, and versioned commercial truth without write affordances", async () => {
    renderWorkbench();

    await screen.findByRole("heading", { name: "Measurement workbench" });
    expect(screen.getByText("Geometry needs review")).toBeVisible();
    expect(
      screen.getByText(
        /does not verify concealed conditions, substrate condition, access, or field dimensions/i,
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Facet comparison" })).toBeVisible();
    expect(screen.getByText("Architectural shingles")).toBeVisible();
    expect(screen.getAllByText(/POLYGON\[type=Roof\]/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Not customer-ready")).toBeVisible();
    expect(screen.getByText("Deck condition")).toBeVisible();
    expect(screen.getByRole("link", { name: /back to sales/i })).toHaveAttribute("href", "/sales");
    expect(
      screen.queryByRole("button", {
        name: /send|assemble proposal|approve quote|collect payment|change price/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /request draft revision/i })).not.toBeInTheDocument();
  });

  it("shows a source-read failure as unavailable instead of relabeling it as field verified", async () => {
    const model = workbenchModel();
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...model,
      measurements: {
        ...model.measurements,
        selected: {
          ...model.measurements.selected!,
          geometry: {
            ...model.measurements.selected!.geometry,
            state: "unavailable",
            reason: "raw_source_not_found",
            facet_count: 0,
            failed_check_count: 0,
            checks: [],
            facets: [],
            metrics: [],
          },
        },
      },
    });
    renderWorkbench();

    await screen.findByRole("heading", { name: "Measurement workbench" });
    expect(screen.getByText("Source geometry could not be recomputed")).toBeVisible();
    expect(screen.getByText("The retained measurement source was not found.")).toBeVisible();
    expect(screen.queryByText("Geometry recomputed from source file")).not.toBeInTheDocument();
    expect(screen.queryByText(/field verified/i)).not.toBeInTheDocument();
  });

  it("does not present unrelated takeoff or proposal records as a continuous evidence chain", async () => {
    const model = workbenchModel({
      lineage: {
        measurement_to_takeoff: "mismatch",
        quote_to_proposal: "mismatch",
      },
      takeoffs: {
        ...workbenchModel().takeoffs,
        selected: null,
      },
      proposal: null,
    });
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(model);
    renderWorkbench();

    await screen.findByRole("heading", { name: "Measurement workbench" });
    expect(screen.getByText("No takeoff links to this measurement")).toBeVisible();
    expect(screen.getByText("No proposal links to this quote")).toBeVisible();
    expect(
      screen.getByText(
        /1 takeoff record was returned, but none link to the selected measurement report/i,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/proposal records were returned, but none link to the selected quote/i),
    ).toBeVisible();
  });

  it("shows a linked revision and unresolved customer scope decision without offering a repricing control", async () => {
    const base = workbenchModel();
    const priorQuote = {
      ...base.quote!,
      id: "quote_a",
      version: 3,
      quote_total: 12600,
      subtotal: 12000,
      tax_amount: 600,
      deposit_amount: 2500,
      amount_due: 2500,
      balance_due: 12600,
      scope_summary: "Replace roof system and flashings.",
      assumptions: "One existing layer.",
      exclusions: "Deck repairs excluded.",
      price_book_version: "2026-07-11",
      pricing_effective_at: "2026-07-11T12:00:00.000Z",
      supersedes: "QUOTE-OLD",
      correction_reason: null,
    };
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...base,
      quote: {
        ...base.quote!,
        id: "quote_b",
        version: 4,
        status: "Approved",
        quote_total: 13020,
        subtotal: 12400,
        tax_amount: 620,
        deposit_amount: 3000,
        amount_due: 3000,
        balance_due: 13020,
        scope_summary: "Replace roof system, flashings, and one added ridge vent.",
        assumptions: "One existing layer and clear driveway.",
        exclusions: "Deck repairs excluded pending written change order.",
        price_book_version: "2026-07-12",
        pricing_effective_at: "2026-07-12T12:00:00.000Z",
        supersedes: "QUOTE-A",
        correction_reason: "Supplier price notice and revised ridge ventilation scope.",
      },
      pricing_snapshot: {
        ...base.pricing_snapshot,
        state: "recorded",
        quote_id: "quote_b",
        quote_version: 4,
        price_book_version: "2026-07-12",
        pricing_effective_at: "2026-07-12T12:00:00.000Z",
      },
      quote_revision: {
        state: "compared",
        prior_quote: priorQuote,
        delta: {
          subtotal: 400,
          tax_amount: 20,
          quote_total: 420,
          deposit_amount: 500,
          amount_due: 500,
          balance_due: 420,
          price_book_version_changed: true,
          pricing_effective_at_changed: true,
          tax_code_changed: false,
          tax_rate_changed: false,
          currency_changed: false,
          scope_summary_changed: true,
          assumptions_changed: true,
          exclusions_changed: true,
        },
      },
      scope_changes: [
        {
          id: "change_b",
          number: "CO-02",
          version: 1,
          status: "Presented",
          title: "Ridge ventilation addition",
          reason: "Field ventilation condition needs customer decision.",
          scope_delta: "Add ridge vent after written customer approval.",
          quote_link: "selected_quote",
          currency: "CAD",
          subtotal: 400,
          tax_amount: 20,
          total_amount: 420,
          price_book_version: "2026-07-12",
          requested_at: "2026-07-12T10:00:00.000Z",
          approved_at: "2026-07-12T10:30:00.000Z",
          accepted_at: null,
          correction_reason: null,
        },
      ],
      proposal_readiness: {
        state: "blocked",
        reasons: ["scope_change_unresolved"],
      },
    });
    renderWorkbench();

    await screen.findByRole("heading", { name: "Commercial decision rail" });
    expect(screen.getByText("Version comparison")).toBeVisible();
    expect(screen.getByText(/Explicitly linked V3 → V4/i)).toBeVisible();
    expect(screen.getByText("Scope change ledger")).toBeVisible();
    expect(screen.getByText("Ridge ventilation addition")).toBeVisible();
    expect(screen.getByText(/still needs its written customer decision/i)).toBeVisible();
    expect(screen.getByText("Blocked")).toBeVisible();
    expect(screen.getByText(/not a live supplier-price check/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /reprice|refresh price|create quote|send proposal/i }),
    ).not.toBeInTheDocument();
  });

  it("does not ask the BFF for estimator records on a field device", async () => {
    renderWorkbench({ ...ownerSession, user: { ...ownerSession.user, role: "field" as const } });

    expect(await screen.findByText("This work belongs to another role")).toBeVisible();
    expect(loadEstimatorWorkbench).not.toHaveBeenCalled();
  });

  it("opens the isolated draft-revision request only when the BFF grants that action", async () => {
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(
      workbenchModel({
        allowed_actions: ["job.read", "estimator.read", "quote_revision_approval.prepare"],
      }),
    );
    renderWorkbench();

    const request = await screen.findByRole("link", { name: /request draft revision/i });
    expect(request).toHaveAttribute("href", "/estimator/jobs/$jobId/revision");
    expect(
      screen.getByText(
        /does not copy price, tax, scope, payment, approval, acceptance, or customer terms/i,
      ),
    ).toBeVisible();
  });
});
