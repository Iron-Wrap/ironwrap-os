import type { AppEnv } from "./app-types.ts";

export const QUOTE_REVISION_APPROVAL_STATES = [
  "pending",
  "executing",
  "executed",
  "denied",
  "expired",
  "failed",
  "audit_failed",
  "execution_uncertain",
] as const;

export type QuoteRevisionApprovalState = (typeof QUOTE_REVISION_APPROVAL_STATES)[number];
export type QuoteRevisionApprovalRequestKind = "quote_revision";
export type QuoteRevisionApprovalTransitionActorKind = "app_user" | "approval_broker" | "system";
export type QuoteRevisionApprovalExecutionTerminalState = Extract<
  QuoteRevisionApprovalState,
  "executed" | "failed" | "audit_failed" | "execution_uncertain"
>;

export interface QuoteRevisionApprovalRequestRecord {
  quote_revision_approval_id: string;
  tenant_id: string;
  request_kind: QuoteRevisionApprovalRequestKind;
  state: QuoteRevisionApprovalState;
  version: number;
  prepare_idempotency_key: string;
  intent_fingerprint: string;
  write_tool: "request_create_quote_revision";
  dry_run_tool: "dry_run_quote_revision";
  agent_role: "estimator-assistant";
  actor_user: string;
  site_id: string;
  target_doctype: "Customer Quote";
  target_name: string;
  roof_job_id: string;
  source_customer_quote_id: string;
  source_quote_version: number;
  source_quote_status: string;
  source_quote_modified: string;
  target_customer_quote_id: string;
  target_quote_version: number;
  correction_reason: string;
  request_text: string;
  write_args_json: string;
  preview_json: string;
  args_digest: string;
  preview_digest: string;
  receipt_preview_digest: string;
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
  transition_actor_kind: QuoteRevisionApprovalTransitionActorKind;
  transition_actor_id: string | null;
  transition_actor_frappe_user: string | null;
  transition_detail_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface QuoteRevisionApprovalPreview {
  would_write: false;
  append_only: true;
  target: { doctype: "Customer Quote"; customer_quote_id: string; quote_version: number };
  source: {
    customer_quote_id: string;
    quote_version: number;
    status: string;
    modified: string;
  };
  draft: {
    customer_quote_id: string;
    quote_version: number;
    status: "Draft";
    supersedes: string;
    correction_reason: string;
  };
  observed_quote_count: number | null;
  effects: {
    customer_notified: false;
    commercial_terms_copied: false;
    proposal_sent: false;
    accounting_mutated: false;
  };
}

export interface QuoteRevisionApprovalOutcome {
  run_id: string;
  created: true;
  customer_quote_id: string;
  quote_version: number;
  supersedes: string;
  audit_finalized: true;
  customer_notified: false;
  commercial_terms_copied: false;
  proposal_sent: false;
  accounting_mutated: false;
}

export interface QuoteRevisionApprovalRequestProjection {
  id: string;
  kind: QuoteRevisionApprovalRequestKind;
  state: QuoteRevisionApprovalState;
  version: number;
  action: "create_quote_revision_draft";
  roof_job_id: string;
  source: {
    customer_quote_id: string;
    quote_version: number;
    status: string;
    modified: string;
  };
  target: { doctype: "Customer Quote"; customer_quote_id: string; quote_version: number };
  correction_reason: string;
  request_text: string;
  preview: QuoteRevisionApprovalPreview | null;
  expires_at: string;
  requested_by: { user_id: string; frappe_user: string | null };
  approved_by: { user_id: string; frappe_user: string; approved_at: string } | null;
  rejection_reason: string | null;
  run_id: string;
  hermes_run_id: string | null;
  outcome: QuoteRevisionApprovalOutcome | null;
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

export interface CreateQuoteRevisionApprovalRequestInput {
  id: string;
  tenantId: string;
  prepareIdempotencyKey: string;
  intentFingerprint: string;
  actorUser: string;
  siteId: string;
  roofJobId: string;
  sourceCustomerQuoteId: string;
  sourceQuoteVersion: number;
  sourceQuoteStatus: string;
  sourceQuoteModified: string;
  targetCustomerQuoteId: string;
  targetQuoteVersion: number;
  correctionReason: string;
  requestText: string;
  writeArgsJson: string;
  previewJson: string;
  argsDigest: string;
  previewDigest: string;
  receiptPreviewDigest: string;
  dryRunReceipt: string;
  expiresAt: string;
  requestedByUserId: string;
  requestedByFrappeUser: string | null;
  runId: string;
  now: string;
}

export type CreateQuoteRevisionApprovalRequestResult =
  | { kind: "created"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "replayed"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "conflict"; request: QuoteRevisionApprovalRequestRecord };

export type ClaimQuoteRevisionApprovalExecutionResult =
  | { kind: "claimed"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "replayed"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "version_conflict"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "already_decided"; request: QuoteRevisionApprovalRequestRecord };

export type DenyQuoteRevisionApprovalRequestResult =
  | { kind: "denied"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "replayed"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "version_conflict"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "already_decided"; request: QuoteRevisionApprovalRequestRecord };

export type FinalizeQuoteRevisionApprovalExecutionResult =
  | { kind: "finalized"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "lost_claim"; request: QuoteRevisionApprovalRequestRecord | null };

export type ReconcileQuoteRevisionApprovalUncertaintyResult =
  | { kind: "reconciled"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "not_uncertain"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "already_reconciled"; request: QuoteRevisionApprovalRequestRecord }
  | { kind: "version_conflict"; request: QuoteRevisionApprovalRequestRecord };

export async function createQuoteRevisionApprovalRequest(
  env: AppEnv,
  input: CreateQuoteRevisionApprovalRequestInput,
): Promise<CreateQuoteRevisionApprovalRequestResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO quote_revision_approval_requests (
       quote_revision_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
       intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
       target_doctype, target_name, roof_job_id, source_customer_quote_id, source_quote_version,
       source_quote_status, source_quote_modified, target_customer_quote_id, target_quote_version,
       correction_reason, request_text, write_args_json, preview_json, args_digest, preview_digest,
       receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id, requested_by_frappe_user, run_id,
       transition_actor_kind, transition_actor_id, transition_actor_frappe_user, transition_detail_code,
       created_at, updated_at
     ) VALUES (
       ?,?, 'quote_revision', 'pending', 1, ?,
       ?, 'request_create_quote_revision', 'dry_run_quote_revision', 'estimator-assistant', ?,?,
       'Customer Quote', ?,?,?,?,?,?,?,?,
       ?,?,?,?,?,?,?, ?,
       ?,?,?, ?,
       'app_user', ?, ?, 'quote_revision_approval_prepared', ?, ?
     )
     ON CONFLICT(tenant_id, prepare_idempotency_key) DO NOTHING
     RETURNING quote_revision_approval_id`,
  ).bind(
    input.id,
    input.tenantId,
    input.prepareIdempotencyKey,
    input.intentFingerprint,
    input.actorUser,
    input.siteId,
    input.targetCustomerQuoteId,
    input.roofJobId,
    input.sourceCustomerQuoteId,
    input.sourceQuoteVersion,
    input.sourceQuoteStatus,
    input.sourceQuoteModified,
    input.targetCustomerQuoteId,
    input.targetQuoteVersion,
    input.correctionReason,
    input.requestText,
    input.writeArgsJson,
    input.previewJson,
    input.argsDigest,
    input.previewDigest,
    input.receiptPreviewDigest,
    input.dryRunReceipt,
    input.expiresAt,
    input.requestedByUserId,
    input.requestedByFrappeUser,
    input.runId,
    input.requestedByUserId,
    input.requestedByFrappeUser,
    input.now,
    input.now,
  ).all<{ quote_revision_approval_id: string }>();

  const insertedId = inserted.results?.[0]?.quote_revision_approval_id;
  if (insertedId) {
    const request = await getQuoteRevisionApprovalRequest(env, input.tenantId, insertedId);
    if (!request) throw new Error("quote_revision_approval_insert_missing");
    return { kind: "created", request };
  }

  const existing = await findQuoteRevisionApprovalRequestByPrepareKey(env, input.tenantId, input.prepareIdempotencyKey);
  if (!existing) throw new Error("quote_revision_approval_idempotency_lookup_missing");
  return existing.intent_fingerprint === input.intentFingerprint
    ? { kind: "replayed", request: existing }
    : { kind: "conflict", request: existing };
}

export async function listQuoteRevisionApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  limit = 50,
): Promise<QuoteRevisionApprovalRequestRecord[]> {
  await expirePendingQuoteRevisionApprovalRequests(env, tenantId, now);
  const result = await env.DB.prepare(
    `${selectQuoteRevisionApprovalRequestSql}
     WHERE tenant_id = ?
     ORDER BY
       CASE state WHEN 'pending' THEN 0 WHEN 'executing' THEN 1 WHEN 'execution_uncertain' THEN 2 ELSE 3 END,
       updated_at DESC, quote_revision_approval_id DESC
     LIMIT ?`,
  ).bind(tenantId, clampLimit(limit)).all<QuoteRevisionApprovalRequestRecord>();
  return (result.results ?? []).map(normalizeQuoteRevisionApprovalRequest);
}

export async function getQuoteRevisionApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
): Promise<QuoteRevisionApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectQuoteRevisionApprovalRequestSql} WHERE tenant_id = ? AND quote_revision_approval_id = ? LIMIT 1`,
  ).bind(tenantId, requestId).first<QuoteRevisionApprovalRequestRecord>();
  return row ? normalizeQuoteRevisionApprovalRequest(row) : null;
}

