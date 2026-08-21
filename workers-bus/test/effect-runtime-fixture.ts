import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// 0042 declares the ledger; 0062 adds the `BEFORE INSERT` guards that make its append-only claim
// hold against `INSERT OR REPLACE` as well as against UPDATE and DELETE. The fixture applies both,
// so a test that says "the ledger refuses this" is executing the refusal the deployed schema has.
const migrations = [
  "0042_external_effect_runtime.sql",
  "0062_external_effect_insert_replace_guards.sql",
].map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
const effectSql = /\bexternal_effect(?:s|_attempts|_events|_exceptions)\b/i;

class SqliteStatement {
  private readonly statement: StatementSync;
  private readonly args: unknown[];
  private readonly database: DatabaseSync;

  constructor(statement: StatementSync, database: DatabaseSync, args: unknown[] = []) {
    this.statement = statement;
    this.database = database;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.statement, this.database, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  /**
   * `meta.changes` the way D1 reports it: a `total_changes()` delta, which **includes rows written
   * by triggers**, not `sqlite3_changes()`.
   *
   * This is not a detail. `0042` puts an `AFTER UPDATE OF state` trigger on `external_effects` that
   * writes an `external_effect_events` row, so every state transition reports 2 on D1 and 1 here
   * until this delta is measured the same way. Reporting the narrow count let
   * `effect-runtime.ts`'s `!== 1` CAS guards pass every test while failing on the first transition
   * against real D1 - proven on the ELEC-75 local stack, where the ledger recorded
   * `proposed -> authorized` and the caller was told `effect_transition_conflict` for the same
   * write. `accounting-api-fixture.ts` already models D1 this way, and for the same reason.
   */
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const before = totalChanges(this.database);
    this.statement.run(...this.args);
    return { success: true, meta: { changes: totalChanges(this.database) - before } };
  }
}

function totalChanges(database: DatabaseSync): number {
  return Number(
    (database.prepare("SELECT total_changes() AS total").get() as { total: number }).total,
  );
}

class EffectLedgerTestD1 {
  private readonly ledger = new DatabaseSync(":memory:");
  private readonly base: Record<string, any> | undefined;

  constructor(base: Record<string, any> | undefined) {
    this.base = base;
    this.ledger.exec("PRAGMA foreign_keys = ON");
    for (const migration of migrations) this.ledger.exec(migration);
  }

  prepare(sql: string) {
    if (effectSql.test(sql) || /^\s*SELECT\s+1(?:\s|;|$)/i.test(sql)) {
      return new SqliteStatement(this.ledger.prepare(sql), this.ledger);
    }
    if (typeof this.base?.prepare !== "function") throw new Error("test_business_db_unavailable");
    return this.base.prepare(sql);
  }

  /**
   * D1 runs a `batch` as one implicit transaction, so a statement that throws leaves none of the
   * batch applied. The effect-runtime claim path depends on exactly that: the UPDATE that takes the
   * lease and the INSERT that records its attempt row have to land together or not at all. Model it
   * here rather than delegating to the business double, which has no ledger to write to.
   */
  async batch(statements: unknown[]) {
    if (statements.length > 0 && statements.every((statement) => statement instanceof SqliteStatement)) {
      this.ledger.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements as SqliteStatement[]) results.push(await statement.run());
        this.ledger.exec("COMMIT");
        return results;
      } catch (error) {
        this.ledger.exec("ROLLBACK");
        throw error;
      }
    }
    if (typeof this.base?.batch !== "function") throw new Error("test_business_db_batch_unavailable");
    return this.base.batch(statements);
  }

  exec(sql: string) {
    if (typeof this.base?.exec !== "function") throw new Error("test_business_db_exec_unavailable");
    return this.base.exec(sql);
  }
}

export function withTestEffectRuntime<T extends Record<string, unknown>>(env: T) {
  return {
    ...env,
    DB: new EffectLedgerTestD1(env.DB as Record<string, any> | undefined),
    EFFECT_RUNTIME_ENABLED: "true",
  };
}

export function withErpReadback(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  const records = new Map<string, Record<string, unknown>>();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const resource = url.pathname.match(/^\/api\/resource\/([^/]+)(?:\/([^/]+))?$/);
    if (method === "GET" && resource?.[2]) {
      const stored = records.get(`${decodeURIComponent(resource[1]!)}:${decodeURIComponent(resource[2])}`);
      if (stored) return testJson({ data: stored });
    }

    const response = await handler(input, init);
    if ((method === "POST" || method === "PUT") && response.ok && resource) {
      const responseBody = await response.clone().json() as { data?: Record<string, unknown> };
      const name = typeof responseBody.data?.name === "string"
        ? responseBody.data.name
        : resource[2] ? decodeURIComponent(resource[2]) : null;
      if (name) {
        const key = `${decodeURIComponent(resource[1]!)}:${name}`;
        const requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        records.set(key, { ...records.get(key), ...requestBody, ...responseBody.data, name });
      }
    }
    return response;
  };
}

export function withQuickBooksReconciliationReadback(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  const reconciliations = new Map<string, Record<string, unknown>>();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.read_pending_reconciliation")) {
      const request = JSON.parse(String(init?.body)) as { reconciliation_id?: unknown };
      const id = typeof request.reconciliation_id === "string" ? request.reconciliation_id : "";
      const reconciliation = reconciliations.get(id);
      return testJson({ message: reconciliation ? { found: true, reconciliation } : { found: false } });
    }

    const response = await handler(input, init);
    if (response.ok && url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      const request = JSON.parse(String(init?.body)) as { reconciliation_json?: unknown };
      const doc = typeof request.reconciliation_json === "string"
        ? JSON.parse(request.reconciliation_json) as Record<string, unknown>
        : {};
      const result = await response.clone().json() as { message?: { name?: unknown } };
      if (typeof result.message?.name === "string") {
        reconciliations.set(result.message.name, { ...doc, name: result.message.name });
      }
    }
    return response;
  };
}

function testJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
