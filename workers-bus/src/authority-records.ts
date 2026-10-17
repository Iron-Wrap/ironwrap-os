import { sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import { isReservedEvidenceUploadReference } from "./evidence-upload-reference.ts";

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

export type AuthorityLifecycleDenial =
  | "authority_missing"
  | "authority_ambiguous"
  | "authority_revoked"
  | "authority_contradictory"
  | "authority_unavailable"
  | "authority_expired"
  | "authority_stale"
  | "authority_superseded"
  | "authority_scope_mismatch"
  | "authority_jurisdiction_mismatch"
  | "authority_unverifiable";

export interface AuthorityRequirement {
  authority_record_id?: string;
  subject_type: "Person" | "Organization";
  subject_role?: "Worker" | "Subcontractor";
  subject_ref: string;
  authority_kind:
    | "Worker Competency"
    | "Trade Licence"
    | "WCB Clearance"
    | "Insurance Certificate"
    | "Permit"
    | "Inspection"
    | "Manufacturer Certification"
    | "Manufacturer Bulletin";
  authority_scope?: string;
  scope_type:
    | "Tenant"
    | "Roof Job"
    | "Assignment"
    | "Work Package"
    | "Shop"
    | "Field"
    | "Trade"
    | "Manufacturer System";
  scope_ref: string;
  issuer_name?: string;
  issuer_jurisdiction?: string;
  issuer_reference?: string;
  source_version?: string;
  version?: number;
  state_digest_sha256?: string;
}

/**
 * Exact authority fact accepted for one frozen requirement. Commands carry
 * this bounded witness to D1 so the event trigger can prove that the same
 * lifecycle head is still current at append time.
 */
export interface AuthorityCurrentPrecondition {
  requirement: AuthorityRequirement;
  current: {
    readback_id: string;
    authority_record_id: string;
    authority_version: number;
    authority_state_digest_sha256: string;
    observation_fingerprint_sha256: string;
  };
}

export const EXTERNAL_ISSUER_AUTHORITY_KINDS = new Set([
  "Trade Licence",
  "WCB Clearance",
  "Insurance Certificate",
  "Permit",
  "Inspection",
  "Manufacturer Certification",
  "Manufacturer Bulletin",
]);

export const INTERNAL_AUTHORITY_VERIFICATION_METHODS = new Set([
  "Internal Competency Assessment",
]);

export const EXTERNAL_ISSUER_VERIFICATION_METHODS = new Set([
  "Issuer Portal Readback",
  "Signed Issuer Record",
  "Regulator Readback",
  "Manufacturer Portal Readback",
]);

export const AUTHORITY_VERIFICATION_METHODS = new Set([
  ...INTERNAL_AUTHORITY_VERIFICATION_METHODS,
  ...EXTERNAL_ISSUER_VERIFICATION_METHODS,
]);

const MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS = 32;
const MAX_AUTHORITY_REQUIREMENTS = 20;
const MAX_AUTHORITY_REQUIREMENTS_BYTES = 20_000;
const AUTHORITY_REQUIREMENT_KEYS = new Set([
  "authority_record_id",
  "subject_type",
  "subject_role",
  "subject_ref",
  "authority_kind",
  "authority_scope",
  "scope_type",
  "scope_ref",
  "issuer_name",
  "issuer_jurisdiction",
  "issuer_reference",
  "source_version",
  "version",
  "state_digest_sha256",
]);
const AUTHORITY_REQUIREMENT_KINDS = new Set<AuthorityRequirement["authority_kind"]>([
  "Worker Competency",
  "Trade Licence",
  "WCB Clearance",
  "Insurance Certificate",
  "Permit",
  "Inspection",
  "Manufacturer Certification",
  "Manufacturer Bulletin",
]);
const AUTHORITY_REQUIREMENT_SCOPE_TYPES = new Set<AuthorityRequirement["scope_type"]>([
  "Tenant",
  "Roof Job",
  "Assignment",
  "Work Package",
  "Shop",
  "Field",
  "Trade",
  "Manufacturer System",
]);

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
      issuerReadbackId: string;
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
  authority_state_digest_sha256: string;
  authority_effective_from: string | null;
  authority_expires_at: string | null;
  authority_revoked_at: string | null;
  supersedes_authority_record_id: string | null;
  authority_verification_method: string | null;
  issuer_receipt_sha256: string | null;
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
  authorityEffectiveFrom: string | null;
  authorityExpiresAt: string | null;
  authorityRevokedAt: string | null;
  supersedesAuthorityRecordId: string | null;
  authorityVerificationMethod: string | null;
  issuerReceiptSha256: string | null;
  observedByUserId: string;
  observedAt: string;
  actionId: string | null;
}

export interface AuthorityLifecycleExpectation {
  tenantId: string;
  now: string;
  readbackId?: string;
  authorityRecordId?: string;
  authorityVersion?: number;
  authorityStateDigestSha256?: string;
  subjectType?: string | null;
  subjectRole?: string | null;
  personUser?: string | null;
  organization?: string | null;
  authorityKind?: string | null;
  authorityScope?: string | null;
  scopeType?: string | null;
  scopeRef?: string | null;
  roofJob?: string | null;
  scopeJson?: string | null;
  issuerName?: string | null;
  issuerReference?: string | null;
  issuerSourceVersion?: string | null;
  issuerJurisdiction?: string | null;
}

export function parseAuthorityRequirements(value: unknown): AuthorityRequirement[] {
  let parsed = value;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_AUTHORITY_REQUIREMENTS_BYTES) {
      throw new Error("authority_requirements_invalid");
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("authority_requirements_invalid");
    }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_AUTHORITY_REQUIREMENTS) {
    throw new Error("authority_requirements_invalid");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(parsed);
  } catch {
    throw new Error("authority_requirements_invalid");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_AUTHORITY_REQUIREMENTS_BYTES) {
    throw new Error("authority_requirements_invalid");
  }
  return parsed.map((raw) => parseAuthorityRequirement(raw));
}

