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

test("pushToErpNext: creates Lead Envelope, Roofing Property, and Roof Job", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-0001" } });
    if (url.endsWith("/api/resource/Roofing%20Property")) return json({ data: { name: "RP-0001" } });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-0001" } });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.gate_id } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const result = await pushToErpNext({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  } as never, rec, { contactId: "C-1", jobId: "J-1", reused: false });

  assert.deepEqual(result, {
    name: "LE-0001",
    reused: false,
    roofingPropertyName: "RP-0001",
    roofJobName: "RJ-0001",
    productionGateCount: 7,
  });
  assert.equal(calls.length, 20);
  assert.match(calls[0].url, /^https:\/\/erp\.example\.com\/api\/resource\/Lead%20Envelope\?/);
  assert.equal(calls[0].init.headers?.["authorization" as never], "token key:secret");
  const leadBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Lead%20Envelope"))?.init.body));
  assert.equal(leadBody.envelope_id, rec.envelope_id);
  assert.equal(leadBody.jobnimbus_contact_id, "C-1");
  assert.equal(leadBody.jobnimbus_job_id, "J-1");

  const propertyBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Roofing%20Property"))?.init.body));
  assert.equal(propertyBody.property_key, "property:1 main st");
  assert.equal(propertyBody.lead_envelope, "LE-0001");
  assert.equal(propertyBody.address_line1, "1 Main St");
  assert.equal(propertyBody.country, "Canada");

  const jobBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Roof%20Job"))?.init.body));
  assert.equal(jobBody.roof_job_id, `job:${rec.envelope_id}`);
  assert.equal(jobBody.service_type, "Metal Roofing");
  assert.equal(jobBody.job_status, "Qualified");
  assert.equal(jobBody.lead_envelope, "LE-0001");
  assert.equal(jobBody.roofing_property, "RP-0001");
  assert.equal(jobBody.current_gate_state, "qualification");
  assert.equal(jobBody.jobnimbus_contact_id, "C-1");
  assert.equal(jobBody.jobnimbus_job_id, "J-1");

  const gateBodies = calls
    .filter((c) => c.url.endsWith("/api/resource/Production%20Gate%20State"))
    .map((c) => JSON.parse(String(c.init.body)));
  assert.deepEqual(gateBodies.map((g) => g.gate), ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"]);
  assert.ok(gateBodies.every((g) => g.roof_job === "RJ-0001" && g.state === "Blocked"));
  assert.ok(gateBodies.every((g) => typeof g.blocker_reason === "string" && g.blocker_reason.length > 0));
});

test("pushToErpNext: captures instant estimate sessions as review-gated ERPNext rows", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-0002" } });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-0002" } });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.gate_id } });
    }
    if (url.endsWith("/api/resource/Instant%20Estimate%20Session")) return json({ data: { name: "IES-0001" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const instantRec = {
    ...rec,
    envelope_id: "ow_22222222-2222-4222-8222-222222222222",
    payload_json: JSON.stringify({
      service: "metal roof",
      instant_estimate: true,
      estimate_low: "$12,000",
      estimate_high: "18000",
      estimate_confidence: "low",
    }),
  };

  const result = await pushToErpNext({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  } as never, instantRec);

  assert.equal(result?.instantEstimateSessionName, "IES-0001");
  const estimate = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Instant%20Estimate%20Session"))?.init.body));
  assert.equal(estimate.estimate_session_id, `estimate:${instantRec.envelope_id}`);
  assert.equal(estimate.lead_envelope, "LE-0002");
  assert.equal(estimate.roof_job, "RJ-0002");
  assert.equal(estimate.service_type, "Metal Roofing");
  assert.equal(estimate.status, "Needs Review");
  assert.equal(estimate.range_low, 12000);
  assert.equal(estimate.range_high, 18000);
  assert.equal(estimate.review_required, 1);
  assert.match(estimate.assumptions, /estimator review/);
  assert.match(estimate.exclusions, /Not a final quote/);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
