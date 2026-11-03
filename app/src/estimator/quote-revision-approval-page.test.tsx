import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  estimatorWorkbenchQueryKey,
  officeJobIdentityScope,
  quoteRevisionApprovalDetailQueryKey,
} from "./office-job-identity-query";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadEstimatorWorkbench } from "./estimator-api";
import type { EstimatorWorkbenchResponse } from "./estimator-contracts";
import {
  approveQuoteRevisionApproval,
  loadQuoteRevisionApproval,
  loadQuoteRevisionApprovals,
  newQuoteRevisionApprovalDecisionKey,
  newQuoteRevisionApprovalPrepareKey,
  prepareQuoteRevisionApproval,
  reconcileQuoteRevisionApproval,
  rejectQuoteRevisionApproval,
} from "./quote-revision-approval-api";
import {
  quoteRevisionApprovalMutationResponseSchema,
  type QuoteRevisionApprovalDetailResponse,
  type QuoteRevisionApprovalListResponse,
  type QuoteRevisionApprovalRequest,
} from "./quote-revision-approval-contracts";
import {
  QuoteRevisionApprovalDetailPage,
  QuoteRevisionApprovalPreparePage,
  QuoteRevisionApprovalQueuePage,
} from "./quote-revision-approval-page";

const router = vi.hoisted(() => ({
  params: {} as { jobId?: string; approvalId?: string },
  navigate: vi.fn(),
  real: false,
}));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useParams: () => (router.real ? actual.useParams({ strict: false }) : router.params),
    useNavigate: () => (router.real ? actual.useNavigate() : router.navigate),
  };
});
vi.mock("./estimator-api", () => ({ loadEstimatorWorkbench: vi.fn() }));
vi.mock("./quote-revision-approval-api", () => ({
  approveQuoteRevisionApproval: vi.fn(),
  loadQuoteRevisionApproval: vi.fn(),
  loadQuoteRevisionApprovals: vi.fn(),
  newQuoteRevisionApprovalDecisionKey: vi.fn(),
  newQuoteRevisionApprovalPrepareKey: vi.fn(),
  prepareQuoteRevisionApproval: vi.fn(),
  reconcileQuoteRevisionApproval: vi.fn(),
  rejectQuoteRevisionApproval: vi.fn(),
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
  permissions: ["estimator:read"],
  allowed_actions: ["quote_revision_approval.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-12T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-12T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function request(
  overrides: Partial<QuoteRevisionApprovalRequest> = {},
): QuoteRevisionApprovalRequest {
  return {
    id: "quote-revision-approval:ui-001",
    kind: "quote_revision",
    state: "pending",
    version: 1,
    action: "create_quote_revision_draft",
    roof_job_id: "JOB-A",
    source: {
      customer_quote_id: "QUOTE-A",
      quote_version: 3,
      status: "Needs Review",
      modified: "2026-07-12T12:00:00.000Z",
    },
    target: {
      doctype: "Customer Quote",
      customer_quote_id: "QUOTE-A-V4",
      quote_version: 4,
    },
    correction_reason:
      "Correct the verified measurement source before entering a new commercial version.",
    request_text: "Prepare a blank Draft shell after human review.",
    preview: {
      would_write: false,
      append_only: true,
      target: {
        doctype: "Customer Quote",
        customer_quote_id: "QUOTE-A-V4",
        quote_version: 4,
      },
      source: {
        customer_quote_id: "QUOTE-A",
        quote_version: 3,
        status: "Needs Review",
        modified: "2026-07-12T12:00:00.000Z",
      },
      draft: {
        customer_quote_id: "QUOTE-A-V4",
        quote_version: 4,
        status: "Draft",
        supersedes: "QUOTE-A",
        correction_reason:
          "Correct the verified measurement source before entering a new commercial version.",
      },
      observed_quote_count: 1,
      effects: {
        customer_notified: false,
        commercial_terms_copied: false,
        proposal_sent: false,
        accounting_mutated: false,
      },
    },
    expires_at: "2026-07-12T12:05:00.000Z",
    requested_by: { user_id: "appu_owner", frappe_user: "owner@ironwrapexteriors.com" },
    approved_by: null,
    rejection_reason: null,
    run_id: "run:quote-revision:ui-001",
    hermes_run_id: null,
    outcome: null,
    error_code: null,
    reconciliation: null,
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function listModel(
  approval = request(),
  allowedActions = ["quote_revision_approval.read"],
): QuoteRevisionApprovalListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-12T12:00:00.000Z",
    permissions: ["estimator:read"],
    allowed_actions: allowedActions as QuoteRevisionApprovalListResponse["allowed_actions"],
    approvals: [approval],
  };
}

function detailModel(
  approval = request(),
  allowedActions = ["quote_revision_approval.read"],
): QuoteRevisionApprovalDetailResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-07-12T12:00:00.000Z",
    permissions: ["estimator:read"],
    allowed_actions: allowedActions as QuoteRevisionApprovalDetailResponse["allowed_actions"],
    approval,
    job: null,
  };
}

function workbench(): EstimatorWorkbenchResponse {
  return {
    job: { id: "JOB-A" },
    quote: { id: "QUOTE-A", version: 3, status: "Needs Review" },
    allowed_actions: ["estimator.read", "quote_revision_approval.prepare"],
  } as EstimatorWorkbenchResponse;
}

function renderPage(children: ReactNode, session = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>{children}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe("QuoteRevisionApprovalPages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.real = false;
    router.params = { jobId: "JOB-A", approvalId: "quote-revision-approval:ui-001" };
    vi.mocked(loadQuoteRevisionApprovals).mockResolvedValue(listModel());
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(detailModel());
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue(workbench());
    vi.mocked(newQuoteRevisionApprovalPrepareKey).mockReturnValue(
      "quote-revision-approval:prepare-ui-001",
    );
    vi.mocked(newQuoteRevisionApprovalDecisionKey).mockReturnValue(
      "quote-revision-approval:decision-ui-001",
    );
  });

  const syntheticJob = {
    id: "JOB-A",
    roof_job_id: "JOB-A",
    job_number: "IW-SYNTHETIC-101",
    customer_display_name: "Synthetic Cedar Household",
    address: "Unit 4, 118 Example Way NW, Edmonton, AB",
  };

  it.each(["legacy-first", "opt-in-first"] as const)(
    "keeps a preseeded legacy approval apart from an overlapping identity read (%s)",
    async (order) => {
      const first = request();
      const legacy = detailModel(first);
      const expanded = { ...legacy, job: syntheticJob };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const legacyKey = [
        "quote-revision-approval",
        ownerSession.tenant.id,
        ownerSession.user.id,
        first.id,
      ];
      client.setQueryData(legacyKey, legacy);
      let finishLegacy!: (model: QuoteRevisionApprovalDetailResponse) => void;
      const legacyRead = client.fetchQuery({
        queryKey: legacyKey,
        queryFn: () =>
          new Promise<QuoteRevisionApprovalDetailResponse>((resolve) => {
            finishLegacy = resolve;
          }),
      });
      let finishExpanded!: (model: QuoteRevisionApprovalDetailResponse) => void;
      vi.mocked(loadQuoteRevisionApproval).mockReturnValue(
        new Promise((resolve) => {
          finishExpanded = resolve;
        }),
      );
      render(
        <QueryClientProvider client={client}>
          <SessionProvider session={ownerSession}>
            <QuoteRevisionApprovalDetailPage />
          </SessionProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(loadQuoteRevisionApproval).toHaveBeenCalledTimes(1));
      expect(screen.queryByLabelText("Job identity")).not.toBeInTheDocument();
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
          "Synthetic Cedar Household",
        ),
      );
      if (order === "opt-in-first")
        await act(async () => {
          finishLegacy(legacy);
          await legacyRead;
        });
      expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Cedar Household");
      expect(client.getQueryData(legacyKey)).toEqual(legacy);
      expect(
        client.getQueryData(
          quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), first.id),
        ),
      ).toEqual(expanded);
    },
  );

  it.each(["approval", "user", "tenant", "renewed-session", "authority"] as const)(
    "does not render a late approval identity or grant after a %s change",
    async (change) => {
      const first = request();
      const secondSession: AuthenticatedSession =
        change === "approval"
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
      const secondApproval =
        change === "approval"
          ? request({ id: "quote-revision-approval:synthetic-other", roof_job_id: "JOB-B" })
          : first;
      const second = {
        ...detailModel(secondApproval),
        job: {
          ...syntheticJob,
          id: secondApproval.roof_job_id,
          roof_job_id: secondApproval.roof_job_id,
          customer_display_name: "Synthetic Current Household",
        },
      };
      let finishFirst!: (model: QuoteRevisionApprovalDetailResponse) => void;
      vi.mocked(loadQuoteRevisionApproval)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
        )
        .mockResolvedValue(second);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const tree = (session: AuthenticatedSession) => (
        <QueryClientProvider client={client}>
          <SessionProvider session={session}>
            <QuoteRevisionApprovalDetailPage />
          </SessionProvider>
        </QueryClientProvider>
      );
      const view = render(tree(ownerSession));
      await waitFor(() => expect(loadQuoteRevisionApproval).toHaveBeenCalledTimes(1));
      router.params = { approvalId: secondApproval.id };
      view.rerender(tree(secondSession));
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Current Household",
        ),
      );
      await act(async () => {
        finishFirst({
          ...detailModel(first, [
            "quote_revision_approval.read",
            "quote_revision_approval.approve",
          ]),
          job: syntheticJob,
        });
      });
      expect(screen.getByLabelText("Job identity")).toHaveTextContent(
        "Synthetic Current Household",
      );
      expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
      expect(approveQuoteRevisionApproval).not.toHaveBeenCalled();
      expect(
        client.getQueryData(
          quoteRevisionApprovalDetailQueryKey(
            officeJobIdentityScope(secondSession),
            secondApproval.id,
          ),
        ),
      ).toEqual(second);
    },
  );

  it("uses exactly the workbench representation key for preparation and prefix invalidation", async () => {
    const model = {
      ...workbench(),
      job: syntheticJob,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const key = estimatorWorkbenchQueryKey(officeJobIdentityScope(ownerSession), "JOB-A");
    client.setQueryData(key, model);
    render(
      <QueryClientProvider client={client}>
        <SessionProvider session={ownerSession}>
          <QuoteRevisionApprovalPreparePage />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Ask for a new quote" });
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Cedar Household");
    expect(loadEstimatorWorkbench).not.toHaveBeenCalled();
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["estimator-workbench", ownerSession.tenant.id, ownerSession.user.id, "JOB-A"],
      });
    });
    expect(loadEstimatorWorkbench).toHaveBeenCalledTimes(1);
  });

  it("preserves the bound identity and grants through mutation success and an opted-in refetch", async () => {
    const actual = await vi.importActual<typeof import("./quote-revision-approval-api")>(
      "./quote-revision-approval-api",
    );
    const user = userEvent.setup();
    const first = request();
    const initial = {
      ...detailModel(first, ["quote_revision_approval.read", "quote_revision_approval.reject"]),
      job: syntheticJob,
    };
    const denied = {
      ...first,
      state: "denied" as const,
      version: 2,
      rejection_reason: "Check the exact source first.",
    };
    const refreshed = {
      ...detailModel(denied),
      job: { ...syntheticJob, customer_display_name: "Synthetic Fresh Household" },
    };
    let finishRead!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(initial))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(loadQuoteRevisionApproval).mockImplementation(actual.loadQuoteRevisionApproval);
    vi.mocked(rejectQuoteRevisionApproval).mockResolvedValue({ approval: denied });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), first.id);
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider session={ownerSession}>
          <QuoteRevisionApprovalDetailPage />
        </SessionProvider>
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      await user.click(screen.getByRole("button", { name: "Turn down" }));
      await user.type(
        screen.getByLabelText("Why should we stop this request?"),
        "Check the exact source first.",
      );
      await user.click(screen.getByRole("button", { name: "Turn down request" }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(client.getQueryData<QuoteRevisionApprovalDetailResponse>(key)).toMatchObject({
        job: syntheticJob,
        permissions: initial.permissions,
        allowed_actions: initial.allowed_actions,
        approval: {
          id: first.id,
          roof_job_id: first.roof_job_id,
          state: "denied",
          source: first.source,
          target: first.target,
        },
      });
      for (const [url, options] of fetcher.mock.calls) {
        expect(url).toBe(
          "/api/v1/quote-revision-approvals/quote-revision-approval%3Aui-001?include_job_identity=1",
        );
        expect(options).toMatchObject({
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
      }
      await act(async () => {
        finishRead(Response.json(refreshed));
      });
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Fresh Household",
        ),
      );
      expect(client.getQueryData(key)).toEqual(refreshed);
      expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
      expect(
        client.getQueryData([
          "quote-revision-approval",
          ownerSession.tenant.id,
          ownerSession.user.id,
          first.id,
        ]),
      ).toBeUndefined();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it.each(["success", "error"] as const)(
    "scopes delayed %s feedback and refresh to its originating review with the actual router",
    async (outcome) => {
      router.real = true;
      const user = userEvent.setup();
      const first = request();
      const second = request({ id: "quote-revision-approval:ui-other", roof_job_id: "JOB-B" });
      const actions = ["quote_revision_approval.read", "quote_revision_approval.reject"];
      const secondModel = {
        ...detailModel(second, actions),
        job: {
          ...syntheticJob,
          id: "JOB-B",
          roof_job_id: "JOB-B",
          customer_display_name: "Synthetic Juniper Household",
        },
      };
      let settled = false;
      vi.mocked(loadQuoteRevisionApproval).mockImplementation(async (id) =>
        id === first.id
          ? {
              ...detailModel(settled ? { ...first, state: "denied", version: 2 } : first, actions),
              job: syntheticJob,
            }
          : secondModel,
      );
      let complete!: (value: { approval: QuoteRevisionApprovalRequest }) => void;
      let fail!: (reason: Error) => void;
      vi.mocked(rejectQuoteRevisionApproval).mockReturnValue(
        new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
        }),
      );
      const rootRoute = createRootRoute({ component: Outlet });
      const detailRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/quote-revision-approvals/$approvalId",
        component: QuoteRevisionApprovalDetailPage,
      });
      const liveRouter = createRouter({
        routeTree: rootRoute.addChildren([detailRoute]),
        history: createMemoryHistory({ initialEntries: ["/quote-revision-approvals/" + first.id] }),
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <SessionProvider session={ownerSession}>
            <RouterProvider router={liveRouter} />
          </SessionProvider>
        </QueryClientProvider>,
      );
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      await user.click(screen.getByRole("button", { name: "Turn down" }));
      await user.type(
        screen.getByLabelText("Why should we stop this request?"),
        "Check A's source.",
      );
      await user.click(screen.getByRole("button", { name: "Turn down request" }));
      await waitFor(() => expect(rejectQuoteRevisionApproval).toHaveBeenCalledTimes(1));
      await act(async () => {
        await liveRouter.navigate({
          to: "/quote-revision-approvals/$approvalId",
          params: { approvalId: second.id },
        });
      });
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Juniper Household",
        ),
      );
      const secondReads = vi
        .mocked(loadQuoteRevisionApproval)
        .mock.calls.filter(([id]) => id === second.id).length;
      settled = true;
      await act(async () => {
        outcome === "success"
          ? complete({ approval: { ...first, state: "denied", version: 2 } })
          : fail(new Error("A result unavailable"));
      });
      await waitFor(() =>
        expect(
          client.getQueryData<QuoteRevisionApprovalDetailResponse>(
            quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), first.id),
          )?.approval.state,
        ).toBe("denied"),
      );
      expect(
        screen.queryByText("The request was turned down. No draft was made."),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Check the saved state")).not.toBeInTheDocument();
      expect(screen.queryByText("Load this request again")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Why should we stop this request?")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Job identity")).toHaveTextContent(
        "Synthetic Juniper Household",
      );
      expect(
        client.getQueryData(
          quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), second.id),
        ),
      ).toEqual(secondModel);
      expect(
        vi.mocked(loadQuoteRevisionApproval).mock.calls.filter(([id]) => id === second.id),
      ).toHaveLength(secondReads);
      await user.click(screen.getByRole("button", { name: "Turn down" }));
      expect(screen.getByLabelText("Why should we stop this request?")).toHaveValue("");
    },
  );

  it.each(["A-first", "B-first"] as const)(
    "retains every review's pending guard through A to B to A and completion (%s)",
    async (order) => {
      router.real = true;
      const user = userEvent.setup();
      const first = request();
      const second = request({
        id: "quote-revision-approval:ui-other",
        roof_job_id: "JOB-B",
        source: { ...first.source, customer_quote_id: "QUOTE-B" },
        target: { ...first.target, customer_quote_id: "QUOTE-B-V4" },
        preview: null,
        run_id: "run:quote-revision:ui-other",
      });
      const deniedA = { ...first, state: "denied" as const, version: 2 };
      const executedB = quoteRevisionApprovalMutationResponseSchema.parse({
        approval: {
          ...second,
          state: "executed",
          version: 2,
          hermes_run_id: second.run_id,
          outcome: {
            run_id: second.run_id,
            created: true,
            customer_quote_id: second.target.customer_quote_id,
            quote_version: second.target.quote_version,
            supersedes: second.source.customer_quote_id,
            audit_finalized: true,
            customer_notified: false,
            commercial_terms_copied: false,
            proposal_sent: false,
            accounting_mutated: false,
          },
        },
      });
      const records = new Map([
        [first.id, first],
        [second.id, second],
      ]);
      const actions = [
        "quote_revision_approval.read",
        "quote_revision_approval.approve",
        "quote_revision_approval.reject",
      ];
      vi.mocked(loadQuoteRevisionApproval).mockImplementation(async (id) => ({
        ...detailModel(records.get(id)!, actions),
        job:
          id === first.id
            ? syntheticJob
            : {
                ...syntheticJob,
                id: "JOB-B",
                roof_job_id: "JOB-B",
                customer_display_name: "Synthetic Juniper Household",
              },
      }));
      let finishA!: (value: { approval: QuoteRevisionApprovalRequest }) => void;
      let finishB!: (value: { approval: QuoteRevisionApprovalRequest }) => void;
      vi.mocked(rejectQuoteRevisionApproval).mockReturnValue(
        new Promise((resolve) => {
          finishA = resolve;
        }),
      );
      vi.mocked(approveQuoteRevisionApproval).mockReturnValue(
        new Promise((resolve) => {
          finishB = resolve;
        }),
      );
      const rootRoute = createRootRoute({ component: Outlet });
      const detailRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/quote-revision-approvals/$approvalId",
        component: QuoteRevisionApprovalDetailPage,
      });
      const liveRouter = createRouter({
        routeTree: rootRoute.addChildren([detailRoute]),
        history: createMemoryHistory({ initialEntries: ["/quote-revision-approvals/" + first.id] }),
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <SessionProvider session={ownerSession}>
            <RouterProvider router={liveRouter} />
          </SessionProvider>
        </QueryClientProvider>,
      );
      async function navigateTo(id: string) {
        await act(async () => {
          await liveRouter.navigate({
            to: "/quote-revision-approvals/$approvalId",
            params: { approvalId: id },
          });
        });
      }
      async function assertAStillPending() {
        await navigateTo(first.id);
        await waitFor(() =>
          expect(screen.getByLabelText("Job identity")).toHaveTextContent(
            "Synthetic Cedar Household",
          ),
        );
        const approveA = screen.getByRole("button", { name: "Make empty draft" });
        const rejectA = screen.getByRole("button", { name: "Turn down" });
        expect(approveA).toHaveAttribute("aria-busy", "true");
        expect(approveA).toBeDisabled();
        expect(rejectA).toBeDisabled();
        await user.click(approveA);
        await user.click(rejectA);
        expect(rejectQuoteRevisionApproval).toHaveBeenCalledTimes(1);
        expect(approveQuoteRevisionApproval).toHaveBeenCalledTimes(1);
      }
      try {
        await screen.findByRole("heading", { name: "Review the new empty draft" });
        await user.click(screen.getByRole("button", { name: "Turn down" }));
        await user.type(
          screen.getByLabelText("Why should we stop this request?"),
          "Check A's source.",
        );
        await user.click(screen.getByRole("button", { name: "Turn down request" }));
        await waitFor(() => expect(rejectQuoteRevisionApproval).toHaveBeenCalledTimes(1));
        await act(async () => {
          await liveRouter.navigate({
            to: "/quote-revision-approvals/$approvalId",
            params: { approvalId: second.id },
          });
        });
        await waitFor(() =>
          expect(screen.getByLabelText("Job identity")).toHaveTextContent(
            "Synthetic Juniper Household",
          ),
        );
        const approveB = screen.getByRole("button", { name: "Make empty draft" });
        expect(approveB).not.toHaveAttribute("aria-busy", "true");
        expect(approveB).toBeEnabled();
        expect(screen.getByRole("button", { name: "Turn down" })).toBeEnabled();
        await user.click(approveB);
        await waitFor(() =>
          expect(approveQuoteRevisionApproval).toHaveBeenCalledWith(
            ownerSession,
            second.id,
            second.version,
            "quote-revision-approval:decision-ui-001",
          ),
        );
        expect(approveB).toHaveAttribute("aria-busy", "true");
        expect(approveB).toBeDisabled();
        await assertAStillPending();
        await navigateTo(second.id);
        expect(screen.getByRole("button", { name: "Make empty draft" })).toHaveAttribute(
          "aria-busy",
          "true",
        );
        if (order === "A-first") {
          records.set(first.id, deniedA);
          await act(async () => {
            finishA({ approval: deniedA });
          });
          expect(screen.getByRole("button", { name: "Make empty draft" })).toHaveAttribute(
            "aria-busy",
            "true",
          );
          expect(screen.getByRole("button", { name: "Make empty draft" })).toBeDisabled();
          expect(
            screen.queryByText("The request was turned down. No draft was made."),
          ).not.toBeInTheDocument();
        }
        records.set(second.id, executedB.approval);
        await act(async () => {
          finishB(executedB);
        });
        expect(await screen.findByRole("heading", { name: "Draft is ready" })).toBeVisible();
        if (order === "B-first") {
          await assertAStillPending();
          records.set(first.id, deniedA);
          await act(async () => {
            finishA({ approval: deniedA });
          });
          await navigateTo(second.id);
          expect(screen.getByRole("heading", { name: "Draft is ready" })).toBeVisible();
        }
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Juniper Household",
        );
        expect(
          screen.queryByText("The request was turned down. No draft was made."),
        ).not.toBeInTheDocument();
        expect(
          client.getQueryData<QuoteRevisionApprovalDetailResponse>(
            quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), first.id),
          )?.approval.state,
        ).toBe("denied");
        expect(
          client.getQueryData<QuoteRevisionApprovalDetailResponse>(
            quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(ownerSession), second.id),
          )?.approval.state,
        ).toBe("executed");
      } finally {
        await act(async () => {
          finishA({ approval: deniedA });
          finishB(executedB);
        });
      }
    },
  );

  it.each(["other-identity", "same-identity-new-sign-in"])(
    "does not apply a prior session's delayed choice or refresh under %s",
    async (change) => {
      const user = userEvent.setup();
      const first = request();
      const secondSession =
        change === "other-identity"
          ? {
              ...ownerSession,
              user: { ...ownerSession.user, id: "appu_other_owner" },
              tenant: { ...ownerSession.tenant, id: "synthetic-other-tenant" },
            }
          : { ...ownerSession, csrf_token: "csrf-new-synthetic-sign-in" };
      const second = {
        ...detailModel(first, ["quote_revision_approval.read", "quote_revision_approval.reject"]),
        job: { ...syntheticJob, customer_display_name: "Synthetic Juniper Household" },
      };
      vi.mocked(loadQuoteRevisionApproval)
        .mockResolvedValueOnce({
          ...detailModel(first, ["quote_revision_approval.read", "quote_revision_approval.reject"]),
          job: syntheticJob,
        })
        .mockResolvedValue(second);
      let complete!: (value: { approval: QuoteRevisionApprovalRequest }) => void;
      vi.mocked(rejectQuoteRevisionApproval).mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const tree = (session: AuthenticatedSession) => (
        <QueryClientProvider client={client}>
          <SessionProvider session={session}>
            <QuoteRevisionApprovalDetailPage />
          </SessionProvider>
        </QueryClientProvider>
      );
      const view = render(tree(ownerSession));
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      await user.click(screen.getByRole("button", { name: "Turn down" }));
      await user.type(
        screen.getByLabelText("Why should we stop this request?"),
        "Check A's source.",
      );
      await user.click(screen.getByRole("button", { name: "Turn down request" }));
      await waitFor(() => expect(rejectQuoteRevisionApproval).toHaveBeenCalledTimes(1));
      view.rerender(tree(secondSession));
      await waitFor(() =>
        expect(screen.getByLabelText("Job identity")).toHaveTextContent(
          "Synthetic Juniper Household",
        ),
      );
      const reads = vi.mocked(loadQuoteRevisionApproval).mock.calls.length;
      await act(async () => {
        complete({ approval: { ...first, state: "denied", version: 2 } });
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Turn down" })).toBeEnabled());
      expect(loadQuoteRevisionApproval).toHaveBeenCalledTimes(reads);
      expect(
        screen.queryByText("The request was turned down. No draft was made."),
      ).not.toBeInTheDocument();
      expect(
        client.getQueryData(
          quoteRevisionApprovalDetailQueryKey(officeJobIdentityScope(secondSession), first.id),
        ),
      ).toEqual(second);
    },
  );

  it.each([
    [syntheticJob, "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101"],
    [
      { ...syntheticJob, customer_display_name: null },
      "Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
    ],
    [{ ...syntheticJob, address: null }, "Synthetic Cedar Household · Job IW-SYNTHETIC-101"],
    [{ ...syntheticJob, customer_display_name: null, address: null }, "Job IW-SYNTHETIC-101"],
    [
      { ...syntheticJob, job_number: null },
      "Synthetic Cedar Household · Unit 4, 118 Example Way NW",
    ],
    [
      { ...syntheticJob, customer_display_name: " ", address: "\t", job_number: " " },
      "Job details unavailable",
    ],
    [null, "Job details unavailable"],
  ])(
    "names the exact reviewed job without substituting an internal ID (%j)",
    async (job, expected) => {
      vi.mocked(loadQuoteRevisionApproval).mockResolvedValue({ ...detailModel(), job });
      renderPage(<QuoteRevisionApprovalDetailPage />);
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      const identity = screen.getByLabelText("Job identity");
      expect(identity).toHaveTextContent(expected);
      expect(identity).not.toHaveTextContent("JOB-A");
      expect(identity).not.toHaveTextContent("Edmonton");
      expect(loadEstimatorWorkbench).not.toHaveBeenCalled();
    },
  );

  it("uses the selected estimator job identity on the preparation page", async () => {
    vi.mocked(loadEstimatorWorkbench).mockResolvedValue({
      ...workbench(),
      job: { ...workbench().job, ...syntheticJob },
    });
    renderPage(<QuoteRevisionApprovalPreparePage />);
    await screen.findByRole("heading", { name: "Ask for a new quote" });
    expect(screen.getByLabelText("Job identity")).toHaveTextContent(
      "Synthetic Cedar Household · Unit 4, 118 Example Way NW · Job IW-SYNTHETIC-101",
    );
  });

  it("keeps distinct job identities separate on separate detail reads", async () => {
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValueOnce({
      ...detailModel(),
      job: syntheticJob,
    });
    const first = renderPage(<QuoteRevisionApprovalDetailPage />);
    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Cedar Household");
    first.unmount();
    router.params = { approvalId: "quote-revision-approval:ui-other" };
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValueOnce({
      ...detailModel(request({ id: router.params.approvalId, roof_job_id: "JOB-B" })),
      job: {
        ...syntheticJob,
        id: "JOB-B",
        roof_job_id: "JOB-B",
        customer_display_name: "Synthetic Juniper Household",
        address: "216 Example Lane NW, Edmonton, AB",
        job_number: "IW-SYNTHETIC-102",
      },
    });
    renderPage(<QuoteRevisionApprovalDetailPage />);
    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByLabelText("Job identity")).toHaveTextContent(
      "Synthetic Juniper Household · 216 Example Lane NW · Job IW-SYNTHETIC-102",
    );
    expect(screen.getByLabelText("Job identity")).not.toHaveTextContent(
      "Synthetic Cedar Household",
    );
  });

  it("retains identity after a decision only for the same immutable review binding", async () => {
    const user = userEvent.setup();
    const initial = request();
    vi.mocked(loadQuoteRevisionApproval)
      .mockResolvedValueOnce({
        ...detailModel(initial, ["quote_revision_approval.read", "quote_revision_approval.reject"]),
        job: syntheticJob,
      })
      .mockRejectedValue(new Error("fresh read unavailable"));
    vi.mocked(rejectQuoteRevisionApproval).mockResolvedValue({
      approval: { ...initial, state: "denied", version: 2, rejection_reason: "Check the source." },
    });
    renderPage(<QuoteRevisionApprovalDetailPage />);
    await screen.findByRole("heading", { name: "Review the new empty draft" });
    await user.click(screen.getByRole("button", { name: "Turn down" }));
    await user.type(screen.getByLabelText("Why should we stop this request?"), "Check the source.");
    await user.click(screen.getByRole("button", { name: "Turn down request" }));
    expect(await screen.findByRole("heading", { name: "Turned down" })).toBeVisible();
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Cedar Household");
  });

  it.each(["job", "source", "source-version", "request"])(
    "refuses to bind loaded identity to a decision response with a different %s",
    async (mismatch) => {
      const user = userEvent.setup();
      const initial = request();
      const changed = {
        ...initial,
        state: "denied" as const,
        version: 2,
        preview: null,
        ...(mismatch === "job" ? { roof_job_id: "JOB-B" } : {}),
        ...(mismatch === "request" ? { id: "quote-revision-approval:other" } : {}),
        source: {
          ...initial.source,
          ...(mismatch === "source" ? { customer_quote_id: "QUOTE-B" } : {}),
          ...(mismatch === "source-version" ? { quote_version: 5 } : {}),
        },
      };
      vi.mocked(loadQuoteRevisionApproval)
        .mockResolvedValueOnce({
          ...detailModel(initial, [
            "quote_revision_approval.read",
            "quote_revision_approval.approve",
          ]),
          job: syntheticJob,
        })
        .mockRejectedValue(new Error("fresh read unavailable"));
      vi.mocked(approveQuoteRevisionApproval).mockResolvedValue(
        quoteRevisionApprovalMutationResponseSchema.parse({ approval: changed }),
      );
      renderPage(<QuoteRevisionApprovalDetailPage />);
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      await user.click(screen.getByRole("button", { name: "Make empty draft" }));
      expect(await screen.findByText("Check the saved state")).toBeVisible();
      expect(await screen.findByText("Load this request again")).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Turned down" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Cedar Household");
      expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    },
  );

  it("keeps the dedicated queue on the bounded source-to-blank-Draft decision", async () => {
    const { container } = renderPage(<QuoteRevisionApprovalQueuePage />);

    await screen.findByRole("heading", { name: "Quote change reviews" });
    expect(screen.getByText("Current quote")).toBeVisible();
    expect(screen.getByText("New empty draft")).toBeVisible();
    // A version number never stands in a person's line (ruling).
    expect(document.body.textContent).not.toMatch(/\b[vV][34]\b/);
    expect(screen.getByText(/prices, job details, payments/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /current quote new empty draft/i })).toHaveAttribute(
      "href",
      "/quote-revision-approvals/$approvalId",
    );
    expect(container.textContent).not.toMatch(/dry_run_receipt|write_args_json|quote_total/i);
  });

  it("submits only the source identity and correction reason, then opens its recorded decision", async () => {
    const user = userEvent.setup();
    const prepared = request();
    vi.mocked(prepareQuoteRevisionApproval).mockResolvedValue({ approval: prepared });
    router.params = { jobId: "JOB-A" };
    renderPage(<QuoteRevisionApprovalPreparePage />);

    await screen.findByRole("heading", { name: "Ask for a new quote" });
    await user.type(
      screen.getByLabelText("What is wrong?"),
      "Correct the verified source before the next commercial review.",
    );
    await user.click(screen.getByRole("button", { name: "Send for review" }));

    await waitFor(() => {
      expect(prepareQuoteRevisionApproval).toHaveBeenCalledWith(
        ownerSession,
        {
          roofJobId: "JOB-A",
          customerQuoteId: "QUOTE-A",
          correctionReason: "Correct the verified source before the next commercial review.",
        },
        "quote-revision-approval:prepare-ui-001",
      );
    });
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/quote-revision-approvals/$approvalId",
      params: { approvalId: "quote-revision-approval:ui-001" },
    });
  });

  it("does not infer approval authority from the role when the server omits the decision action", async () => {
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
      detailModel(request(), ["quote_revision_approval.read"]),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the right person/i)).toBeVisible();
  });

  it("fails closed when an uncertain decision cannot be followed by a current read", async () => {
    const user = userEvent.setup();
    vi.mocked(loadQuoteRevisionApproval)
      .mockResolvedValueOnce(
        detailModel(request(), [
          "quote_revision_approval.read",
          "quote_revision_approval.approve",
          "quote_revision_approval.reject",
        ]),
      )
      .mockRejectedValueOnce(new Error("read unavailable"));
    vi.mocked(approveQuoteRevisionApproval).mockRejectedValue(
      new ApiError({
        status: 502,
        code: "execution_uncertain",
        message: "The broker result could not be verified.",
      }),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Review the new empty draft" });
    await user.click(screen.getByRole("button", { name: "Make empty draft" }));

    expect(
      await screen.findByText(/could not tell if the draft was made. do not try again/i),
    ).toBeVisible();
    expect(screen.getByText("Check the saved state")).toBeVisible();
    expect(screen.queryByText("Your choice was not saved")).not.toBeInTheDocument();
    expect(await screen.findByText("Load this request again")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
  });

  it("turns an uncertain broker outcome into reconciliation work without a retry", async () => {
    const user = userEvent.setup();
    const uncertain = request({
      state: "execution_uncertain",
      version: 3,
      approved_by: {
        user_id: "appu_owner",
        frappe_user: "owner@ironwrapexteriors.com",
        approved_at: "2026-07-12T12:01:00.000Z",
      },
      hermes_run_id: "run:quote-revision:ui-001",
      error_code: "broker_response_unverified",
    });
    const reconciled = {
      ...uncertain,
      version: 4,
      reconciliation: {
        at: "2026-07-12T12:02:00.000Z",
        by_user_id: "appu_owner",
        by_frappe_user: "owner@ironwrapexteriors.com",
        outcome: "inconclusive" as const,
        evidence: "The Hermes Run was unavailable; no second Draft shell was issued.",
      },
    };
    vi.mocked(loadQuoteRevisionApproval)
      .mockResolvedValueOnce(
        detailModel(uncertain, [
          "quote_revision_approval.read",
          "quote_revision_approval.reconcile",
        ]),
      )
      .mockResolvedValue(
        detailModel(reconciled, [
          "quote_revision_approval.read",
          "quote_revision_approval.reconcile",
        ]),
      );
    vi.mocked(reconcileQuoteRevisionApproval).mockResolvedValue({ approval: reconciled });
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByText("Do not try this request again")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    await user.type(
      screen.getByLabelText("What did you check?"),
      "The Hermes Run was unavailable; no second Draft shell was issued.",
    );
    await user.click(screen.getByRole("button", { name: "Save result check" }));

    await waitFor(() => {
      expect(reconcileQuoteRevisionApproval).toHaveBeenCalledWith(
        ownerSession,
        "quote-revision-approval:ui-001",
        3,
        "inconclusive",
        "The Hermes Run was unavailable; no second Draft shell was issued.",
      );
    });
    expect(approveQuoteRevisionApproval).not.toHaveBeenCalled();
    expect(rejectQuoteRevisionApproval).not.toHaveBeenCalled();
    expect(await screen.findByText(/result check saved: not sure/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check saved result" })).not.toBeInTheDocument();
  });

  it("keeps system IDs out of the first reading path", async () => {
    const user = userEvent.setup();
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByText("QUOTE-A-V4")).not.toBeVisible();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("QUOTE-A-V4")).toBeVisible();
    expect(screen.getByText("run:quote-revision:ui-001")).toBeVisible();
  });
  it("puts the empty-draft summary before the decision and hides identifiers after it", async () => {
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
      detailModel(request(), ["quote_revision_approval.read", "quote_revision_approval.approve"]),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);

    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Job details unavailable");
    expect(screen.queryByRole("img", { name: "Job JOB-A" })).not.toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "What you are reviewing" });
    const decision = screen.getByRole("complementary", { name: "Decision" });
    const audit = screen.getByText("System details").closest("details")!;
    expect(
      summary.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(decision.compareDocumentPosition(audit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(summary).getByText(request().correction_reason)).toBeVisible();
    expect(within(decision).getByRole("button", { name: "Make empty draft" })).toBeEnabled();
    expect(screen.getAllByText("Needs review")).toHaveLength(1);
    expect(screen.queryByText("How this works")).not.toBeInTheDocument();
    expect(audit).not.toHaveAttribute("open");
  });

  it("focuses the rejection reason and returns focus without making a decision on cancel", async () => {
    const user = userEvent.setup();
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
      detailModel(request(), ["quote_revision_approval.read", "quote_revision_approval.reject"]),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);
    await user.click(await screen.findByRole("button", { name: "Turn down" }));
    expect(screen.getByLabelText("Why should we stop this request?")).toHaveFocus();
    await user.type(screen.getByLabelText("Why should we stop this request?"), "Recheck source.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Turn down" })).toHaveFocus();
    expect(rejectQuoteRevisionApproval).not.toHaveBeenCalled();
    expect(approveQuoteRevisionApproval).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Turn down" }));
    expect(screen.getByLabelText("Why should we stop this request?")).toHaveValue("");
  });

  it("does not describe a planned run ID as proof of a saved result", async () => {
    const user = userEvent.setup();
    vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
      detailModel(request({ state: "execution_uncertain", hermes_run_id: "run:planned" }), [
        "quote_revision_approval.read",
        "quote_revision_approval.reconcile",
      ]),
    );
    renderPage(<QuoteRevisionApprovalDetailPage />);
    await screen.findByRole("heading", { name: "Review the new empty draft" });
    expect(screen.getByText("Check needed")).toBeVisible();
    expect(screen.queryByText("Saved", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Draft is ready" })).not.toBeInTheDocument();
    expect(screen.getByText("run:planned")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    expect(screen.getByLabelText("What happened?")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Check saved result" })).toHaveFocus();
    expect(reconcileQuoteRevisionApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["executing", "Saving the draft"],
    ["executed", "Draft is ready"],
    ["denied", "Turned down"],
    ["expired", "Review ended"],
    ["failed", "Draft not made"],
    ["audit_failed", "Save check failed"],
  ] as const)(
    "keeps the %s outcome in the decision panel without another draft action",
    async (state, heading) => {
      const approval = request({
        state,
        rejection_reason: state === "denied" ? "Verify the source first." : null,
      });
      vi.mocked(loadQuoteRevisionApproval).mockResolvedValue(
        detailModel(approval, [
          "quote_revision_approval.read",
          "quote_revision_approval.approve",
          "quote_revision_approval.reject",
        ]),
      );
      renderPage(<QuoteRevisionApprovalDetailPage />);
      await screen.findByRole("heading", { name: "Review the new empty draft" });
      const decision = within(screen.getByRole("complementary", { name: "Decision" }));
      expect(decision.getByRole("heading", { name: heading })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Turn down" })).not.toBeInTheDocument();
      expect(decision.getByRole("link", { name: "Open quote" })).toBeVisible();
      expect(decision.getByRole("button", { name: "Load again" })).toBeVisible();
      if (state === "denied") expect(decision.getByText("Verify the source first.")).toBeVisible();
    },
  );
});
