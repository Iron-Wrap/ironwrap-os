import type { AppEnv } from "./app-types.ts";

export const GOVERNED_TRANSITION_OUTBOX_STATES = [
  "pending",
  "leased",
  "succeeded",
  "failed",
  "audit_failed",
  "uncertain",
  "reconciled",
] as const;

export type GovernedTransitionOutboxState = (typeof GOVERNED_TRANSITION_OUTBOX_STATES)[number];
export type GovernedTransitionOutboxTerminalState = Exclude<GovernedTransitionOutboxState, "pending" | "leased">;
export type GovernedTransitionOutboxAttemptMode = "none" | "leased" | "inferred_terminal";

export interface GovernedTransitionOutboxRecord {
  outbox_id: string;
  transition_id: string;
  tenant_id: string;
  approval_request_id: string;
  request_kind: "lead_triage";
  outbox_kind: "approval_execution_dispatch";
  decision_idempotency_key: string;
  state: GovernedTransitionOutboxState;
  due_at: string;
  lease_ref: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  attempt_mode: GovernedTransitionOutboxAttemptMode;
  attempted_at: string | null;
  result_ref: string | null;
  result_code: string | null;
  reconciled_at: string | null;
  reconciliation_outcome: "executed" | "not_executed" | "inconclusive" | null;
  reconciliation_ref: string | null;
  created_at: string;
  updated_at: string;
}

export type ClaimGovernedTransitionOutboxResult =
  | { kind: "claimed"; outbox: GovernedTransitionOutboxRecord }
  | { kind: "already_leased"; outbox: GovernedTransitionOutboxRecord }
  | { kind: "terminal"; outbox: GovernedTransitionOutboxRecord }
  | { kind: "missing" };

export type ClaimNextPendingGovernedTransitionOutboxResult =
  | { kind: "claimed"; outbox: GovernedTransitionOutboxRecord }
  | { kind: "empty" };

export function governedApprovalExecutionOutboxId(approvalRequestId: string): string {
  return `approval-exec:${approvalRequestId}`;
}

export async function getGovernedTransitionOutbox(
  env: AppEnv,
  input: { tenantId: string; approvalRequestId: string; decisionIdempotencyKey: string },
): Promise<GovernedTransitionOutboxRecord | null> {
  const row = await env.DB.prepare(
    `${selectGovernedTransitionOutboxSql}
     WHERE tenant_id = ? AND approval_request_id = ? AND decision_idempotency_key = ?
     LIMIT 1`,
  ).bind(input.tenantId, input.approvalRequestId, input.decisionIdempotencyKey).first<GovernedTransitionOutboxRecord>();
  return row ? normalizeGovernedTransitionOutbox(row) : null;
}

/**
 * Claims the one durable, never-attempted approval execution intent. The
 * pending-to-leased D1 trigger refreshes the corresponding approval lease in
 * the same transaction, so recovery can resume only a proven no-attempt gap.
 */
export async function claimGovernedTransitionOutbox(
  env: AppEnv,
  input: {
    tenantId: string;
    approvalRequestId: string;
    decisionIdempotencyKey: string;
    now: string;
    leaseExpiresAt: string;
  },
): Promise<ClaimGovernedTransitionOutboxResult> {
  const current = await getGovernedTransitionOutbox(env, input);
  if (!current) return { kind: "missing" };
  if (current.state === "leased") return { kind: "already_leased", outbox: current };
  if (isTerminal(current.state)) return { kind: "terminal", outbox: current };

  const result = await env.DB.prepare(
    `UPDATE governed_transition_outbox
     SET state = 'leased', lease_ref = decision_idempotency_key, lease_expires_at = ?,
         attempt_count = attempt_count + 1, attempt_mode = 'leased', attempted_at = ?, updated_at = ?
     WHERE tenant_id = ? AND approval_request_id = ? AND decision_idempotency_key = ?
       AND state = 'pending' AND attempt_count = 0 AND attempt_mode = 'none' AND due_at <= ?
       AND EXISTS (
         SELECT 1 FROM approval_requests
         WHERE approval_requests.tenant_id = governed_transition_outbox.tenant_id
           AND approval_requests.approval_request_id = governed_transition_outbox.approval_request_id
           AND approval_requests.state = 'executing'
           AND approval_requests.decision_idempotency_key = governed_transition_outbox.decision_idempotency_key
       )`,
  ).bind(
    input.leaseExpiresAt,
    input.now,
    input.now,
    input.tenantId,
    input.approvalRequestId,
    input.decisionIdempotencyKey,
    input.now,
  ).run();
  if (d1Changes(result) >= 1) {
    const claimed = await getGovernedTransitionOutbox(env, input);
    if (!claimed) throw new Error("governed_transition_outbox_claim_missing");
    return { kind: "claimed", outbox: claimed };
  }

  const latest = await getGovernedTransitionOutbox(env, input);
  if (!latest) return { kind: "missing" };
  if (latest.state === "leased") return { kind: "already_leased", outbox: latest };
  if (isTerminal(latest.state)) return { kind: "terminal", outbox: latest };
  return { kind: "missing" };
}

