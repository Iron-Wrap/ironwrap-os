// Route-level cover for the money dispatcher (ELEC-72).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4 and 8.1. ELEC-71 proved on the
// running stack that S1-S5 was orphaned: an approved intent stopped at `submission_pending`
// forever, an authorized compensation stopped at `compensating`, no route created an intent at
// all, and closing a money exception was an honour-system text field. Every test here drives the
// real HTTP routes through `handleAuthenticatedRoute` and the real cron entry points - never the
// engine directly - because a test that calls `submitAccountingIntent` itself proves only that the
// function works, which was never in doubt.
//
// The provider is the synthetic Intuit double throughout (project rule 5): the binding is injected,
// so nothing here can reach a real provider even by accident.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REALM, TENANT, fakeIntuit, quickBooksEntity } from "./accounting-fixture.ts";
import {
  ACCOUNTANT_ID,
  OWNER_ID,
  SECOND_ACCOUNTANT_ID,
  apiTestEnv,
  call,
} from "./accounting-api-fixture.ts";
import {
  AT_READ,
  AT_SUBMIT,
  entityRoute,
  scenarioAuth,
} from "./accounting-scenario-fixture.ts";
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import type {
  MoneyDispatchResult,
  MoneyEffectExecutor,
} from "../src/accounting-effect-port.ts";
import {
  runAccountingCompensationDispatch,
  runAccountingDispatch,
  type AccountingDispatchBinding,
} from "../src/accounting-dispatch.ts";
import {
  intentSubjectRef,
  listAccountingExceptions,
  raiseAccountingException,
  readAccountingException,
} from "../src/accounting-exceptions.ts";
import { readAccountingIntent } from "../src/accounting-intents.ts";
import {
  ACCOUNTING_AUTHORITY_POLICY_ANY_KIND,
  DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT,
  recordAccountingAuthorityPolicy,
} from "../src/accounting-authority-policy.ts";
import { readAccountingIntentExpectation } from "../src/accounting-expectations.ts";
import { readAccountingCompensationAuthorizationByException } from "../src/accounting-compensation-authorizations.ts";
import { ingestObservedPayment } from "../src/accounting-payments.ts";
import { runAccountingSweeps, sweepStuckAccountingDispatches } from "../src/accounting-sweeps.ts";
import { recordTaxPolicySnapshot } from "../src/accounting-tax-snapshots.ts";
import { accountingIntentReobserver } from "../src/accounting-reobservation.ts";
import { normalizeProviderEntity } from "../src/accounting-normalizers.ts";

/** The instant every scenario derives at, and the two the dispatcher runs at. */
const AT_DERIVE = new Date("2026-08-19T12:00:00.000Z");
const AT_DISPATCH = new Date("2026-08-19T12:05:00.000Z");
/** The reversal's own `TxnDate` is the day it is dispatched, and the fixture credit memo's is this. */
const AT_COMPENSATE = new Date("2026-08-21T12:00:00.000Z");

/** The provider entity ids the double assigns, per entity type. */
const INVOICE_ID = "2001";
const CREDIT_MEMO_ID = "4002";

/**
 * The tax snapshot the derive route binds. Recorded first in every scenario, because section 5.4
 * makes an unbound rate a refusal rather than a derivation with a rate nobody chose.
 */
async function seedTaxSnapshot(env: AppEnv) {
  return await recordTaxPolicySnapshot(env, {
    tenantId: TENANT,
    jurisdiction: "CA-AB",
    taxCode: "GST",
    providerTaxCodeId: "3",
    ratePercent: "5.0000",
    effectiveFrom: "2008-01-01",
    sourceRef: "CRA GST bulletin 2008-01-01",
  }, AT_DERIVE);
}

