import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadCapabilitySignal } from "../capabilities/capability-api";
import { capabilitySignal, officeCapability } from "../capabilities/capability-test-fixture";
import {
  createFacetLaunch,
  loadEstimatorWorkbench,
  navigateToFacetLaunch,
  newFacetLaunchKey,
} from "./estimator-api";
import type { EstimatorWorkbenchResponse } from "./estimator-contracts";
import { EstimatorWorkbenchPage } from "./estimator-workbench-page";
import { estimatorWorkbenchQueryKey, officeJobIdentityScope } from "./office-job-identity-query";
import { loadManualMeasurements } from "./manual-measurement-api";

const workbenchParams = vi.hoisted(() => ({ jobId: "JOB-A" }));

const manualSearch = vi.hoisted(() => ({ measurementRequest: undefined as string | undefined }));

vi.mock("../capabilities/capability-api", () => ({ loadCapabilitySignal: vi.fn() }));
vi.mock("./manual-measurement-api", () => ({
  loadManualMeasurements: vi.fn(),
  recordManualMeasurement: vi.fn(),
  newManualMeasurementRequestId: vi.fn(),
}));
vi.mock("./estimator-api", () => ({
  createFacetLaunch: vi.fn(),
  loadEstimatorWorkbench: vi.fn(),
  navigateToFacetLaunch: vi.fn(),
  newFacetLaunchKey: vi.fn(() => "facet-launch:ui-stable-0001"),
}));
vi.mock("../portal/customer-portal-office-access", () => ({
  CustomerPortalOfficeAccess: ({ roofJobId }: { roofJobId: string }) => (
    <div data-testid="customer-portal-office-access">{roofJobId}</div>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => workbenchParams,
  useSearch: () => manualSearch,
  useNavigate: () => vi.fn(),
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
      customer_display_name: null,
      address: null,
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
        roof_graph: null,
      },
    },
    visual_model: {
      provider: "Roof capture provider",
      model_state: "needs_review",
      confidence: 82,
      review_required: true,
      approval_recorded: false,
      captured_at: "2026-07-11T12:00:00.000Z",
      approved_at: null,
      measurement_link: "selected_measurement",
      preview: {
        state: "not_recorded",
        url: null,
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
    insurance_supplements: [],
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

function openReviewGroup(name: "Roof details" | "Materials and insurance") {
  fireEvent.click(screen.getByText(name));
}

function openCommercialGroup(name: "Customer quote" | "Proposal" | "Scope and risks") {
  fireEvent.click(screen.getByRole("heading", { name }).closest("summary")!);
}

describe("EstimatorWorkbenchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manualSearch.measurementRequest = undefined;
    workbenchParams.jobId = "JOB-A";
    // The default is an empty capability list: `facet_launch` is not visible to this role, so
    // every other test in this file sees exactly the behaviour it saw before the signal existed.
    vi.mocked(loadCapabilitySignal).mockResolvedValue(capabilitySignal("owner", []));
    vi.mocked(newFacetLaunchKey).mockReturnValue("facet-launch:ui-stable-0001");
    vi.mocked(createFacetLaunch).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2027-01-15T08:00:00.000Z",
      permissions: ["facet:launch"],
      allowed_actions: ["facet_launch.create"],
      launch: {
        facet_project_id: "11111111-1111-4111-8111-111111111111",
        launch_url: `https://facet.example.invalid/#iwlaunch=${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(43)}`,
        expires_at: "2027-01-15T08:10:00.000Z",
        state: "issued",
      },
    });
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbenchModel());
    vi.mocked(loadManualMeasurements).mockImplementation(async (_job, options) => ({
      version: 1,
      tenant_id: "ironwrap",
      read_model_generated_at: "2026-07-11T12:00:00.000Z",
      job: { id: "JOB-A", version: 1, job_number: "IW-1001" },
      allowed_actions: [],
      observation_head: null,
      areas: [],
      history: { items: [], next_before: null },
      requested_request_id: options?.requestId ?? null,
      receipt: null,
    }));
  });

  it.each(["legacy-first", "opt-in-first"] as const)(
    "separates a preseeded legacy cache and overlapping requests (%s)",
    async (order) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const legacyKey = [
        "estimator-workbench",
        ownerSession.tenant.id,
        ownerSession.user.id,
        "JOB-A",
      ];
      const legacy = workbenchModel({
        job: {
          ...workbenchModel().job,
          customer_display_name: null,
          address: null,
          job_number: "IW-LEGACY",
        },
      });
      const expanded = workbenchModel({
        job: { ...workbenchModel().job, customer_display_name: "Synthetic Current Household" },
      });
      client.setQueryData(legacyKey, legacy);
      let finishLegacy!: (model: EstimatorWorkbenchResponse) => void;
      const legacyRead = client.fetchQuery({
        queryKey: legacyKey,
        queryFn: () =>
          new Promise<EstimatorWorkbenchResponse>((resolve) => {
            finishLegacy = resolve;
          }),
      });
      let finishExpanded!: (model: EstimatorWorkbenchResponse) => void;
      vi.mocked(loadEstimatorWorkbench).mockReturnValue(
        new Promise((resolve) => {
          finishExpanded = resolve;
        }),
      );
      render(
        <QueryClientProvider client={client}>
          <SessionProvider session={ownerSession}>
            <EstimatorWorkbenchPage />
          </SessionProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(loadEstimatorWorkbench).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(/IW-LEGACY/)).not.toBeInTheDocument();
      if (order === "legacy-first")
        await act(async () => {
          finishLegacy(legacy);
          await legacyRead;
        });
      await act(async () => {
        finishExpanded(expanded);
      });
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Current Household",
        ),
      );
      if (order === "opt-in-first")
        await act(async () => {
          finishLegacy(legacy);
          await legacyRead;
        });
      expect(screen.getByLabelText("Job identity")).toHaveTextContent(
        "Synthetic Current Household",
      );
      expect(client.getQueryData(legacyKey)).toEqual(legacy);
      expect(
        client.getQueryData(
          estimatorWorkbenchQueryKey(officeJobIdentityScope(ownerSession), "JOB-A"),
        ),
      ).toEqual(expanded);
    },
  );

  it.each(["job", "user", "tenant", "renewed-session", "authority"] as const)(
    "keeps a pending workbench read under its original %s scope",
    async (change) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const secondSession: AuthenticatedSession =
        change === "job"
          ? ownerSession
          : {
              ...ownerSession,
              ...(change === "user"
                ? { user: { ...ownerSession.user, id: "appu_synthetic_other" } }
                : {}),
              ...(change === "tenant"
                ? { tenant: { ...ownerSession.tenant, id: "synthetic-other" } }
                : {}),
              ...(change === "renewed-session" ? { csrf_token: "synthetic-renewed-csrf" } : {}),
              ...(change === "authority" ? { allowed_actions: [] } : {}),
            };
      const secondId = change === "job" ? "JOB-B" : "JOB-A";
      const first = workbenchModel({
        job: { ...workbenchModel().job, customer_display_name: "Synthetic Prior Household" },
      });
      const second = workbenchModel({
        job: {
          ...workbenchModel().job,
          id: secondId,
          roof_job_id: secondId,
          customer_display_name: "Synthetic Current Household",
        },
        allowed_actions: [],
      });
      let finishFirst!: (model: EstimatorWorkbenchResponse) => void;
      vi.mocked(loadEstimatorWorkbench)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
        )
        .mockResolvedValue(second);
      const tree = (session: AuthenticatedSession) => (
        <QueryClientProvider client={client}>
          <SessionProvider session={session}>
            <EstimatorWorkbenchPage />
          </SessionProvider>
        </QueryClientProvider>
      );
      const view = render(tree(ownerSession));
      await waitFor(() => expect(loadEstimatorWorkbench).toHaveBeenCalledTimes(1));
      workbenchParams.jobId = secondId;
      view.rerender(tree(secondSession));
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Current Household",
        ),
      );
      await act(async () => {
        finishFirst(first);
      });
      expect(screen.getByLabelText("Job identity")).toHaveTextContent(
        "Synthetic Current Household",
      );
      expect(screen.queryByText(/Synthetic Prior Household/)).not.toBeInTheDocument();
      expect(
        client.getQueryData(
          estimatorWorkbenchQueryKey(officeJobIdentityScope(secondSession), secondId),
        ),
      ).toEqual(second);
    },
  );

  it.each([
    [
      "Synthetic Cedar Household",
      "118 Example Way NW, Edmonton, AB",
      "IW-SYNTHETIC-101",
      "Synthetic Cedar Household · 118 Example Way NW · Job IW-SYNTHETIC-101",
    ],
    [
      "Synthetic Juniper Household",
      "Unit 4, 216 Example Lane NW, Edmonton, AB",
      "IW-SYNTHETIC-102",
      "Synthetic Juniper Household · Unit 4, 216 Example Lane NW · Job IW-SYNTHETIC-102",
    ],
    [null, "118 Example Way NW, Edmonton, AB", null, "118 Example Way NW"],
    ["Synthetic Cedar Household", null, null, "Synthetic Cedar Household"],
    [null, null, "IW-SYNTHETIC-101", "Job IW-SYNTHETIC-101"],
    [" ", "\t", " ", "Job details unavailable"],
    [null, null, null, "Job details unavailable"],
  ])(
    "names the workbench from only its returned identity (%s, %s, %s)",
    async (customer, address, code, expected) => {
      const model = workbenchModel();
      vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
        ...model,
        job: { ...model.job, customer_display_name: customer, address, job_number: code },
      });
      renderWorkbench();
      await screen.findByRole("heading", { name: "Roof and quote review" });
      const identity = screen.getByLabelText("Job identity");
      expect(identity).toHaveTextContent(expected);
      expect(identity).not.toHaveTextContent("JOB-A");
      expect(identity).not.toHaveTextContent("roof_job_a");
      expect(identity).not.toHaveTextContent("Edmonton");
      expect(screen.getByRole("link", { name: "See what needs review" })).toHaveAttribute(
        "href",
        "#proposal-readiness-heading",
      );
    },
  );

  it("reveals manual recovery when a numberless job is reopened with a receipt link", async () => {
    manualSearch.measurementRequest = "manual-measurement:11111111-1111-4111-8111-111111111111";
    const model = workbenchModel();
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...model,
      job: { ...model.job, job_number: null },
    });
    renderWorkbench();
    await screen.findByRole("heading", { name: "Roof and quote review" });
    expect(screen.getByText("Roof details", { exact: true }).closest("details")).toHaveAttribute(
      "open",
    );
    expect(await screen.findByRole("button", { name: "Check saved observation" })).toBeVisible();
    expect(loadManualMeasurements).toHaveBeenCalledWith("JOB-A", {
      requestId: manualSearch.measurementRequest,
    });
  });

  it("renders source geometry, takeoff lineage, and versioned commercial truth without write affordances", async () => {
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    openReviewGroup("Materials and insurance");
    openCommercialGroup("Scope and risks");
    expect(screen.getByText("Roof math needs review")).toBeVisible();
    expect(
      screen.getByText(/do not confirm hidden damage, deck condition, access, or site size/i),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Roof face check" })).toBeVisible();
    expect(screen.getByText("Architectural shingles")).toBeVisible();
    expect(screen.getAllByText(/POLYGON\[type=Roof\]/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Not customer-ready")).toBeVisible();
    expect(screen.getByText("Deck condition")).toBeVisible();
    expect(screen.getByTestId("customer-portal-office-access")).toHaveTextContent("JOB-A");
    expect(screen.getByRole("link", { name: /back to sales/i })).toHaveAttribute("href", "/sales");
    expect(
      screen.queryByRole("button", {
        name: /send|assemble proposal|approve quote|collect payment|change price/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /request draft revision/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Insurance supplement evidence" }),
    ).not.toBeInTheDocument();
  });

  it("puts the next safe step and selected commercial record ahead of dense evidence", async () => {
    renderWorkbench();

    const nextStep = await screen.findByRole("heading", { name: "Next step" });
    const commercial = screen.getByRole("heading", { name: "Quote at a glance" });
    const measurement = screen.getByRole("heading", { name: "Roof measurements" });

    expect(screen.getByText("Review the roof and quote")).toBeVisible();
    expect(screen.getByText("Quote total")).toBeVisible();
    // A quote is told apart by when it was made, never by a version number (ruling).
    expect(screen.getAllByText("Prepared")[0]).toBeVisible();
    expect(nextStep.compareDocumentPosition(commercial) & 4).toBeTruthy();
    expect(commercial.compareDocumentPosition(measurement) & 4).toBeTruthy();
  });

  it.each([
    ["blocked", "See blocked items", "proposal-readiness-heading"],
    ["review_required", "See what needs review", "proposal-readiness-heading"],
    ["ready", "Open proposal details", "proposal-heading"],
    ["unavailable", "Open saved details", "review-workspace-heading"],
  ] as const)(
    "opens the existing read section for %s without approving it",
    async (state, label, id) => {
      const model = workbenchModel();
      vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
        ...model,
        proposal_readiness: { ...model.proposal_readiness, state },
      });
      renderWorkbench();

      const nextStep = await screen.findByRole("region", { name: "Next step" });
      const action = within(nextStep).getByRole("link", { name: label });
      expect(action).toHaveAttribute("href", `#${id}`);
      const proposal = screen.getByRole("heading", { name: "Proposal" }).closest("details")!;
      expect(proposal).not.toHaveAttribute("open");

      fireEvent.click(action);

      const target = document.getElementById(id)!;
      expect(target).toBeVisible();
      expect(target).toHaveFocus();
      if (state !== "unavailable") expect(proposal).toHaveAttribute("open");
      expect(createFacetLaunch).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: /approve quote|send proposal/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps source tables semantic and leaves static geometry notices out of the live region", async () => {
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    openReviewGroup("Materials and insurance");
    const facetTable = screen.getByRole("table", { name: /roof faces with saved area/i });
    const takeoffTable = screen.getByRole("table", { name: /materials with amount/i });

    expect(within(facetTable).getByRole("rowheader", { name: "F1" })).toBeVisible();
    expect(
      within(takeoffTable).getByRole("rowheader", { name: /architectural shingles/i }),
    ).toBeVisible();
    expect(screen.getByText("Roof math needs review").closest("[role=status]")).toBeNull();
  });

  it("collapses secondary audit detail when the returned evidence has no review signal", async () => {
    const base = workbenchModel();
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...base,
      measurements: {
        ...base.measurements,
        selected: {
          ...base.measurements.selected!,
          metrics: base.measurements.selected!.metrics.map((metric) => ({
            ...metric,
            needs_review: false,
          })),
          geometry: {
            ...base.measurements.selected!.geometry,
            state: "recomputed",
            failed_check_count: 0,
            checks: base.measurements.selected!.geometry.checks.map((check) => ({
              ...check,
              ok: true,
            })),
          },
        },
      },
      takeoffs: {
        ...base.takeoffs,
        selected: {
          ...base.takeoffs.selected!,
          items: base.takeoffs.selected!.items.map((item) => ({ ...item, needs_review: false })),
        },
      },
    });
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    openReviewGroup("Materials and insurance");
    expect(screen.getByText("Roof face details").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Roof value details").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Material details").closest("details")).not.toHaveAttribute("open");
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

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    expect(screen.getByText("Roof math could not be checked")).toBeVisible();
    expect(screen.getByText("The saved roof file was not found.")).toBeVisible();
    expect(screen.queryByText("Roof math checked from the file")).not.toBeInTheDocument();
    expect(screen.queryByText(/field verified/i)).not.toBeInTheDocument();
  });

  it("renders a safe visual evidence preview with provenance but no model controls", async () => {
    const base = workbenchModel();
    const visual = {
      ...base.visual_model!,
      model_state: "approved" as const,
      review_required: false,
      approval_recorded: true,
      approved_at: "2026-07-11T12:30:00.000Z",
      preview: {
        state: "available" as const,
        url: "https://preview.ironwrap.example/roof-a.webp?signature=allowed",
      },
      model_uri: "https://private.example/models/roof-a",
      raw_key: "raw/visual/private-model.json",
    } as unknown as NonNullable<EstimatorWorkbenchResponse["visual_model"]>;
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbenchModel({ visual_model: visual }));
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    screen.getByRole("heading", { name: "Property drawing" });
    expect(screen.getByText("Drawing approved")).toBeVisible();
    expect(screen.getByText("Linked to this roof data")).toBeVisible();
    expect(screen.getByText("82%")).toBeVisible();
    const preview = screen.getByRole("img", { name: "Saved property drawing" });
    expect(preview).toHaveAttribute(
      "src",
      "https://preview.ironwrap.example/roof-a.webp?signature=allowed",
    );
    expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.queryByText("https://private.example/models/roof-a")).not.toBeInTheDocument();
    expect(screen.queryByText("raw/visual/private-model.json")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve|publish|open model|change visual/i }),
    ).not.toBeInTheDocument();
  });

  it("renders source roof facets as read-only selectable graph evidence", async () => {
    const base = workbenchModel();
    const roofGraph = {
      state: "needs_review" as const,
      revision: "roof-graph-r3",
      source: "RoofRuler report",
      provider: "RoofRuler",
      confidence: 87,
      review_status: "Needs Review" as const,
      captured_at: "2026-07-11T12:00:00.000Z",
      units: "ft",
      points: [
        { id: "P1", x: 0, y: 0 },
        { id: "P2", x: 12, y: 0 },
        { id: "P3", x: 12, y: 8 },
        { id: "P4", x: 0, y: 8 },
        { id: "P5", x: 18, y: 4 },
      ],
      edges: [
        { id: "E1", start_point_id: "P1", end_point_id: "P2" },
        { id: "E2", start_point_id: "P2", end_point_id: "P3" },
        { id: "E3", start_point_id: "P3", end_point_id: "P4" },
        { id: "E4", start_point_id: "P4", end_point_id: "P1" },
        { id: "E5", start_point_id: "P2", end_point_id: "P5" },
        { id: "E6", start_point_id: "P5", end_point_id: "P3" },
      ],
      facets: [
        {
          id: "F1",
          label: "Front plane",
          point_ids: ["P1", "P2", "P3", "P4"],
          confidence: 92,
          review_status: "Approved" as const,
        },
        {
          id: "F2",
          label: "Rear plane",
          point_ids: ["P2", "P5", "P3"],
          confidence: 74,
          review_status: "Needs Review" as const,
        },
      ],
      check_count: 6,
      failed_check_count: 1,
      raw_key: "private/roof-graph.json",
    } as unknown as NonNullable<
      NonNullable<EstimatorWorkbenchResponse["measurements"]["selected"]>["roof_graph"]
    >;
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...base,
      measurements: {
        ...base.measurements,
        selected: {
          ...base.measurements.selected!,
          roof_graph: roofGraph,
        },
      },
    });
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    screen.getByRole("heading", { name: "Roof shape drawing" });
    expect(screen.getByText("RoofRuler report")).toBeVisible();
    expect(screen.getByText("roof-graph-r3")).toBeVisible();
    expect(screen.getByText("87%")).toBeVisible();
    expect(screen.getByText(/drawing came from the saved roof file/i)).toBeVisible();
    expect(screen.queryByText("private/roof-graph.json")).not.toBeInTheDocument();

    const graph = screen.getByRole("group", { name: "Roof shape drawing" });
    const frontPlane = within(graph).getByRole("button", { name: /select roof face front plane/i });
    const rearPlane = within(graph).getByRole("button", { name: /select roof face rear plane/i });
    expect(rearPlane).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(frontPlane);
    expect(frontPlane).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Selected roof face: Front plane")).toBeVisible();
    fireEvent.keyDown(rearPlane, { key: "Enter" });
    expect(rearPlane).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Selected roof face: Rear plane")).toBeVisible();
  });

  it("keeps blocked or unapproved visual evidence useful without rendering its URL", async () => {
    const base = workbenchModel();
    const visual = {
      ...base.visual_model!,
      model_state: "needs_review" as const,
      review_required: true,
      approval_recorded: false,
      measurement_link: "other_measurement" as const,
      preview: { state: "blocked" as const, url: null },
      screenshots_json: "https://blocked.example/roof.webp",
    } as unknown as NonNullable<EstimatorWorkbenchResponse["visual_model"]>;
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbenchModel({ visual_model: visual }));
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Roof details");
    screen.getByRole("heading", { name: "Property drawing" });
    expect(screen.getByText("Drawing needs review")).toBeVisible();
    expect(screen.getByText("Linked to other roof data")).toBeVisible();
    expect(screen.getByText("Image blocked")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Saved property drawing" })).not.toBeInTheDocument();
    expect(screen.queryByText("https://blocked.example/roof.webp")).not.toBeInTheDocument();
  });

  it("shows the restricted insurance evidence lane without claim details or write controls", async () => {
    const restrictedSupplement = {
      presentation_key: "insurance-supplement-1",
      version: 1,
      status: "Ready for Human Review",
      measurement_state: "review_required",
      evidence_roles: ["Carrier Scope", "Code/Manufacturer", "Photo", "Invoice"],
      missing_requirements: ["approved_measurement"],
      invoice_state: "recorded",
      approval_recorded: false,
      submission_recorded: false,
      carrier_response_recorded: false,
      closed_recorded: false,
      claim_reference: "private-claim-reference",
      carrier_name: "private-carrier-name",
    } as unknown as EstimatorWorkbenchResponse["insurance_supplements"][number];
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(
      workbenchModel({ insurance_supplements: [restrictedSupplement] }),
    );
    renderWorkbench();

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Materials and insurance");
    screen.getByRole("heading", { name: "Insurance proof" });
    expect(screen.getByText("Carrier Scope · Code/Manufacturer · Photo · Invoice")).toBeVisible();
    expect(screen.getByText("Link an approved roof report.")).toBeVisible();
    expect(screen.getByText(/only shows saved proof/i)).toBeVisible();
    expect(screen.queryByText("private-claim-reference")).not.toBeInTheDocument();
    expect(screen.queryByText("private-carrier-name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit|carrier|coverage|approve supplement/i }),
    ).not.toBeInTheDocument();
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

    await screen.findByRole("heading", { name: "Roof and quote review" });
    openReviewGroup("Materials and insurance");
    openCommercialGroup("Proposal");
    expect(screen.getByText("No proposal links to this quote")).toBeVisible();
    expect(
      screen.getByText(/1 material list was found, but none use this roof report/i),
    ).toBeVisible();
    expect(screen.getByText(/proposals were found, but none use this quote/i)).toBeVisible();
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

    await screen.findByRole("heading", { name: "What needs review" });
    openCommercialGroup("Customer quote");
    openCommercialGroup("Proposal");
    openCommercialGroup("Scope and risks");
    expect(screen.getByText("Quote changes")).toBeVisible();
    expect(screen.getByText(/Compared with the earlier quote/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bV[34]\b/);
    expect(screen.getByText("Job changes")).toBeVisible();
    expect(screen.getByText("Ridge ventilation addition")).toBeVisible();
    expect(screen.getByText(/still needs the customer's written choice/i)).toBeVisible();
    expect(screen.getAllByText("Blocked")[0]).toBeVisible();
    expect(screen.getByText(/not a live supplier price/i)).toBeVisible();
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
      screen.getByText(/price, tax, scope, payment, approvals, and customer terms are not copied/i),
    ).toBeVisible();
  });

  it("opens the exact signed Facet launch only when the BFF grants that action", async () => {
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(
      workbenchModel({
        allowed_actions: ["job.read", "estimator.read", "facet_launch.create"],
      }),
    );
    renderWorkbench();

    fireEvent.click(await screen.findByRole("button", { name: "Design in Facet" }));
    await waitFor(() =>
      expect(createFacetLaunch).toHaveBeenCalledWith(
        "JOB-A",
        "csrf",
        "facet-launch:ui-stable-0001",
      ),
    );
    expect(navigateToFacetLaunch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/does not send the address, price, scope, proposal, payment/i),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /request draft revision/i })).not.toBeInTheDocument();
  });

  // The permission says this role MAY launch. The capability says whether launching can work at
  // all — `facet_launch` is `unconfigured` in the reference deployment, with no static route
  // naming this tenant — and before this the button was live either way and failed after the tap
  // (ELEC-236 AC3).
  it("stops offering the Facet launch when the capability behind it is not configured", async () => {
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(
      workbenchModel({
        allowed_actions: ["job.read", "estimator.read", "facet_launch.create"],
      }),
    );
    vi.mocked(loadCapabilitySignal).mockResolvedValue(
      capabilitySignal("owner", [
        officeCapability("facet_launch", "Facet design launch", {
          state: "unconfigured",
          reason: "configuration_incomplete",
          flag_state: "on",
          configuration_state: "incomplete",
          missing_configuration: ["FACET_LAUNCH_STATIC_ROUTES_JSON"],
        }),
      ]),
    );
    renderWorkbench();

    // Wait on the panel, not the button: the button renders before the capability read settles,
    // and asserting on it first would pass or fail on timing rather than on the state.
    expect(
      await screen.findByRole("heading", { name: "Facet design launch is not set up yet" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Design in Facet" })).toBeDisabled();
    expect(createFacetLaunch).not.toHaveBeenCalled();
  });

  it("keeps a failed Facet launch retry on the same idempotency key", async () => {
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(
      workbenchModel({
        allowed_actions: ["job.read", "estimator.read", "facet_launch.create"],
      }),
    );
    vi.mocked(createFacetLaunch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        version: 1,
        read_model_generated_at: "2027-01-15T08:00:00.000Z",
        permissions: ["facet:launch"],
        allowed_actions: ["facet_launch.create"],
        launch: {
          facet_project_id: "11111111-1111-4111-8111-111111111111",
          launch_url: `https://facet.example.invalid/#iwlaunch=${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(43)}`,
          expires_at: "2027-01-15T08:10:00.000Z",
          state: "issued",
        },
      });
    renderWorkbench();

    const button = await screen.findByRole("button", { name: "Design in Facet" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not change the quote/i);
    fireEvent.click(button);
    await waitFor(() => expect(createFacetLaunch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createFacetLaunch).mock.calls.map((call) => call[2])).toEqual([
      "facet-launch:ui-stable-0001",
      "facet-launch:ui-stable-0001",
    ]);
  });
});
