import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "../ui/dialog";
import { Alert } from "./alert";
import { AskEntry } from "./ask-entry";
import { AiBadge, PersonAvatar } from "./badge";
import { BriefSection } from "./brief-section";
import { Conversation } from "./conversation";
import { DelegationPill } from "./delegation";
import { MacroTile } from "./macro-tile";
import { Message } from "./message";
import { AiName } from "./name";
import { ProposedValue } from "./proposed";
import { SourceChip } from "./source";
import { TimelineItem } from "./timeline-item";
import { Receipt } from "./receipt";
import {
  DELEGATION,
  SPECIALIST_IDS,
  VIEW_REFUSED,
  specialistName,
  type DelegationSetting,
} from "./words";

describe("who acted", () => {
  it("draws every agent as a rounded square with its glyph and every person as a circle", () => {
    const { container } = render(
      <>
        {SPECIALIST_IDS.map((who) => (
          <AiBadge key={who} who={who} />
        ))}
        <PersonAvatar initials="DW" name="Dana Whitford" />
      </>,
    );
    for (const who of SPECIALIST_IDS) {
      const badge = screen.getByRole("img", { name: specialistName(who) });
      expect(badge).toHaveAttribute("data-shape", "rounded-square");
      expect(badge.className).not.toMatch(/rounded-full|signal-/);
    }
    // The face carries the brand mark; every specialist has a glyph of its own.
    expect(screen.getByRole("img", { name: "IronWrap" }).querySelector("img")).toHaveAttribute(
      "src",
      "/brand/shield.png",
    );
    const glyphs = [...container.querySelectorAll('[data-shape="rounded-square"] svg')].map((svg) =>
      svg.getAttribute("class"),
    );
    expect(new Set(glyphs).size).toBe(SPECIALIST_IDS.length - 1);
    const person = screen.getByRole("img", { name: "Dana Whitford" });
    expect(person).toHaveAttribute("data-shape", "circle");
    expect(person).toHaveTextContent("DW");
  });

  it("hides the badge beside the name, and the name always says AI or the brand", () => {
    render(
      <>
        <AiName who="estimator" />
        <AiName who="orchestrator" size="header" line="Makes the brief" />
      </>,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("AI estimator")).toBeVisible();
    expect(screen.getByText("IronWrap")).toBeVisible();
    expect(screen.getByText("Makes the brief")).toBeVisible();
  });
});

