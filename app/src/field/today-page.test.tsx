import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import {
  useOutboxActionsNeedingAttention,
  useOutboxActionsSettledByOffice,
} from "../storage/use-outbox";
import type { OutboxAction } from "../storage/outbox-types";
import type { TodayResponse } from "./field-contracts";
import { loadOperatingIntake } from "../operating-intake/operating-intake-api";
import { operatingIntakePayload } from "../operating-intake/operating-intake-fixture";
import { cacheToday, hasCachedJobPacket, loadToday, prefetchAssignedPackets } from "./field-cache";
import { TodayPage } from "./today-page";

vi.mock("./field-cache", () => ({
  cacheToday: vi.fn().mockResolvedValue(undefined),
  hasCachedJobPacket: vi.fn(),
  loadToday: vi.fn(),
  prefetchAssignedPackets: vi.fn(),
}));

vi.mock("../storage/use-outbox", () => ({
  useOutboxActionsNeedingAttention: vi.fn(),
  useOutboxActionsSettledByOffice: vi.fn(() => []),
}));

vi.mock("../operating-intake/operating-intake-api", () => ({
  loadOperatingIntake: vi.fn(),
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
    params?: Record<string, string>;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={
        to === "/jobs/$jobId" && params?.jobId
          ? `/jobs/${params.jobId}`
          : to.startsWith("/work-objects/") && params
            ? `/work-objects/${encodeURIComponent(params.workObjectType ?? "")}/${encodeURIComponent(params.workObjectId ?? "")}/physical-contexts/${encodeURIComponent(params.physicalContextType ?? "")}/${encodeURIComponent(params.physicalContextId ?? "")}`
            : to
      }
    >
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

// The run sheet is not field-only: an owner or ops user opens `/today` to see the same
// list. Website intake belongs to that reader, never to the crew phone.
const officeSession = {
  ...fieldSession,
  user: {
    id: "appu_ops_user",
    email: "ops@example.invalid",
    display_name: "Operations",
    role: "ops",
    frappe_user_id: "ops@example.invalid",
  },
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
        active_stops: [],
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
        active_stops: [],
      },
    ],
    work_objects: [],
    ...overrides,
  };
}

