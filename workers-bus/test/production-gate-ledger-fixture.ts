// production-gate-ledger-fixture.ts - stand a fixture job's gates at a state through the gate ledger.
//
// Since migration 0153 a production gate changes only by an entry in `production_gate_clearances`.
// Migration 0158 lets a person attest Materials, Access, Weather and Safety and reverse an entry,
// and `attestGateInLedger` / `reverseGateInLedger` append those entries through every guard, the
// way the routes do. Crew still clears only by policy at scheduling, which comes with a later
// change, and Safety needs a competency record. A fixture that schedules a job therefore still
// records its gates the way 0153's backfill records a gate cleared before the ledger existed: each
// changed gate moves to its next version with one `legacy` entry and that entry's audit row. The
// ledger's guards are lifted for that write and restored exactly as they were. No product path
// does this; product writes append entries the guards check. Once Crew-by-policy entries exist,
// move these fixtures onto them.

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SCHEDULING_GATES = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

type GateState = "blocked" | "ready" | "in_progress" | "complete" | "waived";

/** The 0153 guards, in creation order, so restoring them keeps their firing order. */
function ledgerGuards(db: DatabaseSync): Array<{ name: string; sql: string }> {
  return db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger'
        AND (tbl_name = 'production_gate_clearances'
             OR name IN ('operating_production_gates_state_guard',
                         'operating_production_gates_state_guard_insert'))
      ORDER BY rowid`,
  ).all() as Array<{ name: string; sql: string }>;
}

export function recordLegacyGateStates(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    state?: GateState;
    gates?: readonly string[];
    at?: string;
    /** The basis the entry records; a later policy basis such as `contract_no_deposit` fits too. */
    basis?: string;
  },
): void {
  const state = input.state ?? "ready";
  const at = input.at ?? new Date().toISOString();
  const basis = input.basis ?? "(none)";
  const gates = db.prepare(
    `SELECT gate_id, gate, version FROM operating_production_gates
      WHERE tenant_id = ? AND roof_job_id = ? AND state != ?
      ORDER BY gate`,
  ).all(input.tenantId, input.roofJobId, state) as Array<{
    gate_id: string;
    gate: string;
    version: number;
  }>;
  const changes = gates.filter((row) => (input.gates ?? SCHEDULING_GATES).includes(row.gate));
  if (changes.length === 0) return;
  const guards = ledgerGuards(db);
  for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
  try {
    for (const row of changes) {
      const clearanceId = `pgc_${randomBytes(20).toString("hex")}`;
      db.prepare(
        `UPDATE operating_production_gates
            SET state = ?, version = version + 1, updated_at = ?
          WHERE gate_id = ? AND version = ?`,
      ).run(state, at, row.gate_id, row.version);
      db.prepare(
        `INSERT INTO production_gate_clearances (
           clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
           from_gate_version, created_at
         ) VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?, ?, ?)`,
      ).run(clearanceId, input.tenantId, row.gate_id, input.roofJobId, row.gate, basis, state, row.version, at);
      db.prepare(
        `INSERT INTO audit_log (ts, automation, trigger, source_ids, target_ids, action, result, run_id)
         VALUES (?, 'production_gate_clearance', 'migration', ?, ?, ?, 'ok', ?)`,
      ).run(
        at,
        `job:${input.roofJobId},gate:${row.gate},from_version:${row.version},to_state:${state}`,
        `production_gate_clearance:${clearanceId},production_gate:${row.gate_id}`,
        `legacy:${basis}`,
        clearanceId,
      );
    }
  } finally {
    for (const guard of guards) db.exec(guard.sql);
  }
}

const HOUR_MS = 3_600_000;
const hex64 = () => randomBytes(32).toString("hex");

function currentGate(
  db: DatabaseSync,
  input: { tenantId: string; roofJobId: string; gate: string },
): { gate_id: string; version: number } {
  const row = db.prepare(
    `SELECT gate_id, version FROM operating_production_gates
      WHERE tenant_id = ? AND roof_job_id = ? AND gate = ?`,
  ).get(input.tenantId, input.roofJobId, input.gate) as { gate_id: string; version: number } | undefined;
  if (!row) throw new Error(`fixture gate ${input.gate} is missing`);
  return row;
}

/**
 * Attest Materials, Access or Weather the way the attestation route does, through every ledger
 * guard: one `clear` / `person_attestation` entry by an owner or production person who is on no
 * crew, with the gate's typed attestation and no evidence. Weather's window and forecast are taken
 * from the real clock, which is the clock D1 checks them against.
 */
export function attestGateInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    gate: "Materials" | "Access" | "Weather";
    actorUserId: string;
    actorRole: "owner" | "production";
    at?: string;
  },
): string {
  const now = Date.now();
  const instant = (offsetHours: number) => new Date(now + offsetHours * HOUR_MS).toISOString();
  const attestation = input.gate === "Materials"
    ? { reference: "DELIVERY-FIXTURE-0001", source: "supplier_delivery" }
    : input.gate === "Access"
    ? { confirmed_at: instant(-1), confirmed_with: "customer" }
    : {
      forecast_observed_at: instant(-1),
      forecast_source: "weather.gc.ca",
      window_end: instant(72),
      window_start: instant(24),
    };
  const gate = currentGate(db, input);
  const clearanceId = `pgc_${randomBytes(20).toString("hex")}`;
  db.prepare(
    `INSERT INTO production_gate_clearances (
       clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
       from_gate_version, actor_kind, actor_user_id, actor_role, attestation_json,
       evidence_refs_json, request_sha256, idempotency_key_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, 'clear', 'person_attestation', 'ready', ?, 'person', ?, ?, ?, '[]',
               ?, ?, ?)`,
  ).run(
    clearanceId,
    input.tenantId,
    gate.gate_id,
    input.roofJobId,
    input.gate,
    gate.version,
    input.actorUserId,
    input.actorRole,
    JSON.stringify(attestation),
    hex64(),
    hex64(),
    input.at ?? new Date(now).toISOString(),
  );
  return clearanceId;
}

/**
 * Reverse the entry that holds a gate's current state the way the reversal route does, through
 * every ledger guard: the gate is `blocked` again and nothing is deleted.
 */
export function reverseGateInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    gate: string;
    actorUserId: string;
    actorRole: "owner" | "production";
    at?: string;
  },
): string {
  const gate = currentGate(db, input);
  const target = db.prepare(
    `SELECT clearance_id FROM production_gate_clearances
      WHERE tenant_id = ? AND gate_id = ? AND from_gate_version = ?`,
  ).get(input.tenantId, gate.gate_id, gate.version - 1) as { clearance_id: string } | undefined;
  if (!target) throw new Error(`fixture gate ${input.gate} has no entry to reverse`);
  const clearanceId = `pgc_${randomBytes(20).toString("hex")}`;
  db.prepare(
    `INSERT INTO production_gate_clearances (
       clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
       from_gate_version, reverses_id, actor_kind, actor_user_id, actor_role, reason,
       request_sha256, idempotency_key_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, 'reverse', 'person_reversal', 'blocked', ?, ?, 'person', ?, ?,
               'Synthetic fixture reversal for repository proof only.', ?, ?, ?)`,
  ).run(
    clearanceId,
    input.tenantId,
    gate.gate_id,
    input.roofJobId,
    input.gate,
    gate.version,
    target.clearance_id,
    input.actorUserId,
    input.actorRole,
    hex64(),
    hex64(),
    input.at ?? new Date().toISOString(),
  );
  return clearanceId;
}
