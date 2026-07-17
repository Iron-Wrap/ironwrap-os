import type { AppEnv } from "./app-types.ts";

export const PRODUCTION_SCHEDULE_APPROVAL_STATES = [
  "pending",
  "executing",
  "executed",
  "denied",
  "expired",
  "failed",
  "audit_failed",
  "execution_uncertain",
] as const;

export type ProductionScheduleApprovalState = (typeof PRODUCTION_SCHEDULE_APPROVAL_STATES)[number];
export type ProductionScheduleApprovalRequestKind = "production_schedule";
export type ProductionScheduleApprovalTransitionActorKind = "app_user" | "approval_broker" | "system";
export type ProductionScheduleApprovalExecutionTerminalState = Extract<
  ProductionScheduleApprovalState,
  "executed" | "failed" | "audit_failed" | "execution_uncertain"
>;

export interface ProductionScheduleApprovalRequestRecord {
  production_schedule_approval_id: string;
  tenant_id: string;
  request_kind: ProductionScheduleApprovalRequestKind;
  state: ProductionScheduleApprovalState;
  version: number;
  prepare_idempotency_key: string;
  intent_fingerprint: string;
  write_tool: "request_create_job_assignment";
  dry_run_tool: "dry_run_job_assignment";
  agent_role: "production-controller";
  actor_user: string;
  site_id: string;
  target_doctype: "Job Assignment";
  target_name: string;
  roof_job_id: string;
  target_assignment_id: string;
  crew_profile_id: string;
  scheduled_start: string;
  scheduled_end: string | null;
  supersedes_assignment_id: string | null;
  correction_reason: string | null;
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
  transition_actor_kind: ProductionScheduleApprovalTransitionActorKind;
  transition_actor_id: string | null;
  transition_actor_frappe_user: string | null;
  transition_detail_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProductionScheduleApprovalPreview {
  would_write: false;
  append_only: true;
  production_schedule_gate_preview: { required: true; state_eligible: true };
  target: { doctype: "Job Assignment"; assignment_id: string };
  assignment: {
    assignment_id: string;
    roof_job_id: string;
    crew_profile_id: string;
    scheduled_start: string;
    scheduled_end: string | null;
    supersedes_assignment_id: string | null;
    correction_reason: string | null;
  };
  effects: {
    crew_notified: false;
    customer_notified: false;
    accounting_mutated: false;
  };
}

export interface ProductionScheduleApprovalOutcome {
  run_id: string;
  created: true;
  assignment_id: string;
  roof_job_id: string;
  crew_profile_id: string;
  scheduled_start: string;
  scheduled_end: string | null;
  supersedes_assignment_id: string | null;
  audit_finalized: true;
  crew_notified: false;
  customer_notified: false;
  accounting_mutated: false;
}

export interface ProductionScheduleApprovalRequestProjection {
  id: string;
  kind: ProductionScheduleApprovalRequestKind;
  state: ProductionScheduleApprovalState;
  version: number;
  action: "create_job_assignment";
  roof_job_id: string;
  target: { doctype: "Job Assignment"; assignment_id: string };
  crew_profile_id: string;
  scheduled_start: string;
  scheduled_end: string | null;
  supersedes_assignment_id: string | null;
  correction_reason: string | null;
  request_text: string;
  preview: ProductionScheduleApprovalPreview | null;
  expires_at: string;
  requested_by: { user_id: string; frappe_user: string | null };
  approved_by: { user_id: string; frappe_user: string; approved_at: string } | null;
  rejection_reason: string | null;
  run_id: string;
  hermes_run_id: string | null;
  outcome: ProductionScheduleApprovalOutcome | null;
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

export interface CreateProductionScheduleApprovalRequestInput {
  id: string;
  tenantId: string;
  prepareIdempotencyKey: string;
  intentFingerprint: string;
  actorUser: string;
  siteId: string;
  roofJobId: string;
  targetAssignmentId: string;
  crewProfileId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
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

export type CreateProductionScheduleApprovalRequestResult =
  | { kind: "created"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "replayed"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "conflict"; request: ProductionScheduleApprovalRequestRecord };

export type ClaimProductionScheduleApprovalExecutionResult =
  | { kind: "claimed"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "replayed"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "already_decided"; request: ProductionScheduleApprovalRequestRecord };

export type DenyProductionScheduleApprovalRequestResult =
  | { kind: "denied"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "replayed"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "expired"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "already_decided"; request: ProductionScheduleApprovalRequestRecord };

export type FinalizeProductionScheduleApprovalExecutionResult =
  | { kind: "finalized"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "lost_claim"; request: ProductionScheduleApprovalRequestRecord | null };

export type ReconcileProductionScheduleApprovalUncertaintyResult =
  | { kind: "reconciled"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "missing" }
  | { kind: "not_uncertain"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "already_reconciled"; request: ProductionScheduleApprovalRequestRecord }
  | { kind: "version_conflict"; request: ProductionScheduleApprovalRequestRecord };

export async function createProductionScheduleApprovalRequest(
  env: AppEnv,
  input: CreateProductionScheduleApprovalRequestInput,
): Promise<CreateProductionScheduleApprovalRequestResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO production_schedule_approval_requests (
       production_schedule_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
       intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
       target_doctype, target_name, roof_job_id, target_assignment_id, crew_profile_id, scheduled_start,
       scheduled_end, supersedes_assignment_id, correction_reason, request_text, write_args_json, preview_json,
       args_digest, preview_digest, receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id,
       requested_by_frappe_user, run_id, transition_actor_kind, transition_actor_id, transition_actor_frappe_user,
       transition_detail_code, created_at, updated_at
     ) VALUES (
       ?, ?, 'production_schedule', 'pending', 1, ?,
       ?, 'request_create_job_assignment', 'dry_run_job_assignment', 'production-controller', ?, ?,
       'Job Assignment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, 'app_user', ?, ?, 'production_schedule_approval_prepared', ?, ?
     )
     ON CONFLICT(tenant_id, prepare_idempotency_key) DO NOTHING
     RETURNING production_schedule_approval_id`,
  ).bind(
    input.id,
    input.tenantId,
    input.prepareIdempotencyKey,
    input.intentFingerprint,
    input.actorUser,
    input.siteId,
    input.targetAssignmentId,
    input.roofJobId,
    input.targetAssignmentId,
    input.crewProfileId,
    input.scheduledStart,
    input.scheduledEnd,
    input.supersedesAssignmentId,
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
  ).all<{ production_schedule_approval_id: string }>();

  const insertedId = inserted.results?.[0]?.production_schedule_approval_id;
  if (insertedId) {
    const request = await getProductionScheduleApprovalRequest(env, input.tenantId, insertedId);
    if (!request) throw new Error("production_schedule_approval_insert_missing");
    return { kind: "created", request };
  }

  const existing = await findProductionScheduleApprovalRequestByPrepareKey(env, input.tenantId, input.prepareIdempotencyKey);
  if (!existing) throw new Error("production_schedule_approval_idempotency_lookup_missing");
  return existing.intent_fingerprint === input.intentFingerprint
    ? { kind: "replayed", request: existing }
    : { kind: "conflict", request: existing };
}

export async function listProductionScheduleApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  limit = 50,
): Promise<ProductionScheduleApprovalRequestRecord[]> {
  await expirePendingProductionScheduleApprovalRequests(env, tenantId, now);
  const result = await env.DB.prepare(
    `${selectProductionScheduleApprovalRequestSql}
     WHERE tenant_id = ?
     ORDER BY
       CASE state WHEN 'pending' THEN 0 WHEN 'executing' THEN 1 WHEN 'execution_uncertain' THEN 2 ELSE 3 END,
       updated_at DESC, production_schedule_approval_id DESC
     LIMIT ?`,
  ).bind(tenantId, clampLimit(limit)).all<ProductionScheduleApprovalRequestRecord>();
  return (result.results ?? []).map(normalizeProductionScheduleApprovalRequest);
}

export async function getProductionScheduleApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
): Promise<ProductionScheduleApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectProductionScheduleApprovalRequestSql} WHERE tenant_id = ? AND production_schedule_approval_id = ? LIMIT 1`,
  ).bind(tenantId, requestId).first<ProductionScheduleApprovalRequestRecord>();
  return row ? normalizeProductionScheduleApprovalRequest(row) : null;
}

export async function getProductionScheduleApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ProductionScheduleApprovalRequestRecord | null> {
  return await findProductionScheduleApprovalRequestByPrepareKey(env, tenantId, prepareIdempotencyKey);
}

export function matchesProductionScheduleApprovalPreparation(
  record: ProductionScheduleApprovalRequestRecord,
  input: {
    requestedByUserId: string;
    roofJobId: string;
    targetAssignmentId: string;
    crewProfileId: string;
    scheduledStart: string;
    scheduledEnd: string | null;
    supersedesAssignmentId: string | null;
    correctionReason: string | null;
    requestText: string;
  },
): boolean {
  const args = parseObject(record.write_args_json);
  if (!args) return false;
  return record.requested_by_user_id === input.requestedByUserId &&
    record.roof_job_id === input.roofJobId &&
    record.target_assignment_id === input.targetAssignmentId &&
    record.crew_profile_id === input.crewProfileId &&
    record.scheduled_start === input.scheduledStart &&
    record.scheduled_end === input.scheduledEnd &&
    record.supersedes_assignment_id === input.supersedesAssignmentId &&
    record.correction_reason === input.correctionReason &&
    record.request_text === input.requestText &&
    args.roof_job_id === input.roofJobId &&
    // The deterministic target is broker-derived and persisted separately.
    // It is intentionally not a Frappe write argument or browser capability.
    args.crew_profile_id === input.crewProfileId &&
    args.scheduled_start === input.scheduledStart &&
    (input.scheduledEnd === null
      ? !Object.hasOwn(args, "scheduled_end")
      : args.scheduled_end === input.scheduledEnd) &&
    (input.supersedesAssignmentId === null
      ? !Object.hasOwn(args, "supersedes") && !Object.hasOwn(args, "correction_reason")
      : args.supersedes === input.supersedesAssignmentId &&
        args.correction_reason === input.correctionReason) &&
    args.request_text === input.requestText;
}

export async function getCurrentProductionScheduleApprovalRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
  now: string,
): Promise<ProductionScheduleApprovalRequestRecord | null> {
  await expirePendingProductionScheduleApprovalRequests(env, tenantId, now, requestId);
  return await getProductionScheduleApprovalRequest(env, tenantId, requestId);
}

