// The `INSERT OR REPLACE` half of append-only, on every table 0059-0061 declares append-only.
//
// PR #73 review finding 1 (Multica ELEC-64/ELEC-65). `BEFORE UPDATE`/`BEFORE DELETE` triggers do
// not, by themselves, make a table append-only: `INSERT OR REPLACE` (and its `REPLACE INTO`
// spelling) resolves a UNIQUE conflict by deleting the conflicting row *internally*, and an
// internal delete fires DELETE triggers only when `PRAGMA recursive_triggers` is ON - which it is
// not, by default, on D1 or on `node:sqlite`. Before the `BEFORE INSERT` guards in 0059-0061 every
// assertion in this file failed: the forged row landed and the recorded fact was gone.
//
// These run the real migration SQL through the same harness the rest of the money plane uses, so
// the refusal is executed, not described. The same statements were also run against real D1
// (workerd via miniflare) while the guards were being written; the trigger SQL is identical.

import assert from "node:assert/strict";
import { test } from "node:test";

import { NOW, REALM, TENANT, quickBooksEntity, testEnv } from "./accounting-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import {
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  recordAccountingIntentSubmission,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import { normalizeProviderEntity, providerFactEnvelope } from "../src/accounting-normalizers.ts";
import {
  bindAccountingIntentTaxSnapshots,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
  type TaxPolicySnapshotRecord,
} from "../src/accounting-tax-snapshots.ts";
import {
  recordAccountingObservation,
  reconcileAccountingIntent,
} from "../src/accounting-reconciliation.ts";
import { intentSubjectRef, raiseAccountingException } from "../src/accounting-exceptions.ts";
import type { ProviderReadResult } from "../src/accounting-provider-read.ts";

const T2 = "2026-08-19T12:05:00.000Z";
const T3 = "2026-08-19T12:10:00.000Z";
const LATER = new Date(T2);
const LATEST = new Date(T3);
const INTENT_ID = "acct-intent:job-0001:deposit_invoice";

const GST = {
  tenantId: TENANT,
  jurisdiction: "CA-AB",
  taxCode: "GST",
  providerTaxCodeId: "3",
  ratePercent: "5.0000",
  effectiveFrom: "2008-01-01",
  sourceRef: "CRA GST bulletin 2008-01-01",
} as const;

/** A tax-bearing intent in `pending_review`, bound to `snapshot`. Nothing decided yet. */
async function deriveBoundIntent(
  env: AppEnv,
  intentId: string,
  snapshot: TaxPolicySnapshotRecord,
  now: Date,
): Promise<AccountingIntentRecord> {
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload: quickBooksEntity("invoice-open.json", "Invoice"),
  }).facts;

  const intent = await deriveAccountingIntent(env, {
    tenantId: TENANT,
    intentId,
    kind: "deposit_invoice",
    roofJobId: "job-0001",
    basis: { roofJob: "job-0001", intentId },
    sourceDocuments: [{ id: "quote-0001", version: 3 }],
    expected: providerFactEnvelope({ realmId: REALM, entityType: "Invoice", facts }),
    taxPolicySnapshotSha256: await taxBindingSetSha256([snapshot.snapshot_sha256]),
    realmId: REALM,
    providerPayload: { TotalAmt: "1260.00" },
    providerRequestId: `req-${intentId}`,
    subtotal: "1200.00",
    taxAmount: "60.00",
    totalAmount: "1260.00",
    authority: {
      permitRef: "permit:accounting:invoice",
      policyRef: "policy:accounting:invoice.create",
      policyVersion: "v1",
      maxAmount: "5000.00",
    },
    effectIdempotencyKey: `acct:${intentId}:v1`,
    derivedBy: { actorKind: "agent" },
  }, now);

  await bindAccountingIntentTaxSnapshots(env, {
    tenantId: TENANT, intentId, snapshots: [snapshot],
  }, now);
  return intent;
}

