import { Alert } from "../components/ai/alert";
import { AskEntry } from "../components/ai/ask-entry";
import { AiBadge, PersonAvatar, type MarkSize } from "../components/ai/badge";
import { BriefSection } from "../components/ai/brief-section";
import { Conversation } from "../components/ai/conversation";
import { DelegationPill } from "../components/ai/delegation";
import { MacroTile } from "../components/ai/macro-tile";
import { Message } from "../components/ai/message";
import { AiName } from "../components/ai/name";
import { ProposedValue } from "../components/ai/proposed";
import { ReceiptRow } from "../components/ai/receipt-row";
import { SourceChip } from "../components/ai/source";
import { TimelineItem } from "../components/ai/timeline-item";
import {
  DELEGATION,
  SPECIALIST_IDS,
  formatMoney,
  type DelegationSetting,
} from "../components/ai/words";

// Synthetic sample work only: the Harlow job and the people of the zero-learning gate.
const cad = (minor: number) => formatMoney({ minor, currency: "CAD" });
const nothing = () => undefined;

/** Board 6: the badge per specialist and size, the person circle, the name in two sizes. */
export function IdentitySection() {
  const sizes: MarkSize[] = ["small", "default", "large"];
  return (
    <>
      <p className="g-note">
        Specialists are rounded squares with their glyph, people are circles with initials. Every
        specialist&apos;s name starts with its job, as in AI estimator; the face carries the brand,
        IronWrap. Nothing here is coloured.
      </p>
      <div className="g-grid">
        {SPECIALIST_IDS.map((who) => (
          <div key={who} className="g-cell">
            <span className="g-row">
              {sizes.map((size) => (
                <AiBadge key={size} who={who} size={size} />
              ))}
            </span>
            <AiName who={who} />
          </div>
        ))}
        <div className="g-cell">
          <span className="g-row">
            {sizes.map((size) => (
              <PersonAvatar key={size} initials="DW" name="Dana Whitford" size={size} />
            ))}
          </span>
          <span className="g-label">Dana Whitford, a person</span>
        </div>
        <div className="g-cell">
          <AiName who="estimator" size="header" line="Prices quotes from measurements and costs" />
          <AiName who="orchestrator" size="header" line="Brief made today 06:50" />
        </div>
      </div>
    </>
  );
}

/** Board 6, AI/Delegation: every setting in words. */
export function DelegationSection() {
  return (
    <div className="g-row">
      {(Object.keys(DELEGATION) as DelegationSetting[]).map((setting) => (
        <DelegationPill key={setting} setting={setting} />
      ))}
    </div>
  );
}

/** Board 6, AI/Proposed value: inline, field, block, and a field a person accepted. */
export function ProposedSection() {
  return (
    <>
      <p className="g-note">
        Proposed carries the word, the open diamond and a dotted edge together; a fact has none of
        them. A proposed value is never added into a total of facts.
      </p>
      <p className="g-note">
        Steel for the Harlow job costs{" "}
        <ProposedValue kind="inline" value={{ minor: 3600, currency: "CAD" }} /> a sheet.
      </p>
      <div className="g-grid" data-wide="">
        <ProposedValue
          kind="field"
          label="South slope area"
          value="1,064 sq ft"
          caption="Proposed by AI measurer from the measurement report, page 3."
          onAccept={nothing}
          onEdit={nothing}
        />
        <ProposedValue
          kind="field"
          label="North slope area"
          value="988 sq ft"
          caption="Proposed by AI measurer from the drone photos of the north slope."
          acceptLabel="Accept 988 sq ft"
          editNote="Type your own figure; it replaces 988 sq ft and counts as yours."
          editLabel="Edit the north slope area"
          onAccept={nothing}
          onEdit={nothing}
        />
        <ProposedValue
          kind="field"
          label="West slope area"
          value="742 sq ft"
          caption="Accepted by Dana Whitford today 10:44."
          state="accepted"
        />
        <ProposedValue
          kind="block"
          title="New quote for Kara Harlow"
          acceptLabel="Accept the quote"
          editLabel="Edit the quote"
          discardLabel="Discard the quote"
          discardNote="Discarding removes only this new draft; the earlier quote stays as it is."
          onAccept={nothing}
          onEdit={nothing}
          onDiscard={nothing}
        >
          Proposed by AI estimator from the last quote with today&apos;s steel price.
        </ProposedValue>
      </div>
    </>
  );
}