describe("delegation words", () => {
  it("says each setting in words with a glyph, in ink, never a class code", () => {
    const settings = Object.keys(DELEGATION) as DelegationSetting[];
    const { container } = render(
      <>
        {settings.map((setting) => (
          <DelegationPill key={setting} setting={setting} />
        ))}
      </>,
    );
    for (const setting of settings) {
      const pill = container.querySelector(`[data-delegation="${setting}"]`)!;
      expect(pill).toHaveTextContent(DELEGATION[setting].words);
      expect(pill.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(pill.className).not.toMatch(/signal-/);
    }
    expect(container).not.toHaveTextContent(/\bA[0-3]\b/);
  });
});

describe("proposed, not accepted yet", () => {
  it("carries the word, the open diamond and the dotted edge in every kind", async () => {
    const accept = vi.fn();
    const { container } = render(
      <>
        <ProposedValue kind="inline" value={{ minor: 3600, currency: "CAD" }} />
        <ProposedValue
          kind="field"
          label="South slope area"
          value="1,064 sq ft"
          caption="Proposed by AI measurer from the measurement report, page 3."
          onAccept={accept}
          onEdit={vi.fn()}
        />
        <ProposedValue kind="block" title="New quote for Kara Harlow">
          Drafted by AI estimator with today's steel price. Nothing goes to the customer until you
          approve it.
        </ProposedValue>
      </>,
    );
    const proposed = [...container.querySelectorAll("[data-proposed]")];
    expect(proposed).toHaveLength(3);
    for (const value of proposed) {
      expect(value).toHaveTextContent(/Proposed/);
      expect(value.querySelector('[data-glyph="proposed"]')).toBeInTheDocument();
    }
    expect(proposed[0]).toHaveClass("outline-dotted");
    expect(proposed[2]).toHaveClass("outline-dotted");
    // Money in the text face with tabular figures and every minor digit, never mono.
    // Text matchers read a no-break space as a space.
    const money = screen.getByText("CAD 36.00");
    expect(money).toHaveClass("tabular-nums");
    expect(money).not.toHaveClass("font-mono");
    // The word is the component's own and part of the name, whatever the caption says.
    expect(screen.getByRole("group", { name: "South slope area Proposed" })).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Proposed New quote for Kara Harlow" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(accept).toHaveBeenCalledOnce();
    // IRW-R8d R8d-1: Accept and Edit, never "Change"; a field has no Discard.
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Change|Discard/ })).toBeNull();
  });

  it("says what Edit does on a field, bound to the Edit button", () => {
    render(
      <ProposedValue
        kind="field"
        label="North slope area"
        value="988 sq ft"
        caption="Proposed by AI measurer from the drone photos of the north slope."
        acceptLabel="Accept 988 sq ft"
        editLabel="Edit the north slope area"
        editNote="Type your own figure; it replaces 988 sq ft and counts as yours."
        onAccept={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Edit the north slope area" }),
    ).toHaveAccessibleDescription(
      "Type your own figure; it replaces 988 sq ft and counts as yours.",
    );
  });

  it("offers Accept, Edit and Discard on a draft and says it is not sent or saved", async () => {
    const discard = vi.fn();
    render(
      <ProposedValue
        kind="block"
        title="New quote for Kara Harlow"
        onAccept={vi.fn()}
        onEdit={vi.fn()}
        onDiscard={discard}
        discardNote="Discarding removes this draft only; the last quote stays."
      />,
    );
    const draft = screen.getByRole("region", { name: "Proposed New quote for Kara Harlow" });
    expect(draft).toHaveTextContent(
      "Not sent, not saved to the record. Discarding removes this draft only; the last quote stays.",
    );
    expect(within(draft).getByRole("button", { name: "Accept" })).toBeVisible();
    expect(within(draft).getByRole("button", { name: "Edit" })).toBeVisible();
    await userEvent.click(within(draft).getByRole("button", { name: "Discard" }));
    expect(discard).toHaveBeenCalledOnce();
  });

  it("drops the proposed cues once a person accepted the value", () => {
    const { container } = render(
      <ProposedValue
        kind="field"
        label="South slope area"
        value="1,064 sq ft"
        caption="Accepted by Dana Whitford today 10:44."
        state="accepted"
        onAccept={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-proposed]")).toBeNull();
    expect(container.querySelector('[data-glyph="proposed"]')).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "South slope area" })).not.toHaveTextContent(
      /Proposed/,
    );
  });
});

describe("source chips", () => {
  it("shows the plain label first and the code in mono after it", () => {
    render(
      <>
        <SourceChip kind="record" label="Job" code="IW-1044" />
        <SourceChip kind="message" label="Email from Ahmad Haddad" href="/messages/m1" />
        <SourceChip kind="reading" label="Survey reading" code="S-7" check="stale" />
      </>,
    );
    const code = screen.getByText("IW-1044");
    expect(code.tagName).toBe("CODE");
    expect(code).toHaveClass("font-mono");
    expect(code.previousElementSibling).toHaveTextContent("Job");
    expect(screen.getByRole("link", { name: "Source: Email from Ahmad Haddad" })).toHaveAttribute(
      "href",
      "/messages/m1",
    );
    expect(screen.getByText(/Out of date/)).toBeVisible();
  });
});

describe("the face", () => {
  it("is a named search field on the desktop with a visible button beside the shortcut", async () => {
    const ask = vi.fn();
    render(<AskEntry place="desktop" onAsk={ask} bindShortcut />);
    const form = screen.getByRole("search", { name: "Ask IronWrap" });
    const field = within(form).getByRole("searchbox", { name: "Ask IronWrap" });
    expect(field).toHaveAttribute("placeholder", "Ask IronWrap or search work");
    expect(field).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
    expect(within(form).getByText("⌘K")).toHaveAttribute("aria-hidden", "true");
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(field).toHaveFocus();
    await userEvent.type(field, "Is the Harlow job on track?");
    await userEvent.click(within(form).getByRole("button", { name: "Ask" }));
    expect(ask).toHaveBeenCalledWith("Is the Harlow job on track?");
  });

  it("opens from a compact, a crew and a customer entry, each named in words", async () => {
    const open = vi.fn();
    render(
      <>
        <AskEntry place="compact" onOpen={open} />
        <AskEntry place="crew" onOpen={open} />
        <AskEntry place="customer" onOpen={open} />
      </>,
    );
    expect(screen.getAllByRole("button", { name: "Ask IronWrap" })).toHaveLength(2);
    const customer = screen.getByRole("button", { name: "Ask a question" });
    // The customer always learns it is AI and that a person can answer.
    expect(customer).toHaveAccessibleDescription(
      "AI customer care at Iron Wrap Exteriors. A person can answer too.",
    );
    await userEvent.click(customer);
    expect(open).toHaveBeenCalledOnce();
  });

  it("says why it cannot be used now instead of failing silently", () => {
    render(<AskEntry place="crew" unavailable="No signal. Ask again when you are back online." />);
    const entry = screen.getByRole("button", { name: "Ask IronWrap" });
    expect(entry).toBeDisabled();
    expect(entry).toHaveAccessibleDescription("No signal. Ask again when you are back online.");
  });
});

