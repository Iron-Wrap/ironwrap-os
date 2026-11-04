import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AppEnv } from "../src/app-types.ts";
import {
  claimGovernedTransitionOutbox,
  claimNextPendingGovernedTransitionOutbox,
  getGovernedTransitionOutbox,
} from "../src/transition-kernel.ts";

const CREATED = "2026-07-30T10:00:00.000Z";
const EXPIRES = "2026-07-30T10:05:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0016_approval_requests.sql",
      "0027_transition_kernel.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, 1, 'seed', ?, ?)`,
    ).run("appu_owner_0001", "ironwrap", "owner@example.com", "Owner", "owner@example.com", CREATED, CREATED);
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

function env(db = new SqliteD1()): AppEnv {
  return { DB: db as never } as AppEnv;
}

// The approval execution store that used to drive these rows retired with the Frappe approval
// brokers. The transition kernel and its D1 triggers (0027) remain, so these helpers drive the
// approval_requests ledger through the same guarded statements that store issued, and every
// assertion below still proves the triggers and the kernel, not a re-implementation of them.
const APPROVAL_REQUEST_ID = "approval_request_0001";

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function seedPendingApproval(db: SqliteD1): string {
  db.raw.prepare(
    `INSERT INTO approval_requests (
       approval_request_id, tenant_id, request_kind, state, version, prepare_idempotency_key,
       intent_fingerprint, write_tool, dry_run_tool, agent_role, actor_user, site_id,
       target_doctype, target_name, lead_envelope_id, request_text, write_args_json, preview_json,
       args_digest, preview_digest, dry_run_receipt, expires_at, requested_by_user_id,
       requested_by_frappe_user, run_id, transition_actor_kind, transition_actor_id,
       transition_actor_frappe_user, transition_detail_code, created_at, updated_at
     ) VALUES (
       ?, 'ironwrap', 'lead_triage', 'pending', 1, 'prepare-key-0001',
       ?, 'request_mark_lead_triaged', 'dry_run_mark_lead_triaged', 'lead-concierge',
       'concierge@example.com', 'site-ironwrap',
       'Lead Envelope', 'lead:001', 'lead:001', 'Approve the local triage annotation after review.', ?, ?,
       ?, ?, ?, ?, 'appu_owner_0001',
       'owner@example.com', 'run-lead-triage-0001', 'app_user', 'appu_owner_0001',
       'owner@example.com', 'approval_prepared', ?, ?
     )`,
  ).run(
    APPROVAL_REQUEST_ID,
    "a".repeat(64),
    JSON.stringify({ secret: "must-never-enter-transition-kernel" }),
    JSON.stringify({ would_write: false }),
    "b".repeat(64),
    "c".repeat(64),
    "d".repeat(32),
    EXPIRES,
    CREATED,
    CREATED,
  );
  return APPROVAL_REQUEST_ID;
}

function claimApproval(db: SqliteD1, approvalRequestId: string, decisionIdempotencyKey: string): void {
  const result = db.raw.prepare(
    `UPDATE approval_requests
     SET state = 'executing', version = version + 1,
         approved_by_user_id = 'appu_owner_0001', approved_by_frappe_user = 'owner@example.com',
         approved_at = ?, decision_idempotency_key = ?, execution_lease_expires_at = ?,
         transition_actor_kind = 'app_user', transition_actor_id = 'appu_owner_0001',
         transition_actor_frappe_user = 'owner@example.com',
         transition_detail_code = 'approval_execute_claimed', updated_at = ?
     WHERE tenant_id = 'ironwrap' AND approval_request_id = ? AND state = 'pending'
       AND version = 1 AND expires_at > ?`,
  ).run(
    "2026-07-30T10:01:00.000Z",
    decisionIdempotencyKey,
    "2026-07-30T10:03:00.000Z",
    "2026-07-30T10:01:00.000Z",
    approvalRequestId,
    "2026-07-30T10:01:00.000Z",
  );
  assert.ok(changes(result) >= 1, "the guarded claim must land");
}

