import {
  appUserIdentities,
  type AppEnv,
  type AppRole,
  type AuthContext,
  type WorkObjectScope,
} from "./app-types.ts";
import {
  FieldActionError,
  r2ObjectStore,
  type ImmutableObjectStore,
} from "./field-actions.ts";
import type { FrappeRow } from "./frappe-read.ts";
import type { AuthorityCurrentPrecondition } from "./authority-records.ts";
import { safetyReleaseGate } from "./safety-release-gate.ts";
import { holdingSafetyStops, type SafetyBlocker, type SafetyHoldingStop } from "./safety-lifecycle.ts";
import {
  fieldWorkPackageForAssignment,
  fieldWorkPackageProjection,
  currentWorkPackageAuthorityResolution,
  hasWorkPackageCompletionAuthority,
} from "./work-package.ts";
import {
  nativeWorkPackageAction,
  reconcileNativeWorkPackageActions,
} from "./work-package-store.ts";

const MAX_WORK_PACKAGE_ACTION_BYTES = 16 * 1024;
const MAX_BLOCKER_REASON_LENGTH = 4_000;
const WORK_PACKAGE_ACTION_LEASE_MS = 90_000;

export type WorkPackageActionKind =
  | "acknowledge"
  | "stop_work"
  | "start_work"
  | "complete_work";

export interface WorkPackageActionPayload {
  work_package_id: string;
  work_package_version: number;
  release_attempt_id?: string;
  blocker_reason?: string | null;
  work_object_type?: string;
  work_object_id?: string;
  physical_context_type?: string;
  physical_context_id?: string;
}

export interface WorkPackageActionSubmission {
  deviceActionId: string;
  jobId: string;
  assignmentId: string;
  kind: WorkPackageActionKind;
  payload: WorkPackageActionPayload;
}

export interface VerifiedWorkPackageActionResponse {
  device_action_id: string;
  status: "verified";
  server_ref: string;
  cursor: string;
}

interface WorkPackageActionIdentity {
  deviceActionId: string;
  tenantId: string;
  userId: string;
  jobId: string;
  assignmentId: string;
  workPackageId: string;
  kind: WorkPackageActionKind;
  payloadHash: string;
}

interface ClaimInput extends WorkPackageActionIdentity {
  now: string;
  token: string;
  leaseExpiresAt: string;
}

type ClaimResult =
  | { state: "acquired" }
  | { state: "busy" }
  | { state: "conflict" }
  | { state: "verified"; response: VerifiedWorkPackageActionResponse };

