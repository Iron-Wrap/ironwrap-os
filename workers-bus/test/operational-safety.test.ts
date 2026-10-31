import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import {
  BULK_REPLAY_CONFIRMATION,
  deadLetterReplayDueAt,
  sweepDeadLetterAutoReplay,
} from "../src/operations.ts";
import { DEAD_LETTER_SWEEP_APPROVER, markDeadLettersRecovered } from "../src/store.ts";
import { NEWO_CALLBACK_SCHEMA_QUERY } from "../src/newo-callback-schema.ts";

// The readiness double serves installed SQL from actual migrations, never invented guard text.
const newoSchemaDatabase = new DatabaseSync(":memory:");
for (const name of readdirSync(new URL("../migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
  newoSchemaDatabase.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}
const newoSchemaRows = newoSchemaDatabase.prepare(NEWO_CALLBACK_SCHEMA_QUERY).all();
newoSchemaDatabase.close();

const A = "ow_11111111-1111-4111-8111-111111111111";
const B = "ow_22222222-2222-4222-8222-222222222222";
const C = "ow_33333333-3333-4333-8333-333333333333";
const APPROVAL = {
  run_id: "hermes-run-20260710-001",
  approved_by: "owner@example.com",
  reason: "Re-drive after the upstream outage was verified resolved.",
};

interface FakeOptions {
  d1Throws?: boolean;
  missingSchemaArtifact?: boolean;
  missingAccessRoleIndex?: boolean;
  weakFacetAssociationTrigger?: boolean;
  activeNullAccessRole?: boolean;
  heartbeatAt?: string;
  qbAt?: string;
  auditFailures?: Array<Record<string, unknown>>;
  counts?: { pending: number; stuck: number; frappe_errors: number };
  replayCounts?: { failed: number; stuck: number };
  queueBatchThrows?: boolean;
  queueBatchFailCount?: number;
  queueBatchGate?: Promise<void>;
  onQueueBatch?: () => void;
  claimConflictFor?: string;
}

function fakeEnv(options: FakeOptions = {}) {
  const statuses = new Map([[A, "dead"], [B, "dead"], [C, "pushed"]]);
  const deadLetters = [
    { envelope_id: A, recovered: 0, ts: "2026-07-10T01:00:00.000Z" },
    { envelope_id: B, recovered: 0, ts: "2026-07-10T02:00:00.000Z" },
    { envelope_id: C, recovered: 0, ts: "2026-07-10T03:00:00.000Z" },
  ];
  const queue: string[] = [];
  const audits: Array<{ sql: string; args: unknown[] }> = [];
  const sourceCounts: Array<{ day: string; channel: string; count: number }> = [];
  const sqlCalls: Array<{ sql: string; args: unknown[] }> = [];
  const replayRequests = new Map<string, {
    run_id: string;
    selection: "targeted" | "bulk";
    envelope_id: string | null;
    approved_by: string;
    reason: string;
    status: "running" | "completed" | "failed";
    matched: number | null;
    requeued: number | null;
    last_error: string | null;
    attempt_count: number;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>();
  let queueBatchFailuresRemaining = options.queueBatchFailCount ?? 0;
  const now = Date.now();

  const executeFirst = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (options.d1Throws && sql.includes("sqlite_master")) throw new Error("d1_unavailable");
    if (sql.includes("AS access_role_index_sql")) {
      return {
        access_role_index_sql: options.missingAccessRoleIndex
          ? null
          : `CREATE INDEX idx_app_users_tenant_access_role_active
               ON app_users (tenant_id, active, access_role, updated_at)`,
        facet_association_trigger_sql: `CREATE TRIGGER facet_design_evidence_associations_validate_insert
          BEFORE INSERT ON facet_design_evidence_associations BEGIN
            SELECT RAISE(ABORT, 'facet_design_association_event_anchor_mismatch') WHERE NOT EXISTS (
              SELECT 1 FROM facet_customer_approval_events AS event
              WHERE event.event_type = 'facet.design.customer_approved.v2'
                AND event.schema_version = 2
                AND event.approval_actor_type = 'customer_capability'
                AND event.identity_assurance = 'bearer_capability_only'
            );
            SELECT RAISE(ABORT, 'facet_design_association_office_actor_required') WHERE NOT EXISTS (
              SELECT 1 FROM app_users AS actor
              WHERE actor.user_id = NEW.associated_by_user_id
                AND actor.tenant_id = NEW.tenant_id
                AND actor.active = 1
                AND ${options.weakFacetAssociationTrigger ? "actor.role" : "actor.access_role"} IN ('owner', 'ops')
            );
          END`,
        unresolved_access_roles: options.activeNullAccessRole ? 1 : 0,
      };
    }
    if (sql.includes("sqlite_master")) {
      return { table_count: 49, index_count: options.missingSchemaArtifact ? 65 : 66, trigger_count: 63 };
    }
    if (sql.includes("COUNT(*) AS n FROM dead_letter")) {
      return { n: deadLetters.filter((row) => row.recovered === 0).length };
    }
    if (sql.includes("FROM heartbeat ORDER BY")) {
      return {
        day: "2026-07-10",
        ran_at: options.heartbeatAt ?? new Date(now - 60_000).toISOString(),
        reconciled: 1,
        dead_letter_open: 0,
      };
    }
    if (sql.includes("COUNT(*) AS pending")) {
      const counts = options.counts ?? { pending: 3, stuck: 1, frappe_errors: 2 };
      return { pending: counts.pending, stuck: counts.stuck };
    }
    if (sql.includes("COUNT(*) AS frappe_errors")) {
      return { frappe_errors: (options.counts ?? { pending: 3, stuck: 1, frappe_errors: 2 }).frappe_errors };
    }
    if (sql.includes("COUNT(DISTINCT r.envelope_id)")) {
      const approver = String(args[0]);
      const settled = new Set(
        [...replayRequests.values()]
          .filter((row) => row.approved_by === approver && row.envelope_id !== null)
          .map((row) => row.envelope_id as string)
          .filter((id) => !["dead", "pending_jn_push"].includes(statuses.get(id) ?? "")),
      );
      return { n: settled.size };
    }
    if (sql.includes("FROM replay_requests") && sql.includes("AS failed")) {
      return options.replayCounts ?? { failed: 0, stuck: 0 };
    }
    if (sql.includes("FROM replay_requests WHERE run_id = ?")) {
      return replayRequests.get(String(args[0])) ?? null;
    }
    if (sql.includes("FROM quickbooks_webhook_receipts ORDER BY")) {
      return options.qbAt === "none" ? null : {
        payload_hash: "hash-not-returned",
        first_seen_at: new Date(now - 7_200_000).toISOString(),
        last_seen_at: options.qbAt ?? new Date(now - 3_600_000).toISOString(),
        envelope_id: "qb_receipt",
        raw_key: "raw/not-returned.json",
        events_count: 2,
        replay_count: 1,
      };
    }
    return null;
  };

  const executeAll = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (sql === NEWO_CALLBACK_SCHEMA_QUERY) return { results: newoSchemaRows };
    // The sweep's own candidate query. Checked before the shared replayable-dead query below,
    // which it would otherwise match on "FROM dead_letter d".
    if (sql.includes("AS dead_since")) {
      const approver = String(args[0]);
      const noop = new Set([String(args[1]), String(args[2])]);
      const limit = Number(args[3]);
      const deadSince = new Map<string, string>();
      for (const row of deadLetters) {
        if (row.recovered !== 0 || statuses.get(row.envelope_id) !== "dead") continue;
        const seen = deadSince.get(row.envelope_id);
        if (seen === undefined || row.ts < seen) deadSince.set(row.envelope_id, row.ts);
      }
      const rows = [...deadSince].map(([envelope_id, dead_since]) => {
        const booked = [...replayRequests.values()].filter((row) =>
          row.envelope_id === envelope_id && row.approved_by === approver &&
          // The episode bound the real query carries (`r.created_at >= ep.dead_since`). Without it
          // an envelope inherited every attempt it had ever spent, so one exhausted outage made it
          // manual-only for life -- ELEC-137 defect 2. The real SQL is exercised against real
          // SQLite in dead-letter-sweep-episodes.test.ts; this double only has to agree with it.
          row.created_at >= dead_since &&
          (row.last_error === null || !noop.has(row.last_error))
        );
        const stamps = booked.map((row) => row.created_at).sort();
        return {
          envelope_id,
          attempts: booked.length,
          last_attempt_at: stamps.at(-1) ?? null,
          dead_since,
        };
      });
      rows.sort((a, b) => a.dead_since < b.dead_since ? -1 : a.dead_since > b.dead_since ? 1 : 0);
      return { results: rows.slice(0, limit) };
    }
    if (sql.includes("FROM dead_letter d")) {
      const selected = args[0] == null ? null : String(args[0]);
      const ids = deadLetters
        .filter((row) => row.recovered === 0 && statuses.get(row.envelope_id) === "dead")
        .filter((row) => selected === null || row.envelope_id === selected)
        .map((row) => ({ envelope_id: row.envelope_id }));
      return { results: ids };
    }
    // No cron ticks in this double: a missing row reads as "stale" the same way a schema that
    // predates IRO-262 would (cron-liveness.test.ts covers the fresh/starting/stale handler paths
    // for real).
    if (sql.includes("FROM cron_heartbeat")) {
      return { results: [] };
    }
    if (sql.includes("FROM audit_log WHERE result = 'error'")) {
      return { results: options.auditFailures ?? [{
        id: 7,
        ts: new Date(now - 30_000).toISOString(),
        automation: "erpnext_push",
        trigger: "queue",
        envelope_id: A,
        action: "push_attempt_2",
        result: "error",
        error: "frappe unavailable",
        recovery_owner: "owner@example.com",
      }] };
    }
    return { results: [] };
  };

  const executeRun = async (sql: string, args: unknown[]) => {
    sqlCalls.push({ sql, args });
    if (sql.includes("INSERT INTO replay_requests")) {
      const runId = String(args[0]);
      // Migration 0010's CHECK constraints, enforced here so a malformed automated claim fails in
      // tests the way D1 would fail it in production -- inside ctx.waitUntil, where it is invisible.
      const selection = String(args[1]);
      const insertEnvelopeId = args[2] === null ? null : String(args[2]);
      if (runId.length < 3 || runId.length > 128) {
        throw new Error("CHECK constraint failed: replay_requests.run_id");
      }
      if (String(args[3]).length < 3 || String(args[3]).length > 128) {
        throw new Error("CHECK constraint failed: replay_requests.approved_by");
      }
      if (String(args[4]).length < 10 || String(args[4]).length > 500) {
        throw new Error("CHECK constraint failed: replay_requests.reason");
      }
      if ((selection === "targeted") !== (insertEnvelopeId !== null)) {
        throw new Error("CHECK constraint failed: replay_requests.selection");
      }
      if (replayRequests.has(runId)) throw new Error("UNIQUE constraint failed: replay_requests.run_id");
      replayRequests.set(runId, {
        run_id: runId,
        selection: String(args[1]) as "targeted" | "bulk",
        envelope_id: args[2] === null ? null : String(args[2]),
        approved_by: String(args[3]),
        reason: String(args[4]),
        status: "running",
        matched: null,
        requeued: null,
        last_error: null,
        attempt_count: 1,
        created_at: String(args[5]),
        updated_at: String(args[6]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'running'")) {
      const runId = String(args[1]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "failed") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "running",
        matched: null,
        requeued: null,
        last_error: null,
        attempt_count: row.attempt_count + 1,
        updated_at: String(args[0]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'completed'")) {
      const runId = String(args[4]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "running") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "completed",
        matched: Number(args[0]),
        requeued: Number(args[1]),
        last_error: null,
        updated_at: String(args[2]),
        completed_at: String(args[3]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE replay_requests") && sql.includes("SET status = 'failed'")) {
      const runId = String(args[2]);
      const row = replayRequests.get(runId);
      if (!row || row.status !== "running") return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        status: "failed",
        last_error: String(args[0]),
        updated_at: String(args[1]),
        completed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE envelopes SET status = 'pending_jn_push'")) {
      const id = String(args[1]);
      if (statuses.get(id) !== "dead") return { success: true, meta: { changes: 0 } };
      if (options.claimConflictFor === id) {
        statuses.set(id, "pending_jn_push");
        return { success: true, meta: { changes: 0 } };
      }
      statuses.set(id, "pending_jn_push");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE envelopes SET status = 'dead'")) {
      const id = String(args[1]);
      if (statuses.get(id) !== "pending_jn_push") return { success: true, meta: { changes: 0 } };
      statuses.set(id, "dead");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dead_letter SET recovered = 1")) {
      const id = String(args[0]);
      let changes = 0;
      for (const row of deadLetters) {
        if (row.envelope_id === id && row.recovered === 0) {
          row.recovered = 1;
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO audit_log")) audits.push({ sql, args });
    if (sql.includes("INSERT INTO source_counts")) {
      sourceCounts.push({ day: String(args[0]), channel: String(args[1]), count: Number(args[2]) });
    }
    return { success: true, meta: { changes: 1 } };
  };

  const env = {
    INGEST_TOKEN: "ingest-secret",
    ADMIN_TOKEN: "admin-secret",
    OWNER_ALERT_EMAIL: "owner@example.com",
    BACKUP_ALERT_EMAIL: "backup@example.com",
    FROM_EMAIL: "ops@example.com",
    GOOGLE_SERVICE_ACCOUNT_JSON: "service-account-secret",
    JOBNIMBUS_ENABLED: "true",
    JOBNIMBUS_API_KEY: "jobnimbus-secret",
    ERPNEXT_ENABLED: "false",
    STUCK_THRESHOLD_MIN: "15",
    RAW: { put: async () => {} },
    JN_QUEUE: {
      send: async ({ envelope_id }: { envelope_id: string }) => { queue.push(envelope_id); },
      sendBatch: async (messages: Array<{ body: { envelope_id: string } }>) => {
        options.onQueueBatch?.();
        if (options.queueBatchGate) await options.queueBatchGate;
        if (options.queueBatchThrows || queueBatchFailuresRemaining > 0) {
          if (queueBatchFailuresRemaining > 0) queueBatchFailuresRemaining--;
          throw new Error("queue_unavailable");
        }
        for (const message of messages) queue.push(message.body.envelope_id);
      },
    },
    MEASUREMENT_QUEUE: { send: async () => {} },
    DB: {
      prepare(sql: string) {
        const statement = (args: unknown[]) => ({
          first: async () => executeFirst(sql, args),
          all: async () => executeAll(sql, args),
          run: async () => executeRun(sql, args),
        });
        return {
          ...statement([]),
          bind: (...args: unknown[]) => statement(args),
        };
      },
    },
  };
  return { env, statuses, deadLetters, queue, audits, sourceCounts, sqlCalls, replayRequests };
}

function enableAppBff(env: Record<string, unknown>): void {
  Object.assign(env, {
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "https://app.example.com",
    APP_ALLOWED_ORIGINS: "https://app.example.com",
    APP_ALLOW_INSECURE_LOCAL: "false",
    APP_AUTH_PEPPER: "readiness-test-pepper-longer-than-thirty-two-characters",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
    // An enabled BFF carries both field-capture rails, and each holds its own Frappe
    // issuer pair. Reusing the bus pair here would be the very state readiness rejects.
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet-capture-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet-capture-secret",
    WORK_PACKAGE_FRAPPE_API_KEY: "work-package-key",
    WORK_PACKAGE_FRAPPE_API_SECRET: "work-package-secret",
  });
}

function enableProductionScheduleApproval(env: Record<string, unknown>): void {
  enableAppBff(env);
  Object.assign(env, {
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "https://schedule-broker.example.com",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: "production-schedule-v1",
    APP_PRODUCTION_SCHEDULE_APPROVER_ID: "owner@example.com",
    APP_PRODUCTION_SCHEDULE_MAX_SESSION_AGE_SECONDS: "900",
    APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS: "15000",
    APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS: "45",
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: "production-schedule-shared-secret-longer-than-thirty-two-bytes",
  });
}

const ctx = {} as never;
const adminHeaders = { authorization: "Bearer admin-secret", "content-type": "application/json" };

test("public readiness exposes only a generic state while admins receive the diagnostic map", async () => {
  const { env, sqlCalls } = fakeEnv();
  const correlationId = "corr-12345678";
  const response = await worker.fetch(new Request("https://bus.example/ready", {
    headers: { "x-correlation-id": correlationId },
  }), env as never, ctx);
  const body = await response.json() as { ok: boolean };

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-request-id"), correlationId);
  assert.equal(response.headers.get("x-correlation-id"), correlationId);

  const diagnosticResponse = await worker.fetch(new Request("https://bus.example/ready", {
    headers: adminHeaders,
  }), env as never, ctx);
  const diagnostic = await diagnosticResponse.json() as {
    ok: boolean;
    owned_core_ok: boolean;
    office_operating_plane_ok: boolean;
    projection_rails_ok: boolean;
    status: string;
    checks: Record<string, boolean>;
  };
  assert.equal(diagnosticResponse.status, 200);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.owned_core_ok, true);
  assert.equal(diagnostic.office_operating_plane_ok, true);
  assert.equal(diagnostic.projection_rails_ok, false);
  assert.equal(diagnostic.status, "ready");
  assert.ok(Object.values(diagnostic.checks).every(Boolean));
  const schemaQuery = sqlCalls.find((call) => call.sql.includes("sqlite_master"));
  assert.ok(schemaQuery, "D1 was queried");
  assert.match(schemaQuery.sql, /production_schedule_approval_requests/);
  assert.match(schemaQuery.sql, /prevent_production_schedule_approval_binding_rewrite/);
  assert.equal(diagnostic.checks.production_schedule_configuration, true, "blank primary schedule inputs keep the rail intentionally disabled");
  assert.equal(diagnostic.checks.public_estimate_configuration, true, "blank public-estimate config keeps the route intentionally disabled");
  assert.equal(JSON.stringify(diagnostic).includes("ingest-secret"), false);
  assert.equal(JSON.stringify(diagnostic).includes("jobnimbus-secret"), false);
});

test("default readiness stays green when the office BFF is on without leftover Frappe secrets", async () => {
  const { env } = fakeEnv();
  enableAppBff(env);
  delete (env as { ERPNEXT_BASE_URL?: string }).ERPNEXT_BASE_URL;
  delete (env as { ERPNEXT_API_KEY?: string }).ERPNEXT_API_KEY;
  delete (env as { ERPNEXT_API_SECRET?: string }).ERPNEXT_API_SECRET;
  delete (env as { FLEET_CAPTURE_FRAPPE_API_KEY?: string }).FLEET_CAPTURE_FRAPPE_API_KEY;
  delete (env as { WORK_PACKAGE_FRAPPE_API_KEY?: string }).WORK_PACKAGE_FRAPPE_API_KEY;

  const ready = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true });

  const projection = await worker.fetch(
    new Request("https://bus.example/ready?scope=projection"),
    env as never,
    ctx,
  );
  assert.equal(projection.status, 503);
  assert.deepEqual(await projection.json(), { ok: false });
});

test("readiness scopes isolate Frappe projection failure from the owned and office planes", async () => {
  const { env } = fakeEnv();
  (env as Record<string, unknown>).ERPNEXT_ENABLED = "true";

  for (const [scope, expectedStatus] of [
    [null, 200],
    ["core", 200],
    ["owned_core", 200],
    ["office", 200],
    ["projection", 503],
  ] as const) {
    const url = new URL("https://bus.example/ready");
    if (scope) url.searchParams.set("scope", scope);
    const response = await worker.fetch(new Request(url), env as never, ctx);
    assert.equal(response.status, expectedStatus, scope ?? "full");
    assert.deepEqual(await response.json(), { ok: expectedStatus === 200 }, scope ?? "full");
  }
});

test("Newo production readiness requires credentials, live actor/webhooks, Frappe, and clear owned failures", async (t) => {
  const { env } = fakeEnv();
  Object.assign(env, {
    NEWO_PRODUCTION_REQUIRED: "true",
    NEWO_ENABLED: "true",
    NEWO_CONTROL_WRITE_ENABLED: "false",
    NEWO_OUTBOUND_ENABLED: "false",
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
    NEWO_EXPECTED_CONFIG_VERSION: "newo.production.v1",
    NEWO_TOOL_SCHEMA_SHA256: "a".repeat(64),
    NEWO_REPORT_SCHEMA_SHA256: "b".repeat(64),
    NEWO_KB_VERSION: "ironwrap-receptionist.v1",
    NEWO_KB_SHA256: "c".repeat(64),
    NEWO_PHONE_NUMBER: "+14035550100",
    NEWO_ENABLED_CHANNELS: "voice",
    // Callback only (owner decision MD-05): readiness needs no transfer policy or number.
    NEWO_R2_LIFECYCLE_PROVEN: "true",
    NEWO_USAGE_LIMIT_MINUTES: "1000",
    NEWO_USAGE_ALERT_PERCENT: "80",
    NEWO_BOOKING_MODE: "request_only",
    NEWO_JOBNIMBUS_BOOKING_PROVEN: "false",
    NEWO_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      return new Response(JSON.stringify({
        access_token: "access-not-returned",
        refresh_token: "refresh-not-returned",
        token_type: "Bearer",
        expires_in: 900,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/actors/agent/agent-1")) {
      return new Response(JSON.stringify({ id: "agent-1" }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/v1/webhooks")) {
      return new Response(JSON.stringify([
        { id: "report-hook", url: "https://bus.example/webhook/newo/report" },
        { id: "handoff-hook", url: "https://bus.example/webhook/newo/handoff" },
      ]), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/method/ping")) {
      return new Response(JSON.stringify({ message: "pong" }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as {
    ok: boolean;
    checks: Record<string, boolean>;
    newo: { required: boolean; api_authenticated: boolean; frappe_reachable: boolean };
  };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.newo.required, true);
  assert.equal(body.newo.api_authenticated, true);
  assert.equal(body.newo.frappe_reachable, true);
  assert.ok(Object.entries(body.checks).filter(([name]) => name.startsWith("newo_")).every(([, value]) => value));
  assert.equal(JSON.stringify(body).includes("not-returned"), false);

  delete (env as { NEWO_WEBHOOK_TOKEN?: string }).NEWO_WEBHOOK_TOKEN;
  (env as { ERPNEXT_ENABLED?: string }).ERPNEXT_ENABLED = "false";
  const blocked = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const blockedBody = await blocked.json() as {
    ok: boolean;
    projection_rails_ok: boolean;
    checks: Record<string, boolean>;
  };
  // Default /ready is the office plane. Newo/Frappe leftover failures stay on
  // the projection scope instead of turning the Worker not-ready.
  assert.equal(blocked.status, 200);
  assert.equal(blockedBody.ok, true);
  assert.equal(blockedBody.checks.newo_webhook_credentials, false);
  const projection = await worker.fetch(
    new Request("https://bus.example/ready?scope=projection"),
    env as never,
    ctx,
  );
  assert.equal(projection.status, 503);
});

test("health remains a backward-compatible liveness check when dependencies are unavailable", async () => {
  const { env, sqlCalls } = fakeEnv({ d1Throws: true, missingSchemaArtifact: true });
  delete (env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  delete (env as { RAW?: unknown }).RAW;

  const response = await worker.fetch(new Request("https://bus.example/health"), env as never, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sqlCalls.length, 0, "liveness must not query D1");
});

test("health and readiness support HEAD without emitting a response body", async () => {
  const { env, sqlCalls } = fakeEnv();
  const health = await worker.fetch(new Request("https://bus.example/health", { method: "HEAD" }), env as never, ctx);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "");
  assert.equal(sqlCalls.length, 0, "HEAD health remains a cheap liveness probe");

  const ready = await worker.fetch(new Request("https://bus.example/ready", { method: "HEAD" }), env as never, ctx);
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), "");
  assert.ok(sqlCalls.some((call) => call.sql.includes("sqlite_master")), "HEAD readiness still verifies the schema");
});

test("inactive private-app routes do not disclose their release state", async () => {
  const disabled = fakeEnv();
  const disabledResponse = await worker.fetch(
    new Request("https://bus.example/api/v1/session"),
    disabled.env as never,
    ctx,
  );
  assert.equal(disabledResponse.status, 404);
  assert.deepEqual(await disabledResponse.json(), { error: "not_found" });
  assert.equal(disabledResponse.headers.get("cache-control"), "no-store");

  const incomplete = fakeEnv();
  (incomplete.env as Record<string, unknown>).APP_BFF_ENABLED = "true";
  const incompleteResponse = await worker.fetch(
    new Request("https://bus.example/api/v1/session"),
    incomplete.env as never,
    ctx,
  );
  assert.equal(incompleteResponse.status, 404);
  assert.deepEqual(await incompleteResponse.json(), { error: "not_found" });
  assert.equal(incompleteResponse.headers.get("cache-control"), "no-store");
});

test("a failed public readiness probe stays generic", async () => {
  const { env } = fakeEnv({ d1Throws: true });
  const response = await worker.fetch(new Request("https://bus.example/ready"), env as never, ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});

test("readiness fails closed when D1 cannot be queried", async () => {
  const { env } = fakeEnv({ d1Throws: true });
  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { d1: boolean; schema: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.d1, false);
  assert.equal(body.checks.schema, false);
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
});

test("readiness fails closed when the operational migration artifacts are missing", async () => {
  const { env } = fakeEnv({ missingSchemaArtifact: true });
  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { d1: boolean; schema: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.d1, true);
  assert.equal(body.checks.schema, false);
});

test("readiness proves the explicit access-role authority contract", async (t) => {
  for (const [name, options] of [
    ["missing access-role index", { missingAccessRoleIndex: true }],
    ["legacy-role Facet trigger", { weakFacetAssociationTrigger: true }],
    ["active user without access role", { activeNullAccessRole: true }],
  ] as const) {
    await t.test(name, async () => {
      const { env } = fakeEnv(options);
      const response = await worker.fetch(
        new Request("https://bus.example/ready", { headers: adminHeaders }),
        env as never,
        ctx,
      );
      const body = await response.json() as {
        ok: boolean;
        checks: { d1: boolean; schema: boolean };
      };

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.checks.d1, true);
      assert.equal(body.checks.schema, false);
    });
  }
});

test("readiness fails closed when the public estimator is enabled without its complete boundary", async () => {
  const { env } = fakeEnv();
  (env as Record<string, unknown>).PUBLIC_ESTIMATE_ENABLED = "true";

  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: Record<string, boolean> };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.public_estimate_configuration, false);
});

test("readiness fails closed when measurement OCR is enabled without its secret", async () => {
  const { env } = fakeEnv();
  Object.assign(env, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_MODEL: "claude-opus-5",
  });

  const blocked = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const blockedBody = await blocked.json() as { checks: Record<string, boolean> };
  assert.equal(blocked.status, 503);
  assert.equal(blockedBody.checks.measurement_ocr_configuration, false);

  Object.assign(env, { MEASUREMENT_OCR_API_KEY: "anthropic-secret-not-returned" });
  const ready = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const readyBody = await ready.json() as { checks: Record<string, boolean> };
  assert.equal(ready.status, 200);
  assert.equal(readyBody.checks.measurement_ocr_configuration, true);
  assert.equal(JSON.stringify(readyBody).includes("not-returned"), false);

  delete (env as { MEASUREMENT_OCR_API_KEY?: string }).MEASUREMENT_OCR_API_KEY;
  Object.assign(env, {
    OMNIROUTE_URL: "https://omniroute.test",
    OMNIROUTE_API_KEY: "omni-secret-not-returned",
  });
  const omniReady = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const omniBody = await omniReady.json() as { checks: Record<string, boolean> };
  assert.equal(omniReady.status, 200);
  assert.equal(omniBody.checks.measurement_ocr_configuration, true);
  assert.equal(JSON.stringify(omniBody).includes("not-returned"), false);
});

test("readiness accepts a complete enabled production-schedule approval rail", async () => {
  const { env } = fakeEnv();
  enableProductionScheduleApproval(env as Record<string, unknown>);

  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: Record<string, boolean> };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.production_schedule_configuration, true);
});

test("readiness fails closed when production scheduling is partially configured", async () => {
  const { env } = fakeEnv();
  (env as Record<string, unknown>).APP_PRODUCTION_SCHEDULE_BROKER_URL = "https://schedule-broker.example.com";

  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: Record<string, boolean> };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.production_schedule_configuration, false);
});

test("readiness requires the BFF before an otherwise complete production-schedule rail is ready", async () => {
  const { env } = fakeEnv();
  Object.assign(env as Record<string, unknown>, {
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "https://schedule-broker.example.com",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: "production-schedule-v1",
    APP_PRODUCTION_SCHEDULE_APPROVER_ID: "owner@example.com",
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: "production-schedule-shared-secret-longer-than-thirty-two-bytes",
  });

  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: Record<string, boolean> };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.production_schedule_configuration, false);
});

test("readiness fails closed when the redundant alert path is not configured", async () => {
  const { env } = fakeEnv();
  delete (env as { BACKUP_ALERT_EMAIL?: string }).BACKUP_ALERT_EMAIL;
  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { notification_configuration: boolean } };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.notification_configuration, false);
});

test("readiness accepts a complete enabled app BFF configuration", async () => {
  const { env } = fakeEnv();
  enableAppBff(env);
  const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
  const body = await response.json() as { ok: boolean; checks: { app_bff_configuration: boolean } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.app_bff_configuration, true);
});

test("readiness fails closed for missing or malformed enabled app BFF metadata", async () => {
  const cases: Array<[string, unknown]> = [
    ["APP_TENANT_ID", "IronWrap"],
    ["APP_TENANT_NAME", ""],
    ["APP_TENANT_BRAND", ""],
    ["APP_LOCALE", "en-ca"],
    ["APP_TIME_ZONE", "Edmonton"],
    ["APP_CURRENCY", "cad"],
    ["APP_PUBLIC_ORIGIN", "http://app.example.com"],
    ["APP_ALLOWED_ORIGINS", "https://other.example.com"],
    ["APP_AUTH_PEPPER", "too-short"],
  ];

  for (const [key, invalidValue] of cases) {
    const { env } = fakeEnv();
    enableAppBff(env);
    (env as Record<string, unknown>)[key] = invalidValue;
    const response = await worker.fetch(new Request("https://bus.example/ready", { headers: adminHeaders }), env as never, ctx);
    const body = await response.json() as { ok: boolean; checks: { app_bff_configuration: boolean } };
    assert.equal(response.status, 503, key);
    assert.equal(body.ok, false, key);
    assert.equal(body.checks.app_bff_configuration, false, key);
  }
});

test("request-id selection rejects unsafe correlation ids and preserves a safe fallback", async () => {
  const { env } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/not-found", {
    headers: {
      "x-correlation-id": "bad,value",
      "x-request-id": "request-12345678",
    },
  }), env as never, ctx);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "request-12345678");
  assert.equal(response.headers.get("x-correlation-id"), "request-12345678");
});

