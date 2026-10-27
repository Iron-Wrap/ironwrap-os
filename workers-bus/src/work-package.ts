import type {
  AppEnv,
  AppRole,
  AuthContext,
  WorkObjectScope,
} from "./app-types.ts";
import { appUserIdentities } from "./app-types.ts";
import {
  authorityCurrentPrecondition,
  parseAuthorityRequirements,
  resolveAuthorityRequirement,
  type AuthorityCurrentPrecondition,
  type AuthorityLifecycleDenial,
  type AuthorityRequirement,
} from "./authority-records.ts";
import {
  FieldActionError,
  type FieldEvidenceAuthorization,
  type FieldSubmission,
} from "./field-actions.ts";
import type { FrappeRow } from "./frappe-read.ts";
import type { SafetyBlocker } from "./safety-lifecycle.ts";
import {
  nativeWorkPackageDocumentById,
  nativeWorkPackageForAssignment,
  type NativeWorkPackageRead,
} from "./work-package-store.ts";

const CURRENT_WORK_PACKAGE_STATUSES = [
  "Released",
  "Acknowledged",
  "In Progress",
  "Blocked",
] as const;
type EvidenceFreshness = "Current" | "Stale" | "Unknown";
type EvidenceConflictState = "None" | "Detected" | "Resolved";
type EvidenceVerification = "Pending" | "Verified" | "Rejected";
type EvidenceDisposition =
  "Open" | "Accepted" | "Needs Correction" | "Superseded";

export interface FieldWorkPackageWorker {
  sequence: number;
  workerUser: string;
  workerRole: string;
  required: boolean;
}

export interface FieldWorkPackageAcknowledgement {
  actorUser: string;
  actorRole: string;
  deviceActionId: string;
  occurredAt: string;
  releaseAttemptId: string;
}

export interface FieldWorkPackageEvidence {
  eventId: string;
  evidenceItem: string;
  actorUser: string;
  actorRole: string;
  deviceActionId: string;
  occurredAt: string;
  slotId: string;
  requirement: string;
  source: string;
  deviceId: string;
  capturedAt: string;
  freshness: EvidenceFreshness;
  conflictState: EvidenceConflictState;
  correctionOf: string | null;
  itemCorrectionOf: string | null;
  verification: EvidenceVerification;
  disposition: EvidenceDisposition;
  correctionReason: string | null;
  reviewReason: string | null;
  releaseAttemptId: string;
}

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
  workObjectType?: string;
  workObjectId?: string;
  physicalContextType?: string;
  physicalContextId?: string;
  releaseAttemptId: string | null;
  supersession: {
    priorId: string;
    reason: string;
    changedSteps: number[];
    changedHoldPoints: number[];
  } | null;
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
    releasePhase?: "Pre-start" | "In-process" | "Completion";
    releaseAuthority: string;
    requiredEvidence: string;
    acceptanceCriteria: string;
    released: boolean;
  }>;
  /** Present on current packets. Missing means a legacy fixture/cache; it never grants start. */
  assignedWorkers?: FieldWorkPackageWorker[];
  /** Frozen at issue time. Missing or invalid state never grants a non-stop action. */
  authorityRequirements?: AuthorityRequirement[];
  authorityRequirementsState?: "current" | "missing" | "invalid";
  workerRosterKnown?: boolean;
  acknowledgementLedgerAvailable?: boolean;
  acknowledgements?: FieldWorkPackageAcknowledgement[];
  evidenceLedgerAvailable?: boolean;
  evidence?: FieldWorkPackageEvidence[];
  modified: string | null;
}

/**
 * Resolve the immutable package requirements against the current authority
 * ledger. This single fail-closed helper is shared by write gates and read
 * projections so the UI never advertises an action the command will deny.
 */
export async function currentWorkPackageAuthorityDenials(
  env: AppEnv,
  tenantId: string,
  workPackage: FieldWorkPackage,
  now: string,
): Promise<AuthorityLifecycleDenial[]> {
  return (
    await currentWorkPackageAuthorityResolution(env, tenantId, workPackage, now)
  ).denials;
}

export interface CurrentWorkPackageAuthorityResolution {
  denials: AuthorityLifecycleDenial[];
  preconditions: AuthorityCurrentPrecondition[];
}

/** Resolve current authority and retain the exact accepted D1 lifecycle heads. */
export async function currentWorkPackageAuthorityResolution(
  env: AppEnv,
  tenantId: string,
  workPackage: FieldWorkPackage,
  now: string,
): Promise<CurrentWorkPackageAuthorityResolution> {
  if (workPackage.authorityRequirementsState === "invalid") {
    return { denials: ["authority_unverifiable"], preconditions: [] };
  }
  if (
    workPackage.authorityRequirementsState !== "current" ||
    !workPackage.authorityRequirements?.length
  ) {
    return { denials: ["authority_missing"], preconditions: [] };
  }
  const denials = new Set<AuthorityLifecycleDenial>();
  const preconditions: AuthorityCurrentPrecondition[] = [];
  try {
    for (const requirement of workPackage.authorityRequirements) {
      const verdict = await resolveAuthorityRequirement(env, {
        tenantId,
        now,
        requirement,
      });
      if (!verdict.ok) {
        denials.add(verdict.code ?? "authority_unverifiable");
      } else if (!verdict.current) {
        denials.add("authority_unverifiable");
      } else {
        preconditions.push(
          authorityCurrentPrecondition(requirement, verdict.current),
        );
      }
    }
  } catch {
    return { denials: ["authority_unavailable"], preconditions: [] };
  }
  return { denials: [...denials], preconditions };
}

