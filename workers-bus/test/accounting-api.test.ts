// Slice S8. Route-level cover for the money desk BFF surface.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.1. These exercise `handleAuthenticatedRoute`
// itself - the router, the permission set `ROLE_PERMISSIONS` really builds, CSRF, the
// `Idempotency-Key` convention, and the status a refused transition returns - rather than the
// engine, which slices S1-S5 already cover directly.
//
// The engine is driven through its own real path: intents here are derived, approved, dispatched
// through the effect port and reconciled by `accounting-scenario-fixture.ts`, so the rows the
// routes read are the rows production would read.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REALM, TENANT, fakeIntuit, quickBooksEntity } from "./accounting-fixture.ts";
import {
  ACCOUNTANT_ID,
  OWNER_ID,
  SECOND_ACCOUNTANT_ID,
  apiTestEnv,
  call,
  knownJobs,
  unreachableJobDirectory,
} from "./accounting-api-fixture.ts";
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
import { TestMoneyEffectPort } from "./accounting-port-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import { ingestObservedPayment } from "../src/accounting-payments.ts";
import { submitAndReconcileAccountingIntent } from "../src/accounting-submission.ts";
import { runAccountingCompensationDispatch } from "../src/accounting-dispatch.ts";
import { normalizeProviderEntity } from "../src/accounting-normalizers.ts";
import {
  listAccountingExceptions,
  readAccountingException,
} from "../src/accounting-exceptions.ts";
import {
  readAccountingIntent,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import {
  compensationAuthorityLevel,
  type CompensationPlan,
} from "../src/accounting-compensation.ts";
import { recordTaxPolicySnapshot } from "../src/accounting-tax-snapshots.ts";

const PORT_INPUT = {
  actor: DISPATCH_ACTOR,
  taskId: "task:accounting:submit",
  correlationId: "corr:accounting:0001",
  deadlineAt: DEADLINE,
  authorityExpiresAt: AUTHORITY_EXPIRES,
  taxPreflightOnDate: "2026-08-19",
};

/**
 * Every route section 8.1 lists, with the permission its row names.
 *
 * The intent and exception ids are the ones seeded below, so a 404 in this table means the path is
 * not routed rather than that the resource is simply absent - which is the only thing this test is
 * trying to prove.
 */
function contractRoutes(intentId: string, exceptionId: string) {
  return [
  { method: "GET" as const, path: "/api/v1/accounting/summary", permission: "accounting:read" },
  { method: "GET" as const, path: "/api/v1/accounting/intents", permission: "accounting:read" },
  { method: "GET" as const, path: "/api/v1/accounting/intents/x", permission: "accounting:read" },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/intents/x/approve",
    permission: "accounting:approve",
  },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/intents/x/reject",
    permission: "accounting:review",
  },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/intents/x/reconcile",
    permission: "accounting:reconcile",
  },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/intents/x/compensate",
    permission: "accounting:compensate",
  },
  { method: "GET" as const, path: "/api/v1/accounting/holdback", permission: "accounting:read" },
  { method: "GET" as const, path: "/api/v1/accounting/holdback/job-1", permission: "accounting:read" },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/holdback/hb-1/release",
    permission: "accounting:holdback_release",
  },
  { method: "GET" as const, path: "/api/v1/accounting/exceptions", permission: "accounting:read" },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/exceptions/exc-1/resolve",
    permission: "accounting:reconcile",
  },
  { method: "GET" as const, path: "/api/v1/accounting/tax/snapshots", permission: "accounting:read" },
  {
    method: "GET" as const,
    path: "/api/v1/accounting/tax/remittance/2026-08",
    permission: "accounting:read",
  },
  {
    method: "GET" as const,
    path: "/api/v1/accounting/payroll/runs/pr-1",
    permission: "accounting:payroll",
  },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/payroll/runs/pr-1/approve",
    permission: "accounting:payroll",
  },
  {
    method: "POST" as const,
    path: "/api/v1/accounting/payroll/runs/pr-1/reject",
    permission: "accounting:payroll",
  },
  ].map((route) => ({
    ...route,
    path: route.path
      .replace("/intents/x", `/intents/${encodeURIComponent(intentId)}`)
      .replace("/exceptions/exc-1", `/exceptions/${encodeURIComponent(exceptionId)}`),
  }));
}

/**
 * Post a 1260.00 deposit invoice through the real dispatch path and read it back.
 *
 * `submitAndReconcile…` rather than `submit…` on purpose: a submitted intent carries no
 * observation at all, so a desk test that stopped at dispatch would be asserting against a
 * comparison with nothing on the observed side.
 */
async function postedInvoice(env: AppEnv, options: { maxAmount?: string } = {}) {
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env, {
    // The real provider payload rather than the `{ TotalAmt }` stub: a reversal derived from this
    // invoice copies the customer, the currency and the line refs off it, so a stub here would
    // derive a credit memo that could not match any readback.
    providerPayload: {
      CustomerRef: { value: "42" },
      CurrencyRef: { value: "CAD" },
      TxnDate: "2026-08-19",
      DueDate: "2026-09-18",
      TotalAmt: "1260.00",
      TxnTaxDetail: { TotalTax: "60.00" },
      Line: [{
        DetailType: "SalesItemLineDetail",
        Amount: "1200.00",
        SalesItemLineDetail: { ItemRef: { value: "7" }, TaxCodeRef: { value: "TAX" } },
      }],
    },
    ...(options.maxAmount === undefined ? {} : { maxAmount: options.maxAmount }),
  });
  await approveIntent(env, intent);
  const { fetcher } = fakeIntuit([entityRoute("Invoice", "invoice-open.json")]);
  await submitAndReconcileAccountingIntent(env, {
    ...PORT_INPUT,
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "2001", observed: expected }),
    expectedReadback: expected,
    auth: scenarioAuth(),
    fetcher,
  }, AT_SUBMIT);
  return intent.intent_id;
}

