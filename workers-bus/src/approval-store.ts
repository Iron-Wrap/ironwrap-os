import type { AppEnv } from "./app-types.ts";

export const APPROVAL_STATES = [
  "pending",
  "executing",
  "executed",
  "denied",
  "expired",
  "failed",
  "audit_failed",
  "execution_uncertain",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];
export type ApprovalRequestKind = "lead_triage";
export type ApprovalTransitionActorKind = "app_user" | "approval_broker" | "system";
export type ApprovalExecutionTerminalState = Extract<
  ApprovalState,
  "executed" | "failed" | "audit_failed" | "execution_uncertain"
>;

export interface ApprovalRequestRecord {
  approval_request_id: string;
  tenant_id: string;
  request_kind: ApprovalRequestKind;
  state: ApprovalState;
  version: number;
  prepare_idempotency_key: string;
  intent_fingerprint: string;
  write_tool: "request_mark_lead_triaged";
  dry_run_tool: "dry_run_mark_lead_triaged";
  agent_role: string;
  actor_user: string;
  site_id: string;
  target_doctype: "Lead Envelope";
  target_name: string;
  lead_envelope_id: string;
  request_text: string;
  write_args_json: string;
  preview_json: string;
  args_digest: string;
  preview_digest: string;
  dry_run_receipt: string;
  expires_at: string;
  requested_by_user_id: string;
  requested_by_frappe_user: string | null;
  approved_by_user_id: string | null;
  approved_by_frappe_user: string | null;
  approved_at: string | null;
  decision_idempotency_key: string | null;
  rejection_reason: string | null;
  run_id: string;
  execution_lease_expires_at: string | null;
  hermes_run_id: string | null;
  result_json: string | null;
  error_code: string | null;
  reconciled_at: string | null;
  reconciled_by_user_id: string | null;
  reconciled_by_frappe_user: string | null;
  reconciliation_outcome: "executed" | "not_executed" | "inconclusive" | null;
  reconciliation_evidence: string | null;
  transition_actor_kind: ApprovalTransitionActorKind;
  transition_actor_id: string | null;
  transition_actor_frappe_user: string | null;
  transition_detail_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApprovalRequestProjection {
  id: string;
  kind: ApprovalRequestKind;
  state: ApprovalState;
  version: number;
  action: "mark_lead_triaged";
  target: { doctype: "Lead Envelope"; name: string; lead_envelope_id: string };
  request_text: string;
  preview: LeadTriagePreview | null;
  expires_at: string;
  requested_by: { user_id: string; frappe_user: string | null };
  approved_by: { user_id: string; frappe_user: string; approved_at: string } | null;
  rejection_reason: string | null;
  run_id: string;
  hermes_run_id: string | null;
  outcome: LeadTriageOutcome | null;
  error_code: string | null;
  reconciliation: {
    at: string;
    by_user_id: string;
    by_frappe_user: string;
    outcome: "executed" | "not_executed" | "inconclusive";
    evidence: string;
  } | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface LeadTriagePreview {
  would_write: false;
  target: { doctype: "Lead Envelope"; name: string };
  before: {
    triage_status: string | null;
    triaged_by: string | null;
    triaged_at: string | null;
    triage_summary: string | null;
  };
  patch: {
    triage_status: "Triaged";
    triaged_by: string;
    triaged_at: string | null;
    triage_summary: string;
  };
  transport_status_unchanged: string | null;
  communication_events_mutated: false;
}

export interface LeadTriageOutcome {
  run_id: string;
  lead_envelope_id: string;
  updated: boolean;
  audit_finalized: boolean;
  replayed: boolean;
  communication_events_mutated: false;
}

export interface CreateApprovalRequestInput {
  id: string;
  tenantId: string;
  prepareIdempotencyKey: string;
  intentFingerprint: string;
  agentRole: string;
  actorUser: string;
  siteId: string;
  leadEnvelopeId: string;
  requestText: string;
  writeArgsJson: string;
  previewJson: string;
  argsDigest: string;
  previewDigest: string;
  dryRunReceipt: string;
  expiresAt: string;
  requestedByUserId: string;
  requestedByFrappeUser: string | null;
  runId: string;
  now: string;
}

export type CreateApprovalRequestResult =
  | { kind: "created"; request: ApprovalRequestRecord }
  | { kind: "replayed"; request: ApprovalRequestRecord }
  | { kind: "conflict"; request: ApprovalRequestRecord };

export type ClaimApprovalExecutionResult =
  | { kind: "claimed"; request: ApprovalRequestRecord }
  | { kind: "replayed"; request: ApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ApprovalRequestRecord }
  | { kind: "version_conflict"; request: ApprovalRequestRecord }
  | { kind: "already_decided"; request: ApprovalRequestRecord };

export type DenyApprovalRequestResult =
  | { kind: "denied"; request: ApprovalRequestRecord }
  | { kind: "replayed"; request: ApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ApprovalRequestRecord }
  | { kind: "version_conflict"; request: ApprovalRequestRecord }
  | { kind: "already_decided"; request: ApprovalRequestRecord };

export type FinalizeApprovalExecutionResult =
  | { kind: "finalized"; request: ApprovalRequestRecord }
  | { kind: "lost_claim"; request: ApprovalRequestRecord | null };

export type ReconcileApprovalUncertaintyResult =
  | { kind: "reconciled"; request: ApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "not_uncertain"; request: ApprovalRequestRecord }
  | { kind: "already_reconciled"; request: ApprovalRequestRecord }
  | { kind: "version_conflict"; request: ApprovalRequestRecord };

export async function createApprovalRequest(
  env: AppEnv,
  input: CreateApprovalRequestInput,
): Promise<CreateApprovalRequestResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO approval_requests (
       approval_request_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
       intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
       target_doctype, target_name, lead_envelope_id, request_text, write_args_json, preview_json,
       args_digest, preview_digest, dry_run_receipt, expires_at, requested_by_user_id,
       requested_by_frappe_user, run_id, transition_actor_kind, transition_actor_id,
       transition_actor_frappe_user, transition_detail_code, created_at, updated_at
     ) VALUES (
       ?,?, 'lead_triage', 'pending', 1, ?,
       ?, 'request_mark_lead_triaged', 'dry_run_mark_lead_triaged', ?,?,?,
       'Lead Envelope', ?,?,?,?, ?,
       ?,?,?,?,?, ?,
       ?, 'app_user', ?, ?, 'approval_prepared', ?, ?
     )
     ON CONFLICT(tenant_id, prepare_idempotency_key) DO NOTHING
     RETURNING approval_request_id`,
  ).bind(
    input.id,
    input.tenantId,
    input.prepareIdempotencyKey,
    input.intentFingerprint,
    input.agentRole,
    input.actorUser,
    input.siteId,
    input.leadEnvelopeId,
    input.leadEnvelopeId,
    input.requestText,
    input.writeArgsJson,
    input.previewJson,
    input.argsDigest,
    input.previewDigest,
    input.dryRunReceipt,
    input.expiresAt,
    input.requestedByUserId,
    input.requestedByFrappeUser,
    input.runId,
    input.requestedByUserId,
    input.requestedByFrappeUser,
    input.now,
    input.now,
  ).all<{ approval_request_id: string }>();

  const insertedId = inserted.results?.[0]?.approval_request_id;
  if (insertedId) {
    const request = await getApprovalRequest(env, input.tenantId, insertedId);
    if (!request) throw new Error("approval_request_insert_missing");
    return { kind: "created", request };
  }

  const existing = await findApprovalRequestByPrepareKey(env, input.tenantId, input.prepareIdempotencyKey);
  if (!existing) throw new Error("approval_request_idempotency_lookup_missing");
  return existing.intent_fingerprint === input.intentFingerprint
    ? { kind: "replayed", request: existing }
    : { kind: "conflict", request: existing };
}

export async function listApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  limit = 50,
): Promise<ApprovalRequestRecord[]> {
  await expirePendingApprovalRequests(env, tenantId, now);
  const result = await env.DB.prepare(
    `${selectApprovalRequestSql}
     WHERE tenant_id = ?
     ORDER BY
       CASE state WHEN 'pending' THEN 0 WHEN 'executing' THEN 1 WHEN 'execution_uncertain' THEN 2 ELSE 3 END,
       updated_at DESC, approval_request_id DESC
     LIMIT ?`,
  ).bind(tenantId, clampLimit(limit)).all<ApprovalRequestRecord>();
  return (result.results ?? []).map(normalizeApprovalRequest);
}

export async function getApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
): Promise<ApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectApprovalRequestSql} WHERE tenant_id = ? AND approval_request_id = ? LIMIT 1`,
  ).bind(tenantId, requestId).first<ApprovalRequestRecord>();
  return row ? normalizeApprovalRequest(row) : null;
}