function renderToday(
  model = todayModel(),
  initialToday?: TodayResponse,
  session: AuthenticatedSession = fieldSession,
) {
  vi.mocked(loadToday).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session} initialToday={initialToday}>
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
    vi.mocked(prefetchAssignedPackets).mockImplementation(async (_session, model, options) => {
      for (const job of model.jobs) options?.onPacket?.(job.id, true);
      return Object.fromEntries(model.jobs.map((job) => [job.id, true]));
    });
    vi.mocked(useOutboxActionsNeedingAttention).mockReturnValue([]);
    vi.mocked(useOutboxActionsSettledByOffice).mockReturnValue([]);
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload({ leads: [] }));
  });

  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
    vi.restoreAllMocks();
  });

  it("makes an assigned Shop Order discoverable from Today through its typed packet route", async () => {
    const user = userEvent.setup();
    renderToday(
      todayModel({
        jobs: [],
        work_objects: [
          {
            work_object_type: "Shop Order",
            work_object_id: "SHOP-001",
            physical_context_type: "Shop Floor",
            physical_context_id: "SHOP-FLOOR-1",
            scheduled_start: "2026-07-10T16:00:00.000Z",
            scheduled_end: null,
            next_action: "See job plan",
            assignment: {
              id: "ASSIGN-SHOP-1",
              assignment_id: "assignment_shop_1",
              type: "Shop",
              status: "Assigned",
              crew_profile: null,
              scheduled_start: "2026-07-10T16:00:00.000Z",
              scheduled_end: null,
              blocker_reason: null,
            },
          },
        ],
      }),
    );

    const link = await screen.findByRole("link", { name: "Open work plan" });
    expect(link).toHaveAttribute(
      "href",
      "/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1",
    );
    expect(screen.getByText("See job plan")).toBeVisible();
    await user.click(link);
    expect(window.location.pathname).toBe(
      "/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1",
    );
  });

  it("shows a stop on a job on that job's card, naming the job, who stopped it and when", async () => {
    const [blocked, next] = todayModel().jobs;
    renderToday(
      todayModel({
        jobs: [
          {
            ...blocked!,
            active_stops: [
              {
                occurrence_id: "so_1",
                scope: "job",
                reported_at: "2026-07-10T16:24:00.000Z",
                summary: "Ice on the north slope",
                raiser_display_name: "Tom Lachance",
              },
            ],
          },
          { ...next!, active_stops: [] },
        ],
      }),
    );
    const banner = await screen.findByText(
      "Work is stopped on the job: 123 Example Avenue · Ref IW-1042",
    );
    const notice = banner.closest("section")!;
    expect(notice).toHaveTextContent(
      /Stopped on \w{3} 10 Jul at 10:24\sa\.m\. by Tom Lachance · Reason: Ice on the north slope/,
    );
    expect(notice).toHaveTextContent("The office releases the stop.");
    // The card waits on the office; its work check is separate and its button is no longer primary.
    const card = notice.closest("article")!;
    expect(within(card).getByText("Wait for the office to release the stop")).toBeVisible();
    expect(
      within(card).getByText(
        "Separate work check: Delivery confirmation is missing. Clearing it doesn't restart work.",
      ),
    ).toBeVisible();
    expect(within(card).queryByText("1 check blocks work")).toBeNull();
    expect(within(card).getByRole("link", { name: "Check what blocks work" })).not.toHaveClass(
      "bg-primary",
    );
    // With no office number in the profile, the banner offers no call and invents none.
    expect(within(notice).queryByRole("link", { name: "Call the office" })).toBeNull();
    // Only the stopped job's card says so; no stop holds every job.
    expect(screen.getAllByText(/^Work is stopped/)).toHaveLength(1);
    expect(screen.queryByText(/every job/)).toBeNull();
  });

  it("offers a call to the office that releases the stop when the profile has its number", async () => {
    const [blocked] = todayModel().jobs;
    renderToday(
      todayModel({
        jobs: [
          {
            ...blocked!,
            active_stops: [
              {
                occurrence_id: "so_3",
                scope: "job",
                reported_at: "2026-07-10T16:24:00.000Z",
                summary: null,
                raiser_display_name: "Tom Lachance",
              },
            ],
          },
        ],
      }),
      undefined,
      { ...fieldSession, tenant: { ...fieldSession.tenant, office_phone: "780-555-0142" } },
    );
    const banner = (
      await screen.findByText("Work is stopped on the job: 123 Example Avenue · Ref IW-1042")
    ).closest("section")!;
    expect(within(banner).getByRole("link", { name: "Call the office" })).toHaveAttribute(
      "href",
      "tel:7805550142",
    );
  });

  it("never names the run sheet's generic next step as a stopped job's work check", async () => {
    const [blocked] = todayModel().jobs;
    renderToday(
      todayModel({
        jobs: [
          {
            ...blocked!,
            next_action: "Open field check-in",
            active_stops: [
              {
                occurrence_id: "so_5",
                scope: "job",
                reported_at: "2026-07-10T16:24:00.000Z",
                summary: null,
                raiser_display_name: null,
              },
            ],
          },
        ],
      }),
    );
    expect(
      await screen.findByText("A separate work check is open. Clearing it doesn't restart work."),
    ).toBeVisible();
    expect(screen.queryByText(/Separate work check: Open field check-in/)).toBeNull();
  });

  it("offers the office call on the every-job banner too", async () => {
    const tenantStop = {
      occurrence_id: "so_4",
      scope: "tenant" as const,
      reported_at: "2026-07-10T15:50:00.000Z",
      summary: null,
      raiser_display_name: "Priya Nand",
    };
    renderToday(
      todayModel({
        jobs: todayModel().jobs.map((job) => ({ ...job, active_stops: [tenantStop] })),
      }),
      undefined,
      { ...fieldSession, tenant: { ...fieldSession.tenant, office_phone: "780-555-0142" } },
    );
    const banner = (await screen.findByText("Work is stopped on every job.")).closest("section")!;
    expect(within(banner).getByRole("link", { name: "Call the office" })).toHaveAttribute(
      "href",
      "tel:7805550142",
    );
    // The stop names who reported it once, in the sentence that says what happened.
    expect(
      within(banner).getByText(
        "Priya Nand reported a stop, and we couldn't tell which job it's for. The office is told.",
      ),
    ).toBeVisible();
    expect(within(banner).getByText(/^Stopped on \w{3} 10 Jul at 9:50\sa\.m\.$/)).toBeVisible();
  });

  it("shows a stop whose job wasn't found once, above every job", async () => {
    const tenantStop = {
      occurrence_id: "so_2",
      scope: "tenant" as const,
      reported_at: "2026-07-10T15:50:00.000Z",
      summary: null,
      raiser_display_name: null,
    };
    renderToday(
      todayModel({
        jobs: todayModel().jobs.map((job) => ({ ...job, active_stops: [tenantStop] })),
      }),
    );
    expect(await screen.findAllByText("Work is stopped on every job.")).toHaveLength(1);
    // With no raiser the read can name, the banner still says what happened.
    expect(
      screen.getByText(
        "A stop was reported, and we couldn't tell which job it's for. The office is told.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/wasn't found|not found/)).toBeNull();
    // Every card it holds waits on the office, with its work check separate and its button demoted.
    for (const card of screen.getAllByRole("article")) {
      expect(within(card).getByText("Wait for the office to release the stop")).toBeVisible();
      expect(
        within(card).getByRole("link", { name: /Check what blocks work|Open job|Review job/ }),
      ).not.toHaveClass("bg-primary");
    }
    // A stop whose raiser and words the read lacks still says when.
    expect(screen.getByText(/^Stopped on \w{3} 10 Jul at 9:50\sa\.m\.$/)).toBeVisible();
    expect(screen.queryByText(/^Work is stopped on the job/)).toBeNull();
  });

  it("turns assigned work into a truthful run sheet with a distinct blocked-work action", async () => {
    renderToday();

    expect(await screen.findByRole("heading", { name: "Today's work" })).toBeVisible();
    expect(screen.getByText("1 check blocks work")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Ready offline" })).toBeVisible();
    expect(
      screen.getByText(/This run sheet and 2 job plans are saved on this phone/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Check what blocks work" })).toHaveAttribute(
      "href",
      "/jobs/JOB-BLOCKED",
    );
    expect(screen.getByRole("link", { name: "Open job" })).toHaveAttribute(
      "href",
      "/jobs/JOB-NEXT",
    );
    expect(screen.getAllByText(/10:00/).length).toBeGreaterThan(0);

    expect(screen.queryByText("Needs download")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Start work/i })).not.toBeInTheDocument();
  });

  it("lays a job card out by its own width, so the crew shell's narrow column never squeezes it", async () => {
    renderToday();
    const link = await screen.findByRole("link", { name: "Check what blocks work" });
    const card = link.closest("article")!;
    // Three columns only when the card is 48rem wide (the office), the two facts side by side only
    // when their column is 24rem wide; never by the window's width.
    expect(card.parentElement).toHaveClass("@container");
    expect(card.className).toContain("@3xl:grid-cols-[10rem_minmax(0,1fr)_13rem]");
    expect(card.querySelector("dl")?.className).toContain("@sm:grid-cols-2");
    expect(card.className).not.toMatch(/(^|\s)(sm|md|lg):grid-cols/);
  });

  it("renders the verified bootstrap run sheet without a second initial today request", async () => {
    const bootstrapToday = todayModel();
    renderToday(todayModel(), bootstrapToday);

    expect(await screen.findByRole("heading", { name: "Today's work" })).toBeVisible();
    expect(loadToday).not.toHaveBeenCalled();
    expect(cacheToday).toHaveBeenCalledWith(fieldSession, bootstrapToday);
  });

  it("warns when the fresh bootstrap run sheet could not be kept on this phone", async () => {
    const user = userEvent.setup();
    vi.mocked(cacheToday).mockRejectedValueOnce(
      new DOMException("Storage full", "QuotaExceededError"),
    );
    renderToday(todayModel(), todayModel());

    expect(await screen.findByRole("heading", { name: "Not ready offline" })).toBeVisible();
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument();
    expect(screen.queryByText("Some details may be old")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try saving again" }));
    expect(await screen.findByRole("heading", { name: "Ready offline" })).toBeVisible();
    expect(loadToday).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByRole("heading", { name: "Saving for offline use" })).toBeVisible();
    expect(screen.queryByText("Job plan not saved")).not.toBeInTheDocument();
    resolvePacket?.(false);
    expect(screen.getByRole("heading", { name: "Saving for offline use" })).toBeVisible();
  });

  it("exposes a retry only after a failed online packet save", async () => {
    vi.mocked(hasCachedJobPacket).mockResolvedValue(false);
    vi.mocked(prefetchAssignedPackets).mockImplementation(async (_session, model, options) => {
      options?.onPacket?.(model.jobs[0]!.id, false);
      return { [model.jobs[0]!.id]: false };
    });
    renderToday(todayModel({ jobs: [todayModel().jobs[0]!] }));

    expect(await screen.findByText("Job plan not saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save job plan again" })).toBeVisible();
  });

  it("labels cached data as an offline snapshot instead of live work", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderToday(todayModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByText("Saved copy")).toBeVisible();
    expect(screen.getByText(/This is a saved copy for .*Jul 10, 2026/i)).toBeVisible();
    expect(screen.queryByText("Current assignment read")).not.toBeInTheDocument();
    expect(prefetchAssignedPackets).not.toHaveBeenCalled();
  });

  it("shows D1 website intake separately from assigned field jobs, for an office reader", async () => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload());
    renderToday(todayModel(), undefined, officeSession);

    expect(await screen.findByRole("heading", { name: "Website intake" })).toBeVisible();
    expect(screen.getByText("Launch Proof")).toBeVisible();
    expect(
      screen.getByText(
        "Review website enquiries before assigning work or making a customer commitment.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Today's work" })).toBeVisible();
  });

  // ELEC-157. `/api/v1/operating-intake` refuses a field session, and the client sends no
  // device proof with it, so the Worker answered 401 and expired the session cookie in the
  // same response: the crew phone signed itself out every time it opened its own run sheet
  // and the next cold start showed "Pair this crew phone again". Not rendering the panel
  // for a field session is what stops the request being made at all.
  it("never asks a crew phone's run sheet for office website intake", async () => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload());
    renderToday();

    expect(await screen.findByRole("heading", { name: "Today's work" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Website intake" })).not.toBeInTheDocument();
    expect(screen.queryByText("Website intake could not load")).not.toBeInTheDocument();
    expect(loadOperatingIntake).not.toHaveBeenCalled();
  });

  it("makes named preserved field work recoverable from the run sheet", async () => {
    vi.mocked(useOutboxActionsNeedingAttention).mockReturnValue([
      {
        deviceActionId: "needs-office-review",
        tenantId: fieldSession.tenant.id,
        userId: fieldSession.user.id,
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/JOB-BLOCKED/check-ins",
        method: "POST",
        payload: {},
        attachments: [],
        state: "needs_attention",
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
        updatedAt: 2_000,
        lastError: {
          code: "assignment_changed",
          message: "The office assignment changed.",
          status: 409,
          occurredAt: 2_000,
        },
        conflict: {
          status: 409,
          code: "assignment_changed",
          message: "The office assignment changed.",
          detectedAt: 2_000,
        },
        version: 2,
      } satisfies OutboxAction,
    ]);
    renderToday();

    expect(
      await screen.findByRole("heading", { name: "One saved item needs review" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Field check-in · job JOB-BLOCKED" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("says the office has an item it settled instead of letting it vanish", async () => {
    vi.mocked(useOutboxActionsNeedingAttention).mockReturnValue([]);
    vi.mocked(useOutboxActionsSettledByOffice).mockReturnValue([
      {
        deviceActionId: "settled-by-office",
        tenantId: fieldSession.tenant.id,
        userId: fieldSession.user.id,
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/JOB-BLOCKED/check-ins",
        method: "POST",
        payload: {},
        attachments: [],
        state: "verified",
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1_000,
        updatedAt: 3_000,
        verification: {
          verifiedAt: 3_000,
          officeResolution: {
            resolutionId: `fir_${"1".repeat(64)}`,
            resolution: "arrived",
            linkedRecord: { type: "field_action", id: "settled-by-office" },
          },
        },
        version: 2,
      } satisfies OutboxAction,
    ]);
    renderToday();

    expect(
      await screen.findByRole("heading", { name: "The office has your saved item" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Field check-in · job JOB-BLOCKED" })).toBeVisible();
    expect(screen.getByText("The office confirmed it has this.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Got it" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /needs review/ })).not.toBeInTheDocument();
  });
});
