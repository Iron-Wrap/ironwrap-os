import assert from "node:assert/strict";
import { test } from "node:test";

import type { EnvelopeRecord } from "../src/core.ts";
import { pushToJobNimbus } from "../src/jobnimbus.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const record: EnvelopeRecord = {
  envelope_id: "ow_38383838-3838-4838-8838-383838383838",
  source: "website",
  contact_name: "Ada Example",
  contact_phone: "+15875550101",
  contact_email: "ada@example.invalid",
  job_ref: null,
  payload_json: JSON.stringify({
    address: "100 Synthetic Way",
    city: "Calgary",
    province: "AB",
    postal_code: "T1T 1T1",
    country: "Canada",
  }),
  raw_key: "raw/synthetic/jobnimbus-runtime.json",
  ts: "2026-08-17T12:00:00.000Z",
  status: "pending_jn_push",
  dedup_key: "synthetic-jobnimbus-runtime",
  dup_of: null,
  attempts: 0,
  last_error: null,
  jn_contact_id: null,
  jn_job_id: null,
  intent_queue: "human_qualification",
  created_at: "2026-08-17T12:00:00.000Z",
  updated_at: "2026-08-17T12:00:00.000Z",
};

function env() {
  return withTestEffectRuntime({
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "synthetic-key",
    JN_CONTACT_RECORD_TYPE: "Customer",
    JN_CONTACT_STATUS: "New",
  }) as never;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function searchTerms(url: URL): Array<{ field: string; value: unknown }> {
  const encoded = url.searchParams.get("filter");
  if (!encoded) return [];
  const filter = JSON.parse(encoded) as {
    must?: Array<{ term?: Record<string, unknown> }>;
  };
  return (filter.must ?? []).flatMap(({ term }) =>
    Object.entries(term ?? {}).map(([field, value]) => ({ field, value })),
  );
}

test("JobNimbus exact replay rehydrates the provider result without a second mutation", async (t) => {
  const runtime = env();
  let mutations = 0;
  let stored: Record<string, unknown> | null = null;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts")
        return json({ results: [] });
      if (method === "POST" && url.pathname === "/api1/contacts") {
        mutations += 1;
        stored = { ...JSON.parse(String(init?.body)), jnid: "contact-exact-1" };
        return json(stored);
      }
      if (method === "GET" && url.pathname === "/api1/contacts/contact-exact-1")
        return json(stored);
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  const first = await pushToJobNimbus(runtime, record);
  const replay = await pushToJobNimbus(runtime, record);
  assert.equal(first.contactId, "contact-exact-1");
  assert.equal(replay.contactId, "contact-exact-1");
  assert.equal(mutations, 1);
});

test("JobNimbus rejects a material provider readback drift", async (t) => {
  const runtime = env();
  let stored: Record<string, unknown> | null = null;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts")
        return json({ results: [] });
      if (method === "POST" && url.pathname === "/api1/contacts") {
        stored = { ...JSON.parse(String(init?.body)), jnid: "contact-drift-1" };
        return json(stored);
      }
      if (
        method === "GET" &&
        url.pathname === "/api1/contacts/contact-drift-1"
      ) {
        return json({ ...stored, status_name: "Wrong status" });
      }
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  await assert.rejects(
    () => pushToJobNimbus(runtime, record),
    /jobnimbus_readback_conflict/,
  );
  const effect = await runtime.DB.prepare(
    "SELECT state, result_code FROM external_effects WHERE provider = 'jobnimbus'",
  )
    .bind()
    .first<{ state: string; result_code: string }>();
  assert.equal(effect?.state, "manual_exception");
  assert.equal(effect?.result_code, "jobnimbus_readback_conflict");
});

test("JobNimbus duplicate 400 reconciles only one exact material identity through the effect ledger", async (t) => {
  const runtime = env();
  let mutations = 0;
  let stored: Record<string, unknown> | null = null;
  let identitySearches = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts") {
        const terms = searchTerms(url);
        if (terms.length === 1) return json({ results: [] });
        identitySearches += 1;
        assert.deepEqual(
          terms,
          [
            { field: "external_id", value: record.envelope_id },
            { field: "email", value: "ada@example.invalid" },
            { field: "mobile_phone", value: "+15875550101" },
            { field: "tags", value: `bus:${record.envelope_id}` },
            { field: "tags", value: "source:website" },
          ],
        );
        return json({ results: [{ jnid: "contact-existing-1" }] });
      }
      if (method === "POST" && url.pathname === "/api1/contacts") {
        mutations += 1;
        stored = {
          ...JSON.parse(String(init?.body)),
          jnid: "contact-existing-1",
        };
        return new Response("Duplicate contact exists", { status: 400 });
      }
      if (
        method === "GET" &&
        url.pathname === "/api1/contacts/contact-existing-1"
      ) {
        return json(stored);
      }
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  const first = await pushToJobNimbus(runtime, record);
  const replay = await pushToJobNimbus(runtime, record);
  assert.equal(first.contactId, "contact-existing-1");
  assert.equal(first.reused, true);
  assert.deepEqual(replay, first);
  assert.equal(mutations, 1);
  assert.equal(identitySearches, 1);
  const effect = await runtime.DB.prepare(
    "SELECT state, result_code, provider_external_id FROM external_effects WHERE provider = 'jobnimbus'",
  )
    .bind()
    .first<{
      state: string;
      result_code: string | null;
      provider_external_id: string;
    }>();
  assert.equal(effect?.state, "succeeded");
  assert.equal(effect?.result_code, null);
  assert.equal(effect?.provider_external_id, "contact-existing-1");
});

