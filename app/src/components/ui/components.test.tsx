import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
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
    // The primary control height: 64 on touch, 72 on glove.
    expect(button).toHaveClass("min-h-[var(--control-height-primary)]");
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
    expect(link).toHaveClass("min-h-[var(--control-height-primary)]");
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
    expect(screen.getByRole("combobox", { name: "Crew" })).toHaveClass(
      "min-h-[var(--control-height-primary)]",
    );
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

  it("offers no retry for a refusal and keeps its code behind System details", async () => {
    const retry = vi.fn();
    const refused = new ApiError({
      status: 404,
      code: "not_found",
      message: "Not Found",
      requestId: "req-job-7",
    });
    const { rerender } = render(
      <ErrorState message="This job is not on your list." error={refused} onRetry={retry} />,
    );
    // The same request gets the same answer, so the message's own next step is the only one.
    expect(screen.getByRole("heading", { name: "Couldn’t open this" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByText("not_found")).not.toBeVisible();
    await userEvent.click(screen.getByText("System details"));
    expect(screen.getByText("not_found")).toBeVisible();
    expect(screen.getByText("req-job-7")).toBeVisible();

    const down = new ApiError({
      status: 502,
      code: "upstream_unavailable",
      message: "Bad Gateway",
    });
    rerender(<ErrorState message="Something went wrong." error={down} onRetry={retry} />);
    expect(screen.getByRole("heading", { name: "Couldn’t load this yet" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
