// operating-core-launch-proof-pair.test.ts - the launch proof's website lead and estimate session
// for one person, end to end over every migration (IRO-274).
//
// qa's Deploy run dead-lettered the website lead with `operating_core_customer_conflict`: the
// estimate (email only) materialises first, and the lead's post-commit readback then demanded the
// phone the stored customer lacks. The fixtures are the proof's own (`createLaunchProofPlan`), so
// a change to the proof's two requests changes this test with them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import worker from "../src/index.ts";
import { createLaunchProofPlan } from "../../tools/launch-proof.mjs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

const ADMIN_TOKEN = "admin-secret";
const INGEST_TOKEN = "ingest-secret";
const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
const ctx = { waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}) } as never;

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


function launchEnv() {
  const db = new BusTestD1();
  const queued: string[] = [];
  const env = {
    ADMIN_TOKEN,
    INGEST_TOKEN,
    APP_TENANT_ID: "ironwrap",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    DEDUP_WINDOW_HOURS: "72",
    OPERATING_AUTOMATION_USER: "ironwrap-worker",
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

type Launch = ReturnType<typeof launchEnv>;

function plan() {
  return createLaunchProofPlan({ stamp: "1790000000123", randomSuffix: "0123456789abcdef0123456789abcdef" });
}

async function post(launch: Launch, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await worker.fetch(new Request(`https://bus.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), launch.env as never, ctx);
  assert.equal(response.status, 200, `${path} answers 200`);
  return response;
}

const postWebsite = (launch: Launch, p = plan()) => post(launch, "/ingest/website", p.leadFixture);
const postEstimate = (launch: Launch, p = plan()) =>
  post(launch, "/ingest/estimate", p.estimateFixture, { "idempotency-key": `lp-${p.executionId}` });

async function drain(launch: Launch) {
  let acked = 0;
  let retried = 0;
  const ids = launch.queued.splice(0);
  const messages = ids.map((envelope_id) => ({
    body: { envelope_id },
    ack: () => { acked += 1; },
    retry: () => { retried += 1; },
  }));
  await worker.queue({ queue: "ironwrap-jn-push", messages } as never, launch.env as never, ctx);
  return { acked, retried };
}

function websiteEnvelope(db: BusTestD1) {
  return db.raw.prepare(
    "SELECT envelope_id, status, erpnext_error FROM envelopes WHERE source = 'website'",
  ).get() as { envelope_id: string; status: string; erpnext_error: string | null };
}

function count(db: BusTestD1, sql: string): number {
  return Number((db.raw.prepare(sql).get() as { n: number }).n);
}

function seedFreshHeartbeat(db: BusTestD1): void {
  db.raw.prepare(
    "INSERT INTO heartbeat (day, ran_at, reconciled, dead_letter_open) VALUES (?,?,1,0)",
  ).run("2026-08-21", new Date().toISOString());
}

async function adminStatus(launch: Launch) {
  seedFreshHeartbeat(launch.db);
  const response = await worker.fetch(
    new Request("https://bus.example/admin/status?audit_limit=20", { headers: ADMIN_HEADERS }),
    launch.env as never,
    ctx,
  );
  assert.equal(response.status, 200);
  return await response.json() as {
    status: string;
    counts: { open_dead_letters: number; frappe_errors: number };
    recent_audit_failures: { entries: unknown[] };
  };
}

async function assertHealthy(launch: Launch) {
  const { db } = launch;
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM operating_customers"), 1, "one customer");
  assert.equal(
    count(db, "SELECT COUNT(DISTINCT customer_id) AS n FROM operating_roof_jobs"),
    1,
    "every job is on that customer",
  );
  const status = await adminStatus(launch);
  assert.equal(status.status, "ok");
  assert.equal(status.counts.open_dead_letters, 0);
  assert.equal(status.counts.frappe_errors, 0);
  assert.deepEqual(status.recent_audit_failures.entries, []);
}

for (const [label, estimateFirst] of [["estimate first", true], ["website first", false]] as const) {
  test(`launch proof pair, ${label}: one customer, jn_skipped, status ok`, async () => {
    const launch = launchEnv();
    let drained;
    if (estimateFirst) {
      await postWebsite(launch);
      await postEstimate(launch);
      drained = await drain(launch);
    } else {
      await postWebsite(launch);
      drained = await drain(launch);
      await postEstimate(launch);
    }
    assert.deepEqual(drained, { acked: 1, retried: 0 });
    const website = websiteEnvelope(launch.db);
    assert.equal(website.status, "jn_skipped");
    assert.equal(website.erpnext_error, null);
    await assertHealthy(launch);
  });
}

test("launch proof pair: qa residue heals on replay", async () => {
  const launch = launchEnv();
  const { db } = launch;
  await postWebsite(launch);
  // On qa this message already died; the estimate then landed first.
  launch.queued.length = 0;
  await postEstimate(launch);

  const { envelope_id: envelopeId } = websiteEnvelope(db);
  const error = "native_operating_core: Error: operating_core_customer_conflict";
  db.raw.prepare(
    "UPDATE envelopes SET status = 'dead', attempts = 12, last_error = ?, erpnext_error = ? WHERE envelope_id = ?",
  ).run(error, error, envelopeId);
  for (let i = 0; i < 2; i++) {
    db.raw.prepare(
      `INSERT INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
       VALUES (?, ?, 'operating_core', ?, '{}', 0)`,
    ).run(new Date().toISOString(), envelopeId, error);
  }

  const replay = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      envelope_id: envelopeId,
      run_id: "iro-274-test-replay",
      approved_by: "owner@example.invalid",
      reason: "IRO-274 fix deployed; re-drive the launch-proof lead.",
    }),
  }), launch.env as never, ctx);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { requeued: number }).requeued, 1);

  const drained = await drain(launch);
  assert.equal(drained.acked, 1);
  const website = websiteEnvelope(db);
  assert.equal(website.status, "jn_skipped");
  assert.equal(website.erpnext_error, null);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM dead_letter WHERE recovered = 0"), 0);
  await assertHealthy(launch);
});
