import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  approvalListResponseSchema,
  approvalMutationResponseSchema,
  leadTriageApprovalPreparationInputSchema,
  type ApprovalListResponse,
  type ApprovalMutationResponse,
  type LeadTriageApprovalPreparationInput,
} from "./approval-contracts";

export async function loadApprovals(fetcher: typeof fetch = fetch): Promise<ApprovalListResponse> {
  return await apiRequest({
    path: API_PATHS.approvals,
    schema: approvalListResponseSchema,
    fetcher,
  });
}

export async function prepareLeadTriageApproval(
  session: AuthenticatedSession,
  input: LeadTriageApprovalPreparationInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovalMutationResponse> {
  const prepared = leadTriageApprovalPreparationInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.approvalLeadTriagePrepare,
    schema: approvalMutationResponseSchema,
    method: "POST",
    body: {
      lead_envelope_id: prepared.leadEnvelopeId,
      triage_summary: prepared.triageSummary,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approveApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.approvalApprove(approvalId),
    schema: approvalMutationResponseSchema,
    method: "POST",
    body: { version },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function rejectApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.approvalReject(approvalId),
    schema: approvalMutationResponseSchema,
    method: "POST",
    body: { version, reason },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function reconcileApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  outcome: "executed" | "not_executed" | "inconclusive",
  evidence: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.approvalReconcile(approvalId),
    schema: approvalMutationResponseSchema,
    method: "POST",
    body: { version, outcome, evidence },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export function newApprovalDecisionKey(): string {
  return `approval:${crypto.randomUUID()}`;
}

export function newLeadTriageApprovalPrepareKey(): string {
  return `lead-triage-approval:prepare:${crypto.randomUUID()}`;
}
