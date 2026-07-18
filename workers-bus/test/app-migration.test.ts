import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("0011 auth migration contains every readiness artifact and never stores raw tokens", async () => {
  const sql = await readFile(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8");
  for (const table of [
    "app_users", "app_magic_links", "app_sessions", "app_auth_throttles", "app_auth_audit",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_app_users_tenant_role_active",
    "idx_app_magic_links_user_expiry",
    "idx_app_sessions_user_expiry",
    "idx_app_auth_throttles_expiry",
    "idx_app_auth_audit_tenant_created",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.match(sql, /session_hash TEXT PRIMARY KEY/);
  assert.doesNotMatch(sql, /raw_token|raw_session|session_token|magic_token/i);
  assert.match(sql, /role IN \('owner', 'ops', 'field'\)/);
  assert.match(sql, /UNIQUE \(tenant_id, email_normalized\)/);
  assert.match(sql, /UNIQUE \(user_id\)/);
});

test("Wrangler asset routing keeps all dynamic/auth surfaces Worker-first", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"directory": "\.\.\/app\/dist"/);
  assert.match(config, /"not_found_handling": "single-page-application"/);
  for (const route of ["/api/*", "/health", "/ready", "/admin/*", "/ingest/*", "/public/*", "/webhook/*"]) {
    assert.ok(config.includes(`"${route}"`), `missing Worker-first route ${route}`);
  }
});

test("0018 customer portal migration stores only revocable capability hashes", async () => {
  const sql = await readFile(new URL("../migrations/0018_customer_portal_links.sql", import.meta.url), "utf8");
  for (const table of ["customer_portal_links", "customer_portal_access_throttles"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_customer_portal_links_tenant_job_active",
    "idx_customer_portal_access_throttles_expiry",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /customer_id TEXT NOT NULL/);
  assert.match(sql, /revoked_at TEXT/);
  assert.match(sql, /FOREIGN KEY \(issued_by_user_id, tenant_id\)[\s\S]*ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /raw_token|portal_token|token_value/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0019 measurement intake migration keeps retries hash-addressed and reviewable", async () => {
  const sql = await readFile(new URL("../migrations/0019_measurement_intake_receipts.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS measurement_intake_receipts\b/);
  assert.match(sql, /idempotency_key_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /measurement_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /content_type TEXT NOT NULL/);
  assert.match(sql, /key_strategy IN \('request_header', 'provider_attachment', 'attachment_job', 'payload_hash'\)/);
  assert.match(sql, /status IN \('processing', 'matched', 'unmatched', 'retryable_error'\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_measurement_intake_receipts_exception_updated\b/);
  assert.match(sql, /raw_key GLOB 'raw\/measurements\/\[0-9a-f\]\*\.json'/);
  assert.doesNotMatch(sql, /raw_provider_id|attachment_identifier|signed_report_url/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0021 public estimate rate guard stores only bounded keyed hashes", async () => {
  const sql = await readFile(new URL("../migrations/0021_public_estimate_rate_limits.sql", import.meta.url), "utf8");
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public_estimate_rate_limits\b/);
  assert.match(sql, /PRIMARY KEY \(scope, subject_hash\)/);
  assert.match(sql, /scope IN \('ip', 'client'\)/);
  assert.match(sql, /length\(subject_hash\) = 64/);
  assert.match(sql, /idx_public_estimate_rate_limits_expiry/);
  assert.doesNotMatch(schema, /raw_ip|ip_address|client_submission_id|turnstile|contact_email|contact_phone|customer_name/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0012 field migration preserves idempotent actions and immutable media receipts", async () => {
  const sql = await readFile(new URL("../migrations/0012_field_companion.sql", import.meta.url), "utf8");
  for (const table of ["field_actions", "field_action_media"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /device_action_id TEXT PRIMARY KEY/);
  assert.match(sql, /PRIMARY KEY \(device_action_id, attachment_id\)/);
  assert.match(sql, /r2_key TEXT NOT NULL UNIQUE/);
  assert.match(sql, /checksum_sha256 TEXT NOT NULL/);
  assert.match(sql, /ON DELETE RESTRICT/g);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
  assert.match(
    sql,
    /status IN \('processing', 'r2_stored', 'frappe_persisted', 'verified', 'retryable_error'\)/,
  );
});

test("0013 field upload throttles are bounded and user-scoped", async () => {
  const sql = await readFile(new URL("../migrations/0013_field_action_throttles.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_action_throttles\b/);
  assert.match(sql, /PRIMARY KEY \(tenant_id, user_id, scope\)/);
  assert.match(sql, /scope IN \('field_upload'\)/);
  assert.match(sql, /idx_app_action_throttles_expiry/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0014 QR pairing binds field sessions to revocable hashed device proofs", async () => {
  const sql = await readFile(new URL("../migrations/0014_device_pairing.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE app_sessions ADD COLUMN device_id TEXT/);
  for (const table of ["app_device_pairings", "app_devices"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const index of [
    "idx_app_sessions_device_active",
    "idx_app_device_pairings_user_expiry",
    "idx_app_devices_tenant_user_active",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`));
  }
  assert.match(sql, /device_proof_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.doesNotMatch(sql, /raw_token|raw_session|device_proof[^_h]|pairing_token/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("0015 lead-ack receipts preserve provider-acceptance evidence without recipient content", async () => {
  const sql = await readFile(new URL("../migrations/0015_lead_ack_receipts.sql", import.meta.url), "utf8");
  const schema = sql.replace(/^--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_ack_receipts\b/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_lead_ack_receipts_envelope_observed\b/);
  for (const trigger of ["prevent_lead_ack_receipts_update", "prevent_lead_ack_receipts_delete"]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}\\b`));
  }
  assert.match(sql, /BEFORE UPDATE ON lead_ack_receipts/);
  assert.match(sql, /BEFORE DELETE ON lead_ack_receipts/);
  assert.match(sql, /RAISE\(ABORT, 'lead_ack_receipts_immutable'\)/);
  assert.match(sql, /provider_accepted/);
  assert.match(sql, /attempt_failed/);
  assert.match(sql, /no_eligible_channel/);
  assert.match(sql, /provider_message_id TEXT/);
  assert.doesNotMatch(schema, /recipient|contact_email|message_body|raw_message/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("approval migrations avoid nested CASE statements in remote D1 trigger commands", async () => {
  const sql = await readFile(new URL("../migrations/0016_approval_requests.sql", import.meta.url), "utf8");
  for (const migration of [
    "0016_approval_requests.sql",
    "0017_quote_revision_approval_requests.sql",
    "0020_production_schedule_approval_requests.sql",
  ]) {
    const migrationSql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
    assert.doesNotMatch(migrationSql, /\bCASE\b/i);
    assert.match(migrationSql, /COALESCE\(NULLIF\(NEW\.state, 'executing'\), 'execution_claimed'\)/);
  }
  for (const code of [
    "approval_request_version_transition_required",
    "approval_request_transition_actor_required",
    "approval_request_reconciliation_requires_uncertain",
    "approval_request_reconciliation_actor_required",
  ]) {
    assert.match(sql, new RegExp(`SELECT RAISE\\(ABORT, '${code}'\\)\\s+WHERE`));
  }
});

test("the complete D1 migration chain applies cleanly and carries every schedule-ledger invariant", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    assert.equal(migrations.length, 25);
    assert.equal(migrations[0], "0001_init.sql");
    assert.equal(migrations.at(-1), "0025_newo_reconciliation.sql");
    for (const migration of migrations) {
      db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }

    assert.equal(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const counts = db.prepare(
      `SELECT
         SUM(type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
         SUM(type = 'index' AND name LIKE 'idx_%') AS indexes,
         SUM(type = 'trigger') AS triggers
       FROM sqlite_master`,
    ).get() as { tables: number; indexes: number; triggers: number };
    assert.deepEqual({ ...counts }, { tables: 34, indexes: 60, triggers: 31 });

    const newoTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'newo_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(newoTables.map(({ name }) => name), [
      "newo_control_actions",
      "newo_event_receipts",
      "newo_reconciliation_runs",
      "newo_sessions",
      "newo_slot_reservations",
    ]);
    const receiptColumns = db.prepare("PRAGMA table_info(newo_event_receipts)").all() as Array<{
      name: string;
      pk: number;
    }>;
    assert.equal(receiptColumns.find(({ name }) => name === "event_id")?.pk, 1);
    assert.equal(receiptColumns.some(({ name }) => /transcript|recording|payload_json/.test(name)), false);
    const controlColumns = db.prepare("PRAGMA table_info(newo_control_actions)").all() as Array<{
      name: string;
    }>;
    for (const name of [
      "approval_reason", "dry_run_expires_at", "approval_expires_at", "result_json", "consumed_at",
    ]) {
      assert.equal(controlColumns.some((column) => column.name === name), true, `missing ${name}`);
    }
    const sessionColumns = db.prepare("PRAGMA table_info(newo_sessions)").all() as Array<{ name: string }>;
    for (const name of [
      "report_expected_at", "report_received_at", "report_event_id",
      "missing_report_detected_at", "sync_updated_at",
    ]) {
      assert.equal(sessionColumns.some((column) => column.name === name), true, `missing ${name}`);
    }
    const reconciliationColumns = db.prepare("PRAGMA table_info(newo_reconciliation_runs)").all() as Array<{
      name: string;
    }>;
    for (const name of [
      "run_type", "status", "missing_reports", "unresolved_incidents",
      "drift_reasons_json", "usage_status", "usage_minutes", "usage_limit_minutes",
    ]) {
      assert.equal(reconciliationColumns.some((column) => column.name === name), true, `missing ${name}`);
    }

    const scheduleTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'production_schedule_approval_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(scheduleTables.map(({ name }) => name), [
      "production_schedule_approval_request_events",
      "production_schedule_approval_requests",
    ]);
    const scheduleIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_production_schedule_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(scheduleIndexes.map(({ name }) => name), [
      "idx_production_schedule_approval_events_tenant_created",
      "idx_production_schedule_approvals_active_target",
      "idx_production_schedule_approvals_pending_expiry",
      "idx_production_schedule_approvals_state_lease",
      "idx_production_schedule_approvals_tenant_state_updated",
    ]);
    const scheduleTriggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%production_schedule_approval%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(scheduleTriggers.map(({ name }) => name), [
      "append_production_schedule_approval_created_event",
      "append_production_schedule_approval_reconciliation_event",
      "append_production_schedule_approval_transition_event",
      "enforce_production_schedule_approval_reconciliation",
      "enforce_production_schedule_approval_transition",
      "prevent_production_schedule_approval_binding_rewrite",
      "prevent_production_schedule_approval_delete",
      "prevent_production_schedule_approval_event_delete",
      "prevent_production_schedule_approval_event_update",
    ]);
  } finally {
    db.close();
  }
});
