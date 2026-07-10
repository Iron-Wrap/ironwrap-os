import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OutboxStateBadge } from "../outbox-state-badge";
import { Button } from "./button";
import { EmptyState, ErrorState, LoadingState } from "./state-panel";

describe("foundation UI states", () => {
  it("keeps primary touch actions at the field minimum and reports busy truth", () => {
    render(
      <Button size="field" busy>
        Save proof
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save proof" });
    expect(button).toHaveClass("min-h-16");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("pairs outbox color with an icon and a visible state word", () => {
    render(<OutboxStateBadge state="needs_attention" />);
    const badge = screen.getByText("Needs attention");
    expect(badge).toBeVisible();
    expect(badge.closest("span")).toHaveAttribute(
      "title",
      "Nothing was discarded. Review is needed before retrying.",
    );
  });

  it("provides accessible loading, error retry, and teaching empty states", async () => {
    const retry = vi.fn();
    const { rerender } = render(<LoadingState label="Loading assigned jobs…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading assigned jobs…");

    rerender(<ErrorState message="Signal dropped before the job loaded." onRetry={retry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <EmptyState
        title="No assigned jobs"
        message="When office assigns work, its gate and next action appear here."
      />,
    );
    expect(screen.getByText("No assigned jobs")).toBeVisible();
    expect(screen.getByText(/gate and next action/)).toBeVisible();
  });
});
