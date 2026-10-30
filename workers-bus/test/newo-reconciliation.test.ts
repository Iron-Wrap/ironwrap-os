import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { reconcileNewoSessions } from "../src/newo.ts";
import {
  markNewoSessionSync,
  upsertNewoSession,
  type NewoSessionRecord,
} from "../src/newo-store.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0023_newo_reception.sql",
      "0024_newo_caller_association.sql",
      "0025_newo_control_evidence.sql",
      "0026_newo_reconciliation.sql",
      // 0151: the reconcile counts only failed handoffs no person has resolved.
      "0151_newo_handoff_resolutions.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
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

  constructor(
    raw: DatabaseSync,
    sql: string,
    args: unknown[],
  ) {
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

function session(overrides: Partial<NewoSessionRecord> = {}): NewoSessionRecord {
  return {
    session_id: "session-reconcile-1",
    project_id: "project-1",
    agent_id: "agent-1",
    user_actor_id: "user-1",
    conversation_id: "conversation-1",
    channel: "phone",
    direction: "inbound",
    status: "active",
    outcome: "lead_captured",
    contact_name: "Test Caller",
    contact_phone: "+15875550101",
    contact_email: null,
    address_line1: "1 Test Street",
    city: "Edmonton",
    province: "AB",
    postal_code: "T5J 0N3",
    division: "residential",
    service: "Roof repair",
    urgency: "routine",
    lead_envelope_id: null,
    appointment_request_id: null,
    handoff_status: null,
    booking_status: null,
    summary: "Lead captured.",
    transcript_ref: null,
    recording_ref: null,
    ai_disclosed: 1,
    recording_disclosed: 0,
    structured_json: JSON.stringify({ schema_version: "newo.event.v1" }),
    raw_key: "raw/newo/events/2026-07-18/event-1.json",
    payload_hash: "a".repeat(64),
    started_at: "2026-07-18T18:00:00.000Z",
    ended_at: null,
    duration_seconds: null,
    report_expected_at: "2026-07-18T18:30:00.000Z",
    report_received_at: null,
    report_event_id: null,
    missing_report_detected_at: null,
    sync_status: "pending",
    sync_attempts: 0,
    last_error: null,
    sync_updated_at: "2026-07-18T18:00:05.000Z",
    created_at: "2026-07-18T18:00:00.000Z",
    updated_at: "2026-07-18T18:00:00.000Z",
    ...overrides,
  };
}

test("Newo reconciliation requeues stale syncs and detects a missing report only once", async () => {
  const db = new SqliteD1();
  const queued: unknown[] = [];
  const env = {
    DB: db as never,
    NEWO_ENABLED: "true",
    NEWO_PRODUCTION_REQUIRED: "true",
    NEWO_SYNC_RETRY_MINUTES: "5",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "owner@example.com",
    NEWO_QUEUE: {
      sendBatch: async (messages: unknown[]) => queued.push(...messages),
    },
  } as never;
  await upsertNewoSession(env, session());
  db.raw.prepare(
    `INSERT INTO newo_event_receipts (
       event_id, session_id, event_type, payload_hash, raw_key, status,
       response_json, attempts, first_seen_at, last_seen_at, completed_at
     ) VALUES (?, ?, 'lead_captured', ?, ?, 'accepted', '{}', 1, ?, ?, ?)`,
  ).run(
    "event-1",
    "session-reconcile-1",
    "a".repeat(64),
    "raw/newo/events/2026-07-18/event-1.json",
    "2026-07-18T18:00:00.000Z",
    "2026-07-18T18:00:00.000Z",
    "2026-07-18T18:00:01.000Z",
  );

  const first = await reconcileNewoSessions(env, new Date("2026-07-18T18:35:00.000Z"));
  assert.deepEqual(first, { retryable_syncs_requeued: 1, newly_missing_reports: 1 });
  assert.deepEqual(queued, [{ body: { newo_event_id: "event-1" } }]);
  const stored = db.raw.prepare(
    "SELECT missing_report_detected_at FROM newo_sessions WHERE session_id = ?",
  ).get("session-reconcile-1") as { missing_report_detected_at: string };
  assert.equal(stored.missing_report_detected_at, "2026-07-18T18:35:00.000Z");
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'missing_report_detected'").get() as { n: number }).n,
    1,
  );
  const run = db.raw.prepare(
    "SELECT status, retryable_syncs_requeued, missing_reports, usage_status FROM newo_reconciliation_runs",
  ).get() as Record<string, unknown>;
  assert.deepEqual({ ...run }, {
    status: "degraded",
    retryable_syncs_requeued: 1,
    missing_reports: 1,
    usage_status: "not_checked",
  });

  const second = await reconcileNewoSessions(env, new Date("2026-07-18T18:36:00.000Z"));
  assert.equal(second.newly_missing_reports, 0);
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'missing_report_detected'").get() as { n: number }).n,
    1,
  );
  db.raw.close();
});