/** Match the actor against the immutable authority captured by a typed assignment. */
export function hasPhysicalAssignmentAuthority(
  assignment: FrappeRow | null,
  actorUser: string | readonly string[] | null,
  actorRole: AppRole,
): boolean {
  if (!assignment || !hasActor(actorUser)) return false;
  const requiredRole =
    actorRole === "owner"
      ? "IronWrap Owner"
      : actorRole === "production"
        ? "IronWrap Production"
        : null;
  return (
    requiredRole !== null &&
    sameActor(text(assignment.authority_user), actorUser) &&
    text(assignment.authority_role) === requiredRole
  );
}

/**
 * Derive completion authority from the assignment, never from an office role
 * alone. Roof Job completion keeps its existing role-governed adapter, while
 * typed physical work also requires the exact immutable assignment authority.
 */
export function hasWorkPackageCompletionAuthority(
  workPackage: FieldWorkPackage | null,
  assignment: FrappeRow | null,
  actorUser: string | readonly string[] | null,
  actorRole: AppRole,
): boolean {
  if (!workPackage || !hasActor(actorUser)) return false;
  if (
    (workPackage.assignedWorkers ?? []).some((worker) =>
      sameActor(worker.workerUser, actorUser),
    )
  ) {
    return false;
  }
  return (
    (workPackage.workObjectType === "Roof Job" &&
      ["owner", "ops", "production"].includes(actorRole)) ||
    hasPhysicalAssignmentAuthority(assignment, actorUser, actorRole)
  );
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
  tenantId: string,
): Promise<FieldWorkPackage | null> {
  return await nativeFieldWorkPackageForAssignment(
    env,
    tenantId,
    jobId,
    assignmentId,
  );
}

/** Read the D1-owned Work Package without consulting the legacy ERP. */
export async function nativeFieldWorkPackageForAssignment(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  assignmentId: string,
): Promise<FieldWorkPackage | null> {
  const native = await nativeWorkPackageForAssignment(
    env,
    tenantId,
    jobId,
    assignmentId,
  );
  return native
    ? await fieldWorkPackageFromNativeRead(
        env,
        tenantId,
        jobId,
        assignmentId,
        native,
      )
    : null;
}

async function fieldWorkPackageFromNativeRead(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  assignmentId: string,
  native: NativeWorkPackageRead,
): Promise<FieldWorkPackage | null> {
  const document = native.document;
  const roofJob = text(document.roof_job);
  const workObjectId = text(document.work_object_id);
  if (
    text(document.job_assignment) !== assignmentId ||
    (roofJob !== jobId && workObjectId !== jobId)
  ) {
    return null;
  }
  const workPackage = fieldWorkPackage(document);
  if (!workPackage) return null;
  const supersession = await workPackageSupersession(env, document, tenantId);
  if (text(document.supersedes) && !supersession) return null;
  const withSupersession = { ...workPackage, supersession };
  return withVerifiedEvidence(
    withVerifiedAcknowledgements(
      withVerifiedHoldReleases(
        withSupersession,
        native.holdReleases,
        jobId,
        assignmentId,
      ),
      native.acknowledgements,
      jobId,
      assignmentId,
    ),
    native.evidence,
    jobId,
    assignmentId,
  );
}

/**
 * Authorize a typed field capture against the current immutable Work Package
 * packet before the field action claims D1 or writes an R2 object.
 */
export async function authorizeFieldEvidence(
  env: AppEnv,
  submission: FieldSubmission,
  auth: AuthContext,
): Promise<FieldEvidenceAuthorization> {
  const configuredTenantId = env.APP_TENANT_ID?.trim() ?? "ironwrap";
  if (!auth.session.tenant_id || configuredTenantId !== auth.session.tenant_id) {
    throw fieldEvidenceAuthorizationError(
      "tenant_mismatch",
      "This sign-in is for a different company than this job plan. Sign in again with your work account.",
      403,
    );
  }
  const workPackage = await fieldWorkPackageForAssignment(
    env,
    submission.jobId,
    submission.assignmentId,
    auth.session.tenant_id,
  );
  if (!workPackage) {
    throw fieldEvidenceAuthorizationError(
      "work_package_not_available",
      "This job has no current job plan. Ask production to issue one.",
    );
  }
  if (!workPackage.releaseAttemptId) {
    throw fieldEvidenceAuthorizationError(
      "work_package_release_attempt_missing",
      "This job plan is not released to the crew right now, so proof cannot be added. Call production.",
    );
  }
  if (
    !Number.isFinite(Date.parse(workPackage.expiresAt)) ||
    Date.parse(workPackage.expiresAt) <= Date.now()
  ) {
    throw fieldEvidenceAuthorizationError(
      "work_package_expired",
      "This job plan has expired, so proof cannot be added. Ask production to issue a new one.",
    );
  }
  const scope = workPackageScope(workPackage);
  if (submission.scope && !sameScope(submission.scope, scope)) {
    throw fieldEvidenceAuthorizationError(
      "work_object_scope_mismatch",
      "This proof is for a different part of the job than the current job plan. Pick the job again on Today, then tap Add proof on the step.",
    );
  }
  if (
    !auth.session.device_id ||
    (submission.payload.evidence_device_id != null &&
      submission.payload.evidence_device_id !== auth.session.device_id)
  ) {
    throw fieldEvidenceAuthorizationError(
      "evidence_device_mismatch",
      "This proof was started under an earlier sign-in on this phone. Sign in again, then tap Add proof on the step.",
    );
  }
  const actorCandidates = appUserIdentities(auth.session);
  if (
    !workPackage.workerRosterKnown ||
    !workPackage.assignedWorkers?.some((worker) =>
      actorCandidates.some((candidate) => sameUser(worker.workerUser, candidate)),
    )
  ) {
    throw fieldEvidenceAuthorizationError(
      "work_package_actor_not_assigned",
      "You are not on the crew for this job plan. Ask the office to add you to it.",
      403,
    );
  }
  const payload = submission.payload;
  if (payload.work_package_id !== workPackage.id) {
    throw fieldEvidenceAuthorizationError(
      "work_package_not_available",
      "This proof was taken for a job plan that is no longer current. Pick the job again on Today, then tap Add proof on the step.",
    );
  }
  if (payload.work_package_version !== workPackage.version) {
    throw fieldEvidenceAuthorizationError(
      "work_package_version_conflict",
      "The job plan changed after this proof was taken. Pick the job again on Today, then tap Add proof on the step.",
    );
  }
  if (payload.work_package_release_attempt_id !== workPackage.releaseAttemptId) {
    throw fieldEvidenceAuthorizationError(
      "work_package_release_attempt_conflict",
      "The job plan changed after this proof was taken. Pick the job again on Today, then tap Add proof on the step.",
    );
  }
  const slot = declaredEvidenceSlot(workPackage, payload.evidence_slot_id);
  if (!slot) {
    throw fieldEvidenceAuthorizationError(
      "work_package_evidence_slot_not_found",
      "The current job plan no longer has this proof step. Pick the job again on Today to see which steps need proof.",
    );
  }
  if (payload.evidence_requirement !== slot.requirement) {
    throw fieldEvidenceAuthorizationError(
      "work_package_evidence_requirement_conflict",
      "The proof this step asks for changed in the job plan. Pick the job again on Today, then tap Add proof on the step.",
    );
  }
  const source = "field-companion";
  if (payload.evidence_source !== source) {
    throw fieldEvidenceAuthorizationError(
      "evidence_source_mismatch",
      "The saved evidence source is not authorized for this field capture.",
    );
  }
  if (
    payload.evidence_freshness != null &&
    payload.evidence_freshness !== "Current"
  ) {
    throw fieldEvidenceAuthorizationError(
      "evidence_freshness_mismatch",
      "Field capture freshness must be derived as Current.",
    );
  }
  if (
    payload.evidence_conflict_state != null &&
    payload.evidence_conflict_state !== "None"
  ) {
    throw fieldEvidenceAuthorizationError(
      "evidence_conflict_state_mismatch",
      "Field capture conflict state must be derived as None.",
    );
  }
  const correction = authorizedEvidenceCorrection(
    workPackage,
    submission,
    actorCandidates,
    scope,
  );
  return {
    workPackageId: workPackage.id,
    workPackageVersion: workPackage.version,
    releaseAttemptId: workPackage.releaseAttemptId,
    scope,
    slotId: slot.slotId,
    requirement: slot.requirement,
    source,
    deviceId: auth.session.device_id,
    freshness: "Current",
    conflictState: "None",
    correctionOf: correction.eventId,
    itemCorrectionOf: correction.evidenceItem,
  };
}