/** The body the derive route takes: a job, a customer, and the figures. Nothing provider-shaped. */
function derivationBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "deposit_invoice",
    roof_job_id: "job-0001",
    realm_id: REALM,
    // The refs the fixture invoice carries: the readback is the same bytes through the
    // normalizer, so a derivation that named different refs would be a guaranteed mismatch.
    customer_ref: "42",
    item_ref: "7",
    tax_code_ref: "TAX",
    subtotal: "1200.00",
    tax_amount: "60.00",
    txn_date: "2026-08-19",
    due_date: "2026-09-18",
    jurisdiction: "CA-AB",
    tax_code: "GST",
    // No `authority_max_amount`: the ceiling is the tenant's policy, read server-side
    // (ELEC-73 finding 2). A body that names one is refused outright - proven below.
    source_documents: [{ id: "quote-0001", version: 3 }],
    ...overrides,
  };
}

/**
 * A provider adapter over the synthetic fixtures, driven by whatever the intent asked for.
 *
 * The readback echoes the *observed* facts of the fixture entity, which is what makes the round
 * trip non-trivial: `expected_sha256` is the local projection, `observed_sha256` is the normalizer
 * reading provider bytes, and they meet only if the dispatcher bound the identity correctly.
 */
function fixtureExecutor(
  entityFile: string,
  entityType: "Invoice" | "CreditMemo",
  providerExternalId: string,
  overrides: { outcome?: MoneyDispatchResult<unknown>["outcome"] } = {},
): MoneyEffectExecutor<{ providerEntityId: string }> {
  const observed = normalizeProviderEntity({
    realmId: REALM,
    entityType,
    payload: quickBooksEntity(entityFile, entityType),
  });
  return {
    async dispatch() {
      return {
        outcome: overrides.outcome ?? "accepted",
        value: { providerEntityId: providerExternalId },
        providerExternalId,
        providerResponse: { Id: providerExternalId },
      };
    },
    async readback() {
      return {
        status: "match",
        providerExternalId,
        observed: { realmId: REALM, entityType, facts: observed.facts },
      };
    },
    async replay() {
      return { providerEntityId: providerExternalId };
    },
  };
}

/** The whole dispatcher binding, with the fixture Intuit behind the readback leg. */
function binding(
  routes: Parameters<typeof fakeIntuit>[0],
  executorByKind: Record<string, MoneyEffectExecutor<{ providerEntityId: string }>>,
  port = new TestMoneyEffectPort(),
): AccountingDispatchBinding & { port: TestMoneyEffectPort } {
  const { fetcher } = fakeIntuit(routes);
  return {
    port,
    executorFor: ({ intent }) => {
      const executor = executorByKind[intent.kind];
      if (!executor) throw new Error(`no executor for ${intent.kind}`);
      return executor;
    },
    auth: scenarioAuth(),
    fetcher,
  };
}

// ------------------------------------------------------------------- journey 1: the whole lane

