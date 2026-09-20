import { nativeJobStatusLabel } from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

/**
 * What else this customer has had done, including the work that is finished.
 *
 * Every other job read in this Worker stops at the two live statuses, because every other job read
 * exists to run today's work: `buildJobReadModel` refuses anything outside them, and operator
 * search will not return it. The effect is that a repeat customer's history leaves the product the
 * moment a job completes — the office cannot see that this roof was done two winters ago, by whom,
 * or on which of the customer's properties, which is exactly the context a follow-up call needs.
 *
 * This read closes that hole and nothing else. It is a summary, not a second way into a job: it
 * carries what an operator needs to recognise prior work, and it says plainly which entries can be
 * opened and which cannot, rather than offering a link that would 404.
 */

/** One page of history. Deep enough for a long-standing customer, bounded so a phone can hold it. */
export const CUSTOMER_JOB_HISTORY_PAGE_SIZE = 20;

/**
 * The raw `operating_roof_jobs.job_status` values `buildJobReadModel` will open. Kept here in the
 * storage vocabulary (the read model compares display labels) so `openable` below states the
 * truth about the job route rather than guessing at it. `customer-job-history.test.ts` asserts the
 * agreement against the live route instead of trusting this comment.
 */
export const OPENABLE_NATIVE_JOB_STATUSES = [
  "qualified",
  "in_progress",
] as const;

export interface CustomerJobHistoryProperty {
  property_id: string;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  structure_type: string | null;
}

export interface CustomerJobHistoryEntry {
  roof_job_id: string;
  job_number: string | null;
  service_type: string | null;
  job_status: string | null;
  brand: string | null;
  property: CustomerJobHistoryProperty | null;
  /** True for the job the reader is standing on, so the client can mark it rather than link to it. */
  is_anchor: boolean;
  openable: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface CustomerJobHistoryReadModel {
  customer: {
    customer_id: string;
    display_name: string | null;
    lifecycle_status: string | null;
  };
  anchor_job_id: string;
  entries: CustomerJobHistoryEntry[];
  /** True when this customer has more jobs than one page. Never let a cap read as "that is all". */
  truncated: boolean;
  generated_at: string;
}

interface AnchorRow {
  customer_id: string;
  display_name: string | null;
  lifecycle_status: string | null;
}

interface HistoryRow {
  roof_job_id: string;
  job_number: string | null;
  service_type: string | null;
  job_status: string;
  brand: string | null;
  created_at: string | null;
  updated_at: string | null;
  property_id: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  structure_type: string | null;
}

/**
 * Resolve the customer behind one job, then that customer's jobs in this tenant.
 *
 * The anchor is not required to be an openable job. The caller holds `jobs:read:any`, so gating the
 * anchor on status would only stop them reaching history from a completed job — the one case this
 * read exists for. Tenant scope is the boundary that matters and it is applied to both queries.
 *
 * Returns `null` when the job does not exist in this tenant, which the route answers as 404. A job
 * the reader may not name and a job that is not there are deliberately the same answer.
 */
export async function buildCustomerJobHistoryReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<CustomerJobHistoryReadModel | null> {
  const tenantId = auth.session.tenant_id;
  const anchor = await env.DB.prepare(
    `SELECT j.customer_id, c.display_name, c.lifecycle_status
       FROM operating_roof_jobs j
       JOIN operating_customers c
         ON c.customer_id = j.customer_id
        AND c.tenant_id = j.tenant_id
      WHERE j.tenant_id = ?
        AND j.roof_job_id = ?`,
  )
    .bind(tenantId, jobName)
    .first<AnchorRow>();
  if (!anchor) return null;

  // One row past the page so `truncated` is a fact about the data, not a guess from a full page.
  const read = await env.DB.prepare(
    `SELECT j.roof_job_id, j.job_number, j.service_type, j.job_status, j.brand,
            j.created_at, j.updated_at,
            p.property_id, p.address_line1, p.city, p.province, p.postal_code, p.structure_type
       FROM operating_roof_jobs j
       LEFT JOIN operating_properties p
         ON p.property_id = j.property_id
        AND p.tenant_id = j.tenant_id
      WHERE j.tenant_id = ?
        AND j.customer_id = ?
      ORDER BY j.updated_at DESC, j.roof_job_id ASC
      LIMIT ?`,
  )
    .bind(tenantId, anchor.customer_id, CUSTOMER_JOB_HISTORY_PAGE_SIZE + 1)
    .all<HistoryRow>();
  const rows = read.results ?? [];

  return {
    customer: {
      customer_id: anchor.customer_id,
      display_name: anchor.display_name,
      lifecycle_status: anchor.lifecycle_status,
    },
    anchor_job_id: jobName,
    entries: rows
      .slice(0, CUSTOMER_JOB_HISTORY_PAGE_SIZE)
      .map(historyEntry(jobName)),
    truncated: rows.length > CUSTOMER_JOB_HISTORY_PAGE_SIZE,
    generated_at: new Date().toISOString(),
  };
}

function historyEntry(anchorJobId: string) {
  return (row: HistoryRow): CustomerJobHistoryEntry => ({
    roof_job_id: row.roof_job_id,
    job_number: row.job_number,
    service_type: row.service_type,
    job_status: nativeJobStatusLabel(row.job_status),
    brand: row.brand,
    property: row.property_id
      ? {
          property_id: row.property_id,
          address_line1: row.address_line1,
          city: row.city,
          province: row.province,
          postal_code: row.postal_code,
          structure_type: row.structure_type,
        }
      : null,
    is_anchor: row.roof_job_id === anchorJobId,
    openable: (OPENABLE_NATIVE_JOB_STATUSES as readonly string[]).includes(
      row.job_status,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
