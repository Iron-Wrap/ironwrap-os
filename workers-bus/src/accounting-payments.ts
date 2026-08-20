// accounting-payments.ts - the payment path, which is an observation path (slice S4).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 4.1 and section 12 open question 4:
// **IronWrap observes Payments in QuickBooks, it does not create them.** That default is the whole
// design of this module. There is no create, no dispatch and no `MoneyEffectPort` import here -
// `accounting-submission.ts` refuses a `payment`-kind dispatch outright with
// `accounting_payment_observe_only`, and this is the path that exists instead.
//
// What a payment does to IronWrap's money state is entirely indirect: it changes an *invoice*.
// So ingest is a two-read sequence, and the order matters -
//
//   1. authenticated read of the Payment itself, recorded as an immutable observation;
//   2. authenticated re-read of every invoice that payment links and IronWrap owns an intent for,
//      judged by the S3 engine.
//
// The second read is not optional and is not replaced by arithmetic over the first. The cumulative
// invariant of section 5.4 is `sum(observed settlements) + Balance == TotalAmt`, and `Balance` is a
// provider fact: inferring it by subtracting what we just saw would be exactly the "adjust local
// truth to match the provider" move section 5.1 forbids, run backwards.
//
// Nothing here is triggered by a webhook body. A webhook may say "Payment 3003 changed", and this
// module then goes and reads it - "a webhook is a trigger, never evidence" (section 5.1).

import type { AppEnv } from "./app-types.ts";
import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import type { AccountingIntentRecord, AccountingIntentState } from "./accounting-intents.ts";
import {
  readProviderEntity,
  type ProviderReadResult,
  type ProviderReadSource,
} from "./accounting-provider-read.ts";
import { extractSettlementFacts } from "./accounting-normalizers.ts";
import {
  recordAccountingObservation,
  reconcileAccountingIntent,
  type AccountingObservationRecord,
  type ReconciliationOutcome,
} from "./accounting-reconciliation.ts";

/**
 * The intent states a verdict may be applied to, matching the `reconcile` command's source states
 * in `0058_accounting_money_intents.sql`. An invoice intent that has not been dispatched yet has
 * no provider identity to compare against, so a payment landing against it is recorded and left
 * alone rather than forced into a transition the state machine would refuse.
 */
const RECONCILABLE_STATES: readonly AccountingIntentState[] = [
  "submitted", "uncertain", "partially_settled", "reconciled", "mismatch",
  "reconciliation_required",
];

export interface PaymentSettlementResult {
  intentId: string;
  invoiceEntityId: string;
  /** `skipped` carries a reason and leaves every money state untouched. */
  status: "reconciled" | "skipped";
  reason: string | null;
  reconciliation: ReconciliationOutcome | null;
}

export interface IngestObservedPaymentResult {
  status: "observed" | "not_found" | "unavailable";
  detailCode: string | null;
  observation: AccountingObservationRecord | null;
  read: ProviderReadResult;
  /** One entry per invoice the payment links that IronWrap holds an intent for. */
  settlements: readonly PaymentSettlementResult[];
}

export interface IngestObservedPaymentInput {
  tenantId: string;
  paymentEntityId: string;
  /** How this ingest was triggered. `webhook_triggered_read` is the webhook case (section 5.1). */
  source: ProviderReadSource;
  effectAttemptId?: string | null;
}

/**
 * Observe one provider Payment and re-judge every invoice it settles.
 *
 * Idempotent by construction: `recordAccountingObservation` dedupes on
 * `(tenant, realm, type, id, hash, read_at)` and `reconcileAccountingIntent` returns the stored
 * verdict when it has already judged an observation, so a sweep that re-reads an unchanged payment
 * writes nothing new and moves no intent version.
 */
