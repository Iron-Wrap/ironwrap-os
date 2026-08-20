// accounting-compensation-authorizations.ts - the accountant's authorization of one reversal,
// written down.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.4 and 6, migration
// `0063_accounting_dispatch_evidence.sql`. Section 5.4's rule is "the system proposes; the
// accountant authorizes; the remedy runs as a compensating effect with `compensates_effect_id`
// set". Slice S8 implemented the first two-thirds of that sentence and dropped the evidence on the
// floor: `POST /compensate` computed a plan, returned it to the browser, and persisted nothing but
// a receipt fingerprint - so the remedy and amount a human authorized were gone the moment the
// response was written, and no later process could run the reversal they asked for.
//
// This module is that missing row. It is the authorization, not a queue entry: it says who
// authorized what, in the numbers they authorized it in, against which exception. Two things read
// it - the dispatcher, which runs exactly the reversal it names, and the exception-resolution
// check, which measures a claimed reversal against the amount that was actually authorized.
//
// Append-only, one row per exception. A retried command replays it rather than authorizing a
// second reversal, because money that is owed back once must not be returned twice.

import { canonicalJson } from "./newo-hash.ts";
import type { AppEnv } from "./app-types.ts";
import type { CompensationPlan } from "./accounting-compensation.ts";

export class AccountingCompensationAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingCompensationAuthorizationError";
  }
}

export interface AccountingCompensationAuthorizationRecord {
  authorization_id: string;
  tenant_id: string;
  intent_id: string;
  exception_id: string;
  reversal_intent_id: string;
  remedy: "credit_memo_issued" | "refund_issued";
  reversal_kind: "credit_memo" | "refund";
  total_amount: string;
  magnitude_amount: string;
  plan_json: string;
  authorized_by_user_id: string;
  authorized_at: string;
}

/**
 * The id of the reversing intent this authorization will produce.
 *
 * Derived from the exception rather than minted randomly, so a replayed command computes the same
 * id and the `UNIQUE (tenant_id, reversal_intent_id)` constraint turns a double-authorization into
 * a storage-layer no-op instead of a second credit memo.
 */
export function reversalIntentIdFor(exceptionId: string): string {
  return `acct-reversal:${exceptionId}`.slice(0, 160);
}

/**
 * Record one authorization, idempotently on the exception it answers.
 *
 * Returns the stored row, which on a replay is the *original* authorization - so a second command
 * with a different amount cannot quietly widen a reversal the accountant already signed for. The
 * caller compares what it asked for against what came back.
 */
export async function recordAccountingCompensationAuthorization(
  env: AppEnv,
  input: {
    tenantId: string;
    plan: CompensationPlan;
    authorizedByUserId: string;
  },
  now: Date = new Date(),
): Promise<AccountingCompensationAuthorizationRecord> {
  const remedy = input.plan.remedy;
  if (remedy !== "credit_memo_issued" && remedy !== "refund_issued") {
    // Only the two remedies that derive a reversing intent are authorizable here; the others are
    // resolved directly on the exception and never dispatch anything.
    throw new AccountingCompensationAuthorizationError(
      "accounting_compensation_remedy_not_reversal",
    );
  }
  await env.DB.prepare(
    `INSERT INTO accounting_compensation_authorizations (
       authorization_id, tenant_id, intent_id, exception_id, reversal_intent_id, remedy,
       reversal_kind, total_amount, magnitude_amount, plan_json, authorized_by_user_id,
       authorized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, exception_id) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), input.tenantId, input.plan.intentId, input.plan.exceptionId,
    reversalIntentIdFor(input.plan.exceptionId), remedy, input.plan.reversalKind,
    input.plan.totalAmount, input.plan.magnitudeAmount, canonicalJson(input.plan),
    input.authorizedByUserId, now.toISOString(),
  ).run();

  const stored = await readAccountingCompensationAuthorizationByException(
    env, input.tenantId, input.plan.exceptionId,
  );
  if (!stored) {
    throw new AccountingCompensationAuthorizationError(
      "accounting_compensation_authorization_write_failed",
    );
  }
  return stored;
}

export async function readAccountingCompensationAuthorizationByException(
  env: AppEnv,
  tenantId: string,
  exceptionId: string,
): Promise<AccountingCompensationAuthorizationRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_compensation_authorizations
      WHERE tenant_id = ? AND exception_id = ?`,
  ).bind(tenantId, exceptionId).first<AccountingCompensationAuthorizationRecord>();
}

/** Every authorization whose reversal has not settled yet, oldest first. The dispatcher's queue. */
export async function listPendingCompensationAuthorizations(
  env: AppEnv,
  tenantId: string,
  limit = 50,
): Promise<AccountingCompensationAuthorizationRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT a.* FROM accounting_compensation_authorizations a
       JOIN accounting_intents original
         ON original.tenant_id = a.tenant_id AND original.intent_id = a.intent_id
      WHERE a.tenant_id = ?
        -- Only an original the accountant's compensate command actually moved. An authorization
        -- whose original already reached compensated has nothing left to dispatch.
        AND original.state = 'compensating'
      ORDER BY a.authorized_at, a.authorization_id
      LIMIT ?`,
  ).bind(tenantId, limit).all<AccountingCompensationAuthorizationRecord>();
  return rows.results ?? [];
}
