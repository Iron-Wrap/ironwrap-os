// Slice S3. The reconciliation engine.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5. One executable test per failure case the
// contract lists for reconciliation (section 9's scenario matrix), each asserting the final intent
// state, the verdict, the exception raised or not raised, and that no row was deleted.
//
// The harness runs the real 0058-0061 SQL in `node:sqlite`, so every CHECK, trigger and unique
// index executes. Provider responses are the synthetic Intuit-shaped fixtures; nothing here opens
// a socket.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOW,
  REALM,
  TENANT,
  quickBooksEntity,
  testEnv,
} from "./accounting-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import type { MoneyEffectOutcome } from "../src/accounting-effect-port.ts";
import {
  AccountingIntentError,
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  type AccountingIntentKind,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import {
  normalizeProviderEntity,
  observedSha256,
  providerFactEnvelope,
  type AccountingEntityType,
} from "../src/accounting-normalizers.ts";
import {
  recordTaxPolicySnapshot,
  bindAccountingIntentTaxSnapshots,
  taxBindingSetSha256,
} from "../src/accounting-tax-snapshots.ts";
import {
  assertCompensationAllowed,
  invoiceSettlement,
  listAccountingObservations,
  listAccountingReconciliations,
  readCurrentObservation,
  recordAccountingObservation,
  reconcileAccountingIntent,
  resolveUncertainAccountingIntent,
} from "../src/accounting-reconciliation.ts";
import {
  acknowledgeAccountingException,
  listAccountingExceptions,
  readLiveAccountingException,
  resolveAccountingException,
  AccountingExceptionError,
} from "../src/accounting-exceptions.ts";
import type { ProviderReadResult } from "../src/accounting-provider-read.ts";

const T1 = "2026-08-19T12:00:00.000Z";
const T2 = "2026-08-19T12:05:00.000Z";
const T3 = "2026-08-19T12:10:00.000Z";
const LATER = new Date(T2);
const LATEST = new Date(T3);

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

/** An intent bound to the fixture's own fact set, so `expected_sha256` is reachable by a readback. */
async function deriveIntent(
  env: AppEnv,
  options: {
    intentId?: string;
    kind?: AccountingIntentKind;
    entityType?: AccountingEntityType;
    entityFile?: string;
    total?: string;
    facts?: Record<string, unknown>;
  } = {},
): Promise<AccountingIntentRecord> {
  const kind = options.kind ?? "deposit_invoice";
  const entityType = options.entityType ?? "Invoice";
  const intentId = options.intentId ?? `acct-intent:job-0001:${kind}`;
  const facts = options.facts ?? normalizeProviderEntity({
    realmId: REALM,
    entityType,
    payload: quickBooksEntity(options.entityFile ?? "invoice-open.json", entityType),
  }).facts;

  const taxBearing = ["deposit_invoice", "progress_invoice", "credit_memo", "holdback_release",
    "tax_remittance_proposal"].includes(kind);
  let taxPolicySnapshotSha256: string | null = null;
  if (taxBearing) {
    const snapshot = await recordTaxPolicySnapshot(env, {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "3",
      ratePercent: "5.0000",
      effectiveFrom: "2008-01-01",
      sourceRef: "CRA GST bulletin 2008-01-01",
    }, NOW);
    taxPolicySnapshotSha256 = await taxBindingSetSha256([snapshot.snapshot_sha256]);
  }

  const intent = await deriveAccountingIntent(env, {
    tenantId: TENANT,
    intentId,
    kind,
    roofJobId: "job-0001",
    basis: { roofJob: "job-0001", intentId },
    sourceDocuments: [{ id: "quote-0001", version: 3 }],
    expected: providerFactEnvelope({ realmId: REALM, entityType, facts }),
    taxPolicySnapshotSha256,
    realmId: REALM,
    providerPayload: { TotalAmt: options.total ?? "1260.00" },
    providerRequestId: `req-${intentId}`,
    subtotal: "1200.00",
    taxAmount: "60.00",
    totalAmount: options.total ?? "1260.00",
    authority: {
      permitRef: "permit:accounting:money",
      policyRef: "policy:accounting:money.create",
      policyVersion: "v1",
      maxAmount: "5000.00",
    },
    effectIdempotencyKey: `acct:${intentId}:v1`,
    derivedBy: { actorKind: "agent" },
  }, NOW);

  if (taxBearing) {
    const snapshot = await recordTaxPolicySnapshot(env, {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "3",
      ratePercent: "5.0000",
      effectiveFrom: "2008-01-01",
      sourceRef: "CRA GST bulletin 2008-01-01",
    }, NOW);
    await bindAccountingIntentTaxSnapshots(env, {
      tenantId: TENANT, intentId, snapshots: [snapshot],
    }, NOW);
  }
  return intent;
}

/** Approve and settle, so the intent carries the provider identity a readback compares against. */
async function submit(
  env: AppEnv,
  intent: AccountingIntentRecord,
  outcome: Partial<MoneyEffectOutcome<unknown>> = {},
): Promise<AccountingIntentRecord> {
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${intent.intent_id}`,
    request: { version: intent.version },
    requestedVersion: intent.version,
  }, NOW);
  return await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    outcome: settledOutcome(outcome),
  }, LATER);
}

function okRead(
  entityFile: string,
  entityType: AccountingEntityType,
  options: {
    readAt?: string;
    payload?: unknown;
    realmId?: string;
    duplicateEntityIds?: readonly string[];
  } = {},
): ProviderReadResult {
  const realmId = options.realmId ?? REALM;
  const payload = options.payload ?? quickBooksEntity(entityFile, entityType);
  const normalized = normalizeProviderEntity({ realmId, entityType, payload });
  return {
    status: "ok",
    realmId,
    entityType,
    entityId: normalized.entityId,
    payload,
    normalized,
    readAt: options.readAt ?? T2,
    source: "dispatch_readback",
    effectAttemptId: "effect:ironwrap:1:attempt:1",
    duplicateEntityIds: options.duplicateEntityIds,
  };
}

/** Record a payment observation the way an S4 dispatch readback or a sweep would. */
async function observePayment(
  env: AppEnv,
  entityFile: string,
  readAt: string,
  now: Date,
): Promise<void> {
  const payload = quickBooksEntity(entityFile, "Payment");
  await recordAccountingObservation(env, {
    tenantId: TENANT,
    realmId: REALM,
    entityType: "Payment",
    normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Payment", payload }),
    payload,
    readAt,
    source: "sweep",
  }, now);
}

test("expected and observed hashes agree end to end, so a clean readback reconciles", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  const normalized = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload: quickBooksEntity("invoice-paid.json", "Invoice"),
  });
  assert.equal(intent.expected_sha256, await observedSha256(normalized));

  await observePayment(env, "payment-full-1260.json", T2, LATER);
  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(outcome.verdict, "reconciled");
  assert.equal(outcome.reasonCode, null);
  assert.equal(outcome.exception, null);
  assert.equal(outcome.intent.state, "reconciled");
  assert.equal(outcome.intent.observed_sha256, intent.expected_sha256);
  assert.ok(outcome.intent.provider_reconciled_at);
});

test("partial payment is `partially_settled` with no exception, and the cumulative invariant holds", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-partial-500.json", T2, LATER);

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-partially-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(outcome.verdict, "partially_settled");
  assert.equal(outcome.settledAmount, "500.00");
  assert.equal(outcome.exception, null);
  assert.equal(outcome.intent.state, "partially_settled");
  assert.equal(outcome.intent.settled_amount, "500.00");
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
});

test("full settlement after a partial reaches `reconciled` only when the balance is zero", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));

  await observePayment(env, "payment-partial-500.json", T2, LATER);
  const partial = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-partially-paid.json", "Invoice", { readAt: T2 }),
  }, LATER);
  assert.equal(partial.verdict, "partially_settled");

  await observePayment(env, "payment-remainder-760.json", T3, LATEST);
  const settled = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(settled.verdict, "reconciled");
  assert.equal(settled.settledAmount, "1260.00");
  assert.equal(settled.intent.state, "reconciled");
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
});

test("over-payment is a mismatch, not a partial", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-overpaid-1500.json", T2, LATER);

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(outcome.verdict, "mismatch");
  assert.equal(outcome.reasonCode, "provider_overpayment");
  assert.equal(outcome.exception?.reason_code, "provider_overpayment");
  assert.equal(outcome.intent.state, "mismatch");
  assert.equal(outcome.settledAmount, "1500.00");
});

test("two payments against one invoice are `duplicate_provider_payment` with exactly two remedies", async () => {
  const { env, db } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);
  await observePayment(env, "payment-duplicate-1260.json", T2, LATER);

  const settlement = await invoiceSettlement(env, {
    tenantId: TENANT, realmId: REALM, invoiceEntityId: "2001",
  });
  assert.equal(settlement.paymentCount, 2);
  assert.equal(settlement.linkedCents, 252000);

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(outcome.verdict, "mismatch");
  assert.equal(outcome.reasonCode, "duplicate_provider_payment");
  assert.equal(outcome.intent.state, "mismatch");

  const detail = JSON.parse(outcome.exception!.detail_json) as {
    remedies: Array<{ action: string; alternatives: string[] }>;
    paymentEntityIds: string[];
  };
  // Section 5.4 offers the accountant exactly two provider-supported remedies: void the surplus
  // payment, or issue a credit memo / refund receipt for it.
  assert.equal(detail.remedies.length, 2);
  assert.deepEqual(detail.remedies.map((remedy) => remedy.action),
    ["void_provider_entity", "credit_memo_issued"]);
  assert.deepEqual(detail.remedies[1]!.alternatives, ["refund_issued"]);
  assert.deepEqual(detail.paymentEntityIds, ["3003", "3004"]);

  // Nothing was deleted anywhere: the surplus payment is still on record.
  assert.equal(
    (db.raw.prepare(`SELECT COUNT(*) AS n FROM accounting_observations`).get() as { n: number }).n,
    3,
  );
});

test("a duplicate provider entity observed at readback is an exception, never an auto-delete", async () => {
  const { env, db } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", {
      readAt: T3,
      duplicateEntityIds: ["2002"],
    }),
  }, LATEST);

  assert.equal(outcome.verdict, "mismatch");
  assert.equal(outcome.reasonCode, "duplicate_provider_entity");
  const detail = JSON.parse(outcome.exception!.detail_json) as {
    keptEntityId: string;
    duplicateEntityIds: string[];
  };
  assert.equal(detail.keptEntityId, "2001");
  assert.deepEqual(detail.duplicateEntityIds, ["2002"]);
  assert.equal(outcome.intent.state, "mismatch");

  // The intent row itself can never be removed, whatever the remedy turns out to be.
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_intents WHERE intent_id = ?`).run(intent.intent_id),
    /accounting_intents_retained/,
  );
});

