import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REASON_CODES,
  RECEIPT_FIELDS,
  SPECIALISTS,
  delegationOf,
  receiptWords,
  type CatalogAction,
  type ReasonCode,
} from "../src/components/ai/words";

/**
 * The AI words of the app (src/components/ai/words.ts) against docs/AI-TEAM-CONTRACT.md, the one
 * source of the roster, the action catalog and the receipt schema. A contract change that the
 * words do not follow fails here before a screen shows a raw value.
 */
interface Contract {
  specialists: { specialist_id: string; display_name: string }[];
  actions: (CatalogAction & { action_id: string })[];
  receipt: {
    fields: string[];
    nested: Record<string, string[]>;
    reason_codes: Record<string, string[]>;
  };
}

/** The machine-readable block, found the way workers-bus/scripts/sync-agent-catalog.mjs finds it. */
function contract(): Contract {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const markdown = readFileSync(resolve(root, "docs/AI-TEAM-CONTRACT.md"), "utf8");
  const start = markdown.indexOf("<!-- ai-team-contract:start -->");
  const end = markdown.indexOf("<!-- ai-team-contract:end -->");
  if (start === -1 || end <= start) throw new Error("ai-team-contract markers not found");
  const json = markdown.slice(start, end).match(/```json\s*([\s\S]*?)\s*```/)?.[1];
  if (!json) throw new Error("ai-team-contract block has no JSON fence");
  return JSON.parse(json) as Contract;
}

const team = contract();

describe("AI words against the team contract", () => {
  it("names every specialist exactly as the contract does, in its order", () => {
    expect(Object.entries(SPECIALISTS).map(([id, { name }]) => [id, name])).toEqual(
      team.specialists.map((entry) => [entry.specialist_id, entry.display_name]),
    );
  });

  it("says AI in every specialist's name and gives each its own glyph; the face is the brand", () => {
    const entries = Object.entries(SPECIALISTS);
    for (const [id, { name, glyph }] of entries) {
      if (id === "orchestrator") {
        expect(name).toBe("IronWrap");
        expect(glyph).toBeNull();
        continue;
      }
      expect(name).toMatch(/^AI [a-z]+(?: [a-z]+)?$/);
      expect(glyph).toBeTruthy();
    }
    const glyphs = entries.map(([, { glyph }]) => glyph).filter(Boolean);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("lists the fourteen receipt fields of the contract", () => {
    expect([...RECEIPT_FIELDS]).toEqual(team.receipt.fields);
  });

  it("has words for every reason code the contract lists, and no other", () => {
    expect(REASON_CODES).toEqual(team.receipt.reason_codes);
    for (const [outcome, codes] of Object.entries(team.receipt.reason_codes)) {
      for (const code of codes) {
        const words = receiptWords(
          {
            outcome: outcome as "failed" | "unknown" | "abstained",
            needs_from_you: null,
            policy: {
              policy_id: "policy",
              version: "1",
              result: "allow",
              checks: [],
              reason_codes: [code as ReasonCode],
            },
          },
          { by: "Dana Whitford", where: "QuickBooks" },
        );
        expect(words.words, code).toMatch(/^[A-Z]/);
        if (words.state === "held") {
          // A reason of its own, never the fallback for an unmapped code.
          expect(words.why, code).not.toBe("It stopped before acting.");
          expect(words.next, code).toBeTruthy();
        }
        if (outcome === "abstained") expect(words.state, code).toBe("held");
        if (outcome === "unknown") expect(words.state, code).toBe("working");
      }
    }
  });

  it("puts every catalog action under the delegation words its fields call for", () => {
    const counts = new Map<string, number>();
    for (const action of team.actions) {
      const setting = delegationOf(action);
      counts.set(setting, (counts.get(setting) ?? 0) + 1);
      if (action.human_only) expect(setting, action.action_id).toBe("people_only");
      else if (action.protective) expect(setting, action.action_id).toBe("always_on");
      else if (action.autonomy === "A0") expect(setting, action.action_id).toBe("reads");
      else if (action.autonomy === "A1") expect(setting, action.action_id).toBe("prepares");
      else if (!action.delegable) expect(setting, action.action_id).toBe("always_asks_first");
      else expect(setting, action.action_id).toBe(action.default_delegation);
    }
    // Paused: every non-protective action asks first and drafting stops (Delegation, "Per
    // specialist"); watching, protection and people-only acts keep their words.
    for (const action of team.actions) {
      const paused = delegationOf(action, { paused: true });
      if (action.human_only) expect(paused, action.action_id).toBe("people_only");
      else if (action.protective) expect(paused, action.action_id).toBe("always_on");
      else if (action.autonomy === "A0") expect(paused, action.action_id).toBe("reads");
      else if (action.autonomy !== "A1" && !action.delegable)
        expect(paused, action.action_id).toBe("always_asks_first");
      else expect(paused, action.action_id).toBe("asks_first");
    }
    // Counts follow the contract, so a contract change never breaks this test; each kind exists.
    for (const setting of ["people_only", "always_on", "always_asks_first", "off_until_enabled"]) {
      expect(counts.get(setting), setting).toBeGreaterThan(0);
    }
  });
});
