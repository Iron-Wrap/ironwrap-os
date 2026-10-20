import type { AppEnv } from "./app-types.ts";
import {
  parseAuthorityRequirements,
  type AuthorityRequirement,
} from "./authority-records.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { firmStartGateEvidence } from "./production-firm-start.ts";

export interface RecordOperatingJobAssignmentInput {
  tenantId: string;
  roofJobId: string;
  expectedRoofJobVersion: number;
  crewId: string;
  expectedCrewVersion: number;
  authorityRequirements: AuthorityRequirement[];
  scheduledStart: string;
  scheduledEnd?: string | null;
  supersedesAssignmentId?: string | null;
  correctionReason?: string | null;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OperatingJobAssignmentRecord {
  assignment_id: string;
  tenant_id: string;
  roof_job_id: string;
  assignment_version: number;
  roof_job_version: number;
  crew_id: string;
  crew_version: number;
  assigned_users: string[];
  authority_requirements: AuthorityRequirement[] | null;
  authority_requirements_json: string | null;
  authority_requirements_sha256: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  supersedes_assignment_id: string | null;
  correction_reason: string | null;
  actor_user_id: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

interface AssignmentRow extends Omit<
  OperatingJobAssignmentRecord,
  "assigned_users" | "authority_requirements"
> {
  assigned_users_json: string;
}

export class OperatingJobAssignmentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "OperatingJobAssignmentError";
  }
}

export async function recordOperatingJobAssignment(
  env: AppEnv,
  input: RecordOperatingJobAssignmentInput,
  now = new Date(),
): Promise<{
  kind: "created" | "replayed";
  assignment: OperatingJobAssignmentRecord;
}> {
  const command = normalizedCommand(input);
  const commandFingerprint = await sha256Hex(canonicalJson(command));
  const idempotencyKeyHash = await sha256Hex(
    boundedText(
      input.idempotencyKey,
      8,
      280,
      "operating_job_assignment_idempotency_invalid",
    ),
  );
  const existing = await assignmentByIdempotency(
    env,
    command.tenant_id,
    idempotencyKeyHash,
  );
  if (existing) return replay(existing, commandFingerprint);

  const current = await getCurrentOperatingJobAssignment(
    env,
    command.tenant_id,
    command.roof_job_id,
  );
  if (
    current
      ? command.supersedes_assignment_id !== current.assignment_id ||
        !command.correction_reason
      : command.supersedes_assignment_id !== null ||
        command.correction_reason !== null
  ) {
    fail("operating_job_assignment_chain_conflict");
  }

  const roster = await activeCrewRoster(
    env,
    command.tenant_id,
    command.crew_id,
  );
  if (roster.length === 0) fail("operating_job_assignment_roster_invalid");
  const createdAt = instant(
    now.toISOString(),
    "operating_job_assignment_time_invalid",
  );
  const assignmentId = `assignment:${(await sha256Hex(`${command.tenant_id}:${idempotencyKeyHash}`)).slice(0, 40)}`;
  const assignmentVersion = current ? current.assignment_version + 1 : 1;
  // The gate evidence the firm start rests on, read live, and the Crew entries it appends by policy
  // (migration 0159). This is the one check every firm start passes.
  const gates = await firmStartGateEvidence(env, {
    tenantId: command.tenant_id,
    roofJobId: command.roof_job_id,
    roofJobVersion: command.expected_roof_job_version,
    assignmentId,
    crewId: command.crew_id,
    crewVersion: command.expected_crew_version,
    scheduledStart: command.scheduled_start,
    scheduledEnd: command.scheduled_end,
    actorUserId: command.actor_user_id,
  });
  if (!gates.ok) fail(gates.code);
  const insert = env.DB.prepare(
    `INSERT INTO operating_job_assignments (
       assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version,
       crew_id, crew_version, assigned_users_json, scheduled_start, scheduled_end,
       authority_requirements_json, authority_requirements_sha256,
       supersedes_assignment_id, correction_reason, actor_user_id,
       command_fingerprint, idempotency_key_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    assignmentId,
    command.tenant_id,
    command.roof_job_id,
    assignmentVersion,
    command.expected_roof_job_version,
    command.crew_id,
    command.expected_crew_version,
    canonicalJson(roster),
    command.scheduled_start,
    command.scheduled_end,
    canonicalJson(command.authority_requirements),
    await sha256Hex(canonicalJson(command.authority_requirements)),
    command.supersedes_assignment_id,
    command.correction_reason,
    command.actor_user_id,
    commandFingerprint,
    idempotencyKeyHash,
    createdAt,
  );
  try {
    // One batch: the Crew entries and the assignment commit together or not at all.
    await env.DB.batch([...gates.crewEntries, insert]);
  } catch (error) {
    const concurrent = await assignmentByIdempotency(
      env,
      command.tenant_id,
      idempotencyKeyHash,
    );
    if (concurrent) return replay(concurrent, commandFingerprint);
    // A gate that moved between the read above and the batch answers with the ledger's own code.
    const message = error instanceof Error ? error.message : String(error);
    const ledger = message.match(/\bproduction_gate_[a-z_]+/)?.[0];
    if (ledger && !message.includes("operating_job_assignment_")) fail(ledger);
    throw error;
  }
  const assignment = await assignmentById(env, command.tenant_id, assignmentId);
  if (!assignment) fail("operating_job_assignment_write_failed");
  return { kind: "created", assignment };
}

export async function getCurrentOperatingJobAssignment(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<OperatingJobAssignmentRecord | null> {
  const row = await env.DB.prepare(
    `SELECT current.*
       FROM operating_job_assignments current
      WHERE current.tenant_id = ?
        AND current.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1
            FROM operating_job_assignments successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_assignment_id = current.assignment_id
        )
      LIMIT 1`,
  )
    .bind(
      tenant(tenantId),
      roofJobIdValue(roofJobId),
    )
    .first<AssignmentRow>();
  return row ? await fromRow(row) : null;
}

export async function listCurrentOperatingJobAssignments(
  env: AppEnv,
  tenantId: string,
  options: { roofJobId?: string; actorUsers?: readonly string[] } = {},
): Promise<OperatingJobAssignmentRecord[]> {
  const clauses = [
    "current.tenant_id = ?",
    `NOT EXISTS (
      SELECT 1 FROM operating_job_assignments successor
       WHERE successor.tenant_id = current.tenant_id
         AND successor.supersedes_assignment_id = current.assignment_id
    )`,
  ];
  const bindings: unknown[] = [tenant(tenantId)];
  if (options.roofJobId) {
    clauses.push("current.roof_job_id = ?");
    bindings.push(roofJobIdValue(options.roofJobId));
  }
  const actorUsers = [
    ...new Set(
      (options.actorUsers ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 3);
  if (actorUsers.length > 0) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM json_each(current.assigned_users_json) worker
         WHERE lower(worker.value) IN (${actorUsers.map(() => "?").join(", ")})
      )`,
    );
    bindings.push(...actorUsers);
  }
  const rows = await env.DB.prepare(
    `SELECT current.*
       FROM operating_job_assignments current
      WHERE ${clauses.join(" AND ")}
      ORDER BY current.scheduled_start ASC, current.assignment_id ASC
      LIMIT 100`,
  )
    .bind(...bindings)
    .all<AssignmentRow>();
  return await Promise.all(rows.results.map(fromRow));
}

