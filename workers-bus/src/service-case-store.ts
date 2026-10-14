// service-case-store.ts - complaint, warranty, service, diagnosis, remedy, and cost recovery
// (migration 0056).
//
// A Warranty Packet is a closeout artifact; it cannot run a callback. This store owns the callback
// itself: one versioned Service Case bound to customer, property, job, asset, warranty and consent,
// a triage decision that never lets a model hold final authority, a diagnosis that issues a
// governed service Work Package, a remedy whose verification and customer acceptance are separate
// evidence-bound facts, and supplier/manufacturer/insurer recovery intent. Historical attempts keep
// their pending -> leased -> terminal -> reconciled shape, while new execution remains fail-closed
// until a provider adapter and evidence resolver are configured.
//
// Every guarantee here is also a D1 constraint or trigger. This module is the ergonomic surface;
// it is not the enforcement boundary, so a direct writer cannot bypass the lifecycle by skipping
// these functions.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const SERVICE_CASE_STATES = [
  "intake",
  "triaged",
  "diagnosed",
  "remedy_issued",
  "remedy_verified",
  "customer_accepted",
  "disputed",
  "closed",
  "reopened",
] as const;
export type ServiceCaseState = (typeof SERVICE_CASE_STATES)[number];

export const SERVICE_CASE_SEVERITIES = ["emergency", "urgent", "standard", "monitor"] as const;
export type ServiceCaseSeverity = (typeof SERVICE_CASE_SEVERITIES)[number];

export const SERVICE_TRIAGE_CATEGORIES = [
  "emergency",
  "workmanship",
  "material_manufacturer",
  "weather",
  "excluded",
  "unknown",
] as const;
export type ServiceTriageCategory = (typeof SERVICE_TRIAGE_CATEGORIES)[number];

export const SERVICE_RESPONSIBILITIES = [
  "ironwrap_workmanship",
  "manufacturer",
  "supplier",
  "customer",
  "third_party",
  "weather",
  "undetermined",
] as const;
export type ServiceResponsibility = (typeof SERVICE_RESPONSIBILITIES)[number];

export const SERVICE_CLOSURE_REASONS = [
  "remedied_accepted",
  "no_fault_unknown",
  "excluded",
  "duplicate",
  "withdrawn",
] as const;
export type ServiceClosureReason = (typeof SERVICE_CLOSURE_REASONS)[number];

export const SERVICE_RECOVERY_STATES = [
  "pending",
  "leased",
  "succeeded",
  "failed",
  "uncertain",
  "reconciled",
] as const;
export type ServiceRecoveryState = (typeof SERVICE_RECOVERY_STATES)[number];

/** An emergency callback may never be parked behind a routine response window. */
export const EMERGENCY_RESPONSE_SLA_CEILING_MINUTES = 240;

export type ServiceCaseEventType =
  | "case_opened"
  | "duplicate_linked"
  | "triaged"
  | "diagnosed"
  | "remedy_issued"
  | "remedy_verified"
  | "remedy_failed"
  | "customer_accepted"
  | "customer_disputed"
  | "closed"
  | "reopened";