export interface WorkPackageActionStore {
  find(
    identity: WorkPackageActionIdentity,
  ): Promise<
    | { state: "matching" }
    | { state: "verified"; response: VerifiedWorkPackageActionResponse }
    | { state: "mismatch" }
    | null
  >;
  claim(input: ClaimInput): Promise<ClaimResult>;
  renew(
    deviceActionId: string,
    token: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  markR2Stored(
    deviceActionId: string,
    manifestKey: string,
    now: string,
  ): Promise<void>;
  complete(
    deviceActionId: string,
    token: string,
    response: VerifiedWorkPackageActionResponse,
    now: string,
  ): Promise<void>;
  fail(
    deviceActionId: string,
    token: string,
    errorCode: string,
    now: string,
  ): Promise<void>;
}

export interface PersistWorkPackageActionInput {
  kind: WorkPackageActionKind;
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  assignmentId: string;
  actorUser: string;
  actorRole?: AppRole | string;
  deviceActionId: string;
  blockerReason: string | null;
  releaseAttemptId: string | null;
  workObjectType: string | null;
  workObjectId: string | null;
  physicalContextType: string | null;
  physicalContextId: string | null;
  manifestKey?: string | null;
  authorityPreconditions: AuthorityCurrentPrecondition[];
}

export interface WorkPackageCommandWriter {
  persistAction(
    input: PersistWorkPackageActionInput,
  ): Promise<{ workPackageName: string; eventName: string }>;
}

export interface ProcessWorkPackageActionDependencies {
  store: WorkPackageActionStore;
  objects: ImmutableObjectStore;
  native: WorkPackageCommandWriter;
  now?: () => Date;
  randomId?: () => string;
  authorityPreconditions?: AuthorityCurrentPrecondition[];
}

/**
 * Bounded worker and production action endpoints use this single JSON
 * envelope. Work-package state itself is never a generic Frappe REST write,
 * and hold-point release is intentionally absent: field evidence may be
 * submitted, while completion is an online production-authority action.
 */
export async function handleWorkPackageAction(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  jobId: string,
  assignment: FrappeRow,
  kind: WorkPackageActionKind,
  scope?: WorkObjectScope,
): Promise<Response> {
  try {
    if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id) {
      throw new FieldActionError(
        "not_found",
        404,
        "No current work package is available for this tenant.",
      );
    }
    const assignmentId = text(assignment.name);
    if (!assignmentId) {
      throw new FieldActionError(
        "work_package_not_available",
        404,
        "No current work package is available for this assignment.",
      );
    }
    const submission = await parseWorkPackageActionRequest(
      req,
      jobId,
      assignmentId,
      kind,
      scope,
    );
    const store = d1WorkPackageActionStore(env);
    const identity = await actionIdentity(submission, auth);
    let existing = await store.find(identity);
    if (existing?.state === "verified")
      return workPackageJson(existing.response);
    // Reconcile the native append-only fact first: a response can be lost
    // after that fact commits but before the receipt becomes verified. A
    // merely claimed/retryable row has no such authority; it must pass the
    // current safety and authority gates again before reclamation.
    if (existing?.state === "matching") {
      await reconcileNativeWorkPackageActions(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        1,
        submission.deviceActionId,
      );
      existing = await store.find(identity);
      if (existing?.state === "verified") {
        return workPackageJson(existing.response);
      }
    }
    const authorityPreconditions =
      existing?.state !== "mismatch"
        ? await assertCurrentActionAllowed(env, auth, submission, assignment)
        : [];
    const response = await processWorkPackageAction(submission, auth, {
      store,
      objects: r2ObjectStore(env.RAW),
      native: nativeWorkPackageWriter(env),
      authorityPreconditions,
    });
    return workPackageJson(response);
  } catch (error) {
    return workPackageFailureResponse(error);
  }
}

/**
 * Return an exact durable response before looking up a now-terminal assignment.
 * This closes the lost-response window where the native event committed but its
 * stop/complete transition made the package disappear from the current view.
 */
export async function replayVerifiedWorkPackageAction(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  jobId: string,
  kind: WorkPackageActionKind,
  scope?: WorkObjectScope,
): Promise<Response | null> {
  if (env.APP_TENANT_ID?.trim() !== auth.session.tenant_id) return null;
  const headerActionId = req.headers.get("x-device-action-id");
  if (!headerActionId) return null;
  try {
    const deviceActionId = boundedId(headerActionId, 8, 80);
    let row = await workPackageActionRow(env, deviceActionId);
    if (!row) return null;
    const submission = await parseWorkPackageActionRequest(
      req.clone(),
      jobId,
      row.assignment_id,
      kind,
      scope,
    );
    const identity = await actionIdentity(submission, auth);
    if (!matchesIdentity(row, identity)) {
      throw new FieldActionError(
        "idempotency_conflict",
        409,
        "This device action id is already bound to a different work-package action.",
      );
    }
    if (row.status !== "verified") {
      await reconcileNativeWorkPackageActions(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        1,
        deviceActionId,
      );
      row = await workPackageActionRow(env, deviceActionId);
    }
    if (row?.status !== "verified") return null;
    const response = parseStoredResponse(row.response_json);
    if (!response)
      throw new Error("work_package_action_verified_response_invalid");
    return workPackageJson(response);
  } catch (error) {
    return workPackageFailureResponse(error);
  }
}

