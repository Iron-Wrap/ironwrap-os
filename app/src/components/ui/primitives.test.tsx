import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MoneyBadge } from "../../accounting/money-badge";
import { ApiError } from "../../lib/api";
import { Logo, BrandMark } from "./brand";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { ErrorSummary } from "./error-summary";
import { Notice } from "./notice";
import { PageHeader } from "./page-header";
import { Queue, QueueRow } from "./queue";
import { RefTag } from "./ref-tag";
import { SaveIndicator } from "./save-indicator";
import { Segmented, SegmentedCount } from "./segmented";
import { Status, type StatusKind } from "./status";
import { ErrorSystemDetails, SystemDetails } from "./system-details";
import { Timeline } from "./timeline";

describe("Iron Wrap primitives", () => {
  it("keeps the legacy button variants as aliases of the new ones", () => {
    render(
      <>
        <Button variant="primary">Primary</Button>
        <Button variant="accent">Accent</Button>
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="ghost">Ghost</Button>
      </>,
    );
    const className = (name: string) => screen.getByRole("button", { name }).className;
    expect(className("Primary")).toContain("bg-primary");
    expect(className("Accent")).toBe(className("Primary"));
    expect(className("Default")).toBe(className("Primary"));
    expect(className("Outline")).toBe(className("Secondary"));
    expect(className("Ghost")).toBe(className("Quiet"));
    expect(className("Accent")).not.toContain("bg-accent");
  });

  it("keeps a dense small action keyboard-operable without a pseudo hit area", async () => {
    const assign = vi.fn();
    render(
      <Button size="small" onClick={assign}>
        Assign
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Assign" });
    // The office recipe stays dense. CSS enlarges this element's real box on touch.
    expect(button).toHaveClass("ui-button", "min-h-8");
    expect(button).toHaveAttribute("data-ui-size", "small");
    expect(button.className).not.toContain("after:");
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(assign).toHaveBeenCalledOnce();
  });

  it("stamps a reference tag that shows and announces its plain kind before the code", () => {
    render(
      <>
        <RefTag id="IW-1001" />
        <RefTag id="L-2207" kind="lead" size="large" />
        <RefTag id="IW-1002" asChild>
          <a href="/jobs/IW-1002">IW-1002</a>
        </RefTag>
      </>,
    );
    const job = screen.getByRole("img", { name: "Job IW-1001" });
    // The gate's rule: a code never stands alone, and the plain label comes first.
    expect(job.textContent).toBe("Job IW-1001");
    expect(job).toHaveClass("ref-tag");
    expect(job).toHaveAttribute("data-kind", "job");

    const lead = screen.getByRole("img", { name: "Lead L-2207" });
    expect(lead.textContent).toBe("Lead L-2207");
    expect(lead).toHaveAttribute("data-kind", "lead");
    expect(lead).toHaveAttribute("data-size", "large");

    const link = screen.getByRole("link", { name: "Job IW-1002" });
    expect(link.textContent).toBe("Job IW-1002");
    expect(link).toHaveAttribute("href", "/jobs/IW-1002");
    expect(link).toHaveClass("ref-tag");
    expect(link).toHaveAttribute("data-interactive", "true");
    expect(job).not.toHaveAttribute("data-interactive");
  });

  it("names the shop, field and office codes the gate lists in their own words", () => {
    render(
      <>
        <RefTag id="PMS-2231" kind="coil" />
        <RefTag id="L-114" kind="lot" />
        <RefTag id="S-7" kind="survey" />
        <RefTag id="C-14" kind="cutlist" />
        <RefTag id="CO-3" kind="change_order" />
        <RefTag id="NCR-31" kind="quality_problem" />
        <RefTag id="P-9" kind="person" />
        <RefTag id="SC-12" kind="case" />
      </>,
    );
    expect(screen.getAllByRole("img").map((tag) => tag.textContent)).toEqual([
      "Coil PMS-2231",
      "Lot L-114",
      "Survey reading S-7",
      "Cut list C-14",
      "Change order CO-3",
      "Quality problem NCR-31",
      "Person P-9",
      "Service call SC-12",
    ]);
  });

  it("keeps system facts behind one closed disclosure with the same word everywhere", async () => {
    render(
      <SystemDetails className="border" summaryClassName="px-4">
        <p>Request ID approval:42</p>
      </SystemDetails>,
    );
    const summary = screen.getByText("System details");
    const disclosure = summary.closest("details")!;
    expect(summary.tagName).toBe("SUMMARY");
    expect(disclosure).toHaveAttribute("data-system-details");
    expect(disclosure).not.toHaveAttribute("open");
    // 48px is the gate's floor for every target; the summary is the target here.
    expect(summary).toHaveClass("min-h-12", "px-4");
    expect(disclosure).toHaveClass("border");
    await userEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Request ID approval:42")).toBeVisible();
  });

  it("keeps a refused request's code and reference behind System details, and shows nothing for any other error", async () => {
    const { container, rerender } = render(
      <ErrorSystemDetails error={new Error("D1_ERROR: no such table")} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <ErrorSystemDetails
        error={
          new ApiError({
            status: 409,
            code: "approval_conflict",
            message: "The request changed.",
            requestId: "req-7",
          })
        }
      />,
    );
    const code = screen.getByText("approval_conflict");
    expect(code).not.toBeVisible();
    await userEvent.click(screen.getByText("System details"));
    expect(code).toBeVisible();
    expect(screen.getByText("req-7")).toBeVisible();
    expect(screen.queryByText(/The request changed/)).not.toBeInTheDocument();
  });

  it("gives every status its own glyph shape and always says it in words", () => {
    const kinds: StatusKind[] = [
      "confirmed",
      "pending",
      "local",
      "attention",
      "stopped",
      "neutral",
      "retired",
    ];
    const { container } = render(
      <>
        {kinds.map((kind) => (
          <Status key={kind} kind={kind}>
            {`Word for ${kind}`}
          </Status>
        ))}
      </>,
    );
    for (const kind of kinds) expect(screen.getByText(`Word for ${kind}`)).toBeVisible();
    const glyphs = [...container.querySelectorAll("svg[data-glyph]")];
    expect(glyphs).toHaveLength(kinds.length);
    for (const glyph of glyphs) expect(glyph).toHaveAttribute("aria-hidden", "true");
    // Shape, not colour: no two kinds draw the same SVG.
    expect(new Set(glyphs.map((glyph) => glyph.innerHTML)).size).toBe(kinds.length);
  });

  it("shows money states as a status with a glyph and the same words as before", () => {
    const { container } = render(<MoneyBadge badge="mismatched" />);
    expect(screen.getByText("Mismatched")).toBeVisible();
    expect(container.querySelector("[data-status]")).toHaveAttribute("data-status", "stopped");
  });

  it("offers a local tone for work that only exists on this device, with actions", () => {
    render(
      <Notice tone="local" title="Saved on this phone" actions={<Button>Send now</Button>}>
        It has not reached the office yet.
      </Notice>,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Saved on this phone");
    expect(notice).toHaveTextContent("It has not reached the office yet.");
    expect(within(notice).getByRole("button", { name: "Send now" })).toBeVisible();
  });

  it("lays out a labelled queue whose rows mark the current one", () => {
    render(
      <Queue label="Needs a decision">
        <QueueRow
          reference={<RefTag id="IW-1001" />}
          title="Replace north slope"
          next="Approve the revised quote"
          meta={<Status kind="attention">Waiting on you</Status>}
          action={<a href="/jobs/IW-1001">Open</a>}
          current
        />
        <QueueRow title="Gutter repair" />
      </Queue>,
    );
    const list = screen.getByRole("list", { name: "Needs a decision" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(within(rows[0]!).getByText("Approve the revised quote")).toBeVisible();
    expect(within(rows[0]!).getByRole("link", { name: "Open" })).toBeVisible();
  });

  it("titles a page with one h1 and keeps back, meta and actions around it", () => {
    render(
      <PageHeader
        back={<a href="/sales">Back to sales</a>}
        eyebrow="Estimate"
        title="Replace north slope"
        meta={<RefTag id="IW-1001" />}
        actions={<Button>Send quote</Button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Replace north slope" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to sales" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send quote" })).toBeVisible();
  });

  it("uses a nav for section tabs and a labelled group for chips and controls", () => {
    render(
      <>
        <Segmented variant="tabs" label="Job sections">
          <a href="#overview" aria-current="page">
            Overview
          </a>
          <a href="#money">Money</a>
        </Segmented>
        <Segmented variant="filters" label="Status filter">
          <button type="button" aria-pressed="true">
            Open <SegmentedCount>4</SegmentedCount>
          </button>
          <button type="button" aria-pressed="false">
            Closed
          </button>
        </Segmented>
      </>,
    );
    const tabs = screen.getByRole("navigation", { name: "Job sections" });
    expect(within(tabs).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const filters = screen.getByRole("group", { name: "Status filter" });
    expect(within(filters).getByRole("button", { name: "Open 4" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports save state honestly and offers to save again after a failure", async () => {
    const retry = vi.fn();
    const { rerender } = render(<SaveIndicator state="saving" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");

    rerender(<SaveIndicator state="saved" savedAt="2 minutes ago" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved 2 minutes ago");

    rerender(<SaveIndicator state="editing" />);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");

    rerender(<SaveIndicator state="failed" onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved.");
    await userEvent.click(screen.getByRole("button", { name: "Save again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("lists activity as a labelled ordered list with machine-readable times", () => {
    render(
      <Timeline
        label="Job activity"
        entries={[
          { id: "1", actor: "Dana", text: "approved the quote", when: "Jul 10", at: "2026-07-10" },
          { id: "2", actor: "Sam", text: "booked the crew", when: "Jul 11" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Job activity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Jul 10")).toHaveAttribute("datetime", "2026-07-10");
  });

  it("focuses the error summary when it appears and sends each item to its field", async () => {
    const { rerender } = render(
      <>
        <ErrorSummary errors={[]} />
        <label htmlFor="amount">Amount</label>
        <input id="amount" />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <>
        <ErrorSummary errors={[{ fieldId: "amount", message: "Enter the amount" }]} />
        <label htmlFor="amount">Amount</label>
        <input id="amount" />
      </>,
    );
    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();
    await userEvent.click(within(summary).getByRole("link", { name: "Enter the amount" }));
    expect(screen.getByLabelText("Amount")).toHaveFocus();
  });

  it("opens a native modal dialog, closes on request, and reports a user close once", async () => {
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Cancel job
          </button>
          <Dialog
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            title="Cancel IW-1001?"
            description="The crew is told before anything changes."
            footer={<Button variant="danger">Cancel job</Button>}
          >
            <p>Nothing is refunded automatically.</p>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel IW-1001?" });
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAccessibleDescription("The crew is told before anything changes.");

    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(dialog).not.toHaveAttribute("open");
  });

  it("names the wordmark and keeps the shield decorative unless labelled", () => {
    const { container } = render(
      <>
        <Logo />
        <Logo surface="dark" height={24} />
        <BrandMark />
      </>,
    );
    const logos = screen.getAllByRole("img", { name: "Iron Wrap Exteriors" });
    // `auto` ships both artworks and lets styles.css show the one the appearance calls for.
    expect(logos[0]).toHaveAttribute("src", "/brand/logo.png");
    expect(logos[0]).toHaveAttribute("data-on", "light");
    expect(logos[1]).toHaveAttribute("src", "/brand/logo-on-dark.png");
    expect(logos[1]).toHaveAttribute("data-on", "dark");
    expect(logos[2]).toHaveAttribute("src", "/brand/logo-on-dark.png");
    expect(logos[2]).not.toHaveAttribute("data-on");
    expect(logos[2]).toHaveAttribute("width", "82");
    expect(container.querySelector('img[src="/brand/shield.png"]')).toHaveAttribute("alt", "");
  });
});
