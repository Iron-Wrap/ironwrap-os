// accounting-reconciliation.ts - the reconciliation engine (slice S3).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5. This is the module that decides what
// "reconciled" means, and every rule it enforces is one sentence of that section:
//
//   5.1  Three things must agree - the local basis, the effect ledger, and the provider detail.
//        Two out of three is not reconciled, and only an authenticated readback can settle.
//   5.3  Six verdicts. `unavailable` is retryable and is never written as a verdict of record.
//   5.4  An invoice reaches `reconciled` only when `Balance == 0` and the cumulative settlement
//        invariant holds; over-payment is a mismatch, not a partial; a duplicate is an exception,
//        never an auto-delete; a previously reconciled entity that changed is drift.
//
// Nothing here corrects local truth to match the provider, and nothing here deletes a row. The two
// storage-layer facts that make that structural are the append-only triggers on observations and
// reconciliations, and `accounting_intents_no_delete` from slice S1.

import { comparableObservedSha256 } from "./accounting-expectations.ts";
import type { AppEnv } from "./app-types.ts";
import { canonicalJson } from "./newo-hash.ts";
import type { MoneyEffectOutcome } from "./accounting-effect-port.ts";
import {
  AccountingIntentError,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  recordAccountingIntentVerdict,
  type AccountingIntentRecord,
  type AccountingVerdict,
} from "./accounting-intents.ts";
import {
  centsFromDecimal,
  decimalFromCents,
  extractSettlementFacts,
  observedSha256,
  type AccountingEntityType,
  type NormalizedEntityFacts,
} from "./accounting-normalizers.ts";
import {
  intentSubjectRef,
  raiseAccountingException,
  readLiveAccountingException,
  type AccountingExceptionReasonCode,
  type AccountingExceptionRecord,
} from "./accounting-exceptions.ts";
import type { ProviderReadResult, ProviderReadSource } from "./accounting-provider-read.ts";

/** Entity types an observation may record. `TaxRate` is a policy fact, not a money entity. */
export const OBSERVABLE_ENTITY_TYPES: readonly AccountingEntityType[] = [
  "Invoice", "Payment", "CreditMemo", "RefundReceipt", "JournalEntry", "TimeActivity",
];

export interface AccountingObservationRecord {
  observation_seq: number;
  observation_id: string;
  tenant_id: string;
  realm_id: string;
  entity_type: AccountingEntityType;
  entity_id: string;
  intent_id: string | null;
  facts_json: string;
  observed_sha256: string;
  total_amount_cents: number | null;
  balance_cents: number | null;
  unapplied_amount_cents: number | null;
  read_at: string;
  effect_attempt_id: string | null;
  source: ProviderReadSource;
  created_at: string;
}

export interface AccountingReconciliationRecord {
  reconciliation_id: string;
  tenant_id: string;
  intent_id: string;
  observation_id: string | null;
  expected_sha256: string;
  observed_sha256: string | null;
  verdict: Exclude<AccountingVerdict, "unavailable">;
  reason_code: string | null;
  settled_amount: string | null;
  resolved_by_user_id: string | null;
  decided_at: string;
}

export interface RecordAccountingObservationInput {
  tenantId: string;
  realmId: string;
  entityType: AccountingEntityType;
  normalized: NormalizedEntityFacts;
  /** The raw provider entity, read only for the unhashed settlement facts. */
  payload: unknown;
  readAt: string;
  source: ProviderReadSource;
  intentId?: string | null;
  effectAttemptId?: string | null;
}

/**
 * Record one authenticated read.
 *
 * Immutable and idempotent: the same facts read at the same instant are one observation, a later
 * read is a new row, and nothing ever supersedes by rewriting - the highest `observation_seq` for
 * an entity is the current one, which is all `readCurrentObservation` means.
 */