test("each request emits one bounded completion record without query or credential data", async () => {
  const { env } = fakeEnv();
  Object.assign(env, { APP_TENANT_ID: "tenant-ironwrap" });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const response = await worker.fetch(new Request(
      "https://bus.example/not-found?token=do-not-log-me",
      {
        headers: {
          authorization: "Bearer do-not-log-me",
          "x-correlation-id": "event-12345678",
        },
      },
    ), env as never, ctx);
    assert.equal(response.status, 404);
  } finally {
    console.log = originalLog;
  }

  const completions = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === "http_request_completed");
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0], {
    ts: completions[0]?.ts,
    level: "info",
    msg: "http_request_completed",
    service: "ironwrap-worker",
    request_id: "event-12345678",
    tenant: "tenant-ironwrap",
    method: "GET",
    route: "/not-found",
    status: 404,
    duration_ms: completions[0]?.duration_ms,
    envelope_id: null,
    error_code: null,
  });
  assert.match(String(completions[0]?.ts), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Number.isInteger(completions[0]?.duration_ms), true);
  assert.equal(lines.join("\n").includes("do-not-log-me"), false);
  assert.ok(lines[0]?.length && lines[0].length < 1_024);
});

test("handled server failures emit an error completion with a stable code", async () => {
  const { env } = fakeEnv({ d1Throws: true });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const response = await worker.fetch(
      new Request("https://bus.example/ready", {
        headers: { "x-request-id": "ready-12345678" },
      }),
      env as never,
      ctx,
    );
    assert.equal(response.status, 503);
  } finally {
    console.log = originalLog;
  }

  const completions = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === "http_request_completed");
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.level, "error");
  assert.equal(completions[0]?.status, 503);
  assert.equal(completions[0]?.error_code, "http_5xx");
});