export async function getApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ApprovalRequestRecord | null> {
  return await findApprovalRequestByPrepareKey(env, tenantId, prepareIdempotencyKey);
}

export function matchesApprovalPreparation(
  record: ApprovalRequestRecord,
  input: {
    requestedByUserId: string;
    leadEnvelopeId: string;
    triageSummary: string;
    requestText: string;
  },
): boolean {
  const args = parseObject(record.write_args_json);
  if (!args) return false;
  return record.requested_by_user_id === input.requestedByUserId &&
    record.lead_envelope_id === input.leadEnvelopeId &&
    record.request_text === input.requestText &&
    args.lead_envelope_id === input.leadEnvelopeId &&
    args.triage_summary === input.triageSummary &&
    args.request_text === input.requestText;
}

export async function getCurrentApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
  now: string,
): Promise<ApprovalRequestRecord | null> {
  await expirePendingApprovalRequests(env, tenantId, now, requestId);
  return await getApprovalRequest(env, tenantId, requestId);
}

export async function claimApprovalExecution(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    expectedVersion: number;
    decisionIdempotencyKey: string;
    approvedByUserId: string;
    approvedByFrappeUser: string;
    now: string;
    leaseExpiresAt: string;
  },
): Promise<ClaimApprovalExecutionResult> {
  await expirePendingApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE approval_requests
     SET state = 'executing', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, execution_lease_expires_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'approval_execute_claimed',
         updated_at = ?
     WHERE tenant_id = ? AND approval_request_id = ? AND state = 'pending'
       AND version = ? AND expires_at > ?`,
  ).bind(
    input.approvedByUserId,
    input.approvedByFrappeUser,
    input.now,
    input.decisionIdempotencyKey,
    input.leaseExpiresAt,
    input.approvedByUserId,
    input.approvedByFrappeUser,
    input.now,
    input.tenantId,
    input.requestId,
    input.expectedVersion,
    input.now,
  ).run();
  if (d1Changes(result) === 1) {
    const claimed = await getApprovalRequest(env, input.tenantId, input.requestId);
    if (!claimed) throw new Error("approval_request_claim_missing");
    return { kind: "claimed", request: claimed };
  }
  return await resolveClaimRace(env, input);
}

export async function denyApprovalRequest(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    expectedVersion: number;
    decisionIdempotencyKey: string;
    approvedByUserId: string;
    approvedByFrappeUser: string;
    rejectionReason: string;
    now: string;
  },
): Promise<DenyApprovalRequestResult> {
  await expirePendingApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE approval_requests
     SET state = 'denied', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, rejection_reason = ?, completed_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'approval_denied',
         updated_at = ?
     WHERE tenant_id = ? AND approval_request_id = ? AND state = 'pending'
       AND version = ? AND expires_at > ?`,
  ).bind(
    input.approvedByUserId,
    input.approvedByFrappeUser,
    input.now,
    input.decisionIdempotencyKey,
    input.rejectionReason,
    input.now,
    input.approvedByUserId,
    input.approvedByFrappeUser,
    input.now,
    input.tenantId,
    input.requestId,
    input.expectedVersion,
    input.now,
  ).run();
  if (d1Changes(result) === 1) {
    const denied = await getApprovalRequest(env, input.tenantId, input.requestId);
    if (!denied) throw new Error("approval_request_deny_missing");
    return { kind: "denied", request: denied };
  }
  const latest = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

