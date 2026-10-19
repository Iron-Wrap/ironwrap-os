import { Receipt, type ReceiptDisplay } from "../components/ai/receipt";
import { ReceiptRow, type ReceiptRowProps } from "../components/ai/receipt-row";
import { formatMoney, type ContractReceipt } from "../components/ai/words";

// Synthetic sample work only: the Harlow job and the people of the zero-learning gate.
const cad = (minor: number) => formatMoney({ minor, currency: "CAD" });
const people = { person_dana: "Dana Whitford", person_grace: "Grace Obi" };

function step(overrides: Partial<ContractReceipt>): ContractReceipt {
  return {
    specialist_id: "billing_reconciliation",
    run_id: "run_7f3a91",
    action_id: "invoice.send_final",
    did: null,
    doing: null,
    needs_from_you: null,
    sources: [{ fact_id: "contract:iw-1044", version: 3, hash: "9c1e44aa" }],
    policy: {
      policy_id: "policy.invoice_send",
      version: "4",
      result: "allow",
      checks: [{ check: "amount_ceiling", passed: true }],
      reason_codes: [],
    },
    permit: {
      kind: "none",
      permit_id: null,
      approval_id: null,
      approved_by: null,
      delegation_id: null,
    },
    tool: null,
    readback: null,
    outcome: "succeeded",
    undo: { mode: "none", action_id: null, available: false },
    do_it_myself: { surface: "/money/invoices", context: null },
    ...overrides,
  };
}

/** The final invoice waiting for the owner, as the owner and as anyone else sees it. */
const invoiceAsk = step({
  outcome: null,
  did: `Prepared from the accepted contract and the accepted change order: ${cad(939048)} before tax and GST ${cad(46952)}.`,
  needs_from_you: {
    reviewer_role: "owner",
    person_id: "person_dana",
    ask: "Approve the invoice. Approving sends it to QuickBooks.",
  },
  sources: [
    { fact_id: "contract:iw-1044", version: 3, hash: "9c1e44aa" },
    { fact_id: "change_order:co-1044-1", version: 1, hash: "51d2c0fe" },
  ],
  policy: {
    policy_id: "policy.invoice_send",
    version: "4",
    result: "needs_approval",
    checks: [{ check: "amount_ceiling", passed: false }],
    reason_codes: [],
  },
  permit: {
    kind: "asks_first",
    permit_id: null,
    approval_id: null,
    approved_by: null,
    delegation_id: null,
  },
  // Once sent, a person cancels it in QuickBooks until it is paid: nothing undoes it for them.
  undo: { mode: "manual", action_id: null, available: true },
});

const invoiceAskDisplay: ReceiptDisplay = {
  title: `Invoice for Kara Harlow, ${cad(986000)}`,
  when: { text: "Today 06:42" },
  sources: [
    { kind: "record", label: "Contract", code: "IW-1044" },
    { kind: "record", label: "Change order", code: "CO-1044-1" },
  ],
  people,
  where: "QuickBooks",
  why: "Sending an invoice changes QuickBooks. You asked to approve every invoice first.",
  delegation: "asks_first",
  actionClass: "A3",
  primary: "Approve the invoice",
  consequence:
    "Sends the invoice to QuickBooks. You can still cancel it in QuickBooks until it is paid.",
  edit: {
    object: "the invoice",
    opens: "Opens this invoice so you can change it",
    after:
      "Nothing goes to QuickBooks until you approve, and the contract and change order stay as they are.",
  },
};