function workPackageScope(workPackage: FieldWorkPackage): {
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
} {
  if (
    !workPackage.workObjectType ||
    !workPackage.workObjectId ||
    !workPackage.physicalContextType ||
    !workPackage.physicalContextId
  ) {
    throw fieldEvidenceAuthorizationError(
      "work_object_scope_unavailable",
      "This job plan does not say which part of the job it covers, so proof cannot be added. Ask production to issue it again.",
    );
  }
  return {
    workObjectType: workPackage.workObjectType,
    workObjectId: workPackage.workObjectId,
    physicalContextType: workPackage.physicalContextType,
    physicalContextId: workPackage.physicalContextId,
  };
}

function declaredEvidenceSlot(
  workPackage: FieldWorkPackage,
  slotId: string | null | undefined,
): { slotId: string; requirement: string } | null {
  if (!slotId) return null;
  const match = /^(step|hold):([1-9][0-9]*)$/.exec(slotId);
  if (!match) return null;
  const sequence = Number(match[2]);
  const rows = match[1] === "step" ? workPackage.steps : workPackage.holdPoints;
  const row = rows.find((candidate) => candidate.sequence === sequence);
  if (!row) return null;
  return {
    slotId,
    requirement: row.requiredEvidence,
  };
}

function authorizedEvidenceCorrection(
  workPackage: FieldWorkPackage,
  submission: FieldSubmission,
  actorCandidates: string[],
  scope: WorkObjectScope,
): { eventId: string | null; evidenceItem: string | null } {
  const eventId = submission.payload.evidence_correction_of;
  const evidenceItem = submission.payload.evidence_item_correction_of;
  if (!eventId && !evidenceItem) return { eventId: null, evidenceItem: null };
  if (!eventId || !evidenceItem || !workPackage.evidenceLedgerAvailable) {
    throw fieldEvidenceAuthorizationError(
      "work_package_evidence_correction_not_found",
      "The proof you are fixing is not on the current job plan. Pick the job again on Today to see the step's current proof.",
    );
  }
  const target = (workPackage.evidence ?? []).find(
    (candidate) =>
      candidate.eventId === eventId && candidate.evidenceItem === evidenceItem,
  );
  if (
    !target ||
    target.slotId !== submission.payload.evidence_slot_id ||
    target.releaseAttemptId !== workPackage.releaseAttemptId ||
    target.disposition === "Superseded" ||
    target.verification !== "Verified" ||
    !actorCandidates.some((candidate) => sameUser(candidate, target.actorUser)) ||
    !sameScope(scope, workPackageScope(workPackage))
  ) {
    throw fieldEvidenceAuthorizationError(
      "work_package_evidence_correction_mismatch",
      "You can fix only your own verified proof, on the same step of the current job plan. Pick the job again on Today, then tap Fix proof next to it.",
    );
  }
  if ((workPackage.evidence ?? []).some((candidate) => candidate.correctionOf === target.eventId)) {
    throw fieldEvidenceAuthorizationError(
      "work_package_evidence_correction_conflict",
      "One evidence event can have only one immutable replacement.",
    );
  }
  return { eventId, evidenceItem };
}

