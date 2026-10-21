import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { r2ObjectStore, type ImmutableObjectStore } from "./field-actions.ts";
import {
  reportEquipmentDefect,
  reportSafetyOccurrence,
  recordMakeSafe,
  SafetyError,
  SAFETY_OCCURRENCE_KINDS,
  SAFETY_SCOPE_TYPES,
  SAFETY_SEVERITIES,
  type SafetyEvidence,
  type SafetyOccurrenceKind,
  type SafetyScopeRef,
  type SafetySeverity,
} from "./safety-lifecycle.ts";

/**
 * The global safety action rail.
 *
 * This is deliberately not the work-package rail. A worker must be able to
 * report a hazard, make an area safe, condemn a defective harness, or call for
 * rescue with no current work package, no assignment, and no job — including
 * from a device that has been offline for hours. Every action is therefore
 * durable, idempotent on the device-generated action id, and reachable by any
 * active tenant user regardless of role.
 */

const SAFETY_ACTION_LEASE_MS = 90_000;
const MAX_SAFETY_ACTION_BYTES = 16 * 1024;
const MAX_DETAIL_LENGTH = 4_000;

export const SAFETY_DEVICE_ACTION_KINDS = [
  "report_occurrence",
  "make_safe",
  "equipment_defect",
  "rescue_request",
] as const;

export type SafetyDeviceActionKind = (typeof SAFETY_DEVICE_ACTION_KINDS)[number];

export interface SafetyDeviceActionPayload {
  occurrence_id?: string;
  equipment_id?: string;
  occurrence_kind?: SafetyOccurrenceKind;
  severity?: SafetySeverity;
  detail: string;
  evidence_refs_json?: string;
  evidence_sha256?: string;
}

export interface SafetyDeviceActionSubmission {
  deviceActionId: string;
  kind: SafetyDeviceActionKind;
  scope: SafetyScopeRef;
  capturedAt: string;
  payload: SafetyDeviceActionPayload;
}

export interface VerifiedSafetyActionResponse {
  device_action_id: string;
  status: "verified";
  server_ref: string;
  cursor: string;
  /**
   * Raises only (`report_occurrence`, `rescue_request`): true when the scope names no job, Work
   * Package or tenant of this tenant. The stop is recorded and active either way. Absent for `shop`
   * and `vehicle` scopes, which nothing checks yet.
   */
  scope_unresolved?: boolean;
}

interface SafetyActionIdentity {
  deviceActionId: string;
  tenantId: string;
  userId: string;
  kind: SafetyDeviceActionKind;
  scope: SafetyScopeRef;
  capturedAt: string;
  payloadHash: string;
}

export interface ProcessSafetyActionDependencies {
  objects: ImmutableObjectStore;
  now?: () => Date;
  randomId?: () => string;
}

interface SafetyActionRow {
  device_action_id: string;
  tenant_id: string;
  user_id: string;
  action_kind: string;
  scope_type: string;
  scope_id: string;
  payload_hash: string;
  status: string;
  processing_token: string | null;
  lease_expires_at: string | null;
  response_json: string | null;
  captured_at: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export async function parseSafetyActionRequest(
  req: Request,
): Promise<SafetyDeviceActionSubmission> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw invalidSafetyAction();
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SAFETY_ACTION_BYTES) {
    throw new SafetyError("safety_action_too_large", 413, "The safety action is too large.");
  }
  let source: string;
  try {
    source = await req.text();
  } catch {
    throw invalidSafetyAction();
  }
  if (new TextEncoder().encode(source).byteLength > MAX_SAFETY_ACTION_BYTES) {
    throw new SafetyError("safety_action_too_large", 413, "The safety action is too large.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw invalidSafetyAction();
  }
  // The envelope matches every other durable field action, so the safety rail
  // rides the proven offline outbox instead of inventing a second one.
  if (!isRecord(decoded) || !exactKeys(decoded, ["device_action_id", "payload"])) {
    throw invalidSafetyAction();
  }
  const deviceActionId = boundedId(decoded.device_action_id, 8, 80);
  assertActionHeader(req.headers.get("x-device-action-id"), deviceActionId);
  assertActionHeader(req.headers.get("idempotency-key"), deviceActionId);
  if (!isRecord(decoded.payload)) throw invalidSafetyAction();
  const kind = decoded.payload.kind;
  if (
    typeof kind !== "string" ||
    !SAFETY_DEVICE_ACTION_KINDS.includes(kind as SafetyDeviceActionKind)
  ) {
    throw invalidSafetyAction();
  }
  const scopeType = decoded.payload.scope_type;
  if (
    typeof scopeType !== "string" ||
    !SAFETY_SCOPE_TYPES.includes(scopeType as SafetyScopeRef["type"])
  ) {
    throw invalidSafetyAction();
  }
  const scope: SafetyScopeRef = {
    type: scopeType as SafetyScopeRef["type"],
    id: boundedId(decoded.payload.scope_id, 1, 140),
  };
  const capturedAt = decoded.payload.captured_at;
  if (typeof capturedAt !== "string" || !ISO_INSTANT.test(capturedAt)) throw invalidSafetyAction();
  return {
    deviceActionId,
    kind: kind as SafetyDeviceActionKind,
    scope,
    capturedAt,
    payload: parsePayload(kind as SafetyDeviceActionKind, decoded.payload),
  };
}

