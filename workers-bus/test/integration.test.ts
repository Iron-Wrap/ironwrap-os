// Integration test for the ingest path — runs under `node --test` with in-memory fake bindings
// (no Miniflare, no install). Drives the real Worker `fetch` handler end to end:
// auth → raw to R2 → canonical envelope to D1 → enqueue JobNimbus push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { retryEstimateOperatingCoreMaterializations } from "../src/estimates.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

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
    NEWO_WEBHOOK_TOKEN: "newo-webhook-token",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    APP_TENANT_ID: "ironwrap",
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
                    tenant_id: args[20],
                  };
                  envelopesById.set(String(row.envelope_id), row);
                  if (row.estimate_submission_key) {
                    envelopesByEstimateKey.set(String(row.estimate_submission_key), row);
                  }
                }
                if (sql.includes("UPDATE envelopes SET erpnext_lead_envelope_id")) {
                  const id = String(sql.includes("tenant_id") ? args[args.length - 2] : args[6]);
                  const tenantId = sql.includes("tenant_id") ? String(args[args.length - 1]) : null;
                  const row = envelopesById.get(id);
                  if (row && (!tenantId || String(row.tenant_id) === tenantId)) {
                    row.erpnext_lead_envelope_id = args[0];
                    row.erpnext_roofing_property_id = args[1];
                    row.erpnext_roof_job_id = args[2];
                    row.erpnext_instant_estimate_session_id = args[3];
                    row.erpnext_synced_at = args[4];
                    row.updated_at = args[5];
                    row.erpnext_error = null;
                  }
                }
                if (sql.includes("UPDATE envelopes SET attempts = attempts + 1, erpnext_error")) {
                  const id = String(sql.includes("tenant_id") ? args[args.length - 2] : args[2]);
                  const tenantId = sql.includes("tenant_id") ? String(args[args.length - 1]) : null;
                  const row = envelopesById.get(id);
                  if (row && (!tenantId || String(row.tenant_id) === tenantId)) {
                    row.attempts = Number(row.attempts ?? 0) + 1;
                    row.erpnext_error = args[0];
                    row.updated_at = args[1];
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
              all: async () => {
                db.push({ sql, args });
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  return { env: withTestEffectRuntime(env), r2, queue, db, envelopesById };
}

class EstimateD1 {
  readonly raw = new DatabaseSync(":memory:");
  failNextOperatingBatch = false;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0004_estimate_idempotency.sql",
      "0009_replay_approval_audit.sql",
      "0090_operating_core.sql",
      "0082_envelope_operating_tenant.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this.raw;
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => (db.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
        run: async () => {
          const result = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      }),
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    if (this.failNextOperatingBatch) {
      this.failNextOperatingBatch = false;
      throw new Error("temporary_native_d1_failure");
    }
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function nativeEstimateEnv() {
  const db = new EstimateD1();
  const r2: Array<{ key: string; body: string }> = [];
  const env = {
    INGEST_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    OWNER_ALERT_EMAIL: "owner@example.com",
    STUCK_THRESHOLD_MIN: "15",
    APP_TENANT_ID: "ironwrap",
    OPERATING_AUTOMATION_USER: "worker@example.invalid",
    // Deliberately enabled: native estimate intake must ignore legacy Frappe configuration.
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.invalid",
    ERPNEXT_API_KEY: "unused",
    ERPNEXT_API_SECRET: "unused",
    RAW: {
      put: async (key: string, body: string) => { r2.push({ key, body }); },
    },
    DB: db,
  };
  return { env, db, r2 };
}

const fakeCtx = (waitUntilCalls: Promise<unknown>[] = []) => ({
  waitUntil: (p: Promise<unknown>) => {
    waitUntilCalls.push(p);
    void Promise.resolve(p).catch(() => {});
  },
});

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
  assert.equal(secondBody.envelope_id, firstBody.envelope_id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].envelope_id, firstBody.envelope_id);
  assert.equal(r2.length, 2);
  assert.equal(db.filter((c) => c.sql.includes("INSERT INTO dedup_claims")).length, 1);
  assert.equal(
    db.filter((c) => c.sql.includes("INSERT INTO envelopes")).length,
    1,
    "replay must not mint a second D1 lead row",
  );
});

