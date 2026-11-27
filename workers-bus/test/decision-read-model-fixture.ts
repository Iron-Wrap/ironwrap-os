import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
} from "../src/app-types.ts";
import { auth } from "./pipeline-board-fixture.ts";

export const NOW = new Date("2026-09-29T12:00:00.000Z");
export const tables = [
  ["lead_triage", "approval_requests", "approval_request_id"],
  [
    "quote_revision",
    "quote_revision_approval_requests",
    "quote_revision_approval_id",
  ],
  [
    "proposal_publication",
    "proposal_publication_approval_requests",
    "proposal_publication_approval_id",
  ],
  ["postiz", "postiz_intents", "intent_id"],
  ["quickbooks_final_invoice", "quickbooks_final_invoice_intents", "intent_id"],
] as const;

export function actor(role: AppRole, tenant = "ironwrap") {
  const result = auth("owner", tenant);
  result.session.role = role;
  result.permissions = permissionsForRole(role);
  return result;
}

// Minimal tables exercise the real projection SQL with controllable source failures.
// A separate all-migrations handler test below verifies the actual deployed columns.
export function fixture() {
  const db = new DatabaseSync(":memory:");
  const reads: string[] = [];
  const unavailable = new Set<string>();
  for (const [, table, id] of tables)
    db.exec(`CREATE TABLE ${table} (
    ${id} TEXT, tenant_id TEXT, state TEXT, version INTEGER,
    request_text TEXT, correction_reason TEXT, roof_job_id TEXT, target_quote_version INTEGER,
    updated_at TEXT, expires_at TEXT, title TEXT, currency TEXT, final_balance TEXT,
    dry_run_receipt TEXT, write_args_json TEXT)`);
  const env = {
    DB: {
      prepare(sql: string) {
        assert.match(sql.trim(), /^SELECT /);
        assert.doesNotMatch(sql, /production_schedule_approval_requests/);
        reads.push(sql);
        if ([...unavailable].some((table) => sql.includes(`FROM ${table}`)))
          throw new Error("fixture source unavailable");
        return {
          bind: (...args: unknown[]) => ({
            all: async () => ({
              success: true,
              results: db.prepare(sql).all(...(args as never[])),
            }),
          }),
        };
      },
    },
  } as unknown as AppEnv;
  function seed(
    index: number,
    suffix = "1",
    state = index < 3 ? "pending" : "pending_review",
    tenant = "ironwrap",
  ) {
    const [, table, id] = tables[index]!;
    const value =
      index === 3
        ? `11111111-1111-4111-8111-${suffix.padStart(12, "0")}`
        : index === 4
          ? `request:fixture:${index}:${suffix}`
          : `${["approval", "quote-revision-approval", "proposal-publication-approval"][index]}:${suffix.padStart(16, "0")}`;
    db.prepare(
      `INSERT INTO ${table} (${id}, tenant_id, state, version, request_text,
      correction_reason, roof_job_id, target_quote_version, updated_at, expires_at,
      title, currency, final_balance, dry_run_receipt, write_args_json)
      VALUES (?, ?, ?, 2, 'Review captured note', 'Correct measurement', 'job:fixture:1', 3,
        ?, '2026-09-28T12:00:00.000Z', 'Roof update', 'CAD', '1200.00',
        'withheld fixture receipt', '{"fixture":"withheld arguments"}')`,
    ).run(value, tenant, state, NOW.toISOString());
    return value;
  }
  return { db, env, reads, unavailable, seed };
}
