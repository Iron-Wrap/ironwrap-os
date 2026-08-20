// Slice S4. The payment path, driven end to end through the observe-only ingest.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.4's payment failure cases and the section 9
// scenario matrix. The S3 suite proved the verdict engine against hand-recorded observations; this
// proves the same three outcomes arrive when a real ingest reads the provider, records what it
// found, and re-reads the invoice - which is what production will actually do.
//
// Every read here goes through `fakeIntuit`, so an unrouted path is a 404 from a function and
// never a socket.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REALM, TENANT, fakeIntuit, quickBooksEntity, testEnv } from "./accounting-fixture.ts";
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import {
  AT_LATER,
  AT_READ,
  AT_SUBMIT,
  AUTHORITY_EXPIRES,
  DEADLINE,
  DISPATCH_ACTOR,
  approveIntent,
  compensateCommand,
  deriveScenarioIntent,
  entityRoute,
  scenarioAuth,
  scenarioExecutor,
} from "./accounting-scenario-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import type { AccountingIntentRecord } from "../src/accounting-intents.ts";
import { submitAccountingIntent } from "../src/accounting-submission.ts";
import {
  ingestObservedPayment,
  linkedInvoiceIds,
  readIntentByProviderEntity,
} from "../src/accounting-payments.ts";
import {
  invoiceSettlement,
  listAccountingObservations,
} from "../src/accounting-reconciliation.ts";
import { listAccountingExceptions } from "../src/accounting-exceptions.ts";
import { AccountingNormalizerError } from "../src/accounting-normalizers.ts";

/** Derive, approve and dispatch one deposit invoice, so `2001` is an entity IronWrap owns. */
async function postedInvoice(env: AppEnv): Promise<AccountingIntentRecord> {
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);
  const result = await submitAccountingIntent(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "2001", observed: expected }),
    actor: DISPATCH_ACTOR,
    taskId: "task:accounting:submit",
    correlationId: "corr:accounting:0001",
    deadlineAt: DEADLINE,
    authorityExpiresAt: AUTHORITY_EXPIRES,
    expectedReadback: expected,
    taxPreflightOnDate: "2026-08-19",
  }, AT_SUBMIT);
  assert.equal(result.status, "submitted");
  return result.intent;
}

test("a partial payment settles the invoice partially, with no exception and the invariant holding", async () => {
  const { env } = testEnv();
  const intent = await postedInvoice(env);

  const { fetcher, calls } = fakeIntuit([
    entityRoute("Payment", "payment-partial-500.json"),
    entityRoute("Invoice", "invoice-partially-paid.json"),
  ]);
  const result = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT,
    paymentEntityId: "3001",
    source: "webhook_triggered_read",
  }, fetcher, AT_READ);

  assert.equal(result.status, "observed");
  // Two authenticated reads, in order: the payment we were told about, then the invoice it moves.
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.match(calls[0]!.url, /\/payment\/3001/);
  assert.match(calls[1]!.url, /\/invoice\/2001/);

  assert.equal(result.settlements.length, 1);
  const settlement = result.settlements[0]!;
  assert.equal(settlement.intentId, intent.intent_id);
  assert.equal(settlement.status, "reconciled");
  assert.equal(settlement.reconciliation!.verdict, "partially_settled");
  assert.equal(settlement.reconciliation!.settledAmount, "500.00");
  assert.equal(settlement.reconciliation!.exception, null);
  assert.equal(settlement.reconciliation!.intent.state, "partially_settled");

  // Section 5.4's cumulative invariant, evaluated over the observations rather than asserted.
  const cumulative = await invoiceSettlement(env, {
    tenantId: TENANT, realmId: REALM, invoiceEntityId: "2001",
  });
  assert.equal(cumulative.linkedCents, 50000);
  assert.equal(cumulative.paymentCount, 1);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
});