test("admin status reports heartbeat, operational counts, audit failures, and QB freshness", async () => {
  const { env } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/admin/status?audit_limit=5", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    heartbeat: { fresh: boolean; reconciled: boolean };
    counts: {
      open_dead_letters: number;
      pending: number;
      stuck: number;
      frappe_errors: number;
      replay_failed: number;
      replay_stuck: number;
    };
    recent_audit_failures: { entries: unknown[] };
    quickbooks_receipts: Record<string, unknown>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.heartbeat.fresh, true);
  assert.equal(body.heartbeat.reconciled, true);
  assert.deepEqual(body.counts, {
    open_dead_letters: 3,
    pending: 3,
    stuck: 1,
    frappe_errors: 2,
    replay_failed: 0,
    replay_stuck: 0,
  });
  assert.equal(body.recent_audit_failures.entries.length, 1);
  assert.equal(body.quickbooks_receipts.available, true);
  assert.equal(body.quickbooks_receipts.fresh, true);
  assert.equal("payload_hash" in body.quickbooks_receipts, false);
  assert.equal("raw_key" in body.quickbooks_receipts, false);
});

test("admin status treats implausibly future heartbeat timestamps as stale", async () => {
  const { env } = fakeEnv({ heartbeatAt: new Date(Date.now() + 3_600_000).toISOString() });
  const response = await worker.fetch(new Request("https://bus.example/admin/status", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    heartbeat: { age_seconds: number | null; fresh: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.heartbeat.age_seconds, null);
  assert.equal(body.heartbeat.fresh, false);
});

test("admin status surfaces failed and stale replay-ledger claims", async () => {
  const { env } = fakeEnv({ replayCounts: { failed: 2, stuck: 1 } });
  const response = await worker.fetch(new Request("https://bus.example/admin/status", {
    headers: adminHeaders,
  }), env as never, ctx);
  const body = await response.json() as {
    status: string;
    counts: { replay_failed: number; replay_stuck: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.counts.replay_failed, 2);
  assert.equal(body.counts.replay_stuck, 1);
});

test("targeted dead-letter replay claims and queues only the requested envelope", async () => {
  const { env, statuses, deadLetters, queue, audits } = fakeEnv();
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);
  const body = await response.json() as { requeued: number; envelope_id: string };

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    matched: 1,
    requeued: 1,
    envelope_id: A,
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.deepEqual(queue, [A]);
  assert.equal(statuses.get(A), "pending_jn_push");
  assert.equal(statuses.get(B), "dead");
  assert.ok(deadLetters.every((row) => row.recovered === 0), "requeue is not falsely marked recovered");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[3], A);
  assert.equal(audits[0].args[11], APPROVAL.run_id);
  assert.equal(audits[0].args[12], APPROVAL.approved_by);
  assert.equal(audits[0].args[13], APPROVAL.reason);
});

test("an exact completed run-id retry returns the stored outcome without queueing or auditing twice", async () => {
  const { env, queue, audits, replayRequests, sqlCalls } = fakeEnv();
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const first = await worker.fetch(request(), env as never, ctx);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { replayed: boolean }).replayed, false);

  const retry = await worker.fetch(request(), env as never, ctx);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    matched: 1,
    requeued: 1,
    envelope_id: A,
    run_id: APPROVAL.run_id,
    replayed: true,
  });
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "completed");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.attempt_count, 1);
  assert.equal(sqlCalls.filter((call) => call.sql.includes("FROM dead_letter d")).length, 1);
});

