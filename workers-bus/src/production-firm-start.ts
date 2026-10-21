// production-firm-start.ts - what a firm start (a roof job's schedule) rests on, read live when it
// is written, and the Crew gate entries it appends (migration 0159).
//
// `recordOperatingJobAssignment` is the only writer of `operating_job_assignments`, and it calls
// `firmStartGateEvidence` before every write. Each rule D1 holds in 0159's
// `operating_job_assignments_gate_evidence_guard` is read here first, so the route answers each
// refusal by name:
//   * the QA seed owner never schedules, because a schedule clears Crew;
//   * no active stop applies to the job, read as a Safety attestation reads it (0158), and no
//     active stop names a job or a Work Package the tenant does not have: either may be meant for
//     this job, so it holds every schedule, by its own code and with the stop's id;
//   * Deposit does not stand on a contract with no deposit while the job's latest contract is
//     another one with other terms;
//   * Weather stands on a person's attestation whose window has not ended and holds the work;
//   * no active member of the crew shares a login coordinate with the person whose attestation
//     Materials, Safety, Access or Weather stands on.
// The time rules read the real clock, as D1 reads its own. The caller's `now` stamps only the
// assignment row; the Crew entries, like every ledger entry, take D1's clock.
//
// Crew is not a person's call and has no waiver: the schedule binds it by policy. The statements
// returned here are appended in the same D1 batch as the assignment, before it, so 0098's six-gate
// check sees Crew bound and the entries and the assignment commit together or not at all:
//   * Crew blocked: one `clear` / `crew_assignment`, bound to the crew at its version;
//   * Crew bound to that crew at that version already: nothing;
//   * Crew standing on another crew, another version or a pre-ledger entry: a `reverse` /
//     `crew_superseded` of that entry, then the `clear`.
// A later hold on firm starts (A5's cancellation window) is one more check in
// `firmStartGateEvidence` and one more BEFORE INSERT trigger on `operating_job_assignments`.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { safetyStopActive, unknownJobStop, unknownWorkPackageStop } from "./production-job-stops.ts";

export const CREW_GATE_POLICY_VERSION = "ironwrap.crew-gate.v1";
/** D1's clock, in the form `Date.toISOString` writes: the policy's own rows take D1's time. */
const D1_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const QA_SEED_OWNER_CREATED_BY = "system:owner_directed_qa_seed_grant";
/** The gates 0098 admits a schedule on before Crew, which the schedule itself binds. */
const EVIDENCE_GATES = ["Deposit", "Materials", "Safety", "Access", "Weather"] as const;
const NON_BLOCKING_STATES = new Set(["ready", "complete", "waived"]);

export interface FirmStartInput {
  tenantId: string;
  roofJobId: string;
  /** The job version the schedule was written against, as 0098 checks it. */
  roofJobVersion: number;
  assignmentId: string;
  crewId: string;
  crewVersion: number;
  scheduledStart: string;
  scheduledEnd: string | null;
  actorUserId: string;
}

export type FirmStartGateEvidence =
  | { ok: true; crewEntries: D1PreparedStatement[] }
  | { ok: false; code: string; detail?: Readonly<Record<string, string>> };

/** A scheduling gate and the entry it stands on now: the one its current version was produced by. */
interface GateInForce {
  gate_id: string;
  gate: string;
  state: string;
  version: number;
  clearance_id: string | null;
  basis: string | null;
  actor_kind: string | null;
  attestation_json: string | null;
  evidence_refs_json: string | null;
  contract_binding_id: string | null;
}

interface CrewBinding {
  assignment_id: string;
  crew_id: string;
  crew_version: number;
}

const refused = (code: string, detail?: Readonly<Record<string, string>>): FirmStartGateEvidence =>
  detail ? { ok: false, code, detail } : { ok: false, code };

function parsedObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function gatesInForce(env: AppEnv, tenantId: string, roofJobId: string) {
  const rows = await env.DB.prepare(
    `SELECT gate.gate_id, gate.gate, gate.state, gate.version, entry.clearance_id, entry.basis,
            entry.actor_kind, entry.attestation_json, entry.evidence_refs_json,
            entry.contract_binding_id
       FROM operating_production_gates gate
       LEFT JOIN production_gate_clearances entry
         ON entry.tenant_id = gate.tenant_id
        AND entry.gate_id = gate.gate_id
        AND entry.from_gate_version + 1 = gate.version
        AND entry.to_state = gate.state
      WHERE gate.tenant_id = ? AND gate.roof_job_id = ?
        AND gate.gate IN ('Deposit', 'Materials', 'Safety', 'Access', 'Weather', 'Crew')`,
  ).bind(tenantId, roofJobId).all<GateInForce>();
  return new Map((rows.results ?? []).map((row) => [row.gate, row]));
}

/**
 * Whether Deposit stands on a contract with no deposit while the job's latest contract is another
 * one with other terms: the window before the policy's `contract_superseded` entry lands. Only the
 * latest contract counts, as the policy acts only on it; a latest contract that again has no
 * deposit and is paid on completion leaves Deposit standing, as 0159 does.
 */
async function depositContractSuperseded(
  env: AppEnv,
  tenantId: string,
  deposit: GateInForce,
): Promise<boolean> {
  if (deposit.basis !== "contract_no_deposit" || !deposit.contract_binding_id) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       FROM commercial_acceptance_bindings binding
       JOIN commercial_acceptance_bindings latest
         ON latest.tenant_id = binding.tenant_id
        AND latest.roof_job_id = binding.roof_job_id
        AND latest.acceptance_binding_id != binding.acceptance_binding_id
        AND NOT EXISTS (
          SELECT 1 FROM commercial_acceptance_bindings later
           WHERE later.tenant_id = latest.tenant_id
             AND later.roof_job_id = latest.roof_job_id
             AND (later.accepted_at > latest.accepted_at
                  OR (later.accepted_at = latest.accepted_at
                      AND later.acceptance_binding_id > latest.acceptance_binding_id))
        )
       LEFT JOIN commercial_quote_revisions quote
         ON quote.tenant_id = latest.tenant_id
        AND quote.quote_revision_id = latest.quote_revision_id
      WHERE binding.tenant_id = ? AND binding.acceptance_binding_id = ?
        AND NOT (
          quote.quote_revision_id IS NOT NULL
          AND json_type(quote.terms_json, '$.deposit_percent') IS 'integer'
          AND json_extract(quote.terms_json, '$.deposit_percent') = 0
          AND json_type(quote.terms_json, '$.payment_schedule') IS 'array'
          AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
          AND json_extract(quote.terms_json, '$.payment_schedule[0]') IS 'completion'
        )
      LIMIT 1`,
  ).bind(tenantId, deposit.contract_binding_id).first();
  return row !== null;
}

/**
 * Why Weather does not hold the work, or null. The window comes from the person's attestation the
 * gate stands on; a gate with none, or whose window has ended, holds nothing. A schedule with no
 * end is held to its start.
 */
function weatherRefusal(weather: GateInForce, input: FirmStartInput, nowMs: number): string | null {
  const attestation = weather.basis === "person_attestation"
    ? parsedObject(weather.attestation_json)
    : null;
  const start = typeof attestation?.window_start === "string"
    ? Date.parse(attestation.window_start)
    : Number.NaN;
  const end = typeof attestation?.window_end === "string"
    ? Date.parse(attestation.window_end)
    : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= nowMs) {
    return "operating_job_assignment_weather_window_ended";
  }
  const workStart = Date.parse(input.scheduledStart);
  const workEnd = Date.parse(input.scheduledEnd ?? input.scheduledStart);
  return workStart >= start && workEnd <= end
    ? null
    : "operating_job_assignment_outside_weather_window";
}

/**
 * Whether an active member of the crew shares a login coordinate (user id, email or Frappe user)
 * with a person whose attestation one of the job's gates stands on, compared as 0158 compares an
 * attester with every crew.
 */
async function crewShareAttester(
  env: AppEnv,
  input: FirmStartInput,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       FROM operating_production_gates gate
       JOIN production_gate_clearances attested
         ON attested.tenant_id = gate.tenant_id
        AND attested.gate_id = gate.gate_id
        AND attested.from_gate_version + 1 = gate.version
        AND attested.to_state = gate.state
       JOIN app_users attester
         ON attester.tenant_id = attested.tenant_id
        AND attester.user_id = attested.actor_user_id
       JOIN fleet_crew_members membership
         ON membership.tenant_id = gate.tenant_id
        AND membership.crew_id = ?
        AND membership.active = 1
       JOIN app_users worker
         ON worker.tenant_id = membership.tenant_id
        AND worker.user_id = membership.user_id
      WHERE gate.tenant_id = ? AND gate.roof_job_id = ?
        AND gate.gate IN ('Materials', 'Safety', 'Access', 'Weather')
        AND attested.basis = 'person_attestation'
        AND (
          lower(worker.user_id) IN (
            lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
          )
          OR worker.email_normalized IN (
            lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
          )
          OR lower(trim(worker.frappe_user_id)) IN (
            lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
          )
        )
      LIMIT 1`,
  ).bind(input.crewId, input.tenantId, input.roofJobId).first();
  return row !== null;
}

