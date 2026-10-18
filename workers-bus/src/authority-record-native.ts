// The Worker-native executor for internal worker competency records (the catalog's
// `authority.record`). A person approves every command; the Worker then writes the new version in
// one D1 batch together with its claim, its completion and an owned-store readback. Frappe is never
// called, and a natively recorded version has no Frappe projection.
//
// Only a Worker Competency verified by an Internal Competency Assessment is recorded here. Every
// external issuer kind keeps the issuer rail (authority-record-executor-api.ts): nothing inside
// IronWrap can create external authority.
//
// Record, verify and revoke each append version head + 1 superseding the identity's current head
// (tenant, person, kind and scope), so no version is ever edited in place. The batch re-checks
// that the head is still the one the command expected, and that the approver may still approve
// and is not the worker the record is about.

import { sha256Hex } from "./app-auth.ts";
import { appUserIdentities, ROLE_PERMISSIONS, type AppEnv, type AppRole } from "./app-types.ts";
import {
  authorityIdempotencyHash,
  authorityReadbackFingerprint,
  authorityReadbackInsert,
  authorityReadbacksByRequirement,
  authorityReadbacksBySupersedes,
  authorityStateDigest,
  currentAuthorityHeads,
  getAuthorityRecordAction,
  getAuthorityRecordActionByIdempotency,
  getAuthorityRecordReadback,
  lifecycleDenialForRow,
  MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS,
  validateReadbackInput,
  type AuthorityLifecycleDenial,
  type AuthorityRecordAction,
  type AuthorityRecordReadback,
  type RecordAuthorityReadbackInput,
} from "./authority-records.ts";
import type { CompetencyCommand } from "./agents/registry.ts";
import { canonicalJson } from "./agents/schema.ts";
import type { AgentDb, BoundStatement } from "./agents/store.ts";

export const COMPETENCY_KIND = "Worker Competency";
export const COMPETENCY_METHOD = "Internal Competency Assessment";

/** The roles that may approve an authority command: exactly those granted `authority:approve`. */
export const AUTHORITY_APPROVER_ROLES = (Object.keys(ROLE_PERMISSIONS) as AppRole[]).filter((role) =>
  ROLE_PERMISSIONS[role].includes("authority:approve"),
);

const PERSONNEL_TEXT = ["verification_reference", "revocation_reference", "correction_reason"] as const;

/**
 * An action as a reader without `authority:approve` sees it. Verification and revocation references
 * and correction reasons about a colleague are personnel and safety text, so they are left out.
 */
export function actionWithoutPersonnelText(action: AuthorityRecordAction): AuthorityRecordAction {
  if (!action.result_json) return action;
  try {
    const result = JSON.parse(action.result_json) as Record<string, unknown>;
    for (const key of PERSONNEL_TEXT) delete result[key];
    return { ...action, result_json: JSON.stringify(result) };
  } catch {
    return { ...action, result_json: null };
  }
}

/** What binds a replay to its command: the same key may only ever carry the same command. */
export async function competencyFingerprint(command: CompetencyCommand): Promise<string> {
  return await sha256Hex(canonicalJson({ executor: "worker_native", command }));
}

export type CompetencyRefusal =
  | "authority_approver_required"
  | "authority_self_approval_forbidden"
  | "authority_head_changed"
  | "authority_ambiguous"
  | "authority_contradictory"
  | "authority_transition_invalid"
  | "authority_version_limit_reached"
  | AuthorityLifecycleDenial;

export interface CompetencyPlan {
  actionId: string;
  readbackId: string;
  authorityRecordId: string;
  authorityVersion: number;
  stateDigest: string;
  observationFingerprint: string;
  /** Claim, new version, completion and readback, for the caller's own transaction. */
  statements: BoundStatement[];
}

const envOf = (db: AgentDb) => ({ DB: db }) as unknown as AppEnv;

// A login coordinate as appUserIdentities reads it: trimmed, lower case and never empty, so two
// blank values never match.
const coordinate = (column: string) => `NULLIF(lower(trim(${column})), '')`;
const coordinatesOf = (login: string) =>
  ["user_id", "email_normalized", "frappe_user_id"].map((column) => coordinate(`${login}.${column}`)).join(", ");

/**
 * Why this person may not decide a command about this worker, or null. They must be an active
 * approver, and no login the worker's reference names (by user id, email or Frappe user, in any
 * case) may share any of those coordinates with theirs. Two logins of one person that share no
 * coordinate cannot be linked without an explicit person-to-user record, so they are not caught.
 */
