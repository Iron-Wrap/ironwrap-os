import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const pending: EnvelopeRecord = {
  envelope_id: "ow_33333333-3333-4333-8333-333333333333",
  source: "website",
  contact_name: "Jane Doe",
  contact_phone: "+15875551234",
  contact_email: "jane@example.com",
  job_ref: null,
  payload_json: JSON.stringify({ brand: "ironwrap", service: "metal roof" }),
  raw_key: "raw/2026-08-20/ow_333.json",
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

function frappeOnlyFetch(fetches: Array<{ url: string; init: RequestInit }>) {
  const frappeRecords = new Map<string, Record<string, unknown>>();
  let leadCreated = false;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    fetches.push({ url, init: init ?? {} });
    if (url.includes("app.jobnimbus.com")) {
      throw new Error(`jobnimbus_called_while_disabled ${url}`);
    }
    const frappeItem = parsed.pathname.match(/^\/api\/resource\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && frappeItem) {
      const key = `${decodeURIComponent(frappeItem[1]!)}:${decodeURIComponent(frappeItem[2]!)}`;
      const value = frappeRecords.get(key);
      return value ? json({ data: value }) : new Response("not found", { status: 404 });
    }
    if (url.includes("/api/resource/Lead%20Envelope?")) {
      return json({ data: leadCreated ? [{ name: "LE-0001" }] : [] });
    }
    if (url.endsWith("/api/resource/Lead%20Envelope")) {
      leadCreated = true;
      const value = { ...JSON.parse(String(init?.body)), name: "LE-0001" };
      frappeRecords.set("Lead Envelope:LE-0001", value);
      return json({ data: value });
    }
    if (url.endsWith("/api/resource/Lead%20Envelope/LE-0001") && method === "PUT") {
      const value = { ...frappeRecords.get("Lead Envelope:LE-0001"), ...JSON.parse(String(init?.body)), name: "LE-0001" };
      frappeRecords.set("Lead Envelope:LE-0001", value);
      return json({ data: value });
    }
    if (url.includes("/api/resource/Roofing%20Customer?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Roofing%20Customer")) {
      const value = { ...JSON.parse(String(init?.body)), name: "RC-0001" };
      frappeRecords.set("Roofing Customer:RC-0001", value);
      return json({ data: value });
    }
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Roof%20Job")) {
      const value = { ...JSON.parse(String(init?.body)), name: "RJ-0001" };
      frappeRecords.set("Roof Job:RJ-0001", value);
      return json({ data: value });
    }
    if (url.includes("/api/resource/Production%20Gate%20State?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const value = { ...JSON.parse(String(init?.body)), name: "gate" };
      frappeRecords.set("Production Gate State:gate", value);
      return json({ data: value });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

test("queue: JOBNIMBUS_ENABLED=false skips JN without throw, DLQ, or fake pushed", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", frappeOnlyFetch(fetches));

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const env = withTestEffectRuntime({
    JOBNIMBUS_ENABLED: "false",
    JOBNIMBUS_API_KEY: "jn-key-must-not-be-used",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    OWNER_ALERT_EMAIL: "owner@example.com",
    DB: fakeDb(pending, writes),
  });
  const { batch, counts } = queueBatch(pending.envelope_id);

  await worker.queue(batch as never, env as never, {} as never);

  const { acked, retried } = counts();
  assert.equal(acked, 1, "disabled skip must ack so the message does not retry into DLQ");
  assert.equal(retried, 0, "disabled skip must not retry");
  assert.ok(fetches.some((f) => f.url.endsWith("/api/resource/Lead%20Envelope")), "Frappe still lands");
  const leadEnvelopeWrites = fetches.filter((f) => {
    const method = String(f.init.method ?? "GET").toUpperCase();
    return (method === "PUT" || method === "POST") && f.url.includes("/api/resource/Lead%20Envelope");
  });
  assert.ok(
    leadEnvelopeWrites.some((f) => JSON.parse(String(f.init.body)).status === "jn_skipped"),
    "Lead Envelope PUT/POST must include status jn_skipped",
  );
  assert.ok(
    !leadEnvelopeWrites.some((f) => JSON.parse(String(f.init.body)).status === "pushed"),
    "skip must not stamp Frappe status pushed",
  );
  assert.equal(fetches.filter((f) => f.url.includes("app.jobnimbus.com")).length, 0);
  assert.ok(writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("jn_skipped")));
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("pushed")));
  assert.ok(!writes.some((w) => w.sql.includes("attempts = attempts + 1")));
  assert.ok(writes.some((w) =>
    w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("jn_push") &&
    w.args.includes("skip") &&
    w.args.includes("ok") &&
    w.args.includes("jobnimbus_disabled")
  ));
  const statusWrite = writes.find((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("jn_skipped"));
  assert.ok(statusWrite);
  assert.equal(statusWrite?.args.includes("jobnimbus_disabled"), true);
  assert.equal(statusWrite?.args[2], null, "jn_contact_id stays unset — no fake CRM id");
  assert.equal(statusWrite?.args[3], null, "jn_job_id stays unset — no fake CRM id");
});

test("queue: JOBNIMBUS_ENABLED=false and ERPNEXT_ENABLED=false still acks skip with no Frappe fetch", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", frappeOnlyFetch(fetches));

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const env = withTestEffectRuntime({
    JOBNIMBUS_ENABLED: "false",
    JOBNIMBUS_API_KEY: "jn-key-must-not-be-used",
    ERPNEXT_ENABLED: "false",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    OWNER_ALERT_EMAIL: "owner@example.com",
    DB: fakeDb(pending, writes),
  });
  const { batch, counts } = queueBatch(pending.envelope_id);

  await worker.queue(batch as never, env as never, {} as never);

  const { acked, retried } = counts();
  assert.equal(acked, 1, "disabled skip must ack so the message does not retry into DLQ");
  assert.equal(retried, 0, "disabled skip must not retry");
  assert.equal(fetches.length, 0, "ERPNext off means no Frappe fetch on skip");
  assert.equal(fetches.filter((f) => f.url.includes("app.jobnimbus.com")).length, 0);
  assert.ok(writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("jn_skipped")));
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("pushed")));
});

test("queue: jn_skipped re-delivery is a no-op ack, not a fake push or retry", async (t) => {
  const fetches: Array<{ url: string }> = [];
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const skipped: EnvelopeRecord = { ...pending, status: "jn_skipped", last_error: "jobnimbus_disabled" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push({ url: String(input) });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const env = withTestEffectRuntime({
    JOBNIMBUS_ENABLED: "false",
    JOBNIMBUS_API_KEY: "jn-key-must-not-be-used",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    DB: fakeDb(skipped, writes),
  });
  const { batch, counts } = queueBatch(skipped.envelope_id);
  await worker.queue(batch as never, env as never, {} as never);
  const { acked, retried } = counts();
  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.equal(fetches.length, 0);
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE envelopes SET status")));
  assert.ok(writes.some((w) => w.sql.includes("UPDATE dead_letter SET recovered")));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