/** …and over-pay it by 240.00, so a live `provider_overpayment` exception exists. */
async function overpaidInvoice(env: AppEnv, options: { maxAmount?: string } = {}) {
  const intentId = await postedInvoice(env, options);
  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);
  return intentId;
}


/** The reversal's own `TxnDate` is the day it is dispatched; the fixture credit memo's is this. */
const AT_COMPENSATE = new Date("2026-08-21T12:00:00.000Z");

/**
 * The dispatcher binding for a credit-memo reversal, over the synthetic fixtures.
 *
 * The readback returns the fixture's own normalized facts, so the reversal's expectation and its
 * observation are produced by two independent paths over the same provider bytes.
 */
function compensationBinding() {
  const observed = normalizeProviderEntity({
    realmId: REALM,
    entityType: "CreditMemo",
    payload: quickBooksEntity("credit-memo-240.json", "CreditMemo"),
  });
  const { fetcher } = fakeIntuit([entityRoute("CreditMemo", "credit-memo-240.json")]);
  return {
    port: new TestMoneyEffectPort(),
    executorFor: () => ({
      async dispatch() {
        return {
          outcome: "accepted" as const,
          value: { providerEntityId: "4002" },
          providerExternalId: "4002",
          providerResponse: { Id: "4002" },
        };
      },
      async readback() {
        return {
          status: "match" as const,
          providerExternalId: "4002",
          observed: { realmId: REALM, entityType: "CreditMemo", facts: observed.facts },
        };
      },
      async replay() {
        return { providerEntityId: "4002" };
      },
    }),
    auth: scenarioAuth(),
    fetcher,
  };
}

test("every route section 8.1 lists is served, and none of them answers 404 for the owner", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const [exception] = await listAccountingExceptions(env, TENANT, { intentId });
  const routes = contractRoutes(intentId, exception!.exception_id);
  assert.equal(routes.length, 17, "section 8.1 names seventeen routes");

  for (const route of routes) {
    const response = await call(env, "owner", route.method, route.path, {
      body: route.method === "POST" ? {} : undefined,
    });
    assert.notEqual(
      response.status,
      404,
      `${route.method} ${route.path} answered 404 - the route is not served`,
    );
    assert.notEqual(response.status, 403, `${route.method} ${route.path} refused the owner`);
  }
});

test("every route is permission-gated: a sales session reaches none of them", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const [exception] = await listAccountingExceptions(env, TENANT, { intentId });

  for (const route of contractRoutes(intentId, exception!.exception_id)) {
    const response = await call(env, "sales", route.method, route.path, {
      body: route.method === "POST" ? {} : undefined,
    });
    assert.equal(
      response.status,
      403,
      `${route.method} ${route.path} did not refuse a role without the permission`,
    );
    assert.match(String(response.body.error), /_required$/);
  }
});

test("ops reads the desk and can change nothing on it", async () => {
  const { env } = apiTestEnv();
  const summary = await call(env, "ops", "GET", "/api/v1/accounting/summary");
  assert.equal(summary.status, 200);

  for (const path of [
    "/api/v1/accounting/intents/x/approve",
    "/api/v1/accounting/intents/x/reject",
    "/api/v1/accounting/intents/x/reconcile",
    "/api/v1/accounting/intents/x/compensate",
    "/api/v1/accounting/exceptions/e/resolve",
    "/api/v1/accounting/holdback/h/release",
  ]) {
    const refused = await call(env, "ops", "POST", path, { body: {} });
    assert.equal(refused.status, 403, `${path} was reachable by ops`);
  }
});

test("holdback release is the owner's alone; the accountant is refused at the permission", async () => {
  const { env } = apiTestEnv();
  const accountant = await call(env, "accounting", "POST", "/api/v1/accounting/holdback/hb-1/release", {
    body: {},
  });
  assert.equal(accountant.status, 403);
  assert.equal(accountant.body.error, "accounting_holdback_release_required");

  const owner = await call(env, "owner", "POST", "/api/v1/accounting/holdback/hb-1/release", {
    body: {},
  });
  assert.equal(owner.status, 501);
  assert.equal(owner.body.error, "accounting_holdback_not_implemented");
  assert.equal(owner.body.slice, "S6");
});

test("holdback and payroll refuse honestly rather than pretending: 501 naming the slice", async () => {
  const { env } = apiTestEnv();
  for (const [path, slice] of [
    ["/api/v1/accounting/holdback", "S6"],
    ["/api/v1/accounting/holdback/job-1", "S6"],
    ["/api/v1/accounting/payroll/runs/pr-1", "S7"],
  ] as const) {
    const response = await call(env, "owner", "GET", path);
    assert.equal(response.status, 501);
    assert.equal(response.body.slice, slice);
  }
  for (const path of [
    "/api/v1/accounting/payroll/runs/pr-1/approve",
    "/api/v1/accounting/payroll/runs/pr-1/reject",
  ]) {
    const response = await call(env, "owner", "POST", path, { body: {} });
    assert.equal(response.status, 501);
    assert.equal(response.body.error, "accounting_payroll_not_implemented");
  }
});