/** One live row in each of the six append-only tables, written the way the runtime writes them. */
async function seedMoneyPlane(env: AppEnv): Promise<AccountingIntentRecord> {
  const snapshot = await recordTaxPolicySnapshot(env, GST, NOW);
  const intent = await deriveBoundIntent(env, INTENT_ID, snapshot, NOW);

  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${INTENT_ID}`,
    request: { version: intent.version },
    requestedVersion: intent.version,
  }, NOW);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: INTENT_ID,
    outcome: {
      effectId: "effect:ironwrap:1",
      state: "succeeded",
      attemptId: "effect:ironwrap:1:attempt:1",
      attemptState: "succeeded",
      providerExternalId: "2001",
      requestHash: "b".repeat(64),
      providerResponseHash: "c".repeat(64),
      readbackHash: "d".repeat(64),
      resultCode: null,
    },
  }, LATER);

  // A Payment with a LinkedTxn line: one observation row plus one observation-link row.
  const payment = quickBooksEntity("payment-full-1260.json", "Payment");
  await recordAccountingObservation(env, {
    tenantId: TENANT,
    realmId: REALM,
    entityType: "Payment",
    normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Payment", payload: payment }),
    payload: payment,
    readAt: T2,
    source: "sweep",
  }, LATER);

  // A clean readback: one reconciliation verdict of record.
  const invoice = quickBooksEntity("invoice-paid.json", "Invoice");
  const read: ProviderReadResult = {
    status: "ok",
    realmId: REALM,
    entityType: "Invoice",
    entityId: "2001",
    payload: invoice,
    normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload: invoice }),
    readAt: T3,
    source: "dispatch_readback",
    effectAttemptId: "effect:ironwrap:1:attempt:1",
    duplicateEntityIds: [],
  };
  await reconcileAccountingIntent(env, {
    tenantId: TENANT, intentId: INTENT_ID, read,
  }, LATEST);

  // One live exception in the accountant queue.
  await raiseAccountingException(env, {
    tenantId: TENANT,
    subjectRef: intentSubjectRef(INTENT_ID),
    intentId: INTENT_ID,
    reasonCode: "provider_readback_drift",
    expectedSha256: "e".repeat(64),
    observedSha256: "f".repeat(64),
    detail: { note: "seeded" },
  }, LATEST);

  return submitted;
}

type Row = Record<string, unknown>;

/**
 * Build a `REPLACE INTO <table>` that reproduces `row` except for `changes`, so the statement
 * collides on a declared unique key and would rewrite a recorded fact. `spelling` covers both
 * surfaces of the same SQLite behaviour.
 */
function replaceStatement(
  table: string,
  row: Row,
  changes: Row,
  spelling: "REPLACE INTO" | "INSERT OR REPLACE INTO",
): { sql: string; args: unknown[] } {
  const next = { ...row, ...changes };
  const columns = Object.keys(next);
  return {
    sql: `${spelling} ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    args: columns.map((column) => next[column] ?? null),
  };
}

/** Every append-only table 0059-0061 declares, with the fact a forged REPLACE would rewrite. */
const TABLES = [
  {
    table: "tax_policy_snapshots",
    key: "snapshot_id",
    reason: /tax_policy_snapshot_immutable/,
    // Conflicts on UNIQUE (tenant_id, snapshot_sha256) under a brand new primary key: the rate a
    // submitted intent is bound to, rewritten from 5% to 9.9999%.
    changes: { snapshot_id: "tax-snap:CA-AB:GST:v99", rate_percent: "9.9999", version: 99 },
    witness: "rate_percent",
    expected: "5.0000",
  },
  {
    table: "accounting_intent_tax_bindings",
    key: "binding_id",
    reason: /accounting_tax_binding_append_only/,
    // Conflicts on UNIQUE (tenant_id, intent_id, tax_code): the binding points at another hash.
    changes: {
      binding_id: "00000000-0000-4000-8000-000000000001",
      snapshot_sha256: "1".repeat(64),
    },
    witness: "snapshot_sha256",
  },
  {
    table: "accounting_observations",
    key: "observation_id",
    reason: /accounting_observation_append_only/,
    // Conflicts on UNIQUE (tenant_id, realm_id, entity_type, entity_id, observed_sha256, read_at):
    // the same read, re-stated with a different balance.
    changes: {
      observation_seq: null,
      observation_id: "00000000-0000-4000-8000-000000000002",
      balance_cents: 999999,
    },
    witness: "balance_cents",
  },
  {
    table: "accounting_observation_links",
    key: "link_id",
    reason: /accounting_observation_append_only/,
    // Conflicts on UNIQUE (observation_id, line_index, linked_txn_type, linked_txn_id).
    changes: { link_id: "00000000-0000-4000-8000-000000000003", amount_cents: 1 },
    witness: "amount_cents",
  },
  {
    table: "accounting_reconciliations",
    key: "reconciliation_id",
    reason: /accounting_reconciliation_append_only/,
    // Conflicts on UNIQUE (tenant_id, intent_id, observation_id): the verdict of record, flipped.
    changes: {
      reconciliation_id: "00000000-0000-4000-8000-000000000004",
      verdict: "mismatch",
      reason_code: "expected_observed_mismatch",
    },
    witness: "verdict",
    expected: "reconciled",
  },
  {
    table: "accounting_exceptions",
    key: "exception_id",
    reason: /accounting_exception_retained/,
    // Conflicts on the partial unique index over live rows: the finding, re-stated and disowned.
    changes: {
      exception_id: "00000000-0000-4000-8000-000000000005",
      observed_sha256: "9".repeat(64),
      detail_json: '{"note":"forged"}',
    },
    witness: "observed_sha256",
  },
] as const;