function normalizedCommand(input: RecordOperatingJobAssignmentInput) {
  const scheduledStart = instant(
    input.scheduledStart,
    "operating_job_assignment_start_invalid",
  );
  const scheduledEnd = nullableInstant(
    input.scheduledEnd,
    "operating_job_assignment_end_invalid",
  );
  if (scheduledEnd && scheduledEnd <= scheduledStart)
    fail("operating_job_assignment_end_invalid");
  return Object.freeze({
    schema_version: "ironwrap.operating-job-assignment.v1",
    tenant_id: tenant(input.tenantId),
    roof_job_id: roofJobIdValue(input.roofJobId),
    expected_roof_job_version: positiveInteger(
      input.expectedRoofJobVersion,
      "operating_job_assignment_job_version_invalid",
    ),
    crew_id: entityId(input.crewId, "operating_job_assignment_crew_id_invalid"),
    expected_crew_version: positiveInteger(
      input.expectedCrewVersion,
      "operating_job_assignment_crew_version_invalid",
    ),
    authority_requirements: parseAuthorityRequirements(
      input.authorityRequirements,
    ),
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    supersedes_assignment_id: nullableEntityId(
      input.supersedesAssignmentId,
      "operating_job_assignment_predecessor_invalid",
    ),
    correction_reason: nullableText(
      input.correctionReason,
      3,
      1_200,
      "operating_job_assignment_correction_invalid",
    ),
    actor_user_id: entityId(
      input.actorUserId,
      "operating_job_assignment_actor_invalid",
    ),
  });
}

