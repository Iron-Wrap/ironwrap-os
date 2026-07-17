import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  productionScheduleApprovalDetailResponseSchema,
  productionScheduleApprovalListResponseSchema,
  productionScheduleApprovalMutationResponseSchema,
  productionScheduleApprovalPreparationInputSchema,
  type ProductionScheduleApprovalDetailResponse,
  type ProductionScheduleApprovalListResponse,
  type ProductionScheduleApprovalMutationResponse,
  type ProductionScheduleApprovalPreparationInput,
} from "./production-schedule-approval-contracts";

export async function loadProductionScheduleApprovals(
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalListResponse> {
  return await apiRequest({
    path: API_PATHS.productionScheduleApprovals,
    schema: productionScheduleApprovalListResponseSchema,
    fetcher,
  });
}

export async function loadProductionScheduleApproval(
  approvalId: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalDetailResponse> {
  return await apiRequest({
    path: API_PATHS.productionScheduleApproval(approvalId),
    schema: productionScheduleApprovalDetailResponseSchema,
    fetcher,
  });
}

export async function prepareProductionScheduleApproval(
  session: AuthenticatedSession,
  input: ProductionScheduleApprovalPreparationInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalMutationResponse> {
  const prepared = productionScheduleApprovalPreparationInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.productionScheduleApprovals,
    schema: productionScheduleApprovalMutationResponseSchema,
    method: "POST",
    body: {
      roof_job_id: prepared.roofJobId,
      crew_profile_id: prepared.crewProfileId,
      scheduled_start: prepared.scheduledStart,
      scheduled_end: prepared.scheduledEnd ?? null,
      supersedes_assignment_id: prepared.supersedesAssignmentId ?? null,
      correction_reason: prepared.correctionReason ?? null,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approveProductionScheduleApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.productionScheduleApprovalApprove(approvalId),
    schema: productionScheduleApprovalMutationResponseSchema,
    method: "POST",
    body: { version },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function rejectProductionScheduleApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.productionScheduleApprovalReject(approvalId),
    schema: productionScheduleApprovalMutationResponseSchema,
    method: "POST",
    body: { version, reason },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function reconcileProductionScheduleApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  outcome: "executed" | "not_executed" | "inconclusive",
  evidence: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionScheduleApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.productionScheduleApprovalReconcile(approvalId),
    schema: productionScheduleApprovalMutationResponseSchema,
    method: "POST",
    body: { version, outcome, evidence },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export function newProductionScheduleApprovalPrepareKey(): string {
  return `production-schedule-approval:prepare:${crypto.randomUUID()}`;
}

export function newProductionScheduleApprovalDecisionKey(): string {
  return `production-schedule-approval:decision:${crypto.randomUUID()}`;
}
