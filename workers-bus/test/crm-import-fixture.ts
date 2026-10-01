// crm-import-fixture.ts - shared harness for the CRM-import contract tests.
//
// The D1 stand-in runs the real migration files against an in-memory SQLite with foreign keys on,
// so every CHECK and every FK in 0109 is exercised by the tests rather than assumed.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  "0001_init.sql",
  "0082_envelope_operating_tenant.sql",
  "0090_operating_core.sql",
  "0109_crm_import_ledger.sql",
  // insertEnvelope writes release_smoke (IRO-264).
  "0133_envelope_release_smoke.sql",
];

export class TestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const name of MIGRATIONS) {
      this.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this.raw;
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => (db.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
        run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
      }),
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  count(table: string): number {
    const row = this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  rows<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
    return this.raw.prepare(sql).all(...args) as T[];
  }
}

export function testEnv(db: TestD1) {
  return { DB: db, APP_TENANT_ID: "ironwrap", ADMIN_TOKEN: "local-throwaway-admin-token" } as never;
}

export function fixtureCsv(name: string): string {
  return readFileSync(new URL(`./fixtures/crm-import/${name}`, import.meta.url), "utf8");
}

export const FIXTURE_NOW = "2026-08-22T12:00:00.000Z";