export interface AuthorityLifecycleVerdict {
  ok: boolean;
  code: null | AuthorityLifecycleDenial;
  current: AuthorityRecordReadback | null;
  requested: AuthorityRecordReadback | null;
}

export function authorityCurrentPrecondition(
  requirement: AuthorityRequirement,
  current: AuthorityRecordReadback,
): AuthorityCurrentPrecondition {
  return {
    requirement: parseAuthorityRequirements([requirement])[0]!,
    current: {
      readback_id: current.readback_id,
      authority_record_id: current.authority_record_id,
      authority_version: current.authority_version,
      authority_state_digest_sha256: current.authority_state_digest_sha256,
      observation_fingerprint_sha256: current.observation_fingerprint_sha256,
    },
  };
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,139}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function claimAuthorityRecordAction(
  env: AppEnv,
  input: ClaimAuthorityRecordActionInput,
): Promise<ClaimAuthorityRecordActionResult> {
  validateActionInput(input);
  const idempotencyHash = await sha256Hex(`${input.tenantId}\n${input.idempotencyKey}`);
  const existing = await authorityActionByIdempotency(env, input.tenantId, idempotencyHash);
  if (existing) {
    return authorityActionMatchesClaim(existing, input)
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
  return authorityActionMatchesClaim(raced, input)
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
  if (existing.actor_user_id !== input.actorUserId) {
    throw new Error("authority_record_business_actor_required");
  }
  if (existing.status !== "pending") return existing;
  if (existing.authority_record_id !== input.terminal.authorityRecordId) {
    throw new Error("authority_record_action_completion_identity_mismatch");
  }
  if (input.terminal.kind === "material_applied") {
    const explicitReadbackId = input.terminal.issuerReadbackId;
    if (!OPAQUE_ID.test(explicitReadbackId)) {
      throw new Error("authority_record_issuer_readback_required");
    }
    const readback = await authorityReadbackByIdentity(env, input.tenantId, explicitReadbackId);
    if (!readback || !terminalReadbackMatchesAction(existing, input.terminal, readback)) {
      throw new Error("authority_record_issuer_readback_required");
    }
    const gate = await validateTerminalReadbackForOperation(env, existing.operation, readback, {
      tenantId: input.tenantId,
      now: input.now,
      authorityRecordId: existing.authority_record_id,
      authorityVersion: existing.expected_version ?? undefined,
      authorityStateDigestSha256: input.terminal.authorityStateDigestSha256,
    });
    if (!gate) {
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
        issuer_readback_id: input.terminal.issuerReadbackId,
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
    authority_effective_from: input.authorityEffectiveFrom,
    authority_expires_at: input.authorityExpiresAt,
    authority_revoked_at: input.authorityRevokedAt,
    supersedes_authority_record_id: input.supersedesAuthorityRecordId,
    authority_verification_method: input.authorityVerificationMethod,
    issuer_receipt_sha256: input.issuerReceiptSha256,
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
        authority_state_digest_sha256, authority_effective_from, authority_expires_at,
        authority_revoked_at, supersedes_authority_record_id, authority_verification_method,
        issuer_receipt_sha256,
        observed_by_user_id, observed_at,
        observation_fingerprint_sha256, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.authorityEffectiveFrom,
    input.authorityExpiresAt,
    input.authorityRevokedAt,
    input.supersedesAuthorityRecordId,
    input.authorityVerificationMethod,
    input.issuerReceiptSha256,
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
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND authority_record_id = ?
      ORDER BY authority_version DESC, observed_at DESC
      LIMIT ?`,
  ).bind(tenantId, authorityRecordId, boundedLimit).all<AuthorityRecordReadback>();
  return rows.results;
}

/** What the desk shows for one record: the head the fence would pick, and the fence's own verdict.
 *  The verdict is computed here, on the server, so no screen can invent a second answer. */
export type AuthorityVerdict =
  | "clear"
  | "expiring"
  | "expired"
  | "revoked"
  | "unknown"
  | "contradictory";

export interface AuthorityHeadView {
  authority_record_id: string;
  authority_version: number;
  authority_kind: string | null;
  authority_scope: string | null;
  scope_type: string | null;
  scope_ref: string | null;
  issuer_name: string;
  issuer_jurisdiction: string;
  verification_state: AuthorityReadbackState;
  authority_effective_from: string | null;
  authority_expires_at: string | null;
  authority_revoked_at: string | null;
  observed_at: string;
  verdict: AuthorityVerdict;
  denial_code: AuthorityLifecycleDenial | null;
  days_left: number | null;
}

export interface AuthoritySubjectView {
  subject_key: string;
  subject_type: string | null;
  subject_role: string | null;
  person_user: string | null;
  organization: string | null;
  records: AuthorityHeadView[];
}

/** Rows a single tenant desk may hold. Beyond this the desk is the wrong surface. */
const MAX_AUTHORITY_DESK_ROWS = 2000;
/** A ticket inside this many days is worth acting on before it stops work. */
export const AUTHORITY_EXPIRING_DAYS = 30;

function daysBetween(fromIso: string, toDate: string): number | null {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function verdictFor(
  row: AuthorityRecordReadback,
  denial: AuthorityLifecycleDenial | null,
  today: string,
): { verdict: AuthorityVerdict; daysLeft: number | null } {
  const daysLeft = row.authority_expires_at ? daysBetween(today, row.authority_expires_at) : null;
  if (denial === "authority_revoked") return { verdict: "revoked", daysLeft };
  if (denial === "authority_expired") return { verdict: "expired", daysLeft };
  if (denial === "authority_contradictory") return { verdict: "contradictory", daysLeft };
  if (denial) return { verdict: "unknown", daysLeft };
  if (daysLeft !== null && daysLeft <= AUTHORITY_EXPIRING_DAYS) return { verdict: "expiring", daysLeft };
  return { verdict: "clear", daysLeft };
}

function subjectKeyOf(row: AuthorityRecordReadback): string {
  return [row.subject_type ?? "", row.subject_role ?? "", row.person_user ?? "", row.organization ?? ""].join("|");
}

/** Every current authority head this tenant holds, grouped by whom it is about.
 *
 *  It reuses `currentAuthorityHeads` and `lifecycleDenialForRow`, which are the same two rules the
 *  fence applies when it stops work, so the desk cannot disagree with the fence. A record whose
 *  heads contradict each other is reported as contradictory rather than resolved to one of them. */
export async function listCurrentAuthorityHeads(
  env: AppEnv,
  tenantId: string,
  now: string,
): Promise<AuthoritySubjectView[]> {
  if (!TENANT_ID.test(tenantId) || !ISO_INSTANT.test(now)) return [];
  const today = now.slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ?
      ORDER BY authority_record_id ASC, authority_version DESC, observed_at DESC
      LIMIT ?`,
  ).bind(tenantId, MAX_AUTHORITY_DESK_ROWS).all<AuthorityRecordReadback>();

  const byRecord = new Map<string, AuthorityRecordReadback[]>();
  for (const row of rows.results) {
    const peers = byRecord.get(row.authority_record_id) ?? [];
    peers.push(row);
    byRecord.set(row.authority_record_id, peers);
  }

  const bySubject = new Map<string, AuthoritySubjectView>();
  for (const peers of byRecord.values()) {
    const heads = currentAuthorityHeads(peers);
    // A contradictory record has no single head, so it is reported from its newest row rather
    // than dropped: an operator who cannot see it cannot resolve it.
    const shown = heads.rows.length > 0 ? heads.rows : peers.slice(0, 1);
    for (const row of shown) {
      const denial = heads.code ?? lifecycleDenialForRow(row, { tenantId, now });
      const { verdict, daysLeft } = verdictFor(row, denial, today);
      const key = subjectKeyOf(row);
      const subject = bySubject.get(key) ?? {
        subject_key: key,
        subject_type: row.subject_type,
        subject_role: row.subject_role,
        person_user: row.person_user,
        organization: row.organization,
        records: [],
      };
      subject.records.push({
        authority_record_id: row.authority_record_id,
        authority_version: row.authority_version,
        authority_kind: row.authority_kind,
        authority_scope: row.authority_scope,
        scope_type: row.scope_type,
        scope_ref: row.scope_ref,
        issuer_name: row.issuer_name,
        issuer_jurisdiction: row.issuer_jurisdiction,
        verification_state: row.verification_state,
        authority_effective_from: row.authority_effective_from,
        authority_expires_at: row.authority_expires_at,
        authority_revoked_at: row.authority_revoked_at,
        observed_at: row.observed_at,
        verdict,
        denial_code: denial,
        days_left: daysLeft,
      });
      bySubject.set(key, subject);
    }
  }

  const rank: Record<AuthorityVerdict, number> = {
    revoked: 0, expired: 1, contradictory: 2, unknown: 3, expiring: 4, clear: 5,
  };
  const worst = (s: AuthoritySubjectView) => Math.min(...s.records.map((r) => rank[r.verdict]));
  for (const subject of bySubject.values()) {
    subject.records.sort((a, b) => rank[a.verdict] - rank[b.verdict] ||
      (a.authority_kind ?? "").localeCompare(b.authority_kind ?? ""));
  }
  return [...bySubject.values()].sort((a, b) => worst(a) - worst(b) ||
    (a.person_user ?? a.organization ?? "").localeCompare(b.person_user ?? b.organization ?? ""));
}

export async function resolveAuthorityLifecycle(
  env: AppEnv,
  input: AuthorityLifecycleExpectation,
): Promise<AuthorityLifecycleVerdict> {
  validateLifecycleExpectation(input);
  const requested = input.readbackId
    ? await authorityReadbackByIdentity(env, input.tenantId, input.readbackId)
    : null;
  if (input.readbackId && !requested) {
    return { ok: false, code: "authority_missing", current: null, requested: null };
  }
  const bindingSource = requested ?? lifecycleBindingFromExpectation(input);
  if (!bindingSource) {
    return { ok: false, code: "authority_missing", current: null, requested };
  }
  const roots = await authorityReadbacksByBinding(env, input.tenantId, bindingSource);
  if (roots.length === 0) {
    return { ok: false, code: "authority_missing", current: null, requested };
  }
  const candidates = await authorityReadbackLineage(env, input.tenantId, roots);
  if (candidates.overflow) {
    return { ok: false, code: "authority_ambiguous", current: null, requested };
  }
  const currentHeads = currentAuthorityHeads(candidates.rows);
  if (currentHeads.code) {
    return { ok: false, code: currentHeads.code, current: null, requested };
  }
  if (currentHeads.rows.length !== 1) {
    return { ok: false, code: "authority_ambiguous", current: null, requested };
  }
  const current = currentHeads.rows[0] ?? null;
  if (!current) {
    return { ok: false, code: "authority_missing", current: null, requested };
  }
  const currentDenial = lifecycleDenialForRow(current, input);
  if (currentDenial) {
    return { ok: false, code: currentDenial, current, requested };
  }
  const target = requested ?? current;
  if (requested && requested.readback_id !== current.readback_id) {
    return {
      ok: false,
      code:
        current.authority_record_id !== requested.authority_record_id ||
          current.authority_version > requested.authority_version
          ? "authority_superseded"
          : "authority_stale",
      current,
      requested,
    };
  }
  const denial = lifecycleDenialForRow(target, input);
  return denial
    ? { ok: false, code: denial, current, requested: target }
    : { ok: true, code: null, current, requested: target };
}

export async function currentAuthorityReadback(
  env: AppEnv,
  input: AuthorityLifecycleExpectation,
): Promise<AuthorityRecordReadback | null> {
  const verdict = await resolveAuthorityLifecycle(env, input);
  return verdict.ok ? verdict.current : null;
}

export async function resolveAuthorityRequirement(
  env: AppEnv,
  input: {
    tenantId: string;
    now: string;
    requirement: AuthorityRequirement;
  },
): Promise<AuthorityLifecycleVerdict> {
  const requirement = parseAuthorityRequirements([input.requirement])[0]!;
  validateLifecycleExpectation({ tenantId: input.tenantId, now: input.now });
  const roots = await authorityReadbacksByRequirement(
    env,
    input.tenantId,
    requirement,
  );
  if (roots.length === 0) {
    return { ok: false, code: "authority_missing", current: null, requested: null };
  }
  if (roots.length > MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS) {
    return { ok: false, code: "authority_ambiguous", current: null, requested: null };
  }

  const latestByRecord = new Map<string, AuthorityRecordReadback>();
  for (const root of roots) {
    if (!latestByRecord.has(root.authority_record_id)) {
      latestByRecord.set(root.authority_record_id, root);
    }
  }
  const expectation: AuthorityLifecycleExpectation = {
    tenantId: input.tenantId,
    now: input.now,
    subjectType: requirement.subject_type,
    subjectRole: requirement.subject_role,
    ...(requirement.subject_type === "Person"
      ? { personUser: requirement.subject_ref }
      : { organization: requirement.subject_ref }),
    authorityKind: requirement.authority_kind,
    authorityScope: requirement.authority_scope,
    scopeType: requirement.scope_type,
    scopeRef: requirement.scope_ref,
    issuerName: requirement.issuer_name,
    issuerReference: requirement.issuer_reference,
    issuerSourceVersion: requirement.source_version,
    issuerJurisdiction: requirement.issuer_jurisdiction,
  };
  const verdicts: AuthorityLifecycleVerdict[] = [];
  for (const root of latestByRecord.values()) {
    verdicts.push(
      await resolveAuthorityLifecycle(env, {
        ...expectation,
        readbackId: root.readback_id,
      }),
    );
  }
  const currentByReadback = new Map<string, AuthorityRecordReadback>();
  for (const verdict of verdicts) {
    if (verdict.current) currentByReadback.set(verdict.current.readback_id, verdict.current);
  }
  if (currentByReadback.size !== 1) {
    return currentByReadback.size > 1
      ? { ok: false, code: "authority_ambiguous", current: null, requested: null }
      : {
          ok: false,
          code: preferredAuthorityDenial(verdicts) ?? "authority_missing",
          current: null,
          requested: verdicts[0]?.requested ?? null,
        };
  }
  const current = currentByReadback.values().next().value!;
  const requested = verdicts.find(
    (verdict) => verdict.current?.readback_id === current.readback_id,
  )?.requested ?? null;
  const accepted = verdicts.find(
    (verdict) => verdict.ok && verdict.current?.readback_id === current.readback_id,
  );
  if (!accepted) {
    return {
      ok: false,
      code: preferredAuthorityDenial(verdicts) ?? "authority_unverifiable",
      current,
      requested,
    };
  }
  if (
    requirement.authority_record_id &&
    current.authority_record_id !== requirement.authority_record_id
  ) {
    return { ok: false, code: "authority_superseded", current, requested };
  }
  if (requirement.version !== undefined && current.authority_version !== requirement.version) {
    return { ok: false, code: "authority_stale", current, requested };
  }
  if (
    requirement.state_digest_sha256 &&
    current.authority_state_digest_sha256 !== requirement.state_digest_sha256
  ) {
    return { ok: false, code: "authority_unverifiable", current, requested };
  }
  return accepted;
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
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
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
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND authority_record_id = ?
        AND authority_version = ? AND evidence_sha256 = ?
      LIMIT 1`,
  ).bind(tenantId, authorityRecordId, authorityVersion, evidenceSha256).first<AuthorityRecordReadback>();
}

async function authorityReadbacksByRequirement(
  env: AppEnv,
  tenantId: string,
  requirement: AuthorityRequirement,
): Promise<AuthorityRecordReadback[]> {
  const subjectColumn = requirement.subject_type === "Person" ? "person_user" : "organization";
  const authorityRecordClause = requirement.authority_record_id
    ? "AND authority_record_id = ?"
    : "";
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ?
        AND subject_type = ?
        AND ${subjectColumn} = ?
        AND authority_kind = ?
        AND scope_type = ?
        AND scope_ref = ?
        ${authorityRecordClause}
      ORDER BY authority_record_id ASC, authority_version DESC, observed_at DESC, readback_id DESC
      LIMIT ?`,
  ).bind(
    tenantId,
    requirement.subject_type,
    requirement.subject_ref,
    requirement.authority_kind,
    requirement.scope_type,
    requirement.scope_ref,
    ...(requirement.authority_record_id ? [requirement.authority_record_id] : []),
    MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS + 1,
  ).all<AuthorityRecordReadback>();
  return rows.results;
}

async function authorityReadbacksByBinding(
  env: AppEnv,
  tenantId: string,
  binding: Pick<
    AuthorityRecordReadback,
    | "subject_type"
    | "subject_role"
    | "person_user"
    | "organization"
    | "authority_kind"
    | "authority_scope"
    | "scope_type"
    | "scope_ref"
    | "roof_job"
    | "scope_json"
    | "issuer_reference"
    | "issuer_source_version"
    | "issuer_jurisdiction"
  >,
): Promise<AuthorityRecordReadback[]> {
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ?
        AND ((subject_type IS NULL AND ? IS NULL) OR subject_type = ?)
        AND ((subject_role IS NULL AND ? IS NULL) OR subject_role = ?)
        AND ((person_user IS NULL AND ? IS NULL) OR person_user = ?)
        AND ((organization IS NULL AND ? IS NULL) OR organization = ?)
        AND ((authority_kind IS NULL AND ? IS NULL) OR authority_kind = ?)
        AND ((authority_scope IS NULL AND ? IS NULL) OR authority_scope = ?)
        AND ((scope_type IS NULL AND ? IS NULL) OR scope_type = ?)
        AND ((scope_ref IS NULL AND ? IS NULL) OR scope_ref = ?)
        AND ((roof_job IS NULL AND ? IS NULL) OR roof_job = ?)
        AND ((scope_json IS NULL AND ? IS NULL) OR scope_json = ?)
        AND issuer_reference = ?
        AND issuer_source_version = ?
        AND issuer_jurisdiction = ?
      ORDER BY authority_record_id ASC, authority_version DESC, observed_at DESC, readback_id DESC
      LIMIT ?`,
  ).bind(
    tenantId,
    binding.subject_type, binding.subject_type,
    binding.subject_role, binding.subject_role,
    binding.person_user, binding.person_user,
    binding.organization, binding.organization,
    binding.authority_kind, binding.authority_kind,
    binding.authority_scope, binding.authority_scope,
    binding.scope_type, binding.scope_type,
    binding.scope_ref, binding.scope_ref,
    binding.roof_job, binding.roof_job,
    binding.scope_json, binding.scope_json,
    binding.issuer_reference,
    binding.issuer_source_version,
    binding.issuer_jurisdiction,
    MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS + 1,
  ).all<AuthorityRecordReadback>();
  return rows.results;
}

async function authorityReadbacksBySupersedes(
  env: AppEnv,
  tenantId: string,
  supersedesAuthorityRecordId: string,
): Promise<AuthorityRecordReadback[]> {
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND supersedes_authority_record_id = ?
      ORDER BY authority_record_id ASC, authority_version DESC, observed_at DESC, readback_id DESC
      LIMIT ?`,
  ).bind(
    tenantId,
    supersedesAuthorityRecordId,
    MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS + 1,
  ).all<AuthorityRecordReadback>();
  return rows.results;
}

