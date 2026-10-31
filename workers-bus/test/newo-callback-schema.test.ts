import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildNewoOperationsReadModel } from "../src/newo-operations-read-model.ts";
import { getReadiness } from "../src/operations.ts";
import { NEWO_TENANT_BINDING_COUNT_KEYS, newoTenantBindingsReady } from "../src/newo-tenant-readiness.ts";
import {
  NEWO_CALLBACK_SCHEMA_QUERY,
  newoCallbackSchemaReady,
} from "../src/newo-callback-schema.ts";

const RECORD_COLUMNS = [
  "callback_id", "tenant_id", "session_id", "event_id", "reason", "urgency",
  "handoff_summary", "contact_name", "contact_phone", "contact_email", "address_line1",
  "city", "province", "postal_code", "recorded_at",
];
const RESOLUTION_COLUMNS = [
  "resolution_id", "tenant_id", "idempotency_key", "request_sha256", "session_id",
  "outcome", "note", "resolved_by", "resolved_by_role", "resolved_at",
];
const ADMISSION_COLUMNS = [
  "event_id", "tenant_id", "session_id", "event_type", "payload_sha256", "raw_key", "occurred_at", "envelope_id",
  "reported_handoff_status", "reported_urgency", "event_has_contact", "prior_status", "prior_handoff_status",
  "prior_urgency", "prior_has_contact", "matched_customer_id", "matched_property_id", "matched_roof_job_id",
  "verification_status", "effective_urgency", "effective_handoff_status", "projected_status", "callback_reason", "recorded_at",
];

class SchemaD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor(legacy?: (db: DatabaseSync) => void) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const name of names.filter((name) => !legacy || !name.startsWith("0172_"))) {
      this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
    if (legacy) {
      legacy(this.sqlite);
      for (const name of names.filter((name) => name.startsWith("0172_")))
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

async function probe(db: SchemaD1, mutate: () => void, check: () => Promise<void>) {
  db.sqlite.exec("SAVEPOINT schema_probe");
  try {
    mutate();
    await check();
  } finally {
    db.sqlite.exec("ROLLBACK TO schema_probe; RELEASE schema_probe");
  }
}

function schemaSql(db: SchemaD1, name: string): string {
  const row = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
  assert.equal(typeof row?.sql, "string");
  return String(row!.sql);
}

function rebuildTable(db: SchemaD1, table: string, change: (sql: string) => string) {
  const original = schemaSql(db, table);
  const guards = db.sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid",
  ).all(table);
  const changed = change(original);
  assert.notEqual(changed, original, "schema mutation must change the installed definition");
  db.sqlite.exec(`DROP TABLE ${table}`);
  db.sqlite.exec(changed);
  for (const guard of guards) db.sqlite.exec(String(guard.sql));
}

/** Split the actual table definition into top-level columns/constraints for missing-field probes. */
function withoutColumn(sql: string, column: string): string {
  const start = sql.indexOf("(");
  const end = sql.lastIndexOf(")");
  const body = sql.slice(start + 1, end).replace(/--[^\n]*/g, "");
  const definitions: string[] = [];
  let depth = 0;
  let quoted = false;
  let beginning = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      if (quoted && body[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) {
        definitions.push(body.slice(beginning, i).trim());
        beginning = i + 1;
      }
    }
  }
  definitions.push(body.slice(beginning).trim());
  // A physical input's removal must also remove generated expressions that depend on it;
  // otherwise SQLite refuses the mutation before the installed-contract check can inspect it.
  const removed = new Set([column]);
  let previous = 0;
  while (previous !== removed.size) {
    previous = removed.size;
    for (const definition of definitions) {
      if (/GENERATED ALWAYS/.test(definition) && [...removed].some((name) =>
        new RegExp(`\\b${name}\\b`).test(definition))) removed.add(definition.split(/\s+/)[0]!);
    }
  }
  const kept = definitions.filter((definition) =>
    !removed.has(definition.split(/\s+/)[0]!) &&
    !(/^(?:CHECK|UNIQUE|FOREIGN KEY)\b/.test(definition) && [...removed].some((name) =>
      new RegExp(`\\b${name}\\b`).test(definition))));
  assert.ok(kept.length < definitions.length, `${column} must actually be removed`);
  return `${sql.slice(0, start + 1)}\n${kept.join(",\n")}\n${sql.slice(end)}`;
}

