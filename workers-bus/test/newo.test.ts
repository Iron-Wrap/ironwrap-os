import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { resetGoogleAdapterStateForTest } from "../src/google.ts";
import { sendOwnerAlert } from "../src/notify.ts";
import {
  canonicalJson,
  handleNewoQueueMessage,
  newoHandoffStatus,
  newoCallbackRecordInput,
  newoOwnerAlertMarker,
  newoOwnerAlerts,
  newoUrgency,
  parseNewoEvent,
  reconcileNewoSessions,
  sweepNewoCallbackAlerts,
  sha256Hex,
  type NewoEventV1,
} from "../src/newo.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import { listNewoCallbacksForAlert, type NewoSessionRecord } from "../src/newo-store.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

type Row = Record<string, unknown>;

class NativeNewoD1 {
  readonly raw = new DatabaseSync(":memory:");
  failNextSyncUpdate = false;
  readonly calls: Array<{ sql: string; args: unknown[] }> = [];

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0001_init.sql",
      "0004_estimate_idempotency.sql",
      "0009_replay_approval_audit.sql",
      "0023_newo_reception.sql",
      "0024_newo_caller_association.sql",
      "0025_newo_control_evidence.sql",
      "0026_newo_reconciliation.sql",
      "0090_operating_core.sql",
      "0082_envelope_operating_tenant.sql",
      // insertEnvelope writes release_smoke (IRO-264).
      "0133_envelope_release_smoke.sql",
      // The callback record (0168) and the resolution guard it re-creates (0151).
      "0151_newo_handoff_resolutions.sql",
      "0168_newo_callback_records.sql",
      "0172_newo_tenant_event_admission.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string): NativeNewoStatement {
    return new NativeNewoStatement(this, sql, []);
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<void> {
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  consumeSyncFailure(sql: string): boolean {
    if (!this.failNextSyncUpdate || !sql.includes("UPDATE newo_sessions") || !sql.includes("SET sync_status")) {
      return false;
    }
    this.failNextSyncUpdate = false;
    return true;
  }
}

class NativeNewoStatement {
  private readonly db: NativeNewoD1;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(
    db: NativeNewoD1,
    sql: string,
    args: unknown[],
  ) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): NativeNewoStatement {
    return new NativeNewoStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    return (this.db.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    return { results: this.db.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    if (this.db.consumeSyncFailure(this.sql)) throw new Error("simulated_sync_status_loss");
    const result = this.db.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function newoEvent(overrides: Partial<NewoEventV1> = {}): NewoEventV1 {
  return {
    schema_version: "newo.event.v1",
    event_id: "event-001",
    session_id: "session-001",
    event_type: "lead_captured",
    occurred_at: "2026-07-18T18:00:00.000Z",
    provider: {
      project_id: "project-production",
      agent_id: "agent-sofia",
      user_actor_id: "actor-001",
      conversation_id: "conversation-001",
    },
    channel: "phone",
    direction: "inbound",
    contact: {
      name: "Newo Caller",
      phone: "+1 (587) 555-7788",
      email: "CALLER@example.com",
      address: {
        line1: "123 Main Street",
        city: "Edmonton",
        province: "AB",
        postal_code: "T5J 0N3",
      },
    },
    intent: {
      service: "Metal roof quote",
      division: "residential",
      urgency: "routine",
      message: "Looking for a replacement roof.",
    },
    consent: {
      ai_disclosed: true,
      recording_disclosed: true,
      follow_up_email: true,
      follow_up_phone: true,
    },
    appointment: {
      request_id: null,
      preferred_windows: [],
      timezone: "America/Edmonton",
    },
    outcome: {
      status: null,
      summary: "Caller requested a metal roofing estimate.",
      handoff_status: null,
      booking_status: null,
      transcript_ref: "newo:transcript:session-001",
      recording_ref: "https://provider.example/recordings/session-001",
      started_at: "2026-07-18T17:58:00.000Z",
      ended_at: null,
      duration_seconds: null,
    },
    handoff_summary: null,
    ...overrides,
  };
}

function callerLookup() {
  return {
    schema_version: "newo.caller-lookup.v1",
    request_id: "lookup-001",
    session_id: "session-001",
    occurred_at: "2026-07-18T17:57:00.000Z",
    caller_phone: "(587) 555-7788",
    provider: { project_id: "project-production", agent_id: "agent-sofia" },
    verification: { address_line1: "123 Main Street", postal_code: "T5J 0N3" },
  };
}

function fakeNewoEnv() {
  // Real SQLite executes the admission transaction and every integrity guard. The collections
  // below are read-only snapshots for the older route assertions, rather than a SQL-string fake.
  const state = nativeNewoState();
  const rows = (table: string, key: string) => new Map(state.db.raw.prepare(`SELECT * FROM ${table}`)
    .all().map((row) => [String(row[key]), row]));
  return {
    ...state, calls: state.db.calls,
    env: { ...state.env, INGEST_TOKEN: "ingest-token", ADMIN_TOKEN: "admin-token", ERPNEXT_ENABLED: "false" },
    get receipts() { return rows("newo_event_receipts", "event_id"); },
    get sessions() { return rows("newo_sessions", "session_id"); },
    get callbacks() { return rows("newo_callback_records", "callback_id"); },
    get envelopes() { return rows("envelopes", "envelope_id"); },
  };
}

function nativeNewoState(db = new NativeNewoD1(), tenant = "ironwrap") {
  const raw: Array<{ key: string; body: string }> = [];
  const jnQueue: Array<{ envelope_id: string }> = [];
  const newoQueue: Array<{ newo_event_id: string }> = [];
  const env = {
    APP_TENANT_ID: tenant,
    OPERATING_AUTOMATION_USER: "ironwrap-worker",
    NEWO_ENABLED: "true",
    NEWO_WEBHOOK_TOKEN: "newo-webhook-token",
    NEWO_BOOKING_TOKEN: "newo-booking-token",
    NEWO_BOOKING_MODE: "request_only",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "owner@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://frappe.invalid",
    ERPNEXT_API_KEY: "must-not-be-used",
    ERPNEXT_API_SECRET: "must-not-be-used",
    DEDUP_WINDOW_HOURS: "72",
    STUCK_THRESHOLD_MIN: "15",
    RAW: {
      put: async (key: string, body: string) => { raw.push({ key, body }); },
    },
    JN_QUEUE: {
      send: async (message: { envelope_id: string }) => { jnQueue.push(message); },
      sendBatch: async () => {},
    },
    NEWO_QUEUE: {
      send: async (message: { newo_event_id: string }) => { newoQueue.push(message); },
    },
    DB: db as never,
  };
  return { env, db, raw, jnQueue, newoQueue };
}

async function seedNativeOperatingJob(
  db: NativeNewoD1,
  tenant: string,
  options: {
    suffix?: string;
    addressLine1?: string;
    postalCode?: string;
    occurredAt?: string;
  } = {},
): Promise<{ customer_id: string; property_id: string; property_key: string; roof_job_id: string }> {
  const suffix = options.suffix ? `_${options.suffix}` : "";
  const addressLine1 = options.addressLine1 ?? "123 Main Street";
  const postalCode = options.postalCode ?? "T5J 0N3";
  const occurredAt = options.occurredAt ?? "2026-07-18T16:00:00.000Z";
  const rec: EnvelopeRecord = {
    envelope_id: `ow_seed_${tenant}${suffix}`,
    source: "phone",
    contact_name: "Existing Customer",
    contact_phone: "+15875557788",
    contact_email: "caller@example.com",
    job_ref: null,
    payload_json: JSON.stringify({
      address_line1: addressLine1,
      city: "Edmonton",
      province: "AB",
      postal_code: postalCode,
      service: "metal roof",
    }),
    raw_key: `raw/seed/${tenant}${suffix}.json`,
    ts: occurredAt,
    status: "reconciled",
    dedup_key: `seed:${tenant}${suffix}`,
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: "residential_sales",
    created_at: occurredAt,
    updated_at: occurredAt,
  };
  db.raw.prepare(
    `INSERT INTO envelopes (
       envelope_id, source, contact_name, contact_phone, contact_email, job_ref, payload_json,
       raw_key, ts, status, dedup_key, dup_of, attempts, last_error, jn_contact_id, jn_job_id,
       estimate_submission_key, intent_queue, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
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
  await materializeOperatingCore({
    DB: db as never,
    APP_TENANT_ID: tenant,
    OPERATING_AUTOMATION_USER: "ironwrap-worker",
  } as never, rec);
  return db.raw.prepare(
    `SELECT c.customer_id, p.property_id, p.property_key, j.roof_job_id
       FROM operating_roof_jobs j
       JOIN operating_customers c
         ON c.tenant_id = j.tenant_id AND c.customer_id = j.customer_id
       JOIN operating_properties p
         ON p.tenant_id = j.tenant_id AND p.property_id = j.property_id
      WHERE j.tenant_id = ? AND j.source_envelope_id = ?`,
  ).get(tenant, rec.envelope_id) as {
    customer_id: string;
    property_id: string;
    property_key: string;
    roof_job_id: string;
  };
}

function tenantRows(db: NativeNewoD1, table: string, tenant = "ironwrap"): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`)
    .get(tenant) as { count: number }).count);
}

const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}) };

