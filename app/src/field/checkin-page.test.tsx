import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
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

  afterEach(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: originalGeolocation,
    });
  });

  it("puts camera and voice capture ahead of form fields without claiming selected media is saved", async () => {
    const user = userEvent.setup();
    renderCheckIn();

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
    expect(
      screen.getByText(
        /Selected media remains internal. It is only in this form until device save/i,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/photos saved for this action/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove roof-condition.jpg" }));
    expect(screen.queryByText("roof-condition.jpg")).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 12 items/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove roof-edge.jpg" }));
    expect(screen.getByText(/No media selected/i)).toBeVisible();
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
    expect(screen.getByRole("heading", { name: "Record the condition" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Report a blocker" }));
    expect(screen.getByLabelText("Blocker type")).toBeVisible();
    expect(screen.getByLabelText("What must happen next?")).toBeVisible();

    await user.click(screen.getByText("Add device location (optional)"));
    await user.click(screen.getByRole("button", { name: "Add device location" }));
    expect(screen.getByText("Location is not available on this device.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires the server capability as well as the active assignment", async () => {
    renderCheckIn(jobModel({ allowed_actions: [] }));

    expect(
      await screen.findByRole("heading", { name: "Field capture is not permitted" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Take photos/i })).not.toBeInTheDocument();
  });
});
