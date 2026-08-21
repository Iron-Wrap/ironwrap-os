import type { AppEnv } from "./app-types.ts";
import type {
  CommercialAcceptanceBindingRecord,
  CommercialProposalRecord,
  CommercialPublicationRecord,
  CommercialQuoteRecord,
} from "./commercial-store.ts";

export interface NativeJobCoreRecord {
  roof_job_id: string;
  customer_id: string;
  property_id: string | null;
  brand: string | null;
  job_number: string | null;
  service_type: string;
  job_status: string | null;
  current_gate_state: string;
  version: number;
  updated_at: string;
}

export interface NativeCustomerRecord {
  customer_id: string;
  display_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  updated_at: string;
}

export interface NativePropertyRecord {
  property_id: string;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  updated_at: string;
}

export interface NativeJobCore {
  job: NativeJobCoreRecord;
  customer: NativeCustomerRecord | null;
  property: NativePropertyRecord | null;
}

export interface NativeCommercialJobPacket {
  quotes: CommercialQuoteRecord[];
  proposals: CommercialProposalRecord[];
  publications: CommercialPublicationRecord[];
  acceptances: CommercialAcceptanceBindingRecord[];
  partial_sources: string[];
}

export async function readNativeJobCore(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<NativeJobCore | null> {
  if (!env.DB) return null;
  try {
    const job = await firstRow<NativeJobCoreRecord>(
      env,
      `SELECT roof_job_id, customer_id, property_id, brand, job_number, service_type,
              job_status, current_gate_state, version, updated_at
         FROM operating_roof_jobs
        WHERE tenant_id = ? AND roof_job_id = ?
        LIMIT 1`,
      tenantId,
      roofJobId,
    );
    if (!job) return null;
    const [customer, property] = await Promise.all([
      firstRow<NativeCustomerRecord>(
        env,
        `SELECT customer_id, display_name, contact_email, contact_phone, updated_at
           FROM operating_customers
          WHERE tenant_id = ? AND customer_id = ?
          LIMIT 1`,
        tenantId,
        job.customer_id,
      ),
      job.property_id
        ? firstRow<NativePropertyRecord>(
            env,
            `SELECT property_id, address_line1, city, province, postal_code, country, updated_at
             FROM operating_properties
            WHERE tenant_id = ? AND property_id = ?
            LIMIT 1`,
            tenantId,
            job.property_id,
          )
        : Promise.resolve(null),
    ]);
    return { job, customer, property };
  } catch (error) {
    if (
      missingTable(error, "operating_roof_jobs") ||
      missingTable(error, "operating_customers") ||
      missingTable(error, "operating_properties")
    ) {
      return null;
    }
    throw error;
  }
}

export async function readNativeCommercialJobPacket(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  requestedLimit = 20,
): Promise<NativeCommercialJobPacket | null> {
  if (!env.DB) return null;
  const limit = boundedLimit(requestedLimit, 1, 50);
  try {
    const [quotes, proposals, publications, acceptances] = await Promise.all([
      boundedRows<CommercialQuoteRecord>(
        env,
        `SELECT *
           FROM commercial_quote_revisions
          WHERE tenant_id = ? AND roof_job_id = ?
          ORDER BY created_at DESC, revision_number DESC, quote_revision_id ASC`,
        tenantId,
        roofJobId,
        limit,
      ),
      boundedRows<CommercialProposalRecord>(
        env,
        `SELECT *
           FROM commercial_proposal_revisions
          WHERE tenant_id = ? AND roof_job_id = ?
          ORDER BY created_at DESC, revision_number DESC, proposal_revision_id ASC`,
        tenantId,
        roofJobId,
        limit,
      ),
      boundedRows<CommercialPublicationRecord>(
        env,
        `SELECT publication.*
           FROM commercial_proposal_publication_events AS publication
           JOIN commercial_proposal_revisions AS proposal
             ON proposal.tenant_id = publication.tenant_id
            AND proposal.proposal_revision_id = publication.proposal_revision_id
          WHERE publication.tenant_id = ? AND proposal.roof_job_id = ?
          ORDER BY publication.occurred_at DESC, publication.publication_version DESC, publication.publication_event_id ASC`,
        tenantId,
        roofJobId,
        limit,
      ),
      boundedRows<CommercialAcceptanceBindingRecord>(
        env,
        `SELECT *
           FROM commercial_acceptance_bindings
          WHERE tenant_id = ? AND roof_job_id = ?
          ORDER BY accepted_at DESC, acceptance_binding_id ASC`,
        tenantId,
        roofJobId,
        limit,
      ),
    ]);
    return {
      quotes: quotes.rows,
      proposals: proposals.rows,
      publications: publications.rows,
      acceptances: acceptances.rows,
      partial_sources: [
        ...(quotes.partial ? ["commercial_quote_revisions"] : []),
        ...(proposals.partial ? ["commercial_proposal_revisions"] : []),
        ...(publications.partial
          ? ["commercial_proposal_publication_events"]
          : []),
        ...(acceptances.partial ? ["commercial_acceptance_bindings"] : []),
      ],
    };
  } catch (error) {
    if (
      missingTable(error, "commercial_quote_revisions") ||
      missingTable(error, "commercial_proposal_revisions") ||
      missingTable(error, "commercial_proposal_publication_events") ||
      missingTable(error, "commercial_acceptance_bindings")
    ) {
      return null;
    }
    throw error;
  }
}

async function boundedRows<T>(
  env: AppEnv,
  sql: string,
  tenantId: string,
  roofJobId: string,
  limit: number,
): Promise<{ rows: T[]; partial: boolean }> {
  const result = await env.DB.prepare(`${sql} LIMIT ?`)
    .bind(tenantId, roofJobId, limit + 1)
    .all<T>();
  const rows = result.results ?? [];
  return {
    rows: rows.slice(0, limit),
    partial: rows.length > limit,
  };
}

async function firstRow<T>(
  env: AppEnv,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  const statement = env.DB.prepare(sql).bind(...args) as {
    first?: <U>() => Promise<U | null>;
    all?: <U>() => Promise<{ results?: U[] }>;
  };
  if (typeof statement.first === "function") {
    return await statement.first<T>();
  }
  if (typeof statement.all === "function") {
    const result = await statement.all<T>();
    return result.results?.[0] ?? null;
  }
  return null;
}

function boundedLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function missingTable(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return new RegExp(`no such table: ${table}`, "i").test(message);
}
