// production-gate-ledger-fixture.ts - stand a fixture job's gates at a state through the gate ledger.
//
// Since migration 0153 a production gate changes only by an entry in `production_gate_clearances`,
// and every helper here appends its entries through every guard, the way the routes and the
// schedule do; none writes a gate row:
//   * `attestGateInLedger`: a person attests Materials, Access, Weather or Safety (0158). Safety
//     first records the attester's current internal Worker Competency.
//   * `waiveGateInLedger`: the owner waives Deposit, Materials or Access (0153).
//   * `reverseGateInLedger`: a person reverses the entry a gate stands on (0158).
//   * `clearScheduleGatesInLedger`: the five gates a schedule rests on, cleared by people.
//   * `bindCrewInLedger`: Crew bound by policy the way a schedule binds it (0159), for a fixture
//     that writes its assignment row with direct SQL; `recordOperatingJobAssignment` appends the
//     same entries itself.
// A schedule must fall inside the Weather window, which D1 checks against its own clock, so the
// window and the schedules inside it are relative to the real clock (`fixtureWeatherWindow`,
// `fixtureSchedule`).

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SCHEDULING_GATES = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const hex64 = () => randomBytes(32).toString("hex");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const REASON = "Synthetic fixture decision for repository proof only.";

/**
 * The work window a fixture's Weather attestation names unless it says otherwise: from a day ago
 * to eleven days ahead of the real clock, on a forecast observed an hour ago.
 */
export function fixtureWeatherWindow(nowMs = Date.now()): { start: string; end: string } {
  return {
    start: new Date(nowMs - DAY_MS).toISOString(),
    end: new Date(nowMs + 11 * DAY_MS).toISOString(),
  };
}

/** An eight-hour working day `days` ahead of the real clock, inside the default window. */
export function fixtureSchedule(days = 1, nowMs = Date.now()): { start: string; end: string } {
  const start = new Date(Math.floor((nowMs + days * DAY_MS) / HOUR_MS) * HOUR_MS);
  return { start: start.toISOString(), end: new Date(start.getTime() + 8 * HOUR_MS).toISOString() };
}

function currentGate(
  db: DatabaseSync,
  input: { tenantId: string; roofJobId: string; gate: string },
): { gate_id: string; version: number; state: string } {
  const row = db.prepare(
    `SELECT gate_id, version, state FROM operating_production_gates
      WHERE tenant_id = ? AND roof_job_id = ? AND gate = ?`,
  ).get(input.tenantId, input.roofJobId, input.gate) as
    | { gate_id: string; version: number; state: string }
    | undefined;
  if (!row) throw new Error(`fixture gate ${input.gate} is missing`);
  return row;
}

