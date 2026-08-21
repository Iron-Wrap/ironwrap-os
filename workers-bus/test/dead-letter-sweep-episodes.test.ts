// dead-letter-sweep-episodes.test.ts - the auto-replay sweep against REAL SQL.
//
// Why this file exists (ELEC-137). `operational-safety.test.ts` covers the sweep's control flow
// against a hand-written D1 double, and it stayed 46/46 green through three production defects the
// ELEC-55 e2e then found in a single live outage. It had to: that double answers
// `listAutoReplayCandidates` by re-implementing what the query was MEANT to return - one row per
// envelope, attempts counted once - so it could never observe that the shipped SQL joined
// `replay_requests` onto an un-collapsed `dead_letter` and reported `attempts = 2` for one real
// attempt, nor that nothing scoped that count to the current outage.
//
// So this suite runs the real migration SQL in an in-memory `node:sqlite` database behind a
// D1-shaped facade - the pattern `accounting-fixture.ts` and `effect-runtime-fixture.ts` already
// use - and drives the real sweep, the real DLQ handler, and the real admin replay endpoint over
// it. Every assertion below fails against the pre-ELEC-137 code and passes against the fix, which
// is the only reason to trust it: the rows are produced by the system, not seeded to a shape.
//
// The four defects, each with the criterion that pins it:
//   1. attempt-count row fan-out ...... "reports one real attempt as one"
//   2. episode carryover .............. "a recovered, capped-out episode does not spend the next"
//   3. jn_skipped recovery flag ....... "a jn_skipped landing closes its rows and /admin/status
//                                        goes back to ok"
//   4. run-id collision across episodes "a second episode's attempts actually queue"
// (4 was latent behind 2: a second episode never got attempts, so its run ids never collided.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import worker from "../src/index.ts";
import { sweepDeadLetterAutoReplay } from "../src/operations.ts";
import { DEAD_LETTER_SWEEP_APPROVER, listAutoReplayCandidates } from "../src/store.ts";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/**
 * Every numbered migration, in the order D1 applies them.
 *
 * Deliberately the whole directory rather than a curated list: the sweep reads `dead_letter`,
 * `envelopes` and `replay_requests`, `/admin/status` reads a dozen more, and a hand-kept list is
 * one more thing that can drift away from the deployed schema — which is the class of problem this
 * file exists to close.
 */
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

const ENVELOPE = "ow_a1b2c3d4-1111-4111-8111-111111111111";
const ADMIN_TOKEN = "admin-secret";
const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
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

  /** `meta.changes` as a `total_changes()` delta, the way D1 reports it — see effect-runtime-fixture.ts. */
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
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw.prepare(sql), this.raw);
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

interface SweepOverrides {
  maxAttempts?: number;
  backoffMin?: number;
}

function sweepEnv(overrides: SweepOverrides = {}) {
  const db = new BusTestD1();
  const queued: string[] = [];
  const env = {
    ADMIN_TOKEN,
    INGEST_TOKEN: "ingest-secret",
    APP_TENANT_ID: "ironwrap",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    // JobNimbus off is the environment the ELEC-55 e2e ran in and the one defect 3 breaks; Frappe
    // off keeps the whole suite inside the no-live-provider rule with no fetch double at all
    // (`pushToErpNext` and `syncLeadSkipToErpNext` both return null when it is off, and
    // `sendOwnerAlert` throws `email_not_configured` before it can reach a network).
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    DEAD_LETTER_AUTO_REPLAY_MAX_ATTEMPTS: String(overrides.maxAttempts ?? 3),
    DEAD_LETTER_AUTO_REPLAY_BACKOFF_MIN: String(overrides.backoffMin ?? 1),
    RAW: { put: async () => {} },
    MEASUREMENT_QUEUE: { send: async () => {} },
    JN_QUEUE: {
      send: async ({ envelope_id }: { envelope_id: string }) => { queued.push(envelope_id); },
      sendBatch: async (messages: Array<{ body: { envelope_id: string } }>) => {
        for (const message of messages) queued.push(message.body.envelope_id);
      },
    },
    DB: db,
  };
  return { env, db, queued };
}