function parsePayload(
  kind: SafetyDeviceActionKind,
  payload: Record<string, unknown>,
): SafetyDeviceActionPayload {
  const envelopeKeys = ["captured_at", "kind", "scope_id", "scope_type"];
  const evidenceKeys = ["evidence_refs_json", "evidence_sha256"];
  const required: Record<SafetyDeviceActionKind, string[]> = {
    report_occurrence: ["detail", "occurrence_kind", "severity"],
    make_safe: ["detail", "occurrence_id"],
    equipment_defect: ["detail", "equipment_id"],
    rescue_request: ["detail"],
  };
  const allowed = [...required[kind], ...evidenceKeys, ...envelopeKeys];
  const supplied = Object.keys(payload).filter((key) => !envelopeKeys.includes(key));
  if (
    !required[kind].every((key) => supplied.includes(key)) ||
    supplied.some((key) => !allowed.includes(key))
  ) {
    throw invalidSafetyAction();
  }
  const detail = boundedText(payload.detail, 3, MAX_DETAIL_LENGTH);
  const evidenceRefsJson = payload.evidence_refs_json;
  const evidenceSha256 = payload.evidence_sha256;
  if ((evidenceRefsJson === undefined) !== (evidenceSha256 === undefined)) throw invalidSafetyAction();
  if (evidenceSha256 !== undefined && (typeof evidenceSha256 !== "string" || !SHA256.test(evidenceSha256))) {
    throw invalidSafetyAction();
  }
  if (evidenceRefsJson !== undefined && typeof evidenceRefsJson !== "string") {
    throw invalidSafetyAction();
  }
  const evidence =
    evidenceRefsJson === undefined
      ? {}
      : { evidence_refs_json: evidenceRefsJson as string, evidence_sha256: evidenceSha256 as string };
  if (kind === "report_occurrence") {
    const occurrenceKind = payload.occurrence_kind;
    const severity = payload.severity;
    if (
      typeof occurrenceKind !== "string" ||
      !SAFETY_OCCURRENCE_KINDS.includes(occurrenceKind as SafetyOccurrenceKind) ||
      typeof severity !== "string" ||
      !SAFETY_SEVERITIES.includes(severity as SafetySeverity)
    ) {
      throw invalidSafetyAction();
    }
    return {
      detail,
      occurrence_kind: occurrenceKind as SafetyOccurrenceKind,
      severity: severity as SafetySeverity,
      ...evidence,
    };
  }
  if (kind === "make_safe") {
    return { detail, occurrence_id: boundedId(payload.occurrence_id, 3, 140), ...evidence };
  }
  if (kind === "equipment_defect") {
    return { detail, equipment_id: boundedId(payload.equipment_id, 3, 140), ...evidence };
  }
  return { detail, ...evidence };
}

/**
 * Durable, duplicate-safe application of one offline safety action.
 *
 * The R2 manifest is written before the D1 effect so a crash between the two
 * leaves recoverable evidence of what the worker captured rather than a silent
 * loss. A replay of the same device action id returns the original response.
 */
