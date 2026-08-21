// IRO-189 remaining close item: a real SQLite D1 (full migration chain), not an
// in-memory Map fake. After website ingest, sales / field / production / money
// roles read the same tenant-scoped lead from D1. Frappe is never called.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole, type AppRole, type AuthContext } from "../src/app-types.ts";
import worker from "../src/index.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const LEAD = {
  name: "Launch Proof",
  phone: "(587) 555-0199",
  email: "launch-proof+iro-189@example.invalid",
  service: "metal roofing",
  message: "iro-189 real sqlite d1 operating intake",
} as const;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

function fakeCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      void Promise.resolve(p).catch(() => {});
    },
  };
}

function ingestEnv(db: SqliteD1, tenantId: string) {
  const r2: Array<{ key: string; body: string }> = [];
  const queue: Array<{ envelope_id: string }> = [];
  return withTestEffectRuntime({
    INGEST_TOKEN: "ingest-token",
    ADMIN_TOKEN: "admin-token",
    APP_TENANT_ID: tenantId,
    NEWO_WEBHOOK_TOKEN: "newo-webhook-token",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    BACKUP_ALERT_EMAIL: "backup@example.invalid",
    FROM_EMAIL: "ops@example.invalid",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    DEDUP_WINDOW_HOURS: "72",
    STUCK_THRESHOLD_MIN: "15",
    RAW: {
      put: async (key: string, body: string) => {
        r2.push({ key, body });
      },
    },
    JN_QUEUE: {
      send: async (m: { envelope_id: string }) => {
        queue.push(m);
      },
      sendBatch: async (ms: Array<{ body: { envelope_id: string } }>) => {
        for (const m of ms) queue.push(m.body);
      },
    },
    DB: db,
    _r2: r2,
    _queue: queue,
  });
}

function sessionAuth(role: AppRole, tenantId: string): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-21T12:00:00.000Z",
      session_expires_at: "2026-08-22T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}_0001`,
      tenant_id: tenantId,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: "seed",
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
      device_id: null,
      device_proof_hash: null,
    },
  };
}

