import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const INDEXES = [
  [
    "idx_native_photo_evidence_submissions_envelope",
    "native_photo_evidence_submissions",
  ],
  [
    "idx_native_photo_evidence_submissions_job",
    "native_photo_evidence_submissions",
  ],
  [
    "idx_native_photo_evidence_items_submission",
    "native_photo_evidence_items",
  ],
] as const;

const TRIGGERS = [
  [
    "native_photo_evidence_submissions_job_guard",
    "native_photo_evidence_submissions",
  ],
  [
    "native_photo_evidence_submissions_no_insert_replace",
    "native_photo_evidence_submissions",
  ],
  [
    "native_photo_evidence_submissions_append_only_update",
    "native_photo_evidence_submissions",
  ],
  [
    "native_photo_evidence_submissions_append_only_delete",
    "native_photo_evidence_submissions",
  ],
  [
    "native_photo_evidence_items_parent_guard",
    "native_photo_evidence_items",
  ],
  [
    "native_photo_evidence_items_no_insert_replace",
    "native_photo_evidence_items",
  ],
  [
    "native_photo_evidence_items_append_only_update",
    "native_photo_evidence_items",
  ],
  [
    "native_photo_evidence_items_append_only_delete",
    "native_photo_evidence_items",
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

test("0085 native photo evidence authority is complete in backup and restore contracts", () => {
  const migration = readFileSync(
    new URL(
      "../migrations/0104_native_photo_evidence_authority.sql",
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
    /CREATE TABLE IF NOT EXISTS native_photo_evidence_submissions\b/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS native_photo_evidence_items\b/,
  );
  for (const source of [backup, restore]) {
    assert.ok(
      assignment(source, "REQUIRED_TABLES").includes(
        "native_photo_evidence_submissions",
      ),
    );
    assert.ok(
      assignment(source, "REQUIRED_TABLES").includes(
        "native_photo_evidence_items",
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
    assert.equal(scalar(source, "REQUIRED_TABLE_COUNT"), 217);
    assert.equal(scalar(source, "REQUIRED_INDEX_COUNT"), 332);
    assert.equal(scalar(source, "REQUIRED_TRIGGER_COUNT"), 524);
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
        stringAssignment(source, "REQUIRED_NATIVE_PHOTO_INDEX_SEMANTICS"),
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
        stringAssignment(source, "REQUIRED_NATIVE_PHOTO_TRIGGER_SEMANTICS"),
        new RegExp(`(?:^|;)${name}\\|`),
      );
    }
    assert.match(restore, new RegExp(`\\["${name}"`));
  }

  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_PHOTO_TABLE_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_PHOTO_TABLE_SEMANTICS"),
  );
  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_PHOTO_INDEX_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_PHOTO_INDEX_SEMANTICS"),
  );
  assert.equal(
    stringAssignment(backup, "REQUIRED_NATIVE_PHOTO_TRIGGER_SEMANTICS"),
    stringAssignment(restore, "REQUIRED_NATIVE_PHOTO_TRIGGER_SEMANTICS"),
  );
  assert.match(
    backup,
    /verify_native_photo_semantics "\$verification_db" "D1 export"/,
  );
  assert.match(
    restore,
    /verify_native_photo_semantics "\$verification_db" "restored D1 export"/,
  );
});
