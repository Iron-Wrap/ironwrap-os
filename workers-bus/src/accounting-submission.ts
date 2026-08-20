// accounting-submission.ts - the dispatch path from an approved money intent to the provider
// (slice S4).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4 and 6. S0-S3 built every piece of
// the money plane except the one that moves: the port, the aggregate, the tax binding, the
// normalizers, the read path and the verdict engine all exist, and until this module nothing in
// `src/` called `MoneyEffectPort.run` at all. This is that call, and it is the only one.
//
// Three rules shape everything here:
//
//   * **Only a readback settles.** `submitAccountingIntent` can reach `submitted` and no further.
//     Reaching `reconciled` needs an authenticated provider-detail read judged by the S3 engine,
//     which is why `submitAndReconcileAccountingIntent` is a second step rather than a flag.
//   * **The ceiling is a magnitude.** A credit memo and a refund are negative (section 4.1), and
//     they are exactly the kinds section 6 gates hardest. Every amount handed to the port is an
//     absolute value in integer cents, so no signed comparison anywhere can exempt a reversal from
//     the ceiling that exists to gate it.
//   * **Not every kind writes.** A Payment is observed, never created (section 12 open question 4's
//     standing default), and a tax remittance is proposed, never filed (section 4.1). Both refuse
//     here with their own code rather than being absent from a map and failing as a lookup miss.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type {
  MoneyActorType,
  MoneyEffectExecutor,
  MoneyEffectOutcome,
  MoneyEffectPort,
  MoneyEffectRequest,
} from "./accounting-effect-port.ts";
import {
  AccountingIntentError,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  type AccountingIntentKind,
  type AccountingIntentRecord,
} from "./accounting-intents.ts";
import type { NormalizedEntityFacts } from "./accounting-normalizers.ts";
import { preflightAccountingIntentTax } from "./accounting-tax-snapshots.ts";
import {
  readProviderEntity,
  type ProviderReadResult,
} from "./accounting-provider-read.ts";
import {
  reconcileAccountingIntent,
  type ReconciliationOutcome,
} from "./accounting-reconciliation.ts";
import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import type { AccountingEntityType } from "./accounting-normalizers.ts";

/**
 * The normalized provider action per intent kind, or `null` for a kind that never mutates the
 * provider. `null` is a statement, not an omission: `dispatchRefusalCode` turns each one into the
 * contract sentence that put it there.
 */
export const ACCOUNTING_PROVIDER_ACTIONS: Readonly<
  Record<AccountingIntentKind, string | null>
> = {
  deposit_invoice: "quickbooks.invoice.create",
  progress_invoice: "quickbooks.invoice.create",
  // Section 12 open question 4 defaults to observe-only, and section 4.1 states it: IronWrap
  // observes Payments in QuickBooks. `accounting-payments.ts` is the whole payment path.
  payment: null,
  credit_memo: "quickbooks.creditmemo.create",
  refund: "quickbooks.refundreceipt.create",
  holdback_release: "quickbooks.invoice.create",
  // Propose and reconcile only. Filing is a licensed act performed by the accountant (section 4.1).
  tax_remittance_proposal: null,
  payroll_journal: "quickbooks.journalentry.create",
};

/** Why a kind refuses to dispatch, in the vocabulary the Money Desk renders. */
export function dispatchRefusalCode(kind: AccountingIntentKind): string | null {
  if (ACCOUNTING_PROVIDER_ACTIONS[kind] !== null) return null;
  return kind === "payment"
    ? "accounting_payment_observe_only"
    : "accounting_tax_remittance_propose_only";
}

