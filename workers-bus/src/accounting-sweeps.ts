// accounting-sweeps.ts - the scheduled money-plane sweeps (slice S8).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.1: "Scheduled work joins the existing cron
// in `workers-bus/src/index.ts` beside `recoverDueQuickBooksProjections`: a due-observation sweep
// (re-read entities whose reconciliation is stale), a deadline sweep (expire `unknown` effects
// into `manual_exception`), and a holdback lien-period sweep (surface releases that have become
// eligible)." The holdback sweep belongs to slice S6, which has not shipped and is not started
// here; its place is taken by the exception-aging sweep the desk needs to show an ageing queue.
//
// One rule governs all three, and it is the reason two of them write nothing:
//
//   **A timer is not evidence.** Section 5.1 admits exactly one route to a settled state - an
//   authenticated provider-detail read compared against the bound fact set - and section 5.3 says
//   an unreachable provider "is not a statement about the money". A sweep that demoted a
//   `reconciled` intent because a clock passed would be inventing a verdict out of the absence of
//   a check. So the due-observation sweep re-reads when it is given a reader and otherwise reports
//   what is due; the ageing sweep reports; and only the deadline sweep transitions state, because
//   there the deadline itself is the accountant's own policy and section 5.4 names the outcome.
//
// No credential lives here. The provider reader is injected (the `fetcher` convention slice S3
// established), so under test it is a synthetic Intuit double and in an unbound Worker it is
// simply absent - project rule 5 holds by construction rather than by discipline.

import {
  listAccountingExceptions,
  type AccountingExceptionRecord,
} from "./accounting-exceptions.ts";
import {
  ageSeconds,
  DEFAULT_STALE_OBSERVATION_SECONDS,
  OBSERVED_STATES,
} from "./accounting-desk.ts";
import {
  listAccountingIntents,
  type AccountingIntentRecord,
  type AccountingIntentState,
} from "./accounting-intents.ts";
import type { AccountingEntityType } from "./accounting-normalizers.ts";
import type { ProviderReadResult } from "./accounting-provider-read.ts";
import { reconcileAccountingIntent } from "./accounting-reconciliation.ts";
import { resolveUncertainAccountingIntent } from "./accounting-reconciliation.ts";
import type { AppEnv } from "./app-types.ts";

/** How long an `uncertain` intent may stay unresolved before it becomes a human decision. */
export const DEFAULT_UNCERTAIN_DEADLINE_SECONDS = 6 * 60 * 60;

/** When an exception has been open this long, the desk shows it as ageing. */
export const DEFAULT_EXCEPTION_AGING_SECONDS = 48 * 60 * 60;

/**
 * Past this, an intent waiting on the dispatcher is stuck rather than in flight.
 *
 * Generous against a five-minute cron on purpose: a couple of missed runs is a slow afternoon, and
 * half an hour of silence is a dispatcher that is not running.
 */
export const DEFAULT_STUCK_DISPATCH_SECONDS = 30 * 60;

/**
 * The states between a human's decision and the provider hearing about it.
 *
 * Deliberately not added to `OBSERVED_STATES`: that list means "expected to have a current provider
 * observation", and an intent with no provider entity id yet has nothing to re-read by exact id.
 * These states need a sweep of their own, which is `sweepStuckAccountingDispatches`.
 */
export const AWAITING_DISPATCH_STATES: readonly AccountingIntentState[] = [
  "submission_pending", "compensating",
];

/**
 * The one seam a sweep needs to reach the provider: read one entity by its exact id.
 *
 * Deliberately narrower than `readProviderEntity` itself so a sweep cannot grow a write path, and
 * optional everywhere so the Worker can register the sweep before slice S11 binds a real reader.
 */
export type SweepProviderReader = (input: {
  tenantId: string;
  entityType: AccountingEntityType;
  entityId: string;
}) => Promise<ProviderReadResult>;

