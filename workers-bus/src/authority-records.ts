import { sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";

export const AUTHORITY_RECORD_OPERATIONS = [
  "record",
  "verify",
  "renew",
  "supersede",
  "revoke",
  "resolve_exception",
] as const;

export type AuthorityRecordOperation = (typeof AUTHORITY_RECORD_OPERATIONS)[number];
export type AuthorityRecordActionStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "conflict"
  | "reconciliation_required";
export type AuthorityReadbackState =
  | "verified"
  | "revoked"
  | "contradictory"
  | "unavailable";

export interface AuthorityRecordAction {
  action_id: string;
  tenant_id: string;
  authority_record_id: string;
  operation: AuthorityRecordOperation;
  expected_version: number | null;
  idempotency_key_sha256: string;
  request_fingerprint_sha256: string;
  actor_user_id: string;
  status: AuthorityRecordActionStatus;
  result_json: string | null;
  rejection_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ClaimAuthorityRecordActionInput {
  actionId: string;
  tenantId: string;
  authorityRecordId: string;
  operation: AuthorityRecordOperation;
  expectedVersion: number | null;
  idempotencyKey: string;
  requestFingerprintSha256: string;
  actorUserId: string;
  now: string;
}

export type ClaimAuthorityRecordActionResult =
  | { kind: "claimed"; action: AuthorityRecordAction }
  | { kind: "replayed"; action: AuthorityRecordAction }
  | { kind: "conflict"; action: AuthorityRecordAction };

export interface CompleteAuthorityRecordActionInput {
  tenantId: string;
  actionId: string;
  actorUserId: string;
  terminal: AuthorityRecordTerminalReceipt;
  now: string;
}

export type AuthorityRecordTerminalReceipt =
  | {
      kind: "material_applied";
      actionId: string;
      authorityRecordId: string;
      authorityVersion: number;
      authorityStateDigestSha256: string;
      materialReadbackSha256: string;
      // Null is reserved for an internally governed competency assessment.
      // Undefined retains the strict legacy/direct-call default and therefore
      // still requires an issuer readback for a verify action.
      issuerReadbackId?: string | null;
    }
  | {
      kind: "reconciliation_required";
      actionId: string;
      authorityRecordId: string;
      reason: string;
      reconciliationReceiptSha256: string;
    };

export type RecordAuthorityReadbackResult =
  | { kind: "recorded"; readback: AuthorityRecordReadback }
  | { kind: "replayed"; readback: AuthorityRecordReadback }
  | { kind: "conflict"; readback: AuthorityRecordReadback };

export interface AuthorityRecordReadback {
  readback_id: string;
  tenant_id: string;
  authority_record_id: string;
  authority_version: number;
  subject_type: string | null;
  subject_role: string | null;
  person_user: string | null;
  organization: string | null;
  authority_kind: string | null;
  authority_scope: string | null;
  scope_type: string | null;
  scope_ref: string | null;
  roof_job: string | null;
  scope_json: string | null;
  issuer_name: string;
  issuer_jurisdiction: string;
  issuer_reference: string;
  issuer_source_version: string;
  verification_state: AuthorityReadbackState;
  evidence_refs_json: string;
  evidence_sha256: string;
  observed_by_user_id: string;
  observed_at: string;
  observation_fingerprint_sha256: string;
  action_id: string | null;
}

export interface RecordAuthorityReadbackInput {
  readbackId: string;
  tenantId: string;
  authorityRecordId: string;
  authorityVersion: number;
  subjectType: string;
  subjectRole: string;
  personUser: string | null;
  organization: string | null;
  authorityKind: string;
  authorityScope: string;
  scopeType: string;
  scopeRef: string;
  roofJob: string | null;
  scopeJson: string;
  issuerName: string;
  issuerJurisdiction: string;
  issuerReference: string;
  issuerSourceVersion: string;
  verificationState: AuthorityReadbackState;
  evidenceRefsJson: string;
  evidenceSha256: string;
  authorityStateDigestSha256: string;
  observedByUserId: string;
  observedAt: string;
  actionId: string | null;
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,139}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export async function claimAuthorityRecordAction(
  env: AppEnv,
  input: ClaimAuthorityRecordActionInput,
): Promise<ClaimAuthorityRecordActionResult> {
  validateActionInput(input);
  const idempotencyHash = await sha256Hex(`${input.tenantId}\n${input.idempotencyKey}`);
  const existing = await authorityActionByIdempotency(env, input.tenantId, idempotencyHash);
  if (existing) {
    return existing.request_fingerprint_sha256 === input.requestFingerprintSha256 &&
        existing.authority_record_id === input.authorityRecordId &&
        existing.operation === input.operation &&
        existing.expected_version === input.expectedVersion
      ? { kind: "replayed", action: existing }
      : { kind: "conflict", action: existing };
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO authority_record_actions
       (action_id, tenant_id, authority_record_id, operation, expected_version,
        idempotency_key_sha256, request_fingerprint_sha256, actor_user_id,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(tenant_id, idempotency_key_sha256) DO NOTHING`,
  ).bind(
    input.actionId,
    input.tenantId,
    input.authorityRecordId,
    input.operation,
    input.expectedVersion,
    idempotencyHash,
    input.requestFingerprintSha256,
    input.actorUserId,
    input.now,
    input.now,
  ).run();

  if (d1Changes(inserted) === 1) {
    const action = await authorityActionById(env, input.tenantId, input.actionId);
    if (action) return { kind: "claimed", action };
  }
  const raced = await authorityActionByIdempotency(env, input.tenantId, idempotencyHash);
  if (!raced) throw new Error("authority_record_action_claim_missing");
  return raced.request_fingerprint_sha256 === input.requestFingerprintSha256 &&
      raced.authority_record_id === input.authorityRecordId &&
      raced.operation === input.operation &&
      raced.expected_version === input.expectedVersion
    ? { kind: "replayed", action: raced }
    : { kind: "conflict", action: raced };
}

export async function completeAuthorityRecordAction(
  env: AppEnv,
  input: CompleteAuthorityRecordActionInput,
): Promise<AuthorityRecordAction | null> {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.actionId) ||
      !USER_ID.test(input.actorUserId) || !ISO_INSTANT.test(input.now) ||
      !validTerminalReceipt(input.terminal) ||
      input.terminal.actionId !== input.actionId ||
      !OPAQUE_ID.test(input.terminal.authorityRecordId)) {
    throw new Error("authority_record_action_completion_invalid");
  }
  const actor = await businessActor(env, input.tenantId, input.actorUserId);
  if (!actor) throw new Error("authority_record_business_actor_required");
  const existing = await authorityActionById(env, input.tenantId, input.actionId);
  if (!existing) return null;
  if (existing.status !== "pending") return existing;
  if (existing.authority_record_id !== input.terminal.authorityRecordId) {
    throw new Error("authority_record_action_completion_identity_mismatch");
  }
  if (existing.operation === "verify" && input.terminal.kind === "material_applied" &&
      input.terminal.issuerReadbackId !== null) {
    const readback = await env.DB.prepare(
      `SELECT verification_state, authority_state_digest_sha256
         FROM authority_record_readbacks
        WHERE tenant_id = ?
          AND authority_record_id = ?
          AND (? IS NULL OR authority_version = ?)
          AND (? IS NULL OR readback_id = ?)
        ORDER BY observed_at DESC
        LIMIT 1`,
    ).bind(
      input.tenantId,
      existing.authority_record_id,
      existing.expected_version,
      existing.expected_version,
      input.terminal.issuerReadbackId ?? null,
      input.terminal.issuerReadbackId ?? null,
    ).first<{ verification_state: AuthorityReadbackState; authority_state_digest_sha256: string }>();
    if (!readback || readback.verification_state !== "verified" ||
        readback.authority_state_digest_sha256 !== input.terminal.authorityStateDigestSha256) {
      throw new Error("authority_record_issuer_readback_required");
    }
  }
  const status = input.terminal.kind === "material_applied"
    ? "applied"
    : "reconciliation_required";
  const resultJson = JSON.stringify(input.terminal.kind === "material_applied"
    ? {
        authority_record_id: input.terminal.authorityRecordId,
        authority_version: input.terminal.authorityVersion,
        authority_state_digest_sha256: input.terminal.authorityStateDigestSha256,
        material_readback_sha256: input.terminal.materialReadbackSha256,
        ...(input.terminal.issuerReadbackId === undefined
          ? {}
          : { issuer_readback_id: input.terminal.issuerReadbackId }),
      }
    : {
        authority_record_id: input.terminal.authorityRecordId,
        reason: input.terminal.reason,
        reconciliation_receipt_sha256: input.terminal.reconciliationReceiptSha256,
      });
  const rejectionCode = input.terminal.kind === "reconciliation_required"
    ? "reconciliation_required"
    : null;
  const completed = await env.DB.prepare(
    `UPDATE authority_record_actions
        SET status = ?, result_json = ?, rejection_code = ?, updated_at = ?, completed_at = ?
      WHERE tenant_id = ? AND action_id = ? AND status = 'pending'`,
  ).bind(
    status,
    resultJson,
    rejectionCode,
    input.now,
    input.now,
    input.tenantId,
    input.actionId,
  ).run();
  if (d1Changes(completed) === 0) {
    return await authorityActionById(env, input.tenantId, input.actionId);
  }
  return await authorityActionById(env, input.tenantId, input.actionId);
}

export async function getAuthorityRecordAction(
  env: AppEnv,
  tenantId: string,
  actionId: string,
): Promise<AuthorityRecordAction | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(actionId)) return null;
  return await authorityActionById(env, tenantId, actionId);
}

export async function recordAuthorityReadback(
  env: AppEnv,
  input: RecordAuthorityReadbackInput,
): Promise<RecordAuthorityReadbackResult> {
  validateReadbackInput(input);
  const observationFingerprint = await sha256Hex(JSON.stringify({
    action_id: input.actionId,
    authority_record_id: input.authorityRecordId,
    authority_version: input.authorityVersion,
    subject_type: input.subjectType,
    subject_role: input.subjectRole,
    person_user: input.personUser,
    organization: input.organization,
    authority_kind: input.authorityKind,
    authority_scope: input.authorityScope,
    scope_type: input.scopeType,
    scope_ref: input.scopeRef,
    roof_job: input.roofJob,
    scope_json: input.scopeJson,
    evidence_refs_json: input.evidenceRefsJson,
    evidence_sha256: input.evidenceSha256,
    issuer_jurisdiction: input.issuerJurisdiction,
    issuer_name: input.issuerName,
    issuer_reference: input.issuerReference,
    issuer_source_version: input.issuerSourceVersion,
    observed_at: input.observedAt,
    observed_by_user_id: input.observedByUserId,
    tenant_id: input.tenantId,
    verification_state: input.verificationState,
    authority_state_digest_sha256: input.authorityStateDigestSha256,
  }));
  const existing = await authorityReadbackByIdentity(env, input.tenantId, input.readbackId);
  if (existing) {
    return existing.observation_fingerprint_sha256 === observationFingerprint
      ? { kind: "replayed", readback: existing }
      : { kind: "conflict", readback: existing };
  }
  const duplicate = await authorityReadbackByEvidence(
    env,
    input.tenantId,
    input.authorityRecordId,
    input.authorityVersion,
    input.evidenceSha256,
  );
  if (duplicate) {
    return duplicate.observation_fingerprint_sha256 === observationFingerprint
      ? { kind: "replayed", readback: duplicate }
      : { kind: "conflict", readback: duplicate };
  }
  const inserted = await env.DB.prepare(
    `INSERT INTO authority_record_readbacks
       (readback_id, tenant_id, authority_record_id, authority_version,
        subject_type, subject_role, person_user, organization, authority_kind,
        authority_scope, scope_type, scope_ref, roof_job, scope_json,
        issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
        verification_state, evidence_refs_json, evidence_sha256,
        authority_state_digest_sha256, observed_by_user_id, observed_at,
        observation_fingerprint_sha256, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    input.readbackId,
    input.tenantId,
    input.authorityRecordId,
    input.authorityVersion,
    input.subjectType,
    input.subjectRole,
    input.personUser,
    input.organization,
    input.authorityKind,
    input.authorityScope,
    input.scopeType,
    input.scopeRef,
    input.roofJob,
    input.scopeJson,
    input.issuerName,
    input.issuerJurisdiction,
    input.issuerReference,
    input.issuerSourceVersion,
    input.verificationState,
    input.evidenceRefsJson,
    input.evidenceSha256,
    input.authorityStateDigestSha256,
    input.observedByUserId,
    input.observedAt,
    observationFingerprint,
    input.actionId,
  ).run();
  if (d1Changes(inserted) === 1) {
    const readback = await authorityReadbackByIdentity(env, input.tenantId, input.readbackId);
    if (readback) return { kind: "recorded", readback };
  }
  const raced = await authorityReadbackByIdentity(env, input.tenantId, input.readbackId) ??
    await authorityReadbackByEvidence(
      env,
      input.tenantId,
      input.authorityRecordId,
      input.authorityVersion,
      input.evidenceSha256,
    );
  if (!raced) throw new Error("authority_record_readback_insert_missing");
  return raced.observation_fingerprint_sha256 === observationFingerprint
    ? { kind: "replayed", readback: raced }
    : { kind: "conflict", readback: raced };
}

export async function listAuthorityRecordReadbacks(
  env: AppEnv,
  tenantId: string,
  authorityRecordId: string,
  limit = 50,
): Promise<AuthorityRecordReadback[]> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(authorityRecordId)) return [];
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND authority_record_id = ?
      ORDER BY authority_version DESC, observed_at DESC
      LIMIT ?`,
  ).bind(tenantId, authorityRecordId, boundedLimit).all<AuthorityRecordReadback>();
  return rows.results;
}

async function authorityActionById(
  env: AppEnv,
  tenantId: string,
  actionId: string,
): Promise<AuthorityRecordAction | null> {
  return await env.DB.prepare(
    `SELECT action_id, tenant_id, authority_record_id, operation, expected_version,
            idempotency_key_sha256, request_fingerprint_sha256, actor_user_id,
            status, result_json, rejection_code, created_at, updated_at, completed_at
       FROM authority_record_actions
      WHERE tenant_id = ? AND action_id = ?
      LIMIT 1`,
  ).bind(tenantId, actionId).first<AuthorityRecordAction>();
}

async function authorityActionByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyHash: string,
): Promise<AuthorityRecordAction | null> {
  return await env.DB.prepare(
    `SELECT action_id, tenant_id, authority_record_id, operation, expected_version,
            idempotency_key_sha256, request_fingerprint_sha256, actor_user_id,
            status, result_json, rejection_code, created_at, updated_at, completed_at
       FROM authority_record_actions
      WHERE tenant_id = ? AND idempotency_key_sha256 = ?
      LIMIT 1`,
  ).bind(tenantId, idempotencyHash).first<AuthorityRecordAction>();
}

async function authorityReadbackByIdentity(
  env: AppEnv,
  tenantId: string,
  readbackId: string,
): Promise<AuthorityRecordReadback | null> {
  return await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND readback_id = ?
      LIMIT 1`,
  ).bind(tenantId, readbackId).first<AuthorityRecordReadback>();
}

async function authorityReadbackByEvidence(
  env: AppEnv,
  tenantId: string,
  authorityRecordId: string,
  authorityVersion: number,
  evidenceSha256: string,
): Promise<AuthorityRecordReadback | null> {
  return await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND authority_record_id = ?
        AND authority_version = ? AND evidence_sha256 = ?
      LIMIT 1`,
  ).bind(tenantId, authorityRecordId, authorityVersion, evidenceSha256).first<AuthorityRecordReadback>();
}

async function businessActor(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const actor = await env.DB.prepare(
    `SELECT user_id
       FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1 AND role IN ('owner', 'ops')
      LIMIT 1`,
  ).bind(tenantId, userId).first<{ user_id: string }>();
  return !!actor;
}

function validateActionInput(input: ClaimAuthorityRecordActionInput): void {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.actionId) ||
      !OPAQUE_ID.test(input.authorityRecordId) || !USER_ID.test(input.actorUserId) ||
      !AUTHORITY_RECORD_OPERATIONS.includes(input.operation) ||
      input.expectedVersion !== null &&
        (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !SHA256.test(input.requestFingerprintSha256) || !ISO_INSTANT.test(input.now)) {
    throw new Error("authority_record_action_input_invalid");
  }
}

function validTerminalReceipt(value: unknown): value is AuthorityRecordTerminalReceipt {
  if (!isRecord(value) || typeof value.kind !== "string" ||
      typeof value.actionId !== "string" || typeof value.authorityRecordId !== "string") {
    return false;
  }
  if (value.kind === "material_applied") {
    return Number.isInteger(value.authorityVersion) && Number(value.authorityVersion) >= 1 &&
      SHA256.test(String(value.authorityStateDigestSha256 ?? "")) &&
      SHA256.test(String(value.materialReadbackSha256 ?? "")) &&
      (value.issuerReadbackId === undefined || value.issuerReadbackId === null ||
        OPAQUE_ID.test(String(value.issuerReadbackId)));
  }
  return value.kind === "reconciliation_required" &&
    boundedText(value.reason, 3, 2000) &&
    SHA256.test(String(value.reconciliationReceiptSha256 ?? ""));
}

function validateReadbackInput(input: RecordAuthorityReadbackInput): void {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.readbackId) ||
      !OPAQUE_ID.test(input.authorityRecordId) ||
      !Number.isInteger(input.authorityVersion) || input.authorityVersion < 1 ||
      !boundedText(input.subjectType, 2, 120) ||
      !boundedText(input.subjectRole, 2, 200) ||
      !nullableBoundedText(input.personUser, 200) ||
      !nullableBoundedText(input.organization, 200) ||
      !boundedText(input.authorityKind, 2, 200) ||
      !boundedText(input.authorityScope, 2, 240) ||
      !boundedText(input.scopeType, 2, 120) ||
      !boundedText(input.scopeRef, 1, 240) ||
      !nullableBoundedText(input.roofJob, 200) ||
      !boundedText(input.scopeJson, 2, 20_000) ||
      !boundedText(input.issuerName, 2, 200) ||
      !boundedText(input.issuerJurisdiction, 2, 160) ||
      !boundedText(input.issuerReference, 3, 240) ||
      !boundedText(input.issuerSourceVersion, 1, 120) ||
      !isReadbackState(input.verificationState) ||
      !validEvidenceRefsJson(input.evidenceRefsJson) ||
      !SHA256.test(input.evidenceSha256) ||
      !SHA256.test(input.authorityStateDigestSha256) ||
      !USER_ID.test(input.observedByUserId) ||
      !ISO_INSTANT.test(input.observedAt) ||
      input.actionId !== null && !OPAQUE_ID.test(input.actionId)) {
    throw new Error("authority_record_readback_input_invalid");
  }
}

function validEvidenceRefsJson(value: string): boolean {
  if (typeof value !== "string" || value.length < 2 || value.length > 20_000) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) return false;
    return parsed.every((entry) => {
      if (!isRecord(entry)) return false;
      const ref = entry.ref;
      const sha256 = entry.sha256;
      if (typeof ref !== "string" || typeof sha256 !== "string" || !SHA256.test(sha256)) {
        return false;
      }
      return ref.trim().length >= 3 && ref.trim().length <= 512 &&
        !/[\u0000-\u001f]/.test(ref);
    });
  } catch {
    return false;
  }
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max &&
    !/[\u0000-\u001f]/.test(value);
}

function nullableBoundedText(value: unknown, max: number): value is string | null {
  return value === null || boundedText(value, 1, max);
}

function isReadbackState(value: unknown): value is AuthorityReadbackState {
  return value === "verified" || value === "revoked" || value === "contradictory" ||
    value === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}
