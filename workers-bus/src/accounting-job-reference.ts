// accounting-job-reference.ts - the job a money intent is derived against.
//
// ELEC-112 finding 3: `POST /api/v1/accounting/intents` took `roof_job_id` on trust. Any string
// that parsed produced a real, approvable `pending_review` deposit-invoice candidate - a job that
// had never existed, a job belonging to somebody else, a job still sitting in `Proposal`. The
// money plane's other guarantees (separation of duty, the authority ceiling, the tax binding) all
// hold around a job reference nobody ever checked, which makes the whole chain only as trustworthy
// as its weakest link.
//
// Existence is resolved against the tenant's D1 operating core. Eligibility stays a one-line
// seam so a later ruling can narrow it without a route change.

import type { AccountingIntentKind } from "./accounting-intents.ts";
import type { AppEnv } from "./app-types.ts";
import { configuredTenantId } from "./app-auth.ts";

/** The four facts the money desk is allowed to know about a job before it derives against it. */
export interface MoneyIntentJobReference {
  /** The operating job id, which is what `roof_job_id` on the wire refers to. */
  name: string;
  /** The domain identifier carried on the job, when it has one. */
  roofJobId: string | null;
  /** The lifecycle state the eligibility seam below rules on. */
  jobStatus: string | null;
}

/**
 * How the route resolves a job reference.
 *
 * Production leaves this unset and gets `readMoneyIntentJobReference`, which reads
 * `operating_roof_jobs`. A route test hands in a double so the gate can be driven
 * without a full operating core.
 */
export type MoneyIntentJobDirectory = (
  env: AppEnv,
  roofJobName: string,
) => Promise<MoneyIntentJobReference | null>;

const MAX_ROOF_JOB_NAME = 140;
const MAX_JOB_STATUS = 80;

/**
 * Resolve one job by its exact id, or `null` if the tenant's operating core has no such job.
 *
 * A throw means the directory could not be consulted, which the caller must treat as "unknown",
 * never as "absent" and never as "fine": an unreachable operating core is not permission to bill.
 */
export async function readMoneyIntentJobReference(
  env: AppEnv,
  roofJobName: string,
): Promise<MoneyIntentJobReference | null> {
  if (!validRoofJobName(roofJobName)) return null;
  const tenantId = configuredTenantId(env);
  if (!tenantId || !env.DB) {
    throw new Error("accounting_job_directory_unavailable");
  }
  let row: { roof_job_id: string; job_status: string | null } | null;
  try {
    row = await env.DB.prepare(
      `SELECT roof_job_id, job_status
         FROM operating_roof_jobs
        WHERE tenant_id = ? AND roof_job_id = ?
        LIMIT 1`,
    ).bind(tenantId, roofJobName).first<{ roof_job_id: string; job_status: string | null }>();
  } catch {
    throw new Error("accounting_job_directory_unavailable");
  }
  if (!row || row.roof_job_id !== roofJobName) return null;
  return {
    name: row.roof_job_id,
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
 * without silently also shipping an eligibility policy nobody ruled on.
 */
export function moneyIntentJobEligible(
  job: MoneyIntentJobReference,
  kind: AccountingIntentKind,
): boolean {
  void job;
  void kind;
  return true;
}

function validRoofJobName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:#()-]{0,139}$/.test(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}
