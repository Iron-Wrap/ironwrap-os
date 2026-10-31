import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthBoundary } from "../auth/auth-boundary";
import { useSession } from "../auth/session-context";
import { clearSessionSnapshot, type AuthenticatedSession } from "../auth/session";
import { sessionQueryKey } from "../auth/session-query";
import { loadEstimatorWorkbench } from "./estimator-api";
import {
  QuoteRevisionApprovalDetailPage,
  QuoteRevisionApprovalPreparePage,
} from "./quote-revision-approval-page";

// Production AuthBoundary, router, QueryClient, API and mutation hooks remain real. Only HTTP
// transport is synthetic. These regressions preserve the independently reproduced R5 boundary.
import legacyWorkbench from "./estimator-workbench-live-shape.fixture.json";
import authFixture from "./office-job-identity-auth.fixture.json";
// Wire records are deliberately decoded as transport input; production API schemas validate them.
const fixtures = JSON.parse(JSON.stringify({ ...authFixture, legacyWorkbench }));
type Network = (url: URL, init: RequestInit) => Promise<Response> | Response;
let sessionWire: AuthenticatedSession;
let sessionStatus: number;
let network: Network;
let sessions: AuthenticatedSession[];
let requests: { url: URL; init: RequestInit }[];
const clients: QueryClient[] = [];
const clone = <T,>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function makeSession(): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: "synthetic-owner",
      email: "owner@example.invalid",
      display_name: "Synthetic Owner",
      role: "owner",
      frappe_user_id: "owner@example.invalid",
    },
    tenant: {
      id: "synthetic-tenant",
      name: "Synthetic Tenant",
      brand: "Synthetic",
      locale: "en-CA",
      time_zone: "America/Edmonton",
      currency: "CAD",
      office_phone: null,
    },
    permissions: ["estimator:read"],
    allowed_actions: ["quote_revision_approval.read"],
    csrf_token: "synthetic-session-one",
    session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    source_updated_at: null,
    read_model_generated_at: "synthetic-session-read",
    stale_fields: [],
  };
}
function detail(letter = "A", grant = true) {
  const value = clone(fixtures.legacyQuote);
  value.approval.id = `synthetic-review-${letter}`;
  value.approval.roof_job_id = `synthetic-job-${letter}`;
  value.allowed_actions = [
    "quote_revision_approval.read",
    ...(grant ? ["quote_revision_approval.reject", "quote_revision_approval.approve"] : []),
  ];
  value.job = {
    ...fixtures.identity,
    id: value.approval.roof_job_id,
    roof_job_id: value.approval.roof_job_id,
    customer_display_name: `Synthetic Household ${letter}`,
  };
  return value;
}
function workbench(letter = "A") {
  const value = clone(fixtures.legacyWorkbench);
  value.job = {
    ...value.job,
    id: `synthetic-job-${letter}`,
    roof_job_id: `synthetic-job-${letter}`,
    customer_display_name: `Synthetic Household ${letter}`,
    address: "Unit 9, 17 Example Way",
    job_number: `IW-SYNTHETIC-${letter}`,
  };
  value.allowed_actions = [...value.allowed_actions, "quote_revision_approval.prepare"];
  return value;
}
function denied(letter = "A") {
  return {
    approval: {
      ...detail(letter).approval,
      state: "denied",
      version: 2,
      rejection_reason: "Synthetic stop reason.",
    },
  };
}
function SessionProbe() {
  const session = useSession();
  useLayoutEffect(() => {
    sessions.push(session);
  }, [session]);
  return (
    <output data-testid="principal">
      {session.tenant.id}/{session.user.id}
    </output>
  );
}
function mount(path = "/quote-revision-approvals/synthetic-review-A") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => (
      <AuthBoundary>
        <SessionProbe />
        <Outlet />
      </AuthBoundary>
    ),
  });
  const review = createRoute({
    getParentRoute: () => root,
    path: "/quote-revision-approvals/$approvalId",
    component: QuoteRevisionApprovalDetailPage,
  });
  const prepare = createRoute({
    getParentRoute: () => root,
    path: "/estimator/jobs/$jobId/revision",
    component: QuoteRevisionApprovalPreparePage,
  });
  const router = createRouter({
    routeTree: root.addChildren([review, prepare]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router, view };
}
const reads = () =>
  requests.filter(
    (x) => x.init.method === "GET" && x.url.pathname.includes("/quote-revision-approvals/"),
  );
const posts = () => requests.filter((x) => x.init.method === "POST");
const detailQueries = (client: QueryClient) =>
  client.getQueryCache().findAll({ queryKey: ["quote-revision-approval"] });
async function currentIdentity(text = "Synthetic Household A") {
  await waitFor(() => expect(screen.getByLabelText("Job identity")).toHaveTextContent(text));
}
async function sessionRefetch(client: QueryClient) {
  await act(async () => {
    await client.invalidateQueries({ queryKey: sessionQueryKey });
  });
}
async function chooseReject(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Turn down" }));
  await user.type(
    screen.getByLabelText("Why should we stop this request?"),
    "Synthetic stop reason.",
  );
  await user.click(screen.getByRole("button", { name: "Turn down request" }));
}
beforeEach(async () => {
  await clearSessionSnapshot();
  sessionWire = makeSession();
  sessionStatus = 200;
  sessions = [];
  requests = [];
  network = (url) => {
    if (url.pathname.includes("/quote-revision-approvals/"))
      return Response.json(
        detail(decodeURIComponent(url.pathname).includes("synthetic-review-B") ? "B" : "A"),
      );
    if (url.pathname.includes("/estimator/jobs/"))
      return Response.json(workbench(url.pathname.endsWith("B") ? "B" : "A"));
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      requests.push({ url, init });
      if (url.pathname === "/api/v1/session")
        return Response.json(
          sessionStatus === 200 ? clone(sessionWire) : { error: "synthetic_session_refused" },
          { status: sessionStatus },
        );
      return network(url, init);
    }),
  );
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe("independent real AuthBoundary session and representation boundaries", () => {
  it("preserves equal structural-shared auth but rotates same-user renewed credentials and changed authority", async () => {
    const { client } = mount();
    await currentIdentity();
    const original = sessions.at(-1)!;
    const oldKey = detailQueries(client)[0]!.queryKey;
    expect(oldKey.slice(0, 4)).toEqual([
      "quote-revision-approval",
      "synthetic-tenant",
      "synthetic-owner",
      "synthetic-review-A",
    ]);
    expect(oldKey.at(-1)).toBe("job-identity-v1");
    await sessionRefetch(client);
    expect(sessions.at(-1)).toBe(original);
    expect(detailQueries(client)).toHaveLength(1);
    sessionWire = { ...sessionWire, csrf_token: "synthetic-session-two" };
    await sessionRefetch(client);
    await waitFor(() => expect(detailQueries(client)).toHaveLength(2));
    expect(sessions.at(-1)).not.toBe(original);
    const renewalKey = detailQueries(client)[1]!.queryKey;
    expect(renewalKey.slice(0, 4)).toEqual(oldKey.slice(0, 4));
    expect(renewalKey.at(-2)).not.toBe(oldKey.at(-2));
    expect(JSON.stringify(renewalKey)).not.toContain("synthetic-session-two");
    const renewed = sessions.at(-1);
    sessionWire = { ...sessionWire, permissions: [], allowed_actions: [] };
    await sessionRefetch(client);
    await waitFor(() => expect(detailQueries(client)).toHaveLength(3));
    expect(sessions.at(-1)).not.toBe(renewed);
    expect(new Set(detailQueries(client).map((q) => q.queryKey.at(-2))).size).toBe(3);
  });

  it.each([
    "renewal",
    "user",
    "tenant",
    "role",
    "authority",
    "permissions",
    "grants",
    "compatibility-user",
    "expiry",
  ] as const)("rejects a late old GET through actual auth refetch after %s", async (change) => {
    const oldRead = deferred<Response>();
    let readCount = 0;
    network = () => (++readCount === 1 ? oldRead.promise : Response.json(detail("A", false)));
    const { client } = mount();
    await waitFor(() => expect(reads()).toHaveLength(1));
    const oldSession = sessions.at(-1);
    sessionWire = {
      ...sessionWire,
      ...(change === "renewal" ? { csrf_token: "synthetic-session-two" } : {}),
      ...(change === "user" ? { user: { ...sessionWire.user, id: "synthetic-other-owner" } } : {}),
      ...(change === "tenant"
        ? { tenant: { ...sessionWire.tenant, id: "synthetic-other-tenant" } }
        : {}),
      ...(change === "authority" ? { permissions: [], allowed_actions: [] } : {}),
      ...(change === "permissions" ? { permissions: [] } : {}),
      ...(change === "grants" ? { allowed_actions: [] } : {}),
      ...(change === "role" ? { user: { ...sessionWire.user, role: "ops" as const } } : {}),
      ...(change === "compatibility-user"
        ? { user: { ...sessionWire.user, frappe_user_id: "other@example.invalid" } }
        : {}),
      ...(change === "expiry"
        ? { session_expires_at: new Date(Date.now() + 7_200_000).toISOString() }
        : {}),
    };
    await sessionRefetch(client);
    await currentIdentity();
    expect(sessions.at(-1)).not.toBe(oldSession);
    await act(async () => {
      const stale = detail();
      stale.job.customer_display_name = "Synthetic Prior Principal";
      oldRead.resolve(Response.json(stale));
    });
    await waitFor(() =>
      expect(detailQueries(client).every((q) => q.state.fetchStatus === "idle")).toBe(true),
    );
    expect(screen.getByLabelText("Job identity")).not.toHaveTextContent(
      "Synthetic Prior Principal",
    );
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(detailQueries(client)).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    for (const request of reads())
      expect(request.url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
  });

  it("closes the authenticated subtree on a definite session refusal before a pending identity can finish", async () => {
    const held = deferred<Response>();
    network = () => held.promise;
    const { client } = mount();
    await waitFor(() => expect(reads()).toHaveLength(1));
    sessionStatus = 403;
    await sessionRefetch(client);
    await screen.findByRole("heading", { name: "IronWrap OS is not ready" });
    await act(async () => {
      held.resolve(Response.json(detail()));
    });
    await waitFor(() => expect(detailQueries(client)[0]!.state.fetchStatus).toBe("idle"));
    expect(screen.queryByLabelText("Job identity")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("keeps a legacy preseed apart, covers real prefix invalidation and shares the opted-in estimator read with preparation", async () => {
    const { client, router } = mount();
    await currentIdentity();
    const legacy = detail();
    delete legacy.job;
    const legacyKey = [
      "quote-revision-approval",
      "synthetic-tenant",
      "synthetic-owner",
      "synthetic-review-A",
    ];
    client.setQueryData(legacyKey, legacy);
    expect(detailQueries(client)).toHaveLength(2);
    await act(async () => {
      await client.invalidateQueries({ queryKey: legacyKey });
    });
    expect(reads()).toHaveLength(2);
    expect(client.getQueryData(legacyKey)).toEqual(legacy);
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Household A");
    await act(async () => {
      await router.navigate({
        to: "/estimator/jobs/$jobId/revision",
        params: { jobId: "synthetic-job-A" },
      });
    });
    await screen.findByRole("heading", { name: "Ask for a new quote" });
    const estimatorQuery = client.getQueryCache().findAll({
      queryKey: ["estimator-workbench", "synthetic-tenant", "synthetic-owner", "synthetic-job-A"],
    })[0]!;
    expect(estimatorQuery.queryKey.at(-1)).toBe("job-identity-v1");
    const priorFetches = requests.filter((x) => x.url.pathname.includes("/estimator/jobs/")).length;
    const observer = new QueryObserver(client, {
      queryKey: estimatorQuery.queryKey,
      queryFn: () => loadEstimatorWorkbench("synthetic-job-A"),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(client.getQueryCache().findAll({ queryKey: ["estimator-workbench"] })).toHaveLength(1);
    expect(requests.filter((x) => x.url.pathname.includes("/estimator/jobs/"))).toHaveLength(
      priorFetches,
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["estimator-workbench", "synthetic-tenant", "synthetic-owner", "synthetic-job-A"],
      });
    });
    expect(requests.filter((x) => x.url.pathname.includes("/estimator/jobs/"))).toHaveLength(
      priorFetches + 1,
    );
    for (const request of requests.filter((x) => x.url.pathname.includes("/estimator/jobs/")))
      expect(request.url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
    unsubscribe();
  });
});

describe("independent real mutation cache, transport and observer adversaries", () => {
  it("keeps pending duplicate/conflicting decisions, form and feedback under the actor through freshness-only session rechecks", async () => {
    const pending = deferred<Response>();
    let settled = false;
    network = (url, init) => {
      if (init.method === "POST") return pending.promise;
      const letter = url.pathname.includes("synthetic-review-B") ? "B" : "A";
      const model = detail(letter);
      if (settled && letter === "A") model.approval = denied().approval;
      return Response.json(model);
    };
    const user = userEvent.setup();
    const { client, router } = mount();
    await user.click(await screen.findByRole("button", { name: "Turn down" }));
    await user.type(
      screen.getByLabelText("Why should we stop this request?"),
      "Synthetic stop reason.",
    );
    const original = sessions.at(-1)!;
    const originalKey = detailQueries(client)[0]!.queryKey;
    sessionWire = { ...sessionWire, read_model_generated_at: "synthetic-next-ordinary-read" };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(original));
    expect(screen.getByLabelText("Why should we stop this request?")).toHaveValue(
      "Synthetic stop reason.",
    );
    expect(detailQueries(client)).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Turn down request" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const beforePendingClock = sessions.at(-1);
    sessionWire = {
      ...sessionWire,
      read_model_generated_at: "synthetic-another-read",
      source_updated_at: "synthetic-touch-clock",
      stale_fields: ["office_phone.unavailable"],
      user: { ...sessionWire.user, display_name: "Synthetic Updated Label" },
      tenant: { ...sessionWire.tenant, office_phone: "+15555550123" },
    };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(beforePendingClock));
    const confirm = screen.getByRole("button", { name: "Turn down request" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Why should we stop this request?")).toHaveValue(
      "Synthetic stop reason.",
    );
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(posts()).toHaveLength(1);
    expect(detailQueries(client)).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    // Returning to A closes its form but must retain every pending decision's guard. This makes
    // the conflicting approve control present, so actual synchronous clicks can exercise it.
    await act(async () => {
      await router.navigate({
        to: "/quote-revision-approvals/$approvalId",
        params: { approvalId: "synthetic-review-B" },
      });
    });
    await currentIdentity("Synthetic Household B");
    await act(async () => {
      await router.navigate({
        to: "/quote-revision-approvals/$approvalId",
        params: { approvalId: "synthetic-review-A" },
      });
    });
    await currentIdentity();
    const beforeReturnClock = sessions.at(-1),
      beforeReturnReads = reads().length;
    sessionWire = { ...sessionWire, read_model_generated_at: "synthetic-returned-review-clock" };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(beforeReturnClock));
    const approve = screen.getByRole("button", { name: "Make empty draft" });
    expect(approve).toBeDisabled();
    act(() => {
      fireEvent.click(approve);
      fireEvent.click(approve);
    });
    expect(posts()).toHaveLength(1);
    expect(
      client
        .getMutationCache()
        .findAll({ mutationKey: ["quote-revision-approval-decision"], status: "pending" }),
    ).toHaveLength(1);
    expect(reads()).toHaveLength(beforeReturnReads);
    const aQueries = detailQueries(client).filter(
      (query) => query.queryKey[3] === "synthetic-review-A",
    );
    expect(aQueries).toHaveLength(1);
    expect(aQueries[0]!.queryKey).toEqual(originalKey);
    expect(JSON.stringify(originalKey)).not.toContain(original.csrf_token);
    expect(new Headers(posts()[0]!.init.headers).get("X-CSRF-Token")).toBe(original.csrf_token);
    expect(posts()[0]!.url.search).toBe("");
    await act(async () => {
      settled = true;
      pending.resolve(Response.json(denied()));
    });
    await waitFor(() =>
      expect(aQueries[0]!.state.data).toMatchObject({ approval: { state: "denied" } }),
    );
    const beforeFeedbackClock = sessions.at(-1),
      beforeFeedbackReads = reads().length;
    sessionWire = { ...sessionWire, read_model_generated_at: "synthetic-feedback-read" };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(beforeFeedbackClock));
    expect(
      detailQueries(client).filter((query) => query.queryKey[3] === "synthetic-review-A"),
    ).toHaveLength(1);
    expect(reads()).toHaveLength(beforeFeedbackReads);
  });

  it("retains settled success feedback and its read key through an ordinary session recheck", async () => {
    let settled = false;
    network = (_url, init) => {
      if (init.method === "POST") {
        settled = true;
        return Response.json(denied());
      }
      const model = detail();
      if (settled) model.approval = denied().approval;
      return Response.json(model);
    };
    const user = userEvent.setup();
    const { client } = mount();
    await chooseReject(user);
    await screen.findByText("The request was turned down. No draft was made.");
    await waitFor(() => expect(reads()).toHaveLength(2));
    const before = sessions.at(-1),
      key = detailQueries(client)[0]!.queryKey;
    sessionWire = { ...sessionWire, read_model_generated_at: "synthetic-settled-success-clock" };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(before));
    expect(screen.getByText("The request was turned down. No draft was made.")).toBeVisible();
    expect(detailQueries(client)).toHaveLength(1);
    expect(detailQueries(client)[0]!.queryKey).toEqual(key);
    expect(reads()).toHaveLength(2);
    expect(posts()).toHaveLength(1);
  });

  it("retains stale-action refusal and error feedback through a freshness recheck while the originating detail refetch is pending", async () => {
    const fresh = deferred<Response>();
    let count = 0;
    network = (_url, init) =>
      init.method === "POST"
        ? Response.json({ error: "quote_revision_approval_version_conflict" }, { status: 409 })
        : ++count === 1
          ? Response.json(detail())
          : fresh.promise;
    const user = userEvent.setup();
    const { client } = mount();
    await chooseReject(user);
    await screen.findByText("This request changed. Load it again before you choose.");
    await waitFor(() => expect(reads()).toHaveLength(2));
    const beforeErrorClock = sessions.at(-1);
    sessionWire = { ...sessionWire, read_model_generated_at: "synthetic-error-recheck" };
    await sessionRefetch(client);
    await waitFor(() => expect(sessions.at(-1)).not.toBe(beforeErrorClock));
    expect(
      screen.getByText("This request changed. Load it again before you choose."),
    ).toBeVisible();
    expect(screen.getByText("Check the saved state")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(detailQueries(client)).toHaveLength(1);
    expect(reads()).toHaveLength(2);
    expect(posts()).toHaveLength(1);
    await act(async () => {
      fresh.resolve(Response.json(detail("A", false)));
    });
  });

  it("guards two synchronous approve clicks and preserves the exact envelope until the opted-in refetch settles", async () => {
    const mutationResponse = deferred<Response>();
    const freshRead = deferred<Response>();
    let count = 0;
    network = (_url, init) =>
      init.method === "POST"
        ? mutationResponse.promise
        : ++count === 1
          ? Response.json(detail())
          : freshRead.promise;
    const { client } = mount();
    const button = await screen.findByRole("button", { name: "Make empty draft" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(1);
    expect(button).toBeDisabled();
    await act(async () => {
      mutationResponse.resolve(Response.json(denied()));
    });
    await waitFor(() => expect(reads()).toHaveLength(2));
    expect(detailQueries(client)[0]!.state.data).toMatchObject({
      approval: denied().approval,
      job: detail().job,
      permissions: detail().permissions,
      allowed_actions: detail().allowed_actions,
    });
    expect(posts()[0]!.url.search).toBe("");
    expect(JSON.parse(String(posts()[0]!.init.body))).toEqual({ version: 1 });
    expect(reads()[1]!.url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
    await act(async () => {
      const legacy = detail("A", false);
      delete legacy.job;
      legacy.approval = denied().approval;
      freshRead.resolve(Response.json(legacy));
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Job identity")).toHaveTextContent("Job details unavailable"),
    );
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
  });

  it.each(["success", "error"] as const)(
    "blocks duplicate conflicting clicks and discards late %s/refetch after same-user renewal",
    async (outcome) => {
      const pending = deferred<Response>();
      network = (_url, init) =>
        init.method === "POST" ? pending.promise : Response.json(detail());
      const user = userEvent.setup();
      const { client } = mount();
      await chooseReject(user);
      await waitFor(() => expect(posts()).toHaveLength(1));
      const originalKey = detailQueries(client)[0]!.queryKey;
      const originalSession = sessions.at(-1)!;
      sessionWire = { ...sessionWire, csrf_token: "synthetic-session-two" };
      await sessionRefetch(client);
      await currentIdentity();
      await waitFor(() => expect(detailQueries(client)).toHaveLength(2));
      expect(await screen.findByRole("button", { name: "Make empty draft" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Turn down" }));
      const reason = screen.getByLabelText("Why should we stop this request?");
      await user.type(reason, "Current principal reason.");
      const before = reads().length;
      await act(async () => {
        pending.resolve(
          outcome === "success"
            ? Response.json(denied())
            : Response.json(
                { error: { code: "synthetic_denial", message: "Synthetic prior refusal." } },
                { status: 403 },
              ),
        );
      });
      await waitFor(() =>
        expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0),
      );
      expect(reason).toHaveValue("Current principal reason.");
      expect(
        screen.queryByText("The request was turned down. No draft was made."),
      ).not.toBeInTheDocument();
      expect(reads()).toHaveLength(before);
      expect(client.getQueryData(originalKey)).toMatchObject({ approval: { state: "pending" } });
      expect(sessions.at(-1)).not.toBe(originalSession);
      expect(new Headers(posts()[0]!.init.headers).get("X-CSRF-Token")).toBe(
        "synthetic-session-one",
      );
      expect(posts()[0]!.url.search).toBe("");
      expect(JSON.parse(String(posts()[0]!.init.body))).toEqual({
        version: 1,
        reason: "Synthetic stop reason.",
      });
    },
  );

  it("retains all mutation instances when A/B overlap, returns to pending A, and accepts only its opted-in bound refetch", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const settled = new Set<string>();
    network = (url, init) => {
      const letter = url.pathname.includes("synthetic-review-B") ? "B" : "A";
      if (init.method === "POST") return letter === "A" ? a.promise : b.promise;
      const model = detail(letter);
      if (settled.has(letter)) model.approval = denied(letter).approval;
      return Response.json(model);
    };
    const user = userEvent.setup();
    const { client, router } = mount();
    await chooseReject(user);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await act(async () => {
      await router.navigate({
        to: "/quote-revision-approvals/$approvalId",
        params: { approvalId: "synthetic-review-B" },
      });
    });
    await currentIdentity("Synthetic Household B");
    await chooseReject(user);
    await waitFor(() => expect(posts()).toHaveLength(2));
    const both = client
      .getMutationCache()
      .findAll({ mutationKey: ["quote-revision-approval-decision"], status: "pending" });
    expect(both).toHaveLength(2);
    expect((both[0]!.state.variables as any).scope.session).toBe(
      (both[1]!.state.variables as any).scope.session,
    );
    await act(async () => {
      await router.navigate({
        to: "/quote-revision-approvals/$approvalId",
        params: { approvalId: "synthetic-review-A" },
      });
    });
    await currentIdentity();
    const saving = screen.getByRole("button", { name: "Make empty draft" });
    expect(saving).toBeDisabled();
    await act(async () => {
      saving.click();
      saving.click();
    });
    expect(posts()).toHaveLength(2);
    await act(async () => {
      settled.add("B");
      b.resolve(Response.json(denied("B")));
    });
    await waitFor(() =>
      expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: "Make empty draft" })).toBeDisabled();
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Household A");
    await act(async () => {
      settled.add("A");
      a.resolve(Response.json(denied("A")));
    });
    await waitFor(() =>
      expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0),
    );
    await waitFor(() =>
      expect(
        detailQueries(client).find((q) => q.queryKey[3] === "synthetic-review-A")?.state.data,
      ).toMatchObject({
        approval: { state: "denied" },
        job: { customer_display_name: "Synthetic Household A" },
      }),
    );
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    for (const read of reads()) {
      expect(read.url.searchParams.getAll("include_job_identity")).toEqual(["1"]);
      expect(read.init.cache).toBe("no-store");
    }
  });

  it("refuses a mutation response from an incompatible job while preserving current identity and requiring a fresh read", async () => {
    let getCount = 0;
    network = (_url, init) => {
      if (init.method === "POST") {
        const result = denied();
        result.approval.roof_job_id = "synthetic-foreign-job";
        return Response.json(result);
      }
      return ++getCount === 1
        ? Response.json(detail())
        : Response.json({ error: "synthetic_read_unavailable" }, { status: 503 });
    };
    const user = userEvent.setup();
    const { client } = mount();
    await chooseReject(user);
    await screen.findByText(
      "The result did not match this review. Load the saved request before you choose again.",
    );
    expect(screen.getByLabelText("Job identity")).toHaveTextContent("Synthetic Household A");
    expect(screen.queryByRole("button", { name: "Make empty draft" })).not.toBeInTheDocument();
    expect(detailQueries(client)[0]!.state.data).toMatchObject({
      approval: { roof_job_id: "synthetic-job-A", state: "pending" },
    });
    expect(posts()).toHaveLength(1);
  });
});