export interface ServiceCaseRecord {
  service_case_id: string;
  tenant_id: string;
  customer_id: string;
  property_key: string;
  roof_job_id: string;
  asset_ref: string | null;
  warranty_packet_id: string | null;
  origin_work_package_ref: string | null;
  severity: ServiceCaseSeverity;
  symptom_code: string;
  reported_channel: "phone" | "portal" | "email" | "field" | "partner";
  consent_ref: string;
  intake_evidence_digest: string;
  intake_request_sha256?: string | null;
  response_sla_minutes: number;
  response_due_at: string;
  state: ServiceCaseState;
  version: number;
  last_event_type: ServiceCaseEventType;
  last_transition_code: string | null;
  last_evidence_digest: string | null;
  duplicate_of_case_id: string | null;
  closure_reason: ServiceClosureReason | null;
  closed_at: string | null;
  reopen_count: number;
  opened_by_user_id: string;
  last_actor_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceCaseEventRecord {
  event_id: number;
  service_case_id: string;
  tenant_id: string;
  event_type: ServiceCaseEventType;
  case_state: ServiceCaseState;
  case_version: number;
  actor_user_id: string;
  detail_code: string | null;
  evidence_digest: string | null;
  created_at: string;
}

export interface ServiceCaseTriageRecord {
  triage_id: string;
  service_case_id: string;
  tenant_id: string;
  case_version: number;
  advisory_source: "model" | "rule" | "none";
  advisory_category: ServiceTriageCategory | null;
  advisory_confidence_bps: number | null;
  final_category: ServiceTriageCategory;
  responsibility: ServiceResponsibility;
  authority_kind: "human";
  decided_by_user_id: string;
  decided_by_role: string;
  evidence_digest: string;
  decided_at: string;
  created_at: string;
}

export interface ServiceCaseDiagnosisRecord {
  diagnosis_id: string;
  service_case_id: string;
  tenant_id: string;
  case_version: number;
  triage_id: string;
  root_cause_code: string;
  corrective_action_code: string;
  recurrence_of_case_id: string | null;
  work_package_ref: string;
  work_package_version: number;
  warranty_reserve_cents: number;
  evidence_digest: string;
  diagnosed_by_user_id: string;
  diagnosed_at: string;
  created_at: string;
}

export interface ServiceCaseRemedyRecord {
  remedy_id: string;
  service_case_id: string;
  tenant_id: string;
  case_version: number;
  diagnosis_id: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  parts_manifest_digest: string;
  field_evidence_digest: string | null;
  verification_state: "pending" | "verified" | "failed";
  verified_at: string | null;
  verified_by_user_id: string | null;
  failure_code: string | null;
  customer_acceptance_state: "pending" | "accepted" | "disputed";
  customer_decision_at: string | null;
  customer_acceptance_ref: string | null;
  dispute_code: string | null;
  cost_actual_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceCostRecoveryClaimRecord {
  claim_id: string;
  service_case_id: string;
  tenant_id: string;
  case_version: number;
  diagnosis_id: string;
  counterparty_kind: "supplier" | "manufacturer" | "insurer";
  counterparty_ref: string;
  claim_basis_code: string;
  claimed_amount_cents: number;
  currency: "CAD";
  evidence_digest: string;
  effect_kind: "cost_recovery_claim_submission";
  actor_user_id: string;
  actor_role: "owner" | "ops";
  authority_ref: string;
  correlation_id: string;
  request_hash: string;
  deadline_at: string;
  idempotency_key: string;
  state: ServiceRecoveryState;
  attempt_count: number;
  attempt_mode: "none" | "leased" | "inferred_terminal";
  due_at: string;
  lease_ref: string | null;
  lease_expires_at: string | null;
  attempted_at: string | null;
  result_ref: string | null;
  result_code: string | null;
  recovered_amount_cents: number | null;
  reconciled_at: string | null;
  reconciliation_outcome: "executed" | "not_executed" | "inconclusive" | null;
  reconciliation_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenServiceCaseInput {
  serviceCaseId: string;
  tenantId: string;
  customerId: string;
  propertyKey: string;
  roofJobId: string;
  assetRef?: string | null;
  warrantyPacketId?: string | null;
  originWorkPackageRef?: string | null;
  severity: ServiceCaseSeverity;
  symptomCode: string;
  reportedChannel: ServiceCaseRecord["reported_channel"];
  consentRef: string;
  intakeEvidenceDigest: string;
  intakeRequestSha256?: string;
  responseSlaMinutes: number;
  openedByUserId: string;
  intakeCode?: string | null;
  now: string;
}

export type OpenServiceCaseResult =
  | { kind: "opened" | "replayed"; serviceCase: ServiceCaseRecord }
  | { kind: "duplicate"; serviceCase: ServiceCaseRecord; original: ServiceCaseRecord };

const SELECT_CASE = `SELECT * FROM service_cases`;

export function serviceCaseResponseDueAt(now: string, slaMinutes: number): string {
  const due = new Date(new Date(now).getTime() + slaMinutes * 60_000);
  return due.toISOString();
}

export async function getServiceCase(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseRecord | null> {
  const row = await env.DB.prepare(
    `${SELECT_CASE} WHERE tenant_id = ? AND service_case_id = ? LIMIT 1`,
  ).bind(input.tenantId, input.serviceCaseId).first<ServiceCaseRecord>();
  return row ?? null;
}

async function findOpenCaseForSymptom(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string; symptomCode: string },
): Promise<ServiceCaseRecord | null> {
  const row = await env.DB.prepare(
    `${SELECT_CASE}
     WHERE tenant_id = ? AND roof_job_id = ? AND symptom_code = ? AND state != 'closed'
     LIMIT 1`,
  ).bind(input.tenantId, input.roofJobId, input.symptomCode).first<ServiceCaseRecord>();
  return row ?? null;
}

/**
 * Opens one callback. A second report of the same symptom on the same job while a case is still
 * live is not a competing lifecycle: it is recorded as its own case, born closed and linked to the
 * original, so the duplicate call is never silently dropped and never forks the remedy.
 *
 * `response_due_at` is derived here, never accepted: bounding the declared SLA minutes does not
 * bound the timestamp an SLA sweeper actually reads, so the two can never drift apart.
 *
 * The read-then-write duplicate check is a fast path, not the fence. The partial unique index is
 * the fence: two concurrent first reports of the same symptom both see no original, and the loser
 * of the insert race is re-read and linked as a duplicate rather than surfacing a raw constraint
 * failure to the caller.
 */
export async function openServiceCase(
  env: AppEnv,
  input: OpenServiceCaseInput,
): Promise<OpenServiceCaseResult> {
  if (input.severity === "emergency" && input.responseSlaMinutes > EMERGENCY_RESPONSE_SLA_CEILING_MINUTES) {
    throw new Error("service_case_emergency_sla_exceeded");
  }
  const replay = async (): Promise<OpenServiceCaseResult | null> => {
    if (!input.intakeRequestSha256) return null;
    const existing = await getServiceCase(env, input);
    if (!existing) return null;
    if (existing.intake_request_sha256 !== input.intakeRequestSha256) throw new Error("service_case_intake_request_conflict");
    return { kind: "replayed", serviceCase: existing };
  };
  const prior = await replay();
  if (prior) return prior;
  const original = await findOpenCaseForSymptom(env, input);
  if (original) {
    try { return await insertDuplicateCase(env, input, original); }
    catch (error) { const prior = await replay(); if (prior) return prior; throw error; }
  }
  try {
    const serviceCase = await insertServiceCase(env, input, {
      state: "intake",
      lastEventType: "case_opened",
      duplicateOfCaseId: null,
      closureReason: null,
      closedAt: null,
    });
    return { kind: "opened", serviceCase };
  } catch (error) {
    const prior = await replay();
    if (prior) return prior;
    if (!isUniqueConstraintFailure(error)) throw error;
    const winner = await findOpenCaseForSymptom(env, input);
    if (!winner) throw error;
    try { return await insertDuplicateCase(env, input, winner); }
    catch (error) { const prior = await replay(); if (prior) return prior; throw error; }
  }
}

async function insertDuplicateCase(
  env: AppEnv,
  input: OpenServiceCaseInput,
  original: ServiceCaseRecord,
): Promise<OpenServiceCaseResult> {
  const duplicate = await insertServiceCase(env, input, {
    state: "closed",
    lastEventType: "duplicate_linked",
    duplicateOfCaseId: original.service_case_id,
    closureReason: "duplicate",
    closedAt: input.now,
  });
  return { kind: "duplicate", serviceCase: duplicate, original };
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

async function insertServiceCase(
  env: AppEnv,
  input: OpenServiceCaseInput,
  opening: {
    state: ServiceCaseState;
    lastEventType: ServiceCaseEventType;
    duplicateOfCaseId: string | null;
    closureReason: ServiceClosureReason | null;
    closedAt: string | null;
  },
): Promise<ServiceCaseRecord> {
  await env.DB.prepare(
    `INSERT INTO service_cases (
      service_case_id, tenant_id, customer_id, property_key, roof_job_id, asset_ref,
      warranty_packet_id, origin_work_package_ref, severity, symptom_code, reported_channel,
      consent_ref, intake_evidence_digest, response_sla_minutes, response_due_at, state, version,
      last_event_type, last_transition_code, last_evidence_digest, duplicate_of_case_id,
      closure_reason, closed_at, reopen_count, opened_by_user_id, last_actor_user_id,
      created_at, updated_at${input.intakeRequestSha256 ? ", intake_request_sha256" : ""}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?${input.intakeRequestSha256 ? ", ?" : ""})`,
  ).bind(
    input.serviceCaseId,
    input.tenantId,
    input.customerId,
    input.propertyKey,
    input.roofJobId,
    input.assetRef ?? null,
    input.warrantyPacketId ?? null,
    input.originWorkPackageRef ?? null,
    input.severity,
    input.symptomCode,
    input.reportedChannel,
    input.consentRef,
    input.intakeEvidenceDigest,
    input.responseSlaMinutes,
    serviceCaseResponseDueAt(input.now, input.responseSlaMinutes),
    opening.state,
    opening.lastEventType,
    input.intakeCode ?? null,
    input.intakeEvidenceDigest,
    opening.duplicateOfCaseId,
    opening.closureReason,
    opening.closedAt,
    input.openedByUserId,
    input.openedByUserId,
    input.now,
    input.now,
    ...(input.intakeRequestSha256 ? [input.intakeRequestSha256] : []),
  ).run();
  const created = await getServiceCase(env, input);
  if (!created) throw new Error("service_case_insert_missing");
  return created;
}

export interface RecordServiceTriageInput {
  triageId: string;
  tenantId: string;
  serviceCaseId: string;
  advisorySource: "model" | "rule" | "none";
  advisoryCategory?: ServiceTriageCategory | null;
  advisoryConfidenceBps?: number | null;
  finalCategory: ServiceTriageCategory;
  responsibility: ServiceResponsibility;
  decidedByUserId: string;
  decidedByRole: string;
  evidenceDigest: string;
  now: string;
}

/**
 * Records the triage decision and advances the case. A model or rule advisory is stored beside the
 * decision, never as it: `authority_kind` admits only `human` and the deciding user and role are
 * mandatory, so a model classification can inform triage but can never conclude it.
 */
export async function recordServiceTriage(
  env: AppEnv,
  input: RecordServiceTriageInput,
): Promise<{ triage: ServiceCaseTriageRecord; serviceCase: ServiceCaseRecord }> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  const childWrite = env.DB.prepare(
    `INSERT INTO service_case_triage (
      triage_id, service_case_id, tenant_id, case_version, advisory_source, advisory_category,
      advisory_confidence_bps, final_category, responsibility, authority_kind, decided_by_user_id,
      decided_by_role, evidence_digest, decided_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?, ?, ?)`,
  ).bind(
    input.triageId,
    input.serviceCaseId,
    input.tenantId,
    current.version,
    input.advisorySource,
    input.advisoryCategory ?? null,
    input.advisoryConfidenceBps ?? null,
    input.finalCategory,
    input.responsibility,
    input.decidedByUserId,
    input.decidedByRole,
    input.evidenceDigest,
    input.now,
    input.now,
  );

  const serviceCase = await advanceCaseWithChild(env, childWrite, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: "triaged",
    eventType: "triaged",
    transitionCode: input.finalCategory,
    evidenceDigest: input.evidenceDigest,
    actorUserId: input.decidedByUserId,
    now: input.now,
  }, current.reopen_count);
  const triage = await env.DB.prepare(
    `SELECT * FROM service_case_triage WHERE triage_id = ? LIMIT 1`,
  ).bind(input.triageId).first<ServiceCaseTriageRecord>();
  if (!triage) throw new Error("service_case_triage_insert_missing");
  return { triage, serviceCase };
}

export interface RecordServiceDiagnosisInput {
  diagnosisId: string;
  tenantId: string;
  serviceCaseId: string;
  triageId: string;
  rootCauseCode: string;
  correctiveActionCode: string;
  recurrenceOfCaseId?: string | null;
  workPackageRef: string;
  workPackageVersion: number;
  warrantyReserveCents: number;
  evidenceDigest: string;
  diagnosedByUserId: string;
  now: string;
}

/**
 * Records the diagnosis and the governed service Work Package it issues. D1 refuses a diagnosis
 * whose triage was excluded or unknown, so remedy work can never be dispatched off a class that
 * never established a fault.
 */
export async function recordServiceDiagnosis(
  env: AppEnv,
  input: RecordServiceDiagnosisInput,
): Promise<{ diagnosis: ServiceCaseDiagnosisRecord; serviceCase: ServiceCaseRecord }> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  const childWrite = env.DB.prepare(
    `INSERT INTO service_case_diagnoses (
      diagnosis_id, service_case_id, tenant_id, case_version, triage_id, root_cause_code,
      corrective_action_code, recurrence_of_case_id, work_package_ref, work_package_version,
      warranty_reserve_cents, evidence_digest, diagnosed_by_user_id, diagnosed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.diagnosisId,
    input.serviceCaseId,
    input.tenantId,
    current.version,
    input.triageId,
    input.rootCauseCode,
    input.correctiveActionCode,
    input.recurrenceOfCaseId ?? null,
    input.workPackageRef,
    input.workPackageVersion,
    input.warrantyReserveCents,
    input.evidenceDigest,
    input.diagnosedByUserId,
    input.now,
    input.now,
  );

  const serviceCase = await advanceCaseWithChild(env, childWrite, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: "diagnosed",
    eventType: "diagnosed",
    transitionCode: input.rootCauseCode,
    evidenceDigest: input.evidenceDigest,
    actorUserId: input.diagnosedByUserId,
    now: input.now,
  }, current.reopen_count);
  const diagnosis = await env.DB.prepare(
    `SELECT * FROM service_case_diagnoses WHERE diagnosis_id = ? LIMIT 1`,
  ).bind(input.diagnosisId).first<ServiceCaseDiagnosisRecord>();
  if (!diagnosis) throw new Error("service_case_diagnosis_insert_missing");
  return { diagnosis, serviceCase };
}

export interface IssueServiceRemedyInput {
  remedyId: string;
  tenantId: string;
  serviceCaseId: string;
  diagnosisId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  partsManifestDigest: string;
  issuedByUserId: string;
  now: string;
}

export async function issueServiceRemedy(
  env: AppEnv,
  input: IssueServiceRemedyInput,
): Promise<{ remedy: ServiceCaseRemedyRecord; serviceCase: ServiceCaseRecord }> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  const childWrite = env.DB.prepare(
    `INSERT INTO service_case_remedies (
      remedy_id, service_case_id, tenant_id, case_version, diagnosis_id, scheduled_start_at,
      scheduled_end_at, parts_manifest_digest, field_evidence_digest, verification_state,
      verified_at, verified_by_user_id, failure_code, customer_acceptance_state,
      customer_decision_at, customer_acceptance_ref, dispute_code, cost_actual_cents,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
  ).bind(
    input.remedyId,
    input.serviceCaseId,
    input.tenantId,
    current.version,
    input.diagnosisId,
    input.scheduledStartAt,
    input.scheduledEndAt,
    input.partsManifestDigest,
    input.now,
    input.now,
  );

  const serviceCase = await advanceCaseWithChild(env, childWrite, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: "remedy_issued",
    eventType: "remedy_issued",
    transitionCode: "service_work_package_issued",
    evidenceDigest: input.partsManifestDigest,
    actorUserId: input.issuedByUserId,
    now: input.now,
  }, current.reopen_count);
  return { remedy: await requireRemedy(env, input.remedyId), serviceCase };
}

export interface VerifyServiceRemedyInput {
  tenantId: string;
  serviceCaseId: string;
  remedyId: string;
  fieldEvidenceDigest: string;
  costActualCents: number;
  verifiedByUserId: string;
  outcome: "verified" | "failed";
  failureCode?: string | null;
  now: string;
}

/**
 * Records remedy verification. A failed verification does not close anything and does not rewrite
 * the attempt: the remedy row keeps its failure evidence forever and the case falls back to
 * `diagnosed` for rework, which is what a real second truck roll looks like.
 */
export async function verifyServiceRemedy(
  env: AppEnv,
  input: VerifyServiceRemedyInput,
): Promise<{ remedy: ServiceCaseRemedyRecord; serviceCase: ServiceCaseRecord }> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  if (input.outcome === "failed" && !input.failureCode) {
    throw new Error("service_case_remedy_failure_code_required");
  }
  const childWrite = env.DB.prepare(
    `UPDATE service_case_remedies
     SET verification_state = ?, field_evidence_digest = ?, verified_at = ?,
         verified_by_user_id = ?, failure_code = ?, cost_actual_cents = ?, updated_at = ?
     WHERE remedy_id = ? AND tenant_id = ? AND service_case_id = ?
       AND verification_state = 'pending'`,
  ).bind(
    input.outcome,
    input.fieldEvidenceDigest,
    input.now,
    input.verifiedByUserId,
    input.outcome === "failed" ? input.failureCode : null,
    input.costActualCents,
    input.now,
    input.remedyId,
    input.tenantId,
    input.serviceCaseId,
  );