export async function ingestObservedPayment(
  env: AppEnv,
  auth: QuickBooksAuthPort,
  input: IngestObservedPaymentInput,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<IngestObservedPaymentResult> {
  const read = await readProviderEntity(auth, {
    tenantId: input.tenantId,
    entityType: "Payment",
    entityId: input.paymentEntityId,
    source: input.source,
    effectAttemptId: input.effectAttemptId ?? null,
  }, fetcher, now);

  // Section 5.3: an outage is not a statement about the money, and a payment we never created
  // being absent is not IronWrap's exception to raise. Both leave every row exactly as it was.
  if (read.status !== "ok") {
    return {
      status: read.status === "not_found" ? "not_found" : "unavailable",
      detailCode: read.status === "not_found"
        ? (read.detailCode ?? "provider_entity_absent")
        : read.detailCode,
      observation: null,
      read,
      settlements: [],
    };
  }

  const observation = await recordAccountingObservation(env, {
    tenantId: input.tenantId,
    realmId: read.realmId,
    entityType: "Payment",
    normalized: read.normalized,
    payload: read.payload,
    readAt: read.readAt,
    source: read.source,
    // Deliberately unlinked to an intent: the Payment is not something IronWrap intended, it is
    // something IronWrap found. The link that matters is the one to the invoice, below.
    intentId: null,
    effectAttemptId: read.effectAttemptId ?? null,
  }, now);

  const settlements: PaymentSettlementResult[] = [];
  for (const invoiceEntityId of linkedInvoiceIds(read.payload)) {
    const intent = await readIntentByProviderEntity(env, {
      tenantId: input.tenantId,
      realmId: read.realmId,
      entityType: "Invoice",
      entityId: invoiceEntityId,
    });
    // An invoice IronWrap never raised. Someone else's transaction in the same realm is not an
    // accounting event for us, and inventing an intent for it would be the reverse of section 5.1.
    if (!intent) continue;

    if (!RECONCILABLE_STATES.includes(intent.state)) {
      settlements.push({
        intentId: intent.intent_id,
        invoiceEntityId,
        status: "skipped",
        reason: "accounting_intent_not_reconcilable",
        reconciliation: null,
      });
      continue;
    }

    const invoiceRead = await readProviderEntity(auth, {
      tenantId: input.tenantId,
      entityType: "Invoice",
      entityId: invoiceEntityId,
      source: input.source,
      effectAttemptId: input.effectAttemptId ?? null,
    }, fetcher, now);

    // The invoice re-read failing is an outage on the invoice, not on the payment. The payment
    // observation stands - it is a fact we read and hold - and the verdict simply waits.
    if (invoiceRead.status === "unavailable") {
      settlements.push({
        intentId: intent.intent_id,
        invoiceEntityId,
        status: "skipped",
        reason: invoiceRead.detailCode,
        reconciliation: null,
      });
      continue;
    }

    const reconciliation = await reconcileAccountingIntent(env, {
      tenantId: input.tenantId,
      intentId: intent.intent_id,
      read: invoiceRead,
    }, now);
    settlements.push({
      intentId: intent.intent_id,
      invoiceEntityId,
      status: "reconciled",
      reason: null,
      reconciliation,
    });
  }

  return { status: "observed", detailCode: null, observation, read, settlements };
}

/**
 * The distinct invoices one payment applies to, in provider order.
 *
 * Reuses the normalizer's own link extraction rather than re-walking `Line[].LinkedTxn[]`, so an
 * ambiguous line - one payment line split across two invoices with no per-invoice amount - throws
 * `provider_payment_line_ambiguous` here for the same reason it throws in settlement: attributing
 * it would manufacture settlement that was never observed.
 */
export function linkedInvoiceIds(payload: unknown): string[] {
  const seen = new Set<string>();
  for (const link of extractSettlementFacts("Payment", payload).links) {
    if (link.linkedTxnType === "Invoice") seen.add(link.linkedTxnId);
  }
  return [...seen];
}

/** The intent that claims one provider entity, scoped on tenant and realm like every S3 reader. */
export async function readIntentByProviderEntity(
  env: AppEnv,
  input: { tenantId: string; realmId: string; entityType: string; entityId: string },
): Promise<AccountingIntentRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND realm_id = ? AND provider_entity_type = ? AND provider_entity_id = ?
      ORDER BY created_at, intent_id LIMIT 1`,
  ).bind(input.tenantId, input.realmId, input.entityType, input.entityId)
    .first<AccountingIntentRecord>();
}
