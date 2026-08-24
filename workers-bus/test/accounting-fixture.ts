// accounting-fixture.ts - the shared money-plane test harness.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 9: extend `effect-runtime-fixture.ts`'s
// `EffectLedgerTestD1` - which runs real migration SQL in an in-memory `node:sqlite` database
// behind a D1-shaped facade - into one harness the whole IRO-52 lane shares.
//
// Real SQL is the point. Every CHECK, trigger and unique index in 0058-0061 executes here, so a
// test that says "the storage layer refuses this" is executing the refusal rather than describing
// it. A harness that mocked D1 would prove only that the TypeScript agrees with itself, and this
// programme has been burned twice by exactly that.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { AppEnv } from "../src/app-types.ts";
import type { QuickBooksAuthPort, QuickBooksRealmBinding } from "../src/quickbooks-auth-port.ts";

export const TENANT = "ironwrap";
export const REALM = "4620816365000000000";
export const NOW = new Date("2026-08-19T12:00:00.000Z");

/**
 * The money-plane migrations, in order. 0058 is slice S1; 0059-0061 are S2 and S3; 0063-0065 are
 * the ELEC-72/75/79 follow-ups.
 */
export const ACCOUNTING_MIGRATIONS = [
  "0011_app_bff_auth.sql",
  "0030_facet_design_ingest.sql",
  "0034_facet_customer_approval_ingest.sql",
  "0035_facet_design_evidence_associations.sql",
  "0038_app_access_roles.sql",
  "0058_accounting_money_intents.sql",
  "0059_tax_policy_snapshots.sql",
  "0060_accounting_provider_observations.sql",
  "0061_accounting_exceptions.sql",
  "0063_accounting_dispatch_evidence.sql",
  "0064_accounting_authority_policy.sql",
  "0065_accounting_intent_derivation_receipts.sql",
] as const;

export function readAccountingMigration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

/**
 * The focused accounting fixtures intentionally stop at 0065.  Install the 0119 command-facing
 * contract without pulling the full commercial/operating schema into every money-plane unit test.
 * The complete migration and its causal capture trigger run in app-migration/reference tests.
 */
