import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { newoCallbackRecordPresent } from "./newo-enablement.mjs";

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