test("queue sync timestamps cannot suppress a later provider report", async () => {
  const db = new SqliteD1();
  const env = { DB: db as never } as never;
  await upsertNewoSession(env, session());
  await markNewoSessionSync(
    env,
    "session-reconcile-1",
    "synced",
    null,
    "2026-07-18T18:10:00.000Z",
  );
  db.raw.prepare(
    "UPDATE newo_sessions SET missing_report_detected_at = ? WHERE session_id = ?",
  ).run("2026-07-18T18:31:00.000Z", "session-reconcile-1");
  await upsertNewoSession(env, session({
    status: "ended",
    outcome: "completed",
    summary: "Session report received.",
    ended_at: "2026-07-18T18:05:00.000Z",
    duration_seconds: 300,
    report_expected_at: null,
    report_received_at: "2026-07-18T18:05:00.000Z",
    report_event_id: "event-report-1",
    raw_key: "raw/newo/events/2026-07-18/event-report-1.json",
    payload_hash: "b".repeat(64),
    sync_updated_at: "2026-07-18T18:11:00.000Z",
    updated_at: "2026-07-18T18:05:00.000Z",
  }));

  const stored = db.raw.prepare(
    `SELECT status, updated_at, sync_updated_at, report_received_at, report_event_id,
            missing_report_detected_at
       FROM newo_sessions WHERE session_id = ?`,
  ).get("session-reconcile-1") as Record<string, unknown>;
  assert.deepEqual({ ...stored }, {
    status: "ended",
    updated_at: "2026-07-18T18:05:00.000Z",
    sync_updated_at: "2026-07-18T18:11:00.000Z",
    report_received_at: "2026-07-18T18:05:00.000Z",
    report_event_id: "event-report-1",
    missing_report_detected_at: null,
  });
  db.raw.close();
});

test("a stored session keeps its strongest handoff status and its highest urgency", async () => {
  const db = new SqliteD1();
  const env = { DB: db as never } as never;
  const stored = () => ({
    ...(db.raw.prepare("SELECT handoff_status, urgency FROM newo_sessions WHERE session_id = ?")
      .get("session-reconcile-1") as Record<string, unknown>),
  });
  const later = (minute: number, overrides: Partial<NewoSessionRecord>) => upsertNewoSession(env, session({
    updated_at: `2026-07-18T18:${String(minute).padStart(2, "0")}:00.000Z`,
    ...overrides,
  }));

  await later(0, { handoff_status: "requested", urgency: "emergency" });
  // A later snapshot with another status (an old "completed"), no status, or a lower urgency
  // never clears a requested callback or lowers the urgency.
  await later(1, { handoff_status: "completed", urgency: "routine" });
  assert.deepEqual(stored(), { handoff_status: "requested", urgency: "emergency" });
  await later(2, { handoff_status: null, urgency: "urgent" });
  assert.deepEqual(stored(), { handoff_status: "requested", urgency: "emergency" });
  // failed outranks requested, and a later requested does not undo it.
  await later(3, { handoff_status: "failed" });
  await later(4, { handoff_status: "requested" });
  assert.deepEqual(stored(), { handoff_status: "failed", urgency: "emergency" });
  db.raw.close();
});
