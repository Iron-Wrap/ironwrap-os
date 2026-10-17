import type { AuthenticatedSession } from "../auth/session";
import { evidenceReceiptIdsField } from "../evidence/evidence-types";
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
// The one exception is the intake's `Idempotency-Key`: it is chosen before any file is uploaded,
// because each file is scoped to it, and the same key is sent with the request.
//
// Every step that needs evidence carries the receipt ids of files uploaded for exactly that step
// (`evidence_receipt_ids`), and the bus derives what it stores. The case page that still types a
// digest sends it under the step's own field instead, which the bus accepts while receipts are not
// required. The bus refuses a digest beside receipt ids, so a step sends one or the other.

/** The receipt ids of the files uploaded for exactly this step. */
type StepFiles = { evidenceReceiptIds: readonly string[] };

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

/**
 * Opens one service call. Files that show the problem are uploaded first, scoped to `intakeKey`,
 * which goes up again as this request's `Idempotency-Key`; an intake with a typed digest instead
 * needs no key.
 */
export async function openServiceCase(
  session: AuthenticatedSession,
  input: ServiceCaseIntakeInput,
  intakeKey?: string,
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseIntakeResponse> {
  const intake = serviceCaseIntakeInputSchema.parse(input);
  if (intake.evidenceReceiptIds && !intakeKey) {
    throw new Error("An intake with files needs the key its files were uploaded under.");
  }
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
      response_sla_minutes: intake.responseSlaMinutes,
      ...(intake.evidenceReceiptIds
        ? evidenceReceiptIdsField(intake.evidenceReceiptIds)
        : { intake_evidence_digest: intake.intakeEvidenceDigest }),
    },
    csrfToken: session.csrf_token,
    idempotencyKey: intakeKey,
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
  } & (StepFiles | { evidenceDigest: string }),
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
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { evidence_digest: input.evidenceDigest }),
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
  } & (StepFiles | { evidenceDigest: string }),
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
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { evidence_digest: input.evidenceDigest }),
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function issueServiceRemedy(
  session: AuthenticatedSession,
  caseId: string,
  input: {
    scheduledStartAt: string;
    scheduledEndAt: string;
  } & (StepFiles | { partsManifestDigest: string }),
  fetcher: typeof fetch = fetch,
): Promise<ServiceRemedyResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseRemedies(caseId),
    schema: serviceRemedyResponseSchema,
    method: "POST",
    body: {
      scheduled_start_at: input.scheduledStartAt,
      scheduled_end_at: input.scheduledEndAt,
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { parts_manifest_digest: input.partsManifestDigest }),
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
    costActualCents: number;
    failureCode?: string | null;
  } & (StepFiles | { fieldEvidenceDigest: string }),
  fetcher: typeof fetch = fetch,
): Promise<ServiceRemedyResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseRemedyVerification(caseId, remedyId),
    schema: serviceRemedyResponseSchema,
    method: "POST",
    body: {
      outcome: input.outcome,
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { field_evidence_digest: input.fieldEvidenceDigest }),
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
  } & (StepFiles | { evidenceDigest: string }),
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
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { evidence_digest: input.evidenceDigest }),
    },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function closeServiceCase(
  session: AuthenticatedSession,
  caseId: string,
  input: {
    closureReason: string;
    detailCode?: string | null;
    /** Files are optional here; with none, no evidence field is sent at all. */
    evidenceReceiptIds?: readonly string[];
    /** A typed digest from the case page; never sent beside receipt ids. */
    evidenceDigest?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<ServiceCaseMutationResponse> {
  return await apiRequest({
    path: API_PATHS.serviceCaseClosure(caseId),
    schema: serviceCaseMutationResponseSchema,
    method: "POST",
    body: {
      closure_reason: input.closureReason,
      detail_code: input.detailCode ?? null,
      ...(input.evidenceReceiptIds?.length
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : input.evidenceDigest
          ? { evidence_digest: input.evidenceDigest }
          : {}),
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
    deadlineAt: string;
  } & (StepFiles | { evidenceDigest: string }),
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
      ...("evidenceReceiptIds" in input
        ? evidenceReceiptIdsField(input.evidenceReceiptIds)
        : { evidence_digest: input.evidenceDigest }),
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