export async function recordAccountingObservation(
  env: AppEnv,
  input: RecordAccountingObservationInput,
  now: Date = new Date(),
): Promise<AccountingObservationRecord> {
  if (!OBSERVABLE_ENTITY_TYPES.includes(input.entityType)) {
    throw new AccountingIntentError("accounting_observation_entity_unsupported");
  }
  const hash = await observedSha256(input.normalized);
  const settlement = extractSettlementFacts(input.entityType, input.payload);
  const observationId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO accounting_observations (
       observation_id, tenant_id, realm_id, entity_type, entity_id, intent_id, facts_json,
       observed_sha256, total_amount_cents, balance_cents, unapplied_amount_cents, read_at,
       effect_attempt_id, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, realm_id, entity_type, entity_id, observed_sha256, read_at)
       DO NOTHING`,
  ).bind(
    observationId, input.tenantId, input.realmId, input.entityType, input.normalized.entityId,
    input.intentId ?? null, canonicalJson(input.normalized.facts), hash, settlement.totalCents,
    settlement.balanceCents, settlement.unappliedCents, input.readAt,
    input.effectAttemptId ?? null, input.source, now.toISOString(),
  ).run();

  const stored = await env.DB.prepare(
    `SELECT * FROM accounting_observations
      WHERE tenant_id = ? AND realm_id = ? AND entity_type = ? AND entity_id = ?
        AND observed_sha256 = ? AND read_at = ?`,
  ).bind(
    input.tenantId, input.realmId, input.entityType, input.normalized.entityId, hash, input.readAt,
  ).first<AccountingObservationRecord>();
  if (!stored) throw new AccountingIntentError("accounting_observation_write_failed");

  for (const link of settlement.links) {
    await env.DB.prepare(
      `INSERT INTO accounting_observation_links (
         link_id, observation_id, tenant_id, realm_id, line_index, linked_txn_type, linked_txn_id,
         amount_cents, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (observation_id, line_index, linked_txn_type, linked_txn_id) DO NOTHING`,
    ).bind(
      crypto.randomUUID(), stored.observation_id, input.tenantId, input.realmId, link.lineIndex,
      link.linkedTxnType, link.linkedTxnId, link.amountCents, now.toISOString(),
    ).run();
  }

  return stored;
}

/** The newest observation of an entity. Supersession is ordering, never a rewrite. */
export async function readCurrentObservation(
  env: AppEnv,
  input: {
    tenantId: string;
    realmId: string;
    entityType: AccountingEntityType;
    entityId: string;
  },
): Promise<AccountingObservationRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_observations
      WHERE tenant_id = ? AND realm_id = ? AND entity_type = ? AND entity_id = ?
      ORDER BY observation_seq DESC LIMIT 1`,
  ).bind(input.tenantId, input.realmId, input.entityType, input.entityId)
    .first<AccountingObservationRecord>();
}

export interface InvoiceSettlement {
  /** Sum of the current payment observations that link this invoice. */
  linkedCents: number;
  /** How many distinct provider Payments link it. Two is what makes a duplicate a duplicate. */
  paymentCount: number;
  paymentEntityIds: readonly string[];
}

/**
 * The cumulative settlement of one invoice, over current observations only.
 *
 * "Cumulative" is the point (section 5.4): the target is
 * `sum(observed settlements) + Balance == TotalAmt` evaluated across every payment ever observed,
 * not a single-shot equality against one payment. Superseded observations are excluded by the
 * `observation_seq` rule, so re-reading a payment cannot double-count it.
 */
export async function invoiceSettlement(
  env: AppEnv,
  input: { tenantId: string; realmId: string; invoiceEntityId: string },
): Promise<InvoiceSettlement> {
  const rows = await env.DB.prepare(
    `SELECT o.entity_id AS entity_id, SUM(l.amount_cents) AS amount_cents
       FROM accounting_observation_links l
       JOIN accounting_observations o ON o.observation_id = l.observation_id
      WHERE l.tenant_id = ? AND l.realm_id = ? AND l.linked_txn_type = 'Invoice'
        AND l.linked_txn_id = ? AND o.entity_type = 'Payment'
        AND o.observation_seq = (
          SELECT MAX(current.observation_seq) FROM accounting_observations current
           WHERE current.tenant_id = o.tenant_id AND current.realm_id = o.realm_id
             AND current.entity_type = o.entity_type AND current.entity_id = o.entity_id
        )
      GROUP BY o.entity_id
      ORDER BY o.entity_id`,
  ).bind(input.tenantId, input.realmId, input.invoiceEntityId)
    .all<{ entity_id: string; amount_cents: number }>();

  const results = rows.results ?? [];
  return {
    linkedCents: results.reduce((total, row) => total + Number(row.amount_cents ?? 0), 0),
    paymentCount: results.length,
    paymentEntityIds: results.map((row) => row.entity_id),
  };
}