for (const spelling of ["REPLACE INTO", "INSERT OR REPLACE INTO"] as const) {
  for (const target of TABLES) {
    test(`${spelling} cannot rewrite a recorded fact in ${target.table}`, async () => {
      const { env, db } = testEnv();
      await seedMoneyPlane(env);

      const count = () =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${target.table}`).get() as { n: number }).n;
      const row = db.raw.prepare(`SELECT * FROM ${target.table} LIMIT 1`).get() as Row;
      assert.ok(row, `${target.table} should have a seeded row`);
      const before = row[target.witness];
      const rowsBefore = count();
      if ("expected" in target) assert.equal(before, target.expected);

      const { sql, args } = replaceStatement(target.table, row, target.changes, spelling);
      assert.throws(() => db.raw.prepare(sql).run(...args), target.reason);

      const after = db.raw.prepare(
        `SELECT * FROM ${target.table} WHERE ${target.key} = ?`,
      ).get(row[target.key]) as Row | undefined;
      assert.ok(after, `${target.table} row must survive the refused ${spelling}`);
      assert.equal(after[target.witness], before);
      assert.equal(count(), rowsBefore, "the forged row must not have landed alongside");
    });
  }
}

test("a REPLACE that re-states an identical fact changes nothing, and does not re-sequence it", async () => {
  // The one conflicting insert that is not an attempt to rewrite history. It must not abort - the
  // runtime's `ON CONFLICT ... DO NOTHING` re-records take this path - and it must not delete and
  // re-create the row either: `accounting_observations` supersession is "highest observation_seq
  // wins", so a replayed old read that came back with a new sequence would become the current one
  // without a single fact changing.
  const { env, db } = testEnv();
  await seedMoneyPlane(env);

  const count = () =>
    (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_observations`).get() as { n: number }).n;
  const before = db.raw.prepare(
    `SELECT * FROM accounting_observations ORDER BY observation_seq LIMIT 1`,
  ).get() as Row;
  const rowsBefore = count();

  const { sql, args } = replaceStatement("accounting_observations", before, {
    observation_seq: null,
    observation_id: "00000000-0000-4000-8000-00000000000a",
    created_at: "2026-08-19T23:59:59.000Z",
  }, "REPLACE INTO");
  db.raw.prepare(sql).run(...args);

  const after = db.raw.prepare(
    `SELECT * FROM accounting_observations WHERE observation_id = ?`,
  ).get(before.observation_id) as Row | undefined;
  assert.ok(after, "the recorded observation must still be there under its own id");
  assert.equal(after.observation_seq, before.observation_seq);
  assert.equal(after.created_at, before.created_at);
  assert.equal(count(), rowsBefore, "the re-stated fact must not have landed as a second row");
});

test("recording the same fact twice is still one row, through the module path", async () => {
  // The guard sits on the path every idempotent re-record uses, so this is the regression that
  // matters most: `ON CONFLICT ... DO NOTHING` must stay a silent no-op, not become an abort.
  const { env, db } = testEnv();
  await seedMoneyPlane(env);

  const counts = () => ({
    snapshots: (db.raw.prepare(`SELECT COUNT(*) AS n FROM tax_policy_snapshots`).get() as { n: number }).n,
    bindings: (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_intent_tax_bindings`).get() as { n: number }).n,
    observations: (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_observations`).get() as { n: number }).n,
    links: (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_observation_links`).get() as { n: number }).n,
    exceptions: (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_exceptions`).get() as { n: number }).n,
  });

  // A second intent, still pre-decision, so re-binding is the legal path rather than a refusal.
  const snapshot = await recordTaxPolicySnapshot(env, GST, LATEST);
  await deriveBoundIntent(env, "acct-intent:job-0002:deposit_invoice", snapshot, LATEST);
  const before = counts();

  await recordTaxPolicySnapshot(env, GST, LATEST);
  await bindAccountingIntentTaxSnapshots(env, {
    tenantId: TENANT,
    intentId: "acct-intent:job-0002:deposit_invoice",
    snapshots: [snapshot],
  }, LATEST);
  const payment = quickBooksEntity("payment-full-1260.json", "Payment");
  await recordAccountingObservation(env, {
    tenantId: TENANT,
    realmId: REALM,
    entityType: "Payment",
    normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Payment", payload: payment }),
    payload: payment,
    readAt: T2,
    source: "sweep",
  }, LATEST);
  const raised = await raiseAccountingException(env, {
    tenantId: TENANT,
    subjectRef: intentSubjectRef(INTENT_ID),
    intentId: INTENT_ID,
    reasonCode: "provider_readback_drift",
    expectedSha256: "e".repeat(64),
    observedSha256: "f".repeat(64),
    detail: { note: "seeded" },
  }, LATEST);

  assert.equal(raised.raised, false, "re-raising a live finding stays a no-op");
  assert.deepEqual(counts(), before);
});

test("the INSERT guard does not mask the binding guard it shares a table with", async () => {
  // SQLite leaves the firing order of two BEFORE INSERT triggers undefined, so the guard added
  // here must not be able to abandon a row before `accounting_intent_tax_bindings_guard` runs.
  // A re-bind after submission has to stay the loud refusal it has always been.
  const { env } = testEnv();
  await seedMoneyPlane(env);
  const snapshot = await recordTaxPolicySnapshot(env, GST, LATEST);

  await assert.rejects(
    () => bindAccountingIntentTaxSnapshots(env, {
      tenantId: TENANT, intentId: INTENT_ID, snapshots: [snapshot],
    }, LATEST),
    /accounting_tax_binding_intent_not_bindable/,
  );
});