/**
 * Claims at most one eligible, never-attempted intent for a tenant. It never
 * reclaims a lease or retries uncertain/terminal work.
 */
export async function claimNextPendingGovernedTransitionOutbox(
  env: AppEnv,
  input: { tenantId: string; now: string; leaseExpiresAt: string },
): Promise<ClaimNextPendingGovernedTransitionOutboxResult> {
  const next = await env.DB.prepare(
    `${selectGovernedTransitionOutboxSql}
     WHERE tenant_id = ? AND request_kind = 'lead_triage' AND state = 'pending' AND due_at <= ?
       AND attempt_count = 0 AND attempt_mode = 'none'
       AND EXISTS (
         SELECT 1 FROM approval_requests
         WHERE approval_requests.tenant_id = governed_transition_outbox.tenant_id
           AND approval_requests.approval_request_id = governed_transition_outbox.approval_request_id
           AND approval_requests.state = 'executing'
           AND approval_requests.decision_idempotency_key = governed_transition_outbox.decision_idempotency_key
       )
     ORDER BY due_at ASC, outbox_id ASC
     LIMIT 1`,
  ).bind(input.tenantId, input.now).first<GovernedTransitionOutboxRecord>();
  if (!next) return { kind: "empty" };

  const claimed = await claimGovernedTransitionOutbox(env, {
    tenantId: input.tenantId,
    approvalRequestId: next.approval_request_id,
    decisionIdempotencyKey: next.decision_idempotency_key,
    now: input.now,
    leaseExpiresAt: input.leaseExpiresAt,
  });
  return claimed.kind === "claimed" ? claimed : { kind: "empty" };
}

const selectGovernedTransitionOutboxSql = `SELECT
  outbox_id, transition_id, tenant_id, approval_request_id, request_kind, outbox_kind,
  decision_idempotency_key, state, due_at, lease_ref, lease_expires_at, attempt_count,
  attempt_mode, attempted_at, result_ref, result_code, reconciled_at, reconciliation_outcome,
  reconciliation_ref, created_at, updated_at
FROM governed_transition_outbox`;

function isTerminal(state: GovernedTransitionOutboxState): state is GovernedTransitionOutboxTerminalState {
  return state !== "pending" && state !== "leased";
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function normalizeGovernedTransitionOutbox(row: GovernedTransitionOutboxRecord): GovernedTransitionOutboxRecord {
  const state = GOVERNED_TRANSITION_OUTBOX_STATES.includes(row.state as GovernedTransitionOutboxState)
    ? row.state as GovernedTransitionOutboxState
    : "uncertain";
  return {
    ...row,
    request_kind: "lead_triage",
    outbox_kind: "approval_execution_dispatch",
    state,
    attempt_count: Number(row.attempt_count),
    attempt_mode: row.attempt_mode === "leased" || row.attempt_mode === "inferred_terminal"
      ? row.attempt_mode
      : "none",
    lease_ref: nullableText(row.lease_ref),
    lease_expires_at: nullableText(row.lease_expires_at),
    attempted_at: nullableText(row.attempted_at),
    result_ref: nullableText(row.result_ref),
    result_code: nullableText(row.result_code),
    reconciled_at: nullableText(row.reconciled_at),
    reconciliation_outcome: row.reconciliation_outcome === "executed" || row.reconciliation_outcome === "not_executed" ||
        row.reconciliation_outcome === "inconclusive"
      ? row.reconciliation_outcome
      : null,
    reconciliation_ref: nullableText(row.reconciliation_ref),
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