function seedDeadEnvelope(db: BusTestD1, envelopeId = ENVELOPE): void {
  const now = new Date().toISOString();
  db.raw.prepare(
    `INSERT INTO envelopes (envelope_id, source, contact_name, contact_phone, contact_email,
                            payload_json, ts, status, attempts, last_error, created_at, updated_at)
     VALUES (?, 'website', 'Synthetic Lead', '+15875550000', 'lead@example.invalid',
             '{"brand":"ironwrap"}', ?, 'dead', 0, 'erpnext_push: Network connection lost.', ?, ?)`,
  ).run(envelopeId, now, now, now);
  recordDeath(db, envelopeId);
}

/** The dead-letter row `store.recordDeadLetter` writes, with the same columns and defaults. */
function recordDeath(db: BusTestD1, envelopeId = ENVELOPE): void {
  db.raw.prepare(
    `INSERT INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
     VALUES (?, ?, 'erpnext_push', 'erpnext_push: Network connection lost.', '{}', 0)`,
  ).run(new Date().toISOString(), envelopeId);
}

function dlqMessage(envelopeId: string) {
  let acked = 0;
  const batch = {
    queue: "ironwrap-jn-push-dlq",
    messages: [{ body: { envelope_id: envelopeId }, ack: () => { acked += 1; }, retry: () => {} }],
  };
  return { batch, acked: () => acked };
}

function pushMessage(envelopeId: string) {
  let acked = 0;
  const batch = {
    queue: "ironwrap-jn-push",
    messages: [{ body: { envelope_id: envelopeId }, ack: () => { acked += 1; }, retry: () => {} }],
  };
  return { batch, acked: () => acked };
}

/**
 * Move every stored timestamp `minutes` into the past.
 *
 * The sweep's backoff is `backoffMin * 2 ** attempts` from the last attempt (or from the death,
 * before the first), so a test that wants the next tick to be due has to age the ledger rather than
 * wait. Shifting `dead_letter` and `replay_requests` by the SAME offset preserves their order, which
 * is what the episode bound (`replay_requests.created_at >= dead_since`) reads.
 */
function rewind(db: BusTestD1, minutes: number): void {
  const shift = minutes * 60_000;
  const older = (value: string | null) =>
    value === null ? null : new Date(Date.parse(value) - shift).toISOString();

  const deaths = db.raw.prepare("SELECT id, ts FROM dead_letter").all() as Array<{ id: number; ts: string }>;
  const updateDeath = db.raw.prepare("UPDATE dead_letter SET ts = ? WHERE id = ?");
  for (const row of deaths) updateDeath.run(older(row.ts), row.id);

  const replays = db.raw.prepare(
    "SELECT run_id, created_at, updated_at, completed_at FROM replay_requests",
  ).all() as Array<{ run_id: string; created_at: string; updated_at: string; completed_at: string | null }>;
  const updateReplay = db.raw.prepare(
    "UPDATE replay_requests SET created_at = ?, updated_at = ?, completed_at = ? WHERE run_id = ?",
  );
  for (const row of replays) {
    updateReplay.run(older(row.created_at), older(row.updated_at), older(row.completed_at), row.run_id);
  }
}

function sweepLedger(db: BusTestD1): Array<{ run_id: string; status: string; created_at: string }> {
  return db.raw.prepare(
    "SELECT run_id, status, created_at FROM replay_requests WHERE approved_by = ? ORDER BY created_at, run_id",
  ).all(DEAD_LETTER_SWEEP_APPROVER) as Array<{ run_id: string; status: string; created_at: string }>;
}

function openDeadLetterCount(db: BusTestD1): number {
  return Number(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM dead_letter WHERE recovered = 0").get() as { n: number }).n,
  );
}

function envelopeStatus(db: BusTestD1, envelopeId = ENVELOPE): string {
  return String(
    (db.raw.prepare("SELECT status FROM envelopes WHERE envelope_id = ?").get(envelopeId) as { status: string }).status,
  );
}

/** One full failed cycle: the sweep replays, the retry dies again, and the clock moves on. */
async function replayThenRedie(env: Record<string, unknown>, db: BusTestD1): Promise<{
  replayed: number;
  given_up: number;
}> {
  const result = await sweepDeadLetterAutoReplay(env as never);
  if (result.replayed > 0) {
    const { batch, acked } = dlqMessage(ENVELOPE);
    await worker.queue(batch as never, env as never, ctx);
    assert.equal(acked(), 1, "the DLQ handler must ack the re-death");
  }
  rewind(db, 600);
  return result;
}

