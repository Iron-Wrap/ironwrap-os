import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushNewoSessionToErpNext,
  pushToErpNext,
  syncLeadTransportToErpNext,
} from "../src/erpnext.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import type { NewoSessionRecord } from "../src/newo-store.ts";
import { withErpReadback, withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const effectEnv = (values: Record<string, unknown>) => withTestEffectRuntime(values) as never;

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

test("pushToErpNext: enabled without tokens throws erpnext_no_token (no dummy credentials)", async () => {
  await assert.rejects(
    () => pushToErpNext({ ERPNEXT_ENABLED: "true" } as never, rec),
    (err: unknown) => err instanceof Error && err.message === "erpnext_no_token",
  );
});

test("pushToErpNext: creates Lead Envelope, Roofing Customer, Property, and Roof Job", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

  const testEnv = effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  });
  const result = await pushToErpNext(testEnv, rec, { contactId: "C-1", jobId: "J-1", reused: false });
  const mutationsAfterFirstCall = calls.filter((call) => ["POST", "PUT"].includes(call.init.method ?? "GET")).length;
  const replay = await pushToErpNext(testEnv, rec, { contactId: "C-1", jobId: "J-1", reused: false });

  assert.deepEqual(result, {
    name: "LE-0001",
    reused: false,
    roofingPropertyName: "RP-0001",
    roofJobName: "RJ-0001",
    productionGateCount: 7,
  });
  assert.deepEqual(replay, result);
  assert.equal(
    calls.filter((call) => ["POST", "PUT"].includes(call.init.method ?? "GET")).length,
    mutationsAfterFirstCall,
    "generic Frappe exact replay must reconstruct results from provider GETs without another mutation",
  );
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
  // Anchored to the envelope, not to the wall clock: this is what keeps the effect-runtime
  // idempotency key - a hash of the request body - stable across retries. See the boundary
  // test below for the failure this prevents.
  assert.ok(gateBodies.every((g) => g.assigned_at === "2026-07-08 10:00:00"));
  assert.ok(gateBodies.every((g) => g.due_at === "2026-07-11 10:00:00"));
});

test("pushToErpNext: gate replay stays exact across a wall-clock second boundary", async (t) => {
  // The shipped bug this pins: `ensureInitialProductionGates` stamped `new Date()` into every
  // gate body, `toFrappeDatetime` truncated it to whole seconds, and `erpFetch` keys each
  // effect's idempotency on a hash of that body. Two pushes landing in different seconds
  // therefore hashed differently, so the effect runtime dispatched a second POST per gate
  // instead of replaying - 18 mutations where the first pass made 11. It reproduced only when
  // the clock happened to tick between the calls, which is why CI failed and local runs did
  // not; forcing the tick makes it deterministic in both.
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

  const testEnv = effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com/",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  });
  const mutations = () => calls.filter((c) => ["POST", "PUT"].includes(c.init.method ?? "GET")).length;

  const first = await pushToErpNext(testEnv, rec, { contactId: "C-1", jobId: "J-1", reused: false });
  const mutationsAfterFirstCall = mutations();
  await new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20));
  const replay = await pushToErpNext(testEnv, rec, { contactId: "C-1", jobId: "J-1", reused: false });

  assert.deepEqual(replay, first);
  assert.equal(
    mutations(),
    mutationsAfterFirstCall,
    "a replay in a later second must still reconstruct from provider GETs without another mutation",
  );
});

test("pushToErpNext: retry never resets existing human-owned operational records", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

  await pushToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  }), { ...rec, status: "pushed", jn_contact_id: "C-2", jn_job_id: "J-2" });

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
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

  await pushToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  }), rec);

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
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Lead%20Envelope?")) return json({ data: [{ name: "LE-1" }] });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-1" }] });
    if (url.endsWith("/api/resource/Lead%20Envelope/LE-1")) return json({ data: { name: "LE-1" } });
    if (url.endsWith("/api/resource/Roof%20Job/RJ-1")) return json({ data: { name: "RJ-1" } });
    throw new Error(`unexpected fetch ${url}`);
  }));

  const result = await syncLeadTransportToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret",
  }), { ...rec, status: "pushed" }, { contactId: "C-9", jobId: "J-9", jobNumber: "26-0009", reused: false });

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