test("a gated-but-unshipped command still enforces CSRF and the idempotency header", async () => {
  const { env } = apiTestEnv();
  const noCsrf = await call(env, "owner", "POST", "/api/v1/accounting/payroll/runs/pr-1/approve", {
    body: {}, csrf: false,
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const noKey = await call(env, "owner", "POST", "/api/v1/accounting/payroll/runs/pr-1/approve", {
    body: {}, idempotencyKey: null,
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "idempotency_key_required");
});

test("the summary paints four queues and reconciliation health in one request", async () => {
  const { env } = apiTestEnv();
  await overpaidInvoice(env);
  const response = await call(env, "accounting", "GET", "/api/v1/accounting/summary");
  assert.equal(response.status, 200);

  const summary = response.body.summary as {
    queues: Record<string, { count: number; oldest_age_seconds: number | null }>;
    reconciliation_health: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(summary.queues).sort(), [
    "awaiting_provider", "exceptions", "mismatched", "needs_approval",
  ]);
  assert.equal(summary.queues.mismatched!.count, 1);
  assert.equal(summary.queues.exceptions!.count, 1);
  assert.equal(summary.reconciliation_health.open_exceptions, 1);

  const queues = response.body.queues as Record<string, Array<Record<string, unknown>>>;
  assert.equal(queues.mismatched!.length, 1);
  assert.equal(queues.mismatched![0]!.badge, "mismatched");
  assert.equal(
    queues.mismatched![0]!.next_step,
    "QuickBooks does not agree with our figures. Open the detail and pick a remedy.",
  );
});

test("the intent list filters on kind, state and job, and refuses a filter it does not know", async () => {
  const { env } = apiTestEnv();
  await postedInvoice(env);

  const all = await call(env, "accounting", "GET", "/api/v1/accounting/intents");
  assert.equal((all.body.intents as unknown[]).length, 1);

  const byKind = await call(
    env, "accounting", "GET", "/api/v1/accounting/intents?kind=deposit_invoice",
  );
  assert.equal((byKind.body.intents as unknown[]).length, 1);

  const byOtherKind = await call(env, "accounting", "GET", "/api/v1/accounting/intents?kind=refund");
  assert.equal((byOtherKind.body.intents as unknown[]).length, 0);

  const byJob = await call(env, "accounting", "GET", "/api/v1/accounting/intents?job=job-0001");
  assert.equal((byJob.body.intents as unknown[]).length, 1);

  const bogus = await call(env, "accounting", "GET", "/api/v1/accounting/intents?state=nonsense");
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error, "invalid_accounting_intent_filter");
});

test("no office projection carries a tenant id or a provider payload body", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);

  for (const path of [
    "/api/v1/accounting/summary",
    "/api/v1/accounting/intents",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
    "/api/v1/accounting/exceptions",
    "/api/v1/accounting/tax/snapshots?period=2026-08",
    "/api/v1/accounting/tax/remittance/2026-08",
  ]) {
    const response = await call(env, "accounting", "GET", path);
    assert.equal(response.status, 200, path);
    const body = JSON.stringify(response.body);
    assert.doesNotMatch(body, /"tenant_id"/, `${path} leaked a tenant id`);
    assert.doesNotMatch(body, /provider_payload_json|basis_json|access[_-]?token/, path);
  }
});

test("intent detail carries the bound facts, the hash pair, and a field-by-field comparison", async () => {
  const { env } = apiTestEnv();
  const intentId = await postedInvoice(env);
  const response = await call(
    env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
  );
  assert.equal(response.status, 200);

  const evidence = response.body.evidence as Record<string, string | null>;
  assert.match(String(evidence.basis_sha256), /^[0-9a-f]{64}$/);
  assert.equal(evidence.realm_id, REALM);
  assert.equal(evidence.provider_entity_id, "2001");

  const comparison = response.body.comparison as {
    hashes_agree: boolean;
    awaiting_readback: boolean;
    observed_sha256: string | null;
    verdict_observed_sha256: string | null;
    fields: Array<{ field: string; agrees: boolean }>;
  };
  assert.equal(comparison.awaiting_readback, false);
  assert.equal(comparison.hashes_agree, true);
  // The verdict of record stands on the same read, because the readback was judged.
  assert.equal(comparison.verdict_observed_sha256, comparison.observed_sha256);
  const entityId = comparison.fields.find((field) => field.field === "provider_entity_id");
  assert.equal(entityId?.agrees, true);

  assert.ok((response.body.events as unknown[]).length > 0);
  assert.equal((response.body.tax_bindings as unknown[]).length, 1);
});

