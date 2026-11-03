import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";
import worker from "../src/index.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    const directory = new URL("../migrations/", import.meta.url);
    for (const migration of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(migration, directory), "utf8"));
    }
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
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

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read", "owner:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-07-18T18:00:00.000Z",
      session_expires_at: "2026-07-19T18:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: role === "field" ? "crew@example.com" : "ops@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-18T18:00:00.000Z",
      updated_at: "2026-07-18T18:00:00.000Z",
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function env(db: SqliteD1): Env {
  const queue = { send: async () => {}, sendBatch: async () => {} };
  return {
    DB: db as never,
    RAW: { put: async () => {} } as never,
    JN_QUEUE: queue as never,
    NEWO_QUEUE: queue as never,
    INGEST_TOKEN: "ingest-token",
    ADMIN_TOKEN: "admin-token",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    NEWO_PRODUCTION_REQUIRED: "true",
    NEWO_ENABLED: "false",
    NEWO_BOOKING_MODE: "request_only",
    NEWO_OUTBOUND_ENABLED: "false",
    NEWO_CONTROL_WRITE_ENABLED: "false",
    NEWO_EXPECTED_CONFIG_VERSION: "newo.production.v1",
    NEWO_ENABLED_CHANNELS: "voice",
    NEWO_TRANSFER_POLICY: "owner_then_voicemail",
    NEWO_USAGE_ALERT_PERCENT: "80",
  } as unknown as Env;
}