async function authorityReadbacksByAuthorityRecord(
  env: AppEnv,
  tenantId: string,
  authorityRecordId: string,
): Promise<AuthorityRecordReadback[]> {
  const rows = await env.DB.prepare(
    `SELECT readback_id, tenant_id, authority_record_id, authority_version,
            subject_type, subject_role, person_user, organization, authority_kind,
            authority_scope, scope_type, scope_ref, roof_job, scope_json,
            issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
            verification_state, evidence_refs_json, evidence_sha256, authority_state_digest_sha256,
            authority_effective_from, authority_expires_at, authority_revoked_at,
            supersedes_authority_record_id, authority_verification_method, issuer_receipt_sha256,
            observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id
       FROM authority_record_readbacks
      WHERE tenant_id = ? AND authority_record_id = ?
      ORDER BY authority_version DESC, observed_at DESC, readback_id DESC
      LIMIT ?`,
  ).bind(
    tenantId,
    authorityRecordId,
    MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS + 1,
  ).all<AuthorityRecordReadback>();
  return rows.results;
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
      OPAQUE_ID.test(String(value.issuerReadbackId ?? ""));
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
      !nullableDate(input.authorityEffectiveFrom) ||
      !nullableDate(input.authorityExpiresAt) ||
      !nullableInstant(input.authorityRevokedAt) ||
      input.supersedesAuthorityRecordId !== null && !OPAQUE_ID.test(input.supersedesAuthorityRecordId) ||
      input.authorityVerificationMethod !== null &&
        !boundedText(input.authorityVerificationMethod, 2, 200) ||
      input.issuerReceiptSha256 !== null && !SHA256.test(input.issuerReceiptSha256) ||
      !USER_ID.test(input.observedByUserId) ||
      !ISO_INSTANT.test(input.observedAt) ||
      input.actionId !== null && !OPAQUE_ID.test(input.actionId)) {
    throw new Error("authority_record_readback_input_invalid");
  }
}

