// Slice S8. The money desk read model.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2 requires one badge per intent "mapped
// straight from the effect ledger so the screen cannot drift from the truth". The first two tests
// here are what make that structural rather than aspirational: every state the aggregate can hold
// is asserted to have a badge and a plain-language next step, so adding a state to
// `ACCOUNTING_INTENT_STATES` without teaching the desk about it is a failing test rather than a
// screen that renders `undefined`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TENANT, fakeIntuit, testEnv } from "./accounting-fixture.ts";
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
import {
  ACCOUNTING_BADGES,
  ACCOUNTING_QUEUES,
  accountingBadge,
  accountingNextStep,
  ageSeconds,
  periodWindow,
  projectAccountingIntent,
  proposeTaxRemittance,
  readAccountingIntentDetail,
  summarizeAccountingDesk,
} from "../src/accounting-desk.ts";
import {
  ACCOUNTING_INTENT_STATES,
  applyAccountingIntentCommand,
  readAccountingIntent,
  type AccountingIntentState,
} from "../src/accounting-intents.ts";
import { ingestObservedPayment } from "../src/accounting-payments.ts";
import { submitAccountingIntent } from "../src/accounting-submission.ts";

const PORT_INPUT = {
  actor: DISPATCH_ACTOR,
  taskId: "task:accounting:submit",
  correlationId: "corr:accounting:0001",
  deadlineAt: DEADLINE,
  authorityExpiresAt: AUTHORITY_EXPIRES,
  taxPreflightOnDate: "2026-08-19",
};

async function postedInvoice(env: AppEnv, intentId?: string): Promise<string> {
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env, {
    ...(intentId === undefined ? {} : { intentId }),
  });
  await approveIntent(env, intent);
  await submitAccountingIntent(env, {
    ...PORT_INPUT,
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({ providerExternalId: "2001", observed: expected }),
    expectedReadback: expected,
  }, AT_SUBMIT);
  return intent.intent_id;
}

test("every state the aggregate can hold has a badge from the declared vocabulary", () => {
  for (const state of ACCOUNTING_INTENT_STATES) {
    const badge = accountingBadge(state);
    assert.ok(badge, `state ${state} has no badge`);
    assert.ok(
      (ACCOUNTING_BADGES as readonly string[]).includes(badge),
      `state ${state} maps to ${badge}, which is not a declared badge`,
    );
  }
});

test("every state carries a plain-language next step, never a reason code", () => {
  for (const state of ACCOUNTING_INTENT_STATES) {
    const step = accountingNextStep(state);
    assert.ok(step && step.length > 10, `state ${state} has no usable next step`);
    // Section 8.2: a next step is a sentence a non-technical office manager can act on.
    assert.doesNotMatch(step, /_/, `the next step for ${state} reads like a reason code`);
    assert.match(step, /[.?]$/, `the next step for ${state} is not a sentence`);
  }
});

test("the six badges section 8.2 names are all reachable, and the two extras are declared", () => {
  const reachable = new Set(
    ACCOUNTING_INTENT_STATES.map((state) => accountingBadge(state)),
  );
  for (const badge of ["pending", "in_flight", "uncertain", "mismatched", "compensated", "reconciled"]) {
    assert.ok(reachable.has(badge as never), `section 8.2's ${badge} badge is unreachable`);
  }
  // `rejected` and `failed` are the declared extras: real aggregate states section 8.2's list
  // predates. A screen that could not render them would have to hide or mislabel those intents.
  assert.deepEqual([...reachable].sort(), [...ACCOUNTING_BADGES].sort());
});

