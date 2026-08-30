import type { AppEnv, AppRole } from "./app-types.ts";
import {
  parseAuthorityRequirements,
  type AuthorityCurrentPrecondition,
  type AuthorityRequirement,
} from "./authority-records.ts";
import type { FrappeRow } from "./frappe-read.ts";

const CURRENT_STATUSES = ["Released", "Acknowledged", "In Progress", "Blocked"] as const;
const ROLE_LABELS: Record<AppRole, string> = {
  owner: "IronWrap Owner",
  ops: "System Manager",
  sales: "IronWrap Sales",
  production: "IronWrap Production",
  accounting: "IronWrap Accounting",
  field: "Field Worker",
};

export type NativeWorkPackageStatus = "Released" | "Acknowledged" | "In Progress" | "Blocked" | "Completed" | "Expired" | "Superseded";

export interface NativeWorkPackageStep {
  sequence: number;
  instruction: string;
  requiredEvidence: string;
  acceptanceCriteria: string;
}

export interface NativeWorkPackageHoldPoint {
  sequence: number;
  holdPoint: string;
  releasePhase: "Pre-start" | "In-process" | "Completion";
  releaseAuthority: string;
  requiredEvidence: string;
  acceptanceCriteria: string;
}

export interface NativeWorkPackageWorker {
  sequence: number;
  workerUser: string;
  workerRole: string;
  required: boolean;
}

export interface NativeWorkPackageDefinition {
  tenantId: string;
  workPackageId: string;
  version: number;
  deviceActionId: string;
  manifestKey: string;
  jobId: string;
  assignmentId: string;
  assignmentVersion: number;
  assignmentCommandFingerprint: string;
  assignmentAuthorityRequirementsSha256: string;
  issueRequestSha256: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
  assignmentAuthorityUser?: string | null;
  assignmentAuthorityRole?: string | null;
  title: string;
  objective: string;
  boundaries: string;
  prerequisites: string;
  expectedResult: string;
  stopConditions: string;
  makeSafeProcedure: string;
  issuedAt: string;
  expiresAt: string;
  releasedAt: string;
  releaseAttemptId: string;
  authorityRequirements: AuthorityRequirement[];
  steps: NativeWorkPackageStep[];
  holdPoints: NativeWorkPackageHoldPoint[];
  assignedWorkers: NativeWorkPackageWorker[];
  supersedesId?: string | null;
  supersedesVersion?: number | null;
  correctionReason?: string | null;
  issuedByUser: string;
  issuedByRole: string;
}

export interface NativeWorkPackageRead {
  document: FrappeRow;
  holdReleases: FrappeRow[];
  acknowledgements: FrappeRow[];
  evidence: FrappeRow[];
}

export interface NativeWorkPackageVersionHead {
  workPackageId: string;
  version: number;
  status: NativeWorkPackageStatus;
  supersedesId: string | null;
  correctionReason: string | null;
}

export interface NativeWorkPackageActionInput {
  kind: "acknowledge" | "stop_work" | "start_work" | "complete_work";
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  actorUser: string;
  actorRole: AppRole | string;
  deviceActionId: string;
  blockerReason: string | null;
  releaseAttemptId: string | null;
  workObjectType: string | null;
  workObjectId: string | null;
  physicalContextType: string | null;
  physicalContextId: string | null;
  manifestKey: string;
  authorityPreconditions?: AuthorityCurrentPrecondition[];
  occurredAt?: string;
}

export interface NativeWorkPackageActionResult {
  workPackageName: string;
  eventName: string;
}

export interface NativeWorkPackageHoldReleaseInput {
  tenantId: string;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  actorUser: string;
  actorRole: AppRole | string;
  deviceActionId: string;
  holdPointSequence: number;
  evidenceItem: string;
  releaseAttemptId: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
  manifestKey: string;
  occurredAt?: string;
}

export interface NativeWorkPackageEvidenceReviewInput {
  tenantId: string;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  actorUser: string;
  actorRole: AppRole | string;
  deviceActionId: string;
  evidenceEventId: string;
  evidenceItem: string;
  evidenceSlotId: string;
  disposition: "Accepted" | "Needs Correction";
  correctionReason?: string | null;
  releaseAttemptId: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
  manifestKey: string;
  occurredAt?: string;
}

