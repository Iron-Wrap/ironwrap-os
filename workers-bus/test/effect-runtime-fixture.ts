import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const migration = readFileSync(
  new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url),
  "utf8",
);
const effectSql = /\bexternal_effect(?:s|_attempts|_events|_exceptions)\b/i;

class SqliteStatement {
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(statement: StatementSync, args: unknown[] = []) {
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class EffectLedgerTestD1 {
  private readonly ledger = new DatabaseSync(":memory:");
  private readonly base: Record<string, any> | undefined;

  constructor(base: Record<string, any> | undefined) {
    this.base = base;
    this.ledger.exec("PRAGMA foreign_keys = ON");
    this.ledger.exec(migration);
  }

  prepare(sql: string) {
    if (effectSql.test(sql) || /^\s*SELECT\s+1(?:\s|;|$)/i.test(sql)) {
      return new SqliteStatement(this.ledger.prepare(sql));
    }
    if (typeof this.base?.prepare !== "function") throw new Error("test_business_db_unavailable");
    return this.base.prepare(sql);
  }

  batch(statements: unknown[]) {
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
