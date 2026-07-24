import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import {
  canonicalJson,
  parseNewoEvent,
  sha256Hex,
  type NewoEventV1,
} from "../src/newo.ts";

type Row = Record<string, unknown>;

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
              all: async () => ({ results: [] }),
            };
          },
        };
      },
    },
  };
  return { env, raw, jnQueue, newoQueue, calls, receipts, sessions, envelopes };
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
    const url = String(input);
    frappeCalls.push(url);
    if (url.includes("/api/resource/Roofing%20Customer?")) {
      return new Response(JSON.stringify({ data: [{
        name: "RC-PRIVATE-1",
        customer_id: "customer:phone:15875557788",
        phone: "+15875557788",
      }] }));
    }
    if (url.includes("/api/resource/Roof%20Job?")) {
      return new Response(JSON.stringify({ data: [{
        name: "RJ-PRIVATE-1",
        roof_job_id: "job:existing-1",
        job_status: "Materials Ordered",
        service_type: "Metal Roofing",
        roofing_property: "RP-PRIVATE-1",
        customer: "RC-PRIVATE-1",
        modified: "2026-07-18 17:00:00",
      }] }));
    }
    if (url.includes("/api/resource/Roofing%20Property?")) {
      return new Response(JSON.stringify({ data: [{
        name: "RP-PRIVATE-1",
        property_key: "property:123-main-street-edmonton",
        address_line1: "123 Main Street",
        city: "Edmonton",
        province: "AB",
        postal_code: "T5J 0N3",
      }] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  Object.assign(state.env, {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
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
  assert.equal(frappeCalls.length, 3);

  const capture = await worker.fetch(
    request("/webhook/newo", newoEvent()),
    state.env as never,
    ctx as never,
  );
  assert.equal(capture.status, 200);
  const envelope = [...state.envelopes.values()][0];
  const payload = JSON.parse(String(envelope.payload_json));
  assert.deepEqual(payload.owned_association, {
    customer_id: "customer:phone:15875557788",
    property_key: "property:123-main-street-edmonton",
    roof_job_id: "job:existing-1",
    verification_status: "verified",
  });
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
