import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import type { NewoEventV1 } from "../src/newo.ts";
import { claimNewoReceipt } from "../src/newo-store.ts";
import { newoAdmissionJson } from "../src/newo-event-admission.ts";

const TENANT = "ironwrap";
const OTHER = "other-tenant";
const START = Date.now() - 10 * 60_000;
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

class BindingD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor(legacy?: (db: DatabaseSync) => void) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    if (legacy) {
      for (const name of names.filter((name) => !name.startsWith("0172_"))) {
        this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
      }
      legacy(this.sqlite);
      for (const name of names.filter((name) => name.startsWith("0172_"))) {
        this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
      }
    } else {
      for (const name of names) this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this.sqlite;
    const statement = (args: unknown[]) => ({
      bind: (...values: unknown[]) => statement(values),
      first: async <T>() => (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
      all: async <T>() => ({ success: true, results: db.prepare(sql).all(...(args as never[])) as T[] }),
      run: async () => {
        const before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
        db.prepare(sql).run(...(args as never[]));
        return { success: true, meta: { changes: Number(db.prepare("SELECT total_changes() AS n").get()!.n) - before } };
      },
    });
    return statement([]);
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function event(overrides: Partial<NewoEventV1> = {}): NewoEventV1 {
  return {
    schema_version: "newo.event.v1", event_id: "synthetic-event-1", session_id: "synthetic-session-1",
    event_type: "lead_captured", occurred_at: at(0),
    provider: { project_id: "synthetic-project", agent_id: "synthetic-agent", user_actor_id: null, conversation_id: null },
    channel: "phone", direction: "inbound",
    contact: { name: "Synthetic Caller", phone: "+15875550101", email: "caller@example.invalid",
      address: { line1: "1 Synthetic Street", city: "Edmonton", province: "AB", postal_code: "T5J 0N3" } },
    intent: { service: "Roof repair", division: "residential", urgency: "routine", message: "Synthetic callback" },
    consent: { ai_disclosed: true, recording_disclosed: true, follow_up_email: false, follow_up_phone: true },
    appointment: { request_id: null, preferred_windows: [], timezone: "America/Edmonton" },
    outcome: { status: null, summary: "Synthetic request", handoff_status: null, booking_status: null,
      transcript_ref: null, recording_ref: null, started_at: at(-60), ended_at: null, duration_seconds: null },
    handoff_summary: null,
    ...overrides,
  };
}

function runtime(DB: BindingD1, tenant = TENANT) {
  return {
    DB, APP_TENANT_ID: tenant, OPERATING_AUTOMATION_USER: "synthetic-worker",
    NEWO_ENABLED: "true", NEWO_WEBHOOK_TOKEN: "synthetic-newo-webhook", NEWO_BOOKING_MODE: "request_only",
    INGEST_TOKEN: "synthetic-ingest", ADMIN_TOKEN: "synthetic-admin", ERPNEXT_ENABLED: "false", JOBNIMBUS_ENABLED: "false",
    OWNER_ALERT_EMAIL: "owner@example.invalid", BACKUP_ALERT_EMAIL: "backup@example.invalid", FROM_EMAIL: "ops@example.invalid",
    RAW: { put: async () => {}, head: async () => null, get: async () => null },
    NEWO_QUEUE: { send: async () => {}, sendBatch: async () => {} }, JN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
}

async function post(env: Env, path: string, body: unknown) {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`https://binding.example.invalid${path}`, {
    method: "POST", headers: { authorization: "Bearer synthetic-newo-webhook", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise.catch(() => {})) } as never);
  await Promise.all(pending);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("a new event cannot adopt a session created by another trusted tenant", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  const first = event({ event_type: "handoff_requested", handoff_summary: "Synthetic request" });
  assert.equal((await post(runtime(DB), "/webhook/newo/handoff", first)).status, 200);
  const before = DB.sqlite.prepare("SELECT * FROM newo_sessions").get();
  const result = await post(runtime(DB, OTHER), "/webhook/newo/handoff", event({
    ...first, event_id: "foreign-event", occurred_at: at(60),
  }));
  assert.ok(result.status === 404 || result.status === 409, JSON.stringify(result));
  assert.deepEqual(DB.sqlite.prepare("SELECT * FROM newo_sessions").get(), before);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM newo_callback_records").get()!.n, 1);
});

test("caller lookup cannot adopt another tenant's session", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  const lookup = {
    schema_version: "newo.caller-lookup.v1", request_id: "lookup-first", session_id: "lookup-session", occurred_at: at(0),
    caller_phone: "+15875550101", provider: { project_id: "synthetic-project", agent_id: "synthetic-agent" },
    verification: { address_line1: null, postal_code: "T5J 0N3" },
  };
  assert.equal((await post(runtime(DB), "/webhook/newo/lookup", lookup)).status, 200);
  const before = DB.sqlite.prepare("SELECT * FROM newo_sessions").get();
  const result = await post(runtime(DB, OTHER), "/webhook/newo/lookup", {
    ...lookup, request_id: "foreign-lookup", occurred_at: at(60), caller_phone: "+15875550102",
  });
  assert.ok(result.status === 404 || result.status === 409, JSON.stringify(result));
  assert.deepEqual(DB.sqlite.prepare("SELECT * FROM newo_sessions").get(), before);
});

test("an unlinked legacy session never adopts the tenant of its next caller", async (t) => {
  const DB = new BindingD1((db) => db.prepare(`INSERT INTO newo_sessions (
    session_id, status, handoff_status, structured_json, raw_key, payload_hash, created_at, updated_at
  ) VALUES ('synthetic-session-1', 'active', 'requested', '{}', 'raw/newo/legacy.json', ?, ?, ?)`)
    .run("a".repeat(64), at(-120), at(-120)));
  t.after(() => DB.sqlite.close());
  const result = await post(runtime(DB), "/webhook/newo", event());
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM envelopes").get()!.n, 0);
});

test("an unrelated accepted event cannot bless a requested-callback insert", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  assert.equal((await post(runtime(DB), "/webhook/newo", event())).status, 200);
  assert.throws(() => DB.sqlite.prepare(`INSERT INTO newo_callback_records (
    callback_id, tenant_id, session_id, event_id, reason, urgency, contact_phone
  ) VALUES (?, ?, 'synthetic-session-1', 'synthetic-event-1', 'callback_requested', 'routine', '+15875550101')`)
    .run(`ncb_${"a".repeat(32)}`, TENANT), /newo_callback/);
});

