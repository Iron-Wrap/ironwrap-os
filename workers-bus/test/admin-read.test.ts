import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { EnvelopeRecord } from "../src/core.ts";

const rec: EnvelopeRecord = {
  envelope_id: "ow_admin_read",
  source: "website",
  contact_name: "Jane Doe",
  contact_phone: "+15875551234",
  contact_email: "jane@example.com",
  job_ref: null,
  payload_json: "{\"service\":\"metal roof\"}",
  raw_key: "raw/2026-07-08/ow_admin_read.json",
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

function env() {
  return {
    ADMIN_TOKEN: "admin-token",
    DB: {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              first: async () => sql.includes("SELECT * FROM envelopes") ? rec : null,
              all: async () => {
                if (sql.includes("FROM envelopes")) return { results: [rec] };
                if (sql.includes("FROM dead_letter")) {
                  return { results: [{ id: 1, ts: rec.ts, envelope_id: rec.envelope_id, stage: "erpnext_push", error: "boom", payload_json: "{}", recovered: 0 }] };
                }
                return { results: [] };
              },
              run: async () => ({ success: true }),
            };
          },
        };
      },
    },
  };
}

test("GET /admin/envelopes returns recent envelopes with parsed payload", async () => {
  const res = await worker.fetch(new Request("https://bus.example/admin/envelopes?limit=1", {
    headers: { authorization: "Bearer admin-token" },
  }), env() as never, {} as never);
  const body = await res.json() as { envelopes: Array<{ envelope_id: string; payload: { service: string } }> };

  assert.equal(res.status, 200);
  assert.equal(body.envelopes[0].envelope_id, rec.envelope_id);
  assert.deepEqual(body.envelopes[0].payload, { service: "metal roof" });
});

test("GET /admin/envelope/:id returns one envelope", async () => {
  const res = await worker.fetch(new Request(`https://bus.example/admin/envelope/${rec.envelope_id}`, {
    headers: { authorization: "Bearer admin-token" },
  }), env() as never, {} as never);
  const body = await res.json() as { envelope: { envelope_id: string } };

  assert.equal(res.status, 200);
  assert.equal(body.envelope.envelope_id, rec.envelope_id);
});

test("GET /admin/dead-letter returns unrecovered rows", async () => {
  const res = await worker.fetch(new Request("https://bus.example/admin/dead-letter", {
    headers: { authorization: "Bearer admin-token" },
  }), env() as never, {} as never);
  const body = await res.json() as { dead_letters: Array<{ stage: string }> };

  assert.equal(res.status, 200);
  assert.equal(body.dead_letters[0].stage, "erpnext_push");
});

test("admin read endpoints require ADMIN_TOKEN", async () => {
  const res = await worker.fetch(new Request("https://bus.example/admin/envelopes"), env() as never, {} as never);
  assert.equal(res.status, 401);
});
