// accounting-dispatch.ts - the production caller of the money engine.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4 and 8.1. Slices S1-S5 built
// everything that moves money and S8 built the routes an accountant presses, and nothing joined
// them: `commandIntent`'s approve wrote a command receipt, the `0058` trigger flipped the intent to
// `submission_pending`, and that was the end of it - `submitAccountingIntent` had no production
// caller, `deriveCompensationIntent` and `submitAccountingCompensation` had none at all, and the
// desk's "Being sent to QuickBooks. Nothing else to do yet." was permanent (ELEC-71, proven on the
// running stack). This module is the caller.
//
// **Why a cron-drained runner and not a Queue consumer.** The nearest precedent in this repo is
// `quickbooks-final-invoice.ts`, and what it actually uses is a D1 outbox drained by
// `recoverQuickBooksFinalInvoices` on the frequent cron - not a Cloudflare Queue. Following it
// costs no `wrangler.jsonc` change, which matters because a new queue binding is a production
// configuration change; and the money plane already has its outbox, because `submission_pending`
// *is* the queue. `accounting-sweeps.ts` is registered on that same cron for the same class of
// work, so this joins it rather than inventing a second scheduling mechanism.
//
// **Why the binding is injected.** Same reason `sweepDueAccountingObservations` takes an optional
// reader: a Worker with no QuickBooks connection must report what is pending and dispatch nothing.
// Unbound is a normal state, not an error, and project rule 5 ("no live provider calls") then holds
// by construction rather than by discipline - under test the binding is the synthetic Intuit
// double, and in an unbound runtime there is nothing to call.
//
// **Ordering is the contract.** Dispatch, then bind the identity the ledger settled on, then read
// the provider back and judge it. Section 5.1 admits only an authenticated readback as a route to
// `reconciled`, so the readback is a separate call and never the create response echoed back.

import { readDerivedExpectationEnvelope } from "./accounting-expectations.ts";
import {
  listPendingCompensationAuthorizations,
  type AccountingCompensationAuthorizationRecord,
} from "./accounting-compensation-authorizations.ts";
import {
  deriveCompensationIntent,
  submitAccountingCompensation,
  type CompensationPlan,
} from "./accounting-compensation.ts";
import {
  applyAccountingIntentCommand,
  listAccountingIntents,
  readAccountingIntent,
  type AccountingIntentRecord,
} from "./accounting-intents.ts";
import {
  localFactEnvelope,
  type AccountingEntityType,
} from "./accounting-normalizers.ts";
import { readProviderEntity } from "./accounting-provider-read.ts";
import { reconcileAccountingIntent } from "./accounting-reconciliation.ts";
import {
  dispatchRefusalCode,
  submitAccountingIntent,
} from "./accounting-submission.ts";
import type {
  MoneyActorType,
  MoneyEffectExecutor,
  MoneyEffectPort,
} from "./accounting-effect-port.ts";
import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import type { AppEnv } from "./app-types.ts";

/** How long a dispatched effect has to settle before the ledger calls the deadline. */
export const DEFAULT_DISPATCH_DEADLINE_SECONDS = 15 * 60;

/** How long the authority bound to one dispatch stays valid. */
export const DEFAULT_DISPATCH_AUTHORITY_SECONDS = 15 * 60;

/** Past this, an intent that never left `submission_pending` is stuck, not in flight. */
export const DEFAULT_STUCK_DISPATCH_SECONDS = 30 * 60;

/**
 * Everything the dispatcher needs to reach the provider, and nothing else.
 *
 * Deliberately the whole seam: with it the runner dispatches, without it the runner reports. There
 * is no third mode where it half-dispatches, because a money path that degrades quietly is worse
 * than one that refuses.
 */
export interface AccountingDispatchBinding {
  port: MoneyEffectPort;
  /** The provider adapter for one intent. Built per intent so each one gets its own payload. */
  executorFor(input: { intent: AccountingIntentRecord }): MoneyEffectExecutor<unknown>;
  /** Used only for the post-dispatch authenticated readback (section 5.1). */
  auth: QuickBooksAuthPort;
  fetcher?: typeof fetch;
  /**
   * Who the ledger binds the dispatch authority to. `MoneyActorType` predates the accounting role,
   * so a scheduled money mutation runs as `worker` - the actor that is neither a person claiming
   * authority they did not exercise nor an agent pretending a human pressed the button.
   */
  actor?: { type: MoneyActorType; id: string };
  deadlineSeconds?: number;
  authoritySeconds?: number;
}

