// Slice S5. Credit memo and refund intents: the first reversal path.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.4 and 6, and the "rejected alternatives"
// entry that governs this whole slice: **auto-compensating a duplicate payment or an over-release
// is rejected**. So every test here goes through propose -> authorize -> reverse, and the reversal
// is always a provider entity linked to what it reverses - never a deletion, and never a local
// adjustment.
//
// The scenario amounts are real: an over-payment of 1500.00 against a 1260.00 invoice leaves a
// surplus of exactly 240.00, and that is what the reversal fixtures carry.

import assert from "node:assert/strict";
import { test } from "node:test";

import { NOW, REALM, TENANT, fakeIntuit, quickBooksEntity, testEnv } from "./accounting-fixture.ts";
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import {
  AT_LATER,
  AT_READ,
  AT_SUBMIT,
  AUTHORITY_EXPIRES,
  DEADLINE,
  DISPATCH_ACTOR,
  OWNER,
  approveIntent,
  compensateCommand,
  deriveScenarioIntent,
  entityRoute,
  scenarioAuth,
  scenarioExecutor,
} from "./accounting-scenario-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import {
  AccountingIntentError,
  readAccountingIntent,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import { submitAccountingIntent } from "../src/accounting-submission.ts";
import { ingestObservedPayment } from "../src/accounting-payments.ts";
import {
  COMPENSABLE_REASON_CODES,
  deriveCompensationIntent,
  liveCompensableException,
  offeredRemedies,
  planAccountingCompensation,
  submitAccountingCompensation,
  type CompensationPlan,
} from "../src/accounting-compensation.ts";
import {
  invoiceSettlement,
  listAccountingObservations,
  reconcileAccountingIntent,
} from "../src/accounting-reconciliation.ts";
import {
  listAccountingExceptions,
  readLiveAccountingException,
} from "../src/accounting-exceptions.ts";
import {
  normalizeProviderEntity,
  providerFactEnvelope,
  type AccountingEntityType,
} from "../src/accounting-normalizers.ts";
import { readProviderEntity } from "../src/accounting-provider-read.ts";
import {
  bindAccountingIntentTaxSnapshots,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
} from "../src/accounting-tax-snapshots.ts";

const PORT_INPUT = {
  actor: DISPATCH_ACTOR,
  taskId: "task:accounting:submit",
  correlationId: "corr:accounting:0001",
  deadlineAt: DEADLINE,
  authorityExpiresAt: AUTHORITY_EXPIRES,
  taxPreflightOnDate: "2026-08-19",
};

/** Post a 1260.00 deposit invoice and over-pay it by 240.00, leaving a live exception. */
async function overpaidInvoice(env: AppEnv): Promise<AccountingIntentRecord> {
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);
  await submitAccountingIntent(env, {
    ...PORT_INPUT,
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "2001", observed: expected }),
    expectedReadback: expected,
  }, AT_SUBMIT);

  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const ingest = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);
  assert.equal(ingest.settlements[0]!.reconciliation!.reasonCode, "provider_overpayment");
  return ingest.settlements[0]!.reconciliation!.intent;
}

