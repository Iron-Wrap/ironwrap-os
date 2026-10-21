import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const INDEXES = [
  ["idx_native_measurement_revisions_job", "native_measurement_revisions"],
  ["idx_native_measurement_revisions_root", "native_measurement_revisions"],
  [
    "idx_native_measurement_revisions_one_successor",
    "native_measurement_revisions",
  ],
] as const;

const TRIGGERS = [
  [
    "native_measurement_revisions_receipt_guard",
    "native_measurement_revisions",
  ],
  ["native_measurement_revisions_job_guard", "native_measurement_revisions"],
  [
    "native_measurement_revisions_lineage_guard",
    "native_measurement_revisions",
  ],
  [
    "native_measurement_revisions_no_insert_replace",
    "native_measurement_revisions",
  ],
  [
    "native_measurement_revisions_append_only_update",
    "native_measurement_revisions",
  ],
  [
    "native_measurement_revisions_append_only_delete",
    "native_measurement_revisions",
  ],
  [
    "measurement_intake_receipts_native_binding_guard",
    "measurement_intake_receipts",
  ],
] as const;

function assignment(source: string, name: string): string[] {
  const initial = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(initial, `${name} assignment is present`);
  const appended = [
    ...source.matchAll(new RegExp(`^${name}\\+="([^"]*)"`, "gm")),
  ].map((match) => match[1]);
  return `${initial}${appended.join("")}`.split(",").filter(Boolean);
}

function scalar(source: string, name: string): number {
  const value = source.match(new RegExp(`^${name}=(\\d+)$`, "m"))?.[1];
  assert.ok(value, `${name} scalar is present`);
  return Number(value);
}

function stringAssignment(source: string, name: string): string {
  const value = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  return value;
}

test("0084 native measurement authority is complete in backup and restore contracts", () => {
  const migration = readFileSync(
    new URL(
      "../migrations/0103_native_measurement_authority.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const backup = readFileSync(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = readFileSync(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS native_measurement_revisions\b/,
  );
  for (const source of [backup, restore]) {
    assert.ok(
      assignment(source, "REQUIRED_TABLES").includes(
        "native_measurement_revisions",
      ),
    );
    assert.equal(
      assignment(source, "REQUIRED_TABLES").length,
      scalar(source, "REQUIRED_TABLE_COUNT"),
    );
    assert.equal(
      assignment(source, "REQUIRED_INDEX_BINDINGS").length,
      scalar(source, "REQUIRED_INDEX_COUNT"),
    );
    assert.equal(
      assignment(source, "REQUIRED_TRIGGER_BINDINGS").length,
      scalar(source, "REQUIRED_TRIGGER_COUNT"),
    );
    // Pinned through 0200: privacy, crew-stop guards, the stop release record, durable writer
    // claims and the AI team tables
    // and manual measurement history are included in both D1 inventories.
    assert.equal(scalar(source, "REQUIRED_TABLE_COUNT"), 278);
    assert.equal(scalar(source, "REQUIRED_INDEX_COUNT"), 392);
    assert.equal(scalar(source, "REQUIRED_TRIGGER_COUNT"), 761);
  }

  for (const [name, table] of INDEXES) {
    assert.match(
      migration,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`),
    );
    for (const source of [backup, restore]) {
      assert.ok(
        assignment(source, "REQUIRED_INDEX_BINDINGS").includes(
          `${name}=${table}`,
        ),
      );
      assert.match(
        stringAssignment(source, "REQUIRED_NATIVE_MEASUREMENT_INDEX_SEMANTICS"),
        new RegExp(`(?:^|;)${name}\\|`),
      );
    }
    assert.match(restore, new RegExp(`\\["${name}"`));
  }

  for (const [name, table] of TRIGGERS) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b`),
    );
    for (const source of [backup, restore]) {
      assert.ok(
        assignment(source, "REQUIRED_TRIGGER_BINDINGS").includes(
          `${name}=${table}`,
        ),
      );
      assert.match(
        stringAssignment(
          source,
          "REQUIRED_NATIVE_MEASUREMENT_TRIGGER_SEMANTICS",
        ),
        new RegExp(`(?:^|;)${name}\\|`),
      );
    }
    assert.match(restore, new RegExp(`\\["${name}"`));
  }

  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_MEASUREMENT_TABLE_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_MEASUREMENT_TABLE_SEMANTICS"),
  );
  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_MEASUREMENT_INDEX_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_MEASUREMENT_INDEX_SEMANTICS"),
  );
  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_MEASUREMENT_TRIGGER_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_MEASUREMENT_TRIGGER_SEMANTICS"),
  );
  assert.match(
    backup,
    /verify_native_measurement_semantics "\$verification_db" "D1 export"/,
  );
  assert.match(
    restore,
    /verify_native_measurement_semantics "\$verification_db" "restored D1 export"/,
  );
});
