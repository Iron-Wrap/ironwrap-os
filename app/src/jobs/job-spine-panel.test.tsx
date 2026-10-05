import { onlineManager } from "@tanstack/react-query";
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { loadQuoteRevisionApprovals } from "../estimator/quote-revision-approval-api";
import { loadProposalPublicationApprovals } from "../proposal/proposal-publication-api";
import { loadJobEconomics } from "./job-economics-read-view";
import { moneyReadFixture, revisionFixture } from "./job-read-test-fixtures";
import { JobSpinePanel } from "./job-spine-panel";

vi.mock("./job-economics-read-view", async (original) => ({
  ...(await original<typeof import("./job-economics-read-view")>()),
  loadJobEconomics: vi.fn(),
}));
vi.mock("../estimator/quote-revision-approval-api", () => ({
  loadQuoteRevisionApprovals: vi.fn(),
}));
vi.mock("../proposal/proposal-publication-api", () => ({
  loadProposalPublicationApprovals: vi.fn(),
}));

const envelope = {
  version: 1 as const,
  read_model_generated_at: "2026-10-02T10:01:00.000Z",
  permissions: ["approvals:read"],
  allowed_actions: [],
};

beforeEach(() => {
  onlineManager.setOnline(true);
  vi.resetAllMocks();
  vi.mocked(loadJobEconomics).mockResolvedValue(moneyReadFixture());
  vi.mocked(loadQuoteRevisionApprovals).mockResolvedValue({ ...envelope, approvals: [] });
  vi.mocked(loadProposalPublicationApprovals).mockResolvedValue({ ...envelope, approvals: [] });
});

afterEach(() => onlineManager.setOnline(true));

function renderSpine(permissions = ["estimator:read", "approvals:read"]) {
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
    expect(screen.getByText("Quote approval read paused")).toBeVisible();
    expect(screen.getByText("Publication approval read paused")).toBeVisible();
    expect(screen.getByText(/Amounts and completeness are unknown until/)).toBeVisible();
    expect(screen.queryByText("Reading money sources…")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading approval sources…")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No matching approvals in the loaded records."),
    ).not.toBeInTheDocument();
    expect(loadJobEconomics).not.toHaveBeenCalled();
    expect(loadQuoteRevisionApprovals).not.toHaveBeenCalled();
    expect(loadProposalPublicationApprovals).not.toHaveBeenCalled();

    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText("CAD 2,000.10 known")).toBeVisible();
    expect(await screen.findByText("No matching approvals in the loaded records.")).toBeVisible();
    expect(screen.queryByText("Money read paused")).not.toBeInTheDocument();
    expect(screen.queryByText("Quote approval read paused")).not.toBeInTheDocument();
  });

  it("does not fetch money or receipts merely because a role can read job history", async () => {
    renderWithSession(<JobSpinePanel jobId="JOB-READ-001" />, sessionFor("production"));

    expect(
      screen.getByText("Money records are not available to your role on this job."),
    ).toBeVisible();
    expect(screen.getByText("Approval receipts are not available to your role.")).toBeVisible();
    expect(loadJobEconomics).not.toHaveBeenCalled();
    expect(loadQuoteRevisionApprovals).not.toHaveBeenCalled();
    expect(loadProposalPublicationApprovals).not.toHaveBeenCalled();
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

  it("keeps a failed approval source explicit while showing only matching job records", async () => {
    const match = revisionFixture();
    const other = {
      ...revisionFixture(),
      id: "quote-revision-approval:other",
      roof_job_id: "OTHER-JOB",
      request_text: "Other job review must stay out",
    };
    vi.mocked(loadQuoteRevisionApprovals).mockResolvedValue({
      ...envelope,
      approvals: [other, match],
    });
    vi.mocked(loadProposalPublicationApprovals).mockRejectedValue(new Error("unreadable"));
    renderSpine();

    expect(await screen.findByText(match.request_text)).toBeVisible();
    expect(await screen.findByText("Publication approval history unavailable")).toBeVisible();
    expect(screen.queryByText("Other job review must stay out")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No matching approvals in the loaded records."),
    ).not.toBeInTheDocument();
    const ledger = screen.getByRole("list", { name: "Loaded job approval records" });
    expect(within(ledger).getByRole("link", { name: "Open approval record" })).toHaveAttribute(
      "href",
      "/quote-revision-approvals/quote-revision-approval%3Ajob-read-001",
    );
    expect(loadProposalPublicationApprovals).toHaveBeenCalledWith("JOB-READ-001");
  });

  it("keeps an unreadable money source independent of a successfully empty approval ledger", async () => {
    vi.mocked(loadJobEconomics).mockRejectedValue(new Error("unreadable"));
    renderSpine();

    expect(await screen.findByText("Money sources could not be read")).toBeVisible();
    expect(await screen.findByText("No matching approvals in the loaded records.")).toBeVisible();
    expect(screen.queryByText("CAD 0.00")).not.toBeInTheDocument();
  });
});
