import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DEFAULT_TIME_ZONE,
  DELEGATION,
  RECEIPT_FIELDS,
  dayTime,
  deciderWords,
  delegationOf,
  formatMoney,
  receiptWords,
  specialistDelegation,
  type CatalogAction,
  type ContractReceipt,
  type ReasonCode,
} from "./words";

const open = (overrides: Partial<ContractReceipt["policy"]> = {}) => ({
  outcome: null,
  needs_from_you: null,
  policy: {
    policy_id: "policy.invoice",
    version: "3",
    result: "allow" as const,
    checks: [],
    reason_codes: [],
    ...overrides,
  },
});
const closed = (outcome: ContractReceipt["outcome"], reason?: ReasonCode) => ({
  ...open({ reason_codes: reason ? [reason] : [] }),
  outcome,
});

describe("receipt state words (AI-PRIMITIVES, outcome and policy result to words)", () => {
  it("names the five states of the copy table and colours only Needs you and Held", () => {
    expect(receiptWords(open({ result: "needs_approval" }))).toMatchObject({
      state: "needs_you",
      words: "Needs you",
      kind: "you",
    });
    expect(receiptWords(closed("succeeded"))).toMatchObject({
      state: "done",
      words: "Done for you",
      kind: "done",
    });
    expect(receiptWords(closed("unknown", "no_readback_yet"), { where: "QuickBooks" })).toEqual({
      state: "working",
      words: "Working on it",
      kind: "working",
      waiting: "Waiting for QuickBooks to confirm.",
    });
    expect(receiptWords(open())).toMatchObject({ state: "working", words: "Working on it" });
    expect(receiptWords(closed("abstained", "fact_missing"))).toMatchObject({
      state: "held",
      words: "Held",
      kind: "stopped",
    });
    expect(receiptWords(closed("failed", "declined"), { by: "Dana Whitford" })).toMatchObject({
      state: "undone",
      words: "Undone by Dana Whitford",
      kind: "undone",
    });
  });

  it("waits on the viewer when a person is asked, even before the policy answers", () => {
    expect(
      receiptWords({
        ...open(),
        needs_from_you: { reviewer_role: "owner", person_id: "person_dana", ask: "Approve it." },
      }).state,
    ).toBe("needs_you");
    expect(receiptWords(open({ result: "deny" }))).toMatchObject({
      state: "held",
      why: "A rule you set does not allow this step.",
    });
  });

  it("says replaced and done by a person apart from held", () => {
    expect(receiptWords(closed("failed", "superseded"))).toMatchObject({
      state: "replaced",
      words: "Replaced",
    });
    expect(receiptWords(closed("failed", "done_by_person"), { by: "Grace Obi" })).toMatchObject({
      state: "done_by_person",
      words: "Done by Grace Obi",
    });
    expect(
      receiptWords(closed("failed", "done_by_person"), {
        by: "Grace Obi",
        waitingFor: "the phone",
      }),
    ).toMatchObject({
      state: "done_by_person",
      words: "Answered by Grace Obi · waiting for the phone",
      kind: "pending",
    });
  });

  it("gives every held reason one sentence and one next step", () => {
    const why = (outcome: "failed" | "abstained", code: ReasonCode) =>
      receiptWords(closed(outcome, code), { where: "QuickBooks" });
    expect(why("abstained", "fact_missing").why).toBe("A fact it needs is missing.");
    expect(why("abstained", "fact_stale").why).toBe("A fact it needs is out of date.");
    expect(why("abstained", "fact_conflict").why).toBe("Two records disagree.");
    expect(why("abstained", "citation_unverifiable").why).toBe("The source could not be checked.");
    expect(why("abstained", "ceiling_reached").why).toBe("It reached the limit you set.");
    expect(why("abstained", "provider_unavailable")).toMatchObject({
      why: "Its service is not answering.",
      next: "Do it yourself.",
    });
    expect(why("abstained", "no_qualified_route")).toMatchObject({
      why: "It is not cleared to do this step yet.",
      next: "Do it yourself.",
    });
    expect(why("abstained", "injection_suspected")).toMatchObject({
      why: "The message looked like an attempt to trick it.",
      next: "A person reads the message.",
    });
    expect(why("abstained", "person_requested").why).toBe("The customer asked for a person.");
    for (const code of [
      "action_unregistered",
      "policy_missing",
      "out_of_scope",
      "no_progress",
    ] as const)
      expect(why("abstained", code)).toMatchObject({
        why: "This is not something it may do.",
        next: "A person decides.",
      });
    expect(why("abstained", "safety_event")).toMatchObject({
      why: "A work stop or safety report stopped it.",
      next: "A person takes over.",
    });
    expect(why("abstained", "emergency").why).toBe(
      "An emergency: it paged a person and does nothing else.",
    );
    expect(why("failed", "provider_rejected").why).toBe("QuickBooks turned the step down.");
    expect(why("failed", "readback_mismatch").why).toBe(
      "What QuickBooks shows does not match what was sent.",
    );
    expect(why("failed", "approval_expired").next).toBe("Approve it again.");
    for (const code of [
      "policy_denied",
      "tool_refused",
      "provider_rejected",
      "readback_mismatch",
      "approval_expired",
    ] as const) {
      const words = why("failed", code);
      expect(words.state, code).toBe("held");
      expect(words.why, code).toMatch(/^[A-Z].*\.$/);
      expect(words.next, code).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("who decides", () => {
  it("names the person, or the Owner role, and never a job title (IRW-R8d rule 7)", () => {
    expect(deciderWords("owner", "Dana Whitford")).toEqual({
      waiting: "Waiting on Dana Whitford",
      decides: "Dana Whitford, Owner",
    });
    expect(deciderWords("owner")).toEqual({ waiting: "Waiting on the owner", decides: "Owner" });
    expect(deciderWords("accounting")).toEqual({
      waiting: "Waiting on a person",
      decides: "Nobody yet",
    });
    expect(deciderWords("field")).toEqual({
      waiting: "Waiting on a person",
      decides: "Nobody yet",
    });
    expect(deciderWords("accounting", "Priya Shah")).toEqual({
      waiting: "Waiting on Priya Shah",
      decides: "Priya Shah",
    });
    expect(deciderWords("night_shift")).toEqual({
      waiting: "Waiting on a person",
      decides: "Nobody yet",
    });
    expect(deciderWords("night_shift", "Sam Reyes")).toEqual({
      waiting: "Waiting on Sam Reyes",
      decides: "Sam Reyes",
    });
  });
});

describe("delegation words", () => {
  const action = (overrides: Partial<CatalogAction>): CatalogAction => ({
    autonomy: "A3",
    human_only: false,
    protective: false,
    delegable: true,
    default_delegation: "asks_first",
    ...overrides,
  });

  it("follows the contract fields, then the owner's setting", () => {
    expect(delegationOf(action({ autonomy: "H", human_only: true, delegable: false }))).toBe(
      "people_only",
    );
    expect(delegationOf(action({ protective: true, delegable: false }), { paused: true })).toBe(
      "always_on",
    );
    expect(delegationOf(action({}), { paused: true })).toBe("asks_first");
    expect(delegationOf(action({ autonomy: "A0", delegable: false }))).toBe("reads");
    expect(delegationOf(action({ autonomy: "A1", delegable: false }))).toBe("prepares");
    expect(delegationOf(action({ delegable: false }))).toBe("always_asks_first");
    expect(delegationOf(action({ delegable: false }), { setting: "within_limits" })).toBe(
      "always_asks_first",
    );
    expect(delegationOf(action({}))).toBe("asks_first");
    expect(delegationOf(action({}), { setting: "within_limits" })).toBe("within_limits");
    expect(delegationOf(action({ default_delegation: "off_until_enabled" }))).toBe(
      "off_until_enabled",
    );
  });

  it("follows the contract when a specialist is paused: every non-protective action asks first", () => {
    const paused = { paused: true };
    // AI-TEAM-CONTRACT.md: "Pausing sets every non-protective action of the specialist to asks
    // first and stops its drafting." Watching changes nothing and goes on; protection goes on.
    expect(delegationOf(action({ autonomy: "A0", delegable: false }), paused)).toBe("reads");
    expect(delegationOf(action({ autonomy: "A1", delegable: false }), paused)).toBe("asks_first");
    expect(delegationOf(action({ default_delegation: "within_limits" }), paused)).toBe(
      "asks_first",
    );
    expect(delegationOf(action({ autonomy: "A2" }), { ...paused, setting: "within_limits" })).toBe(
      "asks_first",
    );
    expect(delegationOf(action({ default_delegation: "off_until_enabled" }), paused)).toBe(
      "asks_first",
    );
    expect(delegationOf(action({ delegable: false }), paused)).toBe("always_asks_first");
    expect(delegationOf(action({ protective: true, delegable: false }), paused)).toBe("always_on");
    expect(
      delegationOf(action({ autonomy: "H", human_only: true, delegable: false }), paused),
    ).toBe("people_only");
    // "Paused" names the specialist-level control only, never one action.
    expect(specialistDelegation({ paused: true })).toEqual({
      setting: "paused",
      words: "Paused",
    });
    expect(specialistDelegation({ paused: false })).toBeNull();
  });

  it("uses the words of AI-PRIMITIVES and never a class code", () => {
    expect(Object.values(DELEGATION).map((entry) => entry.words)).toEqual([
      "Reads and watches",
      "Prepares",
      "Acts within your limits",
      "Asks first",
      "People only",
      "Paused",
      "Off until you turn it on",
      "Always on: protects you",
      "Always asks first",
    ]);
    for (const { words } of Object.values(DELEGATION))
      expect(words).not.toMatch(/\bA[0-3]\b|\bH\b/);
  });
});

describe("receipt fields", () => {
  it("lists every field of the receipt type", () => {
    expectTypeOf<(typeof RECEIPT_FIELDS)[number]>().toEqualTypeOf<keyof ContractReceipt>();
    expect(new Set(RECEIPT_FIELDS).size).toBe(14);
  });
});

describe("money", () => {
  it("keeps every minor digit of the currency and never rounds through a float", () => {
    expect(formatMoney({ minor: 986000, currency: "CAD" })).toBe("CAD\u00a09,860.00");
    expect(formatMoney({ minor: 5, currency: "CAD" })).toBe("CAD\u00a00.05");
    expect(formatMoney({ minor: 0, currency: "CAD" })).toBe("CAD\u00a00.00");
    expect(formatMoney({ minor: -180360, currency: "CAD" })).toBe("-CAD\u00a01,803.60");
    expect(formatMoney({ minor: 1500, currency: "JPY" })).toBe("JPY\u00a01,500");
    expect(formatMoney({ minor: 1234, currency: "KWD" })).toBe("KWD\u00a01.234");
    expect(formatMoney({ minor: 123456789012345, currency: "CAD" })).toBe(
      "CAD\u00a01,234,567,890,123.45",
    );
  });

  it("says Not known yet for an amount it cannot show, and never throws while rendering", () => {
    expect(formatMoney({ minor: 12.5, currency: "CAD" })).toBe("Not known yet");
    expect(formatMoney({ minor: Number.NaN, currency: "CAD" })).toBe("Not known yet");
    expect(formatMoney({ minor: 2 ** 60, currency: "CAD" })).toBe("Not known yet");
    expect(formatMoney({ minor: 500, currency: "dollars" })).toBe("Not known yet");
  });
});

describe("times", () => {
  // An instant counted from the epoch: 08:00 UTC on a Friday. The tests read times in UTC, which
  // has no daylight saving, so no expectation depends on the zone rules a machine carries.
  const now = 1_800_000_000_000;
  const hours = (count: number) => now + count * 3_600_000;
  const utc = { now, timeZone: "UTC" };

  it("says a day word and the 24-hour time, never a calendar date or a zone abbreviation", () => {
    expect(dayTime(now, utc).text).toBe("Today 08:00");
    // Nine hours earlier is the evening before.
    expect(dayTime(hours(-9), utc).text).toBe("Yesterday 23:00");
    expect(dayTime(hours(24), utc).text).toBe("Tomorrow 08:00");
    expect(dayTime(hours(-72), utc).text).toBe("Tue 08:00");
    expect(dayTime(hours(-9 * 24), utc).text).toBe("9 days ago 08:00");
    expect(dayTime(hours(9 * 24), utc).text).toBe("In 9 days 08:00");
    // IRW-R8d rule 9: Alberta time never prints MST, MDT or any other abbreviation.
    expect(dayTime(now, { now }).text).not.toMatch(/\b(MST|MDT|UTC|GMT)\b/);
    expect(dayTime(now, utc).at).toBe(new Date(now).toISOString());
    expect(dayTime(now, utc).text).not.toMatch(/\d{4}|\d+\/\d+/);
  });

  it("counts days in the zone it is given, and reads the company's zone when given none", () => {
    // 23:00 UTC is yesterday in UTC but still today ten hours behind it. Etc/GMT+10 is a fixed
    // offset with no daylight saving; the expected time is read through Intl, never written out.
    const zone = "Etc/GMT+10";
    const time = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(hours(-9));
    expect(dayTime(hours(-9), { now, timeZone: zone }).text).toBe(`Today ${time}`);
    expect(DEFAULT_TIME_ZONE).toBe("America/Edmonton");
    expect(dayTime(now, { now }).text).toBe(
      dayTime(now, { now, timeZone: DEFAULT_TIME_ZONE }).text,
    );
  });

  it("says Not known yet for a time it cannot read, and never throws while rendering", () => {
    expect(dayTime("not a time", utc)).toEqual({ text: "Not known yet" });
    expect(dayTime(Number.NaN, utc)).toEqual({ text: "Not known yet" });
    // An unknown zone falls back to the company's zone rather than failing the screen.
    expect(dayTime(now, { now, timeZone: "Not/AZone" }).text).toBe(
      dayTime(now, { now, timeZone: DEFAULT_TIME_ZONE }).text,
    );
  });
});