/** The crew a `crew_assignment` entry binds, or null when the entry binds none. */
function boundCrew(entry: GateInForce): CrewBinding | null {
  if (entry.actor_kind !== "policy" || entry.basis !== "crew_assignment") return null;
  const evidence = parsedObject(entry.evidence_refs_json);
  return evidence && typeof evidence.assignment_id === "string" &&
      typeof evidence.crew_id === "string" && Number.isInteger(evidence.crew_version)
    ? {
      assignment_id: evidence.assignment_id,
      crew_id: evidence.crew_id,
      crew_version: evidence.crew_version as number,
    }
    : null;
}

/**
 * One policy entry on Crew. Its key is made of the assignment with "/", outside the alphabet a
 * person's Idempotency-Key may use, so no person entry can take it; a retried schedule finds its
 * assignment first and never appends twice.
 */
async function crewEntry(
  env: AppEnv,
  input: FirmStartInput,
  crew: GateInForce,
  entry: {
    kind: "clear" | "reverse";
    fromVersion: number;
    reversesId: string | null;
  },
): Promise<D1PreparedStatement> {
  const basis = entry.kind === "clear" ? "crew_assignment" : "crew_superseded";
  const toState = entry.kind === "clear" ? "complete" : "blocked";
  const keyHash = await sha256Hex(
    `policy/${CREW_GATE_POLICY_VERSION}/${basis}/${input.assignmentId}`,
  );
  const clearanceId = `pgc_${(await sha256Hex(`${input.tenantId}:${keyHash}`)).slice(0, 40)}`;
  const evidence = canonicalJson({
    assignment_id: input.assignmentId,
    crew_id: input.crewId,
    crew_version: input.crewVersion,
  });
  const requestSha256 = await sha256Hex(canonicalJson({
    route: "crew_gate_policy",
    tenant_id: input.tenantId,
    gate_id: crew.gate_id,
    entry_kind: entry.kind,
    basis,
    reverses_id: entry.reversesId,
    evidence,
  }));
  return env.DB.prepare(
    `INSERT INTO production_gate_clearances (
       clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
       from_gate_version, reverses_id, actor_kind, policy_version, evidence_refs_json,
       request_sha256, idempotency_key_hash, created_at
     ) VALUES (?, ?, ?, ?, 'Crew', ?, ?, ?, ?, ?, 'policy', ?, ?, ?, ?, ${D1_NOW})`,
  ).bind(
    clearanceId,
    input.tenantId,
    crew.gate_id,
    input.roofJobId,
    entry.kind,
    basis,
    toState,
    entry.fromVersion,
    entry.reversesId,
    CREW_GATE_POLICY_VERSION,
    evidence,
    requestSha256,
    keyHash,
  );
}

/**
 * Read what the firm start rests on, in the order D1 refuses it, and return the Crew entries the
 * schedule's batch appends before the assignment, or the first refusal by name.
 */
