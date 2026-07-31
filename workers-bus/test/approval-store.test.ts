import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  approvalProjection,
  claimApprovalExecution,
  createApprovalRequest,
  finalizeApprovalExecution,
  getApprovalRequest,
  markExpiredExecutionLeases,
  reconcileApprovalUncertainty,
  type CreateApprovalRequestInput,
} from "../src/approval-store.ts";
import type { AppEnv } from "../src/app-types.ts";

const CREATED = "2026-07-11T10:00:00.000Z";
const EXPIRES = "2026-07-11T10:05:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0016_approval_requests.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0027_transition_kernel.sql", import.meta.url), "utf8"));
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
    writeArgsJson: JSON.stringify({
      lead_envelope_id: "lead:001",
      triage_summary: "Urgent leak; confirm property address before outreach.",
      request_text: "Approve the local triage annotation after review.",
      approved_by: "owner@example.com",
      run_id: "run-lead-triage-0001",
      dry_run_receipt: "d".repeat(32),
    }),
    previewJson: JSON.stringify({
      would_write: false,
      target: { doctype: "Lead Envelope", name: "lead:001" },
      before: { triage_status: "Untriaged", triaged_by: "", triaged_at: "", triage_summary: "" },
      patch: {
        triage_status: "Triaged",
        triaged_by: "owner@example.com",
        triaged_at: "2026-07-11T10:00:00.000Z",
        triage_summary: "Urgent leak; confirm property address before outreach.",
      },
      transport_status_unchanged: "pushed",
      communication_events_mutated: false,
      approval_request: { dry_run_receipt: "must-never-reach-browser" },
    }),
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

function containsForbidden(value: unknown): boolean {
  if (typeof value === "string") return /dry_run_receipt|approval_receipt|write_args_json|must-never-reach-browser/.test(value);
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) =>
      /dry_run_receipt|approval_receipt|write_args_json/i.test(key) || containsForbidden(child));
  }
  return false;
}

test("approval ledger creates immutable evidence and projects an allowlisted review only", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const created = await createApprovalRequest(appEnv, input());
  assert.equal(created.kind, "created");
  assert.equal(
    (db.raw.prepare("SELECT count(*) AS count FROM approval_request_events").get() as { count: number }).count,
    1,
  );

  const projection = approvalProjection(created.request);
  assert.equal(projection.preview?.patch.triage_status, "Triaged");
  assert.equal(containsForbidden(projection), false, "browser projection must never contain a bearer receipt or raw args");

  assert.throws(() => db.raw.prepare(
    "UPDATE approval_requests SET preview_json = '{}' WHERE approval_request_id = 'approval_request_0001'",
  ).run(), /approval_request_binding_immutable/);
  assert.throws(() => db.raw.prepare(
    "UPDATE approval_request_events SET detail_code = 'rewritten' WHERE id = 1",
  ).run(), /approval_request_events_immutable/);
});

test("approval preparation idempotency is intent-bound rather than JSON-order-bound", async () => {
  const appEnv = env();
  const first = await createApprovalRequest(appEnv, input());
  assert.equal(first.kind, "created");
  const exactRetry = await createApprovalRequest(appEnv, input({ id: "approval_request_0002" }));
  assert.equal(exactRetry.kind, "replayed");
  const changedIntent = await createApprovalRequest(appEnv, input({
    id: "approval_request_0003",
    requestText: "A materially different human decision.",
    intentFingerprint: "f".repeat(64),
  }));
  assert.equal(changedIntent.kind, "conflict");
});

test("one approval claim can execute, stale execution becomes uncertain, and reconciliation is immutable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await createApprovalRequest(appEnv, input());
  const claimed = await claimApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "decision-key-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-11T10:01:00.000Z",
    leaseExpiresAt: "2026-07-11T10:01:30.000Z",
  });
  assert.equal(claimed.kind, "claimed");

  const sameDecision = await claimApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "decision-key-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-11T10:01:01.000Z",
    leaseExpiresAt: "2026-07-11T10:01:31.000Z",
  });
  assert.equal(sameDecision.kind, "replayed");

  assert.equal(await markExpiredExecutionLeases(appEnv, "2026-07-11T10:02:00.000Z", "ironwrap"), 1);
  const uncertain = await getApprovalRequest(appEnv, "ironwrap", "approval_request_0001");
  assert.equal(uncertain?.state, "execution_uncertain");
  assert.equal(uncertain?.version, 3);

  const reconciled = await reconcileApprovalUncertainty(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    expectedVersion: 3,
    reconciledByUserId: "appu_owner_0001",
    reconciledByFrappeUser: "owner@example.com",
    outcome: "inconclusive",
    evidence: "Hermes Run run-lead-triage-0001 was not reachable; no retry was issued.",
    now: "2026-07-11T10:03:00.000Z",
  });
  assert.equal(reconciled.kind, "reconciled");
  assert.equal(reconciled.request.state, "execution_uncertain");
  assert.equal(reconciled.request.reconciliation_outcome, "inconclusive");

  const events = db.raw.prepare(
    "SELECT event_type FROM approval_request_events WHERE approval_request_id = ? ORDER BY id",
  ).all("approval_request_0001") as Array<{ event_type: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    "prepared", "execution_claimed", "execution_uncertain", "reconciled",
  ]);
});

test("completed broker result is deliberately distinct from a lost CAS claim", async () => {
  const appEnv = env();
  await createApprovalRequest(appEnv, input());
  await claimApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "decision-key-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-11T10:01:00.000Z",
    leaseExpiresAt: "2026-07-11T10:02:00.000Z",
  });
  const final = await finalizeApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    decisionIdempotencyKey: "decision-key-0001",
    state: "executed",
    hermesRunId: "run-lead-triage-0001",
    resultJson: JSON.stringify({
      run_id: "run-lead-triage-0001",
      lead_envelope_id: "lead:001",
      updated: true,
      audit_finalized: true,
      replayed: false,
      approval_receipt: "must-not-project",
    }),
    now: "2026-07-11T10:01:10.000Z",
  });
  assert.equal(final.kind, "finalized");
  assert.equal(approvalProjection(final.request).outcome?.updated, true);
  assert.equal(containsForbidden(approvalProjection(final.request)), false);

  const lost = await finalizeApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "approval_request_0001",
    decisionIdempotencyKey: "decision-key-0001",
    state: "executed",
    hermesRunId: "run-lead-triage-0001",
    resultJson: "{}",
    now: "2026-07-11T10:01:11.000Z",
  });
  assert.equal(lost.kind, "lost_claim");
});
