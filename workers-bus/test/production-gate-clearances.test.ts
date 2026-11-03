// production-gate-clearances.test.ts - migration 0153 holds the gate ledger's rules in D1 itself.
//
// These cases write SQL straight at the database, the way a defective or compromised writer
// would, and prove D1 refuses what the Worker routes would never send: a gate written outside its
// ledger, a ledger row rewritten or deleted, a waiver of Safety, Weather or Crew, a decider who is
// the requester, and any entry by the QA seed owner. The route-level cases live in
// production-gate-clearance.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { endCancellationWindow, SCHEDULING_GATES } from "./production-gate-ledger-fixture.ts";

// Synthetic fixtures only: reserved example.invalid identities.
const TENANT = "ironwrap";
const JOB = "job:ledger:0001";
const NOW = "2026-08-20T10:00:00.000Z";
const LATER = "2026-08-21T10:00:00.000Z";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const REASON = "Synthetic ledger reason for repository proof only.";

const OWNER = "appu_owner_ledger_a";
const SECOND_OWNER = "appu_owner_ledger_b";
const PRODUCTION = "appu_production_ledger";
const OPS = "appu_ops_ledger_0001";
const SEED_OWNER = "appu_seed_owner_ledger";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function applyMigrations(db: DatabaseSync, include: (file: string) => boolean): void {
  for (const file of migrationFiles().filter(include)) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
}

function insertUser(
  db: DatabaseSync,
  userId: string,
  role: "owner" | "ops",
  access: string,
  createdBy = "owner@example.invalid",
): void {
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(userId, TENANT, `${userId}@example.invalid`, `Synthetic ${userId}`, role, access, createdBy, NOW, NOW);
}

function seedJob(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES ('ow_ledger_0001', 'manual', 'Ledger Customer', 'ledger@example.invalid', '{}',
             'raw/ledger/0001.json', ?, 'reconciled', ?, ?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES ('lead:ledger:0001', ?, 'ow_ledger_0001', 'manual', 'Ledger Customer',
             'ledger@example.invalid', 'qualified', 1, ?, ?)`,
  ).run(TENANT, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES ('customer:ledger:0001', ?, 'ow_ledger_0001', 'Ledger Customer',
             'ledger@example.invalid', 'active', 1, ?, ?)`,
  ).run(TENANT, NOW, NOW);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
        service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, 'lead:ledger:0001', 'customer:ledger:0001', 'ow_ledger_0001', 'ironwrap',
             'IW-LEDGER-1', 'Roofing', 'qualified', 'blocked', 1, ?, ?)`,
  ).run(JOB, TENANT, NOW, NOW);
}

function insertGate(db: DatabaseSync, gate: string, extra: Record<string, unknown> = {}, verb = "INSERT"): void {
  const row: Record<string, unknown> = {
    gate_id: gateId(gate),
    tenant_id: TENANT,
    roof_job_id: JOB,
    source_envelope_id: "ow_ledger_0001",
    gate,
    owner_user: "owner@example.invalid",
    assigned_at: NOW,
    due_at: LATER,
    blocker_reason: `Awaiting ${gate.toLowerCase()} readiness proof.`,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
  const columns = Object.keys(row);
  db.prepare(
    `${verb} INTO operating_production_gates (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
}

const gateId = (gate: string) => `gate:ledger:${gate.toLowerCase()}`;

/** The full chain, five people, and one job whose six scheduling gates are blocked. */
function ledger(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, () => true);
  insertUser(db, OWNER, "owner", "owner");
  insertUser(db, SECOND_OWNER, "owner", "owner");
  db.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(SECOND_OWNER);
  insertUser(db, PRODUCTION, "ops", "production");
  insertUser(db, OPS, "ops", "ops");
  insertUser(db, SEED_OWNER, "owner", "owner", SEED_CREATED_BY);
  seedJob(db);
  for (const gate of SCHEDULING_GATES) insertGate(db, gate);
  // The OD-01 cancellation window holds every `clear` on Materials until it ends (0160). It ended
  // here, so each rule below answers by its own code.
  endCancellationWindow(db, { tenantId: TENANT, roofJobId: JOB });
  return db;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let entryCounter = 0;