test("the remainder after a partial reaches `reconciled` only once the balance is zero", async () => {
  const { env } = testEnv();
  await postedInvoice(env);

  const partial = fakeIntuit([
    entityRoute("Payment", "payment-partial-500.json"),
    entityRoute("Invoice", "invoice-partially-paid.json"),
  ]);
  const first = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3001", source: "sweep",
  }, partial.fetcher, AT_READ);
  assert.equal(first.settlements[0]!.reconciliation!.verdict, "partially_settled");

  const remainder = fakeIntuit([
    entityRoute("Payment", "payment-remainder-760.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const second = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3002", source: "sweep",
  }, remainder.fetcher, AT_LATER);

  const settlement = second.settlements[0]!;
  assert.equal(settlement.reconciliation!.verdict, "reconciled");
  assert.equal(settlement.reconciliation!.settledAmount, "1260.00");
  assert.equal(settlement.reconciliation!.intent.state, "reconciled");
  assert.ok(settlement.reconciliation!.intent.provider_reconciled_at);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
});

test("two payments against one invoice are `duplicate_provider_payment`, with exactly two remedies", async () => {
  const { env } = testEnv();
  await postedInvoice(env);

  const first = fakeIntuit([
    entityRoute("Payment", "payment-full-1260.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const settled = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3003", source: "sweep",
  }, first.fetcher, AT_READ);
  assert.equal(settled.settlements[0]!.reconciliation!.verdict, "reconciled");

  // The same invoice, paid a second time. Section 5.4: an exception, never an auto-delete.
  const duplicate = fakeIntuit([
    entityRoute("Payment", "payment-duplicate-1260.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const result = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3004", source: "sweep",
  }, duplicate.fetcher, AT_LATER);

  const settlement = result.settlements[0]!;
  assert.equal(settlement.reconciliation!.verdict, "mismatch");
  assert.equal(settlement.reconciliation!.reasonCode, "duplicate_provider_payment");
  // A previously reconciled intent moves to `reconciliation_required`, not straight to `mismatch`.
  assert.equal(settlement.reconciliation!.intent.state, "reconciliation_required");

  const detail = JSON.parse(settlement.reconciliation!.exception!.detail_json) as {
    paymentEntityIds: string[];
    observedSettled: string;
    remedies: Array<{ action: string; alternatives: string[] }>;
  };
  assert.deepEqual(detail.paymentEntityIds, ["3003", "3004"]);
  assert.equal(detail.observedSettled, "2520.00");
  assert.deepEqual(detail.remedies.map((remedy) => remedy.action),
    ["void_provider_entity", "credit_memo_issued"]);
  assert.deepEqual(detail.remedies[1]!.alternatives, ["refund_issued"]);

  // Nothing was deleted: both payment observations and the invoice reads are all still on record.
  const observations = await listAccountingObservations(env, TENANT);
  assert.deepEqual(
    observations.filter((row) => row.entity_type === "Payment").map((row) => row.entity_id),
    ["3003", "3004"],
  );
});

test("an over-sized single payment is `provider_overpayment`, a mismatch and not a partial", async () => {
  const { env } = testEnv();
  await postedInvoice(env);

  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const result = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);

  const settlement = result.settlements[0]!;
  assert.equal(settlement.reconciliation!.verdict, "mismatch");
  assert.equal(settlement.reconciliation!.reasonCode, "provider_overpayment");
  assert.equal(settlement.reconciliation!.settledAmount, "1500.00");
  assert.equal(settlement.reconciliation!.intent.state, "mismatch");

  // One payment, so it is an over-payment rather than a duplicate. The distinction is the whole
  // point: the remedies differ, and so does what the accountant is being asked to decide.
  const cumulative = await invoiceSettlement(env, {
    tenantId: TENANT, realmId: REALM, invoiceEntityId: "2001",
  });
  assert.equal(cumulative.paymentCount, 1);
  assert.equal(cumulative.linkedCents, 150000);
  const exceptions = await listAccountingExceptions(env, TENANT);
  assert.deepEqual(exceptions.map((row) => row.reason_code), ["provider_overpayment"]);
});

test("re-ingesting an unchanged payment writes nothing new and moves no intent version", async () => {
  const { env } = testEnv();
  await postedInvoice(env);
  const routes = [
    entityRoute("Payment", "payment-partial-500.json"),
    entityRoute("Invoice", "invoice-partially-paid.json"),
  ];

  const first = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3001", source: "sweep",
  }, fakeIntuit(routes).fetcher, AT_READ);
  const second = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3001", source: "sweep",
  }, fakeIntuit(routes).fetcher, AT_READ);

  assert.equal(second.observation!.observation_id, first.observation!.observation_id);
  assert.equal(second.settlements[0]!.reconciliation!.replayed, true);
  assert.equal(
    second.settlements[0]!.reconciliation!.intent.version,
    first.settlements[0]!.reconciliation!.intent.version,
  );
  assert.equal((await listAccountingObservations(env, TENANT)).length, 2);
});

