import type { AppEnv } from "./app-types.ts";

/** Current office identity only; it is not a frozen customer-address snapshot or an action grant. */
export interface OfficeJobIdentity {
  id: string;
  roof_job_id: string;
  job_number: string | null;
  customer_display_name: string | null;
  address: string | null;
}

export interface OfficeJobIdentitySource {
  job: OfficeJobIdentity;
  modified: string | null;
}

interface IdentityRow {
  roof_job_id: string;
  job_number: string | null;
  customer_display_name: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  updated_at: string | null;
  customer_updated_at: string | null;
  property_updated_at: string | null;
}

// Matches the existing production source bound; no identity read can broaden its job inventory.
const MAX_JOBS = 100;
const IDENTITY_SOURCE = `SELECT job.roof_job_id, job.job_number,
       customer.display_name AS customer_display_name,
       property.address_line1, property.city, property.province, property.postal_code,
       property.country, job.updated_at,
       customer.updated_at AS customer_updated_at, property.updated_at AS property_updated_at
  FROM operating_roof_jobs job
  LEFT JOIN operating_customers customer
    ON customer.tenant_id = job.tenant_id AND customer.customer_id = job.customer_id
  LEFT JOIN operating_properties property
    ON property.tenant_id = job.tenant_id AND property.property_id = job.property_id`;

/** Callers retain their estimator/production permission gates and select the exact admitted jobs. */
export async function readOfficeJobIdentitySources(
  env: AppEnv,
  tenantId: string,
  roofJobIds: readonly string[],
): Promise<Map<string, OfficeJobIdentitySource>> {
  const selected = [...new Set(roofJobIds)].slice(0, MAX_JOBS);
  if (!env.DB || selected.length === 0) return new Map();
  try {
    const result = await env.DB.prepare(
      `${IDENTITY_SOURCE}
       WHERE job.tenant_id = ?
         AND job.roof_job_id IN (SELECT value FROM json_each(?))
       ORDER BY job.roof_job_id ASC LIMIT ?`,
    ).bind(tenantId, JSON.stringify(selected), MAX_JOBS).all<IdentityRow>();
    return new Map((result.results ?? []).map((row) => [row.roof_job_id, identitySource(row)]));
  } catch (error) {
    if (missingIdentityTable(error)) return new Map();
    throw error;
  }
}

/**
 * Only the detail envelope uses this read. The stored source ID is the exact native revision ID
 * exposed as estimator quote.id; compatibility-only IDs are unknown, never an aggregate/latest
 * quote fallback. The quote's tenant, job, revision number and customer must all agree.
 */
export async function readQuoteRevisionOfficeJob(
  env: AppEnv,
  tenantId: string,
  binding: { roofJobId: string; sourceQuoteId: string; sourceQuoteVersion: number },
): Promise<OfficeJobIdentity | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `${IDENTITY_SOURCE}
       JOIN commercial_quote_revisions reviewed
         ON reviewed.tenant_id = job.tenant_id
        AND reviewed.roof_job_id = job.roof_job_id
        AND reviewed.customer_id = job.customer_id
       WHERE job.tenant_id = ? AND job.roof_job_id = ?
         AND reviewed.quote_revision_id = ? AND reviewed.revision_number = ?
       LIMIT 1`,
    ).bind(tenantId, binding.roofJobId, binding.sourceQuoteId, binding.sourceQuoteVersion)
      .first<IdentityRow>();
    return row ? identitySource(row).job : null;
  } catch (error) {
    if (missingIdentityTable(error) || missingTable(error, "commercial_quote_revisions")) return null;
    throw error;
  }
}

function identitySource(row: IdentityRow): OfficeJobIdentitySource {
  const street = text(row.address_line1);
  const locality = [text(row.city), text(row.province), text(row.postal_code)]
    .filter((part): part is string => part !== null).join(" ");
  const modified = [text(row.updated_at), text(row.customer_updated_at), text(row.property_updated_at)]
    .filter((value): value is string => value !== null).sort().at(-1) ?? null;
  return {
    job: {
      id: row.roof_job_id,
      roof_job_id: row.roof_job_id,
      job_number: text(row.job_number),
      customer_display_name: text(row.customer_display_name),
      address: street
        ? [street, locality || null, text(row.country)].filter((part) => part !== null).join(", ")
        : null,
    },
    modified,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function missingIdentityTable(error: unknown): boolean {
  return ["operating_roof_jobs", "operating_customers", "operating_properties"]
    .some((table) => missingTable(error, table));
}

function missingTable(error: unknown, table: string): boolean {
  return error instanceof Error && error.message.includes(`no such table: ${table}`);
}
