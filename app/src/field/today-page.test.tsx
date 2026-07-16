import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import type { TodayResponse } from "./field-contracts";
import { hasCachedJobPacket, loadToday, prefetchAssignedPackets } from "./field-cache";
import { TodayPage } from "./field-pages";

vi.mock("./field-cache", () => ({
  hasCachedJobPacket: vi.fn(),
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
  useParams: () => ({}),
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

function todayModel(overrides: Partial<TodayResponse> = {}): TodayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T12:00:00.000Z",
    read_model_generated_at: "2026-07-10T12:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    date: "2026-07-10",
    jobs: [
      {
        id: "JOB-BLOCKED",
        job_number: "IW-1042",
        brand: "IronWrap Exteriors",
        status: "In Production",
        address: "123 Example Avenue, Calgary, AB",
        scheduled_start: "2026-07-10T16:00:00.000Z",
        scheduled_end: null,
        blocked_gate_count: 1,
        next_action: "Delivery confirmation is missing",
        assignment: {
          id: "ASSIGN-1",
          assignment_id: "assignment_1",
          type: "Production",
          status: "Assigned",
          crew_profile: null,
          scheduled_start: "2026-07-10T16:00:00.000Z",
          scheduled_end: null,
          blocker_reason: null,
        },
      },
      {
        id: "JOB-NEXT",
        job_number: "IW-1048",
        brand: "IronWrap Exteriors",
        status: "In Production",
        address: "456 Example Road, Airdrie, AB",
        scheduled_start: "2026-07-10T18:30:00.000Z",
        scheduled_end: null,
        blocked_gate_count: 0,
        next_action: "Open field check-in",
        assignment: {
          id: "ASSIGN-2",
          assignment_id: "assignment_2",
          type: "Production",
          status: "Assigned",
          crew_profile: null,
          scheduled_start: "2026-07-10T18:30:00.000Z",
          scheduled_end: null,
          blocker_reason: null,
        },
      },
    ],
    ...overrides,
  };
}

function renderToday(model = todayModel()) {
  vi.mocked(loadToday).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={fieldSession}>
        <TodayPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("TodayPage", () => {
  const originalOnline = navigator.onLine;

  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(hasCachedJobPacket).mockResolvedValue(true);
    vi.mocked(prefetchAssignedPackets).mockResolvedValue({});
  });

  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
    vi.restoreAllMocks();
  });

  it("turns assigned work into a truthful run sheet with a distinct blocked-work action", async () => {
    renderToday();

    expect(await screen.findByRole("heading", { name: "Run sheet" })).toBeVisible();
    expect(screen.getByText("1 gate blocks work")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getAllByText("Saved on this device").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Review gate and packet" })).toHaveAttribute(
      "href",
      "/jobs/JOB-BLOCKED",
    );
    expect(screen.getByRole("link", { name: "Open job packet" })).toHaveAttribute(
      "href",
      "/jobs/JOB-NEXT",
    );
    expect(screen.getAllByText(/10:00/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Ready offline")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs download")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Start work/i })).not.toBeInTheDocument();
  });

  it("keeps availability in checking state until the local packet probe resolves", async () => {
    let resolvePacket: ((value: boolean) => void) | undefined;
    vi.mocked(hasCachedJobPacket).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePacket = resolve;
        }),
    );
    renderToday(todayModel({ jobs: [todayModel().jobs[0]!] }));

    expect(await screen.findByText("Checking saved packets")).toBeVisible();
    expect(screen.queryByText("Packet not saved on this device")).not.toBeInTheDocument();
    resolvePacket?.(false);
    expect(await screen.findByText("Saving packets for offline use")).toBeVisible();
  });

  it("exposes a retry only after a failed online packet save", async () => {
    vi.mocked(hasCachedJobPacket).mockResolvedValue(false);
    vi.mocked(prefetchAssignedPackets).mockImplementation(async (_session, model, options) => {
      options?.onPacket?.(model.jobs[0]!.id, false);
      return { [model.jobs[0]!.id]: false };
    });
    renderToday(todayModel({ jobs: [todayModel().jobs[0]!] }));

    expect(await screen.findByText("Packet not saved on this device")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry saving packet" })).toBeVisible();
  });

  it("labels cached data as an offline snapshot instead of live work", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderToday(todayModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByText("Offline snapshot")).toBeVisible();
    expect(screen.getByText(/Offline snapshot for .*Jul 10, 2026/i)).toBeVisible();
    expect(screen.queryByText("Current assignment read")).not.toBeInTheDocument();
    expect(prefetchAssignedPackets).not.toHaveBeenCalled();
  });
});