export interface SubmitAccountingIntentInput<T> {
  tenantId: string;
  intentId: string;
  port: MoneyEffectPort;
  executor: MoneyEffectExecutor<T>;
  /** The actor the ledger binds the authority to. Derivation is an agent; dispatch is not. */
  actor: { type: MoneyActorType; id: string };
  taskId: string;
  correlationId: string;
  deadlineAt: string;
  authorityExpiresAt: string;
  /**
   * The exact envelope `expected_sha256` was taken over, from `providerFactEnvelope`. Checked
   * against the stored hash before anything is dispatched: the ledger's own readback comparison is
   * only worth as much as the expectation it was handed, and the intent row stores the hash rather
   * than the envelope, so passing a different one has to be a refusal rather than a silent
   * downgrade.
   */
  expectedReadback: unknown;
  /** Provider rates per bound tax code, for the section 5.4 submission preflight. */
  providerRates?: ReadonlyMap<string, NormalizedEntityFacts>;
  /** The date the tax snapshot's effective window is judged against. */
  taxPreflightOnDate?: string;
  retryLimit?: number;
  maxAttempts?: number;
  evidenceRefs?: readonly string[];
  preconditions?: unknown;
  /** Provider-supported reversal only, set by slice S5. Never a local delete. */
  compensationPlan?: unknown;
  parentEffectId?: string | null;
}

export interface SubmitAccountingIntentResult<T> {
  /**
   * `blocked` means the tax preflight refused and **nothing was dispatched**; the other three are
   * what the ledger settled.
   */
  status: "submitted" | "blocked" | "uncertain" | "failed" | "in_flight";
  blockerCode: string | null;
  outcome: MoneyEffectOutcome<T> | null;
  intent: AccountingIntentRecord;
}

/**
 * Dispatch one approved intent through the money effect port.
 *
 * Reaches `submitted` at best: an accepted dispatch means the provider acknowledged, and section
 * 5.1 admits only an authenticated readback as a route to `reconciled`.
 */
export async function submitAccountingIntent<T>(
  env: AppEnv,
  input: SubmitAccountingIntentInput<T>,
  now: Date = new Date(),
): Promise<SubmitAccountingIntentResult<T>> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");

  // Refuse before the ledger is even asked. A kind that never writes must not leave a proposed row
  // behind as evidence that IronWrap considered writing it.
  const refusal = dispatchRefusalCode(intent.kind);
  if (refusal) throw new AccountingIntentError(refusal);
  const action = ACCOUNTING_PROVIDER_ACTIONS[intent.kind]!;

  // The approval is the gate. `submission_pending` is the only state the approve command produces
  // (`0058_accounting_money_intents.sql`), so this is "approved and not yet dispatched" stated as
  // the one thing that can be true rather than as a list of things that must not be.
  if (intent.state !== "submission_pending") {
    throw new AccountingIntentError("accounting_intent_not_submittable");
  }
  input.port.assertReady();

  const expectedSha256 = await sha256Hex(canonicalJson(input.expectedReadback));
  if (expectedSha256 !== intent.expected_sha256) {
    throw new AccountingIntentError("accounting_intent_expected_readback_mismatch");
  }

  // Section 5.4: every submission preflight reads the provider's rate for the bound code. A
  // blocked candidate is an ordinary answer, not an exception - and nothing is dispatched.
  if (intent.tax_policy_snapshot_sha256) {
    const preflight = await preflightAccountingIntentTax(env, {
      tenantId: input.tenantId,
      intentId: input.intentId,
      onDate: input.taxPreflightOnDate ?? now.toISOString().slice(0, 10),
      providerRates: input.providerRates ?? new Map(),
    }, now);
    if (!preflight.ok) {
      const blocked = await readAccountingIntent(env, input.tenantId, input.intentId);
      return {
        status: "blocked",
        blockerCode: preflight.blockerCode,
        outcome: null,
        intent: blocked ?? intent,
      };
    }
  }

  const request: MoneyEffectRequest = {
    tenantId: intent.tenant_id,
    actor: input.actor,
    taskId: input.taskId,
    authority: {
      permitRef: intent.authority_permit_ref,
      policyRef: intent.authority_policy_ref,
      policyVersion: intent.authority_policy_version,
      expiresAt: input.authorityExpiresAt,
      allowedActions: [action],
      maxAttempts: input.maxAttempts,
      // Magnitudes, in integer cents, on both sides of the comparison. See the header: a signed
      // compare would exempt every credit memo and refund from the ceiling section 6 gates them
      // with, which is this lane's known defect class.
      amount: magnitudeCents(intent.total_amount),
      maxAmount: magnitudeCents(intent.authority_max_amount),
    },
    aggregate: { type: "accounting_intent", id: intent.intent_id, version: intent.version },
    intentId: intent.intent_id,
    action,
    request: JSON.parse(intent.provider_payload_json),
    provider: "quickbooks",
    providerAccountRef: intent.realm_id,
    // The business key the ledger dedupes on, bound at derivation. This is the half of the
    // duplicate-create defence that survives a retried dispatch (section 5.4).
    idempotencyKey: intent.effect_idempotency_key,
    deadlineAt: input.deadlineAt,
    preconditions: input.preconditions,
    evidenceRefs: input.evidenceRefs,
    expectedReadback: input.expectedReadback,
    retryLimit: input.retryLimit,
    compensationPlan: input.compensationPlan,
    correlationId: input.correlationId,
    parentEffectId: input.parentEffectId ?? null,
    compensatesEffectId: intent.compensates_effect_id,
  };

  const outcome = await input.port.run<T>(request, input.executor, now);
  const applied = await recordAccountingIntentSubmission(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    outcome,
  }, now);

  return {
    status: applied.state === "submitted"
      ? "submitted"
      : applied.state === "uncertain"
        ? "uncertain"
        : applied.state === "failed"
          ? "failed"
          : "in_flight",
    blockerCode: null,
    outcome,
    intent: applied,
  };
}

