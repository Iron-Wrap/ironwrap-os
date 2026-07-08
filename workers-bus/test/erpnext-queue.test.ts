import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { EnvelopeRecord } from "../src/core.ts";

const rec: EnvelopeRecord = {
  envelope_id: "ow_22222222-2222-4222-8222-222222222222",
  source: "website",
  contact_name: "Jane Doe",
  contact_phone: "+15875551234",
  contact_email: "jane@example.com",
  job_ref: null,
  payload_json: JSON.stringify({ brand: "ironwrap", service: "metal roof" }),
  raw_key: "raw/2026-07-08/ow_222.json",
  ts: "2026-07-08T10:00:00.000Z",
  status: "pending_jn_push",
  dedup_key: "p:+15875551234",
  dup_of: null,
  attempts: 0,
  last_error: null,
  jn_contact_id: null,
  jn_job_id: null,
  intent_queue: "residential_sales",
  created_at: "2026-07-08T10:00:00.000Z",
  updated_at: "2026-07-08T10:00:00.000Z",
};

test("queue: JobNimbus success then ERPNext Lead Envelope sync marks envelope pushed", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("app.jobnimbus.com/api1") && (init?.method ?? "GET") === "GET") return json({ results: [] });
    if (url.endsWith("/contacts")) return json({ jnid: "C-1" });
    if (url.endsWith("/jobs")) return json({ jnid: "J-1", number: "26-0001" });
    if (url.includes("/api/resource/Lead%20Envelope?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-0001" } });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-0001" } });
    if (url.includes("/api/resource/Production%20Gate%20State?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) return json({ data: { name: "gate" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "jn-key",
    JN_CONTACT_RECORD_TYPE: "Customer",
    JN_CONTACT_STATUS: "New",
    JN_JOB_RECORD_TYPE: "Retail",
    JN_JOB_STATUS: "Lead",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    OWNER_ALERT_EMAIL: "owner@example.com",
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("SELECT * FROM envelopes")) return rec;
                if (sql.includes("SELECT attempts FROM envelopes")) return { attempts: 1 };
                return null;
              },
              run: async () => { writes.push({ sql, args }); return { success: true }; },
              all: async () => ({ results: [] }),
            };
          },
        };
      },
    },
  };
  let acked = 0, retried = 0;
  const batch = {
    queue: "ironwrap-jn-push",
    messages: [{
      body: { envelope_id: rec.envelope_id },
      ack: () => { acked += 1; },
      retry: () => { retried += 1; },
    }],
  };

  await worker.queue(batch as never, env as never, {} as never);

  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.ok(fetches.some((f) => f.url.endsWith("/api/resource/Lead%20Envelope")));
  assert.ok(fetches.some((f) => f.url.endsWith("/api/resource/Roof%20Job")));
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/resource/Production%20Gate%20State")).length, 7);
  assert.ok(writes.some((w) => w.sql.includes("erpnext_roof_job_id") && w.args.includes("LE-0001") && w.args.includes("RJ-0001")));
  assert.ok(writes.some((w) => w.sql.includes("UPDATE envelopes SET status") && w.args.includes("pushed")));
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") && w.args.includes("erpnext_push")));
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") && w.args.includes("lead_envelope:LE-0001,roof_job:RJ-0001,production_gates:7")));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
