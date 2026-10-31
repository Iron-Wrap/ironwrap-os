import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { productionRunwayResponseSchema } from "./production-contracts";
import { ProductionRunwayPage } from "./production-runway-page";

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

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_refusal_synthetic",
    email: "owner@example.invalid",
    display_name: "Synthetic Owner",
    role: "owner",
    frappe_user_id: "owner@example.invalid",
  },
  tenant: {
    id: "synthetic-refusal",
    name: "Synthetic Tenant",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any", "production:read"],
  allowed_actions: ["production.read"],
  csrf_token: "synthetic-refusal-csrf",
  session_expires_at: "2030-07-16T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-16T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function model(customer = "Previously Authorized Customer", clearAllowed = true) {
  return productionRunwayResponseSchema.parse({
    version: 1,
    source_updated_at: "2026-07-16T12:00:00.000Z",
    read_model_generated_at: "2026-07-16T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["production.read", ...(clearAllowed ? ["production_gate.clear"] : [])],
    partial_sources: [],
    summary: {
      active_jobs: 1,
      blocked: 1,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [
      {
        id: "native-job:synthetic-refusal",
        job_number: "IW-SYNTH-REFUSAL",
        customer_display_name: customer,
        address: "100 Synthetic Example Street",
        brand: "IronWrap Exteriors",
        service_type: "Roofing",
        status: "In Production",
        version: 1,
        assignment: null,
        scheduling_preparation_allowed: false,
        lane: "blocked",
        next_action: "Check the stored issue",
        gate_coverage: "complete",
        gate_summary: { expected: 6, blocked: 1, ready: 5, waived: 0, done: 0 },
        scheduling_gates: ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map(
          (name) => ({ name, state: name === "Materials" ? "Blocked" : "Ready" }),
        ),
        material_attention: [],
      },
    ],
    crews: [],
  });
}

async function flushObserver() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Production authority refusal remains effective through unsuccessful retries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([401, 403])(
    "requires a fresh successful read after %s before showing identity or grants again",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(model()));
      vi.stubGlobal("fetch", fetcher);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const legacyKey = ["production-runway", session.tenant.id, session.user.id];
      client.setQueryData(legacyKey, { legacySentinel: true });
      render(
        <QueryClientProvider client={client}>
          <SessionProvider session={session}>
            <ProductionRunwayPage />
          </SessionProvider>
        </QueryClientProvider>,
      );
      expect(await screen.findByText("Previously Authorized Customer")).toBeVisible();
      expect(screen.getByText("1 lock still blocks this schedule")).toBeVisible();

      fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status }));
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["production-runway"] });
      });
      expect(await screen.findByRole("heading", { name: "Job plan could not load" })).toBeVisible();
      await flushObserver();

      const hidden = () => {
        expect(screen.queryByText("Previously Authorized Customer")).not.toBeInTheDocument();
        expect(screen.queryByText("100 Synthetic Example Street")).not.toBeInTheDocument();
        expect(screen.queryByText("1 lock still blocks this schedule")).not.toBeInTheDocument();
        expect(
          screen.queryByRole("link", { name: "Open IW-SYNTH-REFUSAL" }),
        ).not.toBeInTheDocument();
      };
      hidden();
      const updatedQuery = () =>
        client
          .getQueryCache()
          .getAll()
          .find((query) => query.queryKey.at(-1) === "job-identity-v1")!;
      let rejectPending!: (reason: unknown) => void;
      fetcher.mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectPending = reject;
          }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Load again" }));
      await waitFor(() => expect(updatedQuery().state.fetchStatus).toBe("fetching"));
      await flushObserver();
      hidden();
      await act(async () => {
        rejectPending(new TypeError("Synthetic offline transport"));
      });
      await waitFor(() =>
        expect((updatedQuery().state.error as ApiError)?.code).toBe("network_error"),
      );
      await flushObserver();
      hidden();

      for (const [code, response] of [
        ["invalid_response", Response.json({ version: 1, unexpected: true })],
        ["server_unavailable", Response.json({ error: "server_unavailable" }, { status: 503 })],
      ] as const) {
        fetcher.mockResolvedValueOnce(response);
        await userEvent.click(screen.getByRole("button", { name: "Load again" }));
        await waitFor(() => expect((updatedQuery().state.error as ApiError)?.code).toBe(code));
        await flushObserver();
        hidden();
      }

      fetcher.mockResolvedValueOnce(Response.json(model("Freshly Authorized Customer", false)));
      await userEvent.click(screen.getByRole("button", { name: "Load again" }));
      expect(await screen.findByText("Freshly Authorized Customer")).toBeVisible();
      expect(screen.queryByText("Previously Authorized Customer")).not.toBeInTheDocument();
      expect(screen.queryByText("1 lock still blocks this schedule")).not.toBeInTheDocument();
      expect(client.getQueryData(legacyKey)).toEqual({ legacySentinel: true });
      expect(fetcher.mock.calls.map(([path]) => path)).toEqual(
        Array(6).fill("/api/v1/production?include_job_identity=1"),
      );
    },
  );
});
