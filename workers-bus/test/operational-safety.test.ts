import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { BULK_REPLAY_CONFIRMATION } from "../src/operations.ts";
import { markDeadLettersRecovered } from "../src/store.ts";

const A = "ow_11111111-1111-4111-8111-111111111111";
const B = "ow_22222222-2222-4222-8222-222222222222";
const C = "ow_33333333-3333-4333-8333-333333333333";
const APPROVAL = {
  run_id: "hermes-run-20260710-001",
  approved_by: "owner@example.com",
  reason: "Re-drive after the upstream outage was verified resolved.",
};

interface FakeOptions {
  d1Throws?: boolean;
  missingSchemaArtifact?: boolean;
  heartbeatAt?: string;
  qbAt?: string;
  auditFailures?: Array<Record<string, unknown>>;
  counts?: { pending: number; stuck: number; frappe_errors: number };
  replayCounts?: { failed: number; stuck: number };
  queueBatchThrows?: boolean;
  queueBatchFailCount?: number;
  queueBatchGate?: Promise<void>;
  onQueueBatch?: () => void;
  claimConflictFor?: string;
}

function fakeEnv(options: FakeOptions = {}) {
  const statuses = new Map([[A, "dead"], [B, "dead"], [C, "pushed"]]);
  const deadLetters = [
    { envelope_id: A, recovered: 0, ts: "2026-07-10T01:00:00.000Z" },
    { envelope_id: B, recovered: 0, ts: "2026-07-10T02:00:00.000Z" },
    { envelope_id: C, recovered: 0, ts: "2026-07-10T03:00:00.000Z" },
  ];
  const queue: string[] = [];
  const audits: Array<{ sql: string; args: unknown[] }> = [];
  const sourceCounts: Array<{ day: string; channel: string; count: number }> = [];
  const sqlCalls: Array<{ sql: string; args: unknown[] }> = [];
  const replayRequests = new Map<string, {
    run_id: string;
    selection: "targeted" | "bulk";
    envelope_id: string | null;
    approved_by: string;
    reason: string;
    status: "running" | "completed" | "failed";
    matched: number | null;
    requeued: number | null;
    last_error: string | null;
    attempt_count: number;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>();
  let queueBatchFailuresRemaining = options.queueBatchFailCount ?? 0;
  const now = Date.now();

  const executeFirst = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (options.d1Throws && sql.includes("sqlite_master")) throw new Error("d1_unavailable");
    if (sql.includes("sqlite_master")) {
      return { table_count: 23, index_count: options.missingSchemaArtifact ? 29 : 30, trigger_count: 22 };
    }
    if (sql.includes("COUNT(*) AS n FROM dead_letter")) {
      return { n: deadLetters.filter((row) => row.recovered === 0).length };
    }
    if (sql.includes("FROM heartbeat ORDER BY")) {
      return {
        day: "2026-07-10",
        ran_at: options.heartbeatAt ?? new Date(now - 60_000).toISOString(),
        reconciled: 1,
        dead_letter_open: 0,
      };
    }
    if (sql.includes("COUNT(*) AS pending")) {
      const counts = options.counts ?? { pending: 3, stuck: 1, frappe_errors: 2 };
      return { pending: counts.pending, stuck: counts.stuck };
    }
    if (sql.includes("COUNT(*) AS frappe_errors")) {
      return { frappe_errors: (options.counts ?? { pending: 3, stuck: 1, frappe_errors: 2 }).frappe_errors };
    }
    if (sql.includes("FROM replay_requests") && sql.includes("AS failed")) {
      return options.replayCounts ?? { failed: 0, stuck: 0 };
    }
    if (sql.includes("FROM replay_requests WHERE run_id = ?")) {
      return replayRequests.get(String(args[0])) ?? null;
    }
    if (sql.includes("FROM quickbooks_webhook_receipts ORDER BY")) {
      return options.qbAt === "none" ? null : {
        payload_hash: "hash-not-returned",
        first_seen_at: new Date(now - 7_200_000).toISOString(),
        last_seen_at: options.qbAt ?? new Date(now - 3_600_000).toISOString(),
        envelope_id: "qb_receipt",
        raw_key: "raw/not-returned.json",
        events_count: 2,
        replay_count: 1,
      };
    }
    return null;
  };

  const executeAll = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (sql.includes("FROM dead_letter d")) {
      const selected = args[0] == null ? null : String(args[0]);
      const ids = deadLetters
        .filter((row) => row.recovered === 0 && statuses.get(row.envelope_id) === "dead")
        .filter((row) => selected === null || row.envelope_id === selected)
        .map((row) => ({ envelope_id: row.envelope_id }));
      return { results: ids };
    }
    if (sql.includes("FROM audit_log WHERE result = 'error'")) {
      return { results: options.auditFailures ?? [{
        id: 7,
        ts: new Date(now - 30_000).toISOString(),
        automation: "erpnext_push",
        trigger: "queue",
        envelope_id: A,
        action: "push_attempt_2",
        result: "error",
        error: "frappe unavailable",
        recovery_owner: "owner@example.com",
      }] };
    }
    return { results: [] };
  };

  const executeRun = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (sql.includes("INSERT INTO replay_requests")) {
      const runId = String(args[0]);
      if (replayRequests.has(runId)) throw new Error("UNIQUE constraint failed: replay_requests.run_id");
      replayRequests.set(runId, {
        run_id: runId,
        selection: String(args[1]) as "targeted" | "bulk",
        envelope_id: args[2] === null ? null : String(args[2]),
        approved_by: String(args[3]),
        reason: String(args[4]),
        status: "running",
        matched: null,
        requeued: null,
        last_error: null,
        attempt_count: 1,
        created_at: String(args[5]),
        updated_at: String(args[6]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'running'")) {
      const runId = String(args[1]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "failed") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "running",
        matched: null,
        requeued: null,
        last_error: null,
        attempt_count: row.attempt_count + 1,
        updated_at: String(args[0]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'completed'")) {
      const runId = String(args[4]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "running") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "completed",
        matched: Number(args[0]),
        requeued: Number(args[1]),
        last_error: null,
        updated_at: String(args[2]),
        completed_at: String(args[3]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'failed'")) {
      const runId = String(args[2]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "running") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "failed",
        last_error: String(args[0]),
        updated_at: String(args[1]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE envelopes SET status = 'pending_jn_push'")) {
      const id = String(args[1]);
      if (statuses.get(id) !== "dead") return { success: true, meta: { changes: 0 } };
      if (options.claimConflictFor === id) {
        statuses.set(id, "pending_jn_push");
        return { success: true, meta: { changes: 0 } };
      }
      statuses.set(id, "pending_jn_push");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE envelopes SET status = 'dead'")) {
      const id = String(args[1]);
      if (statuses.get(id) !== "pending_jn_push") return { success: true, meta: { changes: 0 } };
      statuses.set(id, "dead");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dead_letter SET recovered = 1")) {
      const id = String(args[0]);
      let changes = 0;
      for (const row of deadLetters) {
        if (row.envelope_id === id && row.recovered === 0) {
          row.recovered = 1;
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO audit_log")) audits.push({ sql, args });
    if (sql.includes("INSERT INTO source_counts")) {
      sourceCounts.push({ day: String(args[0]), channel: String(args[1]), count: Number(args[2]) });
    }
    return { success: true, meta: { changes: 1 } };
  };

  const env = {
    INGEST_TOKEN: "ingest-secret",
    ADMIN_TOKEN: "admin-secret",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    GOOGLE_SERVICE_ACCOUNT_JSON: "service-account-secret",
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "jobnimbus-secret",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    RAW: { put: async () => {} },
    JN_QUEUE: {
      send: async ({ envelope_id }: { envelope_id: string }) => { queue.push(envelope_id); },
      sendBatch: async (messages: Array<{ body: { envelope_id: string } }>) => {
        options.onQueueBatch?.();
        if (options.queueBatchGate) await options.queueBatchGate;
        if (options.queueBatchThrows || queueBatchFailuresRemaining > 0) {
          if (queueBatchFailuresRemaining > 0) queueBatchFailuresRemaining--;
          throw new Error("queue_unavailable");
        }
        for (const message of messages) queue.push(message.body.envelope_id);
      },
    },
    DB: {
      prepare(sql: string) {
        const statement = (args: unknown[]) => ({
          first: async () => executeFirst(sql, args),
          all: async () => executeAll(sql, args),
          run: async () => executeRun(sql, args),
        });
        return {
          ...statement([]),
          bind: (...args: unknown[]) => statement(args),
        };
      },
    },
  };
  return { env, statuses, deadLetters, queue, audits, sourceCounts, sqlCalls, replayRequests };
}

function enableAppBff(env: Record<string, unknown>): void {
  Object.assign(env, {
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "https://app.example.com",
    APP_ALLOWED_ORIGINS: "https://app.example.com",
    APP_ALLOW_INSECURE_LOCAL: "false",
    APP_AUTH_PEPPER: "readiness-test-pepper-longer-than-thirty-two-characters",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
  });
}

const ctx = {} as never;
const adminHeaders = { authorization: "Bearer admin-secret", "content-type": "application/json" };

test("public readiness probes D1/bindings without exposing configured secrets", async () => {
  const { env, sqlCalls } = fakeEnv();
  const correlationId = "corr-12345678";
  const response = await worker.fetch(new Request("https://bus.example/ready", {
    headers: { "x-correlation-id": correlationId },
  }), env as never, ctx);
  const body = await response.json() as { ok: boolean; status: string; checks: Record<string, boolean> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "ready");
  assert.ok(Object.values(body.checks).every(Boolean));
  assert.ok(sqlCalls.some((call) => call.sql.includes("sqlite_master")), "D1 was queried");
  assert.equal(JSON.stringify(body).includes("ingest-secret"), false);
  assert.equal(JSON.stringify(body).includes("jobnimbus-secret"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-request-id"), correlationId);
  assert.equal(response.headers.get("x-correlation-id"), correlationId);
});

test("health remains a backward-compatible liveness check when dependencies are unavailable", async () => {
  const { env, sqlCalls } = fakeEnv({ d1Throws: true, missingSchemaArtifact: true });
  delete (env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  delete (env as { RAW?: unknown }).RAW;

  const response = await worker.fetch(new Request("https://bus.example/health"), env as never, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sqlCalls.length, 0, "liveness must not query D1");
});

test("readiness fails closed when D1 cannot be queried", async () => {
  const { env } = fakeEnv({ d1Throws: true });
  const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { d1: boolean; schema: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.d1, false);
  assert.equal(body.checks.schema, false);
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
});

test("readiness fails closed when the operational migration artifacts are missing", async () => {
  const { env } = fakeEnv({ missingSchemaArtifact: true });
  const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { d1: boolean; schema: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.d1, true);
  assert.equal(body.checks.schema, false);
});

test("readiness fails closed when the redundant alert path is not configured", async () => {
  const { env } = fakeEnv();
  delete (env as { BACKUP_ALERT_EMAIL?: string }).BACKUP_ALERT_EMAIL;
  const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { notification_configuration: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.notification_configuration, false);
});

test("readiness accepts a complete enabled app BFF configuration", async () => {
  const { env } = fakeEnv();
  enableAppBff(env);
  const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { app_bff_configuration: boolean } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.app_bff_configuration, true);
});

test("readiness fails closed for missing or malformed enabled app BFF metadata", async () => {
  const cases: Array<[string, unknown]> = [
    ["APP_TENANT_ID", "IronWrap"],
    ["APP_TENANT_NAME", ""],
    ["APP_TENANT_BRAND", ""],
    ["APP_LOCALE", "en-ca"],
    ["APP_TIME_ZONE", "Edmonton"],
    ["APP_CURRENCY", "cad"],
    ["APP_PUBLIC_ORIGIN", "http://app.example.com"],
    ["APP_ALLOWED_ORIGINS", "https://other.example.com"],
    ["APP_AUTH_PEPPER", "too-short"],
    ["ERPNEXT_BASE_URL", "http://frappe.example.com"],
  ];

  for (const [key, invalidValue] of cases) {
    const { env } = fakeEnv();
    enableAppBff(env);
    (env as Record<string, unknown>)[key] = invalidValue;
    const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
    const body = await response.json() as { ok: boolean; checks: { app_bff_configuration: boolean } };
    assert.equal(response.status, 503, key);
    assert.equal(body.ok, false, key);
    assert.equal(body.checks.app_bff_configuration, false, key);
  }
});

test("request-id selection rejects unsafe correlation ids and preserves a safe fallback", async () => {
  const { env } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/not-found", {
    headers: {
      "x-correlation-id": "bad,value",
      "x-request-id": "request-12345678",
    },
  }), env as never, ctx);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "request-12345678");
  assert.equal(response.headers.get("x-correlation-id"), "request-12345678");
});

test("admin status reports heartbeat, operational counts, audit failures, and QB freshness", async () => {
  const { env } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/admin/status?audit_limit=5", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    heartbeat: { fresh: boolean; reconciled: boolean };
    counts: {
      open_dead_letters: number;
      pending: number;
      stuck: number;
      frappe_errors: number;
      replay_failed: number;
      replay_stuck: number;
    };
    recent_audit_failures: { entries: unknown[] };
    quickbooks_receipts: Record<string, unknown>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.heartbeat.fresh, true);
  assert.equal(body.heartbeat.reconciled, true);
  assert.deepEqual(body.counts, {
    open_dead_letters: 3,
    pending: 3,
    stuck: 1,
    frappe_errors: 2,
    replay_failed: 0,
    replay_stuck: 0,
  });
  assert.equal(body.recent_audit_failures.entries.length, 1);
  assert.equal(body.quickbooks_receipts.available, true);
  assert.equal(body.quickbooks_receipts.fresh, true);
  assert.equal("payload_hash" in body.quickbooks_receipts, false);
  assert.equal("raw_key" in body.quickbooks_receipts, false);
});

test("admin status treats implausibly future heartbeat timestamps as stale", async () => {
  const { env } = fakeEnv({ heartbeatAt: new Date(Date.now() + 3_600_000).toISOString() });
  const response = await worker.fetch(new Request("https://bus.example/admin/status", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    heartbeat: { age_seconds: number | null; fresh: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.heartbeat.age_seconds, null);
  assert.equal(body.heartbeat.fresh, false);
});

test("admin status surfaces failed and stale replay-ledger claims", async () => {
  const { env } = fakeEnv({ replayCounts: { failed: 2, stuck: 1 } });
  const response = await worker.fetch(new Request("https://bus.example/admin/status", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    counts: { replay_failed: number; replay_stuck: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.counts.replay_failed, 2);
  assert.equal(body.counts.replay_stuck, 1);
});

test("targeted dead-letter replay claims and queues only the requested envelope", async () => {
  const { env, statuses, deadLetters, queue, audits } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);
  const body = await response.json() as { requeued: number; envelope_id: string };

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    matched: 1,
    requeued: 1,
    envelope_id: A,
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.deepEqual(queue, [A]);
  assert.equal(statuses.get(A), "pending_jn_push");
  assert.equal(statuses.get(B), "dead");
  assert.ok(deadLetters.every((row) => row.recovered === 0), "requeue is not falsely marked recovered");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[3], A);
  assert.equal(audits[0].args[11], APPROVAL.run_id);
  assert.equal(audits[0].args[12], APPROVAL.approved_by);
  assert.equal(audits[0].args[13], APPROVAL.reason);
});

test("an exact completed run-id retry returns the stored outcome without queueing or auditing twice", async () => {
  const { env, queue, audits, replayRequests, sqlCalls } = fakeEnv();
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const first = await worker.fetch(request(), env as never, ctx);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { replayed: boolean }).replayed, false);

  const retry = await worker.fetch(request(), env as never, ctx);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    matched: 1,
    requeued: 1,
    envelope_id: A,
    run_id: APPROVAL.run_id,
    replayed: true,
  });
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "completed");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.attempt_count, 1);
  assert.equal(sqlCalls.filter((call) => call.sql.includes("FROM dead_letter d")).length, 1);
});