test("generic Frappe exact replay rejects a wrong material provider field without another write", async (t) => {
  const records = new Map<string, Record<string, unknown>>([
    ["Lead Envelope:LE-1", { name: "LE-1" }],
    ["Roof Job:RJ-1", { name: "RJ-1" }],
  ]);
  let mutations = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/resource/Lead%20Envelope" && url.search) {
        return json({ data: [{ name: "LE-1" }] });
      }
      if (url.pathname === "/api/resource/Roof%20Job" && url.search) {
        return json({ data: [{ name: "RJ-1" }] });
      }
      const resource = url.pathname.match(
        /^\/api\/resource\/([^/]+)\/([^/]+)$/,
      );
      if (resource) {
        const key = `${decodeURIComponent(resource[1]!)}:${decodeURIComponent(resource[2]!)}`;
        if (method === "GET") return json({ data: records.get(key) });
        if (method === "PUT") {
          mutations += 1;
          const value = {
            ...records.get(key),
            ...JSON.parse(String(init?.body)),
            name: decodeURIComponent(resource[2]!),
          };
          records.set(key, value);
          return json({ data: value });
        }
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
  );
  const testEnv = effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  });
  const transport = {
    contactId: "C-9",
    jobId: "J-9",
    jobNumber: "26-0009",
    reused: false,
  };

  await syncLeadTransportToErpNext(
    testEnv,
    { ...rec, status: "pushed" },
    transport,
  );
  assert.equal(mutations, 2);
  records.set("Lead Envelope:LE-1", {
    ...records.get("Lead Envelope:LE-1"),
    jobnimbus_job_id: "provider-drift",
  });

  await assert.rejects(
    syncLeadTransportToErpNext(
      testEnv,
      { ...rec, status: "pushed" },
      transport,
    ),
    /erpnext_readback_conflict/,
  );
  assert.equal(
    mutations,
    2,
    "a conflicted exact replay must not issue a second provider mutation",
  );
});

test("pushToErpNext: captures instant estimate sessions as review-gated ERPNext rows", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

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

  const result = await pushToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  }), instantRec);

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
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
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
  }));

  const publicRec: EnvelopeRecord = {
    ...rec,
    envelope_id: "ow_33333333-3333-4333-8333-333333333333",
    raw_key: "raw/estimates/2026-07-18/ow_33333333-3333-4333-8333-333333333333.json",
    payload_json: JSON.stringify({
      address: "1 Main St",
      service: "metal roof",
      instant_estimate: true,
      estimate_type: "review_intake",
      selected_services: ["metal_roofing"],
      assumptions: "Measurement and estimator review required before pricing.",
      exclusions: "Not a final quote, contract, material order, or payment request.",
      source_detail: "ironwrap_public_estimator",
      public_estimator: {
        version: 2,
        pricing_state: "measurement_required",
        range: null,
        review_required: true,
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

  await pushToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ERPNEXT_INTEGRATION_USER: "worker@ironwrapexteriors.com",
    RAW: {
      get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(rawBody).buffer }),
    },
  }), publicRec);

  const estimate = JSON.parse(String(calls.find((call) =>
    call.url.endsWith("/api/resource/Instant%20Estimate%20Session")
  )?.init.body));
  assert.equal(estimate.status, "Captured");
  assert.equal(estimate.review_required, 1);
  assert.equal(Object.hasOwn(estimate, "range_low"), false);
  assert.equal(Object.hasOwn(estimate, "range_high"), false);
  assert.equal(Object.hasOwn(estimate, "estimate_total"), false);
  assert.deepEqual(JSON.parse(estimate.selected_services_json), ["metal_roofing"]);

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

test("pushNewoSessionToErpNext keeps appointment review state human-owned on retries", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Reception%20Session?")) {
      return json({ data: [{ name: "RS-session-001" }] });
    }
    if (url.endsWith("/api/resource/Reception%20Session/RS-session-001")) {
      return json({ data: { name: "RS-session-001" } });
    }
    if (url.includes("/api/resource/Appointment%20Request?")) {
      return json({ data: [{ name: "AR-request-001" }] });
    }
    if (url.endsWith("/api/resource/Appointment%20Request/AR-request-001")) {
      return json({ data: { name: "AR-request-001" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  const session: NewoSessionRecord = {
    session_id: "session-001",
    project_id: "project-001",
    agent_id: "agent-001",
    user_actor_id: "actor-001",
    conversation_id: "conversation-001",
    channel: "phone",
    direction: "inbound",
    status: "appointment_requested",
    outcome: "lead_captured",
    contact_name: "Newo Caller",
    contact_phone: "+15875557788",
    contact_email: "caller@example.com",
    address_line1: "123 Main Street",
    city: "Edmonton",
    province: "AB",
    postal_code: "T5J 0N3",
    division: "residential",
    service: "Metal roof quote",
    urgency: "routine",
    lead_envelope_id: rec.envelope_id,
    appointment_request_id: "request-001",
    handoff_status: null,
    booking_status: "requested",
    summary: "Appointment request received.",
    transcript_ref: "newo:transcript:session-001",
    recording_ref: null,
    ai_disclosed: 1,
    recording_disclosed: 0,
    structured_json: JSON.stringify({
      appointment: {
        preferred_windows: [{ start: "2026-07-21T16:00:00.000Z", end: null }],
        timezone: "America/Edmonton",
      },
    }),
    raw_key: "raw/newo/events/2026-07-18/event-001.json",
    payload_hash: "a".repeat(64),
    started_at: "2026-07-18T18:00:00.000Z",
    ended_at: null,
    duration_seconds: null,
    report_expected_at: "2026-07-18T18:31:00.000Z",
    report_received_at: null,
    report_event_id: null,
    missing_report_detected_at: null,
    sync_status: "pending",
    sync_attempts: 0,
    last_error: null,
    sync_updated_at: "2026-07-18T18:01:00.000Z",
    created_at: "2026-07-18T18:00:00.000Z",
    updated_at: "2026-07-18T18:01:00.000Z",
  };

  const result = await pushNewoSessionToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    NEWO_BOOKING_MODE: "request_only",
  }), session, { leadEnvelopeName: "LE-0001", roofJobName: "RJ-0001" });

  assert.deepEqual(result, {
    receptionSessionName: "RS-session-001",
    appointmentRequestName: "AR-request-001",
  });
  const appointmentUpdate = calls.find((call) =>
    call.url.endsWith("/api/resource/Appointment%20Request/AR-request-001"),
  );
  assert.ok(appointmentUpdate);
  const body = JSON.parse(String(appointmentUpdate.init.body));
  assert.equal(body.provider_status, "requested");
  assert.deepEqual(JSON.parse(body.preferred_windows_json), [
    { start: "2026-07-21T16:00:00.000Z", end: null },
  ]);
  for (const humanOwned of [
    "request_status", "booking_mode", "reviewed_by", "reviewed_at", "review_notes",
    "decision_by", "decision_at", "decision_notes", "confirmed_external_id",
  ]) {
    assert.equal(Object.hasOwn(body, humanOwned), false, `${humanOwned} must remain human-owned`);
  }
});

