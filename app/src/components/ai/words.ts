import {
  Calculator,
  CalendarClock,
  CircleGauge,
  CircleOff,
  Eye,
  Factory,
  FilePen,
  HardHat,
  Headphones,
  HeartHandshake,
  Lock,
  Megaphone,
  Pause,
  Pencil,
  Receipt as ReceiptGlyph,
  Ruler,
  Scale,
  ScanSearch,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { z } from "zod";

import { dateTimeFormatter } from "../../lib/intl-cache";
import { appRoles, roleLabel, type AppRole } from "../../lib/roles";
import type { StatusKind } from "../ui/status";

/*
 * The words people see for the values of the AI team contract (docs/AI-TEAM-CONTRACT.md, the
 * machine-readable block) and design/system-v2/AI-PRIMITIVES.md. Screens never show a contract
 * value itself: an outcome, a policy result, a reason code, a delegation field or a specialist id
 * goes through this module. words.test.ts reads the contract and fails when the two drift.
 */

/**
 * The roster, in contract order: the display name people see (it always says "AI", or the
 * tenant's brand for the face) and the glyph on its badge (Board 6). The face uses the brand
 * mark, so it has no glyph here.
 */
export const SPECIALISTS = {
  orchestrator: { name: "IronWrap", glyph: null },
  market_analyst: { name: "AI market analyst", glyph: TrendingUp },
  lead_concierge: { name: "AI receptionist", glyph: Headphones },
  estimator: { name: "AI estimator", glyph: Calculator },
  measurement_design: { name: "AI measurer", glyph: Ruler },
  proposal_contract: { name: "AI proposal writer", glyph: FilePen },
  purchasing_inventory: { name: "AI buyer", glyph: ShoppingCart },
  shop_planner: { name: "AI shop planner", glyph: Factory },
  scheduler_dispatcher: { name: "AI scheduler", glyph: CalendarClock },
  field_safety: { name: "AI field coordinator", glyph: HardHat },
  quality_inspector: { name: "AI quality inspector", glyph: ScanSearch },
  billing_reconciliation: { name: "AI bookkeeper", glyph: ReceiptGlyph },
  compliance: { name: "AI compliance checker", glyph: ShieldCheck },
  customer_care_warranty: { name: "AI customer care", glyph: HeartHandshake },
  marketing_reputation: { name: "AI marketer", glyph: Megaphone },
  independent_auditor: { name: "AI auditor", glyph: Scale },
} as const satisfies Record<string, { name: string; glyph: LucideIcon | null }>;

export type SpecialistId = keyof typeof SPECIALISTS;
export const SPECIALIST_IDS = Object.keys(SPECIALISTS) as SpecialistId[];

/**
 * The name a specialist goes by on every screen. A specialist this app does not know yet (a newer
 * Worker's roster) reads "AI team" rather than taking the screen down.
 */
export function specialistName(id: SpecialistId): string {
  return (SPECIALISTS as Record<string, { name: string } | undefined>)[id]?.name ?? "AI team";
}

/** The action class, fixed by consequence. Shown only inside System details. */
export type ActionClass = "A0" | "A1" | "A2" | "A3" | "H";

/** What a specialist may do with one action, in the words people see (AI-PRIMITIVES). */
export type DelegationSetting =
  | "reads"
  | "prepares"
  | "within_limits"
  | "asks_first"
  | "people_only"
  | "paused"
  | "off_until_enabled"
  | "always_on"
  | "always_asks_first";

export const DELEGATION: Record<DelegationSetting, { words: string; glyph: LucideIcon }> = {
  reads: { words: "Reads and watches", glyph: Eye },
  prepares: { words: "Prepares", glyph: Pencil },
  within_limits: { words: "Acts within your limits", glyph: CircleGauge },
  asks_first: { words: "Asks first", glyph: UserCheck },
  people_only: { words: "People only", glyph: Lock },
  paused: { words: "Paused", glyph: Pause },
  off_until_enabled: { words: "Off until you turn it on", glyph: CircleOff },
  always_on: { words: "Always on: protects you", glyph: ShieldCheck },
  always_asks_first: { words: "Always asks first", glyph: Lock },
};

/** The catalog fields of one action that decide its delegation words. */
export interface CatalogAction {
  autonomy: ActionClass;
  human_only: boolean;
  protective: boolean;
  delegable: boolean;
  default_delegation: "asks_first" | "within_limits" | "off_until_enabled" | null;
}

/**
 * The words for one action: a people-only act (`human_only`) has no setting; a protective action
 * is always on, paused or not; class A0 reads and watches; while its specialist is paused every
 * other action asks first and drafting stops (AI-TEAM-CONTRACT.md, Delegation, "Per specialist");
 * otherwise A1 prepares, an A2 or A3 action the owner can never delegate (`delegable: false`)
 * always asks first, and the rest take the owner's current setting or the catalog's start state.
 */
export function delegationOf(
  action: CatalogAction,
  current: {
    setting?: "asks_first" | "within_limits" | "off_until_enabled";
    paused?: boolean;
  } = {},
): DelegationSetting {
  if (action.human_only || action.autonomy === "H") return "people_only";
  if (action.protective) return "always_on";
  if (action.autonomy === "A0") return "reads";
  if (action.autonomy !== "A1" && !action.delegable) return "always_asks_first";
  if (current.paused) return "asks_first";
  if (action.autonomy === "A1") return "prepares";
  return current.setting ?? action.default_delegation ?? "asks_first";
}

/**
 * The specialist-level control's words: "Paused" while the owner has paused the specialist, and
 * nothing otherwise. Each action then shows its own words through `delegationOf`, never "Paused".
 */
export function specialistDelegation({
  paused,
}: {
  paused: boolean;
}): { setting: "paused"; words: string } | null {
  return paused ? { setting: "paused", words: DELEGATION.paused.words } : null;
}

/** The fourteen receipt fields, in contract order. */
export const RECEIPT_FIELDS = [
  "specialist_id",
  "run_id",
  "action_id",
  "did",
  "doing",
  "needs_from_you",
  "sources",
  "policy",
  "permit",
  "tool",
  "readback",
  "outcome",
  "undo",
  "do_it_myself",
] as const satisfies readonly (keyof ContractReceipt)[];

export const REASON_CODES = {
  // An answer that stands although its generated view was refused (contract f4.1), and a
  // people-only draft that leaves Needs you because a person made the change or a newer draft
  // replaced it (contract f5).
  succeeded: ["view_spec_invalid", "applied_by_person", "superseded"],
  failed: [
    "policy_denied",
    "declined",
    "approval_expired",
    "superseded",
    "done_by_person",
    "tool_refused",
    "provider_rejected",
    "readback_mismatch",
  ],
  unknown: ["no_readback_yet"],
  abstained: [
    "fact_missing",
    "fact_stale",
    "fact_conflict",
    "citation_unverifiable",
    "action_unregistered",
    "policy_missing",
    "ceiling_reached",
    "no_progress",
    "provider_unavailable",
    "no_qualified_route",
    "injection_suspected",
    "out_of_scope",
    "person_requested",
    "safety_event",
    "emergency",
  ],
} as const;

export type Outcome = "succeeded" | "failed" | "unknown" | "abstained";
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES][number];