export async function competencyApproverRefusal(
  db: AgentDb,
  tenantId: string,
  approverUserId: string,
  subjectRef: string,
): Promise<"authority_approver_required" | "authority_self_approval_forbidden" | null> {
  const approver = await db
    .prepare(
      `SELECT user_id, email_normalized, frappe_user_id, COALESCE(access_role, role) AS role
         FROM app_users WHERE tenant_id = ? AND user_id = ? AND active = 1`,
    )
    .bind(tenantId, approverUserId)
    .first<{ user_id: string; email_normalized: string; frappe_user_id: string | null; role: AppRole }>();
  if (!approver || !AUTHORITY_APPROVER_ROLES.includes(approver.role)) return "authority_approver_required";
  const subject = subjectRef.toLowerCase();
  const subjectLogins = await db
    .prepare(
      `SELECT user_id, email_normalized, frappe_user_id FROM app_users
        WHERE tenant_id = ? AND ? IN (${coordinatesOf("app_users")})`,
    )
    .bind(tenantId, subject)
    .all<{ user_id: string; email_normalized: string; frappe_user_id: string | null }>();
  const approverCoordinates = new Set(appUserIdentities(approver));
  const subjectCoordinates = [subject, ...subjectLogins.results.flatMap((login) => appUserIdentities(login))];
  return subjectCoordinates.some((coordinate) => approverCoordinates.has(coordinate))
    ? "authority_self_approval_forbidden"
    : null;
}

/**
 * Reads what a command needs and returns the statements that execute it. Every refusal here is
 * made from current rows; the statements repeat the checks a concurrent write could invalidate.
 */
