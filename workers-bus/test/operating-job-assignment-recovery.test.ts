import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function assignment(source: string, name: string): string[] {
  const value = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  const appended = [
    ...source.matchAll(new RegExp(`^${name}\\+="([^\"]*)"`, "gm")),
  ].map((match) => match[1]);
  return [value, ...appended].join(",").split(",");
}

test("0077 native operating assignments are included in both recovery inventories", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/0098_native_operating_job_assignments.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const backup = await readFile(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = await readFile(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );
  const tables = ["operating_job_assignments"];
  const indexes = [
    ["idx_operating_job_assignments_job_version", "operating_job_assignments"],
    ["idx_operating_job_assignments_predecessor", "operating_job_assignments"],
    ["idx_operating_job_assignments_schedule", "operating_job_assignments"],
  ];
  const triggers = [
    ["operating_job_assignments_validate_insert", "operating_job_assignments"],
    [
      "operating_job_assignments_append_only_update",
      "operating_job_assignments",
    ],
    [
      "operating_job_assignments_append_only_delete",
      "operating_job_assignments",
    ],
  ];
  for (const table of tables) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
    );
    assert.ok(assignment(backup, "REQUIRED_TABLES").includes(table));
    assert.ok(assignment(restore, "REQUIRED_TABLES").includes(table));
  }
  for (const [name, table] of indexes) {
    assert.match(
      migration,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`),
    );
    assert.ok(
      assignment(backup, "REQUIRED_INDEX_BINDINGS").includes(
        `${name}=${table}`,
      ),
    );
    assert.ok(
      assignment(restore, "REQUIRED_INDEX_BINDINGS").includes(
        `${name}=${table}`,
      ),
    );
  }
  for (const [name, table] of triggers) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b`),
    );
    assert.ok(
      assignment(backup, "REQUIRED_TRIGGER_BINDINGS").includes(
        `${name}=${table}`,
      ),
    );
    assert.ok(
      assignment(restore, "REQUIRED_TRIGGER_BINDINGS").includes(
        `${name}=${table}`,
      ),
    );
  }
});
