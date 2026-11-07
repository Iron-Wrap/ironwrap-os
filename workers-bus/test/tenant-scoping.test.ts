// Two tenants in one D1: the sweeps, the queue consumer and the crons each stay inside the tenant
// they run for (tenancy.ts, migration 0209). Cross-tenant reads fail; cross-tenant work is routed
// to its own tenant's env or refused, never handled as another tenant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.ts";
import * as store from "../src/store.ts";
import { resetTenantCache, sealTenantSecrets } from "../src/tenancy.ts";

const TENANT_A = "ironwrap";
const TENANT_B = "northline-metal";
const KEK = "d".repeat(64);
const NOW = "2026-08-23T12:00:00.000Z";

/** The real migration chain on an in-memory SQLite, with every executed statement and its arguments recorded. */
class RecordingD1 {
  readonly raw = new DatabaseSync(":memory:");
  readonly executed: Array<{ sql: string; args: unknown[] }> = [];

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) {
        args = bound;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        db.executed.push({ sql, args });
        return (db.raw.prepare(sql).get(...(args as never[])) ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        db.executed.push({ sql, args });
        return { results: db.raw.prepare(sql).all(...(args as never[])) as T[] };
      },
      async run() {
        db.executed.push({ sql, args });
        const result = db.raw.prepare(sql).run(...(args as never[]));
        return { success: true as const, meta: { changes: Number(result.changes) } };
      },
      execute() {
        db.executed.push({ sql, args });
        return db.raw.prepare(sql).run(...(args as never[]));
      },
    };
    return statement;
  }

  async batch(statements: Array<{ execute(): unknown }>): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  /** The tenant ids bound to every executed statement whose SQL matches. */
  tenantsBoundTo(pattern: RegExp): string[] {
    return this.executed
      .filter((entry) => pattern.test(entry.sql))
      .flatMap((entry) => entry.args.filter((arg): arg is string => arg === TENANT_A || arg === TENANT_B));
  }
}

function env(db: RecordingD1, overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    APP_TENANT_ID: TENANT_A,
    APP_MULTI_TENANT_ENABLED: "true",
    TENANT_SECRETS_KEK: KEK,
    ADMIN_TOKEN: "root-admin-token",
    INGEST_TOKEN: "ingest-a",
    OWNER_ALERT_EMAIL: "owner@a.example.invalid",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    AGENT_DATA_CLASS: "synthetic",
    RAW: { put: async () => {}, get: async () => null, head: async () => null },
    JN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    MEASUREMENT_QUEUE: { send: async () => {} },
    NEWO_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    ...overrides,
  };
}

