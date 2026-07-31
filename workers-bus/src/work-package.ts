import type { AppEnv } from "./app-types.ts";
import {
  FIELD_WORK_PACKAGE_CURRENT_STATUSES,
  listFieldWorkPackageHoldReleases,
  listFieldWorkPackagesForAssignment,
  readFieldWorkPackageFrappeResource,
  type FrappeRow,
} from "./frappe-read.ts";

const CURRENT_WORK_PACKAGE_STATUSES = FIELD_WORK_PACKAGE_CURRENT_STATUSES;

export interface FieldWorkPackage {
  name: string;
  id: string;
  version: number;
  status: (typeof CURRENT_WORK_PACKAGE_STATUSES)[number];
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
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  steps: Array<{
    sequence: number;
    instruction: string;
    requiredEvidence: string;
    acceptanceCriteria: string;
  }>;
  holdPoints: Array<{
    sequence: number;
    holdPoint: string;
    releaseAuthority: string;
    requiredEvidence: string;
    acceptanceCriteria: string;
    released: boolean;
  }>;
  modified: string | null;
}

/**
 * Return exactly one current package for the already-authorized assignment. A
 * duplicate current package is an office-side ambiguity, never a browser-side
 * choice or a write target.
 */
export async function fieldWorkPackageForAssignment(
  env: AppEnv,
  jobId: string,
  assignmentId: string,
): Promise<FieldWorkPackage | null> {
  const matches = await listFieldWorkPackagesForAssignment(
    env,
    jobId,
    assignmentId,
  );
  if (matches.length !== 1) return null;
  const name = text(matches[0]?.name);
  if (!name) return null;
  const document = await readFieldWorkPackageFrappeResource(env, name);
  if (
    !document ||
    text(document.roof_job) !== jobId ||
    text(document.job_assignment) !== assignmentId
  ) {
    return null;
  }
  const workPackage = fieldWorkPackage(document);
  if (!workPackage) return null;
  const releases = await listFieldWorkPackageHoldReleases(
    env,
    workPackage.name,
    jobId,
    assignmentId,
    workPackage.version,
  );
  return withVerifiedHoldReleases(workPackage, releases, jobId, assignmentId);
}

export function fieldWorkPackageProjection(
  workPackage: FieldWorkPackage | null,
  actorUser: string | null,
): {
  work_package: {
    id: string;
    version: number;
    status: FieldWorkPackage["status"];
    title: string;
    objective: string;
    boundaries: string;
    prerequisites: string;
    expected_result: string;
    stop_conditions: string;
    make_safe_procedure: string;
    issued_at: string;
    expires_at: string;
    released_at: string;
    acknowledgement: {
      current_user_acknowledged: boolean;
      acknowledged_at: string | null;
    };
    steps: Array<{
      sequence: number;
      instruction: string;
      required_evidence: string;
      acceptance_criteria: string;
    }>;
    hold_points: Array<{
      sequence: number;
      hold_point: string;
      release_authority: string;
      required_evidence: string;
      acceptance_criteria: string;
      released: boolean;
    }>;
  } | null;
  allowedActions: string[];
} {
  if (!workPackage) return { work_package: null, allowedActions: [] };
  const currentUserAcknowledged = sameUser(
    workPackage.acknowledgedBy,
    actorUser,
  );
  const allowedActions = [
    ...(workPackage.status === "Released" && !currentUserAcknowledged
      ? ["work_package.acknowledge"]
      : []),
    // Starting work is intentionally not an outbox capability. The browser
    // must make this request while online, and the Frappe command repeats the
    // current-release and exact-assignment checks before its state transition.
    ...(workPackage.status === "Acknowledged" &&
    currentUserAcknowledged &&
    workPackage.holdPoints.every((holdPoint) => holdPoint.released)
      ? ["work_package.start"]
      : []),
    ...(CURRENT_WORK_PACKAGE_STATUSES.includes(workPackage.status)
      ? ["work_package.stop_work"]
      : []),
  ];
  return {
    work_package: {
      id: workPackage.id,
      version: workPackage.version,
      status: workPackage.status,
      title: workPackage.title,
      objective: workPackage.objective,
      boundaries: workPackage.boundaries,
      prerequisites: workPackage.prerequisites,
      expected_result: workPackage.expectedResult,
      stop_conditions: workPackage.stopConditions,
      make_safe_procedure: workPackage.makeSafeProcedure,
      issued_at: workPackage.issuedAt,
      expires_at: workPackage.expiresAt,
      released_at: workPackage.releasedAt,
      acknowledgement: {
        current_user_acknowledged: currentUserAcknowledged,
        acknowledged_at: currentUserAcknowledged
          ? workPackage.acknowledgedAt
          : null,
      },
      steps: workPackage.steps.map((step) => ({
        sequence: step.sequence,
        instruction: step.instruction,
        required_evidence: step.requiredEvidence,
        acceptance_criteria: step.acceptanceCriteria,
      })),
      hold_points: workPackage.holdPoints.map((holdPoint) => ({
        sequence: holdPoint.sequence,
        hold_point: holdPoint.holdPoint,
        release_authority: holdPoint.releaseAuthority,
        required_evidence: holdPoint.requiredEvidence,
        acceptance_criteria: holdPoint.acceptanceCriteria,
        released: holdPoint.released,
      })),
    },
    allowedActions,
  };
}

