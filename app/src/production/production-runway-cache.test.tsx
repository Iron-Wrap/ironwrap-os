import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadProductionRunway } from "./production-api";
import type { ProductionRunwayResponse } from "./production-contracts";
import { ProductionRunwayPage } from "./production-runway-page";

vi.mock("./production-api", () => ({ loadProductionRunway: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
  }) => (
    <a href={to.replace("$jobId", params?.jobId ?? "$jobId")} {...props}>
      {children}
    </a>
  ),
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
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-16T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-16T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const schedulingGateNames = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

function job(
  id: string,
  number: string,
  lane: ProductionRunwayResponse["jobs"][number]["lane"],
): ProductionRunwayResponse["jobs"][number] {
  return {
    id,
    job_number: number,
    customer_display_name: `Synthetic Customer ${id}`,
    address: "2 - 100 Example Street, Example City",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "In Production",
    version: 1,
    assignment:
      lane === "needs_assignment"
        ? null
        : {
            id: `assignment:${id}`,
            type: "Production",
            status: lane === "blocked" ? "Blocked" : "Assigned",
            assignment_version: 1,
            roof_job_version: 1,
            crew_id: "crew:install",
            crew_version: 1,
            scheduled_start: lane === "scheduled" ? "2026-07-17T15:00:00.000Z" : null,
            scheduled_end: null,
          },
    lane,
    scheduling_preparation_allowed: id === "JOB-D",
    next_action:
      lane === "ready_for_review"
        ? "Review for scheduling; this view does not dispatch work"
        : "Review the source-backed operational condition",
    gate_coverage: lane === "needs_verification" ? "incomplete" : "complete",
    gate_summary: {
      expected: 6,
      blocked: lane === "blocked" ? 1 : 0,
      ready: lane === "blocked" ? 0 : 6,
      waived: 0,
      done: 0,
    },
    scheduling_gates: schedulingGateNames.map((name) => ({
      name,
      state: lane === "blocked" && name === "Materials" ? "Blocked" : "Ready",
    })),
    material_attention:
      lane === "blocked" ? [{ status: "Shortage", requested_delivery_date: null }] : [],
  };
}

function model(overrides: Partial<ProductionRunwayResponse> = {}): ProductionRunwayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-16T12:00:00.000Z",
    read_model_generated_at: "2026-07-16T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read"],
    partial_sources: [],
    summary: {
      active_jobs: 5,
      blocked: 1,
      scheduled: 1,
      needs_assignment: 1,
      ready_for_review: 1,
      needs_verification: 1,
    },
    jobs: [
      job("JOB-A", "IW-1001", "blocked"),
      job("JOB-B", "IW-1002", "scheduled"),
      job("JOB-C", "IW-1003", "needs_assignment"),
      job("JOB-D", "IW-1004", "ready_for_review"),
      job("JOB-E", "IW-1005", "needs_verification"),
    ],
    crews: [{ id: "crew:install", name: "Install team", version: 1 }],
    ...overrides,
  };
}

