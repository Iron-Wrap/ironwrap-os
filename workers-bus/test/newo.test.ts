import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import {
  canonicalJson,
  handleNewoQueueMessage,
  parseNewoEvent,
  sha256Hex,
  type NewoEventV1,
} from "../src/newo.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";

type Row = Record<string, unknown>;

class NativeNewoD1 {
  readonly raw = new DatabaseSync(":memory:");
  failNextSyncUpdate = false;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0001_init.sql",
      "0004_estimate_idempotency.sql",
      "0009_replay_approval_audit.sql",
      "0023_newo_reception.sql",
      "0024_newo_caller_association.sql",
      "0026_newo_reconciliation.sql",
      "0090_operating_core.sql",
      "0082_envelope_operating_tenant.sql",
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
    return (this.db.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
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
  const raw: Array<{ key: string; body: string }> = [];
  const jnQueue: Array<{ envelope_id: string }> = [];
  const newoQueue: Array<{ newo_event_id: string }> = [];
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const receipts = new Map<string, Row>();
  const sessions = new Map<string, Row>();
  const envelopes = new Map<string, Row>();
  const operatingCustomers: Row[] = [];
  const operatingJobs: Row[] = [];
  const env = {
    INGEST_TOKEN: "ingest-token",
    ADMIN_TOKEN: "admin-token",
    NEWO_ENABLED: "true",
    NEWO_WEBHOOK_TOKEN: "newo-webhook-token",
    NEWO_BOOKING_TOKEN: "newo-booking-token",
    NEWO_BOOKING_MODE: "request_only",
    NEWO_BOOKING_HORIZON_DAYS: "30",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "owner@example.com",
    FROM_EMAIL: "ops@example.com",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
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
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                calls.push({ sql, args });
                if (sql.includes("INSERT OR IGNORE INTO newo_event_receipts")) {
                  const eventId = String(args[0]);
                  if (receipts.has(eventId)) return { success: true, meta: { changes: 0 } };
                  receipts.set(eventId, {
                    event_id: args[0], session_id: args[1], event_type: args[2], payload_hash: args[3],
                    raw_key: args[4], envelope_id: null, status: "processing", response_json: "{}",
                    attempts: 1, last_error: null, first_seen_at: args[5], last_seen_at: args[6],
                    completed_at: null,
                  });
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes("SET status = 'accepted'")) {
                  const row = receipts.get(String(args[4]));
                  if (row) Object.assign(row, {
                    status: "accepted", envelope_id: args[0], response_json: args[1],
                    last_seen_at: args[2], completed_at: args[3],
                  });
                }
                if (sql.includes("SET status = 'failed'")) {
                  const row = receipts.get(String(args[3]));
                  if (row) Object.assign(row, {
                    status: "failed", last_error: args[0], last_seen_at: args[1], completed_at: args[2],
                  });
                }
                if (sql.includes("SET status = 'processing', attempts")) {
                  const row = receipts.get(String(args[1]));
                  if (row?.status === "failed") {
                    Object.assign(row, { status: "processing", attempts: Number(row.attempts) + 1 });
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                if (sql.includes("UPDATE newo_event_receipts SET last_seen_at")) {
                  const row = receipts.get(String(args[1]));
                  if (row) row.last_seen_at = args[0];
                }
                if (sql.includes("INSERT INTO envelopes")) {
                  envelopes.set(String(args[0]), {
                    envelope_id: args[0], source: args[1], contact_name: args[2], contact_phone: args[3],
                    contact_email: args[4], payload_json: args[6], raw_key: args[7], status: args[9],
                    dedup_key: args[10], dup_of: args[11], intent_queue: args[17],
                  });
                }
                if (sql.includes("INSERT INTO newo_sessions") && sql.includes("verification_status")) {
                  const previous = sessions.get(String(args[0]));
                  sessions.set(String(args[0]), {
                    ...previous,
                    session_id: args[0], project_id: args[1], agent_id: args[2], channel: "phone",
                    direction: "inbound", status: previous?.status ?? "caller_lookup", contact_phone: args[3],
                    address_line1: args[4], postal_code: args[5], matched_customer_id: args[6],
                    matched_property_id: args[7], matched_roof_job_id: args[8], verification_status: args[9],
                    structured_json: args[10], raw_key: args[11], payload_hash: args[12],
                    sync_status: "pending", sync_attempts: previous?.sync_attempts ?? 0,
                    created_at: previous?.created_at ?? args[13], updated_at: args[14], lead_envelope_id: null,
                  });
                } else if (sql.includes("INSERT INTO newo_sessions")) {
                  const row: Row = {
                    session_id: args[0], project_id: args[1], agent_id: args[2], user_actor_id: args[3],
                    conversation_id: args[4], channel: args[5], direction: args[6], status: args[7],
                    outcome: args[8], contact_name: args[9], contact_phone: args[10], contact_email: args[11],
                    address_line1: args[12], city: args[13], province: args[14], postal_code: args[15],
                    division: args[16], service: args[17], urgency: args[18], lead_envelope_id: args[19],
                    appointment_request_id: args[20], handoff_status: args[21], booking_status: args[22],
                    summary: args[23], transcript_ref: args[24], recording_ref: args[25], ai_disclosed: args[26],
                    recording_disclosed: args[27], structured_json: args[28], raw_key: args[29],
                    payload_hash: args[30], started_at: args[31], ended_at: args[32], duration_seconds: args[33],
                    report_expected_at: args[34], report_received_at: args[35], report_event_id: args[36],
                    missing_report_detected_at: args[37], sync_status: args[38], sync_attempts: args[39],
                    last_error: args[40], sync_updated_at: args[41], created_at: args[42], updated_at: args[43],
                  };
                  const previous = sessions.get(String(args[0]));
                  sessions.set(String(args[0]), previous ? { ...previous, ...row } : row);
                }
                return { success: true, meta: { changes: 1 } };
              },
              first: async () => {
                calls.push({ sql, args });
                if (sql.includes("FROM newo_event_receipts")) return receipts.get(String(args[0])) ?? null;
                if (sql.includes("FROM newo_sessions")) return sessions.get(String(args[0])) ?? null;
                if (sql.includes("FROM envelopes")) return envelopes.get(String(args[0])) ?? null;
                return null;
              },
              all: async () => {
                calls.push({ sql, args });
                if (sql.includes("FROM operating_customers")) return { results: operatingCustomers };
                if (sql.includes("FROM operating_roof_jobs")) return { results: operatingJobs };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  return { env, raw, jnQueue, newoQueue, calls, receipts, sessions, envelopes, operatingCustomers, operatingJobs };
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
  state.operatingCustomers.push({ customer_id: "customer:phone:15875557788" });
  state.operatingJobs.push({
    roof_job_id: "job:existing-1",
    job_status: "in_progress",
    updated_at: "2026-07-18T17:00:00.000Z",
    property_key: "property:123-main-street-edmonton",
    address_line1: "123 Main Street",
    postal_code: "T5J 0N3",
  });
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
  const envelope = [...state.envelopes.values()][0];
  const payload = JSON.parse(String(envelope.payload_json));
  assert.deepEqual(payload.owned_association, {
    customer_id: "customer:phone:15875557788",
    property_key: "property:123-main-street-edmonton",
    roof_job_id: "job:existing-1",
    verification_status: "verified",
  });
});

test("multiple verified jobs fail closed without dispatching a downstream lead", async () => {
  const state = fakeNewoEnv();
  state.operatingCustomers.push({ customer_id: "customer:phone:15875557788" });
  state.operatingJobs.push(
    {
      roof_job_id: "job:existing-1",
      job_status: "in_progress",
      updated_at: "2026-07-18T17:00:00.000Z",
      property_key: "property:123-main-street-edmonton",
      address_line1: "123 Main Street",
      postal_code: "T5J 0N3",
    },
    {
      roof_job_id: "job:existing-2",
      job_status: "qualified",
      updated_at: "2026-07-18T16:00:00.000Z",
      property_key: "property:123-main-street-edmonton-second",
      address_line1: "123 Main Street",
      postal_code: "T5J 0N3",
    },
  );

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
  const payload = JSON.parse(String([...state.envelopes.values()][0].payload_json));
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
  state.db.raw.prepare(
    `UPDATE newo_sessions
        SET verification_status = 'verified', matched_customer_id = ?, matched_property_id = ?,
            matched_roof_job_id = ?
      WHERE session_id = 'session-001'`,
  ).run(foreign.customer_id, foreign.property_key, foreign.roof_job_id);

  await assert.rejects(
    handleNewoQueueMessage(state.env as never, "event-001", false),
    /newo_native_association_mismatch/,
  );
  assert.equal(fetches, 0);
  assert.equal(tenantRows(state.db, "operating_leads"), 0);
  assert.equal(tenantRows(state.db, "operating_roof_jobs"), 0);
  const session = state.db.raw.prepare(
    "SELECT sync_status, last_error FROM newo_sessions WHERE session_id = 'session-001'",
  ).get() as Row;
  assert.equal(session.sync_status, "failed");
  assert.match(String(session.last_error), /newo_native_association_mismatch/);
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