export interface DispatchedIntent {
  intent_id: string;
  kind: string;
  /** `submitted`, `blocked`, `uncertain`, `failed`, `in_flight`, or a refusal code. */
  status: string;
  blocker_code: string | null;
  state: string;
  verdict: string | null;
  provider_entity_id: string | null;
}

export interface AccountingDispatchReport {
  tenant_id: string;
  /** Every intent sitting in `submission_pending` when the runner looked. */
  pending: string[];
  dispatched: DispatchedIntent[];
  /** Intents skipped because they predate `0063` and have no stored expectation envelope. */
  expectation_unbound: string[];
  /**
   * Intents whose dispatch threw, with the code that stopped each one.
   *
   * Named per intent rather than aggregated, because the failure this array exists to answer
   * (ELEC-73 finding 1) was invisible precisely for being aggregated: one throw took down the whole
   * batch and left a single log line with no `intent_id` in it.
   */
  failed: Array<{ intent_id: string; code: string }>;
  /** True when no binding was supplied, so `pending` is a report and nothing was dispatched. */
  dispatcher_unbound: boolean;
}

/**
 * Dispatch every approved intent that is waiting.
 *
 * Reaches `submitted` through the port, then completes the expectation with the identity the ledger
 * settled on, then re-reads the provider and judges it - which is the only route to `reconciled`
 * section 5.1 admits. A kind that never writes (a Payment, a tax remittance proposal) is skipped by
 * its own refusal code rather than being dispatched and rejected.
 */
export async function runAccountingDispatch(
  env: AppEnv,
  input: {
    tenantId: string;
    binding?: AccountingDispatchBinding;
    limit?: number;
    now?: Date;
  },
): Promise<AccountingDispatchReport> {
  const now = input.now ?? new Date();
  const pending = await listAccountingIntents(env, input.tenantId, {
    state: "submission_pending",
    limit: input.limit ?? 25,
  });

  const report: AccountingDispatchReport = {
    tenant_id: input.tenantId,
    pending: pending.map((intent) => intent.intent_id),
    dispatched: [],
    expectation_unbound: [],
    failed: [],
    dispatcher_unbound: input.binding === undefined,
  };
  const binding = input.binding;
  if (!binding) return report;

  for (const intent of pending) {
    try {
      const dispatched = await dispatchOne(env, intent, binding, input.tenantId, now, report);
      if (dispatched) report.dispatched.push(dispatched);
    } catch (error) {
      // One poisoned intent must not stop the rest of the queue - the same rule
      // `runAccountingCompensationDispatch` below already keeps, and for a sharper reason here.
      // `listAccountingIntents` orders by `derived_at, intent_id`, and a throw happens before
      // `recordAccountingIntentSubmission`, so the failing intent stays `submission_pending` and
      // sorts first again on the next tick: without this catch, one bad row is a permanent
      // head-of-line block on the tenant's entire money queue, not a single stuck intent
      // (ELEC-73 finding 1, reproduced with two approved intents).
      report.failed.push({
        intent_id: intent.intent_id,
        code: error instanceof Error ? error.message : "accounting_dispatch_failed",
      });
    }
  }
  return report;
}