function seedSensitiveOperationsData(db: SqliteD1): void {
  db.raw
    .prepare(
      `INSERT INTO newo_sessions (
         session_id, project_id, agent_id, user_actor_id, conversation_id, channel, direction,
         status, outcome, contact_name, contact_phone, contact_email, address_line1, city,
         province, postal_code, division, service, urgency, appointment_request_id,
         handoff_status, booking_status, summary, transcript_ref, recording_ref, ai_disclosed,
         recording_disclosed, structured_json, raw_key, payload_hash, started_at, ended_at,
         duration_seconds, report_expected_at, report_received_at, missing_report_detected_at,
         sync_status, sync_attempts, last_error, sync_updated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'phone', 'inbound', 'ended', 'callback_required', ?, ?, ?, ?, ?,
         ?, ?, 'residential', 'Roof repair', 'urgent', ?, 'failed', 'requested', ?, ?, ?, 1, 1,
         ?, ?, ?, ?, ?, 180, ?, NULL, ?, 'dead', 6, ?, ?, ?, ?)`,
    )
    .run(
      "session-sensitive-1",
      "project-sensitive",
      "agent-sensitive",
      "user-sensitive",
      "conversation-sensitive",
      "Caller Secret",
      "+15875550101",
      "private@example.com",
      "1 Private Street",
      "Edmonton",
      "AB",
      "T5J 0N3",
      "appointment-sensitive",
      "Transcript secret summary",
      "transcript://private",
      "recording://private",
      JSON.stringify({ transcript: "Transcript secret body" }),
      "raw/newo/private.json",
      "payload-secret-hash",
      "2026-07-18T18:00:00.000Z",
      "2026-07-18T18:03:00.000Z",
      "2026-07-18T18:30:00.000Z",
      "2026-07-18T18:31:00.000Z",
      "private sync error",
      "2026-07-18T18:10:00.000Z",
      "2026-07-18T18:00:00.000Z",
      "2026-07-18T18:10:00.000Z",
    );
  db.raw
    .prepare(
      `INSERT INTO newo_event_receipts (
         event_id, session_id, event_type, payload_hash, raw_key, status, response_json,
         attempts, last_error, first_seen_at, last_seen_at, completed_at
       ) VALUES (?, ?, 'session_ended', ?, ?, 'dead', ?, 6, ?, ?, ?, ?)`,
    )
    .run(
      "event-sensitive-1",
      "session-sensitive-1",
      "event-payload-secret",
      "raw/newo/event-sensitive.json",
      JSON.stringify({ provider_response: "provider secret" }),
      "private event error",
      "2026-07-18T18:00:00.000Z",
      "2026-07-18T18:10:00.000Z",
      "2026-07-18T18:10:00.000Z",
    );
  db.raw
    .prepare(
      `INSERT INTO newo_control_actions (
         action_id, operation, args_hash, args_json, status, requested_by, approved_by,
         approval_reason, dry_run_receipt_hash, approval_receipt_hash, provider_response_hash,
         dry_run_expires_at, approval_expires_at, result_json, consumed_at, last_error,
         created_at, updated_at, completed_at
       ) VALUES (?, 'update_agent', ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-sensitive-1",
      "args-secret-hash",
      JSON.stringify({ api_key: "control argument secret" }),
      "requester-sensitive",
      "approver-sensitive",
      "Approval because private",
      "dry-secret-hash",
      "approval-secret-hash",
      "provider-secret-hash",
      "2026-07-18T18:15:00.000Z",
      "2026-07-18T18:15:00.000Z",
      JSON.stringify({ provider: "provider control secret" }),
      "2026-07-18T18:05:00.000Z",
      "private control error",
      "2026-07-18T18:00:00.000Z",
      "2026-07-18T18:05:00.000Z",
      "2026-07-18T18:05:00.000Z",
    );
  db.raw
    .prepare(
      `INSERT INTO dead_letter (ts, envelope_id, stage, error, payload_json, recovered)
       VALUES (?, ?, 'newo_frappe_sync', ?, ?, 0)`,
    )
    .run(
      "2026-07-18T18:10:00.000Z",
      "envelope-sensitive",
      "private dead-letter error",
      JSON.stringify({ secret: "private dead-letter payload" }),
    );
  db.raw
    .prepare(
      `INSERT INTO newo_reconciliation_runs (
         run_id, run_type, status, ran_at, retryable_syncs_requeued, missing_reports,
         failed_handoffs, pending_bookings, unresolved_incidents, drift_reasons_json,
         usage_status, usage_minutes, usage_limit_minutes, detail_json
       ) VALUES (?, 'daily', 'degraded', ?, 1, 1, 1, 1, 2, ?,
         'unavailable_from_documented_api', NULL, 500, ?)`,
    )
    .run(
      "daily-sensitive-1",
      "2026-07-18T18:15:00.000Z",
      JSON.stringify(["project_id_missing"]),
      JSON.stringify({ provider_detail: "private reconciliation detail" }),
    );
}

/** Every office-plane and Newo check passes; Frappe stays enabled only as a negative control. */
function readyEnv(db: SqliteD1): Env {
  return {
    ...(env(db) as unknown as Record<string, unknown>),
    APP_TENANT_ID: "ironwrap",
    MEASUREMENT_QUEUE: { send: async () => {} },
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    BACKUP_ALERT_EMAIL: "backup@example.invalid",
    FROM_EMAIL: "bus@example.invalid",
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"svc@example.invalid"}',
    NEWO_ENABLED: "true",
    NEWO_WEBHOOK_TOKEN: "webhook-secret-not-returned",
    NEWO_BOOKING_TOKEN: "booking-secret-not-returned",
    NEWO_CONTROL_SIGNING_SECRET: "control-signing-secret-longer-than-thirty-two-characters",
    NEWO_API_BASE_URL: "https://api.newo.example",
    NEWO_API_KEY: "provider-secret-not-returned",
    NEWO_API_TIMEOUT_MS: "1000",
    NEWO_PROJECT_ID: "project-1",
    NEWO_AGENT_ID: "agent-1",
    NEWO_REPORT_WEBHOOK_ID: "report-hook",
    NEWO_REPORT_WEBHOOK_URL: "https://bus.example/webhook/newo/report",
    NEWO_HANDOFF_WEBHOOK_ID: "handoff-hook",
    NEWO_HANDOFF_WEBHOOK_URL: "https://bus.example/webhook/newo/handoff",
    NEWO_TOOL_SCHEMA_SHA256: "a".repeat(64),
    NEWO_REPORT_SCHEMA_SHA256: "b".repeat(64),
    NEWO_KB_VERSION: "ironwrap-receptionist.v1",
    NEWO_KB_SHA256: "c".repeat(64),
    NEWO_PHONE_NUMBER: "+14035550100",
    NEWO_OWNER_TRANSFER_NUMBER: "+17805550101",
    NEWO_R2_LIFECYCLE_PROVEN: "true",
    NEWO_USAGE_LIMIT_MINUTES: "1000",
    NEWO_JOBNIMBUS_BOOKING_PROVEN: "false",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
  } as unknown as Env;
}

/** Answers the Newo API probes; records every outbound URL so a test can prove what was not called. */
function mockNewoApi(t: TestContext): string[] {
  const requested: string[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      return json({
        access_token: "access-not-returned",
        refresh_token: "refresh-not-returned",
        token_type: "Bearer",
        expires_in: 900,
      });
    }
    if (url.endsWith("/api/v1/actors/agent/agent-1")) return json({ id: "agent-1" });
    if (url.endsWith("/api/v1/webhooks")) {
      return json([
        { id: "report-hook", url: "https://bus.example/webhook/newo/report" },
        { id: "handoff-hook", url: "https://bus.example/webhook/newo/handoff" },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return requested;
}

/** Drives the real daily cron and waits for all of its work, Newo reconciliation included. */
async function runDailyCron(runtime: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron: "0 14 * * *", scheduledTime: Date.now(), noRetry() {} } as never,
    runtime as never,
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(pending);
}

test("Newo operations read is office-only, exception-first, and redacts provider content", async () => {
  const db = new SqliteD1();
  seedSensitiveOperationsData(db);
  const runtime = env(db);
  const request = new Request("https://app.example.com/api/v1/newo/operations");

  const response = await handleAuthenticatedRoute(
    request,
    runtime as never,
    auth("ops"),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(body.version, 1);
  assert.equal(body.status, "attention");
  assert.equal(body.readiness.status, "not_ready");
  assert.equal(body.counts.dlq_items, 1);
  assert.equal(body.counts.failed_handoffs, 1);
  // The failed handoff is the open callback issue: D1 counts it, not a Frappe incident read.
  assert.equal(body.counts.unresolved_incidents, 1);
  assert.deepEqual(
    body.readiness.checks.map((check: { id: string }) => check.id),
    [
      "owned_database",
      "raw_store",
      "enabled",
      "webhook_credentials",
      "api_authentication",
      "production_actor",
      "report_webhooks",
      "configuration",
      "queue",
      "dlq",
      "jobnimbus",
      "booking_mode",
    ],
  );
  assert.equal(body.exceptions.missing_reports.length, 1);
  assert.equal(body.exceptions.failed_handoffs.length, 1);
  assert.equal(body.exceptions.pending_bookings.length, 1);
  assert.equal(body.exceptions.sync_failures.length, 1);
  assert.deepEqual(Object.keys(body.recent_sessions[0]).sort(), [
    "booking_status",
    "channel",
    "created_at",
    "direction",
    "division",
    "duration_seconds",
    "ended_at",
    "handoff_status",
    "missing_report_detected_at",
    "outcome",
    "report_expected_at",
    "report_received_at",
    "service",
    "session_id",
    "started_at",
    "status",
    "sync_attempts",
    "sync_status",
    "updated_at",
    "urgency",
  ]);
  assert.deepEqual(Object.keys(body.exceptions.failed_events[0]).sort(), [
    "attempts",
    "event_id",
    "event_type",
    "first_seen_at",
    "last_seen_at",
    "session_id",
    "status",
  ]);
  assert.deepEqual(Object.keys(body.exceptions.control_failures[0]).sort(), [
    "action_id",
    "completed_at",
    "created_at",
    "operation",
    "status",
    "updated_at",
  ]);
  assert.deepEqual(Object.keys(body.exceptions.dlq_items[0]).sort(), [
    "id",
    "recorded_at",
    "stage",
  ]);

  const serialized = JSON.stringify(body);
  for (const privateValue of [
    "Caller Secret",
    "+15875550101",
    "private@example.com",
    "1 Private Street",
    "Transcript secret",
    "transcript://private",
    "recording://private",
    "raw/newo/",
    "control argument secret",
    "Approval because private",
    "provider control secret",
    "private dead-letter payload",
    "private reconciliation detail",
  ]) {
    assert.equal(
      serialized.includes(privateValue),
      false,
      `leaked ${privateValue}`,
    );
  }

  const field = await handleAuthenticatedRoute(
    request,
    runtime as never,
    auth("field"),
  );
  assert.equal(field.status, 403);
  assert.deepEqual(await field.json(), { error: "office_role_required" });
  db.raw.close();
});

test("Newo reports ready, and its daily run ok, without Frappe; a failed handoff is the open issue", async (t) => {
  const db = new SqliteD1();
  const runtime = readyEnv(db);
  const requested = mockNewoApi(t);
  const read = async () => {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/newo/operations"),
      runtime as never,
      auth("ops"),
    );
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, any>;
  };
  const latestDailyRun = () => ({
    ...(db.raw
      .prepare(
        `SELECT status, failed_handoffs, unresolved_incidents FROM newo_reconciliation_runs
          WHERE run_type = 'daily' ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as Record<string, unknown>),
  });

  const clean = await read();
  assert.equal(clean.readiness.status, "ready");
  assert.equal(clean.status, "ready");
  assert.equal(clean.counts.unresolved_incidents, 0);
  await runDailyCron(runtime);
  assert.deepEqual(latestDailyRun(), { status: "ok", failed_handoffs: 0, unresolved_incidents: 0 });

  db.raw
    .prepare(
      `INSERT INTO newo_sessions (
         session_id, status, outcome, handoff_status, structured_json, raw_key, payload_hash,
         sync_status, created_at, updated_at
       ) VALUES (?, 'ended', 'callback_required', 'failed', '{}', ?, ?, 'synced', ?, ?)`,
    )
    .run(
      "session-handoff-1",
      "raw/newo/session-handoff-1.json",
      "d".repeat(64),
      "2026-07-18T18:00:00.000Z",
      "2026-07-18T18:05:00.000Z",
    );
  const handoffFailed = await read();
  assert.equal(handoffFailed.readiness.status, "ready");
  assert.equal(handoffFailed.status, "attention");
  assert.equal(handoffFailed.counts.failed_handoffs, 1);
  assert.equal(handoffFailed.counts.unresolved_incidents, 1);
  await runDailyCron(runtime);
  assert.deepEqual(latestDailyRun(), { status: "degraded", failed_handoffs: 1, unresolved_incidents: 1 });

  assert.deepEqual(
    requested.filter((url) => url.startsWith("https://frappe.example.invalid")),
    [],
  );
  db.raw.close();
});