test("journey 1: derive, approve, and the dispatcher carries it to reconciled with no human step", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);

  // 1. Create. There was no production route for this at all before ELEC-72 - derivation was
  //    engine-only, so every journey had to start from a hand-seeded row.
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-00000000001",
  });
  assert.equal(created.status, 201);
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const derived = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(derived?.state, "pending_review");
  assert.equal(derived?.total_amount, "1260.00");

  // The envelope the hash was taken over is stored, which is what makes a background dispatch
  // possible at all, and it names no `Id` because the provider has not assigned one yet.
  const expectation = await readAccountingIntentExpectation(env, TENANT, intentId);
  assert.ok(expectation, "derivation stores the expectation envelope");
  assert.equal(expectation!.expected_sha256, derived!.expected_sha256);
  assert.equal(expectation!.omits_identity, 1);
  assert.equal(
    (JSON.parse(expectation!.envelope_json) as { facts: Record<string, unknown> }).facts.Id,
    undefined,
  );

  // 2. Approve, over the real route, as a different user than the one that derived it - which is
  //    now a real constraint rather than a comment: the derivation is attributed to the session
  //    that made it, so approving as `ACCOUNTANT_ID` here would be refused (ELEC-77 defect 1).
  const approved = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    {
      body: { version: derived!.version },
      idempotencyKey: "idem-approve-0000000001",
      userId: SECOND_ACCOUNTANT_ID,
    },
  );
  assert.equal(approved.status, 202);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "submission_pending");

  // 3. The dispatcher. This is the step that did not exist: on PR #75 `submission_pending` was
  //    terminal in production and the desk's "Being sent to QuickBooks" never resolved.
  const report = await runAccountingDispatch(env, {
    tenantId: TENANT,
    binding: binding(
      [entityRoute("Invoice", "invoice-open.json")],
      { deposit_invoice: fixtureExecutor("invoice-open.json", "Invoice", INVOICE_ID) },
    ),
    now: AT_DISPATCH,
  });
  assert.equal(report.dispatcher_unbound, false);
  assert.deepEqual(report.pending, [intentId]);
  assert.equal(report.dispatched.length, 1);
  assert.equal(report.dispatched[0]!.status, "submitted");

  // 4. Observed - reached by an authenticated readback of the exact entity id, never by the create
  //    response echoing itself (section 5.1). The invoice is issued and unpaid, so the cumulative
  //    settlement invariant puts it at `partially_settled`: section 5.4 lets an invoice reach
  //    `reconciled` only once `Balance == 0`, and inventing that here would be the whole point of
  //    the engine thrown away.
  assert.equal(report.dispatched[0]!.verdict, "partially_settled");
  const observed = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(observed?.state, "partially_settled");
  assert.equal(observed?.provider_entity_id, INVOICE_ID);

  // Identity is checked on its own, against the entity the effect attempt settled on, which is
  // what lets an intent for an entity IronWrap creates be judged at all (section 5.1, both halves).
  assert.equal(observed?.provider_entity_id, INVOICE_ID);

  // 5. The customer pays it in full. The payment is observed, the invoice it settles is re-read,
  //    and the cumulative invariant now holds with `Balance == 0` - so this is where `reconciled`
  //    is reached, by a readback and nothing else.
  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-full-1260.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3003", source: "sweep",
  }, fetcher, AT_READ);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "reconciled");

  // ...and the scheduled sweep re-reading it a day later reaches the same verdict and opens no
  // exception. The re-read is new evidence, so it records a new observation - what has to be
  // idempotent is the *verdict*, because a sweep that could flip a settled intent on an agreeing
  // read would make every cron run a fresh chance to invent a money event.
  const nextDay = new Date(AT_READ.getTime() + 25 * 60 * 60 * 1000);
  const swept = await runAccountingSweeps(env, {
    tenantId: TENANT,
    reobserve: accountingIntentReobserver(env, { auth: scenarioAuth(), fetcher }),
    now: nextDay,
  });
  assert.equal(swept.due_observations.reconciled, 1);
  assert.equal(swept.due_observations.mismatched, 0);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "reconciled");
  assert.deepEqual(await listAccountingExceptions(env, TENANT, { intentId }), []);

  // 6. And the desk shows it, through the read route the office manager actually loads.
  const detail = await call(
    env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
  );
  assert.equal(detail.status, 200);
  assert.equal((detail.body.intent as { badge: string }).badge, "reconciled");
});

test("the dispatcher is idempotent: a second run neither re-dispatches nor moves anything", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);

  const bound = binding(
    [entityRoute("Invoice", "invoice-open.json")],
    { deposit_invoice: fixtureExecutor("invoice-open.json", "Invoice", INVOICE_ID) },
  );
  await runAccountingDispatch(env, { tenantId: TENANT, binding: bound, now: AT_DISPATCH });
  const afterFirst = await readAccountingIntent(env, TENANT, intentId);
  const dispatchesAfterFirst = bound.port.dispatches.length;

  const second = await runAccountingDispatch(env, {
    tenantId: TENANT, binding: bound, now: AT_DISPATCH,
  });
  // Nothing is left in `submission_pending`, so the second run has no queue to drain and the
  // provider is not called again - which is the half of the duplicate-create defence that a
  // re-running cron has to satisfy (section 5.4).
  assert.deepEqual(second.pending, []);
  assert.deepEqual(second.dispatched, []);
  assert.equal(bound.port.dispatches.length, dispatchesAfterFirst);
  const afterSecond = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(afterSecond?.state, afterFirst?.state);
  assert.equal(afterSecond?.version, afterFirst?.version);
});

