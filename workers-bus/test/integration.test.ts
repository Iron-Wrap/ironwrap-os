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
  const envelopesById = new Map<string, Record<string, unknown>>();
  const envelopesByEstimateKey = new Map<string, Record<string, unknown>>();
  const dedupClaims = new Map<string, Record<string, unknown>>();
  const env = {
    INGEST_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    DEDUP_WINDOW_HOURS: "72",
    STUCK_THRESHOLD_MIN: "15",
    // GOOGLE_SERVICE_ACCOUNT_JSON intentionally absent → instant-ack throws and is swallowed by ctx.waitUntil.
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
              run: async () => {
                db.push({ sql, args });
                if (sql.includes("INSERT INTO envelopes")) {
                  const row: Record<string, unknown> = {
                    envelope_id: args[0],
                    source: args[1],
                    contact_name: args[2],
                    contact_phone: args[3],
                    contact_email: args[4],
                    job_ref: args[5],
                    payload_json: args[6],
                    raw_key: args[7],
                    ts: args[8],
                    status: args[9],
                    dedup_key: args[10],
                    dup_of: args[11],
                    attempts: args[12],
                    last_error: args[13],
                    jn_contact_id: args[14],
                    jn_job_id: args[15],
                    estimate_submission_key: args[16],
                    intent_queue: args[17],
                    created_at: args[18],
                    updated_at: args[19],
                  };
                  envelopesById.set(String(row.envelope_id), row);
                  if (row.estimate_submission_key) {
                    envelopesByEstimateKey.set(String(row.estimate_submission_key), row);
                  }
                }
                if (sql.includes("UPDATE envelopes SET erpnext_lead_envelope_id")) {
                  const id = String(args[6]);
                  const row = envelopesById.get(id);
                  if (row) {
                    row.erpnext_lead_envelope_id = args[0];
                    row.erpnext_roofing_property_id = args[1];
                    row.erpnext_roof_job_id = args[2];
                    row.erpnext_instant_estimate_session_id = args[3];
                    row.erpnext_synced_at = args[4];
                    row.updated_at = args[5];
                  }
                }
                if (sql.includes("INSERT INTO dedup_claims")) {
                  dedupClaims.set(String(args[0]), {
                    dedup_key: args[0],
                    first_envelope_id: args[1],
                    first_seen_at: args[2],
                    updated_at: args[3],
                  });
                }
                if (sql.includes("UPDATE dedup_claims")) {
                  const claim = dedupClaims.get(String(args[3]));
                  if (claim && String(claim.first_seen_at) < String(args[4])) {
                    claim.first_envelope_id = args[0];
                    claim.first_seen_at = args[1];
                    claim.updated_at = args[2];
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                return { success: true };
              },
              first: async () => {
                db.push({ sql, args });
                if (sql.includes("FROM dedup_claims")) {
                  return dedupClaims.get(String(args[0])) ?? null;
                }
                if (sql.includes("WHERE estimate_submission_key = ?")) {
                  return envelopesByEstimateKey.get(String(args[0])) ?? null;
                }
                if (sql.includes("SELECT * FROM envelopes WHERE envelope_id = ?")) {
                  return envelopesById.get(String(args[0])) ?? null;
                }
                return null;
              },
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

test("POST /ingest/website: repeated contact claims duplicate and skips second JN enqueue", async () => {
  const { env, r2, queue, db } = fakeEnv();
  const makeReq = () => new Request("https://bus.example/ingest/website", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ name: "Jane Doe", phone: "(587) 555-1234", email: "Jane@Example.com", service: "metal roof quote" }),
  });

  const first = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const firstBody = (await first.json()) as { envelope_id: string; duplicate: boolean; status: string };
  const second = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const secondBody = (await second.json()) as { envelope_id: string; duplicate: boolean; status: string };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstBody.duplicate, false);
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.status, "duplicate");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].envelope_id, firstBody.envelope_id);
  assert.equal(r2.length, 2);
  assert.equal(db.filter((c) => c.sql.includes("INSERT INTO dedup_claims")).length, 1);
  const duplicateInsert = db
    .filter((c) => c.sql.includes("INSERT INTO envelopes"))
    .find((c) => c.args.includes(secondBody.envelope_id));
  assert.ok(duplicateInsert);
  assert.ok(duplicateInsert.args.includes("duplicate"));
  assert.ok(duplicateInsert.args.includes(firstBody.envelope_id));
});

