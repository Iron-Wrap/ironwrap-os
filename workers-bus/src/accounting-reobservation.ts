// accounting-reobservation.ts - the re-observation rail (slice S11).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.1 admits exactly one route to a settled
// state: "an authenticated provider-detail read of the exact provider entity id ... compared
// against the `expected_sha256` computed from the intent's bound local facts". S3 built that
// comparison and S4 built the payment path into it. What nothing built was a *production* caller
// that goes and looks again after the dispatch readback:
//
//   * `ingestObservedPayment` had zero callers in `src/`;
//   * `runAccountingSweeps` ran with no bound reader (`index.ts:400`, before this slice);
//   * `reconcile` on the BFF was a state-trigger flip that compared nothing.
//
// So a genuinely dispatched, fully-matching invoice could not reach `reconciled` through any
// surface a person or a cron could touch, and the drift exception - the one ELEC-75 hardened
// against a fabricated reversal reference - had no way to be raised at all (ELEC-77).
//
// This module is the missing caller, and it is one function the two production surfaces share: the
// accountant's `POST /api/v1/accounting/intents/{id}/reconcile` and the due-observation sweep on
// the frequent cron. Sharing it is the point - a second surface that re-implemented "read, then
// judge" would be a second place for the two to disagree.
//
// **What is deliberately not here.** Section 5.1 also names the webhook as a trigger ("receiving a
// QuickBooks webhook enqueues an authenticated re-read of the named entity"), and this slice does
// not wire it. `handleQuickbooksWebhook` acknowledges Intuit behind a signed-receipt and
// projection-outbox design of its own, and a money-plane read hung off its acknowledgement path
// would either block that acknowledgement or fail silently; doing it properly means giving that
// outbox a money-plane lane, which is its own change. Nothing depends on it: the sweep re-reads
// every stale entity on the frequent cron whether or not a webhook ever arrives, so the webhook
// would make reconciliation faster rather than possible.
//
// **Why an invoice needs two reads, not one.** Section 5.4 lets an invoice reach `reconciled` only
// when `Balance == 0` *and* `sum(observed settlements) + Balance == TotalAmt`, and the settled half
// of that sum comes from Payment **observations** in D1 - never from arithmetic over the invoice.
// Re-reading the invoice alone would therefore see a zero balance with nothing on record settling
// it and report `settlement_invariant_violated`: a defect wearing a verdict's clothes. The rail
// reads the invoice, observes each Payment the invoice itself declares, and only then judges. Every
// one of those reads is an authenticated detail read of an exact provider id.
//
// **It holds no credential and reaches no provider by default.** The binding is
// `QuickBooksAuthPort` plus an injected fetcher, exactly the seam slice S3 established. Unbound is
// a first-class answer: with no QuickBooks connection the sweep reports what is due and the route
// answers "we could not reach QuickBooks", and neither invents a verdict out of the absence of a
// check. Project rule 5 holds by construction.

import type { AppEnv } from "./app-types.ts";
import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import type { AccountingEntityType } from "./accounting-normalizers.ts";
import {
  AccountingIntentError,
  readAccountingIntent,
  type AccountingIntentState,
  type AccountingVerdict,
} from "./accounting-intents.ts";
import {
  readProviderEntity,
  type ProviderReadSource,
} from "./accounting-provider-read.ts";
import { ingestObservedPayment, linkedPaymentIds } from "./accounting-payments.ts";
import { reconcileAccountingIntent } from "./accounting-reconciliation.ts";
import {
  quickBooksAuthPort,
  quickBooksConnectedRealmId,
} from "./quickbooks-final-invoice.ts";

/**
 * Everything a re-observation needs to reach the provider, and nothing else.
 *
 * Deliberately narrower than `AccountingDispatchBinding`: there is no `MoneyEffectPort` and no
 * executor here, so nothing on this path can write to the provider. Reading and writing through one
 * binding would make it possible to reach a settled state without the effect ledger ever seeing the
 * mutation, which is the property `accounting-provider-read.ts` exists to preserve.
 */
export interface AccountingObservationBinding {
  auth: QuickBooksAuthPort;
  fetcher?: typeof fetch;
}

/** One Payment the rail observed because the invoice it re-read declared it. */
export interface ObservedSettlement {
  entity_id: string;
  status: "observed" | "not_found" | "unavailable";
  detail_code: string | null;
}

export interface ReobservedIntent {
  intent_id: string;
  entity_type: AccountingEntityType;
  entity_id: string;
  /** `judged` means a verdict of record was written; `unavailable` means nothing was written. */
  status: "judged" | "unavailable";
  /** The provider-read code when the provider could not be reached (section 5.3). */
  detail_code: string | null;
  verdict: AccountingVerdict | null;
  reason_code: string | null;
  /** The state the intent holds after the verdict was applied. */
  state: AccountingIntentState;
  settled_amount: string | null;
  /** The Payments the invoice declared, each observed by its exact id. */
  payments: readonly ObservedSettlement[];
  /** The exception this re-observation raised, when it raised one. */
  exception_id: string | null;
  /** True when this exact observation had already been judged, so nothing was applied twice. */
  replayed: boolean;
}

