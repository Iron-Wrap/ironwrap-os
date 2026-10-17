import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CATALOG, CATALOG_VERSION, catalogAction, catalogSpecialist, toolName } from "../src/agents/catalog.ts";
import { CATALOG_JSON, CATALOG_SHA256 } from "../src/agents/contract-catalog.ts";
import { evaluateStep, type StepInput } from "../src/agents/policy.ts";
import { REGISTRY, type RegistryEntry } from "../src/agents/registry.ts";
import { ABSTAIN_REASON_CODES, RUN_OUTPUT_SCHEMA } from "../src/agents/run-output.ts";
import { canonicalJson } from "../src/agents/schema.ts";
// @ts-expect-error: a plain .mjs script without type declarations
import { extractCatalogJson, renderCatalogModule } from "../scripts/sync-agent-catalog.mjs";

const contract = readFileSync(new URL("../../docs/AI-TEAM-CONTRACT.md", import.meta.url), "utf8");

test("the Worker carries the contract catalog byte for byte, under the hash the playbooks pin", async () => {
  const json = extractCatalogJson(contract);
  assert.equal(CATALOG_JSON, json);
  assert.equal(readFileSync(new URL("../src/agents/contract-catalog.ts", import.meta.url), "utf8"), renderCatalogModule(json));
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))).toString("hex");
  assert.equal(CATALOG_SHA256, digest);
  assert.equal(CATALOG_VERSION, digest);
  assert.equal(CATALOG.schema, "ironwrap_ai_team_contract_v1");
});

test("the registry lists every contract action exactly once and nothing else", () => {
  const catalogIds = CATALOG.actions.map((action) => action.action_id).sort();
  assert.deepEqual(Object.keys(REGISTRY).sort(), catalogIds);
  assert.equal(new Set(catalogIds).size, catalogIds.length);
});

test("people-only actions are never registered and tool names map one to one", () => {
  for (const action of CATALOG.actions) {
    if (action.autonomy === "H" || action.human_only) assert.equal(REGISTRY[action.action_id], null, action.action_id);
    assert.ok(!action.action_id.includes("__"), action.action_id);
    assert.match(toolName(action.action_id), /^[A-Za-z0-9_-]{1,64}$/);
  }
  assert.equal(new Set(CATALOG.actions.map((action) => toolName(action.action_id))).size, CATALOG.actions.length);
});

test("the run output schema and reason codes match the agent host and the contract", async () => {
  const host = await import("../../agent-host/src/host/prompt.ts");
  assert.equal(canonicalJson(RUN_OUTPUT_SCHEMA), canonicalJson(host.RUN_OUTPUT_SCHEMA));
  assert.deepEqual([...ABSTAIN_REASON_CODES], CATALOG.receipt.reason_codes.abstained);
});

const SIGNAL_FACT = { fact_id: "signal/sig_1", version: 1, hash: "sha256:00", trust: "untrusted_text" as const, fresh_until: null };
const ANY_ARGS: RegistryEntry = {
  args: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } },
  binding: { kind: "record" },
  machinePermitProven: false,
};

function input(overrides: Partial<StepInput> = {}): StepInput {
  return {
    specialistId: "lead_concierge",
    specialistState: "active",
    actionId: "fact.explain",
    args: { object: null, explanation: "The inquiry asks for a metal re-roof." },
    citations: [{ fact_id: "signal/sig_1", version: 1 }],
    snapshot: new Map([[SIGNAL_FACT.fact_id, SIGNAL_FACT]]),
    currentVersions: new Map([["signal/sig_1", 1]]),
    delegation: null,
    stepsOnRun: 0,
    runStartedAt: 1_000_000,
    now: 1_000_000,
    handoff: null,
    ...overrides,
  };
}

const registry = (entries: Record<string, RegistryEntry>) => (id: string) => entries[id] ?? REGISTRY[id] ?? null;

test("a cited read is recorded as done with no permit", () => {
  const decision = evaluateStep(input());
  assert.equal(decision.result, "allow");
  assert.equal(decision.outcome, "succeeded");
  assert.equal(decision.permit_kind, "none");
  assert.deepEqual(decision.checks.map((check) => check.check), ["budget", "scope", "schema", "cited", "fresh"]);
});