export async function claimProductionScheduleApprovalExecution(
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
): Promise<ClaimProductionScheduleApprovalExecutionResult> {
  await expirePendingProductionScheduleApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET state = 'executing', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, execution_lease_expires_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'production_schedule_approval_execute_claimed',
         updated_at = ?
     WHERE tenant_id = ? AND production_schedule_approval_id = ? AND state = 'pending'
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
    const claimed = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
    if (!claimed) throw new Error("production_schedule_approval_claim_missing");
    return { kind: "claimed", request: claimed };
  }
  return await resolveClaimRace(env, input);
}

export async function denyProductionScheduleApprovalRequest(
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
): Promise<DenyProductionScheduleApprovalRequestResult> {
  await expirePendingProductionScheduleApprovalRequests(env, input.tenantId, input.now, input.requestId);
  const current = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state === "expired") return { kind: "expired", request: current };
  if (current.state !== "pending") {
    return sameDecision(current, input) ? { kind: "replayed", request: current } : { kind: "already_decided", request: current };
  }
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };

  const result = await env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET state = 'denied', version = version + 1,
         approved_by_user_id = ?, approved_by_frappe_user = ?, approved_at = ?,
         decision_idempotency_key = ?, rejection_reason = ?, completed_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'production_schedule_approval_denied',
         updated_at = ?
     WHERE tenant_id = ? AND production_schedule_approval_id = ? AND state = 'pending'
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
    const denied = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
    if (!denied) throw new Error("production_schedule_approval_deny_missing");
    return { kind: "denied", request: denied };
  }
  const latest = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

