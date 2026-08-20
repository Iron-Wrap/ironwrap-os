import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  proposalPublicationApprovalDetailResponseSchema,
  proposalPublicationApprovalListResponseSchema,
  proposalPublicationApprovalMutationResponseSchema,
  proposalPublicationPreparationInputSchema,
  type ProposalPublicationApprovalDetailResponse,
  type ProposalPublicationApprovalListResponse,
  type ProposalPublicationApprovalMutationResponse,
  type ProposalPublicationPreparationInput,
} from "./proposal-publication-contracts";

export async function loadProposalPublicationApprovals(
  roofJobId?: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalListResponse> {
  return await apiRequest({
    path: roofJobId
      ? `${API_PATHS.proposalPublicationApprovals}?roof_job_id=${encodeURIComponent(roofJobId)}`
      : API_PATHS.proposalPublicationApprovals,
    schema: proposalPublicationApprovalListResponseSchema,
    fetcher,
  });
}

export async function loadProposalPublicationApproval(
  approvalId: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalDetailResponse> {
  return await apiRequest({
    path: API_PATHS.proposalPublicationApproval(approvalId),
    schema: proposalPublicationApprovalDetailResponseSchema,
    fetcher,
  });
}

export async function prepareProposalPublication(
  session: AuthenticatedSession,
  input: ProposalPublicationPreparationInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalMutationResponse> {
  const prepared = proposalPublicationPreparationInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.proposalPublicationApprovals,
    schema: proposalPublicationApprovalMutationResponseSchema,
    method: "POST",
    body: {
      roof_job_id: prepared.roofJobId,
      proposal_evidence_pack_id: prepared.proposalEvidencePackId,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approveProposalPublication(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.proposalPublicationApprovalApprove(approvalId),
    schema: proposalPublicationApprovalMutationResponseSchema,
    method: "POST",
    body: { version },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function rejectProposalPublication(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.proposalPublicationApprovalReject(approvalId),
    schema: proposalPublicationApprovalMutationResponseSchema,
    method: "POST",
    body: { version, reason },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function reconcileProposalPublication(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  outcome: "executed" | "not_executed" | "inconclusive",
  evidence: string,
  fetcher: typeof fetch = fetch,
): Promise<ProposalPublicationApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.proposalPublicationApprovalReconcile(approvalId),
    schema: proposalPublicationApprovalMutationResponseSchema,
    method: "POST",
    body: { version, outcome, evidence },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export function newProposalPublicationPrepareKey(): string {
  return `proposal-publication:prepare:${crypto.randomUUID()}`;
}

export function newProposalPublicationDecisionKey(): string {
  return `proposal-publication:decision:${crypto.randomUUID()}`;
}
