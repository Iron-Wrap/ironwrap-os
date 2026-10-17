// accounting-desk.ts - the money desk read model (slice S8).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2 fixes what a roofing office manager sees:
// four queues, one badge per intent, and a plain-language next step on every non-terminal badge.
// This module is that projection and nothing else. It writes nothing, calls no provider, and holds
// no authority check - `accounting-api.ts` decides who may ask, the S1-S5 engine decides what is
// true, and this decides how it reads.
//
// Three rules shape every projection below:
//
//  1. The badge is derived from the intent's own state, never stored. Section 8.2 requires the
//     screen to be unable to drift from the truth, and a second column holding a display state is
//     exactly how that drift happens.
//  2. `tenant_id` never leaves. It is the isolation key, and an office surface that echoes it
//     teaches a caller what to guess.
//  3. No provider payload body and no credential (section 6). Hashes, ids, amounts and timestamps
//     are the evidence; `provider_payload_json` is deliberately absent from every projection here.

import {
  listAccountingExceptions,
  type AccountingExceptionRecord,
} from "./accounting-exceptions.ts";
import {
  listAccountingIntents,
  readAccountingIntent,
  listAccountingIntentEvents,
  type AccountingIntentKind,
  type AccountingIntentRecord,
  type AccountingIntentState,
} from "./accounting-intents.ts";
import {
  listAccountingObservations,
  listAccountingReconciliations,
} from "./accounting-reconciliation.ts";
import {
  listAccountingIntentTaxBindings,
  type TaxPolicySnapshotRecord,
} from "./accounting-tax-snapshots.ts";
import type { AppEnv } from "./app-types.ts";

/**
 * The badge vocabulary shown to the office manager.
 *
 * Section 8.2 names six: Pending, In flight, Uncertain, Mismatched, Compensated, Reconciled. Two
 * more are added here, deliberately and recorded in the contract's section 0 deviations:
 * `accounting_intents` can be in `rejected` and `failed`, and a screen that cannot render a state
 * its own aggregate can hold would have to either hide those intents or mislabel them. Both are
 * worse than naming them.
 */
export const ACCOUNTING_BADGES = [
  "pending", "in_flight", "uncertain", "mismatched", "compensated", "reconciled", "rejected",
  "failed",
] as const;

export type AccountingBadge = (typeof ACCOUNTING_BADGES)[number];

const BADGE_BY_STATE: Readonly<Record<AccountingIntentState, AccountingBadge>> = {
  draft: "pending",
  blocked: "pending",
  pending_review: "pending",
  rejected: "rejected",
  submission_pending: "in_flight",
  submitted: "in_flight",
  // Money has moved, but not all of it. The desk treats it as still in flight, because the next
  // event that matters is the remaining settlement, not a decision the accountant has to make.
  partially_settled: "in_flight",
  uncertain: "uncertain",
  mismatch: "mismatched",
  reconciliation_required: "mismatched",
  compensating: "compensated",
  compensated: "compensated",
  reconciled: "reconciled",
  failed: "failed",
};

/**
 * The plain-language next step, per badge.
 *
 * Section 8.2: "every non-terminal badge carries a plain-language next step, not a reason code."
 * A reason code still travels beside it for the accountant who wants one, but never instead of it.
 */
const NEXT_STEP_BY_STATE: Readonly<Record<AccountingIntentState, string>> = {
  draft: "Finish the figures before anyone reviews this.",
  blocked: "Something the figures depend on changed. Re-derive it, then review.",
  pending_review: "Check the amount against the approved paperwork, then approve or reject it.",
  rejected: "Nothing was sent. Start again from a new set of figures if this is still needed.",
  submission_pending: "Being sent to QuickBooks. Nothing else to do yet.",
  submitted: "Waiting for QuickBooks to confirm. We re-read it until it does.",
  partially_settled: "Posted to QuickBooks. Waiting for the customer to pay it.",
  uncertain: "We do not know whether this reached QuickBooks; we are checking.",
  mismatch: "QuickBooks does not agree with our figures. Open the detail and pick a remedy.",
  reconciliation_required: "This needs re-reading against QuickBooks before it can be trusted.",
  compensating: "A reversal is authorized and on its way.",
  compensated: "Reversed. Nothing further unless the reversal itself needs checking.",
  reconciled: "Matched against QuickBooks. Nothing to do.",
  failed: "This never reached QuickBooks. Review the figures and start again.",
};