test("an entity id that is not the one we created is `identity_conflict`, and it blocks compensation", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  const foreign = {
    ...(quickBooksEntity("invoice-paid.json", "Invoice") as Record<string, unknown>),
    Id: "2099",
  };

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3, payload: foreign }),
  }, LATEST);

  assert.equal(outcome.verdict, "identity_conflict");
  assert.equal(outcome.reasonCode, "provider_identity_conflict");
  assert.equal(outcome.intent.state, "mismatch");
  const detail = JSON.parse(outcome.exception!.detail_json) as {
    expected: { entityId: string };
    observed: { entityId: string };
  };
  assert.equal(detail.expected.entityId, "2001");
  assert.equal(detail.observed.entityId, "2099");

  // Compensating the wrong entity is worse than the conflict, so both layers refuse it.
  await assert.rejects(
    assertCompensationAllowed(env, TENANT, intent.intent_id),
    (error: unknown) =>
      error instanceof AccountingIntentError
      && error.code === "accounting_intent_compensation_blocked",
  );
  await assert.rejects(
    applyAccountingIntentCommand(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      operation: "compensate",
      actorUserId: "appu_owner_0001",
      idempotencyKey: `compensate:${intent.intent_id}`,
      request: { reason: "reverse" },
      requestedVersion: outcome.intent.version,
    }, LATEST),
    (error: unknown) =>
      error instanceof AccountingIntentError
      && error.code === "accounting_intent_compensation_blocked",
  );

  // Once the accountant resolves the conflict, compensation is available again.
  await resolveAccountingException(env, {
    tenantId: TENANT,
    exceptionId: outcome.exception!.exception_id,
    actorUserId: "appu_owner_0001",
    resolutionAction: "accepted_as_posted",
  }, LATEST);
  await assertCompensationAllowed(env, TENANT, intent.intent_id);
  const compensating = await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "compensate",
    actorUserId: "appu_owner_0001",
    idempotencyKey: `compensate:${intent.intent_id}`,
    request: { reason: "reverse" },
    requestedVersion: outcome.intent.version,
  }, LATEST);
  assert.equal(compensating.intent.state, "compensating");
});

