import type { AppEnv } from "./app-types.ts";

export const PROPOSAL_PUBLICATION_APPROVAL_STATES = [
  "pending",
  "executing",
  "executed",
  "denied",
  "expired",
  "failed",
  "audit_failed",
  "execution_uncertain",
] as const;

export type ProposalPublicationApprovalState =
  (typeof PROPOSAL_PUBLICATION_APPROVAL_STATES)[number];
export type ProposalPublicationApprovalRequestKind = "proposal_publication";
export type ProposalPublicationApprovalTransitionActorKind =
  "app_user" | "approval_broker" | "system";
export type ProposalPublicationApprovalExecutionTerminalState = Extract<
  ProposalPublicationApprovalState,
  "executed" | "failed" | "audit_failed" | "execution_uncertain"
>;

export interface ProposalPublicationApprovalRequestRecord {
  proposal_publication_approval_id: string;
  tenant_id: string;
  request_kind: ProposalPublicationApprovalRequestKind;
  state: ProposalPublicationApprovalState;
  version: number;
  prepare_idempotency_key: string;
  intent_fingerprint: string;
  write_tool: "request_publish_proposal_evidence_pack";
  dry_run_tool: "dry_run_publish_proposal_evidence_pack";
  agent_role: "owner-operator";
  actor_user: string;
  site_id: string;
  target_doctype: "Proposal Evidence Pack";
  target_name: string;
  roof_job_id: string;
  proposal_evidence_pack_id: string;
  customer_quote_id: string;
  pack_status_before: string;
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
  transition_actor_kind: ProposalPublicationApprovalTransitionActorKind;
  transition_actor_id: string | null;
  transition_actor_frappe_user: string | null;
  transition_detail_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * What the owner sees before confirming. It says what publication does to the
 * customer surface and, just as importantly, what it does not do: no message,
 * no portal link, no signature, no quote or accounting mutation.
 */
export interface ProposalPublicationApprovalPreview {
  would_write: false;
  target: {
    doctype: "Proposal Evidence Pack";
    proposal_evidence_pack_id: string;
  };
  before: {
    proposal_evidence_pack_id: string;
    roof_job: string;
    quotation: string;
    status: string;
  };
  publication: { status: "Approved" };
  customer_portal: {
    visible_after_publication: true;
    portal_link_issued: false;
    human_portal_link_issuance_required: true;
  };
  effects: {
    customer_delivery_mutated: false;
    contract_acceptance_mutated: false;
    customer_quote_mutated: false;
  };
}

export interface ProposalPublicationApprovalOutcome {
  run_id: string;
  published: true;
  proposal_evidence_pack_id: string;
  customer_quote_id: string;
  status: "Approved";
  audit_finalized: true;
  customer_delivery_mutated: false;
  customer_portal_link_issued: false;
  contract_acceptance_mutated: false;
  customer_quote_mutated: false;
}

export interface ProposalPublicationApprovalRequestProjection {
  id: string;
  kind: ProposalPublicationApprovalRequestKind;
  state: ProposalPublicationApprovalState;
  version: number;
  action: "publish_proposal_evidence_pack";
  roof_job_id: string;
  proposal_evidence_pack_id: string;
  customer_quote_id: string;
  target: {
    doctype: "Proposal Evidence Pack";
    proposal_evidence_pack_id: string;
  };
  pack_status_before: string;
  request_text: string;
  preview: ProposalPublicationApprovalPreview | null;
  expires_at: string;
  requested_by: { user_id: string; frappe_user: string | null };
  approved_by: { user_id: string; frappe_user: string; approved_at: string } | null;
  rejection_reason: string | null;
  run_id: string;
  hermes_run_id: string | null;
  outcome: ProposalPublicationApprovalOutcome | null;
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

export interface CreateProposalPublicationApprovalRequestInput {
  id: string;
  tenantId: string;
  prepareIdempotencyKey: string;
  intentFingerprint: string;
  actorUser: string;
  siteId: string;
  roofJobId: string;
  proposalEvidencePackId: string;
  customerQuoteId: string;
  packStatusBefore: string;
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

export type CreateProposalPublicationApprovalRequestResult =
  | { kind: "created"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "replayed"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "conflict"; request: ProposalPublicationApprovalRequestRecord };

export type ClaimProposalPublicationApprovalExecutionResult =
  | { kind: "claimed"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "replayed"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "already_decided"; request: ProposalPublicationApprovalRequestRecord };

export type DenyProposalPublicationApprovalRequestResult =
  | { kind: "denied"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "replayed"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "already_decided"; request: ProposalPublicationApprovalRequestRecord };

export type FinalizeProposalPublicationApprovalExecutionResult =
  | { kind: "finalized"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "lost_claim"; request: ProposalPublicationApprovalRequestRecord | null };

export type ReconcileProposalPublicationApprovalUncertaintyResult =
  | { kind: "reconciled"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "not_uncertain"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "already_reconciled"; request: ProposalPublicationApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProposalPublicationApprovalRequestRecord };

export async function createProposalPublicationApprovalRequest(
  env: AppEnv,
  input: CreateProposalPublicationApprovalRequestInput,
): Promise<CreateProposalPublicationApprovalRequestResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO proposal_publication_approval_requests (
       proposal_publication_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
       intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
       target_doctype, target_name, roof_job_id, proposal_evidence_pack_id, customer_quote_id,
       pack_status_before, request_text, write_args_json, preview_json, args_digest, preview_digest,
       receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id, requested_by_frappe_user, run_id,
       transition_actor_kind, transition_actor_id, transition_actor_frappe_user, transition_detail_code,
       created_at, updated_at
     ) VALUES (
       ?,?, 'proposal_publication', 'pending', 1, ?,
       ?, 'request_publish_proposal_evidence_pack', 'dry_run_publish_proposal_evidence_pack', 'owner-operator', ?,?,
       'Proposal Evidence Pack', ?,?,?,?,
       ?,?,?,?,?,?,
       ?,?,?,?,?,?,
       'app_user', ?, ?, 'proposal_publication_approval_prepared', ?, ?
     )
     ON CONFLICT(tenant_id, prepare_idempotency_key) DO NOTHING
     RETURNING proposal_publication_approval_id`,
  ).bind(
    input.id,
    input.tenantId,
    input.prepareIdempotencyKey,
    input.intentFingerprint,
    input.actorUser,
    input.siteId,
    input.proposalEvidencePackId,
    input.roofJobId,
    input.proposalEvidencePackId,
    input.customerQuoteId,
    input.packStatusBefore,
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
  ).all<{ proposal_publication_approval_id: string }>();

  const insertedId = inserted.results?.[0]?.proposal_publication_approval_id;
  if (insertedId) {
    const request = await getProposalPublicationApprovalRequest(env, input.tenantId, insertedId);
    if (!request) throw new Error("proposal_publication_approval_insert_missing");
    return { kind: "created", request };
  }

  const existing = await findProposalPublicationApprovalRequestByPrepareKey(
    env,
    input.tenantId,
    input.prepareIdempotencyKey,
  );
  if (!existing) throw new Error("proposal_publication_approval_idempotency_lookup_missing");
  return existing.intent_fingerprint === input.intentFingerprint
    ? { kind: "replayed", request: existing }
    : { kind: "conflict", request: existing };
}

export async function listProposalPublicationApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  limit = 50,
  roofJobId?: string,
): Promise<ProposalPublicationApprovalRequestRecord[]> {
  await expirePendingProposalPublicationApprovalRequests(env, tenantId, now);
  const jobClause = roofJobId ? " AND roof_job_id = ?" : "";
  const statement = env.DB.prepare(
    `${selectProposalPublicationApprovalRequestSql}
     WHERE tenant_id = ?${jobClause}
     ORDER BY
       CASE state WHEN 'pending' THEN 0 WHEN 'executing' THEN 1 WHEN 'execution_uncertain' THEN 2 ELSE 3 END,
       updated_at DESC, proposal_publication_approval_id DESC
     LIMIT ?`,
  );
  const bound = roofJobId
    ? statement.bind(tenantId, roofJobId, clampLimit(limit))
    : statement.bind(tenantId, clampLimit(limit));
  const result = await bound.all<ProposalPublicationApprovalRequestRecord>();
  return (result.results ?? []).map(normalizeProposalPublicationApprovalRequest);
}

export async function getProposalPublicationApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
): Promise<ProposalPublicationApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectProposalPublicationApprovalRequestSql} WHERE tenant_id = ? AND proposal_publication_approval_id = ? LIMIT 1`,
  ).bind(tenantId, requestId).first<ProposalPublicationApprovalRequestRecord>();
  return row ? normalizeProposalPublicationApprovalRequest(row) : null;
}

export async function getProposalPublicationApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ProposalPublicationApprovalRequestRecord | null> {
  return await findProposalPublicationApprovalRequestByPrepareKey(env, tenantId, prepareIdempotencyKey);
}

export function matchesProposalPublicationApprovalPreparation(
  record: ProposalPublicationApprovalRequestRecord,
  input: {
    requestedByUserId: string;
    roofJobId: string;
    proposalEvidencePackId: string;
    requestText: string;
  },
): boolean {
  const args = parseObject(record.write_args_json);
  if (!args) return false;
  return record.requested_by_user_id === input.requestedByUserId &&
    record.roof_job_id === input.roofJobId &&
    record.proposal_evidence_pack_id === input.proposalEvidencePackId &&
    record.request_text === input.requestText &&
    args.proposal_evidence_pack_id === input.proposalEvidencePackId &&
    args.request_text === input.requestText;
}

export async function getCurrentProposalPublicationApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
  now: string,
): Promise<ProposalPublicationApprovalRequestRecord | null> {
  await expirePendingProposalPublicationApprovalRequests(env, tenantId, now, requestId);
  return await getProposalPublicationApprovalRequest(env, tenantId, requestId);
}

