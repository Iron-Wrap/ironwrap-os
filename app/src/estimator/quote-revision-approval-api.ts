import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  quoteRevisionApprovalDetailResponseSchema,
  quoteRevisionApprovalListResponseSchema,
  quoteRevisionApprovalMutationResponseSchema,
  quoteRevisionApprovalPreparationInputSchema,
  type QuoteRevisionApprovalDetailResponse,
  type QuoteRevisionApprovalListResponse,
  type QuoteRevisionApprovalMutationResponse,
  type QuoteRevisionApprovalPreparationInput,
} from "./quote-revision-approval-contracts";

export async function loadQuoteRevisionApprovals(
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalListResponse> {
  return await apiRequest({
    path: API_PATHS.quoteRevisionApprovals,
    schema: quoteRevisionApprovalListResponseSchema,
    fetcher,
  });
}

export async function loadQuoteRevisionApproval(
  approvalId: string,
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalDetailResponse> {
  return await apiRequest({
    path: API_PATHS.quoteRevisionApproval(approvalId),
    schema: quoteRevisionApprovalDetailResponseSchema,
    fetcher,
  });
}

export async function prepareQuoteRevisionApproval(
  session: AuthenticatedSession,
  input: QuoteRevisionApprovalPreparationInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalMutationResponse> {
  const prepared = quoteRevisionApprovalPreparationInputSchema.parse(input);
  return await apiRequest({
    path: API_PATHS.quoteRevisionApprovals,
    schema: quoteRevisionApprovalMutationResponseSchema,
    method: "POST",
    body: {
      roof_job_id: prepared.roofJobId,
      customer_quote_id: prepared.customerQuoteId,
      correction_reason: prepared.correctionReason,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approveQuoteRevisionApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.quoteRevisionApprovalApprove(approvalId),
    schema: quoteRevisionApprovalMutationResponseSchema,
    method: "POST",
    body: { version },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function rejectQuoteRevisionApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.quoteRevisionApprovalReject(approvalId),
    schema: quoteRevisionApprovalMutationResponseSchema,
    method: "POST",
    body: { version, reason },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function reconcileQuoteRevisionApproval(
  session: AuthenticatedSession,
  approvalId: string,
  version: number,
  outcome: "executed" | "not_executed" | "inconclusive",
  evidence: string,
  fetcher: typeof fetch = fetch,
): Promise<QuoteRevisionApprovalMutationResponse> {
  return await apiRequest({
    path: API_PATHS.quoteRevisionApprovalReconcile(approvalId),
    schema: quoteRevisionApprovalMutationResponseSchema,
    method: "POST",
    body: { version, outcome, evidence },
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export function newQuoteRevisionApprovalPrepareKey(): string {
  return `quote-revision-approval:prepare:${crypto.randomUUID()}`;
}

export function newQuoteRevisionApprovalDecisionKey(): string {
  return `quote-revision-approval:decision:${crypto.randomUUID()}`;
}