export interface ReconciliationOutcome {
  verdict: AccountingVerdict;
  reasonCode: string | null;
  observationId: string | null;
  observedSha256: string | null;
  settledAmount: string | null;
  exception: AccountingExceptionRecord | null;
  intent: AccountingIntentRecord;
  /** True when this exact observation had already been judged; nothing was applied twice. */
  replayed: boolean;
}

/**
 * Judge one authenticated read against one intent.
 *
 * Idempotent per observation: a sweep that re-reads an unchanged entity produces the same
 * observation row and returns the stored verdict rather than re-applying it, which is what keeps a
 * five-minute cron from walking an intent's version forward forever.
 */
export async function reconcileAccountingIntent(
  env: AppEnv,
  input: { tenantId: string; intentId: string; read: ProviderReadResult },
  now: Date = new Date(),
): Promise<ReconciliationOutcome> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  const read = input.read;

  // Section 5.3: the provider being unreachable is not a statement about the money. Nothing is
  // written - no observation, no verdict, no exception, no state change.
  if (read.status === "unavailable") {
    return {
      verdict: "unavailable",
      reasonCode: read.detailCode,
      observationId: null,
      observedSha256: null,
      settledAmount: null,
      exception: null,
      intent,
      replayed: false,
    };
  }

  if (read.status === "not_found") {
    const exception = await raise(env, intent, "provider_entity_not_found", {
      realmId: read.realmId,
      entityType: read.entityType,
      entityId: read.entityId,
      detailCode: read.detailCode ?? null,
      remedies: remedies("superseded_by_new_intent", "accepted_as_posted"),
      // Nothing was read, so nothing was hashed. An exception that named a hash here would be
      // citing evidence that does not exist.
    }, now, null);
    // The verdict is recorded even though there is no observation to point at: "we looked and it
    // was not there" is a decision about the money, and a queue entry with no verdict behind it
    // would leave the accountant guessing what the system actually concluded.
    await writeReconciliation(env, {
      intent,
      // Nothing was compared: the entity was not there. The verdict still records which
      // expectation went unmet, which is the intent's own.
      expectedSha256: intent.expected_sha256,
      observationId: null,
      observedSha256: null,
      verdict: "not_found",
      reasonCode: "provider_entity_not_found",
      settledAmount: null,
    }, now);
    const applied = await applyVerdict(env, {
      intent,
      verdict: "not_found",
      reasonCode: "provider_entity_not_found",
      observationId: null,
      observedSha256: null,
      settledAmount: null,
    }, now);
    return {
      verdict: "not_found",
      reasonCode: "provider_entity_not_found",
      observationId: null,
      observedSha256: null,
      settledAmount: null,
      exception,
      intent: applied,
      replayed: false,
    };
  }

  // Only an intent whose dispatch settled with a provider identity can be reconciled at all: the
  // definition compares against "the identity recorded on the settled effect attempt" (section 5.1).
  if (!intent.provider_entity_id || !intent.provider_entity_type) {
    throw new AccountingIntentError("accounting_intent_provider_identity_missing");
  }

  const observation = await recordAccountingObservation(env, {
    tenantId: input.tenantId,
    realmId: read.realmId,
    entityType: read.entityType,
    normalized: read.normalized,
    payload: read.payload,
    readAt: read.readAt,
    source: read.source,
    intentId: input.intentId,
    effectAttemptId: read.effectAttemptId ?? null,
  }, now);

  const alreadyJudged = await env.DB.prepare(
    `SELECT * FROM accounting_reconciliations
      WHERE tenant_id = ? AND intent_id = ? AND observation_id = ?`,
  ).bind(input.tenantId, input.intentId, observation.observation_id)
    .first<AccountingReconciliationRecord>();
  if (alreadyJudged) {
    return {
      verdict: alreadyJudged.verdict,
      reasonCode: alreadyJudged.reason_code,
      observationId: alreadyJudged.observation_id,
      observedSha256: alreadyJudged.observed_sha256,
      settledAmount: alreadyJudged.settled_amount,
      exception: alreadyJudged.reason_code
        ? await readLiveAccountingException(
          env,
          input.tenantId,
          intentSubjectRef(input.intentId),
          alreadyJudged.reason_code as AccountingExceptionReasonCode,
        )
        : null,
      intent,
      replayed: true,
    };
  }

  // What this observation is compared against, and what it is compared *as*.
  //
  // `expected_sha256` is the intent's own and never moves - `0058`'s CHECK requires
  // `observed_sha256 = expected_sha256` on any row in `reconciled`, so nothing else could be
  // written here. The observed side is what varies: for an intent whose provider entity IronWrap
  // is creating, the `Id` is not a local fact and cannot be bound at derivation (section 5.2 hashes
  // it, Intuit assigns it), so such an intent binds an identity-free expectation and the
  // observation is hashed on the same basis. Identity is not thereby unchecked - `decide` compares
  // realm, entity type and entity id against the identity the effect attempt settled on, before
  // any hash is looked at, which is section 5.1's other half stated once instead of twice.
  //
  // The observation row itself keeps the full hash, `Id` included: it is evidence of what the
  // provider returned, and evidence is never trimmed to make a comparison work.
  const expectedSha256 = intent.expected_sha256;
  const comparedObserved = await comparableObservedSha256(env, intent, observation);
  const decision = await decide(
    env, { intent, read, observation, expectedSha256, observedSha256: comparedObserved }, now,
  );
  await writeReconciliation(env, {
    intent,
    expectedSha256,
    observationId: observation.observation_id,
    observedSha256: comparedObserved,
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    settledAmount: decision.settledAmount,
  }, now);

  const exception = decision.exceptionReason
    ? await raise(env, intent, decision.exceptionReason, decision.exceptionDetail, now, comparedObserved)
    : null;
  const applied = await applyVerdict(env, {
    intent,
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    observationId: observation.observation_id,
    observedSha256: comparedObserved,
    settledAmount: decision.settledAmount,
  }, now);

  return {
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    observationId: observation.observation_id,
    observedSha256: observation.observed_sha256,
    settledAmount: decision.settledAmount,
    exception,
    intent: applied,
    replayed: false,
  };
}