const SAMPLES: {
  name: string;
  receipt: ContractReceipt;
  display: ReceiptDisplay;
  /** The viewer may decide it: Needs you is theirs, blue, with the primary. */
  viewerMayDecide?: boolean;
}[] = [
  { name: "Needs you", viewerMayDecide: true, receipt: invoiceAsk, display: invoiceAskDisplay },
  // Needs you is the viewer's: anyone the owner has not given the decision reads who decides.
  {
    name: "Needs you, someone else decides",
    receipt: invoiceAsk,
    display: {
      ...invoiceAskDisplay,
      why: "Sending an invoice changes QuickBooks. Dana Whitford approves every invoice first.",
      viewerPart: "You may change this invoice. You cannot approve it; Dana Whitford approves it.",
      edit: {
        object: "the invoice",
        opens: "Opens this invoice so you can change it",
        after:
          "You may change any of it, words or figures. Your changes stay on this invoice, and Dana Whitford approves the changed invoice before anything reaches QuickBooks.",
      },
    },
  },
  {
    name: "Done for you",
    receipt: step({
      specialist_id: "lead_concierge",
      action_id: "lead.fill_from_call",
      did: "Filled the lead from the call: hail leak over the garage, wants an inspection this week. No duplicate found.",
      sources: [{ fact_id: "call:2291", version: 1, hash: "a77e0b13" }],
      undo: { mode: "automatic", action_id: "lead.restore", available: true },
    }),
    display: {
      title: "Filled the lead from Ahmad Haddad's call",
      when: { text: "Today 06:12" },
      sources: [{ kind: "message", label: "Call from Ahmad Haddad", code: "LD-2291" }],
      checked: "Nothing was sent outside IronWrap. No message went to Ahmad Haddad.",
      delegation: "prepares",
      actionClass: "A1",
      edit: { object: "the lead", opens: "Opens the lead with the call notes filled in" },
      undoUntil: "today 18:00",
      undoDoes: "Undo puts the lead back as it was before.",
    },
  },
  {
    name: "Done for you, undone by hand",
    receipt: step({
      did: `Sent the final invoice, ${cad(986000)}, to QuickBooks after Dana Whitford approved it.`,
      sources: [
        { fact_id: "contract:iw-1044", version: 3, hash: "9c1e44aa" },
        { fact_id: "change_order:co-1044-1", version: 1, hash: "51d2c0fe" },
      ],
      permit: {
        kind: "asks_first",
        permit_id: "permit_52",
        approval_id: "approval_89",
        approved_by: "person_dana",
        delegation_id: null,
      },
      tool: {
        name: "quickbooks.invoice_create",
        binding: "quickbooks",
        idempotency_key: "idem_43",
        request_hash: "8e1a23cc",
      },
      readback: {
        source: "quickbooks",
        reference: "INV-5522",
        response_hash: "d4c3b2a1",
        matched: true,
      },
      undo: { mode: "manual", action_id: null, available: true },
    }),
    display: {
      title: `Invoice for Kara Harlow, ${cad(986000)}`,
      when: { text: "Today 10:31" },
      sources: [
        { kind: "record", label: "Contract", code: "IW-1044" },
        { kind: "record", label: "Change order", code: "CO-1044-1" },
      ],
      people,
      where: "QuickBooks",
      approvedWhen: "today 10:30",
      checkedWhen: "today 10:31",
      delegation: "asks_first",
      actionClass: "A3",
      undoManual: "You can still cancel it in QuickBooks until it is paid.",
      edit: { object: "the invoice", opens: "Opens the invoice in the money desk" },
    },
  },
  {
    name: "Done for you, a standing watch",
    receipt: step({
      specialist_id: "market_analyst",
      action_id: "watch.storm_start",
      did: "Started watching hail reports for the north-west area, as you asked.",
      sources: [{ fact_id: "weather:alert-88", version: 2, hash: "0be4c911" }],
      tool: {
        name: "watch.start",
        binding: "internal",
        idempotency_key: "idem_storm_1",
        request_hash: "c41d9a07",
      },
      readback: {
        source: "ironwrap",
        reference: "watch-storm-nw",
        response_hash: "f00d1e55",
        matched: true,
      },
      undo: { mode: "manual", action_id: null, available: false },
      do_it_myself: { surface: "/settings/watches", context: null },
    }),
    display: {
      title: "Started the storm watch for the north-west area",
      when: { text: "Yesterday 15:40" },
      sources: [{ kind: "reading", label: "Hail warning from Environment Canada" }],
      where: "IronWrap",
      checked: "IronWrap confirmed the watch is running, yesterday 15:41.",
      delegation: "within_limits",
      actionClass: "A2",
      stop: "Stop the storm watch",
      stopNote:
        "Stopping ends the hail alerts for the north-west. You can ask IronWrap to start it again.",
      edit: { object: "the watch", opens: "Opens the watch list, where you can change the area" },
    },
  },
  {
    name: "Working on it",
    receipt: step({
      outcome: "unknown",
      did: `Sent ${cad(294000)} after Dana Whitford approved it today 09:52.`,
      doing: "Checking QuickBooks every 15 minutes. Sent is not paid.",
      policy: {
        policy_id: "policy.invoice_send",
        version: "4",
        result: "allow",
        checks: [],
        reason_codes: ["no_readback_yet"],
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
    }),
    display: {
      title: "Waiting for QuickBooks to confirm the final invoice for Ruth Okafor",
      when: { text: "Today 09:58" },
      sources: [
        { kind: "record", label: "Final invoice", code: "IW-1035" },
        { kind: "record", label: "Approval by Dana Whitford" },
      ],
      people,
      where: "QuickBooks",
      approvedWhen: "today 09:52",
      edit: { object: "the invoice", opens: "Opens the invoice in the money desk" },
    },
  },
  {
    name: "Held",
    receipt: step({
      specialist_id: "shop_planner",
      action_id: "cut_plan.prepare",
      outcome: "abstained",
      did: "Found the parts list for the Harlow job.",
      policy: {
        policy_id: "policy.cut_plan",
        version: "2",
        result: "deny",
        checks: [{ check: "material_released", passed: false }],
        reason_codes: ["fact_conflict"],
      },
      sources: [
        { fact_id: "ncr:31", version: 1, hash: "aa10b3c2" },
        { fact_id: "coil:pms-2231", version: 5, hash: "e7f0d4a1" },
        { fact_id: "job:iw-1044", version: 9, hash: "3c2b1a09" },
        { fact_id: "cut_list:c-14", version: 2, hash: "5b6a7c8d" },
      ],
    }),
    display: {
      title: "The cut plan for the Harlow job is on hold",
      when: { text: "Today 06:30" },
      sources: [
        { kind: "record", label: "Quality problem", code: "NCR-31" },
        { kind: "record", label: "Job", code: "IW-1044" },
        { kind: "document", label: "Cut plan", code: "C-14" },
      ],
      why: "Quality problem NCR-31 is open, so the whole Harlow job is on hold.",
      nextStep: "Grace Obi (Staff) decides the quality problem.",
      nextAction: "Review the quality problem",
      delegation: "prepares",
      actionClass: "A1",
      edit: {
        object: "the cut plan",
        opens: "Opens the cut plan for the Harlow job: how its steel is cut into parts",
        after:
          "Changing the plan does not lift the hold; the job waits until Grace Obi decides the quality problem.",
      },
    },
  },
  {
    name: "Undone",
    receipt: step({
      specialist_id: "lead_concierge",
      action_id: "lead.fill_from_call",
      outcome: "failed",
      did: "Filled the lead from the call and found no duplicate.",
      policy: {
        policy_id: "policy.lead",
        version: "1",
        result: "allow",
        checks: [],
        reason_codes: ["declined"],
      },
    }),
    display: {
      title: "Filled the lead from Ahmad Haddad's call",
      when: { text: "Today 06:12" },
      sources: [{ kind: "message", label: "Call from Ahmad Haddad", code: "LD-2291" }],
      people,
      by: "person_dana",
      since: "Dana Whitford undid it today 07:05. The lead is as it was before.",
      edit: { object: "the lead", opens: "Opens the lead as it is now" },
    },
  },
  {
    name: "Replaced",
    receipt: step({
      specialist_id: "estimator",
      action_id: "quote.draft",
      outcome: "failed",
      did: "Drafted the deck repair price for the Harlow job.",
      policy: {
        policy_id: "policy.quote",
        version: "3",
        result: "allow",
        checks: [],
        reason_codes: ["superseded"],
      },
    }),
    display: {
      title: "Deck repair price for the Harlow job",
      when: { text: "Yesterday 16:20" },
      sources: [{ kind: "photo", label: "Photo, north slope", code: "P-118" }],
      since: "A newer draft with today's steel price replaced this one.",
    },
  },
  {
    name: "Done by a person",
    receipt: step({
      specialist_id: "scheduler_dispatcher",
      action_id: "crew.propose",
      outcome: "failed",
      did: "Proposed the north crew for Thu 07:00.",
      policy: {
        policy_id: "policy.schedule",
        version: "2",
        result: "allow",
        checks: [],
        reason_codes: ["done_by_person"],
      },
    }),
    display: {
      title: "Crew for the Harlow job",
      when: { text: "Today 08:10" },
      sources: [{ kind: "record", label: "Job", code: "IW-1044" }],
      people,
      by: "person_grace",
      since: "Grace Obi booked the crew herself.",
    },
  },
  {
    name: "Answered by a person, still on its way",
    receipt: step({
      specialist_id: "field_safety",
      action_id: "checkin.ask_crew",
      outcome: "failed",
      did: "Asked the north crew whether the deck boards were replaced before shingles went on.",
      policy: {
        policy_id: "policy.checkin",
        version: "1",
        result: "allow",
        checks: [],
        reason_codes: ["done_by_person"],
      },
    }),
    display: {
      title: "Check-in answer for the Harlow job",
      when: { text: "Today 11:05" },
      sources: [{ kind: "record", label: "Job", code: "IW-1044" }],
      people,
      by: "person_grace",
      waitingFor: "the phone",
      since: "Grace Obi answered for the crew. It reaches the crew phone when it has signal.",
    },
  },
];

/** Board 6, AI/Receipt: every state, desktop and phone layout by density or width. */
export function ReceiptSection() {
  return (
    <>
      <p className="g-note">
        One card per step the AI team takes: who did it, what it did, what it needs from you, where
        each fact came from, why it waits for a person, what was checked, and the ways out. In touch
        and glove density or narrower than 30rem it takes the phone layout.
      </p>
      <div className="g-grid" data-wide="">
        {SAMPLES.map(({ name, receipt, display, viewerMayDecide }) => (
          <div key={name} className="g-cell" data-stretch="">
            <span className="g-label">{name}</span>
            <Receipt
              receipt={receipt}
              display={display}
              viewerMayDecide={viewerMayDecide}
              onPrimary={() => undefined}
              onEdit={() => undefined}
              onUndo={() => undefined}
              onNext={() => undefined}
              onStop={() => undefined}
            />
          </div>
        ))}
      </div>
    </>
  );
}

const ROWS: ReceiptRowProps[] = [
  {
    who: "billing_reconciliation",
    state: "needs_you",
    summary: `Invoice for Kara Harlow, ${cad(986000)}`,
    line: "Job IW-1044 · prepared from the accepted contract",
    action: "Review the invoice",
    viewerMayDecide: true,
  },
  {
    who: "estimator",
    state: "needs_you",
    summary: "Discount on the Brandt quote",
    line: "Job IW-1046 · the owner approves every discount",
    action: "See receipt for the discount",
    waitingOn: "Dana Whitford",
  },
  {
    who: "estimator",
    state: "working",
    summary: "Drafting a deck repair change order for the Harlow job",
    line: "Job IW-1044 · rotten deck boards on the north slope",
    action: "See progress",
  },
  {
    who: "quality_inspector",
    state: "done",
    summary: "Checked 10 completion photos for Ruth Okafor",
    line: "Job IW-1019 · 9 meet their requirement, 1 is blurry (north eave)",
    action: "See receipt for the photos",
  },
  {
    who: "shop_planner",
    state: "held",
    summary: "The cut plan for the Harlow job is on hold",
    line: "Quality problem NCR-31 is open",
    action: "See why",
  },
  {
    who: "lead_concierge",
    state: "undone",
    stateWords: "Undone by Dana Whitford",
    summary: "Filled the lead from Ahmad Haddad's call",
    line: "Today 07:05",
    action: "See receipt for the lead",
  },
  {
    state: "done_by_person",
    by: { name: "Grace Obi" },
    summary: "Crew for the Harlow job",
    line: "Job IW-1044 · booked by hand instead of the proposal",
    action: "See receipt for the crew booking",
  },
];

/** Board 6, AI/Receipt row: one row per state; the whole row is one target on the phone. */
export function ReceiptRowSection() {
  return (
    <div className="g-panel">
      <ul className="g-list" aria-label="Receipt rows">
        {ROWS.map((row) => (
          <li key={`${row.state} ${String(row.summary)}`}>
            <ReceiptRow {...row} onOpen={() => undefined} />
          </li>
        ))}
      </ul>
    </div>
  );
}