function finalizeApproval(
  db: SqliteD1,
  input: {
    approvalRequestId: string;
    decisionIdempotencyKey: string;
    state: "executed" | "execution_uncertain";
    detailCode: string;
    hermesRunId?: string | null;
    resultJson?: string | null;
    errorCode?: string | null;
    now: string;
  },
): void {
  const result = db.raw.prepare(
    `UPDATE approval_requests
     SET state = ?, version = version + 1, hermes_run_id = ?, result_json = ?, error_code = ?,
         execution_lease_expires_at = NULL, completed_at = ?,
         transition_actor_kind = 'approval_broker', transition_actor_id = 'lead-triage-broker',
         transition_actor_frappe_user = NULL, transition_detail_code = ?, updated_at = ?
     WHERE tenant_id = 'ironwrap' AND approval_request_id = ? AND state = 'executing'
       AND decision_idempotency_key = ?`,
  ).run(
    input.state,
    input.hermesRunId ?? null,
    input.resultJson ?? null,
    input.errorCode ?? null,
    input.now,
    input.detailCode,
    input.now,
    input.approvalRequestId,
    input.decisionIdempotencyKey,
  );
  assert.ok(changes(result) >= 1, "the guarded finalization must land");
}

function reconcileApproval(db: SqliteD1, approvalRequestId: string, now: string): void {
  const result = db.raw.prepare(
    `UPDATE approval_requests
     SET version = version + 1, reconciled_at = ?, reconciled_by_user_id = 'appu_owner_0001',
         reconciled_by_frappe_user = 'owner@example.com', reconciliation_outcome = 'inconclusive',
         reconciliation_evidence = 'A human compared the canonical run reference; no retry was issued.',
         transition_actor_kind = 'app_user', transition_actor_id = 'appu_owner_0001',
         transition_actor_frappe_user = 'owner@example.com',
         transition_detail_code = 'execution_uncertainty_reconciled', updated_at = ?
     WHERE tenant_id = 'ironwrap' AND approval_request_id = ? AND state = 'execution_uncertain'
       AND version = 3 AND reconciled_at IS NULL`,
  ).run(now, now, approvalRequestId);
  assert.ok(changes(result) >= 1, "the guarded reconciliation must land");
}

function createAndClaimApproval(db: SqliteD1) {
  const approvalRequestId = seedPendingApproval(db);
  const decisionIdempotencyKey = `decision-${approvalRequestId}`;
  claimApproval(db, approvalRequestId, decisionIdempotencyKey);
  return { approvalRequestId, decisionIdempotencyKey };
}

test("approval claim atomically records a redacted transition and never-attempted outbox intent", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const { approvalRequestId, decisionIdempotencyKey } = createAndClaimApproval(db);

  const outbox = await getGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
  });
  assert.equal(outbox?.state, "pending");
  assert.equal(outbox?.attempt_count, 0);
  assert.equal(outbox?.attempt_mode, "none");
  assert.equal(outbox?.lease_ref, null);

  const transition = db.raw.prepare(
    `SELECT subject_ref, subject_version, authority_ref, policy_ref, intent_digest, args_digest,
            preview_digest, correlation_ref, decision_idempotency_key
     FROM governed_transitions`,
  ).get() as {
    subject_ref: string;
    subject_version: number;
    authority_ref: string;
    policy_ref: string;
    intent_digest: string;
    args_digest: string;
    preview_digest: string;
    correlation_ref: string;
    decision_idempotency_key: string;
  };
  assert.equal(transition.subject_ref, approvalRequestId);
  assert.equal(transition.subject_version, 2);
  assert.equal(transition.authority_ref, "appu_owner_0001");
  assert.equal(transition.policy_ref, "request_mark_lead_triaged:dry_run_mark_lead_triaged");
  assert.equal(transition.intent_digest, "a".repeat(64));
  assert.equal(transition.args_digest, "b".repeat(64));
  assert.equal(transition.preview_digest, "c".repeat(64));
  assert.equal(transition.correlation_ref, "run-lead-triage-0001");
  assert.equal(transition.decision_idempotency_key, decisionIdempotencyKey);
  const raw = JSON.stringify(db.raw.prepare("SELECT * FROM governed_transition_outbox").get());
  assert.equal(raw.includes("must-never-enter-transition-kernel"), false);
  assert.throws(
    () => db.raw.prepare("UPDATE governed_transitions SET intent_digest = ?").run("f".repeat(64)),
    /governed_transitions_immutable/,
  );
});