/** Board 6, AI/Source chip: every kind, as a link, and a fact that could not be relied on. */
export function SourcesSection() {
  return (
    <div className="g-row">
      <SourceChip kind="record" label="Job" code="IW-1044" />
      <SourceChip kind="document" label="Measurement report" code="p. 3" />
      <SourceChip kind="message" label="Email from Ahmad Haddad" />
      <SourceChip kind="photo" label="Photo, north eave" code="P-118" />
      <SourceChip kind="reading" label="Survey reading" code="S-7" />
      <SourceChip kind="record" label="Contract" code="IW-1044" href="#sources" />
      <SourceChip kind="reading" label="Survey reading" code="S-6" check="stale" />
      <SourceChip kind="document" label="Supplier price list" check="unverifiable" />
    </div>
  );
}

/** Board 6, AI/Ask entry: the four places, working and unavailable. */
export function AskSection() {
  return (
    <div className="g-grid" data-wide="">
      <div className="g-cell" data-stretch="">
        <span className="g-label">Desktop</span>
        <AskEntry place="desktop" onAsk={nothing} bindShortcut />
      </div>
      <div className="g-cell" data-stretch="">
        <span className="g-label">Desktop, answer on its way</span>
        <AskEntry place="desktop" onAsk={nothing} busy />
      </div>
      <div className="g-cell" data-stretch="">
        <span className="g-label">Desktop, when IronWrap&apos;s AI is off</span>
        <AskEntry place="desktop" onAsk={nothing} unavailable="IronWrap's AI is off." />
      </div>
      <div className="g-cell">
        <span className="g-label">Compact</span>
        <AskEntry place="compact" onOpen={nothing} />
      </div>
      <div className="g-cell" data-stretch="">
        <span className="g-label">Crew</span>
        <AskEntry place="crew" onOpen={nothing} />
      </div>
      <div className="g-cell" data-stretch="">
        <span className="g-label">Crew, offline</span>
        <AskEntry
          place="crew"
          onOpen={nothing}
          unavailable="No signal. Ask again when this phone is back online."
        />
      </div>
      <div className="g-cell" data-stretch="">
        <span className="g-label">Customer</span>
        <AskEntry place="customer" onOpen={nothing} />
      </div>
    </div>
  );
}

/** Board 6, AI/Message and AI/Conversation: docked with answers, and the sheet offline. */
export function ConversationSection() {
  return (
    <div className="g-grid" data-wide="">
      <Conversation place="docked" onClose={nothing} onSend={nothing} onSpeak={nothing}>
        <Message from="person">Is the Harlow job on track?</Message>
        <Message
          from="ironwrap"
          parts={[
            {
              text: "No. Work on the Harlow job is stopped: rotten deck boards on the north slope.",
              sources: [{ kind: "record", label: "Job", code: "IW-1044" }],
            },
            {
              text: "The crew reported it yesterday 09:12. Dana Whitford decides when the stop is released.",
              sources: [{ kind: "record", label: "Stop report", code: "SR-62" }],
            },
          ]}
        />
        <Message
          from="specialist"
          who="estimator"
          parts={[
            {
              text: "I am drafting a deck repair change order for it. I will ask you before anything goes to Kara Harlow.",
            },
          ]}
        />
        <Message from="person">What needs me today?</Message>
        <Message
          from="ironwrap"
          parts={[{ text: "12 things need you. 4 are money and come first. The first one:" }]}
        >
          <div className="g-panel">
            <ReceiptRow
              who="billing_reconciliation"
              state="needs_you"
              summary={`Invoice for Kara Harlow, ${cad(986000)}`}
              line="Job IW-1044 · prepared from the accepted contract"
              action="Review the invoice"
              onOpen={nothing}
            />
          </div>
        </Message>
        <Message from="specialist" who="scheduler_dispatcher" status="working" />
      </Conversation>
      <Conversation place="sheet" state="offline" onClose={nothing} onSend={nothing}>
        <Message from="person" status="not-sent">
          When is the Harlow crew coming?
        </Message>
        <Message from="ironwrap" status="unavailable" />
      </Conversation>
    </div>
  );
}