test("POST /ingest/estimate: materializes native operating truth with zero Frappe calls", async (t) => {
  const { env, r2, db } = nativeEstimateEnv();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("network_must_not_be_called");
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
    operating_lead_id: string;
    operating_customer_id: string;
    operating_roof_job_id: string;
    operating_instant_estimate_id: string;
  };

  assert.equal(res.status, 200);
  assert.equal(fetches, 0);
  assert.match(body.operating_lead_id, /^lead:ironwrap:[0-9a-f]{64}$/);
  assert.match(body.operating_customer_id, /^customer:ironwrap:[0-9a-f]{64}$/);
  assert.match(body.operating_roof_job_id, /^job:ironwrap:[0-9a-f]{64}$/);
  assert.match(body.operating_instant_estimate_id, /^estimate:ironwrap:[0-9a-f]{64}$/);
  assert.equal(Object.keys(body).some((key) => key.startsWith("erpnext_")), false);
  assert.equal(r2.length, 1);
  assert.match(r2[0].key, /^raw\/estimates\/\d{4}-\d{2}-\d{2}\/ow_/);
  assert.equal(r2[0].body, estimateBody);
  const row = db.raw.prepare(
    `SELECT j.roof_job_id, j.job_number, c.customer_id, c.display_name,
            e.estimate_session_id, e.estimate_total_cents, e.configurator_url,
            e.selected_services_json, e.material_choices_json
       FROM operating_roof_jobs j
       JOIN operating_customers c ON c.tenant_id = j.tenant_id AND c.customer_id = j.customer_id
       JOIN operating_instant_estimates e ON e.tenant_id = j.tenant_id AND e.roof_job_id = j.roof_job_id`,
  ).get() as Record<string, unknown>;
  assert.equal(row.roof_job_id, body.operating_roof_job_id);
  assert.equal(row.job_number, "26-180-ER");
  assert.equal(row.customer_id, body.operating_customer_id);
  assert.equal(row.display_name, "Jim Rakievich");
  assert.equal(row.estimate_session_id, body.operating_instant_estimate_id);
  assert.equal(row.estimate_total_cents, 21_626_958);
  assert.equal(row.configurator_url, "https://example.com/p/26-180-ER");
  assert.deepEqual(JSON.parse(String(row.selected_services_json)), estimatePayload.selected_services);
  assert.deepEqual(JSON.parse(String(row.material_choices_json)), estimatePayload.materials);
});

test("POST /ingest/estimate: repeated project id reuses one native graph and one raw object", async (t) => {
  const { env, r2, db } = nativeEstimateEnv();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("network_must_not_be_called");
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
  const firstBody = await first.json() as { envelope_id: string; operating_instant_estimate_id: string };
  const second = await worker.fetch(makeReq(), env as never, fakeCtx() as never);
  const secondBody = await second.json() as {
    envelope_id: string;
    idempotent_replay?: boolean;
    operating_instant_estimate_id: string;
  };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondBody.envelope_id, firstBody.envelope_id);
  assert.equal(secondBody.idempotent_replay, true);
  assert.equal(secondBody.operating_instant_estimate_id, firstBody.operating_instant_estimate_id);
  assert.equal(fetches, 0);
  assert.equal(r2.length, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM envelopes").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_leads").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_roof_jobs").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_instant_estimates").get().count, 1);
});

test("POST /ingest/estimate: replay of invalid project id returns original validation error", async () => {
  const { env, r2, db } = nativeEstimateEnv();
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
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM envelopes").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_leads").get().count, 0);
});