test("the desk summary counts the four queues section 8.2 names", async () => {
  const { env } = testEnv();
  // One awaiting the provider, one still needing approval, one mismatched with a live exception.
  await postedInvoice(env, "acct-intent:job-a:deposit_invoice");
  await deriveScenarioIntent(env, { intentId: "acct-intent:job-b:deposit_invoice" });
  await postedInvoice(env, "acct-intent:job-c:deposit_invoice");
  const { fetcher } = fakeIntuit([
    entityRoute("Payment", "payment-overpaid-1500.json"),
    entityRoute("Invoice", "invoice-paid.json"),
  ]);
  await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);

  const summary = await summarizeAccountingDesk(env, TENANT, { now: AT_READ });
  assert.deepEqual(Object.keys(summary.queues).sort(), [...ACCOUNTING_QUEUES].sort());
  assert.equal(summary.queues.needs_approval.count, 1);
  assert.equal(summary.queues.mismatched.count, 1);
  assert.equal(summary.queues.exceptions.count, 1);
  assert.equal(summary.reconciliation_health.open_exceptions, 1);
  assert.ok(summary.reconciliation_health.oldest_unreconciled_intent_id);
});

test("reconciliation health counts intents nobody has read back yet, separately from stale ones", async () => {
  const { env } = testEnv();
  await postedInvoice(env);
  const summary = await summarizeAccountingDesk(env, TENANT, { now: AT_READ });
  assert.equal(summary.reconciliation_health.unobserved_intent_count, 1);
  assert.equal(summary.reconciliation_health.stale_observation_count, 0);
  assert.equal(summary.reconciliation_health.stale_after_seconds, 24 * 60 * 60);
});

test("a summary for a tenant with nothing in it is empty rather than an error", async () => {
  const { env } = testEnv();
  const summary = await summarizeAccountingDesk(env, TENANT, { now: AT_READ });
  for (const queue of ACCOUNTING_QUEUES) {
    assert.equal(summary.queues[queue].count, 0);
    assert.equal(summary.queues[queue].oldest_age_seconds, null);
  }
  assert.equal(summary.reconciliation_health.oldest_unreconciled_intent_id, null);
});

test("the intent projection carries no tenant id and no provider payload body", async () => {
  const { env } = testEnv();
  const intentId = await postedInvoice(env);
  const intent = await readAccountingIntent(env, TENANT, intentId);
  const row = projectAccountingIntent(intent!, AT_READ);

  assert.ok(!("tenant_id" in row));
  assert.ok(!("provider_payload_json" in row));
  assert.ok(!("basis_json" in row));
  assert.equal(row.badge, "in_flight");
  assert.equal(row.age_seconds, ageSeconds(intent!.derived_at, AT_READ));
});

test("the customer is read from the bound basis, and is null when the basis does not name one", async () => {
  const { env } = testEnv();
  const intentId = await postedInvoice(env);
  const intent = await readAccountingIntent(env, TENANT, intentId);
  // The scenario basis names a job and an intent, never a customer, so nothing is invented.
  assert.equal(projectAccountingIntent(intent!, AT_READ).customer_ref, null);

  const named = {
    ...intent!,
    basis_json: JSON.stringify({ customerRef: "CUST-0001", roofJob: "job-0001" }),
  };
  assert.equal(projectAccountingIntent(named, AT_READ).customer_ref, "CUST-0001");
});

test("the detail's comparison says 'nothing read back yet' rather than 'they disagree'", async () => {
  const { env } = testEnv();
  const intentId = await postedInvoice(env);
  const detail = await readAccountingIntentDetail(env, TENANT, intentId, AT_READ);

  assert.ok(detail);
  assert.equal(detail.comparison.awaiting_readback, true);
  assert.equal(detail.comparison.observed_sha256, null);
  assert.equal(detail.comparison.hashes_agree, false);
  // A fact with nothing on the observed side is not a disagreement about that fact.
  const entityId = detail.comparison.fields.find((field) => field.field === "provider_entity_id");
  assert.equal(entityId?.observed, null);
  assert.equal(entityId?.agrees, false);
  assert.ok(!JSON.stringify(detail).includes("provider_payload_json"));
});