test("reusing a run id for a different replay or approval identity conflicts", async () => {
  const { env, queue, audits } = fakeEnv();
  const first = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(first.status, 200);

  const mismatches = [
    { envelope_id: B, ...APPROVAL },
    { envelope_id: A, ...APPROVAL, reason: "A different approved reason cannot reuse this run id." },
    { envelope_id: A, ...APPROVAL, approved_by: "different-owner@example.com" },
  ];
  for (const body of mismatches) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(body),
    }), env as never, ctx);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "replay_run_id_conflict",
      run_id: APPROVAL.run_id,
    });
  }
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
});

test("an exact retry safely reclaims a failed rolled-back run and then becomes replayable", async () => {
  const { env, statuses, queue, audits, replayRequests } = fakeEnv({ queueBatchFailCount: 1 });
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const failed = await worker.fetch(request(), env as never, ctx);
  assert.equal(failed.status, 500);
  assert.equal(statuses.get(A), "dead");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "failed");

  const retried = await worker.fetch(request(), env as never, ctx);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json() as { replayed: boolean }).replayed, false);
  assert.deepEqual(queue, [A]);
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "completed");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.attempt_count, 2);
  assert.equal(audits.length, 2, "failed and successful attempts retain separate audit rows");

  const stored = await worker.fetch(request(), env as never, ctx);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json() as { replayed: boolean }).replayed, true);
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 2);
});