export async function getQuoteRevisionApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<QuoteRevisionApprovalRequestRecord | null> {
  return await findQuoteRevisionApprovalRequestByPrepareKey(env, tenantId, prepareIdempotencyKey);
}

export function matchesQuoteRevisionApprovalPreparation(
  record: QuoteRevisionApprovalRequestRecord,
  input: {
    requestedByUserId: string;
    roofJobId: string;
    sourceCustomerQuoteId: string;
    correctionReason: string;
    requestText: string;
  },
): boolean {
  const args = parseObject(record.write_args_json);
  if (!args) return false;
  return record.requested_by_user_id === input.requestedByUserId &&
    record.roof_job_id === input.roofJobId &&
    record.source_customer_quote_id === input.sourceCustomerQuoteId &&
    record.correction_reason === input.correctionReason &&
    record.request_text === input.requestText &&
    args.roof_job_id === input.roofJobId &&
    args.customer_quote_id === input.sourceCustomerQuoteId &&
    args.correction_reason === input.correctionReason &&
    args.request_text === input.requestText;
}

export async function getCurrentQuoteRevisionApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
  now: string,
): Promise<QuoteRevisionApprovalRequestRecord | null> {
  await expirePendingQuoteRevisionApprovalRequests(env, tenantId, now, requestId);
  return await getQuoteRevisionApprovalRequest(env, tenantId, requestId);
}