export interface DueObservation {
  intent_id: string;
  state: AccountingIntentState;
  entity_type: string | null;
  entity_id: string | null;
  last_read_at: string | null;
  stale_seconds: number | null;
}

export interface DueObservationSweepResult {
  scanned: number;
  /** Intents whose provider truth has not been re-read inside the window. */
  due: DueObservation[];
  /** How many were actually re-read. Zero without a reader, and that is a normal state. */
  reread: number;
  reconciled: number;
  mismatched: number;
  unavailable: number;
  /** True when no reader was supplied, so `due` is a report and nothing was checked. */
  reader_unbound: boolean;
}

/**
 * Find every intent whose provider truth has gone stale, and re-read it when a reader is bound.
 *
 * "Stale" is a statement about our knowledge, never about the money: an intent appears here
 * because we have not looked recently, which is exactly why the answer is to look rather than to
 * change a state.
 */
export async function sweepDueAccountingObservations(
  env: AppEnv,
  input: {
    tenantId: string;
    read?: SweepProviderReader;
    staleAfterSeconds?: number;
    limit?: number;
    now?: Date;
  },
): Promise<DueObservationSweepResult> {
  const now = input.now ?? new Date();
  const staleAfterSeconds = input.staleAfterSeconds ?? DEFAULT_STALE_OBSERVATION_SECONDS;
  const threshold = new Date(now.getTime() - staleAfterSeconds * 1000).toISOString();

  const candidates = await listAccountingIntents(env, input.tenantId, {
    states: OBSERVED_STATES,
    limit: input.limit ?? 100,
  });

  const due: DueObservation[] = [];
  for (const intent of candidates) {
    const lastReadAt = await latestObservationReadAt(env, input.tenantId, intent.intent_id);
    if (lastReadAt !== null && lastReadAt >= threshold) continue;
    due.push({
      intent_id: intent.intent_id,
      state: intent.state,
      entity_type: intent.provider_entity_type,
      entity_id: intent.provider_entity_id,
      last_read_at: lastReadAt,
      stale_seconds: lastReadAt === null ? null : ageSeconds(lastReadAt, now),
    });
  }

  const result: DueObservationSweepResult = {
    scanned: candidates.length,
    due,
    reread: 0,
    reconciled: 0,
    mismatched: 0,
    unavailable: 0,
    reader_unbound: input.read === undefined,
  };
  const read = input.read;
  if (!read) return result;

  for (const item of due) {
    // An intent with no provider entity id has nothing to re-read by exact id, and section 5.1
    // admits no other kind of read. It stays due, and the deadline sweep is what answers it.
    if (!item.entity_id || !item.entity_type) continue;
    const outcome = await read({
      tenantId: input.tenantId,
      entityType: item.entity_type as AccountingEntityType,
      entityId: item.entity_id,
    });
    result.reread += 1;
    if (outcome.status === "unavailable") {
      result.unavailable += 1;
      continue;
    }
    const judged = await reconcileAccountingIntent(env, {
      tenantId: input.tenantId,
      intentId: item.intent_id,
      read: outcome,
    }, now);
    if (judged.verdict === "reconciled") result.reconciled += 1;
    else if (judged.verdict === "unavailable") result.unavailable += 1;
    else result.mismatched += 1;
  }
  return result;
}

export interface UncertainDeadlineSweepResult {
  scanned: number;
  expired: string[];
  waiting: string[];
}

/**
 * Expire an `unknown` dispatch into an accountant's decision once its deadline passes.
 *
 * The ledger refuses to retry an `unknown` effect (`effect_unknown_requires_reconciliation`), so
 * the only two routes out are finding the entity or handing it to a human. This sweep is the
 * second: past the deadline it raises `unknown_effect_deadline_expired` and moves the intent to
 * `reconciliation_required`. It never invents a `not_found` before the deadline.
 */