export async function finalizeApprovalExecution(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    decisionIdempotencyKey: string;
    state: ApprovalExecutionTerminalState;
    hermesRunId?: string | null;
    resultJson?: string | null;
    errorCode?: string | null;
    now: string;
  },
): Promise<FinalizeApprovalExecutionResult> {
  const result = await env.DB.prepare(
    `UPDATE approval_requests
     SET state = ?, version = version + 1, hermes_run_id = ?, result_json = ?, error_code = ?,
         execution_lease_expires_at = NULL, completed_at = ?,
         transition_actor_kind = 'approval_broker', transition_actor_id = 'lead-triage-broker',
         transition_actor_frappe_user = NULL, transition_detail_code = ?, updated_at = ?
     WHERE tenant_id = ? AND approval_request_id = ? AND state = 'executing'
       AND decision_idempotency_key = ?`,
  ).bind(
    input.state,
    input.hermesRunId ?? null,
    input.resultJson ?? null,
    input.errorCode ?? null,
    input.now,
    terminalTransitionCode(input.state),
    input.now,
    input.tenantId,
    input.requestId,
    input.decisionIdempotencyKey,
  ).run();
  const request = await getApprovalRequest(env, input.tenantId, input.requestId);
  return d1Changes(result) === 1
    ? { kind: "finalized", request: request ?? failMissing("approval_request_finalize_missing") }
    : { kind: "lost_claim", request };
}