export async function parseWorkPackageActionRequest(
  req: Request,
  jobId: string,
  assignmentId: string,
  kind: WorkPackageActionKind,
  scope?: WorkObjectScope,
): Promise<WorkPackageActionSubmission> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WORK_PACKAGE_ACTION_BYTES)
    throw actionPayloadTooLarge();
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw invalidWorkPackageAction();
  }
  let source: string;
  try {
    source = await req.text();
  } catch {
    throw invalidWorkPackageAction();
  }
  if (byteLength(source) > MAX_WORK_PACKAGE_ACTION_BYTES)
    throw actionPayloadTooLarge();
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw invalidWorkPackageAction();
  }
  if (
    !isRecord(decoded) ||
    !exactKeys(decoded, ["device_action_id", "payload"])
  )
    throw invalidWorkPackageAction();
  const deviceActionId = boundedId(decoded.device_action_id, 8, 80);
  assertActionHeader(req.headers.get("x-device-action-id"), deviceActionId);
  assertActionHeader(req.headers.get("idempotency-key"), deviceActionId);
  if (!isRecord(decoded.payload)) throw invalidWorkPackageAction();
  const scopePayloadKeys = [
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
  ];
  const allowedPayloadKeys =
    kind === "stop_work"
      ? [
          "work_package_id",
          "work_package_version",
          "release_attempt_id",
          "blocker_reason",
          ...(scope ? scopePayloadKeys : []),
        ]
      : [
          "work_package_id",
          "work_package_version",
          "release_attempt_id",
          ...(scope ? scopePayloadKeys : []),
        ];
  const suppliedKeys = Object.keys(decoded.payload);
  const requiredPayloadKeys =
    kind === "stop_work"
      ? ["work_package_id", "work_package_version"]
      : ["work_package_id", "work_package_version", "release_attempt_id"];
  if (scope) requiredPayloadKeys.push(...scopePayloadKeys);
  if (
    !requiredPayloadKeys.every((key) => suppliedKeys.includes(key)) ||
    suppliedKeys.some((key) => !allowedPayloadKeys.includes(key))
  )
    throw invalidWorkPackageAction();
  const workPackageId = boundedId(decoded.payload.work_package_id, 1, 140);
  const workPackageVersion = boundedPositiveInteger(
    decoded.payload.work_package_version,
  );
  const releaseAttemptId =
    kind === "stop_work"
      ? optionalBoundedId(decoded.payload.release_attempt_id, 140)
      : boundedId(decoded.payload.release_attempt_id, 1, 140);
  const blockerReason =
    kind === "stop_work" && "blocker_reason" in decoded.payload
      ? optionalBlockerReason(decoded.payload.blocker_reason)
      : undefined;
  const parsedScope = scope
    ? {
        work_object_type: boundedText(
          decoded.payload.work_object_type,
          1,
          140,
        ),
        work_object_id: boundedId(decoded.payload.work_object_id, 1, 140),
        physical_context_type: boundedText(
          decoded.payload.physical_context_type,
          1,
          140,
        ),
        physical_context_id: boundedId(
          decoded.payload.physical_context_id,
          1,
          140,
        ),
      }
    : undefined;
  if (
    scope &&
    (!parsedScope ||
      parsedScope.work_object_type !== scope.workObjectType ||
      parsedScope.work_object_id !== scope.workObjectId ||
      parsedScope.physical_context_type !== scope.physicalContextType ||
      parsedScope.physical_context_id !== scope.physicalContextId)
  ) {
    throw invalidWorkPackageAction();
  }
  return {
    deviceActionId,
    jobId: boundedText(jobId, 1, 140),
    assignmentId: boundedText(assignmentId, 1, 140),
    kind,
    payload: {
      work_package_id: workPackageId,
      work_package_version: workPackageVersion,
      ...(releaseAttemptId ? { release_attempt_id: releaseAttemptId } : {}),
      ...(blockerReason === undefined ? {} : { blocker_reason: blockerReason }),
      ...(parsedScope ?? {}),
    },
  };
}

