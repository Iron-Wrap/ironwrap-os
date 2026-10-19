import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CATALOG, CATALOG_VERSION, catalogAction, catalogSpecialist, toolName } from "../src/agents/catalog.ts";
import { CATALOG_JSON, CATALOG_SHA256 } from "../src/agents/contract-catalog.ts";
import { evaluateStep, type StepInput } from "../src/agents/policy.ts";
import { specialistState } from "../src/agents/control.ts";
import { REGISTRY, type RegistryEntry } from "../src/agents/registry.ts";
import { peopleOnlyFor, toolsFor } from "../src/agents/store.ts";
import { ABSTAIN_REASON_CODES, RUN_OUTPUT_SCHEMA } from "../src/agents/run-output.ts";
import { assertStrictSchema, canonicalJson, validate } from "../src/agents/schema.ts";
import { assertStrictSchema as hostStrict } from "../../agent-host/src/gateway/schema.ts";
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
    specialistState: { paused: false, held: false },
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
    args: {
      reason_code: "fact_missing",
      object: null,
      summary: "No address on the inquiry.",
      urgency: "today",
      route_to: "sales",
    },
  };
  for (const specialistState of [
    { paused: false, held: false },
    { paused: true, held: false },
    { paused: false, held: true },
    { paused: true, held: true },
  ]) {
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
  const within = evaluateStep(input({ ...note, registry: proven, withinCeiling: true }));
  assert.equal(within.permit_kind, "within_limits");
  assert.equal(within.result, "allow");
  const paused = evaluateStep(input({ ...note, registry: proven, specialistState: {paused:true,held:false} }));
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

/** A production manager's press on compliance's view, the request a competency record answers. */
const PRESS = {
  signal_ref: "signal/sig_1",
  kind: "owner_request",
  source: "request",
  actor: { type: "staff", role: "production", ref: "person:appu_production_1", authenticated: true },
  expected_action_id: "authority.record",
};

test("compliance proposes an internal competency record for a person's approval only", () => {
  const compliance = { specialistId: "compliance", requester: PRESS };
  const command = {
    operation: "record",
    authority_kind: "Worker Competency",
    subject_ref: "appu_synthetic_worker",
    scope_type: "Field",
    scope_ref: "field:synthetic",
    expected_head: null,
    record: {
      authority_scope: "synthetic field installation",
      roof_job: null,
      issuer_jurisdiction: "AB-CA",
      issuer_reference: "assessment:synthetic",
      source_version: "rubric:1",
      evidence_refs: [{ ref: "r2://authority/synthetic.pdf", sha256: "c".repeat(64) }],
      effective_from: "2026-10-01",
      expires_at: "2027-09-30",
    },
    reference: null,
    reason: null,
  };
  // Never delegable: an owner's within-limits setting still asks the production reviewer first.
  const proposed = evaluateStep(input({ ...compliance, actionId: "authority.record", args: command, delegation: { delegation_id: "dlg_1", setting: "within_limits" }, withinCeiling: true }));
  assert.equal(proposed.result, "needs_approval");
  assert.equal(proposed.permit_kind, "asks_first");
  assert.equal(proposed.reviewer_role, "production");
  // Only a press on compliance's view: the same command answering an ask, a field worker's press or
  // no person's request abstains before its arguments are read.
  for (const requester of [{ ...PRESS, source: "ask" }, { ...PRESS, actor: { ...PRESS.actor, type: "worker", role: "field" } }, { ...PRESS, expected_action_id: "authority.evaluate" }, null])
    assert.deepEqual(evaluateStep(input({ ...compliance, requester, actionId: "authority.record", args: command })).reason_codes, ["out_of_scope"], JSON.stringify(requester));
  // More reference text than the stored list holds would only fail after a person approved it.
  // Each reference is within its own 512-character limit; together they are not.
  const oversized = Array.from({ length: 40 }, (_, index) => ({ ref: `r2://authority/${String(index).padStart(485, "x")}`, sha256: "c".repeat(64) }));
  assert.ok(oversized.every((entry) => entry.ref.length <= 512) && canonicalJson(oversized).length > 20_000);
  for (const args of [
    { ...command, authority_kind: "Permit" },
    { ...command, record: { ...command.record, expires_at: "2026-01-01" } },
    { ...command, record: { ...command.record, evidence_refs: oversized } },
  ]) {
    assert.deepEqual(evaluateStep(input({ ...compliance, actionId: "authority.record", args })).reason_codes, ["action_unregistered"]);
  }
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
  assert.equal(CATALOG.actions.length, 162);
  assert.equal(CATALOG.watches.length, 115);
  assert.equal(CATALOG_VERSION, "a1c5e9f4f852f30e81ccada13df35976ffda80f14a2e2b281f4fdb2d37c3b852");
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


test("independent pause and hold flags compose before class shortcuts", () => {
  const a1 = CATALOG.actions.find((action) => action.autonomy === "A1" && action.owners.includes("lead_concierge"))!;
  assert.ok(a1);
  // This registered-arguments seam proves A1 class precedence, not an operational draft adapter.
  const draftRegistry = registry({ [a1.action_id]: ANY_ARGS });
  for (const paused of [false, true])
    for (const held of [false, true]) {
      const state = specialistState({ paused, held, revision: 0 });
    assert.deepEqual(state, { paused, held });
      const read = evaluateStep(input({ specialistState: state }));
      assert.equal(read.result, paused || held ? "needs_approval" : "allow", `read paused=${paused} held=${held}`);
      assert.equal(read.permit_kind, paused || held ? "asks_first" : "none");
      const draft = evaluateStep(
        input({
          specialistState: state,
          actionId: a1.action_id,
          args: { note: "Synthetic draft fixture" },
          registry: draftRegistry,
        }),
      );
      assert.equal(
        draft.result,
        paused ? "deny" : held ? "needs_approval" : "allow",
        `draft paused=${paused} held=${held}`,
      );
      assert.equal(draft.permit_kind, paused ? "none" : held ? "asks_first" : "draft");
      const off = evaluateStep(
        input({
          specialistState: state,
          actionId: "note.add",
          args: { object: { aggregate: "lead", id: "L-1", version: 1 }, text: "Synthetic revoked note" },
          delegation: { delegation_id: "synthetic-off", setting: "off" },
        }),
      );
      assert.equal(off.result, "deny");
      assert.equal(off.permit_kind, "none");
    }
});

// The follow-up registrations (output/track-a/POLICY-FOLLOWUP.md, agreed with Track D).

const ASK_REF = "signal/sig_ask_1";
const ASK_FACT = { fact_id: ASK_REF, version: 1, hash: "sha256:01", trust: "owned" as const, fresh_until: null };
const STAFF = { type: "staff", role: "ops", ref: "person:appu_ops_1", authenticated: true };
/** The staff member's ask a run answers, as store.ts `runRequest` hands it to policy. */
const STAFF_ASK = { signal_ref: ASK_REF, kind: "owner_request", source: "ask", actor: STAFF };
const PAIRING = {
  person_ref: "person:appu_field_1",
  change: "pair_device",
  target_role: null,
  device_ref: null,
  expected_access_version: 1,
  request_ref: ASK_REF,
  reason: "Synthetic: pair the new crew phone.",
};
/** A step that cites the ask (and the signal fact every run has), with both facts current. */
function citing(overrides: Partial<StepInput> = {}): StepInput {
  return input({
    citations: [{ fact_id: ASK_REF, version: 1 }],
    snapshot: new Map([[SIGNAL_FACT.fact_id, SIGNAL_FACT], [ASK_REF, ASK_FACT]]),
    currentVersions: new Map([["signal/sig_1", 1], [ASK_REF, 1]]),
    ...overrides,
  });
}
const prepare = (args: unknown, overrides: Partial<StepInput> = {}) =>
  evaluateStep(citing({ specialistId: "compliance", actionId: "access.prepare_change", args, requester: STAFF_ASK, ...overrides }));
/** Whether the step got past the registered-arguments check. */
const schemaPassed = (decision: ReturnType<typeof evaluateStep>) => decision.checks.some((check) => check.check === "schema" && check.passed);

test("the access change schema takes the agreed shape: a role only with a role change, a device only with a device change", () => {
  const accepted = [
    PAIRING,
    { ...PAIRING, change: "change_role", target_role: "production" },
    { ...PAIRING, change: "replace_device", device_ref: "device:PH-0874", expected_access_version: 3 },
    { ...PAIRING, change: "revoke_device", device_ref: "device:PH-0874" },
  ];
  for (const args of accepted) {
    const decision = prepare(args);
    assert.deepEqual([decision.result, decision.outcome, decision.permit_kind], ["allow", "succeeded", "draft"], JSON.stringify(args));
  }
  const refused = [
    { ...PAIRING, change: "change_role" },
    { ...PAIRING, change: "change_role", target_role: "owner" },
    { ...PAIRING, target_role: "sales" },
    { ...PAIRING, device_ref: "device:PH-0874" },
    { ...PAIRING, change: "revoke_device" },
    { ...PAIRING, change: "change_role", target_role: "sales", device_ref: "device:PH-0874" },
    { ...PAIRING, change: "add_person" },
    { ...PAIRING, person_ref: "W-338" },
    { ...PAIRING, change: "replace_device", device_ref: "PH-0874" },
    { ...PAIRING, expected_access_version: 0 },
    { ...PAIRING, reason: "" },
    { ...PAIRING, approved_by: "owner" },
    Object.fromEntries(Object.entries(PAIRING).filter(([key]) => key !== "device_ref")),
  ];
  for (const args of refused) {
    const decision = prepare(args);
    assert.deepEqual([decision.outcome, decision.reason_codes, schemaPassed(decision)], ["abstained", ["action_unregistered"], false], JSON.stringify(args));
  }
  // A request_ref that is no signal fact id is refused before the arguments are read.
  assert.deepEqual(prepare({ ...PAIRING, request_ref: "sig_ask_1" }).reason_codes, ["out_of_scope"]);
});

test("an access change answers only the person's own ask or request, or the one at the root of its handoff chain", () => {
  const requester = (decision: ReturnType<typeof evaluateStep>) => decision.checks.find((check) => check.check === "requester");
  const passes = (decision: ReturnType<typeof evaluateStep>, label: string) =>
    assert.deepEqual([decision.outcome, requester(decision)], ["succeeded", { check: "requester", passed: true }], label);
  const stops = (decision: ReturnType<typeof evaluateStep>, label: string) =>
    assert.deepEqual([decision.outcome, decision.reason_codes, requester(decision)], ["abstained", ["out_of_scope"], { check: "requester", passed: false }], label);
  // The face answering a staff member's own ask, and the owner's; a press on a view's action too.
  passes(prepare(PAIRING, { specialistId: "orchestrator" }), "direct ask");
  passes(prepare(PAIRING, { requester: { ...STAFF_ASK, actor: { ...STAFF, type: "owner", role: "owner" } } }), "owner");
  passes(prepare(PAIRING, { requester: { ...STAFF_ASK, source: "request" } }), "request");
  // A handoff run gets the root of its chain from the store, so policy sees the same ask.
  passes(prepare(PAIRING), "handoff from an ask");
  // A handoff from a non-person event: the root is no owner_request and has no actor.
  stops(prepare({ ...PAIRING, request_ref: "signal/sig_event" }, { requester: { signal_ref: "signal/sig_event", kind: "event", source: "web_form", actor: null } }), "handoff from an event");
  // Another chain's ask, cited and named: not the request this run answers.
  const other = { fact_id: "signal/sig_ask_2", version: 1 };
  stops(
    prepare(
      { ...PAIRING, request_ref: other.fact_id },
      {
        citations: [{ fact_id: ASK_REF, version: 1 }, other],
        snapshot: new Map([[ASK_REF, ASK_FACT], [other.fact_id, { ...ASK_FACT, fact_id: other.fact_id }]]),
        currentVersions: new Map([[ASK_REF, 1], [other.fact_id, 1]]),
      },
    ),
    "a cited ask from another chain",
  );
  // A field worker's ask, an unauthenticated actor, another owner_request source, no chain root.
  stops(prepare(PAIRING, { requester: { ...STAFF_ASK, actor: { ...STAFF, type: "worker", role: "field" } } }), "worker");
  stops(prepare(PAIRING, { requester: { ...STAFF_ASK, actor: { ...STAFF, authenticated: false } } }), "unauthenticated");
  stops(prepare(PAIRING, { requester: { ...STAFF_ASK, source: "owner_console" } }), "another source");
  stops(prepare(PAIRING, { requester: { ...STAFF_ASK, kind: "event" } }), "not an owner_request");
  stops(prepare(PAIRING, { requester: null }), "no root");
  // Named but not cited.
  stops(prepare(PAIRING, { citations: [{ fact_id: "signal/sig_1", version: 1 }] }), "not cited");
});

test("settings, import retry, lead confirmation and authority reads take exactly the agreed arguments", () => {
  const decide = (specialistId: string, actionId: string, args: unknown) => evaluateStep(citing({ specialistId, actionId, args }));
  const cases: Array<[string, string, unknown, boolean]> = [
    // settings.propose_change: flat objects with the same 1 to 20 keys.
    ["orchestrator", "settings.propose_change", { settings_id: "settings:business_details", before: { hours_saturday: "09:00-13:00" }, after: { hours_saturday: "closed" } }, true],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:notifications-P-1", before: { new_inquiry_push: "at any time", quiet: false, limit: 3, note: null }, after: { new_inquiry_push: "until 20:00", quiet: true, limit: 5, note: "Synthetic" } }, true],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`k${n}`, n])), after: Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`k${n}`, n + 1])) }, true],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: {}, after: {} }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`k${n}`, n])), after: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`k${n}`, n])) }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { hours_saturday: "09:00-13:00" }, after: { hours_sunday: "closed" } }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { a: "1" }, after: { a: "1", b: "2" } }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { hours: { saturday: "09:00" } }, after: { hours: { saturday: "closed" } } }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { "Hours Saturday": "09:00" }, after: { "Hours Saturday": "closed" } }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { a: "x".repeat(601) }, after: { a: "y" } }, false],
    ["orchestrator", "settings.propose_change", { settings_id: "settings:a", before: { a: "1" }, after: { a: "2" }, apply: true }, false],
    // import.retry_failed: 1 to 100 unique source keys.
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-0412", source_keys: ["JN-C-20417", "JN-C-20431", "JN-C-20488"] }, true],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1", source_keys: Array.from({ length: 100 }, (_, n) => `JN-${n}`) }, true],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1", source_keys: [] }, false],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1", source_keys: Array.from({ length: 101 }, (_, n) => `JN-${n}`) }, false],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1", source_keys: ["JN-1", "JN-1"] }, false],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1", source_keys: [""] }, false],
    ["orchestrator", "import.retry_failed", { import_run_id: "import_run:IMP-1" }, false],
    // lead_fact.confirm: at least one of service, scope, address, timing, and no other key.
    ["lead_concierge", "lead_fact.confirm", { lead_id: "L-5401", proposal_id: "LP-5401", fields: { service: "metal_roofing", scope: "house only", address: "1 Synthetic Way", timing: "before the first snow" } }, true],
    ["lead_concierge", "lead_fact.confirm", { lead_id: "L-5401", proposal_id: "LP-5401", fields: { service: null, scope: null, address: "1 Synthetic Way", timing: null } }, true],
    ["lead_concierge", "lead_fact.confirm", { lead_id: "L-5401", proposal_id: "LP-5401", fields: { service: null, scope: null, address: null, timing: null } }, false],
    ["lead_concierge", "lead_fact.confirm", { lead_id: "L-5401", proposal_id: "LP-5401", fields: { address: "1 Synthetic Way" } }, false],
    ["lead_concierge", "lead_fact.confirm", { lead_id: "L-5401", proposal_id: "LP-5401", fields: { service: null, scope: null, address: "1 Synthetic Way", timing: null, price: "100" } }, false],
    // authority.evaluate: the four ids.
    ["compliance", "authority.evaluate", { authority_id: "AU-1", job_id: "J-CP1", applicability_id: "AP-1", assignment_id: "AS-1" }, true],
    ["compliance", "authority.evaluate", { authority_id: "AU-1", job_id: "J-CP1", applicability_id: "AP-1" }, false],
    ["compliance", "authority.evaluate", { authority_id: "AU 1", job_id: "J-CP1", applicability_id: "AP-1", assignment_id: "AS-1" }, false],
    ["compliance", "authority.evaluate", { authority_id: "AU-1", job_id: "J-CP1", applicability_id: "AP-1", assignment_id: "AS-1", waive: true }, false],
  ];
  for (const [specialistId, actionId, args, ok] of cases) {
    const decision = decide(specialistId, actionId, args);
    const label = `${actionId} ${JSON.stringify(args).slice(0, 120)}`;
    assert.equal(schemaPassed(decision), ok, label);
    if (!ok) assert.deepEqual([decision.outcome, decision.reason_codes], ["abstained", ["action_unregistered"]], label);
  }
  // By class: an A1 settings edit is a draft and an A0 read is done; both A3 steps ask first, the
  // retry the owner and the confirmation sales, whatever the owner set, until a machine path exists.
  const [settings, retry, confirm, read] = [cases[0], cases[11], cases[19], cases[23]].map(([specialistId, actionId, args]) =>
    evaluateStep(citing({ specialistId, actionId, args, delegation: { delegation_id: "dlg_synthetic", setting: "within_limits" }, withinCeiling: true })),
  );
  assert.deepEqual([settings.permit_kind, settings.outcome], ["draft", "succeeded"]);
  assert.deepEqual([read.permit_kind, read.outcome], ["none", "succeeded"]);
  assert.deepEqual([retry.result, retry.permit_kind, retry.reviewer_role], ["needs_approval", "asks_first", "owner"]);
  assert.deepEqual([confirm.result, confirm.permit_kind, confirm.reviewer_role], ["needs_approval", "asks_first", "sales"]);
  for (const id of ["import.retry_failed", "lead_fact.confirm"]) assert.deepEqual([REGISTRY[id]?.binding, REGISTRY[id]?.machinePermitProven], [{ kind: "by_hand" }, false], id);
  assert.deepEqual(REGISTRY["authority.evaluate"]?.binding, { kind: "authority_read" });
});