test("an unbound dispatcher reports what is waiting and dispatches nothing", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);

  const report = await runAccountingDispatch(env, { tenantId: TENANT, now: AT_DISPATCH });
  assert.equal(report.dispatcher_unbound, true);
  assert.deepEqual(report.pending, [intentId]);
  assert.deepEqual(report.dispatched, []);
  // A Worker with no provider adapter must not invent one, and must not quietly drop the queue.
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "submission_pending");
});

// ---------------------------------------------------------- one bad intent is not a stopped queue

test("a poisoned intent is recorded and skipped; every intent behind it still dispatches", async () => {
  // ELEC-73 finding 1, reproduced. `dispatchOne` had no `try`/`catch`, so any throw - a refusing
  // provider adapter, an `accounting_intent_not_submittable`, an expected-readback mismatch -
  // aborted the whole `for` loop. Because the throw happens before
  // `recordAccountingIntentSubmission`, the failing intent stays `submission_pending` and
  // `ORDER BY derived_at, intent_id` sorts it first again on the next tick: a permanent
  // head-of-line block on the tenant's entire money queue, reported as one aggregate log line with
  // no intent id in it.
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  await approvedIntent(env);
  await approvedIntent(env, { roof_job_id: "job-0002" }, "b");

  // Which one sorts first is the dispatcher's own deterministic order, so ask it rather than
  // assume it: the poison has to be on the intent that is actually at the head of the queue for
  // this to be the head-of-line repro rather than a generic isolation test.
  const queue = await runAccountingDispatch(env, { tenantId: TENANT, now: AT_DISPATCH });
  assert.equal(queue.pending.length, 2);
  const [poisoned, behind] = queue.pending as [string, string];

  const executor = fixtureExecutor("invoice-open.json", "Invoice", INVOICE_ID);
  const bound = binding([entityRoute("Invoice", "invoice-open.json")], {});
  const report = await runAccountingDispatch(env, {
    tenantId: TENANT,
    now: AT_DISPATCH,
    binding: {
      ...bound,
      // A realistic per-job adapter bug: the executor cannot be built for one intent, and building
      // it is the first thing `dispatchOne` does with the binding.
      executorFor: ({ intent }) => {
        if (intent.intent_id === poisoned) throw new Error("accounting_adapter_unavailable");
        return executor;
      },
    },
  });

  // The failure is named, with the intent it belongs to - the thing the aggregate log line could
  // never say.
  assert.deepEqual(report.failed, [
    { intent_id: poisoned, code: "accounting_adapter_unavailable" },
  ]);
  assert.equal((await readAccountingIntent(env, TENANT, poisoned))?.state, "submission_pending");

  // ...and the intent behind it in the queue was still attempted, and still dispatched. This is
  // the assertion that fails on the pre-fix code.
  assert.equal(report.dispatched.length, 1);
  assert.equal(report.dispatched[0]!.intent_id, behind);
  assert.equal(report.dispatched[0]!.status, "submitted");
  assert.equal(
    (await readAccountingIntent(env, TENANT, behind))?.state,
    "partially_settled",
    "the second intent completed its whole dispatch-readback-judge path",
  );
});

// ------------------------------------------------------ the ceiling is the server's, not the caller's

test("the derive route refuses a caller-declared ceiling and uses the tenant's policy", async () => {
  // ELEC-73 finding 2. `authority_max_amount` used to be read straight off the request body, so
  // the money plane's only ceiling check (`|total| > |maxAmount|`) compared two numbers from the
  // same untrusted request and could always be satisfied by declaring a bigger ceiling.
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);

  const declared = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: { ...derivationBody(), authority_max_amount: "999999.00" },
    idempotencyKey: "idem-derive-ceiling-0001",
  });
  assert.equal(declared.status, 400);
  assert.equal(declared.body.error, "unexpected_field");

  // With no policy recorded the tenant gets the conservative platform default - not "unlimited",
  // which is the direction an absent ceiling must never fail in.
  const intentId = await approvedIntent(env);
  assert.equal(
    (await readAccountingIntent(env, TENANT, intentId))?.authority_max_amount,
    DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT,
  );
});