export async function processSafetyDeviceAction(
  env: AppEnv,
  auth: AuthContext,
  submission: SafetyDeviceActionSubmission,
  dependencies: ProcessSafetyActionDependencies,
): Promise<VerifiedSafetyActionResponse> {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const identity = await safetyActionIdentity(submission, auth);
  const existing = await safetyActionRow(env, identity.deviceActionId);
  if (existing) {
    if (!matchesIdentity(existing, identity)) {
      throw new SafetyError(
        "idempotency_conflict",
        409,
        "This device action id is already bound to a different safety action.",
      );
    }
    if (existing.status === "verified") {
      const response = parseStoredResponse(existing.response_json);
      if (response) return response;
    }
  }

  const started = now();
  const token = randomId();
  const claim = await claimSafetyAction(env, identity, token, started);
  if (claim.state === "verified") return claim.response;
  if (claim.state === "conflict") {
    throw new SafetyError(
      "idempotency_conflict",
      409,
      "This device action id is already bound to a different safety action.",
    );
  }
  if (claim.state === "busy") {
    throw new SafetyError(
      "action_in_progress",
      503,
      "This safety action is already being recorded.",
    );
  }

  try {
    const manifest = stableStringify({
      version: 1,
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      action_kind: submission.kind,
      scope: submission.scope,
      captured_at: submission.capturedAt,
      device_action_id: submission.deviceActionId,
      payload: submission.payload,
    });
    const scopeDigest = (await sha256Hex(`${identity.tenantId}:${submission.scope.id}`)).slice(0, 24);
    const manifestKey = `safety/v1/${scopeDigest}/${submission.kind}/${submission.deviceActionId}/manifest.json`;
    await renewSafetyLease(env, submission.deviceActionId, token, now);
    await dependencies.objects.ensure(
      manifestKey,
      manifest,
      "application/json",
      await sha256Hex(manifest),
    );
    await env.DB.prepare(
      `UPDATE safety_device_actions
          SET status = 'r2_stored', manifest_key = COALESCE(manifest_key, ?), updated_at = ?
        WHERE device_action_id = ? AND status != 'verified'`,
    )
      .bind(manifestKey, now().toISOString(), submission.deviceActionId)
      .run();

    await renewSafetyLease(env, submission.deviceActionId, token, now);
    const applied = await applySafetyAction(env, identity, submission, now());
    // Stored below as `response_json`, so a replay repeats this answer, scope flag included.
    const response: VerifiedSafetyActionResponse = {
      device_action_id: submission.deviceActionId,
      status: "verified",
      server_ref: applied.serverRef,
      cursor: applied.cursor,
      ...(applied.scopeUnresolved === undefined ? {} : { scope_unresolved: applied.scopeUnresolved }),
    };
    const completed = await env.DB.prepare(
      `UPDATE safety_device_actions
          SET status = 'verified', response_json = ?, verified_at = ?, updated_at = ?,
              processing_token = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
    )
      .bind(
        JSON.stringify(response),
        now().toISOString(),
        now().toISOString(),
        submission.deviceActionId,
        token,
      )
      .run();
    if (Number(completed.meta?.changes ?? 0) !== 1) {
      throw new SafetyError(
        "safety_action_lease_lost",
        503,
        "Another retry now owns this safety action.",
      );
    }
    return response;
  } catch (error) {
    const code = error instanceof SafetyError ? error.code : "safety_action_failed";
    await env.DB.prepare(
      `UPDATE safety_device_actions
          SET status = 'retryable_error', last_error = ?, updated_at = ?,
              processing_token = NULL, lease_expires_at = NULL
        WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
    )
      .bind(code.slice(0, 240), now().toISOString(), submission.deviceActionId, token)
      .run()
      .catch(() => undefined);
    throw error instanceof SafetyError
      ? error
      : new SafetyError(
          "safety_action_failed",
          502,
          "The safety action remains unrecorded until its evidence and record both succeed.",
        );
  }
}