export async function expirePendingApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  requestId?: string,
): Promise<void> {
  const requestClause = requestId ? " AND approval_request_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE approval_requests
     SET state = 'expired', version = version + 1, completed_at = ?,
         transition_actor_kind = 'system', transition_actor_id = 'approval-expiry-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'approval_expired', updated_at = ?
     WHERE tenant_id = ? AND state = 'pending' AND expires_at <= ?${requestClause}`,
  );
  const bound = requestId
    ? statement.bind(now, now, tenantId, now, requestId)
    : statement.bind(now, now, tenantId, now);
  await bound.run();
}

/**
 * A stale broker call is not retried. It becomes explicit reconciliation work
 * because Frappe may already hold the corresponding immutable Hermes Run.
 */
export async function markExpiredExecutionLeases(
  env: AppEnv,
  now: string,
  tenantId?: string,
): Promise<number> {
  const tenantClause = tenantId ? " AND tenant_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE approval_requests
     SET state = 'execution_uncertain', version = version + 1,
         execution_lease_expires_at = NULL, completed_at = ?, error_code = 'broker_response_timeout',
         transition_actor_kind = 'system', transition_actor_id = 'approval-lease-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'execution_lease_expired', updated_at = ?
     WHERE state = 'executing' AND execution_lease_expires_at <= ?${tenantClause}`,
  );
  const result = tenantId
    ? await statement.bind(now, now, now, tenantId).run()
    : await statement.bind(now, now, now).run();
  return d1Changes(result);
}

export async function reconcileApprovalUncertainty(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    expectedVersion: number;
    reconciledByUserId: string;
    reconciledByFrappeUser: string;
    outcome: "executed" | "not_executed" | "inconclusive";
    evidence: string;
    now: string;
  },
): Promise<ReconcileApprovalUncertaintyResult> {
  const current = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state !== "execution_uncertain") return { kind: "not_uncertain", request: current };
  if (current.reconciled_at) return { kind: "already_reconciled", request: current };
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };
  const result = await env.DB.prepare(
    `UPDATE approval_requests
     SET version = version + 1, reconciled_at = ?, reconciled_by_user_id = ?,
         reconciled_by_frappe_user = ?, reconciliation_outcome = ?, reconciliation_evidence = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'execution_uncertainty_reconciled', updated_at = ?
     WHERE tenant_id = ? AND approval_request_id = ? AND state = 'execution_uncertain'
       AND version = ? AND reconciled_at IS NULL`,
  ).bind(
    input.now,
    input.reconciledByUserId,
    input.reconciledByFrappeUser,
    input.outcome,
    input.evidence,
    input.reconciledByUserId,
    input.reconciledByFrappeUser,
    input.now,
    input.tenantId,
    input.requestId,
    input.expectedVersion,
  ).run();
  if (d1Changes(result) === 1) {
    const reconciled = await getApprovalRequest(env, input.tenantId, input.requestId);
    if (!reconciled) throw new Error("approval_request_reconciliation_missing");
    return { kind: "reconciled", request: reconciled };
  }
  const latest = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state !== "execution_uncertain") return { kind: "not_uncertain", request: latest };
  if (latest.reconciled_at) return { kind: "already_reconciled", request: latest };
  return { kind: "version_conflict", request: latest };
}

