import { describe, expect, it } from "vitest";

import type { AccessConflict } from "./admin-contracts";
import {
  cannotApplyLine,
  chosenElsewhere,
  conflictLine,
  firstName,
  whatIsDifferentNow,
  whatTheChangeDoes,
} from "./team-access-copy";

function conflict(changedBy: AccessConflict["changed_by"]): AccessConflict {
  return {
    user_id: "appu_grace",
    access_version: 2,
    changed_at: "2026-10-20T09:00:00.000Z",
    changed_by: changedBy,
    change: { before: { role: "ops", active: true }, after: { role: "sales", active: true } },
  };
}

const you = { user_id: "appu_ada", display_name: "Ada Owner", is_self_actor: true };
const priya = { user_id: "appu_priya", display_name: "Priya Nand", is_self_actor: false };
const nameless = { user_id: "appu_gone", display_name: null, is_self_actor: false };

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
        "their access is the same as what you see here",
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

  it("name who made the other change; the viewer's own other change is somewhere else", () => {
    const seen = { role: "ops", active: true } as const;
    expect(conflictLine("Grace Obi", conflict(you), seen)).toBe(
      "You changed Grace Obi’s access somewhere else a moment ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(priya), seen)).toBe(
      "Priya Nand changed Grace Obi’s access a moment ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(nameless), seen)).toBe(
      "Someone else changed Grace Obi’s access a moment ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", conflict(null), seen)).toBe(
      "Grace Obi’s access changed somewhere else a moment ago: their role is now Sales, not Operations.",
    );
    expect(conflictLine("Grace Obi", null, seen)).toBe(
      "Grace Obi’s access changed somewhere else a moment ago.",
    );
    // Without the access before from the Worker, the line compares with what this page showed.
    expect(
      conflictLine(
        "Grace Obi",
        { ...conflict(you), change: { before: null, after: seen } },
        {
          role: "sales",
          active: true,
        },
      ),
    ).toBe(
      "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
    );
  });

  it("say why a change cannot apply after a removal, and label a role chosen elsewhere", () => {
    expect(cannotApplyLine("Grace Obi", conflict(you))).toBe(
      "Your change cannot apply: you removed Grace Obi from the team somewhere else a moment ago.",
    );
    expect(cannotApplyLine("Grace Obi", conflict(priya))).toBe(
      "Your change cannot apply: Priya Nand removed Grace Obi from the team a moment ago.",
    );
    expect(cannotApplyLine("Grace Obi", null)).toBe(
      "Your change cannot apply: Grace Obi was removed from the team a moment ago.",
    );
    expect(chosenElsewhere(conflict(you))).toBe("Chosen somewhere else a moment ago");
    expect(chosenElsewhere(conflict(priya))).toBe("Chosen by Priya Nand a moment ago");
    expect(chosenElsewhere(null)).toBe("Chosen somewhere else a moment ago");
  });
});
