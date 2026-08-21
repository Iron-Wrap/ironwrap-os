import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OutboxStateBadge } from "../outbox-state-badge";
import { Button } from "./button";
import { Notice } from "./notice";
import { Select } from "./select";
import { EmptyState, ErrorState, LoadingState } from "./state-panel";
import { Textarea } from "./textarea";

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

  it("slots one field-sized navigation action without creating a nested button", () => {
    render(
      <Button asChild size="field">
        <a href="/jobs/JOB-1">Open job packet</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open job packet" });
    expect(link).toHaveAttribute("href", "/jobs/JOB-1");
    expect(link).toHaveClass("min-h-16");
  });

  it("pairs outbox color with an icon and a visible state word", () => {
    render(<OutboxStateBadge state="needs_attention" />);
    const badge = screen.getByText("Needs a check");
    expect(badge).toBeVisible();
    expect(badge.closest("span")).toHaveAttribute(
      "title",
      "Nothing was thrown away. Check this before you try again.",
    );
  });

  it("announces failures assertively and routine notices politely", () => {
    const { rerender } = render(
      <Notice tone="danger" title="Save refused">
        Nothing was changed.
      </Notice>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was changed.");

    rerender(
      <Notice tone="success" title="Saved">
        The request is ready for review.
      </Notice>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The request is ready for review.");
  });

  it("keeps native field controls large and exposes invalid state", () => {
    render(
      <>
        <Select field invalid aria-label="Crew">
          <option>North crew</option>
        </Select>
        <Textarea invalid aria-label="Correction reason" />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Crew" })).toHaveClass("min-h-16");
    expect(screen.getByRole("combobox", { name: "Crew" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Correction reason" })).toHaveAttribute(
      "aria-invalid",
      "true",
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
