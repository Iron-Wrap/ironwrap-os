#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = "config/authority/lead-triage-shadow-policy.v1.json";
const casesPath = "config/authority/lead-triage-shadow-policy.cases.v1.json";

export function validateLeadTriageShadowAuthorityConfig(policy, cases) {
  exactKeys(policy, [
    "schema_version", "policy_id", "policy_version", "tenant_id", "action", "mode", "status",
    "valid_from", "valid_until", "max_fact_age_seconds", "allowed_facts",
  ], "policy");
  assert.equal(policy.schema_version, "ironwrap.lead-triage-shadow-policy.v1");
  assert.equal(policy.policy_id, "lead-triage-shadow-authority");
  assert.equal(policy.policy_version, "v1");
  assert.equal(policy.tenant_id, "ironwrap");
  assert.equal(policy.action, "request_mark_lead_triaged");
  assert.equal(policy.mode, "shadow");
  assert.ok(["shadow", "disabled", "revoked"].includes(policy.status));
  const validFrom = iso(policy.valid_from, "policy.valid_from");
  const validUntil = iso(policy.valid_until, "policy.valid_until");
  assert.ok(validUntil > validFrom, "policy validity window must be increasing");
  assert.ok(Number.isInteger(policy.max_fact_age_seconds));
  assert.ok(policy.max_fact_age_seconds >= 1 && policy.max_fact_age_seconds <= 3_600);
  exactKeys(policy.allowed_facts, [
    "source", "triage_status", "scope", "requested_effects", "transport_statuses",
  ], "policy.allowed_facts");
  assert.equal(policy.allowed_facts.source, "owned_lead_envelope");
  assert.equal(policy.allowed_facts.triage_status, "Untriaged");
  text(policy.allowed_facts.scope, "policy.allowed_facts.scope", 3, 140);
  uniqueTextArray(policy.allowed_facts.requested_effects, "policy.allowed_facts.requested_effects");
  uniqueTextArray(policy.allowed_facts.transport_statuses, "policy.allowed_facts.transport_statuses");
  assert.equal(policy.allowed_facts.scope, "local_lead_triage_annotation");
  assert.deepEqual(policy.allowed_facts.requested_effects, ["local_lead_triage_annotation"]);
  assert.deepEqual(policy.allowed_facts.transport_statuses, ["pushed", "reconciled"]);

  exactKeys(cases, ["schema_version", "policy_path", "base_facts", "cases"], "cases");
  assert.equal(cases.schema_version, "ironwrap.lead-triage-shadow-policy-cases.v1");
  assert.equal(cases.policy_path, policyPath);
  exactFactKeys(cases.base_facts, "cases.base_facts");
  assert.ok(Array.isArray(cases.cases));
  assert.equal(cases.cases.length, 12, "shadow corpus case count");
  const ids = cases.cases.map((entry) => entry?.id);
  assert.equal(new Set(ids).size, ids.length, "shadow corpus ids must be unique");
  for (const id of [
    "eligible_local_untriaged_lead", "unknown_fact_field", "wrong_tenant", "wrong_action",
    "wrong_policy_version", "disabled_policy", "revoked_policy", "stale_policy",
    "incomplete_facts", "contradictory_triage_facts", "replayed_idempotency_key",
    "scope_expansion_attempt",
  ]) assert.ok(ids.includes(id), `shadow corpus missing ${id}`);

  for (const entry of cases.cases) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    const allowed = new Set(["id", "now", "expected", "facts_patch", "facts_omit", "policy_patch"]);
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `case ${entry.id ?? "unknown"} has unknown field ${key}`);
    text(entry.id, "case.id", 3, 140);
    iso(entry.now, `case ${entry.id}.now`);
    exactKeys(entry.expected, ["outcome", "reason_code"], `case ${entry.id}.expected`);
    assert.ok(["shadow_eligible", "human_approval_required"].includes(entry.expected.outcome));
    text(entry.expected.reason_code, `case ${entry.id}.expected.reason_code`, 3, 140);
    if (entry.facts_patch !== undefined) object(entry.facts_patch, `case ${entry.id}.facts_patch`);
    if (entry.policy_patch !== undefined) object(entry.policy_patch, `case ${entry.id}.policy_patch`);
    if (entry.facts_omit !== undefined) {
      assert.ok(Array.isArray(entry.facts_omit));
      for (const key of entry.facts_omit) {
        assert.ok(Object.hasOwn(cases.base_facts, key), `case ${entry.id} omits an unknown fact`);
      }
    }
  }
}

function exactFactKeys(value, label) {
  exactKeys(value, [
    "tenant_id", "policy_id", "policy_version", "action", "lead_envelope_id", "source",
    "triage_status", "triage_annotation_present", "transport_status", "scope", "requested_effects",
    "idempotency_key", "idempotency_state", "observed_at",
  ], label);
  assert.match(value.tenant_id, /^[a-z0-9][a-z0-9-]{1,63}$/);
  assert.match(value.policy_id, /^[A-Za-z0-9._:-]{1,140}$/);
  assert.match(value.policy_version, /^v[1-9][0-9]*$/);
  assert.equal(value.action, "request_mark_lead_triaged");
  assert.match(value.lead_envelope_id, /^[A-Za-z0-9._:-]{1,140}$/);
  assert.equal(value.source, "owned_lead_envelope");
  assert.equal(value.triage_status, "Untriaged");
  assert.equal(value.triage_annotation_present, false);
  text(value.transport_status, `${label}.transport_status`, 3, 64);
  text(value.scope, `${label}.scope`, 3, 140);
  uniqueTextArray(value.requested_effects, `${label}.requested_effects`);
  text(value.idempotency_key, `${label}.idempotency_key`, 8, 140);
  assert.equal(value.idempotency_state, "fresh");
  iso(value.observed_at, `${label}.observed_at`);
}

function exactKeys(value, keys, label) {
  object(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function text(value, label, min, max) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.ok(value.length >= min && value.length <= max && value === value.trim() && !/[\x00\r\n]/.test(value), `${label} is invalid`);
}

function uniqueTextArray(value, label) {
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 8, `${label} must be a bounded array`);
  for (const item of value) text(item, label, 3, 140);
  assert.equal(new Set(value).size, value.length, `${label} contains a duplicate`);
}

function iso(value, label) {
  text(value, label, 24, 30);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, `${label} must be canonical ISO time`);
  return parsed;
}

function main() {
  const policy = JSON.parse(readFileSync(resolve(root, policyPath), "utf8"));
  const cases = JSON.parse(readFileSync(resolve(root, casesPath), "utf8"));
  validateLeadTriageShadowAuthorityConfig(policy, cases);
  console.log(`ok lead-triage shadow authority config validated: ${cases.cases.length} adversarial cases`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
