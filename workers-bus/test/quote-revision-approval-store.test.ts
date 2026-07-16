import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  claimQuoteRevisionApprovalExecution,
  createQuoteRevisionApprovalRequest,
  denyQuoteRevisionApprovalRequest,
  finalizeQuoteRevisionApprovalExecution,
  getQuoteRevisionApprovalRequest,
  markExpiredQuoteRevisionApprovalExecutionLeases,
  quoteRevisionApprovalProjection,
  reconcileQuoteRevisionApprovalUncertainty,
  type CreateQuoteRevisionApprovalRequestInput,
} from "../src/quote-revision-approval-store.ts";
import type { AppEnv } from "../src/app-types.ts";

const CREATED = "2026-07-12T10:00:00.000Z";
const EXPIRES = "2026-07-12T10:05:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0017_quote_revision_approval_requests.sql", import.meta.url), "utf8"));
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

function input(
  overrides: Partial<CreateQuoteRevisionApprovalRequestInput> = {},
): CreateQuoteRevisionApprovalRequestInput {
  const correctionReason = "A fresh field and supplier review is required.";
  const requestText = "Create a blank quote revision shell after the owner reviews current evidence.";
  return {
    id: "quote-revision-approval:0001",
    tenantId: "ironwrap",
    prepareIdempotencyKey: "quote-revision-prepare-0001",
    intentFingerprint: "a".repeat(64),
    actorUser: "estimator@example.com",
    siteId: "site-ironwrap",
    roofJobId: "job:001",
    sourceCustomerQuoteId: "customer-quote:001",
    sourceQuoteVersion: 1,
    sourceQuoteStatus: "Approved",
    sourceQuoteModified: "2026-07-12T09:59:00.000Z",
    targetCustomerQuoteId: "quote-revision:job-001-v2",
    targetQuoteVersion: 2,
    correctionReason,
    requestText,
    writeArgsJson: JSON.stringify({
      roof_job_id: "job:001",
      customer_quote_id: "customer-quote:001",
      correction_reason: correctionReason,
      request_text: requestText,
      approved_by: "owner@example.com",
      run_id: "run-quote-revision-0001",
      dry_run_receipt: "d".repeat(32),
    }),
    previewJson: JSON.stringify({
      would_write: false,
      required_tool: "request_create_quote_revision",
      target: { doctype: "Customer Quote", name: "quote-revision:job-001-v2" },
      append_only: true,
      source: {
        customer_quote_id: "customer-quote:001",
        roof_job: "job:001",
        quote_version: 1,
        status: "Approved",
        modified: "2026-07-12T09:59:00.000Z",
        quote_total: 25_000,
        tax_policy_snapshot_json: "private",
      },
      observed_quote_count: 1,
      draft: {
        customer_quote_id: "quote-revision:job-001-v2",
        roof_job: "job:001",
        quote_version: 2,
        status: "Draft",
        supersedes: "customer-quote:001",
        correction_reason: correctionReason,
        quote_total: 0,
      },
      approval_request: { dry_run_receipt: "must-never-reach-browser" },
    }),
    argsDigest: "b".repeat(64),
    previewDigest: "c".repeat(64),
    receiptPreviewDigest: "e".repeat(64),
    dryRunReceipt: "d".repeat(32),
    expiresAt: EXPIRES,
    requestedByUserId: "appu_owner_0001",
    requestedByFrappeUser: "owner@example.com",
    runId: "run-quote-revision-0001",
    now: CREATED,
    ...overrides,
  };
}

function containsForbidden(value: unknown): boolean {
  if (typeof value === "string") {
    return /dry_run_receipt|approval_receipt|write_args_json|quote_total|tax_policy_snapshot_json|must-never-reach-browser/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) =>
      /dry_run_receipt|approval_receipt|write_args_json|quote_total|tax_policy_snapshot_json/i.test(key) ||
      containsForbidden(child));
  }
  return false;
}

test("quote revision ledger is immutable and projects only non-commercial Draft-shell evidence", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const created = await createQuoteRevisionApprovalRequest(appEnv, input());
  assert.equal(created.kind, "created");
  assert.equal(
    (db.raw.prepare("SELECT count(*) AS count FROM quote_revision_approval_request_events").get() as { count: number }).count,
    1,
  );

  const projection = quoteRevisionApprovalProjection(created.request);
  assert.equal(projection.preview?.draft.status, "Draft");
  assert.equal(projection.preview?.effects.commercial_terms_copied, false);
  assert.equal(containsForbidden(projection), false, "browser projection must never contain raw commercial or receipt data");

  assert.throws(() => db.raw.prepare(
    "UPDATE quote_revision_approval_requests SET correction_reason = 'rewrite' WHERE quote_revision_approval_id = 'quote-revision-approval:0001'",
  ).run(), /quote_revision_approval_binding_immutable/);
  assert.throws(() => db.raw.prepare(
    "UPDATE quote_revision_approval_request_events SET detail_code = 'rewritten' WHERE id = 1",
  ).run(), /quote_revision_approval_events_immutable/);
});