function fieldWorkPackage(row: FrappeRow): FieldWorkPackage | null {
  const name = text(row.name);
  const id = text(row.work_package_id);
  const status = text(row.status);
  const version = integer(row.version);
  if (!name || !id || !version || !isCurrentStatus(status)) return null;
  const title = text(row.title);
  const objective = text(row.objective);
  const boundaries = text(row.boundaries);
  const prerequisites = text(row.prerequisites);
  const expectedResult = text(row.expected_result);
  const stopConditions = text(row.stop_conditions);
  const makeSafeProcedure = text(row.make_safe_procedure);
  const issuedAt = timestamp(row.issued_at);
  const expiresAt = timestamp(row.expires_at);
  const releasedAt = timestamp(row.released_at);
  if (
    !title ||
    !objective ||
    !boundaries ||
    !prerequisites ||
    !expectedResult ||
    !stopConditions ||
    !makeSafeProcedure ||
    !issuedAt ||
    !expiresAt ||
    !releasedAt
  )
    return null;
  const steps = orderedRows(row.steps, (item, sequence) => {
    const instruction = text(item.instruction);
    const requiredEvidence = text(item.required_evidence);
    const acceptanceCriteria = text(item.acceptance_criteria);
    return instruction && requiredEvidence && acceptanceCriteria
      ? { sequence, instruction, requiredEvidence, acceptanceCriteria }
      : null;
  });
  const holdPoints = orderedRows(row.hold_points, (item, sequence) => {
    const holdPoint = text(item.hold_point);
    const releaseAuthority = text(item.release_authority);
    const requiredEvidence = text(item.required_evidence);
    const acceptanceCriteria = text(item.acceptance_criteria);
    return holdPoint &&
      releaseAuthority &&
      requiredEvidence &&
      acceptanceCriteria
      ? {
          sequence,
          holdPoint,
          releaseAuthority,
          requiredEvidence,
          acceptanceCriteria,
          released: false,
        }
      : null;
  });
  if (!steps || !holdPoints) return null;
  return {
    name,
    id,
    version,
    status,
    title,
    objective,
    boundaries,
    prerequisites,
    expectedResult,
    stopConditions,
    makeSafeProcedure,
    issuedAt,
    expiresAt,
    releasedAt,
    acknowledgedBy: text(row.acknowledged_by),
    acknowledgedAt: text(row.acknowledged_at),
    steps,
    holdPoints,
    modified: text(row.modified),
  };
}

/**
 * A release entry is usable only when it is exactly bound to this package,
 * assignment, version, and declared hold. Any ledger ambiguity clears every
 * projected release bit so the browser cannot start work from partial proof.
 */
function withVerifiedHoldReleases(
  workPackage: FieldWorkPackage,
  rows: FrappeRow[],
  jobId: string,
  assignmentId: string,
): FieldWorkPackage {
  const declared = new Set(
    workPackage.holdPoints.map((holdPoint) => holdPoint.sequence),
  );
  const released = new Set<number>();
  for (const row of rows) {
    const sequence = integer(row.hold_point_sequence);
    if (
      text(row.event_type) !== "Hold Point Released" ||
      text(row.work_package) !== workPackage.name ||
      text(row.roof_job) !== jobId ||
      text(row.job_assignment) !== assignmentId ||
      integer(row.work_package_version) !== workPackage.version ||
      !sequence ||
      !declared.has(sequence) ||
      released.has(sequence) ||
      !text(row.evidence_item)
    ) {
      return {
        ...workPackage,
        holdPoints: workPackage.holdPoints.map((holdPoint) => ({
          ...holdPoint,
          released: false,
        })),
      };
    }
    released.add(sequence);
  }
  return {
    ...workPackage,
    holdPoints: workPackage.holdPoints.map((holdPoint) => ({
      ...holdPoint,
      released: released.has(holdPoint.sequence),
    })),
  };
}

function orderedRows<T>(
  value: unknown,
  project: (row: FrappeRow, sequence: number) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sequence = integer(item.sequence);
    if (!sequence) return [];
    const projected = project(item, sequence);
    return projected ? [{ sequence, projected }] : [];
  });
  if (rows.length !== value.length) return null;
  rows.sort((left, right) => left.sequence - right.sequence);
  return rows.every((row, index) => row.sequence === index + 1)
    ? rows.map((row) => row.projected)
    : null;
}

function integer(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isCurrentStatus(
  value: string | null,
): value is FieldWorkPackage["status"] {
  return CURRENT_WORK_PACKAGE_STATUSES.includes(
    value as FieldWorkPackage["status"],
  );
}

function sameUser(left: string | null, right: string | null): boolean {
  return (
    !!left &&
    !!right &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestamp(value: unknown): string | null {
  const parsed = text(value);
  return parsed && !Number.isNaN(Date.parse(parsed)) ? parsed : null;
}

function isRecord(value: unknown): value is FrappeRow {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