async function ingestLead(
  env: ReturnType<typeof ingestEnv>,
  body: typeof LEAD = LEAD,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request("https://bus.example/ingest/website", {
      method: "POST",
      headers: {
        authorization: "Bearer ingest-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env as never,
    fakeCtx() as never,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function operatingIntake(
  env: ReturnType<typeof ingestEnv>,
  role: AppRole,
  tenantId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleAuthenticatedRoute(
    new Request("https://bus.example/api/v1/operating-intake"),
    env as never,
    sessionAuth(role, tenantId),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("real sqlite D1 stores one synthetic website lead and never calls Frappe", async (t) => {
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push(String(input));
    throw new Error(`unexpected fetch ${String(input)}`);
  });

  const db = new SqliteD1();
  const env = ingestEnv(db, "ironwrap");
  const created = await ingestLead(env);
  assert.equal(created.status, 200);
  const envelopeId = created.json.envelope_id;
  assert.equal(typeof envelopeId, "string");
  assert.match(String(envelopeId), /^ow_[0-9a-f-]{36}$/);
  assert.equal(created.json.tenant_id, "ironwrap");
  assert.equal(fetches.length, 0);

  const stored = db.raw
    .prepare(
      `SELECT envelope_id, tenant_id, contact_name, contact_phone, contact_email, source
       FROM envelopes WHERE envelope_id = ?`,
    )
    .get(envelopeId) as {
    envelope_id: string;
    tenant_id: string;
    contact_name: string;
    contact_phone: string;
    contact_email: string;
    source: string;
  } | undefined;
  assert.ok(stored, "independent SQLite readback must see the D1 row");
  assert.equal(stored.tenant_id, "ironwrap");
  assert.equal(stored.contact_name, "Launch Proof");
  assert.equal(stored.contact_phone, "+15875550199");
  assert.equal(stored.contact_email, "launch-proof+iro-189@example.invalid");
  assert.equal(stored.source, "website");
});

test("repeating the same synthetic lead keeps one operating identity", async () => {
  const db = new SqliteD1();
  const env = ingestEnv(db, "ironwrap");
  const first = await ingestLead(env);
  const second = await ingestLead(env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(second.json.canonical_envelope_id, first.json.envelope_id);

  const canonical = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM envelopes
       WHERE envelope_id = ? AND tenant_id = ? AND status != 'duplicate'`,
    )
    .get(first.json.envelope_id, "ironwrap") as { n: number };
  assert.equal(canonical.n, 1);
});

test("sales, field, production, and money desks read the D1 lead without Frappe", async (t) => {
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetches.push(String(input));
    throw new Error(`unexpected fetch ${String(input)}`);
  });

  const db = new SqliteD1();
  const env = ingestEnv(db, "ironwrap");
  const created = await ingestLead(env);
  assert.equal(created.status, 200);
  const envelopeId = created.json.envelope_id;

  for (const role of ["sales", "field", "production", "accounting", "owner"] as const) {
    const desk = await operatingIntake(env, role, "ironwrap");
    assert.equal(desk.status, 200, `${role} must read D1 intake`);
    assert.equal(desk.json.operating_authority, "d1");
    assert.equal(desk.json.tenant_id, "ironwrap");
    const leads = desk.json.leads as Array<{
      envelope_id: string;
      desk_state: string;
      not_a_scheduled_job?: boolean;
      not_a_money_intent?: boolean;
    }>;
    assert.equal(leads.length, 1, `${role} must see exactly the ingested lead`);
    assert.equal(leads[0]?.envelope_id, envelopeId);
    assert.equal(leads[0]?.desk_state, "intake");
    assert.equal(leads[0]?.not_a_scheduled_job, true);
    assert.equal(leads[0]?.not_a_money_intent, true);
  }
  assert.equal(fetches.length, 0);
});

test("a D1 intake lead cannot be derived as a money job", async () => {
  const db = new SqliteD1();
  const env = ingestEnv(db, "ironwrap");
  const created = await ingestLead(env);
  assert.equal(created.status, 200);
  const envelopeId = String(created.json.envelope_id);

  const res = await handleAuthenticatedRoute(
    new Request("https://bus.example/api/v1/accounting/intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf",
        "idempotency-key": "intake-lead-is-not-a-job-01",
      },
      body: JSON.stringify({
        kind: "deposit_invoice",
        roof_job_id: envelopeId,
        realm_id: "1234567890",
        customer_ref: "cust-1",
        item_ref: "item-1",
        tax_code_ref: "tax-1",
        subtotal: "1000.00",
        tax_amount: "50.00",
        txn_date: "2026-08-21",
        due_date: "2026-09-21",
        source_documents: [{ id: "quote-1", version: 1 }],
        jurisdiction: "CA-AB",
        tax_code: "GST",
      }),
    }),
    env as never,
    sessionAuth("accounting", "ironwrap"),
  );
  const body = (await res.json()) as {
    error?: string;
    not_a_scheduled_job?: boolean;
    not_a_money_intent?: boolean;
  };
  assert.equal(res.status, 409);
  assert.equal(body.error, "accounting_intent_intake_lead_not_a_job");
  assert.equal(body.not_a_scheduled_job, true);
  assert.equal(body.not_a_money_intent, true);
});

test("a second tenant cannot read the first tenant's D1 intake lead", async () => {
  const db = new SqliteD1();
  const tenantA = ingestEnv(db, "ironwrap");
  const created = await ingestLead(tenantA);
  assert.equal(created.status, 200);

  const tenantB = ingestEnv(db, "acme-roofing");
  const leaked = await operatingIntake(tenantB, "owner", "acme-roofing");
  assert.equal(leaked.status, 200);
  const leads = leaked.json.leads as unknown[];
  assert.equal(leads.length, 0);

  const stolen = db.raw
    .prepare(
      `SELECT envelope_id FROM envelopes WHERE tenant_id = ? AND envelope_id = ?`,
    )
    .get("acme-roofing", created.json.envelope_id) as { envelope_id: string } | undefined;
  assert.equal(stolen, undefined);
});