test("reusing a run id for a different replay or approval identity conflicts", async () => {
  const { env, queue, audits } = fakeEnv();
  const first = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(first.status, 200);

  const mismatches = [
    { envelope_id: B, ...APPROVAL },
    { envelope_id: A, ...APPROVAL, reason: "A different approved reason cannot reuse this run id." },
    { envelope_id: A, ...APPROVAL, approved_by: "different-owner@example.com" },
  ];
  for (const body of mismatches) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(body),
    }), env as never, ctx);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "replay_run_id_conflict",
      run_id: APPROVAL.run_id,
    });
  }
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
});

test("an exact retry safely reclaims a failed rolled-back run and then becomes replayable", async () => {
  const { env, statuses, queue, audits, replayRequests } = fakeEnv({ queueBatchFailCount: 1 });
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const failed = await worker.fetch(request(), env as never, ctx);
  assert.equal(failed.status, 500);
  assert.equal(statuses.get(A), "dead");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "failed");

  const retried = await worker.fetch(request(), env as never, ctx);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json() as { replayed: boolean }).replayed, false);
  assert.deepEqual(queue, [A]);
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "completed");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.attempt_count, 2);
  assert.equal(audits.length, 2, "failed and successful attempts retain separate audit rows");

  const stored = await worker.fetch(request(), env as never, ctx);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json() as { replayed: boolean }).replayed, true);
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 2);
});

