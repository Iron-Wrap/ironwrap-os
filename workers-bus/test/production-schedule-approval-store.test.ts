import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  claimProductionScheduleApprovalExecution,
  createProductionScheduleApprovalRequest,
  denyProductionScheduleApprovalRequest,
  finalizeProductionScheduleApprovalExecution,
  getCurrentProductionScheduleApprovalRequest,
  getProductionScheduleApprovalRequest,
  markExpiredProductionScheduleApprovalExecutionLeases,
  matchesProductionScheduleApprovalPreparation,
  productionScheduleApprovalProjection,
  reconcileProductionScheduleApprovalUncertainty,
  type CreateProductionScheduleApprovalRequestInput,
} from "../src/production-schedule-approval-store.ts";
import type { AppEnv } from "../src/app-types.ts";

const CREATED = "2026-07-17T10:00:00.000Z";
const EXPIRES = "2026-07-17T10:05:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0020_production_schedule_approval_requests.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0079_production_schedule_approval_refusal.sql", import.meta.url), "utf8"));
    this.seedUser("appu_owner_0001", "ironwrap", "owner@example.com");
    this.seedUser("appu_owner_0002", "iroof", "owner@iroofalberta.ca");
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

  private seedUser(userId: string, tenantId: string, email: string) {
    this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, 1, 'seed', ?, ?)`,
    ).run(userId, tenantId, email, "Owner", email, CREATED, CREATED);
  }
}

function env(db = new SqliteD1()): AppEnv {
  return { DB: db as never } as AppEnv;
}

function input(
  overrides: Partial<CreateProductionScheduleApprovalRequestInput> = {},
): CreateProductionScheduleApprovalRequestInput {
  const requestText = "Create a new Job Assignment only after the owner approves this crew schedule.";
  return {
    id: "production-schedule-approval:0001",
    tenantId: "ironwrap",
    prepareIdempotencyKey: "production-schedule-prepare-0001",
    intentFingerprint: "a".repeat(64),
    actorUser: "production@example.com",
    siteId: "site-ironwrap",
    roofJobId: "job:001",
    targetAssignmentId: "job-assignment:job-001-a",
    crewProfileId: "crew-profile:metal-a",
    scheduledStart: "2026-07-18T08:00:00.000Z",
    scheduledEnd: null,
    supersedesAssignmentId: null,
    correctionReason: null,
    requestText,
    writeArgsJson: JSON.stringify({
      roof_job_id: "job:001",
      crew_profile_id: "crew-profile:metal-a",
      scheduled_start: "2026-07-18T08:00:00.000Z",
      request_text: requestText,
      dry_run_receipt: "d".repeat(32),
    }),
    previewJson: JSON.stringify({
      would_write: false,
      required_tool: "request_create_job_assignment",
      append_only: true,
      production_schedule_gate_preview: { required: true, state_eligible: true },
      target: { doctype: "Job Assignment", name: "job-assignment:job-001-a" },
      assignment: {
        assignment_id: "job-assignment:job-001-a",
        roof_job_id: "job:001",
        crew_profile_id: "crew-profile:metal-a",
        scheduled_start: "2026-07-18T08:00:00.000Z",
        scheduled_end: null,
        supersedes_assignment_id: null,
        correction_reason: null,
        crew_contact: "private",
      },
      private_broker_context: { dry_run_receipt: "must-never-reach-browser" },
    }),
    argsDigest: "b".repeat(64),
    previewDigest: "c".repeat(64),
    receiptPreviewDigest: "e".repeat(64),
    dryRunReceipt: "d".repeat(32),
    expiresAt: EXPIRES,
    requestedByUserId: "appu_owner_0001",
    requestedByFrappeUser: "owner@example.com",
    runId: "run-production-schedule-0001",
    now: CREATED,
    ...overrides,
  };
}

function containsForbidden(value: unknown): boolean {
  if (typeof value === "string") {
    return /dry_run_receipt|approval_receipt|write_args_json|crew_contact|private_broker_context|must-never-reach-browser/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) =>
      /dry_run_receipt|approval_receipt|write_args_json|crew_contact|private_broker_context/i.test(key) ||
      containsForbidden(child));
  }
  return false;
}

test("production schedule ledger is immutable and projects only allowlisted, gate-eligible schedule evidence", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const created = await createProductionScheduleApprovalRequest(appEnv, input());
  assert.equal(created.kind, "created");
  assert.equal(
    (db.raw.prepare("SELECT count(*) AS count FROM production_schedule_approval_request_events").get() as { count: number }).count,
    1,
  );

  const projection = productionScheduleApprovalProjection(created.request);
  assert.equal(projection.preview?.production_schedule_gate_preview.state_eligible, true);
  assert.equal(projection.preview?.assignment.scheduled_end, null);
  assert.equal(projection.preview?.effects.crew_notified, false);
  assert.equal(containsForbidden(projection), false, "browser projection must never contain raw schedule arguments or receipt data");
  assert.equal(matchesProductionScheduleApprovalPreparation(created.request, {
    requestedByUserId: "appu_owner_0001",
    roofJobId: "job:001",
    targetAssignmentId: "job-assignment:job-001-a",
    crewProfileId: "crew-profile:metal-a",
    scheduledStart: "2026-07-18T08:00:00.000Z",
    scheduledEnd: null,
    supersedesAssignmentId: null,
    correctionReason: null,
    requestText: "Create a new Job Assignment only after the owner approves this crew schedule.",
  }), true);
  assert.equal(productionScheduleApprovalProjection({
    ...created.request,
    preview_json: JSON.stringify({
      would_write: false,
      append_only: true,
      production_schedule_gate_preview: { required: true, state_eligible: false },
    }),
  }).preview, null, "an ineligible schedule gate must not reach the browser as executable preview evidence");

  assert.throws(() => db.raw.prepare(
    "UPDATE production_schedule_approval_requests SET crew_profile_id = 'crew-profile:rewrite' WHERE production_schedule_approval_id = 'production-schedule-approval:0001'",
  ).run(), /production_schedule_approval_binding_immutable/);
  assert.throws(() => db.raw.prepare(
    "UPDATE production_schedule_approval_request_events SET detail_code = 'rewritten' WHERE id = 1",
  ).run(), /production_schedule_approval_events_immutable/);
});

test("production schedule preparation is tenant-scoped, intent-bound, and allows only one active target", async () => {
  const appEnv = env();
  const first = await createProductionScheduleApprovalRequest(appEnv, input());
  assert.equal(first.kind, "created");

  const exactRetry = await createProductionScheduleApprovalRequest(appEnv, input({ id: "production-schedule-approval:0002" }));
  assert.equal(exactRetry.kind, "replayed");
  const changedIntent = await createProductionScheduleApprovalRequest(appEnv, input({
    id: "production-schedule-approval:0003",
    intentFingerprint: "f".repeat(64),
    requestText: "A materially different recorded production request.",
  }));
  assert.equal(changedIntent.kind, "conflict");

  const tenantScoped = await createProductionScheduleApprovalRequest(appEnv, input({
    id: "production-schedule-approval:iroof-0001",
    tenantId: "iroof",
    requestedByUserId: "appu_owner_0002",
    requestedByFrappeUser: "owner@iroofalberta.ca",
    runId: "run-production-schedule-iroof-0001",
  }));
  assert.equal(tenantScoped.kind, "created");

  await assert.rejects(
    () => createProductionScheduleApprovalRequest(appEnv, input({
      id: "production-schedule-approval:0004",
      prepareIdempotencyKey: "production-schedule-prepare-0004",
      intentFingerprint: "e".repeat(64),
      runId: "run-production-schedule-0004",
    })),
    /production_schedule_approval_requests\.tenant_id, production_schedule_approval_requests\.target_assignment_id/,
  );

  const denied = await denyProductionScheduleApprovalRequest(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "production-schedule-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    rejectionReason: "The owner needs a newer crew-availability check before creating this assignment.",
    now: "2026-07-17T10:01:00.000Z",
  });
  assert.equal(denied.kind, "denied");

  const rePrepared = await createProductionScheduleApprovalRequest(appEnv, input({
    id: "production-schedule-approval:0005",
    prepareIdempotencyKey: "production-schedule-prepare-0005",
    intentFingerprint: "9".repeat(64),
    runId: "run-production-schedule-0005",
    writeArgsJson: JSON.stringify({
      roof_job_id: "job:001",
      crew_profile_id: "crew-profile:metal-a",
      scheduled_start: "2026-07-18T08:00:00.000Z",
      request_text: "Create a new Job Assignment only after the owner approves this crew schedule.",
    }),
    previewJson: JSON.stringify({
      would_write: false,
      append_only: true,
      production_schedule_gate_preview: { required: true, state_eligible: true },
      target: { doctype: "Job Assignment", name: "job-assignment:job-001-a" },
      assignment: {
        assignment_id: "job-assignment:job-001-a",
        roof_job_id: "job:001",
        crew_profile_id: "crew-profile:metal-a",
        scheduled_start: "2026-07-18T08:00:00.000Z",
        scheduled_end: null,
        supersedes_assignment_id: null,
        correction_reason: null,
      },
    }),
  }));
  assert.equal(rePrepared.kind, "created");

  await assert.rejects(
    () => createProductionScheduleApprovalRequest(appEnv, input({
      id: "production-schedule-approval:0006",
      prepareIdempotencyKey: "production-schedule-prepare-0006",
      intentFingerprint: "8".repeat(64),
      runId: "run-production-schedule-0006",
      correctionReason: "A correction cannot exist without a superseded assignment.",
    })),
    /CHECK constraint failed/,
  );
});

test("one production schedule approval claim can execute, a stale lease becomes uncertain, and reconciliation is immutable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await createProductionScheduleApprovalRequest(appEnv, input());
  const claimed = await claimProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "production-schedule-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-17T10:01:00.000Z",
    leaseExpiresAt: "2026-07-17T10:01:30.000Z",
  });
  assert.equal(claimed.kind, "claimed");

  const sameDecision = await claimProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "production-schedule-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-17T10:01:01.000Z",
    leaseExpiresAt: "2026-07-17T10:01:31.000Z",
  });
  assert.equal(sameDecision.kind, "replayed");

  assert.equal(await markExpiredProductionScheduleApprovalExecutionLeases(appEnv, "2026-07-17T10:02:00.000Z", "ironwrap"), 1);
  const uncertain = await getProductionScheduleApprovalRequest(appEnv, "ironwrap", "production-schedule-approval:0001");
  assert.equal(uncertain?.state, "execution_uncertain");
  assert.equal(uncertain?.version, 3);

  const reconciled = await reconcileProductionScheduleApprovalUncertainty(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 3,
    reconciledByUserId: "appu_owner_0001",
    reconciledByFrappeUser: "owner@example.com",
    outcome: "inconclusive",
    evidence: "Hermes Run run-production-schedule-0001 was unavailable; no second assignment write was issued.",
    now: "2026-07-17T10:03:00.000Z",
  });
  assert.equal(reconciled.kind, "reconciled");
  assert.equal(reconciled.request.state, "execution_uncertain");
  assert.equal(reconciled.request.reconciliation_outcome, "inconclusive");

  const events = db.raw.prepare(
    "SELECT event_type FROM production_schedule_approval_request_events WHERE production_schedule_approval_id = ? ORDER BY id",
  ).all("production-schedule-approval:0001") as Array<{ event_type: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    "prepared", "execution_claimed", "execution_uncertain", "reconciled",
  ]);
});

test("production schedule execution result is distinct from a lost CAS claim and never projects private broker data", async () => {
  const appEnv = env();
  await createProductionScheduleApprovalRequest(appEnv, input());
  await claimProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: "production-schedule-decision-0001",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-17T10:01:00.000Z",
    leaseExpiresAt: "2026-07-17T10:02:00.000Z",
  });
  const final = await finalizeProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    decisionIdempotencyKey: "production-schedule-decision-0001",
    state: "executed",
    hermesRunId: "run-production-schedule-0001",
    resultJson: JSON.stringify({
      run_id: "run-production-schedule-0001",
      created: true,
      assignment_id: "job-assignment:job-001-a",
      roof_job_id: "job:001",
      crew_profile_id: "crew-profile:metal-a",
      scheduled_start: "2026-07-18T08:00:00.000Z",
      scheduled_end: null,
      supersedes_assignment_id: null,
      audit_finalized: true,
      approval_receipt: "must-not-project",
    }),
    now: "2026-07-17T10:01:10.000Z",
  });
  assert.equal(final.kind, "finalized");
  assert.equal(productionScheduleApprovalProjection(final.request).outcome?.created, true);
  assert.equal(containsForbidden(productionScheduleApprovalProjection(final.request)), false);

  const lost = await finalizeProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    decisionIdempotencyKey: "production-schedule-decision-0001",
    state: "executed",
    hermesRunId: "run-production-schedule-0001",
    resultJson: "{}",
    now: "2026-07-17T10:01:11.000Z",
  });
  assert.equal(lost.kind, "lost_claim");
});

const REFUSAL_MESSAGE =
  "the exact tenant-scoped Authority Record requirements are not satisfied: no current authority " +
  "matches the exact tenant, subject, kind, and scope: Worker Competency for crew@ironwrap.local " +
  "scoped to Roof Job job:001";

/** Take one request from prepared to `executing`, ready to be finalized. */
async function claimed(appEnv: AppEnv, decisionKey: string) {
  await createProductionScheduleApprovalRequest(appEnv, input());
  await claimProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 1,
    decisionIdempotencyKey: decisionKey,
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-17T10:01:00.000Z",
    leaseExpiresAt: "2026-07-17T10:02:00.000Z",
  });
}

test("a refused schedule keeps its reason where the next approver will read it", async () => {
  // The approve response is not the only place this has to land. An approver who re-opens
  // the request tomorrow needs the same sentence the one who clicked approve saw, or the
  // fix only works for whoever was holding the browser at the time.
  const appEnv = env();
  await claimed(appEnv, "production-schedule-decision-refused");
  const final = await finalizeProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    decisionIdempotencyKey: "production-schedule-decision-refused",
    state: "failed",
    hermesRunId: "run-production-schedule-0001",
    resultJson: null,
    errorCode: "broker_production_schedule_refused",
    refusalMessage: REFUSAL_MESSAGE,
    now: "2026-07-17T10:01:10.000Z",
  });

  assert.equal(final.kind, "finalized");
  const projection = productionScheduleApprovalProjection(final.request!);
  assert.equal(projection.state, "failed");
  assert.equal(projection.error_code, "broker_production_schedule_refused");
  assert.equal(projection.refusal_message, REFUSAL_MESSAGE);
  assert.equal(projection.outcome, null);
  assert.equal(containsForbidden(projection), false);
});

test("an uncertain execution is never given a confident-sounding reason", async () => {
  // `execution_uncertain` means nobody knows what happened. A sentence there would read
  // as a decision, so the storage boundary refuses one and the projection drops it.
  const appEnv = env();
  await claimed(appEnv, "production-schedule-decision-uncertain");
  const final = await finalizeProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    decisionIdempotencyKey: "production-schedule-decision-uncertain",
    state: "execution_uncertain",
    hermesRunId: "run-production-schedule-0001",
    resultJson: null,
    errorCode: "broker_mcp_call_ambiguous",
    refusalMessage: REFUSAL_MESSAGE,
    now: "2026-07-17T10:01:10.000Z",
  });

  assert.equal(final.kind, "finalized");
  assert.equal(productionScheduleApprovalProjection(final.request!).refusal_message, null);
});

test("the storage boundary refuses a reason that is not a bounded, single-line refusal", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await claimed(appEnv, "production-schedule-decision-guarded");
  for (const [label, message] of [
    ["markup", "<script>alert(1)</script>"],
    ["a newline", "line one\nline two"],
    ["an over-long sentence", "x".repeat(401)],
  ]) {
    assert.throws(
      () => db.raw.prepare(
        `UPDATE production_schedule_approval_requests
         SET state = 'failed', version = version + 1, error_code = 'broker_production_schedule_refused',
             refusal_message = ?, execution_lease_expires_at = NULL, completed_at = ?,
             transition_actor_kind = 'approval_broker', transition_actor_id = 'production-schedule-broker',
             transition_detail_code = 'production_schedule_broker_execution_failed', updated_at = ?
         WHERE production_schedule_approval_id = 'production-schedule-approval:0001'`,
      ).run(message, "2026-07-17T10:01:10.000Z", "2026-07-17T10:01:10.000Z"),
      /production_schedule_approval_refusal_message_invalid/,
      label,
    );
  }
});

test("a reason cannot be attached to a state that is not a decision, or rewritten later", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await claimed(appEnv, "production-schedule-decision-state-guard");
  assert.throws(
    () => db.raw.prepare(
      `UPDATE production_schedule_approval_requests
       SET state = 'execution_uncertain', version = version + 1, error_code = 'broker_mcp_call_ambiguous',
           refusal_message = ?, execution_lease_expires_at = NULL, completed_at = ?,
           transition_actor_kind = 'approval_broker', transition_actor_id = 'production-schedule-broker',
           transition_detail_code = 'production_schedule_broker_execution_uncertain', updated_at = ?
       WHERE production_schedule_approval_id = 'production-schedule-approval:0001'`,
    ).run(REFUSAL_MESSAGE, "2026-07-17T10:01:10.000Z", "2026-07-17T10:01:10.000Z"),
    /production_schedule_approval_refusal_requires_failed_state/,
  );

  await finalizeProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    decisionIdempotencyKey: "production-schedule-decision-state-guard",
    state: "failed",
    hermesRunId: "run-production-schedule-0001",
    resultJson: null,
    errorCode: "broker_production_schedule_refused",
    refusalMessage: REFUSAL_MESSAGE,
    now: "2026-07-17T10:01:10.000Z",
  });
  // What an approver was told is a recorded fact, not a field to correct.
  assert.throws(
    () => db.raw.prepare(
      "UPDATE production_schedule_approval_requests SET refusal_message = ? WHERE production_schedule_approval_id = ?",
    ).run("a different reason entirely", "production-schedule-approval:0001"),
    /production_schedule_approval_refusal_immutable/,
  );
});

test("expired schedule approval cannot be claimed and retains an append-only expiry event", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await createProductionScheduleApprovalRequest(appEnv, input({ expiresAt: "2026-07-17T10:00:01.000Z" }));

  const expired = await getCurrentProductionScheduleApprovalRequest(
    appEnv,
    "ironwrap",
    "production-schedule-approval:0001",
    "2026-07-17T10:00:02.000Z",
  );
  assert.equal(expired?.state, "expired");
  assert.equal(expired?.version, 2);
  const rejectedClaim = await claimProductionScheduleApprovalExecution(appEnv, {
    tenantId: "ironwrap",
    requestId: "production-schedule-approval:0001",
    expectedVersion: 2,
    decisionIdempotencyKey: "production-schedule-decision-expired",
    approvedByUserId: "appu_owner_0001",
    approvedByFrappeUser: "owner@example.com",
    now: "2026-07-17T10:00:02.000Z",
    leaseExpiresAt: "2026-07-17T10:01:00.000Z",
  });
  assert.equal(rejectedClaim.kind, "expired");
  assert.equal(
    (db.raw.prepare(
      "SELECT event_type FROM production_schedule_approval_request_events WHERE production_schedule_approval_id = ? ORDER BY id DESC LIMIT 1",
    ).get("production-schedule-approval:0001") as { event_type: string }).event_type,
    "expired",
  );
});