test("an authenticated read that 404s is `not_found` and routes to the accountant", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: {
      status: "not_found",
      realmId: REALM,
      entityType: "Invoice",
      entityId: "2001",
      readAt: T3,
      source: "sweep",
      detailCode: "provider_entity_absent",
    },
  }, LATEST);

  assert.equal(outcome.verdict, "not_found");
  assert.equal(outcome.observationId, null, "a missing entity produces no observation");
  assert.equal(outcome.exception?.reason_code, "provider_entity_not_found");
  assert.equal(outcome.intent.state, "reconciliation_required");

  const [reconciliation] = await listAccountingReconciliations(env, TENANT, intent.intent_id);
  assert.equal(reconciliation?.verdict, "not_found");
  assert.equal(reconciliation?.observation_id, null);
});

test("an unavailable provider changes nothing at all", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: { status: "unavailable", detailCode: "provider_throttled" },
  }, LATEST);

  assert.equal(outcome.verdict, "unavailable");
  assert.equal(outcome.reasonCode, "provider_throttled");
  // Section 5.3: never a verdict of record. No observation, no reconciliation, no exception, and
  // the intent has not moved - not even its version.
  assert.equal((await listAccountingObservations(env, TENANT)).length, 0);
  assert.equal((await listAccountingReconciliations(env, TENANT, intent.intent_id)).length, 0);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
  const stored = await readAccountingIntent(env, TENANT, intent.intent_id);
  assert.equal(stored?.state, "submitted");
  assert.equal(stored?.version, intent.version);
});

