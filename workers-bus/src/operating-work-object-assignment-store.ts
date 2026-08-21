import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export type OperatingWorkObjectAuthorityRole = "owner" | "production";

export interface OperatingWorkObjectScope {
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
}

export interface RecordOperatingWorkObjectAssignmentInput extends OperatingWorkObjectScope {
  tenantId: string;
  assignedUsers: string[];
  scheduledStart: string;
  scheduledEnd?: string | null;
  authorityUserId: string;
  authorityRole: OperatingWorkObjectAuthorityRole;
  supersedesAssignmentId?: string | null;
  correctionReason?: string | null;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OperatingWorkObjectAssignmentRecord {
  assignment_id: string;
  tenant_id: string;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  assignment_version: number;
  assigned_users: string[];
  scheduled_start: string;
  scheduled_end: string | null;
  authority_user_id: string;
  authority_role: OperatingWorkObjectAuthorityRole;
  supersedes_assignment_id: string | null;
  correction_reason: string | null;
  actor_user_id: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

interface AssignmentRow extends Omit<
  OperatingWorkObjectAssignmentRecord,
  "assigned_users"
> {
  assigned_users_json: string;
}

export class OperatingWorkObjectAssignmentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "OperatingWorkObjectAssignmentError";
  }
}

export async function recordOperatingWorkObjectAssignment(
  env: AppEnv,
  input: RecordOperatingWorkObjectAssignmentInput,
  now = new Date(),
): Promise<{
  kind: "created" | "replayed";
  assignment: OperatingWorkObjectAssignmentRecord;
}> {
  const command = normalizedCommand(input);
  const commandFingerprint = await sha256Hex(canonicalJson(command));
  const idempotencyKeyHash = await sha256Hex(
    boundedText(
      input.idempotencyKey,
      8,
      280,
      "operating_work_object_assignment_idempotency_invalid",
    ),
  );
  const existing = await assignmentByIdempotency(
    env,
    command.tenant_id,
    idempotencyKeyHash,
  );
  if (existing) return replay(existing, commandFingerprint);

  const scope = commandScope(command);
  const current = await getCurrentOperatingWorkObjectAssignment(
    env,
    command.tenant_id,
    scope,
  );
  if (
    current
      ? command.supersedes_assignment_id !== current.assignment_id ||
        !command.correction_reason
      : command.supersedes_assignment_id !== null ||
        command.correction_reason !== null
  ) {
    fail("operating_work_object_assignment_chain_conflict");
  }

  const createdAt = instant(
    now.toISOString(),
    "operating_work_object_assignment_time_invalid",
  );
  const assignmentId = `assignment:${(
    await sha256Hex(`${command.tenant_id}:${idempotencyKeyHash}`)
  ).slice(0, 40)}`;
  const assignmentVersion = current ? current.assignment_version + 1 : 1;
  try {
    await env.DB.prepare(
      `INSERT INTO operating_work_object_assignments (
         assignment_id, tenant_id, work_object_type, work_object_id,
         physical_context_type, physical_context_id, assignment_version,
         assigned_users_json, scheduled_start, scheduled_end,
         authority_user_id, authority_role, supersedes_assignment_id,
         correction_reason, actor_user_id, command_fingerprint,
         idempotency_key_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        assignmentId,
        command.tenant_id,
        command.work_object_type,
        command.work_object_id,
        command.physical_context_type,
        command.physical_context_id,
        assignmentVersion,
        canonicalJson(command.assigned_users),
        command.scheduled_start,
        command.scheduled_end,
        command.authority_user_id,
        command.authority_role,
        command.supersedes_assignment_id,
        command.correction_reason,
        command.actor_user_id,
        commandFingerprint,
        idempotencyKeyHash,
        createdAt,
      )
      .run();
  } catch (error) {
    const concurrent = await assignmentByIdempotency(
      env,
      command.tenant_id,
      idempotencyKeyHash,
    );
    if (concurrent) return replay(concurrent, commandFingerprint);
    throw error;
  }
  const assignment = await assignmentById(env, command.tenant_id, assignmentId);
  if (!assignment) fail("operating_work_object_assignment_write_failed");
  return { kind: "created", assignment };
}

export async function getCurrentOperatingWorkObjectAssignment(
  env: AppEnv,
  tenantId: string,
  scope: OperatingWorkObjectScope,
): Promise<OperatingWorkObjectAssignmentRecord | null> {
  const normalized = normalizedScope(scope);
  const row = await env.DB.prepare(
    `SELECT current.*
       FROM operating_work_object_assignments current
      WHERE current.tenant_id = ?
        AND current.work_object_type = ?
        AND current.work_object_id = ?
        AND current.physical_context_type = ?
        AND current.physical_context_id = ?
        AND NOT EXISTS (
          SELECT 1
            FROM operating_work_object_assignments successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_assignment_id = current.assignment_id
        )
      LIMIT 1`,
  )
    .bind(
      tenant(tenantId),
      normalized.work_object_type,
      normalized.work_object_id,
      normalized.physical_context_type,
      normalized.physical_context_id,
    )
    .first<AssignmentRow>();
  return row ? fromRow(row) : null;
}

export async function listCurrentOperatingWorkObjectAssignments(
  env: AppEnv,
  tenantId: string,
  options: {
    scope?: OperatingWorkObjectScope;
    actorUsers?: readonly string[];
  } = {},
): Promise<OperatingWorkObjectAssignmentRecord[]> {
  const clauses = [
    "current.tenant_id = ?",
    `NOT EXISTS (
      SELECT 1 FROM operating_work_object_assignments successor
       WHERE successor.tenant_id = current.tenant_id
         AND successor.supersedes_assignment_id = current.assignment_id
    )`,
  ];
  const bindings: unknown[] = [tenant(tenantId)];
  if (options.scope) {
    const scope = normalizedScope(options.scope);
    clauses.push(
      "current.work_object_type = ?",
      "current.work_object_id = ?",
      "current.physical_context_type = ?",
      "current.physical_context_id = ?",
    );
    bindings.push(
      scope.work_object_type,
      scope.work_object_id,
      scope.physical_context_type,
      scope.physical_context_id,
    );
  }
  const actorUsers = (options.actorUsers ?? [])
    .reduce<string[]>((users, value) => {
      const normalized = value.trim().toLowerCase();
      if (
        normalized &&
        normalized.length <= 254 &&
        !users.includes(normalized)
      ) {
        users.push(normalized);
      }
      return users;
    }, [])
    .slice(0, 3);
  if (options.actorUsers && actorUsers.length === 0) return [];
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
       FROM operating_work_object_assignments current
      WHERE ${clauses.join(" AND ")}
      ORDER BY current.scheduled_start ASC, current.assignment_id ASC
      LIMIT 100`,
  )
    .bind(...bindings)
    .all<AssignmentRow>();
  return rows.results.map(fromRow);
}

function normalizedCommand(input: RecordOperatingWorkObjectAssignmentInput) {
  const scheduledStart = instant(
    input.scheduledStart,
    "operating_work_object_assignment_start_invalid",
  );
  const scheduledEnd = nullableInstant(
    input.scheduledEnd,
    "operating_work_object_assignment_end_invalid",
  );
  if (scheduledEnd && scheduledEnd <= scheduledStart)
    fail("operating_work_object_assignment_end_invalid");
  const scope = normalizedScope(input);
  const assignedUsers = uniqueUsers(input.assignedUsers);
  if (assignedUsers.length !== input.assignedUsers.length)
    fail("operating_work_object_assignment_roster_invalid");
  return Object.freeze({
    schema_version: "ironwrap.operating-work-object-assignment.v1",
    tenant_id: tenant(input.tenantId),
    ...scope,
    assigned_users: assignedUsers,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    authority_user_id: entityId(
      input.authorityUserId,
      "operating_work_object_assignment_authority_invalid",
    ),
    authority_role: authorityRole(input.authorityRole),
    supersedes_assignment_id: nullableEntityId(
      input.supersedesAssignmentId,
      "operating_work_object_assignment_predecessor_invalid",
    ),
    correction_reason: nullableText(
      input.correctionReason,
      3,
      1_200,
      "operating_work_object_assignment_correction_invalid",
    ),
    actor_user_id: entityId(
      input.actorUserId,
      "operating_work_object_assignment_actor_invalid",
    ),
  });
}

function normalizedScope(scope: OperatingWorkObjectScope) {
  const workObjectType = boundedText(
    scope.workObjectType,
    1,
    140,
    "operating_work_object_assignment_scope_invalid",
  );
  if (workObjectType === "Roof Job")
    fail("operating_work_object_assignment_scope_invalid");
  return Object.freeze({
    work_object_type: workObjectType,
    work_object_id: boundedText(
      scope.workObjectId,
      1,
      140,
      "operating_work_object_assignment_scope_invalid",
    ),
    physical_context_type: boundedText(
      scope.physicalContextType,
      1,
      140,
      "operating_work_object_assignment_scope_invalid",
    ),
    physical_context_id: boundedText(
      scope.physicalContextId,
      1,
      140,
      "operating_work_object_assignment_scope_invalid",
    ),
  });
}

function commandScope(command: ReturnType<typeof normalizedCommand>) {
  return {
    workObjectType: command.work_object_type,
    workObjectId: command.work_object_id,
    physicalContextType: command.physical_context_type,
    physicalContextId: command.physical_context_id,
  };
}

async function assignmentByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<OperatingWorkObjectAssignmentRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM operating_work_object_assignments
      WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  )
    .bind(tenantId, idempotencyKeyHash)
    .first<AssignmentRow>();
  return row ? fromRow(row) : null;
}