async function dispatchOne(
  env: AppEnv,
  intent: AccountingIntentRecord,
  binding: AccountingDispatchBinding,
  tenantId: string,
  now: Date,
  report: AccountingDispatchReport,
): Promise<DispatchedIntent | null> {
  // A kind that never mutates the provider should not be in `submission_pending` at all, but if it
  // is, it is reported rather than dispatched: section 4.1's observe-only Payment and
  // propose-only remittance refuse by name.
  const refusal = dispatchRefusalCode(intent.kind);
  if (refusal) {
    return {
      intent_id: intent.intent_id,
      kind: intent.kind,
      status: refusal,
      blocker_code: null,
      state: intent.state,
      verdict: null,
      provider_entity_id: intent.provider_entity_id,
    };
  }

  const expected = await readDerivedExpectationEnvelope(env, tenantId, intent.intent_id);
  if (expected === null) {
    // No stored envelope, so nothing can be dispatched against an expectation nobody bound. It
    // stays `submission_pending` and the staleness sweep is what surfaces it.
    report.expectation_unbound.push(intent.intent_id);
    return null;
  }

  const deadlineSeconds = binding.deadlineSeconds ?? DEFAULT_DISPATCH_DEADLINE_SECONDS;
  const authoritySeconds = binding.authoritySeconds ?? DEFAULT_DISPATCH_AUTHORITY_SECONDS;
  const submitted = await submitAccountingIntent(env, {
    tenantId,
    intentId: intent.intent_id,
    port: binding.port,
    executor: binding.executorFor({ intent }),
    actor: binding.actor ?? { type: "worker", id: "accounting-dispatch" },
    taskId: `accounting-dispatch:${intent.intent_id}`,
    correlationId: `accounting-dispatch:${intent.intent_id}:${intent.version}`,
    deadlineAt: new Date(now.getTime() + deadlineSeconds * 1000).toISOString(),
    authorityExpiresAt: new Date(now.getTime() + authoritySeconds * 1000).toISOString(),
    expectedReadback: expected,
  }, now);

  const outcome: DispatchedIntent = {
    intent_id: intent.intent_id,
    kind: intent.kind,
    status: submitted.status,
    blocker_code: submitted.blockerCode,
    state: submitted.intent.state,
    verdict: null,
    provider_entity_id: submitted.intent.provider_entity_id,
  };
  if (submitted.status !== "submitted" || !submitted.intent.provider_entity_id) return outcome;

  // The readback is a separate authenticated read of the exact entity id the ledger settled on,
  // never the create response echoed back: section 5.1 is a statement about what the provider says
  // exists, and a response body from the call that created it is the provider agreeing with itself.
  const read = await readProviderEntity(binding.auth, {
    tenantId,
    entityType: submitted.intent.provider_entity_type as AccountingEntityType,
    entityId: submitted.intent.provider_entity_id,
    source: "dispatch_readback",
    effectAttemptId: submitted.outcome?.attemptId ?? null,
  }, binding.fetcher ?? fetch, now);

  const judged = await reconcileAccountingIntent(env, {
    tenantId,
    intentId: intent.intent_id,
    read,
  }, now);
  outcome.verdict = judged.verdict;
  outcome.state = judged.intent.state;
  return outcome;
}

export interface DispatchedCompensation {
  intent_id: string;
  exception_id: string;
  reversal_intent_id: string;
  status: string;
  original_state: string;
  exception_status: string;
}

export interface AccountingCompensationDispatchReport {
  tenant_id: string;
  authorized: string[];
  dispatched: DispatchedCompensation[];
  /** Authorizations that could not be turned into a reversal, with the code that stopped them. */
  refused: Array<{ exception_id: string; code: string }>;
  dispatcher_unbound: boolean;
}

/**
 * Run every reversal an accountant has authorized.
 *
 * Section 5.4's sentence is "the system proposes; the accountant authorizes; the remedy runs as a
 * compensating effect". The authorization is a row (`0063`), written by `POST /compensate` at the
 * moment a human pressed the button; this is the third clause, and it is the only thing in the
 * codebase that ever runs it. Ordering matters and is the contract's: the reversal reaches the
 * provider first, and only a dispatch the ledger accepted closes the exception and marks the
 * original `compensated`.
 */
export async function runAccountingCompensationDispatch(
  env: AppEnv,
  input: {
    tenantId: string;
    binding?: AccountingDispatchBinding;
    limit?: number;
    now?: Date;
  },
): Promise<AccountingCompensationDispatchReport> {
  const now = input.now ?? new Date();
  const authorizations = await listPendingCompensationAuthorizations(
    env, input.tenantId, input.limit ?? 25,
  );

  const report: AccountingCompensationDispatchReport = {
    tenant_id: input.tenantId,
    authorized: authorizations.map((row) => row.exception_id),
    dispatched: [],
    refused: [],
    dispatcher_unbound: input.binding === undefined,
  };
  const binding = input.binding;
  if (!binding) return report;

  for (const authorization of authorizations) {
    try {
      const dispatched = await dispatchCompensation(
        env, authorization, binding, input.tenantId, now,
      );
      if (dispatched) report.dispatched.push(dispatched);
    } catch (error) {
      // One refused reversal must not stop the rest of the queue, and it must not disappear: the
      // exception stays open and the code that stopped it is reported.
      report.refused.push({
        exception_id: authorization.exception_id,
        code: error instanceof Error ? error.message : "accounting_compensation_dispatch_failed",
      });
    }
  }
  return report;
}

