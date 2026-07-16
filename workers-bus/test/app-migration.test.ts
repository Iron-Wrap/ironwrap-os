import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
  for (const route of ["/api/*", "/health", "/ready", "/admin/*", "/ingest/*", "/webhook/*"]) {
    assert.ok(config.includes(`"${route}"`), `missing Worker-first route ${route}`);
  }
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