test("defect 1: one real attempt is counted once, however many dead-letter rows the outage opened", async () => {
  const { env, db, queued } = sweepEnv();
  seedDeadEnvelope(db);
  rewind(db, 600);

  const first = await sweepDeadLetterAutoReplay(env as never);
  assert.equal(first.replayed, 1);
  assert.deepEqual(queued, [ENVELOPE]);

  // The replay reached a still-broken Frappe and dead-lettered again: a SECOND open row for the
  // same outage, against exactly one real attempt.
  const { batch } = dlqMessage(ENVELOPE);
  await worker.queue(batch as never, env as never, ctx);
  rewind(db, 600);
  assert.equal(openDeadLetterCount(db), 2, "a re-death opens a second row inside the same episode");

  const afterOne = await listAutoReplayCandidates(env as never, 100);
  assert.equal(afterOne.length, 1);
  // Pre-fix this read 2 (2 open rows x 1 ledger row), so a cap of 5 was spent twice as fast and the
  // ELEC-55 repro gave up after ONE retry with the cap set to 2.
  assert.equal(afterOne[0]!.attempts, 1, "one booked attempt must count as one");
  assert.equal(afterOne[0]!.dead_since, oldestOpenDeath(db), "the episode is anchored at its FIRST death");

  await replayThenRedie(env, db);
  assert.equal(openDeadLetterCount(db), 3);

  const afterTwo = await listAutoReplayCandidates(env as never, 100);
  // Pre-fix: 3 open rows x 2 ledger rows = 6.
  assert.equal(afterTwo[0]!.attempts, 2, "two booked attempts must count as two, not as rows x attempts");
});

test("defect 1: the cap is spent by real attempts, so give-up lands on exactly maxAttempts", async () => {
  const { env, db } = sweepEnv({ maxAttempts: 3 });
  seedDeadEnvelope(db);
  rewind(db, 600);

  for (let cycle = 1; cycle <= 3; cycle++) {
    const result = await replayThenRedie(env, db);
    assert.equal(result.replayed, 1, `cycle ${cycle} must make a real attempt`);
    assert.equal(result.given_up, 0, `cycle ${cycle} must not give up early`);
  }
  assert.equal(sweepLedger(db).length, 3, "exactly three real attempts were made");

  const capped = await sweepDeadLetterAutoReplay(env as never);
  assert.equal(capped.given_up, 1);
  assert.equal(capped.replayed, 0);
  assert.equal(sweepLedger(db).length, 3, "give-up books no further ledger row");
  // Terminal for the SWEEP only.
  assert.equal(envelopeStatus(db), "dead");
  assert.equal(openDeadLetterCount(db), 4, "the dead-letter rows stay open for the admin path");
});