export async function firmStartGateEvidence(
  env: AppEnv,
  input: FirmStartInput,
): Promise<FirmStartGateEvidence> {
  const [job, gates, crewRow, roster, actor] = await Promise.all([
    env.DB.prepare(
      `SELECT version, job_status FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
    ).bind(input.tenantId, input.roofJobId).first<{ version: number; job_status: string }>(),
    gatesInForce(env, input.tenantId, input.roofJobId),
    env.DB.prepare(
      `SELECT version, status FROM fleet_crews WHERE tenant_id = ? AND crew_id = ?`,
    ).bind(input.tenantId, input.crewId).first<{ version: number; status: string }>(),
    // The active members, and how many of them are active field users, as 0098 counts them.
    env.DB.prepare(
      `SELECT COUNT(*) AS members,
              COALESCE(SUM(CASE WHEN worker.active = 1 AND worker.access_role = 'field'
                           THEN 1 ELSE 0 END), 0) AS field_users
         FROM fleet_crew_members membership
         LEFT JOIN app_users worker
           ON worker.tenant_id = membership.tenant_id
          AND worker.user_id = membership.user_id
        WHERE membership.tenant_id = ? AND membership.crew_id = ? AND membership.active = 1`,
    ).bind(input.tenantId, input.crewId).first<{ members: number; field_users: number }>(),
    env.DB.prepare(
      `SELECT active, access_role, created_by FROM app_users WHERE tenant_id = ? AND user_id = ?`,
    ).bind(input.tenantId, input.actorUserId)
      .first<{ active: number; access_role: string | null; created_by: string }>(),
  ]);

  // 0098's rules first, in its order, as its re-created trigger fires first. Crew is the schedule's
  // to bind.
  if (
    !job || Number(job.version) !== input.roofJobVersion ||
    job.job_status === "complete" || job.job_status === "cancelled"
  ) {
    return refused("operating_job_assignment_job_invalid");
  }
  const crew = gates.get("Crew");
  if (
    !crew ||
    EVIDENCE_GATES.some((name) => !NON_BLOCKING_STATES.has(gates.get(name)?.state ?? ""))
  ) {
    return refused("operating_job_assignment_gates_blocked");
  }
  if (
    !crewRow || crewRow.status !== "Active" || Number(crewRow.version) !== input.crewVersion
  ) {
    return refused("operating_job_assignment_crew_invalid");
  }
  if (
    !actor || Number(actor.active) !== 1 ||
    !["owner", "ops", "production"].includes(actor.access_role ?? "")
  ) {
    return refused("operating_job_assignment_actor_invalid");
  }
  if (!roster || Number(roster.members) === 0 || Number(roster.field_users) !== Number(roster.members)) {
    return refused("operating_job_assignment_roster_invalid");
  }

  // 0159's rules, in its order.
  if (actor?.created_by === QA_SEED_OWNER_CREATED_BY) {
    return refused("operating_job_assignment_seed_identity_refused");
  }
  const unknownJob = await unknownJobStop(env, input.tenantId);
  if (unknownJob) return refused("operating_job_assignment_stop_job_unknown", { stop_id: unknownJob });
  const unknownPackage = await unknownWorkPackageStop(env, input.tenantId);
  if (unknownPackage) {
    return refused("operating_job_assignment_stop_work_package_unknown", { stop_id: unknownPackage });
  }
  if (await safetyStopActive(env, input.tenantId, input.roofJobId)) {
    return refused("operating_job_assignment_stop_active");
  }
  if (await depositContractSuperseded(env, input.tenantId, gates.get("Deposit")!)) {
    return refused("operating_job_assignment_deposit_contract_superseded");
  }
  const weather = weatherRefusal(gates.get("Weather")!, input, Date.now());
  if (weather) return refused(weather);
  if (await crewShareAttester(env, input)) {
    return refused("operating_job_assignment_crew_not_independent");
  }

  const version = Number(crew.version);
  const bound = boundCrew(crew);
  if (
    crew.state === "complete" && bound?.crew_id === input.crewId &&
    bound.crew_version === input.crewVersion
  ) {
    return { ok: true, crewEntries: [] };
  }
  if (crew.state === "blocked") {
    return {
      ok: true,
      crewEntries: [await crewEntry(env, input, crew, {
        kind: "clear",
        fromVersion: version,
        reversesId: null,
      })],
    };
  }
  // Crew stands on another crew or version, or on an entry from before the ledger: the schedule
  // reverses that entry and binds its own crew in the same batch.
  if (!crew.clearance_id) return refused("operating_job_assignment_crew_gate_unbound");
  return {
    ok: true,
    crewEntries: [
      await crewEntry(env, input, crew, {
        kind: "reverse",
        fromVersion: version,
        reversesId: crew.clearance_id,
      }),
      await crewEntry(env, input, crew, {
        kind: "clear",
        fromVersion: version + 1,
        reversesId: null,
      }),
    ],
  };
}
