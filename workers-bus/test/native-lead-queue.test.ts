import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import type { EnvelopeRecord } from "../src/core.ts";
import worker from "../src/index.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

class Statement {
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(statement: StatementSync, args: unknown[] = []) {
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new Statement(this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0090_operating_core.sql",
      "0082_envelope_operating_tenant.sql",
    ]) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
      );
    }
  }

  prepare(sql: string) {
    return new Statement(this.raw.prepare(sql));
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function envelope(
  status: EnvelopeRecord["status"] = "pending_jn_push",
): EnvelopeRecord {
  return {
    envelope_id: "ow_22222222-2222-4222-8222-222222222222",
    source: "website",
    contact_name: "Jane Doe",
    contact_phone: "+15875551234",
    contact_email: "jane@example.invalid",
    job_ref: null,
    payload_json: JSON.stringify({
      brand: "ironwrap",
      service: "metal roof",
      address: "1 Main Street",
      city: "Edmonton",
      province: "AB",
    }),
    raw_key: "raw/2026-08-21/ow_222.json",
    ts: "2026-08-21T10:00:00.000Z",
    status,
    dedup_key: "p:+15875551234",
    dup_of: null,
    attempts: 0,
    last_error: status === "erpnext_no_token" ? "erpnext_no_token" : null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: "residential_sales",
    created_at: "2026-08-21T10:00:00.000Z",
    updated_at: "2026-08-21T10:00:00.000Z",
  };
}

function seed(db: TestD1, rec: EnvelopeRecord): void {
  db.raw
    .prepare(
      `INSERT INTO envelopes (
       envelope_id, source, contact_name, contact_phone, contact_email, job_ref,
       payload_json, raw_key, ts, status, dedup_key, dup_of, attempts, last_error,
       jn_contact_id, jn_job_id, intent_queue, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.envelope_id,
      rec.source,
      rec.contact_name,
      rec.contact_phone,
      rec.contact_email,
      rec.job_ref,
      rec.payload_json,
      rec.raw_key,
      rec.ts,
      rec.status,
      rec.dedup_key,
      rec.dup_of,
      rec.attempts,
      rec.last_error,
      rec.jn_contact_id,
      rec.jn_job_id,
      rec.intent_queue,
      rec.created_at,
      rec.updated_at,
    );
}

function mockJobNimbus(t: TestContext): string[] {
  const urls: string[] = [];
  const records = new Map<string, Record<string, unknown>>();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      assert.equal(
        url.hostname,
        "app.jobnimbus.com",
        "retired Frappe must never be called",
      );
      const method = init?.method ?? "GET";
      const item = url.pathname.match(/\/api1\/(contacts|jobs)\/([^/]+)$/);
      if (method === "GET" && item) {
        return json(records.get(`${item[1]}:${item[2]}`) ?? {});
      }
      if (method === "GET") return json({ count: 0, results: [] });
      if (method === "POST" && url.pathname.endsWith("/contacts")) {
        const value = { ...JSON.parse(String(init?.body)), jnid: "C-1" };
        records.set("contacts:C-1", value);
        return json(value);
      }
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        const value = {
          ...JSON.parse(String(init?.body)),
          jnid: "J-1",
          number: "26-0001",
        };
        records.set("jobs:J-1", value);
        return json(value);
      }
      throw new Error(`unexpected JobNimbus request ${method} ${url}`);
    },
  );
  return urls;
}

async function runQueue(
  db: TestD1,
  rec: EnvelopeRecord,
  jobNimbusEnabled = "true",
  seedRecord = true,
): Promise<{ acked: number; retried: number }> {
  if (seedRecord) seed(db, rec);
  const env = withTestEffectRuntime({
    DB: db as never,
    APP_TENANT_ID: "ironwrap",
    OPERATING_AUTOMATION_USER: "ironwrap-worker",
    JOBNIMBUS_ENABLED: jobNimbusEnabled,
    JOBNIMBUS_API_KEY: "jn-key",
    JN_CONTACT_RECORD_TYPE: "Customer",
    JN_CONTACT_STATUS: "New",
    JN_JOB_RECORD_TYPE: "Retail",
    JN_JOB_STATUS: "Lead",
    ERPNEXT_ENABLED: "true",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
  });
  let acked = 0;
  let retried = 0;
  await worker.queue(
    {
      queue: "ironwrap-jn-push",
      messages: [
        {
          body: { envelope_id: rec.envelope_id },
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
      ],
    } as never,
    env as never,
    {} as never,
  );
  return { acked, retried };
}

test("lead queue materializes native authority, binds JobNimbus, and never calls Frappe", async (t) => {
  const db = new TestD1();
  const urls = mockJobNimbus(t);
  assert.deepEqual(await runQueue(db, envelope()), { acked: 1, retried: 0 });

  const stored = db.raw
    .prepare(
      `SELECT e.status, e.jn_contact_id, e.jn_job_id,
            j.job_number, j.jobnimbus_contact_id, j.jobnimbus_job_id, j.version
       FROM envelopes e
       JOIN operating_roof_jobs j ON j.source_envelope_id = e.envelope_id
      WHERE e.envelope_id = ?`,
    )
    .get(envelope().envelope_id);
  assert.deepEqual(
    { ...stored },
    {
      status: "pushed",
      jn_contact_id: "C-1",
      jn_job_id: "J-1",
      job_number: "26-0001",
      jobnimbus_contact_id: "C-1",
      jobnimbus_job_id: "J-1",
      version: 2,
    },
  );
  const audits = db.raw
    .prepare("SELECT automation, action FROM audit_log ORDER BY id")
    .all() as Array<{ automation: string; action: string }>;
  assert.equal(
    audits.some(({ automation }) => automation === "erpnext_push"),
    false,
  );
  assert.equal(
    audits.some(
      ({ automation, action }) =>
        automation === "operating_core" &&
        action === "bind_jobnimbus_transport",
    ),
    true,
  );
  assert.ok(urls.length > 0);
});

test("a legacy erpnext_no_token envelope is recovered through the native queue", async (t) => {
  const db = new TestD1();
  mockJobNimbus(t);
  assert.deepEqual(await runQueue(db, envelope("erpnext_no_token")), {
    acked: 1,
    retried: 0,
  });
  const stored = db.raw
    .prepare(
      "SELECT status, last_error, jn_contact_id, jn_job_id FROM envelopes WHERE envelope_id = ?",
    )
    .get(envelope().envelope_id);
  assert.deepEqual(
    { ...stored },
    {
      status: "pushed",
      last_error: null,
      jn_contact_id: "C-1",
      jn_job_id: "J-1",
    },
  );
});

test("disabled JobNimbus still lands native authority and records a truthful skip", async (t) => {
  const db = new TestD1();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("disabled_bridge_must_not_fetch");
  });

  assert.deepEqual(await runQueue(db, envelope(), "false"), {
    acked: 1,
    retried: 0,
  });
  const stored = db.raw
    .prepare(
      `SELECT e.status, e.last_error, j.roof_job_id
       FROM envelopes e
       JOIN operating_roof_jobs j ON j.source_envelope_id = e.envelope_id
      WHERE e.envelope_id = ?`,
    )
    .get(envelope().envelope_id);
  assert.match(
    String((stored as { roof_job_id: string }).roof_job_id),
    /^job:ironwrap:/,
  );
  assert.deepEqual(
    {
      status: (stored as { status: string }).status,
      last_error: (stored as { last_error: string }).last_error,
    },
    {
      status: "jn_skipped",
      last_error: "jobnimbus_disabled",
    },
  );
  assert.equal(fetches, 0);
  assert.equal(
    Number(
      (
        db.raw.prepare("SELECT COUNT(*) AS count FROM dead_letter").get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );
});

test("a jn_skipped redelivery is a no-op acknowledgement", async (t) => {
  const db = new TestD1();
  const skipped = {
    ...envelope("jn_skipped"),
    last_error: "jobnimbus_disabled",
  };
  seed(db, skipped);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("terminal_redelivery_must_not_fetch");
  });

  assert.deepEqual(await runQueue(db, skipped, "false", false), {
    acked: 1,
    retried: 0,
  });
  assert.equal(fetches, 0);
  assert.equal(
    Number(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM operating_roof_jobs")
          .get() as { count: number }
      ).count,
    ),
    0,
  );
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