test("an intent id from another tenant reads as not found, never as somebody else's money", async () => {
  const { env } = apiTestEnv();
  const intentId = await postedInvoice(env);
  const response = await call(
    env, "accounting", "GET", `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
    { tenantId: "someone-else" },
  );
  assert.equal(response.status, 404);
});

test("approve requires CSRF, an idempotency key, and the version the caller actually read", async () => {
  const { env } = apiTestEnv();
  const { intent } = await deriveScenarioIntent(env);
  const path = `/api/v1/accounting/intents/${encodeURIComponent(intent.intent_id)}/approve`;

  const noCsrf = await call(env, "accounting", "POST", path, { body: { version: 1 }, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const noKey = await call(env, "accounting", "POST", path, {
    body: { version: 1 }, idempotencyKey: null,
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "idempotency_key_required");

  const unexpectedField = await call(env, "accounting", "POST", path, {
    body: { version: 1, reason_code: "amount_disputed" },
  });
  assert.equal(unexpectedField.status, 400);
  assert.equal(unexpectedField.body.error, "unexpected_field");

  const staleVersion = await call(env, "accounting", "POST", path, { body: { version: 9 } });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.body.error, "accounting_intent_command_version_invalid");

  const approved = await call(env, "accounting", "POST", path, { body: { version: 1 } });
  assert.equal(approved.status, 202);
  assert.equal((approved.body.intent as Record<string, unknown>).state, "submission_pending");
});

test("a replayed approve is a replay; the same key with a different body is a conflict", async () => {
  const { env } = apiTestEnv();
  const { intent } = await deriveScenarioIntent(env);
  const path = `/api/v1/accounting/intents/${encodeURIComponent(intent.intent_id)}/approve`;

  const first = await call(env, "accounting", "POST", path, {
    body: { version: 1 }, idempotencyKey: "idem-approve-0000000001",
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.replayed, false);

  const replay = await call(env, "accounting", "POST", path, {
    body: { version: 1 }, idempotencyKey: "idem-approve-0000000001",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((replay.body.intent as Record<string, unknown>).version, 2);

  const otherActor = await call(env, "accounting", "POST", path, {
    body: { version: 1 },
    userId: SECOND_ACCOUNTANT_ID,
    idempotencyKey: "idem-approve-0000000001",
  });
  assert.equal(otherActor.status, 409);
  assert.equal(otherActor.body.error, "accounting_intent_command_conflict");

  const conflicting = await call(env, "accounting", "POST", path, {
    body: { version: 2 }, idempotencyKey: "idem-approve-0000000001",
  });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error, "accounting_intent_command_conflict");
});

test("separation of duty is refused at 409, not swallowed as a store failure", async () => {
  const { env } = apiTestEnv();
  // Derived by a named accountant rather than by the agent, so the same person can try to approve
  // their own candidate. Set at derivation because `derived_by_user_id` is immutable afterwards -
  // `0058`'s binding guard refuses the UPDATE, which is the point of the column.
  const { intent } = await deriveScenarioIntent(env, {
    intentId: "acct-intent:job-sod:deposit",
    derivedBy: { actorKind: "accounting", userId: ACCOUNTANT_ID },
  });

  const path = `/api/v1/accounting/intents/${encodeURIComponent(intent.intent_id)}/approve`;
  const sameActor = await call(env, "accounting", "POST", path, { body: { version: 1 } });
  assert.equal(sameActor.status, 409);
  assert.equal(sameActor.body.error, "accounting_intent_separation_of_duty");

  const otherActor = await call(env, "accounting", "POST", path, {
    body: { version: 1 }, userId: SECOND_ACCOUNTANT_ID, idempotencyKey: "idem-sod-0000000000001",
  });
  assert.equal(otherActor.status, 202);
});

/**
 * The derivation body every test below sends. The refs are the fixture invoice's, so an intent
 * derived from it is one the rest of the money plane could actually carry.
 */
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

/** The tax snapshot section 5.4 binds at derivation. Without it the route refuses, correctly. */
async function seedTaxSnapshot(env: AppEnv) {
  await recordTaxPolicySnapshot(env, {
    tenantId: TENANT,
    jurisdiction: "CA-AB",
    taxCode: "GST",
    providerTaxCodeId: "3",
    ratePercent: "5.0000",
    effectiveFrom: "2008-01-01",
    sourceRef: "CRA GST bulletin 2008-01-01",
  });
}

test("the derive route attributes the derivation to its own session, not to an agent", async () => {
  // ELEC-77 defect 1. `deriveIntent` hardcoded `derivedBy: { actorKind: "agent" }`, so
  // `derived_by_user_id` was NULL for every intent the API had ever created and the approve-time
  // check compared NULL against a real user id. Attribution is the whole fix; the refusal below is
  // what it buys.
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);

  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-attribution-01",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intentId = (created.body.intent as { intent_id: string }).intent_id;

  const derived = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(derived?.derived_by_actor_kind, "accounting");
  assert.equal(derived?.derived_by_user_id, ACCOUNTANT_ID);

  // An owner deriving is an owner-kind derivation, not "the agent again": both roles hold
  // `accounting:review`, and the actor kind has to say which one asked.
  const byOwner = await call(env, "owner", "POST", "/api/v1/accounting/intents", {
    body: derivationBody({ roof_job_id: "job-0002" }),
    idempotencyKey: "idem-derive-attribution-02",
  });
  assert.equal(byOwner.status, 201, JSON.stringify(byOwner.body));
  const ownerIntent = await readAccountingIntent(
    env, TENANT, (byOwner.body.intent as { intent_id: string }).intent_id,
  );
  assert.equal(ownerIntent?.derived_by_actor_kind, "owner");
  assert.equal(ownerIntent?.derived_by_user_id, OWNER_ID);
});

test("one session cannot derive and then approve the same intent; a second accountant can", async () => {
  // ELEC-77's repro, end to end over the two production routes: this pair returned 201 then 202
  // before the fix, which is exactly the separation of duty section 6 promises being absent.
  const { env } = apiTestEnv();
  await seedTaxSnapshot(env);

  const created = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-sod-00000001",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intentId = (created.body.intent as { intent_id: string }).intent_id;
  const path = `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`;
  const version = (await readAccountingIntent(env, TENANT, intentId))!.version;

  const sameSession = await call(env, "accounting", "POST", path, {
    body: { version }, idempotencyKey: "idem-approve-sod-0000001",
  });
  assert.equal(sameSession.status, 409);
  assert.equal(sameSession.body.error, "accounting_intent_separation_of_duty");
  // Refused before anything moved: the candidate is still waiting for a reviewer.
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "pending_review");

  const secondAccountant = await call(env, "accounting", "POST", path, {
    body: { version },
    idempotencyKey: "idem-approve-sod-0000002",
    userId: SECOND_ACCOUNTANT_ID,
  });
  assert.equal(secondAccountant.status, 202, JSON.stringify(secondAccountant.body));
  assert.equal(
    (await readAccountingIntent(env, TENANT, intentId))?.approved_by_user_id,
    SECOND_ACCOUNTANT_ID,
  );
});

test("the commercial recovery requester route is separated from deposit approval", async () => {
  const { env, db } = apiTestEnv();
  const { intent } = await deriveScenarioIntent(env, {
    intentId: "acct-intent:job-0001:commercial-recovery-sod",
  });
  db.raw.prepare(
    `INSERT INTO commercial_deposit_approval_exclusions
       (request_id, tenant_id, intent_id, actor_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run("commercial-deposit-reconcile:route-sod", TENANT, intent.intent_id, ACCOUNTANT_ID);

  const path = `/api/v1/accounting/intents/${encodeURIComponent(intent.intent_id)}/approve`;
  const requester = await call(env, "accounting", "POST", path, {
    body: { version: 1 },
    idempotencyKey: "idem-commercial-recovery-sod-requester",
  });
  assert.equal(requester.status, 409);
  assert.equal(requester.body.error, "accounting_intent_separation_of_duty");
  assert.equal((await readAccountingIntent(env, TENANT, intent.intent_id))?.state, "pending_review");

  const independentApprover = await call(env, "accounting", "POST", path, {
    body: { version: 1 },
    idempotencyKey: "idem-commercial-recovery-sod-approver",
    userId: SECOND_ACCOUNTANT_ID,
  });
  assert.equal(independentApprover.status, 202, JSON.stringify(independentApprover.body));
  assert.equal(
    (await readAccountingIntent(env, TENANT, intent.intent_id))?.approved_by_user_id,
    SECOND_ACCOUNTANT_ID,
  );
});

test("a replayed derivation is a replay; the same key with different figures is a conflict", async () => {
  // ELEC-77 defect 2. The header was required and then never used, so a key could stand for two
  // different sets of figures and derive two intents.
  const { env, db } = apiTestEnv();
  await seedTaxSnapshot(env);
  const intents = () =>
    (db.raw.prepare("SELECT COUNT(*) AS n FROM accounting_intents").get() as { n: number }).n;

  const first = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-replay-0001",
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  const intentId = (first.body.intent as { intent_id: string }).intent_id;
  assert.equal(intents(), 1);

  const replay = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-replay-0001",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((replay.body.intent as { intent_id: string }).intent_id, intentId);
  assert.equal(intents(), 1);

  // Same key, a different amount. Before the fix this derived a second intent for money nobody
  // asked for twice; now it is refused and neither figure is silently chosen over the other.
  const conflicting = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody({ subtotal: "2400.00" }), idempotencyKey: "idem-derive-replay-0001",
  });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error, "accounting_intent_derivation_conflict");
  assert.equal(intents(), 1);

  // The key is what refuses, not the route: the same different figures under their own key derive
  // the second intent they are entitled to.
  const underOwnKey = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody({ subtotal: "2400.00" }), idempotencyKey: "idem-derive-replay-0002",
  });
  assert.equal(underOwnKey.status, 201, JSON.stringify(underOwnKey.body));
  assert.notEqual((underOwnKey.body.intent as { intent_id: string }).intent_id, intentId);
  assert.equal(intents(), 2);
});