async function applySafetyAction(
  env: AppEnv,
  identity: SafetyActionIdentity,
  submission: SafetyDeviceActionSubmission,
  now: Date,
): Promise<{ serverRef: string; cursor: string; scopeUnresolved?: boolean }> {
  const nowIso = now.toISOString();
  // A device clock ahead of the server never invents a future safety record.
  // The device's raw value stays in the R2 manifest either way.
  const occurredAt = submission.capturedAt > nowIso ? nowIso : submission.capturedAt;
  const evidence = submissionEvidence(submission);
  if (submission.kind === "report_occurrence" || submission.kind === "rescue_request") {
    const occurrenceId = await derivedOccurrenceId(submission.deviceActionId);
    const result = await reportSafetyOccurrence(env, {
      occurrenceId,
      tenantId: identity.tenantId,
      occurrenceKind:
        submission.kind === "rescue_request"
          ? "emergency"
          : (submission.payload.occurrence_kind as SafetyOccurrenceKind),
      severity:
        submission.kind === "rescue_request"
          ? "critical"
          : (submission.payload.severity as SafetySeverity),
      scope: submission.scope,
      reportedByUserId: identity.userId,
      reportedAt: occurredAt,
      summary: submission.payload.detail,
      rescueRequired: submission.kind === "rescue_request",
      evidence,
      capturedOffline: true,
      deviceActionId: submission.deviceActionId,
      now: nowIso,
    });
    // The stop is already recorded: its scope is read only to flag it, never to refuse it.
    const scopeUnresolved = await raisedScopeUnresolved(env, identity.tenantId, submission.scope);
    return {
      serverRef: result.occurrence.occurrence_id,
      cursor: `${result.occurrence.occurrence_id}:${result.occurrence.version}`,
      ...(scopeUnresolved === undefined ? {} : { scopeUnresolved }),
    };
  }
  if (submission.kind === "make_safe") {
    const occurrence = await recordMakeSafe(env, {
      tenantId: identity.tenantId,
      occurrenceId: submission.payload.occurrence_id as string,
      actorUserId: identity.userId,
      detail: submission.payload.detail,
      evidence,
      capturedOffline: true,
      deviceActionId: submission.deviceActionId,
      occurredAt,
      now: nowIso,
    });
    return {
      serverRef: occurrence.occurrence_id,
      cursor: `${occurrence.occurrence_id}:${occurrence.version}`,
    };
  }
  const equipment = await reportEquipmentDefect(env, {
    tenantId: identity.tenantId,
    equipmentId: submission.payload.equipment_id as string,
    actorUserId: identity.userId,
    detail: submission.payload.detail,
    evidence,
    deviceActionId: submission.deviceActionId,
    occurredAt,
    now: nowIso,
  });
  return {
    serverRef: equipment.equipment_id,
    cursor: `${equipment.equipment_id}:${equipment.version}`,
  };
}

/** Where a stop's job and Work Package live: the native job, and any version of the package. */
const SCOPE_EXISTS_SQL: Partial<Record<SafetyScopeRef["type"], string>> = {
  roof_job: "SELECT 1 FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ? LIMIT 1",
  work_package: "SELECT 1 FROM work_packages WHERE tenant_id = ? AND work_package_id = ? LIMIT 1",
};

/**
 * Whether a raised stop's scope names nothing this tenant has: another tenant's id, a job with no
 * `operating_roof_jobs` row, or a Work Package with no `work_packages` row in any status.
 * Undefined for `shop` and `vehicle`, which nothing checks yet.
 */
async function raisedScopeUnresolved(
  env: AppEnv,
  tenantId: string,
  scope: SafetyScopeRef,
): Promise<boolean | undefined> {
  if (scope.type === "tenant") return scope.id !== tenantId;
  const sql = SCOPE_EXISTS_SQL[scope.type];
  if (!sql) return undefined;
  return (await env.DB.prepare(sql).bind(tenantId, scope.id).first()) === null;
}

function submissionEvidence(submission: SafetyDeviceActionSubmission): SafetyEvidence | null {
  return submission.payload.evidence_refs_json && submission.payload.evidence_sha256
    ? {
        refsJson: submission.payload.evidence_refs_json,
        sha256: submission.payload.evidence_sha256,
      }
    : null;
}

async function derivedOccurrenceId(deviceActionId: string): Promise<string> {
  return `so_${(await sha256Hex(deviceActionId)).slice(0, 32)}`;
}

type ClaimResult =
  | { state: "acquired" }
  | { state: "busy" }
  | { state: "conflict" }
  | { state: "verified"; response: VerifiedSafetyActionResponse };

