import type { AppEnv } from "./app-types.ts";
import {
  frappeBaseUrl,
  frappeRequestTimeout,
  listFrappeResource,
} from "./frappe-read.ts";
import { adapterAuthority, assertEffectLedgerReady, runExternalEffect } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export interface PersistFieldMediaInput {
  evidenceId: string;
  deviceActionId: string;
  jobId: string;
  workObjectType?: string | null;
  workObjectId?: string | null;
  physicalContextType?: string | null;
  physicalContextId?: string | null;
  evidenceType: "Photo" | "Voice Note";
  proofSlot: string;
  r2Key: string;
  checksum: string;
  contentType: string;
  contentLength: number;
  capturedAt: string;
  captureActor: string;
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  summary: string | null;
  customerSafe: boolean;
  correctionOf: string | null;
  correctionReason: string | null;
  workPackageReleaseAttemptId?: string | null;
  workPackageId?: string | null;
  workPackageVersion?: number | null;
  evidenceSlotId?: string | null;
  evidenceRequirement?: string | null;
  evidenceSource?: string | null;
  evidenceDeviceId?: string | null;
  evidenceFreshness?: "Current" | "Stale" | "Unknown" | null;
  evidenceConflictState?: "None" | "Detected" | "Resolved" | null;
  evidenceVerification?: "Pending" | "Verified" | "Rejected" | null;
  evidenceDisposition?:
    "Open" | "Accepted" | "Needs Correction" | "Superseded" | null;
}

export interface PersistFieldCheckInInput {
  checkinId: string;
  deviceActionId: string;
  jobId: string;
  assignmentId: string;
  captureActor: string;
  captureStartedAt: string;
  captureCompletedAt: string;
  submittedAt: string;
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  photoCount: number;
  evidenceIds: string[];
  blocker: boolean;
  blockerCategory: string | null;
  blockerSummary: string | null;
  voiceEvidenceId: string | null;
  correctionOf: string | null;
  correctionReason: string | null;
  notes: string | null;
  manifestKey: string;
}

export interface PersistWorkPackageEvidenceInput {
  workPackageId: string;
  workPackageVersion: number;
  jobId: string;
  workObjectType?: string | null;
  workObjectId?: string | null;
  physicalContextType?: string | null;
  physicalContextId?: string | null;
  assignmentId: string;
  actorUser: string;
  deviceActionId: string;
  evidenceSlotId: string;
  evidenceRequirement: string;
  evidenceSource: string;
  evidenceItemId: string;
  evidenceDeviceId: string;
  evidenceCapturedAt: string;
  evidenceFreshness: "Current" | "Stale" | "Unknown";
  evidenceConflictState: "None" | "Detected" | "Resolved";
  evidenceCorrectionOf: string | null;
  evidenceItemCorrectionOf: string | null;
  workPackageReleaseAttemptId: string;
  correctionReason: string | null;
  evidenceVerification: "Pending" | "Verified" | "Rejected";
  evidenceDisposition: "Open" | "Accepted" | "Needs Correction" | "Superseded";
}

export interface FieldFrappeWriter {
  persistEvidence(input: PersistFieldMediaInput): Promise<{ name: string }>;
  persistCheckIn(input: PersistFieldCheckInInput): Promise<{ name: string }>;
  persistWorkPackageEvidence?(
    input: PersistWorkPackageEvidenceInput,
  ): Promise<{ name: string }>;
}