test("a previously reconciled entity that changed is drift: the new observation supersedes", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);
  const first = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T2 }),
  }, LATER);
  assert.equal(first.verdict, "reconciled");

  // Somebody edited the posted transaction in QuickBooks.
  const edited = {
    ...(quickBooksEntity("invoice-paid.json", "Invoice") as Record<string, unknown>),
    TotalAmt: 1261.00,
  };
  const drift = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3, payload: edited }),
  }, LATEST);

  assert.equal(drift.verdict, "mismatch");
  assert.equal(drift.reasonCode, "provider_readback_drift");
  assert.equal(drift.exception?.reason_code, "provider_readback_drift");
  assert.equal(drift.intent.state, "reconciliation_required");

  // Both observations survive; the newer one is current. Nothing was overwritten.
  const observations = await listAccountingObservations(env, TENANT, { entityId: "2001" });
  assert.equal(observations.length, 2);
  const current = await readCurrentObservation(env, {
    tenantId: TENANT, realmId: REALM, entityType: "Invoice", entityId: "2001",
  });
  assert.equal(current?.observation_id, drift.observationId);
  assert.equal(current?.read_at, T3);
});

test("reconciling the same observation twice is idempotent", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);
  const read = okRead("invoice-paid.json", "Invoice", { readAt: T3 });

  const first = await reconcileAccountingIntent(env, {
    tenantId: TENANT, intentId: intent.intent_id, read,
  }, LATEST);
  const second = await reconcileAccountingIntent(env, {
    tenantId: TENANT, intentId: intent.intent_id, read,
  }, LATEST);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.verdict, first.verdict);
  assert.equal((await listAccountingReconciliations(env, TENANT, intent.intent_id)).length, 1);
  assert.equal((await listAccountingObservations(env, TENANT, { entityId: "2001" })).length, 1);
  // A five-minute sweep must not walk the intent's version forward forever.
  assert.equal(second.intent.version, first.intent.version);
});