  const serviceCase = await advanceCaseWithChild(env, childWrite, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: input.outcome === "verified" ? "remedy_verified" : "diagnosed",
    eventType: input.outcome === "verified" ? "remedy_verified" : "remedy_failed",
    transitionCode: input.outcome === "verified" ? "remedy_verified" : (input.failureCode ?? null),
    evidenceDigest: input.fieldEvidenceDigest,
    actorUserId: input.verifiedByUserId,
    now: input.now,
  }, current.reopen_count, "service_case_remedy_verification_not_recorded");
  return { remedy: await requireRemedy(env, input.remedyId), serviceCase };
}

export interface RecordCustomerServiceDecisionInput {
  tenantId: string;
  serviceCaseId: string;
  remedyId: string;
  decision: "accepted" | "disputed";
  acceptanceRef?: string | null;
  disputeCode?: string | null;
  evidenceDigest: string;
  actorUserId: string;
  now: string;
}

/**
 * Records the customer's own decision on verified work. A dispute is a first-class outcome, not an
 * error: it keeps the verification evidence intact and moves the case to `disputed`, from which the
 * only ways out are rework or an explicit non-remedied closure.
 */
export async function recordCustomerServiceDecision(
  env: AppEnv,
  input: RecordCustomerServiceDecisionInput,
): Promise<{ remedy: ServiceCaseRemedyRecord; serviceCase: ServiceCaseRecord }> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  if (input.decision === "accepted" && !input.acceptanceRef) {
    throw new Error("service_case_customer_acceptance_ref_required");
  }
  if (input.decision === "disputed" && !input.disputeCode) {
    throw new Error("service_case_dispute_code_required");
  }
  const childWrite = env.DB.prepare(
    `UPDATE service_case_remedies
     SET customer_acceptance_state = ?, customer_decision_at = ?, customer_acceptance_ref = ?,
         dispute_code = ?, updated_at = ?
     WHERE remedy_id = ? AND tenant_id = ? AND service_case_id = ?
       AND verification_state = 'verified'
       AND customer_acceptance_state = 'pending'`,
  ).bind(
    input.decision,
    input.now,
    input.decision === "accepted" ? input.acceptanceRef : null,
    input.decision === "disputed" ? input.disputeCode : null,
    input.now,
    input.remedyId,
    input.tenantId,
    input.serviceCaseId,
  );

  const serviceCase = await advanceCaseWithChild(env, childWrite, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: input.decision === "accepted" ? "customer_accepted" : "disputed",
    eventType: input.decision === "accepted" ? "customer_accepted" : "customer_disputed",
    transitionCode: input.decision === "accepted" ? "customer_accepted" : (input.disputeCode ?? null),
    evidenceDigest: input.evidenceDigest,
    actorUserId: input.actorUserId,
    now: input.now,
  }, current.reopen_count, "service_case_customer_decision_not_recorded");
  return { remedy: await requireRemedy(env, input.remedyId), serviceCase };
}