test("a derivation that refuses writes no receipt, so the same key can be retried", async () => {
  // The receipt is written after the derivation, so a request that never derived anything must not
  // burn its key: a caller whose first attempt hit `tax_mapping_missing` retries the same request
  // once the mapping exists, exactly as they would retry any other 409.
  const { env } = apiTestEnv();

  const refused = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-retry-00001",
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "tax_mapping_missing");

  await seedTaxSnapshot(env);
  const retried = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-retry-00001",
  });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.replayed, false);
});

test("a derivation names a job the operating core does not have, and is refused", async () => {
  // ELEC-112 finding 3. `roof_job_id` was a text pattern and nothing else: a job that had never
  // existed produced a real `201 pending_review` deposit invoice, one approval away from a
  // provider. The reference is now resolved against the tenant's operating core first.
  const { env, db } = apiTestEnv();
  await seedTaxSnapshot(env);
  const intents = () =>
    (db.raw.prepare("SELECT COUNT(*) AS n FROM accounting_intents").get() as { n: number }).n;
  const deps = { accounting: { jobDirectory: knownJobs({ "job-0001": "Proposal" }) } };

  const invented = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody({ roof_job_id: "job-does-not-exist" }),
    idempotencyKey: "idem-derive-nojob-00001",
    deps,
  });
  assert.equal(invented.status, 404, JSON.stringify(invented.body));
  assert.equal(invented.body.error, "accounting_intent_roof_job_not_found");
  // Refused before the engine: no candidate, and therefore nothing anybody could approve.
  assert.equal(intents(), 0);

  // The gate refuses a reference, not the route: the job that does exist still derives.
  const real = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-nojob-00002", deps,
  });
  assert.equal(real.status, 201, JSON.stringify(real.body));
  assert.equal(intents(), 1);
});

test("another tenant's session cannot derive against this tenant's jobs", async () => {
  // Rule 2 of the module: an id from another tenant reads as `not_found`. The operating core
  // behind `ERPNEXT_BASE_URL` belongs to the configured tenant, so a session from anywhere else
  // is refused without the directory being consulted at all - a lookup that answered would be
  // this tenant's answer given to somebody else.
  const { env, db } = apiTestEnv();
  await seedTaxSnapshot(env);
  let consulted = 0;
  const deps = {
    accounting: {
      jobDirectory: async (_env: AppEnv, name: string) => {
        consulted += 1;
        return { name, roofJobId: name, jobStatus: "Proposal" };
      },
    },
  };

  const foreign = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-tenant-0001",
    tenantId: "some-other-tenant",
    deps,
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  assert.equal(foreign.body.error, "accounting_intent_roof_job_not_found");
  assert.equal(consulted, 0);
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM accounting_intents").get() as { n: number }).n,
    0,
  );

  // The same request from the tenant that owns the operating core derives normally.
  const own = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-tenant-0002", deps,
  });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(consulted, 1);
});

test("an operating core the Worker cannot reach refuses the derivation, it does not wave it through", async () => {
  // "We could not check" must never be worth more than "we checked". A directory that throws is
  // an unknown job, and an unknown job is not one the money desk may bill against.
  const { env, db } = apiTestEnv();
  await seedTaxSnapshot(env);

  const refused = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-directory-01",
    deps: { accounting: { jobDirectory: unreachableJobDirectory } },
  });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "accounting_job_directory_unavailable");
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM accounting_intents").get() as { n: number }).n,
    0,
  );

  // Nothing was derived, so nothing burned the key either: the same request retries once the
  // operating core is back, exactly like the `tax_mapping_missing` retry above.
  const retried = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(), idempotencyKey: "idem-derive-directory-01",
  });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
});