test("a settlement that does not add up is a mismatch even when the document hash agrees", async () => {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  // Nothing observed as paid, but the provider reports the invoice as fully settled.
  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);

  assert.equal(outcome.verdict, "mismatch");
  assert.equal(outcome.reasonCode, "settlement_invariant_violated");
  assert.equal(outcome.exception?.reason_code, "settlement_invariant_violated");
  assert.equal(outcome.intent.state, "mismatch");
});

test("a non-invoice intent is settled by hash equality alone", async () => {
  const { env } = testEnv();
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Payment",
    payload: quickBooksEntity("payment-full-1260.json", "Payment"),
  }).facts;
  const intent = await submit(
    env,
    await deriveIntent(env, {
      kind: "payment",
      entityType: "Payment",
      entityFile: "payment-full-1260.json",
      facts,
    }),
    { providerExternalId: "3003" },
  );

  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("payment-full-1260.json", "Payment", { readAt: T3 }),
  }, LATEST);
  assert.equal(outcome.verdict, "reconciled");
  assert.equal(outcome.intent.state, "reconciled");

  const changed = {
    ...(quickBooksEntity("payment-full-1260.json", "Payment") as Record<string, unknown>),
    TotalAmt: 1000.00,
  };
  const mismatch = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("payment-full-1260.json", "Payment", { readAt: "2026-08-19T12:20:00.000Z", payload: changed }),
  }, LATEST);
  assert.equal(mismatch.verdict, "mismatch");
  assert.equal(mismatch.reasonCode, "provider_readback_drift");
});

test("observing a refund before or after a payment gives the same verdict (refund settlement is S6)", async () => {
  // Named for exactly what it proves, per the PR #73 review nit. A `RefundReceipt` is *recorded*
  // here but is not yet an input to the cumulative settlement invariant: `invoiceSettlement`
  // filters `entity_type = 'Payment'` (accounting-reconciliation.ts), because "refund after
  // holdback release" is contract section 5.4's S6 target, not shipped in S3. So this asserts
  // order-independence over an observation the verdict engine currently ignores - which is the
  // real property of this slice, and is worth holding: when S6 wires refunds into settlement the
  // test has to be extended to a genuine refund-vs-payment race, and it will fail loudly if that
  // extension is skipped, because the settled amount will move.
  const refundThenPayment = await raceOutcome(["refund", "payment"]);
  const paymentThenRefund = await raceOutcome(["payment", "refund"]);

  // The cumulative invariant is evaluated over the recorded facts, not over arrival order, so the
  // two interleavings cannot disagree.
  assert.deepEqual(refundThenPayment, paymentThenRefund);
  assert.equal(refundThenPayment.verdict, "reconciled");
  assert.equal(refundThenPayment.settledAmount, "1260.00");
  assert.equal(refundThenPayment.exceptionCount, 0);
});

async function raceOutcome(order: ReadonlyArray<"refund" | "payment">) {
  const { env } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  for (const step of order) {
    if (step === "payment") {
      await observePayment(env, "payment-full-1260.json", T2, LATER);
      continue;
    }
    const payload = quickBooksEntity("refund-receipt.json", "RefundReceipt");
    await recordAccountingObservation(env, {
      tenantId: TENANT,
      realmId: REALM,
      entityType: "RefundReceipt",
      normalized: normalizeProviderEntity({
        realmId: REALM, entityType: "RefundReceipt", payload,
      }),
      payload,
      readAt: T2,
      source: "sweep",
    }, LATER);
  }
  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);
  return {
    verdict: outcome.verdict,
    reasonCode: outcome.reasonCode,
    settledAmount: outcome.settledAmount,
    state: outcome.intent.state,
    exceptionCount: (await listAccountingExceptions(env, TENANT)).length,
  };
}

