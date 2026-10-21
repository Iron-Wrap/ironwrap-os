import { describe, expect, it } from "vitest";

import type { AccessConflict } from "./admin-contracts";
import {
  ALREADY_ON_TEAM_NEXT,
  alreadyOnTeam,
  cannotApplyLine,
  saveAfterAccessBack,
  changedElsewhere,
  conflictLine,
  firstName,
  giveBack,
  giveBackThenSave,
  whatIsDifferentNow,
  whatTheChangeDoes,
  whenChanged,
} from "./team-access-copy";

// Local wall-clock times, so the weekday and hh:mm hold in any time zone the suite runs in.
const NOW = new Date(2026, 9, 20, 15, 30).getTime(); // Tue 15:30
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function conflict(
  changedBy: AccessConflict["changed_by"],
  changedAt: string | null = ago(5_000),
): AccessConflict {
  return {
    user_id: "appu_grace",
    access_version: 2,
    changed_at: changedAt,
    changed_by: changedBy,
    change: { before: { role: "ops", active: true }, after: { role: "sales", active: true } },
  };
}

const you = { user_id: "appu_ada", display_name: "Ada Owner", is_self_actor: true };
const priya = { user_id: "appu_priya", display_name: "Priya Nand", is_self_actor: false };
const nameless = { user_id: "appu_gone", display_name: null, is_self_actor: false };

describe("when the other change was made", () => {
  it("is a moment ago under a minute, and when the time is unknown or ahead of this clock", () => {
    expect(whenChanged(ago(0), NOW)).toBe("a moment ago");
    expect(whenChanged(ago(MINUTE - 1), NOW)).toBe("a moment ago");
    expect(whenChanged(ago(-5 * MINUTE), NOW)).toBe("a moment ago");
    expect(whenChanged(null, NOW)).toBe("a moment ago");
    expect(whenChanged("not a time", NOW)).toBe("a moment ago");
  });

  it("counts whole minutes under an hour", () => {
    expect(whenChanged(ago(MINUTE), NOW)).toBe("1 min ago");
    expect(whenChanged(ago(5 * MINUTE + 59_999), NOW)).toBe("5 min ago");
    expect(whenChanged(ago(HOUR - 1), NOW)).toBe("59 min ago");
  });

  it("names the weekday and the 24-hour local time under a week, never a date", () => {
    expect(whenChanged(ago(HOUR), NOW)).toBe("on Tue at 14:30");
    expect(whenChanged(new Date(2026, 9, 19, 0, 5).toISOString(), NOW)).toBe("on Mon at 00:05");
    expect(whenChanged(new Date(2026, 9, 17, 21, 45).toISOString(), NOW)).toBe("on Sat at 21:45");
    expect(whenChanged(ago(7 * DAY - 1), NOW)).toBe("on Tue at 15:30");
  });

  it("says over a week ago from seven days on, with no weekday and no date", () => {
    expect(whenChanged(ago(7 * DAY), NOW)).toBe("over a week ago");
    expect(whenChanged(ago(40 * DAY), NOW)).toBe("over a week ago");
  });
});