describe("conversation", () => {
  it("says under the answer when its generated view was refused, and where to ask again", () => {
    render(
      <Conversation place="docked" onSend={vi.fn()}>
        <Message
          from="ironwrap"
          parts={[
            {
              text: "Both crews work Mon to Fri this week.",
              sources: [{ kind: "record", label: "Schedule", code: "WK-42" }],
            },
          ]}
          note={VIEW_REFUSED}
        />
      </Conversation>,
    );
    const log = screen.getByRole("log");
    expect(within(log).getByText(VIEW_REFUSED)).toBeVisible();
    expect(within(log).getByText("Both crews work Mon to Fri this week.")).toBeVisible();
  });

  it("is a named panel with a message log, sources under every fact and a two-button composer", async () => {
    const send = vi.fn();
    render(
      <Conversation place="docked" onClose={vi.fn()} onSend={send} onSpeak={vi.fn()}>
        <Message from="person">Is the Harlow job on track?</Message>
        <Message
          from="ironwrap"
          parts={[
            {
              text: "No. Work on the Harlow job is stopped: rotten deck boards on the north slope.",
              sources: [{ kind: "record", label: "Stop report", code: "Yesterday 09:12" }],
            },
          ]}
        />
        <Message from="specialist" who="estimator" status="working" />
      </Conversation>,
    );
    const panel = screen.getByRole("complementary", { name: "Ask IronWrap" });
    const log = within(panel).getByRole("log");
    expect(within(log).getByText("Is the Harlow job on track?")).toBeVisible();
    expect(within(log).getByRole("list", { name: "Where this came from" })).toHaveTextContent(
      "Stop report",
    );
    expect(within(log).getByText("AI estimator")).toBeVisible();
    expect(within(log).getByText("Working on it")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Speak" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Close" })).toBeVisible();
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "Question for IronWrap" }),
      "What needs me today?",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith("What needs me today?");
  });

  it("is a dialog as a sheet and says offline in words, with sending switched off", () => {
    render(<Conversation place="sheet" state="offline" onSend={vi.fn()} />);
    const sheet = screen.getByRole("dialog", { name: "Ask IronWrap" });
    expect(within(sheet).getByText(/No signal/)).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(sheet).getByRole("textbox")).toBeDisabled();
  });

  it("offers Speak only with what listens, and a composer only with what sends", () => {
    const { rerender } = render(<Conversation place="docked" onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeVisible();
    rerender(<Conversation place="docked" state="unavailable" />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/IronWrap is not answering right now/)).toBeVisible();
  });
});

