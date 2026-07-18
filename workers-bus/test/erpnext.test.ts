import { test } from "node:test";
import assert from "node:assert/strict";
import { pushToErpNext, syncLeadTransportToErpNext } from "../src/erpnext.ts";
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

test("pushToErpNext: creates Lead Envelope, Roofing Customer, Property, and Roof Job", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-0001" } });
    if (url.endsWith("/api/resource/Roofing%20Customer")) return json({ data: { name: "RC-0001" } });
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
  assert.equal(calls.length, 22);
  assert.match(calls[0].url, /^https:\/\/erp\.example\.com\/api\/resource\/Lead%20Envelope\?/);
  assert.equal(calls[0].init.headers?.["authorization" as never], "token key:secret");
  const leadBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Lead%20Envelope"))?.init.body));
  assert.equal(leadBody.envelope_id, rec.envelope_id);
  assert.equal(leadBody.triage_status, "Untriaged");
  assert.equal(leadBody.jobnimbus_contact_id, "C-1");
  assert.equal(leadBody.jobnimbus_job_id, "J-1");

  const customerBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/resource/Roofing%20Customer"))?.init.body));
  assert.equal(customerBody.customer_id, "customer:email:jane_example.com");
  assert.equal(customerBody.display_name, "Jane Doe");
  assert.equal(customerBody.first_name, "Jane");
  assert.equal(customerBody.last_name, "Doe");
  assert.equal(customerBody.phone, "+15875551234");
  assert.equal(customerBody.email, "jane@example.com");
  assert.equal(customerBody.lead_envelope, "LE-0001");

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
  assert.equal(jobBody.customer, "RC-0001");
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

test("pushToErpNext: retry never resets existing human-owned operational records", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Lead%20Envelope?")) return json({ data: [{ name: "LE-TRIAGED" }] });
    if (url.endsWith("/api/resource/Lead%20Envelope/LE-TRIAGED")) return json({ data: { name: "LE-TRIAGED" } });
    if (url.includes("/api/resource/Roofing%20Customer?")) return json({ data: [{ name: "RC-TRIAGED" }] });
    if (url.includes("/api/resource/Roofing%20Property?")) return json({ data: [{ name: "RP-TRIAGED" }] });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-TRIAGED" }] });
    if (url.endsWith("/api/resource/Roof%20Job/RJ-TRIAGED")) return json({ data: { name: "RJ-TRIAGED", customer: "RC-HUMAN" } });
    if (url.includes("/api/resource/Production%20Gate%20State?")) return json({ data: [{ name: "gate" }] });
    throw new Error(`unexpected fetch ${url}`);
  });

  await pushToErpNext({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  } as never, { ...rec, status: "pushed", jn_contact_id: "C-2", jn_job_id: "J-2" });

  const leadUpdate = calls.find((call) => call.url.endsWith("/api/resource/Lead%20Envelope/LE-TRIAGED"));
  assert.ok(leadUpdate);
  const body = JSON.parse(String(leadUpdate.init.body));
  assert.equal(body.status, "pushed");
  for (const forbidden of ["triage_status", "triaged_by", "triaged_at", "triage_summary"]) {
    assert.equal(Object.hasOwn(body, forbidden), false, `${forbidden} must remain human-owned`);
  }
  const protectedDoctypes = ["Roofing%20Customer", "Roofing%20Property", "Roof%20Job", "Production%20Gate%20State"];
  assert.equal(
    calls.some((call) => call.init.method !== "GET" && protectedDoctypes.some((doctype) => call.url.endsWith(`/api/resource/${doctype}`) ||
      call.url.includes(`/api/resource/${doctype}/`))),
    false,
    "retry must not overwrite property, job, or gate business state",
  );
});

test("pushToErpNext: fills an old unlinked job customer without replacing an existing assignment", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Lead%20Envelope?")) return json({ data: [{ name: "LE-OLD" }] });
    if (url.endsWith("/api/resource/Lead%20Envelope/LE-OLD")) return json({ data: { name: "LE-OLD" } });
    if (url.includes("/api/resource/Roofing%20Customer?")) return json({ data: [{ name: "RC-OLD" }] });
    if (url.includes("/api/resource/Roofing%20Property?")) return json({ data: [{ name: "RP-OLD" }] });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-OLD" }] });
    if (url.endsWith("/api/resource/Roof%20Job/RJ-OLD") && init?.method === "GET") {
      return json({ data: { name: "RJ-OLD", customer: null } });
    }
    if (url.endsWith("/api/resource/Roof%20Job/RJ-OLD") && init?.method === "PUT") {
      return json({ data: { name: "RJ-OLD", customer: "RC-OLD" } });
    }
    if (url.includes("/api/resource/Production%20Gate%20State?")) return json({ data: [{ name: "gate" }] });
    throw new Error(`unexpected fetch ${url}`);
  });

  await pushToErpNext({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  } as never, rec);

  const customerLink = calls.find((call) =>
    call.url.endsWith("/api/resource/Roof%20Job/RJ-OLD") && call.init.method === "PUT",
  );
  assert.ok(customerLink);
  assert.deepEqual(JSON.parse(String(customerLink.init.body)), { customer: "RC-OLD" });
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/resource/Roof%20Job") && call.init.method === "POST"),
    false,
  );
});