interface NativePackageRow {
  work_package_id: string;
  tenant_id: string;
  version: number;
  job_id: string;
  assignment_id: string;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  assignment_authority_user: string | null;
  assignment_authority_role: string | null;
  assignment_version: number | null;
  assignment_command_fingerprint: string | null;
  assignment_authority_requirements_sha256: string | null;
  status: NativeWorkPackageStatus;
  title: string;
  objective: string;
  boundaries: string;
  prerequisites: string;
  expected_result: string;
  stop_conditions: string;
  make_safe_procedure: string;
  definition_json: string;
  issued_at: string;
  expires_at: string;
  released_at: string;
  release_attempt_id: string;
  supersedes_id: string | null;
  correction_reason: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface NativeEventRow {
  event_id: string;
  tenant_id: string;
  work_package_id: string;
  work_package_version: number;
  job_id: string;
  assignment_id: string;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  release_attempt_id: string;
  event_kind: string;
  actor_user_id: string;
  actor_role: string;
  device_action_id: string | null;
  occurred_at: string;
  manifest_key: string | null;
  payload_json: string;
  created_at: string;
}

interface NativeEventInsert {
  eventId: string;
  tenantId: string;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
  releaseAttemptId: string;
  eventKind: string;
  actorUserId: string;
  actorRole: string;
  deviceActionId: string | null;
  occurredAt: string;
  manifestKey: string | null;
  payload: Record<string, unknown>;
}

interface NativeEvidenceRow {
  device_action_id: string;
  user_id: string;
  actor_user: string | null;
  actor_role: string | null;
  created_at: string;
  work_package_id: string;
  work_package_version: number;
  evidence_slot_id: string;
  evidence_requirement: string;
  evidence_source: string;
  evidence_device_id: string;
  evidence_freshness: string;
  evidence_conflict_state: string;
  evidence_verification: string;
  evidence_disposition: string;
  evidence_correction_of: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id: string;
  correction_reason: string | null;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  capture_completed_at: string | null;
  evidence_id: string;
}

export interface NativeWorkPackageIssueReplayInput {
  tenantId: string;
  deviceActionId: string;
  issueRequestSha256: string;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  actorUserId: string;
}

/**
 * Replay an already committed issue command before consulting mutable
 * assignment state. The request hash binds every browser-controlled field;
 * assignment-derived snapshots stay bound inside the immutable definition.
 */
export async function replayNativeWorkPackageIssue(
  env: AppEnv,
  input: NativeWorkPackageIssueReplayInput,
): Promise<NativeWorkPackageRead | null> {
  const event = await eventByDeviceAction(
    env,
    input.tenantId,
    input.deviceActionId,
  );
  if (!event) return null;
  const payload = parseJson(event.payload_json);
  if (
    event.event_kind !== "issued" ||
    event.work_package_id !== input.workPackageId ||
    event.work_package_version !== input.workPackageVersion ||
    event.job_id !== input.jobId ||
    event.assignment_id !== input.assignmentId ||
    event.actor_user_id !== input.actorUserId ||
    payload?.issue_request_sha256 !== input.issueRequestSha256
  ) {
    throw new Error("work_package_device_action_conflict");
  }
  const row = await packageRow(
    env,
    input.tenantId,
    input.workPackageId,
    input.workPackageVersion,
  );
  const replay = row ? await nativeWorkPackageReadFromRow(env, row) : null;
  if (!replay) throw new Error("work_package_readback_missing");
  return replay;
}

/**
 * Insert an issued, immutable D1 package. Re-issuing the same exact definition
 * is an idempotent read; changing any frozen field is rejected.
 */
export async function issueNativeWorkPackage(env: AppEnv, definition: NativeWorkPackageDefinition): Promise<NativeWorkPackageRead> {
  definition = {
    ...definition,
    authorityRequirements: parseAuthorityRequirements(
      definition.authorityRequirements,
    ),
  };
  validateDefinition(definition, env);
  definition = await canonicalDefinitionActors(env, definition);
  if (
    (await sha256Hex(canonicalJson(definition.authorityRequirements))) !==
    definition.assignmentAuthorityRequirementsSha256
  ) {
    throw new Error("work_package_assignment_snapshot_invalid");
  }
  const definitionJson = canonicalJson(definitionPayload(definition));
  const definitionHash = await sha256Hex(definitionJson);
  const existingCommand = await eventByDeviceAction(
    env,
    definition.tenantId,
    definition.deviceActionId,
  );
  if (existingCommand) {
    const payload = parseJson(existingCommand.payload_json);
    if (
      existingCommand.event_kind !== "issued" ||
      existingCommand.work_package_id !== definition.workPackageId ||
      existingCommand.work_package_version !== definition.version ||
      existingCommand.job_id !== definition.jobId ||
      existingCommand.assignment_id !== definition.assignmentId ||
      existingCommand.actor_user_id !== definition.issuedByUser ||
      existingCommand.manifest_key !== definition.manifestKey ||
      payload?.definition_sha256 !== definitionHash ||
      payload?.command_sha256 !== definitionHash ||
      payload?.issue_request_sha256 !== definition.issueRequestSha256
    )
      throw new Error("work_package_device_action_conflict");
    const row = await packageRow(
      env,
      definition.tenantId,
      definition.workPackageId,
      definition.version,
    );
    const replay = row ? await nativeWorkPackageReadFromRow(env, row) : null;
    if (!replay) throw new Error("work_package_readback_missing");
    return replay;
  }
  const existing = await packageRow(
    env,
    definition.tenantId,
    definition.workPackageId,
    definition.version,
  );
  const eventId = `wpi_${(await sha256Hex(`${definition.tenantId}:${definition.deviceActionId}`)).slice(0, 32)}`;
  const issuedEvent = {
    eventId,
    tenantId: definition.tenantId,
    workPackageId: definition.workPackageId,
    workPackageVersion: definition.version,
    jobId: definition.jobId,
    assignmentId: definition.assignmentId,
    workObjectType: definition.workObjectType,
    workObjectId: definition.workObjectId,
    physicalContextType: definition.physicalContextType,
    physicalContextId: definition.physicalContextId,
    releaseAttemptId: definition.releaseAttemptId,
    eventKind: "issued",
    actorUserId: definition.issuedByUser,
    actorRole: definition.issuedByRole,
    deviceActionId: definition.deviceActionId,
    occurredAt: definition.issuedAt,
    manifestKey: definition.manifestKey,
    payload: {
      definition_sha256: definitionHash,
      command_sha256: definitionHash,
      issue_request_sha256: definition.issueRequestSha256,
    },
  };
  if (existing) {
    if (existing.definition_json !== definitionJson) throw new Error("work_package_definition_conflict");
    const event = await env.DB.prepare(
      `SELECT event_id, device_action_id, manifest_key, payload_json FROM work_package_events
        WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
          AND event_kind = 'issued'`,
    )
      .bind(definition.tenantId, definition.workPackageId, definition.version)
      .first<{
        event_id: string;
        device_action_id: string | null;
        manifest_key: string | null;
        payload_json: string;
      }>();
    const payload = event ? parseJson(event.payload_json) : null;
    if (
      !event ||
      event.device_action_id !== definition.deviceActionId ||
      event.manifest_key !== definition.manifestKey ||
      payload?.definition_sha256 !== definitionHash ||
      payload?.command_sha256 !== definitionHash ||
      payload?.issue_request_sha256 !== definition.issueRequestSha256
    )
      throw new Error("work_package_definition_conflict");
    const replay = await nativeWorkPackageReadFromRow(env, existing);
    if (!replay) throw new Error("work_package_readback_missing");
    return replay;
  }
  const createdAt = definition.issuedAt;
  const packageInsert = env.DB.prepare(
    `INSERT INTO work_packages
      (work_package_id, tenant_id, version, job_id, assignment_id,
       work_object_type, work_object_id, physical_context_type, physical_context_id,
       assignment_authority_user, assignment_authority_role, status,
       assignment_version, assignment_command_fingerprint,
       assignment_authority_requirements_sha256,
       title, objective, boundaries, prerequisites, expected_result, stop_conditions,
       make_safe_procedure, definition_json, issued_at, expires_at, released_at,
       release_attempt_id, supersedes_id, correction_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Released', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    definition.workPackageId,
    definition.tenantId,
    definition.version,
    definition.jobId,
    definition.assignmentId,
    definition.workObjectType,
    definition.workObjectId,
    definition.physicalContextType,
    definition.physicalContextId,
    definition.assignmentAuthorityUser ?? null,
    definition.assignmentAuthorityRole ?? null,
    definition.assignmentVersion,
    definition.assignmentCommandFingerprint,
    definition.assignmentAuthorityRequirementsSha256,
    definition.title,
    definition.objective,
    definition.boundaries,
    definition.prerequisites,
    definition.expectedResult,
    definition.stopConditions,
    definition.makeSafeProcedure,
    definitionJson,
    definition.issuedAt,
    definition.expiresAt,
    definition.releasedAt,
    definition.releaseAttemptId,
    definition.supersedesId ?? null,
    definition.correctionReason ?? null,
    createdAt,
    createdAt,
  );
  const statements = [packageInsert, eventStatement(env, issuedEvent)];
  if (definition.supersedesId && definition.supersedesVersion) {
    const supersessionId = `wps_${(await sha256Hex(`${definition.tenantId}:${definition.deviceActionId}:supersession`)).slice(0, 32)}`;
    statements.unshift(
      env.DB.prepare(
        `INSERT INTO work_package_supersessions
          (supersession_id, tenant_id, device_action_id, command_sha256,
           prior_work_package_id, prior_work_package_version,
           replacement_work_package_id, replacement_work_package_version,
           job_id, assignment_id, work_object_type, work_object_id,
           physical_context_type, physical_context_id, actor_user_id, actor_role,
           correction_reason, manifest_key, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        supersessionId,
        definition.tenantId,
        definition.deviceActionId,
        definitionHash,
        definition.supersedesId,
        definition.supersedesVersion,
        definition.workPackageId,
        definition.version,
        definition.jobId,
        definition.assignmentId,
        definition.workObjectType,
        definition.workObjectId,
        definition.physicalContextType,
        definition.physicalContextId,
        definition.issuedByUser,
        definition.issuedByRole,
        definition.correctionReason,
        definition.manifestKey,
        definition.issuedAt,
        definition.issuedAt,
      ),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("work_package_assignment_snapshot_stale")) {
      throw new Error("work_package_assignment_snapshot_stale");
    }
    throw error;
  }
  const read = await nativeWorkPackageForAssignment(
    env,
    definition.tenantId,
    definition.jobId,
    definition.assignmentId,
  );
  if (!read) throw new Error("work_package_readback_missing");
  return read;
}

/** Read one exact current package without a provider call. */
export async function nativeWorkPackageForAssignment(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  assignmentId: string,
): Promise<NativeWorkPackageRead | null> {
  const rows = await env.DB.prepare(
    `SELECT work_package_id, tenant_id, version, job_id, assignment_id,
            work_object_type, work_object_id, physical_context_type, physical_context_id,
            assignment_authority_user, assignment_authority_role, status,
            assignment_version, assignment_command_fingerprint,
            assignment_authority_requirements_sha256,
            title, objective, boundaries, prerequisites, expected_result,
            stop_conditions, make_safe_procedure, definition_json, issued_at,
            expires_at, released_at, release_attempt_id, supersedes_id,
            correction_reason, acknowledged_at, completed_at, created_at, updated_at
       FROM work_packages
      WHERE tenant_id = ? AND job_id = ? AND assignment_id = ?
        AND status IN ('Released', 'Acknowledged', 'In Progress', 'Blocked')
      ORDER BY version DESC
      LIMIT 2`,
  )
    .bind(tenantId, jobId, assignmentId)
    .all<NativePackageRow>();
  if (rows.results.length !== 1) return null;
  return await nativeWorkPackageReadFromRow(env, rows.results[0]);
}

/** Read the latest version head so office issuance can distinguish replay, supersession, and terminal work. */
export async function getNativeWorkPackageVersionHead(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  assignmentId: string,
): Promise<NativeWorkPackageVersionHead | null> {
  const rows = await env.DB.prepare(
    `SELECT work_package_id, version, status, supersedes_id, correction_reason
       FROM work_packages
      WHERE tenant_id = ? AND job_id = ? AND assignment_id = ?
      ORDER BY version DESC
      LIMIT 2`,
  )
    .bind(tenantId, jobId, assignmentId)
    .all<{
      work_package_id: string;
      version: number;
      status: NativeWorkPackageStatus;
      supersedes_id: string | null;
      correction_reason: string | null;
    }>();
  if (rows.results.length === 0) return null;
  const row = rows.results[0];
  return {
    workPackageId: row.work_package_id,
    version: row.version,
    status: row.status,
    supersedesId: row.supersedes_id,
    correctionReason: row.correction_reason,
  };
}

async function nativeWorkPackageReadFromRow(
  env: AppEnv,
  packageRowValue: NativePackageRow,
): Promise<NativeWorkPackageRead | null> {
  const payload = parseDefinitionPayload(packageRowValue.definition_json);
  if (!payload) return null;
  const document = packageDocument(packageRowValue, payload);
  const eventRows = await env.DB.prepare(
    `SELECT event_id, tenant_id, work_package_id, work_package_version,
            job_id, assignment_id, work_object_type, work_object_id,
            physical_context_type, physical_context_id, release_attempt_id,
            event_kind, actor_user_id, actor_role, device_action_id, occurred_at,
            manifest_key, payload_json, created_at
       FROM work_package_events
      WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
      ORDER BY occurred_at ASC, event_id ASC`,
  )
    .bind(
      packageRowValue.tenant_id,
      packageRowValue.work_package_id,
      packageRowValue.version,
    )
    .all<NativeEventRow>();
  const events = eventRows.results.map(eventDocument);
  const evidence = await nativeEvidenceRows(env, packageRowValue);
  return {
    document,
    holdReleases: events.filter((row) => row.event_type === "Hold Point Released"),
    acknowledgements: events.filter((row) => row.event_type === "Acknowledged"),
    evidence: [...evidence, ...events.filter((row) => row.event_type === "Evidence Reviewed")],
  };
}