async function dispatchCompensation(
  env: AppEnv,
  authorization: AccountingCompensationAuthorizationRecord,
  binding: AccountingDispatchBinding,
  tenantId: string,
  now: Date,
): Promise<DispatchedCompensation | null> {
  const original = await readAccountingIntent(env, tenantId, authorization.intent_id);
  if (!original) return null;
  const plan = JSON.parse(authorization.plan_json) as CompensationPlan;

  let reversal = await readAccountingIntent(env, tenantId, authorization.reversal_intent_id);
  if (!reversal) {
    reversal = await deriveReversal(env, authorization, plan, original, tenantId, now);
  }
  // The reversal is an ordinary intent and needs the approval every intent needs. The approval is
  // recorded against the accountant who authorized *this* reversal - which is not a stand-in for
  // their decision, it is their decision: the authorization row names them, the amount, and the
  // remedy, and it was written inside the request they made.
  if (reversal.state === "pending_review") {
    const { intent } = await applyAccountingIntentCommand(env, {
      tenantId,
      intentId: reversal.intent_id,
      operation: "approve",
      actorUserId: authorization.authorized_by_user_id,
      idempotencyKey: `compensation-authorization:${authorization.authorization_id}`,
      request: {
        authorizationId: authorization.authorization_id,
        remedy: authorization.remedy,
        amount: authorization.total_amount,
      },
      requestedVersion: reversal.version,
    }, now);
    reversal = intent;
  }
  if (reversal.state !== "submission_pending") {
    return {
      intent_id: original.intent_id,
      exception_id: authorization.exception_id,
      reversal_intent_id: reversal.intent_id,
      status: `reversal_${reversal.state}`,
      original_state: original.state,
      exception_status: "open",
    };
  }

  const expected = await readDerivedExpectationEnvelope(env, tenantId, reversal.intent_id);
  if (expected === null) return null;

  const deadlineSeconds = binding.deadlineSeconds ?? DEFAULT_DISPATCH_DEADLINE_SECONDS;
  const authoritySeconds = binding.authoritySeconds ?? DEFAULT_DISPATCH_AUTHORITY_SECONDS;
  const result = await submitAccountingCompensation(env, {
    tenantId,
    plan,
    reversalIntentId: reversal.intent_id,
    port: binding.port,
    executor: binding.executorFor({ intent: reversal }),
    actor: binding.actor ?? { type: "worker", id: "accounting-dispatch" },
    resolvedByUserId: authorization.authorized_by_user_id,
    taskId: `accounting-compensation:${reversal.intent_id}`,
    correlationId: `accounting-compensation:${authorization.authorization_id}`,
    deadlineAt: new Date(now.getTime() + deadlineSeconds * 1000).toISOString(),
    authorityExpiresAt: new Date(now.getTime() + authoritySeconds * 1000).toISOString(),
    expectedReadback: expected,
  }, now);

  return {
    intent_id: original.intent_id,
    exception_id: authorization.exception_id,
    reversal_intent_id: reversal.intent_id,
    status: result.submission.status,
    original_state: result.original.state,
    exception_status: result.exception.status,
  };
}

/**
 * Turn one authorization into the reversing intent it authorized.
 *
 * The payload is built from the original's own provider payload so the reversal names the same
 * customer and currency, and the expectation is the projection of that payload through the section
 * 5.2 descriptor - "what we said should be true", with the provider's `Id` left for the ledger to
 * settle. Tax is apportioned in integer cents so `subtotal + tax` is exactly the total, which
 * `deriveCompensationIntent` refuses to accept otherwise.
 */
