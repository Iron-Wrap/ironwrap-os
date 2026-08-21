// IRO-189: D1/Worker is the operating authority for a synthetic lead.
// Frappe/ERPNext is out of scope. These tests drive the public ingest and admin
// read-back seams with in-memory D1 fakes — no Miniflare, no wrangler deploy.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const LEAD = {
  name: "Launch Proof",
  phone: "(587) 555-0199",
  email: "launch-proof+iro-189@example.invalid",
  service: "metal roofing",
  message: "iro-189 d1-native synthetic lead",
};

function fakeCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      void Promise.resolve(p).catch(() => {});
    },
  };
}

function ingestRequest(body: Record<string, unknown>, token = "ingest-token") {
  return new Request("https://bus.example/ingest/website", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function adminEnvBindings(options: {
  tenantId: string;
  ingestToken?: string;
  adminToken?: string;
  envelopes: Map<string, Record<string, unknown>>;
  dedupClaims: Map<string, Record<string, unknown>>;
  writes: Array<{ sql: string; args: unknown[] }>;
  r2: Array<{ key: string; body: string }>;
  queue: Array<{ envelope_id: string }>;
}) {
  const ingestToken = options.ingestToken ?? "ingest-token";
  const adminToken = options.adminToken ?? "admin-token";
  const env = {
    INGEST_TOKEN: ingestToken,
    ADMIN_TOKEN: adminToken,
    APP_TENANT_ID: options.tenantId,
    NEWO_WEBHOOK_TOKEN: "newo-webhook-token",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    DEDUP_WINDOW_HOURS: "72",
    STUCK_THRESHOLD_MIN: "15",
    RAW: {
      put: async (key: string, body: string) => {
        options.r2.push({ key, body });
      },
    },
    JN_QUEUE: {
      send: async (m: { envelope_id: string }) => {
        options.queue.push(m);
      },
      sendBatch: async (ms: Array<{ body: { envelope_id: string } }>) => {
        for (const m of ms) options.queue.push(m.body);
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                options.writes.push({ sql, args });
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
                  options.envelopes.set(String(row.envelope_id), row);
                }
                if (sql.includes("INSERT INTO dedup_claims")) {
                  options.dedupClaims.set(String(args[0]), {
                    dedup_key: args[0],
                    first_envelope_id: args[1],
                    first_seen_at: args[2],
                    updated_at: args[3],
                  });
                }
                return { success: true, meta: { changes: 1 } };
              },
              first: async () => {
                options.writes.push({ sql, args });
                if (sql.includes("FROM dedup_claims")) {
                  return options.dedupClaims.get(String(args[0])) ?? null;
                }
                if (sql.includes("SELECT * FROM envelopes WHERE envelope_id = ?")) {
                  const row = options.envelopes.get(String(args[0])) ?? null;
                  if (!row) return null;
                  if (sql.includes("tenant_id") && String(row.tenant_id) !== String(args[1])) {
                    return null;
                  }
                  return row;
                }
                return null;
              },
              all: async () => {
                options.writes.push({ sql, args });
                if (sql.includes("FROM envelopes") && sql.includes("ORDER BY created_at")) {
                  const tenantId = sql.includes("tenant_id") ? String(args[0]) : null;
                  const results = [...options.envelopes.values()].filter((row) =>
                    tenantId ? String(row.tenant_id) === tenantId : true,
                  );
                  return { results };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  return withTestEffectRuntime(env);
}

function sharedStore() {
  return {
    envelopes: new Map<string, Record<string, unknown>>(),
    dedupClaims: new Map<string, Record<string, unknown>>(),
    writes: [] as Array<{ sql: string; args: unknown[] }>,
    r2: [] as Array<{ key: string; body: string }>,
    queue: [] as Array<{ envelope_id: string }>,
  };
}

test("synthetic website lead persists to D1 with exact tenant identity and never calls Frappe", async (t) => {
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push(String(input));
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const store = sharedStore();
  const env = adminEnvBindings({ tenantId: "ironwrap", ...store });
  const res = await worker.fetch(ingestRequest(LEAD), env as never, fakeCtx() as never);
  const body = (await res.json()) as {
    envelope_id: string;
    canonical_envelope_id: string;
    tenant_id: string;
    duplicate: boolean;
    status: string;
  };

  assert.equal(res.status, 200);
  assert.match(body.envelope_id, /^ow_[0-9a-f-]{36}$/);
  assert.equal(body.canonical_envelope_id, body.envelope_id);
  assert.equal(body.tenant_id, "ironwrap");
  assert.equal(body.duplicate, false);
  assert.equal(fetches.length, 0);

  const stored = store.envelopes.get(body.envelope_id);
  assert.ok(stored, "D1 envelope row is the operating record");
  assert.equal(stored.tenant_id, "ironwrap");
  assert.equal(stored.contact_phone, "+15875550199");
  assert.equal(stored.contact_email, "launch-proof+iro-189@example.invalid");
  assert.equal(stored.contact_name, "Launch Proof");

  const readback = await worker.fetch(
    new Request(`https://bus.example/admin/envelope/${body.envelope_id}`, {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    fakeCtx() as never,
  );
  const readBody = (await readback.json()) as {
    envelope: { envelope_id: string; tenant_id: string; contact_phone: string };
  };
  assert.equal(readback.status, 200);
  assert.equal(readBody.envelope.envelope_id, body.envelope_id);
  assert.equal(readBody.envelope.tenant_id, "ironwrap");
  assert.equal(readBody.envelope.contact_phone, "+15875550199");
});

test("repeating the same synthetic lead returns the original envelope identity", async () => {
  const store = sharedStore();
  const env = adminEnvBindings({ tenantId: "ironwrap", ...store });
  const first = await worker.fetch(ingestRequest(LEAD), env as never, fakeCtx() as never);
  const firstBody = (await first.json()) as {
    envelope_id: string;
    canonical_envelope_id: string;
    duplicate: boolean;
  };
  const second = await worker.fetch(ingestRequest(LEAD), env as never, fakeCtx() as never);
  const secondBody = (await second.json()) as {
    envelope_id: string;
    canonical_envelope_id: string;
    duplicate: boolean;
    status: string;
  };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstBody.duplicate, false);
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.status, "duplicate");
  assert.equal(secondBody.canonical_envelope_id, firstBody.envelope_id);
  assert.equal(store.queue.length, 1);
  assert.equal(store.queue[0].envelope_id, firstBody.envelope_id);
});

test("a second tenant cannot read the first tenant's synthetic lead", async () => {
  const store = sharedStore();
  const tenantA = adminEnvBindings({ tenantId: "ironwrap", ...store });
  const tenantB = adminEnvBindings({
    tenantId: "acme-roofing",
    ingestToken: "ingest-token",
    adminToken: "admin-token",
    ...store,
  });
  const created = await worker.fetch(ingestRequest(LEAD), tenantA as never, fakeCtx() as never);
  const createdBody = (await created.json()) as { envelope_id: string };
  assert.equal(created.status, 200);

  const leaked = await worker.fetch(
    new Request(`https://bus.example/admin/envelope/${createdBody.envelope_id}`, {
      headers: { authorization: "Bearer admin-token" },
    }),
    tenantB as never,
    fakeCtx() as never,
  );
  const leakedBody = (await leaked.json()) as { envelope: unknown };
  assert.equal(leaked.status, 200);
  assert.equal(leakedBody.envelope, null);

  const listed = await worker.fetch(
    new Request("https://bus.example/admin/envelopes?limit=10", {
      headers: { authorization: "Bearer admin-token" },
    }),
    tenantB as never,
    fakeCtx() as never,
  );
  const listedBody = (await listed.json()) as { envelopes: Array<{ envelope_id: string }> };
  assert.equal(listed.status, 200);
  assert.equal(
    listedBody.envelopes.some((row) => row.envelope_id === createdBody.envelope_id),
    false,
  );
});

test("ingest refuses an unverified tenant identity before any D1 mutation", async () => {
  const store = sharedStore();
  const env = adminEnvBindings({ tenantId: "IronWrap", ...store });
  const res = await worker.fetch(ingestRequest(LEAD), env as never, fakeCtx() as never);
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 403);
  assert.equal(body.error, "tenant_identity_required");
  assert.equal(store.envelopes.size, 0);
  assert.equal(store.r2.length, 0);
  assert.equal(store.queue.length, 0);
});

test("ingest token cannot read the D1 lead; admin token can", async () => {
  const store = sharedStore();
  const env = adminEnvBindings({ tenantId: "ironwrap", ...store });
  const created = await worker.fetch(ingestRequest(LEAD), env as never, fakeCtx() as never);
  const createdBody = (await created.json()) as { envelope_id: string };

  const denied = await worker.fetch(
    new Request(`https://bus.example/admin/envelope/${createdBody.envelope_id}`, {
      headers: { authorization: "Bearer ingest-token" },
    }),
    env as never,
    fakeCtx() as never,
  );
  assert.equal(denied.status, 401);

  const allowed = await worker.fetch(
    new Request(`https://bus.example/admin/envelope/${createdBody.envelope_id}`, {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    fakeCtx() as never,
  );
  assert.equal(allowed.status, 200);
});