test("POST /ingest/estimate: configurator payload lands in owned store and ERPNext without JN/GHL queue", async (t) => {
  const { env, r2, queue, db } = fakeEnv();
  const erpCalls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    erpCalls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-EST-1" } });
    if (url.endsWith("/api/resource/Roofing%20Property")) return json({ data: { name: "RP-EST-1" } });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-EST-1" } });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.gate_id } });
    }
    if (url.endsWith("/api/resource/Instant%20Estimate%20Session")) return json({ data: { name: "IES-EST-1" } });
    throw new Error(`unexpected fetch ${url}`);
  });
  Object.assign(env, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
  });

  const estimatePayload = {
    project_id: "26-180-ER",
    job_number: "26-180-ER",
    customer: "Jim Rakievich",
    email: "jim@example.com",
    address: "Gunn, AB",
    selected_services: ["Roof", "Wall", "Soffit", "Fascia", "Gutters", "Downspouts"],
    materials: { roof: "SnapLock Metal Roofing", siding: "Metal Siding", roof_color: "Wrinkle RAL 7024" },
    total_estimate: "$216,269.58",
    project_url: "https://example.com/p/26-180-ER",
  };
  const estimateBody = JSON.stringify(estimatePayload);
  const req = new Request("https://bus.example/ingest/estimate", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: estimateBody,
  });
  const res = await worker.fetch(req, env as never, fakeCtx() as never);
  const body = await res.json() as {
    envelope_id: string;
    erpnext_lead_envelope_id?: string;
    erpnext_roof_job_id?: string;
    erpnext_instant_estimate_id?: string;
  };

  assert.equal(res.status, 200);
  assert.equal(body.erpnext_lead_envelope_id, "LE-EST-1");
  assert.equal(body.erpnext_roof_job_id, "RJ-EST-1");
  assert.equal(body.erpnext_instant_estimate_id, "IES-EST-1");
  assert.equal(queue.length, 0);
  assert.equal(r2.length, 1);
  assert.match(r2[0].key, /^raw\/estimates\/\d{4}-\d{2}-\d{2}\/ow_/);
  assert.equal(r2[0].body, estimateBody);

  const insert = db.find((c) => c.sql.includes("INSERT INTO envelopes"));
  assert.ok(insert);
  assert.ok(insert.args.includes("Jim Rakievich"));
  assert.ok(insert.args.includes("26-180-ER"));
  assert.ok(insert.args.includes("received"));

  const job = JSON.parse(String(erpCalls.find((c) => c.url.endsWith("/api/resource/Roof%20Job"))?.init.body));
  assert.equal(job.roof_job_id, "job:26-180-ER");
  assert.equal(job.job_number, "26-180-ER");

  const estimate = JSON.parse(String(erpCalls.find((c) => c.url.endsWith("/api/resource/Instant%20Estimate%20Session"))?.init.body));
  assert.equal(estimate.estimate_session_id, "estimate:26-180-ER");
  assert.equal(estimate.roof_job, "RJ-EST-1");
  assert.equal(estimate.estimate_total, 216269.58);
  assert.equal(estimate.configurator_url, "https://example.com/p/26-180-ER");
  assert.equal(estimate.review_required, 1);
  assert.deepEqual(JSON.parse(estimate.selected_services_json), ["Roof", "Wall", "Soffit", "Fascia", "Gutters", "Downspouts"]);
  assert.deepEqual(JSON.parse(estimate.material_choices_json), {
    roof: "SnapLock Metal Roofing",
    siding: "Metal Siding",
    roof_color: "Wrinkle RAL 7024",
  });
});

test("POST /ingest/estimate: repeated project id is idempotent and does not re-drive side effects", async (t) => {
  const { env, r2, queue, db } = fakeEnv();
  const erpCalls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    erpCalls.push({ url, init: init ?? {} });
    if ((init?.method ?? "GET") === "GET") return json({ data: [] });
    if (url.endsWith("/api/resource/Lead%20Envelope")) return json({ data: { name: "LE-EST-IDEMPOTENT" } });
    if (url.endsWith("/api/resource/Roofing%20Property")) return json({ data: { name: "RP-EST-IDEMPOTENT" } });
    if (url.endsWith("/api/resource/Roof%20Job")) return json({ data: { name: "RJ-EST-IDEMPOTENT" } });
    if (url.endsWith("/api/resource/Production%20Gate%20State")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.gate_id } });
    }
    if (url.endsWith("/api/resource/Instant%20Estimate%20Session")) {
      return json({ data: { name: "IES-EST-IDEMPOTENT" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  Object.assign(env, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
  });

  const bodyText = JSON.stringify({
    project_id: "26-180-ER",
    customer: "Jim Rakievich",
    email: "jim@example.com",
    total_estimate: "$216,269.58",
  });
  const makeReq = () => new Request("https://bus.example/ingest/estimate", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: bodyText,
  });

  const first = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const firstBody = await first.json() as { envelope_id: string; erpnext_instant_estimate_id?: string };
  const second = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const secondBody = await second.json() as {
    envelope_id: string;
    idempotent_replay?: boolean;
    erpnext_instant_estimate_id?: string;
  };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondBody.envelope_id, firstBody.envelope_id);
  assert.equal(secondBody.idempotent_replay, true);
  assert.equal(secondBody.erpnext_instant_estimate_id, "IES-EST-IDEMPOTENT");
  assert.equal(queue.length, 0);
  assert.equal(r2.length, 1);
  assert.equal(db.filter((c) => c.sql.includes("INSERT INTO envelopes")).length, 1);
  assert.equal(erpCalls.filter((c) => c.url.endsWith("/api/resource/Lead%20Envelope")).length, 1);
  assert.equal(erpCalls.filter((c) => c.url.endsWith("/api/resource/Instant%20Estimate%20Session")).length, 1);
});

test("POST /ingest/estimate: replay of invalid project id returns original validation error", async () => {
  const { env, r2, db } = fakeEnv();
  const bodyText = JSON.stringify({ project_id: "invalid-no-contact", total_estimate: "$1,000" });
  const makeReq = () => new Request("https://bus.example/ingest/estimate", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: bodyText,
  });

  const first = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const firstBody = await first.json() as { envelope_id: string; error: string };
  const second = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const secondBody = await second.json() as { envelope_id: string; idempotent_replay?: boolean; error: string };

  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
  assert.equal(secondBody.envelope_id, firstBody.envelope_id);
  assert.equal(secondBody.idempotent_replay, true);
  assert.equal(secondBody.error, "no_contact_handle");
  assert.equal(r2.length, 1);
  assert.equal(db.filter((c) => c.sql.includes("INSERT INTO envelopes")).length, 1);
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

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