export function approvalProjection(record: ApprovalRequestRecord): ApprovalRequestProjection {
  return {
    id: record.approval_request_id,
    kind: record.request_kind,
    state: record.state,
    version: record.version,
    action: "mark_lead_triaged",
    target: {
      doctype: "Lead Envelope",
      name: record.target_name,
      lead_envelope_id: record.lead_envelope_id,
    },
    request_text: record.request_text,
    preview: safeLeadTriagePreview(record.preview_json),
    expires_at: record.expires_at,
    requested_by: { user_id: record.requested_by_user_id, frappe_user: record.requested_by_frappe_user },
    approved_by: record.approved_by_user_id && record.approved_by_frappe_user && record.approved_at
      ? {
          user_id: record.approved_by_user_id,
          frappe_user: record.approved_by_frappe_user,
          approved_at: record.approved_at,
        }
      : null,
    rejection_reason: record.rejection_reason,
    run_id: record.run_id,
    hermes_run_id: record.hermes_run_id,
    outcome: safeLeadTriageOutcome(record.result_json),
    error_code: record.error_code,
    reconciliation: record.reconciled_at && record.reconciled_by_user_id && record.reconciled_by_frappe_user &&
        record.reconciliation_outcome && record.reconciliation_evidence
      ? {
          at: record.reconciled_at,
          by_user_id: record.reconciled_by_user_id,
          by_frappe_user: record.reconciled_by_frappe_user,
          outcome: record.reconciliation_outcome,
          evidence: record.reconciliation_evidence,
        }
      : null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
  };
}

const selectApprovalRequestSql = `SELECT
  approval_request_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
  intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
  target_doctype, target_name, lead_envelope_id, request_text, write_args_json, preview_json,
  args_digest, preview_digest, dry_run_receipt, expires_at, requested_by_user_id,
  requested_by_frappe_user, approved_by_user_id, approved_by_frappe_user, approved_at,
  decision_idempotency_key, rejection_reason, run_id, execution_lease_expires_at, hermes_run_id,
  result_json, error_code, reconciled_at, reconciled_by_user_id, reconciled_by_frappe_user,
  reconciliation_outcome, reconciliation_evidence, transition_actor_kind, transition_actor_id,
  transition_actor_frappe_user, transition_detail_code, created_at, updated_at, completed_at
 FROM approval_requests`;