/** Section 8.2's four queues, in the order the desk shows them. */
export const ACCOUNTING_QUEUES = [
  "needs_approval", "awaiting_provider", "mismatched", "exceptions",
] as const;

export type AccountingQueue = (typeof ACCOUNTING_QUEUES)[number];

const QUEUE_STATES: Readonly<
  Record<Exclude<AccountingQueue, "exceptions">, readonly AccountingIntentState[]>
> = {
  needs_approval: ["pending_review", "blocked"],
  awaiting_provider: ["submission_pending", "submitted", "partially_settled", "uncertain"],
  mismatched: ["mismatch", "reconciliation_required"],
};

export function accountingBadge(state: AccountingIntentState): AccountingBadge {
  return BADGE_BY_STATE[state];
}

/**
 * How long an intent may sit waiting to reach the provider before the copy stops saying
 * "nothing else to do". Matches `DEFAULT_STUCK_DISPATCH_SECONDS` in `accounting-sweeps.ts`: the
 * sweep that logs a stalled dispatcher and the sentence the office manager reads must agree, or
 * the desk is calm about something the cron is already shouting about.
 */
export const STUCK_DISPATCH_NEXT_STEP_SECONDS = 30 * 60;

/**
 * The sentence a person acts on, from the state and what is actually known about it.
 *
 * The state alone is not always enough to tell the truth, and both exceptions were live copy
 * defects ELEC-77 photographed:
 *
 *   * a freshly dispatched invoice is `partially_settled` with nothing paid at all - `Balance`
 *     still equals `TotalAmt` and no Payment has been observed - so "Part of this is paid" was
 *     simply false for the most common case the state has;
 *   * `submission_pending` says "Nothing else to do yet", which is right for the first few minutes
 *     and wrong once the dispatcher has clearly stopped. `sweepStuckAccountingDispatches` already
 *     surfaces that intent in the cron log; the desk now says the same thing to the person looking
 *     at it.
 *
 * The context is optional so a caller that only holds a state still gets the plain sentence.
 */
export function accountingNextStep(
  state: AccountingIntentState,
  context: { settledAmount?: string | null; waitingSeconds?: number } = {},
): string {
  if (
    state === "submission_pending"
    && (context.waitingSeconds ?? 0) >= STUCK_DISPATCH_NEXT_STEP_SECONDS
  ) {
    return "This has been waiting to reach QuickBooks longer than it should. "
      + "Tell whoever runs the system.";
  }
  if (state === "partially_settled" && settledCents(context.settledAmount) > 0) {
    return "Part of this is paid. Waiting for the rest.";
  }
  return NEXT_STEP_BY_STATE[state];
}