test("tool descriptions name the action, its aggregate and its catalog name, and mark a protective one", () => {
  for (const action of CATALOG.actions) assert.ok(action.name?.trim(), `${action.action_id} has a catalog name`);
  for (const specialist of CATALOG.specialists)
    for (const tool of toolsFor(specialist.specialist_id)) {
      const action = catalogAction(tool.action_id)!;
      assert.equal(tool.description, `${action.action_id} on ${action.aggregate}: ${action.name}${action.protective ? " (protective)" : ""}.`);
    }
  assert.equal(
    toolsFor("orchestrator").find((tool) => tool.action_id === "exception.escalate")?.description,
    "exception.escalate on exception: raising an issue with a named person (protective).",
  );
  assert.equal(
    toolsFor("orchestrator").find((tool) => tool.action_id === "import.retry_failed")?.description,
    "import.retry_failed on import_run: retrying the failed items of an import.",
  );
  assert.equal(
    toolsFor("compliance").find((tool) => tool.action_id === "authority.evaluate")?.description,
    "authority.evaluate on authority_record: checking licences and clearances.",
  );
});

test("a run names the people-only acts its specialist owns, by catalog name, and none is a tool", () => {
  assert.deepEqual(peopleOnlyFor("orchestrator"), [
    { action_id: "delegation.set", name: "setting what may run without asking" },
    { action_id: "policy.activate", name: "putting a policy change into effect" },
    { action_id: "settings.apply", name: "applying a settings change" },
    { action_id: "onboarding.go_live", name: "going live after setup" },
  ]);
  assert.deepEqual(peopleOnlyFor("compliance"), [
    { action_id: "filing.submit", name: "submitting a filing" },
    { action_id: "gate.waive", name: "waiving a job gate" },
    { action_id: "access.change", name: "changing a person's access" },
  ]);
  assert.deepEqual(peopleOnlyFor("lead_concierge"), []);
  for (const specialist of CATALOG.specialists) {
    const tools = new Set(toolsFor(specialist.specialist_id).map((tool) => tool.action_id));
    for (const act of peopleOnlyFor(specialist.specialist_id)) assert.equal(tools.has(act.action_id), false, act.action_id);
  }
});