test("a recorded tenant policy sets the ceiling, and a kind-specific row narrows it", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  await recordAccountingAuthorityPolicy(env, {
    tenantId: TENANT,
    kind: ACCOUNTING_AUTHORITY_POLICY_ANY_KIND,
    maxAmount: "4000.00",
    policyVersion: "v1",
    effectiveFrom: "2026-01-01",
    sourceRef: "owner decision 2026-01-01",
  }, AT_DERIVE);

  const tenantWide = await approvedIntent(env);
  assert.equal(
    (await readAccountingIntent(env, TENANT, tenantWide))?.authority_max_amount,
    "4000.00",
  );

  // A kind-specific row wins for that kind: a refund and a deposit invoice are not the same risk
  // (section 6), so narrowing one must not require moving the rest.
  await recordAccountingAuthorityPolicy(env, {
    tenantId: TENANT,
    kind: "deposit_invoice",
    maxAmount: "1300.00",
    policyVersion: "v1",
    effectiveFrom: "2026-01-01",
    sourceRef: "owner decision 2026-01-01",
  }, AT_DERIVE);
  const narrowed = await approvedIntent(env, { roof_job_id: "job-0002" }, "b");
  assert.equal(
    (await readAccountingIntent(env, TENANT, narrowed))?.authority_max_amount,
    "1300.00",
  );
});

test("a derivation above the tenant's ceiling refuses, and the caller cannot raise it", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  await recordAccountingAuthorityPolicy(env, {
    tenantId: TENANT,
    kind: ACCOUNTING_AUTHORITY_POLICY_ANY_KIND,
    // Below the fixture invoice's 1260.00 total.
    maxAmount: "1000.00",
    policyVersion: "v1",
    effectiveFrom: "2026-01-01",
    sourceRef: "owner decision 2026-01-01",
  }, AT_DERIVE);

  const refused = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-ceiling-0002",
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "effect_policy_amount_ceiling_exceeded");

  // And the escape hatch is closed: sending a bigger ceiling alongside is a refusal about the
  // request's shape, never a derivation at the caller's number.
  const retried = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: { ...derivationBody(), authority_max_amount: "5000.00" },
    idempotencyKey: "idem-derive-ceiling-0003",
  });
  assert.equal(retried.status, 400);
  assert.equal(retried.body.error, "unexpected_field");
});

// ------------------------------------------------------- the sweep that makes a stall visible

test("an intent stuck in submission_pending is surfaced by the staleness sweep, and a re-run is a no-op", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);

  // Nothing dispatched it. Before ELEC-72 no sweep looked at `submission_pending` at all, so this
  // is exactly the state ELEC-71 found an invoice sleeping in forever.
  // Judged against the row's own `updated_at`: the routes stamp wall-clock time, so a fixed
  // instant here would make the test depend on the day it runs.
  const approvedAt = Date.parse((await readAccountingIntent(env, TENANT, intentId))!.updated_at);
  const fresh = await sweepStuckAccountingDispatches(env, {
    tenantId: TENANT,
    now: new Date(approvedAt + 60_000),
  });
  assert.equal(fresh.scanned, 1);
  assert.deepEqual(fresh.stuck, [], "a minute old is in flight, not stuck");

  const later = new Date(approvedAt + 2 * 60 * 60 * 1000);
  const stuck = await sweepStuckAccountingDispatches(env, { tenantId: TENANT, now: later });
  assert.equal(stuck.stuck.length, 1);
  assert.equal(stuck.stuck[0]!.intent_id, intentId);
  assert.equal(stuck.stuck[0]!.state, "submission_pending");

  // The full sweep entry point carries it, and running it twice changes nothing: a timer is not
  // evidence, so this sweep reports and never writes.
  const first = await runAccountingSweeps(env, { tenantId: TENANT, now: later });
  const second = await runAccountingSweeps(env, { tenantId: TENANT, now: later });
  assert.equal(first.stuck_dispatches.stuck.length, 1);
  assert.deepEqual(second.stuck_dispatches, first.stuck_dispatches);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.version, 2);
});