export function frappeFieldWriter(env: AppEnv): FieldFrappeWriter {
  return {
    async persistEvidence(input) {
      if (input.correctionOf) {
        await assertCorrectionTarget(
          env,
          "Evidence Item",
          input.correctionOf,
          input.jobId,
          input,
        );
      }
      const existing = await listFrappeResource(
        env,
        "Evidence Item",
        [["Evidence Item", "evidence_id", "=", input.evidenceId]],
        1,
      );
      const existingName = text(existing[0]?.name);
      if (existingName) {
        assertExistingEvidence(existing[0]!, input);
        return { name: existingName };
      }
      return await createVerifiedFieldEvidence(
        env,
        compact({
          evidence_id: input.evidenceId,
          device_action_id: input.deviceActionId,
          ...evidenceScopeFields(input),
          work_package: input.workPackageId,
          work_package_version: input.workPackageVersion,
          evidence_slot_id: input.evidenceSlotId,
          evidence_requirement: input.evidenceRequirement,
          evidence_source: input.evidenceSource,
          evidence_device_id: input.evidenceDeviceId,
          evidence_type: input.evidenceType,
          proof_slot: input.proofSlot,
          r2_key: input.r2Key,
          content_checksum: input.checksum,
          checksum_algorithm: "SHA-256",
          content_type: input.contentType,
          content_length: input.contentLength,
          capture_actor: input.captureActor,
          captured_at: frappeDatetime(input.capturedAt),
          latitude: input.latitude,
          longitude: input.longitude,
          location_accuracy_m: input.locationAccuracyM,
          correction_of: input.correctionOf,
          correction_reason: input.correctionReason,
          evidence_freshness: input.evidenceFreshness,
          evidence_conflict_state: input.evidenceConflictState,
          evidence_verification: input.evidenceVerification,
          evidence_disposition: input.evidenceDisposition,
          work_package_release_attempt_id: input.workPackageReleaseAttemptId,
          customer_safe: input.customerSafe ? 1 : 0,
          summary: input.summary,
        }),
      );
    },
    async persistCheckIn(input) {
      if (input.correctionOf) {
        await assertCorrectionTarget(
          env,
          "Field Check-in",
          input.correctionOf,
          input.jobId,
        );
      }
      const existing = await listFrappeResource(
        env,
        "Field Check-in",
        [["Field Check-in", "checkin_id", "=", input.checkinId]],
        1,
      );
      const existingName = text(existing[0]?.name);
      if (existingName) {
        assertExistingCheckIn(existing[0]!, input);
        return { name: existingName };
      }
      return await createFrappeResource(
        env,
        "Field Check-in",
        compact({
          checkin_id: input.checkinId,
          device_action_id: input.deviceActionId,
          roof_job: input.jobId,
          job_assignment: input.assignmentId,
          source_system: "ironwrap-pwa",
          capture_actor: input.captureActor,
          capture_started_at: frappeDatetime(input.captureStartedAt),
          capture_completed_at: frappeDatetime(input.captureCompletedAt),
          submitted_at: frappeDatetime(input.submittedAt),
          status: "Received",
          sync_state: "Verified",
          verified_at: frappeDatetime(new Date().toISOString()),
          latitude: input.latitude,
          longitude: input.longitude,
          location_accuracy_m: input.locationAccuracyM,
          photo_count: input.photoCount,
          evidence_ids_json: JSON.stringify(input.evidenceIds),
          blocker_flag: input.blocker ? 1 : 0,
          // Frappe Select fields default to their first option when omitted; an
          // implicit blocker_category trips the policy's stale_blocker rule.
          blocker_category: input.blockerCategory ?? "",
          blocker_summary: input.blockerSummary,
          voice_evidence: input.voiceEvidenceId,
          correction_of: input.correctionOf,
          correction_reason: input.correctionReason,
          notes: input.notes,
          raw_key: input.manifestKey,
        }),
      );
    },
    async persistWorkPackageEvidence(input) {
      const decoded = (await postFrappeJson(
        env,
        "/api/method/ironwrap_roofing.work_package_api.capture_work_package_evidence",
        {
          work_package_id: input.workPackageId,
          work_package_version: input.workPackageVersion,
          ...workPackageScopeFields(input),
          job_assignment_id: input.assignmentId,
          actor_user: input.actorUser,
          device_action_id: input.deviceActionId,
          evidence_slot_id: input.evidenceSlotId,
          evidence_requirement: input.evidenceRequirement,
          evidence_source: input.evidenceSource,
          evidence_item_id: input.evidenceItemId,
          evidence_device_id: input.evidenceDeviceId,
          evidence_captured_at: frappeDatetime(input.evidenceCapturedAt),
          evidence_freshness: input.evidenceFreshness,
          evidence_conflict_state: input.evidenceConflictState,
          evidence_correction_of: input.evidenceCorrectionOf,
          evidence_item_correction_of: input.evidenceItemCorrectionOf,
          release_attempt_id: input.workPackageReleaseAttemptId,
          correction_reason: input.correctionReason,
          evidence_verification: input.evidenceVerification,
          evidence_disposition: input.evidenceDisposition,
        },
      )) as { message?: { event?: { name?: unknown } } };
      const name = text(decoded?.message?.event?.name);
      if (!name) throw new Error("frappe_field_invalid_shape");
      return { name };
    },
  };
}