test("a concurrent exact retry loses the run-id claim and cannot double-queue", async () => {
  let markQueueStarted!: () => void;
  let releaseQueue!: () => void;
  const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const { env, queue, audits } = fakeEnv({ queueBatchGate: queueGate, onQueueBatch: markQueueStarted });
  const request = () => new Request("https://bus.example/admin/replay", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  });

  const firstPromise = worker.fetch(request(), env as never, ctx);
  await queueStarted;
  const concurrent = await worker.fetch(request(), env as never, ctx);
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), {
    error: "replay_run_in_progress",
    run_id: APPROVAL.run_id,
  });

  releaseQueue();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.deepEqual(queue, [A]);
  assert.equal(audits.length, 1);
});

test("bulk dead-letter replay requires the exact hard confirmation", async () => {
  const { env, statuses, queue, audits } = fakeEnv();
  const denied = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(denied.status, 400);
  assert.equal(statuses.get(A), "dead");
  assert.deepEqual(queue, []);

  const confirmed = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, confirm: BULK_REPLAY_CONFIRMATION, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    matched: 2,
    requeued: 2,
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.deepEqual(queue, [A, B]);
  assert.equal(statuses.get(C), "pushed");

  const retry = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ all: true, confirm: BULK_REPLAY_CONFIRMATION, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    matched: 2,
    requeued: 2,
    run_id: APPROVAL.run_id,
    replayed: true,
  });
  assert.deepEqual(queue, [A, B]);
  assert.equal(audits.length, 1);
});