async function claimSafetyAction(
  env: AppEnv,
  identity: SafetyActionIdentity,
  token: string,
  started: Date,
): Promise<ClaimResult> {
  const now = started.toISOString();
  const leaseExpiresAt = new Date(started.getTime() + SAFETY_ACTION_LEASE_MS).toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO safety_device_actions
       (device_action_id, tenant_id, user_id, action_kind, scope_type, scope_id, payload_hash,
        status, processing_token, lease_expires_at, captured_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`,
  )
    .bind(
      identity.deviceActionId,
      identity.tenantId,
      identity.userId,
      identity.kind,
      identity.scope.type,
      identity.scope.id,
      identity.payloadHash,
      token,
      leaseExpiresAt,
      identity.capturedAt,
      now,
      now,
    )
    .run();
  let row = await safetyActionRow(env, identity.deviceActionId);
  if (!row) throw new SafetyError("safety_action_claim_missing", 502, "The safety action was lost.");
  if (!matchesIdentity(row, identity)) return { state: "conflict" };
  if (row.status === "verified") {
    const response = parseStoredResponse(row.response_json);
    if (response) return { state: "verified", response };
  }
  if (row.processing_token === token) return { state: "acquired" };
  const reclaimable =
    row.status === "retryable_error" || !row.lease_expires_at || row.lease_expires_at <= now;
  if (!reclaimable) return { state: "busy" };
  await env.DB.prepare(
    `UPDATE safety_device_actions
        SET status = 'processing', processing_token = ?, lease_expires_at = ?, updated_at = ?,
            last_error = NULL
      WHERE device_action_id = ? AND payload_hash = ? AND status != 'verified'
        AND (status = 'retryable_error' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(token, leaseExpiresAt, now, identity.deviceActionId, identity.payloadHash, now)
    .run();
  row = await safetyActionRow(env, identity.deviceActionId);
  return row?.processing_token === token ? { state: "acquired" } : { state: "busy" };
}

async function renewSafetyLease(
  env: AppEnv,
  deviceActionId: string,
  token: string,
  now: () => Date,
): Promise<void> {
  const current = now();
  const result = await env.DB.prepare(
    `UPDATE safety_device_actions SET lease_expires_at = ?, updated_at = ?
      WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
  )
    .bind(
      new Date(current.getTime() + SAFETY_ACTION_LEASE_MS).toISOString(),
      current.toISOString(),
      deviceActionId,
      token,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new SafetyError(
      "safety_action_lease_lost",
      503,
      "Another retry now owns this safety action.",
    );
  }
}

async function safetyActionRow(
  env: AppEnv,
  deviceActionId: string,
): Promise<SafetyActionRow | null> {
  return await env.DB.prepare(
    `SELECT device_action_id, tenant_id, user_id, action_kind, scope_type, scope_id, payload_hash,
            status, processing_token, lease_expires_at, response_json, captured_at
       FROM safety_device_actions WHERE device_action_id = ?`,
  )
    .bind(deviceActionId)
    .first<SafetyActionRow>();
}

function matchesIdentity(row: SafetyActionRow, identity: SafetyActionIdentity): boolean {
  return (
    row.tenant_id === identity.tenantId &&
    row.user_id === identity.userId &&
    row.action_kind === identity.kind &&
    row.scope_type === identity.scope.type &&
    row.scope_id === identity.scope.id &&
    row.payload_hash === identity.payloadHash &&
    row.captured_at === identity.capturedAt
  );
}

async function safetyActionIdentity(
  submission: SafetyDeviceActionSubmission,
  auth: AuthContext,
): Promise<SafetyActionIdentity> {
  return {
    deviceActionId: submission.deviceActionId,
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    kind: submission.kind,
    scope: submission.scope,
    capturedAt: submission.capturedAt,
    payloadHash: await sha256Hex(
      stableStringify({
        action_kind: submission.kind,
        captured_at: submission.capturedAt,
        payload: submission.payload,
        scope: submission.scope,
      }),
    ),
  };
}

export function safetyActionDependencies(env: AppEnv): ProcessSafetyActionDependencies {
  return { objects: r2ObjectStore(env.RAW) };
}

function parseStoredResponse(value: string | null): VerifiedSafetyActionResponse | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<VerifiedSafetyActionResponse>;
    return parsed.status === "verified" &&
      typeof parsed.device_action_id === "string" &&
      typeof parsed.server_ref === "string" &&
      typeof parsed.cursor === "string"
      ? (parsed as VerifiedSafetyActionResponse)
      : null;
  } catch {
    return null;
  }
}

function assertActionHeader(value: string | null, deviceActionId: string): void {
  if (value !== null && value.trim() !== deviceActionId) throw invalidSafetyAction();
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function boundedId(value: unknown, min: number, max: number): string {
  const parsed = boundedText(value, min, max);
  if (!BOUNDED_ID.test(parsed)) throw invalidSafetyAction();
  return parsed;
}

function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw invalidSafetyAction();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max) throw invalidSafetyAction();
  if (/[\u0000-\u001f]/.test(parsed)) throw invalidSafetyAction();
  return parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidSafetyAction(): SafetyError {
  return new SafetyError("invalid_safety_action", 400, "The safety action is invalid.");
}