export async function finalizeProductionScheduleApprovalExecution(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    decisionIdempotencyKey: string;
    state: ProductionScheduleApprovalExecutionTerminalState;
    hermesRunId?: string | null;
    resultJson?: string | null;
    errorCode?: string | null;
    now: string;
  },
): Promise<FinalizeProductionScheduleApprovalExecutionResult> {
  const result = await env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET state = ?, version = version + 1, hermes_run_id = ?, result_json = ?, error_code = ?,
         execution_lease_expires_at = NULL, completed_at = ?,
         transition_actor_kind = 'approval_broker', transition_actor_id = 'production-schedule-broker',
         transition_actor_frappe_user = NULL, transition_detail_code = ?, updated_at = ?
     WHERE tenant_id = ? AND production_schedule_approval_id = ? AND state = 'executing'
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
  const request = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  return d1Changes(result) === 1
    ? { kind: "finalized", request: request ?? failMissing("production_schedule_approval_finalize_missing") }
    : { kind: "lost_claim", request };
}

export async function expirePendingProductionScheduleApprovalRequests(
  env: AppEnv,
  tenantId: string,
  now: string,
  requestId?: string,
): Promise<void> {
  const requestClause = requestId ? " AND production_schedule_approval_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET state = 'expired', version = version + 1, completed_at = ?,
         transition_actor_kind = 'system', transition_actor_id = 'production-schedule-approval-expiry-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'production_schedule_approval_expired', updated_at = ?
     WHERE tenant_id = ? AND state = 'pending' AND expires_at <= ?${requestClause}`,
  );
  const bound = requestId
    ? statement.bind(now, now, tenantId, now, requestId)
    : statement.bind(now, now, tenantId, now);
  await bound.run();
}

/** A stale broker call is reconciliation work, not a retry opportunity. */
export async function markExpiredProductionScheduleApprovalExecutionLeases(
  env: AppEnv,
  now: string,
  tenantId?: string,
): Promise<number> {
  const tenantClause = tenantId ? " AND tenant_id = ?" : "";
  const statement = env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET state = 'execution_uncertain', version = version + 1,
         execution_lease_expires_at = NULL, completed_at = ?, error_code = 'broker_response_timeout',
         transition_actor_kind = 'system', transition_actor_id = 'production-schedule-approval-lease-sweep',
         transition_actor_frappe_user = NULL, transition_detail_code = 'production_schedule_approval_execution_lease_expired', updated_at = ?
     WHERE state = 'executing' AND execution_lease_expires_at <= ?${tenantClause}`,
  );
  const result = tenantId
    ? await statement.bind(now, now, now, tenantId).run()
    : await statement.bind(now, now, now).run();
  return d1Changes(result);
}