test("defects 2, 3 and 4: a recovered episode closes its rows, and the next outage gets a fresh, spendable cap", async () => {
  const { env, db, queued } = sweepEnv({ maxAttempts: 3 });
  seedDeadEnvelope(db);
  rewind(db, 600);

  for (let cycle = 1; cycle <= 3; cycle++) await replayThenRedie(env, db);
  assert.equal((await sweepDeadLetterAutoReplay(env as never)).given_up, 1, "episode 1 is capped out");
  const episodeOneLedger = sweepLedger(db).map((row) => row.run_id);
  assert.equal(episodeOneLedger.length, 3);

  // (e) Regression: the cap ends AUTOMATIC recovery only. An admin can still replay by hand.
  queued.length = 0;
  const replay = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      envelope_id: ENVELOPE,
      run_id: "hermes-run-20260821-manual-001",
      approved_by: "owner@example.invalid",
      reason: "Frappe verified reachable again; re-drive the capped envelope by hand.",
    }),
  }), env as never, ctx);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    replayed: false,
    matched: 1,
    requeued: 1,
    envelope_id: ENVELOPE,
    run_id: "hermes-run-20260821-manual-001",
  });
  assert.deepEqual(queued, [ENVELOPE], "the manual replay actually queues the envelope");

  // (d) Frappe is healthy now, so the replay lands. With JobNimbus disabled the terminal outcome is
  // `jn_skipped` — the branch that, pre-fix, was the one terminal success that never closed its
  // dead-letter rows, leaving /admin/status degraded forever on every JN-disabled environment.
  const { batch, acked } = pushMessage(ENVELOPE);
  await worker.queue(batch as never, env as never, ctx);
  assert.equal(acked(), 1, "a disabled-JobNimbus skip acks, it never retries into the DLQ");
  assert.equal(envelopeStatus(db), "jn_skipped");
  assert.equal(openDeadLetterCount(db), 0, "every row the episode opened is closed by its recovery");

  // ...and the operator-visible verdict actually heals with it.
  seedFreshHeartbeat(db);
  const healthy = await worker.fetch(
    new Request("https://bus.example/admin/status", { headers: ADMIN_HEADERS }),
    env as never,
    ctx,
  ) ;
  assert.equal(healthy.status, 200);
  const healthyBody = await healthy.json() as { status: string; counts: { open_dead_letters: number } };
  assert.equal(healthyBody.counts.open_dead_letters, 0);
  assert.equal(healthyBody.status, "ok", "the system healed, so the status must say so");

  // (c) Months later, an unrelated failure. This is a NEW episode: the spent budget of the closed
  // one must not follow it. Pre-fix `attempts` still counted all three old ledger rows, so the very
  // first tick gave up with zero automatic attempts and the envelope was manual-only for life.
  recordDeath(db, ENVELOPE);
  db.raw.prepare("UPDATE envelopes SET status = 'dead' WHERE envelope_id = ?").run(ENVELOPE);
  rewind(db, 600);

  const fresh = await listAutoReplayCandidates(env as never, 100);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.attempts, 0, "a new episode starts from zero");
  assert.equal(fresh[0]!.last_attempt_at, null, "and from no backoff history");

  queued.length = 0;
  const episodeTwo = await sweepDeadLetterAutoReplay(env as never);
  assert.equal(episodeTwo.given_up, 0);
  assert.equal(episodeTwo.replayed, 1, "the fresh cap is actually spendable");
  // (4) The proof that it is spendable and not silently cached: a NEW ledger row was booked, under
  // a run id that does not collide with episode 1's first attempt. Sharing the id would have made
  // `claimReplayRequest` return episode 1's completed outcome, which the sweep books as a conflict
  // that queues nothing — a fresh cap that can never be spent.
  const episodeTwoLedger = sweepLedger(db).map((row) => row.run_id);
  assert.equal(episodeTwoLedger.length, 4);
  const booked = episodeTwoLedger.filter((runId) => !episodeOneLedger.includes(runId));
  assert.equal(booked.length, 1, "episode 2 attempt 1 must take a run id of its own");
  assert.deepEqual(queued, [ENVELOPE], "and must actually queue the envelope");
  assert.equal(envelopeStatus(db), "pending_jn_push");
});

test("defect 3: the missing-credential skip also closes its dead-letter rows", async () => {
  // Same shape as `jn_skipped`: a terminal status the sweep will never revisit, because it only
  // considers envelopes still `dead`. Leaving the rows open strands /admin/status identically.
  const { env, db } = sweepEnv();
  Object.assign(env, { ERPNEXT_ENABLED: "true", ERPNEXT_API_KEY: "", ERPNEXT_API_SECRET: "" });
  seedDeadEnvelope(db);
  db.raw.prepare("UPDATE envelopes SET status = 'pending_jn_push' WHERE envelope_id = ?").run(ENVELOPE);
  assert.equal(openDeadLetterCount(db), 1);

  const { batch, acked } = pushMessage(ENVELOPE);
  await worker.queue(batch as never, env as never, ctx);

  assert.equal(acked(), 1);
  assert.equal(envelopeStatus(db), "jn_skipped");
  assert.equal(openDeadLetterCount(db), 0);
});

function oldestOpenDeath(db: BusTestD1): string {
  return String(
    (db.raw.prepare("SELECT MIN(ts) AS ts FROM dead_letter WHERE recovered = 0").get() as { ts: string }).ts,
  );
}

/** `/admin/status` is degraded without a fresh reconciled heartbeat, whatever the dead letters say. */
function seedFreshHeartbeat(db: BusTestD1): void {
  db.raw.prepare(
    "INSERT INTO heartbeat (day, ran_at, reconciled, dead_letter_open) VALUES (?,?,1,0)",
  ).run("2026-08-21", new Date().toISOString());
}
