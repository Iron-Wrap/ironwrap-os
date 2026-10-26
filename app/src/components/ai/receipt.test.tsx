import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Receipt, type ReceiptDisplay } from "./receipt";
import { ReceiptRow } from "./receipt-row";
import { TimelineItem } from "./timeline-item";
import { receiptActions, type ContractReceipt, type ReceiptState } from "./words";

/** A synthetic step: the final invoice for the Harlow job, prepared by the AI bookkeeper. */
function receipt(overrides: Partial<ContractReceipt> = {}): ContractReceipt {
  return {
    specialist_id: "billing_reconciliation",
    run_id: "run_7f3a",
    action_id: "invoice.send_final",
    did: "Prepared the final invoice from the accepted contract and the accepted change order.",
    doing: null,
    needs_from_you: null,
    sources: [
      { fact_id: "contract:iw-1044", version: 3, hash: "9c1e44aa" },
      { fact_id: "change_order:co-1044-1", version: 1, hash: null },
    ],
    policy: {
      policy_id: "policy.invoice_send",
      version: "4",
      result: "allow",
      checks: [{ check: "amount_ceiling", passed: true }],
      reason_codes: [],
    },
    permit: {
      kind: "asks_first",
      permit_id: "permit_51",
      approval_id: "approval_88",
      approved_by: "person_dana",
      delegation_id: null,
    },
    tool: {
      name: "quickbooks.invoice_create",
      binding: "quickbooks",
      idempotency_key: "idem_42",
      request_hash: "7d0f12bb",
    },
    readback: {
      source: "quickbooks",
      reference: "INV-5521",
      response_hash: "e3b0c442",
      matched: true,
    },
    outcome: "succeeded",
    undo: { mode: "automatic", action_id: "invoice.void", available: true },
    do_it_myself: { surface: "/money/invoices/new", context: { job: "IW-1044" } },
    ...overrides,
  };
}

const display: ReceiptDisplay = {
  title: "Final invoice for Kara Harlow, CAD 9,860.00",
  when: { text: "Today 06:42" },
  sources: [
    { kind: "record", label: "Contract", code: "IW-1044" },
    { kind: "record", label: "Change order", code: "CO-1044-1" },
  ],
  people: { person_dana: "Dana Whitford" },
  where: "QuickBooks",
  approvedWhen: "today 09:52",
  checkedWhen: "today 10:31",
  primary: "Approve the final invoice",
  consequence: "Sends the invoice to QuickBooks once. Can't be undone after Kara Harlow pays it.",
  edit: { object: "the invoice", opens: "Opens the invoice screen with this draft filled in" },
  undoUntil: "today 18:00",
  undoDoes: "Undo voids the invoice in QuickBooks.",
  delegation: "asks_first",
  actionClass: "A3",
};

const needsYou = receipt({
  outcome: null,
  readback: null,
  permit: { ...receipt().permit, approved_by: null, approval_id: null, permit_id: null },
  needs_from_you: {
    reviewer_role: "owner",
    person_id: "person_dana",
    ask: "Approve it. Approving sends it to QuickBooks once.",
  },
  policy: { ...receipt().policy, result: "needs_approval" },
});

const ranks = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.tagName === "BUTTON" && !button.closest("summary"))
    .map((button) => `${button.textContent?.trim()}:${button.getAttribute("data-variant")}`);

