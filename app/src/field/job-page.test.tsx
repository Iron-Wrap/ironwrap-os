import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import type { JobResponse } from "./field-contracts";
import { loadJob } from "./field-cache";
import { JobPage } from "./field-pages";

vi.mock("./field-cache", () => ({
  hasCachedJobPacket: vi.fn(),
  loadJob: vi.fn(),
  loadProofPage: vi.fn(),
  loadToday: vi.fn(),
  prefetchAssignedPackets: vi.fn(),
}));

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
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={
        to === "/jobs/$jobId" && params?.jobId
          ? `/jobs/${params.jobId}`
          : to === "/check-in/$jobId" && params?.jobId
            ? `/check-in/${params.jobId}`
            : to
      }
    >
      {children}
    </a>
  ),
  useParams: () => ({ jobId: "JOB-1" }),
}));

const fieldSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "crew@example.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function jobModel(overrides: Partial<JobResponse> = {}): JobResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T12:00:00.000Z",
    read_model_generated_at: "2026-07-10T12:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    job: {
      id: "JOB-1",
      roof_job_id: "roof-job-1",
      job_number: "IW-1042",
      brand: "IronWrap Exteriors",
      service_type: "Roofing",
      status: "In Production",
      address: "123 Example Avenue, Calgary, AB",
      current_gate_state: "Blocked",
    },
    assignment: {
      id: "ASSIGN-1",
      assignment_id: "assignment-1",
      type: "Production",
      status: "Assigned",
      crew_profile: null,
      scheduled_start: "2026-07-10T16:00:00.000Z",
      scheduled_end: null,
      blocker_reason: null,
    },
    gates: [
      {
        id: "GATE-1",
        name: "Materials",
        state: "Blocked",
        blocker_reason: "Delivery confirmation is missing",
        owner: "Production dispatch",
        due_at: "2026-07-10T17:00:00.000Z",
      },
    ],
    packet: {
      scope_clauses: [
        {
          id: "SCOPE-1",
          type: "Scope",
          title: "Replace shingles",
          text: "North slope",
          version: "1",
        },
      ],
      measurements: [
        {
          id: "MEASURE-1",
          provider: "RoofRuler",
          review_status: "Reviewed",
          parsed_at: "2026-07-10T15:00:00.000Z",
        },
      ],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: {
        id: "SAFETY-1",
        version: 2,
        status: "Ready",
        effective_date: "2026-07-10",
        hazard_summary: "Steep-slope fall exposure",
        controls: "Use roof anchors and harnesses",
        emergency_plan: "Call dispatch and emergency services",
        ppe_requirements: "Harness and eye protection",
        weather_limits: "Stop above plan wind limit",
      },
      contact: {
        display_name: "Jamie Homeowner",
        phone: "+14035550123",
        access_instructions: null,
      },
    },
    proof_stream: [
      {
        id: "PROOF-1",
        type: "Photo",
        proof_slot: "Production",
        occurred_at: "2026-07-10T15:30:00.000Z",
        summary: "Arrival condition",
        customer_safe: false,
        source: "field_checkin",
        sync_state: "Verified",
        blocker: true,
      },
    ],
    proof_page: { next_cursor: "100", page_size: 100 },
    required_proof: [
      {
        id: "GATE-1",
        slot: "Materials",
        label: "Materials proof",
        state: "Blocked",
        blocker_reason: "Delivery confirmation is missing",
      },
    ],
    ...overrides,
  };
}

function renderJob(model = jobModel(), session = fieldSession) {
  vi.mocked(loadJob).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <JobPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("JobPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns a blocked gate into a work lock while preserving the permitted blocker-capture path", async () => {
    renderJob();

    expect(await screen.findByRole("heading", { name: "Work status" })).toBeVisible();
    expect(screen.getByText("1 gate blocks scheduled work")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveAttribute(
      "href",
      "/check-in/JOB-1",
    );
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveClass("min-h-16");
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveClass("fixed");
    expect(screen.queryByText("Gate owner: Production dispatch")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Proof obligations" })).not.toBeInTheDocument();
  });

  it("surfaces safety detail as read-only context and keeps proof provenance visible", async () => {
    renderJob();

    expect(await screen.findByText("Safety plan · v2")).toBeVisible();
    expect(screen.getByText("Steep-slope fall exposure")).toBeVisible();
    expect(screen.getByText("Use roof anchors and harnesses")).toBeVisible();
    expect(screen.getByText(/field_checkin · Internal/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /acknowledge|clear work|override/i }),
    ).not.toBeInTheDocument();
  });

  it("requires both the server capability and an active assignment before showing capture", async () => {
    const noAssignment = jobModel({ assignment: null, allowed_actions: [] });
    renderJob(noAssignment);

    expect(
      await screen.findByRole("heading", { name: "Active assignment required" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /Capture .*proof/i })).not.toBeInTheDocument();
  });

  it("labels cached data as an offline packet and suppresses older-proof loading", async () => {
    renderJob(jobModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByText(/Offline packet from/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load older proof" })).not.toBeInTheDocument();
  });
});
