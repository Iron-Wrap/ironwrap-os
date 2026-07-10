import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvedArgs,
  digest,
  semanticPreview,
  signApprovalReceipt,
  signDryRunReceipt,
  verifyApprovalReceipt,
  verifyDryRunReceipt,
} from "../src/approval-contract.mjs";

const EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

test("approval receipts bind role, actor, run, arguments, and the exact dry-run receipt", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const writeArgs = {
    gate_id: "gate:1",
    next_state: "Ready",
    request_text: "Deposit verified by owner",
    approved_by: "owner@example.com",
    run_id: "run-approval-0001",
    dry_run_receipt: "receipt-will-be-injected",
    approval_receipt: "receipt-will-be-injected",
  };
  const dryRunReceipt = signDryRunReceipt("a".repeat(32), {
    dry_run_tool: "dry_run_update_gate",
    write_tool: "request_update_gate",
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    args_digest: digest({ gate_id: "gate:1", next_state: "Ready" }),
    preview_digest: digest({ target: "gate:1", patch: { state: "Ready" } }),
    issued_at: new Date().toISOString(),
    expires_at: EXPIRES_AT,
  });
  writeArgs.dry_run_receipt = dryRunReceipt;
  const approvalReceipt = signApprovalReceipt(privateKey, {
    write_tool: "request_update_gate",
    dry_run_receipt: dryRunReceipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: EXPIRES_AT,
  });

  verifyDryRunReceipt("a".repeat(32), dryRunReceipt, {
    dry_run_tool: "dry_run_update_gate",
    write_tool: "request_update_gate",
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    args_digest: digest({ gate_id: "gate:1", next_state: "Ready" }),
    preview_digest: digest({ target: "gate:1", patch: { state: "Ready" } }),
  });
  assert.doesNotThrow(() => verifyApprovalReceipt(publicKey, approvalReceipt, {
    write_tool: "request_update_gate",
    dry_run_receipt: dryRunReceipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
  }));
  assert.throws(() => verifyApprovalReceipt(publicKey, approvalReceipt, {
    write_tool: "request_update_gate",
    dry_run_receipt: dryRunReceipt,
    agent_role: "field-companion",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
  }), /agent_role/);
  assert.throws(() => verifyApprovalReceipt(publicKey, approvalReceipt, {
    write_tool: "request_update_gate",
    dry_run_receipt: dryRunReceipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: "site:ironwrap-1",
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest({ ...approvedArgs(writeArgs), next_state: "Waived" }),
  }), /args_digest/);
});

test("semantic preview excludes generated safety acknowledgement timestamps", () => {
  const firstPreview = semanticPreview({
    patch: {
      acknowledgements: [{
        acknowledged_by: "crew@example.com",
        acknowledged_at: "2026-07-10T18:00:00.000Z",
        acknowledgement_method: "QR Device Pairing",
        device_action_id: "device-action-0001",
      }],
    },
  });
  const replayedPreview = semanticPreview({
    patch: {
      acknowledgements: [{
        acknowledged_by: "crew@example.com",
        acknowledged_at: "2026-07-10T18:00:01.000Z",
        acknowledgement_method: "QR Device Pairing",
        device_action_id: "device-action-0001",
      }],
    },
  });

  assert.deepEqual(firstPreview, {
    patch: {
      acknowledgements: [{
        acknowledged_by: "crew@example.com",
        acknowledgement_method: "QR Device Pairing",
        device_action_id: "device-action-0001",
      }],
    },
  });
  assert.equal(digest(firstPreview), digest(replayedPreview));
});
