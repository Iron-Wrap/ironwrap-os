import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { resetDatabaseForTests } from "../storage/db";
import { getOutboxActionsNeedingAttention } from "../storage/outbox";
import type { JobResponse } from "./field-contracts";
import { loadJob } from "./field-cache";
import { CheckInPage } from "./field-pages";

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
    <a {...props} href={to === "/jobs/$jobId" && params?.jobId ? `/jobs/${params.jobId}` : to}>
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

// A released work plan is what the server binds field evidence to
// (`workers-bus/migrations/0044_work_package_evidence_slots.sql`). Only a job that has one may
// offer photo capture, so the fixture carries both states explicitly.
const principal = { tenantId: fieldSession.tenant.id, userId: fieldSession.user.id };

function releasedWorkPackage(): NonNullable<JobResponse["packet"]["work_package"]> {
  return {
    id: "WP-1042-v3",
    version: 3,
    status: "Released",
    title: "North slope replacement",
    objective: "Replace the north slope covering.",
    boundaries: "North slope only.",
    prerequisites: "Anchor points inspected.",
    expected_result: "Watertight north slope.",
    stop_conditions: "Wind over 40 km/h.",
    make_safe_procedure: "Clear the drop zone and tie off.",
    issued_at: "2026-07-10T13:00:00.000Z",
    expires_at: "2026-07-11T13:00:00.000Z",
    released_at: "2026-07-10T13:05:00.000Z",
    work_object_type: "Roof Job",
    work_object_id: "roof-job-1",
    physical_context_type: "Roof Site",
    physical_context_id: "site-1",
    release_attempt_id: "RA-1",
    supersession: null,
    acknowledgement: { current_user_acknowledged: false, acknowledged_at: null, workers: [] },
    evidence_slots: [],
    steps: [],
    hold_points: [],
  };
}

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
      current_gate_state: "Ready",
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
    gates: [],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: null,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
    ...overrides,
  };
}

function jobModelWithWorkPackage(): JobResponse {
  const model = jobModel();
  return { ...model, packet: { ...model.packet, work_package: releasedWorkPackage() } };
}