async function assignmentById(
  env: AppEnv,
  tenantId: string,
  assignmentId: string,
): Promise<OperatingWorkObjectAssignmentRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM operating_work_object_assignments
      WHERE tenant_id = ? AND assignment_id = ?`,
  )
    .bind(tenantId, assignmentId)
    .first<AssignmentRow>();
  return row ? fromRow(row) : null;
}

function fromRow(row: AssignmentRow): OperatingWorkObjectAssignmentRecord {
  let assignedUsers: unknown;
  try {
    assignedUsers = JSON.parse(row.assigned_users_json);
  } catch {
    fail("operating_work_object_assignment_roster_corrupt");
  }
  if (
    !Array.isArray(assignedUsers) ||
    assignedUsers.some((value) => typeof value !== "string")
  ) {
    fail("operating_work_object_assignment_roster_corrupt");
  }
  const { assigned_users_json: _assignedUsersJson, ...record } = row;
  return { ...record, assigned_users: assignedUsers };
}

function replay(
  assignment: OperatingWorkObjectAssignmentRecord,
  commandFingerprint: string,
): { kind: "replayed"; assignment: OperatingWorkObjectAssignmentRecord } {
  if (assignment.command_fingerprint !== commandFingerprint)
    fail("operating_work_object_assignment_idempotency_conflict");
  return { kind: "replayed", assignment };
}

function uniqueUsers(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50)
    fail("operating_work_object_assignment_roster_invalid");
  const users = values.map((value) =>
    entityId(value, "operating_work_object_assignment_roster_invalid"),
  );
  const unique = new Map(users.map((value) => [value.toLowerCase(), value]));
  return [...unique.values()].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

function tenant(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value))
    fail("operating_work_object_assignment_tenant_invalid");
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

function authorityRole(value: unknown): OperatingWorkObjectAuthorityRole {
  if (value !== "owner" && value !== "production")
    fail("operating_work_object_assignment_authority_invalid");
  return value;
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
  throw new OperatingWorkObjectAssignmentError(code);
}
