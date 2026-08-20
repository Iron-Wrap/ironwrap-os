// Slice S11. The re-observation rail: `reconciled` reachable, and the drift loop real.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4 and 8.1. ELEC-77 proved on the
// running stack that S8a's dispatcher worked and that everything after it did not: a genuinely
// dispatched, fully-matching invoice stopped at `partially_settled` and could go no further,
// because no production surface re-read an already-submitted provider entity. `reconciled` was
// unreachable and the reconciliation-drift exception - the one ELEC-75 hardened against a
// fabricated reversal reference - could not be raised at all, so that hardening had never been
// exercised end to end.
//
// Everything below therefore enters through a surface a person or a cron can actually reach: the
// BFF route via `handleAuthenticatedRoute`, or `runAccountingSweeps` with the same reobserver
// `index.ts` binds on the frequent cron. The single seam any test replaces is the credential -
// project rule 5 forbids a live provider - and behind it sits the real `readProviderEntity`, the
// real payment ingest and the real S3 engine.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REALM,
  TENANT,
  fakeIntuit,
  quickBooksEntity,
  stubAuthPort,
} from "./accounting-fixture.ts";
import {
  ACCOUNTANT_ID,
  SECOND_ACCOUNTANT_ID,
  apiTestEnv,
  call,
} from "./accounting-api-fixture.ts";
import { entityRoute, scenarioAuth } from "./accounting-scenario-fixture.ts";
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import type {
  MoneyEffectExecutor,
} from "../src/accounting-effect-port.ts";
import {
  runAccountingCompensationDispatch,
  runAccountingDispatch,
  type AccountingDispatchBinding,
} from "../src/accounting-dispatch.ts";
import { readAccountingIntent } from "../src/accounting-intents.ts";
import {
  listAccountingExceptions,
  readAccountingException,
} from "../src/accounting-exceptions.ts";
import { readAccountingCompensationAuthorizationByException } from "../src/accounting-compensation-authorizations.ts";
import { listAccountingObservations } from "../src/accounting-reconciliation.ts";
import { normalizeProviderEntity } from "../src/accounting-normalizers.ts";
import { projectAccountingIntent } from "../src/accounting-desk.ts";
import { recordTaxPolicySnapshot } from "../src/accounting-tax-snapshots.ts";
import { runAccountingSweeps } from "../src/accounting-sweeps.ts";
import {
  accountingIntentReobserver,
  reobserveAccountingIntent,
  resolveAccountingObservationBinding,
  type AccountingObservationBinding,
} from "../src/accounting-reobservation.ts";
import { linkedPaymentIds } from "../src/accounting-payments.ts";
import { quickBooksAuthPort } from "../src/quickbooks-final-invoice.ts";

const AT_DERIVE = new Date("2026-08-19T12:00:00.000Z");
const AT_DISPATCH = new Date("2026-08-19T12:05:00.000Z");
/** Past the 24-hour staleness window `DEFAULT_STALE_OBSERVATION_SECONDS` sets, so a sweep looks. */
const AT_REOBSERVE = new Date("2026-08-22T12:00:00.000Z");
/** The reversal's own `TxnDate` is the day it is dispatched, and the fixture credit memo's is this. */
const AT_COMPENSATE = new Date("2026-08-21T12:00:00.000Z");
/** A further day on, so the second sweep is due again rather than inside the window. */
const NEXT_DAY = new Date("2026-08-23T13:00:00.000Z");

const INVOICE_ID = "2001";
const CREDIT_MEMO_ID = "4002";

// -------------------------------------------------------------------------------- the scenario

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

function derivationBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "deposit_invoice",
    roof_job_id: "job-0001",
    realm_id: REALM,
    customer_ref: "42",
    item_ref: "7",
    tax_code_ref: "TAX",
    subtotal: "1200.00",
    tax_amount: "60.00",
    txn_date: "2026-08-19",
    due_date: "2026-09-18",
    jurisdiction: "CA-AB",
    tax_code: "GST",
    source_documents: [{ id: "quote-0001", version: 3 }],
    ...overrides,
  };
}