// --------------------------------------------- journey 2: authorize, reverse, and close honestly

test("journey 2: authorizing a compensation dispatches the reversal and closes the exception on it", async () => {
  const { env } = apiTestEnv();
  const { intentId, exceptionId } = await overpaidThroughRoutes(env);

  // 1. Authorize, over the real route. Before ELEC-72 this returned a plan and persisted nothing
  //    but a receipt fingerprint, so the reversal it described could never be run by anything.
  const original = await readAccountingIntent(env, TENANT, intentId);
  const authorized = await call(
    env, "owner", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    {
      body: { version: original!.version, remedy: "credit_memo_issued" },
      idempotencyKey: "idem-compensate-000000001",
    },
  );
  assert.equal(authorized.status, 202);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "compensating");

  const authorization = await readAccountingCompensationAuthorizationByException(
    env, TENANT, exceptionId,
  );
  assert.ok(authorization, "the authorization is evidence, not a value in a response body");
  assert.equal(authorization!.magnitude_amount, "240.00");
  assert.equal(authorization!.authorized_by_user_id, OWNER_ID);

  // 2. The dispatcher derives the reversal, approves it under that authorization, and runs it.
  const report = await runAccountingCompensationDispatch(env, {
    tenantId: TENANT,
    binding: binding(
      [entityRoute("CreditMemo", "credit-memo-240.json")],
      { credit_memo: fixtureExecutor("credit-memo-240.json", "CreditMemo", CREDIT_MEMO_ID) },
    ),
    now: AT_COMPENSATE,
  });
  assert.deepEqual(report.refused, []);
  assert.equal(report.dispatched.length, 1);
  assert.equal(report.dispatched[0]!.status, "submitted");

  // 3. The original is `compensated` only because the ledger accepted the reversal, and the
  //    exception is closed on that effect rather than on a claim about it.
  assert.equal(report.dispatched[0]!.original_state, "compensated");
  const closed = await readAccountingException(env, TENANT, exceptionId);
  assert.equal(closed?.status, "resolved");
  assert.equal(closed?.resolution_action, "credit_memo_issued");
  const reversal = await readAccountingIntent(env, TENANT, authorization!.reversal_intent_id);
  assert.equal(closed?.compensating_effect_id, reversal?.effect_id);
  assert.equal(reversal?.compensates_intent_id, intentId);
  assert.equal(reversal?.total_amount, "-240.00");
});

test("the fabricated-reference repro is refused: closing an exception now needs a real reversal", async () => {
  const { env } = apiTestEnv();
  const { exceptionId } = await overpaidThroughRoutes(env);
  const path = `/api/v1/accounting/exceptions/${encodeURIComponent(exceptionId)}/resolve`;

  // Naming no effect at all is still the first refusal, unchanged.
  const unlinked = await call(env, "accounting", "POST", path, {
    body: { resolution_action: "credit_memo_issued" },
  });
  assert.equal(unlinked.status, 400);
  assert.equal(unlinked.body.error, "accounting_exception_compensating_effect_required");

  // ELEC-71's exact repro, typed into the live UI's "Reference of the reversal in QuickBooks"
  // field for a genuine $240 overpayment, which closed the exception and painted the badge
  // "compensated" for money nothing had reversed anywhere.
  const fabricated = await call(env, "accounting", "POST", path, {
    body: {
      resolution_action: "credit_memo_issued",
      compensating_effect_id: "credit-memo-cm-e2e-000001",
    },
    idempotencyKey: "idem-resolve-00000000001",
  });
  assert.equal(fabricated.status, 409);
  assert.equal(fabricated.body.error, "accounting_exception_compensating_effect_unknown");
  assert.equal((await readAccountingException(env, TENANT, exceptionId))?.status, "open");

  // A remedy with no dispatch path anywhere refuses by name rather than accepting a reference it
  // has no way to check.
  const undispatchable = await call(env, "accounting", "POST", path, {
    body: {
      resolution_action: "void_provider_entity",
      compensating_effect_id: "void-of-payment-3005",
    },
    idempotencyKey: "idem-resolve-00000000002",
  });
  assert.equal(undispatchable.status, 409);
  assert.equal(undispatchable.body.error, "accounting_exception_remedy_dispatch_unavailable");
  assert.equal((await readAccountingException(env, TENANT, exceptionId))?.status, "open");
});

