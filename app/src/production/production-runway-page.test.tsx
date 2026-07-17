import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
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
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read", "production.read", "production_schedule_approval.prepare"],
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
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "In Production",
    assignment:
      lane === "needs_assignment"
        ? null
        : {
            id: `assignment:${id}`,
            type: "Production",
            status: lane === "blocked" ? "Blocked" : "Assigned",
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
    allowed_actions: ["job.read", "production.read", "production_schedule_approval.prepare"],
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
    crews: [{ id: "crew:install", name: "Install team" }],
    ...overrides,
  };
}

function renderRunway() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={ownerSession}>
        <ProductionRunwayPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("ProductionRunwayPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadProductionRunway).mockResolvedValue(model());
  });

  it("keeps the runway read-only and links only eligible jobs to a schedule request", async () => {
    renderRunway();

    await screen.findByRole("heading", { name: "Production runway" });
    expect(screen.getByText(/does not schedule, dispatch, or alter a job/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ready to review" })).toBeVisible();
    expect(screen.getByText("Material attention: Shortage.")).toBeVisible();
    expect(screen.getAllByText("Scheduling locks").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Deposit: Ready").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Completion:/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Completion is reviewed at closeout/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open IW-1001" })).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(
      screen.getByRole("link", { name: "Prepare schedule request for IW-1004" }),
    ).toHaveAttribute("href", "/production/schedule/JOB-D");
    expect(
      screen.queryByRole("link", { name: "Prepare schedule request for IW-1001" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule|dispatch/i })).not.toBeInTheDocument();
  });

  it("makes incomplete source coverage explicit", async () => {
    vi.mocked(loadProductionRunway).mockResolvedValue(
      model({
        partial_sources: ["gate_states"],
        stale_fields: ["jobs.partial_sources", "jobs.gate_coverage"],
      }),
    );
    renderRunway();

    await screen.findByRole("heading", { name: "Production runway" });
    expect(screen.getByRole("heading", { name: "Source boundary needs review" })).toBeVisible();
    expect(screen.getByText(/Limited source: gate states/i)).toBeVisible();
    expect(screen.getByText(/does not infer missing gates/i)).toBeVisible();
  });
});