test("Owner runtime read is office-only and excludes privileged diagnostic detail", async () => {
  const db = new SqliteD1();
  seedSensitiveOperationsData(db);
  const runtime = env(db);
  const request = new Request("https://app.example.com/api/v1/owner/runtime");

  const response = await handleAuthenticatedRoute(
    request,
    runtime as never,
    auth("ops"),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(body).sort(), [
    "operations",
    "read_model_generated_at",
    "readiness",
    "status",
    "version",
  ]);
  assert.deepEqual(
    body.readiness.checks.map((check: { id: string }) => check.id),
    [
      "owned_persistence",
      "queue",
      "core_auth",
      "provider_delivery",
      "office_bff",
      "customer_portal",
      "public_estimate",
      "newo",
    ],
  );
  assert.deepEqual(Object.keys(body.operations).sort(), [
    "audit_failure_window_hours",
    "audit_failures_observed",
    "counts",
    "heartbeat",
    "quickbooks_final_invoices",
    "quickbooks_receipts",
    "status",
  ]);
  assert.equal(body.operations.counts.open_dead_letters, 1);

  const serialized = JSON.stringify(body);
  for (const privateValue of [
    "Caller Secret",
    "+15875550101",
    "private@example.com",
    "1 Private Street",
    "Transcript secret",
    "raw/newo/",
    "control argument secret",
    "private dead-letter payload",
    "private reconciliation detail",
  ]) {
    assert.equal(
      serialized.includes(privateValue),
      false,
      `leaked ${privateValue}`,
    );
  }

  const field = await handleAuthenticatedRoute(
    request,
    runtime as never,
    auth("field"),
  );
  assert.equal(field.status, 403);
  assert.deepEqual(await field.json(), { error: "office_role_required" });
  db.raw.close();
});
