import type { AppEnv, AuthContext, WorkObjectScope } from "./app-types.ts";
import {
  FieldActionError,
  r2ObjectStore,
  type ImmutableObjectStore,
} from "./field-actions.ts";
import { adapterAuthority, assertEffectLedgerReady, runExternalEffect } from "./effect-runtime.ts";
import {
  frappeBaseUrl,
  frappeRequestTimeout,
  type FrappeRow,
} from "./frappe-read.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { safetyReleaseGate } from "./safety-release-gate.ts";
import {
  fieldWorkPackageForAssignment,
  fieldWorkPackageProjection,
  hasWorkPackageCompletionAuthority,
} from "./work-package.ts";

const MAX_WORK_PACKAGE_ACTION_BYTES = 16 * 1024;
const MAX_BLOCKER_REASON_LENGTH = 1_200;
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
  blocker_reason?: string;
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
  deviceActionId: string;
  blockerReason: string | null;
  releaseAttemptId: string | null;
  workObjectType: string | null;
  workObjectId: string | null;
  physicalContextType: string | null;
  physicalContextId: string | null;
}

export interface WorkPackageFrappeWriter {
  persistAction(
    input: PersistWorkPackageActionInput,
  ): Promise<{ workPackageName: string; eventName: string }>;
}

export interface ProcessWorkPackageActionDependencies {
  store: WorkPackageActionStore;
  objects: ImmutableObjectStore;
  frappe: WorkPackageFrappeWriter;
  now?: () => Date;
  randomId?: () => string;
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
    const existing = await store.find(await actionIdentity(submission, auth));
    if (existing?.state === "verified")
      return workPackageJson(existing.response);
    // A first submission must be a currently allowed action. Once the same
    // scoped device action is durable, a lost response can safely replay its
    // idempotent Frappe command even after that command changed the package to
    // Blocked or In Progress. Frappe still locks and rechecks the transition.
    if (existing?.state !== "matching")
      await assertCurrentActionAllowed(env, auth, submission, assignment);
    const response = await processWorkPackageAction(submission, auth, {
      store,
      objects: r2ObjectStore(env.RAW),
      frappe: frappeWorkPackageWriter(env),
    });
    return workPackageJson(response);
  } catch (error) {
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
      { error: failure.code, message: failure.message },
      failure.status,
    );
    if (failure.retryAfterSeconds)
      response.headers.set("retry-after", String(failure.retryAfterSeconds));
    return response;
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
      ? ["work_package_id", "work_package_version", "blocker_reason"]
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
    kind === "stop_work"
      ? boundedText(
          decoded.payload.blocker_reason,
          1,
          MAX_BLOCKER_REASON_LENGTH,
        )
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
      actor_user: auth.session.frappe_user_id,
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
    const persisted = await dependencies.frappe.persistAction({
      kind: submission.kind,
      workPackageId: submission.payload.work_package_id,
      workPackageVersion: submission.payload.work_package_version,
      jobId: submission.jobId,
      assignmentId: submission.assignmentId,
      actorUser: auth.session.frappe_user_id!,
      deviceActionId: submission.deviceActionId,
      blockerReason: submission.payload.blocker_reason ?? null,
      releaseAttemptId: submission.payload.release_attempt_id ?? null,
      workObjectType: submission.payload.work_object_type ?? null,
      workObjectId: submission.payload.work_object_id ?? null,
      physicalContextType: submission.payload.physical_context_type ?? null,
      physicalContextId: submission.payload.physical_context_id ?? null,
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
          "The work-package action remains unverified until its evidence and Frappe command both succeed.",
          5,
        );
  }
}

export function frappeWorkPackageWriter(env: AppEnv): WorkPackageFrappeWriter {
  return {
    async persistAction(input) {
      if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)
        throw new Error("work_package_frappe_not_configured");
      const method = {
        acknowledge: "acknowledge_work_package",
        stop_work: "stop_work",
        start_work: "start_work",
        complete_work: "complete_work_package",
      } satisfies Record<WorkPackageActionKind, string>;
      const path = `/api/method/ironwrap_roofing.work_package_api.${method[input.kind]}`;
      const body = {
        work_package_id: input.workPackageId,
        ...(input.workObjectType
          ? input.workObjectType === "Roof Job"
            ? { roof_job_id: input.jobId }
            : {}
          : { roof_job_id: input.jobId }),
        job_assignment_id: input.assignmentId,
        actor_user: input.actorUser,
        device_action_id: input.deviceActionId,
        work_package_version: input.workPackageVersion,
        ...(input.releaseAttemptId
          ? { release_attempt_id: input.releaseAttemptId }
          : {}),
        ...(input.kind === "stop_work" ? { blocker_reason: input.blockerReason } : {}),
        ...(input.workObjectType
          ? {
              work_object_type: input.workObjectType,
              work_object_id: input.workObjectId,
              physical_context_type: input.physicalContextType,
              physical_context_id: input.physicalContextId,
            }
          : {}),
      };
      const request = { path, body };
      const requestHash = await sha256Hex(canonicalJson(request));
      const eventName = `wpe_${(await sha256Hex(input.deviceActionId)).slice(0, 32)}`;
      assertEffectLedgerReady(env);
      const tenantId = env.APP_TENANT_ID ?? "ironwrap";
        const idempotencyKey = `work-package:${input.deviceActionId}`;
        const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const result = await runExternalEffect(env, {
          tenantId,
          actor: { type: "agent", id: "work-package-adapter" },
          taskId: `work-package:${input.deviceActionId}`,
          authority: adapterAuthority({
            tenantId,
            provider: "frappe",
            action: "work_package.mutation",
            actorId: "work-package-adapter",
            deadlineAt,
            retryLimit: 1,
          }),
          aggregate: {
            type: "work_package",
            id: input.workPackageId,
            version: input.workPackageVersion,
          },
          intentId: idempotencyKey,
          action: "work_package.mutation",
          request,
          requestHash,
          provider: "frappe",
          idempotencyKey,
          deadlineAt,
          expectedReadback: { event_name: eventName },
          retryLimit: 1,
          compensationPlan: {},
          correlationId: idempotencyKey,
        }, {
          async dispatch() {
            const value = await persistWorkPackageActionDirect(env, path, body);
            return {
              outcome: "accepted" as const,
              value,
              providerExternalId: value.eventName,
              providerResponse: value,
            };
          },
          async readback({ providerExternalId }) {
            return await workPackageActionReadback(env, providerExternalId);
          },
          async replay({ effect }) {
            const providerExternalId = effect.provider_external_id;
            if (!providerExternalId) throw new Error("work_package_replay_id_missing");
            const readback = await workPackageActionReadback(env, providerExternalId);
            if (readback.status !== "match" || !readback.observed || typeof readback.observed !== "object") {
              throw new Error(readback.detailCode ?? "work_package_replay_readback_failed");
            }
            const observed = readback.observed as { event_name?: unknown; work_package_name?: unknown };
            if (typeof observed.event_name !== "string" || typeof observed.work_package_name !== "string") {
              throw new Error("work_package_replay_shape_invalid");
            }
            return { workPackageName: observed.work_package_name, eventName: observed.event_name };
          },
        });
        if (result.effect.state !== "succeeded" || result.value === undefined) {
          throw new Error(result.effect.result_code ?? "work_package_frappe_effect_unknown");
        }
      return result.value;
    },
  };
}