test("the settings map form is for action arguments only: the strict output dialect refuses it", () => {
  const settings = REGISTRY["settings.propose_change"]!.args;
  const values = (settings.properties as Record<string, Record<string, unknown>>).before;
  // validate() reads it; both strict checkers, the Worker's and the gateway's, refuse it as a schema.
  assert.deepEqual(validate(values, { hours_saturday: "closed" }), []);
  for (const strict of [assertStrictSchema, hostStrict]) {
    assert.throws(() => strict(settings), /unsupported keyword propertyNames/);
    assert.throws(() => strict(values), /unsupported keyword propertyNames/);
    assert.throws(() => strict({ type: "object", additionalProperties: { type: "string" }, properties: {}, required: [] }), /objects must set additionalProperties to false/);
    assert.throws(() => strict({ type: "object", additionalProperties: false, properties: {}, required: [], minProperties: 1 }), /unsupported keyword minProperties/);
  }
  // Every other registered schema stays in the strict dialect.
  for (const [actionId, entry] of Object.entries(REGISTRY))
    if (entry && actionId !== "settings.propose_change") assert.doesNotThrow(() => assertStrictSchema(entry.args), actionId);
});

test("a prepared people-only act names the person who performs it, under a hold too", () => {
  const prepared = (specialistId: string, actionId: string, held: boolean) =>
    evaluateStep(input({ specialistId, actionId, args: { note: "Synthetic." }, specialistState: { paused: false, held }, registry: registry({ [actionId]: ANY_ARGS }) }));
  // The access change answers a staff ask (its own rule), as a draft and under a hold.
  assert.deepEqual([prepare(PAIRING).reviewer_role, prepare(PAIRING, { specialistState: { paused: false, held: true } }).reviewer_role], ["owner", "owner"]);
  for (const [specialistId, actionId, person] of [
    ["orchestrator", "delegation.propose_change", "owner"],
    ["billing_reconciliation", "payee.unfreeze_prepare", "owner"],
    ["field_safety", "safety_stop.release_prepare", "production"],
  ] as const) {
    assert.equal(prepared(specialistId, actionId, false).reviewer_role, person, `${actionId} draft`);
    assert.equal(prepared(specialistId, actionId, true).reviewer_role, person, `${actionId} under a hold`);
  }
});
