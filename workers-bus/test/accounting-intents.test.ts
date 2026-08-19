// Slice S1. The state machine, the command receipts, and the D1 invariants that back them.
//
// Every test here runs the real migration SQL in `node:sqlite` behind a D1-shaped facade, the same
// way `effect-runtime-fixture.ts` does, so the CHECKs and triggers execute rather than being
// described. A test that only exercised the TypeScript would prove nothing about the storage layer
// that is the actual backstop.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import {
  ACCOUNTING_INTENT_KINDS,
  ACCOUNTING_INTENT_STATES,
  ACCOUNTING_INTENT_TRANSITIONS,
  AccountingIntentError,
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  listAccountingIntentEvents,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  recordAccountingIntentVerdict,
  type AccountingIntentState,
  type DeriveAccountingIntentInput,
} from "../src/accounting-intents.ts";
import type { MoneyEffectOutcome } from "../src/accounting-effect-port.ts";

const TENANT = "ironwrap";
const REALM = "4620816365000000000";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const LATER = new Date("2026-08-19T12:05:00.000Z");

const MIGRATION = readFileSync(
  new URL("../migrations/0058_accounting_money_intents.sql", import.meta.url),
  "utf8",
);

class SqliteStatement {
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

class AccountingTestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0030_facet_design_ingest.sql",
      "0034_facet_customer_approval_ingest.sql",
      "0035_facet_design_evidence_associations.sql",
      "0038_app_access_roles.sql",
      "0058_accounting_money_intents.sql",
    ]) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
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

function testEnv(): { env: AppEnv; db: AccountingTestD1 } {
  const db = new AccountingTestD1();
  return { env: { DB: db } as unknown as AppEnv, db };
}

function deriveInput(
  overrides: Partial<DeriveAccountingIntentInput> = {},
): DeriveAccountingIntentInput {
  return {
    tenantId: TENANT,
    intentId: "acct-intent:job-0001:payment",
    kind: "payment",
    roofJobId: "job-0001",
    basis: { roofJob: "job-0001", invoice: "1001", amount: "1200.00" },
    sourceDocuments: [{ id: "quote-0001", version: 3 }],
    expected: { realmId: REALM, Id: "2001", TotalAmt: "1200.00" },
    realmId: REALM,
    providerPayload: { TotalAmt: "1200.00", CustomerRef: { value: "42" } },
    providerRequestId: "req-payment-0001",
    subtotal: "1200.00",
    taxAmount: "0.00",
    totalAmount: "1200.00",
    authority: {
      permitRef: "permit:accounting:payment",
      policyRef: "policy:accounting:payment.create",
      policyVersion: "v1",
      maxAmount: "5000.00",
    },
    effectIdempotencyKey: "acct:payment:job-0001:v1",
    derivedBy: { actorKind: "agent" },
    ...overrides,
  };
}

function settledOutcome(
  overrides: Partial<MoneyEffectOutcome<unknown>> = {},
): MoneyEffectOutcome<unknown> {
  return {
    effectId: "effect:ironwrap:1",
    state: "succeeded",
    attemptId: "effect:ironwrap:1:attempt:1",
    attemptState: "succeeded",
    providerExternalId: "2001",
    requestHash: "b".repeat(64),
    providerResponseHash: "c".repeat(64),
    readbackHash: "d".repeat(64),
    resultCode: null,
    ...overrides,
  };
}

/** Approve through the command path, which is the only legitimate route out of pending_review. */
async function approve(
  env: AppEnv,
  intentId: string,
  version: number,
  actorUserId = "appu_accounting_0001",
) {
  return await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId,
    operation: "approve",
    actorUserId,
    idempotencyKey: `approve:${intentId}:${version}`,
    request: { version },
    requestedVersion: version,
  }, NOW);
}