export async function sweepUncertainAccountingIntents(
  env: AppEnv,
  input: {
    tenantId: string;
    deadlineSeconds?: number;
    limit?: number;
    now?: Date;
  },
): Promise<UncertainDeadlineSweepResult> {
  const now = input.now ?? new Date();
  const deadlineSeconds = input.deadlineSeconds ?? DEFAULT_UNCERTAIN_DEADLINE_SECONDS;
  const uncertain = await listAccountingIntents(env, input.tenantId, {
    state: "uncertain",
    limit: input.limit ?? 100,
  });

  const result: UncertainDeadlineSweepResult = { scanned: uncertain.length, expired: [], waiting: [] };
  for (const intent of uncertain) {
    const deadlineAt = new Date(
      Date.parse(intent.provider_submitted_at ?? intent.updated_at) + deadlineSeconds * 1000,
    ).toISOString();
    const outcome = await resolveUncertainAccountingIntent(env, {
      tenantId: input.tenantId,
      intentId: intent.intent_id,
      lookup: { status: "absent" },
      deadlineAt,
    }, now);
    if (outcome.resolution === "manual_exception") result.expired.push(intent.intent_id);
    else result.waiting.push(intent.intent_id);
  }
  return result;
}

export interface ExceptionAgingSweepResult {
  open: number;
  acknowledged: number;
  ageing: Array<{ exception_id: string; reason_code: string; age_seconds: number }>;
  oldest_age_seconds: number | null;
  aging_after_seconds: number;
}

/**
 * Report how long the accountant's queue has been waiting.
 *
 * It writes nothing on purpose. Acknowledging an exception is a statement that a person has seen
 * it (section 6, "resolve an exception: `accounting`"), and a cron acknowledging one on their
 * behalf would put a human's name on a decision nobody made.
 */
export async function sweepAgeingAccountingExceptions(
  env: AppEnv,
  input: { tenantId: string; agingAfterSeconds?: number; now?: Date },
): Promise<ExceptionAgingSweepResult> {
  const now = input.now ?? new Date();
  const agingAfterSeconds = input.agingAfterSeconds ?? DEFAULT_EXCEPTION_AGING_SECONDS;
  const live = (await listAccountingExceptions(env, input.tenantId))
    .filter((exception) => exception.status !== "resolved");

  const ageing = live
    .map((exception) => ({
      exception_id: exception.exception_id,
      reason_code: exception.reason_code as string,
      age_seconds: ageSeconds(exception.opened_at, now),
    }))
    .filter((entry) => entry.age_seconds >= agingAfterSeconds);

  return {
    open: count(live, "open"),
    acknowledged: count(live, "acknowledged"),
    ageing,
    oldest_age_seconds: live.length === 0 ? null : ageSeconds(live[0]!.opened_at, now),
    aging_after_seconds: agingAfterSeconds,
  };
}

export interface StuckDispatchSweepResult {
  scanned: number;
  /** Intents that have been waiting to reach the provider longer than the window allows. */
  stuck: Array<{
    intent_id: string;
    state: AccountingIntentState;
    kind: string;
    age_seconds: number;
  }>;
  stuck_after_seconds: number;
}

/**
 * Surface an intent that is waiting to reach the provider and has stopped moving.
 *
 * `submission_pending` and `compensating` are the two states an intent occupies between a human's
 * decision and the dispatcher acting on it, and neither is in `OBSERVED_STATES` - correctly, since
 * an intent with no provider entity yet has nothing to re-read by exact id, which is the only kind
 * of read section 5.1 admits. That left them unobserved by anything at all: before this sweep an
 * approved invoice could sit in `submission_pending` forever behind the desk's "Being sent to
 * QuickBooks. Nothing else to do yet." and no sweep would ever mention it (ELEC-71).
 *
 * It writes nothing, for the same reason the ageing sweep writes nothing: a clock passing is not
 * evidence about the money. What it produces is the log line and the desk figure that make a
 * stalled dispatcher visible instead of silent.
 */