/** One coordination-run step, exactly as the Worker emits it (`workers-bus/src/agents/receipts.ts`). */
export interface ContractReceipt {
  specialist_id: SpecialistId;
  run_id: string;
  action_id: string;
  did: string | null;
  doing: string | null;
  needs_from_you: { reviewer_role: string; person_id: string | null; ask: string } | null;
  sources: { fact_id: string; version: number; hash: string | null }[];
  policy: {
    policy_id: string;
    version: string;
    result: "allow" | "needs_approval" | "deny";
    checks: { check: string; passed: boolean }[];
    reason_codes: ReasonCode[];
  };
  permit: {
    kind: "none" | "draft" | "within_limits" | "asks_first";
    permit_id: string | null;
    approval_id: string | null;
    approved_by: string | null;
    delegation_id: string | null;
  };
  tool: { name: string; binding: string; idempotency_key: string; request_hash: string } | null;
  readback: { source: string; reference: string; response_hash: string; matched: boolean } | null;
  outcome: Outcome | null;
  undo: { mode: "none" | "automatic" | "manual"; action_id: string | null; available: boolean };
  do_it_myself: { surface: string | null; context: unknown };
}

/** The receipt states of the copy table, plus the two failed outcomes that are not held. */
export type ReceiptState =
  "needs_you" | "working" | "done" | "held" | "undone" | "replaced" | "done_by_person";