test("an accepted late callback request survives a newer ordinary session projection", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  const newer = event({ event_id: "newer-report", event_type: "session_ended", occurred_at: at(120),
    outcome: { ...event().outcome, status: "completed", ended_at: at(120), duration_seconds: 180 } });
  assert.equal((await post(runtime(DB), "/webhook/newo/report", newer)).status, 200);
  const before = DB.sqlite.prepare("SELECT status, handoff_status, updated_at FROM newo_sessions").get();
  assert.equal((await post(runtime(DB), "/webhook/newo/handoff", event({
    event_id: "late-request", event_type: "handoff_requested", occurred_at: at(60), handoff_summary: "Late accepted request",
  }))).status, 200);
  assert.deepEqual(DB.sqlite.prepare("SELECT status, handoff_status, updated_at FROM newo_sessions").get(), before);
  assert.equal(DB.sqlite.prepare("SELECT event_id FROM newo_callback_records").get()!.event_id, "late-request");
});

test("producer tenant must be explicit and raw tenant labels never supply it", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  const env = runtime(DB) as unknown as Record<string, unknown>;
  delete env.APP_TENANT_ID;
  assert.equal((await post(env as unknown as Env, "/webhook/newo", event())).status, 503);
  assert.equal((await post(runtime(DB), "/webhook/newo", { ...event(), tenant_id: OTHER })).status, 422);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM newo_sessions").get()!.n, 0);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM newo_event_receipts").get()!.n, 0);
});

