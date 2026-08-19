import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  costRecoveryMutationResponseSchema,
  serviceCaseDetailResponseSchema,
  serviceCaseIntakeInputSchema,
  serviceCaseIntakeResponseSchema,
  serviceCaseListResponseSchema,
  serviceCaseMutationResponseSchema,
  serviceDiagnosisResponseSchema,
  serviceRemedyResponseSchema,
  serviceTriageResponseSchema,
  type CostRecoveryMutationResponse,
  type ServiceCaseDetailResponse,
  type ServiceCaseIntakeInput,
  type ServiceCaseIntakeResponse,
  type ServiceCaseListResponse,
  type ServiceCaseMutationResponse,
  type ServiceDiagnosisResponse,
  type ServiceRemedyResponse,
  type ServiceTriageResponse,
} from "./service-contracts";

// No identifier is minted here. The bus mints the case, triage, diagnosis, remedy, and claim ids
// and attributes every decision to the authenticated session, so these calls carry facts only.

export async function loadServiceCases(
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseListResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCases,
    schema: serviceCaseListResponseSchema,
    fetcher,
  });
}

export async function loadServiceCase(
  caseId: string,
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseDetailResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCase(caseId),
    schema: serviceCaseDetailResponseSchema,
    fetcher,
  });
}

export async function openServiceCase(
  session: AuthenticatedSession,
  input: ServiceCaseIntakeInput,
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseIntakeResponse> {
  const intake = serviceCaseIntakeInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.serviceCases,
    schema: serviceCaseIntakeResponseSchema,
    method: "POST",
    body: {
      customer_id: intake.customerId,
      property_key: intake.propertyKey,
      roof_job_id: intake.roofJobId,
      warranty_packet_id: intake.warrantyPacketId ?? null,
      severity: intake.severity,
      symptom_code: intake.symptomCode,
      reported_channel: intake.reportedChannel,
      consent_ref: intake.consentRef,
      intake_evidence_digest: intake.intakeEvidenceDigest,
      response_sla_minutes: intake.responseSlaMinutes,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function recordServiceTriage(
  session: AuthenticatedSession,
  caseId: string,
  input: {
    advisorySource: "model" | "rule" | "none";
    advisoryCategory?: string | null;
    advisoryConfidenceBps?: number | null;
    finalCategory: string;
    responsibility: string;
    evidenceDigest: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ServiceTriageResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseTriage(caseId),
    schema: serviceTriageResponseSchema,
    method: "POST",
    body: {
      advisory_source: input.advisorySource,
      advisory_category: input.advisoryCategory ?? null,
      advisory_confidence_bps: input.advisoryConfidenceBps ?? null,
      final_category: input.finalCategory,
      responsibility: input.responsibility,
      evidence_digest: input.evidenceDigest,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function recordServiceDiagnosis(
  session: AuthenticatedSession,
  caseId: string,
  input: {
    rootCauseCode: string;
    correctiveActionCode: string;
    workPackageRef: string;
    workPackageVersion: number;
    warrantyReserveCents: number;
    evidenceDigest: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ServiceDiagnosisResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseDiagnoses(caseId),
    schema: serviceDiagnosisResponseSchema,
    method: "POST",
    body: {
      root_cause_code: input.rootCauseCode,
      corrective_action_code: input.correctiveActionCode,
      work_package_ref: input.workPackageRef,
      work_package_version: input.workPackageVersion,
      warranty_reserve_cents: input.warrantyReserveCents,
      evidence_digest: input.evidenceDigest,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function issueServiceRemedy(
  session: AuthenticatedSession,
  caseId: string,
  input: { scheduledStartAt: string; scheduledEndAt: string; partsManifestDigest: string },
  fetcher: typeof fetch = fetch,
): Promise<ServiceRemedyResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseRemedies(caseId),
    schema: serviceRemedyResponseSchema,
    method: "POST",
    body: {
      scheduled_start_at: input.scheduledStartAt,
      scheduled_end_at: input.scheduledEndAt,
      parts_manifest_digest: input.partsManifestDigest,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function verifyServiceRemedy(
  session: AuthenticatedSession,
  caseId: string,
  remedyId: string,
  input: {
    outcome: "verified" | "failed";
    fieldEvidenceDigest: string;
    costActualCents: number;
    failureCode?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<ServiceRemedyResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseRemedyVerification(caseId, remedyId),
    schema: serviceRemedyResponseSchema,
    method: "POST",
    body: {
      outcome: input.outcome,
      field_evidence_digest: input.fieldEvidenceDigest,
      cost_actual_cents: input.costActualCents,
      failure_code: input.failureCode ?? null,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function recordCustomerServiceDecision(
  session: AuthenticatedSession,
  caseId: string,
  remedyId: string,
  input: {
    decision: "accepted" | "disputed";
    acceptanceRef?: string | null;
    disputeCode?: string | null;
    evidenceDigest: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ServiceRemedyResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseCustomerDecision(caseId, remedyId),
    schema: serviceRemedyResponseSchema,
    method: "POST",
    body: {
      decision: input.decision,
      acceptance_ref: input.acceptanceRef ?? null,
      dispute_code: input.disputeCode ?? null,
      evidence_digest: input.evidenceDigest,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function closeServiceCase(
  session: AuthenticatedSession,
  caseId: string,
  input: { closureReason: string; detailCode?: string | null; evidenceDigest?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseMutationResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseClosure(caseId),
    schema: serviceCaseMutationResponseSchema,
    method: "POST",
    body: {
      closure_reason: input.closureReason,
      detail_code: input.detailCode ?? null,
      evidence_digest: input.evidenceDigest ?? null,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function reopenServiceCase(
  session: AuthenticatedSession,
  caseId: string,
  reopenCode: string,
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseMutationResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseReopen(caseId),
    schema: serviceCaseMutationResponseSchema,
    method: "POST",
    body: { reopen_code: reopenCode },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function openCostRecoveryClaim(
  session: AuthenticatedSession,
  caseId: string,
  input: {
    counterpartyKind: "supplier" | "manufacturer" | "insurer";
    counterpartyRef: string;
    claimBasisCode: string;
    claimedAmountCents: number;
    evidenceDigest: string;
    deadlineAt: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<CostRecoveryMutationResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseCostRecoveryClaims(caseId),
    schema: costRecoveryMutationResponseSchema,
    method: "POST",
    body: {
      counterparty_kind: input.counterpartyKind,
      counterparty_ref: input.counterpartyRef,
      claim_basis_code: input.claimBasisCode,
      claimed_amount_cents: input.claimedAmountCents,
      evidence_digest: input.evidenceDigest,
      deadline_at: input.deadlineAt,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function reconcileCostRecoveryClaim(
  session: AuthenticatedSession,
  caseId: string,
  claimId: string,
  input: {
    outcome: "executed" | "not_executed" | "inconclusive";
    reconciliationRef: string;
    recoveredAmountCents?: number | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<CostRecoveryMutationResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseCostRecoveryReconcile(caseId, claimId),
    schema: costRecoveryMutationResponseSchema,
    method: "POST",
    body: {
      outcome: input.outcome,
      reconciliation_ref: input.reconciliationRef,
      recovered_amount_cents: input.recoveredAmountCents ?? null,
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}