test("a concurrent exact retry loses the run-id claim and cannot double-queue", async () => {
  let markQueueStarted!: () => void;
  let releaseQueue!: () => void;
  const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const { env, queue, audits } = fakeEnv({ queueBatchGate: queueGate, onQueueBatch: markQueueStarted });
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const firstPromise = worker.fetch(request(), env as never, ctx);
  await queueStarted;
  const concurrent = await worker.fetch(request(), env as never, ctx);
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), {
    error: "replay_run_in_progress",
    run_id: APPROVAL.run_id,
  });

  releaseQueue();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
});

test("bulk dead-letter replay requires the exact hard confirmation", async () => {
  const { env, statuses, queue, audits } = fakeEnv();
  const denied = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(denied.status, 400);
  assert.equal(statuses.get(A), "dead");
  assert.deepEqual(queue, []);

  const confirmed = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, confirm: BULK_REPLAY_CONFIRMATION, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    matched: 2,
    requeued: 2,
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.deepEqual(queue, [A, B]);
  assert.equal(statuses.get(C), "pushed");

  const retry = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, confirm: BULK_REPLAY_CONFIRMATION, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    matched: 2,
    requeued: 2,
    run_id: APPROVAL.run_id,
    replayed: true,
  });
  assert.deepEqual(queue, [A, B]);
  assert.equal(audits.length, 1);
});