function fixtureExecutor(
  entityFile: string,
  entityType: "Invoice" | "CreditMemo",
  providerExternalId: string,
): MoneyEffectExecutor<{ providerEntityId: string }> {
  const observed = normalizeProviderEntity({
    realmId: REALM,
    entityType,
    payload: quickBooksEntity(entityFile, entityType),
  });
  return {
    async dispatch() {
      return {
        outcome: "accepted",
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

function dispatchBinding(
  routes: Parameters<typeof fakeIntuit>[0],
  executorByKind: Record<string, MoneyEffectExecutor<{ providerEntityId: string }>>,
): AccountingDispatchBinding & { port: TestMoneyEffectPort } {
  const { fetcher } = fakeIntuit(routes);
  const port = new TestMoneyEffectPort();
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

/** The observation binding, over whatever fixtures this scenario wants the provider to hold. */
function observationBinding(
  routes: Parameters<typeof fakeIntuit>[0],
): AccountingObservationBinding & { calls: () => number } {
  const { fetcher, calls } = fakeIntuit(routes);
  return { auth: scenarioAuth(), fetcher, calls: () => calls.length };
}

/**
 * Everything ELEC-77 could already do, through the same routes it used: derive, approve, dispatch.
 *
 * It stops exactly where ELEC-77 stopped - a genuinely posted invoice sitting at
 * `partially_settled` with a real provider entity id - so every test below starts from the state
 * the shipped product could actually reach and nothing is hand-seeded past it.
 */
async function dispatchedInvoice(env: AppEnv, suffix = "1"): Promise<string> {
  await seedTaxSnapshot(env);
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: `idem-derive-reobs-${suffix}`.padEnd(16, "0"),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const derived = await readAccountingIntent(env, TENANT, intentId);

  const approved = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    {
      body: { version: derived!.version },
      idempotencyKey: `idem-approve-reobs-${suffix}`.padEnd(16, "0"),
      userId: SECOND_ACCOUNTANT_ID,
    },
  );
  assert.equal(approved.status, 202, JSON.stringify(approved.body));

  const report = await runAccountingDispatch(env, {
    tenantId: TENANT,
    binding: dispatchBinding(
      [entityRoute("Invoice", "invoice-open.json")],
      { deposit_invoice: fixtureExecutor("invoice-open.json", "Invoice", INVOICE_ID) },
    ),
    now: AT_DISPATCH,
  });
  assert.equal(report.dispatched[0]!.verdict, "partially_settled");
  // The ceiling ELEC-77 hit, restated as the starting line: this is as far as the shipped product
  // could carry an invoice, however much of it the customer had paid.
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "partially_settled");
  return intentId;
}

/** `POST /api/v1/accounting/intents/{id}/reconcile` with a bound (or deliberately absent) provider. */
async function reconcileThroughRoute(
  env: AppEnv,
  intentId: string,
  deps: { observation?: AccountingObservationBinding | null },
  idempotencyKey: string,
) {
  const intent = await readAccountingIntent(env, TENANT, intentId);
  return await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/reconcile`,
    {
      body: { version: intent!.version },
      idempotencyKey: idempotencyKey.padEnd(16, "0"),
      deps: { accounting: deps },
    },
  );
}

// ------------------------------------------------------------ the route reaches `reconciled`

test("the reconcile route re-reads the provider and carries a paid invoice to reconciled", async () => {
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);

  // The customer paid it in full. The provider now holds a zero-balance invoice that names the
  // Payment which settled it, and the Payment itself - both read by exact id, nothing searched.
  const provider = observationBinding([
    entityRoute("Invoice", "invoice-paid-linked.json"),
    entityRoute("Payment", "payment-full-1260.json"),
  ]);
  const response = await reconcileThroughRoute(
    env, intentId, { observation: provider }, "idem-reconcile-a",
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const reRead = response.body.re_read as Record<string, unknown>;
  assert.equal(reRead.status, "judged");
  assert.equal(reRead.verdict, "reconciled");
  assert.equal(reRead.reason_code, null);
  // The Payment the invoice declared, observed because the invoice declared it. Without this the
  // cumulative invariant has nothing on the settled side and a paid invoice reads as broken.
  assert.equal(reRead.payments_observed, 1);
  assert.equal(reRead.exception_id, null);

  const settled = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(settled?.state, "reconciled");
  assert.equal(settled?.settled_amount, "1260.00");
  assert.ok(settled?.provider_reconciled_at, "reconciled is stamped by a readback, not a clock");
  assert.equal(settled?.observed_sha256, settled?.expected_sha256);
  assert.deepEqual(await listAccountingExceptions(env, TENANT, { intentId }), []);

  // ...and the desk says so, through the route the office manager's phone actually loads.
  const detail = await call(
    env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
  );
  assert.equal((detail.body.intent as { badge: string }).badge, "reconciled");
  assert.equal(
    (detail.body.intent as { next_step: string }).next_step,
    "Matched against QuickBooks. Nothing to do.",
  );
});

test("an unbound tenant gets a receipt and an honest refusal, never an unchecked verdict", async () => {
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);

  const response = await reconcileThroughRoute(
    env, intentId, { observation: null }, "idem-reconcile-b",
  );

  // 202, not 200: the command was accepted and recorded, and the work it names has not happened.
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.deepEqual(response.body.re_read, {
    status: "provider_unbound",
    verdict: null,
    reason_code: null,
  });

  const intent = await readAccountingIntent(env, TENANT, intentId);
  // `reconciliation_required` is the truth here: it needs re-reading, and we could not.
  assert.equal(intent?.state, "reconciliation_required");
  assert.equal(
    (await call(
      env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
    ).then((r) => (r.body.intent as { next_step: string }).next_step)),
    "This needs re-reading against QuickBooks before it can be trusted.",
  );
  // Nothing was read, so nothing was recorded as observed.
  assert.equal((await listAccountingObservations(env, TENANT, { intentId })).length, 1);
});

test("the reconcile route wires its own binding when nobody hands it one", async () => {
  // The default path, with no `deps` at all: production resolves the tenant's own connection, and
  // this env has none. What is under test is that the default is *wired* - a route that had left
  // the resolver unreferenced would answer exactly like the injected-null case and prove nothing,
  // so the assertion is paired with the resolver's own contract below.
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);
  const intent = await readAccountingIntent(env, TENANT, intentId);
  const response = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/reconcile`,
    { body: { version: intent!.version }, idempotencyKey: "idem-reconcile-default00" },
  );
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal((response.body.re_read as { status: string }).status, "provider_unbound");
  assert.equal(await resolveAccountingObservationBinding(env, { tenantId: TENANT }), null);
});

// ---------------------------------------------------------------- the cron reaches `reconciled`

test("the due-observation sweep re-reads through the bound rail and reconciles what it finds", async () => {
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);
  const provider = observationBinding([
    entityRoute("Invoice", "invoice-paid-linked.json"),
    entityRoute("Payment", "payment-full-1260.json"),
  ]);

  const swept = await runAccountingSweeps(env, {
    tenantId: TENANT,
    // Exactly what `index.ts` binds on the frequent cron, over a synthetic Intuit.
    reobserve: accountingIntentReobserver(env, provider),
    now: AT_REOBSERVE,
  });

  assert.equal(swept.due_observations.reader_unbound, false);
  assert.equal(swept.due_observations.reread, 1);
  assert.equal(swept.due_observations.reconciled, 1);
  assert.equal(swept.due_observations.mismatched, 0);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "reconciled");

  // A second run inside the staleness window is a no-op: nothing is due, so nothing is read and no
  // version moves. That is what keeps a five-minute cron from walking a settled intent forward.
  const versionAfterFirst = (await readAccountingIntent(env, TENANT, intentId))!.version;
  const callsAfterFirst = provider.calls();
  const again = await runAccountingSweeps(env, {
    tenantId: TENANT,
    reobserve: accountingIntentReobserver(env, provider),
    now: new Date(AT_REOBSERVE.getTime() + 60_000),
  });
  assert.equal(again.due_observations.due.length, 0);
  assert.equal(again.due_observations.reread, 0);
  assert.equal(provider.calls(), callsAfterFirst);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))!.version, versionAfterFirst);

  // ...and a day later it looks again, agrees, and still opens nothing. A re-read is new evidence,
  // so it records a new observation; what has to be idempotent is the *verdict*.
  const tomorrow = await runAccountingSweeps(env, {
    tenantId: TENANT,
    reobserve: accountingIntentReobserver(env, provider),
    now: NEXT_DAY,
  });
  assert.equal(tomorrow.due_observations.reread, 1);
  assert.equal(tomorrow.due_observations.reconciled, 1);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "reconciled");
  assert.deepEqual(await listAccountingExceptions(env, TENANT, { intentId }), []);
});