export interface CloseServiceCaseInput {
  tenantId: string;
  serviceCaseId: string;
  closureReason: Exclude<ServiceClosureReason, "duplicate">;
  detailCode?: string | null;
  evidenceDigest?: string | null;
  actorUserId: string;
  now: string;
}

export async function closeServiceCase(
  env: AppEnv,
  input: CloseServiceCaseInput,
): Promise<ServiceCaseRecord> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  return advanceCase(env, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: "closed",
    eventType: "closed",
    transitionCode: input.detailCode ?? input.closureReason,
    evidenceDigest: input.evidenceDigest ?? null,
    actorUserId: input.actorUserId,
    closureReason: input.closureReason,
    closedAt: input.now,
    now: input.now,
  });
}

export interface ReopenServiceCaseInput {
  tenantId: string;
  serviceCaseId: string;
  reopenCode: string;
  actorUserId: string;
  now: string;
}

/**
 * Reopens a closed case. Closure history stays in `service_case_events`; the reopen is a forward
 * version with its own event and a raised `reopen_count`, which is what "compensation reopens or
 * corrects, never erases" means at the row level.
 */
export async function reopenServiceCase(
  env: AppEnv,
  input: ReopenServiceCaseInput,
): Promise<ServiceCaseRecord> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  if (current.state !== "closed") throw new Error("service_case_reopen_requires_closed_case");
  return advanceCase(env, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    fromVersion: current.version,
    state: "reopened",
    eventType: "reopened",
    transitionCode: input.reopenCode,
    evidenceDigest: null,
    actorUserId: input.actorUserId,
    closureReason: null,
    closedAt: null,
    reopenCount: current.reopen_count + 1,
    now: input.now,
  });
}