test("replay rejects malformed or non-replayable selections without changing state", async () => {
  const { env, statuses, queue } = fakeEnv();
  const cases = [
    { body: "{", status: 400, error: "invalid_json" },
    { body: JSON.stringify({}), status: 400, error: "invalid_envelope_id" },
    { body: JSON.stringify({ envelope_id: "ow_not-a-uuid" }), status: 400, error: "invalid_envelope_id" },
    { body: JSON.stringify({ all: "true" }), status: 400, error: "invalid_all_flag" },
    { body: JSON.stringify({ all: true, envelope_id: A, confirm: BULK_REPLAY_CONFIRMATION }), status: 400, error: "ambiguous_replay_selection" },
    { body: JSON.stringify({ envelope_id: C, ...APPROVAL }), status: 404, error: "dead_letter_not_replayable" },
  ];

  for (const item of cases) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: item.body,
    }), env as never, ctx);
    assert.equal(response.status, item.status);
    assert.equal((await response.json() as { error: string }).error, item.error);
  }
  assert.equal(statuses.get(A), "dead");
  assert.equal(statuses.get(B), "dead");
  assert.deepEqual(queue, []);
});

test("replay requires bounded approval evidence and never accepts a body token", async () => {
  const { env, statuses, queue, sqlCalls } = fakeEnv();
  const cases = [
    { body: { envelope_id: A }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, run_id: "x" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, approved_by: "x" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, reason: "too short" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, reason: "x".repeat(501) }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, approval_token: "must-not-be-accepted" }, error: "unexpected_replay_field" },
    {
      body: { all: true, confirm: BULK_REPLAY_CONFIRMATION },
      error: "invalid_approval_context",
    },
  ];

  for (const item of cases) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(item.body),
    }), env as never, ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, item.error);
  }
  assert.equal(statuses.get(A), "dead");
  assert.deepEqual(queue, []);
  assert.equal(sqlCalls.some((call) => call.sql.includes("FROM dead_letter d")), false);
});