test("an intent still waiting on the dispatcher is surfaced, not re-read", async () => {
  // `submission_pending` has no provider entity to read by exact id, so the due sweep leaves it
  // alone and the stuck sweep is what names it. Preserved from S8a, and worth pinning here: the
  // rail now has a reader, and a reader that reached for an entity that does not exist yet would
  // manufacture a `not_found` exception for an invoice nobody has posted.
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-stuck-0001",
  });
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const derived = await readAccountingIntent(env, TENANT, intentId);
  await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    {
      body: { version: derived!.version },
      idempotencyKey: "idem-approve-stuck-001",
      userId: SECOND_ACCOUNTANT_ID,
    },
  );

  const provider = observationBinding([entityRoute("Invoice", "invoice-paid-linked.json")]);
  const swept = await runAccountingSweeps(env, {
    tenantId: TENANT,
    reobserve: accountingIntentReobserver(env, provider),
    now: NEXT_DAY,
  });
  assert.equal(swept.due_observations.scanned, 0);
  assert.equal(provider.calls(), 0, "nothing was asked of the provider");
  assert.equal(swept.stuck_dispatches.stuck.length, 1);
  assert.equal(swept.stuck_dispatches.stuck[0]!.intent_id, intentId);

  // Freshly approved, so the desk is right to be calm about it.
  const detail = await call(
    env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
  );
  assert.equal(
    (detail.body.intent as { next_step: string }).next_step,
    "Being sent to QuickBooks. Nothing else to do yet.",
  );

  // ...and stops being calm once it has been waiting as long as the stuck sweep's own window,
  // which is the copy defect ELEC-77 photographed: the cron was already logging a stalled
  // dispatcher while the screen said there was nothing to do.
  const waiting = await readAccountingIntent(env, TENANT, intentId);
  const stuckFor = new Date(Date.parse(waiting!.updated_at) + 45 * 60 * 1000);
  assert.equal(
    projectAccountingIntent(waiting!, stuckFor).next_step,
    "This has been waiting to reach QuickBooks longer than it should. "
      + "Tell whoever runs the system.",
  );
});