async function persistWorkPackageActionDirect(
  env: AppEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<{ workPackageName: string; eventName: string }> {
      if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET) throw new Error("work_package_frappe_not_configured");
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS),
      );
      try {
        const response = await fetch(
          `${frappeBaseUrl(env)}${path}`,
          {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              accept: "application/json",
              authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
              "content-type": "application/json",
              "user-agent": "ironwrap-bff/1.0",
            },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok)
          throw new Error(`work_package_frappe_http_${response.status}`);
        const decoded = (await response.json()) as {
          message?: {
            work_package?: { name?: unknown };
            event?: { name?: unknown };
          };
        };
        const workPackageName = text(decoded.message?.work_package?.name);
        const eventName = text(decoded.message?.event?.name);
        if (!workPackageName || !eventName)
          throw new Error("work_package_frappe_invalid_shape");
        return { workPackageName, eventName };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError")
          throw new Error("work_package_frappe_timeout");
        if (
          error instanceof Error &&
          error.message.startsWith("work_package_frappe_")
        )
          throw error;
        throw new Error("work_package_frappe_network_error");
      } finally {
        clearTimeout(timer);
      }
}

async function workPackageActionReadback(
  env: AppEnv,
  providerExternalId: string | null,
): Promise<{ status: "match" | "conflict" | "unavailable" | "not_found"; providerExternalId?: string; observed?: unknown; detailCode?: string }> {
  if (!providerExternalId) return { status: "unavailable", detailCode: "work_package_readback_id_missing" };
  try {
    const response = await fetch(
      `${frappeBaseUrl(env)}/api/resource/Work%20Package%20Event/${encodeURIComponent(providerExternalId)}`,
      {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
        },
      },
    );
    if (response.status === 404) return { status: "not_found", detailCode: "work_package_readback_not_found" };
    if (!response.ok) return { status: "unavailable", detailCode: `work_package_readback_${response.status}` };
    const payload = await response.json() as { data?: Record<string, unknown> };
    const data = payload.data ?? {};
    const eventName = typeof data.name === "string" ? data.name : typeof data.work_package_event_id === "string" ? data.work_package_event_id : null;
    const workPackageName = typeof data.work_package === "string" ? data.work_package : null;
    const observed = { event_name: eventName, work_package_name: workPackageName };
    if (eventName !== providerExternalId || !workPackageName) {
      return { status: "conflict", providerExternalId, observed, detailCode: "work_package_readback_conflict" };
    }
    return { status: "match", providerExternalId, observed };
  } catch {
    return { status: "unavailable", detailCode: "work_package_readback_unavailable" };
  }
}

async function assertCurrentActionAllowed(
  env: AppEnv,
  auth: AuthContext,
  submission: WorkPackageActionSubmission,
  assignment: FrappeRow,
): Promise<void> {
  const workPackage = await fieldWorkPackageForAssignment(
    env,
    submission.jobId,
    submission.assignmentId,
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
  // Stopping work never consults safety readiness. Every other action does, and
  // a release decision records the immutable snapshot of what it saw.
  const safetyBlockers =
    submission.kind === "stop_work"
      ? []
      : (
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
            now: new Date().toISOString(),
          })
        ).readiness.blockers;
  if (
    !fieldWorkPackageProjection(
      workPackage,
      auth.session.frappe_user_id,
      {
        completionAuthority: hasWorkPackageCompletionAuthority(
          workPackage,
          assignment,
          auth.session.frappe_user_id,
          auth.session.role,
        ),
        safetyBlockers,
      },
    ).allowedActions.includes(capability[submission.kind])
  ) {
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
  if (!auth.session.frappe_user_id?.trim()) {
    throw new FieldActionError(
      "field_identity_missing",
      403,
      "This field account is not linked to a Frappe user.",
    );
  }
  if (submission.kind === "stop_work") {
    boundedText(
      submission.payload.blocker_reason,
      1,
      MAX_BLOCKER_REASON_LENGTH,
    );
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
