import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const pending: EnvelopeRecord = {
  envelope_id: "ow_44444444-4444-4444-8444-444444444444",
  source: "website",
  contact_name: "Jane Doe",
  contact_phone: "+15875551234",
  contact_email: "jane@example.com",
  job_ref: null,
  payload_json: JSON.stringify({ brand: "ironwrap", service: "metal roof" }),
  raw_key: "raw/2026-08-20/ow_444.json",
  ts: "2026-08-20T10:00:00.000Z",
  status: "pending_jn_push",
  dedup_key: "p:+15875551234",
  dup_of: null,
  attempts: 0,
  last_error: null,
  jn_contact_id: null,
  jn_job_id: null,
  intent_queue: "residential_sales",
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:00:00.000Z",
};

function queueBatch(envelopeId: string) {
  let acked = 0;
  let retried = 0;
  const batch = {
    queue: "ironwrap-jn-push",
    messages: [{
      body: { envelope_id: envelopeId },
      ack: () => { acked += 1; },
      retry: () => { retried += 1; },
    }],
  };
  return {
    batch,
    counts: () => ({ acked, retried }),
  };
}

function fakeDb(rec: EnvelopeRecord, writes: Array<{ sql: string; args: unknown[] }>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (sql.includes("SELECT * FROM envelopes")) return rec;
              if (sql.includes("SELECT attempts FROM envelopes")) return { attempts: rec.attempts };
              return null;
            },
            run: async () => { writes.push({ sql, args }); return { success: true, meta: { changes: 1 } }; },
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
}

test("queue: ERPNEXT_ENABLED without tokens fail-closes without throw, DLQ, or fake pushed", async (t) => {
  const fetches: Array<{ url: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push({ url: String(input) });
    throw new Error(`unexpected fetch ${String(input)}`);
  });

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const env = withTestEffectRuntime({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    // Intentionally omit ERPNEXT_API_KEY / ERPNEXT_API_SECRET — do not invent dummy tokens.
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "jn-key-must-not-be-used",
    OWNER_ALERT_EMAIL: "owner@example.com",
    DB: fakeDb(pending, writes),
  });
  const { batch, counts } = queueBatch(pending.envelope_id);

  await worker.queue(batch as never, env as never, {} as never);

  const { acked, retried } = counts();
  assert.equal(acked, 1, "missing-token skip must ack so the message does not retry into DLQ");
  assert.equal(retried, 0, "missing-token skip must not retry — retries cannot mint credentials");
  assert.equal(fetches.length, 0, "no Frappe or JobNimbus HTTP with no API pair");
  assert.ok(writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("erpnext_no_token")));
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("pushed")));
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("jn_skipped")));
  assert.ok(!writes.some((w) => w.sql.includes("attempts = attempts + 1")));
  assert.ok(!writes.some((w) => w.sql.includes("INSERT INTO dead_letter")));
  assert.ok(writes.some((w) =>
    w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("erpnext_push") &&
    w.args.includes("skip") &&
    w.args.includes("ok") &&
    w.args.includes("erpnext_no_token")
  ));
  assert.ok(writes.some((w) =>
    w.sql.includes("erpnext_error") &&
    w.args.includes("erpnext_no_token")
  ));
  const statusWrite = writes.find((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("erpnext_no_token"));
  assert.ok(statusWrite);
  assert.equal(statusWrite?.args.includes("erpnext_no_token"), true);
  assert.equal(statusWrite?.args[2], null, "jn_contact_id stays unset — no fake CRM id");
  assert.equal(statusWrite?.args[3], null, "jn_job_id stays unset — no fake CRM id");
});

test("queue: erpnext_no_token re-delivery is a no-op ack, not a fake push or retry", async (t) => {
  const fetches: Array<{ url: string }> = [];
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const skipped: EnvelopeRecord = { ...pending, status: "erpnext_no_token", last_error: "erpnext_no_token" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push({ url: String(input) });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const env = withTestEffectRuntime({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "jn-key-must-not-be-used",
    DB: fakeDb(skipped, writes),
  });
  const { batch, counts } = queueBatch(skipped.envelope_id);
  await worker.queue(batch as never, env as never, {} as never);
  const { acked, retried } = counts();
  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.equal(fetches.length, 0);
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status")));
  assert.ok(!writes.some((w) => w.sql.includes("attempts = attempts + 1")));
  assert.ok(!writes.some((w) => w.sql.includes("INSERT INTO dead_letter")));
  assert.ok(writes.some((w) => w.sql.includes("UPDATE dead_letter SET recovered")));
});