async function findApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectApprovalRequestSql} WHERE tenant_id = ? AND prepare_idempotency_key = ? LIMIT 1`,
  ).bind(tenantId, prepareIdempotencyKey).first<ApprovalRequestRecord>();
  return row ? normalizeApprovalRequest(row) : null;
}

async function resolveClaimRace(
  env: AppEnv,
  input: Parameters<typeof claimApprovalExecution>[1],
): Promise<ClaimApprovalExecutionResult> {
  const latest = await getApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

function sameDecision(
  current: ApprovalRequestRecord,
  input: {
    decisionIdempotencyKey: string;
    approvedByUserId: string;
    approvedByFrappeUser: string;
  },
): boolean {
  return current.decision_idempotency_key === input.decisionIdempotencyKey &&
    current.approved_by_user_id === input.approvedByUserId &&
    current.approved_by_frappe_user === input.approvedByFrappeUser;
}

function terminalTransitionCode(state: ApprovalExecutionTerminalState): string {
  if (state === "executed") return "broker_execution_succeeded";
  if (state === "audit_failed") return "broker_audit_finalization_failed";
  if (state === "execution_uncertain") return "broker_execution_uncertain";
  return "broker_execution_failed";
}

function normalizeApprovalRequest(row: ApprovalRequestRecord): ApprovalRequestRecord {
  return {
    ...row,
    request_kind: "lead_triage",
    state: APPROVAL_STATES.includes(row.state as ApprovalState) ? row.state as ApprovalState : "failed",
    version: Number(row.version),
    requested_by_frappe_user: nullableText(row.requested_by_frappe_user),
    approved_by_user_id: nullableText(row.approved_by_user_id),
    approved_by_frappe_user: nullableText(row.approved_by_frappe_user),
    approved_at: nullableText(row.approved_at),
    decision_idempotency_key: nullableText(row.decision_idempotency_key),
    rejection_reason: nullableText(row.rejection_reason),
    execution_lease_expires_at: nullableText(row.execution_lease_expires_at),
    hermes_run_id: nullableText(row.hermes_run_id),
    result_json: nullableText(row.result_json),
    error_code: nullableText(row.error_code),
    reconciled_at: nullableText(row.reconciled_at),
    reconciled_by_user_id: nullableText(row.reconciled_by_user_id),
    reconciled_by_frappe_user: nullableText(row.reconciled_by_frappe_user),
    reconciliation_outcome: row.reconciliation_outcome === "executed" || row.reconciliation_outcome === "not_executed" ||
        row.reconciliation_outcome === "inconclusive"
      ? row.reconciliation_outcome
      : null,
    reconciliation_evidence: nullableText(row.reconciliation_evidence),
    transition_actor_kind: row.transition_actor_kind === "approval_broker" || row.transition_actor_kind === "system"
      ? row.transition_actor_kind
      : "app_user",
    transition_actor_id: nullableText(row.transition_actor_id),
    transition_actor_frappe_user: nullableText(row.transition_actor_frappe_user),
    transition_detail_code: nullableText(row.transition_detail_code),
    completed_at: nullableText(row.completed_at),
  };
}

function safeLeadTriagePreview(value: string): LeadTriagePreview | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const target = object(parsed.target);
  const before = object(parsed.before);
  const patch = object(parsed.patch);
  if (!target || !before || !patch || target.doctype !== "Lead Envelope") return null;
  const name = boundedText(target.name, 1, 140);
  const triageStatus = boundedText(patch.triage_status, 1, 32);
  const triagedBy = boundedText(patch.triaged_by, 1, 140);
  const triageSummary = boundedText(patch.triage_summary, 1, 2000);
  if (!name || triageStatus !== "Triaged" || !triagedBy || !triageSummary) return null;
  return {
    would_write: false,
    target: { doctype: "Lead Envelope", name },
    before: {
      triage_status: nullableBoundedText(before.triage_status, 32),
      triaged_by: nullableBoundedText(before.triaged_by, 140),
      triaged_at: nullableBoundedText(before.triaged_at, 80),
      triage_summary: nullableBoundedText(before.triage_summary, 2000),
    },
    patch: {
      triage_status: "Triaged",
      triaged_by: triagedBy,
      triaged_at: nullableBoundedText(patch.triaged_at, 80),
      triage_summary: triageSummary,
    },
    transport_status_unchanged: nullableBoundedText(parsed.transport_status_unchanged, 64),
    communication_events_mutated: false,
  };
}

function safeLeadTriageOutcome(value: string | null): LeadTriageOutcome | null {
  const parsed = value ? parseObject(value) : null;
  if (!parsed) return null;
  const runId = boundedText(parsed.run_id, 8, 128);
  const leadEnvelopeId = boundedText(parsed.lead_envelope_id, 1, 140);
  if (!runId || !leadEnvelopeId || parsed.updated !== true || parsed.audit_finalized !== true) return null;
  return {
    run_id: runId,
    lead_envelope_id: leadEnvelopeId,
    updated: true,
    audit_finalized: true,
    replayed: parsed.replayed === true,
    communication_events_mutated: false,
  };
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function nullableBoundedText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, 1, max);
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function clampLimit(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 50;
}

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

function failMissing(message: string): never {
  throw new Error(message);
}
