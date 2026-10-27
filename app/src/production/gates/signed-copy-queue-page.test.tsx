import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../../auth/session-context";
import type { AppRole } from "../../lib/roles";
import { OPEN_NOW, TIME_ZONE, queue, session } from "./gate-test-fixtures";
import { SignedCopyQueue, SignedCopyQueuePage } from "./signed-copy-queue-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
    search?: { step?: string };
  }) => (
    <a
      href={`${to.replace("$jobId", params?.jobId ?? "$jobId")}${search?.step ? `?step=${search.step}` : ""}`}
      {...props}
    >
      {children}
    </a>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

function page(role: AppRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session(role)}>
        <SignedCopyQueuePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("Q1, jobs missing a signed-copy time", () => {
  it("lists each job with its count, one primary and the step it opens", () => {
    render(<SignedCopyQueue model={queue} role="ops" timeZone={TIME_ZONE} now={OPEN_NOW} />);
    expect(screen.getByRole("heading", { name: "Signed copy time missing" })).toBeVisible();
    expect(screen.getByText("Jobs with no signed-copy time: 3")).toBeVisible();
    expect(
      screen.getByText(
        "Without it, the cancellation window can’t start, so ordering and a firm start stay held.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Use when each customer received the signed copy of the contract, not when they signed. Each button opens that job’s step.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Elena Marchetti · 118 Larkspur Way NW")).toBeVisible();
    expect(screen.getByText("Not recorded yet")).toBeVisible();
    expect(screen.getAllByText("Imported from the old system · not recorded yet")).toHaveLength(2);
    const first = screen.getByRole("link", {
      name: "Add the signed-copy time for Elena Marchetti",
    });
    expect(first).toHaveAttribute(
      "href",
      "/production/jobs/roof-job-elena-synthetic/gates?step=window",
    );
    expect(first.dataset.variant).toBe("primary");
    expect(
      screen.getByRole("link", { name: "Add the signed-copy time for Owen Pratt" }).dataset.variant,
    ).toBe("secondary");
    expect(
      screen.getByText(
        "Next: each job you record leaves this list, and its cancellation window shows when it ends.",
      ),
    ).toBeVisible();
  });

  it("names a copy that was shown but never confirmed sent, and a record for an earlier contract", () => {
    render(
      <SignedCopyQueue
        model={{
          ...queue,
          count: 2,
          counts: { window_unknown: 1, signed_copy_unconfirmed: 1 },
          complete: false,
          jobs: [
            {
              ...queue.jobs[0]!,
              category: "signed_copy_unconfirmed",
              unknown_reason: "signed_copy_unconfirmed",
              copy_shown_at: "2026-10-21T00:26:00.000Z",
            },
            {
              ...queue.jobs[1]!,
              contract_on_record: true,
              unknown_reason: "signed_copy_before_contract",
            },
          ],
        }}
        role="owner"
        timeZone={TIME_ZONE}
        now={OPEN_NOW}
      />,
    );
    expect(
      screen.getByText(
        "Shown at signing Tue 20 Oct 18:26, never confirmed sent · not recorded yet",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Recorded for an earlier contract · not recorded yet for this one"),
    ).toBeVisible();
    expect(
      screen.getByText("Showing the oldest 2. Record these and the rest appear."),
    ).toBeVisible();
  });

  it("says when nothing is missing", () => {
    render(
      <SignedCopyQueue
        model={{
          count: 0,
          counts: { window_unknown: 0, signed_copy_unconfirmed: 0 },
          complete: true,
          jobs: [],
        }}
        role="owner"
        timeZone={TIME_ZONE}
        now={OPEN_NOW}
      />,
    );
    expect(
      screen.getByText("Every signed job has its signed-copy time. Nothing to add."),
    ).toBeVisible();
  });

  it("loads the list for ops and never asks the Worker for production", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(queue), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const ops = page("ops");
    expect(await screen.findByText("Jobs with no signed-copy time: 3")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/production/cancellation-window/signed-copy-missing",
      expect.anything(),
    );
    ops.unmount();
    fetcher.mockClear();
    page("production");
    expect(screen.getByText("Only an owner or ops can see this list.")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