describe("brief, numbers, history and findings", () => {
  it("names a brief section with its count and shows at most four rows", () => {
    const row = (summary: string) => ({
      who: "lead_concierge" as const,
      state: "needs_you" as const,
      summary,
      action: "Review",
    });
    render(
      <BriefSection
        kind="needs_you"
        count={12}
        rows={["One", "Two", "Three", "Four", "Five"].map(row)}
        onSeeAll={vi.fn()}
      />,
    );
    const section = screen.getByRole("region", { name: "Needs you, 12" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
    expect(within(section).getByRole("button", { name: "See all" })).toBeVisible();
    expect(within(section).getByText("Needs you", { selector: "h2 span" })).toHaveClass(
      "text-signal-you",
    );
  });

  it("says an empty section in words, with its one next step and no See all", () => {
    render(
      <>
        <BriefSection kind="done" count={0} rows={[]} onSeeAll={vi.fn()} />
        <BriefSection kind="working" count={0} rows={[]} />
        <BriefSection
          kind="found"
          count={0}
          rows={[]}
          emptyNext={<a href="/settings/watches">Choose what the AI team watches</a>}
        />
      </>,
    );
    const done = screen.getByRole("region", { name: "Done for you, 0" });
    expect(done).toHaveTextContent(
      "Nothing done for you yet today.When the AI team finishes a step, its receipt shows here.",
    );
    expect(within(done).queryByRole("button", { name: "See all" })).toBeNull();
    expect(screen.getByRole("region", { name: "Working on it, 0" })).toHaveTextContent(
      "Nothing in progress right now.When the AI team starts something, it shows here.",
    );
    expect(
      within(screen.getByRole("region", { name: "Found, 0" })).getByRole("link", {
        name: "Choose what the AI team watches",
      }),
    ).toBeVisible();
  });

  it("shows a known number exactly and an unknown one as words, never 0", () => {
    render(
      <>
        <MacroTile
          label="Invoices waiting for you"
          value={{ minor: 1343000, currency: "CAD" }}
          change="Ruth Okafor and Kyle Brandt"
          source="From IronWrap · prepared today"
        />
        <MacroTile
          label="Cash in the bank"
          value={null}
          change="The bank feed is not connected to QuickBooks"
          source="Set it up in Settings › QuickBooks"
        />
        <MacroTile label="Next month's work" value={{ minor: 4200000, currency: "CAD" }} proposed />
      </>,
    );
    const [known, unknown, forecast] = screen
      .getAllByRole("term")
      .map((term) => term.parentElement!);
    expect(known).toHaveTextContent("CAD 13,430.00");
    expect(unknown).toHaveAttribute("data-known", "false");
    expect(within(unknown!).getByText("Not known yet")).toBeVisible();
    expect(unknown).not.toHaveTextContent(/\b0\b|CAD/);
    expect(forecast).toHaveTextContent(/Proposed/);
  });

  it("tells a person, a specialist, the face and a customer apart by shape and words", () => {
    const { container } = render(
      <ol>
        <TimelineItem
          actor="person"
          initials="DW"
          when={{ text: "Today 09:52" }}
          what="Dana Whitford approved the final invoice"
        />
        <TimelineItem
          actor="specialist"
          who="billing_reconciliation"
          when={{ text: "Today 09:58" }}
          what="AI bookkeeper sent the final invoice to QuickBooks"
          status={{ kind: "working", words: "Working on it" }}
          link="See receipt for the final invoice"
          onLink={vi.fn()}
        />
        <TimelineItem
          actor="ironwrap"
          when={{ text: "Today 06:50" }}
          what="IronWrap made the brief"
        />
        <TimelineItem
          actor="customer"
          initials="KH"
          when={{ text: "Yesterday 18:20" }}
          what="Kara Harlow opened the new quote"
          line="From the customer page"
        />
      </ol>,
    );
    const shapes = [...container.querySelectorAll("li [data-shape]")].map((node) =>
      node.getAttribute("data-shape"),
    );
    expect(shapes).toEqual(["circle", "rounded-square", "rounded-square", "circle"]);
    expect(screen.getByText("Customer · From the customer page")).toBeVisible();
    expect(screen.getByRole("button", { name: "See receipt for the final invoice" })).toBeVisible();
    for (const when of ["Today 09:52", "Yesterday 18:20"])
      expect(screen.getByText(when)).toBeVisible();
  });

  it("links a receipt only when something opens it, and draws a person nobody named as a person", () => {
    const { container } = render(
      <ol>
        <TimelineItem
          actor="person"
          when={{ text: "Today 09:52" }}
          what="Someone in the office approved the final invoice"
          link="See receipt for the final invoice"
        />
      </ol>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-shape="circle"] svg')).toBeInTheDocument();
    expect(container.querySelector('[data-shape="circle"]')).not.toHaveTextContent("?");
  });

  it("names a finding by its kind word and asks for a decision only when it waits on you", async () => {
    const review = vi.fn();
    render(
      <>
        <Alert
          kind="risk"
          forYou
          who="independent_auditor"
          title="A supplier asked to change bank details by email"
          evidence="Payments to Prairie Coil Supply are held until someone calls the number on file."
          sources={[{ kind: "record", label: "Supplier", code: "SUP-104" }]}
          impact="1 payment held: CAD 1,803.60"
          onPrimary={review}
          onNotNow={vi.fn()}
        />
        <Alert
          kind="opportunity"
          who="market_analyst"
          title="3 hail leaks reported in one area"
          evidence="Three hail leaks came in since yesterday, all in the north-west area."
        />
      </>,
    );
    const risk = screen.getByRole("article", {
      name: "Risk A supplier asked to change bank details by email",
    });
    expect(risk).toHaveClass("bg-signal-you-tint");
    // Who it waits on, in words with a glyph: never the tint alone.
    expect(within(risk).getByText("Needs you").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "you",
    );
    expect(within(risk).getByText("AI auditor")).toBeVisible();
    expect(within(risk).getByRole("button", { name: "Review the proposal" })).toHaveAttribute(
      "data-variant",
      "you",
    );
    expect(within(risk).getByRole("button", { name: "Not now" })).toBeVisible();
    await userEvent.click(within(risk).getByRole("button", { name: "Review the proposal" }));
    expect(review).toHaveBeenCalledOnce();
    const opportunity = screen.getByRole("article", {
      name: "Opportunity 3 hail leaks reported in one area",
    });
    expect(opportunity).not.toHaveClass("bg-signal-you-tint");
    expect(
      within(opportunity).getByText("For your information").closest("[data-status]"),
    ).not.toHaveAttribute("data-status", "you");
    // No handler, no button.
    expect(within(opportunity).queryByRole("button")).toBeNull();
  });

  it("keeps the proposal outlined when it is for your information", () => {
    render(
      <Alert
        kind="opportunity"
        who="market_analyst"
        title="3 hail leaks reported in one area"
        evidence="Three hail leaks came in since yesterday, all in the north-west area."
        onPrimary={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Review the proposal" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
  });
});

describe("headings", () => {
  it("keeps each heading's type-role leading over the global heading rule", () => {
    // styles.css sets `:is(h1, h2, h3)` leading unlayered, which outranks any layered utility that
    // is not important; each heading's own leading has to be.
    const { container } = render(
      <>
        <Alert
          kind="risk"
          who="independent_auditor"
          title="Bank details changed"
          evidence="By email."
        />
        <BriefSection kind="done" count={0} rows={[]} />
        <Conversation place="docked" />
        <ProposedValue kind="block" title="New quote for Kara Harlow" />
        <Receipt
          receipt={{
            specialist_id: "estimator",
            run_id: "run_1",
            action_id: "quote.draft",
            did: "Drafted the quote.",
            doing: null,
            needs_from_you: null,
            sources: [],
            policy: { policy_id: "p", version: "1", result: "allow", checks: [], reason_codes: [] },
            permit: {
              kind: "within_limits",
              permit_id: null,
              approval_id: null,
              approved_by: null,
              delegation_id: null,
            },
            tool: null,
            readback: null,
            outcome: "succeeded",
            undo: { mode: "none", action_id: null, available: false },
            do_it_myself: { surface: null, context: null },
          }}
          display={{
            title: "Quote for Kara Harlow",
            when: { text: "Today 09:52" },
            sources: [],
          }}
        />
        <Dialog open onClose={vi.fn()} title="Approve the invoice" />
      </>,
    );
    const headings = [...container.ownerDocument.querySelectorAll("h1, h2, h3")];
    expect(headings).toHaveLength(6);
    for (const heading of headings)
      expect(heading.className, heading.textContent ?? "").toMatch(
        /(^|\s)leading-\[[^\s]+\]!(\s|$)/,
      );
  });
});

describe("what a newer Worker or a missing name cannot break", () => {
  it("names a specialist this app does not know yet as the AI team, with the team's mark", () => {
    const unknown = "roof_drone_pilot" as unknown as Parameters<typeof AiBadge>[0]["who"];
    expect(specialistName(unknown)).toBe("AI team");
    render(<AiBadge who={unknown} />);
    expect(screen.getByRole("img", { name: "AI team" })).toBeVisible();
  });

  it("shows waiting in ink on a history row unless the viewer decides", () => {
    const { rerender } = render(
      <ol>
        <TimelineItem
          actor="specialist"
          who="billing_reconciliation"
          state="needs_you"
          waitingOn="Dana Whitford"
          when={{ text: "Today 06:42" }}
          what="Final invoice for Kara Harlow"
        />
      </ol>,
    );
    expect(screen.getByText("Waiting on Dana Whitford")).toBeVisible();
    expect(screen.queryByText("Needs you")).toBeNull();
    rerender(
      <ol>
        <TimelineItem
          actor="specialist"
          who="billing_reconciliation"
          state="needs_you"
          viewerMayDecide
          when={{ text: "Today 06:42" }}
          what="Final invoice for Kara Harlow"
        />
      </ol>,
    );
    expect(screen.getByText("Needs you")).toBeVisible();
  });
});
