// Every D1 table is classified for the shared multi-tenant Worker (tenancy.ts): it carries a
// tenant column, it is global infrastructure that holds no tenant's data, or it is a legacy
// table that holds one tenant's rows without a tenant column. The third list is pinned and may
// only shrink: a follow-up migration moves a table out of it by adding the column, and a new
// table must land with its tenant column or be named here as infrastructure on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Tables that hold no tenant's data: guards, throttles, the cron heartbeat, replay registries. */
export const GLOBAL_INFRASTRUCTURE_TABLES: readonly string[] = Object.freeze([
  "agent_control_guard",
  "app_auth_throttles",
  "cron_heartbeat",
  // Keyed `t:<tenant>:<key>` in code (store.ts dedupClaimKey), so the tenant is in the key.
  "dedup_claims",
  // Keyed `scheduled-v1:<tenant>`; a CHECK (0212) ties the key to the row's tenant.
  "commercial_deposit_derivation_cursors",
  "native_final_invoice_derivation_cursors",
  // Derived global cardinality witness for append-only admission integrity; no tenant rows.
  "external_effect_gateway_admission_count",
  "facet_design_event_identity_registry",
  "facet_design_ingest_nonce_registry",
  "facet_design_ingest_nonces",
  "facet_v2_estimator_ready_nonces",
  "proposal_delivery_late_answer_windows",
  "public_estimate_rate_limits",
  "service_case_batch_guard",
]);

/**
 * Tables that hold one tenant's rows without a tenant column. On a shared D1 these are read by
 * whichever tenant's env runs the query, so until a migration adds the column they belong to
 * the hosting operator's surfaces only (/admin/*, crons' global jobs). Shrink this list; never
 * extend it.
 */
export const LEGACY_UNSCOPED_TABLES: readonly string[] = Object.freeze([
  "audit_log",
  "customer_portal_acceptance_events",
  "customer_portal_decision_events",
  "dead_letter",
  // Captured local mail: recipients and links are one tenant's.
  "dev_outbox",
  "external_effect_attempts",
  "facet_v2_consumer_receipts",
  "facet_v2_estimator_ready_receipts",
  "facet_v2_native_projection_attempts",
  "facet_v2_projection_attempts",
  "field_action_media",
  // The daily reconcile verdict, one row per day for the Worker: the default tenant's.
  "heartbeat",
  "lead_ack_receipts",
  "newo_control_actions",
  "newo_event_receipts",
  "newo_reconciliation_runs",
  "newo_sessions",
  "newo_slot_reservations",
  "quickbooks_projection_outbox",
  "quickbooks_webhook_receipts",
  "replay_requests",
  "source_counts",
]);

const TENANT_COLUMNS = new Set(["tenant_id", "destination_tenant_id"]);

function schemaTables(): Map<string, string[]> {
  const db = new DatabaseSync(":memory:");
  for (const migration of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const tables = new Map<string, string[]>();
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  for (const { name } of names) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    tables.set(name, columns.map((column) => column.name));
  }
  return tables;
}

test("every table carries a tenant column or is named as infrastructure or legacy unscoped", () => {
  const tables = schemaTables();
  const scoped: string[] = [];
  const unclassified: string[] = [];
  for (const [name, columns] of tables) {
    if (columns.some((column) => TENANT_COLUMNS.has(column))) {
      scoped.push(name);
      continue;
    }
    if (GLOBAL_INFRASTRUCTURE_TABLES.includes(name) || LEGACY_UNSCOPED_TABLES.includes(name)) continue;
    unclassified.push(name);
  }
  assert.deepEqual(unclassified, [], "a new table lands with its tenant column, or is named here on purpose");
  assert.equal(scoped.length + GLOBAL_INFRASTRUCTURE_TABLES.length + LEGACY_UNSCOPED_TABLES.length, tables.size);
});

test("the legacy unscoped list only shrinks: a table that gained its tenant column leaves it", () => {
  const tables = schemaTables();
  for (const name of [...GLOBAL_INFRASTRUCTURE_TABLES, ...LEGACY_UNSCOPED_TABLES]) {
    const columns = tables.get(name);
    assert.ok(columns, `${name} is listed but no migration creates it`);
    assert.ok(!columns.some((column) => TENANT_COLUMNS.has(column)), `${name} carries a tenant column now; remove it from the list`);
  }
  for (const name of GLOBAL_INFRASTRUCTURE_TABLES) assert.ok(!LEGACY_UNSCOPED_TABLES.includes(name), `${name} is classified twice`);
});

test("the sweeps a cron runs per tenant bind the tenant on every tenant table they read", () => {
  // The queries this slice scoped; each must keep its tenant predicate.
  const sources: Array<[string, RegExp]> = [
    ["store.ts", /FROM envelopes WHERE tenant_id = \? AND status = 'pending_jn_push'/],
    ["store.ts", /WHERE status = 'received'\s+AND tenant_id = \?/],
    ["store.ts", /FROM envelopes\s+WHERE tenant_id = \? AND substr\(created_at, 1, 10\) = \?/],
    ["effect-runtime.ts", /FROM external_effects\s+WHERE tenant_id = \? AND state IN \('executing', 'reconciling'\)/],
    ["proposal-delivery-checks.ts", /WHERE effect\.tenant_id = \? AND effect\.state = 'unknown'/],
    ["customer-contract-acceptance.ts", /UPDATE customer_portal_acceptance_challenges\s+SET state = 'invalidated', invalidated_at = \?\s+WHERE tenant_id = \?/],
    ["quickbooks-final-invoice.ts", /FROM quickbooks_final_invoice_outbox\s+WHERE tenant_id = \? AND state = 'pending'/],
    ["postiz.ts", /FROM postiz_effect_outbox\s+WHERE tenant_id = \? AND state = 'pending'/],
    ["postiz.ts", /FROM postiz_intents\s+WHERE tenant_id = \?/],
    ["measurement-intake-store.ts", /FROM measurement_intake_receipts\s+WHERE tenant_id = \? AND status IN \('unmatched', 'retryable_error'\)/],
    ["measurement-intake-store.ts", /FROM measurement_intake_receipts\s+WHERE tenant_id = \?\s+AND \(\(status = 'retryable_error'/],
    ["customer-portal-decision.ts", /WHERE tenant_id = \? AND state = 'receipt_stored'/],
    ["customer-portal-decision.ts", /WHERE tenant_id = \? AND state = 'recorded'/],
    ["customer-contract-acceptance.ts", /WHERE tenant_id = \? AND state = 'receipt_stored'/],
    ["quickbooks-final-invoice.ts", /WHERE i\.tenant_id = \? AND i\.state IN \('submitted','reconciliation_required'\)/],
    ["quickbooks-final-invoice.ts", /WHERE i\.tenant_id = \? AND i\.provider_invoice_id IS NOT NULL/],
    ["quickbooks-final-invoice.ts", /FROM quickbooks_final_invoice_outbox\s+WHERE tenant_id = \? AND state = 'attempting'/],
    ["store.ts", /INNER JOIN envelopes e ON e\.envelope_id = ep\.envelope_id AND e\.tenant_id = \?/],
    ["store.ts", /INNER JOIN envelopes e ON e\.envelope_id = d\.envelope_id AND e\.tenant_id = \?/],
  ];
  for (const [file, pattern] of sources) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(source, pattern, `${file} lost its tenant predicate on a cron-swept table`);
  }
});
