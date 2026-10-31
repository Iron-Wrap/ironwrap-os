import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATION = "0171_safety_stop_additions_release_photo_rescope.sql";
const migrations = readdirSync(new URL("../migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function migrate(names: string[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of names) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  return db;
}

function schema(db: DatabaseSync) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

test("0171 preserves full schema and per-table trigger order when deployed after higher migrations", () => {
  const sorted = migrate(migrations);
  const deployed = migrate([...migrations.filter((name) => name !== MIGRATION), MIGRATION]);
  try {
    assert.deepEqual(schema(sorted), schema(deployed));
    const triggerOrder = (db: DatabaseSync) => db.prepare(
      "SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, rowid",
    ).all();
    assert.deepEqual(triggerOrder(sorted), triggerOrder(deployed));
    for (const db of [sorted, deployed]) {
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    }
  } finally {
    sorted.close();
    deployed.close();
  }
});

test("backup and restore pin every actual table and exact index/trigger binding including 0171", () => {
  const db = migrate(migrations);
  try {
    const objects = (schema(db) as Array<{ type: string; name: string; tbl_name: string }>)
      .filter((object) => !object.name.startsWith("sqlite_"));
    for (const script of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
      const source = readFileSync(new URL(`../../deploy/${script}`, import.meta.url), "utf8");
      for (const [type, variable, count] of [
        ["table", "REQUIRED_TABLES", "REQUIRED_TABLE_COUNT"],
        ["index", "REQUIRED_INDEX_BINDINGS", "REQUIRED_INDEX_COUNT"],
        ["trigger", "REQUIRED_TRIGGER_BINDINGS", "REQUIRED_TRIGGER_COUNT"],
      ]) {
        const values = [...source.matchAll(new RegExp(`^${variable}(?:\\+)?="([^"]*)"$`, "gm"))]
          .map((match) => match[1]).join("").split(",").filter(Boolean).sort();
        const actual = objects.filter((object) => object.type === type)
          .map((object) => type === "table" ? object.name : `${object.name}=${object.tbl_name}`).sort();
        assert.deepEqual(values, actual, `${script}: ${variable}`);
        assert.equal(Number(source.match(new RegExp(`^${count}=(\\d+)$`, "m"))?.[1]), actual.length,
          `${script}: ${count}`);
      }
    }
  } finally {
    db.close();
  }
});