test("pushNewoSessionToErpNext creates one owned urgent-callback incident for a failed handoff", async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Reception%20Session?")) {
      return json({ data: [{ name: "RS-session-failed" }] });
    }
    if (url.endsWith("/api/resource/Reception%20Session/RS-session-failed")) {
      return json({ data: { name: "RS-session-failed" } });
    }
    if (url.includes("/api/resource/Automation%20Incident?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Automation%20Incident")) {
      return json({ data: { name: "incident:newo-callback:session-failed" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  const session: NewoSessionRecord = {
    session_id: "session-failed",
    project_id: "project-001",
    agent_id: "agent-001",
    user_actor_id: "actor-001",
    conversation_id: "conversation-failed",
    channel: "phone",
    direction: "inbound",
    status: "session_failed",
    outcome: "handoff_failed",
    contact_name: "Callback Caller",
    contact_phone: "+15875557799",
    contact_email: null,
    address_line1: "456 Main Street",
    city: "Edmonton",
    province: "AB",
    postal_code: "T5J 0N4",
    division: "residential",
    service: "Emergency leak",
    urgency: "emergency",
    lead_envelope_id: rec.envelope_id,
    appointment_request_id: null,
    handoff_status: "failed",
    booking_status: null,
    summary: "Owner transfer failed; urgent callback required.",
    transcript_ref: "newo:transcript:session-failed",
    recording_ref: "newo:recording:session-failed",
    ai_disclosed: 1,
    recording_disclosed: 1,
    structured_json: JSON.stringify({ handoff: { reason: "Active leak" } }),
    raw_key: "raw/newo/events/2026-07-18/event-failed.json",
    payload_hash: "b".repeat(64),
    started_at: "2026-07-18T19:00:00.000Z",
    ended_at: "2026-07-18T19:02:00.000Z",
    duration_seconds: 120,
    report_expected_at: null,
    report_received_at: "2026-07-18T19:02:00.000Z",
    report_event_id: "event-failed",
    missing_report_detected_at: null,
    sync_status: "pending",
    sync_attempts: 1,
    last_error: null,
    sync_updated_at: "2026-07-18T19:02:30.000Z",
    created_at: "2026-07-18T19:00:00.000Z",
    updated_at: "2026-07-18T19:02:00.000Z",
  };

  const result = await pushNewoSessionToErpNext(effectEnv({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    NEWO_CALLBACK_OWNER_USER: "owner@example.com",
  }), session, { leadEnvelopeName: "LE-0001", roofJobName: "RJ-0001" });

  assert.deepEqual(result, {
    receptionSessionName: "RS-session-failed",
    automationIncidentName: "incident:newo-callback:session-failed",
  });
  const incident = JSON.parse(String(calls.find((call) =>
    call.url.endsWith("/api/resource/Automation%20Incident") && call.init.method === "POST"
  )?.init.body));
  assert.equal(incident.incident_id, "incident:newo-callback:session-failed");
  assert.equal(incident.status, "Open");
  assert.equal(incident.severity, "Critical");
  assert.equal(incident.assigned_to, "owner@example.com");
  assert.equal(incident.record_ref, "Reception Session:RS-session-failed");
  assert.equal(incident.correlation_id, "session-failed");
  assert.equal(incident.lead_envelope, "LE-0001");
  assert.equal(incident.roof_job, "RJ-0001");
  assert.equal(JSON.stringify(incident).includes("transcript"), false);
  assert.equal(JSON.stringify(incident).includes("recording"), false);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