export async function processWorkPackageAction(
  submission: WorkPackageActionSubmission,
  auth: AuthContext,
  dependencies: ProcessWorkPackageActionDependencies,
): Promise<VerifiedWorkPackageActionResponse> {
  validateSubmission(submission, auth);
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const identity = await actionIdentity(submission, auth);
  const started = now();
  const token = randomId();
  const claim = await dependencies.store.claim({
    ...identity,
    now: started.toISOString(),
    token,
    leaseExpiresAt: new Date(
      started.getTime() + WORK_PACKAGE_ACTION_LEASE_MS,
    ).toISOString(),
  });
  if (claim.state === "verified") return claim.response;
  if (claim.state === "conflict") {
    throw new FieldActionError(
      "idempotency_conflict",
      409,
      "This device action id is already bound to a different work-package action.",
    );
  }
  if (claim.state === "busy") {
    throw new FieldActionError(
      "action_in_progress",
      503,
      "This work-package action is already being verified.",
      3,
    );
  }

  try {
    const scopeDigest = (
      await sha256Text(`${auth.session.tenant_id}:${submission.jobId}`)
    ).slice(0, 24);
    const manifest = stableStringify({
      version: 1,
      tenant_id: auth.session.tenant_id,
      user_id: auth.session.user_id,
      actor_user: auth.session.user_id,
      job_id: submission.jobId,
      assignment_id: submission.assignmentId,
      work_package_id: submission.payload.work_package_id,
      action_kind: submission.kind,
      device_action_id: submission.deviceActionId,
      payload: submission.payload,
    });
    const manifestKey = workPackageManifestKey(
      scopeDigest,
      submission.payload.work_package_id,
      submission.deviceActionId,
    );
    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    await dependencies.objects.ensure(
      manifestKey,
      manifest,
      "application/json",
      await sha256Text(manifest),
    );
    await dependencies.store.markR2Stored(
      submission.deviceActionId,
      manifestKey,
      now().toISOString(),
    );

    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    const persisted = await dependencies.native.persistAction({
      kind: submission.kind,
      workPackageId: submission.payload.work_package_id,
      workPackageVersion: submission.payload.work_package_version,
      jobId: submission.jobId,
      assignmentId: submission.assignmentId,
      actorUser: auth.session.user_id,
      actorRole: auth.session.role,
      deviceActionId: submission.deviceActionId,
      blockerReason: submission.payload.blocker_reason?.trim() || null,
      releaseAttemptId: submission.payload.release_attempt_id ?? null,
      workObjectType: submission.payload.work_object_type ?? null,
      workObjectId: submission.payload.work_object_id ?? null,
      physicalContextType: submission.payload.physical_context_type ?? null,
      physicalContextId: submission.payload.physical_context_id ?? null,
      manifestKey,
      authorityPreconditions: dependencies.authorityPreconditions ?? [],
    });
    const response: VerifiedWorkPackageActionResponse = {
      device_action_id: submission.deviceActionId,
      status: "verified",
      server_ref: persisted.workPackageName,
      cursor: persisted.eventName,
    };
    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    await dependencies.store.complete(
      submission.deviceActionId,
      token,
      response,
      now().toISOString(),
    );
    return response;
  } catch (error) {
    const code =
      error instanceof FieldActionError ? error.code : safeErrorCode(error);
    await dependencies.store
      .fail(submission.deviceActionId, token, code, now().toISOString())
      .catch(() => {});
    throw error instanceof FieldActionError
      ? error
      : new FieldActionError(
          code,
          502,
          "The work-package action remains unverified until its owned event and evidence binding both succeed.",
          5,
        );
  }
}