interface Decision {
  verdict: Exclude<AccountingVerdict, "unavailable">;
  reasonCode: string | null;
  settledAmount: string | null;
  exceptionReason: AccountingExceptionReasonCode | null;
  exceptionDetail: unknown;
}

async function decide(
  env: AppEnv,
  input: {
    intent: AccountingIntentRecord;
    read: Extract<ProviderReadResult, { status: "ok" }>;
    observation: AccountingObservationRecord;
    /** What the observation is compared against; see `reconcileAccountingIntent`. */
    expectedSha256: string;
    /** ...and the observation hashed on the same basis as that expectation. */
    observedSha256: string;
  },
  now: Date,
): Promise<Decision> {
  const { intent, read, observation, expectedSha256, observedSha256 } = input;

  // Identity before facts. A fact set that matches on a different entity is the most dangerous
  // shape of all: it looks reconciled and points at money we never created.
  if (
    read.realmId !== intent.realm_id
    || read.entityType !== intent.provider_entity_type
    || read.entityId !== intent.provider_entity_id
  ) {
    return {
      verdict: "identity_conflict",
      reasonCode: "provider_identity_conflict",
      settledAmount: null,
      exceptionReason: "provider_identity_conflict",
      exceptionDetail: {
        expected: {
          realmId: intent.realm_id,
          entityType: intent.provider_entity_type,
          entityId: intent.provider_entity_id,
        },
        observed: { realmId: read.realmId, entityType: read.entityType, entityId: read.entityId },
        // Compensation is blocked while this is live: reversing the wrong entity is worse than
        // the conflict. `idx_accounting_exceptions_compensation_guard` in 0061 enforces it.
        remedies: remedies("accepted_as_posted", "superseded_by_new_intent"),
      },
    };
  }

  // A second entity for something we created once. Never an auto-delete (section 5.4).
  const duplicates = read.duplicateEntityIds ?? [];
  if (duplicates.length > 0) {
    return {
      verdict: "mismatch",
      reasonCode: "duplicate_provider_entity",
      settledAmount: null,
      exceptionReason: "duplicate_provider_entity",
      exceptionDetail: {
        realmId: read.realmId,
        entityType: read.entityType,
        keptEntityId: read.entityId,
        duplicateEntityIds: [...duplicates],
        remedies: remedies("void_provider_entity", "credit_memo_issued"),
      },
    };
  }

  const hashesAgree = observedSha256 === expectedSha256;
  // "Previously reconciled" is a durable fact, not the current state. `provider_reconciled_at` is
  // stamped once a readback matched and never cleared, whereas the state moves: the accountant's
  // own `reconcile` command writes a receipt that flips the intent to `reconciliation_required`
  // *before* the re-read it triggers, so judging drift by the state would report the most
  // deliberate re-read in the system - a person pressing "check this against QuickBooks" - as a
  // first-time mismatch on an entity that had already agreed once.
  const drifted = intent.provider_reconciled_at !== null;

  // Only an invoice carries the cumulative settlement target (section 5.4). A payment, credit memo
  // or refund is settled by its own existence, so hash equality is the whole test.
  if (intent.provider_entity_type !== "Invoice") {
    if (hashesAgree) {
      return {
        verdict: "reconciled",
        reasonCode: null,
        settledAmount: null,
        exceptionReason: null,
        exceptionDetail: null,
      };
    }
    return mismatchDecision(intent, drifted, null, expectedSha256, observedSha256);
  }

  const settlement = await invoiceSettlement(env, {
    tenantId: intent.tenant_id,
    realmId: intent.realm_id,
    invoiceEntityId: intent.provider_entity_id!,
  });
  const intentTotalCents = centsFromDecimal(intent.total_amount) ?? 0;
  const balanceCents = observation.balance_cents;
  const settledAmount = decimalFromCents(settlement.linkedCents);

  // Over-payment is a mismatch, not a partial. Two payments against one invoice make it a
  // duplicate; one over-sized payment makes it an over-payment. Both are the accountant's.
  if (settlement.linkedCents > intentTotalCents) {
    const duplicate = settlement.paymentCount >= 2;
    return {
      verdict: "mismatch",
      reasonCode: duplicate ? "duplicate_provider_payment" : "provider_overpayment",
      settledAmount,
      exceptionReason: duplicate ? "duplicate_provider_payment" : "provider_overpayment",
      exceptionDetail: {
        realmId: intent.realm_id,
        invoiceEntityId: intent.provider_entity_id,
        invoiceTotal: intent.total_amount,
        observedSettled: settledAmount,
        paymentEntityIds: [...settlement.paymentEntityIds],
        // Exactly the two provider-supported remedies section 5.4 names.
        remedies: remedies("void_provider_entity", "credit_memo_issued", ["refund_issued"]),
      },
    };
  }

  if (!hashesAgree) {
    return mismatchDecision(intent, drifted, settledAmount, expectedSha256, observedSha256);
  }

  // The cumulative invariant: what has been settled plus what is still owed is the whole invoice.
  if (balanceCents === null || settlement.linkedCents + balanceCents !== intentTotalCents) {
    return {
      verdict: "mismatch",
      reasonCode: "settlement_invariant_violated",
      settledAmount,
      exceptionReason: "settlement_invariant_violated",
      exceptionDetail: {
        realmId: intent.realm_id,
        invoiceEntityId: intent.provider_entity_id,
        invoiceTotal: intent.total_amount,
        observedSettled: settledAmount,
        observedBalance: balanceCents === null ? null : decimalFromCents(balanceCents),
        remedies: remedies("accepted_as_posted", "superseded_by_new_intent"),
      },
    };
  }

  if (balanceCents === 0) {
    return {
      verdict: "reconciled",
      reasonCode: null,
      settledAmount,
      exceptionReason: null,
      exceptionDetail: null,
    };
  }

  // A legitimate waiting state, not a defect: the invoice is posted correctly and not yet paid off.
  return {
    verdict: "partially_settled",
    reasonCode: null,
    settledAmount,
    exceptionReason: null,
    exceptionDetail: null,
  };
}

