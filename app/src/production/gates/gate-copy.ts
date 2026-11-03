/**
 * Every word the gate screens show (P30, Staff · Production, and the P30 signed-copy frames).
 *
 * PROVISIONAL. The strings follow the Product UI file's frames as they stand; none has passed a
 * gate in the current freeze, and the rework lead's fix pass will replace them. Keep all visible
 * text here, so that pass swaps words without touching logic. Each entry names its frame.
 *
 * Placeholders take what the reads give: `{name}` is the customer's display name, `{gate}` a
 * gate's name, `{day}` the window's last day ("Fri 30 Oct"), `{stamp}` an office stamp
 * ("Today 14:05", "Fri 10 Jul 09:15") and `{when}` the same time inside a sentence ("today at
 * 14:05"). Frames name people the reads do not carry (the deciding owner, who cleared a gate, a
 * colleague off the crew); those lines say "the owner", "an owner" or the role instead.
 */

import type { AppRole } from "../../lib/roles";
import type { GateName, WindowUnknownReason } from "./gate-contracts";
import type { WindowDeadline } from "./gate-time";

/** "Materials and Weather", "Safety, Access and Weather". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The held form of a control: "{Action} · after {condition}" (owner rule). */
export function held(action: string, condition: string): string {
  return `${action} · ${condition}`;
}

function roleWords(role: string | null): string {
  switch (role) {
    case "owner":
      return "the owner";
    case "ops":
      return "operations";
    case "production":
      return "production";
    default:
      return "someone in the office";
  }
}

/** Who appended an entry, as far as the read says (it carries the role, never the person). */
export function byWhom(role: string | null): string {
  return `by ${roleWords(role)}`;
}

const depositSettlementAction = "Clear Deposit on the settled payment";

function clearAfterReversal(gate: GateName): string {
  return gate === "Deposit" ? depositSettlementAction : `Clear ${gate} with the right proof`;
}