async function activeCrewRoster(
  env: AppEnv,
  tenantId: string,
  crewId: string,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT membership.user_id
       FROM fleet_crew_members membership
       JOIN app_users worker
         ON worker.tenant_id = membership.tenant_id
        AND worker.user_id = membership.user_id
      WHERE membership.tenant_id = ?
        AND membership.crew_id = ?
        AND membership.active = 1
        AND worker.active = 1
        AND worker.access_role = 'field'
      ORDER BY lower(membership.user_id), membership.user_id`,
  )
    .bind(tenantId, crewId)
    .all<{ user_id: string }>();
  return rows.results.map((row) => row.user_id);
}

async function assignmentByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<OperatingJobAssignmentRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM operating_job_assignments
      WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  )
    .bind(tenantId, idempotencyKeyHash)
    .first<AssignmentRow>();
  return row ? await fromRow(row) : null;
}

async function assignmentById(
  env: AppEnv,
  tenantId: string,
  assignmentId: string,
): Promise<OperatingJobAssignmentRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM operating_job_assignments
      WHERE tenant_id = ? AND assignment_id = ?`,
  )
    .bind(tenantId, assignmentId)
    .first<AssignmentRow>();
  return row ? await fromRow(row) : null;
}

async function fromRow(
  row: AssignmentRow,
): Promise<OperatingJobAssignmentRecord> {
  let assignedUsers: unknown;
  let authorityRequirements: AuthorityRequirement[] | null = null;
  const authorityRequirementsJson = row.authority_requirements_json ?? null;
  const authorityRequirementsSha256 = row.authority_requirements_sha256 ?? null;
  try {
    assignedUsers = JSON.parse(row.assigned_users_json);
    if (authorityRequirementsJson !== null) {
      authorityRequirements = parseAuthorityRequirements(
        authorityRequirementsJson,
      );
    }
  } catch {
    fail("operating_job_assignment_snapshot_corrupt");
  }
  if (
    !Array.isArray(assignedUsers) ||
    assignedUsers.some((value) => typeof value !== "string")
  ) {
    fail("operating_job_assignment_roster_corrupt");
  }
  if (
    (authorityRequirementsJson === null) !==
    (authorityRequirementsSha256 === null)
  ) {
    fail("operating_job_assignment_snapshot_corrupt");
  }
  const canonicalRequirements = authorityRequirements
    ? canonicalJson(authorityRequirements)
    : null;
  if (
    authorityRequirementsJson !== canonicalRequirements ||
    (authorityRequirementsSha256 !== null &&
      (!/^[0-9a-f]{64}$/.test(authorityRequirementsSha256) ||
        authorityRequirementsSha256 !==
          (await sha256Hex(canonicalRequirements!))))
  ) {
    fail("operating_job_assignment_snapshot_corrupt");
  }
  const { assigned_users_json: _assignedUsersJson, ...record } = row;
  return {
    ...record,
    assigned_users: assignedUsers,
    authority_requirements: authorityRequirements,
    authority_requirements_json: authorityRequirementsJson,
    authority_requirements_sha256: authorityRequirementsSha256,
  };
}

function replay(
  assignment: OperatingJobAssignmentRecord,
  commandFingerprint: string,
): { kind: "replayed"; assignment: OperatingJobAssignmentRecord } {
  if (assignment.command_fingerprint !== commandFingerprint) {
    fail("operating_job_assignment_idempotency_conflict");
  }
  return { kind: "replayed", assignment };
}

function tenant(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    fail("operating_job_assignment_tenant_invalid");
  }
  return value;
}

function entityId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    fail(code);
  return value;
}

function roofJobIdValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    fail("operating_job_assignment_job_id_invalid");
  return value;
}

function nullableEntityId(value: unknown, code: string): string | null {
  return value === undefined || value === null ? null : entityId(value, code);
}

function boundedText(
  value: unknown,
  min: number,
  max: number,
  code: string,
): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) fail(code);
  return normalized;
}

function nullableText(
  value: unknown,
  min: number,
  max: number,
  code: string,
): string | null {
  return value === undefined || value === null
    ? null
    : boundedText(value, min, max, code);
}

function positiveInteger(value: unknown, code: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 1_000_000
  )
    fail(code);
  return Number(value);
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    fail(code);
  return value;
}

function nullableInstant(value: unknown, code: string): string | null {
  return value === undefined || value === null ? null : instant(value, code);
}

function fail(code: string): never {
  throw new OperatingJobAssignmentError(code);
}
