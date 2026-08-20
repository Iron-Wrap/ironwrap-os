// Slice S4. The dispatch path: an approved intent reaching the provider through the money port.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4, 6 and the section 9 scenario
// matrix. Every test here runs the real 0058-0061 SQL in `node:sqlite` and the real in-memory
// ledger from `accounting-port-fixture.ts`; nothing opens a socket and no provider credential
// exists anywhere in the tree.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REALM,
  TENANT,
  fakeIntuit,
  quickBooksEntity,
  testEnv,
} from "./accounting-fixture.ts";
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import {
  AT_READ,
  AT_SUBMIT,
  AUTHORITY_EXPIRES,
  DEADLINE,
  DISPATCH_ACTOR,
  approveIntent,
  deriveScenarioIntent,
  entityRoute,
  scenarioAuth,
  scenarioExecutor,
} from "./accounting-scenario-fixture.ts";
import { MoneyEffectError } from "../src/accounting-effect-port.ts";
import {
  AccountingIntentError,
  listAccountingIntentEvents,
  readAccountingIntent,
} from "../src/accounting-intents.ts";
import {
  ACCOUNTING_PROVIDER_ACTIONS,
  dispatchRefusalCode,
  magnitudeCents,
  submitAccountingIntent,
  submitAndReconcileAccountingIntent,
} from "../src/accounting-submission.ts";
import {
  normalizeProviderEntity,
  providerFactEnvelope,
} from "../src/accounting-normalizers.ts";
import {
  currentTaxPolicySnapshot,
  recordTaxPolicySnapshot,
} from "../src/accounting-tax-snapshots.ts";
import { listAccountingExceptions } from "../src/accounting-exceptions.ts";

function submitInput(
  intentId: string,
  port: TestMoneyEffectPort,
  executor: ReturnType<typeof scenarioExecutor>,
  expected: unknown,
) {
  return {
    tenantId: TENANT,
    intentId,
    port,
    executor,
    actor: DISPATCH_ACTOR,
    taskId: "task:accounting:submit",
    correlationId: "corr:accounting:0001",
    deadlineAt: DEADLINE,
    authorityExpiresAt: AUTHORITY_EXPIRES,
    expectedReadback: expected,
    taxPreflightOnDate: "2026-08-19",
  };
}

test("an approved deposit invoice dispatches once and reaches `submitted`, never `reconciled`", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  const result = await submitAccountingIntent(
    env,
    submitInput(intent.intent_id, port, executor, expected),
    AT_SUBMIT,
  );

  assert.equal(result.status, "submitted");
  assert.equal(result.intent.state, "submitted");
  assert.equal(result.intent.provider_entity_id, "2001");
  assert.equal(result.intent.provider_entity_type, "Invoice");
  assert.ok(result.intent.provider_submitted_at);
  // Section 5.1: an accepted dispatch is the provider acknowledging, not the money being settled.
  assert.equal(result.intent.provider_reconciled_at, null);
  assert.equal(executor.dispatchCount(), 1);
  assert.equal(port.dispatches.length, 1);

  // The transition is on the event ledger, not only on the row.
  const states = (await listAccountingIntentEvents(env, TENANT, intent.intent_id))
    .map((event) => event.state_to);
  assert.deepEqual(states.slice(-2), ["submission_pending", "submitted"]);
});

test("the authority the port receives carries magnitudes, so a ceiling cannot be signed away", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  // A refund: negative money, and exactly the kind a signed comparison would wave through.
  const { intent, expected } = await deriveScenarioIntent(env, {
    kind: "refund",
    entityType: "RefundReceipt",
    entityFile: "refund-receipt.json",
    subtotal: "-315.00",
    taxAmount: "0.00",
    total: "-315.00",
    // `0058`'s CHECK on `authority_max_amount` refuses a minus sign outright, so the ceiling is a
    // magnitude in the schema itself and `total_amount` is the only signed side of the compare.
    maxAmount: "500.00",
  });
  await approveIntent(env, intent);

  const executor = scenarioExecutor({ providerExternalId: "5001", observed: expected });
  await submitAccountingIntent(
    env,
    submitInput(intent.intent_id, port, executor, expected),
    AT_SUBMIT,
  );

  const authority = port.requests[0]!.authority;
  assert.equal(authority.amount, 31500);
  assert.equal(authority.maxAmount, 50000);
  assert.ok(authority.amount! > 0 && authority.maxAmount! > 0);
  // The property under test, stated as the arithmetic that would fail without it: signed, every
  // reversal is "under" any ceiling, because -31500 < 50000 is true for any refund of any size.
  assert.equal(magnitudeCents("-315.00"), 31500);
  assert.ok(Number.parseInt("-99999.00".replace(".", ""), 10) < 50000);
});