test("installed Newo schema admission accepts the actual migrations without provider access", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected_provider_call"); });
  assert.equal(await newoCallbackSchemaReady({ DB } as never), true);
  assert.equal(requests, 0);
});

test("schema admission refuses every missing or renamed callback and resolution column", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  for (const [table, columns] of [
    ["newo_callback_records", RECORD_COLUMNS], ["newo_handoff_resolutions", RESOLUTION_COLUMNS],
    ["newo_event_admissions", ADMISSION_COLUMNS],
    ["newo_sessions", ["session_id", "status", "handoff_status", "urgency", "lead_envelope_id", "payload_hash",
      "raw_key", "tenant_id", "tenant_binding_state", "tenant_binding_source", "tenant_binding_ref", "last_event_id"]],
    ["newo_event_receipts", ["event_id", "session_id", "event_type", "status", "payload_hash", "raw_key", "envelope_id",
      "attempts", "admission_json", "tenant_id"]],
  ] as const) {
    for (const column of columns) {
      for (const operation of ["missing", "renamed"]) {
        await t.test(`${table}.${column} ${operation}`, async () => {
          await probe(DB, () => {
            if (operation === "missing") rebuildTable(DB, table, (sql) => withoutColumn(sql, column));
            else DB.sqlite.exec(`ALTER TABLE ${table} RENAME COLUMN ${column} TO missing_${column}`);
            const installed = DB.sqlite.prepare(`PRAGMA table_xinfo(${table})`).all();
            assert.ok(installed.every((row) => row.name !== column));
          }, async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
        });
      }
    }
  }
});

test("schema admission refuses weakened types, nullability, keys, checks and foreign keys", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  const changes = [
    ["column type", "newo_callback_records", "contact_phone TEXT", "contact_phone BLOB"],
    ["nullability", "newo_callback_records", "tenant_id TEXT NOT NULL", "tenant_id TEXT"],
    ["primary key", "newo_callback_records", "callback_id TEXT PRIMARY KEY", "callback_id TEXT"],
    ["unique key", "newo_callback_records", "UNIQUE (tenant_id, session_id)", "UNIQUE (tenant_id, session_id, event_id)"],
    ["FK delete rule", "newo_callback_records", "ON DELETE RESTRICT", "ON DELETE CASCADE"],
    ["FK target", "newo_callback_records", "REFERENCES newo_sessions(session_id)", "REFERENCES envelopes(envelope_id)"],
    ["reason CHECK", "newo_callback_records", "reason IN ('callback_requested', 'handoff_failed', 'session_failed')", "length(reason) > 0"],
    ["literal whitespace", "newo_callback_records", "'session_failed'", "'session_failed  '"],
    ["actor FK columns", "newo_handoff_resolutions", "REFERENCES app_users(user_id, tenant_id)", "REFERENCES app_users(tenant_id, user_id)"],
    ["admission tenant FK", "newo_event_admissions", "REFERENCES newo_sessions(session_id, tenant_id)", "REFERENCES newo_sessions(tenant_id, session_id)"],
    ["deferred batch binding", "newo_event_admissions", "DEFERRABLE INITIALLY DEFERRED", ""],
    ["generated callback policy", "newo_event_admissions", "WHEN event_type = 'caller_lookup' THEN NULL", "WHEN event_type = 'caller_lookup' THEN 'callback_requested'"],
    ["session state CHECK", "newo_sessions", "tenant_binding_state IN ('bound', 'unbound', 'conflict')", "length(tenant_binding_state) > 0"],
  ];
  for (const [name, table, from, to] of changes) {
    await t.test(name!, async () => {
      await probe(DB, () => rebuildTable(DB, table!, (sql) => sql.replace(from!, to!)),
        async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
    });
  }
});