describe("the derived access-conflict phrases", () => {
  it("say what is different now, in plain words, after the conflict line's colon", () => {
    const cases = [
      [
        { role: "ops", active: true },
        { role: "sales", active: true },
        "their role is now Sales, not Operations",
      ],
      [{ role: "ops", active: true }, { role: "ops", active: false }, "they no longer have access"],
      [
        { role: "ops", active: true },
        { role: "sales", active: false },
        "they no longer have access",
      ],
      [{ role: "ops", active: false }, { role: "ops", active: true }, "they have access again"],
      [
        { role: "ops", active: false },
        { role: "sales", active: true },
        "they have access again and their role is now Sales, not Operations",
      ],
      [
        { role: "ops", active: false },
        { role: "field", active: false },
        "their role is now Crew, not Operations",
      ],
      [
        { role: "ops", active: true },
        { role: "ops", active: true },
        "nothing you can see here changed",
      ],
    ] as const;
    for (const [before, after, phrase] of cases) {
      expect(whatIsDifferentNow(before, after)).toBe(phrase);
    }
  });

  it("say what a held role change does, opening on the first name or inside a sentence", () => {
    expect(whatTheChangeDoes("Grace’s", "sales", "production")).toBe(
      "Grace’s role changes from Sales to Production",
    );
    expect(whatTheChangeDoes("their", "sales", "production")).toBe(
      "their role changes from Sales to Production",
    );
    expect(firstName("Grace Obi")).toBe("Grace");
    expect(firstName("  Mei  ")).toBe("Mei");
  });

  it("name who made the other change and when; the viewer's own other change is somewhere else", () => {
    const seen = { role: "ops", active: true } as const;
    expect(conflictLine("Grace Obi", conflict(you), seen, NOW)).toBe(
      "You changed Grace Obi’s access somewhere else a moment ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(priya, ago(5 * MINUTE)), seen, NOW)).toBe(
      "Priya Nand changed Grace Obi’s access 5 min ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(nameless, ago(2 * HOUR)), seen, NOW)).toBe(
      "Grace Obi’s access was changed on Tue at 13:30: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(null, ago(9 * DAY)), seen, NOW)).toBe(
      "Grace Obi’s access was changed over a week ago: their role is now Sales, not Operations.",
    );
    expect(
      conflictLine(
        "Grace Obi",
        { ...conflict(null), change: { before: seen, after: { role: "ops", active: false } } },
        seen,
        NOW,
      ),
    ).toBe("Grace Obi’s access was changed a moment ago: they no longer have access.");
    expect(conflictLine("Grace Obi", null, seen, NOW)).toBe(
      "Grace Obi’s access was changed a moment ago.",
    );
    // Without the access before from the Worker, the line compares with what this page showed.
    expect(
      conflictLine(
        "Grace Obi",
        { ...conflict(you), change: { before: null, after: seen } },
        { role: "sales", active: true },
        NOW,
      ),
    ).toBe(
      "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
    );
  });

  it("say why a change cannot apply after a removal, and mark a value changed elsewhere", () => {
    expect(cannotApplyLine("Grace Obi", conflict(you), NOW)).toBe(
      "Your change cannot apply: you removed Grace Obi from the team somewhere else a moment ago.",
    );
    expect(cannotApplyLine("Grace Obi", conflict(priya, ago(3 * HOUR)), NOW)).toBe(
      "Your change cannot apply: Priya Nand removed Grace Obi from the team on Tue at 12:30.",
    );
    expect(cannotApplyLine("Grace Obi", null, NOW)).toBe(
      "Your change cannot apply: Grace Obi was removed from the team a moment ago.",
    );
    expect(changedElsewhere(conflict(you), NOW)).toBe("changed somewhere else a moment ago");
    expect(changedElsewhere(conflict(priya, ago(12 * MINUTE)), NOW)).toBe(
      "changed by Priya Nand 12 min ago",
    );
    expect(changedElsewhere(conflict(nameless), NOW)).toBe("changed a moment ago");
    expect(changedElsewhere(conflict(null, ago(3 * DAY)), NOW)).toBe("changed on Sat at 15:30");
  });

  it("say an address is already on the team in Track B's words", () => {
    expect(`${alreadyOnTeam("grace@freshco.example")} ${ALREADY_ON_TEAM_NEXT}`).toBe(
      "grace@freshco.example is already on your team, so nothing was added. To change their access, use “See access” on their row.",
    );
  });

  it("label frame 5's waiting Save by their access coming back, not by them signing in", () => {
    expect(saveAfterAccessBack("Grace")).toBe("Save Grace’s access · after their access is back");
  });

  it("give access back right away on frame 5, and ask for a crew phone only when Save leaves them Crew", () => {
    // Removing Tom unpaired his crew phone, but Save moves him off Crew: no phone to pair.
    expect(`Give Tom access back: ${giveBackThenSave("field", "production", true)}`).toBe(
      "Give Tom access back: it returns the access they had (Crew) right away. Then save to add your change: their role moves from Crew to Production. You don’t need to wait for them to sign in.",
    );
    // A crew phone a removal unpaired, and Save makes them Crew: the clause follows the save
    // sentence, because it belongs to the role after Save.
    expect(`Give Ray access back: ${giveBackThenSave("production", "field", true)}`).toBe(
      "Give Ray access back: it returns the access they had (Production) right away. Then save to add your change: their role moves from Production to Crew; a crew phone must then be paired again in Settings › Crew phones. You don’t need to wait for them to sign in.",
    );
    // No crew phone was unpaired: no clause, even when Save makes them Crew.
    expect(`Give Grace access back: ${giveBackThenSave("sales", "field", false)}`).toBe(
      "Give Grace access back: it returns the access they had (Sales) right away. Then save to add your change: their role moves from Sales to Crew. You don’t need to wait for them to sign in.",
    );
  });

  it("give access back with nothing held in the same words, asking for a crew phone only when Crew comes back", () => {
    // Crew restored, and the removal unpaired their crew phone.
    expect(`Give Tom access back: ${giveBack("field", true)}`).toBe(
      "Give Tom access back: it returns the access they had (Crew) right away; a crew phone must be paired again in Settings › Crew phones.",
    );
    // Another role restored: the unpaired phone belongs to a Crew role they do not get back.
    expect(`Give Grace access back: ${giveBack("sales", true)}`).toBe(
      "Give Grace access back: it returns the access they had (Sales) right away.",
    );
    // No crew phone was unpaired: no clause, even for Crew.
    expect(`Give Ray access back: ${giveBack("field", false)}`).toBe(
      "Give Ray access back: it returns the access they had (Crew) right away.",
    );
  });
});