function append(db: DatabaseSync, row: Record<string, unknown>): string {
  const clearanceId = String(row.clearance_id ?? `pgc_${randomBytes(20).toString("hex")}`);
  const entry = { clearance_id: clearanceId, ...row };
  const columns = Object.keys(entry);
  db.prepare(
    `INSERT INTO production_gate_clearances (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => entry[column as keyof typeof entry]) as never[]));
  return clearanceId;
}

/**
 * The attester's current internal Worker Competency, recorded the way an owner or operations person
 * records a readback: verified by an internal assessment, in force today and bound to no job.
 */
function recordCompetency(
  db: DatabaseSync,
  input: { tenantId: string; personUser: string; observerUserId: string },
): Record<string, unknown> {
  const id = randomBytes(8).toString("hex");
  const day = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
  const row: Record<string, unknown> = {
    readback_id: `readback.fixture.${id}`,
    tenant_id: input.tenantId,
    authority_record_id: `competency_fixture_${id}`,
    authority_version: 1,
    subject_type: "Person",
    subject_role: "Worker",
    person_user: input.personUser,
    organization: null,
    authority_kind: "Worker Competency",
    authority_scope: "Site hazard assessment and fall protection",
    scope_type: "Tenant",
    scope_ref: input.tenantId,
    roof_job: null,
    scope_json: "{}",
    issuer_name: input.tenantId,
    issuer_jurisdiction: "AB-CA",
    issuer_reference: "internal:competency:fixture",
    issuer_source_version: "1",
    verification_state: "verified",
    evidence_refs_json: "[]",
    evidence_sha256: sha256(`competency-evidence:${id}`),
    authority_state_digest_sha256: sha256(`competency-state:${id}`),
    authority_effective_from: day(-30),
    authority_expires_at: day(365),
    authority_revoked_at: null,
    supersedes_authority_record_id: null,
    authority_verification_method: "Internal Competency Assessment",
    issuer_receipt_sha256: null,
    observed_by_user_id: input.observerUserId,
    observed_at: new Date(Date.now() - HOUR_MS).toISOString(),
    observation_fingerprint_sha256: sha256(`competency-fingerprint:${id}`),
    action_id: null,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO authority_record_readbacks (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
  return {
    readback_id: row.readback_id,
    authority_record_id: row.authority_record_id,
    authority_version: row.authority_version,
    state_digest_sha256: row.authority_state_digest_sha256,
  };
}

/**
 * Attest a gate the way the attestation route does, through every ledger guard: one `clear` /
 * `person_attestation` entry by an owner or production person who is on no crew, with the gate's
 * typed attestation and no evidence. Weather's window defaults to `fixtureWeatherWindow()` and its
 * forecast was observed an hour ago, on the real clock D1 checks them against. Safety first records
 * the attester's competency, observed by `observerUserId` (an active owner or operations user;
 * the attester by default).
 */
export function attestGateInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    gate: "Materials" | "Access" | "Weather" | "Safety";
    actorUserId: string;
    actorRole: "owner" | "production";
    window?: { start: string; end: string };
    observerUserId?: string;
    at?: string;
  },
): string {
  const now = Date.now();
  const instant = (offsetHours: number) => new Date(now + offsetHours * HOUR_MS).toISOString();
  const window = input.window ?? fixtureWeatherWindow(now);
  const attestation = input.gate === "Materials"
    ? { reference: "DELIVERY-FIXTURE-0001", source: "supplier_delivery" }
    : input.gate === "Access"
    ? { confirmed_at: instant(-1), confirmed_with: "customer" }
    : input.gate === "Weather"
    ? {
      forecast_observed_at: instant(-1),
      forecast_source: "weather.gc.ca",
      window_end: window.end,
      window_start: window.start,
    }
    : {
      assessed_at: instant(-1),
      competency: recordCompetency(db, {
        tenantId: input.tenantId,
        personUser: input.actorUserId,
        observerUserId: input.observerUserId ?? input.actorUserId,
      }),
      fall_protection: { no_exposure_at_3m: true },
      hazard_assessment_ref: "FLHA-FIXTURE-0001",
    };
  const gate = currentGate(db, input);
  return append(db, {
    tenant_id: input.tenantId,
    gate_id: gate.gate_id,
    roof_job_id: input.roofJobId,
    gate: input.gate,
    entry_kind: "clear",
    basis: "person_attestation",
    to_state: "ready",
    from_gate_version: gate.version,
    actor_kind: "person",
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    attestation_json: JSON.stringify(attestation),
    evidence_refs_json: "[]",
    request_sha256: hex64(),
    idempotency_key_hash: hex64(),
    created_at: input.at ?? new Date(now).toISOString(),
  });
}

/**
 * Waive Deposit, Materials or Access the way the waiver routes do (0153): an owner decides, never
 * their own request while another active owner can decide it. The requester (an owner or
 * production person; the owner by default) requests the waiver and another owner decides it; an
 * owner who is the only active one approves their own item with a reason (D-08).
 */
export function waiveGateInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    gate: "Deposit" | "Materials" | "Access";
    ownerUserId: string;
    requesterUserId?: string;
    requesterRole?: "owner" | "production";
    at?: string;
  },
): string {
  const at = input.at ?? new Date().toISOString();
  const requester = input.requesterUserId ?? input.ownerUserId;
  let decider = input.ownerUserId;
  if (requester === decider) {
    const other = db.prepare(
      `SELECT user_id FROM app_users
        WHERE tenant_id = ? AND user_id != ? AND active = 1 AND access_role = 'owner'
          AND created_by != 'system:owner_directed_qa_seed_grant'
        ORDER BY user_id LIMIT 1`,
    ).get(input.tenantId, requester) as { user_id: string } | undefined;
    if (other) decider = other.user_id;
  }
  let requestId: string | null = null;
  if (requester !== decider) {
    const gate = currentGate(db, input);
    requestId = append(db, {
      tenant_id: input.tenantId,
      gate_id: gate.gate_id,
      roof_job_id: input.roofJobId,
      gate: input.gate,
      entry_kind: "waiver_request",
      basis: "office_waiver",
      to_state: "blocked",
      from_gate_version: gate.version,
      actor_kind: "person",
      actor_user_id: requester,
      actor_role: input.requesterRole ?? (requester === input.ownerUserId ? "owner" : "production"),
      reason: REASON,
      request_sha256: hex64(),
      idempotency_key_hash: hex64(),
      created_at: at,
    });
  }
  const gate = currentGate(db, input);
  return append(db, {
    tenant_id: input.tenantId,
    gate_id: gate.gate_id,
    roof_job_id: input.roofJobId,
    gate: input.gate,
    entry_kind: "waiver_decision",
    basis: "office_waiver",
    to_state: "waived",
    from_gate_version: gate.version,
    request_id: requestId,
    actor_kind: "person",
    actor_user_id: decider,
    actor_role: "owner",
    requested_by: requester,
    self_approval: requestId === null ? 1 : 0,
    self_approval_basis: requestId === null ? "only_holder" : null,
    reason: REASON,
    request_sha256: hex64(),
    idempotency_key_hash: hex64(),
    created_at: at,
  });
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
  return append(db, {
    tenant_id: input.tenantId,
    gate_id: gate.gate_id,
    roof_job_id: input.roofJobId,
    gate: input.gate,
    entry_kind: "reverse",
    basis: "person_reversal",
    to_state: "blocked",
    from_gate_version: gate.version,
    reverses_id: target.clearance_id,
    actor_kind: "person",
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    reason: "Synthetic fixture reversal for repository proof only.",
    request_sha256: hex64(),
    idempotency_key_hash: hex64(),
    created_at: input.at ?? new Date().toISOString(),
  });
}

/**
 * Clear the five gates a schedule rests on the way people do, so the job can be scheduled; the
 * schedule itself binds Crew by policy. Deposit is waived by the owner (requested by the attester
 * when that is someone else). Materials, Safety, Access and Weather are attested by the attester,
 * an owner or production person on no crew; Weather names `window` (by default
 * `fixtureWeatherWindow()`), which every schedule of the job must fall inside.
 */
export function clearScheduleGatesInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    ownerUserId: string;
    attesterUserId: string;
    attesterRole: "owner" | "production";
    window?: { start: string; end: string };
    observerUserId?: string;
  },
): { start: string; end: string } {
  const window = input.window ?? fixtureWeatherWindow();
  const job = { tenantId: input.tenantId, roofJobId: input.roofJobId };
  waiveGateInLedger(db, {
    ...job,
    gate: "Deposit",
    ownerUserId: input.ownerUserId,
    requesterUserId: input.attesterUserId,
    requesterRole: input.attesterRole,
  });
  for (const gate of ["Materials", "Safety", "Access", "Weather"] as const) {
    attestGateInLedger(db, {
      ...job,
      gate,
      actorUserId: input.attesterUserId,
      actorRole: input.attesterRole,
      window,
      observerUserId: input.observerUserId,
    });
  }
  return window;
}

/**
 * Bind Crew the way a schedule does (0159), for a fixture that inserts its assignment row with
 * direct SQL right after: a policy `clear` / `crew_assignment` naming the assignment, the crew and
 * its version, preceded by the `crew_superseded` reversal when Crew stands on another binding.
 */
export function bindCrewInLedger(
  db: DatabaseSync,
  input: {
    tenantId: string;
    roofJobId: string;
    crewId: string;
    crewVersion?: number;
    assignmentId: string;
    at?: string;
  },
): string {
  const at = input.at ?? new Date().toISOString();
  const evidence = JSON.stringify({
    assignment_id: input.assignmentId,
    crew_id: input.crewId,
    crew_version: input.crewVersion ?? 1,
  });
  const policy = (gate: { gate_id: string; version: number }, row: Record<string, unknown>) =>
    append(db, {
      tenant_id: input.tenantId,
      gate_id: gate.gate_id,
      roof_job_id: input.roofJobId,
      gate: "Crew",
      from_gate_version: gate.version,
      actor_kind: "policy",
      policy_version: "ironwrap.crew-gate.v1",
      evidence_refs_json: evidence,
      request_sha256: hex64(),
      idempotency_key_hash: hex64(),
      created_at: at,
      ...row,
    });
  const crew = currentGate(db, { ...input, gate: "Crew" });
  if (crew.state !== "blocked") {
    const target = db.prepare(
      `SELECT clearance_id FROM production_gate_clearances
        WHERE tenant_id = ? AND gate_id = ? AND from_gate_version = ?`,
    ).get(input.tenantId, crew.gate_id, crew.version - 1) as { clearance_id: string };
    policy(crew, {
      entry_kind: "reverse",
      basis: "crew_superseded",
      to_state: "blocked",
      reverses_id: target.clearance_id,
    });
  }
  return policy(currentGate(db, { ...input, gate: "Crew" }), {
    entry_kind: "clear",
    basis: "crew_assignment",
    to_state: "complete",
  });
}