test("replay rejects malformed or non-replayable selections without changing state", async () => {
  const { env, statuses, queue } = fakeEnv();
  const cases = [
    { body: "{", status: 400, error: "invalid_json" },
    { body: JSON.stringify({}), status: 400, error: "invalid_envelope_id" },
    { body: JSON.stringify({ envelope_id: "ow_not-a-uuid" }), status: 400, error: "invalid_envelope_id" },
    { body: JSON.stringify({ all: "true" }), status: 400, error: "invalid_all_flag" },
    { body: JSON.stringify({ all: true, envelope_id: A, confirm: BULK_REPLAY_CONFIRMATION }), status: 400, error: "ambiguous_replay_selection" },
    { body: JSON.stringify({ envelope_id: C, ...APPROVAL }), status: 404, error: "dead_letter_not_replayable" },
  ];

  for (const item of cases) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: item.body,
    }), env as never, ctx);
    assert.equal(response.status, item.status);
    assert.equal((await response.json() as { error: string }).error, item.error);
  }
  assert.equal(statuses.get(A), "dead");
  assert.equal(statuses.get(B), "dead");
  assert.deepEqual(queue, []);
});

test("replay requires bounded approval evidence and never accepts a body token", async () => {
  const { env, statuses, queue, sqlCalls } = fakeEnv();
  const cases = [
    { body: { envelope_id: A }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, run_id: "x" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, approved_by: "x" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, reason: "too short" }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, reason: "x".repeat(501) }, error: "invalid_approval_context" },
    { body: { envelope_id: A, ...APPROVAL, approval_token: "must-not-be-accepted" }, error: "unexpected_replay_field" },
    {
      body: { all: true, confirm: BULK_REPLAY_CONFIRMATION },
      error: "invalid_approval_context",
    },
  ];

  for (const item of cases) {
    const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(item.body),
    }), env as never, ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, item.error);
  }
  assert.equal(statuses.get(A), "dead");
  assert.deepEqual(queue, []);
  assert.equal(sqlCalls.some((call) => call.sql.includes("FROM dead_letter d")), false);
});

test("queue publication failure restores a replay claim and records the failure", async () => {
  const { env, statuses, deadLetters, queue, audits, replayRequests } = fakeEnv({ queueBatchThrows: true });
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal" });
  assert.equal(statuses.get(A), "dead", "failed queue publication must not strand the claim as pending");
  assert.deepEqual(queue, []);
  assert.ok(deadLetters.every((row) => row.recovered === 0));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[8], "error");
  assert.equal(replayRequests.get(APPROVAL.run_id)?.status, "failed");
});

test("targeted replay reports an atomic-claim conflict without double-queueing", async () => {
  const { env, statuses, queue, audits } = fakeEnv({ claimConflictFor: A });
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "dead_letter_replay_conflict",
    run_id: APPROVAL.run_id,
    replayed: false,
  });
  assert.equal(statuses.get(A), "pending_jn_push", "the concurrent claimant keeps ownership");
  assert.deepEqual(queue, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].args[8], "error");
  assert.equal(audits[0].args[9], "dead_letter_replay_conflict");
});