test("schema admission refuses every missing, renamed, weakened or rebound guard", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  const guards = DB.sqlite.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'
    AND tbl_name IN ('newo_callback_records', 'newo_handoff_resolutions', 'newo_sessions',
      'newo_event_receipts', 'newo_event_admissions') ORDER BY rowid`).all();
  assert.equal(guards.length, 20);
  for (const guard of guards) {
    for (const operation of ["missing", "renamed", "weakened", "rebound"]) {
      await t.test(`${guard.name} ${operation}`, async () => {
        await probe(DB, () => {
          DB.sqlite.exec(`DROP TRIGGER ${guard.name}`);
          const sql = String(guard.sql);
          if (operation === "renamed") DB.sqlite.exec(sql.replace(`CREATE TRIGGER ${guard.name}`, `CREATE TRIGGER ${guard.name}_renamed`));
          if (operation === "weakened") {
            const verb = sql.match(/BEFORE (INSERT|UPDATE|DELETE)/)![1];
            DB.sqlite.exec(`CREATE TRIGGER ${guard.name} BEFORE ${verb} ON ${guard.tbl_name} BEGIN SELECT 1; END`);
          }
          if (operation === "rebound") DB.sqlite.exec(sql.replace(`ON ${guard.tbl_name}`, "ON envelopes"));
        }, async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
      });
    }
  }
  for (const table of ["newo_callback_records", "newo_handoff_resolutions", "newo_sessions", "newo_event_receipts", "newo_event_admissions"]) {
    await t.test(`${table} same guard body in the wrong creation order`, async () => {
      const guard = guards.find((row) => row.tbl_name === table)!;
      await probe(DB, () => {
        DB.sqlite.exec(`DROP TRIGGER ${guard.name}`);
        DB.sqlite.exec(String(guard.sql));
      }, async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
    });
  }
  await t.test("unexpected guard on an owned table", async () => {
    await probe(DB, () => DB.sqlite.exec("CREATE TRIGGER unexpected_callback_guard BEFORE INSERT ON newo_callback_records BEGIN SELECT 1; END"),
      async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
  });
});

test("schema admission refuses unavailable foreign-key and guard dependency tables", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  for (const table of ["newo_sessions", "newo_event_receipts", "newo_event_admissions", "app_users", "envelopes",
    "operating_roof_jobs", "operating_leads", "operating_customers", "operating_properties"]) {
    await t.test(table, async () => {
      await probe(DB, () => DB.sqlite.exec(`DROP TABLE ${table}`),
        async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
    });
  }
  for (const [table, pattern, replacement] of [
    ["newo_sessions", /session_id\s+TEXT PRIMARY KEY/, "session_id TEXT"],
    ["newo_event_receipts", /event_id\s+TEXT PRIMARY KEY/, "event_id TEXT"],
    ["app_users", /UNIQUE \(user_id, tenant_id\),/, ""],
  ] as const) {
    await t.test(`${table} weakened referenced key`, async () => {
      await probe(DB, () => rebuildTable(DB, table, (sql) => sql.replace(pattern, replacement)),
        async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
    });
  }
});

test("schema admission binds the actual tenant key and supporting index definitions", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  for (const name of ["idx_newo_sessions_id_tenant", "idx_newo_sessions_tenant_binding",
    "idx_newo_receipts_tenant_session", "idx_newo_admissions_tenant_session"]) {
    await t.test(`${name} missing`, async () => {
      await probe(DB, () => DB.sqlite.exec(`DROP INDEX ${name}`),
        async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
    });
  }
  await probe(DB, () => DB.sqlite.exec(`DROP INDEX idx_newo_sessions_id_tenant;
    CREATE INDEX idx_newo_sessions_id_tenant ON newo_sessions (session_id, tenant_id)`),
  async () => assert.equal(await newoCallbackSchemaReady({ DB } as never), false));
});

test("runtime readiness refuses unknown legacy identity despite a complete installed contract", async (t) => {
  const DB = new SchemaD1((db) => db.exec(`INSERT INTO newo_sessions
    (session_id, status, structured_json, raw_key, payload_hash, created_at, updated_at)
    VALUES ('synthetic-unbound', 'active', '{}', 'raw/synthetic/unbound.json', '${"a".repeat(64)}',
      '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`));
  t.after(() => DB.sqlite.close());
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected_provider_call"); });
  const env = { DB, APP_TENANT_ID: "ironwrap", NEWO_ENABLED: "false", NEWO_PRODUCTION_REQUIRED: "false" } as unknown as Env;
  const report = await getReadiness(env);
  assert.equal(report.checks.newo_callback_schema, true);
  assert.equal(report.checks.newo_tenant_binding, false);
  assert.equal(report.newo.tenant_binding_holds?.unbound_sessions, 1);
  assert.equal((await buildNewoOperationsReadModel(env)).readiness.checks.find((check) => check.id === "owned_database")?.ok, false);
  assert.equal(requests, 0);
});