test("a draft is recorded as proposed output", () => {
  const decision = evaluateStep(input({ actionId: "report.compose", args: { note: "x" }, specialistId: "orchestrator", registry: registry({ "report.compose": ANY_ARGS }) }));
  assert.equal(decision.outcome, "succeeded");
  assert.equal(decision.permit_kind, "draft");
});

test("unregistered actions, unknown fields and missing citations abstain; scope and people-only fail", () => {
  const cases: Array<[Partial<StepInput>, string, string]> = [
    [{ actionId: "roof.teleport" }, "abstained", "action_unregistered"],
    [{ args: { object: null, explanation: "x", send_now: true } }, "abstained", "action_unregistered"],
    [{ args: { object: null } }, "abstained", "action_unregistered"],
    [{ actionId: "quote.commit_revision", specialistId: "estimator", args: {} }, "abstained", "policy_missing"],
    [{ citations: [] }, "abstained", "citation_unverifiable"],
    [{ citations: [{ fact_id: "lead/L-1", version: 3 }] }, "abstained", "citation_unverifiable"],
    [{ citations: [{ fact_id: "signal/sig_1", version: 2 }] }, "abstained", "citation_unverifiable"],
    [{ currentVersions: new Map([["signal/sig_1", 2]]) }, "abstained", "fact_stale"],
    [{ currentVersions: new Map() }, "abstained", "citation_unverifiable"],
    [{ snapshot: new Map([["signal/sig_1", { ...SIGNAL_FACT, fresh_until: "1970-01-01T00:00:00Z" }]]) }, "abstained", "fact_stale"],
    [{ actionId: "dead_letter.replay" }, "failed", "policy_denied"],
    [{ actionId: "delegation.set", specialistId: "orchestrator" }, "failed", "policy_denied"],
    [{ stepsOnRun: 12 }, "abstained", "ceiling_reached"],
    [{ now: 1_000_000 + 10 * 60_000 + 1 }, "abstained", "ceiling_reached"],
  ];
  for (const [overrides, outcome, reason] of cases) {
    const decision = evaluateStep(input(overrides));
    assert.equal(decision.result, "deny", JSON.stringify(overrides));
    assert.equal(decision.outcome, outcome, JSON.stringify(overrides));
    assert.deepEqual(decision.reason_codes, [reason], JSON.stringify(overrides));
    // An abstention names who takes it over; a refusal does not.
    assert.equal(decision.reviewer_role === null, outcome === "failed", JSON.stringify(overrides));
  }
});

test("protective steps never ask first, even while the specialist is paused", () => {
  const escalate = {
    actionId: "exception.escalate",
    args: { reason_code: "fact_missing", object: null, summary: "No address on the inquiry.", urgency: "today" },
  };
  for (const specialistState of ["active", "paused", "held"] as const) {
    const decision = evaluateStep(input({ ...escalate, specialistState }));
    assert.equal(decision.result, "allow");
    assert.equal(decision.permit_kind, "within_limits");
    assert.equal(decision.outcome, null);
    // The action names no reviewer, so the escalation goes to the specialist's reviewer role.
    assert.equal(decision.reviewer_role, catalogSpecialist("lead_concierge")?.reviewer_role);
  }
});

test("within limits needs a proven machine path; until then, and while paused, the step asks first", () => {
  const note = { actionId: "note.add", args: { object: { aggregate: "lead", id: "L-1", version: 1 }, text: "Prefers calls after 5." } };
  assert.equal(evaluateStep(input(note)).permit_kind, "asks_first");
  const proven = registry({ "note.add": { ...(REGISTRY["note.add"] as RegistryEntry), machinePermitProven: true } });
  const within = evaluateStep(input({ ...note, registry: proven }));
  assert.equal(within.permit_kind, "within_limits");
  assert.equal(within.result, "allow");
  const paused = evaluateStep(input({ ...note, registry: proven, specialistState: "paused" }));
  assert.equal(paused.permit_kind, "asks_first");
  assert.equal(paused.result, "needs_approval");
  assert.equal(paused.outcome, null);
});

