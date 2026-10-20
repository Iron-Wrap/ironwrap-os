import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const OPERATING_TABLES = [
  "operating_leads",
  "operating_customers",
  "operating_properties",
  "operating_roof_jobs",
  "operating_production_gates",
  "operating_instant_estimates",
  "operating_consents",
  "operating_core_events",
  "operating_core_audit",
] as const;

const OPERATING_INDEXES = [
  ["idx_operating_leads_tenant_status", "operating_leads"],
  ["idx_operating_customers_tenant_contact", "operating_customers"],
  ["idx_operating_properties_tenant_address", "operating_properties"],
  ["idx_operating_roof_jobs_tenant_status", "operating_roof_jobs"],
  ["idx_operating_gates_tenant_state", "operating_production_gates"],
  ["idx_operating_estimates_tenant_status", "operating_instant_estimates"],
  ["idx_operating_consents_tenant_customer", "operating_consents"],
  ["idx_operating_events_tenant_time", "operating_core_events"],
  ["idx_operating_audit_tenant_time", "operating_core_audit"],
] as const;

const OPERATING_TRIGGERS = [
  ["operating_leads_version_guard", "operating_leads"],
  ["operating_customers_version_guard", "operating_customers"],
  ["operating_properties_version_guard", "operating_properties"],
  ["operating_roof_jobs_version_guard", "operating_roof_jobs"],
  ["operating_production_gates_version_guard", "operating_production_gates"],
  ["operating_instant_estimates_version_guard", "operating_instant_estimates"],
  ["operating_leads_identity_guard", "operating_leads"],
  ["operating_customers_identity_guard", "operating_customers"],
  ["operating_properties_identity_guard", "operating_properties"],
  ["operating_roof_jobs_identity_guard", "operating_roof_jobs"],
  ["operating_production_gates_identity_guard", "operating_production_gates"],
  ["operating_instant_estimates_identity_guard", "operating_instant_estimates"],
  ["operating_consents_append_only_update", "operating_consents"],
  ["operating_consents_append_only_delete", "operating_consents"],
  ["operating_core_events_append_only_update", "operating_core_events"],
  ["operating_core_events_append_only_delete", "operating_core_events"],
  ["operating_core_audit_append_only_update", "operating_core_audit"],
  ["operating_core_audit_append_only_delete", "operating_core_audit"],
] as const;

function assignment(source: string, name: string): string[] {
  const value = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  const appended = [
    ...source.matchAll(new RegExp(`^${name}\\+="([^\"]*)"`, "gm")),
  ].map((match) => match[1]);
  return [value, ...appended].join(",").split(",");
}

function countAssignment(source: string, name: string): number {
  const value = source.match(new RegExp(`^${name}=(\\d+)`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  return Number(value);
}

test("0090 operating-core tables, indexes, and guards are recoverable by both D1 inventories", () => {
  const migration = readFileSync(
    new URL("../migrations/0090_operating_core.sql", import.meta.url),
    "utf8",
  );
  const backup = readFileSync(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = readFileSync(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(migration, /payload_json/);
  for (const name of OPERATING_TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`),
    );
    assert.ok(
      assignment(backup, "REQUIRED_TABLES").includes(name),
      `backup table ${name}`,
    );
    assert.ok(
      assignment(restore, "REQUIRED_TABLES").includes(name),
      `restore table ${name}`,
    );
  }
  for (const [name, table] of OPERATING_INDEXES) {
    const binding = `${name}=${table}`;
    assert.match(
      migration,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`),
    );
    assert.ok(
      assignment(backup, "REQUIRED_INDEX_BINDINGS").includes(binding),
      `backup index ${binding}`,
    );
    assert.ok(
      assignment(restore, "REQUIRED_INDEX_BINDINGS").includes(binding),
      `restore index ${binding}`,
    );
  }
  for (const [name, table] of OPERATING_TRIGGERS) {
    const binding = `${name}=${table}`;
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b`),
    );
    assert.ok(
      assignment(backup, "REQUIRED_TRIGGER_BINDINGS").includes(binding),
      `backup trigger ${binding}`,
    );
    assert.ok(
      assignment(restore, "REQUIRED_TRIGGER_BINDINGS").includes(binding),
      `restore trigger ${binding}`,
    );
  }

  for (const [name, expected] of [
    // Pinned through 0204: service atomicity, both crew-stop guards, the stop release record,
    // and the AI team
    // coordination tables, append-only events, owner controls, human decisions, named
    // exceptions, the fact-version ledger and the shadow/agreement records and watch firings are included in both D1 inventories.
    // So is the 0153 gate clearance ledger with the two state guards it adds to the gate row,
    // and the 0155 tenant deposit policy with its four guards.
    ["REQUIRED_TABLE_COUNT", 277],
    ["REQUIRED_INDEX_COUNT", 391],
    ["REQUIRED_TRIGGER_COUNT", 760],
  ] as const) {
    assert.equal(countAssignment(backup, name), expected, `backup ${name}`);
    assert.equal(countAssignment(restore, name), expected, `restore ${name}`);
  }
  assert.deepEqual(
    assignment(backup, "REQUIRED_TABLES").sort(),
    assignment(restore, "REQUIRED_TABLES").sort(),
  );
  assert.deepEqual(
    assignment(backup, "REQUIRED_INDEX_BINDINGS").sort(),
    assignment(restore, "REQUIRED_INDEX_BINDINGS").sort(),
  );
  assert.deepEqual(
    assignment(backup, "REQUIRED_TRIGGER_BINDINGS").sort(),
    assignment(restore, "REQUIRED_TRIGGER_BINDINGS").sort(),
  );
});