async function registerTenantB(db: RecordingD1, status: "active" | "suspended" = "active"): Promise<void> {
  const sealed = await sealTenantSecrets(KEK, TENANT_B, 1, { INGEST_TOKEN: "ingest-b" });
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, secrets_ciphertext,
                          secrets_key_version, version, write_id, created_at, updated_at)
     VALUES (?, 'Northline Metal', ?, 'synthetic', '{"OWNER_ALERT_EMAIL":"owner@b.example.invalid"}', ?, 1, 1, 'seed-write-b', ?, ?)`,
  ).run(TENANT_B, status, sealed, NOW, NOW);
}

function seedEnvelope(db: RecordingD1, tenantId: string, envelopeId: string, status = "pending_jn_push"): void {
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  db.raw.prepare(
    `INSERT INTO envelopes (envelope_id, tenant_id, source, contact_name, contact_phone, contact_email,
                            payload_json, raw_key, ts, status, dedup_key, attempts, created_at, updated_at)
     VALUES (?, ?, 'website', 'Synthetic Lead', '+15875550100', ?, '{}', ?, ?, ?, ?, 0, ?, ?)`,
  ).run(envelopeId, tenantId, `${envelopeId}@example.invalid`, `raw/${envelopeId}.json`, stale, status, `e:${envelopeId}`, stale, stale);
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>): void { pending.push(promise); },
    passThroughOnException(): void {},
    async settle(): Promise<void> { await Promise.all(pending.map((promise) => promise.catch(() => {}))); },
  };
}

test.beforeEach(() => resetTenantCache());

test("the envelope sweeps read one tenant's rows: stuck, retryable and landed counts never cross", async () => {
  const db = new RecordingD1();
  seedEnvelope(db, TENANT_A, "ow_a_stuck");
  seedEnvelope(db, TENANT_B, "ow_b_stuck");
  seedEnvelope(db, TENANT_B, "ow_b_stuck_2");
  const envA = env(db) as never;
  const envB = env(db, { APP_TENANT_ID: TENANT_B }) as never;

  assert.deepEqual((await store.listStuck(envA, 15, 100)).map((row) => row.envelope_id), ["ow_a_stuck"]);
  assert.deepEqual((await store.listStuck(envB, 15, 100)).map((row) => row.envelope_id).sort(), ["ow_b_stuck", "ow_b_stuck_2"]);

  const day = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 10);
  assert.deepEqual(await store.countLandedByChannel(envA, day), { website: 1 });
  assert.deepEqual(await store.countLandedByChannel(envB, day), { website: 2 });

  assert.equal(await store.getEnvelope(envB, "ow_a_stuck"), null, "tenant B cannot read tenant A's envelope by id");
  assert.ok(await store.getEnvelope(envA, "ow_a_stuck"));
  assert.equal(await store.getEnvelope(envA, "ow_b_stuck"), null);

  db.raw.prepare(
    `UPDATE envelopes SET status = 'received', estimate_submission_key = 'k-a', last_error = 'native_operating_core:retry:x' WHERE envelope_id = 'ow_a_stuck'`,
  ).run();
  db.raw.prepare(
    `UPDATE envelopes SET status = 'received', estimate_submission_key = 'k-b', last_error = 'native_operating_core:retry:x' WHERE envelope_id = 'ow_b_stuck'`,
  ).run();
  assert.deepEqual((await store.listRetryableEstimateOperatingCoreMaterializations(envA, 15, 100)).map((row) => row.envelope_id), ["ow_a_stuck"]);
  assert.deepEqual((await store.listRetryableEstimateOperatingCoreMaterializations(envB, 15, 100)).map((row) => row.envelope_id), ["ow_b_stuck"]);
});

test("a queue message is handled under the tenant that enqueued it; a tenant that cannot be served is retried, never handled as another", async () => {
  const db = new RecordingD1();
  await registerTenantB(db);
  seedEnvelope(db, TENANT_B, "ow_b_queued");
  const outcomes: string[] = [];
  const message = (body: Record<string, unknown>) => ({
    body,
    attempts: 1,
    ack: () => { outcomes.push("ack"); },
    retry: () => { outcomes.push("retry"); },
  });
  const run = async (body: Record<string, unknown>) => {
    db.executed.length = 0;
    outcomes.length = 0;
    await worker.queue({ queue: "ironwrap-jn-push", messages: [message(body)] } as never, env(db) as never, ctx() as never);
  };

  await run({ envelope_id: "ow_b_queued", tenant_id: TENANT_B });
  const envelopeReads = /FROM envelopes WHERE envelope_id = \? AND tenant_id = \?/;
  assert.deepEqual([...new Set(db.tenantsBoundTo(envelopeReads))], [TENANT_B], "tenant B's message reads tenant B's envelope");

  await run({ envelope_id: "ow_b_queued" });
  assert.deepEqual([...new Set(db.tenantsBoundTo(envelopeReads))], [TENANT_A], "a message without a tenant is the Worker tenant's");
  assert.deepEqual(outcomes, ["retry"], "and tenant B's envelope is not found there");

  resetTenantCache();
  db.raw.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").run(TENANT_B);
  await run({ envelope_id: "ow_b_queued", tenant_id: TENANT_B });
  assert.deepEqual(db.tenantsBoundTo(envelopeReads), [], "a suspended tenant's message touches no envelope");
  assert.deepEqual(outcomes, ["retry"]);

  await run({ envelope_id: "ow_b_queued", tenant_id: "no-such-tenant" });
  assert.deepEqual(db.tenantsBoundTo(envelopeReads), []);
  assert.deepEqual(outcomes, ["retry"]);

  // With the flag off a stamped message is the Worker tenant's, as every message was before the field.
  db.executed.length = 0;
  outcomes.length = 0;
  await worker.queue(
    { queue: "ironwrap-jn-push", messages: [message({ envelope_id: "ow_b_queued", tenant_id: TENANT_B })] } as never,
    env(db, { APP_MULTI_TENANT_ENABLED: "false" }) as never,
    ctx() as never,
  );
  assert.deepEqual([...new Set(db.tenantsBoundTo(envelopeReads))], [TENANT_A]);
});

test("the five-minute cron runs its tenant jobs once per active tenant and its global jobs once", async (t) => {
  const db = new RecordingD1();
  await registerTenantB(db);
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(String(line)); });
  const stuckSweep = /FROM envelopes WHERE tenant_id = \? AND status = 'pending_jn_push'/;
  const tick = { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} };

  const both = ctx();
  await worker.scheduled(tick as never, env(db) as never, both as never);
  await both.settle();
  assert.deepEqual(db.tenantsBoundTo(stuckSweep).sort(), [TENANT_A, TENANT_B], "the stuck sweep ran once for each tenant");
  assert.equal(db.executed.filter((entry) => /INSERT INTO cron_heartbeat/.test(entry.sql)).length, 1, "one heartbeat per tick");
  assert.equal(
    db.executed.filter((entry) => /FROM dead_letter/.test(entry.sql) && /recovered = 0/.test(entry.sql)).length <= 2,
    true,
    "the dead-letter sweep, on a table with no tenant column, does not run once per tenant",
  );

  // A tenant whose secrets do not open under the Worker's key is skipped and named, never run
  // with the Worker tenant's credentials.
  resetTenantCache();
  db.executed.length = 0;
  logged.length = 0;
  const wrongKey = ctx();
  await worker.scheduled(tick as never, env(db, { TENANT_SECRETS_KEK: "e".repeat(64) }) as never, wrongKey as never);
  await wrongKey.settle();
  assert.deepEqual(db.tenantsBoundTo(stuckSweep), [TENANT_A], "a tenant that cannot be served gets no pass");
  assert.ok(logged.some((line) => line.includes("cron_tenant_skipped") && line.includes(TENANT_B) && line.includes("tenant_secrets_unavailable")));

  resetTenantCache();
  db.executed.length = 0;
  db.raw.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").run(TENANT_B);
  const suspended = ctx();
  await worker.scheduled(tick as never, env(db) as never, suspended as never);
  await suspended.settle();
  assert.deepEqual(db.tenantsBoundTo(stuckSweep), [TENANT_A], "a suspended tenant gets no pass");

  db.executed.length = 0;
  const off = ctx();
  await worker.scheduled(tick as never, env(db, { APP_MULTI_TENANT_ENABLED: "false" }) as never, off as never);
  await off.settle();
  assert.deepEqual(db.tenantsBoundTo(stuckSweep), [TENANT_A], "with the flag off there is exactly one pass, the Worker tenant's");
});

test("the daily cron runs reconcile per tenant and the prunes once", async () => {
  const db = new RecordingD1();
  await registerTenantB(db);
  const tick = { cron: "0 14 * * *", scheduledTime: Date.now(), noRetry() {} };
  const run = ctx();
  await worker.scheduled(tick as never, env(db) as never, run as never);
  await run.settle();
  const landed = /FROM envelopes\s+WHERE tenant_id = \? AND substr\(created_at, 1, 10\) = \?/;
  assert.deepEqual(db.tenantsBoundTo(landed).sort(), [TENANT_A, TENANT_B], "the landed-count reconcile ran once per tenant");
  assert.equal(db.executed.filter((entry) => /DELETE FROM app_magic_links/.test(entry.sql)).length, 1, "the auth prune ran once");
});