test("a payment against an invoice IronWrap never raised is recorded and settles nothing", async () => {
  const { env } = testEnv();
  // No intent claims entity 2001 in this test: the payment is somebody else's transaction.
  const { fetcher } = fakeIntuit([entityRoute("Payment", "payment-full-1260.json")]);
  const result = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3003", source: "sweep",
  }, fetcher, AT_READ);

  assert.equal(result.status, "observed");
  assert.ok(result.observation);
  assert.deepEqual(result.settlements, []);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
  assert.equal(
    await readIntentByProviderEntity(env, {
      tenantId: TENANT, realmId: REALM, entityType: "Invoice", entityId: "2001",
    }),
    null,
  );
});

test("a payment landing on an intent that is mid-compensation is skipped, not forced", async () => {
  const { env } = testEnv();
  const intent = await postedInvoice(env);

  // Over-pay it, so the intent reaches `mismatch` and a compensation becomes available.
  const overpaid = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const mismatch = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, overpaid.fetcher, AT_READ);
  assert.equal(mismatch.settlements[0]!.reconciliation!.intent.state, "mismatch");

  // The accountant authorizes a reversal. `compensating` is not a state a verdict may be applied
  // to, and the state machine would refuse the transition - so ingest reports the skip instead of
  // driving the intent into a refusal.
  const compensating = await compensateCommand(
    env,
    mismatch.settlements[0]!.reconciliation!.intent,
  );
  assert.equal(compensating.state, "compensating");

  const late = fakeIntuit([
    entityRoute("Payment", "payment-full-1260.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  const result = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3003", source: "sweep",
  }, late.fetcher, AT_LATER);

  assert.equal(result.settlements.length, 1);
  assert.equal(result.settlements[0]!.intentId, intent.intent_id);
  assert.equal(result.settlements[0]!.status, "skipped");
  assert.equal(result.settlements[0]!.reason, "accounting_intent_not_reconcilable");
  // The payment itself is still recorded: it is a fact IronWrap read, whatever the intent's state.
  assert.ok(result.observation);
  assert.equal(
    (await readIntentByProviderEntity(env, {
      tenantId: TENANT, realmId: REALM, entityType: "Invoice", entityId: "2001",
    }))!.state,
    "compensating",
  );
});

test("an unreachable provider writes nothing at all, and a missing payment raises nothing", async () => {
  const { env } = testEnv();
  await postedInvoice(env);

  const outage = fakeIntuit([
    entityRoute("Payment", "payment-partial-500.json", { status: 429, body: {} }),
  ]);
  const unavailable = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3001", source: "sweep",
  }, outage.fetcher, AT_READ);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.detailCode, "provider_throttled");
  assert.equal(unavailable.observation, null);
  assert.deepEqual(unavailable.settlements, []);

  // An id that is simply not there: not IronWrap's exception to raise, because IronWrap never
  // created it. Section 5.4's `provider_entity_not_found` is about entities we did create.
  const missing = await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "9999", source: "sweep",
  }, fakeIntuit([]).fetcher, AT_READ);
  assert.equal(missing.status, "not_found");
  assert.equal(missing.observation, null);
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
  // A dispatch records no observation - only an authenticated readback does - so both refused
  // reads leaving the table empty is the whole assertion.
  assert.equal((await listAccountingObservations(env, TENANT)).length, 0);
});

test("a payment line split across two invoices is refused rather than attributed by guess", async () => {
  const ambiguous = {
    Id: "3099",
    TotalAmt: 1000.0,
    Line: [{
      Amount: 1000.0,
      LinkedTxn: [
        { TxnId: "2001", TxnType: "Invoice" },
        { TxnId: "2002", TxnType: "Invoice" },
      ],
    }],
  };
  assert.throws(
    () => linkedInvoiceIds(ambiguous),
    (error: unknown) => error instanceof AccountingNormalizerError
      && error.code === "provider_payment_line_ambiguous",
  );
  // The unambiguous case still reads exactly the invoices the provider named.
  assert.deepEqual(linkedInvoiceIds(quickBooksEntity("payment-full-1260.json", "Payment")),
    ["2001"]);
});