/** Read one exact native package document, including terminal predecessors. */
export async function nativeWorkPackageDocumentById(
  env: AppEnv,
  tenantId: string,
  workPackageId: string,
): Promise<FrappeRow | null> {
  const versions = await env.DB.prepare(
    `SELECT version
       FROM work_packages
      WHERE tenant_id = ? AND work_package_id = ?
      ORDER BY version DESC
      LIMIT 2`,
  )
    .bind(tenantId, workPackageId)
    .all<{ version: number }>();
  if (versions.results.length !== 1) return null;
  const row = await packageRow(
    env,
    tenantId,
    workPackageId,
    versions.results[0].version,
  );
  if (!row) return null;
  const payload = parseDefinitionPayload(row.definition_json);
  return payload ? packageDocument(row, payload) : null;
}

export async function nativeAssignments(
  env: AppEnv,
  tenantId: string,
  options: {
    jobId?: string;
    scope?: {
      workObjectType: string;
      workObjectId: string;
      physicalContextType: string;
      physicalContextId: string;
    };
    actorUsers?: readonly string[];
  } = {},
): Promise<FrappeRow[]> {
  const clauses = [
    "tenant_id = ?",
    "status IN ('Released', 'Acknowledged', 'In Progress', 'Blocked')",
  ];
  const bindings: unknown[] = [tenantId];
  if (options.jobId) {
    clauses.push("job_id = ?");
    bindings.push(options.jobId);
  }
  if (options.scope) {
    clauses.push(
      "work_object_type = ?",
      "work_object_id = ?",
      "physical_context_type = ?",
      "physical_context_id = ?",
    );
    bindings.push(
      options.scope.workObjectType,
      options.scope.workObjectId,
      options.scope.physicalContextType,
      options.scope.physicalContextId,
    );
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
        SELECT 1 FROM json_each(definition_json, '$.assigned_workers') worker
         WHERE lower(json_extract(worker.value, '$.worker_user')) IN (${actorUsers
           .map(() => "?")
           .join(", ")})
           AND json_extract(worker.value, '$.required') IN (1, '1', true)
      )`,
    );
    bindings.push(...actorUsers);
  }
  const rows = await env.DB.prepare(
    `SELECT work_package_id, tenant_id, version, job_id, assignment_id,
            work_object_type, work_object_id, physical_context_type, physical_context_id,
            assignment_authority_user, assignment_authority_role, status,
            assignment_version, assignment_command_fingerprint,
            assignment_authority_requirements_sha256,
            definition_json, updated_at
       FROM work_packages
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, work_package_id ASC
      LIMIT 100`,
  )
    .bind(...bindings)
    .all<NativePackageRow>();
  return rows.results.flatMap((row) =>
    parseDefinitionPayload(row.definition_json) ? [assignmentDocument(row)] : [],
  );
}

/**
 * Resolve the assignment envelope needed by the BFF route without asking
 * Frappe. A duplicate current package is intentionally ambiguous and fails
 * closed rather than letting the browser choose a write target.
 */
export async function nativeAssignmentForWorkObject(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  scope?: {
    workObjectType?: string;
    workObjectId?: string;
    physicalContextType?: string;
    physicalContextId?: string;
  },
): Promise<FrappeRow | null> {
  const rows = await nativeAssignments(env, tenantId, {
    jobId,
    ...(scope?.workObjectType
      ? {
          scope: {
            workObjectType: scope.workObjectType,
            workObjectId: scope.workObjectId ?? "",
            physicalContextType: scope.physicalContextType ?? "",
            physicalContextId: scope.physicalContextId ?? "",
          },
        }
      : {}),
  });
  return rows.length === 1 ? rows[0] : null;
}

function assignmentDocument(row: NativePackageRow): FrappeRow {
  return {
    name: row.assignment_id,
    assignment_id: row.assignment_id,
    roof_job: row.work_object_type === "Roof Job" ? row.job_id : null,
    work_object_type: row.work_object_type,
    work_object_id: row.work_object_id,
    physical_context_type: row.physical_context_type,
    physical_context_id: row.physical_context_id,
    authority_user: row.assignment_authority_user,
    authority_role: row.assignment_authority_role,
    assignment_version: row.assignment_version,
    assignment_command_fingerprint: row.assignment_command_fingerprint,
    assignment_authority_requirements_sha256:
      row.assignment_authority_requirements_sha256,
    work_package: row.work_package_id,
    work_package_version: row.version,
    status:
      row.status === "Released"
        ? "Assigned"
        : row.status === "Acknowledged"
          ? "Accepted"
          : row.status,
    modified: row.updated_at,
  };
}

/** Append one native command event; package triggers enforce the transition. */
export async function nativeWorkPackageAction(env: AppEnv, input: NativeWorkPackageActionInput): Promise<NativeWorkPackageActionResult> {
  const tenantId = env.APP_TENANT_ID ?? "ironwrap";
  const actorIdentities = await activeActorIdentities(
    env,
    tenantId,
    input.actorUser,
    input.actorRole,
  );
  const existing = await eventByDeviceAction(env, tenantId, input.deviceActionId);
  if (existing) {
    assertReplayIdentity(existing, {
      workPackageId: input.workPackageId,
      workPackageVersion: input.workPackageVersion,
      jobId: input.jobId,
      assignmentId: input.assignmentId,
      kind: eventKindForAction(input.kind),
      actorUsers: actorIdentities,
    });
    return {
      workPackageName: existing.work_package_id,
      eventName: existing.event_id,
    };
  }
  const row = await packageRow(env, tenantId, input.workPackageId, input.workPackageVersion);
  if (
    !row ||
    row.tenant_id !== tenantId ||
    row.job_id !== input.jobId ||
    row.assignment_id !== input.assignmentId ||
    (input.releaseAttemptId !== null && row.release_attempt_id !== input.releaseAttemptId) ||
    (input.workObjectType !== null && row.work_object_type !== input.workObjectType) ||
    (input.workObjectId !== null && row.work_object_id !== input.workObjectId) ||
    (input.physicalContextType !== null && row.physical_context_type !== input.physicalContextType) ||
    (input.physicalContextId !== null && row.physical_context_id !== input.physicalContextId)
  ) {
    throw new Error("work_package_scope_conflict");
  }
  const definition = parseDefinitionPayload(row.definition_json);
  if (!definition) throw new Error("work_package_definition_invalid");
  const eventActorRole = assertActorAuthority(
    row,
    definition,
    input,
    actorIdentities,
  );
  if (input.kind === "complete_work" && !(await nativeCompletionReady(env, row, definition))) {
    throw new Error("work_package_completion_not_ready");
  }
  const eventId = `wpe_${(await sha256Hex(`${row.tenant_id}:${input.deviceActionId}`)).slice(0, 32)}`;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  try {
    await insertEvent(env, {
      eventId,
      tenantId: row.tenant_id,
      workPackageId: row.work_package_id,
      workPackageVersion: row.version,
      jobId: row.job_id,
      assignmentId: row.assignment_id,
      workObjectType: row.work_object_type,
      workObjectId: row.work_object_id,
      physicalContextType: row.physical_context_type,
      physicalContextId: row.physical_context_id,
      releaseAttemptId: row.release_attempt_id,
      eventKind: eventKindForAction(input.kind),
      actorUserId: actorIdentities[0]!,
      actorRole: eventActorRole,
      deviceActionId: input.deviceActionId,
      occurredAt,
      manifestKey: input.manifestKey ?? null,
      payload: {
        blocker_reason: input.blockerReason,
        work_package_id: input.workPackageId,
        work_package_version: input.workPackageVersion,
        ...(input.kind === "stop_work"
          ? {}
          : {
              authority_preconditions: input.authorityPreconditions ?? [],
            }),
      },
    });
  } catch (error) {
    const replay = await eventByDeviceAction(env, tenantId, input.deviceActionId);
    if (replay) {
      assertReplayIdentity(replay, {
        workPackageId: input.workPackageId,
        workPackageVersion: input.workPackageVersion,
        jobId: input.jobId,
        assignmentId: input.assignmentId,
        kind: eventKindForAction(input.kind),
        actorUsers: actorIdentities,
      });
      return {
        workPackageName: replay.work_package_id,
        eventName: replay.event_id,
      };
    }
    if (String(error).includes("work_package_authority_precondition_stale")) {
      throw new Error("work_package_authority_precondition_stale");
    }
    throw error;
  }
  if (input.deviceActionId) {
    await env.DB.prepare(
      `UPDATE field_work_package_actions
          SET work_package_version = ?, release_attempt_id = ?,
              work_object_type = ?, work_object_id = ?, physical_context_type = ?,
              physical_context_id = ?, event_id = ?, manifest_key = COALESCE(manifest_key, ?),
              updated_at = ?
        WHERE device_action_id = ? AND tenant_id = ?`,
    )
      .bind(
        row.version,
        row.release_attempt_id,
        row.work_object_type,
        row.work_object_id,
        row.physical_context_type,
        row.physical_context_id,
        eventId,
        input.manifestKey ?? null,
        occurredAt,
        input.deviceActionId,
        row.tenant_id,
      )
      .run();
  }
  return { workPackageName: row.work_package_id, eventName: eventId };
}

function eventKindForAction(kind: NativeWorkPackageActionInput["kind"]): string {
  return kind === "acknowledge" ? "acknowledged" : kind;
}

/** Release one declared hold point into the native append-only ledger. */
export async function releaseNativeWorkPackageHold(env: AppEnv, input: NativeWorkPackageHoldReleaseInput): Promise<NativeWorkPackageActionResult> {
  const actorIdentities = await activeActorIdentities(
    env,
    input.tenantId,
    input.actorUser,
    input.actorRole,
  );
  const existing = await eventByDeviceAction(env, input.tenantId, input.deviceActionId);
  if (existing) {
    assertReplayIdentity(existing, {
      workPackageId: input.workPackageId,
      workPackageVersion: input.workPackageVersion,
      jobId: input.jobId,
      assignmentId: input.assignmentId,
      kind: "hold_released",
      actorUsers: actorIdentities,
    });
    const payload = parseJson(existing.payload_json);
    if (payload?.hold_point_sequence !== input.holdPointSequence || payload?.evidence_item !== input.evidenceItem)
      throw new Error("work_package_device_action_conflict");
    return {
      workPackageName: existing.work_package_id,
      eventName: existing.event_id,
    };
  }
  const row = await nativeCommandPackage(env, input);
  const definition = parseDefinitionPayload(row.definition_json);
  const hold = definition?.hold_points.find((candidate) => candidate.sequence === input.holdPointSequence);
  if (!definition || !hold || !text(input.evidenceItem)) throw new Error("work_package_hold_invalid");
  if (!isCurrentPackageStatus(row.status)) throw new Error("work_package_hold_not_releasable");
  if (!holdReleaseAuthority(row, hold.releaseAuthority, actorIdentities, input.actorRole)) {
    throw new Error("work_package_hold_release_authority_required");
  }
  const captures = await nativeEvidenceRows(env, row);
  const superseded = new Set(
    captures
      .map((capture) => text(capture.evidence_correction_of))
      .filter((eventId): eventId is string => Boolean(eventId)),
  );
  const capture = captures.find(
    (candidate) =>
      text(candidate.evidence_item) === input.evidenceItem &&
      text(candidate.evidence_slot_id) === `hold:${input.holdPointSequence}` &&
      !superseded.has(text(candidate.name) ?? "") &&
      text(candidate.evidence_verification) === "Verified" &&
      text(candidate.evidence_disposition) === "Open" &&
      text(candidate.evidence_freshness) === "Current" &&
      ["None", "Resolved"].includes(
        text(candidate.evidence_conflict_state) ?? "",
      ),
  );
  if (!capture || !nativeEvidenceLedgerValid(captures, definition)) {
    throw new Error("work_package_hold_evidence_invalid");
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = `wpe_${(await sha256Hex(`${row.tenant_id}:${input.deviceActionId}`)).slice(0, 32)}`;
  try {
    await insertEvent(env, {
      eventId,
      tenantId: row.tenant_id,
      workPackageId: row.work_package_id,
      workPackageVersion: row.version,
      jobId: row.job_id,
      assignmentId: row.assignment_id,
      workObjectType: row.work_object_type,
      workObjectId: row.work_object_id,
      physicalContextType: row.physical_context_type,
      physicalContextId: row.physical_context_id,
      releaseAttemptId: row.release_attempt_id,
      eventKind: "hold_released",
      actorUserId: actorIdentities[0]!,
      actorRole: roleLabel(input.actorRole),
      deviceActionId: input.deviceActionId,
      occurredAt,
      manifestKey: input.manifestKey ?? null,
      payload: {
        hold_point_sequence: input.holdPointSequence,
        evidence_item: input.evidenceItem,
        evidence_slot_id: `hold:${input.holdPointSequence}`,
        evidence_requirement: hold.requiredEvidence,
      },
    });
  } catch (error) {
    const replay = await eventByDeviceAction(env, input.tenantId, input.deviceActionId);
    if (replay) {
      assertReplayIdentity(replay, {
        workPackageId: input.workPackageId,
        workPackageVersion: input.workPackageVersion,
        jobId: input.jobId,
        assignmentId: input.assignmentId,
        kind: "hold_released",
        actorUsers: actorIdentities,
      });
      return {
        workPackageName: replay.work_package_id,
        eventName: replay.event_id,
      };
    }
    throw error;
  }
  return { workPackageName: row.work_package_id, eventName: eventId };
}

/** Review one verified D1/R2 capture without writing a compatibility provider. */
export async function reviewNativeWorkPackageEvidence(env: AppEnv, input: NativeWorkPackageEvidenceReviewInput): Promise<NativeWorkPackageActionResult> {
  const actorIdentities = await activeActorIdentities(
    env,
    input.tenantId,
    input.actorUser,
    input.actorRole,
  );
  const existing = await eventByDeviceAction(env, input.tenantId, input.deviceActionId);
  if (existing) {
    assertEvidenceReviewReplay(existing, input, actorIdentities);
    return {
      workPackageName: existing.work_package_id,
      eventName: existing.event_id,
    };
  }
  const row = await nativeCommandPackage(env, input);
  const definition = parseDefinitionPayload(row.definition_json);
  if (!definition) throw new Error("work_package_definition_invalid");
  const captures = await nativeEvidenceRows(env, row);
  const superseded = new Set(
    captures
      .map((candidate) => text(candidate.evidence_correction_of))
      .filter((eventId): eventId is string => Boolean(eventId)),
  );
  const capture = captures.find(
    (candidate) =>
      candidate.name === input.evidenceEventId &&
      text(candidate.evidence_item) === input.evidenceItem &&
      text(candidate.evidence_slot_id) === input.evidenceSlotId,
  );
  if (
    !capture ||
    superseded.has(input.evidenceEventId) ||
    !nativeEvidenceLedgerValid(captures, definition) ||
    text(capture.evidence_verification) !== "Verified" ||
    text(capture.evidence_disposition) !== "Open"
  )
    throw new Error("work_package_evidence_review_target_invalid");
  if (actorIdentities.some((identity) => sameUser(text(capture.actor_user), identity))) {
    throw new Error("work_package_evidence_separation_required");
  }
  if (!reviewAuthority(row, actorIdentities, input.actorRole)) {
    throw new Error("work_package_evidence_review_authority_required");
  }
  if (input.disposition === "Needs Correction" && !text(input.correctionReason)) {
    throw new Error("work_package_correction_reason_required");
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = `wpe_${(await sha256Hex(`${row.tenant_id}:${input.deviceActionId}`)).slice(0, 32)}`;
  try {
    await insertEvent(env, {
      eventId,
      tenantId: row.tenant_id,
      workPackageId: row.work_package_id,
      workPackageVersion: row.version,
      jobId: row.job_id,
      assignmentId: row.assignment_id,
      workObjectType: row.work_object_type,
      workObjectId: row.work_object_id,
      physicalContextType: row.physical_context_type,
      physicalContextId: row.physical_context_id,
      releaseAttemptId: row.release_attempt_id,
      eventKind: "evidence_reviewed",
      actorUserId: actorIdentities[0]!,
      actorRole: roleLabel(input.actorRole),
      deviceActionId: input.deviceActionId,
      occurredAt,
      manifestKey: input.manifestKey ?? null,
      payload: {
        target_event_id: input.evidenceEventId,
        evidence_item: input.evidenceItem,
        evidence_slot_id: input.evidenceSlotId,
        disposition: input.disposition,
        correction_reason: input.correctionReason ?? null,
      },
    });
  } catch (error) {
    const replay = await eventByDeviceAction(env, input.tenantId, input.deviceActionId);
    if (replay) {
      assertEvidenceReviewReplay(replay, input, actorIdentities);
      return {
        workPackageName: replay.work_package_id,
        eventName: replay.event_id,
      };
    }
    throw error;
  }
  return { workPackageName: row.work_package_id, eventName: eventId };
}

/** Reconcile receipts whose event was committed but the response was lost. */
export async function reconcileNativeWorkPackageActions(
  env: AppEnv,
  tenantId: string,
  now = new Date().toISOString(),
  limit = 100,
  deviceActionId?: string,
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT a.device_action_id, a.work_package_id, e.event_id,
            e.work_package_version, e.release_attempt_id, e.work_object_type,
            e.work_object_id, e.physical_context_type, e.physical_context_id,
            e.manifest_key
       FROM field_work_package_actions a
       JOIN work_package_events e
         ON e.tenant_id = a.tenant_id
        AND e.device_action_id = a.device_action_id
        AND e.work_package_id = a.work_package_id
        AND e.job_id = a.job_id
        AND e.assignment_id = a.assignment_id
        AND e.event_kind = CASE a.action_kind
          WHEN 'acknowledge' THEN 'acknowledged'
          ELSE a.action_kind
        END
        AND (a.event_id IS NULL OR a.event_id = e.event_id)
      WHERE a.tenant_id = ? AND a.status != 'verified'
        AND (? IS NULL OR a.device_action_id = ?)
      ORDER BY a.created_at ASC, a.device_action_id ASC
      LIMIT ?`,
  )
    .bind(tenantId, deviceActionId ?? null, deviceActionId ?? null, limit)
    .all<{
      device_action_id: string;
      work_package_id: string;
      event_id: string;
      work_package_version: number;
      release_attempt_id: string;
      work_object_type: string;
      work_object_id: string;
      physical_context_type: string;
      physical_context_id: string;
      manifest_key: string | null;
    }>();
  let reconciled = 0;
  for (const row of rows.results) {
    const response = {
      device_action_id: row.device_action_id,
      status: "verified" as const,
      server_ref: row.work_package_id,
      cursor: row.event_id,
    };
    const result = await env.DB.prepare(
      `UPDATE field_work_package_actions
          SET work_package_version = ?, release_attempt_id = ?,
              work_object_type = ?, work_object_id = ?, physical_context_type = ?,
              physical_context_id = ?, event_id = ?, manifest_key = COALESCE(manifest_key, ?),
              status = 'verified', response_json = ?, verified_at = ?, updated_at = ?,
              processing_token = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE tenant_id = ? AND device_action_id = ? AND status != 'verified'
          AND (event_id IS NULL OR event_id = ?)`,
    )
      .bind(
        row.work_package_version,
        row.release_attempt_id,
        row.work_object_type,
        row.work_object_id,
        row.physical_context_type,
        row.physical_context_id,
        row.event_id,
        row.manifest_key,
        JSON.stringify(response),
        now,
        now,
        tenantId,
        row.device_action_id,
        row.event_id,
      )
      .run();
    reconciled += Number(result.meta.changes ?? 0);
  }
  return reconciled;
}