export async function sweepStuckAccountingDispatches(
  env: AppEnv,
  input: { tenantId: string; stuckAfterSeconds?: number; limit?: number; now?: Date },
): Promise<StuckDispatchSweepResult> {
  const now = input.now ?? new Date();
  const stuckAfterSeconds = input.stuckAfterSeconds ?? DEFAULT_STUCK_DISPATCH_SECONDS;
  const waiting = await listAccountingIntents(env, input.tenantId, {
    states: AWAITING_DISPATCH_STATES,
    limit: input.limit ?? 100,
  });

  return {
    scanned: waiting.length,
    stuck: waiting
      .map((intent) => ({
        intent_id: intent.intent_id,
        state: intent.state,
        kind: intent.kind as string,
        age_seconds: ageSeconds(intent.updated_at, now),
      }))
      .filter((entry) => entry.age_seconds >= stuckAfterSeconds),
    stuck_after_seconds: stuckAfterSeconds,
  };
}

export interface AccountingSweepReport {
  tenant_id: string;
  due_observations: DueObservationSweepResult;
  uncertain: UncertainDeadlineSweepResult;
  exceptions: ExceptionAgingSweepResult;
  stuck_dispatches: StuckDispatchSweepResult;
}

/** The single entry point `index.ts` registers on the frequent cron. */
export async function runAccountingSweeps(
  env: AppEnv,
  input: {
    tenantId: string;
    read?: SweepProviderReader;
    staleAfterSeconds?: number;
    deadlineSeconds?: number;
    agingAfterSeconds?: number;
    stuckAfterSeconds?: number;
    now?: Date;
  },
): Promise<AccountingSweepReport> {
  const [dueObservations, uncertain, exceptions, stuckDispatches] = await Promise.all([
    sweepDueAccountingObservations(env, {
      tenantId: input.tenantId,
      read: input.read,
      staleAfterSeconds: input.staleAfterSeconds,
      now: input.now,
    }),
    sweepUncertainAccountingIntents(env, {
      tenantId: input.tenantId,
      deadlineSeconds: input.deadlineSeconds,
      now: input.now,
    }),
    sweepAgeingAccountingExceptions(env, {
      tenantId: input.tenantId,
      agingAfterSeconds: input.agingAfterSeconds,
      now: input.now,
    }),
    sweepStuckAccountingDispatches(env, {
      tenantId: input.tenantId,
      stuckAfterSeconds: input.stuckAfterSeconds,
      now: input.now,
    }),
  ]);
  return {
    tenant_id: input.tenantId,
    due_observations: dueObservations,
    uncertain,
    exceptions,
    stuck_dispatches: stuckDispatches,
  };
}

/** True when a sweep found anything a log line should carry. Keeps a quiet cron quiet. */
export function accountingSweepIsNoteworthy(report: AccountingSweepReport): boolean {
  return report.due_observations.due.length > 0
    || report.uncertain.expired.length > 0
    || report.exceptions.ageing.length > 0
    || report.stuck_dispatches.stuck.length > 0;
}

async function latestObservationReadAt(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(read_at) AS read_at FROM accounting_observations
      WHERE tenant_id = ? AND intent_id = ?`,
  ).bind(tenantId, intentId).first<{ read_at: string | null }>();
  return row?.read_at ?? null;
}

function count(
  exceptions: readonly AccountingExceptionRecord[],
  status: "open" | "acknowledged",
): number {
  return exceptions.filter((exception) => exception.status === status).length;
}

/**
 * The tenant the Worker's own cron sweeps.
 *
 * A scheduled invocation has no session to take a tenant from, so it uses the runtime's configured
 * identity - the same value `validate-tenant-runtime.mjs` pins and every other single-tenant
 * scheduled path here already falls back to.
 */
export function accountingSweepTenantId(env: AppEnv): string {
  return env.APP_TENANT_ID?.trim() || "ironwrap";
}

/** Kept for the type-only import that documents what a sweep may touch. */
export type SweptIntent = AccountingIntentRecord;