test("queue publication failure restores a replay claim and records the failure", async () => {
  const { env, statuses, deadLetters, queue, audits, replayRequests } = fakeEnv({ queueBatchThrows: true });
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal" });
  assert.equal(statuses.get(A), "dead", "failed queue publication must not strand the claim as pending");
  assert.deepEqual(queue, []);
  assert.ok(deadLetters.every((row) => row.recovered === 0));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[8], "error");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "failed");
});

test("targeted replay reports an atomic-claim conflict without double-queueing", async () => {
  const { env, statuses, queue, audits } = fakeEnv({ claimConflictFor: A });
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "dead_letter_replay_conflict",
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.equal(statuses.get(A), "pending_jn_push", "the concurrent claimant keeps ownership");
  assert.deepEqual(queue, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[8], "error");
  assert.equal(audits[0].args[9], "dead_letter_replay_conflict");
});

test("source-count endpoint rejects malformed observations before D1", async () => {
  const { env, sourceCounts } = fakeEnv();
  const invalid = [
    { day: "2026-02-30", channel: "website", count: 1 },
    { day: "2026-07-10", channel: "email", count: 1 },
    { day: "2026-07-10", channel: "website", count: -1 },
    { day: "2026-07-10", channel: "website", count: 1.5 },
    { day: "2026-07-10", channel: "website", count: 1_000_001 },
    { day: "2026-07-10", channel: "website", count: "1" },
    { day: "2026-07-10", channel: true, count: 1 },
  ];
  for (const body of invalid) {
    const response = await worker.fetch(new Request("https://bus.example/admin/source-count", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(body),
    }), env as never, ctx);
    assert.equal(response.status, 400);
  }
  const malformed = await worker.fetch(new Request("https://bus.example/admin/source-count", {
    method: "POST", headers: adminHeaders, body: "not-json",
  }), env as never, ctx);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json" });
  assert.deepEqual(sourceCounts, []);

  const valid = await worker.fetch(new Request("https://bus.example/admin/source-count", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ day: "2026-07-10", channel: "website", count: 0 }),
  }), env as never, ctx);
  assert.equal(valid.status, 200);
  assert.deepEqual(sourceCounts, [{ day: "2026-07-10", channel: "website", count: 0 }]);
});

test("dead-letter recovery update is envelope-scoped", async () => {
  const { env, deadLetters } = fakeEnv();
  const recovered = await markDeadLettersRecovered(env as never, A);
  assert.equal(recovered, 1);
  assert.equal(deadLetters.find((row) => row.envelope_id === A)?.recovered, 1);
  assert.equal(deadLetters.find((row) => row.envelope_id === B)?.recovered, 0);
});