function gateRow(db: DatabaseSync, gate: string): Record<string, unknown> {
  return {
    ...(db.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id,
              evidence_refs_json, cleared_at
         FROM operating_production_gates WHERE gate_id = ?`,
    ).get(gateId(gate)) as Record<string, unknown>),
  };
}

/** Append one entry with direct SQL, defaulting to a production waiver request on Materials. */
function append(db: DatabaseSync, overrides: Record<string, unknown> = {}, verb = "INSERT"): string {
  entryCounter += 1;
  const gate = String(overrides.gate ?? "Materials");
  const current = db.prepare("SELECT version FROM operating_production_gates WHERE gate_id = ?")
    .get(gateId(gate)) as { version: number } | undefined;
  const row: Record<string, unknown> = {
    clearance_id: `pgc_${entryCounter.toString(16).padStart(40, "0")}`,
    tenant_id: TENANT,
    gate_id: gateId(gate),
    roof_job_id: JOB,
    gate,
    entry_kind: "waiver_request",
    basis: "office_waiver",
    to_state: "blocked",
    from_gate_version: current?.version ?? 1,
    actor_kind: "person",
    actor_user_id: PRODUCTION,
    actor_role: "production",
    reason: REASON,
    request_sha256: sha(`request:${entryCounter}`),
    idempotency_key_hash: sha(`key:${entryCounter}`),
    created_at: LATER,
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `${verb} INTO production_gate_clearances (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return String(row.clearance_id);
}

/** An owner deciding with no request: the only holder approving their own item. */
const selfApproval = (gate: string, actor = OWNER) => ({
  gate,
  entry_kind: "waiver_decision",
  to_state: "waived",
  actor_user_id: actor,
  actor_role: "owner",
  requested_by: actor,
  self_approval: 1,
  self_approval_basis: "only_holder",
});

function refused(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

function seedReconciledDeposit(db: DatabaseSync): string {
  const row: Record<string, unknown> = {
    intent_id: "acct-intent-ledger-deposit-01",
    tenant_id: TENANT,
    kind: "deposit_invoice",
    roof_job_id: JOB,
    basis_json: "{}",
    basis_sha256: "a".repeat(64),
    source_documents_json: "[]",
    expected_sha256: "b".repeat(64),
    tax_policy_snapshot_sha256: "e".repeat(64),
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_payload_json: "{}",
    provider_payload_sha256: "c".repeat(64),
    provider_request_id: "req-ledger-deposit-000000001",
    currency: "CAD",
    subtotal: "5000.00",
    tax_amount: "250.00",
    total_amount: "5250.00",
    settled_amount: "5250.00",
    authority_permit_ref: "permit:test",
    authority_policy_ref: "policy:test",
    authority_policy_version: "1",
    authority_max_amount: "100000.00",
    effect_id: "effect:ledger-deposit-00000001",
    effect_idempotency_key: "effect-key-ledger-deposit-01",
    state: "reconciled",
    version: 1,
    derived_by_actor_kind: "owner",
    derived_by_user_id: OWNER,
    derived_at: NOW,
    approved_by_user_id: SECOND_OWNER,
    approved_at: NOW,
    provider_entity_id: "1042",
    observed_sha256: "b".repeat(64),
    provider_submitted_at: NOW,
    provider_reconciled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO accounting_intents (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return String(row.intent_id);
}

test("a gate row is created blocked at version 1 and never written outside its ledger", () => {
  const db = ledger();
  // A gate is born blocked, at version 1, with no clearance - exactly what the materializer writes.
  refused(() => insertGate(db, "Completion", { state: "ready" }), "operating_production_gates_ledger_required");
  refused(() => insertGate(db, "Completion", { version: 2 }), "operating_production_gates_ledger_required");
  refused(
    () => insertGate(db, "Completion", { clearance_basis: "office_waiver" }),
    "operating_production_gates_ledger_required",
  );
  insertGate(db, "Completion");
  // A retried materializer write never reaches the guard, cleared or not.
  insertGate(db, "Completion", {}, "INSERT OR IGNORE");
  db.prepare(
    `INSERT INTO operating_production_gates
       (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
        due_at, blocker_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'ow_ledger_0001', 'Completion', 'worker', ?, ?, 'Retry', ?, ?)
     ON CONFLICT(gate_id) DO NOTHING`,
  ).run(gateId("Completion"), TENANT, JOB, NOW, LATER, NOW, NOW);

  // No direct update: not a state, not an owner, not a version.
  refused(
    () => db.prepare(
      "UPDATE operating_production_gates SET state = 'ready', version = version + 1 WHERE gate_id = ?",
    ).run(gateId("Weather")),
    "operating_production_gates_ledger_required",
  );
  refused(
    () => db.prepare(
      "UPDATE operating_production_gates SET owner_user = 'someone', version = version + 1 WHERE gate_id = ?",
    ).run(gateId("Weather")),
    "operating_production_gates_ledger_required",
  );

  append(db, selfApproval("Materials"));
  assert.deepEqual(
    { state: gateRow(db, "Materials").state, version: gateRow(db, "Materials").version },
    { state: "waived", version: 2 },
  );
  // A REPLACE would delete the cleared row and write a fresh blocked one in its place.
  refused(
    () => insertGate(db, "Materials", {}, "INSERT OR REPLACE"),
    "FOREIGN KEY constraint failed|operating_production_gates_ledger_required",
  );
  db.exec("PRAGMA foreign_keys = OFF");
  refused(() => insertGate(db, "Materials", {}, "INSERT OR REPLACE"), "operating_production_gates_ledger_required");
  db.exec("PRAGMA foreign_keys = ON");
  assert.deepEqual(
    { state: gateRow(db, "Materials").state, version: gateRow(db, "Materials").version },
    { state: "waived", version: 2 },
  );
  // Once a gate is cleared, even an identical retry of its creation writes nothing.
  insertGate(db, "Materials", {}, "INSERT OR IGNORE");
  assert.equal(gateRow(db, "Materials").state, "waived");
});

test("the ledger is append-only except a redaction of the reason", () => {
  const db = ledger();
  const requestId = append(db);
  const before = { ...db.prepare("SELECT * FROM production_gate_clearances WHERE clearance_id = ?").get(requestId) as object };
  refused(
    () => db.prepare("UPDATE production_gate_clearances SET to_state = 'waived' WHERE clearance_id = ?").run(requestId),
    "production_gate_clearance_append_only",
  );
  refused(
    () => db.prepare("UPDATE production_gate_clearances SET reason = 'Something else entirely.' WHERE clearance_id = ?").run(requestId),
    "production_gate_clearance_append_only",
  );
  refused(
    () => db.prepare("DELETE FROM production_gate_clearances WHERE clearance_id = ?").run(requestId),
    "production_gate_clearance_append_only",
  );
  // REPLACE fires no delete trigger, so it is refused on the existing key before it can delete.
  entryCounter -= 1;
  refused(() => append(db, { from_gate_version: 2 }, "INSERT OR REPLACE"), "production_gate_clearance_append_only");
  refused(
    () => append(db, { idempotency_key_hash: before["idempotency_key_hash" as keyof typeof before] }, "INSERT OR REPLACE"),
    "production_gate_clearance_append_only",
  );
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM production_gate_clearances WHERE clearance_id = ?").get(requestId) as object },
    before,
  );

  db.prepare(
    "UPDATE production_gate_clearances SET reason = NULL, reason_redacted_at = ? WHERE clearance_id = ?",
  ).run(LATER, requestId);
  const redacted = db.prepare(
    "SELECT reason, reason_redacted_at, to_state FROM production_gate_clearances WHERE clearance_id = ?",
  ).get(requestId) as Record<string, unknown>;
  assert.deepEqual({ ...redacted }, { reason: null, reason_redacted_at: LATER, to_state: "blocked" });
  refused(
    () => db.prepare(
      "UPDATE production_gate_clearances SET reason = 'Restored text.', reason_redacted_at = NULL WHERE clearance_id = ?",
    ).run(requestId),
    "production_gate_clearance_append_only",
  );
  refused(
    () => db.prepare(
      "UPDATE production_gate_clearances SET reason_redacted_at = ? WHERE clearance_id = ?",
    ).run(NOW, requestId),
    "production_gate_clearance_append_only",
  );
  assert.equal(gateRow(db, "Materials").version, 2, "a redaction does not move the gate");
});

test("no legacy entry can be appended after the backfill", () => {
  const db = ledger();
  refused(
    () => append(db, {
      entry_kind: "legacy",
      basis: "(none)",
      to_state: "ready",
      actor_kind: null,
      actor_role: null,
      request_sha256: null,
      idempotency_key_hash: null,
    }),
    "production_gate_clearance_legacy_closed",
  );
  assert.equal(gateRow(db, "Materials").state, "blocked");
});

test("Safety, Weather and Crew are never waived, and nothing outside the matrix is appended", () => {
  const db = ledger();
  for (const gate of ["Safety", "Weather", "Crew", "Completion"]) {
    if (gate === "Completion") insertGate(db, gate);
    refused(() => append(db, { gate }), "production_gate_not_waivable");
    refused(() => append(db, selfApproval(gate)), "production_gate_not_waivable");
  }
  refused(() => append(db, { entry_kind: "clear", to_state: "complete" }), "production_gate_clearance_basis_invalid");
  refused(
    () => append(db, { entry_kind: "clear", basis: "deposit_settlement", to_state: "complete" }),
    "production_gate_clearance_basis_invalid",
  );
  refused(() => append(db, { entry_kind: "reverse" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { actor_kind: "policy" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { to_state: "waived" }), "production_gate_clearance_basis_invalid");
  refused(() => append(db, { basis: "person_attestation", to_state: "ready" }), "production_gate_clearance_basis_invalid");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM production_gate_clearances").get() as { n: number }).n,
    0,
  );
  for (const gate of SCHEDULING_GATES) assert.equal(gateRow(db, gate).version, 1, gate);
});

test("an entry acts on the gate's current version, by a person who holds the set right now", () => {
  const db = ledger();
  refused(() => append(db, { from_gate_version: 2 }), "production_gate_version_conflict");
  refused(() => append(db, { roof_job_id: "job:ledger:other" }), "production_gate_clearance_gate_invalid");
  refused(() => append(db, { actor_user_id: OPS, actor_role: "ops" }), "production_gate_clearance_actor_invalid");
  refused(() => append(db, { actor_role: "owner" }), "production_gate_clearance_actor_invalid");
  refused(() => append(db, { reason: null }), "production_gate_clearance_reason_required");
  db.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(PRODUCTION);
  refused(() => append(db), "production_gate_clearance_actor_invalid");
  db.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(PRODUCTION);
  const requestId = append(db);
  // Production requests a waiver; it never decides one.
  refused(
    () => append(db, {
      entry_kind: "waiver_decision",
      to_state: "waived",
      request_id: requestId,
      requested_by: PRODUCTION,
    }),
    "production_gate_clearance_actor_invalid",
  );

  // Settlement is made of a reconciled deposit invoice of this job, and of nothing else.
  const settlement = (intentId: string) => ({
    gate: "Deposit",
    entry_kind: "clear",
    basis: "deposit_settlement",
    to_state: "complete",
    reason: null,
    evidence_refs_json: JSON.stringify({ r2_key: "production-gate-clearance/v1/x.json", money_intent_id: intentId }),
  });
  refused(() => append(db, settlement("acct-intent-ledger-deposit-01")), "deposit_settlement_not_observed");
  const intentId = seedReconciledDeposit(db);
  refused(() => append(db, settlement("acct-intent-someone-else-0001")), "deposit_settlement_not_observed");
  const clearId = append(db, settlement(intentId));
  assert.deepEqual(gateRow(db, "Deposit"), {
    state: "complete",
    version: 2,
    clearance_basis: "deposit_settlement",
    clearance_decision_id: clearId,
    cleared_by_user_id: PRODUCTION,
    evidence_refs_json: settlement(intentId).evidence_refs_json,
    cleared_at: LATER,
  });
  // A cleared gate takes no further entry of this slice.
  refused(() => append(db, { gate: "Deposit" }), "production_gate_already_cleared");
});

test("a decider is never the requester, unless the only active holder approves their own item", () => {
  const db = ledger();
  db.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(SECOND_OWNER);
  const ownRequest = append(db, { gate: "Access", actor_user_id: OWNER, actor_role: "owner" });
  const decision = (overrides: Record<string, unknown>) => ({
    gate: "Access",
    entry_kind: "waiver_decision",
    to_state: "waived",
    request_id: ownRequest,
    requested_by: OWNER,
    actor_user_id: SECOND_OWNER,
    actor_role: "owner",
    ...overrides,
  });
  // While another owner is active, the requester decides nothing on their own request.
  refused(
    () => append(db, decision({ actor_user_id: OWNER, self_approval: 1, self_approval_basis: "only_holder" })),
    "production_gate_waiver_self_approval_refused",
  );
  refused(() => append(db, decision({ actor_user_id: OWNER })), "production_gate_waiver_self_approval_refused");
  refused(() => append(db, selfApproval("Access")), "production_gate_waiver_self_approval_refused");
  // A self-approval flag belongs only to the requester's own decision.
  refused(
    () => append(db, decision({ self_approval: 1, self_approval_basis: "only_holder" })),
    "production_gate_clearance_basis_invalid",
  );
  // The decision must name the request and its requester as recorded.
  refused(() => append(db, decision({ requested_by: PRODUCTION })), "production_gate_waiver_request_invalid");
  refused(
    () => append(db, decision({ request_id: null, requested_by: PRODUCTION })),
    "production_gate_waiver_request_invalid",
  );

  const declined = append(db, decision({ to_state: "blocked" }));
  assert.equal(gateRow(db, "Access").state, "blocked");
  assert.equal(gateRow(db, "Access").version, 3);
  refused(() => append(db, decision({})), "production_gate_waiver_already_decided");

  // The second owner leaves: the requester is now the only holder and may approve their own
  // item, with a reason, recorded as a self-approval. The QA seed owner is still active and
  // does not count.
  const secondRequest = append(db, { gate: "Access", actor_user_id: OWNER, actor_role: "owner" });
  db.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(SECOND_OWNER);
  refused(
    () => append(db, decision({ request_id: secondRequest, actor_user_id: OWNER, to_state: "blocked", self_approval: 1, self_approval_basis: "only_holder" })),
    "production_gate_waiver_self_approval_refused",
  );
  refused(
    () => append(db, decision({ request_id: secondRequest, actor_user_id: OWNER, self_approval: 1, self_approval_basis: "only_holder", reason: null })),
    "production_gate_clearance_reason_required",
  );
  const approved = append(db, decision({
    request_id: secondRequest,
    actor_user_id: OWNER,
    self_approval: 1,
    self_approval_basis: "only_holder",
  }));
  assert.deepEqual(
    { ...db.prepare(
      `SELECT entry_kind, to_state, requested_by, actor_user_id, self_approval, self_approval_basis, reason
         FROM production_gate_clearances WHERE clearance_id = ?`,
    ).get(approved) as object },
    {
      entry_kind: "waiver_decision",
      to_state: "waived",
      requested_by: OWNER,
      actor_user_id: OWNER,
      self_approval: 1,
      self_approval_basis: "only_holder",
      reason: REASON,
    },
  );
  assert.equal(gateRow(db, "Access").state, "waived");
  assert.notEqual(declined, approved);
});

test("a person holds one open waiver request per gate, and a decision closes it", () => {
  const db = ledger();
  const first = append(db);
  refused(
    () => append(db, { reason: "A second synthetic request on the same gate." }),
    "production_gate_waiver_request_open",
  );
  // Another person, or another gate, is not held by it.
  append(db, { actor_user_id: OWNER, actor_role: "owner" });
  append(db, { gate: "Access" });
  append(db, {
    entry_kind: "waiver_decision",
    request_id: first,
    requested_by: PRODUCTION,
    actor_user_id: OWNER,
    actor_role: "owner",
  });
  append(db);
  assert.equal(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM production_gate_clearances
        WHERE gate = 'Materials' AND entry_kind = 'waiver_request' AND actor_user_id = ?`,
    ).get(PRODUCTION) as { n: number }).n,
    2,
  );
});

test("waiver entries carry no attestation, contract or evidence fields", () => {
  const db = ledger();
  for (const field of [
    { attestation_json: '{"note":"synthetic"}' },
    { policy_version: "ironwrap.synthetic.v1" },
    { terms_hash: "a".repeat(64) },
    { contract_binding_id: "binding:synthetic:0001" },
    { evidence_refs_json: '{"r2_key":"production-gate-clearance/v1/x.json"}' },
  ]) {
    refused(() => append(db, field), "production_gate_clearance_basis_invalid");
    refused(() => append(db, { ...selfApproval("Access"), ...field }), "production_gate_clearance_basis_invalid");
  }
  // A settlement names its receipt and carries no attestation or contract facts either.
  const intentId = seedReconciledDeposit(db);
  refused(
    () => append(db, {
      gate: "Deposit",
      entry_kind: "clear",
      basis: "deposit_settlement",
      to_state: "complete",
      reason: null,
      evidence_refs_json: JSON.stringify({ money_intent_id: intentId }),
      attestation_json: '{"note":"synthetic"}',
    }),
    "production_gate_clearance_basis_invalid",
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM production_gate_clearances").get() as { n: number }).n,
    0,
  );
});

// A person's `clear` names its money receipt only: each contract field the matrix holds NULL is
// refused on its own, and the same settlement without it is appended (0153, kept by 0155).
for (const [field, value] of [
  ["policy_version", "ironwrap.deposit-gate.v1"],
  ["terms_hash", "a".repeat(64)],
  ["contract_binding_id", "binding:synthetic:0001"],
] as const) {
  test(`a person's settlement clear carrying ${field} is refused`, () => {
    const db = ledger();
    const intentId = seedReconciledDeposit(db);
    const settlement = {
      gate: "Deposit",
      entry_kind: "clear",
      basis: "deposit_settlement",
      to_state: "complete",
      reason: null,
      evidence_refs_json: JSON.stringify({ money_intent_id: intentId }),
    };
    refused(() => append(db, { ...settlement, [field]: value }), "production_gate_clearance_basis_invalid");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM production_gate_clearances").get() as { n: number }).n,
      0,
    );
    append(db, settlement);
    assert.equal(gateRow(db, "Deposit").state, "complete");
  });
}

test("the QA seed owner is refused on every person entry", () => {
  const db = ledger();
  const intentId = seedReconciledDeposit(db);
  const productionRequest = append(db);
  refused(() => append(db, { actor_user_id: SEED_OWNER, actor_role: "owner" }), "production_gate_clearance_seed_identity_refused");
  refused(() => append(db, selfApproval("Deposit", SEED_OWNER)), "production_gate_clearance_seed_identity_refused");
  refused(
    () => append(db, {
      entry_kind: "waiver_decision",
      to_state: "waived",
      request_id: productionRequest,
      requested_by: PRODUCTION,
      actor_user_id: SEED_OWNER,
      actor_role: "owner",
    }),
    "production_gate_clearance_seed_identity_refused",
  );
  refused(
    () => append(db, {
      gate: "Deposit",
      entry_kind: "clear",
      basis: "deposit_settlement",
      to_state: "complete",
      reason: null,
      actor_user_id: SEED_OWNER,
      actor_role: "owner",
      evidence_refs_json: JSON.stringify({ money_intent_id: intentId }),
    }),
    "production_gate_clearance_seed_identity_refused",
  );
  // The real owner decides; the seed owner, though active, is not another holder.
  append(db, selfApproval("Deposit"));
  assert.equal(gateRow(db, "Deposit").state, "waived");
});

test("each entry moves its gate once and writes exactly one audit row", () => {
  const db = ledger();
  db.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(SECOND_OWNER);
  const request = append(db);
  const decline = append(db, {
    entry_kind: "waiver_decision",
    request_id: request,
    requested_by: PRODUCTION,
    actor_user_id: OWNER,
    actor_role: "owner",
  });
  const second = append(db, { reason: "A second synthetic request for repository proof." });
  const approve = append(db, {
    entry_kind: "waiver_decision",
    to_state: "waived",
    request_id: second,
    requested_by: PRODUCTION,
    actor_user_id: SECOND_OWNER,
    actor_role: "owner",
  });
  db.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(SECOND_OWNER);
  const own = append(db, selfApproval("Deposit"));
  const entries = [request, decline, second, approve, own];

  for (const clearanceId of entries) {
    const rows = db.prepare(
      `SELECT action, trigger, approved_by, reason, target_ids FROM audit_log WHERE run_id = ?`,
    ).all(clearanceId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, clearanceId);
    const entry = db.prepare(
      "SELECT entry_kind, basis, actor_user_id, gate_id FROM production_gate_clearances WHERE clearance_id = ?",
    ).get(clearanceId) as Record<string, string>;
    assert.deepEqual({ ...rows[0] }, {
      action: `${entry.entry_kind}:${entry.basis}`,
      trigger: "person",
      approved_by: entry.actor_user_id,
      reason: null,
      target_ids: `production_gate_clearance:${clearanceId},production_gate:${entry.gate_id}`,
    });
  }
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE automation = 'production_gate_clearance'").get() as { n: number }).n,
    entries.length,
  );
  assert.match(
    String((db.prepare("SELECT source_ids FROM audit_log WHERE run_id = ?").get(own) as { source_ids: string }).source_ids),
    /,self_approval:only_holder$/,
  );
  assert.match(
    String((db.prepare("SELECT source_ids FROM audit_log WHERE run_id = ?").get(approve) as { source_ids: string }).source_ids),
    new RegExp(`from_version:4,to_state:waived,request:${second}$`),
  );
  assert.deepEqual(gateRow(db, "Materials"), {
    state: "waived",
    version: 5,
    clearance_basis: "office_waiver",
    clearance_decision_id: approve,
    cleared_by_user_id: SECOND_OWNER,
    evidence_refs_json: null,
    cleared_at: LATER,
  });
  assert.equal(gateRow(db, "Deposit").version, 2);
  // A blocked outcome carries no clearance on the gate row.
  assert.equal(gateRow(db, "Access").clearance_basis, null);
});

test("the backfill records each gate already out of blocked as one legacy entry", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, (file) => file.slice(0, 4) < "0153");
  insertUser(db, OWNER, "owner", "owner");
  seedJob(db);
  const cleared = (gate: string, values: Record<string, unknown>) =>
    insertGate(db, gate, { cleared_at: LATER, cleared_by_user_id: OWNER, ...values });
  cleared("Deposit", {
    state: "complete",
    version: 2,
    clearance_basis: "deposit_settlement",
    clearance_decision_id: "production-gate-clearance:legacy-deposit",
    evidence_refs_json: '{"r2_key":"production-gate-clearance/v1/legacy.json"}',
  });
  cleared("Materials", {
    state: "waived",
    version: 2,
    clearance_basis: "office_waiver",
    clearance_decision_id: "production-gate-clearance:legacy-materials",
    evidence_refs_json: '{"waiver_reason":"  Panels staged at the shop for this job.  "}',
  });
  cleared("Safety", {
    state: "waived",
    version: 3,
    clearance_basis: "office_waiver",
    clearance_decision_id: "production-gate-clearance:legacy-safety-0",
    evidence_refs_json: "{not json",
  });
  insertGate(db, "Weather", { state: "ready" });
  insertGate(db, "Access");
  insertGate(db, "Crew");
  const gatesBefore = db.prepare(
    "SELECT * FROM operating_production_gates ORDER BY gate_id",
  ).all().map((row) => ({ ...row }));

  applyMigrations(db, (file) => file.slice(0, 4) >= "0153");

  assert.deepEqual(
    db.prepare("SELECT * FROM operating_production_gates ORDER BY gate_id").all().map((row) => ({ ...row })),
    gatesBefore,
    "the backfill writes no gate",
  );
  const entries = db.prepare(
    `SELECT gate, entry_kind, basis, to_state, from_gate_version, actor_kind, actor_user_id,
            evidence_refs_json, reason, legacy_decision_id, request_sha256, idempotency_key_hash,
            created_at, clearance_id
       FROM production_gate_clearances ORDER BY gate`,
  ).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
  assert.deepEqual(entries.map(({ clearance_id: _id, ...entry }) => entry), [
    {
      gate: "Deposit", entry_kind: "legacy", basis: "deposit_settlement", to_state: "complete",
      from_gate_version: 1, actor_kind: null, actor_user_id: OWNER,
      evidence_refs_json: '{"r2_key":"production-gate-clearance/v1/legacy.json"}', reason: null,
      legacy_decision_id: "production-gate-clearance:legacy-deposit", request_sha256: null,
      idempotency_key_hash: null, created_at: LATER,
    },
    {
      gate: "Materials", entry_kind: "legacy", basis: "office_waiver", to_state: "waived",
      from_gate_version: 1, actor_kind: null, actor_user_id: OWNER, evidence_refs_json: null,
      reason: "Panels staged at the shop for this job.",
      legacy_decision_id: "production-gate-clearance:legacy-materials", request_sha256: null,
      idempotency_key_hash: null, created_at: LATER,
    },
    {
      gate: "Safety", entry_kind: "legacy", basis: "office_waiver", to_state: "waived",
      from_gate_version: 2, actor_kind: null, actor_user_id: OWNER, evidence_refs_json: null,
      reason: null, legacy_decision_id: "production-gate-clearance:legacy-safety-0",
      request_sha256: null, idempotency_key_hash: null, created_at: LATER,
    },
    {
      gate: "Weather", entry_kind: "legacy", basis: "(none)", to_state: "ready",
      from_gate_version: 0, actor_kind: null, actor_user_id: null, evidence_refs_json: null,
      reason: null, legacy_decision_id: null, request_sha256: null, idempotency_key_hash: null,
      created_at: NOW,
    },
  ]);
  for (const entry of entries) {
    const audit = db.prepare(
      "SELECT action, trigger, approved_by FROM audit_log WHERE run_id = ?",
    ).all(entry.clearance_id as string).map((row) => ({ ...row }));
    assert.deepEqual(audit, [{
      action: `legacy:${String(entry.basis)}`,
      trigger: "migration",
      approved_by: entry.actor_user_id,
    }]);
  }
  // From here on the guards hold for the backfilled gates too.
  refused(
    () => db.prepare(
      "UPDATE operating_production_gates SET state = 'blocked', version = version + 1 WHERE gate_id = ?",
    ).run(gateId("Safety")),
    "operating_production_gates_ledger_required",
  );
  insertUser(db, PRODUCTION, "ops", "production");
  refused(() => append(db), "production_gate_already_cleared");
  append(db, { gate: "Access" });
  assert.equal(gateRow(db, "Access").version, 2);
});

test("both D1 recovery inventories carry the ledger, its index and every guard", () => {
  const db = ledger();
  const objects = db.prepare(
    `SELECT type, name, tbl_name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND (tbl_name = 'production_gate_clearances'
             OR name LIKE 'operating_production_gates_state_guard%')
      ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; tbl_name: string }>;
  assert.deepEqual(
    objects.map(({ type, name }) => `${type}:${name}`),
    [
      "index:idx_production_gate_clearances_request",
      "table:production_gate_clearances",
      "trigger:operating_production_gates_state_guard",
      "trigger:operating_production_gates_state_guard_insert",
      "trigger:production_gate_clearances_append_only_delete",
      "trigger:production_gate_clearances_append_only_update",
      "trigger:production_gate_clearances_apply",
      "trigger:production_gate_clearances_cancellation_window_hold",
      "trigger:production_gate_clearances_no_insert_replace",
      "trigger:production_gate_clearances_validate_insert",
    ],
  );
  for (const script of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
    const source = readFileSync(new URL(`../../deploy/${script}`, import.meta.url), "utf8");
    const listed = (name: string) =>
      [...source.matchAll(new RegExp(`^${name}\\+?="([^"]*)"$`, "gm"))]
        .flatMap((match) => match[1]!.split(","));
    for (const { type, name, tbl_name: table } of objects) {
      const inventory = type === "table"
        ? listed("REQUIRED_TABLES")
        : listed(type === "index" ? "REQUIRED_INDEX_BINDINGS" : "REQUIRED_TRIGGER_BINDINGS");
      assert.ok(inventory.includes(type === "table" ? name : `${name}=${table}`), `${script} recovers ${name}`);
    }
  }
});