export function nativeWorkPackageCompletionAuthority(
  document: FrappeRow | null,
  actorUser: string | readonly string[] | null,
  actorRole: AppRole,
): boolean {
  const actorUsers = typeof actorUser === "string" ? [actorUser] : actorUser;
  if (!document || !actorUsers?.length) return false;
  const objectType = text(document.work_object_type);
  if (objectType === "Roof Job") return ["owner", "ops", "production"].includes(actorRole);
  const authorityRole = actorRole === "owner" ? "IronWrap Owner" : actorRole === "production" ? "IronWrap Production" : null;
  return (
    authorityRole !== null &&
    actorUsers.some((identity) => sameUser(text(document.authority_user), identity)) &&
    text(document.authority_role) === authorityRole
  );
}

function assertActorAuthority(
  row: NativePackageRow,
  definition: ReturnType<typeof parseDefinitionPayload> & object,
  input: NativeWorkPackageActionInput,
  actorIdentities: readonly string[],
): string {
  const worker = definition.assigned_workers.find(
    (candidate) =>
      candidate.required &&
      actorIdentities.some((identity) => sameUser(candidate.workerUser, identity)),
  );
  if (input.kind === "complete_work") {
    const authority = nativeWorkPackageCompletionAuthority(
      {
        work_object_type: row.work_object_type,
        authority_user: row.assignment_authority_user,
        authority_role: row.assignment_authority_role,
      },
      actorIdentities,
      input.actorRole as AppRole,
    );
    if (!authority) throw new Error("work_package_completion_authority_required");
    return roleLabel(input.actorRole);
  }
  if (!worker || (input.actorRole !== "field" && !sameUser(worker.workerRole, input.actorRole))) throw new Error("work_package_actor_not_assigned");
  if (input.kind === "stop_work") {
    if (!input.blockerReason?.trim()) throw new Error("work_package_blocker_reason_required");
    return worker.workerRole;
  }
  if (input.kind === "acknowledge" && ["Released", "Acknowledged"].includes(row.status)) return worker.workerRole;
  if (input.kind === "start_work" && row.status === "Acknowledged") return worker.workerRole;
  throw new Error("work_package_action_not_allowed");
}