function sameScope(
  left: {
    workObjectType: string;
    workObjectId: string;
    physicalContextType: string;
    physicalContextId: string;
  },
  right: {
    workObjectType: string;
    workObjectId: string;
    physicalContextType: string;
    physicalContextId: string;
  },
): boolean {
  return (
    left.workObjectType === right.workObjectType &&
    left.workObjectId === right.workObjectId &&
    left.physicalContextType === right.physicalContextType &&
    left.physicalContextId === right.physicalContextId
  );
}

function fieldEvidenceAuthorizationError(
  code: string,
  message: string,
  status = 409,
): FieldActionError {
  return new FieldActionError(code, status, message);
}

function rowMatchesWorkScope(
  workPackage: FieldWorkPackage,
  row: FrappeRow,
  jobId: string,
): boolean {
  if (workPackage.workObjectType === "Roof Job") {
    return text(row.roof_job) === jobId;
  }
  return (
    !text(row.roof_job) &&
    text(row.work_object_type) === workPackage.workObjectType &&
    text(row.work_object_id) === jobId &&
    text(row.physical_context_type) === workPackage.physicalContextType &&
    text(row.physical_context_id) === workPackage.physicalContextId
  );
}

export function fieldWorkPackageProjection(
  workPackage: FieldWorkPackage | null,
  actorUser: string | readonly string[] | null,
  options: {
    completionAuthority?: boolean;
    completionActorUser?: string | readonly string[] | null;
    /**
     * Current safety blockers for this package's scope. Any blocker removes
     * acknowledge, start, and complete. Stopping work is never removed: no
     * safety state may make a stop harder to reach than it already is.
     */
    safetyBlockers?: SafetyBlocker[];
    /** Current fail-closed authority denials; stop_work remains reachable. */
    authorityDenials?: AuthorityLifecycleDenial[];
  } = {},
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
    work_object_type: string;
    work_object_id: string;
    physical_context_type: string;
    physical_context_id: string;
    release_attempt_id: string | null;
    supersession: {
      prior_id: string;
      reason: string;
      changed_steps: number[];
      changed_hold_points: number[];
    } | null;
    acknowledgement: {
      current_user_acknowledged: boolean;
      acknowledged_at: string | null;
      workers: Array<{
        worker_user: string;
        worker_role: string;
        required: boolean;
        acknowledged: boolean;
        acknowledged_at: string | null;
      }>;
    };
    evidence_slots: Array<{
      event_id: string;
      evidence_item: string;
      slot_id: string;
      requirement: string;
      source: string;
      actor_user: string;
      device_id: string;
      captured_at: string;
      freshness: EvidenceFreshness;
      conflict_state: EvidenceConflictState;
      correction_of: string | null;
      evidence_item_correction_of: string | null;
      review_reason: string | null;
      verification: EvidenceVerification;
      disposition: EvidenceDisposition;
      correction_reason: string | null;
      superseded: boolean;
    }>;
    steps: Array<{
      sequence: number;
      instruction: string;
      required_evidence: string;
      acceptance_criteria: string;
    }>;
    hold_points: Array<{
      sequence: number;
      hold_point: string;
      release_phase: "Pre-start" | "In-process" | "Completion";
      release_authority: string;
      required_evidence: string;
      acceptance_criteria: string;
      released: boolean;
    }>;
    safety_blockers: SafetyBlocker[];
    authority_denials: AuthorityLifecycleDenial[];
  } | null;
  allowedActions: string[];
} {
  if (!workPackage) return { work_package: null, allowedActions: [] };
  const currentUserAcknowledgement = (workPackage.acknowledgements ?? []).find(
    (item) =>
      sameActor(item.actorUser, actorUser) &&
      !!workPackage.releaseAttemptId &&
      item.releaseAttemptId === workPackage.releaseAttemptId,
  );
  const currentUserAcknowledged =
    Boolean(currentUserAcknowledgement) ||
    (sameActor(workPackage.acknowledgedBy, actorUser) &&
      !workPackage.releaseAttemptId);
  const workers = workPackage.assignedWorkers ?? [];
  const acknowledgements = workPackage.acknowledgements ?? [];
  const workerLedgerKnown = workPackage.workerRosterKnown === true;
  const workerLedgerAvailable =
    workPackage.acknowledgementLedgerAvailable === true;
  const requiredWorkers = workers.filter((worker) => worker.required);
  const requiredWorkersAcknowledged =
    workerLedgerKnown && workerLedgerAvailable && requiredWorkers.length > 0
      ? requiredWorkers.every((worker) =>
          acknowledgements.some((acknowledgement) =>
            sameUser(acknowledgement.actorUser, worker.workerUser),
          ),
        )
      : false;
  const preStartHoldsReleased = workPackage.holdPoints
    .filter((holdPoint) => (holdPoint.releasePhase ?? "Pre-start") === "Pre-start")
    .every((holdPoint) => holdPoint.released);
  const requiredEvidenceSlots = [
    ...workPackage.steps.map((step) => `step:${step.sequence}`),
    ...workPackage.holdPoints.map((holdPoint) => `hold:${holdPoint.sequence}`),
  ];
  const supersededEvidenceIds = new Set(
    (workPackage.evidence ?? [])
      .map((evidence) => evidence.correctionOf)
      .filter((eventId): eventId is string => Boolean(eventId)),
  );
  const currentEvidenceBySlot = new Map<string, FieldWorkPackageEvidence[]>();
  for (const evidence of workPackage.evidence ?? []) {
    // A correction is the current leaf for its slot. Only the prior event is
    // superseded; dropping every correction here made a Needs Correction ->
    // corrected capture permanently invisible to completion readiness.
    if (supersededEvidenceIds.has(evidence.eventId)) continue;
    const instances = currentEvidenceBySlot.get(evidence.slotId) ?? [];
    instances.push(evidence);
    currentEvidenceBySlot.set(evidence.slotId, instances);
  }
  const conflictingSlots = new Set(
    [...currentEvidenceBySlot.entries()]
      .filter(([, instances]) => instances.length > 1)
      .map(([slotId]) => slotId),
  );
  const completionEvidenceReady =
    workPackage.evidenceLedgerAvailable === true &&
    requiredEvidenceSlots.length > 0 &&
    requiredEvidenceSlots.every((slotId) => {
      const instances = currentEvidenceBySlot.get(slotId) ?? [];
      if (instances.length === 0 || conflictingSlots.has(slotId)) return false;
      const evidence = instances[0];
      return (
        evidence?.verification === "Verified" &&
        evidence.disposition === "Accepted" &&
        evidence.freshness === "Current" &&
        ["None", "Resolved"].includes(evidence.conflictState)
      );
    });
  const completionReady =
    options.completionAuthority === true &&
    hasActor(options.completionActorUser ?? actorUser) &&
    !workers.some((worker) =>
      sameActor(worker.workerUser, options.completionActorUser ?? actorUser),
    ) &&
    workPackage.status === "In Progress" &&
    workerLedgerKnown &&
    workerLedgerAvailable &&
    !!workPackage.releaseAttemptId &&
    requiredWorkers.length > 0 &&
    requiredWorkersAcknowledged &&
    workPackage.holdPoints.every((holdPoint) => holdPoint.released) &&
    completionEvidenceReady;
  const workerAcknowledgementProjection = workers.map((worker) => {
    const acknowledgement = acknowledgements.find((item) =>
      sameUser(item.actorUser, worker.workerUser),
    );
    return {
      worker_user: worker.workerUser,
      worker_role: worker.workerRole,
      required: worker.required,
      acknowledged: Boolean(acknowledgement),
      acknowledged_at: acknowledgement?.occurredAt ?? null,
    };
  });
  const safetyBlockers = options.safetyBlockers ?? [];
  const safetyBlocked = safetyBlockers.length > 0;
  const authorityDenials = options.authorityDenials ?? [];
  const authorityBlocked = authorityDenials.length > 0;
  const allowedActions = [
    ...((workPackage.status === "Released" ||
      workPackage.status === "Acknowledged") &&
    !currentUserAcknowledged &&
    workerLedgerKnown &&
    workerLedgerAvailable &&
    !!workPackage.releaseAttemptId &&
    workers.some(
      (worker) => worker.required && sameActor(worker.workerUser, actorUser),
    )
      ? ["work_package.acknowledge"]
      : []),
    // Starting work is intentionally not an outbox capability. The browser
    // must make this request while online, and the D1 command repeats the
    // current-release and exact-assignment checks before its state transition.
    ...(workPackage.status === "Acknowledged" &&
    workerLedgerKnown &&
    workerLedgerAvailable &&
    !!workPackage.releaseAttemptId &&
    workers.some(
      (worker) => worker.required && sameActor(worker.workerUser, actorUser),
    ) &&
    requiredWorkersAcknowledged &&
    preStartHoldsReleased
      ? ["work_package.start"]
      : []),
    // Stopping work is never gated by safety state, capability, or readiness.
    // A worker who needs to stop must always be able to.
    ...(workPackage.status !== "Blocked" &&
    CURRENT_WORK_PACKAGE_STATUSES.includes(workPackage.status)
      ? ["work_package.stop_work"]
      : []),
    ...(completionReady ? ["work_package.complete"] : []),
  ].filter(
    (action) =>
      (!safetyBlocked && !authorityBlocked) ||
      action === "work_package.stop_work",
  );
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
      work_object_type: workPackage.workObjectType ?? "",
      work_object_id: workPackage.workObjectId ?? "",
      physical_context_type: workPackage.physicalContextType ?? "",
      physical_context_id: workPackage.physicalContextId ?? "",
      release_attempt_id: workPackage.releaseAttemptId,
      supersession: workPackage.supersession
        ? {
            prior_id: workPackage.supersession.priorId,
            reason: workPackage.supersession.reason,
            changed_steps: workPackage.supersession.changedSteps,
            changed_hold_points: workPackage.supersession.changedHoldPoints,
          }
        : null,
      acknowledgement: {
        current_user_acknowledged: currentUserAcknowledged,
        acknowledged_at: currentUserAcknowledged
          ? (currentUserAcknowledgement?.occurredAt ??
            workPackage.acknowledgedAt)
          : null,
        workers: workerAcknowledgementProjection,
      },
      evidence_slots: (workPackage.evidence ?? []).map((item) => ({
        event_id: item.eventId,
        evidence_item: item.evidenceItem,
        slot_id: item.slotId,
        requirement: item.requirement,
        source: item.source,
        actor_user: item.actorUser,
        device_id: item.deviceId,
        captured_at: item.capturedAt,
        freshness: item.freshness,
        conflict_state: conflictingSlots.has(item.slotId)
          ? "Detected"
          : item.conflictState,
        correction_of: item.correctionOf,
        evidence_item_correction_of: item.itemCorrectionOf,
        review_reason: item.reviewReason,
        verification: item.verification,
        disposition: item.disposition,
        correction_reason: item.correctionReason,
        superseded: (workPackage.evidence ?? []).some(
          (candidate) => candidate.correctionOf === item.eventId,
        ),
      })),
      steps: workPackage.steps.map((step) => ({
        sequence: step.sequence,
        instruction: step.instruction,
        required_evidence: step.requiredEvidence,
        acceptance_criteria: step.acceptanceCriteria,
      })),
      hold_points: workPackage.holdPoints.map((holdPoint) => ({
        sequence: holdPoint.sequence,
        hold_point: holdPoint.holdPoint,
        release_phase: holdPoint.releasePhase ?? "Pre-start",
        release_authority: holdPoint.releaseAuthority,
        required_evidence: holdPoint.requiredEvidence,
        acceptance_criteria: holdPoint.acceptanceCriteria,
        released: holdPoint.released,
      })),
      safety_blockers: safetyBlockers,
      authority_denials: authorityDenials,
    },
    allowedActions,
  };
}

