import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildNewoOperationsReadModel } from "../src/newo-operations-read-model.ts";

class SchemaD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    const statement = (args: unknown[]) => ({
      bind: (...values: unknown[]) => statement(values),
      first: async <T>() => (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...(args as never[])) as T[] }),
    });
    return statement([]);
  }
}

test("Newo owned_database refuses a missing callback guard independently of provider setup", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  DB.sqlite.exec("DROP TRIGGER newo_callback_records_validate_insert");
  const env = {
    DB, APP_TENANT_ID: "ironwrap", NEWO_ENABLED: "false", NEWO_PRODUCTION_REQUIRED: "true",
    ERPNEXT_ENABLED: "false", JOBNIMBUS_ENABLED: "false",
  } as unknown as Env;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("schema proof must not call a provider"); });
  const model = await buildNewoOperationsReadModel(env);
  assert.equal(model.readiness.checks.find((check) => check.id === "owned_database")?.ok, false);
});
