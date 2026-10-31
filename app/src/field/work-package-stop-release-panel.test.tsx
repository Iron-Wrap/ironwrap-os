import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { getDatabase } from "../storage/db";
import type { JobResponse } from "./field-contracts";
import { WorkPackageStopReleasePanel } from "./work-package-stop-release-panel";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  apiRequest: vi.fn(),
}));
const session = {
  user: { id: "owner-test", email: "owner@example.invalid", frappe_user_id: null, role: "owner" },
  tenant: { id: "test", locale: "en-CA", time_zone: "America/Edmonton" },
  csrf_token: "csrf-test",
} as AuthenticatedSession;
const evidenceId = `evi_${"a".repeat(32)}`;
const plan = {
  id: "WP-TEST",
  version: 3,
  status: "Blocked",
  evidence_slots: [
    {
      event_id: "proof-test",
      evidence_item: evidenceId,
      requirement: "Ice removed from the north slope",
      captured_at: "2026-07-10T16:30:00Z",
      verification: "Verified",
      superseded: false,
    },
  ],
} as NonNullable<JobResponse["packet"]["work_package"]>;
const stop = {
  stop_event_id: "stop-test-1",
  stop_actor_user_id: "crew-test",
  occurred_at: "2026-07-10T16:00:00Z",
  blocker_reason: "Ice on the north slope",
};
const read = {
  work_package: { id: plan.id, version: 3, job_id: "JOB-TEST", status: "Blocked" },
  current_stop: stop,
  releases: [] as object[],
};
const release = {
  release_id: "release-test",
  work_package_id: plan.id,
  work_package_version: 3,
  stop_event_id: stop.stop_event_id,
};
const onReleased = vi.fn<() => Promise<void>>();
function mount(overrides: Partial<React.ComponentProps<typeof WorkPackageStopReleasePanel>> = {}) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkPackageStopReleasePanel
        session={session}
        workPackage={plan}
        jobId="JOB-TEST"
        holdingStops={[]}
        offline={false}
        onReleased={onReleased}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}
async function ready() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review stop for release" }));
  await user.click(await screen.findByRole("checkbox", { name: /Ice removed/ }));
  await user.type(
    screen.getByLabelText(/What was corrected/),
    "Crew confirmed ice removed; checked the attached proof.",
  );
  return user;
}
function postCalls() {
  return vi.mocked(apiRequest).mock.calls.filter(([options]) => options.method === "POST");
}

beforeEach(async () => {
  const db = await getDatabase();
  await db.clear("meta");
  vi.resetAllMocks();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.mocked(apiRequest).mockResolvedValue(read);
  onReleased.mockResolvedValue();
});

