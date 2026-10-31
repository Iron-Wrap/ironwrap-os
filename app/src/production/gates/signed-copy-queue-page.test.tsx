import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../../auth/session-context";
import type { AppRole } from "../../lib/roles";
import { ENDED_NOW, TIME_ZONE, queue, session } from "./gate-test-fixtures";
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
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session(role)}>
        <SignedCopyQueuePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("Q1, jobs that need a signed-copy time", () => {
  it("lists one row per category, each opening that job's record step, with one primary", () => {
    render(<SignedCopyQueue model={queue} role="owner" timeZone={TIME_ZONE} now={ENDED_NOW} />);
    expect(screen.getByRole("heading", { name: "Signed copy time missing" })).toBeVisible();
    expect(screen.getByText("Jobs that need a signed-copy time: 3")).toBeVisible();
    expect(
      screen.getByText(
        "Without it, the cancellation window can’t start, so ordering and a firm start stay held.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Use when each customer received the signed copy of the contract, not when they signed.",
      ),
    ).toBeVisible();

    // signed_copy_time_missing
    expect(screen.getByText("Elena Marchetti · 118 Larkspur Way NW")).toBeVisible();
    expect(screen.getByText("Not recorded yet")).toBeVisible();
    const add = screen.getByRole("link", { name: "Add the signed-copy time for Elena Marchetti" });
    expect(add).toHaveAttribute(
      "href",
      "/production/jobs/roof-job-elena-synthetic/gates?step=window",
    );
    expect(add.dataset.variant).toBe("primary");

    // signed_copy_before_contract: the recorded time predates the latest contract.
    expect(
      screen.getByText(
        "Contract signed again Mon 26 Oct 15:30 · the time on record is for the earlier one",
      ),
    ).toBeVisible();
    const update = screen.getByRole("link", { name: "Update the signed-copy time for Owen Pratt" });
    expect(update).toHaveAttribute(
      "href",
      "/production/jobs/roof-job-owen-synthetic/gates?step=window",
    );
    expect(update.dataset.variant).toBe("secondary");

    // signed_copy_unconfirmed
    expect(screen.getByText("Copy shown Thu 29 Oct 11:42 · receipt not confirmed")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Confirm the signed-copy time for Lena Ross" }),
    ).toHaveAttribute("href", "/production/jobs/roof-job-lena-synthetic/gates?step=window");

    expect(
      screen.getByText(
        "A job leaves this list once its time is recorded; its cancellation window then shows when it ends.",
      ),
    ).toBeVisible();
  });

  it("says when the list is cut short, and when nothing is missing", () => {
    const partial = render(
      <SignedCopyQueue
        model={{ ...queue, count: 140, complete: false }}
        role="ops"
        timeZone={TIME_ZONE}
        now={ENDED_NOW}
      />,
    );
    expect(
      screen.getByText("Showing the oldest 3. Record these and the rest appear."),
    ).toBeVisible();
    partial.unmount();
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
        now={ENDED_NOW}
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
    expect(await screen.findByText("Jobs that need a signed-copy time: 3")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/production/cancellation-window/signed-copy-missing",
      expect.anything(),
    );
    ops.unmount();
    fetcher.mockClear();
    page("production");
    expect(screen.getByText("Only the Owner or Operations can see this list.")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks a cached list unavailable after a failed refresh and lets the person reload it", async () => {
    let fails = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(fails ? { error: "unavailable" } : queue), {
            status: fails ? 503 : 200,
          }),
      ),
    );
    const { client } = page("ops");
    expect(await screen.findByText("Jobs that need a signed-copy time: 3")).toBeVisible();
    fails = true;
    await act(() => client.invalidateQueries({ queryKey: ["production-signed-copy-missing"] }));
    expect(
      await screen.findByText(
        "The latest list could not be checked. Reload it before choosing a job.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Add the signed-copy time/ }),
    ).not.toBeInTheDocument();
    fails = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Load the list again" }));
    expect(await screen.findByText("Jobs that need a signed-copy time: 3")).toBeVisible();
  });
});