test("POST /ingest/estimate: invalid native money is terminal and never scheduled", async () => {
  const { env, db } = nativeEstimateEnv();
  const bodyText = JSON.stringify({
    project_id: "invalid-money-project",
    customer: "Invalid Money",
    email: "invalid-money@example.com",
    total_estimate: "not-money",
  });
  const request = () => new Request("https://bus.example/ingest/estimate", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: bodyText,
  });

  const first = await worker.fetch(request(), env as never, fakeCtx() as never);
  const firstBody = await first.json() as { envelope_id: string; error: string };
  assert.equal(first.status, 422);
  assert.equal(firstBody.error, "native_operating_core_rejected");
  const terminal = db.raw.prepare(
    "SELECT attempts, last_error FROM envelopes WHERE envelope_id = ?",
  ).get(firstBody.envelope_id) as { attempts: number; last_error: string };
  assert.equal(terminal.attempts, 1);
  assert.match(terminal.last_error, /^native_operating_core:terminal:.*operating_core_money_invalid:estimate_total/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_leads").get().count, 0);

  db.raw.prepare("UPDATE envelopes SET updated_at = ? WHERE envelope_id = ?")
    .run("2000-01-01T00:00:00.000Z", firstBody.envelope_id);
  await retryEstimateOperatingCoreMaterializations(env as never);
  assert.equal(
    (db.raw.prepare("SELECT attempts FROM envelopes WHERE envelope_id = ?")
      .get(firstBody.envelope_id) as { attempts: number }).attempts,
    1,
  );

  const replay = await worker.fetch(request(), env as never, fakeCtx() as never);
  const replayBody = await replay.json() as { idempotent_replay?: boolean; error: string };
  assert.equal(replay.status, 422);
  assert.equal(replayBody.idempotent_replay, true);
  assert.equal(replayBody.error, "native_operating_core_rejected");
});

test("POST /ingest/estimate: failed native batch stays accepted and scheduled retry converges", async (t) => {
  const { env, db } = nativeEstimateEnv();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("network_must_not_be_called");
  });
  db.failNextOperatingBatch = true;
  const bodyText = JSON.stringify({
    project_id: "retry-project-1",
    customer: "Retry Customer",
    email: "retry@example.com",
    total_estimate: "$12,000",
  });
  const request = () => new Request("https://bus.example/ingest/estimate", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: bodyText,
  });

  const first = await worker.fetch(request(), env as never, fakeCtx() as never);
  const firstBody = await first.json() as {
    accepted?: boolean;
    completed?: boolean;
    envelope_id: string;
    operating_core_status?: string;
  };

  assert.equal(first.status, 202);
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.completed, false);
  assert.equal(firstBody.operating_core_status, "retry_pending");
  const pending = db.raw.prepare(
    "SELECT attempts, last_error FROM envelopes WHERE envelope_id = ?",
  ).get(firstBody.envelope_id) as { attempts: number; last_error: string };
  assert.match(pending.last_error, /^native_operating_core:.*temporary_native_d1_failure/);
  assert.equal(pending.attempts, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_leads").get().count, 0);

  db.raw.prepare("UPDATE envelopes SET updated_at = ? WHERE envelope_id = ?")
    .run("2000-01-01T00:00:00.000Z", firstBody.envelope_id);
  await retryEstimateOperatingCoreMaterializations(env as never);
  const recovered = db.raw.prepare(
    "SELECT attempts, last_error FROM envelopes WHERE envelope_id = ?",
  ).get(firstBody.envelope_id) as { attempts: number; last_error: string | null };
  assert.equal(recovered.last_error, null);
  assert.equal(recovered.attempts, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_leads").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_roof_jobs").get().count, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM operating_instant_estimates").get().count, 1);

  const replay = await worker.fetch(request(), env as never, fakeCtx() as never);
  const replayBody = await replay.json() as {
    idempotent_replay?: boolean;
    operating_instant_estimate_id?: string;
  };
  assert.equal(replay.status, 200);
  assert.equal(replayBody.idempotent_replay, true);
  assert.match(replayBody.operating_instant_estimate_id ?? "", /^estimate:ironwrap:[0-9a-f]{64}$/);
  assert.equal(fetches, 0);
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
