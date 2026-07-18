export type NewoControlStatus =
  | "previewed"
  | "approved"
  | "executing"
  | "completed"
  | "failed";

export interface NewoControlActionRecord {
  action_id: string;
  operation: string;
  args_hash: string;
  args_json: string;
  status: NewoControlStatus;
  requested_by: string;
  approved_by: string | null;
  approval_reason: string | null;
  dry_run_receipt_hash: string | null;
  approval_receipt_hash: string | null;
  provider_response_hash: string | null;
  dry_run_expires_at: string | null;
  approval_expires_at: string | null;
  result_json: string | null;
  consumed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function createNewoControlPreview(
  env: Env,
  record: Pick<
    NewoControlActionRecord,
    | "action_id"
    | "operation"
    | "args_hash"
    | "args_json"
    | "requested_by"
    | "dry_run_receipt_hash"
    | "dry_run_expires_at"
    | "created_at"
    | "updated_at"
  >,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO newo_control_actions (
       action_id, operation, args_hash, args_json, status, requested_by,
       dry_run_receipt_hash, dry_run_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?)`,
  ).bind(
    record.action_id,
    record.operation,
    record.args_hash,
    record.args_json,
    record.requested_by,
    record.dry_run_receipt_hash,
    record.dry_run_expires_at,
    record.created_at,
    record.updated_at,
  ).run();
}

export async function getNewoControlAction(
  env: Env,
  actionId: string,
): Promise<NewoControlActionRecord | null> {
  return await env.DB.prepare(
    "SELECT * FROM newo_control_actions WHERE action_id = ?",
  ).bind(actionId).first<NewoControlActionRecord>();
}

export async function approveNewoControlAction(
  env: Env,
  input: {
    actionId: string;
    approvedBy: string;
    approvalReason: string;
    approvalReceiptHash: string;
    approvalExpiresAt: string;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE newo_control_actions
        SET status = 'approved', approved_by = ?, approval_reason = ?,
            approval_receipt_hash = ?, approval_expires_at = ?, updated_at = ?
      WHERE action_id = ? AND status = 'previewed' AND dry_run_expires_at > ?`,
  ).bind(
    input.approvedBy,
    input.approvalReason,
    input.approvalReceiptHash,
    input.approvalExpiresAt,
    input.now,
    input.actionId,
    input.now,
  ).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function claimNewoControlExecution(
  env: Env,
  input: {
    actionId: string;
    dryRunReceiptHash: string;
    approvalReceiptHash: string;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE newo_control_actions
        SET status = 'executing', consumed_at = ?, updated_at = ?
      WHERE action_id = ? AND status = 'approved'
        AND dry_run_receipt_hash = ? AND approval_receipt_hash = ?
        AND dry_run_expires_at > ? AND approval_expires_at > ?`,
  ).bind(
    input.now,
    input.now,
    input.actionId,
    input.dryRunReceiptHash,
    input.approvalReceiptHash,
    input.now,
    input.now,
  ).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function completeNewoControlAction(
  env: Env,
  actionId: string,
  providerResponseHash: string,
  resultJson: string,
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE newo_control_actions
        SET status = 'completed', provider_response_hash = ?, result_json = ?,
            last_error = NULL, completed_at = ?, updated_at = ?
      WHERE action_id = ? AND status = 'executing'`,
  ).bind(providerResponseHash, resultJson, now, now, actionId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function failNewoControlAction(
  env: Env,
  actionId: string,
  error: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE newo_control_actions
        SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
      WHERE action_id = ? AND status = 'executing'`,
  ).bind(error.slice(0, 500), now, now, actionId).run();
}

export async function listNewoControlActions(
  env: Env,
  limit: number,
): Promise<Array<Omit<NewoControlActionRecord, "args_json" | "result_json">>> {
  const result = await env.DB.prepare(
    `SELECT action_id, operation, args_hash, status, requested_by, approved_by,
            approval_reason, dry_run_receipt_hash, approval_receipt_hash,
            provider_response_hash, dry_run_expires_at, approval_expires_at,
            consumed_at, last_error, created_at, updated_at, completed_at
       FROM newo_control_actions
      ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all<Omit<NewoControlActionRecord, "args_json" | "result_json">>();
  return result.results ?? [];
}