interface AdvanceCaseInput {
  tenantId: string;
  serviceCaseId: string;
  fromVersion: number;
  state: ServiceCaseState;
  eventType: ServiceCaseEventType;
  transitionCode: string | null;
  evidenceDigest: string | null;
  actorUserId: string;
  closureReason?: ServiceClosureReason | null;
  closedAt?: string | null;
  reopenCount?: number;
  now: string;
}

/**
 * The one write that moves a case. `version = fromVersion` in the WHERE clause makes the step
 * optimistic-concurrency safe; the D1 triggers reject an illegal target state, a missing evidence
 * digest, a closure reason that does not belong to the source state, and any reopen that would
 * drop the closure history.
 *
 * The standalone transition reads the `RETURNING` row, never `meta.changes`. `service_cases` carries the
 * `service_cases_append_transition_event` AFTER-UPDATE trigger, and D1 counts trigger-written rows
 * in `meta.changes` -- a legal transition reports 2, so a `changes !== 1` guard refuses every
 * transition *after* it has already committed. `RETURNING` yields exactly the rows this statement
 * matched: one row when the version was ours, none when another writer took it. Batched child
 * transitions use SQLite's changes() in the next statement, which excludes trigger side effects.
 */
function caseTransitionStatement(
  env: AppEnv,
  input: AdvanceCaseInput,
  reopenCount: number,
  returning: boolean,
): ReturnType<AppEnv["DB"]["prepare"]> {
  return env.DB.prepare(
    `UPDATE service_cases
     SET state = ?, version = version + 1, last_event_type = ?, last_transition_code = ?,
         last_evidence_digest = ?, closure_reason = ?, closed_at = ?, reopen_count = ?,
         last_actor_user_id = ?, updated_at = ?
     WHERE tenant_id = ? AND service_case_id = ? AND version = ?
     ${returning ? "RETURNING version" : ""}`,
  ).bind(
    input.state,
    input.eventType,
    input.transitionCode,
    input.evidenceDigest,
    input.closureReason ?? null,
    input.closedAt ?? null,
    reopenCount,
    input.actorUserId,
    input.now,
    input.tenantId,
    input.serviceCaseId,
    input.fromVersion,
  );
}

/**
 * D1 batches are transactions, but a CAS UPDATE that matches zero rows is still a successful SQL
 * statement. The immediately following guard aborts that transaction when changes() is not one.
 * For remedy updates, a second guard ensures the pending child row was actually changed. This
 * keeps the child, case version, and trigger-written event one indivisible business step.
 */
