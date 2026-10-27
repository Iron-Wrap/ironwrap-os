import type { AuthenticatedSession } from "../../auth/session";
import { apiRequest } from "../../lib/api";
import { API_PATHS } from "../../lib/api-paths";
import {
  gateEntryResponseSchema,
  jobGatesResponseSchema,
  signedCopyQueueResponseSchema,
  signedCopyRecordResponseSchema,
  waiverDecisionResponseSchema,
  type AttestableGate,
  type GateAttestation,
  type GateEntryResponse,
  type GateName,
  type JobGatesResponse,
  type SignedCopyQueueResponse,
  type SignedCopyRecordResponse,
  type WaiverDecisionResponse,
} from "./gate-contracts";

/**
 * The office's calls for a job's gates and its cancellation window. Every write carries the CSRF
 * token and a fresh Idempotency-Key per attempt the person makes; the Worker answers an exact
 * replay as the first request did.
 */

export function jobGatesQueryKey(tenantId: string, userId: string, jobId: string) {
  return ["production-job-gates", tenantId, userId, jobId] as const;
}

export function signedCopyQueueQueryKey(tenantId: string, userId: string) {
  return ["production-signed-copy-missing", tenantId, userId] as const;
}

export async function loadJobGates(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<JobGatesResponse> {
  return await apiRequest({
    path: API_PATHS.productionJobGates(jobId),
    schema: jobGatesResponseSchema,
    fetcher,
  });
}

export function newGateKey(kind: string): string {
  return `production-gate-${kind}:${crypto.randomUUID()}`;
}

export async function attestGate(
  session: AuthenticatedSession,
  input: {
    jobId: string;
    gate: AttestableGate;
    expectedGateVersion: number;
    attestation: GateAttestation;
  },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<GateEntryResponse> {
  return await apiRequest({
    path: API_PATHS.productionGateClearance(input.jobId, input.gate),
    schema: gateEntryResponseSchema,
    method: "POST",
    body: {
      basis: "person_attestation",
      expected_gate_version: input.expectedGateVersion,
      attestation: input.attestation,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function decideWaiver(
  session: AuthenticatedSession,
  input: {
    jobId: string;
    gate: GateName;
    requestId: string;
    expectedGateVersion: number;
    decision: "approve" | "decline";
    reason: string;
  },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<WaiverDecisionResponse> {
  return await apiRequest({
    path: API_PATHS.productionGateWaiverDecision(input.jobId, input.gate),
    schema: waiverDecisionResponseSchema,
    method: "POST",
    body: {
      request_id: input.requestId,
      expected_gate_version: input.expectedGateVersion,
      decision: input.decision,
      reason: input.reason,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function reverseGate(
  session: AuthenticatedSession,
  input: {
    jobId: string;
    gate: GateName;
    expectedGateVersion: number;
    reversesId: string;
    reason: string;
  },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<GateEntryResponse> {
  return await apiRequest({
    path: API_PATHS.productionGateReversal(input.jobId, input.gate),
    schema: gateEntryResponseSchema,
    method: "POST",
    body: {
      expected_gate_version: input.expectedGateVersion,
      reverses_id: input.reversesId,
      reason: input.reason,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function recordSignedCopy(
  session: AuthenticatedSession,
  input: { jobId: string; receivedAt: string; reason: string; evidenceRef: string },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SignedCopyRecordResponse> {
  return await apiRequest({
    path: API_PATHS.productionSignedCopyRecord(input.jobId),
    schema: signedCopyRecordResponseSchema,
    method: "POST",
    body: {
      received_at: input.receivedAt,
      reason: input.reason,
      evidence_ref: input.evidenceRef,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function loadSignedCopyQueue(
  fetcher: typeof fetch = fetch,
): Promise<SignedCopyQueueResponse> {
  return await apiRequest({
    path: API_PATHS.productionSignedCopyMissing,
    schema: signedCopyQueueResponseSchema,
    fetcher,
  });
}