export interface ReobserveAccountingIntentInput {
  tenantId: string;
  intentId: string;
  /** How this look was triggered. `sweep` for the cron, `recovery_query` for an accountant. */
  source: ProviderReadSource;
}

/**
 * Look again at one intent's provider entity, and record what was found.
 *
 * Writes nothing at all when the provider is unreachable: section 5.3 says an outage "is not a
 * statement about the money", so an unavailable read leaves every row exactly as it was and says so
 * in the result rather than moving the intent somewhere that looks decided.
 *
 * Idempotent per observation. `recordAccountingObservation` dedupes on
 * `(tenant, realm, type, id, hash, read_at)` and `reconcileAccountingIntent` returns the stored
 * verdict for an observation it has already judged, so the same unchanged entity re-read inside one
 * pass - which is exactly what happens when a Payment ingest re-reads the invoice this rail is
 * already holding a read of - produces one observation, one verdict, and one version bump.
 */
export async function reobserveAccountingIntent(
  env: AppEnv,
  binding: AccountingObservationBinding,
  input: ReobserveAccountingIntentInput,
  now: Date = new Date(),
): Promise<ReobservedIntent> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  const entityType = intent.provider_entity_type as AccountingEntityType | null;
  const entityId = intent.provider_entity_id;
  // Section 5.1 compares against "the identity recorded on the settled effect attempt". An intent
  // that never reached the provider has no such identity and nothing to read by exact id; the
  // staleness sweep is what surfaces it, not a read that would have to guess what to ask for.
  if (!entityType || !entityId) {
    throw new AccountingIntentError("accounting_intent_provider_identity_missing");
  }

  const fetcher = binding.fetcher ?? fetch;
  const read = await readProviderEntity(binding.auth, {
    tenantId: input.tenantId,
    entityType,
    entityId,
    source: input.source,
  }, fetcher, now);

  if (read.status === "unavailable") {
    return {
      intent_id: intent.intent_id,
      entity_type: entityType,
      entity_id: entityId,
      status: "unavailable",
      detail_code: read.detailCode,
      verdict: null,
      reason_code: null,
      state: intent.state,
      settled_amount: intent.settled_amount,
      payments: [],
      exception_id: null,
      replayed: false,
    };
  }

  // The settlement half of the invariant, gathered before the verdict is computed. Only an invoice
  // carries one: a credit memo, a refund or a journal entry is settled by its own existence
  // (section 5.4), so there is nothing to follow and nothing extra to read.
  const payments: ObservedSettlement[] = [];
  if (read.status === "ok" && entityType === "Invoice") {
    for (const paymentEntityId of linkedPaymentIds(read.payload)) {
      const ingest = await ingestObservedPayment(env, binding.auth, {
        tenantId: input.tenantId,
        paymentEntityId,
        source: input.source,
      }, fetcher, now);
      payments.push({
        entity_id: paymentEntityId,
        status: ingest.status,
        detail_code: ingest.detailCode,
      });
    }
  }

  const judged = await reconcileAccountingIntent(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    read,
  }, now);

  return {
    intent_id: intent.intent_id,
    entity_type: entityType,
    entity_id: entityId,
    status: judged.verdict === "unavailable" ? "unavailable" : "judged",
    detail_code: judged.verdict === "unavailable" ? judged.reasonCode : null,
    verdict: judged.verdict,
    reason_code: judged.reasonCode,
    state: judged.intent.state,
    settled_amount: judged.intent.settled_amount,
    payments,
    exception_id: judged.exception?.exception_id ?? null,
    replayed: judged.replayed,
  };
}

/**
 * Bind the rail to this tenant's QuickBooks connection, or answer `null`.
 *
 * Two unbound answers, both normal and both silent: QuickBooks OAuth is unconfigured, or this
 * tenant has never connected a realm. Deliberately *not* gated on the effect ledger the way
 * `resolveAccountingDispatchBinding` is - reading does not need a ledger, and an intent with a
 * provider entity id to re-read is by definition one the ledger already settled.
 *
 * The realm is asked for without minting a token, so an unconfigured tenant does not provoke a
 * refresh attempt on every cron tick just to discover there is nothing to refresh.
 */
export async function resolveAccountingObservationBinding(
  env: AppEnv,
  input: { tenantId: string; fetcher?: typeof fetch },
): Promise<AccountingObservationBinding | null> {
  const fetcher = input.fetcher ?? fetch;
  const auth = quickBooksAuthPort(env, fetcher);
  if (!auth) return null;
  const realmId = await quickBooksConnectedRealmId(env, input.tenantId).catch(() => null);
  if (!realmId) return null;
  return { auth, fetcher };
}

/**
 * The sweep's seam, closed over one binding.
 *
 * `accounting-sweeps.ts` decides *what* is due to be looked at; this decides *how* one is looked
 * at. Keeping the two apart is what stops the sweep growing its own opinion about payments,
 * hashing or verdicts - it counts what came back and nothing more.
 */
export function accountingIntentReobserver(
  env: AppEnv,
  binding: AccountingObservationBinding,
  source: ProviderReadSource = "sweep",
) {
  return async (input: { tenantId: string; intentId: string; now?: Date }) =>
    await reobserveAccountingIntent(
      env,
      binding,
      { tenantId: input.tenantId, intentId: input.intentId, source },
      input.now ?? new Date(),
    );
}