/** A person who answered, approved, released or did a step. */
export interface Person {
  name: string;
  /** Two letters for the circle; taken from the name when absent. */
  initials?: string;
}

export function initialsOf({ name, initials }: Person): string {
  return (
    initials ??
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("")
  );
}

/**
 * The chip of a step a person did instead of the AI team (AI-PRIMITIVES copy table): "Done by
 * {name}" with the tick, or, while the answer still has to reach a phone or another system,
 * "Answered by {name} · waiting for the phone" with the clock. The person's initials circle
 * stands where the badge would; the AI badge never does.
 */
export function personDoneWords(
  by: string,
  waitingFor?: string,
): { words: string; kind: StatusKind } {
  return waitingFor
    ? { words: `Answered by ${by} · waiting for ${waitingFor}`, kind: "pending" }
    : { words: `Done by ${by}`, kind: "done" };
}

/** Each state's chip: its words and its status kind. Only Needs you is blue and only Held red. */
export const RECEIPT_STATE: Record<ReceiptState, { words: string; kind: StatusKind }> = {
  needs_you: { words: "Needs you", kind: "you" },
  working: { words: "Working on it", kind: "working" },
  done: { words: "Done for you", kind: "done" },
  held: { words: "Held", kind: "stopped" },
  undone: { words: "Undone", kind: "undone" },
  replaced: { words: "Replaced", kind: "retired" },
  done_by_person: { words: "Done by a person", kind: "done" },
};

export interface ReceiptWords {
  state: ReceiptState;
  /** The state chip's words: "Done for you", "Held", "Undone by Dana Whitford". */
  words: string;
  /** The status chip kind; only Needs you is blue and only Held is red. */
  kind: StatusKind;
  /** Held: why it waits, in one sentence. */
  why?: string;
  /**
   * Something the person should know: on Done, `VIEW_REFUSED` ("IronWrap couldn't draw the layout
   * you asked for, …"); on a closed people-only draft, `appliedByPersonNote` or `supersededNote`.
   */
  note?: string;
  /** Held: the one next step. */
  next?: string;
  /** Working on it: what it is waiting for. */
  waiting?: string;
}

type HeldReason = Exclude<
  ReasonCode,
  | "declined"
  | "superseded"
  | "done_by_person"
  | "no_readback_yet"
  | "view_spec_invalid"
  | "applied_by_person"
>;

/** Why a held step waits, in one sentence, and the one next step (AI-PRIMITIVES outcome table). */
const HELD: Record<HeldReason, (where: string) => { why: string; next: string }> = {
  policy_denied: () => ({
    why: "A rule you set does not allow this step.",
    next: "Do it yourself if it should still happen.",
  }),
  tool_refused: () => ({
    why: "IronWrap could not carry out the step as it was written.",
    next: "Do it yourself.",
  }),
  provider_rejected: (where) => ({
    why: `${where} turned the step down.`,
    next: "Do it yourself.",
  }),
  readback_mismatch: (where) => ({
    why: `What ${where} shows does not match what was sent.`,
    next: "Compare the two and correct the one that is wrong.",
  }),
  approval_expired: () => ({
    why: "The approval ran out before the step ran.",
    next: "Approve it again.",
  }),
  fact_missing: () => ({ why: "A fact it needs is missing.", next: "Add the missing fact." }),
  fact_stale: () => ({ why: "A fact it needs is out of date.", next: "Update the fact." }),
  fact_conflict: () => ({ why: "Two records disagree.", next: "Decide which record is right." }),
  citation_unverifiable: () => ({
    why: "The source could not be checked.",
    next: "Check the source yourself.",
  }),
  ceiling_reached: () => ({
    why: "It reached the limit you set.",
    next: "Approve this one yourself.",
  }),
  provider_unavailable: () => ({ why: "Its service is not answering.", next: "Do it yourself." }),
  no_qualified_route: () => ({
    why: "It is not cleared to do this step yet.",
    next: "Do it yourself.",
  }),
  injection_suspected: () => ({
    why: "The message looked like an attempt to trick it.",
    next: "A person reads the message.",
  }),
  person_requested: () => ({
    why: "The customer asked for a person.",
    next: "Answer the customer yourself.",
  }),
  action_unregistered: () => notItsJob,
  policy_missing: () => notItsJob,
  out_of_scope: () => notItsJob,
  no_progress: () => notItsJob,
  safety_event: () => ({
    why: "A work stop or safety report stopped it.",
    next: "A person takes over.",
  }),
  emergency: () => ({
    why: "An emergency: it paged a person and does nothing else.",
    next: "Answer the page.",
  }),
};
const notItsJob = { why: "This is not something it may do.", next: "A person decides." };