export async function reconcileProductionScheduleApprovalUncertainty(
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
): Promise<ReconcileProductionScheduleApprovalUncertaintyResult> {
  const current = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!current) return { kind: "missing" };
  if (current.state !== "execution_uncertain") return { kind: "not_uncertain", request: current };
  if (current.reconciled_at) return { kind: "already_reconciled", request: current };
  if (current.version !== input.expectedVersion) return { kind: "version_conflict", request: current };
  const result = await env.DB.prepare(
    `UPDATE production_schedule_approval_requests
     SET version = version + 1, reconciled_at = ?, reconciled_by_user_id = ?,
         reconciled_by_frappe_user = ?, reconciliation_outcome = ?, reconciliation_evidence = ?,
         transition_actor_kind = 'app_user', transition_actor_id = ?,
         transition_actor_frappe_user = ?, transition_detail_code = 'production_schedule_approval_execution_uncertainty_reconciled', updated_at = ?
     WHERE tenant_id = ? AND production_schedule_approval_id = ? AND state = 'execution_uncertain'
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
    const reconciled = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
    if (!reconciled) throw new Error("production_schedule_approval_reconciliation_missing");
    return { kind: "reconciled", request: reconciled };
  }
  const latest = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state !== "execution_uncertain") return { kind: "not_uncertain", request: latest };
  if (latest.reconciled_at) return { kind: "already_reconciled", request: latest };
  return { kind: "version_conflict", request: latest };
}

export function productionScheduleApprovalProjection(
  record: ProductionScheduleApprovalRequestRecord,
): ProductionScheduleApprovalRequestProjection {
  return {
    id: record.production_schedule_approval_id,
    kind: "production_schedule",
    state: record.state,
    version: record.version,
    action: "create_job_assignment",
    roof_job_id: record.roof_job_id,
    target: { doctype: "Job Assignment", assignment_id: record.target_assignment_id },
    crew_profile_id: record.crew_profile_id,
    scheduled_start: record.scheduled_start,
    scheduled_end: record.scheduled_end,
    supersedes_assignment_id: record.supersedes_assignment_id,
    correction_reason: record.correction_reason,
    request_text: record.request_text,
    preview: safeProductionScheduleApprovalPreview(record.preview_json, record),
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
    outcome: safeProductionScheduleApprovalOutcome(record.result_json, record),
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

const selectProductionScheduleApprovalRequestSql = `SELECT
  production_schedule_approval_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
  intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
  target_doctype, target_name, roof_job_id, target_assignment_id, crew_profile_id, scheduled_start,
  scheduled_end, supersedes_assignment_id, correction_reason, request_text, write_args_json, preview_json,
  args_digest, preview_digest, receipt_preview_digest, dry_run_receipt, expires_at, requested_by_user_id,
  requested_by_frappe_user, approved_by_user_id, approved_by_frappe_user, approved_at, decision_idempotency_key,
  rejection_reason, run_id, execution_lease_expires_at, hermes_run_id, result_json, error_code, reconciled_at,
  reconciled_by_user_id, reconciled_by_frappe_user, reconciliation_outcome, reconciliation_evidence,
  transition_actor_kind, transition_actor_id, transition_actor_frappe_user, transition_detail_code,
  created_at, updated_at, completed_at
 FROM production_schedule_approval_requests`;

async function findProductionScheduleApprovalRequestByPrepareKey(
  env: AppEnv,
  tenantId: string,
  prepareIdempotencyKey: string,
): Promise<ProductionScheduleApprovalRequestRecord | null> {
  const row = await env.DB.prepare(
    `${selectProductionScheduleApprovalRequestSql} WHERE tenant_id = ? AND prepare_idempotency_key = ? LIMIT 1`,
  ).bind(tenantId, prepareIdempotencyKey).first<ProductionScheduleApprovalRequestRecord>();
  return row ? normalizeProductionScheduleApprovalRequest(row) : null;
}

async function resolveClaimRace(
  env: AppEnv,
  input: Parameters<typeof claimProductionScheduleApprovalExecution>[1],
): Promise<ClaimProductionScheduleApprovalExecutionResult> {
  const latest = await getProductionScheduleApprovalRequest(env, input.tenantId, input.requestId);
  if (!latest) return { kind: "missing" };
  if (latest.state === "expired") return { kind: "expired", request: latest };
  if (latest.state !== "pending") {
    return sameDecision(latest, input) ? { kind: "replayed", request: latest } : { kind: "already_decided", request: latest };
  }
  return { kind: "version_conflict", request: latest };
}

function sameDecision(
  current: ProductionScheduleApprovalRequestRecord,
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

function terminalTransitionCode(state: ProductionScheduleApprovalExecutionTerminalState): string {
  if (state === "executed") return "production_schedule_broker_execution_succeeded";
  if (state === "audit_failed") return "production_schedule_broker_audit_finalization_failed";
  if (state === "execution_uncertain") return "production_schedule_broker_execution_uncertain";
  return "production_schedule_broker_execution_failed";
}

function normalizeProductionScheduleApprovalRequest(
  row: ProductionScheduleApprovalRequestRecord,
): ProductionScheduleApprovalRequestRecord {
  return {
    ...row,
    request_kind: "production_schedule",
    state: PRODUCTION_SCHEDULE_APPROVAL_STATES.includes(row.state as ProductionScheduleApprovalState)
      ? row.state as ProductionScheduleApprovalState
      : "failed",
    version: Number(row.version),
    scheduled_end: nullableText(row.scheduled_end),
    supersedes_assignment_id: nullableText(row.supersedes_assignment_id),
    correction_reason: nullableText(row.correction_reason),
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

function safeProductionScheduleApprovalPreview(
  value: string,
  record: ProductionScheduleApprovalRequestRecord,
): ProductionScheduleApprovalPreview | null {
  const parsed = parseObject(value);
  if (!parsed || parsed.would_write !== false || parsed.append_only !== true) return null;
  const gate = object(parsed.production_schedule_gate_preview);
  const target = object(parsed.target);
  const assignment = object(parsed.assignment);
  if (!gate || gate.required !== true || gate.state_eligible !== true || !target || !assignment || target.doctype !== "Job Assignment") {
    return null;
  }
  const targetAssignmentId = boundedText(target.name, 1, 140);
  const assignmentId = boundedText(assignment.assignment_id, 1, 140);
  const roofJobId = boundedText(assignment.roof_job_id, 1, 140);
  const crewProfileId = boundedText(assignment.crew_profile_id, 1, 140);
  const scheduledStart = boundedText(assignment.scheduled_start, 1, 80);
  const scheduledEnd = requiredNullableBoundedText(assignment, "scheduled_end", 1, 80);
  const supersedesAssignmentId = requiredNullableBoundedText(assignment, "supersedes_assignment_id", 1, 140);
  const correctionReason = requiredNullableBoundedText(assignment, "correction_reason", 1, 2000);
  if (
    !targetAssignmentId || !assignmentId || !roofJobId || !crewProfileId || !scheduledStart ||
    scheduledEnd === undefined || supersedesAssignmentId === undefined || correctionReason === undefined ||
    targetAssignmentId !== record.target_assignment_id || assignmentId !== record.target_assignment_id ||
    roofJobId !== record.roof_job_id || crewProfileId !== record.crew_profile_id ||
    scheduledStart !== record.scheduled_start || scheduledEnd !== record.scheduled_end ||
    supersedesAssignmentId !== record.supersedes_assignment_id || correctionReason !== record.correction_reason ||
    (scheduledEnd !== null && scheduledEnd <= scheduledStart)
  ) return null;
  return {
    would_write: false,
    append_only: true,
    production_schedule_gate_preview: { required: true, state_eligible: true },
    target: { doctype: "Job Assignment", assignment_id: targetAssignmentId },
    assignment: {
      assignment_id: assignmentId,
      roof_job_id: roofJobId,
      crew_profile_id: crewProfileId,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      supersedes_assignment_id: supersedesAssignmentId,
      correction_reason: correctionReason,
    },
    effects: noOperationalEffects(),
  };
}

function safeProductionScheduleApprovalOutcome(
  value: string | null,
  record: ProductionScheduleApprovalRequestRecord,
): ProductionScheduleApprovalOutcome | null {
  const parsed = value ? parseObject(value) : null;
  if (!parsed) return null;
  const runId = boundedText(parsed.run_id, 8, 128);
  const assignmentId = boundedText(parsed.assignment_id, 1, 140);
  const roofJobId = boundedText(parsed.roof_job_id, 1, 140);
  const crewProfileId = boundedText(parsed.crew_profile_id, 1, 140);
  const scheduledStart = boundedText(parsed.scheduled_start, 1, 80);
  const scheduledEnd = nullableBoundedText(parsed.scheduled_end, 1, 80);
  const supersedesAssignmentId = nullableBoundedText(parsed.supersedes_assignment_id, 1, 140);
  if (
    !runId || !assignmentId || !roofJobId || !crewProfileId || !scheduledStart ||
    scheduledEnd === undefined || supersedesAssignmentId === undefined || parsed.created !== true ||
    parsed.audit_finalized !== true || runId !== record.run_id || assignmentId !== record.target_assignment_id ||
    roofJobId !== record.roof_job_id || crewProfileId !== record.crew_profile_id ||
    scheduledStart !== record.scheduled_start || scheduledEnd !== record.scheduled_end ||
    supersedesAssignmentId !== record.supersedes_assignment_id ||
    (scheduledEnd !== null && scheduledEnd <= scheduledStart)
  ) return null;
  return {
    run_id: runId,
    created: true,
    assignment_id: assignmentId,
    roof_job_id: roofJobId,
    crew_profile_id: crewProfileId,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    supersedes_assignment_id: supersedesAssignmentId,
    audit_finalized: true,
    ...noOperationalEffects(),
  };
}

function noOperationalEffects() {
  return {
    crew_notified: false as const,
    customer_notified: false as const,
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

function nullableBoundedText(value: unknown, min: number, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedText(value, min, max) ?? undefined;
}

function requiredNullableBoundedText(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string | null | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return nullableBoundedText(value[key], min, max);
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