export async function claimProposalPublicationApprovalExecution(
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
): Promise<ClaimProposalPublicationApprovalExecutionResult> {
  await expirePendingProposalPublicationApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input)
      ? { kind: "replayed", request: current }
      : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET state = 'executing', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, execution_lease_expires_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'proposal_publication_approval_execute_claimed',
         updated_at = ?
     WHERE tenant_id = ? AND proposal_publication_approval_id = ? AND state = 'pending'
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
    const claimed = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
    if (!claimed) throw new Error("proposal_publication_approval_claim_missing");
    return { kind: "claimed", request: claimed };
  }
  return await resolveClaimRace(env, input);
}

export async function denyProposalPublicationApprovalRequest(
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
): Promise<DenyProposalPublicationApprovalRequestResult> {
  await expirePendingProposalPublicationApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input)
      ? { kind: "replayed", request: current }
      : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET state = 'denied', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, rejection_reason = ?, completed_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'proposal_publication_approval_denied',
         updated_at = ?
     WHERE tenant_id = ? AND proposal_publication_approval_id = ? AND state = 'pending'
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
    const denied = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
    if (!denied) throw new Error("proposal_publication_approval_deny_missing");
    return { kind: "denied", request: denied };
  }
  const latest = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input)
      ? { kind: "replayed", request: latest }
      : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