export const gateCopy = {
  page: {
    breadcrumbRoot: "Production",
    gatesCrumb: "Gates",
    windowCrumb: "Cancellation window",
    waiveCrumb: (gate: GateName) => `Waive ${gate}`,
    jobFallback: "This job",
    customerFallback: "the customer",
    backToList: "Back to the gate list",
    loading: "Loading the gates…",
    loadFailed: "The gates did not load. Nothing was changed.",
    readbackFailed:
      "The latest gates could not be checked. A change may already be saved. Reload the gates before making another change.",
    productionLoadFailed: "The production plan did not load. Load it again before changing a gate.",
    productionReadbackFailed:
      "The latest production plan could not be checked. A change may already be saved. Reload it before making another change.",
    productionRetry: "Load the production plan again",
    retry: "Load the gates again",
    notFound: "This job has no gates to show. Open it again from the production plan.",
    noAccess: "Only an owner, ops or production can see a job's gates.",
    seeGates: "See gates",
    seeGatesFor: (job: string) => `See gates for ${job}`,
    required: "Required",
    /** The fix pass dropped the "Next:" lead: each line states its consequence alone. */
    next: (line: string) => line,
    historyTitle: "What happened on this gate",
    historyIncomplete: "Only the newest changes are shown.",
    offline: "You're offline. A gate changes only online.",
    offlineWrite: "Nothing was sent. Reconnect, then choose the action again.",
  },

  /** Frame 1, and frame 12 once the window has ended. */
  overview: {
    summary: (summary: {
      total: number;
      cleared: number;
      waived: number;
      blocked: number;
      waiting: number;
    }) =>
      [
        `${summary.cleared} of ${summary.total} gates cleared`,
        summary.waived > 0 ? `${summary.waived} waived` : null,
        summary.blocked > 0 ? `${summary.blocked} blocked` : null,
        summary.waiting > 0 ? `${summary.waiting} waiting` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    windowLabel: "Cancellation window · not a gate",
    depositLabel: "Deposit · not a gate",
    depositNoDeposit: "No deposit under this contract",
    clear: (gate: GateName) => `Clear ${gate}`,
    notWaivable:
      "Safety, Weather and Crew can’t be waived: they keep the crew safe, so only proof clears them.",
    schedule: "Schedule the crew",
    nextScheduleWindowAndGates: (blocked: number) =>
      blocked > 0
        ? `“Schedule the crew” turns on once the window ends and the ${blocked} blocked ${
            blocked === 1 ? "gate clears" : "gates clear"
          }.`
        : "“Schedule the crew” turns on once the window ends.",
    nextScheduleGates: (gates: readonly GateName[]) =>
      `“Schedule the crew” turns on when ${listWords(gates)} ${gates.length === 1 ? "clears" : "clear"}.`,
    readOnly: "Only an owner or production can clear a gate.",
  },

  /** The one-line state of each gate in the overview rows (frames 1 and 12). */
  row: {
    materialsHeld: "Blocked: ordering waits for the window to end",
    materialsBlocked: "Blocked: no supplier reference yet",
    safetyBlocked: "Blocked: no hazard assessment yet",
    safetyBlockedLong:
      "Blocked: clears with a hazard assessment, a permit that is held or not needed, a fall-protection plan or “no exposure at 3 m”, and a current competency record",
    accessBlocked: "Blocked: nobody has confirmed site access yet",
    weatherBlocked: "Blocked: no forecast yet; read it near the crew day",
    weatherBlockedLong:
      "Blocked: clears with a work window of 14 days or less and a forecast from the last 72 hours",
    depositBlocked: "Blocked: no settled deposit yet",
    crewWaiting: "Waiting: clears when you schedule the crew",
    crewWaitingLong: "Waiting: clears by itself when you schedule the crew",
    cleared: (stamp: string) => `Cleared ${stamp}`,
    waived: (stamp: string) => `Waived ${stamp}`,
    waitingOnOwner: "Waiting: an owner decides the waiver",
    waitingOnYou: "Waiting on you: decide the waiver",
  },

  /** The status lines under each step's title (frames 2-23). */
  strip: {
    window: (
      state: "unknown" | "open" | "ended",
      deadline: WindowDeadline,
      reason: WindowUnknownReason | null,
    ) => {
      if (state === "unknown") return `Cancellation window · unknown: ${unknownShort(reason)}`;
      if (deadline.kind === "none") {
        return state === "open" ? "Cancellation window · open" : "Cancellation window · ended";
      }
      if (deadline.kind === "exact") {
        return state === "open"
          ? `Cancellation window · open until ${deadline.label}`
          : `Cancellation window · ended ${deadline.label}`;
      }
      return state === "open"
        ? `Cancellation window · open until the end of ${deadline.label}`
        : `Cancellation window · ended at the end of ${deadline.label}`;
    },
    gate: (
      gate: GateName,
      view:
        "cleared" | "waived" | "blocked" | "waiting_on_owner" | "waiting_on_you" | "crew_waiting",
    ) => {
      switch (view) {
        case "cleared":
          return `${gate} cleared`;
        case "waived":
          return `${gate} waived`;
        case "waiting_on_owner":
          return `${gate} waiting on the owner`;
        case "waiting_on_you":
          return `${gate} waiting on you`;
        case "crew_waiting":
          return `${gate} waiting`;
        default:
          return `${gate} blocked`;
      }
    },
    contractSigned: (stamp: string) => `Contract signed ${stamp}`,
  },

  /** The window's value in the overview row and on the Materials step (frames 1 and 2). */
  window: {
    withStart: (stamp: string, deadline: string) => `Signed copy received ${stamp}. ${deadline}`,
    withUnknownStart: (deadline: string) => `Signed-copy receipt time is unavailable. ${deadline}`,
    openRow: (deadline: string) =>
      `Open until the end of ${deadline}. Plan now; ordering, purchase orders and a firm start wait until then.`,
    openRowExact: (stamp: string) =>
      `Open until ${stamp}. Plan now; ordering, purchase orders and a firm start wait until then.`,
    endedRow: (deadline: string) => `Ended at the end of ${deadline}.`,
    endedRowExact: (stamp: string) => `Ended ${stamp}.`,
    unknownRow: (reason: WindowUnknownReason | null) => `Unknown: ${unknownShort(reason)}`,
    holdsField: "Cancellation window",
    holdsOpen: (deadline: string) =>
      `Open until the end of ${deadline}. It holds ordering, a firm start and any purchase order moving to ordered or sent. It can’t be waived.`,
    holdsOpenExact: (stamp: string) =>
      `Open until ${stamp}. It holds ordering, a firm start and any purchase order moving to ordered or sent. It can’t be waived.`,
    holdsUnknown: (reason: WindowUnknownReason | null) =>
      `Unknown: ${unknownShort(reason)}. Until it’s known it holds ordering, a firm start and any purchase order moving to ordered or sent. It can’t be waived.`,
    /** Frame 19. */
    unknownBanner: (name: string, reason: WindowUnknownReason | null, shownAt: string | null) => {
      if (reason === "signed_copy_unconfirmed") {
        return `${name} was shown the signed copy at signing${
          shownAt ? ` ${shownAt}` : ""
        }, but it was never confirmed sent, so the cancellation window can’t be worked out; ordering and a firm start stay held.`;
      }
      if (reason === "signed_copy_before_contract") {
        return `The signed-copy time on record is from before ${name}’s latest contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.`;
      }
      return `No one has recorded when ${name} received the signed copy of the contract, so the cancellation window can’t be worked out; ordering and a firm start stay held.`;
    },
    addReceived: (name: string) => `Add when ${name} received the signed copy`,
    nextAfterAdd: "Adding that time shows when the window ends.",
    askOwnerOrOps: (name: string) =>
      `Only the Owner or Operations can add when ${name} received the signed copy.`,
    afterWindow: "after the window ends",
  },

  /** Frames 2, 3 and 17. */
  materials: {
    canStillCancel: (name: string) =>
      `${name} can still cancel until the window ends, so nothing is ordered before then.`,
    supplier: "Supplier",
    supplierHelp: "Who the order is with.",
    reference: "Supplier reference",
    referenceHelp: "The order or quote number, with no spaces, like 3152.",
    referenceInvalid: "Use letters, numbers and - . / : # only, with no spaces.",
    clearWithProof: "Clear Materials with this proof",
    nextHeld: (clearable: readonly GateName[]) =>
      [
        "After the window ends, order and add the supplier reference; then “Clear Materials with this proof” turns on.",
        clearable.length > 0 ? `${listWords(clearable)} can be cleared now.` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
    problemTitle: "This job has an open material problem, so Materials can’t clear yet.",
    seeProblem: "See the material problem",
    afterProblem: "after the problem is closed",
    nextProblem: "“Clear Materials with this proof” turns on once the problem is closed.",
  },

  /** Frames 4, 11, 14, 15 and 16. */
  safety: {
    whoClears:
      "Only someone who holds “checks site safety” and isn’t on this crew can clear Safety. It can’t be waived.",
    hazard: "Hazard assessment",
    hazardHelp: "Its reference, with no spaces, like 4417.",
    assessedAt: "When it was done",
    permitLegend: "Permit",
    permitHeld: "Permit needed and held",
    permitNotNeeded: "Permit not needed",
    permitUnknown: "Permit unknown",
    permitNumber: "Permit number",
    permitNumberHelp: "Like “building permit 4417”.",
    permitNumberInvalid: "Use letters and numbers with single spaces, up to 80 characters.",
    fallLegend: "Fall protection",
    fallPlan: "Fall-protection plan",
    fallNoExposure: "No exposure at 3 m",
    fallPlanRef: "Fall-protection plan",
    fallPlanHelp: "The plan’s reference, with no spaces, like ridge-anchors-2.",
    clearWithProof: "Clear Safety with this proof",
    permitUnknownValue: "Unknown: nobody has checked whether this job needs one",
    permitUnknownTitle: "The permit is unknown, so you can’t clear Safety yet.",
    changePermit: "Change the permit answer",
    afterPermit: "after you change the permit answer",
    nextPermit:
      "To clear Safety, choose “Permit needed and held” with its number, or “Permit not needed”.",
    competencyTitle: "You have no current competency record, so you can’t clear Safety yet.",
    addCompetency: "Add your current competency record",
    askCompetency: "Ask the office to add your current competency record.",
    afterCompetency: "after your record is current",
    nextCompetency: "“Clear Safety with this proof” turns on once your record is current.",
    stopTitle: "This job has an active safety stop, so Safety can’t clear until it’s lifted.",
    stopJobUnknownTitle:
      "A work stop names a job that doesn’t exist, so Safety stays held on every job until it’s lifted.",
    stopPlanUnknownTitle:
      "A work stop names a job plan that doesn’t exist, so Safety stays held on every job until it’s lifted.",
    seeStop: "See the safety stop",
    afterStop: "after the stop is lifted",
    nextStop:
      "Someone other than the person who raised it lifts the stop; then “Clear Safety with this proof” turns on.",
  },

  /** Frame 14, for any gate a crew member tries to clear. */
  onCrew: {
    title: (gate: GateName) => `You’re on the crew for this job, so you can’t clear its ${gate}.`,
    after: "after someone off this crew clears it",
    next: (gate: GateName) =>
      `Only someone who isn’t on this crew can clear ${gate}; “Clear ${gate} with this proof” stays off for you.`,
  },

  /** Frame 5. */
  access: {
    whoLegend: "Who confirmed access",
    customer: "The customer",
    propertyManager: "The property manager",
    notNeeded: "No one: access isn’t needed",
    when: "When",
    what: "What they confirmed",
    clearWithProof: "Clear Access with this proof",
  },

  /** Frames 6 and 18. */
  weather: {
    rule: "Weather can’t be waived. It needs a work window of 14 days or less and a forecast from the last 72 hours.",
    windowStart: "Work window starts",
    windowEnd: "Work window ends",
    windowSummary: (start: string, end: string, days: number) =>
      `${start} to ${end} · ${days} ${days === 1 ? "day" : "days"}`,
    forecast: "Forecast",
    forecastHelp: "What it says for the work window, like “Dry, wind under 30 km/h”.",
    forecastRead: "When you read it",
    forecastSource: "Where you read it",
    forecastSourceHelp: "The site’s name, like weather.gc.ca.",
    forecastSourceInvalid: "Use the site’s name in lower case, like weather.gc.ca.",
    clearWithProof: "Clear Weather with this proof",
    staleTitle: (day: string) =>
      `This forecast is from ${day}, over 72 hours ago, so Weather can’t clear.`,
    addForecast: "Add a forecast from the last 72 hours",
    afterForecast: "after you add a newer forecast",
    nextForecast:
      "“Clear Weather with this proof” turns on with a forecast from the last 72 hours.",
    windowInvalidTitle:
      "This work window can’t clear Weather: it must be 14 days or less, not over yet, and end within 14 days of the forecast.",
    changeWindow: "Change the work window",
  },

  /** The Deposit step, for a business that takes deposits (no frame yet). */
  deposit: {
    clearOnSettlement: depositSettlementAction,
    settlementHelp:
      "Deposit clears once the deposit invoice shows as paid. A waiver is a decision, not a proof.",
  },

  /** Frames 3, 5, 6 and 7: what turns "Schedule the crew" on. */
  schedule: {
    action: "Schedule the crew",
    afterGates: (gates: readonly GateName[]) =>
      `after ${listWords(gates)} ${gates.length === 1 ? "clears" : "clear"}`,
    /** A gate step once the window has ended: the gates still blocked, this one included. */
    nextClearThen: (gates: readonly GateName[]) =>
      gates.length === 1
        ? `Clearing ${gates[0]} turns on “Schedule the crew”.`
        : `Once ${listWords(gates)} are cleared, “Schedule the crew” turns on.`,
    /** A gate step inside the window: every gate still blocked, including this form's gate. */
    nextAfterWindowThen: (gates: readonly GateName[]) =>
      gates.length > 0
        ? `“Schedule the crew” turns on once the window ends and ${listWords(gates)} ${
            gates.length === 1 ? "is" : "are"
          } cleared.`
        : "“Schedule the crew” turns on once the window ends.",
    nextOnceClears: (gate: GateName) => `Clearing ${gate} turns on “Schedule the crew”.`,
    nextWindowAndEvery:
      "“Schedule the crew” turns on once the window ends and every gate is clear.",
    nextStaysOff: (gates: readonly GateName[]) =>
      `“Schedule the crew” stays off until ${listWords(gates)} ${gates.length === 1 ? "clears" : "clear"}.`,
  },

  /** Frames 7 and 7b, and the schedule form (no frame yet). */
  crew: {
    rule: "Crew clears by itself when you schedule the crew. There’s no form, and it can’t be waived.",
    field: "Crew",
    notYet: "Not yet: no crew scheduled for this job",
    pickCrew: "Which crew",
    pickCrewPlaceholder: "Choose a crew",
    noCrews: "No crew is set up yet. Add one under People first.",
    start: "Crew day starts",
    end: "Crew day ends",
    endHelp: "Leave it empty if the end isn’t known yet.",
    correction: "Why change the schedule?",
    issuePlan: "Issue job plan",

    allClear: (count: number, waived: number) =>
      waived > 0
        ? `All ${count} gates are cleared or waived and the cancellation window has ended.`
        : `All ${count} gates are cleared and the cancellation window has ended.`,
    clearedLine: (stamp: string, crew: string, start: string | null, windowDay: string | null) =>
      `Cleared ${stamp}: ${crew} scheduled${start ? ` for ${start}` : ""}${
        windowDay ? ` (the cancellation window ended at the end of ${windowDay})` : ""
      }`,
    crewFallback: "the crew",
    endBeforeStart: "The end has to come after the start.",
    scheduled: "The crew is scheduled.",
  },

  /** Frames 8a, 8, 9, 10 and 10b. */
  waiver: {
    ownerDecides: (gate: GateName) =>
      `An owner decides waivers. ${gate} stays blocked until they do.`,
    whyWaive: (gate: GateName) => `Why waive ${gate}?`,
    ask: (gate: GateName) => `Ask the owner to waive ${gate}`,
    askToWaive: (gate: GateName) => `Ask to waive ${gate}`,
    proofInstead: (gate: GateName) => `Clear ${gate} with proof instead`,
    nextAsk: (gate: GateName) =>
      `Asking sends the owner your reason. Their answer shows on the ${gate} gate.`,
    recorded: (when: string, gate: GateName) =>
      `Your request is recorded, ${when}. An owner decides; ${gate} stays blocked until then.`,
    othersRecorded: (when: string, gate: GateName) =>
      `A waiver of ${gate} was asked ${when}. An owner decides; ${gate} stays blocked until then.`,
    yourReason: "Your reason",
    theirReason: "Their reason",
    reasonHidden: "The reason was removed.",
    nextWaiting: (clearable: readonly GateName[]) =>
      clearable.length > 0
        ? `The owner’s answer shows on this gate. Meanwhile you can clear ${listWords(clearable)}.`
        : "The owner’s answer shows on this gate.",
    asks: (who: string, gate: GateName, reason: string) =>
      `${who} asks to waive ${gate}: “${reason}”`,
    asksNoReason: (who: string, gate: GateName) => `${who} asks to waive ${gate}.`,
    askerFromRole: (role: string | null) =>
      role === "owner"
        ? "Another owner"
        : role === "production"
          ? "Production"
          : "Someone in the office",
    decideReason: "Your reason (needed to approve or to decline)",
    approve: "Approve the waiver with this reason",
    decline: "Decline with this reason",
    nextDecide: (gate: GateName) =>
      `Your answer and reason go on the record, and the person who asked sees them on the ${gate} gate.`,
    ownerRequest:
      "If you’re the only person who can approve this waiver, submitting it approves it. Otherwise, another owner decides and the gate stays blocked.",
    submitOwn: (gate: GateName) => `Submit the ${gate} waiver with reason`,
    nextOwn: (gate: GateName) => `Your reason and the outcome show on the ${gate} gate.`,
    approvedOwn: (reason: string) =>
      `You approved this waiver yourself, since only you can. Your reason: “${reason}”`,
    waivedByYou: "Waived by you",
    waivedBy: (stamp: string, role: string | null) => `Waived ${stamp} ${byWhom(role)}`,
    nextAfterOwn: (clearable: readonly GateName[], windowHolds: boolean) =>
      [
        clearable.length > 0 ? `${listWords(clearable)} can be cleared now.` : null,
        windowHolds ? "Materials and Weather wait for the window to end." : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
    declinedAnswer: (stamp: string, reason: string | null) =>
      reason ? `Declined ${stamp}: “${reason}”` : `Declined ${stamp}`,
    ownerAnswer: "The owner’s answer",
    reasonTooShort: "Write at least 8 characters.",
    readOnly: "Only an owner or production can ask to waive a gate.",
    notWaivable: (gate: GateName) => `${gate} can’t be waived: only proof clears it.`,
  },

  /** Frames 13a and 13. */
  reversal: {
    clearedBy: (stamp: string, who: string) => `Cleared ${stamp} ${who}`,
    waivedBy: (stamp: string, who: string) => `Waived ${stamp} ${who}`,
    why: "Why reverse it?",
    reverse: "Reverse the clearance with this reason",
    rightProof: clearAfterReversal,
    afterReverse: "after you reverse this",
    next: (gate: GateName) =>
      `Reversing sets ${gate} back to blocked and keeps this clearance in its history; nothing is deleted. Then “${clearAfterReversal(gate)}” turns on.`,
    reversed: (when: string, gate: GateName) =>
      `Reversed ${when}. ${gate} is blocked again. Nothing was deleted.`,
  },

  /** History rows on a gate (frame 13). */
  history: {
    title: (stamp: string, kind: string) => `${stamp} · ${kind}`,
    cleared: "Cleared",
    reversed: "Reversed",
    waiverAsked: "Waiver asked",
    waived: "Waived",
    declined: "Waiver declined",
    earlier: "Cleared before this record began",
    byPolicy: "Set by the contract or the schedule",
    noDeposit: "No deposit under this contract",
    crewScheduled: "Set when the crew was scheduled",
    crewReplaced: "Released when another crew was scheduled",
    who: (role: string | null) =>
      role === "owner"
        ? "Owner"
        : role === "production"
          ? "Production"
          : role === "ops"
            ? "Operations"
            : "Office",
    line: (who: string, text: string) => `${who}: ${text}`,
    removedReason: "reason removed",
  },

  /** What a person's proof said, in one line (frames 13a and 13). */
  proof: {
    materials: (supplier: string | null, reference: string) =>
      supplier ? `${supplier} · ${reference}` : reference,
    permitHeld: (number: string) => `Permit needed and held · ${number}`,
    permitNotNeeded: "Permit not needed",
    fallPlan: (ref: string) => `fall-protection plan ${ref}`,
    noExposure: "no exposure at 3 m",
    access: (who: string, note: string | null) => (note ? `${who} · ${note}` : who),
    weather: (start: string, end: string, read: string) =>
      `${start} to ${end} · forecast read ${read}`,
  },

  /** Frames 19, 20, 20b, 20c, 21, 22 and 23. */
  record: {
    rule: (role: AppRole, name: string, contractStamp: string | null) =>
      `Only the Owner or Operations can record this, and you’re ${
        role === "owner" ? "the Owner" : "in Operations"
      }. The 10 days count from when ${name} received the signed copy, not from the signing. It can’t be in the future${
        contractStamp ? ` or before ${contractStamp}` : ""
      }.`,
    received: "Signed copy received",
    newTime: "New time",
    onRecord: "Signed copy received, on record",
    onRecordManual: (received: string, recorded: string, who: string) =>
      `${received} · recorded ${recorded} by ${who}`,
    onRecordShown: (shown: string) => `${shown} · shown in the portal at signing`,
    whoName: (name: string | null, role: string) =>
      name ? `${name} · ${roleTitle(role)}` : roleTitle(role),
    why: "Why are you recording it?",
    evidence: "Evidence reference",
    evidenceHelp: "Say where the time comes from, like “Delivered email · signed copy.pdf”.",
    /** Frame 20c: what to type in each empty required field. */
    reasonMissing: (name: string) => `Type how you know when ${name} received it`,
    evidenceMissing: "Type an evidence reference",
    submit: (name: string) => `Record when ${name} received it`,
    next: (name: string) =>
      `Recording it starts the window: it runs to the end of the 10th day after ${name} received it. Ordering and a firm start wait until it ends.`,
    recordedOpen: (deadline: string) =>
      `Recorded. The cancellation window is open until the end of ${deadline}.`,
    recordedOpenExact: (stamp: string) =>
      `Recorded. The cancellation window is open until ${stamp}.`,
    recordedEnded: (deadline: string) =>
      `Recorded. The cancellation window ended at the end of ${deadline}.`,
    recordedEndedExact: (stamp: string) => `Recorded. The cancellation window ended ${stamp}.`,
    recordedLine: (received: string, recorded: string) =>
      `${received} · recorded ${recorded} by you`,
    evidenceField: "Evidence",
    nextRecorded: (deadline: string) =>
      `Plan now; ordering, purchase orders and a firm start wait until the end of ${deadline}.`,
    unchanged: "That time is already on record, so nothing changed.",
    missingBoth:
      "Nothing was recorded: add why you’re recording this time and the evidence, so others can check where it came from.",
    missingReason:
      "Nothing was recorded: add why you’re recording this time, so others can check where it came from.",
    missingEvidence:
      "Nothing was recorded: add the evidence, so others can check where this time came from.",
    addBoth: "Add the reason and evidence",
    addReason: "Add the reason",
    addEvidence: "Add the evidence",
    afterBoth: "after you add both",
    afterOne: "after you add it",

    beforeContract: (received: string, signed: string, name: string) =>
      `${received} is before the contract was signed (${signed}), so ${name} can’t have received the signed copy then. Check the delivered email.`,
    inFuture: (received: string, name: string) =>
      `${received} hasn’t happened yet, so ${name} can’t have received the signed copy then. Check the delivered email.`,
    changeTime: "Change the time",
    afterChange: "after you change it",
    nextChange: (signed: string | null) =>
      signed ? `Enter a time from ${signed} up to now.` : "Enter a time up to now.",
    earlier: (received: string) =>
      `${received} is earlier than the time on record. This time can only move later, never earlier, so this isn’t saved.`,
    keep: (recorded: string) => `Keep ${recorded}`,
    nextEarlier: (deadline: string | null) =>
      deadline
        ? `The window is still open until the end of ${deadline}.`
        : "The time on record stays.",
    timeInvalid: "That time can’t be read. Pick a day and time again.",
    timeMissing: "Pick the day and time the signed copy was received.",
    readOnly: (name: string) =>
      `Only the Owner or Operations can record when ${name} received the signed copy.`,
  },

  /** Q1, Admin · Work queue › Signed copy time missing. */
  queue: {
    breadcrumbRoot: "Work queue",
    title: "Signed copy time missing",
    count: (count: number) => `Jobs that need a signed-copy time: ${count}`,
    why: "Without it, the cancellation window can’t start, so ordering and a firm start stay held.",
    rule: "Use when each customer received the signed copy of the contract, not when they signed.",
    notRecorded: "Not recorded yet",

    earlierContract: (stamp: string | null) =>
      stamp
        ? `Contract signed again ${stamp} · the time on record is for the earlier one`
        : "Contract signed again · the time on record is for the earlier one",
    unconfirmed: (stamp: string | null) =>
      stamp ? `Copy shown ${stamp} · receipt not confirmed` : "Copy shown · receipt not confirmed",
    add: (name: string) => `Add the signed-copy time for ${name}`,
    update: (name: string) => `Update the signed-copy time for ${name}`,
    confirm: (name: string) => `Confirm the signed-copy time for ${name}`,
    next: "A job leaves this list once its time is recorded; its cancellation window then shows when it ends.",
    empty: "Every signed job has its signed-copy time. Nothing to add.",
    partial: (shown: number) => `Showing the oldest ${shown}. Record these and the rest appear.`,
    loadFailed: "The list did not load. Nothing was changed.",
    readbackFailed: "The latest list could not be checked. Reload it before choosing a job.",
    retry: "Load the list again",
    loading: "Loading the list…",
    noAccess: "Only the Owner or Operations can see this list.",
    linkFromRunway: "Jobs that need a signed-copy time",
  },
} as const;

function unknownShort(reason: WindowUnknownReason | null): string {
  if (reason === "signed_copy_unconfirmed") return "signed copy never confirmed sent";
  if (reason === "signed_copy_before_contract")
    return "signed-copy time is from an earlier contract";
  return "no signed-copy time";
}

function roleTitle(role: string): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "ops":
      return "Operations";
    case "production":
      return "Production";
    default:
      return "Office";
  }
}

/**
 * Words for the refusals the gate routes answer. A code with a frame of its own is drawn by its
 * step (see `gate-refusals.ts`); these sentences cover the rest, so no refusal reads generic.
 */
export const gateRefusalWords: Readonly<Record<string, string>> = {
  production_gate_version_conflict:
    "Someone changed this gate while you had it open. Nothing was saved. Load the gates again to see it.",
  production_gate_already_cleared: "This gate is already cleared. Load the gates again to see how.",
  production_gate_not_cleared: "This gate is already blocked, so there is nothing to reverse.",
  production_gate_reversal_target_invalid:
    "This is no longer the clearance that holds the gate. Load the gates again to see it.",
  production_gate_contract_no_deposit_not_reversible:
    "“No deposit under this contract” can’t be reversed here. Only a newer contract changes it.",
  production_gate_attestation_invalid:
    "Some of this proof can’t be saved as written. Check each field, then send it again.",
  production_gate_evidence_invalid:
    "A file this proof points to can’t be used. Check the proof, then send it again.",
  production_gate_clearance_forbidden: "Only an owner or production can clear or waive a gate.",
  production_gate_reversal_forbidden: "Only an owner or production can reverse a clearance.",
  production_gate_waiver_decision_forbidden: "Only an owner decides a waiver.",
  production_gate_waiver_self_approval_refused:
    "Another owner is active, so they decide your own request.",
  production_gate_waiver_already_decided:
    "This request was already decided. Load the gates again to see the answer.",
  production_gate_waiver_request_invalid:
    "This request is no longer open. Load the gates again to see where it stands.",
  production_gate_job_not_on_runway:
    "This job is not on your production plan, so its gates cannot be changed here.",
  production_gate_clearance_seed_identity_refused:
    "This sign-in can’t change a gate. Sign in with your own account.",
  production_gate_clearance_actor_invalid:
    "Your account can’t change this gate. Ask the office to check your access.",
  production_gate_clearance_replay_conflict:
    "This was already sent with other details. Load the gates again before you send it again.",
  production_gate_clearance_reason_required: "Write a reason of at least 8 characters.",
  production_gate_not_attestable: "This gate doesn’t clear with a proof form.",
  production_gate_not_waivable:
    "Safety, Weather and Crew can’t be waived: they keep the crew safe, so only proof clears them.",
  production_gate_safety_person_only: "Only a person can clear Safety.",
  invalid_production_gate_clearance: "Some of this can’t be saved as written. Check each field.",
  invalid_production_gate_waiver_decision: "Write a reason of at least 8 characters.",
  invalid_production_gate_reversal: "Write a reason of at least 8 characters.",
  deposit_settlement_not_observed:
    "No paid deposit invoice is on record for this job yet. Clear Deposit once the payment shows, or ask to waive it.",
  production_gate_receipt_unavailable:
    "The clearance record could not be stored, so nothing was changed.",
  person_session_required: "Sign in with your own account to do this.",
  idempotency_key_required: "This request was not complete. Load the gates again and try again.",
  cancellation_window_receipt_owner_or_ops_required:
    "Only an owner or ops can record when the signed copy was received.",
  cancellation_window_receipt_seed_identity_refused:
    "This sign-in can’t record this. Sign in with your own account.",
  cancellation_window_receipt_replay_conflict:
    "This was already sent with other details. Load the gates again before you send it again.",
  cancellation_window_receipt_contract_changed:
    "The customer signed a newer contract while you were recording this. Load the gates again.",
  cancellation_window_receipt_time_invalid: "That time can’t be read. Pick a day and time again.",
  cancellation_window_receipt_job_unknown:
    "This job can’t be found. Open it again from the production plan.",
  cancellation_window_receipt_unchanged: "That time is already on record, so nothing changed.",
  invalid_cancellation_window_receipt:
    "Some of this can’t be saved as written. Check the reason and the evidence.",
  operating_job_assignment_cancellation_window_unknown:
    "No one has recorded when the customer received the signed copy, so the crew can’t be scheduled yet.",
  operating_job_assignment_cancellation_window_open:
    "The cancellation window hasn’t ended, so the crew can’t be scheduled yet.",
  operating_job_assignment_gates_blocked:
    "A gate is still blocked, so the crew can’t be scheduled yet. Clear every gate first.",
  operating_job_assignment_weather_window_missing:
    "Weather has no work window on record. Clear Weather with a forecast, then schedule the crew.",
  operating_job_assignment_weather_window_ended:
    "The Weather work window has ended. Clear Weather again with a newer forecast, then schedule the crew.",
  operating_job_assignment_outside_weather_window:
    "The crew day falls outside the Weather work window. Pick a time inside it.",
  operating_job_assignment_crew_not_independent:
    "Someone on this crew cleared one of this job’s gates. Pick another crew, or have someone off the crew clear that gate again.",
  operating_job_assignment_crew_gate_unbound:
    "Crew could not be set for this crew. Load the gates again, then schedule again.",
  operating_job_assignment_deposit_contract_superseded:
    "The customer signed a newer contract with other payment terms. Deposit has to clear again before the crew is scheduled.",
  operating_job_assignment_stop_active:
    "This job has an active work stop, so the crew can’t be scheduled until it’s lifted.",
  operating_job_assignment_stop_job_unknown:
    "A work stop names a job that doesn’t exist, so no crew can be scheduled until it’s lifted.",
  operating_job_assignment_stop_work_package_unknown:
    "A work stop names a job plan that doesn’t exist, so no crew can be scheduled until it’s lifted.",
  operating_job_assignment_seed_identity_refused:
    "This sign-in can’t schedule a crew. Sign in with your own account.",
  operating_job_assignment_crew_invalid:
    "This crew isn’t ready to work. Pick another crew, or check its members under People.",
  operating_job_assignment_roster_invalid:
    "Someone on this crew can’t work right now. Check the crew’s members under People.",
  operating_job_assignment_crew_version_invalid:
    "This crew changed while you had it open. Load the gates again and pick the crew again.",
  operating_job_assignment_job_version_invalid:
    "The job changed while you had it open. Load the gates again.",
  operating_job_assignment_job_invalid: "This job can’t be scheduled right now.",
  operating_job_assignment_start_invalid: "Check the start: pick a day and time.",
  operating_job_assignment_end_invalid: "The end has to come after the start.",
  operating_job_assignment_time_invalid: "Check the start and the end, then schedule again.",
  operating_job_assignment_correction_invalid:
    "Say why the schedule changes, in at least 3 characters.",
  operating_job_assignment_predecessor_invalid:
    "The schedule changed while you had it open. Load the gates again.",
  operating_job_assignment_chain_conflict:
    "The schedule changed while you had it open. Load the gates again.",
  production_role_required: "Only an owner, ops or production can schedule a crew.",
};

export const gateFallbacks = {
  refused:
    "This was not accepted, and nothing was changed. Load the gates again to see where the job stands.",
  unconfirmed:
    "We could not confirm this went through. Load the gates again to check before you try again.",
} as const;