test("syncLeadTransportToErpNext: mirrors only bridge identifiers into the existing job", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Lead%20Envelope?")) return json({ data: [{ name: "LE-1" }] });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-1" }] });
    if (url.endsWith("/api/resource/Lead%20Envelope/LE-1")) return json({ data: { name: "LE-1" } });
    if (url.endsWith("/api/resource/Roof%20Job/RJ-1")) return json({ data: { name: "RJ-1" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const result = await syncLeadTransportToErpNext({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  } as never, { ...rec, status: "pushed" }, { contactId: "C-9", jobId: "J-9", jobNumber: "26-0009", reused: false });

  assert.deepEqual(result, { name: "LE-1", roofJobName: "RJ-1" });
  const leadBody = JSON.parse(String(calls.find((call) => call.url.endsWith("/api/resource/Lead%20Envelope/LE-1"))?.init.body));
  const jobBody = JSON.parse(String(calls.find((call) => call.url.endsWith("/api/resource/Roof%20Job/RJ-1"))?.init.body));
  assert.deepEqual(jobBody, {
    job_number: "26-0009", jobnimbus_contact_id: "C-9", jobnimbus_job_id: "J-9",
  });
  for (const forbidden of ["triage_status", "triaged_by", "triaged_at", "triage_summary"]) {
    assert.equal(Object.hasOwn(leadBody, forbidden), false, `${forbidden} must remain human-owned`);
  }
});

test("pushToErpNext: captures instant estimate sessions as review-gated ERPNext rows", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-0002" } });
    if (url.endsWith("/api/resource/Roofing%20Customer")) return json({ data: { name: "RC-0002" } });
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

test("pushToErpNext: mirrors explicit public-estimator follow-up consent with raw R2 evidence", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const rawBody = JSON.stringify({ original: "public estimator submission" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-PUBLIC-1" } });
    if (url.endsWith("/api/resource/Roofing%20Customer")) return json({ data: { name: "RC-PUBLIC-1" } });
    if (url.endsWith("/api/resource/Roofing%20Property")) return json({ data: { name: "RP-PUBLIC-1" } });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-PUBLIC-1" } });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.gate_id } });
    }
    if (url.endsWith("/api/resource/Instant%20Estimate%20Session")) return json({ data: { name: "IES-PUBLIC-1" } });
    if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EVI-PUBLIC-CONSENT-1" } });
    if (url.endsWith("/api/resource/Communication%20Consent")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: `CC-${body.channel}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const publicRec: EnvelopeRecord = {
    ...rec,
    envelope_id: "ow_33333333-3333-4333-8333-333333333333",
    raw_key: "raw/estimates/2026-07-18/ow_33333333-3333-4333-8333-333333333333.json",
    payload_json: JSON.stringify({
      address: "1 Main St",
      service: "metal roof",
      instant_estimate: true,
      estimate_low: 10000,
      estimate_high: 20000,
      source_detail: "ironwrap_public_estimator",
      public_estimator: {
        jurisdiction: "Alberta, Canada",
        consent: {
          contact: true,
          privacy: true,
          recorded_at: "2026-07-18T11:00:00.000Z",
          origin: "https://ironwrapexteriors.com",
        },
      },
    }),
  };

  await pushToErpNext({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_INTEGRATION_USER: "worker@ironwrapexteriors.com",
    RAW: {
      get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(rawBody).buffer }),
    },
  } as never, publicRec);

  const evidence = JSON.parse(String(calls.find((call) => call.url.endsWith("/api/resource/Evidence%20Item"))?.init.body));
  assert.equal(evidence.evidence_id, `evidence:public-estimate-consent:${publicRec.envelope_id}`);
  assert.equal(evidence.roof_job, "RJ-PUBLIC-1");
  assert.equal(evidence.lead_envelope, "LE-PUBLIC-1");
  assert.equal(evidence.proof_slot, "Communication");
  assert.equal(evidence.r2_key, publicRec.raw_key);
  assert.equal(evidence.sync_state, "Uploaded", "raw storage is not falsely promoted to verified evidence");
  assert.equal(evidence.content_length, new TextEncoder().encode(rawBody).byteLength);
  assert.match(evidence.content_checksum, /^[0-9a-f]{64}$/);

  const consents = calls
    .filter((call) => call.url.endsWith("/api/resource/Communication%20Consent"))
    .map((call) => JSON.parse(String(call.init.body)));
  assert.equal(consents.length, 2);
  assert.deepEqual(consents.map((consent) => consent.channel).sort(), ["Email", "Phone"]);
  assert.ok(consents.every((consent) => consent.status === "Granted"));
  assert.ok(consents.every((consent) => consent.purpose === "Estimate Follow-up"));
  assert.ok(consents.every((consent) => consent.consent_basis === "Express"));
  assert.ok(consents.every((consent) => consent.captured_by === "worker@ironwrapexteriors.com"));
  assert.ok(consents.every((consent) => consent.proof_evidence === "EVI-PUBLIC-CONSENT-1"));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