export async function claimQuoteRevisionApprovalExecution(
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
): Promise<ClaimQuoteRevisionApprovalExecutionResult> {
  await expirePendingQuoteRevisionApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET state = 'executing', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, execution_lease_expires_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'quote_revision_approval_execute_claimed',
         updated_at = ?
     WHERE tenant_id = ? AND quote_revision_approval_id = ? AND state = 'pending'
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
  // SQLite counts trigger-inserted event rows in meta.changes: the guarded
  // single-row UPDATE reports >= 2 on success, not exactly 1.
  if (d1Changes(result) >= 1) {
    const claimed = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
    if (!claimed) throw new Error("quote_revision_approval_claim_missing");
    return { kind: "claimed", request: claimed };
  }
  return await resolveClaimRace(env, input);
}

export async function denyQuoteRevisionApprovalRequest(
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
): Promise<DenyQuoteRevisionApprovalRequestResult> {
  await expirePendingQuoteRevisionApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET state = 'denied', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, rejection_reason = ?, completed_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'quote_revision_approval_denied',
         updated_at = ?
     WHERE tenant_id = ? AND quote_revision_approval_id = ? AND state = 'pending'
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
  // Trigger-augmented meta.changes means >= 1 (see claim above).
  if (d1Changes(result) >= 1) {
    const denied = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
    if (!denied) throw new Error("quote_revision_approval_deny_missing");
    return { kind: "denied", request: denied };
  }
  const latest = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

export async function finalizeQuoteRevisionApprovalExecution(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    decisionIdempotencyKey: string;
    state: QuoteRevisionApprovalExecutionTerminalState;
    hermesRunId?: string | null;
    resultJson?: string | null;
    errorCode?: string | null;
    now: string;
  },
): Promise<FinalizeQuoteRevisionApprovalExecutionResult> {
  const result = await env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET state = ?, version = version + 1, hermes_run_id = ?, result_json = ?, error_code = ?,
         execution_lease_expires_at = NULL, completed_at = ?,
         transition_actor_kind = 'approval_broker', transition_actor_id = 'quote-revision-broker',
         transition_actor_frappe_user = NULL, transition_detail_code = ?, updated_at = ?
     WHERE tenant_id = ? AND quote_revision_approval_id = ? AND state = 'executing'
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
  const request = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  // Trigger-augmented meta.changes means >= 1 (see claim above).
  return d1Changes(result) >= 1
    ? { kind: "finalized", request: request ?? failMissing("quote_revision_approval_finalize_missing") }
    : { kind: "lost_claim", request };
}

export async function expirePendingQuoteRevisionApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  requestId?: string,
): Promise<void> {
  const requestClause = requestId ? " AND quote_revision_approval_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET state = 'expired', version = version + 1, completed_at = ?,
         transition_actor_kind = 'system', transition_actor_id = 'quote-revision-approval-expiry-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'quote_revision_approval_expired', updated_at = ?
     WHERE tenant_id = ? AND state = 'pending' AND expires_at <= ?${requestClause}`,
  );
  const bound = requestId
    ? statement.bind(now, now, tenantId, now, requestId)
    : statement.bind(now, now, tenantId, now);
  await bound.run();
}

/** A stale broker call is reconciliation work, not a retry opportunity. */
export async function markExpiredQuoteRevisionApprovalExecutionLeases(
  env: AppEnv,
  now: string,
  tenantId?: string,
): Promise<number> {
  const tenantClause = tenantId ? " AND tenant_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET state = 'execution_uncertain', version = version + 1,
         execution_lease_expires_at = NULL, completed_at = ?, error_code = 'broker_response_timeout',
         transition_actor_kind = 'system', transition_actor_id = 'quote-revision-approval-lease-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'quote_revision_approval_execution_lease_expired', updated_at = ?
     WHERE state = 'executing' AND execution_lease_expires_at <= ?${tenantClause}`,
  );
  const result = tenantId
    ? await statement.bind(now, now, now, tenantId).run()
    : await statement.bind(now, now, now).run();
  return d1Changes(result);
}