test("the D1 transition guard and the TypeScript transition map are the same graph", () => {
  // Both are derived from section 5 of the contract; a divergence would let a handler write a
  // state the storage layer forbids, or refuse one it allows.
  const guard = MIGRATION.slice(
    MIGRATION.indexOf("CREATE TRIGGER accounting_intents_transition_guard"),
  ).slice(0, MIGRATION.slice(MIGRATION.indexOf("CREATE TRIGGER accounting_intents_transition_guard")).indexOf("END;"));

  const fromSql = new Map<string, Set<string>>();
  for (const match of guard.matchAll(
    /OLD\.state = '(\w+)'\s+AND NEW\.state\s+(?:IN \(([^)]*)\)|= '(\w+)')/g,
  )) {
    const targets = match[3]
      ? [match[3]]
      : [...match[2]!.matchAll(/'(\w+)'/g)].map((entry) => entry[1]!);
    fromSql.set(match[1]!, new Set(targets));
  }

  assert.equal(fromSql.size, ACCOUNTING_INTENT_STATES.length);
  for (const state of ACCOUNTING_INTENT_STATES) {
    assert.deepEqual(
      [...(fromSql.get(state) ?? [])].sort(),
      [...ACCOUNTING_INTENT_TRANSITIONS[state]].sort(),
      `transition set for ${state} differs between D1 and TypeScript`,
    );
  }
});