test("a reversal above the ceiling is refused on magnitude, at derivation and at the ledger", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();

  // Layer one: the aggregate refuses the row. A signed compare would have accepted it, because
  // -31500 is less than 30000 by any signed reading.
  await assert.rejects(
    () => deriveScenarioIntent(env, {
      kind: "refund",
      entityType: "RefundReceipt",
      entityFile: "refund-receipt.json",
      subtotal: "-315.00",
      taxAmount: "0.00",
      total: "-315.00",
      maxAmount: "300.00",
    }),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "effect_policy_amount_ceiling_exceeded",
  );

  // Layer two: the ledger refuses the effect when the authority it is handed is tighter than the
  // intent's own ceiling - the case the aggregate cannot see.
  const { intent, expected } = await deriveScenarioIntent(env, {
    kind: "refund",
    entityType: "RefundReceipt",
    entityFile: "refund-receipt.json",
    subtotal: "-315.00",
    taxAmount: "0.00",
    total: "-315.00",
    maxAmount: "5000.00",
  });
  await approveIntent(env, intent);
  const executor = scenarioExecutor({ providerExternalId: "5001", observed: expected });
  const input = submitInput(intent.intent_id, port, executor, expected);
  await assert.rejects(
    () => submitAccountingIntent(env, {
      ...input,
      port: {
        assertReady: () => port.assertReady(),
        // A tighter per-effect ceiling, in the same magnitude-cents unit the money plane uses.
        run: (request, exec, now) => port.run(
          { ...request, authority: { ...request.authority, maxAmount: 10000 } },
          exec,
          now,
        ),
      },
    }, AT_SUBMIT),
    (error: unknown) => error instanceof MoneyEffectError
      && error.code === "effect_policy_amount_ceiling_exceeded",
  );
  assert.equal(executor.dispatchCount(), 0);
});

test("a payment intent refuses to dispatch: IronWrap observes Payments, it does not create them", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env, {
    kind: "payment",
    entityType: "Payment",
    entityFile: "payment-full-1260.json",
    subtotal: "1260.00",
    taxAmount: "0.00",
  });
  await approveIntent(env, intent);

  const executor = scenarioExecutor({ providerExternalId: "3003", observed: expected });
  await assert.rejects(
    () => submitAccountingIntent(
      env,
      submitInput(intent.intent_id, port, executor, expected),
      AT_SUBMIT,
    ),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_payment_observe_only",
  );

  // Nothing was proposed, so there is no ledger row implying IronWrap considered the write.
  assert.equal(port.requests.length, 0);
  assert.equal(executor.dispatchCount(), 0);
  assert.equal((await readAccountingIntent(env, TENANT, intent.intent_id))!.state,
    "submission_pending");

  // Section 12 open question 4's default and section 4.1's filing rule, as the map states them.
  assert.equal(ACCOUNTING_PROVIDER_ACTIONS.payment, null);
  assert.equal(ACCOUNTING_PROVIDER_ACTIONS.tax_remittance_proposal, null);
  assert.equal(dispatchRefusalCode("payment"), "accounting_payment_observe_only");
  assert.equal(dispatchRefusalCode("tax_remittance_proposal"),
    "accounting_tax_remittance_propose_only");
  assert.equal(dispatchRefusalCode("deposit_invoice"), null);
});

test("an unapproved intent cannot dispatch, whatever the caller passes", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);

  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  await assert.rejects(
    () => submitAccountingIntent(
      env,
      submitInput(intent.intent_id, port, executor, expected),
      AT_SUBMIT,
    ),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_intent_not_submittable",
  );
  assert.equal(port.requests.length, 0);
});

test("an expectation that is not the one the intent bound is refused before dispatch", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  // The same invoice with one fact altered: a caller could otherwise hand the ledger a weaker
  // expectation than the one the accountant approved, and every readback would "match".
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType: "Invoice",
    payload: quickBooksEntity("invoice-open.json", "Invoice"),
  }).facts;
  const tampered = providerFactEnvelope({
    realmId: REALM,
    entityType: "Invoice",
    facts: { ...facts, TotalAmt: "9999.00" },
  });

  const executor = scenarioExecutor({ providerExternalId: "2001", observed: tampered });
  await assert.rejects(
    () => submitAccountingIntent(
      env,
      submitInput(intent.intent_id, port, executor, tampered),
      AT_SUBMIT,
    ),
    (error: unknown) => error instanceof AccountingIntentError
      && error.code === "accounting_intent_expected_readback_mismatch",
  );
  assert.equal(port.requests.length, 0);
});

