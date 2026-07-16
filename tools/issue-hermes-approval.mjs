#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { approvedArgs, digest, signApprovalReceipt } from "../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";

const inputPath = process.argv[2];
const privateKeyPath = process.env.HERMES_APPROVAL_PRIVATE_KEY_FILE;
const approverId = process.env.HERMES_APPROVER_ID;

if (!inputPath || !privateKeyPath || !approverId) {
  throw new Error(
    "usage: HERMES_APPROVER_ID=owner@example.com HERMES_APPROVAL_PRIVATE_KEY_FILE=/secure/key.pem node tools/issue-hermes-approval.mjs approval-request.json",
  );
}

const request = JSON.parse(readFileSync(inputPath, "utf8"));
const required = [
  "write_tool",
  "dry_run_receipt",
  "agent_role",
  "actor_user",
  "site_id",
  "approved_by",
  "write_args",
];
for (const key of required) {
  if (!request[key]) throw new Error(`approval_request_${key}_required`);
}
if (!request.write_args.run_id || !request.write_args.request_text) {
  throw new Error("approval_request_write_args_must_include_run_id_and_request_text");
}
if (request.write_args.approved_by !== request.approved_by) {
  throw new Error("approval_request_approved_by_mismatch");
}
if (request.approved_by !== approverId) {
  throw new Error("approval_request_approver_identity_mismatch");
}

const expiresAt = request.expires_at ?? new Date(Date.now() + 5 * 60_000).toISOString();
const expiresMs = Date.parse(expiresAt);
if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() || expiresMs > Date.now() + 10 * 60_000) {
  throw new Error("approval_request_expiry_must_be_between_now_and_10_minutes");
}

const approvalReceipt = signApprovalReceipt(readFileSync(privateKeyPath, "utf8"), {
  write_tool: request.write_tool,
  dry_run_receipt: request.dry_run_receipt,
  agent_role: request.agent_role,
  actor_user: request.actor_user,
  site_id: request.site_id,
  run_id: request.write_args.run_id,
  approved_by: request.approved_by,
  args_digest: digest(approvedArgs(request.write_args)),
  issued_at: new Date().toISOString(),
  expires_at: expiresAt,
});

process.stdout.write(`${JSON.stringify({ approval_receipt: approvalReceipt, expires_at: expiresAt })}\n`);