test("session and admitted-event identities reject direct mutation, delete and replace", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  assert.equal((await post(runtime(DB), "/webhook/newo", event())).status, 200);
  const session = DB.sqlite.prepare("SELECT * FROM newo_sessions").get()!;
  for (const assignment of [
    "tenant_id = 'other-tenant'", "tenant_binding_state = 'unbound'", "tenant_binding_source = 'legacy_job'",
    "tenant_binding_ref = 'another-event'", "session_id = 'another-session'", "created_at = 'changed'",
    "status = 'failed'", "handoff_status = 'requested'", "last_event_id = NULL",
  ]) {
    assert.throws(() => DB.sqlite.exec(`UPDATE newo_sessions SET ${assignment}`), /newo_session/);
  }
  assert.throws(() => DB.sqlite.exec("DELETE FROM newo_sessions"), /newo_session/);
  assert.throws(() => DB.sqlite.exec("INSERT OR REPLACE INTO newo_sessions SELECT * FROM newo_sessions"), /newo_session/);
  assert.deepEqual(DB.sqlite.prepare("SELECT * FROM newo_sessions").get(), session);
  const admission = DB.sqlite.prepare("SELECT * FROM newo_event_admissions").get()!;
  assert.throws(() => DB.sqlite.exec("UPDATE newo_event_admissions SET tenant_id = 'other-tenant'"), /newo_event_admission/);
  assert.throws(() => DB.sqlite.exec("DELETE FROM newo_event_admissions"), /newo_event_admission/);
  const columns = DB.sqlite.prepare("PRAGMA table_info(newo_event_admissions)").all().map((row) => String(row.name));
  assert.throws(() => DB.sqlite.exec(`INSERT OR REPLACE INTO newo_event_admissions (${columns.join(",")})
    SELECT ${columns.join(",")} FROM newo_event_admissions`), /newo_event_admission/);
  assert.deepEqual(DB.sqlite.prepare("SELECT * FROM newo_event_admissions").get(), admission);
});

test("claimed receipt identity, accepted response and attempt history are immutable", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  assert.equal((await post(runtime(DB), "/webhook/newo", event())).status, 200);
  const receipt = DB.sqlite.prepare("SELECT * FROM newo_event_receipts").get();
  for (const assignment of [
    "tenant_id = 'other-tenant'", "session_id = 'another-session'", "event_type = 'session_failed'",
    "payload_hash = 'changed'", "raw_key = 'raw/newo/changed.json'", "admission_json = '{}'",
    "status = 'processing'", "attempts = 0", "response_json = '{}'", "envelope_id = NULL",
  ]) {
    assert.throws(() => DB.sqlite.exec(`UPDATE newo_event_receipts SET ${assignment}`), /newo_receipt/);
  }
  assert.throws(() => DB.sqlite.exec("DELETE FROM newo_event_receipts"), /newo_receipt/);
  assert.throws(() => DB.sqlite.exec("INSERT OR REPLACE INTO newo_event_receipts SELECT * FROM newo_event_receipts"), /newo_receipt/);
  assert.deepEqual(DB.sqlite.prepare("SELECT * FROM newo_event_receipts").get(), receipt);
});

test("admitted facts require the claimed session, reported facts and canonical owned envelope", async (t) => {
  const DB = new BindingD1();
  t.after(() => DB.sqlite.close());
  const env = runtime(DB);
  assert.equal((await post(env, "/webhook/newo", event())).status, 200);
  assert.equal((await post(env, "/webhook/newo", event({ event_id: "other-session-event", session_id: "other-session" }))).status, 200);
  const session = DB.sqlite.prepare("SELECT * FROM newo_sessions WHERE session_id = ?").get(event().session_id)!;
  const foreignEnvelope = DB.sqlite.prepare("SELECT lead_envelope_id FROM newo_sessions WHERE session_id = 'other-session'").get()!.lead_envelope_id;
  const probeId = "claimed-admission-probe";
  await claimNewoReceipt(env, {
    event_id: probeId, session_id: event().session_id, event_type: "handoff_requested",
    payload_hash: "b".repeat(64), raw_key: "raw/newo/claimed-admission-probe.json",
    admission_json: newoAdmissionJson({ event_id: probeId, session_id: event().session_id,
      event_type: "handoff_requested", occurred_at: at(60), reported_handoff_status: null,
      reported_urgency: "routine", event_has_contact: 1 }),
  }, at(60));
  const columns = ["event_id", "tenant_id", "session_id", "event_type", "payload_sha256", "raw_key", "occurred_at",
    "envelope_id", "reported_handoff_status", "reported_urgency", "event_has_contact", "prior_status",
    "prior_handoff_status", "prior_urgency", "prior_has_contact"];
  const values = [probeId, TENANT, event().session_id, "handoff_requested", "b".repeat(64),
    "raw/newo/claimed-admission-probe.json", at(60), session.lead_envelope_id, null, "routine", 1,
    session.status, session.handoff_status, session.urgency, 1];
  for (const [name, value] of [
    ["tenant_id", OTHER], ["session_id", "other-session"], ["reported_handoff_status", "failed"],
    ["envelope_id", foreignEnvelope], ["prior_status", "failed"],
  ]) {
    const modified = [...values];
    modified[columns.indexOf(String(name))] = value;
    assert.throws(() => DB.sqlite.prepare(`INSERT INTO newo_event_admissions (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})`).run(...(modified as never[])), /newo_event_admission/);
  }
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM newo_event_admissions WHERE event_id = ?").get(probeId)!.n, 0);
});

