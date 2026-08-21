import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import {
  loadProductionRunway,
  newProductionScheduleKey,
  scheduleProductionJob,
} from "./production-api";
import type { ProductionRunwayResponse } from "./production-contracts";
import { ProductionScheduleApprovalPreparePage } from "./production-schedule-approval-page";

const router = vi.hoisted(() => ({ params: { jobId: "JOB-A" } as { jobId?: string } }));

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
  useParams: () => router.params,
}));
vi.mock("./production-api", () => ({
  loadProductionRunway: vi.fn(),
  newProductionScheduleKey: vi.fn(),
  scheduleProductionJob: vi.fn(),
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
  allowed_actions: ["job.read", "production.read", "operating_job_assignment.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-17T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-17T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function job(
  overrides: Partial<ProductionRunwayResponse["jobs"][number]> = {},
): ProductionRunwayResponse["jobs"][number] {
  return {
    id: "JOB-A",
    job_number: "IW-1001",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "In Production",
    version: 5,
    assignment: {
      id: "assignment:current",
      type: "Production",
      status: "Assigned",
      assignment_version: 2,
      roof_job_version: 5,
      crew_id: "crew:metal-1",
      crew_version: 7,
      scheduled_start: "2026-07-18T15:00:00.000Z",
      scheduled_end: null,
    },
    scheduling_preparation_allowed: true,
    lane: "scheduled",
    next_action: "Review the current native schedule.",
    gate_coverage: "complete",
    gate_summary: { expected: 6, blocked: 0, ready: 6, waived: 0, done: 0 },
    scheduling_gates: [
      { name: "Deposit", state: "Ready" },
      { name: "Materials", state: "Ready" },
      { name: "Safety", state: "Ready" },
      { name: "Access", state: "Ready" },
      { name: "Weather", state: "Ready" },
      { name: "Crew", state: "Ready" },
    ],
    material_attention: [],
    ...overrides,
  };
}

function model(overrides: Partial<ProductionRunwayResponse> = {}): ProductionRunwayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-17T12:00:00.000Z",
    read_model_generated_at: "2026-07-17T12:00:01.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: ["job.read", "production.read", "operating_job_assignment.create"],
    partial_sources: [],
    summary: {
      active_jobs: 1,
      blocked: 0,
      scheduled: 1,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [job()],
    crews: [
      { id: "crew:metal-1", name: "Metal crew one", version: 7 },
      { id: "crew:roof-2", name: "Roof crew two", version: 4 },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={ownerSession}>
        <ProductionScheduleApprovalPreparePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("ProductionScheduleApprovalPreparePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.params = { jobId: "JOB-A" };
    vi.mocked(loadProductionRunway).mockResolvedValue(model());
    vi.mocked(newProductionScheduleKey).mockReturnValue("operating-job-assignment:schedule-ui-001");
  });

  it("records the exact native schedule with optimistic versions", async () => {
    const user = userEvent.setup();
    vi.mocked(scheduleProductionJob).mockResolvedValue({ assignment: {} } as never);
    renderPage();

    await screen.findByRole("heading", { name: "Schedule production job" });
    await user.selectOptions(screen.getByLabelText("Crew"), "crew:roof-2");
    fireEvent.change(screen.getByLabelText("Scheduled start"), {
      target: { value: "2026-07-20T09:30" },
    });
    fireEvent.change(screen.getByLabelText("Scheduled end (optional)"), {
      target: { value: "2026-07-20T16:30" },
    });
    await user.type(
      await screen.findByLabelText("Correction reason"),
      "Weather moved the install window.",
    );
    await user.click(screen.getByRole("button", { name: "Record schedule" }));

    await waitFor(() => {
      expect(scheduleProductionJob).toHaveBeenCalledWith(
        ownerSession,
        {
          roofJobId: "JOB-A",
          expectedRoofJobVersion: 5,
          crewId: "crew:roof-2",
          expectedCrewVersion: 4,
          scheduledStart: new Date("2026-07-20T09:30").toISOString(),
          scheduledEnd: new Date("2026-07-20T16:30").toISOString(),
          supersedesAssignmentId: "assignment:current",
          correctionReason: "Weather moved the install window.",
        },
        "operating-job-assignment:schedule-ui-001",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(/schedule recorded/i);
    expect(document.body.textContent).not.toMatch(
      /dry_run_receipt|approval_receipt|write_args_json|tool_name|site_id/i,
    );
  });

  it("fails closed when the current production read omits the native action", async () => {
    vi.mocked(loadProductionRunway).mockResolvedValue(
      model({ allowed_actions: ["job.read", "production.read"] }),
    );
    renderPage();

    await screen.findByRole("heading", { name: "Scheduling is not available" });
    expect(screen.queryByRole("button", { name: "Record schedule" })).not.toBeInTheDocument();
    expect(scheduleProductionJob).not.toHaveBeenCalled();
  });

  it("fails closed when no bounded active crew list is available", async () => {
    vi.mocked(loadProductionRunway).mockResolvedValue(model({ crews: [] }));
    renderPage();

    await screen.findByRole("heading", { name: "No active crew profile is available" });
    expect(screen.queryByLabelText("Crew")).not.toBeInTheDocument();
    expect(scheduleProductionJob).not.toHaveBeenCalled();
  });
});