export async function planCompetencyCommand(
  db: AgentDb,
  input: {
    tenantId: string;
    command: CompetencyCommand;
    approverUserId: string;
    actionId: string;
    idempotencyKey: string;
    now: string;
  },
): Promise<CompetencyPlan | { refusal: CompetencyRefusal }> {
  const { tenantId, command, now } = input;
  const approverRefusal = await competencyApproverRefusal(db, tenantId, input.approverUserId, command.subject_ref);
  if (approverRefusal) return { refusal: approverRefusal };
  const subject = command.subject_ref.toLowerCase();

  const env = envOf(db);
  const rows = await authorityReadbacksByRequirement(env, tenantId, {
    subject_type: "Person",
    subject_ref: command.subject_ref,
    authority_kind: COMPETENCY_KIND,
    scope_type: command.scope_type,
    scope_ref: command.scope_ref,
  });
  if (rows.length > MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS) return { refusal: "authority_ambiguous" };
  const heads = currentAuthorityHeads(rows);
  if (heads.code) return { refusal: "authority_contradictory" };
  if (heads.rows.length > 1) return { refusal: "authority_ambiguous" };
  const head = heads.rows[0] ?? null;
  if (head) {
    // One version line per identity: no other record reaches the head's version, and nothing
    // outside the identity supersedes it.
    if (
      rows.some((row) => row.authority_version >= head.authority_version && row.authority_record_id !== head.authority_record_id) ||
      (await authorityReadbacksBySupersedes(env, tenantId, head.authority_record_id)).length > 0
    ) {
      return { refusal: "authority_ambiguous" };
    }
  }
  const expected = command.expected_head;
  if (
    expected
      ? head?.authority_record_id !== expected.authority_record_id ||
        head?.authority_version !== expected.authority_version
      : head !== null
  ) {
    return { refusal: "authority_head_changed" };
  }

  const verifying = command.operation === "verify";
  const revoking = command.operation === "revoke";
  // Verify confirms a recorded assessment; revoke ends one that is recorded or verified.
  const open = head !== null && head.authority_revoked_at === null && head.subject_role === "Worker" &&
    head.organization === null;
  if (verifying && !(open && head.verification_state === "unavailable")) {
    return { refusal: "authority_transition_invalid" };
  }
  if (revoking && !(open && (head.verification_state === "verified" || head.verification_state === "unavailable"))) {
    return { refusal: "authority_transition_invalid" };
  }
  // The fence reads at most this many rows of one lineage, so an identity never holds more. Its
  // last slot is kept for a revocation: a competency can always be revoked.
  const room = MAX_AUTHORITY_LINEAGE_COMPONENT_ROWS - rows.length;
  if (room <= 0 || (room === 1 && !revoking)) return { refusal: "authority_version_limit_reached" };

  const record = command.record;
  const evidenceRefsJson = record ? canonicalJson(record.evidence_refs) : head?.evidence_refs_json ?? "";
  const assessment = record
    ? {
        authorityScope: record.authority_scope,
        roofJob: record.roof_job,
        scopeJson: "{}",
        issuerName: tenantId,
        issuerJurisdiction: record.issuer_jurisdiction,
        issuerReference: record.issuer_reference,
        issuerSourceVersion: record.source_version,
        evidenceSha256: await sha256Hex(evidenceRefsJson),
        effectiveFrom: record.effective_from,
        expiresAt: record.expires_at,
      }
    : {
        authorityScope: head?.authority_scope ?? "",
        roofJob: head?.roof_job ?? null,
        scopeJson: head?.scope_json ?? "",
        issuerName: head?.issuer_name ?? "",
        issuerJurisdiction: head?.issuer_jurisdiction ?? "",
        issuerReference: head?.issuer_reference ?? "",
        issuerSourceVersion: head?.issuer_source_version ?? "",
        evidenceSha256: head?.evidence_sha256 ?? "",
        effectiveFrom: head?.authority_effective_from ?? null,
        expiresAt: head?.authority_expires_at ?? null,
      };
  const version = (head?.authority_version ?? 0) + 1;
  const authorityRecordId = `competency_${crypto.randomUUID()}`;
  const readbackId = `${input.actionId}.readback`;
  const material = {
    authority_record_id: authorityRecordId,
    tenant: tenantId,
    subject_type: "Person",
    subject_role: "Worker",
    person_user: command.subject_ref,
    organization: "",
    authority_kind: COMPETENCY_KIND,
    authority_scope: assessment.authorityScope,
    scope_type: command.scope_type,
    scope_ref: command.scope_ref,
    roof_job: assessment.roofJob ?? "",
    scope_json: assessment.scopeJson,
    issuer_name: assessment.issuerName,
    issuer_jurisdiction: assessment.issuerJurisdiction,
    issuer_reference: assessment.issuerReference,
    source_version: assessment.issuerSourceVersion,
    evidence_refs_json: evidenceRefsJson,
    evidence_sha256: assessment.evidenceSha256,
    effective_from: assessment.effectiveFrom ?? "",
    expires_at: assessment.expiresAt ?? "",
    version,
    status: verifying ? "Verified" : revoking ? "Revoked" : "Unverified",
    verification_method: verifying ? COMPETENCY_METHOD : "",
    verified_at: verifying ? now : "",
    verification_reference: verifying ? command.reference : "",
    verified_by: verifying ? input.approverUserId : "",
    revoked_at: revoking ? now : "",
    revocation_reference: revoking ? command.reference : "",
    revoked_by: revoking ? input.approverUserId : "",
    supersedes: head?.authority_record_id ?? "",
    correction_reason: command.reason ?? "",
    exception_status: "None",
    exception_reason: "",
    issuer_readback_json: "",
  };
  const stateDigest = await authorityStateDigest(material);
  const readback: RecordAuthorityReadbackInput = {
    readbackId,
    tenantId,
    authorityRecordId,
    authorityVersion: version,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: command.subject_ref,
    organization: null,
    authorityKind: COMPETENCY_KIND,
    authorityScope: assessment.authorityScope,
    scopeType: command.scope_type,
    scopeRef: command.scope_ref,
    roofJob: assessment.roofJob,
    scopeJson: assessment.scopeJson,
    issuerName: assessment.issuerName,
    issuerJurisdiction: assessment.issuerJurisdiction,
    issuerReference: assessment.issuerReference,
    issuerSourceVersion: assessment.issuerSourceVersion,
    verificationState: verifying ? "verified" : revoking ? "revoked" : "unavailable",
    evidenceRefsJson,
    evidenceSha256: assessment.evidenceSha256,
    authorityStateDigestSha256: stateDigest,
    authorityEffectiveFrom: assessment.effectiveFrom,
    authorityExpiresAt: assessment.expiresAt,
    authorityRevokedAt: revoking ? now : null,
    supersedesAuthorityRecordId: head?.authority_record_id ?? null,
    authorityVerificationMethod: verifying ? COMPETENCY_METHOD : null,
    issuerReceiptSha256: null,
    observedByUserId: input.approverUserId,
    observedAt: now,
    actionId: input.actionId,
  };
  try {
    validateReadbackInput(readback);
  } catch {
    return { refusal: "authority_transition_invalid" };
  }
  const observationFingerprint = await authorityReadbackFingerprint(readback);
  // A verified version is only written when the fence would accept it now.
  if (verifying) {
    const denial = lifecycleDenialForRow(readbackRow(readback, observationFingerprint), { tenantId, now });
    if (denial) return { refusal: denial };
  }

  const identity = [tenantId, command.subject_ref, COMPETENCY_KIND, command.scope_type, command.scope_ref];
  const identityWhere =
    "tenant_id = ? AND subject_type = 'Person' AND person_user = ? AND authority_kind = ? AND scope_type = ? AND scope_ref = ?";
  const resultJson = JSON.stringify({
    executor: "worker_native",
    operation: command.operation,
    authority_record_id: authorityRecordId,
    authority_version: version,
    authority_state_digest_sha256: stateDigest,
    verification_reference: verifying ? command.reference : null,
    revocation_reference: revoking ? command.reference : null,
    correction_reason: command.reason,
    material_readback_sha256: await sha256Hex(canonicalJson({ ...material, state_digest_sha256: stateDigest })),
    issuer_readback_id: readbackId,
  });
  const changed = () => db.prepare("INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE changes() <> 1").bind();
  const statements: BoundStatement[] = [
    // The approver is still an active approver, and no login the worker's reference names shares a
    // coordinate with theirs (competencyApproverRefusal, read again in this transaction).
    db
      .prepare(
        `INSERT INTO agent_control_guard (kind) SELECT 'authority' WHERE NOT EXISTS (
          SELECT 1 FROM app_users WHERE tenant_id = ? AND user_id = ? AND active = 1
             AND COALESCE(access_role, role) IN (${AUTHORITY_APPROVER_ROLES.map(() => "?").join(", ")}))
        OR EXISTS (
          SELECT 1 FROM app_users approver JOIN app_users subject ON subject.tenant_id = approver.tenant_id
           WHERE approver.tenant_id = ? AND approver.user_id = ?
             AND ? IN (${coordinatesOf("subject")})
             AND (${coordinate("subject.user_id")} IN (${coordinatesOf("approver")})
               OR ${coordinate("subject.email_normalized")} IN (${coordinatesOf("approver")})
               OR ${coordinate("subject.frappe_user_id")} IN (${coordinatesOf("approver")})))`,
      )
      .bind(tenantId, input.approverUserId, ...AUTHORITY_APPROVER_ROLES, tenantId, input.approverUserId, subject),
    // The head is still the one the command supersedes: no other version arrived, and nothing
    // else superseded it. The first version requires that the identity still has none.
    expected
      ? db
          .prepare(
            `INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE NOT EXISTS (
              SELECT 1 FROM authority_record_readbacks
               WHERE ${identityWhere} AND authority_record_id = ? AND authority_version = ?)
            OR EXISTS (
              SELECT 1 FROM authority_record_readbacks WHERE ${identityWhere}
                 AND (authority_version > ? OR (authority_version = ? AND authority_record_id <> ?)))
            OR EXISTS (
              SELECT 1 FROM authority_record_readbacks
               WHERE tenant_id = ? AND supersedes_authority_record_id = ?)`,
          )
          .bind(
            ...identity,
            expected.authority_record_id,
            expected.authority_version,
            ...identity,
            expected.authority_version,
            expected.authority_version,
            expected.authority_record_id,
            tenantId,
            expected.authority_record_id,
          )
      : db
          .prepare(
            `INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE EXISTS (
              SELECT 1 FROM authority_record_readbacks WHERE ${identityWhere})`,
          )
          .bind(...identity),
    db
      .prepare(
        `INSERT INTO authority_record_actions
           (action_id, tenant_id, authority_record_id, operation, expected_version,
            idempotency_key_sha256, request_fingerprint_sha256, actor_user_id,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        input.actionId,
        tenantId,
        authorityRecordId,
        command.operation,
        version,
        await authorityIdempotencyHash(tenantId, input.idempotencyKey),
        await competencyFingerprint(command),
        input.approverUserId,
        now,
        now,
      ),
    authorityReadbackInsert(db, readback, observationFingerprint),
    changed(),
    db
      .prepare(
        `UPDATE authority_record_actions
            SET status = 'applied', result_json = ?, updated_at = ?, completed_at = ?
          WHERE tenant_id = ? AND action_id = ? AND status = 'pending'`,
      )
      .bind(resultJson, now, now, tenantId, input.actionId),
    changed(),
    // The owned-store readback: the stored version and its applied action, read in this transaction.
    db
      .prepare(
        `INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE NOT EXISTS (
          SELECT 1 FROM authority_record_readbacks readback
            JOIN authority_record_actions action
              ON action.tenant_id = readback.tenant_id AND action.action_id = readback.action_id
           WHERE readback.tenant_id = ? AND readback.readback_id = ? AND readback.authority_record_id = ?
             AND readback.authority_version = ? AND readback.authority_state_digest_sha256 = ?
             AND readback.observation_fingerprint_sha256 = ? AND action.status = 'applied'
             AND action.actor_user_id = readback.observed_by_user_id
             AND json_extract(action.result_json, '$.issuer_readback_id') = readback.readback_id)`,
      )
      .bind(tenantId, readbackId, authorityRecordId, version, stateDigest, observationFingerprint),
  ];
  return {
    actionId: input.actionId,
    readbackId,
    authorityRecordId,
    authorityVersion: version,
    stateDigest,
    observationFingerprint,
    statements,
  };
}

export type CompetencyResult =
  | { kind: "recorded" | "replayed"; action: AuthorityRecordAction; readback: AuthorityRecordReadback }
  | {
      refusal:
        | CompetencyRefusal
        | "session_authority_changed"
        | "authority_readback_mismatch"
        | "idempotency_conflict";
    };

/**
 * Runs one command from a person's own request, behind the caller's session guards, and reads the
 * new version back once it commits. A repeated idempotency key replays its first result.
 */
export async function executeCompetencyCommand(
  db: AgentDb,
  input: { tenantId: string; command: CompetencyCommand; approverUserId: string; idempotencyKey: string; now: string },
  guards: BoundStatement[],
): Promise<CompetencyResult> {
  const fingerprint = await competencyFingerprint(input.command);
  const prior = await priorCommand(db, input, fingerprint);
  if (prior) return prior;
  const plan = await planCompetencyCommand(db, { ...input, actionId: `authority_${crypto.randomUUID()}` });
  if ("refusal" in plan) return plan;
  try {
    await db.batch([...guards, ...plan.statements]);
  } catch (error) {
    // A concurrent request with the same key committed first; answer as its replay.
    const raced = await priorCommand(db, input, fingerprint);
    if (raced) return raced;
    const message = String(error);
    if (message.includes("agent_control_authority")) return { refusal: "session_authority_changed" };
    if (message.includes("agent_control_version")) return { refusal: "authority_head_changed" };
    throw error;
  }
  const env = envOf(db);
  const action = await getAuthorityRecordAction(env, input.tenantId, plan.actionId);
  const readback = await getAuthorityRecordReadback(env, input.tenantId, plan.readbackId);
  if (
    action?.status !== "applied" ||
    readback?.observation_fingerprint_sha256 !== plan.observationFingerprint ||
    readback.authority_state_digest_sha256 !== plan.stateDigest
  ) {
    return { refusal: "authority_readback_mismatch" };
  }
  return { kind: "recorded", action, readback };
}

async function priorCommand(
  db: AgentDb,
  input: { tenantId: string; approverUserId: string; idempotencyKey: string },
  fingerprint: string,
): Promise<CompetencyResult | null> {
  const env = envOf(db);
  const action = await getAuthorityRecordActionByIdempotency(env, input.tenantId, input.idempotencyKey);
  if (!action) return null;
  if (
    action.status !== "applied" ||
    action.actor_user_id !== input.approverUserId ||
    action.request_fingerprint_sha256 !== fingerprint
  ) {
    return { refusal: "idempotency_conflict" };
  }
  const readbackId = (JSON.parse(action.result_json ?? "{}") as { issuer_readback_id?: unknown }).issuer_readback_id;
  const readback = typeof readbackId === "string"
    ? await getAuthorityRecordReadback(env, input.tenantId, readbackId)
    : null;
  return readback ? { kind: "replayed", action, readback } : { refusal: "authority_readback_mismatch" };
}

function readbackRow(input: RecordAuthorityReadbackInput, fingerprint: string): AuthorityRecordReadback {
  return {
    readback_id: input.readbackId,
    tenant_id: input.tenantId,
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
    issuer_name: input.issuerName,
    issuer_jurisdiction: input.issuerJurisdiction,
    issuer_reference: input.issuerReference,
    issuer_source_version: input.issuerSourceVersion,
    verification_state: input.verificationState,
    evidence_refs_json: input.evidenceRefsJson,
    evidence_sha256: input.evidenceSha256,
    authority_state_digest_sha256: input.authorityStateDigestSha256,
    authority_effective_from: input.authorityEffectiveFrom,
    authority_expires_at: input.authorityExpiresAt,
    authority_revoked_at: input.authorityRevokedAt,
    supersedes_authority_record_id: input.supersedesAuthorityRecordId,
    authority_verification_method: input.authorityVerificationMethod,
    issuer_receipt_sha256: input.issuerReceiptSha256,
    observed_by_user_id: input.observedByUserId,
    observed_at: input.observedAt,
    observation_fingerprint_sha256: fingerprint,
    action_id: input.actionId,
  };
}
