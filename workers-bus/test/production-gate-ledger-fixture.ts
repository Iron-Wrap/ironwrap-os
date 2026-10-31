// production-gate-ledger-fixture.ts - stand a fixture job's gates at a state through the gate ledger.
//
// Since migration 0153 a production gate changes only by an entry in `production_gate_clearances`,
// and no entry a person may append yet clears Safety, Weather or Crew: attestation and Crew by
// policy come with later changes. A fixture that schedules a job therefore records its gates the
// way 0153's backfill records a gate cleared before the ledger existed: each changed gate moves to
// its next version with one `legacy` entry and that entry's audit row. The ledger's guards are
// lifted for this write and restored exactly as they were. No product path does this; product
// writes append entries the guards check. Once attestation and Crew-by-policy entries exist, move
// these fixtures onto them.

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
  },
): void {
  const state = input.state ?? "ready";
  const at = input.at ?? new Date().toISOString();
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
         ) VALUES (?, ?, ?, ?, ?, 'legacy', '(none)', ?, ?, ?)`,
      ).run(clearanceId, input.tenantId, row.gate_id, input.roofJobId, row.gate, state, row.version, at);
      db.prepare(
        `INSERT INTO audit_log (ts, automation, trigger, source_ids, target_ids, action, result, run_id)
         VALUES (?, 'production_gate_clearance', 'migration', ?, ?, 'legacy:(none)', 'ok', ?)`,
      ).run(
        at,
        `job:${input.roofJobId},gate:${row.gate},from_version:${row.version},to_state:${state}`,
        `production_gate_clearance:${clearanceId},production_gate:${row.gate_id}`,
        clearanceId,
      );
    }
  } finally {
    for (const guard of guards) db.exec(guard.sql);
  }
}