describe("Receipt", () => {
  it("names the step by its title, says who did it and states its state in words", () => {
    render(<Receipt receipt={receipt()} display={display} onUndo={vi.fn()} />);
    const card = screen.getByRole("article", { name: display.title as string });
    expect(card).toHaveAttribute("data-state", "done");
    expect(within(card).getByText("AI bookkeeper")).toBeVisible();
    expect(within(card).getByText("Done for you")).toBeVisible();
    expect(within(card).getByText("Today 06:42")).toBeVisible();
    // The people see the delegation words, never the class.
    expect(within(card).getByText("Asks first")).toBeVisible();
    expect(within(card).getByText("A3")).not.toBeVisible();
    expect(within(card).getByText("Did")).toBeVisible();
    expect(within(card).getByRole("list", { name: "Where this came from" })).toBeVisible();
    expect(
      within(card).getByText(
        "Approved by Dana Whitford today 09:52. Checked in QuickBooks today 10:31: matches.",
      ),
    ).toBeVisible();
  });

  it("keeps run, action, permit, tool and hashes closed behind System details", async () => {
    render(<Receipt receipt={receipt()} display={display} />);
    for (const fact of ["run_7f3a", "invoice.send_final", "permit_51", "idem_42", "9c1e44aa"])
      expect(screen.getByText(fact)).not.toBeVisible();
    await userEvent.click(screen.getByText("System details"));
    for (const fact of ["run_7f3a", "invoice.send_final", "permit_51", "idem_42", "9c1e44aa"])
      expect(screen.getByText(fact)).toBeVisible();
    expect(screen.getByText("7d0f12bb")).toBeVisible();
    expect(screen.getByText("e3b0c442")).toBeVisible();
  });

  it("ranks the actions of each state the way the copy table does", () => {
    const every = { primary: true, next: true, stop: true, undo: true, edit: true };
    const states: [ReceiptState, string[]][] = [
      // Nothing has run on a card waiting for approval, so there is nothing to undo (gate R2-1).
      ["needs_you", ["primary:you", "edit:secondary"]],
      // A standing watch stops in place of Undo.
      ["done", ["stop:secondary", "edit:quiet"]],
      ["held", ["next:secondary", "edit:secondary"]],
      ["working", ["edit:secondary"]],
      ["undone", ["edit:secondary"]],
      ["replaced", []],
      ["done_by_person", []],
    ];
    for (const [state, expected] of states)
      expect(
        receiptActions(state, every).map((action) => `${action.id}:${action.rank}`),
        state,
      ).toEqual(expected);
    expect(
      receiptActions("done", { ...every, stop: false }).map(
        (action) => `${action.id}:${action.rank}`,
      ),
    ).toEqual(["undo:secondary", "edit:quiet"]);
    // A button appears only when it can do something: its handler, and for Edit the screen
    // it opens and the line that says so.
    const none = { primary: false, next: false, stop: false, undo: false, edit: false };
    for (const [state] of states) expect(receiptActions(state, none), state).toEqual([]);
  });

  it("puts the one blue primary first in Needs you, with its consequence and the ways out", async () => {
    const approve = vi.fn();
    render(
      <Receipt
        receipt={needsYou}
        display={display}
        viewerMayDecide
        onPrimary={approve}
        onEdit={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-state", "needs_you");
    expect(card).toHaveClass("bg-signal-you-tint");
    expect(
      within(card).getByText("Needs you", { selector: "[data-status] *, [data-status]" }),
    ).toBeVisible();
    expect(within(card).getByText("Why it asks you")).toBeVisible();
    expect(ranks()).toEqual(["Approve the final invoice:you", "Edit the invoice:secondary"]);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    const primary = screen.getByRole("button", { name: "Approve the final invoice" });
    expect(primary).toHaveAccessibleDescription(display.consequence!);
    expect(screen.getByRole("button", { name: "Edit the invoice" })).toHaveAccessibleDescription(
      "Opens the invoice screen with this draft filled in. It does not undo anything.",
    );
    expect(screen.getByText(/does not undo anything/).closest("p")).toHaveTextContent(
      "Opens the invoice screen with this draft filled in. It does not undo anything.",
    );
    // The step has not run: its consequence speaks, not an undo window (gate finding F2).
    expect(screen.queryByText(/You can undo this/)).toBeNull();
    await userEvent.click(primary);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("waits on the person who decides, without blue or a primary, when the viewer may not decide", () => {
    render(<Receipt receipt={needsYou} display={display} onPrimary={vi.fn()} onEdit={vi.fn()} />);
    const card = screen.getByRole("article");
    expect(card).not.toHaveClass("bg-signal-you-tint");
    const chip = within(card).getByText("Waiting on Dana Whitford").closest("[data-status]")!;
    expect(chip).toHaveAttribute("data-status", "pending");
    expect(within(card).queryByText("Needs you")).not.toBeInTheDocument();
    expect(within(card).getByText("Who decides")).toBeVisible();
    // It says whom it asks, not "Approve it" as an order to someone who cannot (gate R3b-3).
    expect(within(card).getByText("What Dana Whitford is asked")).toBeVisible();
    expect(within(card).getByText("Dana Whitford, Owner")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve the final invoice" })).toBeNull();
    // The consequence belongs to the primary, so it leaves with it.
    expect(screen.queryByText(display.consequence!)).toBeNull();
    expect(card.innerHTML).not.toMatch(/signal-you/);
    // Doing it yourself does not go around the decision, and the card says so.
    expect(within(card).getByText(/Dana Whitford still decides\./)).toBeVisible();
  });

  it("tells a viewer who does not decide what their part is, and only them", () => {
    const viewerPart =
      "You may change this invoice. You cannot approve it; Dana Whitford approves it.";
    const { rerender } = render(
      <Receipt receipt={needsYou} display={{ ...display, viewerPart }} onEdit={vi.fn()} />,
    );
    expect(screen.getByText("Your part")).toBeVisible();
    expect(screen.getByText(viewerPart)).toBeVisible();
    rerender(
      <Receipt
        receipt={needsYou}
        display={{ ...display, viewerPart }}
        viewerMayDecide
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryByText("Your part")).toBeNull();
  });

  it("never names a job title as who decides when no person is named", () => {
    render(
      <Receipt
        receipt={{
          ...needsYou,
          needs_from_you: { reviewer_role: "accounting", person_id: null, ask: "Approve it." },
        }}
        display={display}
      />,
    );
    // IRW-R8d rule 7: a job title never names who decides; with nobody named it reads "a person".
    expect(screen.getByText("Waiting on a person")).toBeVisible();
    expect(screen.queryByText(/accounting/i)).toBeNull();
  });

  it("gives Undo its own line after the work is done, and says what it undoes", () => {
    render(<Receipt receipt={receipt()} display={display} onUndo={vi.fn()} />);
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveAccessibleDescription(
      "You can undo this until today 18:00. Undo voids the invoice in QuickBooks.",
    );
    // No handler, no button and no promise.
    expect(screen.queryByRole("button", { name: "Edit the invoice" })).toBeNull();
  });

  it("tells a viewer who does not decide where the edit goes and who still decides", () => {
    render(
      <Receipt
        receipt={needsYou}
        display={{
          ...display,
          edit: {
            ...display.edit!,
            after:
              "You may fix it. Your fix goes into this draft, and Dana Whitford approves it first.",
          },
        }}
        onEdit={vi.fn()}
      />,
    );
    // The screen's own words say who still decides, so the default sentence is not repeated.
    expect(screen.getByRole("button", { name: "Edit the invoice" })).toHaveAccessibleDescription(
      "Opens the invoice screen with this draft filled in. It does not undo anything. You may fix it. Your fix goes into this draft, and Dana Whitford approves it first.",
    );
  });

  it("still names who decides when the after-clause does not", () => {
    render(
      <Receipt
        receipt={needsYou}
        display={{
          ...display,
          edit: { ...display.edit!, after: "Nothing goes to QuickBooks until it is approved." },
        }}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit the invoice" })).toHaveAccessibleDescription(
      "Opens the invoice screen with this draft filled in. It does not undo anything. Nothing goes to QuickBooks until it is approved. Dana Whitford still decides.",
    );
  });

  it("says it does not undo anything once, whatever the screen passes as the Edit line", () => {
    render(
      <Receipt
        receipt={needsYou}
        display={{
          ...display,
          edit: {
            object: "the lead",
            opens: "Opens the lead with the call notes filled in; reverts nothing.",
          },
        }}
        viewerMayDecide
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit the lead" })).toHaveAccessibleDescription(
      "Opens the lead with the call notes filled in. It does not undo anything.",
    );
  });

  it("shows a button only when its handler is there, and Edit only with its screen and words", () => {
    const { rerender } = render(
      <Receipt receipt={needsYou} display={display} viewerMayDecide onEdit={vi.fn()} />,
    );
    // No onPrimary: no primary.
    expect(screen.queryByRole("button", { name: "Approve the final invoice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit the invoice" })).toBeVisible();

    rerender(
      <Receipt
        receipt={{ ...needsYou, do_it_myself: { surface: null, context: null } }}
        display={display}
        viewerMayDecide
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit the invoice" })).toBeNull();

    rerender(
      <Receipt
        receipt={needsYou}
        display={{ ...display, edit: undefined }}
        viewerMayDecide
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit the invoice" })).toBeNull();
    expect(screen.queryByText(/does not undo anything/)).toBeNull();

    rerender(
      <Receipt
        receipt={receipt()}
        display={{ ...display, stop: "Stop the storm watch", nextAction: "Review it" }}
      />,
    );
    expect(screen.queryAllByRole("button").filter((b) => b.tagName === "BUTTON")).toEqual([]);
  });

  it("ranks Undo first after the work is done, and Stop in its place for a standing watch", () => {
    const { rerender } = render(
      <Receipt receipt={receipt()} display={display} onUndo={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(ranks()).toEqual(["Undo:secondary", "Edit the invoice:quiet"]);
    rerender(
      <Receipt
        receipt={receipt()}
        display={{ ...display, stop: "Stop the storm watch" }}
        onUndo={vi.fn()}
        onStop={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(ranks()).toEqual(["Stop the storm watch:secondary", "Edit the invoice:quiet"]);
    // A watch never says it cannot be undone.
    expect(screen.queryByText(/can't be undone|you can undo/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    // A stop sign, not an empty square that reads as a checkbox (gate F10).
    expect(
      screen.getByRole("button", { name: "Stop the storm watch" }).querySelector("svg"),
    ).toHaveClass("lucide-circle-stop");
  });

  it("says when a step cannot be undone, and why", () => {
    render(
      <Receipt
        receipt={receipt({ undo: { mode: "none", action_id: null, available: false } })}
        display={{ ...display, cannotUndo: "the email was delivered" }}
      />,
    );
    expect(screen.getByText("Can't be undone: the email was delivered.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("holds in red with the reason in one sentence and the one next step as a button", () => {
    render(
      <Receipt
        receipt={receipt({
          specialist_id: "shop_planner",
          outcome: "abstained",
          readback: null,
          policy: { ...receipt().policy, result: "deny", reason_codes: ["fact_conflict"] },
        })}
        display={{
          ...display,
          title: "Cannot plan cuts for the Harlow job",
          nextAction: "Review the quality problem",
        }}
        onNext={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveClass("bg-signal-held-tint");
    expect(within(card).getByText("Held")).toBeVisible();
    expect(within(card).getByText("Why it waits")).toBeVisible();
    expect(within(card).getByText("Two records disagree.")).toBeVisible();
    expect(within(card).getByText("Decide which record is right.")).toBeVisible();
    expect(ranks()).toEqual(["Review the quality problem:secondary", "Edit the invoice:secondary"]);
  });

  it("is waiting, not done, until the outside system confirms", () => {
    render(
      <Receipt
        receipt={receipt({
          outcome: "unknown",
          readback: null,
          policy: { ...receipt().policy, reason_codes: ["no_readback_yet"] },
        })}
        display={display}
      />,
    );
    expect(screen.getByText("Working on it")).toBeVisible();
    expect(screen.getByText("Waiting for QuickBooks to confirm.")).toBeVisible();
    expect(screen.getByText(/Not checked yet\./)).toBeVisible();
    expect(screen.queryByText("Done for you")).not.toBeInTheDocument();
  });

  it("names the person who undid it", () => {
    render(
      <Receipt
        receipt={receipt({
          outcome: "failed",
          policy: { ...receipt().policy, reason_codes: ["declined"] },
        })}
        display={{
          ...display,
          by: "person_dana",
          since: "The invoice is as it was before.",
        }}
      />,
    );
    expect(screen.getByText("Undone by Dana Whitford")).toBeVisible();
    expect(screen.getByText("The invoice is as it was before.")).toBeVisible();
  });

  it("takes the phone layout in touch, glove or a narrow container", () => {
    const { container } = render(
      <Receipt receipt={receipt()} display={display} onUndo={vi.fn()} onEdit={vi.fn()} />,
    );
    const article = container.querySelector("article")!;
    expect(article).toHaveClass("@container");
    expect(container.querySelector("dl > div")).toHaveClass("phone:grid-cols-1");
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveClass("phone:w-full", "phone:min-h-[max(3rem,var(--control-height))]");
  });
});

describe("ReceiptRow", () => {
  it("is one target named by the summary and the state, with one outlined action", async () => {
    const open = vi.fn();
    render(
      <ReceiptRow
        who="billing_reconciliation"
        state="needs_you"
        summary="Final invoice for Kara Harlow, CAD 9,860.00"
        line="Job IW-1044 · prepared from the accepted contract"
        action="Review the invoice"
        viewerMayDecide
        onOpen={open}
      />,
    );
    const row = screen.getByRole("button", {
      name: "Final invoice for Kara Harlow, CAD 9,860.00 Needs you",
    });
    expect(row).toHaveAccessibleDescription(
      "Job IW-1044 · prepared from the accepted contract Review the invoice",
    );
    expect(row).toHaveClass("ai-row-target", "absolute", "inset-0");
    const action = screen.getByRole("button", { name: "Review the invoice" });
    // Outlined, never a second primary; hidden on the phone, where the row is the target.
    expect(action).toHaveAttribute("data-variant", "secondary");
    expect(action).toHaveClass("phone:hidden");
    await userEvent.click(row);
    await userEvent.click(action);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("is 56px on the office and 64px or taller as one target on the phone", () => {
    const { container } = render(
      <ReceiptRow
        who="quality_inspector"
        state="done"
        summary="Checked 10 completion photos"
        href="/receipts/run_1"
        action="See receipt for the photos"
      />,
    );
    const grid = container.querySelector("[data-state]")!;
    expect(grid).toHaveClass("min-h-14", "phone:min-h-[max(4rem,var(--row-min-height))]");
    expect(
      screen.getByRole("link", { name: "Checked 10 completion photos Done for you" }),
    ).toHaveAttribute("href", "/receipts/run_1");
    expect(screen.getByText("Done for you").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "done",
    );
  });

  it("states every receipt state in words and colours only Needs you and Held", () => {
    const { container } = render(
      <>
        {(["needs_you", "working", "done", "held", "undone", "replaced"] as const).map((state) => (
          <ReceiptRow key={state} who="estimator" state={state} summary={state} viewerMayDecide />
        ))}
        <ReceiptRow state="done_by_person" by={{ name: "Grace Obi" }} summary="Crew booked" />
        <ReceiptRow who="estimator" state="needs_you" summary="Quote" waitingOn="Dana Whitford" />
      </>,
    );
    const words = [...container.querySelectorAll("[data-status]")].map((chip) => chip.textContent);
    expect(words).toEqual([
      "Needs you",
      "Working on it",
      "Done for you",
      "Held",
      "Undone",
      "Replaced",
      "Done by Grace Obi",
      // Needs you is the viewer's: anyone else reads who decides, in ink.
      "Waiting on Dana Whitford",
    ]);
    const coloured = [...container.querySelectorAll("[data-status]")]
      .filter((chip) => /signal-you|danger/.test(chip.className))
      .map((chip) => chip.textContent);
    expect(coloured).toEqual(["Needs you", "Held"]);
  });

  it("offers no target and no action when nothing opens the receipt", () => {
    render(<ReceiptRow who="estimator" state="done" summary="Quote" action="See receipt" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("See receipt")).toBeNull();
  });
});

describe("a step a person did", () => {
  const personDone = receipt({
    specialist_id: "scheduler_dispatcher",
    outcome: "failed",
    readback: null,
    policy: { ...receipt().policy, reason_codes: ["done_by_person"] },
  });
  const people = { person_grace: "Grace Obi" };

  it("shows the person's initials on the receipt, never the AI badge", () => {
    const { container } = render(
      <Receipt
        receipt={personDone}
        display={{ ...display, title: "Crew for the Harlow job", people, by: "person_grace" }}
      />,
    );
    const header = container.querySelector("header")!;
    expect(header.querySelector('[data-shape="circle"]')).toHaveTextContent("GO");
    expect(container.querySelector('[data-shape="rounded-square"]')).toBeNull();
    expect(within(header).getByText("Grace Obi")).toBeVisible();
    expect(within(header).queryByText("AI scheduler")).not.toBeInTheDocument();
    const chip = within(header).getByText("Done by Grace Obi").closest("[data-status]")!;
    expect(chip.querySelector("svg")).toHaveAttribute("data-glyph", "done");
  });

  it("draws a neutral person, never the AI badge, when it does not know who did it", () => {
    const { container } = render(
      <Receipt receipt={personDone} display={{ ...display, title: "Crew for the Harlow job" }} />,
    );
    const header = container.querySelector("header")!;
    expect(header.querySelector('[data-shape="circle"] svg')).toBeInTheDocument();
    expect(container.querySelector('[data-shape="rounded-square"]')).toBeNull();
    expect(within(header).getByText("Done by a person")).toBeVisible();
    expect(within(header).getByText("A person")).toBeVisible();
  });

  it("says the answer is still on its way, with the clock, until it reaches the phone", () => {
    render(
      <Receipt
        receipt={personDone}
        display={{ ...display, people, by: "person_grace", waitingFor: "the phone" }}
      />,
    );
    const chip = screen
      .getByText("Answered by Grace Obi · waiting for the phone")
      .closest("[data-status]")!;
    expect(chip).toHaveAttribute("data-status", "pending");
    expect(chip.querySelector("svg")).toHaveAttribute("data-glyph", "pending");
  });

  it("shows the person's initials on the row, never the AI badge", () => {
    const { container } = render(
      <ReceiptRow
        state="done_by_person"
        by={{ name: "Grace Obi" }}
        summary="Crew for the Harlow job"
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-shape="circle"]')).toHaveTextContent("GO");
    expect(container.querySelector('[data-shape="rounded-square"]')).toBeNull();
    expect(
      screen.getByRole("button", { name: "Crew for the Harlow job Done by Grace Obi" }),
    ).toBeInTheDocument();
  });

  it("shows the person's initials in the history, never the AI badge", () => {
    const { container } = render(
      <ol>
        <TimelineItem
          actor="specialist"
          who="scheduler_dispatcher"
          state="done_by_person"
          by={{ name: "Grace Obi" }}
          when={{ text: "Today 08:10" }}
          what="The crew for the Harlow job was booked"
        />
        <TimelineItem
          actor="specialist"
          who="scheduler_dispatcher"
          state="done"
          when={{ text: "Today 08:12" }}
          what="AI scheduler told the north crew"
        />
      </ol>,
    );
    const [person, agent] = [...container.querySelectorAll("li")];
    expect(person!.querySelector('[data-shape="circle"]')).toHaveTextContent("GO");
    expect(person!.querySelector('[data-shape="rounded-square"]')).toBeNull();
    expect(within(person!).getByText("Done by Grace Obi")).toBeVisible();
    expect(agent!.querySelector('[data-shape="rounded-square"]')).toBeInTheDocument();
    expect(within(agent!).getByText("Done for you")).toBeVisible();
  });

  it("says what stopping a watch does before the press, and never calls it undone", () => {
    render(
      <Receipt
        receipt={receipt({ undo: { mode: "none", action_id: null, available: false } })}
        display={{
          ...display,
          title: "Started the storm watch",
          stop: "Stop the storm watch",
          stopNote: "Stopping ends the hail alerts. You can ask IronWrap to start it again.",
        }}
        onStop={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Stop the storm watch" }),
    ).toHaveAccessibleDescription(
      "Stopping ends the hail alerts. You can ask IronWrap to start it again.",
    );
    expect(screen.queryByText(/can't be undone|undone/i)).toBeNull();
  });

  it("gives a step that waits for a person its consequence, not an undo window", () => {
    render(
      <Receipt
        receipt={needsYou}
        display={{ ...display, consequence: "Sends it once." }}
        viewerMayDecide
        onPrimary={() => {}}
      />,
    );
    expect(screen.queryByText(/You can undo this/)).toBeNull();
    expect(screen.getByText("Sends it once.")).toBeVisible();
  });

  it("never prints a person id it cannot name", () => {
    render(
      <Receipt
        receipt={receipt({
          permit: {
            kind: "asks_first",
            permit_id: "permit_51",
            approval_id: "approval_88",
            approved_by: "person_gone",
            delegation_id: null,
          },
        })}
        display={{ ...display, people: {} }}
      />,
    );
    const card = screen.getByRole("article");
    expect(card.textContent).not.toMatch(/person_gone/);
    expect(within(card).getByText(/Approved by a person/)).toBeVisible();
  });
});

describe("a people-only draft that left Needs you", () => {
  const draft = (reason: "applied_by_person" | "superseded") =>
    receipt({
      specialist_id: "compliance",
      action_id: "access.prepare_change",
      did: "Prepared a role change for Grace Obi: from Field to Sales.",
      tool: null,
      readback: null,
      permit: { ...receipt().permit, kind: "draft", approved_by: null, approval_id: null },
      policy: { ...receipt().policy, reason_codes: [reason] },
    });
  const closed: ReceiptDisplay = {
    title: "Move from Field to Sales",
    when: { text: "Yesterday 16:20" },
    sources: [{ kind: "message", label: "Request from Grace Obi", code: "RQ-311" }],
    people: { person_dana: "Dana Whitford" },
    record: "Grace Obi's role",
  };

  it("says who made the change, that it stays and that nothing is left, with no button", () => {
    render(
      <Receipt receipt={draft("applied_by_person")} display={{ ...closed, by: "person_dana" }} />,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-state", "done_by_person");
    expect(within(card).getByText("Done by Dana Whitford")).toBeVisible();
    expect(within(card).getByText("Since then")).toBeVisible();
    expect(
      within(card).getByText(
        "Dana Whitford already made this change to Grace Obi's role, so this draft is closed. The change stays in place, and nothing is left to do.",
      ),
    ).toBeVisible();
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  it("says who changed the record by hand and what it is now, from the draft's applied record", () => {
    const changed = {
      ...draft("applied_by_person"),
      readback: {
        source: "owned_store",
        reference: "person:user_grace",
        response_hash: "sha256:role",
        matched: true,
      },
      do_it_myself: {
        surface: "/settings/team",
        context: { applied: { field: "role", value: "production", by: "person_dana" } },
      },
    };
    render(<Receipt receipt={changed} display={closed} />);
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-state", "done_by_person");
    // The person comes from the applied record when the screen names no one.
    expect(within(card).getByText("Done by Dana Whitford")).toBeVisible();
    expect(
      within(card).getByText(
        "Dana Whitford changed Grace Obi's role by hand, so this draft is closed. Grace Obi's role is now Production.",
      ),
    ).toBeVisible();
    expect(card.textContent).not.toMatch(/this change|person_dana|production\b/);
    // The read-back names the changed record; it is not a check in another system.
    expect(within(card).queryByText("Checked")).toBeNull();
    expect(card.textContent).not.toMatch(/other system/);
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  it("never prints the id of a person in the applied record it cannot name", () => {
    const changed = {
      ...draft("applied_by_person"),
      do_it_myself: {
        surface: null,
        context: { applied: { field: "role", value: "sales", by: "person_gone" } },
      },
    };
    render(<Receipt receipt={changed} display={closed} />);
    const card = screen.getByRole("article");
    expect(card.textContent).not.toMatch(/person_gone/);
    expect(
      within(card).getByText(
        "A person changed Grace Obi's role by hand, so this draft is closed. Grace Obi's role is now Sales.",
      ),
    ).toBeVisible();
  });

  it("says a newer draft replaced it, that it changed nothing and where the newer one is", () => {
    const replaced = {
      ...draft("superseded"),
      readback: {
        source: "owned_store",
        reference: "step/step_newer",
        response_hash: "sha256:args",
        matched: true,
      },
    };
    render(<Receipt receipt={replaced} display={closed} />);
    const card = screen.getByRole("article");
    expect(within(card).queryByText("Checked")).toBeNull();
    expect(card).toHaveAttribute("data-state", "replaced");
    expect(within(card).getByText("Replaced")).toBeVisible();
    expect(
      within(card).getByText(
        "A newer draft for Grace Obi's role replaced this one. This draft changed nothing; the newer draft is in Needs you.",
      ),
    ).toBeVisible();
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  it("keeps the screen's own line when it passes one", () => {
    render(
      <Receipt receipt={draft("superseded")} display={{ ...closed, since: "Replaced on Mon." }} />,
    );
    expect(screen.getByText("Replaced on Mon.")).toBeVisible();
    expect(screen.queryByText(/This draft changed nothing/)).toBeNull();
  });

  it("never puts an answer's refused-view line on a receipt card", () => {
    render(
      <Receipt
        receipt={receipt({ policy: { ...receipt().policy, reason_codes: ["view_spec_invalid"] } })}
        display={display}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByText("Since then")).toBeNull();
    expect(screen.queryByText(/couldn't draw the layout/)).toBeNull();
  });
});

describe("a step a newer one replaced or a person did, with no line from the screen", () => {
  it.each(["superseded", "done_by_person"] as const)(
    "shows no empty Since then row: failed/%s",
    (reason) => {
      render(
        <Receipt
          receipt={receipt({
            outcome: "failed",
            readback: null,
            policy: { ...receipt().policy, reason_codes: [reason] },
          })}
          display={{ ...display, people: { person_dana: "Dana Whitford" } }}
        />,
      );
      expect(screen.queryByText("Since then")).toBeNull();
    },
  );
});