function hasActor(actorUser: string | readonly string[] | null): boolean {
  return typeof actorUser === "string"
    ? actorUser.trim().length > 0
    : Boolean(actorUser?.length);
}

function sameActor(
  value: unknown,
  actorUser: string | readonly string[] | null,
): boolean {
  const candidate = text(value);
  return typeof actorUser === "string"
    ? sameUser(candidate, actorUser)
    : Boolean(actorUser?.some((identity) => sameUser(candidate, identity)));
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
    const releasePhase = text(item.release_phase) ?? "Pre-start";
    if (
      releasePhase !== "Pre-start" &&
      releasePhase !== "In-process" &&
      releasePhase !== "Completion"
    ) {
      return null;
    }
    return holdPoint &&
      releaseAuthority &&
      requiredEvidence &&
      acceptanceCriteria
      ? {
          sequence,
          holdPoint,
          releasePhase: releasePhase as "Pre-start" | "In-process" | "Completion",
          releaseAuthority,
          requiredEvidence,
          acceptanceCriteria,
          released: false,
        }
      : null;
  });
  if (!steps || !holdPoints) return null;
  const workerRosterKnown = Array.isArray(row.assigned_workers);
  const assignedWorkers = workerRosterKnown
    ? (orderedRows(row.assigned_workers, (item, sequence) => {
        const workerUser = text(item.worker_user);
        const workerRole = text(item.worker_role);
        const required = booleanValue(item.required);
        return workerUser && workerRole && required !== null
          ? { sequence, workerUser, workerRole, required }
          : null;
      }) ?? undefined)
    : undefined;
  if (workerRosterKnown && !assignedWorkers) return null;
  if (workerRosterKnown) {
    const workerUsers = assignedWorkers!.map((worker) => worker.workerUser.toLowerCase());
    if (
      assignedWorkers!.length === 0 ||
      !assignedWorkers!.some((worker) => worker.required) ||
      new Set(workerUsers).size !== workerUsers.length
    ) {
      return null;
    }
  }
  const authority = fieldWorkPackageAuthority(row);
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
    workObjectType: text(row.work_object_type) ?? (text(row.roof_job) ? "Roof Job" : ""),
    workObjectId: text(row.work_object_id) ?? text(row.roof_job) ?? "",
    physicalContextType: text(row.physical_context_type) ?? (text(row.roof_job) ? "Roof Site" : ""),
    physicalContextId: text(row.physical_context_id) ?? text(row.roof_job) ?? "",
    releaseAttemptId: text(row.release_attempt_id),
    supersession: null,
    acknowledgedBy: text(row.acknowledged_by),
    acknowledgedAt: text(row.acknowledged_at),
    steps,
    holdPoints,
    assignedWorkers,
    authorityRequirements: authority.requirements,
    authorityRequirementsState: authority.state,
    workerRosterKnown,
    acknowledgementLedgerAvailable: false,
    acknowledgements: [],
    evidenceLedgerAvailable: false,
    evidence: [],
    modified: text(row.modified),
  };
}