function validateLifecycleExpectation(input: AuthorityLifecycleExpectation): void {
  if (!TENANT_ID.test(input.tenantId) || !ISO_INSTANT.test(input.now) ||
      input.readbackId !== undefined && !OPAQUE_ID.test(input.readbackId) ||
      input.authorityRecordId !== undefined && !OPAQUE_ID.test(input.authorityRecordId) ||
      input.authorityVersion !== undefined &&
        (!Number.isInteger(input.authorityVersion) || input.authorityVersion < 1) ||
      input.authorityStateDigestSha256 !== undefined && !SHA256.test(input.authorityStateDigestSha256) ||
      input.subjectType !== undefined && !nullableBoundedText(input.subjectType, 120) ||
      input.subjectRole !== undefined && !nullableBoundedText(input.subjectRole, 200) ||
      input.personUser !== undefined && !nullableBoundedText(input.personUser, 200) ||
      input.organization !== undefined && !nullableBoundedText(input.organization, 200) ||
      input.authorityKind !== undefined && !nullableBoundedText(input.authorityKind, 200) ||
      input.authorityScope !== undefined && !nullableBoundedText(input.authorityScope, 240) ||
      input.scopeType !== undefined && !nullableBoundedText(input.scopeType, 120) ||
      input.scopeRef !== undefined && !nullableBoundedText(input.scopeRef, 240) ||
      input.roofJob !== undefined && !nullableBoundedText(input.roofJob, 200) ||
      input.scopeJson !== undefined && !nullableBoundedText(input.scopeJson, 20_000) ||
      input.issuerName !== undefined && !nullableBoundedText(input.issuerName, 200) ||
      input.issuerReference !== undefined && !nullableBoundedText(input.issuerReference, 240) ||
      input.issuerSourceVersion !== undefined && !nullableBoundedText(input.issuerSourceVersion, 120) ||
      input.issuerJurisdiction !== undefined && !nullableBoundedText(input.issuerJurisdiction, 160)) {
    throw new Error("authority_record_lifecycle_input_invalid");
  }
}

