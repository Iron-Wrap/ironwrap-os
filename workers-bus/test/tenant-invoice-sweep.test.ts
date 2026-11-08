import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { recoverQuickBooksFinalInvoices } from "../src/quickbooks-final-invoice.ts";

const A = "ironwrap";
const B = "northline-metal";

/** Private relational fixture for the observation repair seam. Other recovery stages return
 * no work; the production observation SELECT, successor INSERT and replay SELECT run in SQLite.
 * This proves filtering/order/LIMIT and exact replay, not the provider dispatcher or full schema. */
function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE quickbooks_final_invoice_intents (
      tenant_id TEXT, intent_id TEXT, provider_invoice_id TEXT,
      PRIMARY KEY (tenant_id, intent_id)
    );
    CREATE TABLE quickbooks_final_invoice_observations (
      tenant_id TEXT, intent_id TEXT, provider_invoice_id TEXT,
      provider_readback_sha256 TEXT, outcome_code TEXT, checked_at INTEGER
    );
    CREATE TABLE quickbooks_final_invoice_outbox (
      effect_id TEXT PRIMARY KEY, tenant_id TEXT, intent_id TEXT, operation TEXT,
      idempotency_key_sha256 TEXT, request_fingerprint_sha256 TEXT,
      state TEXT, attempt_count INTEGER, next_attempt_at TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE (tenant_id, idempotency_key_sha256)
    );
  `);
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const query = {
        bind(...values: unknown[]) { args = values; return query; },
        async all() {
          if (sql.includes("JOIN quickbooks_final_invoice_observations ob"))
            return { results: raw.prepare(sql).all(...args as never[]) };
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT intent_id, operation, request_fingerprint_sha256"))
            return raw.prepare(sql).get(...args as never[]) ?? null;
          return null;
        },
        async run() {
          assert.match(sql, /INSERT INTO quickbooks_final_invoice_outbox/);
          const result = raw.prepare(sql).run(...args as never[]);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return query;
    },
  };
  function add(tenant: string, id: string, order: number, outcome = "exact_match", observedInvoice = id) {
    raw.prepare("INSERT INTO quickbooks_final_invoice_intents VALUES (?, ?, ?)").run(tenant, id, id);
    raw.prepare("INSERT INTO quickbooks_final_invoice_observations VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenant, id, observedInvoice, id.padEnd(64, "f"), outcome, order);
  }
  async function sweep(tenant: string) {
    let providerCalls = 0;
    const result = await recoverQuickBooksFinalInvoices({ DB: db, APP_TENANT_ID: tenant, QB_FINAL_INVOICE_ENABLED: "true" } as never,
      async () => { providerCalls++; throw new Error("provider dispatch forbidden in repair fixture"); });
    assert.equal(providerCalls, 0);
    assert.equal(result.effects_processed, 0);
  }
  function successors() {
    return raw.prepare("SELECT tenant_id, intent_id, operation, request_fingerprint_sha256 FROM quickbooks_final_invoice_outbox ORDER BY tenant_id, intent_id")
      .all().map((row) => ({ ...row }));
  }
  return { raw, add, sweep, successors };
}

test("each invoice sweep creates only its own exact-match successors and exact replay is idempotent", async () => {
  const f = fixture();
  f.add(A, "a1", 1);
  f.add(B, "b1", 0);
  await f.sweep(A);
  assert.deepEqual(f.successors(), [{ tenant_id: A, intent_id: "a1", operation: "resolve", request_fingerprint_sha256: "a1".padEnd(64, "f") }]);
  await f.sweep(A);
  assert.equal(f.successors().length, 1);
  await f.sweep(B);
  assert.deepEqual(f.successors().map((row) => [row.tenant_id, row.intent_id]), [[A, "a1"], [B, "b1"]]);
  await f.sweep(B);
  assert.equal(f.successors().length, 2);
  f.raw.close();
});

test("foreign observations before the LIMIT cannot starve this tenant's later observation", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.add(B, `b${i}`, i);
  f.add(A, "a1", 100);
  await f.sweep(A);
  assert.deepEqual(f.successors().map((row) => [row.tenant_id, row.intent_id]), [[A, "a1"]]);
  f.raw.close();
});

test("invoice observation repair retains exact invoice, tenant, outcome and fingerprint predicates", async () => {
  const f = fixture();
  f.add(A, "good", 3);
  f.add(A, "wrong-invoice", 0, "exact_match", "other");
  f.add(A, "mismatch", 1, "mismatch");
  f.add(B, "foreign", 2);
  await f.sweep(A);
  assert.deepEqual(f.successors().map((row) => row.intent_id), ["good"]);
  f.raw.close();
});