function legacyOwner(db: DatabaseSync, sessionId: string, tenant: string, envelopeId: string) {
  db.prepare(`INSERT INTO envelopes (envelope_id, tenant_id, source, payload_json, raw_key, ts, status,
    dedup_key, created_at, updated_at) VALUES (?, ?, 'phone', ?, 'raw/newo/legacy.json', ?,
    'pending_jn_push', ?, ?, ?)`)
    .run(envelopeId, tenant, JSON.stringify({ provider: "newo", session_id: sessionId }), at(-60), envelopeId, at(-60), at(-60));
}

test("legacy original owned envelope binds identity; later calls never rewrite that evidence", async (t) => {
  const DB = new BindingD1((db) => {
    legacyOwner(db, "synthetic-session-1", TENANT, "legacy-owned-envelope");
    db.prepare(`INSERT INTO newo_sessions (session_id, status, structured_json, raw_key, payload_hash,
      lead_envelope_id, created_at, updated_at) VALUES (?, 'active', '{}', 'raw/newo/legacy.json', ?, ?, ?, ?)`)
      .run(event().session_id, "a".repeat(64), "legacy-owned-envelope", at(-60), at(-60));
  });
  t.after(() => DB.sqlite.close());
  const before = DB.sqlite.prepare("SELECT tenant_id, tenant_binding_state, tenant_binding_source, tenant_binding_ref FROM newo_sessions").get();
  assert.deepEqual({ ...before }, { tenant_id: TENANT, tenant_binding_state: "bound",
    tenant_binding_source: "legacy_envelope", tenant_binding_ref: "envelope:legacy-owned-envelope" });
  assert.equal((await post(runtime(DB), "/webhook/newo", event())).status, 200);
  assert.deepEqual(DB.sqlite.prepare("SELECT tenant_id, tenant_binding_state, tenant_binding_source, tenant_binding_ref FROM newo_sessions").get(), before);
});

test("conflicting original envelopes stay explicitly unbound and preserve child history", async (t) => {
  const DB = new BindingD1((db) => {
    legacyOwner(db, event().session_id, TENANT, "legacy-owned-envelope");
    legacyOwner(db, event().session_id, OTHER, "legacy-conflicting-envelope");
    db.prepare(`INSERT INTO newo_sessions (session_id, status, structured_json, raw_key, payload_hash,
      lead_envelope_id, created_at, updated_at) VALUES (?, 'active', '{}', 'raw/newo/legacy.json', ?, ?, ?, ?)`)
      .run(event().session_id, "a".repeat(64), "legacy-owned-envelope", at(-60), at(-60));
    db.prepare(`INSERT INTO newo_event_receipts (event_id, session_id, event_type, payload_hash, raw_key,
      envelope_id, status, first_seen_at, last_seen_at) VALUES ('conflicting-legacy-event', ?, 'lead_captured', ?,
      'raw/newo/legacy.json', 'legacy-conflicting-envelope', 'accepted', ?, ?)`)
      .run(event().session_id, "a".repeat(64), at(-60), at(-60));
  });
  t.after(() => DB.sqlite.close());
  assert.deepEqual({ ...DB.sqlite.prepare("SELECT tenant_id, tenant_binding_state FROM newo_sessions").get() },
    { tenant_id: null, tenant_binding_state: "conflict" });
  assert.equal((await post(runtime(DB), "/webhook/newo", event())).status, 409);
  assert.equal(DB.sqlite.prepare("SELECT status FROM newo_event_receipts").get()!.status, "accepted");
});