// --------------------------------------------------------------------------- the drift loop

test("a re-observation that disagrees raises the drift exception through the production path", async () => {
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);

  // First, reconcile it for real, so what follows is genuinely *drift* and not a first mismatch.
  await reconcileThroughRoute(env, intentId, {
    observation: observationBinding([
      entityRoute("Invoice", "invoice-paid-linked.json"),
      entityRoute("Payment", "payment-full-1260.json"),
    ]),
  }, "idem-reconcile-c");
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "reconciled");

  // Somebody edited the posted invoice in QuickBooks: same entity, different figures.
  const drifted = await reconcileThroughRoute(env, intentId, {
    observation: observationBinding([
      entityRoute("Invoice", "invoice-drifted-linked.json"),
      entityRoute("Payment", "payment-full-1260.json"),
    ]),
  }, "idem-reconcile-d");

  assert.equal(drifted.status, 200, JSON.stringify(drifted.body));
  const reRead = drifted.body.re_read as Record<string, unknown>;
  assert.equal(reRead.verdict, "mismatch");
  // Not `expected_observed_mismatch`: this entity agreed once, so the disagreement is an accounting
  // event about a posted transaction (section 5.4) and is reported as one.
  assert.equal(reRead.reason_code, "provider_readback_drift");
  assert.ok(reRead.exception_id, "the drift exception exists");

  const intent = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(intent?.state, "reconciliation_required");

  const exception = await readAccountingException(env, TENANT, reRead.exception_id as string);
  assert.equal(exception?.reason_code, "provider_readback_drift");
  assert.equal(exception?.status, "open");
  // Both hashes are on the queue entry, so the accountant is shown what moved rather than told.
  assert.ok(exception?.expected_sha256);
  assert.ok(exception?.observed_sha256);
  assert.notEqual(exception?.expected_sha256, exception?.observed_sha256);
});

