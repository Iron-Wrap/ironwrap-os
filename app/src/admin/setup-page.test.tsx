import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStub } from "./admin-link-stub";
import { adminErrorMessage, loadSetupProgress } from "./admin-api";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import { SetupPage } from "./setup-page";

vi.mock("./admin-api", () => ({
  loadSetupProgress: vi.fn(),
  adminErrorMessage: vi.fn(() => "What is already set up could not be checked."),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

function step(id: "company" | "people" | "crew_phones", status: "done" | "in_progress" | "later") {
  return { id, title: id, status, detail: "server-derived", requirements: [] };
}

describe("SetupPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the server setup projector instead of guessing from profile and user queries", async () => {
    vi.mocked(loadSetupProgress).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-24T12:00:00.000Z",
      allowed_actions: ["setup_progress.read"],
      progress: {
        generated_at: "2026-08-24T12:00:00.000Z",
        done: 1,
        total: 5,
        percent_complete: 20,
        steps: [
          step("company", "done"),
          step("people", "in_progress"),
          step("crew_phones", "later"),
          { id: "money_and_intake", title: "Money", status: "later", detail: "", requirements: [] },
          {
            id: "notifications",
            title: "Notifications",
            status: "later",
            detail: "",
            requirements: [],
          },
        ],
      },
    });

    renderWithSession(<SetupPage />, sessionFor("owner"));

    expect(await screen.findByText("1 of 5 setup areas complete.")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Later")).toBeInTheDocument();
    expect(loadSetupProgress).toHaveBeenCalledOnce();
  });

  // The old fallback said "Do these in order the first time" for every case
  // that was not loaded data, so a fully configured company whose progress
  // read failed was told it had done nothing.
  it("says the check failed instead of reporting a configured company as untouched", async () => {
    vi.mocked(loadSetupProgress).mockRejectedValue(new Error("boom"));
    renderWithSession(<SetupPage />, sessionFor("owner"));

    expect(
      await screen.findByText("Progress could not be checked, so nothing below is marked done."),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "What is already set up could not be checked.",
    );
    expect(screen.queryByText("Do these in order the first time.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(adminErrorMessage).toHaveBeenCalled();
  });

  it("keeps the three destinations reachable when progress cannot be read", async () => {
    // The list does not depend on progress, so a failed read must not blank it.
    vi.mocked(loadSetupProgress).mockRejectedValue(new Error("boom"));
    renderWithSession(<SetupPage />, sessionFor("owner"));

    await screen.findByRole("button", { name: "Try again" });
    for (const title of ["Company details", "People", "Crew phones"]) {
      expect(screen.getByText(title)).toBeVisible();
    }
  });
});