export async function reconcileQuoteRevisionApprovalUncertainty(
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
): Promise<ReconcileQuoteRevisionApprovalUncertaintyResult> {
  const current = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state !== "execution_uncertain") return { kind: "not_uncertain", request: current };
  if (current.reconciled_at) return { kind: "already_reconciled", request: current };
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };
  const result = await env.DB.prepare(
    `UPDATE quote_revision_approval_requests
     SET version = version + 1, reconciled_at = ?, reconciled_by_user_id = ?,
         reconciled_by_frappe_user = ?, reconciliation_outcome = ?, reconciliation_evidence = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'quote_revision_approval_execution_uncertainty_reconciled', updated_at = ?
     WHERE tenant_id = ? AND quote_revision_approval_id = ? AND state = 'execution_uncertain'
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
  // Trigger-augmented meta.changes means >= 1 (see claim above).
  if (d1Changes(result) >= 1) {
    const reconciled = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
    if (!reconciled) throw new Error("quote_revision_approval_reconciliation_missing");
    return { kind: "reconciled", request: reconciled };
  }
  const latest = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state !== "execution_uncertain") return { kind: "not_uncertain", request: latest };
  if (latest.reconciled_at) return { kind: "already_reconciled", request: latest };
  return { kind: "version_conflict", request: latest };
}

export function quoteRevisionApprovalProjection(
  record: QuoteRevisionApprovalRequestRecord,
): QuoteRevisionApprovalRequestProjection {
  return {
    id: record.quote_revision_approval_id,
    kind: "quote_revision",
    state: record.state,
    version: record.version,
    action: "create_quote_revision_draft",
    roof_job_id: record.roof_job_id,
    source: {
      customer_quote_id: record.source_customer_quote_id,
      quote_version: record.source_quote_version,
      status: record.source_quote_status,
      modified: record.source_quote_modified,
    },
    target: {
      doctype: "Customer Quote",
      customer_quote_id: record.target_customer_quote_id,
      quote_version: record.target_quote_version,
    },
    correction_reason: record.correction_reason,
    request_text: record.request_text,
    preview: safeQuoteRevisionApprovalPreview(record.preview_json, record),
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
    outcome: safeQuoteRevisionApprovalOutcome(record.result_json, record),
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

const selectQuoteRevisionApprovalRequestSql = `SELECT
  quote_revision_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
  intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
  target_doctype, target_name, roof_job_id, source_customer_quote_id, source_quote_version,
  source_quote_status, source_quote_modified, target_customer_quote_id, target_quote_version,
  correction_reason, request_text, write_args_json, preview_json, args_digest, preview_digest,
  receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id, requested_by_frappe_user, approved_by_user_id,
  approved_by_frappe_user, approved_at, decision_idempotency_key, rejection_reason, run_id,
  execution_lease_expires_at, hermes_run_id, result_json, error_code, reconciled_at,
  reconciled_by_user_id, reconciled_by_frappe_user, reconciliation_outcome, reconciliation_evidence,
  transition_actor_kind, transition_actor_id, transition_actor_frappe_user, transition_detail_code,
  created_at, updated_at, completed_at
 FROM quote_revision_approval_requests`;

async function findQuoteRevisionApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<QuoteRevisionApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectQuoteRevisionApprovalRequestSql} WHERE tenant_id = ? AND prepare_idempotency_key = ? LIMIT 1`,
  ).bind(tenantId, prepareIdempotencyKey).first<QuoteRevisionApprovalRequestRecord>();
  return row ? normalizeQuoteRevisionApprovalRequest(row) : null;
}