function request(path: string, event: NewoEventV1, token = "newo-webhook-token"): Request {
  return new Request(`https://bus.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

test("strict event parser normalizes contact data and rejects transcript content", () => {
  const valid = parseNewoEvent(JSON.stringify(newoEvent()));
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.contact.phone, "+15875557788");
    assert.equal(valid.value.contact.email, "caller@example.com");
  }
  const withTranscript = { ...newoEvent(), transcript: "verbatim caller text" };
  const invalid = parseNewoEvent(JSON.stringify(withTranscript));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.ok(invalid.issues.includes("$.transcript is not allowed"));
});

test("canonical hashing ignores JSON property order", async () => {
  const first = { z: 1, a: { y: 2, x: 3 } };
  const second = { a: { x: 3, y: 2 }, z: 1 };
  assert.equal(await sha256Hex(canonicalJson(first)), await sha256Hex(canonicalJson(second)));
});

test("bad credentials and malformed payload create no R2 or D1 business record", async () => {
  const state = fakeNewoEnv();
  const denied = await worker.fetch(
    request("/webhook/newo", newoEvent(), "wrong-token"),
    state.env as never,
    ctx as never,
  );
  assert.equal(denied.status, 401);

  const malformed = { ...newoEvent(), transcript: "must not be retained" };
  const invalid = await worker.fetch(new Request("https://bus.example/webhook/newo", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify(malformed),
  }), state.env as never, ctx as never);
  assert.equal(invalid.status, 422);
  assert.equal(state.raw.length, 0);
  assert.equal(state.receipts.size, 0);
  assert.equal(state.envelopes.size, 0);
});

test("accepted event replays the original receipt without another lead or queue delivery", async () => {
  const state = fakeNewoEnv();
  const event = newoEvent();
  const first = await worker.fetch(request("/webhook/newo", event), state.env as never, ctx as never);
  const original = await first.text();
  const replay = await worker.fetch(request("/webhook/newo", event), state.env as never, ctx as never);

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), original);
  assert.equal(replay.headers.get("x-newo-replay"), "true");
  assert.equal(state.raw.length, 1);
  assert.equal(state.envelopes.size, 1);
  assert.equal(state.jnQueue.length, 1);
  assert.equal(state.newoQueue.length, 1);
});

test("same event id with changed content returns 409 and creates conflict evidence", async () => {
  const state = fakeNewoEnv();
  const event = newoEvent();
  const first = await worker.fetch(request("/webhook/newo", event), state.env as never, ctx as never);
  assert.equal(first.status, 200);
  const conflicting = newoEvent({ intent: { ...event.intent, service: "Commercial roof" } });
  const conflict = await worker.fetch(request("/webhook/newo", conflicting), state.env as never, ctx as never);
  assert.equal(conflict.status, 409);
  assert.equal(state.envelopes.size, 1);
  assert.equal(state.raw.length, 2);
  assert.match(state.raw[1].key, /^raw\/newo\/conflicts\//);
  assert.ok(state.calls.some(({ sql, args }) => sql.includes("INSERT INTO dead_letter") && args.includes("newo_event_conflict")));
});

test("the same caller in two Newo sessions creates two owned leads", async () => {
  const state = fakeNewoEnv();
  const first = await worker.fetch(request("/webhook/newo", newoEvent()), state.env as never, ctx as never);
  const secondEvent = newoEvent({ event_id: "event-002", session_id: "session-002" });
  const second = await worker.fetch(request("/webhook/newo", secondEvent), state.env as never, ctx as never);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(state.envelopes.size, 2);
  assert.equal(state.jnQueue.length, 2);
  assert.deepEqual([...state.envelopes.values()].map((row) => row.dedup_key).sort(), [
    "newo-session:session-001",
    "newo-session:session-002",
  ]);
});

test("request-only booking returns request language and a durable appointment id", async () => {
  const state = fakeNewoEnv();
  const lead = newoEvent();
  await worker.fetch(request("/webhook/newo", lead), state.env as never, ctx as never);
  const booking = newoEvent({
    event_id: "event-booking-001",
    event_type: "booking_requested",
    appointment: {
      request_id: null,
      timezone: "America/Edmonton",
      preferred_windows: [{ start: "2026-07-21T16:00:00.000Z", end: "2026-07-21T18:00:00.000Z" }],
    },
  });
  const response = await worker.fetch(
    request("/webhook/newo/booking", booking, "newo-booking-token"),
    state.env as never,
    ctx as never,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.booking_mode, "request_only");
  assert.equal(body.booking_status, "requested");
  assert.match(String(body.appointment_request_id), /^nar_[0-9a-f-]{36}$/);
  assert.equal(body.message, "Appointment request received.");
  assert.doesNotMatch(JSON.stringify(body), /\b(booked|confirmed)\b/i);
});

test("verified caller lookup returns only broad state and privately binds the later lead", async (t) => {
  const state = fakeNewoEnv();
  const frappeCalls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    frappeCalls.push(String(input));
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const existing = await seedNativeOperatingJob(state.db, "ironwrap");
  state.db.raw.prepare("UPDATE operating_roof_jobs SET job_status = 'in_progress', version = version + 1").run();
  state.calls.length = 0;
  const lookupResponse = await worker.fetch(new Request("https://bus.example/webhook/newo/lookup", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify(callerLookup()),
  }), state.env as never, ctx as never);
  const lookupBody = await lookupResponse.json() as Record<string, unknown>;

  assert.equal(lookupResponse.status, 200);
  assert.deepEqual(lookupBody, {
    schema_version: "newo.caller-lookup-response.v1",
    request_id: "lookup-001",
    session_id: "session-001",
    match_status: "verified",
    verified: true,
    job_state: "In progress",
    safe_next_step: "continue_verified_service",
  });
  assert.doesNotMatch(JSON.stringify(lookupBody), /RC-PRIVATE|RJ-PRIVATE|customer:|property:/);
  assert.equal(frappeCalls.length, 0);
  const nativeReads = state.calls.filter(({ sql }) =>
    sql.includes("FROM operating_customers") || sql.includes("FROM operating_roof_jobs")
  );
  assert.equal(nativeReads.length, 2);
  assert.ok(nativeReads.every(({ args }) => args[0] === "ironwrap"));

  const capture = await worker.fetch(
    request("/webhook/newo", newoEvent()),
    state.env as never,
    ctx as never,
  );
  assert.equal(capture.status, 200);
  assert.equal(state.jnQueue.length, 0);
  const envelope = state.db.raw.prepare("SELECT envelope.* FROM envelopes envelope JOIN newo_sessions session ON session.lead_envelope_id = envelope.envelope_id WHERE session.session_id = ?").get("session-001")!;
  const payload = JSON.parse(String(envelope.payload_json));
  assert.deepEqual(payload.owned_association, {
    customer_id: existing.customer_id,
    property_key: existing.property_key,
    roof_job_id: existing.roof_job_id,
    verification_status: "verified",
  });
});

test("multiple verified jobs fail closed without dispatching a downstream lead", async () => {
  const state = fakeNewoEnv();
  await seedNativeOperatingJob(state.db, "ironwrap");
  await seedNativeOperatingJob(state.db, "ironwrap", { suffix: "second" });

  const lookup = await worker.fetch(new Request("https://bus.example/webhook/newo/lookup", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify(callerLookup()),
  }), state.env as never, ctx as never);
  assert.deepEqual(await lookup.json(), {
    schema_version: "newo.caller-lookup-response.v1",
    request_id: "lookup-001",
    session_id: "session-001",
    match_status: "ambiguous",
    verified: false,
    job_state: null,
    safe_next_step: "offer_staff_callback",
  });

  const capture = await worker.fetch(request("/webhook/newo", newoEvent()), state.env as never, ctx as never);
  assert.equal(capture.status, 200);
  assert.equal(state.jnQueue.length, 0);
  assert.equal(state.newoQueue.length, 1);
  const payload = JSON.parse(String(state.db.raw.prepare("SELECT envelope.payload_json FROM envelopes envelope JOIN newo_sessions session ON session.lead_envelope_id = envelope.envelope_id WHERE session.session_id = ?").get("session-001")!.payload_json));
  assert.equal(payload.owned_association, undefined);
});

test("native Newo projection survives a lost status response and reuses exact D1 identities", async (t) => {
  const state = nativeNewoState();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("frappe_must_not_be_called");
  });
  const accepted = await worker.fetch(
    request("/webhook/newo", newoEvent()),
    state.env as never,
    ctx as never,
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(state.newoQueue, [{ newo_event_id: "event-001" }]);
  assert.deepEqual(state.jnQueue.length, 1);

  state.db.failNextSyncUpdate = true;
  await assert.rejects(
    handleNewoQueueMessage(state.env as never, "event-001", false),
    /simulated_sync_status_loss/,
  );
  assert.equal(tenantRows(state.db, "operating_leads"), 1);
  assert.equal(tenantRows(state.db, "operating_customers"), 1);
  assert.equal(tenantRows(state.db, "operating_properties"), 1);
  assert.equal(tenantRows(state.db, "operating_roof_jobs"), 1);
  assert.equal(tenantRows(state.db, "operating_production_gates"), 7);

  await handleNewoQueueMessage(state.env as never, "event-001", false);
  assert.equal(fetches, 0);
  assert.equal(tenantRows(state.db, "operating_leads"), 1);
  assert.equal(tenantRows(state.db, "operating_roof_jobs"), 1);
  const session = state.db.raw.prepare(
    "SELECT sync_status, sync_attempts, last_error FROM newo_sessions WHERE session_id = ?",
  ).get("session-001") as Row;
  assert.equal(session.sync_status, "synced");
  assert.equal(session.sync_attempts, 2);
  assert.equal(session.last_error, null);
  const property = state.db.raw.prepare(
    "SELECT address_line1 FROM operating_properties WHERE tenant_id = 'ironwrap'",
  ).get() as Row;
  const job = state.db.raw.prepare(
    "SELECT service_type FROM operating_roof_jobs WHERE tenant_id = 'ironwrap'",
  ).get() as Row;
  assert.equal(property.address_line1, "123 Main Street");
  assert.equal(job.service_type, "Metal Roofing");
  const audit = state.db.raw.prepare(
    "SELECT action, target_ids FROM audit_log WHERE automation = 'newo_native_projection'",
  ).get() as Row;
  assert.equal(audit.action, "readback");
  assert.match(String(audit.target_ids), /newo_session:session-001,lead:lead:ironwrap:/);
});

test("verified Newo sessions read back the exact native job and never create a duplicate lead", async (t) => {
  const state = nativeNewoState();
  const existing = await seedNativeOperatingJob(state.db, "ironwrap");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("frappe_must_not_be_called");
  });
  const lookup = await worker.fetch(new Request("https://bus.example/webhook/newo/lookup", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify(callerLookup()),
  }), state.env as never, ctx as never);
  const lookupBody = await lookup.json() as Row;
  const lookupReceipt = state.db.raw.prepare(
    "SELECT status, last_error FROM newo_event_receipts WHERE event_id = 'lookup-001'",
  ).get();
  assert.equal(lookup.status, 200, JSON.stringify({ lookupBody, lookupReceipt }));
  assert.equal(lookupBody.match_status, "verified");

  const capture = await worker.fetch(request("/webhook/newo", newoEvent()), state.env as never, ctx as never);
  assert.equal(capture.status, 200);
  assert.equal(state.jnQueue.length, 0);
  await handleNewoQueueMessage(state.env as never, "event-001", false);
  await handleNewoQueueMessage(state.env as never, "event-001", false);

  assert.equal(fetches, 0);
  assert.equal(tenantRows(state.db, "operating_leads"), 1);
  assert.equal(tenantRows(state.db, "operating_roof_jobs"), 1);
  const audit = state.db.raw.prepare(
    `SELECT target_ids FROM audit_log
      WHERE automation = 'newo_native_projection' ORDER BY id DESC LIMIT 1`,
  ).get() as Row;
  assert.match(String(audit.target_ids), new RegExp(`customer:${existing.customer_id}`));
  assert.match(String(audit.target_ids), new RegExp(`property:${existing.property_id}`));
  assert.match(String(audit.target_ids), new RegExp(`roof_job:${existing.roof_job_id}`));
});

test("verified Newo association cannot cross the configured tenant boundary", async (t) => {
  const state = nativeNewoState();
  const foreign = await seedNativeOperatingJob(state.db, "other-tenant");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    throw new Error("frappe_must_not_be_called");
  });
  const capture = await worker.fetch(request("/webhook/newo", newoEvent()), state.env as never, ctx as never);
  assert.equal(capture.status, 200);
  assert.throws(() => state.db.raw.prepare(
    `UPDATE newo_sessions SET verification_status = 'verified', matched_customer_id = ?,
      matched_property_id = ?, matched_roof_job_id = ? WHERE session_id = 'session-001'`,
  ).run(foreign.customer_id, foreign.property_key, foreign.roof_job_id), /newo_session_event_invalid/);
  const stored = state.db.raw.prepare("SELECT verification_status, matched_roof_job_id FROM newo_sessions").get()!;
  assert.equal(stored.matched_roof_job_id, null);
  await handleNewoQueueMessage(state.env as never, "event-001", false);
  assert.equal(fetches, 0);
  assert.equal(tenantRows(state.db, "operating_leads"), 1);
  assert.equal(tenantRows(state.db, "operating_roof_jobs"), 1);
  assert.equal(tenantRows(state.db, "operating_roof_jobs", "other-tenant"), 1);

});

test("out-of-order caller lookups cannot replace or clear a newer verified association", async () => {
  const state = nativeNewoState();
  const firstJob = await seedNativeOperatingJob(state.db, "ironwrap");
  const newerJob = await seedNativeOperatingJob(state.db, "ironwrap", {
    suffix: "newer",
    addressLine1: "456 Jasper Avenue",
    postalCode: "T5K 0L5",
    occurredAt: "2026-07-18T16:30:00.000Z",
  });
  const lookup = callerLookup();
  const sendLookup = (overrides: Partial<typeof lookup>) => worker.fetch(new Request(
    "https://bus.example/webhook/newo/lookup",
    {
      method: "POST",
      headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
      body: JSON.stringify({ ...lookup, ...overrides }),
    },
  ), state.env as never, ctx as never);

  const newerResponse = await sendLookup({
    request_id: "lookup-newer",
    occurred_at: "2026-07-18T18:10:00.000Z",
    verification: { address_line1: "456 Jasper Avenue", postal_code: "T5K 0L5" },
  });
  assert.equal(newerResponse.status, 200);

  const staleVerifiedResponse = await sendLookup({
    request_id: "lookup-stale-verified",
    occurred_at: "2026-07-18T17:00:00.000Z",
    verification: { address_line1: "123 Main Street", postal_code: "T5J 0N3" },
  });
  assert.equal(staleVerifiedResponse.status, 409);
  assert.deepEqual(await staleVerifiedResponse.json(), {
    error: "caller_lookup_stale",
    request_id: "lookup-stale-verified",
    session_id: "session-001",
  });

  const afterStaleVerified = state.db.raw.prepare(
    `SELECT matched_customer_id, matched_property_id, matched_roof_job_id,
            verification_status, updated_at
       FROM newo_sessions WHERE session_id = 'session-001'`,
  ).get() as Row;
  assert.equal(afterStaleVerified.matched_customer_id, newerJob.customer_id);
  assert.equal(afterStaleVerified.matched_property_id, newerJob.property_key);
  assert.equal(afterStaleVerified.matched_roof_job_id, newerJob.roof_job_id);
  assert.equal(afterStaleVerified.verification_status, "verified");
  assert.equal(afterStaleVerified.updated_at, "2026-07-18T18:10:00.000Z");
  assert.notEqual(afterStaleVerified.matched_roof_job_id, firstJob.roof_job_id);

  const staleReplay = await sendLookup({
    request_id: "lookup-stale-verified",
    occurred_at: "2026-07-18T17:00:00.000Z",
    verification: { address_line1: "123 Main Street", postal_code: "T5J 0N3" },
  });
  assert.equal(staleReplay.status, 409);
  assert.equal(staleReplay.headers.get("x-newo-replay"), "true");

  const staleNonverifiedResponse = await sendLookup({
    request_id: "lookup-stale-nonverified",
    occurred_at: "2026-07-18T17:30:00.000Z",
    verification: { address_line1: "999 Unknown Road", postal_code: "T0T 0T0" },
  });
  assert.equal(staleNonverifiedResponse.status, 409);
  assert.deepEqual(await staleNonverifiedResponse.json(), {
    error: "caller_lookup_stale",
    request_id: "lookup-stale-nonverified",
    session_id: "session-001",
  });

  const durable = state.db.raw.prepare(
    `SELECT matched_customer_id, matched_property_id, matched_roof_job_id,
            verification_status, updated_at
       FROM newo_sessions WHERE session_id = 'session-001'`,
  ).get() as Row;
  assert.equal(durable.matched_customer_id, newerJob.customer_id);
  assert.equal(durable.matched_property_id, newerJob.property_key);
  assert.equal(durable.matched_roof_job_id, newerJob.roof_job_id);
  assert.equal(durable.verification_status, "verified");
  assert.equal(durable.updated_at, "2026-07-18T18:10:00.000Z");
});

test("caller lookup requires address or postal verification before any durable write", async () => {
  const state = fakeNewoEnv();
  const payload = callerLookup();
  payload.verification = { address_line1: null, postal_code: null };
  const response = await worker.fetch(new Request("https://bus.example/webhook/newo/lookup", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), state.env as never, ctx as never);
  assert.equal(response.status, 422);
  assert.equal(state.raw.length, 0);
  assert.equal(state.receipts.size, 0);
  assert.equal(state.sessions.size, 0);
});

// Callback only (owner decisions MD-05 and D-03): "requested" is the routine handoff status and
// opens a callback; "failed" means the handoff request did not arrive or could not be processed.
function handoffEvent(overrides: Partial<NewoEventV1> = {}): NewoEventV1 {
  return newoEvent({
    event_id: "event-handoff-001",
    event_type: "handoff_requested",
    handoff_summary: "Caller asked for a person.",
    ...overrides,
  });
}

function alertSubjects(event: NewoEventV1): Array<[string, string]> {
  return newoOwnerAlerts(event).map((alert) => [alert.kind, alert.subject]);
}

test("a requested handoff alerts staff to call back, urgently only when the caller's urgency says so", () => {
  for (const [urgency, subject] of [
    ["routine", "Newo callback requested"],
    ["urgent", "Urgent Newo callback requested - urgent"],
    ["emergency", "Urgent Newo callback requested - emergency"],
  ] as const) {
    const event = handoffEvent({
      intent: { ...newoEvent().intent, urgency },
      outcome: { ...newoEvent().outcome, handoff_status: "requested" },
    });
    assert.equal(newoHandoffStatus(event), "requested", urgency);
    assert.deepEqual(alertSubjects(event), [["handoff", subject]], urgency);
  }
});

test("a failed handoff or a failed session still raises the urgent failure alert", () => {
  const report = (handoffStatus: string | null, eventType: NewoEventV1["event_type"] = "session_ended") =>
    newoEvent({
      event_id: "event-report-001",
      event_type: eventType,
      outcome: { ...newoEvent().outcome, handoff_status: handoffStatus },
    });
  assert.deepEqual(alertSubjects(report("failed")), [["failure", "Urgent Newo callback required"]]);
  assert.deepEqual(alertSubjects(report(null, "session_failed")), [["failure", "Urgent Newo callback required"]]);
  assert.deepEqual(alertSubjects(report("requested")), []);
  assert.deepEqual(alertSubjects(report(null)), []);
});

test("a handoff request is stored as requested, never failed, and a reported failure stays failed", async () => {
  for (const handoffStatus of [null, "requested"]) {
    const state = fakeNewoEnv();
    const response = await worker.fetch(
      request("/webhook/newo/handoff", handoffEvent({ outcome: { ...newoEvent().outcome, handoff_status: handoffStatus } })),
      state.env as never,
      ctx as never,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(state.sessions.get("session-001")?.handoff_status, "requested", String(handoffStatus));
  }

  const state = fakeNewoEnv();
  const report = newoEvent({
    event_id: "event-report-001",
    event_type: "session_ended",
    outcome: {
      ...newoEvent().outcome,
      handoff_status: "failed",
      ended_at: "2026-07-18T18:05:00.000Z",
      duration_seconds: 420,
    },
  });
  const response = await worker.fetch(request("/webhook/newo/report", report), state.env as never, ctx as never);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(state.sessions.get("session-001")?.handoff_status, "failed");
});

// The session the Worker already holds, for the precedence and work-list rules below.
function storedSession(overrides: Partial<NewoSessionRecord> = {}): NewoSessionRecord {
  return {
    session_id: "session-001",
    project_id: null,
    agent_id: null,
    user_actor_id: null,
    conversation_id: null,
    channel: "phone",
    direction: "inbound",
    status: "handoff_requested",
    outcome: null,
    contact_name: "Stored Caller",
    contact_phone: "+15875550142",
    contact_email: null,
    address_line1: "9 Stored Road",
    city: "Edmonton",
    province: "AB",
    postal_code: "T5J 0N9",
    division: "residential",
    service: null,
    urgency: "routine",
    lead_envelope_id: null,
    appointment_request_id: null,
    handoff_status: null,
    booking_status: null,
    summary: null,
    transcript_ref: null,
    recording_ref: null,
    ai_disclosed: 1,
    recording_disclosed: 1,
    structured_json: "{}",
    raw_key: "raw/newo/events/stored.json",
    payload_hash: "e".repeat(64),
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    report_expected_at: null,
    report_received_at: null,
    report_event_id: null,
    missing_report_detected_at: null,
    sync_status: "synced",
    sync_attempts: 0,
    last_error: null,
    sync_updated_at: null,
    created_at: "2026-07-18T17:58:00.000Z",
    updated_at: "2026-07-18T17:59:00.000Z",
    ...overrides,
  };
}

function closingReport(urgency: NewoEventV1["intent"]["urgency"], handoffStatus: NewoEventV1["outcome"]["handoff_status"] = null,
  eventType: NewoEventV1["event_type"] = "session_ended"): NewoEventV1 {
  return newoEvent({
    event_id: "event-report-002",
    event_type: eventType,
    intent: { ...newoEvent().intent, urgency },
    outcome: { ...newoEvent().outcome, handoff_status: handoffStatus, ended_at: "2026-07-18T18:05:00.000Z", duration_seconds: 300 },
  });
}

test("the callback and failure emails are the work list: name, phone and address of the caller", () => {
  const [callback] = newoOwnerAlerts(handoffEvent({ intent: { ...newoEvent().intent, urgency: "urgent" } }));
  assert.equal(callback?.kind, "handoff");
  for (const detail of [
    "Name: Newo Caller",
    "Phone: +1 (587) 555-7788",
    "Address: 123 Main Street, Edmonton, AB, T5J 0N3",
    "Reason: Caller asked for a person.",
  ]) {
    assert.ok(callback?.html.includes(detail), detail);
  }

  // A report that omits the contact still names the caller the session already holds.
  const bare = closingReport("emergency");
  bare.contact = { name: null, phone: null, email: "caller@example.com", address: { line1: null, city: null, province: null, postal_code: null } };
  const failure = newoOwnerAlerts(bare, storedSession()).find((alert) => alert.kind === "failure");
  for (const detail of ["Name: Stored Caller", "Phone: +15875550142", "Address: 9 Stored Road, Edmonton, AB, T5J 0N9"]) {
    assert.ok(failure?.html.includes(detail), detail);
  }
  const escaped = newoOwnerAlerts(handoffEvent({ contact: { ...newoEvent().contact, name: "<b>Caller</b>" } }));
  assert.ok(escaped[0]?.html.includes("Name: &lt;b&gt;Caller&lt;/b&gt;"));
});

test("a handoff status other than requested, failed or null is refused, and a live connection says why", async () => {
  const withStatus = (handoffStatus: unknown) => JSON.stringify({
    ...newoEvent(),
    outcome: { ...newoEvent().outcome, handoff_status: handoffStatus },
  });
  for (const accepted of ["requested", "failed", null]) {
    assert.equal(parseNewoEvent(withStatus(accepted)).ok, true, String(accepted));
  }
  const connected = parseNewoEvent(withStatus("connected"));
  assert.equal(connected.ok, false);
  if (!connected.ok) {
    assert.deepEqual(connected.issues, ["outcome.handoff_status reports a live connection; the receptionist is callback only"]);
  }
  const completed = parseNewoEvent(withStatus("completed"));
  assert.equal(completed.ok, false);
  if (!completed.ok) assert.deepEqual(completed.issues, ["outcome.handoff_status must be one of requested, failed"]);

  const state = fakeNewoEnv();
  const refused = await worker.fetch(new Request("https://bus.example/webhook/newo/report", {
    method: "POST",
    headers: { authorization: "Bearer newo-webhook-token", "content-type": "application/json" },
    body: JSON.stringify({ ...closingReport("routine"), outcome: { ...closingReport("routine").outcome, handoff_status: "connected" } }),
  }), state.env as never, ctx as never);
  assert.equal(refused.status, 422);
  assert.equal(state.raw.length, 0);
  assert.equal(state.sessions.size, 0);
});

test("a session keeps its strongest handoff status and its highest urgency", () => {
  const requested = storedSession({ handoff_status: "requested", urgency: "emergency" });
  assert.equal(newoHandoffStatus(closingReport("routine"), requested), "requested");
  assert.equal(newoHandoffStatus(closingReport("routine", "failed"), requested), "failed");
  assert.equal(newoHandoffStatus(handoffEvent(), storedSession({ handoff_status: "failed" })), "failed");
  assert.equal(newoUrgency(closingReport("routine"), requested), "emergency");
  assert.equal(newoUrgency(closingReport("urgent"), storedSession({ urgency: "routine" })), "urgent");
  assert.deepEqual(alertSubjects(closingReport("routine")), []);
  // A failed session still owes the failure alert on a later event; the sent marker, not the state
  // the event found, keeps it to one email (the retry tests below).
  assert.deepEqual(
    newoOwnerAlerts(closingReport("routine"), storedSession({ handoff_status: "failed" }))
      .map(({ kind, marker }) => [kind, marker]),
    [["failure", "raw/newo/owner-alerts/session-001/failure.json"]],
  );
});

test("an emergency session that closes without a handoff request is a failed handoff", async () => {
  for (const eventType of ["session_ended", "session_failed"] as const) {
    assert.equal(newoHandoffStatus(closingReport("emergency", null, eventType)), "failed", eventType);
  }
  assert.equal(newoHandoffStatus(closingReport("emergency"), storedSession({ handoff_status: "requested" })), "requested");
  assert.equal(newoHandoffStatus(closingReport("urgent")), null);
  // The urgency the session already holds counts, not only the report's.
  assert.equal(newoHandoffStatus(closingReport("routine"), storedSession({ urgency: "emergency" })), "failed");
  assert.deepEqual(alertSubjects(closingReport("emergency")), [["failure", "Urgent Newo callback required"]]);

  const state = fakeNewoEnv();
  const response = await worker.fetch(request("/webhook/newo/report", closingReport("emergency")), state.env as never, ctx as never);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(state.sessions.get("session-001")?.handoff_status, "failed");
});

// The owner alerts end to end: the Worker's own sendOwnerAlert through the Gmail adapter, with
// only Google's token and send endpoints faked. Every name, address and mailbox is synthetic.
function alertingNewoState(t: { mock: { method: typeof import("node:test").mock.method }; after(fn: () => void): void }) {
  resetGoogleAdapterStateForTest();
  t.after(() => resetGoogleAdapterStateForTest());
  const state = nativeNewoState();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const objects = new Map<string, string>();
  // failNext: one queue outage after the session row is written, so the request fails and Newo
  // retries it. down: the queue never takes a message.
  const queue = { failNext: false, down: false, sent: 0 };
  // timeouts: how many Gmail sends never answer (the adapter sees a network failure).
  const gmail = { timeouts: 0 };
  // headFails: the R2 read of a sent marker throws.
  const r2 = { headFails: false };
  const emails: Array<{ to: string | null; subject: string | null; body: string }> = [];
  const timedOut: Array<{ to: string | null; subject: string | null; body: string }> = [];
  const env = withTestEffectRuntime({
    ...state.env,
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "alerts@example.com", private_key: privateKey }),
    RAW: {
      put: async (key: string, body: string) => { objects.set(key, body); },
      get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
      head: async (key: string) => {
        if (r2.headFails) throw new Error("simulated_r2_read_failure");
        return objects.has(key) ? { key } : null;
      },
    },
    NEWO_QUEUE: {
      sendBatch: async () => {
        if (queue.down) throw new Error("simulated_queue_down");
      },
      send: async () => {
        if (queue.down) throw new Error("simulated_queue_down");
        if (queue.failNext) {
          queue.failNext = false;
          throw new Error("simulated_queue_outage");
        }
        queue.sent += 1;
      },
    },
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "gmail-test-token" });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const mime = Buffer.from((JSON.parse(String(init?.body)) as { raw: string }).raw, "base64url").toString("utf8");
      const header = (name: string) => mime.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? null;
      const email = {
        to: header("To"),
        subject: header("Subject")?.replace(/^=\?UTF-8\?B\?(.*)\?=$/, (_, b64: string) =>
          Buffer.from(b64, "base64").toString("utf8")) ?? null,
        body: mime.slice(mime.indexOf("\r\n\r\n") + 4),
      };
      if (gmail.timeouts > 0) {
        // Whether Google sent it is unknown: the request left and no answer came back.
        gmail.timeouts -= 1;
        timedOut.push(email);
        throw new Error("simulated_gmail_timeout");
      }
      emails.push(email);
      return Response.json({ id: `gmail-${emails.length}` });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const pending: Array<Promise<unknown>> = [];
  const alertCtx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise.catch(() => {})); } };
  const deliver = async (path: string, event: NewoEventV1) => {
    const response = await worker.fetch(request(path, event), env as never, alertCtx as never);
    while (pending.length > 0) await Promise.all(pending.splice(0));
    return response.status;
  };
  const session = () => state.db.raw.prepare(
    "SELECT handoff_status, urgency FROM newo_sessions WHERE session_id = ?",
  ).get("session-001") as { handoff_status: string | null; urgency: string | null } | undefined;
  const callbackRecords = () => state.db.raw.prepare(
    "SELECT session_id, event_id, reason, urgency, handoff_summary, contact_phone FROM newo_callback_records ORDER BY recorded_at",
  ).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
  const markers = () => [...objects.keys()].filter((key) => key.includes("owner-alerts")).sort();
  return { env, db: state.db, objects, queue, gmail, r2, emails, timedOut, deliver, session, callbackRecords, markers };
}

/** The Gmail effects in the ledger, oldest first. */
async function effectRows(env: { DB: unknown }): Promise<Array<{ state: string; attempt_count: number }>> {
  const db = env.DB as { prepare(sql: string): { all<T>(): Promise<{ results: T[] }> } };
  return (await db.prepare(
    "SELECT state, attempt_count FROM external_effects ORDER BY created_at, effect_id",
  ).all<{ state: string; attempt_count: number }>()).results;
}

const toAlertBoxes = (emails: Array<{ to: string | null; subject: string | null }>) =>
  emails.map(({ to, subject }) => `${to}: ${subject}`).sort();

const FAILURE_BOXES = [
  "backup@example.com: Urgent Newo callback required",
  "owner@example.com: Urgent Newo callback required",
];

test("an emergency session that closes without a handoff emails the owner and the backup the urgent alert", async (t) => {
  const alerting = alertingNewoState(t);
  assert.equal(await alerting.deliver("/webhook/newo/report", closingReport("emergency")), 200);
  assert.equal(alerting.session()?.handoff_status, "failed");
  assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
  for (const email of alerting.emails) {
    for (const detail of ["Name: Newo Caller", "Phone: +15875557788", "Address: 123 Main Street, Edmonton, AB, T5J 0N3"]) {
      assert.ok(email.body.includes(detail), `${email.to} carries ${detail}`);
    }
  }
  // The failed handoff has its D1 callback record, written with the session.
  assert.deepEqual(alerting.callbackRecords().map(({ reason, urgency }) => [reason, urgency]), [
    ["handoff_failed", "emergency"],
  ]);
});

test("a requested callback emails the owner and the backup, urgently when the caller's urgency says so", async (t) => {
  const alerting = alertingNewoState(t);
  const event = handoffEvent({ intent: { ...newoEvent().intent, urgency: "urgent" } });
  assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
  assert.equal(alerting.session()?.handoff_status, "requested");
  assert.deepEqual(toAlertBoxes(alerting.emails), [
    "backup@example.com: Urgent Newo callback requested - urgent",
    "owner@example.com: Urgent Newo callback requested - urgent",
  ]);
  assert.ok(alerting.emails.every((email) => email.body.includes("Reason: Caller asked for a person.")));
  assert.deepEqual(alerting.callbackRecords(), [{
    session_id: "session-001",
    event_id: "event-handoff-001",
    reason: "callback_requested",
    urgency: "urgent",
    handoff_summary: "Caller asked for a person.",
    contact_phone: "+15875557788",
  }]);
});

test("a failure alert goes out before the queue send, survives a retry, and is sent only once", async (t) => {
  const failedHandoff = closingReport("routine", "failed");
  for (const [name, path, event] of [
    ["failed handoff report", "/webhook/newo/report", failedHandoff],
    ["emergency close without a handoff", "/webhook/newo/report", closingReport("emergency")],
  ] as const) {
    await t.test(name, async (subtest) => {
      const alerting = alertingNewoState(subtest);
      alerting.queue.failNext = true;
      assert.equal(await alerting.deliver(path, event), 500);
      // The first attempt wrote the failed handoff and its callback record, alerted, then failed
      // at the queue.
      assert.equal(alerting.session()?.handoff_status, "failed");
      assert.equal(alerting.callbackRecords().length, 1);
      assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
      assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/failure.json"]);

      // Newo retries the same event: the alert is recorded as sent, so nothing more goes out.
      assert.equal(await alerting.deliver(path, event), 200);
      assert.equal(alerting.emails.length, 2);
      assert.equal(alerting.callbackRecords().length, 1);

      // A later event of the same failed session, with different caller details, sends nothing more.
      const later = newoEvent({
        event_id: "event-report-003",
        event_type: "session_ended",
        contact: { ...newoEvent().contact, phone: "+1 (587) 555-0199" },
        outcome: { ...newoEvent().outcome, ended_at: "2026-07-18T18:06:00.000Z", duration_seconds: 360 },
      });
      assert.equal(await alerting.deliver("/webhook/newo/report", later), 200);
      assert.equal(alerting.emails.length, 2);
    });
  }
});

test("a queue that stays down until Newo stops retrying still alerts once, and the callback is in D1", async (t) => {
  for (const [name, path, event, boxes] of [
    ["callback request", "/webhook/newo/handoff", handoffEvent({ intent: { ...newoEvent().intent, urgency: "emergency" } }), [
      "backup@example.com: Urgent Newo callback requested - emergency",
      "owner@example.com: Urgent Newo callback requested - emergency",
    ]],
    ["failed handoff report", "/webhook/newo/report", closingReport("routine", "failed"), FAILURE_BOXES],
  ] as const) {
    await t.test(name, async (subtest) => {
      const alerting = alertingNewoState(subtest);
      alerting.queue.down = true;
      // Newo's first delivery and every retry fail at the queue.
      for (let delivery = 1; delivery <= 4; delivery += 1) {
        assert.equal(await alerting.deliver(path, event), 500, `delivery ${delivery}`);
      }
      assert.equal(alerting.queue.sent, 0);
      assert.deepEqual(toAlertBoxes(alerting.emails), [...boxes].sort());
      assert.ok(alerting.emails.every((email) => email.body.includes(`Alert for event ${event.event_id}, attempt 1.`)));
      assert.equal(alerting.callbackRecords().length, 1);
      assert.equal(alerting.callbackRecords()[0]?.event_id, event.event_id);
    });
  }
});

test("a Gmail timeout never holds the urgent alert behind reconciliation, and nothing identical is resent", async (t) => {
  await t.test("the failure alert is owed on the next event, as a new attempt", async (subtest) => {
    const alerting = alertingNewoState(subtest);
    alerting.gmail.timeouts = 2;
    assert.equal(await alerting.deliver("/webhook/newo/report", closingReport("routine", "failed")), 200);
    // Both sends left and no answer came: the outcome is unknown, so nothing is recorded as sent.
    assert.deepEqual(toAlertBoxes(alerting.timedOut), FAILURE_BOXES);
    assert.deepEqual(alerting.emails, []);
    assert.deepEqual(alerting.markers(), []);
    const unknown = await effectRows(alerting.env);
    assert.deepEqual(unknown.map((row) => row.state), ["unknown", "unknown"]);

    const later = newoEvent({
      event_id: "event-report-003",
      event_type: "session_ended",
      outcome: { ...newoEvent().outcome, ended_at: "2026-07-18T18:06:00.000Z", duration_seconds: 360 },
    });
    assert.equal(await alerting.deliver("/webhook/newo/report", later), 200);
    assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
    for (const email of alerting.emails) {
      assert.ok(email.body.includes("Alert for event event-report-003, attempt 1."), email.body);
      assert.ok(email.body.includes("If an earlier alert about this caller reached you, this one repeats it."));
    }
    assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/failure.json"]);
    // The unknown sends stay unknown: they are new effects, never the earlier ones again.
    const states = await effectRows(alerting.env);
    assert.deepEqual(states.map((row) => row.state).sort(), ["succeeded", "succeeded", "unknown", "unknown"]);
    assert.ok(states.filter((row) => row.state === "unknown").every((row) => Number(row.attempt_count) === 1));
    // The same content again is the same effect, and the ledger refuses it while its outcome is unknown.
    const [first] = alerting.timedOut;
    await assert.rejects(
      sendOwnerAlert(alerting.env as never, first!.subject!, first!.body),
      /effect_unknown_requires_reconciliation/,
    );
    assert.equal(alerting.emails.length, 2);
  });

  await t.test("the callback request alert goes out on Newo's retry of its event", async (subtest) => {
    const alerting = alertingNewoState(subtest);
    alerting.gmail.timeouts = 2;
    alerting.queue.failNext = true;
    const event = handoffEvent({ intent: { ...newoEvent().intent, urgency: "urgent" } });
    assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 500);
    assert.deepEqual(alerting.emails, []);
    assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
    assert.deepEqual(toAlertBoxes(alerting.emails), [
      "backup@example.com: Urgent Newo callback requested - urgent",
      "owner@example.com: Urgent Newo callback requested - urgent",
    ]);
    assert.ok(alerting.emails.every((email) => email.body.includes("Alert for event event-handoff-001, attempt 2.")));
    assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/handoff-event-handoff-001.json"]);
  });
});

test("the sweep recovers a timed-out callback alert without another event and leaves unknown effects alone", async (t) => {
  const alerting = alertingNewoState(t);
  const event = handoffEvent({ intent: { ...newoEvent().intent, urgency: "urgent" } });
  alerting.gmail.timeouts = 2;
  assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
  assert.deepEqual(alerting.markers(), []);
  assert.equal(alerting.callbackRecords().length, 1);
  const sweepAt = new Date(event.occurred_at);
  await reconcileNewoSessions(alerting.env as never, sweepAt);
  assert.deepEqual(toAlertBoxes(alerting.emails), [
    "backup@example.com: Urgent Newo callback requested - urgent",
    "owner@example.com: Urgent Newo callback requested - urgent",
  ]);
  assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/handoff-event-handoff-001.json"]);
  assert.ok(alerting.emails.every((email) => email.body.includes("attempt sweep-") && email.body.includes("repeats it")));
  assert.deepEqual((await effectRows(alerting.env)).map((row) => row.state).sort(),
    ["succeeded", "succeeded", "unknown", "unknown"]);
  await reconcileNewoSessions(alerting.env as never, sweepAt);
  assert.equal(alerting.emails.length, 2, "a confirmed alert is not sent again");
});

test("an open callback alone makes the five-minute reconciliation degraded", async (t) => {
  const alerting = alertingNewoState(t);
  const event = handoffEvent();
  assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
  await reconcileNewoSessions(alerting.env as never, new Date(event.occurred_at));
  const run = alerting.db.raw.prepare("SELECT status, missing_reports, failed_handoffs FROM newo_reconciliation_runs").get();
  assert.deepEqual({ ...run }, { status: "degraded", missing_reports: 0, failed_handoffs: 0 });
});

test("callback alert recovery completes before a landing queue failure", async (t) => {
  const alerting = alertingNewoState(t);
  const event = handoffEvent();
  alerting.gmail.timeouts = 2;
  assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
  alerting.db.raw.prepare("UPDATE newo_sessions SET sync_updated_at = ?").run(
    new Date(Date.parse(event.occurred_at) - 10 * 60_000).toISOString(),
  );
  alerting.queue.down = true;
  await assert.rejects(reconcileNewoSessions(alerting.env as never, new Date(event.occurred_at)), /simulated_queue_down/);
  assert.equal(alerting.emails.length, 2);
  assert.equal(alerting.markers().length, 1);
});

test("the recovery alert retains a session's higher urgency and stronger failed-handoff status", async (t) => {
  for (const handoffStatus of ["requested", "failed"]) {
    await t.test(handoffStatus, async (subtest) => {
      const alerting = alertingNewoState(subtest);
      const serviceAccount = alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
      assert.equal(await alerting.deliver("/webhook/newo/handoff", handoffEvent()), 200);
      assert.equal(await alerting.deliver("/webhook/newo", newoEvent({ event_id: "event-stronger-state",
        occurred_at: "2026-07-18T18:01:00.000Z", intent: { ...newoEvent().intent, urgency: "emergency" },
        outcome: { ...newoEvent().outcome, handoff_status: handoffStatus },
      })), 200);
      alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
      assert.equal((await sweepNewoCallbackAlerts(alerting.env as never)).sent, 1);
      const expected = handoffStatus === "failed" ? "Urgent Newo callback required" : "Urgent Newo callback requested - emergency";
      assert.ok(alerting.emails.every((email) => email.subject === expected));
      assert.deepEqual(alerting.markers(), [newoOwnerAlertMarker("session-001",
        handoffStatus === "failed" ? "failure" : "handoff", "event-handoff-001")]);
    });
  }
});

test("a timed-out sweep retries as a distinct effect, and disabled recovery sends nothing", async (t) => {
  const alerting = alertingNewoState(t);
  alerting.gmail.timeouts = 4;
  assert.equal(await alerting.deliver("/webhook/newo/handoff", handoffEvent()), 200);
  const first = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.deepEqual(first, { scanned: 1, sent: 0, failed: 1, next_callback_id: null });
  assert.deepEqual(alerting.markers(), []);
  alerting.env.NEWO_ENABLED = "false";
  assert.deepEqual(await sweepNewoCallbackAlerts(alerting.env as never),
    { scanned: 0, sent: 0, failed: 0, next_callback_id: null });
  assert.equal(alerting.emails.length, 0);
  alerting.env.NEWO_ENABLED = "true";
  // The provider recovers. The third network failure opened the adapter's breaker, so another
  // recipient may have been refused before fetch and did not consume a simulated timeout.
  alerting.gmail.timeouts = 0;
  // The next cron occurs after the 30-second cooldown. Advance its clock without sleeping or
  // clearing adapter state; the unknown effects and any suppressed attempt remain in the ledger.
  const nextTick = Date.now() + 5 * 60_000;
  t.mock.method(Date, "now", () => nextTick);
  const second = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.equal(second.sent, 1);
  assert.equal(alerting.emails.length, 2);
  const effects = await effectRows(alerting.env);
  assert.deepEqual(effects.map((row) => row.state).sort(),
    ["succeeded", "succeeded", "unknown", "unknown", "unknown", "unknown"]);
  assert.ok(effects.every((row) => Number(row.attempt_count) === 1));
});

test("confirmed alerts in the first batch cannot starve a later open callback", async (t) => {
  const alerting = alertingNewoState(t);
  const serviceAccount = alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  for (let i = 0; i < 26; i++) {
    const event = handoffEvent({ event_id: `event-batch-${i}`, session_id: `session-batch-${i}` });
    assert.equal(await alerting.deliver("/webhook/newo/handoff", event), 200);
  }
  const callbacks = alerting.db.raw.prepare(
    "SELECT callback_id, session_id, event_id FROM newo_callback_records ORDER BY callback_id",
  ).all() as Array<{ callback_id: string; session_id: string; event_id: string }>;
  for (const callback of callbacks.slice(0, 25)) {
    alerting.objects.set(newoOwnerAlertMarker(callback.session_id, "handoff", callback.event_id), "{}");
  }
  alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
  const first = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.deepEqual(first, { scanned: 25, sent: 0, failed: 0, next_callback_id: callbacks[24]!.callback_id });
  const second = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.deepEqual(second, { scanned: 1, sent: 1, failed: 0, next_callback_id: null });
  assert.equal(alerting.emails.length, 2);
  assert.ok(alerting.emails.every((email) => email.body.includes(callbacks[25]!.session_id)));
  const wrapped = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.equal(wrapped.scanned, 25);
  assert.equal(wrapped.sent, 0);
});

test("a callback request alert never stands in for the failure alert", async (t) => {
  const alerting = alertingNewoState(t);
  assert.equal(await alerting.deliver("/webhook/newo/handoff", handoffEvent()), 200);
  assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/handoff-event-handoff-001.json"]);
  // The callback request then fails: the failure alert is still owed and goes out.
  assert.equal(await alerting.deliver("/webhook/newo/report", closingReport("routine", "failed")), 200);
  assert.deepEqual(toAlertBoxes(alerting.emails.slice(2)), FAILURE_BOXES);
  assert.deepEqual(alerting.markers(), [
    "raw/newo/owner-alerts/session-001/failure.json",
    "raw/newo/owner-alerts/session-001/handoff-event-handoff-001.json",
  ]);
  assert.notEqual(
    newoOwnerAlertMarker("session-001", "handoff", "event-handoff-001"),
    newoOwnerAlertMarker("session-001", "failure", "event-handoff-001"),
  );
});

test("the sweep recovers a later session failure after the callback request alert was confirmed", async (t) => {
  const alerting = alertingNewoState(t);
  const requested = handoffEvent();
  const handoffMarker = newoOwnerAlertMarker(requested.session_id, "handoff", requested.event_id);
  const failureMarker = newoOwnerAlertMarker(requested.session_id, "failure", requested.event_id);
  assert.equal(await alerting.deliver("/webhook/newo/handoff", requested), 200);
  assert.equal(alerting.emails.length, 2);
  assert.deepEqual(alerting.markers(), [handoffMarker]);

  alerting.gmail.timeouts = 2;
  const failed = failedSession({
    occurred_at: new Date(Date.parse(requested.occurred_at) + 60_000).toISOString(),
  });
  assert.equal(await alerting.deliver("/webhook/newo/report", failed), 200);
  assert.equal(alerting.timedOut.length, 2);
  assert.deepEqual({ ...alerting.db.raw.prepare(
    "SELECT status, handoff_status FROM newo_sessions WHERE session_id = ?",
  ).get(requested.session_id) }, { status: "failed", handoff_status: "requested" });
  assert.equal(alerting.callbackRecords()[0]?.reason, "callback_requested");
  assert.equal(alerting.callbackRecords()[0]?.event_id, requested.event_id);
  assert.deepEqual(alerting.markers(), [handoffMarker]);
  const unknownEffects = async () => (await alerting.env.DB.prepare(
    "SELECT effect_id, state, attempt_count FROM external_effects WHERE state = 'unknown' ORDER BY effect_id",
  ).all()).results.map((row: Row) => ({ ...row }));
  const unknownBefore = await unknownEffects();
  assert.equal(unknownBefore.length, 2);

  const before = alerting.emails.length;
  const recovery = await sweepNewoCallbackAlerts(alerting.env as never);
  assert.equal(recovery.sent, 1, "a confirmed request never confirms a later failure alert");
  const recovered = alerting.emails.slice(before);
  assert.deepEqual(toAlertBoxes(recovered), FAILURE_BOXES);
  assert.ok(recovered.every((email) => email.body.includes("attempt sweep-") && email.body.includes("repeats it")));
  assert.deepEqual(alerting.markers(), [failureMarker, handoffMarker].sort());
  assert.deepEqual(await unknownEffects(), unknownBefore, "the timed-out effects stay unknown and are not replayed");
  const effects = await effectRows(alerting.env);
  assert.equal(effects.length, 6);
  assert.ok(effects.every((effect) => Number(effect.attempt_count) === 1));
  assert.equal((await sweepNewoCallbackAlerts(alerting.env as never)).sent, 0);
  assert.equal(alerting.emails.length, before + 2, "confirmed recovery is not sent again");
});

test("the sweep recovers a late accepted session failure without replacing a newer normal report", async (t) => {
  const alerting = alertingNewoState(t);
  const requested = handoffEvent();
  assert.equal(await alerting.deliver("/webhook/newo/handoff", requested), 200);
  const originalCallback = alerting.callbackRecords();
  const handoffMarker = newoOwnerAlertMarker(requested.session_id, "handoff", requested.event_id);
  assert.deepEqual(alerting.markers(), [handoffMarker]);
  const newer = {
    ...closingReport("routine", "requested"),
    event_id: "event-newer-normal-report",
    occurred_at: new Date(Date.parse(requested.occurred_at) + 120_000).toISOString(),
  };
  assert.equal(await alerting.deliver("/webhook/newo/report", newer), 200);
  const latestSession = () => ({ ...alerting.db.raw.prepare(
    "SELECT * FROM newo_sessions WHERE session_id = ?",
  ).get(requested.session_id) });
  const latestBefore = latestSession();
  assert.equal(latestBefore.status, "ended");
  assert.equal(latestBefore.handoff_status, "requested");
  assert.equal(latestBefore.report_event_id, newer.event_id);

  alerting.gmail.timeouts = 2;
  const lateFailure = failedSession({
    occurred_at: new Date(Date.parse(requested.occurred_at) + 60_000).toISOString(),
  });
  assert.equal(await alerting.deliver("/webhook/newo/report", lateFailure), 200);
  const receipt = alerting.db.raw.prepare(
    "SELECT status, event_type, session_id, envelope_id FROM newo_event_receipts WHERE event_id = ?",
  ).get(lateFailure.event_id);
  assert.deepEqual({ ...receipt }, {
    status: "accepted", event_type: "session_failed", session_id: requested.session_id,
    envelope_id: latestBefore.lead_envelope_id,
  });
  assert.equal(alerting.timedOut.length, 2);
  assert.deepEqual(latestSession(), latestBefore, "an older event cannot replace the newer session projection");
  assert.deepEqual(alerting.callbackRecords(), originalCallback);
  assert.deepEqual(alerting.markers(), [handoffMarker]);
  const unknownEffects = async () => (await alerting.env.DB.prepare(
    "SELECT effect_id, state, attempt_count FROM external_effects WHERE state = 'unknown' ORDER BY effect_id",
  ).all()).results.map((row: Row) => ({ ...row }));
  const unknownBefore = await unknownEffects();
  assert.equal(unknownBefore.length, 2);

  const before = alerting.emails.length;
  assert.equal((await sweepNewoCallbackAlerts(alerting.env as never)).sent, 1,
    "an accepted late failure owes an urgent alert independently of the latest session status");
  const recovered = alerting.emails.slice(before);
  assert.deepEqual(toAlertBoxes(recovered), FAILURE_BOXES);
  assert.ok(recovered.every((email) => email.body.includes("attempt sweep-") && email.body.includes("repeats it")));
  assert.deepEqual(alerting.markers(), [handoffMarker,
    newoOwnerAlertMarker(requested.session_id, "failure", lateFailure.event_id)].sort());
  assert.deepEqual(await unknownEffects(), unknownBefore);
  assert.ok((await effectRows(alerting.env)).every((effect) => Number(effect.attempt_count) === 1));
  assert.deepEqual(latestSession(), latestBefore);
  assert.deepEqual(alerting.callbackRecords(), originalCallback);
  assert.equal((await sweepNewoCallbackAlerts(alerting.env as never)).sent, 0);
  assert.equal(await alerting.deliver("/webhook/newo/report", lateFailure), 200);
  assert.equal(alerting.emails.length, before + 2, "a confirmed failure marker also suppresses provider replay");
});

test("failure provenance requires an accepted receipt for this session and its owned tenant envelope", async (t) => {
  const alerting = alertingNewoState(t);
  const requested = handoffEvent();
  assert.equal(await alerting.deliver("/webhook/newo/handoff", requested), 200);
  const session = alerting.db.raw.prepare(
    "SELECT lead_envelope_id FROM newo_sessions WHERE session_id = ?",
  ).get(requested.session_id)!;
  const envelopeId = String(session.lead_envelope_id);
  const kinds = async () => (await listNewoCallbacksForAlert(alerting.env as never, null, 25))
    .map((callback) => callback.alert_kind);
  const cases = [
    { name: "processing", status: "processing" },
    { name: "failed", status: "failed" },
    { name: "dead", status: "dead" },
    { name: "another event type", eventType: "session_ended" },
    { name: "another session", sessionId: "other-session" },
    { name: "no envelope", envelopeId: null },
    { name: "missing envelope", envelopeId: "ow_missing_synthetic" },
    { name: "different owned envelope", envelopeId: "ow_other_synthetic" },
    { name: "foreign tenant envelope", foreignTenant: true },
  ];
  for (const probe of cases) {
    await t.test(probe.name, async () => {
      alerting.db.raw.exec("SAVEPOINT receipt_provenance_probe");
      try {
        alerting.db.raw.prepare(`INSERT INTO envelopes (
            envelope_id, source, payload_json, raw_key, ts, status, dedup_key, created_at, updated_at, tenant_id
          ) SELECT 'ow_other_synthetic', source, payload_json, raw_key, ts, status,
            'synthetic-other-envelope', created_at, updated_at, tenant_id FROM envelopes WHERE envelope_id = ?`)
          .run(envelopeId);
        assert.throws(() => alerting.db.raw.prepare(`INSERT INTO newo_event_receipts (
            event_id, session_id, event_type, payload_hash, raw_key, envelope_id, status, first_seen_at, last_seen_at
          ) VALUES ('synthetic-failure-provenance', ?, ?, 'synthetic-hash', 'raw/newo/synthetic.json', ?, ?, ?, ?)`)
          .run("sessionId" in probe ? probe.sessionId : requested.session_id,
            "eventType" in probe ? probe.eventType : "session_failed",
            "envelopeId" in probe ? probe.envelopeId : envelopeId,
            "status" in probe ? probe.status : "accepted", requested.occurred_at, requested.occurred_at), /newo_receipt/);
        if ("foreignTenant" in probe) {
          alerting.db.raw.prepare("UPDATE envelopes SET tenant_id = 'other-tenant' WHERE envelope_id = ?").run(envelopeId);
        }
        assert.deepEqual(await kinds(), ["handoff"]);
      } finally {
        alerting.db.raw.exec("ROLLBACK TO receipt_provenance_probe; RELEASE receipt_provenance_probe");
      }
    });
  }
  assert.deepEqual(await listNewoCallbacksForAlert({ ...alerting.env, APP_TENANT_ID: "other-tenant" } as never,
    null, 25), []);
});

test("rejected and conflicting failure input never becomes accepted failure provenance", async (t) => {
  const alerting = alertingNewoState(t);
  const requested = handoffEvent();
  assert.equal(await alerting.deliver("/webhook/newo/handoff", requested), 200);
  const rejected = failedSession({ event_id: "event-rejected-failure" });
  assert.equal((await worker.fetch(request("/webhook/newo/report", rejected, "wrong-token"),
    alerting.env as never, ctx as never)).status, 401);
  assert.equal(await alerting.deliver("/webhook/newo/handoff", rejected), 422);
  assert.equal(alerting.db.raw.prepare("SELECT COUNT(*) AS n FROM newo_event_receipts WHERE event_id = ?")
    .get(rejected.event_id)?.n, 0);
  assert.equal(await alerting.deliver("/webhook/newo/report", failedSession({ event_id: requested.event_id })), 409);
  assert.equal(alerting.db.raw.prepare("SELECT event_type FROM newo_event_receipts WHERE event_id = ?")
    .get(requested.event_id)?.event_type, "handoff_requested");
  assert.deepEqual((await listNewoCallbacksForAlert(alerting.env as never, null, 25))
    .map((callback) => callback.alert_kind), ["handoff"]);
  assert.equal((await sweepNewoCallbackAlerts(alerting.env as never)).sent, 0);
  assert.deepEqual(alerting.markers(), [newoOwnerAlertMarker(requested.session_id, "handoff", requested.event_id)]);
  assert.equal(alerting.emails.length, 2);
});

test("a sent marker that cannot be read counts as not sent", async (t) => {
  const alerting = alertingNewoState(t);
  alerting.r2.headFails = true;
  assert.equal(await alerting.deliver("/webhook/newo/report", closingReport("routine", "failed")), 200);
  assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
  assert.deepEqual(alerting.markers(), ["raw/newo/owner-alerts/session-001/failure.json"]);
});

test("a failure alert whose send fails is not recorded as sent, so the next event sends it", async (t) => {
  const alerting = alertingNewoState(t);
  // The send fails before anything is dispatched: Gmail is not configured yet.
  const serviceAccount = alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  assert.equal(await alerting.deliver("/webhook/newo/report", closingReport("routine", "failed")), 200);
  assert.deepEqual(alerting.emails, []);
  assert.equal(alerting.objects.has("raw/newo/owner-alerts/session-001/failure.json"), false);

  alerting.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
  const later = newoEvent({
    event_id: "event-report-003",
    event_type: "session_ended",
    outcome: { ...newoEvent().outcome, ended_at: "2026-07-18T18:06:00.000Z", duration_seconds: 360 },
  });
  assert.equal(await alerting.deliver("/webhook/newo/report", later), 200);
  assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
  assert.equal(alerting.objects.has("raw/newo/owner-alerts/session-001/failure.json"), true);
});

// A failed session that is not a failed handoff (owner ruling on #58): no caller rests on an email
// alone, so one the session can reach gets a callback record, `session_failed`.
function failedSession(overrides: Partial<NewoEventV1> = {}): NewoEventV1 {
  return newoEvent({
    event_id: "event-failed-001",
    event_type: "session_failed",
    outcome: { ...newoEvent().outcome, status: "failed", ended_at: "2026-07-18T18:04:00.000Z", duration_seconds: 240 },
    ...overrides,
  });
}

const NO_CONTACT: NewoEventV1["contact"] = {
  name: null,
  phone: null,
  email: null,
  address: { line1: null, city: null, province: null, postal_code: null },
};

test("a failed session with the caller's contact gets exactly one callback record, idempotent on retry", async (t) => {
  await t.test("the contact is on the failed-session event", async (subtest) => {
    const alerting = alertingNewoState(subtest);
    alerting.queue.failNext = true;
    // Newo's first delivery writes the session and the record, then fails at the queue; its retry
    // and a second failed-session event of the same session add nothing.
    assert.equal(await alerting.deliver("/webhook/newo/report", failedSession()), 500);
    assert.equal(await alerting.deliver("/webhook/newo/report", failedSession()), 200);
    assert.equal(await alerting.deliver("/webhook/newo/report", failedSession({ event_id: "event-failed-002" })), 200);
    assert.deepEqual(alerting.callbackRecords(), [{
      session_id: "session-001",
      event_id: "event-failed-001",
      reason: "session_failed",
      urgency: "routine",
      handoff_summary: null,
      contact_phone: "+15875557788",
    }]);
    assert.equal(alerting.session()?.handoff_status, null);
    // The urgent email still goes out, once.
    assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
  });

  await t.test("the contact came with an earlier event of the session", async (subtest) => {
    const alerting = alertingNewoState(subtest);
    assert.equal(await alerting.deliver("/webhook/newo", newoEvent()), 200);
    assert.equal(await alerting.deliver("/webhook/newo/report", failedSession({ contact: NO_CONTACT })), 200);
    assert.deepEqual(alerting.callbackRecords().map(({ event_id, reason, contact_phone }) => [event_id, reason, contact_phone]), [
      ["event-failed-001", "session_failed", "+15875557788"],
    ]);
  });
});

test("a failed session nobody can call back gets no callback record, and D1 refuses one", async (t) => {
  const alerting = alertingNewoState(t);
  assert.equal(await alerting.deliver("/webhook/newo/report", failedSession({ contact: NO_CONTACT })), 200);
  assert.deepEqual(alerting.callbackRecords(), []);
  // The owner is still told; there is simply no one to call.
  assert.deepEqual(toAlertBoxes(alerting.emails), FAILURE_BOXES);
  assert.equal(
    await newoCallbackRecordInput(alerting.env as never, failedSession({ contact: NO_CONTACT }), null),
    null,
  );
  // A routine session that ended normally owes no callback either.
  assert.equal(await newoCallbackRecordInput(alerting.env as never, closingReport("routine"), null), null);
  // D1 refuses a failed session's record that names no phone and no email.
  const db = alerting.env.DB as unknown as {
    prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown> } };
  };
  await assert.rejects(
    db.prepare(
      `INSERT INTO newo_callback_records (callback_id, tenant_id, session_id, event_id, reason, urgency)
       VALUES (?, 'ironwrap', 'session-001', 'event-failed-001', 'session_failed', 'routine')`,
    ).bind(`ncb_${"a".repeat(32)}`).run(),
    /newo_callback_record_event_invalid|CHECK constraint failed/,
  );
  assert.deepEqual(alerting.callbackRecords(), []);
});
