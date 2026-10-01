// cron-liveness.test.ts — IRO-262. The pure verdict in isolation, then the real handler, the
// real `/admin/status` evidence and the real `/ready?scope=ops` gate against a migrated in-memory
// D1 — the `BusTestD1` pattern `dead-letter-sweep-episodes.test.ts` established, because a double
// that re-implements the schema can agree with a bug the same way it agrees with the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import worker from "../src/index.ts";
import { getOperationalStatus } from "../src/operations.ts";
import {
  CRON_LIVENESS_WINDOW_SECONDS,
  CRON_STARTUP_GRACE_SECONDS,
  cronLivenessReport,
  cronStartupGraceSeconds,
} from "../src/cron-liveness.ts";
import type { CronHeartbeatRecord } from "../src/store.ts";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

const ADMIN_TOKEN = "admin-secret";
const ctx = {} as never;

class SqliteStatement {
  private readonly statement: StatementSync;
  private readonly database: DatabaseSync;
  private readonly args: unknown[];

  constructor(statement: StatementSync, database: DatabaseSync, args: unknown[] = []) {
    this.statement = statement;
    this.database = database;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.statement, this.database, args);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T | null;
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    return { success: true, results: this.statement.all(...this.args) as T[], meta: { changes: 0 } };
  }

  async run(): Promise<{ success: true; results: []; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...this.args);
    return { success: true, results: [], meta: { changes: totalChanges(this.database) - before } };
  }
}

function totalChanges(database: DatabaseSync): number {
  return Number((database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
}

class BusTestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) this.raw.exec(migration);
    // A pre-0038 user exists on every real tenant; readiness only reports ready once the
    // backfill has resolved its access_role (readiness-probe.test.ts's migratedDatabase).
    this.raw.prepare(
      `INSERT INTO app_users
        (user_id, tenant_id, email_normalized, display_name, role, access_role, active,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ops', 'ops', 1, ?, ?, ?)`,
    ).run(
      "appu_legacy_ops_0001",
      "ironwrap",
      "legacy-ops@example.invalid",
      "Legacy Operations",
      "owner@example.invalid",
      "2026-08-13T11:59:00.000Z",
      "2026-08-13T11:59:00.000Z",
    );
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw.prepare(sql), this.raw);
  }
}

/** A readiness-passing env: every `OWNED_CORE_CHECKS` binding/credential present, real D1. */
function readinessEnv(db: BusTestD1, overrides: Record<string, unknown> = {}) {
  return {
    ADMIN_TOKEN,
    INGEST_TOKEN: "ingest-secret",
    APP_TENANT_ID: "ironwrap",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    BACKUP_ALERT_EMAIL: "backup@example.invalid",
    FROM_EMAIL: "bus@example.invalid",
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"svc@example.invalid"}',
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    RAW: { put: async () => {} },
    MEASUREMENT_QUEUE: { send: async () => {} },
    JN_QUEUE: {
      send: async () => {},
      sendBatch: async () => {},
    },
    DB: db,
    ...overrides,
  };
}

function cronRow(db: BusTestD1, cron: string): CronHeartbeatRecord | null {
  return db.raw.prepare(
    "SELECT cron, started_at, finished_at, status, seeded_at FROM cron_heartbeat WHERE cron = ?",
  ).get(cron) as CronHeartbeatRecord | null;
}

/** Drive the real Worker entrypoint Wrangler invokes and await its whole lifetime. Returns whether
 * the composed work's lifetime rejected, so a test can assert R1.3's re-raise rather than assume
 * it — `runCron`'s own `.catch` must not silently absorb that signal. */
async function runCron(env: unknown, cron: string, scheduledTime: number): Promise<boolean> {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron, scheduledTime, noRetry() {} } as never,
    env as never,
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as never,
  );
  assert.equal(pending.length, cron === "*/5 * * * *" || cron === "0 14 * * *" ? 1 : 0);
  let rejected = false;
  await Promise.all(pending.map((p) => p.catch(() => { rejected = true; })));
  return rejected;
}

// --- cronLivenessReport: the pure verdict ------------------------------------------------------

const NOW = new Date("2026-09-30T12:00:00.000Z");
const FREQUENT = "*/5 * * * *";
const DAILY = "0 14 * * *";