/** Native D1 command writer. Frappe is not consulted on this path. */
export function nativeWorkPackageWriter(env: AppEnv): WorkPackageCommandWriter {
  return {
    async persistAction(input) {
      if (!input.actorRole) throw new Error("work_package_actor_role_missing");
      if (!input.manifestKey) throw new Error("work_package_manifest_missing");
      try {
        return await nativeWorkPackageAction(env, {
          ...input,
          actorRole: input.actorRole,
          manifestKey: input.manifestKey,
        });
      } catch (error) {
        // D1 found a stop holding this job after the Worker's own gate passed (0170).
        if (error instanceof Error && error.message === "safety_stop_active") {
          throw safetyStopRefusal(
            await holdingSafetyStops(env, env.APP_TENANT_ID ?? "ironwrap", [input.jobId])
              .then((byJob) => byJob.get(input.jobId) ?? [])
              .catch(() => []),
          );
        }
        if (
          error instanceof Error &&
          error.message === "work_package_authority_precondition_stale"
        ) {
          throw new FieldActionError(
            "authority_release_blocked",
            409,
            "Authority readiness changed before this action could be committed.",
          );
        }
        throw error;
      }
    },
  };
}

async function assertCurrentActionAllowed(
  env: AppEnv,
  auth: AuthContext,
  submission: WorkPackageActionSubmission,
  assignment: FrappeRow,
): Promise<AuthorityCurrentPrecondition[]> {
  const workPackage = await fieldWorkPackageForAssignment(
    env,
    submission.jobId,
    submission.assignmentId,
    auth.session.tenant_id,
  );
  if (
    !workPackage ||
    workPackage.id !== submission.payload.work_package_id ||
    (submission.payload.work_package_version !== undefined &&
      submission.payload.work_package_version !== workPackage.version)
  ) {
    throw new FieldActionError(
      "work_package_not_available",
      404,
      "No current work package is available for this assignment.",
    );
  }
  const capability = {
    acknowledge: "work_package.acknowledge",
    stop_work: "work_package.stop_work",
    start_work: "work_package.start",
    complete_work: "work_package.complete",
  } satisfies Record<WorkPackageActionKind, string>;
  // Stopping work never consults authority or safety readiness. Every other
  // action re-evaluates both current control planes before any command claim.
  let safetyBlockers: SafetyBlocker[] = [];
  let authorityPreconditions: AuthorityCurrentPrecondition[] = [];
  if (submission.kind !== "stop_work") {
    const evaluatedAt = new Date().toISOString();
    const authority = await currentWorkPackageAuthorityResolution(
      env,
      auth.session.tenant_id,
      workPackage,
      evaluatedAt,
    );
    const authorityDenials = authority.denials;
    if (authorityDenials.length > 0) {
      const unavailable = authorityDenials.includes("authority_unavailable");
      throw new FieldActionError(
        "authority_release_blocked",
        unavailable ? 503 : 409,
        `Authority readiness blocks this action: ${authorityDenials.join(", ")}.`,
        unavailable ? 5 : undefined,
      );
    }
    authorityPreconditions = authority.preconditions;
    safetyBlockers = (
      await safetyReleaseGate(env, {
        tenantId: auth.session.tenant_id,
        scope: {
          type: "work_package",
          id: submission.payload.work_package_id,
        },
        jobId: submission.jobId,
        subjectUserIds: [auth.session.user_id],
        consumer: "work_package_release",
        evaluatedByUserId: auth.session.user_id,
        decisionRef: `${submission.deviceActionId}:${submission.kind}`,
        now: evaluatedAt,
      })
    ).readiness.blockers;
  }
  const actorUsers = appUserIdentities(auth.session);
  if (
    !fieldWorkPackageProjection(
      workPackage,
      actorUsers,
      {
        completionAuthority: hasWorkPackageCompletionAuthority(
          workPackage,
          assignment,
          actorUsers,
          auth.session.role,
        ),
        safetyBlockers,
        authorityDenials: [],
      },
    ).allowedActions.includes(capability[submission.kind])
  ) {
    // An active stop that holds this job is named with the facts a crew screen shows.
    const stops = safetyBlockers.flatMap((blocker) => (blocker.stop ? [blocker.stop] : []));
    if (stops.length > 0) throw safetyStopRefusal(stops);
    throw new FieldActionError(
      safetyBlockers.length > 0
        ? "safety_release_blocked"
        : "work_package_action_not_allowed",
      409,
      safetyBlockers.length > 0
        ? `Safety readiness blocks this action: ${safetyBlockers
            .map((blocker) => blocker.code)
            .join(", ")}.`
        : "That work-package action is no longer allowed.",
    );
  }
  return authorityPreconditions;
}