function mismatchDecision(
  intent: AccountingIntentRecord,
  drifted: boolean,
  settledAmount: string | null,
  expectedSha256: string,
  observedSha256: string,
): Decision {
  // Section 5.4, provider drift: somebody changed a posted transaction in QuickBooks. That is an
  // accounting event, and it is reported as one rather than as a first-time mismatch.
  const reasonCode = drifted ? "provider_readback_drift" : "expected_observed_mismatch";
  return {
    verdict: "mismatch",
    reasonCode,
    settledAmount,
    exceptionReason: reasonCode as AccountingExceptionReasonCode,
    exceptionDetail: {
      realmId: intent.realm_id,
      entityType: intent.provider_entity_type,
      entityId: intent.provider_entity_id,
      expectedSha256,
      observedSha256,
      remedies: remedies("adjusting_entry_posted", "accepted_as_posted"),
    },
  };
}

export interface ResolveUncertainInput {
  tenantId: string;
  intentId: string;
  /**
   * What the bounded recovery query found. `found` carries the settled ledger outcome the S11
   * binding produces once the provider confirms the entity exists; the engine never queries a
   * provider itself.
   */
  lookup:
    | { status: "found"; outcome: MoneyEffectOutcome<unknown> }
    | { status: "absent" };
  /** After this instant an entity that still cannot be found is the accountant's decision. */
  deadlineAt: string;
}