test("a lost response is resolved by finding the entity, never by retrying", async () => {
  const { env } = testEnv();
  const derived = await deriveIntent(env);
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${derived.intent_id}`,
    request: { version: derived.version },
    requestedVersion: derived.version,
  }, NOW);
  const uncertain = await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    outcome: settledOutcome({ state: "unknown", providerExternalId: null, attemptState: "unknown" }),
  }, LATER);
  assert.equal(uncertain.state, "uncertain");

  // Before the deadline, an absent entity is not yet anybody's decision.
  const waiting = await resolveUncertainAccountingIntent(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    lookup: { status: "absent" },
    deadlineAt: "2026-08-19T13:00:00.000Z",
  }, LATER);
  assert.equal(waiting.resolution, "waiting");
  assert.equal(waiting.intent.state, "uncertain");
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);

  // The recovery query finds it: uncertain -> submitted -> reconciled.
  const found = await resolveUncertainAccountingIntent(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    lookup: { status: "found", outcome: settledOutcome() },
    deadlineAt: "2026-08-19T13:00:00.000Z",
  }, LATEST);
  assert.equal(found.resolution, "submitted");
  assert.equal(found.intent.state, "submitted");
  assert.equal(found.intent.provider_entity_id, "2001");

  await observePayment(env, "payment-full-1260.json", T3, LATEST);
  const reconciled = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: "2026-08-19T12:15:00.000Z" }),
  }, LATEST);
  assert.equal(reconciled.verdict, "reconciled");
});

test("a lost response whose entity never appears becomes the accountant's decision at the deadline", async () => {
  const { env } = testEnv();
  const derived = await deriveIntent(env);
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    operation: "approve",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `approve:${derived.intent_id}`,
    request: { version: derived.version },
    requestedVersion: derived.version,
  }, NOW);
  await recordAccountingIntentSubmission(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    outcome: settledOutcome({ state: "unknown", providerExternalId: null, attemptState: "unknown" }),
  }, LATER);

  const expired = await resolveUncertainAccountingIntent(env, {
    tenantId: TENANT,
    intentId: derived.intent_id,
    lookup: { status: "absent" },
    deadlineAt: "2026-08-19T12:00:00.000Z",
  }, LATEST);

  assert.equal(expired.resolution, "manual_exception");
  assert.equal(expired.intent.state, "reconciliation_required");
  assert.equal(expired.exception?.reason_code, "unknown_effect_deadline_expired");
  const detail = JSON.parse(expired.exception!.detail_json) as { effectIdempotencyKey: string };
  assert.equal(detail.effectIdempotencyKey, derived.effect_idempotency_key);
});

test("observations and verdicts are append-only, and no money row can be deleted", async () => {
  const { env, db } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);
  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);
  assert.equal(outcome.verdict, "reconciled");

  assert.throws(
    () => db.raw.prepare(`UPDATE accounting_observations SET observed_sha256 = ? WHERE observation_id = ?`)
      .run("a".repeat(64), outcome.observationId),
    /accounting_observation_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_observations WHERE observation_id = ?`)
      .run(outcome.observationId),
    /accounting_observation_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_observation_links`).run(),
    /accounting_observation_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(`UPDATE accounting_reconciliations SET verdict = 'mismatch'`).run(),
    /accounting_reconciliation_append_only/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_reconciliations`).run(),
    /accounting_reconciliation_append_only/,
  );
});

test("D1 refuses a `reconciled` verdict whose hashes do not match", async () => {
  const { env, db } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  assert.throws(
    () => db.raw.prepare(
      `INSERT INTO accounting_reconciliations (
         reconciliation_id, tenant_id, intent_id, observation_id, expected_sha256, observed_sha256,
         verdict, reason_code, settled_amount, decided_at
       ) VALUES (?, ?, ?, NULL, ?, ?, 'reconciled', NULL, NULL, ?)`,
    ).run(
      "22222222-3333-4444-5555-666666666666", TENANT, intent.intent_id,
      intent.expected_sha256, "e".repeat(64), T3,
    ),
    /CHECK constraint failed/,
  );
});

