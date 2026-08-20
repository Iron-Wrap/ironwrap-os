// Slice S8. The scheduled money-plane sweeps.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.1. Two of the three sweeps write nothing,
// and the tests here are as interested in that as in what they do write: the negative assertions
// below ("the state is unchanged", "the exception is still open") are the executable form of
// `accounting-sweeps.ts`'s governing rule that a timer is not evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import { REALM, TENANT, fakeIntuit, testEnv } from "./accounting-fixture.ts";
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
  accountingSweepIsNoteworthy,
  accountingSweepTenantId,
  runAccountingSweeps,
  sweepAgeingAccountingExceptions,
  sweepDueAccountingObservations,
  sweepUncertainAccountingIntents,
  type SweepProviderReader,
} from "../src/accounting-sweeps.ts";
import { readAccountingIntent } from "../src/accounting-intents.ts";
import {
  listAccountingExceptions,
  readLiveAccountingException,
} from "../src/accounting-exceptions.ts";
import { listAccountingObservations } from "../src/accounting-reconciliation.ts";
import { readProviderEntity } from "../src/accounting-provider-read.ts";
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

/** Well after every scenario instant, so a stale window of any sane length has elapsed. */
const MUCH_LATER = new Date("2026-08-22T12:00:00.000Z");

async function submittedInvoice(
  env: AppEnv,
  options: { lostResponse?: boolean } = {},
): Promise<string> {
  const port = new TestMoneyEffectPort();
  const { intent, expected } = await deriveScenarioIntent(env);
  await approveIntent(env, intent);
  await submitAccountingIntent(env, {
    ...PORT_INPUT,
    tenantId: TENANT,
    intentId: intent.intent_id,
    port,
    executor: scenarioExecutor({
      providerExternalId: "2001",
      observed: expected,
      // A lost response: the provider may have committed, and we never learned the answer.
      ...(options.lostResponse
        ? {
          readbackStatus: "unavailable" as const,
          detailCode: "provider_readback_unavailable",
        }
        : {}),
    }),
    expectedReadback: expected,
  }, AT_SUBMIT);
  return intent.intent_id;
}

/** A reader over the synthetic fixtures, shaped exactly like the S11 binding will be. */
function fixtureReader(entityFile: string): { read: SweepProviderReader; calls: () => number } {
  let calls = 0;
  const { fetcher } = fakeIntuit([entityRoute("Invoice", entityFile)]);
  return {
    calls: () => calls,
    read: async (input) => {
      calls += 1;
      return await readProviderEntity(scenarioAuth(), { ...input, source: "sweep" }, fetcher, MUCH_LATER);
    },
  };
}

test("with no reader bound the due sweep reports what is stale and changes nothing", async () => {
  const { env } = testEnv();
  const intentId = await submittedInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);

  const result = await sweepDueAccountingObservations(env, {
    tenantId: TENANT,
    now: MUCH_LATER,
  });

  assert.equal(result.reader_unbound, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.due.length, 1);
  assert.equal(result.due[0]!.intent_id, intentId);
  // Never read at all, rather than read long ago: the two are different facts and stay different.
  assert.equal(result.due[0]!.last_read_at, null);
  assert.equal(result.reread, 0);

  const after = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(after?.state, before?.state);
  assert.equal(after?.version, before?.version);
  assert.equal((await listAccountingObservations(env, TENANT, { intentId })).length, 0);
});

test("with a reader bound the due sweep re-reads and judges what it finds", async () => {
  const { env } = testEnv();
  const intentId = await submittedInvoice(env);
  const reader = fixtureReader("invoice-open.json");

  const result = await sweepDueAccountingObservations(env, {
    tenantId: TENANT,
    read: reader.read,
    now: MUCH_LATER,
  });

  assert.equal(result.reader_unbound, false);
  assert.equal(result.reread, 1);
  assert.equal(reader.calls(), 1);
  // The fixture's balance is not zero, so an honest verdict is not `reconciled`.
  assert.equal(result.reconciled, 0);
  const observations = await listAccountingObservations(env, TENANT, { intentId });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.source, "sweep");
  assert.equal(observations[0]!.entity_id, "2001");
});

test("a freshly read intent is not due again inside the window", async () => {
  const { env } = testEnv();
  await submittedInvoice(env);
  const reader = fixtureReader("invoice-open.json");
  await sweepDueAccountingObservations(env, {
    tenantId: TENANT, read: reader.read, now: MUCH_LATER,
  });

  const second = await sweepDueAccountingObservations(env, {
    tenantId: TENANT,
    read: reader.read,
    // One minute after the read that just happened, with a one-day window.
    now: new Date(MUCH_LATER.getTime() + 60_000),
  });
  assert.equal(second.due.length, 0);
  assert.equal(second.reread, 0);
  assert.equal(reader.calls(), 1);
});