test("the eligibility seam's refusal is wired, so the pending ruling is a one-line change", async () => {
  // `moneyIntentJobEligible` accepts every existing job today - deliberately, because that is the
  // behaviour this gate inherited and the eligibility semantics are the architect's call, not
  // this route's. What is proven here is the wire: when that predicate says no, the route refuses
  // with its own code and derives nothing. Substituting the ruling changes one function.
  const { env, db } = apiTestEnv();
  await seedTaxSnapshot(env);

  const refused = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-eligible-01",
    deps: {
      accounting: {
        jobDirectory: knownJobs({ "job-0001": "Proposal" }),
        jobEligibility: (job) => job.jobStatus === "Won",
      },
    },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "accounting_intent_roof_job_not_eligible");
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM accounting_intents").get() as { n: number }).n,
    0,
  );

  // The same predicate against a job that does satisfy it derives, so the refusal above is the
  // predicate talking and not the gate refusing everything.
  const allowed = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody({ roof_job_id: "job-0002" }),
    idempotencyKey: "idem-derive-eligible-02",
    deps: {
      accounting: {
        jobDirectory: knownJobs({ "job-0002": "Won" }),
        jobEligibility: (job) => job.jobStatus === "Won",
      },
    },
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test("a D1 trigger refusal reaches the caller as its own code at 409, never as 502", async () => {
  const { env } = apiTestEnv();
  const intentId = await postedInvoice(env);
  const current = await readAccountingIntent(env, TENANT, intentId);
  // `reconciled` is not a source state for `approve`; the handler's early check and the receipt
  // trigger both refuse it, and the wire answer has to be the refusal rather than a fault.
  const response = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
    { body: { version: current!.version } },
  );
  assert.equal(response.status, 409);
  assert.match(String(response.body.error), /^accounting_/);
  assert.notEqual(response.body.error, "accounting_store_unavailable");
});

test("reject records a bounded reason and settles locally at 200", async () => {
  const { env } = apiTestEnv();
  const { intent } = await deriveScenarioIntent(env);
  const path = `/api/v1/accounting/intents/${encodeURIComponent(intent.intent_id)}/reject`;

  const badReason = await call(env, "accounting", "POST", path, {
    body: { version: 1, reason_code: "because_i_said_so" },
  });
  assert.equal(badReason.status, 400);

  const rejected = await call(env, "accounting", "POST", path, {
    body: { version: 1, reason_code: "amount_disputed" }, idempotencyKey: "idem-reject-000000001",
  });
  assert.equal(rejected.status, 200);
  const stored = await readAccountingIntent(env, TENANT, intent.intent_id);
  assert.equal(stored?.state, "rejected");
  assert.equal(stored?.reason_code, "amount_disputed");
});

test("reconcile asks for a re-read; it never declares an outcome by itself", async () => {
  const { env } = apiTestEnv();
  const intentId = await postedInvoice(env);
  const current = await readAccountingIntent(env, TENANT, intentId);
  const response = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/reconcile`,
    { body: { version: current!.version } },
  );
  assert.equal(response.status, 202);
  const stored = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(stored?.state, "reconciliation_required");
});

test("compensate authorizes a plan; it writes no reversal and dispatches nothing", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);

  const response = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    { body: { version: before!.version, remedy: "credit_memo_issued" } },
  );
  assert.equal(response.status, 202);

  const plan = response.body.compensation_plan as Record<string, unknown>;
  assert.equal(plan.remedy, "credit_memo_issued");
  assert.equal(plan.reversalKind, "credit_memo");
  // The surplus of an over-payment of 1500.00 against a 1260.00 invoice, and nothing else.
  assert.equal(plan.totalAmount, "-240.00");
  assert.equal(plan.magnitudeAmount, "240.00");

  const after = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(after?.state, "compensating");
  // Propose -> authorize -> reverse: the reversing intent is the finance agent's, not the desk's.
  const intents = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM accounting_intents WHERE tenant_id = ?`,
  ).bind(TENANT).first<{ total: number }>();
  assert.equal(Number(intents?.total), 1);
});

test("a remedy the exception never offered is refused before anything is authorized", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);

  const response = await call(
    env, "accounting", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    { body: { version: before!.version, remedy: "adjusting_entry_posted" } },
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "accounting_compensation_remedy_not_offered");
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, before!.state);
});

test("the owner gate compares magnitudes, and derivation is what makes it unreachable today", () => {
  const original = {
    total_amount: "-1260.00",
    authority_max_amount: "1000.00",
  } as AccountingIntentRecord;
  const plan = { totalAmount: "-1200.00", magnitudeAmount: "1200.00" } as CompensationPlan;
  assert.equal(compensationAuthorityLevel(plan, original), "owner");
  assert.equal(
    compensationAuthorityLevel({ ...plan, totalAmount: "-900.00" } as CompensationPlan, original),
    "accounting",
  );
  // Recorded rather than asserted end to end on purpose. `deriveAccountingIntent` already refuses
  // `|total| > |maxAmount|` with `effect_policy_amount_ceiling_exceeded`, and a plan may never
  // exceed the original's magnitude, so no intent reachable through derivation can produce a plan
  // above its own ceiling. This gate is therefore defence in depth for a hand-written or future
  // row - the same shape ELEC-58 recorded for `0058`'s over-ceiling trigger branch.
});

test("the owner may compensate the same intent an accountant could", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);
  const response = await call(
    env, "owner", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    {
      body: { version: before!.version, remedy: "refund_issued" },
      userId: OWNER_ID,
      idempotencyKey: "idem-compensate-00000001",
    },
  );
  assert.equal(response.status, 202);
  assert.equal(
    (response.body.compensation_plan as Record<string, unknown>).reversalKind,
    "refund",
  );
});