export function installCommercialDepositApprovalExclusionContract(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE commercial_deposit_approval_exclusions (
      request_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      UNIQUE (tenant_id, intent_id, actor_user_id)
    );
    CREATE TRIGGER accounting_intent_command_receipts_commercial_deposit_sod
    BEFORE INSERT ON accounting_intent_command_receipts
    WHEN NEW.operation = 'approve'
    BEGIN
      SELECT RAISE(ABORT, 'accounting_intent_separation_of_duty')
      WHERE EXISTS (
        SELECT 1 FROM commercial_deposit_approval_exclusions AS exclusion
         WHERE exclusion.tenant_id = NEW.tenant_id
           AND exclusion.intent_id = NEW.intent_id
           AND exclusion.actor_user_id = NEW.actor_user_id
      );
    END;
  `);
}

export class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.sql, args);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.raw.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T | null;
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    return {
      success: true,
      results: this.raw.prepare(this.sql).all(...this.args) as T[],
      meta: { changes: 0 },
    };
  }

  async run(): Promise<{ success: true; results: []; meta: { changes: number } }> {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

export class AccountingTestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of ACCOUNTING_MIGRATIONS) {
      this.raw.exec(readAccountingMigration(migration));
    }
    installCommercialDepositApprovalExclusionContract(this.raw);
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
         user_id, tenant_id, email_normalized, display_name, role, access_role,
         active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    for (const role of ["owner", "accounting", "ops"] as const) {
      // `access_role` carries the accounting role; `role` keeps the legacy three-value column.
      insert.run(
        `appu_${role}_0001`,
        TENANT,
        `${role}@example.invalid`,
        role,
        role === "accounting" ? "ops" : role,
        role,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    }
    // A second accountant, so separation of duty has somebody legitimate to fall back to.
    insert.run(
      "appu_accounting_0002",
      TENANT,
      "accounting2@example.invalid",
      "accounting-2",
      "ops",
      "accounting",
      NOW.toISOString(),
      NOW.toISOString(),
    );
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }
}

export function testEnv(): { env: AppEnv; db: AccountingTestD1 } {
  const db = new AccountingTestD1();
  return { env: { DB: db } as unknown as AppEnv, db };
}

/**
 * A QuickBooks auth port bound to a synthetic realm.
 *
 * Fixed, obviously-fake values: project rule 5 forbids a live provider credential anywhere, and a
 * token that could not possibly authenticate against Intuit is the cheapest way to keep that true.
 */
export function stubAuthPort(overrides: Partial<QuickBooksRealmBinding> = {}): QuickBooksAuthPort {
  return {
    async activeRealm(): Promise<QuickBooksRealmBinding> {
      return {
        realmId: REALM,
        accessToken: "test-access-token-not-a-credential",
        apiBase: "https://quickbooks.example.invalid",
        minorVersion: "75",
        connectionId: "qbc_test_0001",
        ...overrides,
      };
    },
  };
}

export interface FakeIntuitRoute {
  /** Matched against the request path, e.g. `/v3/company/<realm>/invoice/2001`. */
  path: string;
  status?: number;
  /** The response body. Intuit wraps an entity under its own type key. */
  body?: unknown;
  /** Throw instead of responding, to model a socket-level failure. */
  networkError?: boolean;
}

/**
 * A synthetic Intuit double of type `typeof fetch`.
 *
 * Injected through the `fetcher` parameter the final-invoice module already established
 * (contract section 9), so nothing is globally patched and no test can accidentally reach a real
 * host: an unrouted path is a 404 from this function, never a socket.
 */
export function fakeIntuit(routes: readonly FakeIntuitRoute[]): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; method: string; authorization: string | null }>;
} {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    const route = routes.find((candidate) => candidate.path === url.pathname);
    if (!route) {
      return new Response(JSON.stringify({ Fault: { Error: [{ code: "610" }] } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (route.networkError) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/**
 * The synthetic Intuit-shaped fixture catalogue (contract section 9).
 *
 * No real realm, customer, account, or credential appears in any of these files, and none of them
 * is a recording of a live call - they are hand-built to the documented response shape. That is
 * the honest limit of the mocked contract test, and section 9 states it: this proves our reader
 * and our fixtures agree, not that Intuit behaves as described.
 */
export const QUICKBOOKS_FIXTURES: ReadonlyArray<{ file: string; entityType: string }> = [
  { file: "invoice-open.json", entityType: "Invoice" },
  { file: "invoice-partially-paid.json", entityType: "Invoice" },
  { file: "invoice-paid.json", entityType: "Invoice" },
  // Slice S11: the same paid invoice, carrying the `LinkedTxn` the provider puts on it once a
  // Payment is applied. `LinkedTxn` is hashed by nothing and read by no normalizer - it only names
  // which Payment the re-observation rail goes and reads next, which is what lets an invoice reach
  // `reconciled` from a sweep or a route instead of only from a hand-called engine function.
  { file: "invoice-paid-linked.json", entityType: "Invoice" },
  { file: "invoice-overpaid-linked.json", entityType: "Invoice" },
  // ...and the same invoice after somebody edited the posted total in QuickBooks: same identity,
  // different comparison facts, which is section 5.4's provider drift.
  { file: "invoice-drifted-linked.json", entityType: "Invoice" },
  { file: "payment-partial-500.json", entityType: "Payment" },
  { file: "payment-remainder-760.json", entityType: "Payment" },
  { file: "payment-full-1260.json", entityType: "Payment" },
  { file: "payment-duplicate-1260.json", entityType: "Payment" },
  { file: "payment-overpaid-1500.json", entityType: "Payment" },
  { file: "credit-memo.json", entityType: "CreditMemo" },
  { file: "refund-receipt.json", entityType: "RefundReceipt" },
  // Slice S5: the reversal that exactly matches the 240.00 surplus an over-payment of 1500.00
  // leaves against a 1260.00 invoice, so a compensation scenario reverses a real number rather
  // than an amount chosen to fit whichever fixture already existed.
  { file: "credit-memo-240.json", entityType: "CreditMemo" },
  { file: "refund-receipt-240.json", entityType: "RefundReceipt" },
  { file: "journal-entry.json", entityType: "JournalEntry" },
  { file: "time-activity.json", entityType: "TimeActivity" },
  { file: "tax-rate-gst-5.json", entityType: "TaxRate" },
  { file: "tax-rate-gst-6.json", entityType: "TaxRate" },
];

/** The whole response body, exactly as the fixture file holds it. */
export function quickBooksFixture(file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/quickbooks/${file}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

/** The entity Intuit nests under its own type key. */
export function quickBooksEntity(file: string, entityType: string): unknown {
  return quickBooksFixture(file)[entityType];
}

/** The provider error shapes that drive behaviour, per contract section 9. */
export function quickBooksError(file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/quickbooks/errors/${file}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}