test("the migration declares no table owned by the effect runtime or the connection plane", () => {
  // Contract section 3.1 rule 1: re-declaring one guarantees a collision.
  for (const table of [
    "external_effects", "external_effect_attempts", "external_effect_events",
    "external_effect_exceptions", "quickbooks_oauth_states", "quickbooks_connections",
    "quickbooks_connection_events", "quickbooks_final_invoice_intents",
  ]) {
    assert.doesNotMatch(
      MIGRATION,
      new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`),
      `${table} must not be re-declared`,
    );
  }
  // Rule 2: cross-plane references are TEXT with no foreign key.
  assert.doesNotMatch(MIGRATION, /REFERENCES external_effects?\b/);
  assert.doesNotMatch(MIGRATION, /REFERENCES quickbooks_\w+/);
  assert.match(MIGRATION, /effect_id TEXT CHECK/);
});

test("a derived intent binds its basis, hashes and authority and lands in review", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);

  assert.equal(intent.state, "pending_review");
  assert.equal(intent.version, 1);
  assert.equal(intent.kind, "payment");
  assert.equal(intent.provider_entity_type, "Payment");
  assert.equal(intent.basis_sha256, await sha256Hex(canonicalJson(deriveInput().basis)));
  assert.equal(intent.expected_sha256, await sha256Hex(canonicalJson(deriveInput().expected)));
  assert.equal(intent.derived_by_actor_kind, "agent");
  assert.equal(intent.derived_by_user_id, null);
  assert.equal(intent.approved_by_user_id, null);
  assert.equal(intent.observed_sha256, null);

  const events = await listAccountingIntentEvents(env, TENANT, intent.intent_id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event_type, "derived");
  assert.equal(events[0]!.state_to, "pending_review");
});

test("deriving twice from the same bound facts returns the same intent", async () => {
  const { env } = testEnv();
  const first = await deriveAccountingIntent(env, deriveInput(), NOW);
  const second = await deriveAccountingIntent(
    env,
    deriveInput({ intentId: "acct-intent:job-0001:payment-duplicate" }),
    LATER,
  );
  assert.equal(second.intent_id, first.intent_id);
  assert.equal(second.version, 1);
  assert.equal((await listAccountingIntentEvents(env, TENANT, first.intent_id)).length, 1);
});

test("a tax-bearing kind cannot be derived without a bound tax snapshot", async () => {
  const { env } = testEnv();
  await assert.rejects(
    () => deriveAccountingIntent(
      env,
      deriveInput({ kind: "deposit_invoice", taxPolicySnapshotSha256: null }),
      NOW,
    ),
    (error: AccountingIntentError) => error.code === "tax_mapping_missing",
  );
});

test("D1 refuses a tax-bearing intent with no snapshot even when the handler is bypassed", () => {
  const { db } = testEnv();
  assert.throws(
    () => insertIntentDirectly(db, {
      kind: "deposit_invoice",
      provider_entity_type: "Invoice",
      tax_policy_snapshot_sha256: null,
    }),
    /CHECK constraint failed/,
  );
});

test("an intent may not be derived already above its own policy ceiling", async () => {
  const { env } = testEnv();
  await assert.rejects(
    () => deriveAccountingIntent(
      env,
      deriveInput({
        totalAmount: "9000.00",
        authority: { ...deriveInput().authority, maxAmount: "5000.00" },
      }),
      NOW,
    ),
    (error: AccountingIntentError) => error.code === "effect_policy_amount_ceiling_exceeded",
  );
});

test("the ceiling is a magnitude, so a refund below its negative is refused too", async () => {
  const { env } = testEnv();
  // Section 4.1: a refund carries a negative total. Section 6 gates a refund above the ceiling on
  // the owner, so a signed comparison would have exempted the reversing kinds entirely.
  const refund = (totalAmount: string) => deriveInput({
    intentId: "acct-intent:job-0001:refund",
    kind: "refund",
    basis: { roofJob: "job-0001", refund: "customer-decision-7", amount: totalAmount },
    effectIdempotencyKey: "acct:refund:job-0001:v1",
    providerRequestId: "req-refund-0001",
    subtotal: totalAmount,
    totalAmount,
    authority: { ...deriveInput().authority, maxAmount: "5000.00" },
  });

  await assert.rejects(
    () => deriveAccountingIntent(env, refund("-9000.00"), NOW),
    (error: AccountingIntentError) => error.code === "effect_policy_amount_ceiling_exceeded",
  );

  // The magnitude rule may not swallow the legitimate case: a refund inside the ceiling derives.
  const within = await deriveAccountingIntent(env, refund("-4500.00"), NOW);
  assert.equal(within.total_amount, "-4500.00");
  assert.equal(within.state, "pending_review");
});

test("D1 refuses an over-ceiling negative total even when the handler is bypassed", () => {
  const { db } = testEnv();
  assert.throws(
    () => insertIntentDirectly(db, {
      intent_id: "acct-intent:job-0001:refund-direct",
      kind: "refund",
      provider_entity_type: "RefundReceipt",
      basis_sha256: "1".repeat(64),
      effect_idempotency_key: "acct:refund:job-0001:direct",
      provider_request_id: "req-refund-direct-0001",
      subtotal: "-9000.00",
      total_amount: "-9000.00",
      authority_max_amount: "5000.00",
    }),
    /CHECK constraint failed/,
  );
});

test("an over-ceiling refund still needs the owner if the row ever gets past the CHECK", async () => {
  const { env, db } = testEnv();
  // The table CHECK now refuses an over-ceiling row outright, which would make the trigger's
  // ceiling branch untestable through any normal path — so the CHECK is suspended for this test
  // only, to prove the trigger is a real second layer and not a restatement of the first. Triggers
  // stay armed under this pragma; it stays on for the whole test because the trigger's own UPDATE
  // would otherwise be re-checked against the ceiling it is being tested against.
  db.raw.exec("PRAGMA ignore_check_constraints = ON");
  insertIntentDirectly(db, {
    intent_id: "acct-intent:job-0001:refund-over-ceiling",
    kind: "refund",
    provider_entity_type: "RefundReceipt",
    basis_sha256: "2".repeat(64),
    effect_idempotency_key: "acct:refund:job-0001:over-ceiling",
    provider_request_id: "req-refund-over-ceiling-0001",
    subtotal: "-9000.00",
    total_amount: "-9000.00",
    authority_max_amount: "5000.00",
  });

  await assert.rejects(
    () => approve(env, "acct-intent:job-0001:refund-over-ceiling", 1, "appu_accounting_0001"),
    (error: AccountingIntentError) => error.code === "accounting_intent_owner_authority_required",
  );
  const approved = await approve(
    env, "acct-intent:job-0001:refund-over-ceiling", 1, "appu_owner_0001",
  );
  assert.equal(approved.intent.state, "submission_pending");
  assert.equal(approved.intent.approved_by_user_id, "appu_owner_0001");
});

test("the event history is read per tenant, not per globally-guessable intent id", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  // `intent_id` is `acct-intent:<roofJobId>:<kind>` — structured and guessable, not a secret, so
  // the tenant is what scopes the read (section 8.2).
  assert.equal((await listAccountingIntentEvents(env, TENANT, intent.intent_id)).length, 1);
  assert.deepEqual(await listAccountingIntentEvents(env, "other-tenant", intent.intent_id), []);
});

test("money columns refuse anything that is not a two-place decimal", () => {
  const { db } = testEnv();
  for (const amount of ["1200", "1200.0", "1200.000", "1.2e3", "1,200.00", "12-00.00", ""]) {
    assert.throws(
      () => insertIntentDirectly(db, { total_amount: amount }),
      /CHECK constraint failed/,
      `total_amount accepted ${JSON.stringify(amount)}`,
    );
  }
  // A credit is legitimately negative; a leading minus is the only place one may appear.
  assert.doesNotThrow(() => insertIntentDirectly(db, {
    intent_id: "acct-intent:job-0002:credit",
    basis_sha256: "e".repeat(64),
    effect_idempotency_key: "acct:credit:job-0002:v1",
    provider_request_id: "req-credit-0002",
    total_amount: "-450.00",
    subtotal: "-450.00",
  }));
});

test("approval is a command receipt, and a replay applies nothing twice", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);

  const first = await approve(env, intent.intent_id, 1);
  assert.equal(first.replayed, false);
  assert.equal(first.intent.state, "submission_pending");
  assert.equal(first.intent.version, 2);
  assert.equal(first.intent.approved_by_user_id, "appu_accounting_0001");
  assert.match(first.intent.approved_at ?? "", /^2026-08-19T12:00:00/);

  const replay = await approve(env, intent.intent_id, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intent.version, 2);
  assert.equal(replay.intent.state, "submission_pending");

  const events = await listAccountingIntentEvents(env, TENANT, intent.intent_id);
  assert.deepEqual(events.map((event) => event.event_type), ["derived", "approved"]);
  assert.equal(events[1]!.actor_user_id, "appu_accounting_0001");
});

test("the same idempotency key with a different body is a conflict, not an overwrite", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  await approve(env, intent.intent_id, 1);
  await assert.rejects(
    () => applyAccountingIntentCommand(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      operation: "approve",
      actorUserId: "appu_accounting_0001",
      idempotencyKey: `approve:${intent.intent_id}:1`,
      request: { version: 1, note: "changed" },
      requestedVersion: 1,
    }, LATER),
    (error: AccountingIntentError) => error.code === "accounting_intent_command_conflict",
  );
});

test("a stale version loses the race instead of applying to a moved aggregate", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  await approve(env, intent.intent_id, 1);
  await assert.rejects(
    () => applyAccountingIntentCommand(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      operation: "reject",
      actorUserId: "appu_owner_0001",
      idempotencyKey: "reject:stale",
      request: { version: 1 },
      requestedVersion: 1,
    }, LATER),
    (error: AccountingIntentError) => error.code === "accounting_intent_command_version_invalid",
  );
});

test("the actor that derived a candidate may not approve it", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(
    env,
    deriveInput({ derivedBy: { actorKind: "accounting", userId: "appu_accounting_0001" } }),
    NOW,
  );
  await assert.rejects(
    () => approve(env, intent.intent_id, 1, "appu_accounting_0001"),
    (error: AccountingIntentError) => error.code === "accounting_intent_separation_of_duty",
  );
  // The second accountant is a legitimate approver for the same intent.
  const approved = await approve(env, intent.intent_id, 1, "appu_accounting_0002");
  assert.equal(approved.intent.state, "submission_pending");
});

test("D1 refuses a separation-of-duty violation written straight to the receipt table", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(
    env,
    deriveInput({ derivedBy: { actorKind: "accounting", userId: "appu_accounting_0001" } }),
    NOW,
  );
  assert.throws(
    () => insertReceiptDirectly(db, {
      intent_id: intent.intent_id,
      operation: "approve",
      actor_user_id: "appu_accounting_0001",
      requested_version: 1,
    }),
    /accounting_intent_separation_of_duty/,
  );
});

test("a holdback release is the owner's decision, and D1 says so too", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput({
    intentId: "acct-intent:job-0001:holdback-release",
    kind: "holdback_release",
    taxPolicySnapshotSha256: "f".repeat(64),
    basis: { roofJob: "job-0001", holdback: "release", amount: "3000.00" },
    effectIdempotencyKey: "acct:holdback-release:job-0001:v1",
    providerRequestId: "req-holdback-0001",
    subtotal: "3000.00",
    totalAmount: "3000.00",
  }), NOW);

  await assert.rejects(
    () => approve(env, intent.intent_id, 1, "appu_accounting_0001"),
    (error: AccountingIntentError) => error.code === "accounting_intent_owner_authority_required",
  );
  const approved = await approve(env, intent.intent_id, 1, "appu_owner_0001");
  assert.equal(approved.intent.state, "submission_pending");
});

test("an ops user cannot command a money intent at all", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  await assert.rejects(
    () => approve(env, intent.intent_id, 1, "appu_ops_0001"),
    (error: AccountingIntentError) => error.code === "accounting_intent_command_actor_invalid",
  );
});

test("an accepted dispatch reaches submitted, never reconciled", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);

  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);

  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.provider_entity_id, "2001");
  assert.equal(submitted.effect_id, "effect:ironwrap:1");
  assert.equal(submitted.provider_submitted_at, LATER.toISOString());
  // Nothing has been read back yet, so nothing may claim to be reconciled.
  assert.equal(submitted.observed_sha256, null);
  assert.equal(submitted.provider_reconciled_at, null);
});

test("a lost response leaves the intent uncertain rather than settled either way", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const uncertain = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome({
      state: "unknown",
      attemptState: "unknown",
      providerExternalId: null,
      readbackHash: null,
      resultCode: "effect_outcome_unknown",
    }),
  }, LATER);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.provider_entity_id, null);
  assert.equal(uncertain.error_code, "effect_outcome_unknown");
});

test("reconciled requires an observed hash equal to the expected hash", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);

  await assert.rejects(
    () => recordAccountingIntentVerdict(env, {
      tenantId: TENANT,
      intentId: submitted.intent_id,
      verdict: "reconciled",
      observedSha256: "9".repeat(64),
    }, LATER),
    (error: AccountingIntentError) => error.code === "accounting_intent_reconciled_hash_mismatch",
  );

  const reconciled = await recordAccountingIntentVerdict(env, {
    tenantId: TENANT,
    intentId: submitted.intent_id,
    verdict: "reconciled",
    observedSha256: submitted.expected_sha256,
  }, LATER);
  assert.equal(reconciled.state, "reconciled");
  assert.equal(reconciled.observed_sha256, reconciled.expected_sha256);
  assert.equal(reconciled.provider_reconciled_at, LATER.toISOString());
});

test("D1 refuses a reconciled row whose observed hash differs from the expected hash", () => {
  const { db } = testEnv();
  assert.throws(
    () => insertIntentDirectly(db, {
      state: "reconciled",
      observed_sha256: "9".repeat(64),
      provider_entity_id: "2001",
      effect_id: "effect:ironwrap:1",
      provider_reconciled_at: NOW.toISOString(),
      approved_by_user_id: "appu_accounting_0001",
      approved_at: NOW.toISOString(),
    }),
    /CHECK constraint failed/,
  );
});

test("a partial payment is a waiting state, and over-payment is not", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);

  const partial = await recordAccountingIntentVerdict(env, {
    tenantId: TENANT,
    intentId: submitted.intent_id,
    verdict: "partially_settled",
    observedSha256: "1".repeat(64),
    settledAmount: "600.00",
  }, LATER);
  assert.equal(partial.state, "partially_settled");
  assert.equal(partial.settled_amount, "600.00");

  // Section 5.4: over-payment is a mismatch, not a partial.
  const over = await recordAccountingIntentVerdict(env, {
    tenantId: TENANT,
    intentId: submitted.intent_id,
    verdict: "mismatch",
    observedSha256: "2".repeat(64),
    reasonCode: "duplicate_provider_payment",
  }, LATER);
  assert.equal(over.state, "mismatch");
  assert.equal(over.reason_code, "duplicate_provider_payment");
});

test("an unreachable provider is never a verdict of record", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);

  const unchanged = await recordAccountingIntentVerdict(env, {
    tenantId: TENANT,
    intentId: submitted.intent_id,
    verdict: "unavailable",
  }, LATER);
  assert.equal(unchanged.state, "submitted");
  assert.equal(unchanged.version, submitted.version);
});

test("a reconciled intent that drifts moves back to reconciliation_required", async () => {
  const { env } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);
  const reconciled = await recordAccountingIntentVerdict(env, {
    tenantId: TENANT,
    intentId: submitted.intent_id,
    verdict: "reconciled",
    observedSha256: submitted.expected_sha256,
  }, LATER);

  const drifted = await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: reconciled.intent_id,
    operation: "reconcile",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: "reconcile:drift:1",
    request: { reason: "provider_readback_drift" },
    requestedVersion: reconciled.version,
    reasonCode: "provider_readback_drift",
  }, LATER);
  assert.equal(drifted.intent.state, "reconciliation_required");
  assert.equal(drifted.intent.reason_code, "provider_readback_drift");
});

test("the state machine refuses an illegal jump in both layers", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);

  // pending_review -> reconciled is not a legal edge in the map...
  await assert.rejects(
    () => recordAccountingIntentVerdict(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      verdict: "reconciled",
      observedSha256: intent.expected_sha256,
    }, LATER),
    (error: AccountingIntentError) => error.code === "accounting_intent_transition_invalid",
  );

  // ...nor in D1, even for a caller that writes the row itself.
  assert.throws(
    () => db.raw.prepare(
      `UPDATE accounting_intents SET state = 'compensated', version = version + 1,
         updated_at = ? WHERE intent_id = ?`,
    ).run(LATER.toISOString(), intent.intent_id),
    /accounting_intent_transition_invalid/,
  );
});

test("the bound basis, amounts and authority are immutable after derivation", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  for (const [column, value] of [
    ["basis_sha256", "7".repeat(64)],
    ["expected_sha256", "7".repeat(64)],
    ["total_amount", "9999.00"],
    ["authority_max_amount", "999999.00"],
    ["provider_request_id", "req-payment-0002"],
    ["effect_idempotency_key", "acct:payment:job-0001:v2"],
    ["realm_id", "9999999999"],
  ] as const) {
    assert.throws(
      () => db.raw.prepare(
        `UPDATE accounting_intents SET ${column} = ?, version = version + 1, updated_at = ?
          WHERE intent_id = ?`,
      ).run(value, LATER.toISOString(), intent.intent_id),
      /accounting_intent_basis_immutable/,
      `${column} was mutable`,
    );
  }
});

test("a version that does not advance by exactly one is refused", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  assert.throws(
    () => db.raw.prepare(
      `UPDATE accounting_intents SET state = 'blocked', blocker_code = 'x',
         blocker_next_step = 'y', updated_at = ? WHERE intent_id = ?`,
    ).run(LATER.toISOString(), intent.intent_id),
    /accounting_intent_version_invalid/,
  );
});

test("provider identity and decision evidence are written once", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  const approved = await approve(env, intent.intent_id, 1);
  const submitted = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: approved.intent.intent_id,
    outcome: settledOutcome(),
  }, LATER);

  assert.throws(
    () => db.raw.prepare(
      `UPDATE accounting_intents SET provider_entity_id = '3001', version = version + 1,
         updated_at = ? WHERE intent_id = ?`,
    ).run(LATER.toISOString(), submitted.intent_id),
    /accounting_intent_provider_evidence_immutable/,
  );
  assert.throws(
    () => db.raw.prepare(
      `UPDATE accounting_intents SET approved_by_user_id = 'appu_owner_0001',
         version = version + 1, updated_at = ? WHERE intent_id = ?`,
    ).run(LATER.toISOString(), submitted.intent_id),
    /accounting_intent_decision_evidence_immutable/,
  );
});

test("events and command receipts are append-only, and money rows are never deleted", async () => {
  const { env, db } = testEnv();
  const intent = await deriveAccountingIntent(env, deriveInput(), NOW);
  await approve(env, intent.intent_id, 1);

  assert.throws(
    () => db.raw.prepare("DELETE FROM accounting_intent_events WHERE intent_id = ?")
      .run(intent.intent_id),
    /accounting_intent_events_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(
      "UPDATE accounting_intent_events SET state_to = 'reconciled' WHERE intent_id = ?",
    ).run(intent.intent_id),
    /accounting_intent_events_append_only/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM accounting_intent_command_receipts WHERE intent_id = ?")
      .run(intent.intent_id),
    /accounting_intent_command_receipts_append_only/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM accounting_intents WHERE intent_id = ?").run(intent.intent_id),
    /accounting_intents_retained/,
  );
});

test("every kind carries the provider entity type its comparison fact set names", async () => {
  const { env } = testEnv();
  const expected: Record<string, string | null> = {
    deposit_invoice: "Invoice",
    progress_invoice: "Invoice",
    payment: "Payment",
    credit_memo: "CreditMemo",
    refund: "RefundReceipt",
    holdback_release: "Invoice",
    tax_remittance_proposal: null,
    payroll_journal: "JournalEntry",
  };
  let index = 0;
  for (const kind of ACCOUNTING_INTENT_KINDS) {
    index += 1;
    const intent = await deriveAccountingIntent(env, deriveInput({
      kind,
      intentId: `acct-intent:job-0001:${kind.replace(/_/g, "-")}`,
      basis: { roofJob: "job-0001", kind },
      effectIdempotencyKey: `acct:${kind}:job-0001:v1`,
      providerRequestId: `req-${index}-0001`,
      taxPolicySnapshotSha256: "f".repeat(64),
    }), NOW);
    assert.equal(intent.provider_entity_type, expected[kind], `${kind} entity type`);
  }
});

test("a tax remittance proposal is the one kind that creates nothing at the provider", () => {
  const { db } = testEnv();
  // It may not name a provider entity type...
  assert.throws(
    () => insertIntentDirectly(db, {
      kind: "tax_remittance_proposal",
      provider_entity_type: "JournalEntry",
      tax_policy_snapshot_sha256: "f".repeat(64),
    }),
    /CHECK constraint failed/,
  );
  // ...and every other kind must.
  assert.throws(
    () => insertIntentDirectly(db, { kind: "payment", provider_entity_type: null }),
    /CHECK constraint failed/,
  );
});

test("a state past submission cannot exist without an approver", () => {
  const { db } = testEnv();
  assert.throws(
    () => insertIntentDirectly(db, {
      state: "submitted",
      provider_entity_id: "2001",
      effect_id: "effect:ironwrap:1",
      approved_by_user_id: null,
    }),
    /CHECK constraint failed/,
  );
});

test("a submitted intent cannot exist without provider identity and an effect", () => {
  const { db } = testEnv();
  assert.throws(
    () => insertIntentDirectly(db, {
      state: "submitted",
      provider_entity_id: null,
      effect_id: null,
      approved_by_user_id: "appu_accounting_0001",
      approved_at: NOW.toISOString(),
    }),
    /CHECK constraint failed/,
  );
});

/** Write a row straight to D1, bypassing the module, so the storage-layer guard is what is tested. */
function insertIntentDirectly(
  db: AccountingTestD1,
  overrides: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    intent_id: "acct-intent:job-0001:direct",
    tenant_id: TENANT,
    kind: "payment",
    roof_job_id: "job-0001",
    basis_json: "{}",
    basis_sha256: "a".repeat(64),
    source_documents_json: "[]",
    expected_sha256: "b".repeat(64),
    tax_policy_snapshot_sha256: null,
    provider: "quickbooks",
    realm_id: REALM,
    provider_entity_type: "Payment",
    provider_payload_json: "{}",
    provider_payload_sha256: "c".repeat(64),
    provider_request_id: "req-direct-0001",
    currency: "CAD",
    subtotal: "1200.00",
    tax_amount: "0.00",
    total_amount: "1200.00",
    settled_amount: null,
    authority_permit_ref: "permit:accounting:payment",
    authority_policy_ref: "policy:accounting:payment.create",
    authority_policy_version: "v1",
    authority_max_amount: "5000.00",
    effect_id: null,
    effect_idempotency_key: "acct:payment:job-0001:direct",
    compensates_effect_id: null,
    final_invoice_intent_id: null,
    compensates_intent_id: null,
    state: "pending_review",
    version: 1,
    blocker_code: null,
    blocker_next_step: null,
    reason_code: null,
    error_code: null,
    derived_by_actor_kind: "agent",
    derived_by_user_id: null,
    derived_at: NOW.toISOString(),
    approved_by_user_id: null,
    approved_at: null,
    approval_idempotency_sha256: null,
    approval_fingerprint_sha256: null,
    rejected_by_user_id: null,
    rejected_at: null,
    rejection_idempotency_sha256: null,
    rejection_fingerprint_sha256: null,
    provider_entity_id: null,
    observed_sha256: null,
    provider_submitted_at: null,
    provider_reconciled_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO accounting_intents (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column] as null));
}

function insertReceiptDirectly(
  db: AccountingTestD1,
  overrides: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    receipt_id: "11111111-2222-4333-8444-555555555555",
    tenant_id: TENANT,
    intent_id: "acct-intent:job-0001:payment",
    operation: "approve",
    idempotency_key_sha256: "a".repeat(64),
    request_fingerprint_sha256: "b".repeat(64),
    requested_version: 1,
    actor_user_id: "appu_accounting_0001",
    reason_code: null,
    created_at: NOW.toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO accounting_intent_command_receipts (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column] as null));
}

test("the state and kind vocabularies match the migration exactly", () => {
  for (const state of ACCOUNTING_INTENT_STATES) {
    assert.ok(MIGRATION.includes(`'${state}'`), `${state} missing from the migration`);
  }
  for (const kind of ACCOUNTING_INTENT_KINDS) {
    assert.ok(MIGRATION.includes(`'${kind}'`), `${kind} missing from the migration`);
  }
  const declared = MIGRATION.slice(MIGRATION.indexOf("state TEXT NOT NULL CHECK (state IN ("));
  const states = [...declared.slice(0, declared.indexOf("))")).matchAll(/'(\w+)'/g)]
    .map((match) => match[1] as AccountingIntentState);
  assert.deepEqual(states.sort(), [...ACCOUNTING_INTENT_STATES].sort());
});