async function deriveReversal(
  env: AppEnv,
  authorization: AccountingCompensationAuthorizationRecord,
  plan: CompensationPlan,
  original: AccountingIntentRecord,
  tenantId: string,
  now: Date,
): Promise<AccountingIntentRecord> {
  const entityType: AccountingEntityType = plan.providerEntityType;
  const originalPayload = parseObject(original.provider_payload_json);
  const magnitudeCents = Math.abs(Number.parseInt(plan.totalAmount.replace(".", ""), 10));
  const { subtotal, taxAmount } = apportion(original, magnitudeCents);
  const txnDate = now.toISOString().slice(0, 10);

  const providerPayload: Record<string, unknown> = {
    CustomerRef: originalPayload.CustomerRef ?? null,
    CurrencyRef: originalPayload.CurrencyRef ?? null,
    TxnDate: txnDate,
    TotalAmt: plan.magnitudeAmount,
    Line: [{
      DetailType: "SalesItemLineDetail",
      // The line carries the net, not the gross: tax travels in `TxnTaxDetail`, which is how the
      // section 5.2 descriptor reads an invoice and therefore how it reads a credit memo.
      Amount: subtotal,
      SalesItemLineDetail: firstLineDetail(originalPayload),
    }],
    ...(entityType === "CreditMemo"
      ? {
        // A credit memo is due the day it is issued; the descriptor hashes `DueDate`, so leaving
        // it unset would guarantee a mismatch against every readback.
        DueDate: txnDate,
        TxnTaxDetail: { TotalTax: taxAmount },
        RemainingCredit: plan.magnitudeAmount,
      }
      : { DepositToAccountRef: originalPayload.DepositToAccountRef ?? null }),
  };

  return await deriveCompensationIntent(env, {
    tenantId,
    plan,
    reversalIntentId: authorization.reversal_intent_id,
    roofJobId: original.roof_job_id,
    // Unique per exception, because `deriveAccountingIntent` dedupes on the basis hash: two
    // exceptions on one intent must derive two reversals, and one exception must derive only ever
    // the same single reversal however many times the runner sees it.
    basis: {
      reverses: original.intent_id,
      exceptionId: authorization.exception_id,
      remedy: authorization.remedy,
      amount: plan.totalAmount,
    },
    sourceDocuments: [{ id: authorization.exception_id, version: 1 }],
    expected: localFactEnvelope({
      realmId: original.realm_id,
      entityType,
      payload: providerPayload,
    }),
    realmId: original.realm_id,
    providerPayload,
    providerRequestId: `rev-${authorization.authorization_id}`.slice(0, 50),
    subtotal,
    taxAmount,
    // A credit memo carries tax and therefore must bind a snapshot; a refund receipt does not.
    taxPolicySnapshotSha256: plan.reversalKind === "credit_memo"
      ? original.tax_policy_snapshot_sha256
      : null,
    authority: {
      permitRef: original.authority_permit_ref,
      policyRef: original.authority_policy_ref,
      policyVersion: original.authority_policy_version,
      maxAmount: original.authority_max_amount,
    },
    effectIdempotencyKey: `acct-reversal:${authorization.authorization_id}`,
    // Derivation is the system's work (section 6); the authorization above it is the human's.
    derivedBy: { actorKind: "agent" },
    compensatesEffectId: original.effect_id,
  }, now);
}

/**
 * Split a reversal magnitude into subtotal and tax in the original's own proportion.
 *
 * Integer cents throughout, with the remainder going to the subtotal, so the two parts sum to the
 * total exactly. A refund receipt carries no tax at all (section 5.2 does not hash tax for one), so
 * it is the whole magnitude as subtotal.
 */
function apportion(
  original: AccountingIntentRecord,
  magnitudeCents: number,
): { subtotal: string; taxAmount: string } {
  const originalTotal = Math.abs(Number.parseInt(original.total_amount.replace(".", ""), 10));
  const originalTax = Math.abs(Number.parseInt(original.tax_amount.replace(".", ""), 10));
  const taxCents = originalTotal === 0
    ? 0
    : Math.round((originalTax * magnitudeCents) / originalTotal);
  return {
    subtotal: decimal(magnitudeCents - taxCents),
    taxAmount: decimal(taxCents),
  };
}

function decimal(cents: number): string {
  const magnitude = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(magnitude / 100)}.${
    String(magnitude % 100).padStart(2, "0")
  }`;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The item and tax refs the original posted against, so the reversal lands on the same accounts. */
function firstLineDetail(payload: Record<string, unknown>): Record<string, unknown> {
  const lines = Array.isArray(payload.Line) ? payload.Line : [];
  const first = lines[0];
  if (!first || typeof first !== "object") return {};
  const detail = (first as Record<string, unknown>).SalesItemLineDetail;
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail as Record<string, unknown>
    : {};
}
