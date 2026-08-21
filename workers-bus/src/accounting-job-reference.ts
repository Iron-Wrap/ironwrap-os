// accounting-job-reference.ts - the job a money intent is derived against.
//
// ELEC-112 finding 3: `POST /api/v1/accounting/intents` took `roof_job_id` on trust. Any string
// that parsed produced a real, approvable `pending_review` deposit-invoice candidate - a job that
// had never existed, a job belonging to somebody else, a job still sitting in `Proposal`. The
// money plane's other guarantees (separation of duty, the authority ceiling, the tax binding) all
// hold around a job reference nobody ever checked, which makes the whole chain only as trustworthy
// as its weakest link.
//
// This module is that check, and it is deliberately split in two:
//
//  1. **Existence** - `readMoneyIntentJobReference` resolves the reference against the tenant's
//     operating core through the narrowest Frappe contract in the codebase. A job that does not
//     resolve is not a job the desk may bill against.
//  2. **Eligibility** - `moneyIntentJobEligible` decides whether a job that *does* exist is in a
//     state a given money intent may be derived from. Today that predicate is "any job that
//     exists", which is exactly the behaviour this fix inherited; it is written as one function so
//     the architect's ruling on the semantics lands as a one-line change here rather than as a
//     status set hard-coded through the route.
//
// Nothing here decides *who* may ask - `accounting-api.ts` still owns permission, CSRF and
// idempotency - and nothing here writes.

import type { AccountingIntentKind } from "./accounting-intents.ts";
import type { AppEnv } from "./app-types.ts";
import { listAccountingJobFrappeResource } from "./frappe-read.ts";

/** The four facts the money desk is allowed to know about a job before it derives against it. */
export interface MoneyIntentJobReference {
  /** The Frappe document name, which is what `roof_job_id` on the wire refers to. */
  name: string;
  /** The domain identifier carried on the job, when it has one. */
  roofJobId: string | null;
  /** The lifecycle state the eligibility seam below rules on. */
  jobStatus: string | null;
}

/**
 * How the route resolves a job reference.
 *
 * Production leaves this unset and gets `readMoneyIntentJobReference`, which reaches the tenant's
 * Frappe. A route test hands in a double so the gate can be driven without an operating core -
 * the same shape and the same reason as the money desk's existing observation seam.
 */
export type MoneyIntentJobDirectory = (
  env: AppEnv,
  roofJobName: string,
) => Promise<MoneyIntentJobReference | null>;

const MAX_ROOF_JOB_NAME = 140;
const MAX_JOB_STATUS = 80;

/**
 * Resolve one job by its exact name, or `null` if the tenant's operating core has no such job.
 *
 * A throw means the directory could not be consulted, which the caller must treat as "unknown",
 * never as "absent" and never as "fine": an unreachable operating core is not permission to bill.
 */
export async function readMoneyIntentJobReference(
  env: AppEnv,
  roofJobName: string,
): Promise<MoneyIntentJobReference | null> {
  if (!validRoofJobName(roofJobName)) return null;
  const rows = await listAccountingJobFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", roofJobName]],
    1,
  );
  const row = rows[0];
  const name = row ? text(row.name, MAX_ROOF_JOB_NAME) : null;
  // Frappe's `=` is the storage collation's `=`, so the row that comes back is confirmed against
  // the name that was asked for rather than assumed to be it.
  if (!row || name !== roofJobName) return null;
  return {
    name,
    roofJobId: text(row.roof_job_id, MAX_ROOF_JOB_NAME),
    jobStatus: text(row.job_status, MAX_JOB_STATUS),
  };
}

/** The shape of the eligibility seam, so a route test can prove the refusal it guards. */
export type MoneyIntentJobEligibility = (
  job: MoneyIntentJobReference,
  kind: AccountingIntentKind,
) => boolean;

/**
 * **The eligibility seam.** Whether an existing job is in a state this kind of money intent may be
 * derived from.
 *
 * Today: yes, for every job that exists. That is not a judgement about what the rule *should* be -
 * it is this route's behaviour before the gate, preserved on purpose so the existence check ships
 * without silently also shipping an eligibility policy nobody ruled on. ELEC-112 finding 3 asked
 * for the PO's judgement on the intended gate (must a deposit invoice wait for `Won`? may a
 * progress invoice be derived mid-production?), and the architect's ruling replaces the body of
 * this function - for example:
 *
 * ```ts
 * const ELIGIBLE_JOB_STATUSES: Readonly<Record<AccountingIntentKind, readonly string[]>> = { ... };
 * return ELIGIBLE_JOB_STATUSES[kind]?.includes(job.jobStatus ?? "") ?? false;
 * ```
 *
 * Nothing else needs to change when it does: the route already refuses an ineligible job with
 * `accounting_intent_roof_job_not_eligible`, and that refusal already has a test.
 */
export function moneyIntentJobEligible(
  job: MoneyIntentJobReference,
  kind: AccountingIntentKind,
): boolean {
  void job;
  void kind;
  return true;
}

/**
 * The Frappe document-name shape, matched before the reference reaches the wire.
 *
 * The route's own `refText` is narrower than Frappe names can be, so this stays permissive enough
 * for a real name and strict enough that nothing resembling a filter expression is ever sent.
 */
function validRoofJobName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:#()-]{0,139}$/.test(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}
