import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { pushQuickBooksEventToErpNext } from "../src/erpnext.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec(readFileSync(new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url), "utf8"));
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

test("QuickBooks issuer projection is leased, idempotent, and provider-readback verified", async (t) => {
  const db = new SqliteD1();
  const calls: string[] = [];
  let issued: Record<string, unknown> | null = null;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/resource/Payment%20Milestone?")) return new Response(JSON.stringify({ data: [] }));
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      const request = JSON.parse(String(init?.body)) as { reconciliation_json: string };
      issued = JSON.parse(request.reconciliation_json) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { name: issued.reconciliation_id, idempotent_replay: false } }));
    }
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.read_pending_reconciliation")) {
      assert.ok(issued);
      return new Response(JSON.stringify({
        message: { found: true, reconciliation: { ...issued, name: issued.reconciliation_id } },
      }));
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const env = {
    DB: db,
    APP_TENANT_ID: "ironwrap",
    EFFECT_RUNTIME_ENABLED: "true",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    QB_EXPECTED_REALM_ID: "1234567890",
    QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
    QB_RECONCILIATION_ISSUER_API_KEY: "qb-issuer-key",
    QB_RECONCILIATION_ISSUER_API_SECRET: "qb-issuer-secret",
  } as never;
  const input = {
    realmId: "1234567890",
    type: "Payment" as const,
    id: "7",
    operation: "Create" as const,
    rawKey: "raw/quickbooks/2026-08-16/ow_test.json",
    eventTs: "2026-08-16T12:00:00.000Z",
    payloadHash: "a".repeat(64),
    eventIndex: 0,
  };

  const first = await pushQuickBooksEventToErpNext(env, input);
  const second = await pushQuickBooksEventToErpNext(env, input);

  assert.equal(first.reconciliationName, second.reconciliationName);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(calls.filter((url) => url.endsWith("issue_pending_reconciliation")).length, 1);
  assert.equal(
    calls.filter((url) => url.endsWith("read_pending_reconciliation")).length,
    2,
    "initial settlement and exact replay must each verify the provider record",
  );
  const effect = db.raw.prepare(
    "SELECT state, provider_external_id, idempotency_key, expected_readback_json FROM external_effects",
  ).get() as {
    state: string;
    provider_external_id: string;
    idempotency_key: string;
    expected_readback_json: string;
  };
  assert.equal(effect.state, "succeeded");
  assert.equal(effect.provider_external_id, first.reconciliationName);
  assert.equal(effect.idempotency_key, `quickbooks:reconciliation:${first.reconciliationName}`);
  assert.match(effect.expected_readback_json, /"source_payload_hash":"a{64}"/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM external_effect_attempts").get().count, 1);
});