interface NativeCommandScope {
  tenantId: string;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  releaseAttemptId: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
}

async function nativeCommandPackage(env: AppEnv, input: NativeCommandScope): Promise<NativePackageRow> {
  const configuredTenant = env.APP_TENANT_ID ?? "ironwrap";
  if (input.tenantId !== configuredTenant) throw new Error("work_package_tenant_mismatch");
  const row = await packageRow(env, input.tenantId, input.workPackageId, input.workPackageVersion);
  if (
    !row ||
    row.job_id !== input.jobId ||
    row.assignment_id !== input.assignmentId ||
    row.release_attempt_id !== input.releaseAttemptId ||
    row.work_object_type !== input.workObjectType ||
    row.work_object_id !== input.workObjectId ||
    row.physical_context_type !== input.physicalContextType ||
    row.physical_context_id !== input.physicalContextId
  )
    throw new Error("work_package_scope_conflict");
  return row;
}

function isCurrentPackageStatus(status: NativeWorkPackageStatus): boolean {
  return (CURRENT_STATUSES as readonly string[]).includes(status);
}

function authorityRoleCode(role: AppRole | string): AppRole | null {
  if (role === "owner" || role === "IronWrap Owner") return "owner";
  if (role === "ops" || role === "System Manager") return "ops";
  if (role === "production" || role === "IronWrap Production") return "production";
  if (role === "field" || role === "Field Worker") return "field";
  return null;
}

async function activeActorIdentities(
  env: AppEnv,
  tenantId: string,
  actorUser: string,
  actorRole: AppRole | string,
): Promise<string[]> {
  const role = authorityRoleCode(actorRole);
  if (!role) throw new Error("work_package_actor_role_invalid");
  const actor = await activeActor(env, tenantId, actorUser);
  if (actor.role !== role) throw new Error("work_package_actor_identity_invalid");
  return [actor.user_id, actor.email_normalized, actor.frappe_user_id].filter(
    (value): value is string => Boolean(value),
  );
}

interface ActiveActor {
  user_id: string;
  email_normalized: string;
  frappe_user_id: string | null;
  role: AppRole;
}

async function activeActor(
  env: AppEnv,
  tenantId: string,
  identity: string,
): Promise<ActiveActor> {
  const rows = await env.DB.prepare(
    `SELECT user_id, email_normalized, frappe_user_id, access_role AS role
       FROM app_users
      WHERE tenant_id = ? AND active = 1
        AND (
          lower(user_id) = lower(?)
          OR lower(email_normalized) = lower(?)
          OR lower(COALESCE(frappe_user_id, '')) = lower(?)
        )
      LIMIT 2`,
  )
    .bind(tenantId, identity, identity, identity)
    .all<ActiveActor>();
  if (rows.results.length !== 1)
    throw new Error("work_package_actor_identity_invalid");
  return rows.results[0];
}

function authorityLabelMatches(actorRole: AppRole | string, declared: string): boolean {
  const code = authorityRoleCode(actorRole);
  if (!code) return false;
  const labels: Record<Exclude<AppRole, "sales" | "accounting" | "field">, string[]> = {
    owner: ["IronWrap Owner", "Owner"],
    ops: ["System Manager", "Operations", "Supervisor"],
    production: ["IronWrap Production", "Production", "Supervisor"],
  };
  return (labels[code as Exclude<AppRole, "sales" | "accounting" | "field">] ?? []).some((label) => label.toLowerCase() === declared.trim().toLowerCase());
}

function holdReleaseAuthority(
  row: NativePackageRow,
  declaredAuthority: string,
  actorUsers: readonly string[],
  actorRole: AppRole | string,
): boolean {
  const code = authorityRoleCode(actorRole);
  if (!code || code === "field" || code === "sales" || code === "accounting") return false;
  if (!authorityLabelMatches(actorRole, declaredAuthority)) return false;
  if (row.work_object_type === "Roof Job") return true;
  return (
    actorUsers.some((identity) => sameUser(row.assignment_authority_user, identity)) &&
    (!row.assignment_authority_role || authorityLabelMatches(actorRole, row.assignment_authority_role))
  );
}

function reviewAuthority(row: NativePackageRow, actorUsers: readonly string[], actorRole: AppRole | string): boolean {
  const code = authorityRoleCode(actorRole);
  if (!code || !["owner", "ops", "production"].includes(code)) return false;
  if (row.work_object_type === "Roof Job") return true;
  return (
    actorUsers.some((identity) => sameUser(row.assignment_authority_user, identity)) &&
    (!row.assignment_authority_role || authorityLabelMatches(actorRole, row.assignment_authority_role))
  );
}

function assertReplayIdentity(
  existing: NativeEventRow,
  expected: {
    workPackageId: string;
    workPackageVersion: number;
    jobId: string;
    assignmentId: string;
    kind: string;
    actorUsers: readonly string[];
  },
): void {
  if (
    existing.work_package_id !== expected.workPackageId ||
    existing.work_package_version !== expected.workPackageVersion ||
    existing.job_id !== expected.jobId ||
    existing.assignment_id !== expected.assignmentId ||
    existing.event_kind !== expected.kind ||
    !expected.actorUsers.some((identity) => sameUser(existing.actor_user_id, identity))
  )
    throw new Error("work_package_device_action_conflict");
}

function assertEvidenceReviewReplay(
  existing: NativeEventRow,
  input: NativeWorkPackageEvidenceReviewInput,
  actorIdentities: readonly string[],
): void {
  assertReplayIdentity(existing, {
    workPackageId: input.workPackageId,
    workPackageVersion: input.workPackageVersion,
    jobId: input.jobId,
    assignmentId: input.assignmentId,
    kind: "evidence_reviewed",
    actorUsers: actorIdentities,
  });
  const payload = parseJson(existing.payload_json);
  if (
    payload?.target_event_id !== input.evidenceEventId ||
    payload?.evidence_item !== input.evidenceItem ||
    payload?.evidence_slot_id !== input.evidenceSlotId ||
    payload?.disposition !== input.disposition ||
    payload?.correction_reason !== (input.correctionReason ?? null)
  )
    throw new Error("work_package_device_action_conflict");
}