export async function finalizeProposalPublicationApprovalExecution(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    decisionIdempotencyKey: string;
    state: ProposalPublicationApprovalExecutionTerminalState;
    hermesRunId?: string | null;
    resultJson?: string | null;
    errorCode?: string | null;
    now: string;
  },
): Promise<FinalizeProposalPublicationApprovalExecutionResult> {
  const result = await env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET state = ?, version = version + 1, hermes_run_id = ?, result_json = ?, error_code = ?,
         execution_lease_expires_at = NULL, completed_at = ?,
         transition_actor_kind = 'approval_broker', transition_actor_id = 'proposal-publication-broker',
         transition_actor_frappe_user = NULL, transition_detail_code = ?, updated_at = ?
     WHERE tenant_id = ? AND proposal_publication_approval_id = ? AND state = 'executing'
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
  const request = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  // Trigger-augmented meta.changes means >= 1 (see claim above).
  return d1Changes(result) >= 1
    ? { kind: "finalized", request: request ?? failMissing("proposal_publication_approval_finalize_missing") }
    : { kind: "lost_claim", request };
}

export async function expirePendingProposalPublicationApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  requestId?: string,
): Promise<void> {
  const requestClause = requestId ? " AND proposal_publication_approval_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET state = 'expired', version = version + 1, completed_at = ?,
         transition_actor_kind = 'system', transition_actor_id = 'proposal-publication-approval-expiry-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'proposal_publication_approval_expired', updated_at = ?
     WHERE tenant_id = ? AND state = 'pending' AND expires_at <= ?${requestClause}`,
  );
  const bound = requestId
    ? statement.bind(now, now, tenantId, now, requestId)
    : statement.bind(now, now, tenantId, now);
  await bound.run();
}

/** A stale broker call is reconciliation work, not a retry opportunity. */
export async function markExpiredProposalPublicationApprovalExecutionLeases(
  env: AppEnv,
  now: string,
  tenantId?: string,
): Promise<number> {
  const tenantClause = tenantId ? " AND tenant_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET state = 'execution_uncertain', version = version + 1,
         execution_lease_expires_at = NULL, completed_at = ?, error_code = 'broker_response_timeout',
         transition_actor_kind = 'system', transition_actor_id = 'proposal-publication-approval-lease-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'proposal_publication_approval_execution_lease_expired', updated_at = ?
     WHERE state = 'executing' AND execution_lease_expires_at <= ?${tenantClause}`,
  );
  const result = tenantId
    ? await statement.bind(now, now, now, tenantId).run()
    : await statement.bind(now, now, now).run();
  return d1Changes(result);
}

