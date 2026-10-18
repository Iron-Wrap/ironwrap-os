import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CATALOG } from "../src/agents/catalog.ts";
import { receiptOf } from "../src/agents/receipts.ts";
import type { StepRow } from "../src/agents/store.ts";

const ACTION = "invoice.commit_intent";

const step = (overrides: Partial<StepRow>): StepRow => ({
  step_id: "stp_synthetic_0001", run_id: "run_synthetic_0001", step_seq: 1, step_key: "k".repeat(64),
  specialist_id: "billing_reconciliation", action_id: ACTION, autonomy: "A3",
  args_json: "{}", args_sha256: "a".repeat(64), sources_json: "[]",
  policy_json: JSON.stringify({ policy_id: "p", version: "1", result: "needs_approval", checks: [], reason_codes: ["fact_conflict"] }),
  permit_json: "{}", tool_json: null, readback_json: null, outcome: null, reason_code: null,
  needs_reviewer_role: null, needs_person_id: null, needs_ask: null,
  undo_json: JSON.stringify({ mode: "none", action_id: null, available: false }),
  do_it_myself_json: JSON.stringify({ surface: null, context: null }),
  created_at: "2026-03-02T10:00:00.000Z", decided_at: null, version: 1, ...overrides,
});

/** Sets (or clears) the catalog action's plain name for one test and restores what it was. */
function withName(t: TestContext, name: string | undefined) {
  const action = CATALOG.actions.find((entry) => entry.action_id === ACTION);
  assert.ok(action);
  const had = Object.hasOwn(action, "name");
  const before = action.name;
  if (name === undefined) delete action.name;
  else action.name = name;
  t.after(() => {
    if (had) action.name = before;
    else delete action.name;
  });
}

const OUTCOMES: Array<[Partial<StepRow>, "did" | "doing", string]> = [
  [{ outcome: "succeeded" }, "did", "finished %."],
  [{ outcome: "abstained", reason_code: "fact_conflict" }, "did", "stopped before %."],
  [{ outcome: "failed", reason_code: "provider_unavailable" }, "did", "could not finish %."],
  [{ outcome: "unknown", reason_code: "readback_mismatch" }, "doing", "is checking whether % went through."],
  [{ needs_reviewer_role: "owner", reason_code: "fact_conflict" }, "doing", "is waiting on a person before %."],
];

test("receipt sentences name the specialist and the action in words, never a code or a reason", (t) => {
  withName(t, undefined);
  for (const [overrides, field, tail] of [...OUTCOMES, [{}, "doing", "is working on %."] as const]) {
    const receipt = receiptOf(step(overrides));
    assert.equal(receipt[field], `AI bookkeeper ${tail.replace("%", "this step")}`);
    assert.equal(receipt[field === "did" ? "doing" : "did"], null);
  }
  // The reason stays in the structured policy, and an unknown specialist is never shown by its id.
  assert.deepEqual(receiptOf(step({ outcome: "abstained" })).policy.reason_codes, ["fact_conflict"]);
  assert.equal(receiptOf(step({ specialist_id: "synthetic_unknown", outcome: "succeeded" })).did, "The AI team finished this step.");
});

test("with a plain action name the sentences use it", (t) => {
  withName(t, "committing the invoice");
  for (const [overrides, field, tail] of [...OUTCOMES, [{}, "doing", "is %."] as const])
    assert.equal(receiptOf(step(overrides))[field], `AI bookkeeper ${tail.replace("%", "committing the invoice")}`);
});

test("a blank action name falls back to this step", (t) => {
  withName(t, "  ");
  assert.equal(receiptOf(step({ outcome: "succeeded" })).did, "AI bookkeeper finished this step.");
});

test("no catalog action or reason code ever reaches a receipt sentence", () => {
  const codes = [...new Set(Object.values(CATALOG.receipt.reason_codes).flat())].filter((code) => code.includes("_"));
  assert.ok(codes.length > 0);
  for (const action of CATALOG.actions)
    for (const [overrides, field] of OUTCOMES)
      for (const code of codes) {
        const sentence = receiptOf(step({ ...overrides, action_id: action.action_id, specialist_id: action.owners[0], reason_code: code }))[field] ?? "";
        assert.ok(!sentence.includes(action.action_id) && !sentence.includes("_") && !sentence.includes(code.replaceAll("_", " ")), sentence);
      }
});
