// Cover for the production dispatcher binding (ELEC-75).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 3.1, 5.1 and 8.1. ELEC-74 proved on the
// running stack that ELEC-72's fix stopped one layer short: `index.ts` called
// `runAccountingDispatch(env, { tenantId })` with no `binding`, no production `MoneyEffectPort`
// existed anywhere in `src/`, and an approved intent therefore sat in `submission_pending`
// permanently while the desk read "Being sent to QuickBooks. Nothing else to do yet."
//
// Two things are under test, and they are deliberately separated:
//
//   * **The unbound answers**, which must stay exactly what ELEC-74 observed for a tenant that has
//     not connected QuickBooks: report what is waiting, dispatch nothing, change nothing.
//   * **The bound path**, driven through the *real* production port (`externalEffectMoneyPort`,
//     i.e. the universal effect ledger) and the *real* production adapter
//     (`accountingIntentExecutor`), against the synthetic Intuit double. The one seam replaced is
//     the OAuth token lookup, which is `quickbooks-final-invoice.ts`'s own already-covered path -
//     project rule 5 means no test may reach a real provider, so the credential leg is proven on
//     the local stack with a loopback double instead.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REALM, TENANT, fakeIntuit, quickBooksEntity, stubAuthPort } from "./accounting-fixture.ts";
import { SECOND_ACCOUNTANT_ID, apiTestEnv, call } from "./accounting-api-fixture.ts";
import { entityRoute } from "./accounting-scenario-fixture.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import {
  accountingIntentExecutor,
  externalEffectMoneyPort,
  resolveAccountingDispatchBinding,
} from "../src/accounting-dispatch-binding.ts";
import { runAccountingDispatch } from "../src/accounting-dispatch.ts";
import { readAccountingIntent } from "../src/accounting-intents.ts";
import { recordTaxPolicySnapshot } from "../src/accounting-tax-snapshots.ts";
import {
  quickBooksAuthPort,
  quickBooksProviderApiBase,
} from "../src/quickbooks-final-invoice.ts";

const AT_DERIVE = new Date("2026-08-19T12:00:00.000Z");
const AT_DISPATCH = new Date("2026-08-19T12:05:00.000Z");
const INVOICE_ID = "2001";

/** Throwaway local values only. None of these authenticates against anything (project rule 6). */
const QUICKBOOKS_CONFIG = {
  QB_OAUTH_ENABLED: "true",
  QB_API_ENVIRONMENT: "sandbox",
  QB_API_MINOR_VERSION: "75",
  QB_CLIENT_ID: "local-development-client-id",
  QB_CLIENT_SECRET: "local-development-client-secret",
  QB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  QB_TOKEN_ENCRYPTION_KEY_VERSION: "v1",
  APP_PUBLIC_ORIGIN: "http://localhost:5173",
} as const;

function boundEnv(overrides: Record<string, unknown> = {}): AppEnv {
  const { env } = apiTestEnv();
  return withTestEffectRuntime({ ...env, ...QUICKBOOKS_CONFIG, ...overrides }) as AppEnv;
}

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

/**
 * Derive and approve one deposit invoice through the real routes.
 *
 * Two different accountants, because separation of duty is now enforced against a real
 * `derived_by_user_id` (ELEC-77 defect 1): the derive route attributes the derivation to its
 * session, so one session deriving and approving is refused at 409, as section 6 says it must be.
 */
async function approvedIntent(env: AppEnv): Promise<string> {
  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: {
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
    },
    idempotencyKey: "idem-derive-binding-0001",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const derived = await readAccountingIntent(env, TENANT, intentId);
  const approved = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    {
      body: { version: derived!.version },
      idempotencyKey: "idem-approve-binding-001",
      userId: SECOND_ACCOUNTANT_ID,
    },
  );
  assert.equal(approved.status, 202, JSON.stringify(approved.body));
  return intentId;
}

/** The double's create leg: `POST /v3/company/{realm}/invoice` answers with the fixture entity. */
function createRoute(entityType: "Invoice" | "CreditMemo", entityFile: string) {
  return {
    path: `/v3/company/${REALM}/${entityType.toLowerCase()}`,
    body: { [entityType]: quickBooksEntity(entityFile, entityType) },
  };
}

// ------------------------------------------------------------------- unbound stays unbound

test("no effect ledger means no binding, and the dispatcher reports rather than dispatches", async () => {
  const { env } = apiTestEnv();
  const unwired = { ...env, ...QUICKBOOKS_CONFIG } as AppEnv;
  assert.equal(await resolveAccountingDispatchBinding(unwired, { tenantId: TENANT }), null);
});

test("unconfigured QuickBooks means no binding", async () => {
  const env = boundEnv({ QB_CLIENT_ID: undefined, QB_CLIENT_SECRET: undefined });
  assert.equal(await resolveAccountingDispatchBinding(env, { tenantId: TENANT }), null);
});

test("a tenant with no connected realm keeps ELEC-74's behaviour exactly", async () => {
  // The acceptance criterion this test exists for: configuring QuickBooks is not the same as
  // connecting it, and a tenant that never finished the OAuth handshake must keep reporting what
  // is waiting and dispatching nothing - no crash, no state change, no invented realm.
  const env = boundEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);

  // The config gate is genuinely passed here - otherwise this test would prove nothing about the
  // *connection* being what is missing.
  assert.ok(quickBooksAuthPort(env), "QuickBooks is configured on this env");
  const binding = await resolveAccountingDispatchBinding(env, { tenantId: TENANT });
  assert.equal(binding, null, "no connection row, so nothing to bind to");

  const report = await runAccountingDispatch(env, {
    tenantId: TENANT,
    ...(binding ? { binding } : {}),
    now: AT_DISPATCH,
  });
  assert.equal(report.dispatcher_unbound, true);
  assert.deepEqual(report.pending, [intentId]);
  assert.deepEqual(report.dispatched, []);
  assert.deepEqual(report.failed, []);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "submission_pending");
});