async function assertCorrectionTarget(
  env: AppEnv,
  doctype: "Evidence Item" | "Field Check-in",
  targetName: string,
  jobId: string,
  scope?: PersistFieldMediaInput,
): Promise<void> {
  const rows = await listFrappeResource(
    env,
    doctype,
    [[doctype, "name", "=", targetName]],
    1,
  );
  const target = rows[0];
  if (
    !target ||
    text(target.name) !== targetName ||
    !evidenceScopeMatches(target, jobId, scope) ||
    text(target.sync_state) !== "Verified" ||
    text(target.correction_of) === targetName
  ) {
    throw new Error("frappe_field_correction_invalid");
  }
}

function assertExistingEvidence(
  row: Record<string, unknown>,
  input: PersistFieldMediaInput,
): void {
  if (
    text(row.evidence_id) !== input.evidenceId ||
    text(row.device_action_id) !== input.deviceActionId ||
    !evidenceScopeMatches(row, input.jobId, input) ||
    text(row.work_package) !== (input.workPackageId ?? null) ||
    numberOrNull(row.work_package_version) !==
      (input.workPackageVersion ?? null) ||
    text(row.work_package_release_attempt_id) !==
      (input.workPackageReleaseAttemptId ?? null) ||
    text(row.evidence_slot_id) !== (input.evidenceSlotId ?? null) ||
    text(row.evidence_requirement) !== (input.evidenceRequirement ?? null) ||
    text(row.evidence_source) !== (input.evidenceSource ?? null) ||
    text(row.evidence_device_id) !== (input.evidenceDeviceId ?? null) ||
    text(row.evidence_type) !== input.evidenceType ||
    text(row.proof_slot) !== input.proofSlot ||
    text(row.source_system) !== "ironwrap-pwa" ||
    text(row.r2_key) !== input.r2Key ||
    text(row.content_checksum) !== input.checksum ||
    text(row.content_type) !== input.contentType ||
    Number(row.content_length) !== input.contentLength ||
    text(row.capture_actor) !== input.captureActor ||
    booleanValue(row.customer_safe) !== input.customerSafe ||
    text(row.sync_state) !== "Verified" ||
    text(row.correction_of) !== input.correctionOf ||
    text(row.correction_reason) !== input.correctionReason ||
    text(row.evidence_freshness) !== (input.evidenceFreshness ?? null) ||
    text(row.evidence_conflict_state) !==
      (input.evidenceConflictState ?? null) ||
    text(row.evidence_verification) !== (input.evidenceVerification ?? null) ||
    text(row.evidence_disposition) !== (input.evidenceDisposition ?? null)
  ) {
    throw new Error("frappe_field_identity_conflict");
  }
}

type TypedEvidenceScope = Pick<
  PersistFieldMediaInput,
  "workObjectType" | "workObjectId" | "physicalContextType" | "physicalContextId"
>;

function hasTypedScope(input: TypedEvidenceScope): boolean {
  return Boolean(
    input.workObjectType ||
      input.workObjectId ||
      input.physicalContextType ||
      input.physicalContextId,
  );
}