function row(overrides: Partial<CronHeartbeatRecord> & { cron: string }): CronHeartbeatRecord {
  return {
    started_at: null,
    finished_at: null,
    status: "seeded",
    seeded_at: NOW.toISOString(),
    ...overrides,
  };
}

test("cronLivenessReport: a tick inside its window is fresh", () => {
  const report = cronLivenessReport(
    [
      row({ cron: FREQUENT, started_at: new Date(NOW.getTime() - 60_000).toISOString(), status: "ok" }),
      row({ cron: DAILY, started_at: new Date(NOW.getTime() - 3_600_000).toISOString(), status: "ok" }),
    ],
    NOW,
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.crons.map((c) => c.state), ["fresh", "fresh"]);
});

test("cronLivenessReport: a tick older than its window is stale", () => {
  const report = cronLivenessReport(
    [
      row({
        cron: FREQUENT,
        started_at: new Date(NOW.getTime() - CRON_LIVENESS_WINDOW_SECONDS[FREQUENT] * 1_000 - 60_000)
          .toISOString(),
        status: "ok",
      }),
      row({ cron: DAILY, started_at: new Date(NOW.getTime() - 3_600_000).toISOString(), status: "ok" }),
    ],
    NOW,
  );
  assert.equal(report.ok, false);
  assert.equal(report.crons[0].state, "stale");
  assert.equal(report.crons[1].state, "fresh");
});

test("cronLivenessReport: a never-started row inside its startup grace is starting", () => {
  const report = cronLivenessReport(
    [
      row({ cron: FREQUENT, seeded_at: new Date(NOW.getTime() - CRON_STARTUP_GRACE_SECONDS * 1_000 + 60_000).toISOString() }),
      row({ cron: DAILY, seeded_at: new Date(NOW.getTime() - CRON_STARTUP_GRACE_SECONDS * 1_000 + 60_000).toISOString() }),
    ],
    NOW,
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.crons.map((c) => c.state), ["starting", "starting"]);
});

test("cronLivenessReport: a never-started row past its startup grace is stale", () => {
  const report = cronLivenessReport(
    [row({
      cron: FREQUENT,
      seeded_at: new Date(NOW.getTime() - cronStartupGraceSeconds(FREQUENT) * 1_000 - 60_000).toISOString(),
    })],
    NOW,
  );
  assert.equal(report.crons[0].state, "stale");
  assert.equal(report.ok, false);
});

test("cronLivenessReport: the asymmetric day-one state — */5 fresh, daily never started", () => {
  // The regression test for the blocker this revision fixes: a daily cron past the old global
  // 20-minute grace, but well inside its own (20 min + 26 h) grace, must read "starting", not
  // "stale".
  const freshFrequent = row({
    cron: FREQUENT,
    started_at: new Date(NOW.getTime() - 60_000).toISOString(),
    status: "ok",
  });
  const stillStarting = cronLivenessReport(
    [
      freshFrequent,
      row({ cron: DAILY, seeded_at: new Date(NOW.getTime() - CRON_STARTUP_GRACE_SECONDS * 1_000 - 60_000).toISOString() }),
    ],
    NOW,
  );
  assert.equal(stillStarting.crons.find((c) => c.cron === DAILY)?.state, "starting");
  assert.equal(stillStarting.ok, true);

  const nowStale = cronLivenessReport(
    [
      freshFrequent,
      row({ cron: DAILY, seeded_at: new Date(NOW.getTime() - cronStartupGraceSeconds(DAILY) * 1_000 - 60_000).toISOString() }),
    ],
    NOW,
  );
  assert.equal(nowStale.crons.find((c) => c.cron === DAILY)?.state, "stale");
  assert.equal(nowStale.ok, false);
});

test("cronLivenessReport: a started_at in the future is skew, not freshness", () => {
  const report = cronLivenessReport(
    [row({ cron: FREQUENT, started_at: new Date(NOW.getTime() + 600_000).toISOString(), status: "running" })],
    NOW,
  );
  assert.equal(report.crons[0].age_seconds, null);
  assert.equal(report.crons[0].state, "stale");
});