async function resolveClaimRace(
  env: AppEnv,
  input: Parameters<typeof claimQuoteRevisionApprovalExecution>[1],
): Promise<ClaimQuoteRevisionApprovalExecutionResult> {
  const latest = await getQuoteRevisionApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

function sameDecision(
  current: QuoteRevisionApprovalRequestRecord,
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

function terminalTransitionCode(state: QuoteRevisionApprovalExecutionTerminalState): string {
  if (state === "executed") return "quote_revision_broker_execution_succeeded";
  if (state === "audit_failed") return "quote_revision_broker_audit_finalization_failed";
  if (state === "execution_uncertain") return "quote_revision_broker_execution_uncertain";
  return "quote_revision_broker_execution_failed";
}

function normalizeQuoteRevisionApprovalRequest(
  row: QuoteRevisionApprovalRequestRecord,
): QuoteRevisionApprovalRequestRecord {
  return {
    ...row,
    request_kind: "quote_revision",
    state: QUOTE_REVISION_APPROVAL_STATES.includes(row.state as QuoteRevisionApprovalState)
      ? row.state as QuoteRevisionApprovalState
      : "failed",
    version: Number(row.version),
    source_quote_version: Number(row.source_quote_version),
    target_quote_version: Number(row.target_quote_version),
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

function safeQuoteRevisionApprovalPreview(
  value: string,
  record: QuoteRevisionApprovalRequestRecord,
): QuoteRevisionApprovalPreview | null {
  const parsed = parseObject(value);
  if (!parsed || parsed.would_write !== false || parsed.append_only !== true) return null;
  const target = object(parsed.target);
  const source = object(parsed.source);
  const draft = object(parsed.draft);
  if (!target || !source || !draft || target.doctype !== "Customer Quote") return null;
  const targetId = boundedText(target.name, 1, 140);
  const sourceId = boundedText(source.customer_quote_id, 1, 140);
  const sourceRoofJobId = boundedText(source.roof_job, 1, 140);
  const sourceStatus = boundedText(source.status, 1, 32);
  const sourceModified = boundedText(source.modified, 1, 80);
  const draftId = boundedText(draft.customer_quote_id, 1, 140);
  const draftRoofJobId = boundedText(draft.roof_job, 1, 140);
  const supersedes = boundedText(draft.supersedes, 1, 140);
  const correctionReason = boundedText(draft.correction_reason, 1, 2000);
  const sourceVersion = validPositiveInt(source.quote_version);
  const draftVersion = validPositiveInt(draft.quote_version);
  if (
    !targetId || !sourceId || !sourceRoofJobId || !sourceStatus || !sourceModified || !draftId || !draftRoofJobId || !supersedes || !correctionReason ||
    sourceVersion === null || draftVersion === null || draft.status !== "Draft" ||
    targetId !== record.target_customer_quote_id || draftId !== record.target_customer_quote_id ||
    sourceId !== record.source_customer_quote_id || sourceRoofJobId !== record.roof_job_id ||
    draftRoofJobId !== record.roof_job_id ||
    supersedes !== record.source_customer_quote_id ||
    sourceStatus !== record.source_quote_status || sourceModified !== record.source_quote_modified ||
    sourceVersion !== record.source_quote_version || draftVersion !== record.target_quote_version ||
    correctionReason !== record.correction_reason
  ) return null;
  const observedQuoteCount = parsed.observed_quote_count === undefined
    ? null
    : validNonNegativeInt(parsed.observed_quote_count);
  if (parsed.observed_quote_count !== undefined && observedQuoteCount === null) return null;
  return {
    would_write: false,
    append_only: true,
    target: { doctype: "Customer Quote", customer_quote_id: targetId, quote_version: draftVersion },
    source: { customer_quote_id: sourceId, quote_version: sourceVersion, status: sourceStatus, modified: sourceModified },
    draft: {
      customer_quote_id: draftId,
      quote_version: draftVersion,
      status: "Draft",
      supersedes,
      correction_reason: correctionReason,
    },
    observed_quote_count: observedQuoteCount,
    effects: noCommercialEffects(),
  };
}

function safeQuoteRevisionApprovalOutcome(
  value: string | null,
  record: QuoteRevisionApprovalRequestRecord,
): QuoteRevisionApprovalOutcome | null {
  const parsed = value ? parseObject(value) : null;
  if (!parsed) return null;
  const runId = boundedText(parsed.run_id, 8, 128);
  const customerQuoteId = boundedText(parsed.customer_quote_id, 1, 140);
  const supersedes = boundedText(parsed.supersedes, 1, 140);
  const quoteVersion = validPositiveInt(parsed.quote_version);
  if (
    !runId || !customerQuoteId || !supersedes || quoteVersion === null || parsed.created !== true ||
    parsed.audit_finalized !== true || runId !== record.run_id ||
    customerQuoteId !== record.target_customer_quote_id || quoteVersion !== record.target_quote_version ||
    supersedes !== record.source_customer_quote_id
  ) return null;
  return {
    run_id: runId,
    created: true,
    customer_quote_id: customerQuoteId,
    quote_version: quoteVersion,
    supersedes,
    audit_finalized: true,
    ...noCommercialEffects(),
  };
}

function noCommercialEffects() {
  return {
    customer_notified: false as const,
    commercial_terms_copied: false as const,
    proposal_sent: false as const,
    accounting_mutated: false as const,
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

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function validNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function clampLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 50;
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function failMissing(message: string): never {
  throw new Error(message);
}