test("source-count endpoint rejects malformed observations before D1", async () => {
  const { env, sourceCounts } = fakeEnv();
  const invalid = [
    { day: "2026-02-30", channel: "website", count: 1 },
    { day: "2026-07-10", channel: "email", count: 1 },
    { day: "2026-07-10", channel: "website", count: -1 },
    { day: "2026-07-10", channel: "website", count: 1.5 },
    { day: "2026-07-10", channel: "website", count: 1_000_001 },
    { day: "2026-07-10", channel: "website", count: "1" },
    { day: "2026-07-10", channel: true, count: 1 },
  ];
  for (const body of invalid) {
    const response = await worker.fetch(new Request("https://bus.example/admin/source-count", {
      method: "POST", headers: adminHeaders, body: JSON.stringify(body),
    }), env as never, ctx);
    assert.equal(response.status, 400);
  }
  const malformed = await worker.fetch(new Request("https://bus.example/admin/source-count", {
    method: "POST", headers: adminHeaders, body: "not-json",
  }), env as never, ctx);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json" });
  assert.deepEqual(sourceCounts, []);

  const valid = await worker.fetch(new Request("https://bus.example/admin/source-count", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ day: "2026-07-10", channel: "website", count: 0 }),
  }), env as never, ctx);
  assert.equal(valid.status, 200);
  assert.deepEqual(sourceCounts, [{ day: "2026-07-10", channel: "website", count: 0 }]);
});

test("dead-letter recovery update is envelope-scoped", async () => {
  const { env, deadLetters } = fakeEnv();
  const recovered = await markDeadLettersRecovered(env as never, A);
  assert.equal(recovered, 1);
  assert.equal(deadLetters.find((row) => row.envelope_id === A)?.recovered, 1);
  assert.equal(deadLetters.find((row) => row.envelope_id === B)?.recovered, 0);
});


// --------------------------------------------------------- ELEC-52 / IRO-194: auto-replay sweep
//
// The sweep re-drives dead-letter envelopes on the five-minute cron so the dual-surface pipeline
// heals itself. Dead-letter timestamps are set relative to Date.now() rather than to the fixture's
// hard-coded 2026-07-10 stamps, so the backoff assertions do not depend on the wall clock.

const MINUTE = 60_000;

/** Age every open dead letter by `minutes`, which is the sweep's clock before its first attempt. */
function ageDeadLetters(
  deadLetters: Array<{ envelope_id: string; recovered: number; ts: string }>,
  minutes: number,
  only?: string,
): void {
  for (const row of deadLetters) {
    if (only !== undefined && row.envelope_id !== only) continue;
    row.ts = new Date(Date.now() - minutes * MINUTE).toISOString();
  }
}

type FakeDeadLetter = { envelope_id: string; recovered: number; ts: string };

/** The envelope's open outage episode: `MIN(ts)` over its open rows, exactly as the query reads it. */
function deadSince(deadLetters: FakeDeadLetter[], envelopeId: string): string {
  return deadLetters
    .filter((row) => row.envelope_id === envelopeId && row.recovered === 0)
    .map((row) => row.ts)
    .sort()[0]!;
}

/**
 * The run id the sweep books, mirroring `deadLetterSweepRunId`.
 *
 * Attempt numbers restart at 1 every episode, so the id carries the episode stamp too: without it
 * a second outage's first attempt reused the first outage's run id and read back its cached
 * outcome, queueing nothing (ELEC-137 defect 4).
 */
function sweepRunId(deadLetters: FakeDeadLetter[], envelopeId: string, attempt: number): string {
  const episode = deadSince(deadLetters, envelopeId).replace(/[^0-9]/g, "").slice(0, 17);
  return `dls-${envelopeId}-${episode}-${attempt}`;
}

/**
 * A re-death inside the SAME outage: one more open row, and the envelope back to `dead`.
 *
 * Adding a row rather than re-stamping the existing one is the point. The episode is anchored at
 * its FIRST open row, so a re-death must not move `dead_since` -- and the fan-out this creates
 * (two open rows against one real attempt) is exactly what the shipped query miscounted.
 */
function redeath(
  deadLetters: FakeDeadLetter[],
  statuses: Map<string, string>,
  envelopeId: string,
): void {
  deadLetters.push({ envelope_id: envelopeId, recovered: 0, ts: new Date().toISOString() });
  statuses.set(envelopeId, "dead");
}

/**
 * Book a completed sweep replay for `envelopeId`, the way a previous tick would have left it.
 *
 * `minutesAgo` must be inside the envelope's open episode (fewer minutes than its dead-letter age),
 * or the attempt belongs to a resolved outage and the cap correctly ignores it.
 */
function seedSweepAttempts(
  replayRequests: Map<string, Record<string, unknown>>,
  deadLetters: FakeDeadLetter[],
  envelopeId: string,
  attempts: number,
  minutesAgo = 300,
): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const runId = sweepRunId(deadLetters, envelopeId, attempt);
    const at = new Date(Date.now() - minutesAgo * MINUTE).toISOString();
    replayRequests.set(runId, {
      run_id: runId,
      selection: "targeted",
      envelope_id: envelopeId,
      approved_by: DEAD_LETTER_SWEEP_APPROVER,
      reason: `Automated dead-letter reconciliation sweep: attempt ${attempt} of 5 for envelope ${envelopeId}.`,
      status: "completed",
      matched: 1,
      requeued: 1,
      last_error: null,
      attempt_count: 1,
      created_at: at,
      updated_at: at,
      completed_at: at,
    });
  }
}