async function nativeCompletionReady(env: AppEnv, row: NativePackageRow, definition: ReturnType<typeof parseDefinitionPayload> & object): Promise<boolean> {
  const holdRows = await env.DB.prepare(
    `SELECT payload_json FROM work_package_events
      WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
        AND event_kind = 'hold_released'`,
  )
    .bind(row.tenant_id, row.work_package_id, row.version)
    .all<{ payload_json: string }>();
  const releasedHolds = new Set(
    holdRows.results.flatMap((event) => {
      const payload = parseJson(event.payload_json);
      return typeof payload?.hold_point_sequence === "number" ? [payload.hold_point_sequence] : [];
    }),
  );
  if (definition.hold_points.some((hold) => !releasedHolds.has(hold.sequence))) return false;
  const captures = await nativeEvidenceRows(env, row);
  if (!nativeEvidenceLedgerValid(captures, definition)) return false;
  const reviews = await env.DB.prepare(
    `SELECT payload_json FROM work_package_events
      WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
        AND event_kind = 'evidence_reviewed'
      ORDER BY occurred_at ASC, event_id ASC`,
  )
    .bind(row.tenant_id, row.work_package_id, row.version)
    .all<{ payload_json: string }>();
  const reviewDisposition = new Map<string, string>();
  for (const review of reviews.results) {
    const payload = parseJson(review.payload_json);
    if (typeof payload?.target_event_id === "string" && typeof payload.disposition === "string") {
      reviewDisposition.set(payload.target_event_id, payload.disposition);
    }
  }
  const required = [...definition.steps.map((step) => `step:${step.sequence}`), ...definition.hold_points.map((hold) => `hold:${hold.sequence}`)];
  const superseded = new Set(captures.map((capture) => text(capture.evidence_correction_of)).filter((eventId): eventId is string => Boolean(eventId)));
  const current = new Map<string, { eventId: string; correctionOf: string | null; valid: boolean }>();
  for (const capture of captures) {
    const evidenceItem = text(capture.evidence_item);
    const eventId = evidenceItem ? evidenceEventId(evidenceItem) : null;
    const correctionOf = text(capture.evidence_correction_of);
    const slotId = text(capture.evidence_slot_id);
    if (!eventId || !slotId) continue;
    if (superseded.has(eventId)) continue;
    if (current.has(slotId)) {
      current.get(slotId)!.valid = false;
      continue;
    }
    current.set(slotId, {
      eventId,
      correctionOf,
      valid:
        text(capture.evidence_verification) === "Verified" &&
        text(capture.evidence_disposition) === "Open" &&
        text(capture.evidence_freshness) === "Current" &&
        ["None", "Resolved"].includes(text(capture.evidence_conflict_state) ?? ""),
    });
  }
  return required.every((slot) => {
    const capture = current.get(slot);
    return !!capture && capture.valid && reviewDisposition.get(capture.eventId) === "Accepted";
  });
}