test("a retried dispatch with the same envelope replays; a changed one is an idempotency conflict", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  const first = await submitAccountingIntent(
    env,
    submitInput(intent.intent_id, port, executor, expected),
    AT_SUBMIT,
  );
  assert.equal(first.status, "submitted");

  // Section 5.4, duplicate create: the identical envelope replays the stored entity. No second
  // provider call, and no second ledger attempt row.
  const replayed = await port.run(port.requests[0]!, executor, AT_SUBMIT);
  assert.equal(replayed.effectId, first.outcome!.effectId);
  assert.equal(replayed.providerExternalId, "2001");
  assert.equal(executor.dispatchCount(), 1);
  assert.equal(executor.replayCount(), 1);
  assert.equal(port.attemptsFor(first.outcome!.effectId).length, 1);

  // A changed envelope on the same business key is a conflict, and nothing is dispatched.
  await assert.rejects(
    () => port.run(
      { ...port.requests[0]!, request: { TotalAmt: "9999.00" } },
      executor,
      AT_SUBMIT,
    ),
    (error: unknown) => error instanceof MoneyEffectError
      && error.code === "effect_idempotency_conflict",
  );
  assert.equal(executor.dispatchCount(), 1);
});

test("a lost response leaves the intent `uncertain` and the ledger refuses to retry it", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  const executor = scenarioExecutor({
    providerExternalId: "2001",
    observed: expected,
    readbackStatus: "unavailable",
    detailCode: "provider_readback_unavailable",
  });
  const result = await submitAccountingIntent(
    env,
    submitInput(intent.intent_id, port, executor, expected),
    AT_SUBMIT,
  );

  assert.equal(result.status, "uncertain");
  assert.equal(result.intent.state, "uncertain");
  assert.equal(result.outcome!.state, "unknown");
  // Section 5.4: retry is not an option and never becomes one.
  await assert.rejects(
    () => port.run(port.requests[0]!, executor, AT_SUBMIT),
    (error: unknown) => error instanceof MoneyEffectError
      && error.code === "effect_unknown_requires_reconciliation",
  );
});

test("a stale tax snapshot blocks the submission, and nothing reaches the ledger", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  // The rate changed after approval. A new snapshot supersedes; the approved candidate is stale.
  await recordTaxPolicySnapshot(env, {
    tenantId: TENANT,
    jurisdiction: "CA-AB",
    taxCode: "GST",
    providerTaxCodeId: "3",
    ratePercent: "6.0000",
    effectiveFrom: "2026-08-01",
    sourceRef: "CRA GST bulletin 2026-08-01",
  }, AT_SUBMIT);

  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  const result = await submitAccountingIntent(
    env,
    submitInput(intent.intent_id, port, executor, expected),
    AT_SUBMIT,
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.blockerCode, "candidate_changed");
  assert.equal(result.intent.state, "blocked");
  assert.equal(port.requests.length, 0);
  assert.equal(executor.dispatchCount(), 0);
  // The snapshot the intent bound is untouched; only the candidate has to be re-derived.
  const current = await currentTaxPolicySnapshot(env, {
    tenantId: TENANT, jurisdiction: "CA-AB", taxCode: "GST", onDate: "2026-08-19",
  });
  assert.equal(current!.rate_percent, "6.0000");
});

test("submit then read back is the whole first money path, and a fresh invoice is `partially_settled`", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  const { fetcher, calls } = fakeIntuit([entityRoute("Invoice", "invoice-open.json")]);
  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  const result = await submitAndReconcileAccountingIntent(env, {
    ...submitInput(intent.intent_id, port, executor, expected),
    auth: scenarioAuth(),
    fetcher,
  }, AT_READ);

  assert.equal(result.status, "submitted");
  // The readback is a separate authenticated GET, not the create response echoed back.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v3\/company\/\d+\/invoice\/2001/);
  assert.equal(calls[0]!.method, "GET");
  assert.ok(calls[0]!.authorization?.startsWith("Bearer "));

  // Nothing is owed yet and nothing is paid yet: the invariant holds, the target is not met.
  assert.equal(result.reconciliation!.verdict, "partially_settled");
  assert.equal(result.reconciliation!.settledAmount, "0.00");
  assert.equal(result.reconciliation!.exception, null);
  assert.equal(result.intent.state, "partially_settled");
  assert.equal(result.read!.status, "ok");
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
  assert.equal(result.reconciliation!.observedSha256, intent.expected_sha256);
});

test("a provider that is unreachable at readback changes no money state at all", async () => {
  const { env } = testEnv();
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);

  const { fetcher } = fakeIntuit([
    entityRoute("Invoice", "invoice-open.json", { status: 503, body: {} }),
  ]);
  const executor = scenarioExecutor({ providerExternalId: "2001", observed: expected });
  const result = await submitAndReconcileAccountingIntent(env, {
    ...submitInput(intent.intent_id, port, executor, expected),
    auth: scenarioAuth(),
    fetcher,
  }, AT_READ);

  // Section 5.3: `unavailable` is retryable and is never a verdict of record.
  assert.equal(result.reconciliation!.verdict, "unavailable");
  assert.equal(result.reconciliation!.observationId, null);
  assert.equal(result.intent.state, "submitted");
  assert.equal((await listAccountingExceptions(env, TENANT)).length, 0);
  assert.equal(result.read!.status, "unavailable");
});