export async function reconcileProposalPublicationApprovalUncertainty(
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
): Promise<ReconcileProposalPublicationApprovalUncertaintyResult> {
  const current = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state !== "execution_uncertain") return { kind: "not_uncertain", request: current };
  if (current.reconciled_at) return { kind: "already_reconciled", request: current };
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };
  const result = await env.DB.prepare(
    `UPDATE proposal_publication_approval_requests
     SET version = version + 1, reconciled_at = ?, reconciled_by_user_id = ?,
         reconciled_by_frappe_user = ?, reconciliation_outcome = ?, reconciliation_evidence = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'proposal_publication_approval_execution_uncertainty_reconciled', updated_at = ?
     WHERE tenant_id = ? AND proposal_publication_approval_id = ? AND state = 'execution_uncertain'
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
    const reconciled = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
    if (!reconciled) throw new Error("proposal_publication_approval_reconciliation_missing");
    return { kind: "reconciled", request: reconciled };
  }
  const latest = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state !== "execution_uncertain") return { kind: "not_uncertain", request: latest };
  if (latest.reconciled_at) return { kind: "already_reconciled", request: latest };
  return { kind: "version_conflict", request: latest };
}

export function proposalPublicationApprovalProjection(
  record: ProposalPublicationApprovalRequestRecord,
): ProposalPublicationApprovalRequestProjection {
  return {
    id: record.proposal_publication_approval_id,
    kind: "proposal_publication",
    state: record.state,
    version: record.version,
    action: "publish_proposal_evidence_pack",
    roof_job_id: record.roof_job_id,
    proposal_evidence_pack_id: record.proposal_evidence_pack_id,
    customer_quote_id: record.customer_quote_id,
    target: {
      doctype: "Proposal Evidence Pack",
      proposal_evidence_pack_id: record.proposal_evidence_pack_id,
    },
    pack_status_before: record.pack_status_before,
    request_text: record.request_text,
    preview: safeProposalPublicationApprovalPreview(record.preview_json, record),
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
    outcome: safeProposalPublicationApprovalOutcome(record.result_json, record),
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

const selectProposalPublicationApprovalRequestSql = `SELECT
  proposal_publication_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
  intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
  target_doctype, target_name, roof_job_id, proposal_evidence_pack_id, customer_quote_id,
  pack_status_before, request_text, write_args_json, preview_json, args_digest, preview_digest,
  receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id, requested_by_frappe_user, approved_by_user_id,
  approved_by_frappe_user, approved_at, decision_idempotency_key, rejection_reason, run_id,
  execution_lease_expires_at, hermes_run_id, result_json, error_code, reconciled_at,
  reconciled_by_user_id, reconciled_by_frappe_user, reconciliation_outcome, reconciliation_evidence,
  transition_actor_kind, transition_actor_id, transition_actor_frappe_user, transition_detail_code,
  created_at, updated_at, completed_at
 FROM proposal_publication_approval_requests`;

async function findProposalPublicationApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ProposalPublicationApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectProposalPublicationApprovalRequestSql} WHERE tenant_id = ? AND prepare_idempotency_key = ? LIMIT 1`,
  ).bind(tenantId, prepareIdempotencyKey).first<ProposalPublicationApprovalRequestRecord>();
  return row ? normalizeProposalPublicationApprovalRequest(row) : null;
}