/**
 * Resolve a lost response (section 5.4).
 *
 * Retry is not an option and never becomes one: the ledger refuses to retry an `unknown` effect
 * (`effect_unknown_requires_reconciliation`), so the only routes out are finding the entity or
 * handing the decision to a human at the deadline.
 */
export async function resolveUncertainAccountingIntent(
  env: AppEnv,
  input: ResolveUncertainInput,
  now: Date = new Date(),
): Promise<{
  resolution: "submitted" | "manual_exception" | "waiting";
  intent: AccountingIntentRecord;
  exception: AccountingExceptionRecord | null;
}> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  if (intent.state !== "uncertain") {
    throw new AccountingIntentError("accounting_intent_not_uncertain");
  }

  if (input.lookup.status === "found") {
    const applied = await recordAccountingIntentSubmission(env, {
      tenantId: input.tenantId,
      intentId: input.intentId,
      outcome: input.lookup.outcome,
    }, now);
    return { resolution: "submitted", intent: applied, exception: null };
  }

  if (now.toISOString() < input.deadlineAt) {
    return { resolution: "waiting", intent, exception: null };
  }

  const exception = await raise(env, intent, "unknown_effect_deadline_expired", {
    realmId: intent.realm_id,
    effectIdempotencyKey: intent.effect_idempotency_key,
    providerRequestId: intent.provider_request_id,
    deadlineAt: input.deadlineAt,
    remedies: remedies("superseded_by_new_intent", "accepted_as_posted"),
    // A deadline passing is not a read: the last hash we hold is the last one an observation
    // produced, and it is the honest thing to cite for an entity nobody has been able to find.
  }, now, intent.observed_sha256);
  const applied = await recordAccountingIntentVerdict(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    verdict: "not_found",
    reasonCode: "unknown_effect_deadline_expired",
  }, now);
  return { resolution: "manual_exception", intent: applied, exception };
}

/**
 * Refuse a compensation while an identity conflict is live (section 5.3).
 *
 * The same rule is enforced in D1 by `accounting_exceptions_block_compensation` in 0061, so a
 * caller that skips this check still cannot write the receipt. Both layers exist for the same
 * reason the state machine has two: one for a legible error, one that cannot be forgotten.
 */
export async function assertCompensationAllowed(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<void> {
  const conflict = await readLiveAccountingException(
    env,
    tenantId,
    intentSubjectRef(intentId),
    "provider_identity_conflict",
  );
  if (conflict) {
    throw new AccountingIntentError("accounting_intent_compensation_blocked");
  }
}

export async function listAccountingReconciliations(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<AccountingReconciliationRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_reconciliations
      WHERE tenant_id = ? AND intent_id = ? ORDER BY decided_at, reconciliation_id`,
  ).bind(tenantId, intentId).all<AccountingReconciliationRecord>();
  return rows.results ?? [];
}

export async function listAccountingObservations(
  env: AppEnv,
  tenantId: string,
  filter: { intentId?: string; entityId?: string } = {},
): Promise<AccountingObservationRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_observations
      WHERE tenant_id = ?
        AND (? IS NULL OR intent_id = ?)
        AND (? IS NULL OR entity_id = ?)
      ORDER BY observation_seq`,
  ).bind(
    tenantId, filter.intentId ?? null, filter.intentId ?? null,
    filter.entityId ?? null, filter.entityId ?? null,
  ).all<AccountingObservationRecord>();
  return rows.results ?? [];
}

