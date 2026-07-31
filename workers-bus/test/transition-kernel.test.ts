import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  claimApprovalExecution,
  createApprovalRequest,
  finalizeApprovalExecution,
  reconcileApprovalUncertainty,
  type CreateApprovalRequestInput,
} from "../src/approval-store.ts";
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

function input(overrides: Partial<CreateApprovalRequestInput> = {}): CreateApprovalRequestInput {
  return {
    id: "approval_request_0001",
    tenantId: "ironwrap",
    prepareIdempotencyKey: "prepare-key-0001",
    intentFingerprint: "a".repeat(64),
    agentRole: "lead-concierge",
    actorUser: "concierge@example.com",
    siteId: "site-ironwrap",
    leadEnvelopeId: "lead:001",
    requestText: "Approve the local triage annotation after review.",
    writeArgsJson: JSON.stringify({ secret: "must-never-enter-transition-kernel" }),
    previewJson: JSON.stringify({ would_write: false }),
    argsDigest: "b".repeat(64),
    previewDigest: "c".repeat(64),
    dryRunReceipt: "d".repeat(32),
    expiresAt: EXPIRES,
    requestedByUserId: "appu_owner_0001",
    requestedByFrappeUser: "owner@example.com",
    runId: "run-lead-triage-0001",
    now: CREATED,
    ...overrides,
  };
}

async function createAndClaimApproval(appEnv: AppEnv, overrides: Partial<CreateApprovalRequestInput> = {}) {
  const created = await createApprovalRequest(appEnv, input(overrides));
  assert.equal(created.kind, "created");
  const claimed = await claimApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: created.request.approval_request_id,
    expectedVersion: 1,
    decisionIdempotencyKey: `decision-${created.request.approval_request_id}`,
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-30T10:01:00.000Z",
    leaseExpiresAt: "2026-07-30T10:03:00.000Z",
  });
  assert.equal(claimed.kind, "claimed");
  return {
    approvalRequestId: created.request.approval_request_id,
    decisionIdempotencyKey: `decision-${created.request.approval_request_id}`,
  };
}

test("approval claim atomically records a redacted transition and never-attempted outbox intent", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const { approvalRequestId, decisionIdempotencyKey } = await createAndClaimApproval(appEnv);

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
  const { approvalRequestId, decisionIdempotencyKey } = await createAndClaimApproval(appEnv);

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

  const final = await finalizeApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: approvalRequestId,
    decisionIdempotencyKey,
    state: "execution_uncertain",
    errorCode: "broker_response_timeout",
    now: "2026-07-30T10:03:01.000Z",
  });
  assert.equal(final.kind, "finalized");

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

  const reconciled = await reconcileApprovalUncertainty(appEnv, {
    tenantId: "ironwrap",
    requestId: approvalRequestId,
    expectedVersion: 3,
    reconciledByUserId: "appu_owner_0001",
    reconciledByFrappeUser: "owner@example.com",
    outcome: "inconclusive",
    evidence: "A human compared the canonical run reference; no retry was issued.",
    now: "2026-07-30T10:04:30.000Z",
  });
  assert.equal(reconciled.kind, "reconciled");

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
  const { approvalRequestId, decisionIdempotencyKey } = await createAndClaimApproval(appEnv);

  const final = await finalizeApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: approvalRequestId,
    decisionIdempotencyKey,
    state: "executed",
    hermesRunId: "run-lead-triage-0001",
    resultJson: "{}",
    now: "2026-07-30T10:01:10.000Z",
  });
  assert.equal(final.kind, "finalized");

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
