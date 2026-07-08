import { test } from "node:test";
import assert from "node:assert/strict";
import { pushToErpNext } from "../src/erpnext.ts";
import type { EnvelopeRecord } from "../src/core.ts";

const rec: EnvelopeRecord = {
  envelope_id: "ow_11111111-1111-4111-8111-111111111111",
  source: "website",
  contact_name: "Jane Doe",
  contact_phone: "+15875551234",
  contact_email: "jane@example.com",
  job_ref: null,
  payload_json: JSON.stringify({ address: "1 Main St", service: "metal roof" }),
  raw_key: "raw/2026-07-08/ow_111.json",
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

test("pushToErpNext: disabled flag is a no-op", async () => {
  assert.equal(await pushToErpNext({ ERPNEXT_ENABLED: "false" } as never, rec), null);
});

test("pushToErpNext: creates Lead Envelope with token auth and JobNimbus refs", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    return json({ data: { name: "LE-0001" } });
  });

  const result = await pushToErpNext({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  } as never, rec, { contactId: "C-1", jobId: "J-1", reused: false });

  assert.deepEqual(result, { name: "LE-0001", reused: false });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/erp\.example\.com\/api\/resource\/Lead%20Envelope\?/);
  assert.equal(calls[0].init.headers?.["authorization" as never], "token key:secret");
  assert.equal(calls[1].url, "https://erp.example.com/api/resource/Lead%20Envelope");
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.envelope_id, rec.envelope_id);
  assert.equal(body.jobnimbus_contact_id, "C-1");
  assert.equal(body.jobnimbus_job_id, "J-1");
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