async function writeReconciliation(
  env: AppEnv,
  input: {
    intent: AccountingIntentRecord;
    /** The hash actually compared, which is the only one worth recording as the verdict's basis. */
    expectedSha256: string;
    observationId: string | null;
    observedSha256: string | null;
    verdict: Exclude<AccountingVerdict, "unavailable">;
    reasonCode: string | null;
    settledAmount: string | null;
  },
  now: Date,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO accounting_reconciliations (
       reconciliation_id, tenant_id, intent_id, observation_id, expected_sha256, observed_sha256,
       verdict, reason_code, settled_amount, decided_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, intent_id, observation_id) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), input.intent.tenant_id, input.intent.intent_id, input.observationId,
    input.expectedSha256, input.observedSha256, input.verdict, input.reasonCode,
    input.settledAmount, now.toISOString(),
  ).run();
}

async function applyVerdict(
  env: AppEnv,
  input: {
    intent: AccountingIntentRecord;
    verdict: Exclude<AccountingVerdict, "unavailable">;
    reasonCode: string | null;
    observationId: string | null;
    observedSha256: string | null;
    settledAmount: string | null;
  },
  now: Date,
): Promise<AccountingIntentRecord> {
  return await recordAccountingIntentVerdict(env, {
    tenantId: input.intent.tenant_id,
    intentId: input.intent.intent_id,
    verdict: input.verdict,
    observedSha256: input.observedSha256,
    // Every verdict that computed a settled figure records it, not only `partially_settled`.
    // Restricting it to that one verdict was invisible while `reconciled` was unreachable and
    // became a desk-truth defect the moment slice S11 made it reachable: an invoice that a
    // customer had paid in full showed the badge "Reconciled" beside `settled_amount` `0.00` -
    // the figure the dispatch readback wrote when nothing had been paid yet. `null` still means
    // "this verdict computed no settlement", and the column's COALESCE keeps the last one that did.
    settledAmount: input.settledAmount,
    reasonCode: input.reasonCode,
  }, now);
}

/**
 * Open the accountant's queue entry for one verdict.
 *
 * `observedSha256` is the hash **this** read produced, passed in rather than taken from
 * `intent.observed_sha256`. The column on the intent still holds the previous observation's hash
 * at this point - the verdict has not been applied yet - so reading it here put the *old* figure on
 * the exception. On a first mismatch that column is null and the omission was invisible; on drift,
 * where the previous read matched by definition, it wrote the expected hash into both fields and
 * the queue entry claimed expected and observed were identical on an exception that exists because
 * they are not. `null` is honest and means there was nothing to compare (the entity was absent).
 */
async function raise(
  env: AppEnv,
  intent: AccountingIntentRecord,
  reasonCode: AccountingExceptionReasonCode,
  detail: unknown,
  now: Date,
  observedSha256: string | null,
): Promise<AccountingExceptionRecord> {
  const { exception } = await raiseAccountingException(env, {
    tenantId: intent.tenant_id,
    subjectRef: intentSubjectRef(intent.intent_id),
    intentId: intent.intent_id,
    reasonCode,
    expectedSha256: intent.expected_sha256,
    observedSha256,
    detail,
  }, now);
  return exception;
}

/**
 * The provider-supported remedies on offer, in the order the accountant sees them.
 *
 * Section 5.4 offers exactly two for a duplicate payment - void the surplus payment, or issue a
 * credit memo / refund receipt for it - so a remedy is one choice that may name its variants,
 * rather than a flat list where "credit memo" and "refund" would read as two separate decisions.
 */
function remedies(
  primary: string,
  secondary: string,
  secondaryAlternatives: readonly string[] = [],
): Array<{ action: string; alternatives: string[] }> {
  return [
    { action: primary, alternatives: [] },
    { action: secondary, alternatives: [...secondaryAlternatives] },
  ];
}