/** An answer whose generated view was refused: the answer text stands; asking again may draw it. */
export const VIEW_REFUSED =
  "IronWrap couldn't draw the layout you asked for, so the answer is in the text above. To try once more, type your request in other words in the box below.";

/** What a person set by hand on the record a closed draft prepared (`do_it_myself.context.applied`). */
export interface AppliedByPerson {
  field: "role" | "delegation_setting";
  value: string;
  /** The person's user id; without it the note says "A person". */
  by?: string;
}

const appliedSchema = z.object({
  applied: z.object({
    field: z.enum(["role", "delegation_setting"]),
    value: z.string().min(1),
    by: z.string().min(1).optional(),
  }),
});

/** The `applied` record of a closed draft's `do_it_myself.context`; anything else reads as absent. */
export function appliedOf(context: unknown): AppliedByPerson | undefined {
  const parsed = appliedSchema.safeParse(context);
  return parsed.success ? parsed.data.applied : undefined;
}

/** What a person changed, when the screen names no record. */
const APPLIED_SUBJECT: Record<AppliedByPerson["field"], string> = {
  role: "the role",
  delegation_setting: "the AI team setting",
};

/**
 * The delegation settings a person can set by hand, as the contract's delegation table shows them,
 * each with what it means once (gate c2: "Asks first" alone was terse).
 */
const APPLIED_SETTING: Record<string, string> = {
  asks_first: `${DELEGATION.asks_first.words}: it asks a person each time before it acts`,
  within_limits: `${DELEGATION.within_limits.words}: it acts without asking up to the limit set, and asks a person for anything over the limit`,
  off: "Off: it does not do this at all, and people do it by hand",
  shadow:
    "Practice only: it runs practice rounds that change nothing, and people still do the real work",
};

/** What is set now, in the words its screen shows (a role, or a delegation setting's "Shown as"). */
function appliedValueWords({ field, value }: Pick<AppliedByPerson, "field" | "value">) {
  if (field === "role")
    return (appRoles as readonly string[]).includes(value)
      ? roleLabel(value as AppRole)
      : undefined;
  return Object.hasOwn(APPLIED_SETTING, value) ? APPLIED_SETTING[value] : undefined;
}

/**
 * A people-only draft whose record a person changed by hand (`applied_by_person`). With what is
 * set now (`applied`): who changed which record, that the draft is closed, and what the record
 * is now, whatever the draft proposed, so it never claims the person made "this change". Without
 * it, or with a value it has no words for: who made the change, to which record, that the draft is
 * closed (gate f5: "closing this draft" read as a button to find), that the change stays in place
 * (gate f5: "does not undo the change" left readers only fairly sure it still held), and that
 * nothing is left.
 */
export function appliedByPersonNote(
  by = "A person",
  record?: string,
  applied?: Pick<AppliedByPerson, "field" | "value">,
): string {
  const value = applied && appliedValueWords(applied);
  if (applied && value) {
    const subject = record ?? APPLIED_SUBJECT[applied.field];
    return `${by} changed ${subject} by hand, so this draft is closed. ${subject.charAt(0).toUpperCase()}${subject.slice(1)} is now ${value}.`;
  }
  return `${by} already made this change${record ? ` to ${record}` : ""}, so this draft is closed. The change stays in place, and nothing is left to do.`;
}

/** A people-only draft a newer one replaced (`superseded`): it changed nothing; where the newer one waits. */
export function supersededNote(record?: string): string {
  return `A newer draft ${record ? `for ${record}` : "of the same change"} replaced this one. This draft changed nothing; the newer draft is in Needs you.`;
}

/**
 * The state words of one receipt. `by` names the person who declined, undid or did the step;
 * `where` is the outside system in plain words ("QuickBooks"); `waitingFor` is where a person's
 * answer still has to arrive ("the phone"); `record` is what a people-only draft changes ("Grace
 * Obi's role"); `applied` is what a person set on it by hand (`appliedOf`).
 */