test("the exception queue carries both hashes and the remedies actually on offer", async () => {
  const { env } = apiTestEnv();
  await overpaidInvoice(env);

  const response = await call(env, "accounting", "GET", "/api/v1/accounting/exceptions?status=open");
  assert.equal(response.status, 200);
  const exceptions = response.body.exceptions as Array<Record<string, unknown>>;
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0]!.reason_code, "provider_overpayment");
  assert.deepEqual(exceptions[0]!.offered_remedies, [
    "void_provider_entity", "credit_memo_issued", "refund_issued",
  ]);
  assert.ok(typeof exceptions[0]!.age_seconds === "number");

  const bogus = await call(env, "accounting", "GET", "/api/v1/accounting/exceptions?status=zzz");
  assert.equal(bogus.status, 400);
});

test("resolving with a money reversal demands the compensating effect it claims to have", async () => {
  const { env } = apiTestEnv();
  const intentId = await overpaidInvoice(env);
  const [exception] = await listAccountingExceptions(env, TENANT, { intentId });
  const path = `/api/v1/accounting/exceptions/${encodeURIComponent(exception!.exception_id)}/resolve`;

  const unlinked = await call(env, "accounting", "POST", path, {
    body: { resolution_action: "credit_memo_issued" },
  });
  assert.equal(unlinked.status, 400);
  assert.equal(unlinked.body.error, "accounting_exception_compensating_effect_required");
  assert.equal(
    (await readAccountingException(env, TENANT, exception!.exception_id))?.status,
    "open",
  );

  // ...and naming one is not the same as having done it. Until ELEC-72 this passed a literal
  // string that had never been dispatched anywhere and asserted `200`, so the test's own title
  // oversold both the test and the code: the check was presence, never verification. A reference
  // the ledger has never heard of is now refused, and the exception stays open.
  const fabricated = await call(env, "accounting", "POST", path, {
    body: { resolution_action: "credit_memo_issued", compensating_effect_id: "eff-reversal-0001" },
    idempotencyKey: "idem-resolve-0000000001",
  });
  assert.equal(fabricated.status, 409);
  assert.equal(fabricated.body.error, "accounting_exception_compensating_effect_unknown");
  assert.equal(
    (await readAccountingException(env, TENANT, exception!.exception_id))?.status,
    "open",
  );

  // The reversal the accountant authorized, dispatched for real through the mocked port. Closing
  // the exception on *that* effect is what section 5.4's "the remedy runs as a compensating
  // effect" actually means, and it is the only thing that closes it.
  const original = await readAccountingIntent(env, TENANT, intentId);
  const authorized = await call(
    env, "owner", "POST",
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
    {
      body: { version: original!.version, remedy: "credit_memo_issued" },
      idempotencyKey: "idem-compensate-0000000001",
    },
  );
  assert.equal(authorized.status, 202, JSON.stringify(authorized.body));
  const dispatched = await runAccountingCompensationDispatch(env, {
    tenantId: TENANT,
    binding: compensationBinding(),
    now: AT_COMPENSATE,
  });
  assert.deepEqual(dispatched.refused, []);
  assert.equal(dispatched.dispatched[0]?.status, "submitted");

  // The dispatcher closed it on the effect it really settled - the route never had to be asked.
  const closed = await readAccountingException(env, TENANT, exception!.exception_id);
  assert.equal(closed?.status, "resolved");
  const reversalId = (authorized.body.authorized_reversal_intent_id as string);
  const reversal = await readAccountingIntent(env, TENANT, reversalId);
  assert.equal(closed?.compensating_effect_id, reversal?.effect_id);
  assert.equal(reversal?.compensates_intent_id, intentId);
});

test("tax snapshots and the remittance proposal read by period, and refuse a period that is not one", async () => {
  const { env } = apiTestEnv();
  await recordTaxPolicySnapshot(env, {
    tenantId: TENANT,
    jurisdiction: "CA-AB",
    taxCode: "GST",
    providerTaxCodeId: "3",
    ratePercent: "5.0000",
    effectiveFrom: "2008-01-01",
    sourceRef: "CRA GST bulletin 2008-01-01",
  });
  await postedInvoice(env);

  const snapshots = await call(
    env, "accounting", "GET", "/api/v1/accounting/tax/snapshots?period=2026-08",
  );
  assert.equal(snapshots.status, 200);
  assert.equal((snapshots.body.snapshots as unknown[]).length, 1);

  const remittance = await call(env, "accounting", "GET", "/api/v1/accounting/tax/remittance/2026-08");
  assert.equal(remittance.status, 200);
  const proposal = remittance.body.remittance as Record<string, unknown>;
  assert.equal(proposal.period, "2026-08");
  assert.equal(proposal.submitted_tax_total, "60.00");
  assert.equal(proposal.pending_tax_total, "0.00");
  // IronWrap proposes; the accountant files (section 12, open question 5).
  assert.equal(proposal.filing_authority, "accountant");

  const bogusPeriod = await call(env, "accounting", "GET", "/api/v1/accounting/tax/remittance/last-month");
  assert.equal(bogusPeriod.status, 400);
  const bogusFilter = await call(
    env, "accounting", "GET", "/api/v1/accounting/tax/snapshots?period=2026-13",
  );
  assert.equal(bogusFilter.status, 400);
});