test("binding readiness requires every bounded count and an explicit trusted deployment tenant", async (t) => {
  const clear = Object.fromEntries(NEWO_TENANT_BINDING_COUNT_KEYS.map((key) => [key, 0]));
  assert.equal(newoTenantBindingsReady(clear as never), true);
  for (const key of NEWO_TENANT_BINDING_COUNT_KEYS) for (const value of [undefined, null, -1, 1, "0", NaN, Infinity, 0.5]) {
    assert.equal(newoTenantBindingsReady({ ...clear, [key]: value } as never), false, `${key}:${value}`);
  }
  assert.equal(newoTenantBindingsReady(null), false);
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  const env = { DB, NEWO_ENABLED: "false", NEWO_PRODUCTION_REQUIRED: "false" } as unknown as Env;
  assert.equal((await getReadiness(env)).checks.newo_tenant_binding, false);
});

test("Newo owned_database proves the callback contract independently of provider setup", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  const env = {
    DB, APP_TENANT_ID: "ironwrap", NEWO_ENABLED: "false", NEWO_PRODUCTION_REQUIRED: "true",
    ERPNEXT_ENABLED: "false", JOBNIMBUS_ENABLED: "false",
  } as unknown as Env;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected_provider_call"); });
  const ready = await getReadiness(env);
  assert.equal(ready.checks.newo_callback_schema, true);
  assert.equal((await buildNewoOperationsReadModel(env)).readiness.checks
    .find((check) => check.id === "owned_database")?.ok, true);
  DB.sqlite.exec("DROP TRIGGER newo_callback_records_validate_insert");
  const refused = await getReadiness(env);
  assert.equal(refused.checks.d1, true);
  assert.equal(refused.checks.schema, true, "the old general schema check alone is insufficient");
  assert.equal(refused.checks.newo_callback_schema, false);
  assert.ok(refused.newo.drift_reasons.includes("callback_schema_unready"));
  assert.equal((await buildNewoOperationsReadModel(env)).readiness.checks
    .find((check) => check.id === "owned_database")?.ok, false);
  assert.equal(requests, 0);
});

test("runtime schema admission fails closed on a D1 read error or unsuccessful result", async (t) => {
  const DB = new SchemaD1();
  t.after(() => DB.sqlite.close());
  const results = DB.sqlite.prepare(NEWO_CALLBACK_SCHEMA_QUERY).all();
  for (const read of [
    async () => { throw new Error("synthetic_d1_read_error"); },
    async () => ({ success: false, results }),
    async () => ({ success: true }),
  ]) {
    assert.equal(await newoCallbackSchemaReady({ DB: { prepare: () => ({ all: read }) } } as never), false);
  }
});
