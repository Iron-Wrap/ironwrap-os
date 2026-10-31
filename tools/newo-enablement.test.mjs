import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { newoCallbackRecordPresent } from "./newo-enablement.mjs";
import { NEWO_CALLBACK_SCHEMA_QUERY, newoCallbackSchemaMatches } from "../workers-bus/src/newo-callback-schema.ts";
import { NEWO_TENANT_BINDING_QUERY, newoTenantBindingsReady } from "../workers-bus/src/newo-tenant-readiness.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixture(t, extraSql) {
  const copy = mkdtempSync(join(tmpdir(), "newo-schema-admission-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const directory = join(copy, "workers-bus/migrations");
  mkdirSync(directory, { recursive: true });
  cpSync(join(root, "workers-bus/migrations"), directory, { recursive: true });
  if (extraSql) writeFileSync(join(directory, "0999_admission_probe.sql"), extraSql);
  return copy;
}

test("schema admission requires the guards even when every callback column exists", async (t) => {
  const copy = fixture(t, "DROP TRIGGER newo_callback_records_validate_insert;");
  assert.equal(await newoCallbackRecordPresent(copy), false);
});

test("schema admission requires callback fields beyond the former seven-column marker", async (t) => {
  const copy = fixture(t, "ALTER TABLE newo_callback_records RENAME COLUMN event_id TO missing_event_id;");
  assert.equal(await newoCallbackRecordPresent(copy), false);
});

test("source admission accepts the complete installed migration contract", async (t) => {
  assert.equal(await newoCallbackRecordPresent(fixture(t)), true);
});

test("source admission refuses missing guard dependencies and an unexecutable migration", async (t) => {
  for (const sql of ["DROP TABLE newo_event_receipts;", "SELECT * FROM no_such_admission_table;"]) {
    assert.equal(await newoCallbackRecordPresent(fixture(t, sql)), false);
  }
});

test("a complete installed schema does not admit unresolved original tenant provenance", async (t) => {
  const copy = fixture(t);
  const directory = join(copy, "workers-bus/migrations");
  writeFileSync(join(directory, "0171_zz_legacy_admission_probe.sql"), `INSERT INTO newo_sessions (
    session_id, status, structured_json, raw_key, payload_hash, created_at, updated_at
  ) VALUES ('synthetic-unbound-session', 'active', '{}', 'raw/newo/synthetic-legacy.json',
    '${"a".repeat(64)}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory).sort()) db.exec(readFileSync(join(directory, name), "utf8"));
  assert.equal(await newoCallbackSchemaMatches(db.prepare(NEWO_CALLBACK_SCHEMA_QUERY).all()), true);
  const counts = db.prepare(NEWO_TENANT_BINDING_QUERY).get();
  assert.equal(counts.unbound_sessions, 1);
  assert.equal(newoTenantBindingsReady(counts), false);
  assert.equal(await newoCallbackRecordPresent(copy), false);
});