// --------------------------------------------------------- the bound path, through the real port

test("the production port and adapter carry an approved intent to the provider and back", async () => {
  const env = boundEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);

  const { fetcher, calls } = fakeIntuit([
    createRoute("Invoice", "invoice-open.json"),
    entityRoute("Invoice", "invoice-open.json"),
  ]);
  const auth = stubAuthPort();
  const report = await runAccountingDispatch(env, {
    tenantId: TENANT,
    binding: {
      // The real ledger-backed port, not the in-memory test double: what is under test is that
      // `runExternalEffect` accepts what the money plane hands it and that the row it settles
      // projects back onto `MoneyEffectOutcome` correctly.
      port: externalEffectMoneyPort(env),
      executorFor: ({ intent }) => accountingIntentExecutor({ intent, auth, fetcher }),
      auth,
      fetcher,
    },
    now: AT_DISPATCH,
  });

  assert.equal(report.dispatcher_unbound, false);
  assert.deepEqual(report.failed, []);
  assert.equal(report.dispatched.length, 1);
  assert.equal(report.dispatched[0]!.status, "submitted");
  assert.equal(report.dispatched[0]!.provider_entity_id, INVOICE_ID);
  // Reached by an authenticated readback of the exact entity id, judged by the S3 engine. An
  // open invoice is `partially_settled`, not `reconciled`: section 5.4 needs `Balance == 0`.
  assert.equal(report.dispatched[0]!.verdict, "partially_settled");

  const settled = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(settled?.state, "partially_settled");
  assert.equal(settled?.provider_entity_id, INVOICE_ID);
  assert.ok(settled?.effect_id, "the ledger's own effect id is recorded on the intent");

  // The create carries Intuit's `requestid` - the second half of the duplicate-create defence
  // beside the ledger's business key (section 5.4) - and every call is authenticated.
  const created = calls.find((entry) => entry.method === "POST");
  assert.ok(created, "the adapter really posted a create");
  assert.match(created!.url, /\/v3\/company\/\d+\/invoice\?/);
  assert.match(created!.url, /requestid=/);
  assert.ok(calls.every((entry) => entry.authorization?.startsWith("Bearer ")));
});

test("the adapter refuses a connection that points at a different company", async () => {
  const env = boundEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);
  const intent = await readAccountingIntent(env, TENANT, intentId);

  const { fetcher, calls } = fakeIntuit([createRoute("Invoice", "invoice-open.json")]);
  const executor = accountingIntentExecutor({
    intent: intent!,
    // The connection moved to another realm after the intent was derived. Posting anyway would put
    // a customer's invoice in somebody else's books.
    auth: stubAuthPort({ realmId: "9999999999999999999" }),
    fetcher,
  });
  const dispatched = await executor.dispatch({
    effectId: "effect-test", attemptId: "attempt-test", businessIdempotencyKey: "key-test",
  });
  assert.equal(dispatched.outcome, "rejected");
  assert.equal(dispatched.detailCode, "accounting_provider_realm_mismatch");
  assert.deepEqual(calls, [], "nothing was posted anywhere");
});

test("a lost create is unknown, never rejected: section 5.4 forbids retrying an unobserved write", async () => {
  const env = boundEnv();
  await seedTaxSnapshot(env);
  const intentId = await approvedIntent(env);
  const intent = await readAccountingIntent(env, TENANT, intentId);

  const { fetcher } = fakeIntuit([
    { path: `/v3/company/${REALM}/invoice`, networkError: true },
  ]);
  const dispatched = await accountingIntentExecutor({
    intent: intent!, auth: stubAuthPort(), fetcher,
  }).dispatch({
    effectId: "effect-test", attemptId: "attempt-test", businessIdempotencyKey: "key-test",
  });
  assert.equal(dispatched.outcome, "unknown");
  assert.equal(dispatched.detailCode, "provider_unreachable");
});

// ------------------------------------------------------------ the loopback double is local-only

test("the loopback provider override is honoured locally and ignored everywhere else", () => {
  // A deployed-shaped configuration: https origin, real tenant id, everything `configuration()`
  // requires, so the only variable across the three assertions is the gate itself.
  const deployed = {
    ...QUICKBOOKS_CONFIG,
    APP_TENANT_ID: TENANT,
    APP_PUBLIC_ORIGIN: "https://app.example.invalid",
    QB_API_BASE_LOCAL_OVERRIDE: "http://127.0.0.1:19099",
  };

  assert.equal(
    quickBooksProviderApiBase(
      { ...deployed, APP_ALLOW_INSECURE_LOCAL: "true" } as unknown as AppEnv,
    ),
    "http://127.0.0.1:19099",
  );

  // The gate that makes project rule 5 hold by construction: `wrangler.jsonc` sets
  // `APP_ALLOW_INSECURE_LOCAL` to "false" in every deployed environment, so a deployed Worker
  // resolves to Intuit no matter what the override says.
  assert.equal(
    quickBooksProviderApiBase(
      { ...deployed, APP_ALLOW_INSECURE_LOCAL: "false" } as unknown as AppEnv,
    ),
    "https://sandbox-quickbooks.api.intuit.com",
  );

  // ...and even locally it must be loopback: an override pointing at a public host is ignored.
  assert.equal(
    quickBooksProviderApiBase({
      ...deployed,
      APP_ALLOW_INSECURE_LOCAL: "true",
      QB_API_BASE_LOCAL_OVERRIDE: "https://quickbooks.api.intuit.example",
    } as unknown as AppEnv),
    "https://sandbox-quickbooks.api.intuit.com",
  );
});