test("the $240 over-payment loop: raised by a real re-observation, closed only by a real reversal", async () => {
  // The whole of ELEC-77's blocked check 3, which could not be run at all because nothing raised
  // the exception through a production surface. Every step here is a route or the real dispatcher.
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);

  // The customer pays 1500.00 against a 1260.00 invoice. The invoice's balance is zero and it names
  // the Payment; the Payment is 240.00 larger than what was posted.
  const overpaid = await reconcileThroughRoute(env, intentId, {
    observation: observationBinding([
      entityRoute("Invoice", "invoice-overpaid-linked.json"),
      entityRoute("Payment", "payment-overpaid-1500.json"),
    ]),
  }, "idem-reconcile-e");
  assert.equal(overpaid.status, 200, JSON.stringify(overpaid.body));
  const reRead = overpaid.body.re_read as Record<string, unknown>;
  assert.equal(reRead.verdict, "mismatch");
  assert.equal(reRead.reason_code, "provider_overpayment");

  const exceptionId = reRead.exception_id as string;
  assert.ok(exceptionId, "a live over-payment exception, raised by a production re-read");
  const path = `/api/v1/accounting/exceptions/${encodeURIComponent(exceptionId)}/resolve`;

  // ELEC-71's exact repro, typed into "Reference of the reversal in QuickBooks" for money nothing
  // had reversed anywhere. Refused now, and this is the first time it has been refused against an
  // exception a production surface actually raised.
  const fabricated = await call(env, "accounting", "POST", path, {
    body: {
      resolution_action: "credit_memo_issued",
      compensating_effect_id: "credit-memo-cm-fabricated-01",
    },
    idempotencyKey: "idem-resolve-fake-00001",
  });
  assert.equal(fabricated.status, 409, JSON.stringify(fabricated.body));
  assert.equal(fabricated.body.error, "accounting_exception_compensating_effect_unknown");
  assert.equal((await readAccountingException(env, TENANT, exceptionId))?.status, "open");

  // The real path: an owner authorizes the credit memo, and the compensation dispatcher runs it.
  const original = await readAccountingIntent(env, TENANT, intentId);
  const authorized = await call(
    env, "owner", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    {
      body: { version: original!.version, remedy: "credit_memo_issued" },
      idempotencyKey: "idem-compensate-000001",
    },
  );
  assert.equal(authorized.status, 202, JSON.stringify(authorized.body));
  await runAccountingCompensationDispatch(env, {
    tenantId: TENANT,
    binding: dispatchBinding(
      [entityRoute("CreditMemo", "credit-memo-240.json")],
      { credit_memo: fixtureExecutor("credit-memo-240.json", "CreditMemo", CREDIT_MEMO_ID) },
    ),
    now: AT_COMPENSATE,
  });

  const authorization = await readAccountingCompensationAuthorizationByException(
    env, TENANT, exceptionId,
  );
  const reversal = await readAccountingIntent(env, TENANT, authorization!.reversal_intent_id);
  assert.ok(reversal?.effect_id, "the reversal really settled through the port");

  // ...and the same field, with the reference of the reversal that genuinely happened, closes it.
  const genuine = await call(env, "accounting", "POST", path, {
    body: {
      resolution_action: "credit_memo_issued",
      compensating_effect_id: reversal!.effect_id,
    },
    idempotencyKey: "idem-resolve-real-00001",
  });
  assert.equal(genuine.status, 200, JSON.stringify(genuine.body));
  assert.equal((await readAccountingException(env, TENANT, exceptionId))?.status, "resolved");
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "compensated");
});