describe("job-plan stop release", () => {
  it("binds the exact stop and proof, verifies the stored release, then rereads the job", async () => {
    let submitted = false;
    vi.mocked(apiRequest).mockImplementation(async (options) => {
      if (options.method === "POST") {
        submitted = true;
        return { device_action_id: options.deviceActionId, status: "verified", release };
      }
      return submitted
        ? {
            ...read,
            current_stop: null,
            releases: [release],
            work_package: { ...read.work_package, status: "Released" },
          }
        : read;
    });
    mount();
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1));
    const request = postCalls()[0]![0];
    expect(request).toMatchObject({
      path: "/api/v1/work-packages/WP-TEST/stop-releases",
      csrfToken: "csrf-test",
      body: {
        work_package_version: 3,
        stop_event_id: "stop-test-1",
        evidence_ids: [evidenceId],
        reason: "Crew confirmed ice removed; checked the attached proof.",
      },
    });
    expect(request.idempotencyKey).toBe(request.deviceActionId);
    expect(screen.getByText(/The release is recorded and checked/)).toBeVisible();
  });

  it.each(["stale version", "different job", "no current stop"])(
    "refuses a %s read before offering a write",
    async (caseName) => {
      vi.mocked(apiRequest).mockResolvedValue({
        ...read,
        work_package: {
          ...read.work_package,
          ...(caseName === "stale version" ? { version: 4 } : {}),
          ...(caseName === "different job" ? { job_id: "JOB-OTHER" } : {}),
        },
        current_stop: caseName === "no current stop" ? null : stop,
      });
      mount();
      await userEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
      expect(await screen.findByText(/This plan or its stop has changed/)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Record release of this plan’s stop" }),
      ).not.toBeInTheDocument();
      expect(postCalls()).toHaveLength(0);
    },
  );

  it.each(["old", "same instant", "unverified", "superseded"])(
    "does not offer %s proof",
    async (kind) => {
      const item = {
        ...plan.evidence_slots[0]!,
        ...(kind === "old" ? { captured_at: "2026-07-10T15:59:00Z" } : {}),
        ...(kind === "same instant" ? { captured_at: stop.occurred_at } : {}),
        ...(kind === "unverified" ? { verification: "Pending" as const } : {}),
        ...(kind === "superseded" ? { superseded: true } : {}),
      };
      mount({ workPackage: { ...plan, evidence_slots: [item] } });
      await userEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
      expect(await screen.findByText(/No verified proof captured after this stop/)).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Record release of this plan’s stop" }),
      ).toBeDisabled();
    },
  );

  it("blocks a known raiser locally, but leaves reporter and alias checks to the server", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...read,
      current_stop: { ...stop, stop_actor_user_id: session.user.email },
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
    expect(await screen.findByText(/You reported this stop/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Record release of this plan’s stop" }),
    ).toBeDisabled();
  });

  it("shows the authoritative independence refusal without claiming release", async () => {
    vi.mocked(apiRequest).mockImplementation(async (options) => {
      if (options.method === "POST")
        throw new ApiError({
          status: 403,
          code: "work_package_stop_release_independence_required",
          message: "private server wording",
        });
      return read;
    });
    mount();
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    expect(await screen.findByText(/You raised or reported this stop/)).toBeVisible();
    expect(onReleased).not.toHaveBeenCalled();
    expect(screen.queryByText("private server wording")).not.toBeInTheDocument();
  });

  it("retries a lost response with the same frozen intent and handles a newer stop", async () => {
    let writes = 0;
    vi.mocked(apiRequest).mockImplementation(async (options) => {
      if (options.method === "POST") {
        writes++;
        if (writes === 1)
          throw new ApiError({
            status: 502,
            code: "work_package_native_unavailable",
            message: "lost",
          });
        return { device_action_id: options.deviceActionId, status: "verified", release };
      }
      return writes > 1
        ? { ...read, current_stop: { ...stop, stop_event_id: "stop-test-2" }, releases: [release] }
        : read;
    });
    const view = mount();
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    expect(await screen.findByText(/The release is not confirmed/)).toBeVisible();
    view.unmount();
    mount();
    expect(await screen.findByText(/An earlier release is not confirmed/)).toBeVisible();
    expect(screen.getByLabelText(/What was corrected/)).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry same release" }));
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1));
    expect(postCalls()[1]![0]).toEqual(postCalls()[0]![0]);
    expect(screen.getByText(/Another stop now holds this plan/)).toBeVisible();
  });

  it("does not treat a missing readback as a confirmed release", async () => {
    vi.mocked(apiRequest).mockImplementation(async (options) =>
      options.method === "POST"
        ? { device_action_id: options.deviceActionId, status: "verified", release }
        : read,
    );
    mount();
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    expect(await screen.findByText(/The release is not confirmed/)).toBeVisible();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("distinguishes a recorded release from an unavailable job readback", async () => {
    let submitted = false;
    vi.mocked(apiRequest).mockImplementation(async (options) => {
      if (options.method === "POST") {
        submitted = true;
        return { device_action_id: options.deviceActionId, status: "verified", release };
      }
      return submitted ? { ...read, current_stop: null, releases: [release] } : read;
    });
    onReleased.mockRejectedValue(new Error("job read unavailable"));
    mount();
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    expect(
      await screen.findByText(/The release is recorded, but the job could not be reloaded/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload job details" })).toBeEnabled();
    expect(postCalls()).toHaveLength(1);
    onReleased.mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Reload job details" }));
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(2));
    expect(postCalls()).toHaveLength(1);
  });

  it("keeps an unresolved tenant stop separate from this exact plan release", async () => {
    mount({
      holdingStops: [
        {
          occurrence_id: "unresolved-safety-stop",
          scope: "tenant",
          summary: "Job could not be identified",
          raiser_display_name: null,
          reported_at: stop.occurred_at,
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
    expect(
      await screen.findByText(
        "A separate safety stop also holds this job. This release will not clear it.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/It does not start work/)).toBeVisible();
  });

  it("never writes offline or shows a release form to a field user", async () => {
    const view = mount({ offline: true });
    expect(screen.getByRole("button", { name: "Review stop for release" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
    expect(apiRequest).not.toHaveBeenCalled();
    view.unmount();
    mount({ session: { ...session, user: { ...session.user, role: "field" } } });
    expect(
      screen.queryByRole("heading", { name: "Release this plan’s stop" }),
    ).not.toBeInTheDocument();
  });

  it("does not retarget the exact release to a tenant-first or different-plan holding stop", async () => {
    mount({
      holdingStops: [
        {
          occurrence_id: "tenant-hold",
          scope: "tenant",
          reported_at: "2026-07-10T12:00:00Z",
          summary: "Older tenant hold",
          raiser_display_name: null,
        },
        {
          occurrence_id: "other-plan-stop",
          scope: "job",
          reported_at: "2026-07-10T13:00:00Z",
          summary: "A different plan",
          raiser_display_name: null,
        },
      ],
    });
    const user = await ready();
    expect(screen.getByText(/Stopped .*Ice on the north slope/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0]![0].body).toMatchObject({
      stop_event_id: stop.stop_event_id,
      work_package_version: plan.version,
      evidence_ids: [evidenceId],
    });
  });

  it("states that other holds are unknown while keeping the exact current-stop selector", async () => {
    mount({ holdingStops: null });
    const user = await ready();
    expect(screen.getByText(/Other safety stops could not be confirmed/)).toBeVisible();
    expect(screen.getByText(/It does not start work/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Record release of this plan’s stop" }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0]![0].body).toMatchObject({ stop_event_id: stop.stop_event_id });
  });

  it("refuses a different current package even when a generic stop matches", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...read,
      work_package: { ...read.work_package, id: "OTHER-PLAN" },
    });
    mount({
      holdingStops: [
        {
          occurrence_id: stop.stop_event_id,
          scope: "job",
          reported_at: stop.occurred_at,
          summary: stop.blocker_reason,
          raiser_display_name: null,
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Review stop for release" }));
    expect(await screen.findByText(/This plan or its stop has changed/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Record release of this plan’s stop" }),
    ).not.toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });
});