test("the sweep auto-replays due dead-letter envelopes and books each under the cron identity", async () => {
  const { env, statuses, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 120);

  const result = await sweepDeadLetterAutoReplay(env as never);

  // C's dead letter is open but its envelope is already 'pushed', so it is not a candidate.
  assert.equal(result.scanned, 2);
  assert.equal(result.due, 2);
  assert.equal(result.replayed, 2);
  assert.equal(result.given_up, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.conflicted, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(queue.sort(), [A, B].sort());
  assert.equal(statuses.get(A), "pending_jn_push");
  assert.equal(statuses.get(B), "pending_jn_push");
  assert.equal(statuses.get(C), "pushed");

  // Trap 3: targeted, never bulk -- 'bulk' forces envelope_id IS NULL and would erase the
  // per-envelope attribution the attempt cap is counted from.
  const booked = [...replayRequests.values()].filter((row) => row.approved_by === DEAD_LETTER_SWEEP_APPROVER);
  assert.equal(booked.length, 2);
  for (const row of booked) {
    assert.equal(row.selection, "targeted");
    assert.ok(row.envelope_id === A || row.envelope_id === B);
    assert.equal(row.status, "completed");
    assert.equal(row.run_id, sweepRunId(deadLetters, row.envelope_id!, 1));
    // Trap 2: migration 0010 CHECKs length(reason) BETWEEN 10 AND 500 and approved_by 3..128.
    assert.ok(row.reason.length >= 10 && row.reason.length <= 500);
    assert.ok(row.approved_by.length >= 3 && row.approved_by.length <= 128);
    assert.ok(row.run_id.length >= 3 && row.run_id.length <= 128);
  }
});

test("a freshly dead envelope waits out its backoff window before the first automatic attempt", async () => {
  const { env, deadLetters, queue } = fakeEnv();
  ageDeadLetters(deadLetters, 120);
  ageDeadLetters(deadLetters, 1, A); // died a minute ago: inside the 5-minute default window

  const result = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(result.scanned, 2);
  assert.equal(result.due, 1);
  assert.equal(result.replayed, 1);
  assert.deepEqual(queue, [B]);
});

test("backoff doubles per booked attempt and is clamped so it cannot overflow", () => {
  const at = "2026-08-21T00:00:00.000Z";
  const base = Date.parse(at);
  assert.equal(deadLetterReplayDueAt(at, 0, 5), base + 5 * MINUTE);
  assert.equal(deadLetterReplayDueAt(at, 1, 5), base + 10 * MINUTE);
  assert.equal(deadLetterReplayDueAt(at, 2, 5), base + 20 * MINUTE);
  assert.equal(deadLetterReplayDueAt(at, 3, 5), base + 40 * MINUTE);
  assert.equal(deadLetterReplayDueAt(at, 4, 5), base + 80 * MINUTE);
  // Clamped at 2^10 rather than growing without bound.
  assert.equal(deadLetterReplayDueAt(at, 99, 5), base + 5 * MINUTE * 1024);
  assert.equal(deadLetterReplayDueAt("not-a-date", 0, 5), null);
});

test("an envelope inside its backoff window is skipped, and replayed once the window elapses", async () => {
  const { env, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);
  // One booked attempt => the next is due 10 minutes after it, not 5.
  seedSweepAttempts(replayRequests, deadLetters, A, 1, 6);
  seedSweepAttempts(replayRequests, deadLetters, B, 1, 11);

  const result = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(result.scanned, 2);
  assert.equal(result.due, 1);
  assert.equal(result.replayed, 1);
  assert.deepEqual(queue, [B]);
  assert.equal(replayRequests.get(sweepRunId(deadLetters, B, 2))?.status, "completed");
  assert.equal(replayRequests.has(sweepRunId(deadLetters, A, 2)), false);
});

test("the sweep gives up at the attempt cap and leaves the envelope for manual replay", async () => {
  const { env, statuses, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);
  seedSweepAttempts(replayRequests, deadLetters, A, 5);

  const result = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(result.scanned, 2);
  assert.equal(result.given_up, 1);
  assert.equal(result.replayed, 1);
  assert.deepEqual(queue, [B]);
  // Terminal for the SWEEP only: the envelope stays dead with its dead letter open, which is what
  // keeps the admin path below possible.
  assert.equal(statuses.get(A), "dead");
  assert.equal(replayRequests.has(sweepRunId(deadLetters, A, 6)), false);

  // AC #1: manual replay still works after the cap.
  const response = await worker.fetch(new Request("https://bus.example/admin/replay", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ envelope_id: A, ...APPROVAL }),
  }), env as never, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    replayed: false,
    matched: 1,
    requeued: 1,
    envelope_id: A,
    run_id: APPROVAL.run_id,
  });
  assert.equal(statuses.get(A), "pending_jn_push");
  assert.ok(queue.includes(A));
});

test("each attempt takes a fresh run id, so a repeat sweep re-queues instead of replaying a cached outcome", async () => {
  const { env, statuses, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);

  const first = await sweepDeadLetterAutoReplay(env as never);
  assert.equal(first.replayed, 2);

  // The replay did not stick: the envelope died again and its dead letter is still open. Backdate
  // the booked attempt so the second tick is past the 10-minute window one attempt earns.
  redeath(deadLetters, statuses, A);
  const booked = replayRequests.get(sweepRunId(deadLetters, A, 1))!;
  booked.created_at = new Date(Date.now() - 30 * MINUTE).toISOString();

  const second = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(second.replayed, 1);
  // Trap 1: claimReplayRequest keys on run_id. Reusing `dls-<A>-1` would return the cached
  // completed outcome and queue nothing at all.
  assert.equal(replayRequests.get(sweepRunId(deadLetters, A, 2))?.status, "completed");
  assert.equal(queue.filter((id) => id === A).length, 2);
});

test("losing a race to an admin replay does not burn one of the envelope's automatic attempts", async () => {
  const racing: FakeOptions = { claimConflictFor: A };
  const { env, statuses, deadLetters, queue, replayRequests } = fakeEnv(racing);
  ageDeadLetters(deadLetters, 600);

  const raced = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(raced.replayed, 1); // B only
  assert.equal(raced.conflicted, 1); // A was already claimed elsewhere
  assert.equal(raced.failed, 0);
  assert.deepEqual(queue, [B]);
  assert.equal(replayRequests.get(sweepRunId(deadLetters, A, 1))?.last_error, "dead_letter_replay_conflict");

  // Trap 4: that ledger row records "nothing left to replay", not a failed delivery attempt, so it
  // is excluded from the attempt count -- the exact retry reclaims the same run id and re-queues.
  racing.claimConflictFor = undefined; // the competing claim has finished
  statuses.set(A, "dead");
  const retry = await sweepDeadLetterAutoReplay(env as never);

  assert.equal(retry.replayed, 1);
  assert.equal(retry.conflicted, 0);
  assert.equal(replayRequests.get(sweepRunId(deadLetters, A, 1))?.status, "completed");
  assert.equal(replayRequests.has(sweepRunId(deadLetters, A, 2)), false);
  assert.ok(queue.includes(A));
});

test("the sweep counts envelopes it replayed that have since settled, and reports a truncated scan", async () => {
  const { env, statuses, deadLetters, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);
  seedSweepAttempts(replayRequests, deadLetters, C, 1); // C's envelope is 'pushed': a completed recovery

  const result = await sweepDeadLetterAutoReplay(
    Object.assign(env, { DEAD_LETTER_AUTO_REPLAY_SCAN_LIMIT: "1" }) as never,
  );

  assert.equal(result.scanned, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.recovered, 1);
  // An in-flight replay is not a recovery: the envelope it just queued is pending, not settled.
  assert.equal(statuses.get(A), "pending_jn_push");
});

test("the sweep can be switched off without a deploy and then queues nothing", async () => {
  const { env, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);

  const result = await sweepDeadLetterAutoReplay(
    Object.assign(env, { DEAD_LETTER_AUTO_REPLAY_ENABLED: "false" }) as never,
  );

  assert.deepEqual(result, {
    scanned: 0, due: 0, replayed: 0, conflicted: 0, failed: 0, given_up: 0, recovered: 0,
    truncated: false,
  });
  assert.deepEqual(queue, []);
  assert.equal(replayRequests.size, 0);
});

test("the five-minute cron runs the sweep", async () => {
  const { env, deadLetters, queue, replayRequests } = fakeEnv();
  ageDeadLetters(deadLetters, 600);
  const pending: Promise<unknown>[] = [];

  await worker.scheduled(
    { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as never,
    env as never,
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as never,
  );
  await Promise.all(pending.map((promise) => promise.catch(() => {})));

  assert.deepEqual(queue.sort(), [A, B].sort());
  assert.equal(
    [...replayRequests.values()].filter((row) => row.approved_by === DEAD_LETTER_SWEEP_APPROVER).length,
    2,
  );
});