const briefRow = (
  state: "needs_you" | "working" | "done" | "held",
  who: (typeof SPECIALIST_IDS)[number],
  summary: string,
  line: string,
  action: string,
) => ({
  state,
  who,
  summary,
  line,
  action,
  // The brief is the owner's: what needs a person waits on them.
  viewerMayDecide: true,
  onOpen: nothing,
});

/** Board 6, AI/Brief section: the four kinds in brief order, up to four rows each. */
export function BriefSectionGallery() {
  return (
    <div className="g-grid" data-wide="">
      <BriefSection
        kind="needs_you"
        count={12}
        onSeeAll={nothing}
        rows={[
          briefRow(
            "needs_you",
            "billing_reconciliation",
            `Invoice for Kara Harlow, ${cad(986000)}`,
            "Job IW-1044 · prepared from the accepted contract",
            "Review the invoice",
          ),
          briefRow(
            "needs_you",
            "lead_concierge",
            "Replies to 3 hail leads",
            "Ahmad Haddad and 2 others · each offers 3 inspection times",
            "Review the replies",
          ),
          briefRow(
            "needs_you",
            "scheduler_dispatcher",
            "Crew for Kyle Brandt: the north crew, Thu 07:00",
            "Job IW-1046 · checked weather, certificates and delivery",
            "Review the crew",
          ),
          briefRow(
            "needs_you",
            "field_safety",
            "Release request for the stopped Harlow roof",
            "Job IW-1044 · four sources, the crew's photos first",
            "Review the work stop",
          ),
        ]}
      />
      <BriefSection
        kind="found"
        count={4}
        onSeeAll={nothing}
        rows={[
          briefRow(
            "needs_you",
            "market_analyst",
            "Opportunity: 3 hail leaks in one area",
            "Since yesterday, north-west area · 12 past jobs there",
            "Review the proposal",
          ),
          briefRow(
            "needs_you",
            "independent_auditor",
            "Risk: a supplier asked to change bank details by email",
            "Prairie Coil Supply · payments held until someone calls the number on file",
            "Review the hold",
          ),
          briefRow(
            "held",
            "shop_planner",
            "Risk: a coil for the Harlow job is on hold",
            "Coil PMS-2231 · cuts cannot be planned from it",
            "See why",
          ),
        ]}
      />
      <BriefSection
        kind="done"
        count={4}
        rows={[
          briefRow(
            "done",
            "lead_concierge",
            "Filled Ahmad Haddad's lead from his call",
            "Lead LD-2291 · no duplicate found",
            "See receipt for the lead",
          ),
          briefRow(
            "done",
            "billing_reconciliation",
            "Checked 6 invoices against QuickBooks",
            "5 match, 1 does not (Job IW-1036)",
            "See receipt for the invoice check",
          ),
          briefRow(
            "done",
            "quality_inspector",
            "Checked 10 completion photos for Ruth Okafor",
            "Job IW-1019 · 1 is blurry (north eave), retake asked for",
            "See receipt for the photos",
          ),
          briefRow(
            "done",
            "purchasing_inventory",
            "Matched the Prairie Coil Supply bill to its order",
            "Purchase order and delivery agree to the cent",
            "See receipt for the bill",
          ),
        ]}
      />
      <BriefSection kind="working" count={0} rows={[]} />
    </div>
  );
}

/** Board 6, AI/Macro tile: known, not known yet, and a proposed forecast. */
export function MacroSection() {
  return (
    <div className="g-grid">
      <MacroTile
        label="Invoices waiting for you"
        value={{ minor: 1343000, currency: "CAD" }}
        change={`Kara Harlow ${cad(986000)} and Kyle Brandt ${cad(357000)}`}
        source="From IronWrap · prepared today"
      />
      <MacroTile
        label="Cash in the bank"
        value={null}
        change="The bank feed is not connected to QuickBooks"
        source="Set it up in Settings › QuickBooks"
      />
      <MacroTile
        label="Roofing booked next month"
        value={{ minor: 4200000, currency: "CAD" }}
        proposed
        change="Forecast from 9 signed and 4 likely jobs"
        source="Proposed by AI scheduler · today 06:50"
      />
      <MacroTile
        label="Crews free this week"
        value="2 of 5"
        change="North and south crews from Thu"
        source="From the schedule · today 06:50"
      />
    </div>
  );
}