function assertCompleteTypedScope(input: TypedEvidenceScope): void {
  if (
    !input.workObjectType ||
    !input.workObjectId ||
    !input.physicalContextType ||
    !input.physicalContextId ||
    input.workObjectType === "Roof Job"
  ) {
    throw new Error("frappe_field_scope_invalid");
  }
}

function evidenceScopeFields(
  input: PersistFieldMediaInput,
): Record<string, string> {
  if (!hasTypedScope(input) || input.workObjectType === "Roof Job") {
    return { roof_job: input.jobId };
  }
  assertCompleteTypedScope(input);
  // Evidence Item has no generic parent fields. The typed Work Package event
  // carries the immutable parent/context envelope below; omitting roof_job
  // here prevents a non-roof object from being projected as a Roof Job Link.
  return {};
}

function workPackageScopeFields(
  input: PersistWorkPackageEvidenceInput,
): Record<string, string> {
  if (!hasTypedScope(input) || input.workObjectType === "Roof Job") {
    return { roof_job_id: input.jobId };
  }
  assertCompleteTypedScope(input);
  return {
    work_object_type: input.workObjectType!,
    work_object_id: input.workObjectId!,
    physical_context_type: input.physicalContextType!,
    physical_context_id: input.physicalContextId!,
  };
}

function evidenceScopeMatches(
  row: Record<string, unknown>,
  jobId: string,
  scope?: TypedEvidenceScope,
): boolean {
  if (!scope || !hasTypedScope(scope) || scope.workObjectType === "Roof Job") {
    return text(row.roof_job) === jobId;
  }
  assertCompleteTypedScope(scope);
  // Evidence Item intentionally has no generic parent fields yet. Its exact
  // Work Package binding is checked by the typed Frappe capture command; here
  // the absence of a Roof Job link is the important non-roof invariant.
  return !text(row.roof_job);
}

function assertExistingCheckIn(
  row: Record<string, unknown>,
  input: PersistFieldCheckInInput,
): void {
  let evidenceIds: unknown;
  try {
    evidenceIds = JSON.parse(text(row.evidence_ids_json) ?? "null") as unknown;
  } catch {
    throw new Error("frappe_field_identity_conflict");
  }
  if (
    text(row.checkin_id) !== input.checkinId ||
    text(row.device_action_id) !== input.deviceActionId ||
    text(row.roof_job) !== input.jobId ||
    text(row.job_assignment) !== input.assignmentId ||
    text(row.source_system) !== "ironwrap-pwa" ||
    text(row.capture_actor) !== input.captureActor ||
    text(row.sync_state) !== "Verified" ||
    text(row.raw_key) !== input.manifestKey ||
    JSON.stringify(evidenceIds) !== JSON.stringify(input.evidenceIds) ||
    text(row.correction_of) !== input.correctionOf
  ) {
    throw new Error("frappe_field_identity_conflict");
  }
}

async function createFrappeResource(
  env: AppEnv,
  doctype: "Field Check-in",
  document: Record<string, unknown>,
): Promise<{ name: string }> {
  const decoded = (await postFrappeJson(
    env,
    `/api/resource/${encodeURIComponent(doctype)}`,
    document,
  )) as { data?: { name?: unknown } };
  const name = text(decoded?.data?.name);
  if (!name) throw new Error("frappe_field_invalid_shape");
  return { name };
}

async function createVerifiedFieldEvidence(
  env: AppEnv,
  document: Record<string, unknown>,
): Promise<{ name: string }> {
  const decoded = (await postFrappeJson(
    env,
    "/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence",
    { evidence_json: JSON.stringify(document) },
  )) as { message?: { name?: unknown } };
  const name = text(decoded?.message?.name);
  if (!name) throw new Error("frappe_field_invalid_shape");
  return { name };
}