function parseAuthorityRequirement(value: unknown): AuthorityRequirement {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !AUTHORITY_REQUIREMENT_KEYS.has(key))
  ) {
    throw new Error("authority_requirements_invalid");
  }
  const subjectType = requirementText(value.subject_type, 1, 120);
  const subjectRef = requirementText(value.subject_ref, 1, 140);
  const authorityKind = requirementText(value.authority_kind, 1, 200);
  const scopeType = requirementText(value.scope_type, 1, 120);
  const scopeRef = requirementText(value.scope_ref, 1, 140);
  if (
    (subjectType !== "Person" && subjectType !== "Organization") ||
    !AUTHORITY_REQUIREMENT_KINDS.has(authorityKind as AuthorityRequirement["authority_kind"]) ||
    !AUTHORITY_REQUIREMENT_SCOPE_TYPES.has(scopeType as AuthorityRequirement["scope_type"])
  ) {
    throw new Error("authority_requirements_invalid");
  }
  const subjectRole = optionalRequirementText(value, "subject_role", 1, 200);
  if (subjectRole !== undefined && subjectRole !== "Worker" && subjectRole !== "Subcontractor") {
    throw new Error("authority_requirements_invalid");
  }
  const authorityRecordId = optionalRequirementText(value, "authority_record_id", 3, 140);
  if (authorityRecordId !== undefined && !OPAQUE_ID.test(authorityRecordId)) {
    throw new Error("authority_requirements_invalid");
  }
  const version = Object.hasOwn(value, "version") ? value.version : undefined;
  if (
    version !== undefined &&
    (!Number.isInteger(version) || Number(version) < 1 || Number(version) > 1_000_000)
  ) {
    throw new Error("authority_requirements_invalid");
  }
  const stateDigest = optionalRequirementText(value, "state_digest_sha256", 64, 64)?.toLowerCase();
  if (stateDigest !== undefined && !SHA256.test(stateDigest)) {
    throw new Error("authority_requirements_invalid");
  }
  return {
    subject_type: subjectType,
    subject_ref: subjectRef,
    authority_kind: authorityKind as AuthorityRequirement["authority_kind"],
    scope_type: scopeType as AuthorityRequirement["scope_type"],
    scope_ref: scopeRef,
    ...(authorityRecordId === undefined ? {} : { authority_record_id: authorityRecordId }),
    ...(subjectRole === undefined ? {} : { subject_role: subjectRole }),
    ...optionalRequirementField(value, "authority_scope", 1, 240),
    ...optionalRequirementField(value, "issuer_name", 2, 200),
    ...optionalRequirementField(value, "issuer_jurisdiction", 2, 160),
    ...optionalRequirementField(value, "issuer_reference", 3, 240),
    ...optionalRequirementField(value, "source_version", 1, 120),
    ...(version === undefined ? {} : { version: Number(version) }),
    ...(stateDigest === undefined ? {} : { state_digest_sha256: stateDigest }),
  };
}