export function receiptWords(
  receipt: Pick<ContractReceipt, "outcome" | "policy" | "needs_from_you">,
  {
    by,
    where = "the other system",
    waitingFor,
    record,
    applied,
  }: {
    by?: string;
    where?: string;
    waitingFor?: string;
    record?: string;
    applied?: AppliedByPerson;
  } = {},
): ReceiptWords {
  const [reason] = receipt.policy.reason_codes;
  const as = (state: ReceiptState, words?: string): ReceiptWords => ({
    state,
    ...RECEIPT_STATE[state],
    ...(words ? { words } : {}),
  });
  const held = (code: ReasonCode | undefined): ReceiptWords => {
    const words = code && code in HELD ? HELD[code as HeldReason](where) : undefined;
    return {
      ...as("held"),
      why: words?.why ?? "It stopped before acting.",
      next: words?.next ?? "A person decides.",
    };
  };
  switch (receipt.outcome) {
    case "succeeded":
      // The answer stands; only its generated view was refused, so say what to do instead.
      if (reason === "view_spec_invalid") return { ...as("done"), note: VIEW_REFUSED };
      // A people-only draft leaves Needs you, never for Done for you: a person made the change,
      // or a newer draft replaced it.
      if (reason === "applied_by_person")
        return {
          ...(by
            ? { state: "done_by_person" as const, ...personDoneWords(by) }
            : as("done_by_person")),
          note: appliedByPersonNote(by, record, applied),
        };
      if (reason === "superseded") return { ...as("replaced"), note: supersededNote(record) };
      return as("done");
    case "unknown":
      return { ...as("working"), waiting: `Waiting for ${where} to confirm.` };
    case "failed":
      if (reason === "declined") return as("undone", by && `Undone by ${by}`);
      if (reason === "superseded") return as("replaced");
      if (reason === "done_by_person")
        return by
          ? { state: "done_by_person", ...personDoneWords(by, waitingFor) }
          : as("done_by_person");
      return held(reason);
    case "abstained":
      return held(reason);
    case null:
      if (receipt.policy.result === "deny") return held(reason ?? "policy_denied");
      if (receipt.policy.result === "needs_approval" || receipt.needs_from_you)
        return as("needs_you");
      return as("working");
  }
}

/** A button on a receipt, and its rank: the one You primary, outlined secondary, or ghost. */
export interface ReceiptAction {
  id: "primary" | "next" | "stop" | "undo" | "edit";
  rank: "you" | "secondary" | "quiet";
}

/** Which buttons can do something here: each has its handler, and Edit its screen too. */
export type ReceiptActionsAvailable = Record<ReceiptAction["id"], boolean>;

/**
 * The buttons a receipt offers, in order, with their rank (AI-PRIMITIVES copy table and
 * LIBRARY-WAVE 1, 14, 15): one primary only in Needs you; "Edit {object}" (IRW-R8d R8d-2, in place
 * of "Do it myself") secondary in Needs you, Held and Working on it, ghost in Done for you. Undo
 * only in Done for you, while it can be undone: nothing has run while a step needs you, works or is
 * held, and testers read Undo there as "undo my approval". A standing watch offers Stop in place of
 * Undo. A button appears only when it can act.
 */
export function receiptActions(
  state: ReceiptState,
  available: ReceiptActionsAvailable,
): ReceiptAction[] {
  const offered = (id: ReceiptAction["id"], rank: ReceiptAction["rank"]): ReceiptAction[] =>
    available[id] ? [{ id, rank }] : [];
  switch (state) {
    case "needs_you":
      return [...offered("primary", "you"), ...offered("edit", "secondary")];
    case "done":
      return [
        ...(available.stop ? offered("stop", "secondary") : offered("undo", "secondary")),
        ...offered("edit", "quiet"),
      ];
    case "held":
      return [...offered("next", "secondary"), ...offered("edit", "secondary")];
    case "working":
    case "undone":
      return offered("edit", "secondary");
    case "replaced":
    case "done_by_person":
      return [];
  }
}

/** The six reviewer roles: a label for "Who decides" and the words after "Waiting on". */
// IRW-R8d rule 7: who decides is a named person or a role, never a job title or a department, so
// only the Owner role has words here; any other reviewer reads "a person" until the screen names one.
const REVIEWER: Partial<Record<string, { label: string; words: string }>> = {
  owner: { label: "Owner", words: "the owner" },
};