export interface SubmitAndReconcileResult<T> extends SubmitAccountingIntentResult<T> {
  /** Absent when the dispatch never reached `submitted`; there is nothing to read back. */
  read: ProviderReadResult | null;
  reconciliation: ReconciliationOutcome | null;
}

/**
 * The whole first money path: dispatch, then read the provider back and judge it.
 *
 * The readback is a *separate authenticated read* rather than a reuse of the dispatch response,
 * because section 5.1 defines `reconciled` in terms of "an authenticated provider-detail read of
 * the exact provider entity id". A response body echoed by the same call that created the entity
 * is the provider agreeing with itself.
 */
export async function submitAndReconcileAccountingIntent<T>(
  env: AppEnv,
  input: SubmitAccountingIntentInput<T> & { auth: QuickBooksAuthPort; fetcher?: typeof fetch },
  now: Date = new Date(),
): Promise<SubmitAndReconcileResult<T>> {
  const submitted = await submitAccountingIntent(env, input, now);
  if (submitted.status !== "submitted" || !submitted.intent.provider_entity_id) {
    return { ...submitted, read: null, reconciliation: null };
  }

  const read = await readProviderEntity(input.auth, {
    tenantId: input.tenantId,
    entityType: submitted.intent.provider_entity_type as AccountingEntityType,
    entityId: submitted.intent.provider_entity_id,
    source: "dispatch_readback",
    effectAttemptId: submitted.outcome?.attemptId ?? null,
  }, input.fetcher ?? fetch, now);

  const reconciliation = await reconcileAccountingIntent(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    read,
  }, now);

  return { ...submitted, intent: reconciliation.intent, read, reconciliation };
}

/**
 * Absolute value in integer cents.
 *
 * The column CHECK guarantees two decimal places, so this is exact rather than rounded - and it is
 * the only unit the port ever sees, so `amount` and `maxAmount` are always compared on the same
 * scale whatever the runtime binding does with them.
 */
export function magnitudeCents(value: string): number {
  return Math.abs(Number.parseInt(value.replace(".", ""), 10));
}
