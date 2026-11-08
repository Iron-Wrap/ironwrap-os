// Per-tenant derivation cursors (0212): each tenant walks behind its own row.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { reconcileCustomerContractAcceptanceAttempts } from "../src/customer-contract-acceptance.ts";
import type { AppEnv } from "../src/app-types.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const CURSOR_0212 = "0212_tenant_derivation_cursors.sql";
const AT = "2026-11-01T00:00:00.000Z";

function chainBefore(migration: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    if (name >= migration) break;
    db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  }
  return db;
}

test("0212 keeps the position for its tenant and a rolled-back Worker's SQL still applies", () => {
  const db = chainBefore(CURSOR_0212);
  try {
    db.prepare("INSERT INTO commercial_deposit_derivation_cursors VALUES ('scheduled-v1', 'ironwrap', ?, ?)").run("a".repeat(16), AT);
    db.prepare("INSERT INTO native_final_invoice_derivation_cursors VALUES ('scheduled-v1', 'ironwrap', 'job-1', ?)").run(AT);
    db.exec(readFileSync(new URL(CURSOR_0212, MIGRATIONS), "utf8"));

    const deposits = () => db.prepare("SELECT cursor_name, last_tenant_id, last_acceptance_id FROM commercial_deposit_derivation_cursors ORDER BY cursor_name").all().map((row) => ({ ...row }));
    assert.deepEqual(deposits(), [
      { cursor_name: "scheduled-v1", last_tenant_id: "ironwrap", last_acceptance_id: "a".repeat(16) },
      { cursor_name: "scheduled-v1:ironwrap", last_tenant_id: "ironwrap", last_acceptance_id: "a".repeat(16) },
    ]);
    assert.deepEqual(
      db.prepare("SELECT cursor_name, last_roof_job_id FROM native_final_invoice_derivation_cursors ORDER BY cursor_name").all().map((row) => ({ ...row })),
      [
        { cursor_name: "scheduled-v1", last_roof_job_id: "job-1" },
        { cursor_name: "scheduled-v1:ironwrap", last_roof_job_id: "job-1" },
      ],
    );

    // The exact read and upsert the previous Worker runs.
    assert.equal(
      (db.prepare("SELECT last_tenant_id, last_acceptance_id FROM commercial_deposit_derivation_cursors WHERE cursor_name = 'scheduled-v1'").get() as { last_acceptance_id: string }).last_acceptance_id,
      "a".repeat(16),
    );
    db.prepare(
      `INSERT INTO commercial_deposit_derivation_cursors (cursor_name, last_tenant_id, last_acceptance_id, updated_at)
       VALUES ('scheduled-v1', ?, ?, ?)
       ON CONFLICT(cursor_name) DO UPDATE SET
         last_tenant_id = excluded.last_tenant_id,
         last_acceptance_id = excluded.last_acceptance_id,
         updated_at = excluded.updated_at`,
    ).run("ironwrap", "b".repeat(16), AT);
    assert.equal(deposits()[0].last_acceptance_id, "b".repeat(16));
    assert.equal(deposits()[1].last_acceptance_id, "a".repeat(16), "a rolled-back Worker leaves the tenant's row alone");
  } finally { db.close(); }
});

test("0212 ties every per-tenant row's name to its tenant and starts empty on a new database", () => {
  const db = chainBefore(CURSOR_0212);
  try {
    db.exec(readFileSync(new URL(CURSOR_0212, MIGRATIONS), "utf8"));
    for (const table of ["commercial_deposit_derivation_cursors", "native_final_invoice_derivation_cursors"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
      assert.throws(() => insert.run("scheduled-v1:northline-metal", "ironwrap", "a".repeat(16), AT), /CHECK/);
      assert.throws(() => insert.run("something-else", "ironwrap", "a".repeat(16), AT), /CHECK/);
      insert.run("scheduled-v1:northline-metal", "northline-metal", "a".repeat(16), AT);
    }
  } finally { db.close(); }
});

test("each tenant's deposit pass walks only its accepted contracts behind its own cursor", async () => {
  const rows = [
    { acceptance_id: "acceptance_a_000001", tenant_id: "ironwrap" },
    { acceptance_id: "acceptance_a_000002", tenant_id: "ironwrap" },
    { acceptance_id: "acceptance_b_000001", tenant_id: "northline-metal" },
  ];
  const cursors = new Map<string, { last_tenant_id: string; last_acceptance_id: string }>();
  const attempted: string[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>(): Promise<T | null> {
          if (sql.includes("commercial_deposit_derivation_cursors")) return (cursors.get(String(args[0])) ?? null) as T | null;
          if (sql.includes("FROM commercial_deposit_derivations")) {
            attempted.push(String(args[1]));
            return null;
          }
          throw new Error(`unexpected first: ${sql}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("state = 'receipt_stored'")) return { results: [] };
          if (sql.includes("state = 'accepted'")) {
            const own = rows.filter((row) => row.tenant_id === args[0]);
            const selected = sql.includes("acceptance_id > ?")
              ? own.filter((row) => row.acceptance_id > String(args[1]))
              : own.filter((row) => row.acceptance_id <= String(args[1]));
            return { results: selected as T[] };
          }
          throw new Error(`unexpected all: ${sql}`);
        },
        async run(): Promise<{ success: true }> {
          if (sql.includes("INSERT INTO commercial_deposit_derivation_cursors")) {
            cursors.set(String(args[0]), { last_tenant_id: String(args[1]), last_acceptance_id: String(args[2]) });
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
  const pass = (tenant: string) => reconcileCustomerContractAcceptanceAttempts(
    { DB: db, APP_TENANT_ID: tenant } as unknown as AppEnv,
    new Date(AT),
  );

  await pass("ironwrap");
  assert.deepEqual(attempted.splice(0), ["acceptance_a_000001", "acceptance_a_000002"]);
  await pass("northline-metal");
  assert.deepEqual(attempted.splice(0), ["acceptance_b_000001"]);
  assert.deepEqual(Object.fromEntries(cursors), {
    "scheduled-v1:ironwrap": { last_tenant_id: "ironwrap", last_acceptance_id: "acceptance_a_000002" },
    "scheduled-v1:northline-metal": { last_tenant_id: "northline-metal", last_acceptance_id: "acceptance_b_000001" },
  });
});