test("JobNimbus duplicate 400 with zero stable matches stays reconciliation-required", async (t) => {
  const runtime = env();
  const searchedFields: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts") {
        searchedFields.push(...searchTerms(url).map(({ field }) => field));
        return json({ results: [] });
      }
      if (method === "POST" && url.pathname === "/api1/contacts") {
        return new Response("Duplicate contact exists", { status: 400 });
      }
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  await assert.rejects(
    () => pushToJobNimbus(runtime, record),
    /jobnimbus_duplicate_contact_jobnimbus_readback_not_found/,
  );
  assert.equal(searchedFields.includes("display_name"), false);
  const effect = await runtime.DB.prepare(
    "SELECT state, result_code, provider_external_id FROM external_effects WHERE provider = 'jobnimbus'",
  )
    .bind()
    .first<{
      state: string;
      result_code: string;
      provider_external_id: string | null;
    }>();
  assert.equal(effect?.state, "unknown");
  assert.equal(
    effect?.result_code,
    "jobnimbus_duplicate_contact_jobnimbus_readback_not_found",
  );
  assert.equal(effect?.provider_external_id, null);
});

test("JobNimbus duplicate 400 with multiple exact candidates opens a manual exception", async (t) => {
  const runtime = env();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts") {
        return json({
          ...(searchTerms(url).length > 1
            ? { count: 2, results: [{ jnid: "contact-a" }] }
            : { count: 0, results: [] }),
        });
      }
      if (method === "POST" && url.pathname === "/api1/contacts") {
        return new Response("Duplicate contact exists", { status: 400 });
      }
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  await assert.rejects(
    () => pushToJobNimbus(runtime, record),
    /jobnimbus_duplicate_contact_jobnimbus_readback_multiple_candidates/,
  );
  const effect = await runtime.DB.prepare(
    "SELECT state, result_code FROM external_effects WHERE provider = 'jobnimbus'",
  )
    .bind()
    .first<{ state: string; result_code: string }>();
  assert.equal(effect?.state, "manual_exception");
  assert.equal(
    effect?.result_code,
    "jobnimbus_duplicate_contact_jobnimbus_readback_multiple_candidates",
  );
});

test("JobNimbus never selects a same-name contact without stable identity", async (t) => {
  const runtime = env();
  let displayNameSearches = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts") {
        const fields = searchTerms(url).map(({ field }) => field);
        if (fields.includes("display_name")) {
          displayNameSearches += 1;
          return json({ results: [{ jnid: "same-name-wrong-person" }] });
        }
        return json({ results: [] });
      }
      if (method === "POST" && url.pathname === "/api1/contacts") {
        return new Response("Duplicate contact exists", { status: 400 });
      }
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  await assert.rejects(
    () => pushToJobNimbus(runtime, record),
    /jobnimbus_duplicate_contact_jobnimbus_readback_not_found/,
  );
  assert.equal(displayNameSearches, 0);
});

test("JobNimbus duplicate reconciliation fails closed on incomplete or unavailable search results", async (t) => {
  for (const scenario of [
    {
      name: "incomplete candidate",
      response: () => json({ results: [{}] }),
      code:
        "jobnimbus_duplicate_contact_jobnimbus_readback_candidate_incomplete",
      state: "manual_exception",
    },
    {
      name: "unavailable search",
      response: () => new Response("temporarily unavailable", { status: 503 }),
      code: "jobnimbus_duplicate_contact_jobnimbus_search_503",
      state: "unknown",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const runtime = env();
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (method === "GET" && url.pathname === "/api1/contacts") {
            return searchTerms(url).length > 1
              ? scenario.response()
              : json({ results: [] });
          }
          if (method === "POST" && url.pathname === "/api1/contacts") {
            return new Response("Duplicate contact exists", { status: 400 });
          }
          throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
        },
      );

      await assert.rejects(
        () => pushToJobNimbus(runtime, record),
        new RegExp(scenario.code),
      );
      const effect = await runtime.DB.prepare(
        "SELECT state, result_code FROM external_effects WHERE provider = 'jobnimbus'",
      )
        .bind()
        .first<{ state: string; result_code: string }>();
      assert.equal(effect?.state, scenario.state);
      assert.equal(effect?.result_code, scenario.code);
    });
  }
});

test("JobNimbus reconciles a lost create response by external identity", async (t) => {
  const runtime = env();
  let mutations = 0;
  let stored: Record<string, unknown> | null = null;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api1/contacts") {
        return json({
          results:
            stored && searchTerms(url).length > 1
              ? [{ jnid: "contact-lost-1" }]
              : [],
        });
      }
      if (method === "POST" && url.pathname === "/api1/contacts") {
        mutations += 1;
        stored = { ...JSON.parse(String(init?.body)), jnid: "contact-lost-1" };
        throw new Error("response_lost_after_commit");
      }
      if (method === "GET" && url.pathname === "/api1/contacts/contact-lost-1")
        return json(stored);
      throw new Error(`unexpected JobNimbus fetch ${method} ${url}`);
    },
  );

  const first = await pushToJobNimbus(runtime, record);
  const replay = await pushToJobNimbus(runtime, record);
  assert.equal(first.contactId, "contact-lost-1");
  assert.equal(first.reused, true);
  assert.deepEqual(replay, first);
  assert.equal(mutations, 1);
  const effect = await runtime.DB.prepare(
    "SELECT state, provider_external_id FROM external_effects WHERE provider = 'jobnimbus'",
  )
    .bind()
    .first<{ state: string; provider_external_id: string }>();
  assert.equal(effect?.state, "succeeded");
  assert.equal(effect?.provider_external_id, "contact-lost-1");
});
