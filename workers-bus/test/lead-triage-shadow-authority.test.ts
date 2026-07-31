import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateLeadTriageShadowAuthority } from "../src/lead-triage-shadow-authority.ts";

const policy = readJson(new URL("../../config/authority/lead-triage-shadow-policy.v1.json", import.meta.url));
const cases = readJson(new URL("../../config/authority/lead-triage-shadow-policy.cases.v1.json", import.meta.url));

test("checked-in lead-triage shadow corpus is deterministic and never grants execution", async () => {
  for (const entry of cases.cases) {
    const decision = await evaluateLeadTriageShadowAuthority(
      materializePolicy(entry),
      materializeFacts(entry),
      { now: new Date(entry.now) },
    );
    assert.equal(decision.outcome, entry.expected.outcome, entry.id);
    assert.equal(decision.reason_code, entry.expected.reason_code, entry.id);
    assert.equal(decision.human_approval_required, true, entry.id);
    assert.deepEqual(Object.keys(decision).sort(), [
      "human_approval_required", "idempotency_key_sha256", "outcome", "policy_digest",
      "policy_id", "policy_version", "reason_code",
    ]);
  }

  const facts = materializeFacts(cases.cases[0]);
  const first = await evaluateLeadTriageShadowAuthority(policy, facts, {
    now: new Date(cases.cases[0].now),
  });
  const second = await evaluateLeadTriageShadowAuthority(policy, facts, {
    now: new Date(cases.cases[0].now),
  });
  assert.deepEqual(first, second);
  assert.equal(first.outcome, "shadow_eligible");
  assert.match(first.policy_digest ?? "", /^[0-9a-f]{64}$/);
  assert.match(first.idempotency_key_sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("unknown or sensitive-looking facts fail closed without entering the decision", async () => {
  const sentinel = "customer-sentinel@example.invalid";
  const decision = await evaluateLeadTriageShadowAuthority(
    policy,
    { ...cases.base_facts, contact_email: sentinel },
    { now: new Date("2026-07-31T12:01:00.000Z") },
  );
  assert.equal(decision.outcome, "human_approval_required");
  assert.equal(decision.reason_code, "facts_invalid");
  assert.equal(JSON.stringify(decision).includes(sentinel), false);
});

test("policy schema drift fails closed without an authority capability", async () => {
  const decision = await evaluateLeadTriageShadowAuthority(
    { ...policy, schema_version: "ironwrap.lead-triage-shadow-policy.v2" },
    cases.base_facts,
    { now: new Date("2026-07-31T12:01:00.000Z") },
  );
  assert.deepEqual(
    { outcome: decision.outcome, reason_code: decision.reason_code, human: decision.human_approval_required },
    { outcome: "human_approval_required", reason_code: "policy_schema_mismatch", human: true },
  );
});

test("policy drift cannot widen the v1 shadow contract", async () => {
  const widenedEffects = ["local_lead_triage_annotation", "customer_message"];
  const attempts = [
    {
      policy: { ...policy, tenant_id: "demo-exteriors" },
      facts: { ...cases.base_facts, tenant_id: "demo-exteriors" },
      reason: "policy_invalid",
    },
    {
      policy: { ...policy, policy_version: "v2" },
      facts: { ...cases.base_facts, policy_version: "v2" },
      reason: "policy_invalid",
    },
    {
      policy: {
        ...policy,
        allowed_facts: { ...policy.allowed_facts, requested_effects: widenedEffects },
      },
      facts: { ...cases.base_facts, requested_effects: widenedEffects },
      reason: "scope_expanded",
    },
  ];
  for (const attempt of attempts) {
    const decision = await evaluateLeadTriageShadowAuthority(attempt.policy, attempt.facts, {
      now: new Date("2026-07-31T12:01:00.000Z"),
    });
    assert.equal(decision.outcome, "human_approval_required");
    assert.equal(decision.reason_code, attempt.reason);
  }
});

function materializePolicy(entry: { policy_patch?: Record<string, unknown> }) {
  return { ...policy, ...(entry.policy_patch ?? {}) };
}

function materializeFacts(entry: {
  facts_patch?: Record<string, unknown>;
  facts_omit?: string[];
}) {
  const result = { ...cases.base_facts, ...(entry.facts_patch ?? {}) };
  for (const key of entry.facts_omit ?? []) delete result[key];
  return result;
}

function readJson(url: URL): any {
  return JSON.parse(readFileSync(url, "utf8"));
}