test("an exception moves open to acknowledged to resolved, once, and a reversal must name its effect", async () => {
  const { env, db } = testEnv();
  const intent = await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-full-1260.json", T2, LATER);
  await observePayment(env, "payment-duplicate-1260.json", T2, LATER);
  const outcome = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
  }, LATEST);
  const exceptionId = outcome.exception!.exception_id;

  const acknowledged = await acknowledgeAccountingException(env, {
    tenantId: TENANT, exceptionId, actorUserId: "appu_accounting_0001",
  }, LATEST);
  assert.equal(acknowledged.status, "acknowledged");

  // Re-raising the same finding on the next sweep must not create a second row or reopen this one.
  const resweep = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: okRead("invoice-paid.json", "Invoice", { readAt: "2026-08-19T12:30:00.000Z" }),
  }, LATEST);
  assert.equal(resweep.exception?.exception_id, exceptionId);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 1);
  assert.equal(
    (await readLiveAccountingException(env, TENANT, `accounting_intent:${intent.intent_id}`,
      "duplicate_provider_payment"))?.status,
    "acknowledged",
  );

  // A remedy that reverses money at the provider has to point at the compensating effect.
  await assert.rejects(
    resolveAccountingException(env, {
      tenantId: TENANT, exceptionId, actorUserId: "appu_owner_0001",
      resolutionAction: "void_provider_entity",
    }, LATEST),
    (error: unknown) =>
      error instanceof AccountingExceptionError
      && error.code === "accounting_exception_compensating_effect_required",
  );

  // ...and naming one is not the same as having done it. `void_provider_entity` has no dispatch
  // path in any shipped slice, so there is no ledger evidence it could ever produce: it refuses by
  // name rather than accepting a typed-in reference, which is what let ELEC-71 close a real $240
  // exception for money nothing had reversed.
  await assert.rejects(
    resolveAccountingException(env, {
      tenantId: TENANT, exceptionId, actorUserId: "appu_owner_0001",
      resolutionAction: "void_provider_entity",
      compensatingEffectId: "effect:ironwrap:2",
    }, LATEST),
    (error: unknown) =>
      error instanceof AccountingExceptionError
      && error.code === "accounting_exception_remedy_dispatch_unavailable",
  );

  // A remedy that moves no money at the provider needs no effect, and still closes the queue entry.
  const resolved = await resolveAccountingException(env, {
    tenantId: TENANT, exceptionId, actorUserId: "appu_owner_0001",
    resolutionAction: "accepted_as_posted",
  }, LATEST);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.compensating_effect_id, null);

  // Resolved is terminal, and the queue is never emptied by deletion.
  assert.throws(
    () => db.raw.prepare(`UPDATE accounting_exceptions SET status = 'open' WHERE exception_id = ?`)
      .run(exceptionId),
    /accounting_exception_transition_invalid/,
  );
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_exceptions WHERE exception_id = ?`).run(exceptionId),
    /accounting_exception_retained/,
  );
  assert.throws(
    () => db.raw.prepare(`UPDATE accounting_exceptions SET subject_ref = 'x' WHERE exception_id = ?`)
      .run(exceptionId),
    /accounting_exception_binding_immutable/,
  );
});

test("reconciling an intent that never reached the provider is refused", async () => {
  const { env } = testEnv();
  const derived = await deriveIntent(env);
  await assert.rejects(
    reconcileAccountingIntent(env, {
      tenantId: TENANT,
      intentId: derived.intent_id,
      read: okRead("invoice-paid.json", "Invoice", { readAt: T3 }),
    }, LATEST),
    (error: unknown) =>
      error instanceof AccountingIntentError
      && error.code === "accounting_intent_provider_identity_missing",
  );
});

test("a superseded payment observation is not counted twice", async () => {
  const { env } = testEnv();
  await submit(env, await deriveIntent(env));
  await observePayment(env, "payment-partial-500.json", T2, LATER);
  // The same payment, re-read later with identical facts: a new observation row, one settlement.
  await observePayment(env, "payment-partial-500.json", T3, LATEST);

  const settlement = await invoiceSettlement(env, {
    tenantId: TENANT, realmId: REALM, invoiceEntityId: "2001",
  });
  assert.equal(settlement.paymentCount, 1);
  assert.equal(settlement.linkedCents, 50000);
  assert.equal((await listAccountingObservations(env, TENANT, { entityId: "3001" })).length, 2);
});