function renderCheckIn(model = jobModel()) {
  vi.mocked(loadJob).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={fieldSession}>
        <CheckInPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("CheckInPage", () => {
  const originalGeolocation = navigator.geolocation;

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: originalGeolocation,
    });
    await resetDatabaseForTests();
  });

  it("puts camera and voice capture ahead of form fields without claiming selected media is saved", async () => {
    const user = userEvent.setup();
    renderCheckIn(jobModelWithWorkPackage());

    expect(await screen.findByRole("heading", { name: "Capture what you see" })).toBeVisible();
    const photoInput = screen.getByLabelText(/Take photos/i);
    await user.upload(
      photoInput,
      new File(["photo"], "roof-condition.jpg", { type: "image/jpeg" }),
    );
    await user.upload(photoInput, new File(["photo"], "roof-edge.jpg", { type: "image/jpeg" }));

    expect(screen.getByText("roof-condition.jpg")).toBeVisible();
    expect(screen.getByText("roof-edge.jpg")).toBeVisible();
    expect(screen.getByText(/2 of 12 items/i)).toBeVisible();
    expect(screen.getByText(/Your files stay in this form until you save them/i)).toBeVisible();
    expect(screen.queryByText(/photos saved for this action/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove roof-condition.jpg" }));
    expect(screen.queryByText("roof-condition.jpg")).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 12 items/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove roof-edge.jpg" }));
    expect(screen.getByText(/No files added/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toHaveClass("min-h-16");
    photoInput.focus();
    expect(photoInput).toHaveFocus();
    expect(photoInput.closest("label")).toHaveClass("focus-within:outline");
    expect(screen.getByLabelText(/Add voice note/i).closest("label")).toHaveClass(
      "focus-within:outline",
    );
  });

  it("makes blocker reporting deliberate and leaves location denial nonfatal", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    renderCheckIn();

    await user.click(await screen.findByRole("button", { name: "Continue to review" }));
    expect(screen.getByRole("heading", { name: "Add job details" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Report a blocker" }));
    expect(screen.getByLabelText("Blocker type")).toBeVisible();
    expect(screen.getByLabelText("What must happen next?")).toBeVisible();

    await user.click(screen.getByText("Add this phone's location (optional)"));
    await user.click(screen.getByRole("button", { name: "Add device location" }));
    expect(screen.getByText("Location is not available on this device.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ELEC-211. A job that is scheduled but not yet planned is the default state right after
  // scheduling, and the server refuses evidence in it. Offering the camera there promises a send
  // that can never happen, which is how a crew member's photos went missing silently.
  it("does not offer photo or voice capture before production issues a work plan, and says why", async () => {
    const user = userEvent.setup();
    renderCheckIn();

    expect(await screen.findByRole("heading", { name: "Say what is happening" })).toBeVisible();
    expect(
      screen.getByText("Photos can be attached once production issues a work plan."),
    ).toBeVisible();
    expect(screen.queryByLabelText(/Take photos/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Add voice note/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Change proof type/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue to review" }));
    await user.click(screen.getByRole("button", { name: "Report a blocker" }));
    expect(
      screen.getByText(
        /This report sends as text\. Photos can be attached once production issues a work plan\./i,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("What must happen next?")).toBeVisible();
  });

  it("sends a note-only blocker report on a job with no work plan", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return Response.json({
        device_action_id: headers.get("X-Device-Action-Id"),
        status: "verified",
        server_ref: "checkin-1",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCheckIn();

    await user.click(await screen.findByRole("button", { name: "Continue to review" }));
    await user.click(screen.getByRole("button", { name: "Report a blocker" }));
    await user.type(
      screen.getByLabelText("What must happen next?"),
      "Shop cannot start: no work plan issued for this roof.",
    );
    await user.click(screen.getByRole("button", { name: "Save on device" }));

    expect(await screen.findByRole("heading", { name: "Check-in saved" })).toBeVisible();
    expect(await screen.findByText("Sent", { exact: true })).toBeVisible();
    const [endpoint, request] = fetchMock.mock.calls.at(-1) ?? [];
    expect(endpoint).toBe("/api/v1/jobs/JOB-1/check-ins");
    const body = request?.body as FormData;
    expect(body.getAll("attachments")).toEqual([]);
    expect(JSON.parse(String(body.get("metadata"))).payload).toMatchObject({
      blocker: true,
      blocker_summary: "Shop cannot start: no work plan issued for this roof.",
    });
    expect(await getOutboxActionsNeedingAttention(principal)).toEqual([]);
  });

  it("moves a terminal refusal out of Waiting and names what to do next", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "field_action_evidence_requires_work_package",
            message: "Evidence requires a released work package.",
          },
          { status: 422 },
        ),
      ),
    );
    renderCheckIn();

    await user.click(await screen.findByRole("button", { name: "Continue to review" }));
    await user.click(screen.getByRole("button", { name: "Report a blocker" }));
    await user.type(screen.getByLabelText("What must happen next?"), "Crew is standing by.");
    await user.click(screen.getByRole("button", { name: "Save on device" }));

    expect(await screen.findByRole("heading", { name: "Check-in needs a check" })).toBeVisible();
    expect(screen.getByText("Needs a check")).toBeVisible();
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Production has not issued a work plan for this job, so files cannot be filed to it.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/Ask production to issue the work plan/i)).toBeVisible();
    const stopped = await getOutboxActionsNeedingAttention(principal);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.lastError).toMatchObject({
      code: "field_action_evidence_requires_work_package",
      status: 422,
    });
  });

  it("requires the server capability as well as the active assignment", async () => {
    renderCheckIn(jobModel({ allowed_actions: [] }));

    expect(await screen.findByRole("heading", { name: "You cannot add a check-in" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Take photos/i })).not.toBeInTheDocument();
  });
});