/** Board 6, AI/Timeline item: a person, a specialist, the face and a customer. */
export function TimelineSection() {
  return (
    <div className="g-panel">
      <ol className="g-list" aria-label="Harlow job history">
        <TimelineItem
          actor="customer"
          initials="KH"
          when={{ text: "Yesterday 18:20" }}
          what="Kara Harlow opened the new quote"
          line="From the customer page"
        />
        <TimelineItem
          actor="ironwrap"
          when={{ text: "Today 06:50" }}
          what="IronWrap made the brief"
          line="12 need you · 4 found · 4 done for you"
          link="See receipt for the brief"
          onLink={nothing}
        />
        <TimelineItem
          actor="person"
          initials="DW"
          when={{ text: "Today 09:52" }}
          what="Dana Whitford approved the final invoice"
          line={`${cad(294000)} · Job IW-1035`}
        />
        <TimelineItem
          actor="specialist"
          who="billing_reconciliation"
          when={{ text: "Today 09:58" }}
          what="AI bookkeeper sent the final invoice to QuickBooks"
          line={`${cad(294000)} · waiting for QuickBooks to confirm`}
          status={{ kind: "working", words: "Working on it" }}
          link="See receipt for the final invoice"
          onLink={nothing}
        />
        <TimelineItem
          actor="specialist"
          who="estimator"
          when={{ text: "Today 10:15" }}
          what="AI estimator drafted a deck repair change order"
          status={{ kind: "proposed", words: "Proposed" }}
          link="See receipt for the change order"
          onLink={nothing}
        />
        <TimelineItem
          actor="specialist"
          who="field_safety"
          when={{ text: "Today 10:40" }}
          what="AI field coordinator asked to release the work stop"
          status={{ kind: "you", words: "Needs you" }}
          link="See receipt for the release request"
          onLink={nothing}
        />
        <TimelineItem
          actor="specialist"
          who="scheduler_dispatcher"
          state="done_by_person"
          by={{ name: "Grace Obi" }}
          when={{ text: "Today 11:05" }}
          what="Grace Obi booked the north crew herself"
          line="The proposal from AI scheduler was not used"
        />
      </ol>
    </div>
  );
}

/** Board 6, AI/Alert: Risk and Opportunity, for you and for your information. */
export function AlertSection() {
  const risk = {
    who: "independent_auditor" as const,
    title: "A supplier asked to change bank details by email",
    evidence:
      "An email claiming to be Prairie Coil Supply asks us to pay a new account. The account on file was confirmed by phone. Payments to Prairie Coil Supply are held until someone calls the number on file.",
    sources: [
      {
        kind: "message" as const,
        label: "Email from accounts@prairiecoil-billing.example.invalid",
      },
      { kind: "record" as const, label: "Supplier", code: "SUP-104" },
    ],
    impact: `1 payment held: ${cad(180360)}`,
  };
  const opportunity = {
    who: "market_analyst" as const,
    title: "3 hail leaks reported in one area",
    evidence:
      "Ahmad Haddad and two neighbours reported hail leaks since yesterday, all in the north-west area.",
    sources: [{ kind: "record" as const, label: "Lead", code: "LD-2291" }],
    impact: "12 past Iron Wrap jobs are in the same area",
  };
  return (
    <div className="g-grid" data-wide="">
      <Alert kind="risk" forYou {...risk} onPrimary={nothing} onNotNow={nothing} />
      <Alert kind="risk" {...risk} onPrimary={nothing} onNotNow={nothing} />
      <Alert kind="opportunity" forYou {...opportunity} onPrimary={nothing} onNotNow={nothing} />
      <Alert kind="opportunity" {...opportunity} onPrimary={nothing} onNotNow={nothing} />
    </div>
  );
}