test("the detail carries the events, the tax bindings, and the intent's own evidence hashes", async () => {
  const { env } = testEnv();
  const intentId = await postedInvoice(env);
  const detail = await readAccountingIntentDetail(env, TENANT, intentId, AT_READ);

  assert.ok(detail);
  assert.ok(detail.events.length >= 2, "derivation and approval are both events");
  assert.equal(detail.tax_bindings.length, 1);
  assert.equal(detail.tax_bindings[0]!.tax_code, "GST");
  assert.match(detail.evidence.basis_sha256, /^[0-9a-f]{64}$/);
  assert.match(detail.evidence.expected_sha256, /^[0-9a-f]{64}$/);
  assert.equal(detail.evidence.authority_max_amount, "5000.00");
});

test("an intent that does not exist reads as null, not as an empty detail", async () => {
  const { env } = testEnv();
  assert.equal(await readAccountingIntentDetail(env, TENANT, "acct-intent:nope", AT_READ), null);
});

test("a period is a year or a month, and anything else is not a period", () => {
  assert.deepEqual(periodWindow("2026-08"), {
    start: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(periodWindow("2026-12"), {
    start: "2026-12-01T00:00:00.000Z",
    endExclusive: "2027-01-01T00:00:00.000Z",
  });
  assert.deepEqual(periodWindow("2026"), {
    start: "2026-01-01T00:00:00.000Z",
    endExclusive: "2027-01-01T00:00:00.000Z",
  });
  for (const bogus of ["2026-13", "2026-00", "last-month", "", "26-08", "2026-8", "1999"]) {
    assert.equal(periodWindow(bogus), null, `${bogus} was accepted as a period`);
  }
});

test("the remittance proposal keeps confirmed tax apart from tax still in flight", async () => {
  const { env } = testEnv();
  await postedInvoice(env, "acct-intent:job-a:deposit_invoice");
  await deriveScenarioIntent(env, { intentId: "acct-intent:job-b:deposit_invoice" });

  const proposal = await proposeTaxRemittance(env, TENANT, "2026-08");
  assert.ok(proposal);
  // One submitted invoice's 60.00, and one candidate nobody has approved yet.
  assert.equal(proposal.submitted_tax_total, "60.00");
  assert.equal(proposal.pending_tax_total, "60.00");
  assert.equal(proposal.intents.length, 2);
  assert.equal(proposal.snapshots.length, 1);
  // IronWrap proposes and reconciles; filing is a licensed act performed by the accountant.
  assert.equal(proposal.filing_authority, "accountant");
});

test("a rejected candidate's tax counts towards neither total", async () => {
  const { env } = testEnv();
  const { intent } = await deriveScenarioIntent(env);
  await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "reject",
    actorUserId: "appu_accounting_0001",
    idempotencyKey: `reject:${intent.intent_id}`,
    request: { version: intent.version, reason_code: "amount_disputed" },
    requestedVersion: intent.version,
    reasonCode: "amount_disputed",
  }, AT_READ);

  assert.equal((await readAccountingIntent(env, TENANT, intent.intent_id))?.state, "rejected");
  const proposal = await proposeTaxRemittance(env, TENANT, "2026-08");
  assert.equal(proposal!.submitted_tax_total, "0.00");
  assert.equal(proposal!.pending_tax_total, "0.00");
});

test("a period with no money in it proposes zero rather than nothing", async () => {
  const { env } = testEnv();
  const proposal = await proposeTaxRemittance(env, TENANT, "2020-01");
  assert.ok(proposal);
  assert.equal(proposal.submitted_tax_total, "0.00");
  assert.equal(proposal.intents.length, 0);
});

test("the badge map and the state list cannot drift apart", () => {
  // A guard against the one failure this projection is uniquely exposed to: a new state added to
  // the aggregate that the desk silently renders as `undefined`.
  const states = new Set<AccountingIntentState>(ACCOUNTING_INTENT_STATES);
  assert.equal(states.size, ACCOUNTING_INTENT_STATES.length);
  for (const state of states) {
    assert.equal(typeof accountingBadge(state), "string");
    assert.equal(typeof accountingNextStep(state), "string");
  }
});