function nativeEvidenceLedgerValid(captures: FrappeRow[], definition: ReturnType<typeof parseDefinitionPayload> & object): boolean {
  const events = new Map<string, FrappeRow>();
  const devices = new Set<string>();
  const correctionTargets = new Set<string>();
  const workers = new Map(definition.assigned_workers.map((worker) => [worker.workerUser.toLowerCase(), worker.workerRole]));
  for (const capture of captures) {
    const evidenceItem = text(capture.evidence_item);
    const eventId = text(capture.name);
    const actorUser = text(capture.actor_user);
    const actorRole = text(capture.actor_role);
    const deviceActionId = text(capture.device_action_id);
    const slotId = text(capture.evidence_slot_id);
    const correctionOf = text(capture.evidence_correction_of);
    const itemCorrectionOf = text(capture.evidence_item_correction_of);
    const correctionReason = text(capture.correction_reason);
    if (
      !evidenceItem ||
      !eventId ||
      eventId !== evidenceEventId(evidenceItem) ||
      !actorUser ||
      !actorRole ||
      !deviceActionId ||
      !slotId ||
      text(capture.evidence_verification) !== "Verified" ||
      text(capture.evidence_disposition) !== "Open" ||
      Boolean(correctionOf) !== Boolean(itemCorrectionOf) ||
      (correctionOf && !correctionReason) ||
      (!correctionOf && correctionReason) ||
      devices.has(deviceActionId) ||
      events.has(eventId) ||
      (workers.size > 0 && workers.get(actorUser.toLowerCase()) !== actorRole)
    )
      return false;
    devices.add(deviceActionId);
    events.set(eventId, capture);
    if (correctionOf) {
      if (correctionTargets.has(correctionOf)) return false;
      correctionTargets.add(correctionOf);
    }
  }
  for (const capture of events.values()) {
    const correctionOf = text(capture.evidence_correction_of);
    if (!correctionOf) continue;
    const target = events.get(correctionOf);
    if (
      !target ||
      text(target.evidence_slot_id) !== text(capture.evidence_slot_id) ||
      sameUser(text(target.actor_user), text(capture.actor_user)) === false ||
      text(target.evidence_item) !== text(capture.evidence_item_correction_of)
    )
      return false;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (eventId: string): boolean => {
    if (visiting.has(eventId)) return false;
    if (visited.has(eventId)) return true;
    const event = events.get(eventId);
    if (!event) return false;
    visiting.add(eventId);
    const correctionOf = text(event.evidence_correction_of);
    if (correctionOf && !visit(correctionOf)) return false;
    visiting.delete(eventId);
    visited.add(eventId);
    return true;
  };
  return [...events.keys()].every(visit);
}

async function nativeEvidenceRows(env: AppEnv, row: NativePackageRow): Promise<FrappeRow[]> {
  let result: { results?: NativeEvidenceRow[] };
  try {
    result = await env.DB.prepare(
      `SELECT a.device_action_id, a.user_id, a.user_id AS actor_user,
              COALESCE(NULLIF(u.access_role, ''), u.role) AS actor_role,
              a.created_at, a.work_package_id, a.work_package_version,
              a.evidence_slot_id, a.evidence_requirement, a.evidence_source,
              a.evidence_device_id, a.evidence_freshness, a.evidence_conflict_state,
              a.evidence_verification, a.evidence_disposition,
              a.evidence_correction_of, a.evidence_item_correction_of,
              a.work_package_release_attempt_id, a.correction_reason,
              a.work_object_type, a.work_object_id, a.physical_context_type,
              a.physical_context_id, a.capture_completed_at, m.evidence_id
         FROM field_actions a
         JOIN field_action_media m ON m.device_action_id = a.device_action_id
         LEFT JOIN app_users u ON u.user_id = a.user_id AND u.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.status = 'verified'
          AND a.manifest_key IS NOT NULL AND m.r2_stored_at IS NOT NULL
          AND a.job_id = ? AND a.assignment_id = ?
          AND a.work_package_id = ? AND a.work_package_version = ?
          AND a.work_package_release_attempt_id = ?
          AND a.work_object_type = ? AND a.work_object_id = ?
          AND a.physical_context_type = ? AND a.physical_context_id = ?
        ORDER BY a.created_at ASC, a.device_action_id ASC, m.attachment_id ASC`,
    )
      .bind(
        row.tenant_id,
        row.job_id,
        row.assignment_id,
        row.work_package_id,
        row.version,
        row.release_attempt_id,
        row.work_object_type,
        row.work_object_id,
        row.physical_context_type,
        row.physical_context_id,
      )
      .all<NativeEvidenceRow>();
  } catch (error) {
    if (isMissingNativeEvidenceSchema(error)) return [];
    throw error;
  }
  const definition = parseDefinitionPayload(row.definition_json);
  return (result.results ?? []).map((capture) => ({
    name: evidenceEventId(capture.evidence_id),
    event_type: "Evidence Captured",
    work_package: row.work_package_id,
    roof_job: row.work_object_type === "Roof Job" ? row.job_id : null,
    job_assignment: row.assignment_id,
    work_object_type: capture.work_object_type,
    work_object_id: capture.work_object_id,
    physical_context_type: capture.physical_context_type,
    physical_context_id: capture.physical_context_id,
    work_package_version: row.version,
    release_attempt_id: capture.work_package_release_attempt_id,
    actor_user: capture.actor_user ?? capture.user_id,
    actor_role:
      definition?.assigned_workers.find((worker) => sameUser(worker.workerUser, capture.actor_user ?? capture.user_id))?.workerRole ??
      capture.actor_role ??
      "Field Worker",
    device_action_id: capture.device_action_id,
    occurred_at: capture.created_at,
    evidence_item: capture.evidence_id,
    evidence_slot_id: capture.evidence_slot_id,
    evidence_requirement: capture.evidence_requirement,
    evidence_source: capture.evidence_source,
    evidence_device_id: capture.evidence_device_id,
    evidence_captured_at: capture.capture_completed_at ?? capture.created_at,
    evidence_freshness: capture.evidence_freshness,
    evidence_conflict_state: capture.evidence_conflict_state,
    evidence_correction_of: capture.evidence_correction_of,
    evidence_item_correction_of: capture.evidence_item_correction_of,
    evidence_verification: capture.evidence_verification,
    evidence_disposition: capture.evidence_disposition,
    correction_reason: capture.correction_reason,
  }));
}

async function packageRow(env: AppEnv, tenantId: string, workPackageId: string, version: number): Promise<NativePackageRow | null> {
  return await env.DB.prepare(
    `SELECT work_package_id, tenant_id, version, job_id, assignment_id,
            work_object_type, work_object_id, physical_context_type, physical_context_id,
            assignment_authority_user, assignment_authority_role, status,
            assignment_version, assignment_command_fingerprint,
            assignment_authority_requirements_sha256,
            title, objective, boundaries, prerequisites, expected_result,
            stop_conditions, make_safe_procedure, definition_json, issued_at,
            expires_at, released_at, release_attempt_id, supersedes_id,
            correction_reason, acknowledged_at, completed_at, created_at, updated_at
       FROM work_packages
      WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
  )
    .bind(tenantId, workPackageId, version)
    .first<NativePackageRow>();
}

async function eventByDeviceAction(env: AppEnv, tenantId: string, deviceActionId: string): Promise<NativeEventRow | null> {
  return await env.DB.prepare(
    `SELECT event_id, tenant_id, work_package_id, work_package_version,
            job_id, assignment_id, work_object_type, work_object_id,
            physical_context_type, physical_context_id, release_attempt_id,
            event_kind, actor_user_id, actor_role, device_action_id, occurred_at,
            manifest_key, payload_json, created_at
       FROM work_package_events WHERE tenant_id = ? AND device_action_id = ?`,
  )
    .bind(tenantId, deviceActionId)
    .first<NativeEventRow>();
}

async function insertEvent(
  env: AppEnv,
  event: NativeEventInsert,
): Promise<void> {
  await eventStatement(env, event).run();
}

function eventStatement(env: AppEnv, event: NativeEventInsert) {
  return env.DB.prepare(
    `INSERT INTO work_package_events
      (event_id, tenant_id, work_package_id, work_package_version, job_id,
       assignment_id, work_object_type, work_object_id, physical_context_type,
       physical_context_id, release_attempt_id, event_kind, actor_user_id,
       actor_role, device_action_id, occurred_at, manifest_key, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.eventId,
      event.tenantId,
      event.workPackageId,
      event.workPackageVersion,
      event.jobId,
      event.assignmentId,
      event.workObjectType,
      event.workObjectId,
      event.physicalContextType,
      event.physicalContextId,
      event.releaseAttemptId,
      event.eventKind,
      event.actorUserId,
      event.actorRole,
      event.deviceActionId,
      event.occurredAt,
      event.manifestKey,
      canonicalJson(event.payload),
      event.occurredAt,
    );
}

function packageDocument(row: NativePackageRow, payload: ReturnType<typeof parseDefinitionPayload> & object): FrappeRow {
  return {
    name: row.work_package_id,
    source_system: "ironwrap-d1",
    work_package_id: row.work_package_id,
    roof_job: row.work_object_type === "Roof Job" ? row.job_id : null,
    job_assignment: row.assignment_id,
    work_object_type: row.work_object_type,
    work_object_id: row.work_object_id,
    physical_context_type: row.physical_context_type,
    physical_context_id: row.physical_context_id,
    version: row.version,
    status: row.status,
    title: row.title,
    objective: row.objective,
    boundaries: row.boundaries,
    prerequisites: row.prerequisites,
    expected_result: row.expected_result,
    stop_conditions: row.stop_conditions,
    make_safe_procedure: row.make_safe_procedure,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
    release_attempt_id: row.release_attempt_id,
    acknowledged_by: null,
    acknowledged_at: row.acknowledged_at,
    supersedes: row.supersedes_id,
    correction_reason: row.correction_reason,
    ...(payload.authority_requirements_json === undefined
      ? {}
      : {
          authority_requirements_json:
            payload.authority_requirements_json,
        }),
    assigned_workers: payload.assigned_workers.map((worker) => ({
      sequence: worker.sequence,
      worker_user: worker.workerUser,
      worker_role: worker.workerRole,
      required: worker.required,
    })),
    steps: payload.steps.map((step) => ({
      sequence: step.sequence,
      instruction: step.instruction,
      required_evidence: step.requiredEvidence,
      acceptance_criteria: step.acceptanceCriteria,
    })),
    hold_points: payload.hold_points.map((hold) => ({
      sequence: hold.sequence,
      hold_point: hold.holdPoint,
      release_phase: hold.releasePhase,
      release_authority: hold.releaseAuthority,
      required_evidence: hold.requiredEvidence,
      acceptance_criteria: hold.acceptanceCriteria,
    })),
    modified: row.updated_at,
    authority_user: row.assignment_authority_user,
    authority_role: row.assignment_authority_role,
  };
}

function eventDocument(row: NativeEventRow): FrappeRow {
  const payload = parseJson(row.payload_json) ?? {};
  const eventType: Record<string, string> = {
    issued: "Issued",
    hold_released: "Hold Point Released",
    acknowledged: "Acknowledged",
    start_work: "Work Started",
    stop_work: "Work Stopped",
    complete_work: "Work Completed",
    evidence_reviewed: "Evidence Reviewed",
    reconciled: "Reconciled",
  };
  return {
    name: row.event_id,
    event_type: eventType[row.event_kind] ?? row.event_kind,
    work_package: row.work_package_id,
    roof_job: row.work_object_type === "Roof Job" ? row.job_id : null,
    job_assignment: row.assignment_id,
    work_object_type: row.work_object_type,
    work_object_id: row.work_object_id,
    physical_context_type: row.physical_context_type,
    physical_context_id: row.physical_context_id,
    work_package_version: row.work_package_version,
    release_attempt_id: row.release_attempt_id,
    actor_user: row.actor_user_id,
    actor_role: row.actor_role,
    device_action_id: row.device_action_id,
    occurred_at: row.occurred_at,
    evidence_item: payload.evidence_item ?? null,
    evidence_slot_id: payload.evidence_slot_id ?? null,
    evidence_requirement: payload.evidence_requirement ?? null,
    evidence_source: payload.evidence_source ?? null,
    evidence_device_id: payload.evidence_device_id ?? null,
    evidence_review_of: payload.target_event_id ?? null,
    evidence_disposition: payload.disposition ?? null,
    correction_reason: payload.correction_reason ?? null,
    hold_point_sequence: payload.hold_point_sequence ?? null,
  };
}

function definitionPayload(definition: NativeWorkPackageDefinition) {
  return {
    tenant_id: definition.tenantId,
    work_package_id: definition.workPackageId,
    version: definition.version,
    job_id: definition.jobId,
    assignment_id: definition.assignmentId,
    assignment_version: definition.assignmentVersion,
    assignment_command_fingerprint: definition.assignmentCommandFingerprint,
    assignment_authority_requirements_sha256:
      definition.assignmentAuthorityRequirementsSha256,
    issue_request_sha256: definition.issueRequestSha256,
    work_object_type: definition.workObjectType,
    work_object_id: definition.workObjectId,
    physical_context_type: definition.physicalContextType,
    physical_context_id: definition.physicalContextId,
    assignment_authority_user: definition.assignmentAuthorityUser ?? null,
    assignment_authority_role: definition.assignmentAuthorityRole ?? null,
    title: definition.title,
    objective: definition.objective,
    boundaries: definition.boundaries,
    prerequisites: definition.prerequisites,
    expected_result: definition.expectedResult,
    stop_conditions: definition.stopConditions,
    make_safe_procedure: definition.makeSafeProcedure,
    issued_at: definition.issuedAt,
    expires_at: definition.expiresAt,
    released_at: definition.releasedAt,
    release_attempt_id: definition.releaseAttemptId,
    authority_requirements: definition.authorityRequirements,
    supersedes_id: definition.supersedesId ?? null,
    supersedes_version: definition.supersedesVersion ?? null,
    correction_reason: definition.correctionReason ?? null,
    issued_by_user: definition.issuedByUser,
    issued_by_role: definition.issuedByRole,
    assigned_workers: definition.assignedWorkers.map((worker) => ({
      sequence: worker.sequence,
      worker_user: worker.workerUser,
      worker_role: worker.workerRole,
      required: worker.required,
    })),
    steps: definition.steps.map((step) => ({
      sequence: step.sequence,
      instruction: step.instruction,
      required_evidence: step.requiredEvidence,
      acceptance_criteria: step.acceptanceCriteria,
    })),
    hold_points: definition.holdPoints.map((hold) => ({
      sequence: hold.sequence,
      hold_point: hold.holdPoint,
      release_phase: hold.releasePhase,
      release_authority: hold.releaseAuthority,
      required_evidence: hold.requiredEvidence,
      acceptance_criteria: hold.acceptanceCriteria,
    })),
  };
}

function parseDefinitionPayload(value: string): {
  assigned_workers: NativeWorkPackageWorker[];
  steps: NativeWorkPackageStep[];
  hold_points: NativeWorkPackageHoldPoint[];
  authority_requirements_json?: string;
} | null {
  const parsed = parseJson(value);
  if (!parsed || !Array.isArray(parsed.assigned_workers) || !Array.isArray(parsed.steps) || !Array.isArray(parsed.hold_points)) return null;
  const assignedWorkers = parsed.assigned_workers.map((value) => {
    const worker = value as Record<string, unknown>;
    return {
      sequence: Number(worker.sequence),
      workerUser: text(worker.worker_user) ?? "",
      workerRole: text(worker.worker_role) ?? "",
      required: worker.required === true,
    } satisfies NativeWorkPackageWorker;
  });
  const steps = parsed.steps.map((value) => {
    const step = value as Record<string, unknown>;
    return {
      sequence: Number(step.sequence),
      instruction: text(step.instruction) ?? "",
      requiredEvidence: text(step.required_evidence) ?? "",
      acceptanceCriteria: text(step.acceptance_criteria) ?? "",
    } satisfies NativeWorkPackageStep;
  });
  const holdPoints = parsed.hold_points.map((value) => {
    const hold = value as Record<string, unknown>;
    return {
      sequence: Number(hold.sequence),
      holdPoint: text(hold.hold_point) ?? "",
      releasePhase: hold.release_phase as NativeWorkPackageHoldPoint["releasePhase"],
      releaseAuthority: text(hold.release_authority) ?? "",
      requiredEvidence: text(hold.required_evidence) ?? "",
      acceptanceCriteria: text(hold.acceptance_criteria) ?? "",
    } satisfies NativeWorkPackageHoldPoint;
  });
  if (
    assignedWorkers.some((worker) => !Number.isInteger(worker.sequence) || !worker.workerUser || !worker.workerRole) ||
    steps.some((step) => !Number.isInteger(step.sequence) || !step.instruction || !step.requiredEvidence || !step.acceptanceCriteria) ||
    holdPoints.some(
      (hold) =>
        !Number.isInteger(hold.sequence) ||
        !hold.holdPoint ||
        !hold.releaseAuthority ||
        !hold.requiredEvidence ||
        !hold.acceptanceCriteria ||
        !["Pre-start", "In-process", "Completion"].includes(hold.releasePhase),
    )
  )
    return null;
  const authorityRequirementsJson = Object.hasOwn(
      parsed,
      "authority_requirements",
    )
    ? JSON.stringify(parsed.authority_requirements)
    : undefined;
  return {
    assigned_workers: assignedWorkers,
    steps,
    hold_points: holdPoints,
    ...(authorityRequirementsJson === undefined
      ? {}
      : { authority_requirements_json: authorityRequirementsJson }),
  };
}

function validateDefinition(definition: NativeWorkPackageDefinition, env: AppEnv): void {
  const configuredTenant = env.APP_TENANT_ID ?? "ironwrap";
  if (!definition.tenantId || definition.tenantId !== configuredTenant) throw new Error("work_package_tenant_mismatch");
  for (const value of [
    definition.workPackageId,
    definition.jobId,
    definition.assignmentId,
    definition.workObjectType,
    definition.workObjectId,
    definition.physicalContextType,
    definition.physicalContextId,
    definition.releaseAttemptId,
    definition.issuedByUser,
    definition.deviceActionId,
  ]) {
    if (!text(value) || !/^[A-Za-z0-9._:@ -]+$/.test(value)) throw new Error("work_package_definition_invalid");
  }
  for (const value of [
    definition.issuedByRole,
    definition.title,
    definition.objective,
    definition.boundaries,
    definition.prerequisites,
    definition.expectedResult,
    definition.stopConditions,
    definition.makeSafeProcedure,
    definition.assignmentAuthorityUser,
    definition.assignmentAuthorityRole,
  ]) {
    if (value !== null && value !== undefined && !text(value)) throw new Error("work_package_definition_invalid");
  }
  if (
    !text(definition.issuedByRole) ||
    !text(definition.title) ||
    !text(definition.objective) ||
    !text(definition.boundaries) ||
    !text(definition.prerequisites) ||
    !text(definition.expectedResult) ||
    !text(definition.stopConditions) ||
    !text(definition.makeSafeProcedure)
  ) {
    throw new Error("work_package_definition_invalid");
  }
  if (!Number.isInteger(definition.version) || definition.version < 1)
    throw new Error("work_package_definition_invalid");
  if (
    !Number.isInteger(definition.assignmentVersion) ||
    definition.assignmentVersion < 1 ||
    !/^[0-9a-f]{64}$/.test(definition.assignmentCommandFingerprint) ||
    !/^[0-9a-f]{64}$/.test(definition.assignmentAuthorityRequirementsSha256) ||
    !/^[0-9a-f]{64}$/.test(definition.issueRequestSha256)
  ) {
    throw new Error("work_package_assignment_snapshot_invalid");
  }
  if (!text(definition.manifestKey) || definition.manifestKey.length > 1024)
    throw new Error("work_package_definition_invalid");
  if (
    (definition.version === 1 &&
      (definition.supersedesId != null ||
        definition.supersedesVersion != null ||
        definition.correctionReason != null)) ||
    (definition.version > 1 &&
      (!text(definition.supersedesId) ||
        definition.supersedesVersion !== definition.version - 1 ||
        !text(definition.correctionReason)))
  )
    throw new Error("work_package_supersession_invalid");
  for (const timestamp of [
    definition.issuedAt,
    definition.expiresAt,
    definition.releasedAt,
  ]) {
    if (!timestamp || Number.isNaN(Date.parse(timestamp)))
      throw new Error("work_package_definition_invalid");
  }
  if (Date.parse(definition.expiresAt) <= Date.parse(definition.issuedAt)) throw new Error("work_package_expiry_invalid");
  if (
    !definition.steps.length ||
    !definition.holdPoints.length ||
    !definition.assignedWorkers.length ||
    definition.steps.length > 100 ||
    definition.holdPoints.length > 100 ||
    definition.assignedWorkers.length > 50
  )
    throw new Error("work_package_definition_incomplete");
  assertSequences(definition.steps.map((row) => row.sequence));
  assertSequences(definition.holdPoints.map((row) => row.sequence));
  assertSequences(definition.assignedWorkers.map((row) => row.sequence));
  if (
    definition.steps.some((step) => !text(step.instruction) || !text(step.requiredEvidence) || !text(step.acceptanceCriteria)) ||
    definition.holdPoints.some(
      (hold) =>
        !text(hold.holdPoint) || !text(hold.releasePhase) || !text(hold.releaseAuthority) || !text(hold.requiredEvidence) || !text(hold.acceptanceCriteria),
    ) ||
    definition.assignedWorkers.some((worker) => !text(worker.workerUser) || !text(worker.workerRole))
  )
    throw new Error("work_package_definition_incomplete");
  if (!definition.assignedWorkers.some((worker) => worker.required)) throw new Error("work_package_required_worker_missing");
  const workers = definition.assignedWorkers.map((worker) => worker.workerUser.toLowerCase());
  if (new Set(workers).size !== workers.length) throw new Error("work_package_worker_duplicate");
}

async function canonicalDefinitionActors(
  env: AppEnv,
  definition: NativeWorkPackageDefinition,
): Promise<NativeWorkPackageDefinition> {
  const issuer = await activeActor(
    env,
    definition.tenantId,
    definition.issuedByUser,
  );
  if (
    !["owner", "ops", "production"].includes(issuer.role) ||
    roleLabel(issuer.role) !== definition.issuedByRole
  )
    throw new Error("work_package_issuer_authority_required");
  const assignedWorkers = [];
  for (const worker of definition.assignedWorkers) {
    const actor = await activeActor(env, definition.tenantId, worker.workerUser);
    if (actor.role !== "field")
      throw new Error("work_package_worker_authority_invalid");
    assignedWorkers.push({ ...worker, workerUser: actor.user_id });
  }
  const authorityUser = text(definition.assignmentAuthorityUser);
  const authorityRole = text(definition.assignmentAuthorityRole);
  if (definition.workObjectType !== "Roof Job" && (!authorityUser || !authorityRole))
    throw new Error("work_package_assignment_authority_required");
  if (authorityUser || authorityRole) {
    if (!authorityUser || !authorityRole)
      throw new Error("work_package_assignment_authority_invalid");
    const authority = await activeActor(env, definition.tenantId, authorityUser);
    if (
      !["owner", "production"].includes(authority.role) ||
      roleLabel(authority.role) !== authorityRole
    )
      throw new Error("work_package_assignment_authority_invalid");
    return {
      ...definition,
      issuedByUser: issuer.user_id,
      assignmentAuthorityUser: authority.user_id,
      assignedWorkers,
    };
  }
  return { ...definition, issuedByUser: issuer.user_id, assignedWorkers };
}

function assertSequences(values: number[]): void {
  if (values.some((value, index) => !Number.isInteger(value) || value !== index + 1)) throw new Error("work_package_sequence_invalid");
}

function roleLabel(role: AppRole | string): string {
  return ROLE_LABELS[role as AppRole] ?? role;
}

function sameUser(left: string | null, right: string | null): boolean {
  return !!left && !!right && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceEventId(evidenceId: string): string {
  return /^evi_[0-9a-f]{32}$/.test(evidenceId) ? `wpe_${evidenceId.slice(4)}` : `wpe_${evidenceId.replace(/[^A-Za-z0-9._:-]/g, "_")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMissingNativeEvidenceSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table: field_actions|no such table: field_action_media|no such column: a\.work_object_type/i.test(message);
}