async function postFrappeJson(
  env: AppEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  assertEffectLedgerReady(env);
  const tenantId = env.APP_TENANT_ID ?? "ironwrap";
    const request = { path, body };
    const requestHash = await sha256Hex(canonicalJson(request));
    const idempotencyKey = `frappe-field:${path}:${requestHash}`;
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = await runExternalEffect(env, {
      tenantId,
      actor: { type: "agent", id: "frappe-field-adapter" },
      taskId: `frappe-field:${path}`,
      authority: adapterAuthority({ tenantId, provider: "frappe", action: "field.mutation", actorId: "frappe-field-adapter", deadlineAt, retryLimit: 1 }),
      aggregate: { type: "frappe_field", id: requestHash.slice(0, 32), version: 0 },
      intentId: idempotencyKey,
      action: "field.mutation",
      request,
      requestHash,
      provider: "frappe",
      idempotencyKey,
      deadlineAt,
      expectedReadback: {},
      retryLimit: 1,
      compensationPlan: {},
      correlationId: idempotencyKey,
    }, {
      async dispatch() {
        const value = await postFrappeJsonDirect(env, path, body);
        const record = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown> : {};
        const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as Record<string, unknown> : {};
        const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
          ? record.message as Record<string, unknown> : {};
        const event = message.event && typeof message.event === "object" && !Array.isArray(message.event)
          ? message.event as Record<string, unknown> : {};
        const providerExternalId = typeof data.name === "string" ? data.name
          : typeof message.name === "string" ? message.name
            : typeof event.name === "string" ? event.name : null;
        return { outcome: "accepted" as const, value, providerExternalId, providerResponse: value };
      },
      async readback({ providerExternalId }) {
        return await fieldMutationReadback(env, path, providerExternalId);
      },
      async replay({ effect }) {
        const providerExternalId = effect.provider_external_id;
        if (!providerExternalId) throw new Error("frappe_field_replay_id_missing");
        const readback = await fieldMutationReadback(env, path, providerExternalId);
        if (readback.status !== "match") {
          throw new Error(readback.detailCode ?? "frappe_field_replay_readback_failed");
        }
        return path.includes("field_evidence_api")
          ? { message: { name: providerExternalId } }
          : path.includes("work_package_api")
            ? { message: { event: { name: providerExternalId } } }
            : { data: { name: providerExternalId } };
      },
    });
    if (result.effect.state !== "succeeded" || result.value === undefined) {
      throw new Error(result.effect.result_code ?? "frappe_field_effect_unknown");
    }
  return result.value;
}

async function postFrappeJsonDirect(
  env: AppEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)
    throw new Error("frappe_field_not_configured");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(`${frappeBaseUrl(env)}${path}`, {
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
    });
    if (!response.ok) throw new Error(`frappe_field_http_${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("frappe_field_timeout");
    if (error instanceof Error && error.message.startsWith("frappe_field_"))
      throw error;
    throw new Error("frappe_field_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function fieldMutationReadback(
  env: AppEnv,
  path: string,
  providerExternalId: string | null,
): Promise<{ status: "match" | "conflict" | "unavailable" | "not_found"; providerExternalId?: string; observed?: unknown; detailCode?: string }> {
  if (!providerExternalId) return { status: "unavailable", detailCode: "frappe_field_readback_id_missing" };
  const doctype = path.includes("field_evidence_api")
    ? "Evidence Item"
    : path.includes("work_package_api")
      ? "Work Package Event"
      : "Field Check-in";
  try {
    const response = await fetch(
      `${frappeBaseUrl(env)}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(providerExternalId)}`,
      { method: "GET", redirect: "manual", headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
      } },
    );
    if (response.status === 404) return { status: "not_found", detailCode: "frappe_field_readback_not_found" };
    if (!response.ok) return { status: "unavailable", detailCode: `frappe_field_readback_${response.status}` };
    const payload = await response.json() as { data?: Record<string, unknown> };
    const observed = payload.data ?? {};
    return observed.name === providerExternalId
      ? { status: "match", providerExternalId, observed: { name: observed.name } }
      : { status: "conflict", providerExternalId, observed, detailCode: "frappe_field_readback_conflict" };
  } catch {
    return { status: "unavailable", detailCode: "frappe_field_readback_unavailable" };
  }
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}

function frappeDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error("frappe_field_invalid_datetime");
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