function d1WorkPackageActionStore(env: AppEnv): WorkPackageActionStore {
  return {
    async find(identity) {
      const row = await workPackageActionRow(env, identity.deviceActionId);
      if (!row) return null;
      if (!matchesIdentity(row, identity)) return { state: "mismatch" };
      if (row.status !== "verified") return { state: "matching" };
      const response = parseStoredResponse(row.response_json);
      if (!response)
        throw new Error("work_package_action_verified_response_invalid");
      return { state: "verified", response };
    },
    async claim(input) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO field_work_package_actions
          (device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id, action_kind,
           payload_hash, status, processing_token, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      )
        .bind(
          input.deviceActionId,
          input.tenantId,
          input.userId,
          input.jobId,
          input.assignmentId,
          input.workPackageId,
          input.kind,
          input.payloadHash,
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.now,
        )
        .run();
      let row = await workPackageActionRow(env, input.deviceActionId);
      if (!row) throw new Error("work_package_action_claim_missing");
      if (!matchesIdentity(row, input)) return { state: "conflict" };
      if (row.status === "verified") {
        const response = parseStoredResponse(row.response_json);
        if (!response)
          throw new Error("work_package_action_verified_response_invalid");
        return { state: "verified", response };
      }
      if (row.processing_token === input.token) return { state: "acquired" };
      const reclaimable =
        row.status === "retryable_error" ||
        !row.lease_expires_at ||
        row.lease_expires_at <= input.now;
      if (!reclaimable) return { state: "busy" };
      await env.DB.prepare(
        `UPDATE field_work_package_actions
         SET status = 'processing', processing_token = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
         WHERE device_action_id = ? AND payload_hash = ? AND status != 'verified'
           AND (status = 'retryable_error' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
        .bind(
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.deviceActionId,
          input.payloadHash,
          input.now,
        )
        .run();
      row = await workPackageActionRow(env, input.deviceActionId);
      return row?.processing_token === input.token
        ? { state: "acquired" }
        : { state: "busy" };
    },
    async renew(deviceActionId, token, now, leaseExpiresAt) {
      const result = await env.DB.prepare(
        `UPDATE field_work_package_actions SET lease_expires_at = ?, updated_at = ?
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(leaseExpiresAt, now, deviceActionId, token)
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },
    async markR2Stored(deviceActionId, manifestKey, now) {
      await env.DB.prepare(
        `UPDATE field_work_package_actions
         SET status = 'r2_stored', manifest_key = COALESCE(manifest_key, ?), updated_at = ?
         WHERE device_action_id = ? AND status != 'verified'`,
      )
        .bind(manifestKey, now, deviceActionId)
        .run();
    },
    async complete(deviceActionId, token, response, now) {
      const result = await env.DB.prepare(
        `UPDATE field_work_package_actions
         SET status = 'verified', response_json = ?, verified_at = ?, updated_at = ?,
             processing_token = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(JSON.stringify(response), now, now, deviceActionId, token)
        .run();
      if (Number(result.meta.changes ?? 0) !== 1)
        throw new Error("work_package_action_lease_lost");
    },
    async fail(deviceActionId, token, errorCode, now) {
      await env.DB.prepare(
        `UPDATE field_work_package_actions
         SET status = 'retryable_error', last_error = ?, updated_at = ?, processing_token = NULL, lease_expires_at = NULL
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(errorCode.slice(0, 240), now, deviceActionId, token)
        .run();
    },
  };
}

interface WorkPackageActionRow {
  device_action_id: string;
  tenant_id: string;
  user_id: string;
  job_id: string;
  assignment_id: string;
  work_package_id: string;
  action_kind: string;
  payload_hash: string;
  status: string;
  processing_token: string | null;
  lease_expires_at: string | null;
  response_json: string | null;
}

async function workPackageActionRow(
  env: AppEnv,
  deviceActionId: string,
): Promise<WorkPackageActionRow | null> {
  return await env.DB.prepare(
    `SELECT device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id, action_kind,
            payload_hash, status, processing_token, lease_expires_at, response_json
     FROM field_work_package_actions WHERE device_action_id = ?`,
  )
    .bind(deviceActionId)
    .first<WorkPackageActionRow>();
}

function matchesIdentity(
  row: WorkPackageActionRow,
  input: WorkPackageActionIdentity,
): boolean {
  return (
    row.tenant_id === input.tenantId &&
    row.user_id === input.userId &&
    row.job_id === input.jobId &&
    row.assignment_id === input.assignmentId &&
    row.work_package_id === input.workPackageId &&
    row.action_kind === input.kind &&
    row.payload_hash === input.payloadHash
  );
}

async function actionIdentity(
  submission: WorkPackageActionSubmission,
  auth: AuthContext,
): Promise<WorkPackageActionIdentity> {
  return {
    deviceActionId: submission.deviceActionId,
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    jobId: submission.jobId,
    assignmentId: submission.assignmentId,
    workPackageId: submission.payload.work_package_id,
    kind: submission.kind,
    payloadHash: await sha256Text(
      stableStringify({
        job_id: submission.jobId,
        assignment_id: submission.assignmentId,
        action_kind: submission.kind,
        payload: submission.payload,
      }),
    ),
  };
}

async function renewLease(
  store: WorkPackageActionStore,
  deviceActionId: string,
  token: string,
  now: () => Date,
): Promise<void> {
  const current = now();
  const renewed = await store.renew(
    deviceActionId,
    token,
    current.toISOString(),
    new Date(current.getTime() + WORK_PACKAGE_ACTION_LEASE_MS).toISOString(),
  );
  if (!renewed)
    throw new FieldActionError(
      "action_lease_lost",
      503,
      "Another retry now owns this work-package action.",
      3,
    );
}

function validateSubmission(
  submission: WorkPackageActionSubmission,
  auth: AuthContext,
): void {
  boundedId(submission.deviceActionId, 8, 80);
  boundedText(submission.jobId, 1, 140);
  boundedText(submission.assignmentId, 1, 140);
  boundedId(submission.payload.work_package_id, 1, 140);
  boundedPositiveInteger(submission.payload.work_package_version);
  const scopeFields = [
    submission.payload.work_object_type,
    submission.payload.work_object_id,
    submission.payload.physical_context_type,
    submission.payload.physical_context_id,
  ];
  if (scopeFields.some((value) => value !== undefined)) {
    if (scopeFields.some((value) => value === undefined))
      throw invalidWorkPackageAction();
    boundedText(submission.payload.work_object_type, 1, 140);
    boundedId(submission.payload.work_object_id, 1, 140);
    boundedText(submission.payload.physical_context_type, 1, 140);
    boundedId(submission.payload.physical_context_id, 1, 140);
    if (submission.payload.work_object_id !== submission.jobId)
      throw invalidWorkPackageAction();
  }
  if (submission.kind !== "stop_work") {
    boundedId(submission.payload.release_attempt_id, 1, 140);
  } else if (submission.payload.release_attempt_id !== undefined) {
    optionalBoundedId(submission.payload.release_attempt_id, 140);
  }
  const completionAuthority =
    submission.kind === "complete_work" &&
    (auth.session.role === "owner" ||
      auth.session.role === "ops" ||
      auth.session.role === "production");
  if (auth.session.role !== "field" && !completionAuthority) {
    throw new FieldActionError(
      "field_role_required",
      403,
      "A field role is required for worker actions; completion requires production authority.",
    );
  }
  if (submission.kind === "stop_work") {
    if ("blocker_reason" in submission.payload)
      optionalBlockerReason(submission.payload.blocker_reason);
  } else if (submission.payload.blocker_reason !== undefined) {
    throw invalidWorkPackageAction();
  }
}

function parseStoredResponse(
  value: string | null,
): VerifiedWorkPackageActionResponse | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      value,
    ) as Partial<VerifiedWorkPackageActionResponse>;
    return parsed.status === "verified" &&
      typeof parsed.device_action_id === "string" &&
      typeof parsed.server_ref === "string" &&
      typeof parsed.cursor === "string"
      ? (parsed as VerifiedWorkPackageActionResponse)
      : null;
  } catch {
    return null;
  }
}

