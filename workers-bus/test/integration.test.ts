// Integration test for the ingest path — runs under `node --test` with in-memory fake bindings
// (no Miniflare, no install). Drives the real Worker `fetch` handler end to end:
// auth → raw to R2 → canonical envelope to D1 → enqueue JobNimbus push.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

function fakeEnv() {
  const r2: Array<{ key: string; body: string }> = [];
  const queue: Array<{ envelope_id: string }> = [];
  const db: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    INGEST_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    A2P_SMS_ENABLED: "false",
    DEDUP_WINDOW_HOURS: "72",
    STUCK_THRESHOLD_MIN: "15",
    // RESEND_API_KEY intentionally absent → instant-ack throws and is swallowed by ctx.waitUntil.
    RAW: { put: async (key: string, body: string) => { r2.push({ key, body }); } },
    JN_QUEUE: {
      send: async (m: { envelope_id: string }) => { queue.push(m); },
      sendBatch: async (ms: Array<{ body: { envelope_id: string } }>) => { for (const m of ms) queue.push(m.body); },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => { db.push({ sql, args }); return { success: true }; },
              first: async () => { db.push({ sql, args }); return null; }, // findDuplicate → no dup
              all: async () => { db.push({ sql, args }); return { results: [] }; },
            };
          },
        };
      },
    },
  };
  return { env, r2, queue, db };
}

const fakeCtx = () => ({ waitUntil: (p: Promise<unknown>) => { void Promise.resolve(p).catch(() => {}); } });

test("POST /ingest/website: raw→R2, envelope→D1, enqueue JN, 200", async () => {
  const { env, r2, queue, db } = fakeEnv();
  const req = new Request("https://bus.example/ingest/website", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "Jane Doe", phone: "(587) 555-1234", email: "Jane@Example.com", service: "metal roof quote" }),
  });
  const res = await worker.fetch(req, env as never, fakeCtx() as never);
  const body = (await res.json()) as { envelope_id: string; status: string; queue: string; duplicate: boolean };

  assert.equal(res.status, 200);
  assert.match(body.envelope_id, /^ow_[0-9a-f-]{36}$/);
  assert.equal(body.duplicate, false);
  assert.equal(body.queue, "residential_sales");           // classifyIntent("metal roof…")
  assert.equal(r2.length, 1);                               // raw stored FIRST
  assert.match(r2[0].key, /^raw\/\d{4}-\d{2}-\d{2}\/ow_/);
  assert.equal(queue.length, 1);                            // JN push enqueued
  assert.equal(queue[0].envelope_id, body.envelope_id);
  const insert = db.find((c) => c.sql.includes("INSERT INTO envelopes"));
  assert.ok(insert, "envelope inserted into D1");
  assert.ok(insert.args.includes("+15875551234"), "phone normalized to E.164 in the stored row");
  assert.ok(insert.args.includes("jane@example.com"), "email normalized");
});

test("auth: missing/wrong bearer token → 401, nothing written", async () => {
  const { env, r2, queue } = fakeEnv();
  const req = new Request("https://bus.example/ingest/website", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  const res = await worker.fetch(req, env as never, fakeCtx() as never);
  assert.equal(res.status, 401);
  assert.equal(r2.length, 0);
  assert.equal(queue.length, 0);
});

test("bad source in path → 400", async () => {
  const { env } = fakeEnv();
  const req = new Request("https://bus.example/ingest/bogus", {
    method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: "{}",
  });
  const res = await worker.fetch(req, env as never, fakeCtx() as never);
  assert.equal(res.status, 400);
});

test("GET /health → ok", async () => {
  const { env } = fakeEnv();
  const res = await worker.fetch(new Request("https://bus.example/health"), env as never, fakeCtx() as never);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
