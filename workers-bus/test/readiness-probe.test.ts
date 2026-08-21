import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  buildReadinessColumnProbeSql,
  checkDatabaseReadiness,
  READINESS_COLUMN_PROBES,
  READINESS_PROBE_COLUMN_BUDGET,
} from "../src/store.ts";

/**
 * D1 refuses a result set wider than this outright ("too many columns in result
 * set"), so a readiness probe that crosses it can never report ready. The budget
 * is asserted well below the ceiling: landing at 99 is not a fix.
 */
const D1_RESULT_COLUMN_LIMIT = 100;
const MAX_PROBE_COLUMNS = 80;

/** The real production schema: every migration, in order, on a real SQLite file. */
async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    if (migration === "0038_app_access_roles.sql") {
      // A pre-0038 user exists on every real tenant; readiness only reports ready
      // once the backfill has resolved its access_role.
      db.prepare(
        `INSERT INTO app_users
          (user_id, tenant_id, email_normalized, display_name, role, active,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
      ).run(
        "appu_legacy_ops_0001",
        "ironwrap",
        "legacy-ops@example.com",
        "Legacy Operations",
        "owner@example.com",
        "2026-08-13T11:59:00.000Z",
        "2026-08-13T11:59:00.000Z",
      );
    }
    db.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

/** A D1 stand-in over real SQLite that keeps every statement readiness prepares. */
class RecordingD1 {
  readonly prepared: string[] = [];
  readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  prepare(sql: string) {
    this.prepared.push(sql);
    return {
      first: async <T>() => (this.raw.prepare(sql).get() ?? null) as T | null,
      all: async <T>() => ({ results: this.raw.prepare(sql).all() as T[] }),
    };
  }
}

test("readiness reports ready against the complete migration chain", async () => {
  const db = await migratedDatabase();
  try {
    assert.equal(await checkDatabaseReadiness({ DB: new RecordingD1(db) } as never), true);
  } finally {
    db.close();
  }
});

test("no readiness statement approaches D1's result-set column ceiling", async () => {
  const db = await migratedDatabase();
  try {
    const recording = new RecordingD1(db);
    await checkDatabaseReadiness({ DB: recording } as never);
    assert.ok(recording.prepared.length > 0, "readiness prepared no statement");
    for (const sql of recording.prepared) {
      const statement = db.prepare(sql);
      let width: number;
      if (typeof statement.columns === "function") {
        width = statement.columns().length;
      } else if (sql.includes("LIMIT 0")) {
        width = sql.slice(0, sql.indexOf(" FROM ")).split(" AS ").length - 1;
      } else {
        continue;
      }
      assert.ok(
        width <= MAX_PROBE_COLUMNS,
        `readiness statement selects ${width} columns; D1 rejects over ` +
          `${D1_RESULT_COLUMN_LIMIT} and the budget is ${MAX_PROBE_COLUMNS}: ${sql.slice(0, 120)}…`,
      );
    }
  } finally {
    db.close();
  }
});

test("readiness goes red when a schema artifact it names disappears", async () => {
  const db = await migratedDatabase();
  try {
    db.exec("DROP TRIGGER hermes_desktop_results_append_only_update");
    assert.equal(await checkDatabaseReadiness({ DB: new RecordingD1(db) } as never), false);
  } finally {
    db.close();
  }
});

test("every probed table and column exists in the migrated schema", async () => {
  const db = await migratedDatabase();
  try {
    for (const probe of READINESS_COLUMN_PROBES) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${probe.table})`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      assert.ok(columns.size > 0, `no such table: ${probe.table}`);
      for (const column of probe.columns) {
        assert.ok(columns.has(column), `no such column: ${probe.table}.${column}`);
      }
    }
  } finally {
    db.close();
  }
});

test("probe grouping stays inside its budget and drops nothing", () => {
  const statements = buildReadinessColumnProbeSql();
  assert.ok(statements.length > 1, "the probe must be split, not one wide join");
  for (const sql of statements) {
    const width = sql.slice(0, sql.indexOf(" FROM ")).split(" AS ").length - 1;
    assert.ok(
      width <= READINESS_PROBE_COLUMN_BUDGET,
      `probe statement selects ${width} columns, over the ${READINESS_PROBE_COLUMN_BUDGET} budget`,
    );
  }
  const covered = statements.join(" ");
  for (const probe of READINESS_COLUMN_PROBES) {
    assert.ok(
      new RegExp(`\\b${probe.table} p\\d+\\b`).test(covered),
      `probe grouping dropped ${probe.table}`,
    );
  }
  assert.equal(
    statements.reduce((total, sql) => total + sql.split(" AS ").length - 1, 0),
    READINESS_COLUMN_PROBES.reduce((total, probe) => total + probe.columns.length, 0),
  );
});