test("a non-delegable action asks first whatever the owner set, and off-until-enabled does nothing", () => {
  const storm = evaluateStep(
    input({
      actionId: "storm_mode.propose",
      specialistId: "market_analyst",
      args: { note: "x" },
      registry: registry({ "storm_mode.propose": { ...ANY_ARGS, machinePermitProven: true } }),
      delegation: { delegation_id: "dlg_1", setting: "within_limits" },
    }),
  );
  assert.equal(storm.permit_kind, "asks_first");
  assert.equal(storm.reviewer_role, "owner");
  const live = evaluateStep(input({ actionId: "conversation.answer_live", args: { note: "x" }, registry: registry({ "conversation.answer_live": ANY_ARGS }) }));
  assert.equal(live.outcome, "failed");
  assert.deepEqual(live.reason_codes, ["policy_denied"]);
});

test("handoffs stop at the depth and repeat limits", () => {
  const handoff = {
    actionId: "handoff.create",
    args: { to_specialist_id: "estimator", object: { aggregate: "lead", id: "L-1", version: 1 }, reason: "Needs a price range.", expected_action_id: "estimate.prepare" },
  };
  const expected = catalogAction("estimate.prepare") ? "estimate.prepare" : CATALOG.actions[0].action_id;
  const args = { ...handoff.args, expected_action_id: expected };
  assert.equal(evaluateStep(input({ ...handoff, args, handoff: { depth: 1, samePair: 0 } })).outcome, "succeeded");
  assert.equal(evaluateStep(input({ ...handoff, args, handoff: { depth: 4, samePair: 0 } })).outcome, "succeeded");
  assert.deepEqual(evaluateStep(input({ ...handoff, args, handoff: { depth: 5, samePair: 0 } })).reason_codes, ["ceiling_reached"]);
  assert.deepEqual(evaluateStep(input({ ...handoff, args, handoff: { depth: 1, samePair: 2 } })).reason_codes, ["ceiling_reached"]);
});


test("the followup contract keeps closed machine reasons, auditor protection and protective revoke", () => {
  assert.equal(CATALOG.actions.length, 155);
  assert.equal(CATALOG.watches.length, 114);
  assert.equal(CATALOG_VERSION, "4e47c00eb3f9076efdf1fcd1d9085d715757d4fe9e4f64902e11d5b08d99fa68");
  assert.deepEqual(catalogAction("specialist.hold")?.never_targets, ["independent_auditor"]);
  assert.equal(catalogAction("portal_link.revoke")?.protective, true);
  assert.equal(catalogAction("portal_link.revoke")?.side_effect_class, "internal_reversible");
  assert.equal(catalogAction("portal_link.revoke")?.delegable, false);
  const reasonEntry: RegistryEntry = {
    ...ANY_ARGS,
    args: { type: "object", additionalProperties: false, required: ["reason_code"], properties: { reason_code: { type: "string" } } },
  };
  for (const reason_code of ["scam", "data_request", "invented_reason"]) {
    const decision = evaluateStep(input({ actionId: "inbound.quarantine", args: { reason_code }, registry: registry({ "inbound.quarantine": reasonEntry }) }));
    assert.deepEqual(decision.reason_codes, ["action_unregistered"]);
  }
  assert.equal(evaluateStep(input({ actionId: "inbound.quarantine", args: { reason_code: "privacy_sensitive" }, registry: registry({ "inbound.quarantine": reasonEntry }) })).result, "allow");
  const holdEntry: RegistryEntry = {
    ...ANY_ARGS,
    args: { type: "object", additionalProperties: false, required: ["specialist_id"], properties: { specialist_id: { type: "string" } } },
  };
  assert.deepEqual(evaluateStep(input({ specialistId: "independent_auditor", actionId: "specialist.hold", args: { specialist_id: "independent_auditor" }, registry: registry({ "specialist.hold": holdEntry }) })).reason_codes, ["policy_denied"]);
  // Contract metadata alone cannot stand in for an implemented protective effect.
  assert.deepEqual(evaluateStep(input({ specialistId: "proposal_contract", actionId: "portal_link.revoke", args: {} })).reason_codes, ["policy_missing"]);
});