test("cronLivenessReport: a row for a cron outside the contract is ignored", () => {
  const report = cronLivenessReport(
    [
      row({ cron: FREQUENT, started_at: new Date(NOW.getTime() - 60_000).toISOString(), status: "ok" }),
      row({ cron: DAILY, started_at: new Date(NOW.getTime() - 3_600_000).toISOString(), status: "ok" }),
      row({ cron: "*/1 * * * *", started_at: NOW.toISOString(), status: "ok" }),
    ],
    NOW,
  );
  assert.equal(report.crons.length, 2);
  assert.equal(report.ok, true);
});

test("cronLivenessReport: a missing row is stale", () => {
  const report = cronLivenessReport([row({ cron: DAILY, started_at: NOW.toISOString(), status: "ok" })], NOW);
  const frequent = report.crons.find((c) => c.cron === FREQUENT);
  assert.equal(frequent?.state, "stale");
  assert.equal(frequent?.status, "missing");
  assert.equal(report.ok, false);
});

// --- the real handler against a migrated in-memory D1 -------------------------------------------

test("scheduled: the daily cron starts then settles its heartbeat, ok on success", async () => {
  const db = new BusTestD1();
  const before = Date.now();
  assert.equal(await runCron(readinessEnv(db), DAILY, before), false);
  const after = cronRow(db, DAILY)!;
  assert.equal(after.status, "ok");
  assert.ok(after.started_at && Date.parse(after.started_at) >= before);
  assert.ok(after.finished_at && after.finished_at >= after.started_at!);
  // Unrelated cron's seed row is untouched.
  const frequent = cronRow(db, FREQUENT)!;
  assert.equal(frequent.status, "seeded");
});

test("scheduled: the frequent cron starts then settles its heartbeat, ok on success", async () => {
  const db = new BusTestD1();
  const before = Date.now();
  assert.equal(await runCron(readinessEnv(db), FREQUENT, before), false);
  const after = cronRow(db, FREQUENT)!;
  assert.equal(after.status, "ok");
  assert.ok(after.started_at && Date.parse(after.started_at) >= before);
  assert.ok(after.finished_at && after.finished_at >= after.started_at!);
});

test("scheduled: the daily cron settles 'error' when its composed work rejects", async () => {
  const db = new BusTestD1();
  // runReconcile is bare in the Promise.all — no per-item catch — so dropping a table it writes
  // rejects the composed work the same way a real D1 outage would.
  db.raw.exec("DROP TABLE heartbeat");
  const env = readinessEnv(db);
  assert.equal(await runCron(env, DAILY, Date.now()), true);
  const after = cronRow(db, DAILY)!;
  assert.equal(after.status, "error");
  assert.ok(after.started_at);
  assert.ok(after.finished_at);
});

test("scheduled: the frequent cron settles 'error' when its composed work rejects", async () => {
  const db = new BusTestD1();
  // Seed one stuck envelope (past the 15-minute threshold) so retrySweep (also bare in the array)
  // has something to redrive, then take away the JobNimbus queue binding it redrives through.
  const old = new Date(Date.now() - 3_600_000).toISOString();
  db.raw.prepare(
    `INSERT INTO envelopes (envelope_id, source, contact_name, contact_phone, contact_email,
                            payload_json, ts, status, attempts, last_error, created_at, updated_at)
     VALUES ('ow_a1b2c3d4-1111-4111-8111-111111111111', 'website', 'Synthetic Lead', '+15875550000',
             'lead@example.invalid', '{"brand":"ironwrap"}', ?, 'pending_jn_push', 0, NULL, ?, ?)`,
  ).run(old, old, old);
  const env = readinessEnv(db, { JN_QUEUE: undefined });
  assert.equal(await runCron(env, FREQUENT, Date.now()), true);
  const after = cronRow(db, FREQUENT)!;
  assert.equal(after.status, "error");
});

test("scheduled: an unknown cron string writes nothing and owns no waitUntil", async () => {
  const db = new BusTestD1();
  await runCron(readinessEnv(db), "*/1 * * * *", Date.now());
  assert.equal(cronRow(db, FREQUENT)!.status, "seeded");
  assert.equal(cronRow(db, DAILY)!.status, "seeded");
});

// --- /admin/status: evidence only, never a gate -------------------------------------------------