function fieldWorkPackageAuthority(row: FrappeRow): {
  requirements?: AuthorityRequirement[];
  state: "current" | "missing" | "invalid";
} {
  if (!Object.hasOwn(row, "authority_requirements_json")) {
    return { state: "missing" };
  }
  if (
    typeof row.authority_requirements_json !== "string" ||
    !row.authority_requirements_json.trim()
  ) {
    return { state: "invalid" };
  }
  try {
    return {
      requirements: parseAuthorityRequirements(
        row.authority_requirements_json,
      ),
      state: "current",
    };
  } catch {
    return { state: "invalid" };
  }
}

async function workPackageSupersession(
  env: AppEnv,
  document: FrappeRow,
  tenantId: string,
): Promise<FieldWorkPackage["supersession"]> {
  const priorReference = text(document.supersedes);
  if (!priorReference) return null;
  const reason = text(document.correction_reason);
  if (!reason) return null;
  const prior = await nativeWorkPackageDocumentById(
    env,
    tenantId,
    priorReference,
  );
  if (
    !prior ||
    (text(prior.name) !== priorReference &&
      text(prior.work_package_id) !== priorReference)
  )
    return null;
  return {
    priorId: priorReference,
    reason,
    changedSteps: changedRowSequences(document.steps, prior.steps, [
      "instruction",
      "required_evidence",
      "acceptance_criteria",
    ]),
    changedHoldPoints: changedRowSequences(
      document.hold_points,
      prior.hold_points,
      [
        "hold_point",
        "release_authority",
        "required_evidence",
        "acceptance_criteria",
      ],
    ),
  };
}