async function resolveClaimRace(
  env: AppEnv,
  input: Parameters<typeof claimProposalPublicationApprovalExecution>[1],
): Promise<ClaimProposalPublicationApprovalExecutionResult> {
  const latest = await getProposalPublicationApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input)
      ? { kind: "replayed", request: latest }
      : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

function sameDecision(
  current: ProposalPublicationApprovalRequestRecord,
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

function terminalTransitionCode(state: ProposalPublicationApprovalExecutionTerminalState): string {
  if (state === "executed") return "proposal_publication_broker_execution_succeeded";
  if (state === "audit_failed") return "proposal_publication_broker_audit_finalization_failed";
  if (state === "execution_uncertain") return "proposal_publication_broker_execution_uncertain";
  return "proposal_publication_broker_execution_failed";
}

function normalizeProposalPublicationApprovalRequest(
  row: ProposalPublicationApprovalRequestRecord,
): ProposalPublicationApprovalRequestRecord {
  return {
    ...row,
    request_kind: "proposal_publication",
    state: PROPOSAL_PUBLICATION_APPROVAL_STATES.includes(row.state as ProposalPublicationApprovalState)
      ? row.state as ProposalPublicationApprovalState
      : "failed",
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

function safeProposalPublicationApprovalPreview(
  value: string,
  record: ProposalPublicationApprovalRequestRecord,
): ProposalPublicationApprovalPreview | null {
  const parsed = parseObject(value);
  if (!parsed || parsed.would_write !== false) return null;
  const target = object(parsed.target);
  const before = object(parsed.before);
  const publication = object(parsed.publication);
  const portal = object(parsed.customer_portal);
  if (!target || !before || !publication || !portal) return null;
  if (target.doctype !== "Proposal Evidence Pack") return null;
  const targetId = boundedText(target.name, 1, 140);
  const beforeId = boundedText(before.pack_id, 1, 140);
  const roofJob = boundedText(before.roof_job, 1, 140);
  const quotation = boundedText(before.quotation, 1, 140);
  const status = boundedText(before.status, 1, 80);
  if (
    !targetId || !beforeId || !roofJob || !quotation || !status ||
    targetId !== record.proposal_evidence_pack_id || beforeId !== record.proposal_evidence_pack_id ||
    roofJob !== record.roof_job_id || quotation !== record.customer_quote_id ||
    status !== record.pack_status_before ||
    publication.status !== "Approved" ||
    portal.visible_after_publication !== true || portal.portal_link_issued !== false ||
    portal.human_portal_link_issuance_required !== true ||
    parsed.customer_delivery_mutated !== false || parsed.contract_acceptance_mutated !== false ||
    parsed.customer_quote_mutated !== false
  ) return null;
  return {
    would_write: false,
    target: { doctype: "Proposal Evidence Pack", proposal_evidence_pack_id: targetId },
    before: {
      proposal_evidence_pack_id: beforeId,
      roof_job: roofJob,
      quotation,
      status,
    },
    publication: { status: "Approved" },
    customer_portal: {
      visible_after_publication: true,
      portal_link_issued: false,
      human_portal_link_issuance_required: true,
    },
    effects: noCustomerEffects(),
  };
}

function safeProposalPublicationApprovalOutcome(
  value: string | null,
  record: ProposalPublicationApprovalRequestRecord,
): ProposalPublicationApprovalOutcome | null {
  const parsed = value ? parseObject(value) : null;
  if (!parsed) return null;
  const runId = boundedText(parsed.run_id, 8, 128);
  const packId = boundedText(parsed.proposal_evidence_pack_id, 1, 140);
  const quoteId = boundedText(parsed.customer_quote_id, 1, 140);
  if (
    !runId || !packId || !quoteId || parsed.published !== true || parsed.audit_finalized !== true ||
    parsed.status !== "Approved" || runId !== record.run_id ||
    packId !== record.proposal_evidence_pack_id || quoteId !== record.customer_quote_id
  ) return null;
  return {
    run_id: runId,
    published: true,
    proposal_evidence_pack_id: packId,
    customer_quote_id: quoteId,
    status: "Approved",
    audit_finalized: true,
    ...noCustomerEffects(),
    customer_portal_link_issued: false as const,
  };
}

function noCustomerEffects() {
  return {
    customer_delivery_mutated: false as const,
    contract_acceptance_mutated: false as const,
    customer_quote_mutated: false as const,
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

function clampLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 50;
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function failMissing(message: string): never {
  throw new Error(message);
}