test("a provider outage during the sweep leaves every money state exactly as it was", async () => {
  const { env } = testEnv();
  const intentId = await submittedInvoice(env);
  const before = await readAccountingIntent(env, TENANT, intentId);
  const { fetcher } = fakeIntuit([
    entityRoute("Invoice", "invoice-open.json", { networkError: true }),
  ]);

  const result = await sweepDueAccountingObservations(env, {
    tenantId: TENANT,
    now: MUCH_LATER,
    read: async (input) =>
      await readProviderEntity(scenarioAuth(), { ...input, source: "sweep" }, fetcher, MUCH_LATER),
  });

  assert.equal(result.unavailable, 1);
  const after = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(after?.state, before?.state);
  assert.equal(after?.version, before?.version);
  assert.equal((await listAccountingObservations(env, TENANT, { intentId })).length, 0);
});

test("an uncertain dispatch waits until its deadline, then becomes an accountant's exception", async () => {
  const { env } = testEnv();
  const intentId = await submittedInvoice(env, { lostResponse: true });
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "uncertain");

  const waiting = await sweepUncertainAccountingIntents(env, {
    tenantId: TENANT,
    deadlineSeconds: 6 * 60 * 60,
    now: new Date(AT_SUBMIT.getTime() + 60_000),
  });
  assert.deepEqual(waiting.waiting, [intentId]);
  assert.equal(waiting.expired.length, 0);
  assert.equal((await readAccountingIntent(env, TENANT, intentId))?.state, "uncertain");
  assert.equal((await listAccountingExceptions(env, TENANT, { intentId })).length, 0);

  const expired = await sweepUncertainAccountingIntents(env, {
    tenantId: TENANT,
    deadlineSeconds: 6 * 60 * 60,
    now: MUCH_LATER,
  });
  assert.deepEqual(expired.expired, [intentId]);
  const intent = await readAccountingIntent(env, TENANT, intentId);
  assert.equal(intent?.state, "reconciliation_required");
  assert.equal(intent?.reason_code, "unknown_effect_deadline_expired");

  const exception = await readLiveAccountingException(
    env, TENANT, `accounting_intent:${intentId}`, "unknown_effect_deadline_expired",
  );
  assert.ok(exception, "the deadline sweep must leave a decision for a person");
});

test("the ageing sweep reports the queue's age and acknowledges nothing on anybody's behalf", async () => {
  const { env } = testEnv();
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
  await ingestObservedPayment(env, scenarioAuth(), {
    tenantId: TENANT, paymentEntityId: "3005", source: "sweep",
  }, fetcher, AT_READ);

  const fresh = await sweepAgeingAccountingExceptions(env, {
    tenantId: TENANT,
    agingAfterSeconds: 48 * 60 * 60,
    now: new Date(AT_READ.getTime() + 60_000),
  });
  assert.equal(fresh.open, 1);
  assert.equal(fresh.ageing.length, 0);
  assert.equal(fresh.oldest_age_seconds, 60);

  const aged = await sweepAgeingAccountingExceptions(env, {
    tenantId: TENANT,
    agingAfterSeconds: 60,
    now: MUCH_LATER,
  });
  assert.equal(aged.ageing.length, 1);
  assert.equal(aged.ageing[0]!.reason_code, "provider_overpayment");

  // A cron acknowledging an exception would put a person's name on a decision nobody made.
  const [exception] = await listAccountingExceptions(env, TENANT);
  assert.equal(exception!.status, "open");
  assert.equal(exception!.acknowledged_by_user_id, null);
});

test("the cron entry point runs all three and stays quiet when there is nothing to say", async () => {
  const { env } = testEnv();
  const quiet = await runAccountingSweeps(env, { tenantId: TENANT, now: MUCH_LATER });
  assert.equal(quiet.tenant_id, TENANT);
  assert.equal(accountingSweepIsNoteworthy(quiet), false);

  await submittedInvoice(env);
  const noisy = await runAccountingSweeps(env, { tenantId: TENANT, now: MUCH_LATER });
  assert.equal(noisy.due_observations.due.length, 1);
  assert.equal(accountingSweepIsNoteworthy(noisy), true);
});

test("the sweep never crosses a tenant boundary", async () => {
  const { env } = testEnv();
  await submittedInvoice(env);
  const other = await runAccountingSweeps(env, { tenantId: "someone-else", now: MUCH_LATER });
  assert.equal(other.due_observations.scanned, 0);
  assert.equal(other.uncertain.scanned, 0);
  assert.equal(other.exceptions.open, 0);
});

test("the scheduled tenant is the runtime's configured identity, with the repository default", () => {
  assert.equal(accountingSweepTenantId({ APP_TENANT_ID: "  acme  " } as AppEnv), "acme");
  assert.equal(accountingSweepTenantId({} as AppEnv), "ironwrap");
  assert.equal(accountingSweepTenantId({ APP_TENANT_ID: "  " } as AppEnv), "ironwrap");
});

test("a realm is never invented: the reader is asked for the entity the intent actually bound", async () => {
  const { env } = testEnv();
  await submittedInvoice(env);
  const asked: Array<{ entityType: string; entityId: string }> = [];
  await sweepDueAccountingObservations(env, {
    tenantId: TENANT,
    now: MUCH_LATER,
    read: async (input) => {
      asked.push({ entityType: input.entityType, entityId: input.entityId });
      return { status: "unavailable", detailCode: "provider_unreachable" };
    },
  });
  assert.deepEqual(asked, [{ entityType: "Invoice", entityId: "2001" }]);
  assert.equal(REALM.length > 0, true);
});