test("quote revision preparation is intent-bound and permits only one active deterministic target", async () => {
  const appEnv = env();
  const first = await createQuoteRevisionApprovalRequest(appEnv, input());
  assert.equal(first.kind, "created");

  const exactRetry = await createQuoteRevisionApprovalRequest(appEnv, input({ id: "quote-revision-approval:0002" }));
  assert.equal(exactRetry.kind, "replayed");
  const changedIntent = await createQuoteRevisionApprovalRequest(appEnv, input({
    id: "quote-revision-approval:0003",
    intentFingerprint: "f".repeat(64),
    requestText: "A materially different recorded request.",
  }));
  assert.equal(changedIntent.kind, "conflict");

  await assert.rejects(
    () => createQuoteRevisionApprovalRequest(appEnv, input({
      id: "quote-revision-approval:0004",
      prepareIdempotencyKey: "quote-revision-prepare-0004",
      intentFingerprint: "e".repeat(64),
      runId: "run-quote-revision-0004",
    })),
    /quote_revision_approval_requests\.tenant_id, quote_revision_approval_requests\.target_customer_quote_id/,
  );

  const denied = await denyQuoteRevisionApprovalRequest(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "quote-revision-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    rejectionReason: "The owner needs another evidence review before a Draft shell is created.",
    now: "2026-07-12T10:01:00.000Z",
  });
  assert.equal(denied.kind, "denied");

  const rePrepared = await createQuoteRevisionApprovalRequest(appEnv, input({
    id: "quote-revision-approval:0005",
    prepareIdempotencyKey: "quote-revision-prepare-0005",
    intentFingerprint: "9".repeat(64),
    runId: "run-quote-revision-0005",
    correctionReason: "A newer supplier review requires a fresh Draft shell.",
    writeArgsJson: JSON.stringify({
      roof_job_id: "job:001",
      customer_quote_id: "customer-quote:001",
      correction_reason: "A newer supplier review requires a fresh Draft shell.",
      request_text: "Create a blank quote revision shell after the owner reviews current evidence.",
    }),
  }));
  assert.equal(rePrepared.kind, "created");
});

test("one quote revision approval claim can execute, a stale lease becomes uncertain, and reconciliation is immutable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await createQuoteRevisionApprovalRequest(appEnv, input());
  const claimed = await claimQuoteRevisionApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "quote-revision-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-12T10:01:00.000Z",
    leaseExpiresAt: "2026-07-12T10:01:30.000Z",
  });
  assert.equal(claimed.kind, "claimed");

  const sameDecision = await claimQuoteRevisionApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "quote-revision-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-12T10:01:01.000Z",
    leaseExpiresAt: "2026-07-12T10:01:31.000Z",
  });
  assert.equal(sameDecision.kind, "replayed");

  assert.equal(await markExpiredQuoteRevisionApprovalExecutionLeases(appEnv, "2026-07-12T10:02:00.000Z", "ironwrap"), 1);
  const uncertain = await getQuoteRevisionApprovalRequest(appEnv, "ironwrap", "quote-revision-approval:0001");
  assert.equal(uncertain?.state, "execution_uncertain");
  assert.equal(uncertain?.version, 3);

  const reconciled = await reconcileQuoteRevisionApprovalUncertainty(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    expectedVersion: 3,
    reconciledByUserId: "appu_owner_0001",
    reconciledByFrappeUser: "owner@example.com",
    outcome: "inconclusive",
    evidence: "Hermes Run run-quote-revision-0001 was unavailable; no second revision write was issued.",
    now: "2026-07-12T10:03:00.000Z",
  });
  assert.equal(reconciled.kind, "reconciled");
  assert.equal(reconciled.request.state, "execution_uncertain");
  assert.equal(reconciled.request.reconciliation_outcome, "inconclusive");

  const events = db.raw.prepare(
    "SELECT event_type FROM quote_revision_approval_request_events WHERE quote_revision_approval_id = ? ORDER BY id",
  ).all("quote-revision-approval:0001") as Array<{ event_type: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    "prepared", "execution_claimed", "execution_uncertain", "reconciled",
  ]);
});

test("quote revision execution result is distinct from a lost CAS claim and cannot project a commercial capability", async () => {
  const appEnv = env();
  await createQuoteRevisionApprovalRequest(appEnv, input());
  await claimQuoteRevisionApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "quote-revision-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-12T10:01:00.000Z",
    leaseExpiresAt: "2026-07-12T10:02:00.000Z",
  });
  const final = await finalizeQuoteRevisionApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    decisionIdempotencyKey: "quote-revision-decision-0001",
    state: "executed",
    hermesRunId: "run-quote-revision-0001",
    resultJson: JSON.stringify({
      run_id: "run-quote-revision-0001",
      created: true,
      customer_quote_id: "quote-revision:job-001-v2",
      quote_version: 2,
      supersedes: "customer-quote:001",
      audit_finalized: true,
      quote_total: 25_000,
      approval_receipt: "must-not-project",
    }),
    now: "2026-07-12T10:01:10.000Z",
  });
  assert.equal(final.kind, "finalized");
  assert.equal(quoteRevisionApprovalProjection(final.request).outcome?.created, true);
  assert.equal(containsForbidden(quoteRevisionApprovalProjection(final.request)), false);

  const lost = await finalizeQuoteRevisionApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "quote-revision-approval:0001",
    decisionIdempotencyKey: "quote-revision-decision-0001",
    state: "executed",
    hermesRunId: "run-quote-revision-0001",
    resultJson: "{}",
    now: "2026-07-12T10:01:11.000Z",
  });
  assert.equal(lost.kind, "lost_claim");
});