function changedRowSequences(
  current: unknown,
  prior: unknown,
  fields: string[],
): number[] {
  if (!Array.isArray(current) || !Array.isArray(prior)) return [];
  const bySequence = (rows: unknown[]) => {
    const result = new Map<number, FrappeRow>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const sequence = integer(row.sequence);
      if (sequence) result.set(sequence, row);
    }
    return result;
  };
  const currentRows = bySequence(current);
  const priorRows = bySequence(prior);
  return [...new Set([...currentRows.keys(), ...priorRows.keys()])]
    .sort((left, right) => left - right)
    .filter((sequence) => {
      const left = currentRows.get(sequence);
      const right = priorRows.get(sequence);
      return fields.some(
        (field) => text(left?.[field]) !== text(right?.[field]),
      );
    });
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
  if (!workPackage.releaseAttemptId) {
    return {
      ...workPackage,
      holdPoints: workPackage.holdPoints.map((holdPoint) => ({
        ...holdPoint,
        released: false,
      })),
    };
  }
  const declared = new Set(
    workPackage.holdPoints.map((holdPoint) => holdPoint.sequence),
  );
  const released = new Set<number>();
  for (const row of rows) {
    const releaseAttemptId = text(row.release_attempt_id);
    if (releaseAttemptId && releaseAttemptId !== workPackage.releaseAttemptId)
      continue;
    const sequence = integer(row.hold_point_sequence);
    if (
      text(row.event_type) !== "Hold Point Released" ||
      text(row.work_package) !== workPackage.name ||
      !rowMatchesWorkScope(workPackage, row, jobId) ||
      text(row.job_assignment) !== assignmentId ||
      integer(row.work_package_version) !== workPackage.version ||
      text(row.release_attempt_id) !== workPackage.releaseAttemptId ||
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

/** Validate the per-worker acknowledgement ledger before it drives a capability. */
function withVerifiedAcknowledgements(
  workPackage: FieldWorkPackage,
  rows: FrappeRow[],
  jobId: string,
  assignmentId: string,
): FieldWorkPackage {
  if (!workPackage.releaseAttemptId) {
    return {
      ...workPackage,
      acknowledgementLedgerAvailable: false,
      acknowledgements: [],
    };
  }
  const requiredUsers = new Set(
    (workPackage.assignedWorkers ?? [])
      .filter((worker) => worker.required)
      .map((worker) => worker.workerUser.toLowerCase()),
  );
  const workerRoles = new Map(
    (workPackage.assignedWorkers ?? []).map((worker) => [
      worker.workerUser.toLowerCase(),
      worker.workerRole,
    ]),
  );
  const actors = new Set<string>();
  const devices = new Set<string>();
  const acknowledgements: FieldWorkPackageAcknowledgement[] = [];
  for (const row of rows) {
    const actorUser = text(row.actor_user);
    const actorRole = text(row.actor_role);
    const deviceActionId = text(row.device_action_id);
    const occurredAt = timestamp(row.occurred_at);
    const releaseAttemptId = text(row.release_attempt_id);
    if (releaseAttemptId && releaseAttemptId !== workPackage.releaseAttemptId)
      continue;
    if (
      text(row.event_type) !== "Acknowledged" ||
      text(row.work_package) !== workPackage.name ||
      !rowMatchesWorkScope(workPackage, row, jobId) ||
      text(row.job_assignment) !== assignmentId ||
      integer(row.work_package_version) !== workPackage.version ||
      releaseAttemptId !== workPackage.releaseAttemptId ||
      !actorUser ||
      !actorRole ||
      !deviceActionId ||
      !occurredAt ||
      actors.has(actorUser.toLowerCase()) ||
      devices.has(deviceActionId) ||
      workerRoles.get(actorUser.toLowerCase()) !== actorRole ||
      (requiredUsers.size > 0 && !requiredUsers.has(actorUser.toLowerCase()))
    ) {
      return {
        ...workPackage,
        acknowledgementLedgerAvailable: false,
        acknowledgements: [],
      };
    }
    actors.add(actorUser.toLowerCase());
    devices.add(deviceActionId);
    acknowledgements.push({
      actorUser,
      actorRole,
      deviceActionId,
      occurredAt,
      releaseAttemptId,
    });
  }
  acknowledgements.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  return {
    ...workPackage,
    acknowledgementLedgerAvailable: true,
    acknowledgements,
  };
}

/** Validate typed evidence events while preserving every immutable correction link. */
export function withVerifiedEvidence(
  workPackage: FieldWorkPackage,
  rows: FrappeRow[],
  jobId: string,
  assignmentId: string,
): FieldWorkPackage {
  if (!workPackage.releaseAttemptId) {
    return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
  }
  const events = new Map<string, FieldWorkPackageEvidence>();
  const reviews: Array<{
    target: string;
    item: string;
    slot: string;
    disposition: EvidenceDisposition;
    reason: string | null;
    actorUser: string;
    actorRole: string;
  }> = [];
  const devices = new Set<string>();
  const eventIds = new Set<string>();
  const correctionTargets = new Set<string>();
  const workerRoles = new Map(
    (workPackage.assignedWorkers ?? []).map((worker) => [
      worker.workerUser.toLowerCase(),
      worker.workerRole,
    ]),
  );
  for (const row of rows) {
    const eventId = text(row.name);
    const evidenceItem = text(row.evidence_item);
    const actorUser = text(row.actor_user);
    const actorRole = text(row.actor_role);
    const deviceActionId = text(row.device_action_id);
    const occurredAt = timestamp(row.occurred_at);
    const slotId = text(row.evidence_slot_id);
    const requirement = text(row.evidence_requirement);
    const source = text(row.evidence_source);
    const deviceId = text(row.evidence_device_id);
    const capturedAt = timestamp(row.evidence_captured_at);
    const freshness = evidenceFreshness(row.evidence_freshness);
    const conflictState = evidenceConflictState(row.evidence_conflict_state);
    const verification = evidenceVerification(row.evidence_verification);
    const disposition = evidenceDisposition(row.evidence_disposition);
    const correctionOf = text(row.evidence_correction_of);
    const itemCorrectionOf = text(row.evidence_item_correction_of);
    const correctionReason = text(row.correction_reason);
    const releaseAttemptId = text(row.release_attempt_id);
    const eventType = text(row.event_type);
    if (releaseAttemptId && releaseAttemptId !== workPackage.releaseAttemptId)
      continue;
    if (eventType === "Evidence Reviewed") {
      const reviewTarget = text(row.evidence_review_of);
      const reviewDisposition = evidenceDisposition(row.evidence_disposition);
      if (
        !eventId ||
        !reviewTarget ||
        !evidenceItem ||
        !actorUser ||
        !actorRole ||
        !deviceActionId ||
        !occurredAt ||
        !slotId ||
        !reviewDisposition ||
        !["Accepted", "Needs Correction"].includes(reviewDisposition) ||
        (reviewDisposition === "Needs Correction" && !correctionReason) ||
        !["IronWrap Owner", "IronWrap Production", "System Manager"].includes(
          actorRole,
        ) ||
        text(row.evidence_requirement) ||
        text(row.evidence_source) ||
        text(row.evidence_device_id) ||
        text(row.evidence_captured_at) ||
        text(row.evidence_freshness) ||
        text(row.evidence_conflict_state) ||
        text(row.evidence_correction_of) ||
        text(row.evidence_item_correction_of) ||
        eventIds.has(eventId) ||
        devices.has(deviceActionId) ||
        text(row.work_package) !== workPackage.name ||
        !rowMatchesWorkScope(workPackage, row, jobId) ||
        text(row.job_assignment) !== assignmentId ||
        integer(row.work_package_version) !== workPackage.version ||
        releaseAttemptId !== workPackage.releaseAttemptId
      )
        return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
      eventIds.add(eventId);
      devices.add(deviceActionId);
      reviews.push({
        target: reviewTarget,
        item: evidenceItem,
        slot: slotId,
        disposition: reviewDisposition,
        reason: correctionReason,
        actorUser,
        actorRole,
      });
      continue;
    }
    if (
      !eventId ||
      !evidenceItem ||
      !actorUser ||
      !actorRole ||
      !deviceActionId ||
      !occurredAt ||
      !slotId ||
      !requirement ||
      !source ||
      !deviceId ||
      !capturedAt ||
      !freshness ||
      !conflictState ||
      !verification ||
      !disposition ||
      verification !== "Verified" ||
      disposition !== "Open" ||
      Boolean(correctionOf) !== Boolean(correctionReason) ||
      Boolean(correctionOf) !== Boolean(itemCorrectionOf) ||
      eventIds.has(eventId) ||
      events.has(eventId) ||
      devices.has(deviceActionId) ||
      (workPackage.workerRosterKnown &&
        workerRoles.get(actorUser.toLowerCase()) !== actorRole) ||
      text(row.event_type) !== "Evidence Captured" ||
      text(row.work_package) !== workPackage.name ||
      !rowMatchesWorkScope(workPackage, row, jobId) ||
      text(row.job_assignment) !== assignmentId ||
      integer(row.work_package_version) !== workPackage.version ||
      releaseAttemptId !== workPackage.releaseAttemptId
    ) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
    eventIds.add(eventId);
    const declaredRequirement = evidenceSlotRequirement(workPackage, slotId);
    if (!declaredRequirement || declaredRequirement !== requirement) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
    if (
      workPackage.workerRosterKnown &&
      !(workPackage.assignedWorkers ?? []).some((worker) =>
        sameUser(worker.workerUser, actorUser),
      )
    ) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
    devices.add(deviceActionId);
    if (correctionOf) {
      if (correctionTargets.has(correctionOf)) {
        return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
      }
      correctionTargets.add(correctionOf);
    }
    events.set(eventId, {
      eventId,
      evidenceItem,
      actorUser,
      actorRole,
      deviceActionId,
      occurredAt,
      slotId,
      requirement,
      source,
      deviceId,
      capturedAt,
      freshness,
      conflictState,
      correctionOf,
      itemCorrectionOf,
      verification,
      disposition,
      correctionReason,
      reviewReason: null,
      releaseAttemptId,
    });
  }
  const reviewedTargets = new Set<string>();
  for (const review of reviews) {
    if (reviewedTargets.has(review.target))
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    const target = events.get(review.target);
    if (
      !target ||
      target.evidenceItem !== review.item ||
      target.slotId !== review.slot ||
      sameUser(target.actorUser, review.actorUser) ||
      !["IronWrap Owner", "IronWrap Production", "System Manager"].includes(
        review.actorRole,
      )
    ) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
    reviewedTargets.add(review.target);
    events.set(review.target, {
      ...target,
      disposition: review.disposition,
      reviewReason: review.reason,
    });
  }
  for (const event of events.values()) {
    if (!event.correctionOf) continue;
    const target = events.get(event.correctionOf);
    if (
      !target ||
      target.slotId !== event.slotId ||
      target.eventId === event.eventId ||
      !sameUser(target.actorUser, event.actorUser) ||
      target.evidenceItem !== event.itemCorrectionOf
    ) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitCorrectionChain = (eventId: string): boolean => {
    if (visiting.has(eventId)) return false;
    if (visited.has(eventId)) return true;
    visiting.add(eventId);
    const event = events.get(eventId);
    if (!event) return false;
    if (event.correctionOf && !visitCorrectionChain(event.correctionOf)) {
      return false;
    }
    visiting.delete(eventId);
    visited.add(eventId);
    return true;
  };
  for (const eventId of events.keys()) {
    if (!visitCorrectionChain(eventId)) {
      return { ...workPackage, evidenceLedgerAvailable: false, evidence: [] };
    }
  }
  const evidence = [...events.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId),
  );
  return { ...workPackage, evidenceLedgerAvailable: true, evidence };
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

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function evidenceFreshness(value: unknown): EvidenceFreshness | null {
  return value === "Current" || value === "Stale" || value === "Unknown"
    ? value
    : null;
}

function evidenceConflictState(value: unknown): EvidenceConflictState | null {
  return value === "None" || value === "Detected" || value === "Resolved"
    ? value
    : null;
}

function evidenceVerification(value: unknown): EvidenceVerification | null {
  return value === "Pending" || value === "Verified" || value === "Rejected"
    ? value
    : null;
}

function evidenceDisposition(value: unknown): EvidenceDisposition | null {
  return value === "Open" ||
    value === "Accepted" ||
    value === "Needs Correction" ||
    value === "Superseded"
    ? value
    : null;
}

function evidenceSlotRequirement(
  workPackage: FieldWorkPackage,
  slotId: string,
): string | null {
  const match = /^(step|hold):(\d+)$/.exec(slotId);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  const rows = match[1] === "step" ? workPackage.steps : workPackage.holdPoints;
  const row = rows.find((candidate) => candidate.sequence === sequence);
  return row?.requiredEvidence ?? null;
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