async function advanceCaseWithChild(
  env: AppEnv,
  childWrite: ReturnType<AppEnv["DB"]["prepare"]>,
  input: AdvanceCaseInput,
  reopenCount: number,
  childConflictCode?: string,
): Promise<ServiceCaseRecord> {
  const guard = (kind: "child" | "transition") => env.DB.prepare(
    `INSERT INTO service_case_batch_guard (kind)
     SELECT ? WHERE changes() != 1`,
  ).bind(kind);
  try {
    await env.DB.batch([
      childWrite,
      ...(childConflictCode ? [guard("child")] : []),
      caseTransitionStatement(env, input, reopenCount, false),
      guard("transition"),
    ]);
  } catch (error) {
    if (childConflictCode && String(error).includes("service_case_child_write_conflict")) {
      throw new Error(childConflictCode);
    }
    // Triage has its own direct-write version trigger. If another writer moved the case between
    // requireCase and this batch, expose the same stable conflict as the case CAS guard.
    if (String(error).includes("service_case_triage_case_version_mismatch")) {
      const latest = await requireCase(env, input.tenantId, input.serviceCaseId);
      if (latest.version !== input.fromVersion) {
        throw new Error("service_case_transition_conflict");
      }
    }
    throw error;
  }
  return requireCase(env, input.tenantId, input.serviceCaseId);
}

async function advanceCase(env: AppEnv, input: AdvanceCaseInput): Promise<ServiceCaseRecord> {
  const reopenCount = input.reopenCount
    ?? (await requireCase(env, input.tenantId, input.serviceCaseId)).reopen_count;
  const applied = await caseTransitionStatement(env, input, reopenCount, true)
    .first<{ version: number }>();
  if (!applied) throw new Error("service_case_transition_conflict");
  return requireCase(env, input.tenantId, input.serviceCaseId);
}

export interface OpenCostRecoveryClaimInput {
  claimId: string;
  tenantId: string;
  serviceCaseId: string;
  diagnosisId: string;
  counterpartyKind: "supplier" | "manufacturer" | "insurer";
  counterpartyRef: string;
  claimBasisCode: string;
  claimedAmountCents: number;
  evidenceDigest: string;
  /** Who authorized the claim, and under which office role. */
  actorUserId: string;
  actorRole: "owner" | "ops";
  /** The counterparty's own claim window: the point after which submitting is pointless. */
  deadlineAt: string;
  now: string;
}

/** Every effect raised for one service case correlates under this id. */
export function serviceCaseCorrelationId(serviceCaseId: string): string {
  return `svc-case:${serviceCaseId}`;
}

/**
 * Canonical request identity for one claim submission. IRO-38's `external_effects` requires a
 * `request_hash` over the exact request an attempt would carry; deriving it here rather than
 * accepting it means the recorded hash can never disagree with the recorded claim.
 */
export async function costRecoveryRequestHash(input: {
  tenantId: string;
  serviceCaseId: string;
  diagnosisId: string;
  counterpartyKind: string;
  counterpartyRef: string;
  claimBasisCode: string;
  claimedAmountCents: number;
  currency: "CAD";
  evidenceDigest: string;
}): Promise<string> {
  return await sha256Hex(
    canonicalJson([
      input.tenantId,
      input.serviceCaseId,
      input.diagnosisId,
      input.counterpartyKind,
      input.counterpartyRef,
      input.claimBasisCode,
      input.claimedAmountCents,
      input.currency,
      input.evidenceDigest,
    ]),
  );
}

/**
 * The business identity of one claim submission: the same claim requested twice carries the same
 * key, so `UNIQUE (tenant_id, service_case_id, counterparty_kind, idempotency_key)` turns a
 * repeated submission into a no-op instead of a second attempt at the same money.
 */
export function costRecoveryIdempotencyKey(requestHash: string): string {
  return `svc-recovery:${requestHash.slice(0, 48)}`;
}

export type OpenCostRecoveryClaimResult =
  | { kind: "opened"; claim: ServiceCostRecoveryClaimRecord }
  | { kind: "already_recorded"; claim: ServiceCostRecoveryClaimRecord };

/**
 * Records a never-attempted cost-recovery intent. This is the whole external side effect at
 * creation time: no provider is called here, and D1 refuses the intent unless triage placed
 * responsibility on a manufacturer, supplier, or third party.
 *
 * Authority, correlation, request hash, and the idempotency key are derived from the case and its
 * diagnosis rather than accepted from the caller, so the governance facts IRO-38's
 * `external_effects` demands NOT NULL are captured at the only moment they are knowable, and no
 * caller can recycle another claim's identity.
 */
export async function openCostRecoveryClaim(
  env: AppEnv,
  input: OpenCostRecoveryClaimInput,
): Promise<OpenCostRecoveryClaimResult> {
  const current = await requireCase(env, input.tenantId, input.serviceCaseId);
  const diagnosis = await requireDiagnosis(env, input.tenantId, input.diagnosisId);
  const requestHash = await costRecoveryRequestHash({ ...input, currency: "CAD" });
  const idempotencyKey = costRecoveryIdempotencyKey(requestHash);
  const existing = await findCostRecoveryClaimByKey(env, {
    tenantId: input.tenantId,
    serviceCaseId: input.serviceCaseId,
    counterpartyKind: input.counterpartyKind,
    idempotencyKey,
  });
  if (existing) return { kind: "already_recorded", claim: existing };
  try {
    await insertCostRecoveryClaim(env, input, {
      caseVersion: current.version,
      authorityRef: diagnosis.triage_id,
      requestHash,
      idempotencyKey,
    });
  } catch (error) {
    if (!isUniqueConstraintFailure(error)) throw error;
    const winner = await findCostRecoveryClaimByKey(env, {
      tenantId: input.tenantId,
      serviceCaseId: input.serviceCaseId,
      counterpartyKind: input.counterpartyKind,
      idempotencyKey,
    });
    if (!winner) throw error;
    return { kind: "already_recorded", claim: winner };
  }
  return { kind: "opened", claim: await requireClaim(env, input.claimId) };
}