test("only a pending intent can be leased, then approval terminal and reconciliation state project without retry", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const { approvalRequestId, decisionIdempotencyKey } = createAndClaimApproval(db);

  const next = await claimNextPendingGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    now: "2026-07-30T10:01:01.000Z",
    leaseExpiresAt: "2026-07-30T10:03:00.000Z",
  });
  assert.equal(next.kind, "claimed");
  assert.equal(next.kind === "claimed" ? next.outbox.state : null, "leased");
  assert.equal(next.kind === "claimed" ? next.outbox.attempt_count : null, 1);
  assert.equal(next.kind === "claimed" ? next.outbox.attempt_mode : null, "leased");

  const same = await claimGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
    now: "2026-07-30T10:01:02.000Z",
    leaseExpiresAt: "2026-07-30T10:03:00.000Z",
  });
  assert.equal(same.kind, "already_leased");

  finalizeApproval(db, {
    approvalRequestId,
    decisionIdempotencyKey,
    state: "execution_uncertain",
    detailCode: "broker_execution_uncertain",
    errorCode: "broker_response_timeout",
    now: "2026-07-30T10:03:01.000Z",
  });

  const uncertain = await getGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
  });
  assert.equal(uncertain?.state, "uncertain");
  assert.equal(uncertain?.attempt_count, 1);
  assert.equal(uncertain?.attempt_mode, "leased");
  assert.equal(uncertain?.result_code, "broker_response_timeout");

  const blocked = await claimGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
    now: "2026-07-30T10:04:00.000Z",
    leaseExpiresAt: "2026-07-30T10:05:00.000Z",
  });
  assert.equal(blocked.kind, "terminal");

  reconcileApproval(db, approvalRequestId, "2026-07-30T10:04:30.000Z");

  const outbox = await getGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
  });
  assert.equal(outbox?.state, "reconciled");
  assert.equal(outbox?.reconciliation_outcome, "inconclusive");
  assert.equal(outbox?.reconciliation_ref, `approval-reconciliation:${approvalRequestId}`);

  const events = db.raw.prepare(
    "SELECT event_type FROM governed_transition_outbox_events ORDER BY id",
  ).all() as Array<{ event_type: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    "intent_recorded",
    "leased",
    "uncertain",
    "reconciled",
  ]);
});

test("a pre-kernel dispatcher terminal result becomes an inferred, non-retryable outbox attempt", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const { approvalRequestId, decisionIdempotencyKey } = createAndClaimApproval(db);

  finalizeApproval(db, {
    approvalRequestId,
    decisionIdempotencyKey,
    state: "executed",
    detailCode: "broker_execution_succeeded",
    hermesRunId: "run-lead-triage-0001",
    resultJson: "{}",
    now: "2026-07-30T10:01:10.000Z",
  });

  const outbox = await getGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
  });
  assert.equal(outbox?.state, "succeeded");
  assert.equal(outbox?.attempt_count, 1);
  assert.equal(outbox?.attempt_mode, "inferred_terminal");
  assert.equal(outbox?.lease_ref, decisionIdempotencyKey);
  assert.equal(outbox?.result_ref, "run-lead-triage-0001");

  const retry = await claimGovernedTransitionOutbox(appEnv, {
    tenantId: "ironwrap",
    approvalRequestId,
    decisionIdempotencyKey,
    now: "2026-07-30T10:01:11.000Z",
    leaseExpiresAt: "2026-07-30T10:03:00.000Z",
  });
  assert.equal(retry.kind, "terminal");
});

test("the transition migration avoids CASE expressions in D1 trigger commands", () => {
  const sql = readFileSync(new URL("../migrations/0027_transition_kernel.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /\bCASE\b/i);
});