function workPackageManifestKey(
  scopeDigest: string,
  workPackageId: string,
  deviceActionId: string,
): string {
  return `field/v1/${scopeDigest}/work-package/${workPackageId}/${deviceActionId}/manifest.json`;
}

function assertActionHeader(
  value: string | null,
  deviceActionId: string,
): void {
  if (value !== null && value.trim() !== deviceActionId)
    throw invalidWorkPackageAction();
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === allowed.length &&
    keys.every((key, index) => key === [...allowed].sort()[index])
  );
}

function boundedId(value: unknown, min: number, max: number): string {
  const parsed = boundedText(value, min, max);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw invalidWorkPackageAction();
  return parsed;
}

function optionalBoundedId(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedId(value, 1, max);
}

function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw invalidWorkPackageAction();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max)
    throw invalidWorkPackageAction();
  return parsed;
}

function optionalBlockerReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_BLOCKER_REASON_LENGTH)
    throw invalidWorkPackageAction();
  // Keep the submitted words in the immutable manifest and action identity.
  // The native event alone reduces a blank explanation to null.
  return value;
}

function boundedPositiveInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1_000_000
  ) {
    throw invalidWorkPackageAction();
  }
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "work_package_action_failed";
  return /^[a-z0-9_]{3,80}$/.test(message)
    ? message
    : "work_package_action_failed";
}