// ------------------------------------------------------------------- what the rail refuses to do

test("a provider outage writes nothing at all: not an observation, not a verdict, not an exception", async () => {
  const { env } = apiTestEnv();
  const intentId = await dispatchedInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);
  const observationsBefore = (await listAccountingObservations(env, TENANT, { intentId })).length;

  const outcome = await reobserveAccountingIntent(
    env,
    observationBinding([entityRoute("Invoice", "invoice-paid-linked.json", { networkError: true })]),
    { tenantId: TENANT, intentId, source: "sweep" },
    AT_REOBSERVE,
  );

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.detail_code, "provider_unreachable");
  assert.equal(outcome.verdict, null);
  assert.deepEqual(outcome.payments, []);
  const after = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(after?.state, before?.state);
  assert.equal(after?.version, before?.version);
  assert.equal(
    (await listAccountingObservations(env, TENANT, { intentId })).length,
    observationsBefore,
  );
  assert.deepEqual(await listAccountingExceptions(env, TENANT, { intentId }), []);
});

test("an intent that never reached the provider has nothing to re-read, and says so", async () => {
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-noident-001",
  });
  const intentId = (created.body.intent as { intent_id: string }).intent_id;

  await assert.rejects(
    () => reobserveAccountingIntent(
      env,
      observationBinding([entityRoute("Invoice", "invoice-paid-linked.json")]),
      { tenantId: TENANT, intentId, source: "sweep" },
      AT_REOBSERVE,
    ),
    /accounting_intent_provider_identity_missing/,
  );
});

// ------------------------------------------------------------------------------- the binding

test("unconfigured QuickBooks and an unconnected tenant both mean no binding", async () => {
  const configured = {
    QB_OAUTH_ENABLED: "true",
    QB_API_ENVIRONMENT: "sandbox",
    QB_API_MINOR_VERSION: "75",
    QB_CLIENT_ID: "local-development-client-id",
    QB_CLIENT_SECRET: "local-development-client-secret",
    QB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    QB_TOKEN_ENCRYPTION_KEY_VERSION: "v1",
    APP_PUBLIC_ORIGIN: "http://localhost:5173",
  };
  const { env } = apiTestEnv();

  // Unconfigured: there is no auth port at all.
  assert.equal(quickBooksAuthPort(env), null);
  assert.equal(await resolveAccountingObservationBinding(env, { tenantId: TENANT }), null);

  // Configured but never connected. The distinction matters: configuring QuickBooks is not the
  // same as connecting it, and a tenant that never finished the handshake must keep reporting what
  // is due and reading nothing - with no crash and no invented realm.
  const withConfig = { ...env, ...configured } as AppEnv;
  assert.ok(quickBooksAuthPort(withConfig), "QuickBooks is configured on this env");
  assert.equal(await resolveAccountingObservationBinding(withConfig, { tenantId: TENANT }), null);
});

// ------------------------------------------------------------------- what an invoice declares

test("linked payments are read from the invoice's own declaration, and only Payments", () => {
  assert.deepEqual(
    linkedPaymentIds(quickBooksEntity("invoice-paid-linked.json", "Invoice")),
    ["3003"],
  );
  // An invoice that declares nothing is not a broken invoice: it is one nobody has paid.
  assert.deepEqual(linkedPaymentIds(quickBooksEntity("invoice-open.json", "Invoice")), []);
  // Other linked transaction types are not settlements and are not followed.
  assert.deepEqual(
    linkedPaymentIds({ LinkedTxn: [{ TxnId: "77", TxnType: "Estimate" }] }),
    [],
  );
  assert.deepEqual(linkedPaymentIds(null), []);
  assert.deepEqual(linkedPaymentIds({ LinkedTxn: "not-an-array" }), []);
  // The same payment declared twice is one payment.
  assert.deepEqual(
    linkedPaymentIds({
      LinkedTxn: [
        { TxnId: "3003", TxnType: "Payment" },
        { TxnId: "3003", TxnType: "Payment" },
      ],
    }),
    ["3003"],
  );
});

void ACCOUNTANT_ID;
void stubAuthPort;