function renderRunway(
  session: AuthenticatedSession = ownerSession,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  strict = false,
) {
  const tree = (current: AuthenticatedSession) => (
    <QueryClientProvider client={client}>
      <SessionProvider session={current}>
        <ProductionRunwayPage />
      </SessionProvider>
    </QueryClientProvider>
  );
  const content = (current: AuthenticatedSession) =>
    strict ? <StrictMode>{tree(current)}</StrictMode> : tree(current);
  const view = render(content(session));
  return {
    ...view,
    client,
    changeSession: (next: AuthenticatedSession) => view.rerender(content(next)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("Production runway cache and session isolation", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadProductionRunway).mockResolvedValue(model());
  });
  it("separates a seeded and later-completing legacy representation with the real QueryClient", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const legacyKey = ["production-runway", ownerSession.tenant.id, ownerSession.user.id];
    const legacy = model({
      jobs: [
        {
          ...job("legacy-job", "IW-LEGACY", "blocked"),
          customer_display_name: "Legacy cached customer",
        },
      ],
    });
    client.setQueryData(legacyKey, legacy);
    const oldRead = deferred<ProductionRunwayResponse>();
    const oldResult = client.fetchQuery({
      queryKey: legacyKey,
      queryFn: () => oldRead.promise,
      staleTime: 0,
    });
    renderRunway(ownerSession, client);

    expect(await screen.findByText("Synthetic Customer JOB-A")).toBeVisible();
    expect(loadProductionRunway).toHaveBeenCalledOnce();
    await act(async () => {
      oldRead.resolve(legacy);
      await oldResult;
    });
    expect(screen.queryByText("Legacy cached customer")).not.toBeInTheDocument();
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(legacyKey);
    expect(
      keys.some(
        (key) =>
          key[0] === "production-runway" &&
          key[1] === ownerSession.tenant.id &&
          key[2] === ownerSession.user.id &&
          key.at(-1) === "job-identity-v1",
      ),
    ).toBe(true);
    expect(client.getQueryData(legacyKey)).toEqual(legacy);
    expect(JSON.stringify(keys)).not.toContain(ownerSession.csrf_token);
  });

  it.each([
    ["user", { ...ownerSession, user: { ...ownerSession.user, id: "appu_other" } }],
    ["tenant", { ...ownerSession, tenant: { ...ownerSession.tenant, id: "tenant-other" } }],
    ["same-user sign-in", { ...ownerSession, csrf_token: "other-session-csrf" }],
    ["session expiry", { ...ownerSession, session_expires_at: "2031-01-01T00:00:00.000Z" }],
    ["role", { ...ownerSession, user: { ...ownerSession.user, role: "production" as const } }],
    ["permission", { ...ownerSession, permissions: ["jobs:read:assigned"] }],
    ["action", { ...ownerSession, allowed_actions: ["production.read"] }],
  ])("never shows a pending identity under a changed %s scope", async (_name, nextSession) => {
    const previous = deferred<ProductionRunwayResponse>();
    let previousSignal: AbortSignal | undefined;
    vi.mocked(loadProductionRunway)
      .mockImplementationOnce((_fetcher, signal) => {
        previousSignal = signal;
        return previous.promise;
      })
      .mockResolvedValueOnce(
        model({
          jobs: [
            {
              ...job("next-job", "IW-NEXT", "blocked"),
              customer_display_name: "Synthetic Next Customer",
            },
          ],
        }),
      );
    const view = renderRunway();
    await waitFor(() => expect(loadProductionRunway).toHaveBeenCalledOnce());
    view.changeSession(nextSession);

    expect(await screen.findByText("Synthetic Next Customer")).toBeVisible();
    expect(previousSignal?.aborted).toBe(true);
    await act(async () => {
      previous.resolve(model());
      await previous.promise;
    });
    expect(screen.queryByText("Synthetic Customer JOB-A")).not.toBeInTheDocument();
    expect(screen.getByText("Synthetic Next Customer")).toBeVisible();
  });

  it.each([401, 403])(
    "removes cached identity and grants after an authority refusal (%s)",
    async (status) => {
      const view = renderRunway();
      expect(await screen.findByText("Synthetic Customer JOB-A")).toBeVisible();
      vi.mocked(loadProductionRunway).mockRejectedValue(
        new ApiError({ status, code: "forbidden", message: "Refused" }),
      );
      await act(async () => {
        await view.client.invalidateQueries({ queryKey: ["production-runway"] });
      });

      expect(await screen.findByRole("heading", { name: "Job plan could not load" })).toBeVisible();
      expect(screen.queryByText("Synthetic Customer JOB-A")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open IW-1001" })).not.toBeInTheDocument();
    },
  );

  it.each([401, 403])(
    "keeps a newer parsed modal after a superseded %s read with abort-aware transport in StrictMode",
    async (status) => {
      const actual = await vi.importActual<typeof import("./production-api")>("./production-api");
      vi.mocked(loadProductionRunway).mockImplementation(actual.loadProductionRunway);
      const reads: { path: string; signal: AbortSignal; resolve: (response: Response) => void }[] =
        [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_path: string, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              const signal = init.signal!;
              signal.addEventListener(
                "abort",
                () =>
                  reject(new DOMException("Synthetic conforming transport abort", "AbortError")),
                { once: true },
              );
              reads.push({ path: _path, signal, resolve });
            }),
        ),
      );
      const view = renderRunway(ownerSession, undefined, true);
      await waitFor(() => expect(reads.some((read) => !read.signal.aborted)).toBe(true));
      await act(async () => {
        reads.at(-1)!.resolve(Response.json(model()));
      });
      await userEvent.click(await screen.findByRole("button", { name: "Find a job" }));
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /IW-1001/ }),
      );

      const before = reads.length;
      void view.client.invalidateQueries({ queryKey: ["production-runway"] });
      await waitFor(() => expect(reads.length).toBeGreaterThan(before));
      const superseded = reads.at(-1)!;
      view.changeSession({ ...ownerSession, csrf_token: "synthetic-new-sign-in" });
      await waitFor(() => expect(reads.at(-1)).not.toBe(superseded));
      expect(superseded.signal.aborted).toBe(true);
      await act(async () => {
        reads
          .at(-1)!
          .resolve(
            Response.json(
              model({
                jobs: [
                  {
                    ...job("current-job", "IW-CURRENT", "blocked"),
                    customer_display_name: "Current Parsed Customer",
                  },
                ],
              }),
            ),
          );
      });
      await userEvent.click(await screen.findByRole("button", { name: "Find a job" }));
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /IW-CURRENT/ }),
      );
      await act(async () => {
        superseded.resolve(Response.json({ error: "forbidden" }, { status }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(within(screen.getByRole("dialog")).getByText("Current Parsed Customer")).toBeVisible();
      expect(screen.queryByText("Synthetic Customer JOB-A")).not.toBeInTheDocument();
      expect(reads.every((read) => read.path === "/api/v1/production?include_job_identity=1")).toBe(
        true,
      );
      expect(
        JSON.stringify(
          view.client
            .getQueryCache()
            .getAll()
            .map((query) => query.queryKey),
        ),
      ).not.toContain("synthetic-new-sign-in");

      const finalCount = reads.length;
      void view.client.invalidateQueries({ queryKey: ["production-runway"] });
      await waitFor(() => expect(reads.length).toBeGreaterThan(finalCount));
      const unmounted = reads.at(-1)!;
      view.unmount();
      expect(unmounted.signal.aborted).toBe(true);
    },
  );
});