function invalidWorkPackageAction(): FieldActionError {
  return new FieldActionError(
    "invalid_work_package_action",
    400,
    "The work-package action is invalid.",
  );
}

function actionPayloadTooLarge(): FieldActionError {
  return new FieldActionError(
    "work_package_action_too_large",
    413,
    "The work-package action is too large.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function workPackageJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

/**
 * Acknowledge, start and complete are refused while an active safety stop holds the job. The body
 * names each holding stop: `{ error: "safety_stop_active", message, safety_stops: [{ occurrence_id,
 * scope: "job" | "tenant", raised_at, raiser_display_name }] }`. Stopping work is never refused.
 */
function safetyStopRefusal(stops: SafetyHoldingStop[]): FieldActionError {
  return new FieldActionError(
    "safety_stop_active",
    409,
    "A safety stop holds this job. Work stays stopped until a person releases it.",
    undefined,
    undefined,
    { safety_stops: stops },
  );
}

function workPackageFailureResponse(error: unknown): Response {
  const failure =
    error instanceof FieldActionError
      ? error
      : new FieldActionError(
          "work_package_action_failed",
          502,
          "The work-package action could not be verified yet.",
          5,
        );
  const response = workPackageJson(
    { ...failure.details, error: failure.code, message: failure.message },
    failure.status,
  );
  if (failure.retryAfterSeconds)
    response.headers.set("retry-after", String(failure.retryAfterSeconds));
  return response;
}