async function findCostRecoveryClaimByKey(
  env: AppEnv,
  input: {
    tenantId: string;
    serviceCaseId: string;
    counterpartyKind: string;
    idempotencyKey: string;
  },
): Promise<ServiceCostRecoveryClaimRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM service_cost_recovery_claims
     WHERE tenant_id = ? AND service_case_id = ? AND counterparty_kind = ? AND idempotency_key = ?
     LIMIT 1`,
  ).bind(
    input.tenantId,
    input.serviceCaseId,
    input.counterpartyKind,
    input.idempotencyKey,
  ).first<ServiceCostRecoveryClaimRecord>();
  return row ?? null;
}

async function insertCostRecoveryClaim(
  env: AppEnv,
  input: OpenCostRecoveryClaimInput,
  derived: {
    caseVersion: number;
    authorityRef: string;
    requestHash: string;
    idempotencyKey: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO service_cost_recovery_claims (
      claim_id, service_case_id, tenant_id, case_version, diagnosis_id, counterparty_kind,
      counterparty_ref, claim_basis_code, claimed_amount_cents, currency, evidence_digest,
      effect_kind, actor_user_id, actor_role, authority_ref, correlation_id, request_hash,
      deadline_at, idempotency_key, state, attempt_count, attempt_mode, due_at, lease_ref,
      lease_expires_at, attempted_at, result_ref, result_code, recovered_amount_cents,
      reconciled_at, reconciliation_outcome, reconciliation_ref, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?, 'cost_recovery_claim_submission', ?, ?, ?, ?, ?, ?, ?,
      'pending', 0, 'none', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
    )`,
  ).bind(
    input.claimId,
    input.serviceCaseId,
    input.tenantId,
    derived.caseVersion,
    input.diagnosisId,
    input.counterpartyKind,
    input.counterpartyRef,
    input.claimBasisCode,
    input.claimedAmountCents,
    input.evidenceDigest,
    input.actorUserId,
    input.actorRole,
    derived.authorityRef,
    serviceCaseCorrelationId(input.serviceCaseId),
    derived.requestHash,
    input.deadlineAt,
    derived.idempotencyKey,
    input.now,
    input.now,
    input.now,
  ).run();
}

/**
 * Closes a legacy uncertain attempt with independently observed evidence. New attempts remain
 * disabled until a real provider adapter and evidence resolver are configured, but already
 * recorded uncertainty must remain safely reconcilable rather than being stranded by that gate.
 */
export async function reconcileCostRecoveryEffect(
  env: AppEnv,
  input: {
    tenantId: string;
    claimId: string;
    outcome: "executed" | "not_executed" | "inconclusive";
    reconciliationRef: string;
    recoveredAmountCents?: number | null;
    now: string;
  },
): Promise<ServiceCostRecoveryClaimRecord> {
  const current = await getCostRecoveryClaim(env, input);
  if (!current) throw new Error("service_cost_recovery_claim_not_found");
  const recoveredAmount =
    input.outcome === "executed"
      ? requiredRecoveredAmount(input.recoveredAmountCents)
      : null;
  if (current.state === "reconciled") {
    if (
      current.reconciliation_outcome === input.outcome &&
      current.reconciliation_ref === input.reconciliationRef &&
      current.recovered_amount_cents === recoveredAmount
    ) {
      return current;
    }
    throw new Error("service_cost_recovery_reconcile_conflict");
  }
  if (current.state !== "uncertain") {
    throw new Error("service_cost_recovery_reconcile_conflict");
  }

  const reconciled = await env.DB.prepare(
    `UPDATE service_cost_recovery_claims
     SET state = 'reconciled', reconciled_at = ?, reconciliation_outcome = ?,
         reconciliation_ref = ?, recovered_amount_cents = ?, updated_at = ?
     WHERE tenant_id = ? AND claim_id = ? AND state = 'uncertain'
     RETURNING claim_id`,
  ).bind(
    input.now,
    input.outcome,
    input.reconciliationRef,
    recoveredAmount,
    input.now,
    input.tenantId,
    input.claimId,
  ).first<{ claim_id: string }>();
  if (!reconciled) throw new Error("service_cost_recovery_reconcile_conflict");
  return requireClaim(env, input.claimId);
}

function requiredRecoveredAmount(value: number | null | undefined): number {
  if (
    value === undefined ||
    value === null ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100_000_000
  ) {
    throw new Error("service_cost_recovery_recovered_amount_invalid");
  }
  return value;
}

export async function getCostRecoveryClaim(
  env: AppEnv,
  input: { tenantId: string; claimId: string },
): Promise<ServiceCostRecoveryClaimRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM service_cost_recovery_claims WHERE tenant_id = ? AND claim_id = ? LIMIT 1`,
  ).bind(input.tenantId, input.claimId).first<ServiceCostRecoveryClaimRecord>();
  return row ?? null;
}

export async function listServiceCaseEvents(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseEventRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM service_case_events
     WHERE tenant_id = ? AND service_case_id = ?
     ORDER BY event_id ASC`,
  ).bind(input.tenantId, input.serviceCaseId).all<ServiceCaseEventRecord>();
  return results ?? [];
}

export interface ServiceCaseCostSummary {
  warranty_reserve_cents: number;
  actual_cost_cents: number;
  recovered_cents: number;
  /** Cost the business actually carried once recovery settled: never below zero. */
  net_cost_cents: number;
  recurrence_count: number;
}

/**
 * The learning feed. Reserve, actual cost, and settled recovery are read back from the same rows
 * the lifecycle wrote, so audit and estimate learning consume measured cost rather than an
 * estimate of it. `recurrence_count` counts prior closed cases with the same root cause on the
 * same job.
 */