test("a real reversal of a different intent does not close this exception", async () => {
  const { env } = apiTestEnv();
  const { intentId, exceptionId } = await overpaidThroughRoutes(env);
  await authorizeAndDispatch(env, intentId, exceptionId);
  const authorization = await readAccountingCompensationAuthorizationByException(
    env, TENANT, exceptionId,
  );
  const reversal = await readAccountingIntent(env, TENANT, authorization!.reversal_intent_id);
  assert.ok(reversal?.effect_id, "the reversal really settled through the port");

  // A second job, with its own exception. Raised the way a drifted observation raises one, because
  // what is under test is the resolve route's check and not how the queue entry got there.
  const otherIntentId = await approvedIntent(env, { roof_job_id: "job-0002" }, "b");
  const { exception: other } = await raiseAccountingException(env, {
    tenantId: TENANT,
    subjectRef: intentSubjectRef(otherIntentId),
    intentId: otherIntentId,
    reasonCode: "provider_overpayment",
    detail: { remedies: [{ action: "credit_memo_issued", alternatives: ["refund_issued"] }] },
  }, AT_COMPENSATE);

  // Borrowing a real reversal to close somebody else's exception is the subtler version of the
  // same lie, and it is refused on what the reversal actually reverses rather than on whether the
  // string exists anywhere in the ledger.
  const borrowed = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/exceptions/${encodeURIComponent(other.exception_id)}/resolve`,
    {
      body: {
        resolution_action: "credit_memo_issued",
        compensating_effect_id: reversal!.effect_id,
      },
      idempotencyKey: "idem-resolve-00000000003",
    },
  );
  assert.equal(borrowed.status, 409);
  assert.equal(
    borrowed.body.error,
    "accounting_exception_compensating_effect_intent_mismatch",
  );
  assert.equal(
    (await readAccountingException(env, TENANT, other.exception_id))?.status,
    "open",
  );
});

test("an exception with no authorization of its own cannot be closed on a sibling's reversal", async () => {
  // ELEC-73 finding 3. `verifyCompensatingEffect` skipped the amount check entirely when no
  // authorization row existed for the exception being resolved, leaving only "reverses the same
  // original intent, and is settled" - which two exceptions on one intent both satisfy. So one
  // real $240 credit memo could close both of them, and the second exception's badge would read
  // `compensated` for money nobody reversed twice.
  const { env } = apiTestEnv();
  const { intentId, exceptionId } = await overpaidThroughRoutes(env);
  await authorizeAndDispatch(env, intentId, exceptionId);
  const authorization = await readAccountingCompensationAuthorizationByException(
    env, TENANT, exceptionId,
  );
  const reversal = await readAccountingIntent(env, TENANT, authorization!.reversal_intent_id);
  assert.ok(reversal?.effect_id, "the reversal really settled through the port");

  // A second exception on the *same* intent, so the intent-mismatch check above passes and this
  // is genuinely the gap that check leaves open.
  const { exception: sibling } = await raiseAccountingException(env, {
    tenantId: TENANT,
    subjectRef: intentSubjectRef(intentId),
    intentId,
    reasonCode: "expected_observed_mismatch",
    detail: { remedies: [{ action: "credit_memo_issued", alternatives: ["refund_issued"] }] },
  }, AT_COMPENSATE);

  const reused = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/exceptions/${encodeURIComponent(sibling.exception_id)}/resolve`,
    {
      body: {
        resolution_action: "credit_memo_issued",
        compensating_effect_id: reversal!.effect_id,
      },
      idempotencyKey: "idem-resolve-00000000004",
    },
  );
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "accounting_exception_compensating_effect_unauthorized");
  assert.equal(
    (await readAccountingException(env, TENANT, sibling.exception_id))?.status,
    "open",
    "an exception nobody authorized a remedy for stays in the queue",
  );

  // The first exception, which *was* authorized, is still resolved - the check refuses the
  // unauthorized close without weakening the authorized one.
  assert.equal((await readAccountingException(env, TENANT, exceptionId))?.status, "resolved");
});

