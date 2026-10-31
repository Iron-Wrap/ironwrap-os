import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../../auth/session-context";
import { JOB_ID, crews, model, runwayJob, session } from "./gate-test-fixtures";
import { JobGatesPage } from "./job-gates-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const runway = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-10-21T16:45:00.000Z",
  stale_fields: [],
  permissions: ["production:read"],
  allowed_actions: ["production.read"],
  partial_sources: [],
  summary: {
    active_jobs: 1,
    blocked: 1,
    scheduled: 0,
    needs_assignment: 0,
    ready_for_review: 0,
    needs_verification: 0,
  },
  jobs: [runwayJob],
  crews,
};

const history = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-10-21T16:45:00.000Z",
  stale_fields: [],
  permissions: [],
  allowed_actions: [],
  job: {
    id: JOB_ID,
    roof_job_id: JOB_ID,
    job_number: "IW-2041",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "Won",
    address: "118 Larkspur Way NW, Calgary AB T3H 0A1, Canada",
    current_gate_state: null,
  },
  customer: { display_name: "Elena Marchetti", phone: null },
  gates: [],
  proof: { items: [], next_cursor: null },
  openable: true,
  proof_unavailable: false,
};

function page(answers: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const answer = answers[path] ?? { status: 404, body: { error: "not_found" } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session("production")}>
        <JobGatesPage jobId={JOB_ID} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("loading a job's gates", () => {
  it("names the job by its customer and street, from the job's record", async () => {
    page({
      [`/api/v1/production/jobs/${JOB_ID}/gates`]: { status: 200, body: model("open") },
      "/api/v1/production": { status: 200, body: runway },
      [`/api/v1/jobs/${JOB_ID}/history`]: { status: 200, body: history },
    });
    expect(await screen.findAllByText("Elena Marchetti · 118 Larkspur Way NW")).not.toHaveLength(0);
    expect(screen.getByText("0 of 5 gates cleared · 4 blocked · 1 waiting")).toBeVisible();
  });

  it("falls back to the job number when the job's record does not load", async () => {
    page({
      [`/api/v1/production/jobs/${JOB_ID}/gates`]: { status: 200, body: model("unknown") },
      "/api/v1/production": { status: 200, body: runway },
    });
    expect(await screen.findAllByText("IW-2041")).not.toHaveLength(0);
    expect(
      screen.getByText(
        "No one has recorded when the customer received the signed copy of the contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.",
      ),
    ).toBeVisible();
  });

  it("says plainly when the job has no gates", async () => {
    page({
      [`/api/v1/production/jobs/${JOB_ID}/gates`]: {
        status: 404,
        body: { error: "production_gate_job_not_found" },
      },
    });
    expect(
      await screen.findByText(
        "This job has no gates to show. Open it again from the production plan.",
      ),
    ).toBeVisible();
  });

  it("refuses a gates answer that does not match the contract", async () => {
    page({
      [`/api/v1/production/jobs/${JOB_ID}/gates`]: {
        status: 200,
        body: { ...model("open"), surprise: true },
      },
    });
    expect(await screen.findByText("The gates did not load. Nothing was changed.")).toBeVisible();
  });

  it("blocks actions after a cached gate read fails and reloads the current state", async () => {
    const path = `/api/v1/production/jobs/${JOB_ID}/gates`;
    const answers = {
      [path]: { status: 200, body: model("open") as unknown },
      "/api/v1/production": { status: 200, body: runway },
      [`/api/v1/jobs/${JOB_ID}/history`]: { status: 200, body: history },
    };
    const { client } = page(answers);
    expect(await screen.findByRole("link", { name: "Clear Safety" })).toBeVisible();
    answers[path] = { status: 503, body: { error: "unavailable" } };
    await act(() => client.invalidateQueries({ queryKey: ["production-job-gates"] }));
    expect(
      await screen.findByText(
        "The latest gates could not be checked. A change may already be saved. Reload the gates before making another change.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
    answers[path] = { status: 200, body: model("ended") };
    await userEvent.setup().click(screen.getByRole("button", { name: "Load the gates again" }));
    expect(await screen.findByRole("link", { name: "Clear Materials" })).toBeVisible();
  });
});