function optionalRequirementField<K extends keyof AuthorityRequirement>(
  value: Record<string, unknown>,
  key: K,
  min: number,
  max: number,
): Partial<Pick<AuthorityRequirement, K>> {
  const parsed = optionalRequirementText(value, key, min, max);
  return parsed === undefined ? {} : { [key]: parsed } as Partial<Pick<AuthorityRequirement, K>>;
}

function optionalRequirementText(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string | undefined {
  return Object.hasOwn(value, key)
    ? requirementText(value[key], min, max)
    : undefined;
}

function requirementText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw new Error("authority_requirements_invalid");
  const parsed = value.trim();
  if (
    parsed.length < min ||
    parsed.length > max ||
    /[\u0000-\u001f]/.test(parsed)
  ) {
    throw new Error("authority_requirements_invalid");
  }
  return parsed;
}

function preferredAuthorityDenial(
  verdicts: AuthorityLifecycleVerdict[],
): AuthorityLifecycleDenial | null {
  const codes = new Set(verdicts.map((verdict) => verdict.code).filter((code) => code !== null));
  for (const code of [
    "authority_ambiguous",
    "authority_contradictory",
    "authority_revoked",
    "authority_unavailable",
    "authority_expired",
    "authority_jurisdiction_mismatch",
    "authority_scope_mismatch",
    "authority_unverifiable",
    "authority_superseded",
    "authority_stale",
    "authority_missing",
  ] as const) {
    if (codes.has(code)) return code;
  }
  return null;
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
        !isReservedEvidenceUploadReference(ref) &&
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

function nullableDate(value: unknown): value is string | null {
  return value === null || typeof value === "string" && validIsoDate(value);
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || typeof value === "string" && validIsoInstant(value);
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

function lifecycleBindingFromExpectation(
  input: AuthorityLifecycleExpectation,
): Pick<
  AuthorityRecordReadback,
  | "subject_type"
  | "subject_role"
  | "person_user"
  | "organization"
  | "authority_kind"
  | "authority_scope"
  | "scope_type"
  | "scope_ref"
  | "roof_job"
  | "scope_json"
  | "issuer_reference"
  | "issuer_source_version"
  | "issuer_jurisdiction"
> | null {
  if (
    input.subjectType === undefined ||
    input.subjectRole === undefined ||
    input.authorityKind === undefined ||
    input.authorityScope === undefined ||
    input.scopeType === undefined ||
    input.scopeRef === undefined ||
    input.scopeJson === undefined ||
    input.issuerReference === undefined ||
    input.issuerReference === null ||
    input.issuerSourceVersion === undefined ||
    input.issuerSourceVersion === null ||
    input.issuerJurisdiction === undefined ||
    input.issuerJurisdiction === null
  ) {
    return null;
  }
  return {
    subject_type: input.subjectType,
    subject_role: input.subjectRole,
    person_user: input.personUser ?? null,
    organization: input.organization ?? null,
    authority_kind: input.authorityKind,
    authority_scope: input.authorityScope,
    scope_type: input.scopeType,
    scope_ref: input.scopeRef,
    roof_job: input.roofJob ?? null,
    scope_json: input.scopeJson,
    issuer_reference: input.issuerReference,
    issuer_source_version: input.issuerSourceVersion,
    issuer_jurisdiction: input.issuerJurisdiction,
  };
}

export function currentAuthorityHeads(
  rows: AuthorityRecordReadback[],
): { rows: AuthorityRecordReadback[]; code: AuthorityLifecycleDenial | null } {
  const currentByAuthorityRecord = new Map<string, AuthorityRecordReadback>();
  const rowsByAuthorityRecord = new Map<string, AuthorityRecordReadback[]>();
  for (const row of rows) {
    const peers = rowsByAuthorityRecord.get(row.authority_record_id) ?? [];
    peers.push(row);
    rowsByAuthorityRecord.set(row.authority_record_id, peers);
  }
  for (const peers of rowsByAuthorityRecord.values()) {
    const maxVersion = Math.max(...peers.map((peer) => peer.authority_version));
    const peerMaxVersion = peers.filter((peer) => peer.authority_version === maxVersion);
    const peerDigests = new Set(peerMaxVersion.map((peer) => peer.authority_state_digest_sha256));
    if (peerDigests.size > 1) {
      return { rows: [], code: "authority_contradictory" };
    }
    const current = peerMaxVersion.reduce<AuthorityRecordReadback | null>(
      (best, peer) => !best || compareAuthorityRecency(peer, best) > 0 ? peer : best,
      null,
    );
    if (current) {
      currentByAuthorityRecord.set(current.authority_record_id, current);
    }
  }
  const currentRows = [...currentByAuthorityRecord.values()];
  return {
    rows: currentRows.filter((candidate) => !currentRows.some((other) =>
      other.readback_id !== candidate.readback_id &&
      other.supersedes_authority_record_id === candidate.authority_record_id
    )),
    code: null,
  };
}

async function authorityReadbackLineage(
  env: AppEnv,
  tenantId: string,
  roots: AuthorityRecordReadback[],
): Promise<{ rows: AuthorityRecordReadback[]; overflow: boolean }> {
  const byReadback = new Map<string, AuthorityRecordReadback>();
  const visitedAuthorityRecords = new Set<string>();
  const queue: AuthorityRecordReadback[] = [];
  const overflowed = () => byReadback.size > MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS;
  for (const row of roots) {
    byReadback.set(row.readback_id, row);
    queue.push(row);
  }
  if (overflowed()) return { rows: [], overflow: true };
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (!visitedAuthorityRecords.has(row.authority_record_id)) {
      visitedAuthorityRecords.add(row.authority_record_id);
      const peers = await authorityReadbacksByAuthorityRecord(env, tenantId, row.authority_record_id);
      for (const peer of peers) {
        if (!byReadback.has(peer.readback_id)) {
          byReadback.set(peer.readback_id, peer);
          queue.push(peer);
          if (overflowed()) return { rows: [], overflow: true };
        }
      }
      const descendants = await authorityReadbacksBySupersedes(env, tenantId, row.authority_record_id);
      for (const descendant of descendants) {
        if (!byReadback.has(descendant.readback_id)) {
          byReadback.set(descendant.readback_id, descendant);
          queue.push(descendant);
          if (overflowed()) return { rows: [], overflow: true };
        }
      }
    }
    if (row.supersedes_authority_record_id) {
      const ancestors = await authorityReadbacksByAuthorityRecord(
        env,
        tenantId,
        row.supersedes_authority_record_id,
      );
      for (const ancestor of ancestors) {
        if (!byReadback.has(ancestor.readback_id)) {
          byReadback.set(ancestor.readback_id, ancestor);
          queue.push(ancestor);
          if (overflowed()) return { rows: [], overflow: true };
        }
      }
    }
  }
  return { rows: [...byReadback.values()], overflow: false };
}

function sameAuthorityRecord(left: AuthorityRecordReadback, right: AuthorityRecordReadback): boolean {
  return left.authority_record_id === right.authority_record_id;
}

function compareAuthorityRecency(left: AuthorityRecordReadback, right: AuthorityRecordReadback): number {
  return (
    left.authority_version - right.authority_version ||
    left.observed_at.localeCompare(right.observed_at) ||
    left.readback_id.localeCompare(right.readback_id)
  );
}

async function validateTerminalReadbackForOperation(
  env: AppEnv,
  operation: AuthorityRecordOperation,
  readback: AuthorityRecordReadback,
  expectation: AuthorityLifecycleExpectation,
): Promise<boolean> {
  switch (operation) {
    case "record":
      return readback.verification_state === "unavailable";
    case "revoke":
      return readback.verification_state === "revoked" &&
        (!issuerEvidenceRequired(readback) || !!readback.issuer_receipt_sha256);
    case "verify":
    case "renew":
    case "supersede":
    case "resolve_exception": {
      if (readback.verification_state !== "verified") return false;
      const lifecycle = await resolveAuthorityLifecycle(env, {
        ...expectation,
        readbackId: readback.readback_id,
      });
      return lifecycle.ok;
    }
  }
}

function terminalReadbackMatchesAction(
  action: AuthorityRecordAction,
  terminal: Extract<AuthorityRecordTerminalReceipt, { kind: "material_applied" }>,
  readback: AuthorityRecordReadback,
): boolean {
  return readback.action_id === action.action_id &&
    readback.authority_record_id === action.authority_record_id &&
    readback.authority_version === terminal.authorityVersion &&
    readback.authority_state_digest_sha256 === terminal.authorityStateDigestSha256 &&
    (action.expected_version === null || readback.authority_version === action.expected_version);
}

function authorityActionMatchesClaim(
  action: AuthorityRecordAction,
  input: ClaimAuthorityRecordActionInput,
): boolean {
  return action.action_id === input.actionId &&
    action.actor_user_id === input.actorUserId &&
    action.request_fingerprint_sha256 === input.requestFingerprintSha256 &&
    action.authority_record_id === input.authorityRecordId &&
    action.operation === input.operation &&
    action.expected_version === input.expectedVersion;
}

export function lifecycleDenialForRow(
  row: AuthorityRecordReadback,
  input: AuthorityLifecycleExpectation,
): AuthorityLifecycleDenial | null {
  if (input.authorityRecordId && row.authority_record_id !== input.authorityRecordId) {
    return "authority_scope_mismatch";
  }
  if (input.authorityVersion && row.authority_version !== input.authorityVersion) {
    return "authority_scope_mismatch";
  }
  if (input.authorityStateDigestSha256 &&
      row.authority_state_digest_sha256 !== input.authorityStateDigestSha256) {
    return "authority_unverifiable";
  }
  if (input.issuerJurisdiction && row.issuer_jurisdiction !== input.issuerJurisdiction) {
    return "authority_jurisdiction_mismatch";
  }
  if (bindingMismatch(row, input)) return "authority_scope_mismatch";
  const stateDenial = verificationStateDenial(row);
  if (stateDenial) return stateDenial;
  if (!row.authority_effective_from || !row.authority_expires_at) {
    return "authority_stale";
  }
  if (provenanceDenied(row)) {
    return "authority_unverifiable";
  }
  const today = input.now.slice(0, 10);
  if (row.authority_effective_from > today) {
    return "authority_stale";
  }
  if (row.authority_expires_at < today) {
    return "authority_expired";
  }
  return null;
}

function bindingMismatch(
  row: AuthorityRecordReadback,
  input: AuthorityLifecycleExpectation,
): boolean {
  return (
    fieldMismatch(row.subject_type, input.subjectType) ||
    fieldMismatch(row.subject_role, input.subjectRole) ||
    fieldMismatch(row.person_user, input.personUser) ||
    fieldMismatch(row.organization, input.organization) ||
    fieldMismatch(row.authority_kind, input.authorityKind) ||
    fieldMismatch(row.authority_scope, input.authorityScope) ||
    fieldMismatch(row.scope_type, input.scopeType) ||
    fieldMismatch(row.scope_ref, input.scopeRef) ||
    fieldMismatch(row.roof_job, input.roofJob) ||
    fieldMismatch(row.scope_json, input.scopeJson) ||
    fieldMismatch(row.issuer_name, input.issuerName) ||
    fieldMismatch(row.issuer_reference, input.issuerReference) ||
    fieldMismatch(row.issuer_source_version, input.issuerSourceVersion)
  );
}

function fieldMismatch(current: string | null, expected: string | null | undefined): boolean {
  return expected !== undefined && current !== expected;
}

function verificationStateDenial(row: AuthorityRecordReadback): AuthorityLifecycleDenial | null {
  if (row.authority_revoked_at) return "authority_revoked";
  switch (row.verification_state) {
    case "verified":
      return null;
    case "revoked":
      return "authority_revoked";
    case "contradictory":
      return "authority_contradictory";
    case "unavailable":
      return "authority_unavailable";
  }
}

function provenanceDenied(row: AuthorityRecordReadback): boolean {
  const method = row.authority_verification_method?.trim() ?? "";
  if (!method) return true;
  if (row.authority_kind !== null && EXTERNAL_ISSUER_AUTHORITY_KINDS.has(row.authority_kind)) {
    return !row.issuer_receipt_sha256 || !EXTERNAL_ISSUER_VERIFICATION_METHODS.has(method);
  }
  return !INTERNAL_AUTHORITY_VERIFICATION_METHODS.has(method);
}

function issuerEvidenceRequired(row: AuthorityRecordReadback): boolean {
  return row.authority_kind !== null && EXTERNAL_ISSUER_AUTHORITY_KINDS.has(row.authority_kind);
}

function validIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validIsoInstant(value: string): boolean {
  if (!ISO_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = value.includes(".")
    ? parsed.toISOString()
    : parsed.toISOString().replace(".000Z", "Z");
  return canonical === value;
}