/** Derive the reversing intent a plan describes, bound to its own provider fixture. */
async function deriveReversal(
  env: AppEnv,
  plan: CompensationPlan,
  options: { entityFile: string; subtotal: string; taxAmount: string; effectId?: string | null },
): Promise<{ intent: AccountingIntentRecord; expected: unknown }> {
  const entityType = plan.providerEntityType as AccountingEntityType;
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType,
    payload: quickBooksEntity(options.entityFile, entityType),
  }).facts;
  const expected = providerFactEnvelope({ realmId: REALM, entityType, facts });

  let taxPolicySnapshotSha256: string | null = null;
  let snapshot = null;
  if (plan.reversalKind === "credit_memo") {
    snapshot = await recordTaxPolicySnapshot(env, {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "3",
      ratePercent: "5.0000",
      effectiveFrom: "2008-01-01",
      sourceRef: "CRA GST bulletin 2008-01-01",
    }, AT_LATER);
    taxPolicySnapshotSha256 = await taxBindingSetSha256([snapshot.snapshot_sha256]);
  }

  const reversalIntentId = `acct-intent:job-0001:${plan.reversalKind}`;
  const intent = await deriveCompensationIntent(env, {
    tenantId: TENANT,
    plan,
    reversalIntentId,
    roofJobId: "job-0001",
    basis: { reverses: plan.intentId, exception: plan.exceptionId, amount: plan.totalAmount },
    sourceDocuments: [{ id: plan.exceptionId, version: 1 }],
    expected,
    realmId: REALM,
    providerPayload: { TotalAmt: plan.magnitudeAmount },
    providerRequestId: `req-${reversalIntentId}`,
    subtotal: options.subtotal,
    taxAmount: options.taxAmount,
    taxPolicySnapshotSha256,
    authority: {
      permitRef: "permit:accounting:money",
      policyRef: "policy:accounting:money.reverse",
      policyVersion: "v1",
      maxAmount: "5000.00",
    },
    effectIdempotencyKey: `acct:${reversalIntentId}:v1`,
    derivedBy: { actorKind: "agent" },
    compensatesEffectId: options.effectId ?? null,
  }, AT_LATER);

  if (snapshot) {
    await bindAccountingIntentTaxSnapshots(env, {
      tenantId: TENANT, intentId: reversalIntentId, snapshots: [snapshot],
    }, AT_LATER);
  }
  return { intent, expected };
}

test("a plan proposes exactly the surplus, and names the exception it answers", async () => {
  const { env } = testEnv();
  const intent = await overpaidInvoice(env);

  const plan = await planAccountingCompensation(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    remedy: "credit_memo_issued",
  });

  assert.equal(plan.reasonCode, "provider_overpayment");
  assert.equal(plan.reversalKind, "credit_memo");
  assert.equal(plan.providerEntityType, "CreditMemo");
  // 1500.00 observed against a 1260.00 invoice. The reversal is the surplus, not the whole invoice.
  assert.equal(plan.basis.originalTotal, "1260.00");
  assert.equal(plan.basis.observedSettled, "1500.00");
  assert.equal(plan.basis.surplus, "240.00");
  assert.equal(plan.totalAmount, "-240.00");
  assert.equal(plan.magnitudeAmount, "240.00");

  // Proposing writes nothing: no intent moved, no exception changed.
  assert.equal((await readAccountingIntent(env, TENANT, intent.intent_id))!.version,
    intent.version);
  assert.equal((await listAccountingExceptions(env, TENANT, { status: "open" })).length, 1);
});

