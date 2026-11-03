import { onlineManager } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { loadJobEconomics } from "./job-economics-read-view";
import { moneyReadFixture } from "./job-read-test-fixtures";
import { JobSpinePanel } from "./job-spine-panel";

vi.mock("./job-economics-read-view", async (original) => ({
  ...(await original<typeof import("./job-economics-read-view")>()),
  loadJobEconomics: vi.fn(),
}));

beforeEach(() => {
  onlineManager.setOnline(true);
  vi.resetAllMocks();
  vi.mocked(loadJobEconomics).mockResolvedValue(moneyReadFixture());
});

afterEach(() => onlineManager.setOnline(true));

function renderSpine(permissions = ["estimator:read"]) {
  return renderWithSession(
    <JobSpinePanel jobId="JOB-READ-001" />,
    sessionFor("owner", { permissions }),
  );
}

describe("job source connections", () => {
  it("explains paused live-session reads and resumes them on reconnect", async () => {
    onlineManager.setOnline(false);
    renderSpine();

    expect(await screen.findByText("Money read paused")).toBeVisible();
    expect(screen.getByText(/Amounts and completeness are unknown until/)).toBeVisible();
    expect(screen.queryByText("Reading money sources…")).not.toBeInTheDocument();
    expect(loadJobEconomics).not.toHaveBeenCalled();

    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText("CAD 2,000.10 known")).toBeVisible();
    expect(screen.queryByText("Money read paused")).not.toBeInTheDocument();
  });

  it("does not fetch money merely because a role can read job history", async () => {
    renderWithSession(<JobSpinePanel jobId="JOB-READ-001" />, sessionFor("production"));

    expect(
      screen.getByText("Money records are not available to your role on this job."),
    ).toBeVisible();
    expect(loadJobEconomics).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Open estimate record" })).not.toBeInTheDocument();
  });

  it("labels known sums, unavailable money, source limits and actual profit separately", async () => {
    renderSpine();

    expect(await screen.findByText("CAD 2,000.10 known")).toBeVisible();
    expect(screen.getByText("CAD 0.00")).toBeVisible();
    expect(screen.getAllByText("Amount unavailable")).toHaveLength(4);
    expect(screen.getByText("Money read has source limits")).toBeVisible();
    expect(screen.getByText(/Actual profit is unavailable/)).toBeVisible();
    expect(screen.getByText(/source updated/)).toHaveTextContent("Money read");
    expect(loadJobEconomics).toHaveBeenCalledWith("freshco", "JOB-READ-001");
  });

  it("keeps an unreadable money source explicit instead of an empty ledger", async () => {
    vi.mocked(loadJobEconomics).mockRejectedValue(new Error("unreadable"));
    renderSpine();

    expect(await screen.findByText("Money sources could not be read")).toBeVisible();
    expect(screen.queryByText("CAD 0.00")).not.toBeInTheDocument();
  });
});