test("the money lane starts from zero: the statutory rate has a route, so a derivation can bind one", async () => {
  // Slice S11. `recordTaxPolicySnapshot` shipped with S2 and had no production caller, which made
  // this the first wall a real tenant hit: `deriveIntent` refuses with `tax_mapping_missing` when
  // no current snapshot binds the jurisdiction and code, so on a tenant nobody had hand-inserted a
  // row for, no money intent could be derived at all.
  const { env } = apiTestEnv();

  const before = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-notax-00001",
  });
  assert.equal(before.status, 409);
  assert.equal(before.body.error, "tax_mapping_missing");

  const recorded = await call(env, "accounting", "POST", "/api/v1/accounting/tax/snapshots", {
    body: {
      jurisdiction: "CA-AB",
      tax_code: "GST",
      provider_tax_code_id: "3",
      rate_percent: "5.0000",
      effective_from: "2008-01-01",
      source_ref: "CRA GST bulletin 2008-01-01",
    },
    idempotencyKey: "idem-taxsnap-00000001",
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const snapshot = recorded.body.snapshot as Record<string, unknown>;
  assert.equal(snapshot.rate_percent, "5.0000");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.tenant_id, undefined, "the tenant is the session's, never echoed");

  // ...and now the derivation the same tenant could not make a moment ago succeeds and binds it.
  const after = await call(env, "accounting", "POST", "/api/v1/accounting/intents", {
    body: derivationBody(),
    idempotencyKey: "idem-derive-withtax-0001",
  });
  assert.equal(after.status, 201, JSON.stringify(after.body));
  const intent = await readAccountingIntent(
    env, TENANT, (after.body.intent as { intent_id: string }).intent_id,
  );
  assert.ok(intent?.tax_policy_snapshot_sha256, "the candidate bound a rate somebody recorded");

  // The same rate again is one snapshot, not a second version of the same number: the facts hash
  // is the idempotency, which is the guarantee `recordTaxPolicySnapshot` has always given.
  const again = await call(env, "accounting", "POST", "/api/v1/accounting/tax/snapshots", {
    body: {
      jurisdiction: "CA-AB",
      tax_code: "GST",
      provider_tax_code_id: "3",
      rate_percent: "5",
      effective_from: "2008-01-01",
      source_ref: "CRA GST bulletin 2008-01-01",
    },
    idempotencyKey: "idem-taxsnap-00000002",
  });
  assert.equal(again.status, 201);
  assert.equal((again.body.snapshot as { snapshot_id: string }).snapshot_id, snapshot.snapshot_id);

  // A different rate is a different snapshot, versioned beside the first rather than over it -
  // section 5.4's "a rate change creates a NEW snapshot", with the old one still immutable.
  const raised = await call(env, "accounting", "POST", "/api/v1/accounting/tax/snapshots", {
    body: {
      jurisdiction: "CA-AB",
      tax_code: "GST",
      provider_tax_code_id: "3",
      rate_percent: "6.0000",
      effective_from: "2026-09-01",
      source_ref: "CRA GST bulletin 2026-09-01",
    },
    idempotencyKey: "idem-taxsnap-00000003",
  });
  assert.equal(raised.status, 201);
  assert.equal((raised.body.snapshot as { version: number }).version, 2);
  const listed = await call(
    env, "accounting", "GET", "/api/v1/accounting/tax/snapshots?period=2026-09",
  );
  assert.equal((listed.body.snapshots as unknown[]).length, 2);
});

test("recording a rate is gated, CSRF-checked, key-required, and refuses a rate that is not one", async () => {
  const { env } = apiTestEnv();
  const path = "/api/v1/accounting/tax/snapshots";
  const body = {
    jurisdiction: "CA-AB",
    tax_code: "GST",
    rate_percent: "5.0000",
    effective_from: "2008-01-01",
    source_ref: "CRA GST bulletin 2008-01-01",
  };

  // `ops` holds `accounting:read` alone: reading the rates is not recording them.
  const ops = await call(env, "ops", "POST", path, { body, idempotencyKey: "idem-tax-ops-00001" });
  assert.equal(ops.status, 403);
  const sales = await call(env, "sales", "POST", path, { body, idempotencyKey: "idem-tax-sal-001" });
  assert.equal(sales.status, 403);

  const noCsrf = await call(env, "accounting", "POST", path, { body, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const noKey = await call(env, "accounting", "POST", path, { body, idempotencyKey: null });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "idempotency_key_required");

  for (const bad of [
    { ...body, rate_percent: "-5.0000" },
    { ...body, rate_percent: "5.000005" },
    { ...body, rate_percent: "five" },
    { ...body, effective_from: "not-a-date" },
    { ...body, source_ref: "x" },
    { ...body, jurisdiction: "C" },
  ]) {
    const refused = await call(env, "accounting", "POST", path, {
      body: bad,
      idempotencyKey: "idem-tax-bad-000001",
    });
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal(refused.body.error, "invalid_accounting_tax_snapshot");
  }

  // The tenant is the session's, and a body that tries to name one is refused outright.
  const extraField = await call(env, "accounting", "POST", path, {
    body: { ...body, tenant_id: "someone-else" },
    idempotencyKey: "idem-tax-extra-00001",
  });
  assert.equal(extraField.status, 400);
  assert.equal(extraField.body.error, "unexpected_field");

  assert.deepEqual(
    (await call(env, "accounting", "GET", "/api/v1/accounting/tax/snapshots")).body.snapshots,
    [],
    "not one refusal wrote a rate",
  );
});

test("the allowed-action list mirrors the permissions the session really holds", async () => {
  const { env } = apiTestEnv();
  const accountant = await call(env, "accounting", "GET", "/api/v1/accounting/summary");
  const owner = await call(env, "owner", "GET", "/api/v1/accounting/summary");
  const ops = await call(env, "ops", "GET", "/api/v1/accounting/summary");

  assert.ok((accountant.body.allowed_actions as string[]).includes("accounting.intent.approve"));
  assert.ok(!(accountant.body.allowed_actions as string[]).includes("accounting.holdback.release"));
  assert.ok((owner.body.allowed_actions as string[]).includes("accounting.holdback.release"));
  assert.deepEqual(ops.body.allowed_actions, ["accounting.read"]);
});

test("an unknown path under the money desk is a 404, not a fall-through", async () => {
  const { env } = apiTestEnv();
  for (const path of [
    "/api/v1/accounting",
    "/api/v1/accounting/nonsense",
    "/api/v1/accounting/intents/x/detonate",
    "/api/v1/accounting/payroll/pr-1",
  ]) {
    const response = await call(env, "owner", "GET", path);
    assert.equal(response.status, 404, path);
  }
});