// ------------------------------------------------------------------------------------ helpers

/** Derive and approve one deposit invoice through the routes, leaving it in `submission_pending`. */
async function approvedIntent(
  env: AppEnv,
  overrides: Record<string, unknown> = {},
  suffix = "",
): Promise<string> {
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(overrides),
    idempotencyKey: `idem-derive-0000000000${suffix || "1"}`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const derived = await readAccountingIntent(env, TENANT, intentId);
  const approved = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    {
      body: { version: derived!.version },
      idempotencyKey: `idem-approve-000000000${suffix || "1"}`,
      // A second accountant, because the derive route now attributes the derivation to its own
      // session and section 6 refuses the deriving user at approve time (ELEC-77 defect 1).
      userId: SECOND_ACCOUNTANT_ID,
    },
  );
  assert.equal(approved.status, 202, JSON.stringify(approved.body));
  return intentId;
}

/**
 * The whole of journey 1, then a drifted observation that over-pays it by 240.00.
 *
 * Every step is a real route or the real dispatcher, so the exception this leaves behind is the one
 * a real over-payment would leave behind.
 */
async function overpaidThroughRoutes(
  env: AppEnv,
  options: { suffix?: string; customerRef?: string } = {},
): Promise<{ intentId: string; exceptionId: string }> {
  const suffix = options.suffix ?? "";
  if (!(await recordedSnapshot.has(env))) await seedTaxSnapshot(env);
  const intentId = await approvedIntent(
    env,
    options.customerRef === undefined ? {} : { customer_ref: options.customerRef },
    suffix,
  );
  const invoiceId = suffix === "" ? INVOICE_ID : "2002";
  await runAccountingDispatch(env, {
    tenantId: TENANT,
    binding: binding(
      [entityRoute("Invoice", "invoice-open.json")],
      { deposit_invoice: fixtureExecutor("invoice-open.json", "Invoice", invoiceId) },
    ),
    now: AT_DISPATCH,
  });

  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);

  const [exception] = await listAccountingExceptions(env, TENANT, { intentId });
  assert.ok(exception, "a live over-payment exception");
  return { intentId, exceptionId: exception!.exception_id };
}

/** Authorize a credit memo for one exception and let the dispatcher run it. */
async function authorizeAndDispatch(env: AppEnv, intentId: string, exceptionId: string) {
  const original = await readAccountingIntent(env, TENANT, intentId);
  const authorized = await call(
    env, "owner", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    {
      body: { version: original!.version, remedy: "credit_memo_issued" },
      idempotencyKey: `idem-compensate-${exceptionId}`.slice(0, 120).padEnd(16, "0"),
    },
  );
  assert.equal(authorized.status, 202, JSON.stringify(authorized.body));
  return await runAccountingCompensationDispatch(env, {
    tenantId: TENANT,
    binding: binding(
      [entityRoute("CreditMemo", "credit-memo-240.json")],
      { credit_memo: fixtureExecutor("credit-memo-240.json", "CreditMemo", CREDIT_MEMO_ID) },
    ),
    now: AT_COMPENSATE,
  });
}

/** Seed the snapshot once per env; a second identical snapshot is a no-op but a wasted round trip. */
const recordedSnapshot = {
  async has(env: AppEnv): Promise<boolean> {
    const row = await env.DB.prepare(
      `SELECT 1 AS present FROM tax_policy_snapshots WHERE tenant_id = ? LIMIT 1`,
    ).bind(TENANT).first<{ present: number }>();
    return row !== null;
  },
};

void ACCOUNTANT_ID;
void SECOND_ACCOUNTANT_ID;