/** Integer cents from the `settled_amount` the last verdict recorded, or zero when none has. */
function settledCents(settledAmount: string | null | undefined): number {
  if (!settledAmount) return 0;
  const parsed = Number.parseInt(settledAmount.replace(".", ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function queueStates(queue: Exclude<AccountingQueue, "exceptions">): readonly AccountingIntentState[] {
  return QUEUE_STATES[queue];
}

export interface AccountingIntentRow {
  intent_id: string;
  kind: AccountingIntentKind;
  roof_job_id: string;
  /** Read from the bound basis when it names one. Never invented, and null when it does not. */
  customer_ref: string | null;
  currency: string;
  total_amount: string;
  settled_amount: string | null;
  state: AccountingIntentState;
  badge: AccountingBadge;
  next_step: string;
  version: number;
  blocker_code: string | null;
  reason_code: string | null;
  derived_at: string;
  updated_at: string;
  /** Whole seconds since derivation, so the queue can be read by age without a client clock. */
  age_seconds: number;
  compensates_intent_id: string | null;
}

export function projectAccountingIntent(
  intent: AccountingIntentRecord,
  now: Date,
): AccountingIntentRow {
  return {
    intent_id: intent.intent_id,
    kind: intent.kind,
    roof_job_id: intent.roof_job_id,
    customer_ref: customerRef(intent),
    currency: intent.currency,
    total_amount: intent.total_amount,
    settled_amount: intent.settled_amount,
    state: intent.state,
    badge: accountingBadge(intent.state),
    next_step: accountingNextStep(intent.state, {
      settledAmount: intent.settled_amount,
      // Since the last transition, not since derivation: what the copy is judging is how long this
      // intent has been stuck in the state it is in now.
      waitingSeconds: ageSeconds(intent.updated_at, now),
    }),
    version: intent.version,
    blocker_code: intent.blocker_code,
    reason_code: intent.reason_code,
    derived_at: intent.derived_at,
    updated_at: intent.updated_at,
    age_seconds: ageSeconds(intent.derived_at, now),
    compensates_intent_id: intent.compensates_intent_id,
  };
}

export interface AccountingExceptionRow {
  exception_id: string;
  intent_id: string | null;
  subject_ref: string;
  reason_code: string;
  status: string;
  expected_sha256: string | null;
  observed_sha256: string | null;
  /** The provider-supported remedies this exception offered, exactly as it recorded them. */
  remedies: unknown;
  detail: Record<string, unknown>;
  resolution_action: string | null;
  opened_at: string;
  updated_at: string;
  age_seconds: number;
}

export function projectAccountingException(
  exception: AccountingExceptionRecord,
  now: Date,
): AccountingExceptionRow {
  const detail = parseDetail(exception.detail_json);
  return {
    exception_id: exception.exception_id,
    intent_id: exception.intent_id,
    subject_ref: exception.subject_ref,
    reason_code: exception.reason_code,
    status: exception.status,
    expected_sha256: exception.expected_sha256,
    observed_sha256: exception.observed_sha256,
    remedies: detail.remedies ?? [],
    detail,
    resolution_action: exception.resolution_action,
    opened_at: exception.opened_at,
    updated_at: exception.updated_at,
    age_seconds: ageSeconds(exception.opened_at, now),
  };
}

export interface AccountingDeskSummary {
  queues: Record<AccountingQueue, { count: number; oldest_age_seconds: number | null }>;
  /** Section 8.2's settings extension: the health an accountant checks before trusting the desk. */
  reconciliation_health: {
    open_exceptions: number;
    acknowledged_exceptions: number;
    oldest_open_exception_age_seconds: number | null;
    oldest_unreconciled_intent_id: string | null;
    oldest_unreconciled_age_seconds: number | null;
    stale_observation_count: number;
    stale_after_seconds: number;
    /** Intents in a state that admits an observation but which carry none at all. */
    unobserved_intent_count: number;
  };
}

/** Beyond this, a reconciled fact has not been re-read recently enough to be shown as current. */
export const DEFAULT_STALE_OBSERVATION_SECONDS = 24 * 60 * 60;

/** The states in which an intent is expected to have a current provider observation. */
export const OBSERVED_STATES: readonly AccountingIntentState[] = [
  "submitted", "partially_settled", "reconciled", "mismatch", "reconciliation_required",
  "uncertain",
];

/** The states that are still open money: neither reconciled nor abandoned. */
const UNRECONCILED_STATES: readonly AccountingIntentState[] = [
  "draft", "blocked", "pending_review", "submission_pending", "submitted", "partially_settled",
  "uncertain", "mismatch", "reconciliation_required", "compensating",
];

export async function summarizeAccountingDesk(
  env: AppEnv,
  tenantId: string,
  options: { now?: Date; staleAfterSeconds?: number } = {},
): Promise<AccountingDeskSummary> {
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_OBSERVATION_SECONDS;

  const [needsApproval, awaitingProvider, mismatched, exceptions, unreconciled, staleness] =
    await Promise.all([
      listAccountingIntents(env, tenantId, { states: QUEUE_STATES.needs_approval, limit: 200 }),
      listAccountingIntents(env, tenantId, { states: QUEUE_STATES.awaiting_provider, limit: 200 }),
      listAccountingIntents(env, tenantId, { states: QUEUE_STATES.mismatched, limit: 200 }),
      listAccountingExceptions(env, tenantId),
      listAccountingIntents(env, tenantId, { states: UNRECONCILED_STATES, limit: 200 }),
      observationStaleness(env, tenantId, now, staleAfterSeconds),
    ]);

  const live = exceptions.filter((exception) => exception.status !== "resolved");
  const oldestUnreconciled = unreconciled[0] ?? null;

  return {
    queues: {
      needs_approval: queueCount(needsApproval, now),
      awaiting_provider: queueCount(awaitingProvider, now),
      mismatched: queueCount(mismatched, now),
      exceptions: {
        count: live.length,
        oldest_age_seconds: live.length === 0 ? null : ageSeconds(live[0]!.opened_at, now),
      },
    },
    reconciliation_health: {
      open_exceptions: live.filter((exception) => exception.status === "open").length,
      acknowledged_exceptions:
        live.filter((exception) => exception.status === "acknowledged").length,
      oldest_open_exception_age_seconds:
        live.length === 0 ? null : ageSeconds(live[0]!.opened_at, now),
      oldest_unreconciled_intent_id: oldestUnreconciled?.intent_id ?? null,
      oldest_unreconciled_age_seconds:
        oldestUnreconciled === null ? null : ageSeconds(oldestUnreconciled.derived_at, now),
      stale_observation_count: staleness.stale,
      stale_after_seconds: staleAfterSeconds,
      unobserved_intent_count: staleness.unobserved,
    },
  };
}

export interface AccountingIntentDetail {
  intent: AccountingIntentRow;
  /** The bound local commercial facts and the documents they were read from. */
  basis: unknown;
  source_documents: unknown;
  /** Identity and integrity evidence, per section 6. Hashes only - never a provider body. */
  evidence: {
    basis_sha256: string;
    expected_sha256: string;
    observed_sha256: string | null;
    provider_payload_sha256: string;
    provider_request_id: string;
    provider: string;
    realm_id: string;
    provider_entity_type: string | null;
    provider_entity_id: string | null;
    tax_policy_snapshot_sha256: string | null;
    effect_id: string | null;
    compensates_effect_id: string | null;
    authority_permit_ref: string;
    authority_policy_ref: string;
    authority_policy_version: string;
    authority_max_amount: string;
    provider_submitted_at: string | null;
    provider_reconciled_at: string | null;
  };
  comparison: AccountingComparison;
  events: Awaited<ReturnType<typeof listAccountingIntentEvents>>;
  reconciliations: Array<{
    reconciliation_id: string;
    verdict: string;
    reason_code: string | null;
    settled_amount: string | null;
    expected_sha256: string;
    observed_sha256: string | null;
    decided_at: string;
  }>;
  observations: Array<{
    observation_id: string;
    entity_type: string;
    entity_id: string;
    observed_sha256: string;
    total_amount_cents: number | null;
    balance_cents: number | null;
    read_at: string;
    source: string;
  }>;
  tax_bindings: Array<{
    snapshot_id: string;
    snapshot_sha256: string;
    jurisdiction: string;
    tax_code: string;
    bound_at: string;
  }>;
  exceptions: AccountingExceptionRow[];
}

export async function readAccountingIntentDetail(
  env: AppEnv,
  tenantId: string,
  intentId: string,
  now: Date = new Date(),
): Promise<AccountingIntentDetail | null> {
  const intent = await readAccountingIntent(env, tenantId, intentId);
  if (!intent) return null;

  const [events, reconciliations, observations, taxBindings, exceptions] = await Promise.all([
    listAccountingIntentEvents(env, tenantId, intentId),
    listAccountingReconciliations(env, tenantId, intentId),
    listAccountingObservations(env, tenantId, { intentId }),
    listAccountingIntentTaxBindings(env, tenantId, intentId),
    listAccountingExceptions(env, tenantId, { intentId }),
  ]);

  const current = observations.at(-1) ?? null;
  return {
    intent: projectAccountingIntent(intent, now),
    basis: parseJson(intent.basis_json),
    source_documents: parseJson(intent.source_documents_json),
    evidence: {
      basis_sha256: intent.basis_sha256,
      expected_sha256: intent.expected_sha256,
      observed_sha256: intent.observed_sha256,
      provider_payload_sha256: intent.provider_payload_sha256,
      provider_request_id: intent.provider_request_id,
      provider: intent.provider,
      realm_id: intent.realm_id,
      provider_entity_type: intent.provider_entity_type,
      provider_entity_id: intent.provider_entity_id,
      tax_policy_snapshot_sha256: intent.tax_policy_snapshot_sha256,
      effect_id: intent.effect_id,
      compensates_effect_id: intent.compensates_effect_id,
      authority_permit_ref: intent.authority_permit_ref,
      authority_policy_ref: intent.authority_policy_ref,
      authority_policy_version: intent.authority_policy_version,
      authority_max_amount: intent.authority_max_amount,
      provider_submitted_at: intent.provider_submitted_at,
      provider_reconciled_at: intent.provider_reconciled_at,
    },
    comparison: compareFacts(intent, current ?? null),
    events,
    reconciliations: reconciliations.map((row) => ({
      reconciliation_id: row.reconciliation_id,
      verdict: row.verdict,
      reason_code: row.reason_code,
      settled_amount: row.settled_amount,
      expected_sha256: row.expected_sha256,
      observed_sha256: row.observed_sha256,
      decided_at: row.decided_at,
    })),
    observations: observations.map((row) => ({
      observation_id: row.observation_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      observed_sha256: row.observed_sha256,
      total_amount_cents: row.total_amount_cents,
      balance_cents: row.balance_cents,
      read_at: row.read_at,
      source: row.source,
    })),
    tax_bindings: taxBindings.map((row) => ({
      snapshot_id: row.snapshot_id,
      snapshot_sha256: row.snapshot_sha256,
      jurisdiction: row.jurisdiction,
      tax_code: row.tax_code,
      bound_at: row.bound_at,
    })),
    exceptions: exceptions.map((exception) => projectAccountingException(exception, now)),
  };
}

/**
 * Every tax snapshot whose effective window overlaps one period, plus the intents bound to it.
 *
 * A period is `YYYY-MM` or `YYYY`, because that is how a remittance is asked for. Overlap rather
 * than containment: a rate that changed mid-period governs part of it and must still be shown.
 */
export async function listTaxSnapshotsForPeriod(
  env: AppEnv,
  tenantId: string,
  period: string,
): Promise<TaxPolicySnapshotRecord[]> {
  const window = periodWindow(period);
  if (!window) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM tax_policy_snapshots
      WHERE tenant_id = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to > ?)
      ORDER BY jurisdiction, tax_code, version`,
  ).bind(tenantId, window.endExclusive, window.start).all<TaxPolicySnapshotRecord>();
  return rows.results ?? [];
}

export interface TaxRemittanceProposal {
  period: string;
  currency: string;
  /** Tax bound by intents that actually reached the provider, in the period. */
  submitted_tax_total: string;
  /** Tax bound by intents still in flight. Proposed, never filed - section 12 open question 5. */
  pending_tax_total: string;
  intents: Array<{
    intent_id: string;
    kind: AccountingIntentKind;
    state: AccountingIntentState;
    badge: AccountingBadge;
    tax_amount: string;
    total_amount: string;
    derived_at: string;
  }>;
  snapshots: Array<{
    snapshot_id: string;
    jurisdiction: string;
    tax_code: string;
    rate_percent: string;
    effective_from: string;
    effective_to: string | null;
    version: number;
    snapshot_sha256: string;
  }>;
  /** Stated on the envelope, not only in a document: IronWrap proposes; the accountant files. */
  filing_authority: "accountant";
}

/**
 * Propose a remittance figure for one period (section 8.1, `GET /accounting/tax/remittance/…`).
 *
 * Two totals, never one. A single number would merge tax that QuickBooks has confirmed with tax
 * that is still a proposal, and the accountant who files needs those apart.
 */
export async function proposeTaxRemittance(
  env: AppEnv,
  tenantId: string,
  period: string,
  now: Date = new Date(),
): Promise<TaxRemittanceProposal | null> {
  const window = periodWindow(period);
  if (!window) return null;

  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND derived_at >= ? AND derived_at < ?
      ORDER BY derived_at, intent_id`,
  ).bind(tenantId, window.start, window.endExclusive).all<AccountingIntentRecord>();
  const intents = (rows.results ?? []).filter((intent) => intent.tax_amount !== "0.00");

  const settled: readonly AccountingIntentState[] = [
    "submitted", "partially_settled", "reconciled", "mismatch", "reconciliation_required",
    "compensating", "compensated",
  ];
  let submittedCents = 0;
  let pendingCents = 0;
  for (const intent of intents) {
    const amount = centsOf(intent.tax_amount);
    if (settled.includes(intent.state)) submittedCents += amount;
    else if (intent.state !== "rejected" && intent.state !== "failed") pendingCents += amount;
  }

  const snapshots = await listTaxSnapshotsForPeriod(env, tenantId, period);
  return {
    period,
    currency: intents[0]?.currency ?? "CAD",
    submitted_tax_total: decimalOf(submittedCents),
    pending_tax_total: decimalOf(pendingCents),
    intents: intents.map((intent) => ({
      intent_id: intent.intent_id,
      kind: intent.kind,
      state: intent.state,
      badge: accountingBadge(intent.state),
      tax_amount: intent.tax_amount,
      total_amount: intent.total_amount,
      derived_at: intent.derived_at,
    })),
    snapshots: snapshots.map((snapshot) => ({
      snapshot_id: snapshot.snapshot_id,
      jurisdiction: snapshot.jurisdiction,
      tax_code: snapshot.tax_code,
      rate_percent: snapshot.rate_percent,
      effective_from: snapshot.effective_from,
      effective_to: snapshot.effective_to,
      version: snapshot.version,
      snapshot_sha256: snapshot.snapshot_sha256,
    })),
    filing_authority: "accountant",
  };
}

/** `YYYY` or `YYYY-MM` to a half-open ISO instant window. Anything else is not a period. */
export function periodWindow(period: string): { start: string; endExclusive: string } | null {
  if (/^\d{4}$/.test(period)) {
    const year = Number(period);
    if (year < 2000 || year > 2999) return null;
    return {
      start: `${period}-01-01T00:00:00.000Z`,
      endExclusive: `${year + 1}-01-01T00:00:00.000Z`,
    };
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (year < 2000 || year > 2999) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${period}-01T00:00:00.000Z`,
    endExclusive: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000Z`,
  };
}

export function ageSeconds(from: string, now: Date): number {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}

async function observationStaleness(
  env: AppEnv,
  tenantId: string,
  now: Date,
  staleAfterSeconds: number,
): Promise<{ stale: number; unobserved: number }> {
  const threshold = new Date(now.getTime() - staleAfterSeconds * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN latest.read_at IS NOT NULL AND latest.read_at < ? THEN 1 ELSE 0 END) AS stale,
       SUM(CASE WHEN latest.read_at IS NULL THEN 1 ELSE 0 END) AS unobserved
     FROM accounting_intents i
     LEFT JOIN (
       SELECT intent_id, tenant_id, MAX(read_at) AS read_at
         FROM accounting_observations
        WHERE tenant_id = ? AND intent_id IS NOT NULL
        GROUP BY tenant_id, intent_id
     ) latest ON latest.intent_id = i.intent_id AND latest.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND i.state IN (${OBSERVED_STATES.map(() => "?").join(", ")})`,
  ).bind(threshold, tenantId, tenantId, ...OBSERVED_STATES)
    .first<{ stale: number | null; unobserved: number | null }>();
  return { stale: Number(row?.stale ?? 0), unobserved: Number(row?.unobserved ?? 0) };
}

function queueCount(
  intents: readonly AccountingIntentRecord[],
  now: Date,
): { count: number; oldest_age_seconds: number | null } {
  return {
    count: intents.length,
    oldest_age_seconds: intents.length === 0 ? null : ageSeconds(intents[0]!.derived_at, now),
  };
}

export interface AccountingComparison {
  /** The authoritative verdict: section 5.1 defines agreement as one hash equalling the other. */
  expected_sha256: string;
  /** The hash of the most recent authenticated read - what QuickBooks says right now. */
  observed_sha256: string | null;
  /**
   * The hash the last recorded verdict stood on. It lags `observed_sha256` between a read and the
   * verdict that judges it, and the two are kept apart because merging them would let a screen
   * show a settled verdict for a read nobody has judged yet.
   */
  verdict_observed_sha256: string | null;
  hashes_agree: boolean;
  /** True while no authenticated read has happened yet, so nothing below is a disagreement. */
  awaiting_readback: boolean;
  /** The bound local facts we actually hold an expectation for, field by field. */
  fields: Array<{ field: string; expected: unknown; observed: unknown; agrees: boolean }>;
  /**
   * The normalized fact set the last authenticated read returned, exactly as it was hashed. This
   * is a provider *response* projection, which section 5.2 defines as the comparison artifact -
   * not a provider request body, which section 6 keeps out of every evidence surface. Null until
   * a read exists, and null for a read from another realm, which is not evidence about this intent.
   */
  observed_facts: unknown;
  read_at: string | null;
  read_source: string | null;
}

/**
 * The field-by-field expected-vs-observed diff section 8.2 requires.
 *
 * Only the facts IronWrap actually bound are compared. `accounting_intents` stores the expected
 * fact set as a hash and not as JSON, so an honest field diff can cover exactly the columns the
 * intent holds - identity, realm, entity type, and the money - and the hash pair carries the rest.
 * Manufacturing a wider table by diffing the provider request payload against the provider's
 * response would compare two different vocabularies and report differences that are not
 * disagreements about anything.
 *
 * The observation is read in the shape `recordAccountingObservation` stores: `facts_json` is the
 * bare fact set and the realm is its own column. A read from another realm fails closed - provider
 * ids are per company, so only the realm row is filled and no other fact is compared.
 */
function compareFacts(
  intent: AccountingIntentRecord,
  observation: { realm_id: string; facts_json: string; entity_id: string; entity_type: string;
    read_at: string; source: string; observed_sha256: string; total_amount_cents: number | null;
    balance_cents: number | null } | null,
): AccountingComparison {
  const comparable =
    observation !== null && observation.realm_id === intent.realm_id ? observation : null;
  const stored = comparable === null ? null : parseJson(comparable.facts_json);
  const observedFacts = isRecord(stored) ? stored : null;

  const fields: Array<{ field: string; expected: unknown; observed: unknown; agrees: boolean }> = [
    row("realm_id", intent.realm_id, observation?.realm_id ?? null),
    row("provider_entity_type", intent.provider_entity_type, comparable?.entity_type ?? null),
    row("provider_entity_id", intent.provider_entity_id, comparable?.entity_id ?? null),
    row("total_amount", intent.total_amount,
      comparable === null || comparable.total_amount_cents === null
        ? null
        : decimalOf(comparable.total_amount_cents)),
    row("currency", intent.currency,
      observedFacts === null ? null : (observedFacts["CurrencyRef.value"] ?? null)),
  ];

  return {
    expected_sha256: intent.expected_sha256,
    observed_sha256: observation?.observed_sha256 ?? null,
    verdict_observed_sha256: intent.observed_sha256,
    hashes_agree: comparable !== null
      && comparable.observed_sha256 === intent.expected_sha256,
    awaiting_readback: observation === null,
    fields,
    observed_facts: observedFacts,
    read_at: observation?.read_at ?? null,
    read_source: observation?.source ?? null,
  };
}

/**
 * One comparison row. A fact IronWrap never bound (a null expectation) is not a disagreement, and
 * neither is a fact nobody has read back yet - both render as "nothing to compare", never as red.
 */
function row(
  field: string,
  expected: unknown,
  observed: unknown,
): { field: string; expected: unknown; observed: unknown; agrees: boolean } {
  return {
    field,
    expected: expected ?? null,
    observed: observed ?? null,
    agrees: expected === null || observed === null
      ? expected === null && observed === null
      : JSON.stringify(expected) === JSON.stringify(observed),
  };
}

/** The customer the basis names, when it names one. Never derived from anything else. */
function customerRef(intent: AccountingIntentRecord): string | null {
  const basis = parseJson(intent.basis_json);
  if (!isRecord(basis)) return null;
  for (const key of ["customerRef", "customer_ref", "customerId", "customer_id", "customer"]) {
    const value = basis[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 160) return value;
  }
  return null;
}

function parseDetail(json: string): Record<string, unknown> {
  const parsed = parseJson(json);
  return isRecord(parsed) ? parsed : {};
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function centsOf(value: string): number {
  return Number.parseInt(value.replace(".", ""), 10) || 0;
}

function decimalOf(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}
