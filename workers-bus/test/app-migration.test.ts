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