export async function summarizeServiceCaseCost(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseCostSummary> {
  const totals = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(warranty_reserve_cents) FROM service_case_diagnoses
                 WHERE tenant_id = ? AND service_case_id = ?), 0) AS warranty_reserve_cents,
       COALESCE((SELECT SUM(cost_actual_cents) FROM service_case_remedies
                 WHERE tenant_id = ? AND service_case_id = ?), 0) AS actual_cost_cents,
       COALESCE((SELECT SUM(recovered_amount_cents) FROM service_cost_recovery_claims
                 WHERE tenant_id = ? AND service_case_id = ?
                   AND state IN ('succeeded', 'reconciled')), 0) AS recovered_cents`,
  ).bind(
    input.tenantId, input.serviceCaseId,
    input.tenantId, input.serviceCaseId,
    input.tenantId, input.serviceCaseId,
  ).first<{
    warranty_reserve_cents: number;
    actual_cost_cents: number;
    recovered_cents: number;
  }>();
  const recurrence = await env.DB.prepare(
    `SELECT COUNT(*) AS recurrence_count
     FROM service_case_diagnoses diagnosis
     INNER JOIN service_cases owner ON owner.service_case_id = diagnosis.service_case_id
     WHERE diagnosis.tenant_id = ?
       AND diagnosis.service_case_id != ?
       AND owner.roof_job_id = (SELECT roof_job_id FROM service_cases WHERE service_case_id = ?)
       AND diagnosis.root_cause_code IN (
         SELECT root_cause_code FROM service_case_diagnoses
         WHERE tenant_id = ? AND service_case_id = ?
       )`,
  ).bind(
    input.tenantId,
    input.serviceCaseId,
    input.serviceCaseId,
    input.tenantId,
    input.serviceCaseId,
  ).first<{ recurrence_count: number }>();

  const reserve = Number(totals?.warranty_reserve_cents ?? 0);
  const actual = Number(totals?.actual_cost_cents ?? 0);
  const recovered = Number(totals?.recovered_cents ?? 0);
  return {
    warranty_reserve_cents: reserve,
    actual_cost_cents: actual,
    recovered_cents: recovered,
    net_cost_cents: Math.max(0, actual - recovered),
    recurrence_count: Number(recurrence?.recurrence_count ?? 0),
  };
}

async function requireCase(
  env: AppEnv,
  tenantId: string,
  serviceCaseId: string,
): Promise<ServiceCaseRecord> {
  const found = await getServiceCase(env, { tenantId, serviceCaseId });
  if (!found) throw new Error("service_case_not_found");
  return found;
}

/**
 * The office queue. Live callbacks come first and are ordered by how soon their response is due,
 * because the response window is the only thing on a service case that expires.
 */
export async function listServiceCases(
  env: AppEnv,
  input: { tenantId: string; limit: number; openOnly?: boolean },
): Promise<ServiceCaseRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 200);
  const { results } = await env.DB.prepare(
    `${SELECT_CASE}
     WHERE tenant_id = ?${input.openOnly ? " AND state != 'closed'" : ""}
     ORDER BY (state = 'closed') ASC, response_due_at ASC, created_at ASC
     LIMIT ?`,
  ).bind(input.tenantId, limit).all<ServiceCaseRecord>();
  return results ?? [];
}

export async function listServiceCaseTriage(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseTriageRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM service_case_triage
     WHERE tenant_id = ? AND service_case_id = ?
     ORDER BY case_version ASC`,
  ).bind(input.tenantId, input.serviceCaseId).all<ServiceCaseTriageRecord>();
  return results ?? [];
}

export async function listServiceCaseDiagnoses(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseDiagnosisRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM service_case_diagnoses
     WHERE tenant_id = ? AND service_case_id = ?
     ORDER BY case_version ASC`,
  ).bind(input.tenantId, input.serviceCaseId).all<ServiceCaseDiagnosisRecord>();
  return results ?? [];
}

export async function listServiceCaseRemedies(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCaseRemedyRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM service_case_remedies
     WHERE tenant_id = ? AND service_case_id = ?
     ORDER BY case_version ASC, created_at ASC`,
  ).bind(input.tenantId, input.serviceCaseId).all<ServiceCaseRemedyRecord>();
  return results ?? [];
}

export async function listCostRecoveryClaims(
  env: AppEnv,
  input: { tenantId: string; serviceCaseId: string },
): Promise<ServiceCostRecoveryClaimRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM service_cost_recovery_claims
     WHERE tenant_id = ? AND service_case_id = ?
     ORDER BY created_at ASC, claim_id ASC`,
  ).bind(input.tenantId, input.serviceCaseId).all<ServiceCostRecoveryClaimRecord>();
  return results ?? [];
}

async function requireDiagnosis(
  env: AppEnv,
  tenantId: string,
  diagnosisId: string,
): Promise<ServiceCaseDiagnosisRecord> {
  const row = await env.DB.prepare(
    `SELECT * FROM service_case_diagnoses WHERE tenant_id = ? AND diagnosis_id = ? LIMIT 1`,
  ).bind(tenantId, diagnosisId).first<ServiceCaseDiagnosisRecord>();
  if (!row) throw new Error("service_case_diagnosis_not_found");
  return row;
}

async function requireRemedy(env: AppEnv, remedyId: string): Promise<ServiceCaseRemedyRecord> {
  const row = await env.DB.prepare(
    `SELECT * FROM service_case_remedies WHERE remedy_id = ? LIMIT 1`,
  ).bind(remedyId).first<ServiceCaseRemedyRecord>();
  if (!row) throw new Error("service_case_remedy_not_found");
  return row;
}

async function requireClaim(env: AppEnv, claimId: string): Promise<ServiceCostRecoveryClaimRecord> {
  const row = await env.DB.prepare(
    `SELECT * FROM service_cost_recovery_claims WHERE claim_id = ? LIMIT 1`,
  ).bind(claimId).first<ServiceCostRecoveryClaimRecord>();
  if (!row) throw new Error("service_cost_recovery_claim_not_found");
  return row;
}