/**
 * Who may decide a step that needs a person, for a viewer who may not: the chip's words
 * ("Waiting on Dana Whitford", "Waiting on the owner", "Waiting on a person") and the "Who decides"
 * row ("Dana Whitford, Owner"). `name` is the named person's name, when the receipt names one.
 */
export function deciderWords(
  reviewerRole: string,
  name?: string,
): { waiting: string; decides?: string } {
  const role = REVIEWER[reviewerRole];
  return {
    waiting: `Waiting on ${name ?? role?.words ?? "a person"}`,
    // R8d-6: an item names its responsible person or, until MD-06, "Nobody yet".
    decides: name && role ? `${name}, ${role.label}` : (name ?? role?.label ?? "Nobody yet"),
  };
}

/** What a value nobody can show says instead: never 0, never a blank (TOKENS.md, principle 3). */
export const NOT_KNOWN_YET = "Not known yet";

/** Money as the contract keeps it: an integer count of the currency's minor units. */
export interface Money {
  minor: number;
  currency: string;
}

export const isMoney = (value: unknown): value is Money =>
  typeof value === "object" && value !== null && "minor" in value && "currency" in value;

/**
 * "CAD 9,860.00": the ISO code, then the amount with every minor digit (none for JPY, three for
 * KWD). Built from the integer, so no amount is rounded through a float. Money is set in the text
 * face with tabular figures, never in mono.
 */
export function formatMoney({ minor, currency }: Money, locale = "en-CA"): string {
  // An amount it cannot show exactly says so in words: a screen never shows a guess or breaks.
  if (!Number.isSafeInteger(minor) || !/^[A-Z]{3}$/.test(currency)) return NOT_KNOWN_YET;
  try {
    const digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    const units = Math.abs(minor)
      .toString()
      .padStart(digits + 1, "0");
    const whole = new Intl.NumberFormat(locale).format(
      BigInt(units.slice(0, units.length - digits)),
    );
    const fraction = digits ? `.${units.slice(units.length - digits)}` : "";
    return `${minor < 0 ? "-" : ""}${currency}\u00a0${whole}${fraction}`;
  } catch {
    return NOT_KNOWN_YET;
  }
}

/** A moment as people read it, and the instant for `<time dateTime>`. */
export interface When {
  text: string;
  at?: string;
}

/**
 * The zone times are read in when the caller passes none: the company's own, in Alberta. A screen
 * passes the tenant's or session's zone; this is only the explicit default.
 */
export const DEFAULT_TIME_ZONE = "America/Edmonton";

/**
 * "Today 06:42", "Yesterday 15:40", "Thu 07:00": a day word and the 24-hour time, never a calendar
 * date in copy and never a zone abbreviation (IRW-R8d rules 8 and 9: every time is Alberta time, and
 * text that needs the zone says "Alberta time"). Days and hours are counted in `timeZone`.
 */
export function dayTime(
  at: Date | number | string,
  {
    now = Date.now(),
    timeZone = DEFAULT_TIME_ZONE,
    locale = "en-CA",
  }: { now?: Date | number; timeZone?: string; locale?: string } = {},
): When {
  const instant = new Date(at);
  const today = new Date(now);
  // A time it cannot read says so in words; an unknown zone reads in the company's zone.
  if (Number.isNaN(instant.getTime()) || Number.isNaN(today.getTime()))
    return { text: NOT_KNOWN_YET };
  try {
    return { text: dayTimeText(instant, today, timeZone, locale), at: instant.toISOString() };
  } catch {
    if (timeZone === DEFAULT_TIME_ZONE) return { text: NOT_KNOWN_YET };
    return dayTime(instant, { now: today, timeZone: DEFAULT_TIME_ZONE, locale });
  }
}

function dayTimeText(instant: Date, now: Date, timeZone: string, locale: string): string {
  const days = dateTimeFormatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const dayNumber = (date: Date) => {
    const part = (type: string) =>
      Number(days.formatToParts(date).find((entry) => entry.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
  };
  const offset = dayNumber(instant) - dayNumber(now);
  const day =
    offset === 0
      ? "Today"
      : offset === -1
        ? "Yesterday"
        : offset === 1
          ? "Tomorrow"
          : Math.abs(offset) < 7
            ? dateTimeFormatter(locale, { timeZone, weekday: "short" }).format(instant)
            : offset < 0
              ? `${-offset} days ago`
              : `In ${offset} days`;
  const time = dateTimeFormatter(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${day} ${time}`;
}