test("a remedy the exception never offered, and one that is not a reversal, are both refused", async () => {
  const { env } = testEnv();
  const intent = await overpaidInvoice(env);
  const exception = (await liveCompensableException(env, TENANT, intent.intent_id))!;

  // What the engine actually offered for an over-payment (section 5.4's exactly-two rule).
  assert.deepEqual(offeredRemedies(exception),
    ["void_provider_entity", "credit_memo_issued", "refund_issued"]);

  await assert.rejects(
    () => planAccountingCompensation(env, {
      tenantId: TENANT, intentId: intent.intent_id, remedy: "adjusting_entry_posted",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_compensation_remedy_not_offered",
  );

  // Offered, but it is not a reversing intent: voiding is resolved on the exception directly.
  await assert.rejects(
    () => planAccountingCompensation(env, {
      tenantId: TENANT, intentId: intent.intent_id, remedy: "void_provider_entity",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_compensation_remedy_not_reversal",
  );
});

test("a reversal larger than what was posted is refused on magnitude, not on sign", async () => {
  const { env } = testEnv();
  const intent = await overpaidInvoice(env);

  await assert.rejects(
    () => planAccountingCompensation(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      remedy: "refund_issued",
      amount: "2000.00",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_compensation_amount_exceeds_original",
  );

  // The same amount written as a negative is the same reversal and is refused identically. A
  // signed comparison would accept it, because -200000 is below every ceiling there is.
  await assert.rejects(
    () => planAccountingCompensation(env, {
      tenantId: TENANT,
      intentId: intent.intent_id,
      remedy: "refund_issued",
      amount: "-2000.00",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_compensation_amount_exceeds_original",
  );
});

test("a live identity conflict blocks compensation in the planner and in the storage layer", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);
  const submitted = await submitAccountingIntent(env, {
    ...PORT_INPUT,
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "2001", observed: expected }),
    expectedReadback: expected,
  }, AT_SUBMIT);

  // A readback that returns a different entity id than the one we created.
  const payload = { ...(quickBooksEntity("invoice-open.json", "Invoice") as object), Id: "2999" };
  const conflicted = await reconcileAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    read: {
      status: "ok",
      realmId: REALM,
      entityType: "Invoice",
      entityId: "2999",
      payload,
      normalized: normalizeProviderEntity({ realmId: REALM, entityType: "Invoice", payload }),
      readAt: "2026-08-19T12:10:00.000Z",
      source: "sweep",
    },
  }, AT_READ);
  assert.equal(conflicted.verdict, "identity_conflict");
  assert.equal(submitted.status, "submitted");

  // Layer one: the planner refuses before the accountant ever sees a proposal.
  await assert.rejects(
    () => planAccountingCompensation(env, {
      tenantId: TENANT, intentId: intent.intent_id, remedy: "credit_memo_issued",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_intent_compensation_blocked",
  );

  // Layer two: the D1 trigger refuses the command receipt even if a handler forgets to ask.
  await assert.rejects(
    () => compensateCommand(env, conflicted.intent),
    (error: unknown) => (error as { code?: string }).code === "accounting_intent_compensation_blocked",
  );
  assert.ok(await readLiveAccountingException(
    env, TENANT, `accounting_intent:${intent.intent_id}`, "provider_identity_conflict",
  ));
  // Stated once, where it matters: an identity conflict is deliberately absent from the reasons a
  // reversal may answer. Reversing an entity we cannot prove is ours is worse than the conflict.
  assert.ok(!COMPENSABLE_REASON_CODES.includes("provider_identity_conflict"));
});

test("a credit memo reverses the surplus end to end, and both intents stay visible", async () => {
  const { env, db } = testEnv();
  const port = new TestMoneyEffectPort();
  const original = await overpaidInvoice(env);
  const plan = await planAccountingCompensation(env, {
    tenantId: TENANT, intentId: original.intent_id, remedy: "credit_memo_issued",
  });

  const { intent: reversal, expected } = await deriveReversal(env, plan, {
    entityFile: "credit-memo-240.json",
    subtotal: "-228.57",
    taxAmount: "-11.43",
    effectId: original.effect_id,
  });
  assert.equal(reversal.kind, "credit_memo");
  assert.equal(reversal.total_amount, "-240.00");
  assert.equal(reversal.compensates_intent_id, original.intent_id);
  assert.equal(reversal.compensates_effect_id, original.effect_id);

  await approveIntent(env, reversal);
  // The accountant authorizes the reversal on the original. `owner`, because money is being
  // reversed (section 6).
  await compensateCommand(env, original, OWNER, NOW, plan);

  const executor = scenarioExecutor({ providerExternalId: "4002", observed: expected });
  const result = await submitAccountingCompensation(env, {
    tenantId: TENANT,
    plan,
    reversalIntentId: reversal.intent_id,
    port,
    executor,
    actor: DISPATCH_ACTOR,
    resolvedByUserId: OWNER,
    taskId: "task:accounting:compensate",
    correlationId: "corr:accounting:0002",
    deadlineAt: DEADLINE,
    authorityExpiresAt: AUTHORITY_EXPIRES,
    expectedReadback: expected,
  }, AT_LATER);

  assert.equal(result.submission.status, "submitted");
  assert.equal(result.reversal.state, "submitted");
  assert.equal(result.reversal.provider_entity_id, "4002");
  assert.equal(result.original.state, "compensated");

  // The exception is closed by the remedy that was actually performed, linked to the ledger effect.
  assert.equal(result.exception.status, "resolved");
  assert.equal(result.exception.resolution_action, "credit_memo_issued");
  assert.equal(result.exception.compensating_effect_id, result.submission.outcome!.effectId);

  // The envelope carries what the accountant authorized, not only what was sent.
  const dispatched = port.requests.at(-1)!;
  assert.deepEqual(dispatched.compensationPlan, {
    exceptionId: plan.exceptionId,
    reasonCode: "provider_overpayment",
    remedy: "credit_memo_issued",
    compensatesIntentId: original.intent_id,
    amount: "-240.00",
  });
  assert.equal(dispatched.action, "quickbooks.creditmemo.create");
  assert.equal(dispatched.authority.amount, 24000);

  // Both remain visible, and neither row can be removed (section 5.4).
  const rows = (db.raw.prepare(
    `SELECT intent_id, state FROM accounting_intents ORDER BY intent_id`,
  ).all() as Array<{ intent_id: string; state: string }>);
  assert.equal(rows.length, 2);
  assert.throws(
    () => db.raw.prepare(`DELETE FROM accounting_intents WHERE intent_id = ?`)
      .run(original.intent_id),
    /accounting_intents_retained/,
  );
});

test("a reversal that does not reach the provider leaves the exception open and the original uncompensated", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const original = await overpaidInvoice(env);
  const plan = await planAccountingCompensation(env, {
    tenantId: TENANT, intentId: original.intent_id, remedy: "refund_issued",
  });
  const { intent: reversal, expected } = await deriveReversal(env, plan, {
    entityFile: "refund-receipt-240.json",
    subtotal: "-240.00",
    taxAmount: "0.00",
    effectId: original.effect_id,
  });
  await approveIntent(env, reversal);
  await compensateCommand(env, original, OWNER, NOW, plan);

  const executor = scenarioExecutor({
    providerExternalId: "5002",
    observed: expected,
    readbackStatus: "unavailable",
  });
  const result = await submitAccountingCompensation(env, {
    tenantId: TENANT,
    plan,
    reversalIntentId: reversal.intent_id,
    port,
    executor,
    actor: DISPATCH_ACTOR,
    resolvedByUserId: OWNER,
    taskId: "task:accounting:compensate",
    correlationId: "corr:accounting:0003",
    deadlineAt: DEADLINE,
    authorityExpiresAt: AUTHORITY_EXPIRES,
    expectedReadback: expected,
  }, AT_LATER);

  assert.equal(result.submission.status, "uncertain");
  assert.equal(result.reversal.state, "uncertain");
  // Nothing was closed on the strength of a reversal we cannot prove happened.
  assert.equal(result.exception.status, "open");
  assert.equal(result.exception.compensating_effect_id, null);
  assert.equal(result.original.state, "compensating");
});

test("a refund and a payment observed in either order produce one deterministic outcome", async () => {
  // Section 5.4's refund race, extended from S3's bare-observation version to a real refund
  // *intent*: a RefundReceipt IronWrap raised, dispatched through the port, reconciling on its own
  // provider identity while a payment observation for the same job arrives around it.
  //
  // Two properties, and the second is the one that would break first if this were order-sensitive:
  //
  //   * the refund reconciles against its own entity, whenever it is read;
  //   * the invoice intent, already compensated, is not reopened by re-observing the payment that
  //     caused the reversal - and the cumulative settlement is unchanged either way.
  //
  // The invoice's invariant still counts Payments only. Wiring refunds into settlement is section
  // 5.4's "refund after holdback release", which is slice S6 - so if S6 changes that, the settled
  // amount asserted here moves and this test fails loudly rather than silently passing.
  const refundFirst = await raceOutcome(["refund", "payment"]);
  const paymentFirst = await raceOutcome(["payment", "refund"]);

  assert.deepEqual(refundFirst, paymentFirst);
  assert.equal(refundFirst.refundVerdict, "reconciled");
  assert.equal(refundFirst.invoiceVerdict, "skipped");
  assert.equal(refundFirst.invoiceSkipReason, "accounting_intent_not_reconcilable");
  assert.equal(refundFirst.invoiceState, "compensated");
  assert.equal(refundFirst.settledCents, 150000);
  assert.deepEqual(refundFirst.observationEntityIds, ["2001", "3005", "5002"]);
});

async function raceOutcome(order: ReadonlyArray<"refund" | "payment">) {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();

  // The invoice is posted and already over-paid, so the reversal has a live exception to answer.
  const original = await overpaidInvoice(env);
  const plan = await planAccountingCompensation(env, {
    tenantId: TENANT, intentId: original.intent_id, remedy: "refund_issued",
  });
  const { intent: reversal, expected } = await deriveReversal(env, plan, {
    entityFile: "refund-receipt-240.json",
    subtotal: "-240.00",
    taxAmount: "0.00",
    effectId: original.effect_id,
  });
  await approveIntent(env, reversal);
  await compensateCommand(env, original, OWNER, NOW, plan);
  await submitAccountingCompensation(env, {
    tenantId: TENANT,
    plan,
    reversalIntentId: reversal.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "5002", observed: expected }),
    actor: DISPATCH_ACTOR,
    resolvedByUserId: OWNER,
    taskId: "task:accounting:compensate",
    correlationId: "corr:accounting:0004",
    deadlineAt: DEADLINE,
    authorityExpiresAt: AUTHORITY_EXPIRES,
    expectedReadback: expected,
  }, AT_LATER);

  let refundVerdict: string | null = null;
  let invoiceVerdict: string | null = null;
  let invoiceSkipReason: string | null = null;

  for (const step of order) {
    if (step === "refund") {
      const { fetcher } = fakeIntuit([entityRoute("RefundReceipt", "refund-receipt-240.json")]);
      const read = await readProviderEntity(scenarioAuth(), {
        tenantId: TENANT,
        entityType: "RefundReceipt",
        entityId: "5002",
        source: "sweep",
      }, fetcher, AT_LATER);
      const outcome = await reconcileAccountingIntent(env, {
        tenantId: TENANT, intentId: reversal.intent_id, read,
      }, AT_LATER);
      refundVerdict = outcome.verdict;
      continue;
    }
    const { fetcher } = fakeIntuit([
      entityRoute("Payment", "payment-overpaid-1500.json"),
      entityRoute("Invoice", "invoice-paid.json"),
    ]);
    const ingest = await ingestObservedPayment(env, scenarioAuth(), {
      tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
    }, fetcher, AT_LATER);
    // The original is `compensated` by now, which is not a state a verdict may be applied to, so
    // the ingest reports the skip instead of walking a settled reversal backwards.
    invoiceVerdict = ingest.settlements[0]!.status === "skipped"
      ? "skipped"
      : ingest.settlements[0]!.reconciliation!.verdict;
    invoiceSkipReason = ingest.settlements[0]!.reason;
  }

  const settlement = await invoiceSettlement(env, {
    tenantId: TENANT, realmId: REALM, invoiceEntityId: "2001",
  });
  const observations = await listAccountingObservations(env, TENANT);
  return {
    refundVerdict,
    invoiceVerdict,
    invoiceSkipReason,
    invoiceState: (await readAccountingIntent(env, TENANT, original.intent_id))!.state,
    settledCents: settlement.linkedCents,
    observationEntityIds: [...new Set(observations.map((row) => row.entity_id))].sort(),
  };
}