test("/admin/status carries a crons block and its top-level status is unchanged by a stale cron", async () => {
  const db = new BusTestD1();
  const env = readinessEnv(db);
  // A clean "ok" baseline: the real daily tick writes the heartbeat `getOperationalStatus` reads.
  await runCron(env, DAILY, Date.now());
  // Age each row past its OWN per-cron grace (R1.1) — the daily's grace is 26 h wider than the
  // frequent's, so a single shared age would leave the daily "starting" instead of "stale".
  for (const cron of [FREQUENT, DAILY]) {
    const longAgo = new Date(Date.now() - (cronStartupGraceSeconds(cron) + 3_600) * 1_000).toISOString();
    db.raw.prepare("UPDATE cron_heartbeat SET seeded_at = ?, started_at = NULL WHERE cron = ?").run(longAgo, cron);
  }
  const status = await getOperationalStatus(env as never, 20);
  assert.equal(status.crons.length, 2);
  assert.ok(status.crons.every((c) => c.state === "stale"));
  // No open dead letters, no stuck envelopes, no audit failures, a fresh daily heartbeat — the
  // existing verdict stays "ok" even though every cron reads stale.
  assert.equal(status.status, "ok");
});

test("getCronLiveness fails closed: an unreadable cron_heartbeat is 503 on scope=ops, never a 500, and /admin/status stays 'ok'", async () => {
  const db = new BusTestD1();
  // A clean "ok" baseline first, same as the `/admin/status` test above: the real daily tick
  // writes the `heartbeat` row `getOperationalStatus` reads for its own unrelated verdict.
  await runCron(readinessEnv(db), DAILY, Date.now());
  // Every read of cron_heartbeat throws from here on, the way a production deploy that ships code
  // before the 0132 migration would see it — everything else on `DB` still works.
  const throwingDB = {
    prepare(sql: string) {
      if (sql.includes("FROM cron_heartbeat")) throw new Error("no such table: cron_heartbeat");
      return db.prepare(sql);
    },
  };
  const env = readinessEnv(db, { DB: throwingDB });

  const ready = await worker.fetch(new Request("https://bus.example/ready?scope=ops"), env as never, ctx);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ok: false });

  const status = await getOperationalStatus(env as never, 20);
  assert.equal(status.status, "ok");
  assert.ok(status.crons.every((c) => c.state === "stale" && c.status === "missing"));
});

// --- /ready?scope=ops: the token-less cron probe --------------------------------------------

test("/ready?scope=ops is 503 on a stale row and 200 once a tick lands; other scopes are unaffected", async () => {
  const db = new BusTestD1();
  const env = readinessEnv(db);
  // Past the FREQUENT cron's own startup grace, with no tick yet: stale, not "starting". Scoped
  // to FREQUENT alone (not every row) so this is the cron under test going stale, rather than
  // passing by accident because the daily's much wider grace was also exceeded.
  const longAgo = new Date(Date.now() - (cronStartupGraceSeconds(FREQUENT) + 3_600) * 1_000).toISOString();
  db.raw.prepare("UPDATE cron_heartbeat SET seeded_at = ? WHERE cron = ?").run(longAgo, FREQUENT);

  const stale = await worker.fetch(new Request("https://bus.example/ready?scope=ops"), env as never, ctx);
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), { ok: false });

  const core = await worker.fetch(new Request("https://bus.example/ready?scope=core"), env as never, ctx);
  assert.equal(core.status, 200);
  assert.deepEqual(await core.json(), { ok: true });

  const full = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  assert.equal(full.status, 200);

  await runCron(env, FREQUENT, Date.now());
  await runCron(env, DAILY, Date.now());

  const fresh = await worker.fetch(new Request("https://bus.example/ready?scope=ops"), env as never, ctx);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { ok: true });

  const freshAdmin = await worker.fetch(
    new Request("https://bus.example/ready?scope=ops", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    env as never,
    ctx,
  );
  assert.equal(freshAdmin.status, 200);
  const body = await freshAdmin.json() as { crons: Array<{ cron: string; state: string }> };
  assert.equal(body.crons.length, 2);
  assert.ok(body.crons.every((c) => c.state === "fresh"));
});
