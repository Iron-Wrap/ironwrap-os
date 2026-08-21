import type { AppEnv } from "./app-types.ts";
import type {
  CommercialAcceptanceBindingRecord,
  CommercialLeadTriageRecord,
  CommercialProposalRecord,
  CommercialPublicationRecord,
  CommercialQuoteRecord,
} from "./commercial-store.ts";

export interface OperatingSalesLeadRecord {
  lead_id: string;
  tenant_id: string;
  source_envelope_id: string;
  source_raw_key: string | null;
  source: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  job_ref: string | null;
  lifecycle_status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OperatingSalesJobRecord {
  roof_job_id: string;
  tenant_id: string;
  lead_id: string;
  customer_id: string;
  job_number: string | null;
  service_type: string;
  job_status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OperatingSalesEstimateRecord {
  estimate_session_id: string;
  tenant_id: string;
  lead_id: string;
  roof_job_id: string;
  service_type: string;
  status: string;
  range_low_cents: number | null;
  range_high_cents: number | null;
  estimate_total_cents: number | null;
  confidence: string | null;
  review_required: number;
  assumptions: string | null;
  exclusions: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OperatingSalesConsentRecord {
  consent_id: string;
  tenant_id: string;
  lead_id: string;
  customer_id: string;
  roof_job_id: string;
  channel: string;
  purpose: string;
  status: string;
  jurisdiction: string;
  consent_basis: string;
  recorded_at: string;
  created_at: string;
}

export interface CommercialSalesSources {
  leads: OperatingSalesLeadRecord[];
  jobs: OperatingSalesJobRecord[];
  estimates: OperatingSalesEstimateRecord[];
  consents: OperatingSalesConsentRecord[];
  triageDecisions: CommercialLeadTriageRecord[];
  quotes: CommercialQuoteRecord[];
  proposals: CommercialProposalRecord[];
  publications: CommercialPublicationRecord[];
  acceptances: CommercialAcceptanceBindingRecord[];
  partialSources: string[];
}

export async function readCommercialSalesSources(
  env: AppEnv,
  tenantId: string,
  requestedLimit = 100,
): Promise<CommercialSalesSources> {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 100;
  const reads = await Promise.all([
    boundedRows<OperatingSalesLeadRecord>(
      env,
      `SELECT * FROM operating_leads
        WHERE tenant_id = ? ORDER BY updated_at DESC, version DESC, lead_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<OperatingSalesJobRecord>(
      env,
      `SELECT * FROM operating_roof_jobs
        WHERE tenant_id = ? ORDER BY updated_at DESC, version DESC, roof_job_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<OperatingSalesEstimateRecord>(
      env,
      `SELECT * FROM operating_instant_estimates
        WHERE tenant_id = ? ORDER BY updated_at DESC, version DESC, estimate_session_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<OperatingSalesConsentRecord>(
      env,
      `SELECT * FROM operating_consents
        WHERE tenant_id = ? ORDER BY recorded_at DESC, consent_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<CommercialLeadTriageRecord>(
      env,
      `SELECT * FROM commercial_lead_triage_decisions
        WHERE tenant_id = ? ORDER BY decided_at DESC, lead_version DESC, triage_decision_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<CommercialQuoteRecord>(
      env,
      `SELECT * FROM commercial_quote_revisions
        WHERE tenant_id = ? ORDER BY created_at DESC, revision_number DESC, quote_revision_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<CommercialProposalRecord>(
      env,
      `SELECT * FROM commercial_proposal_revisions
        WHERE tenant_id = ? ORDER BY created_at DESC, revision_number DESC, proposal_revision_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<CommercialPublicationRecord>(
      env,
      `SELECT * FROM commercial_proposal_publication_events
        WHERE tenant_id = ? ORDER BY occurred_at DESC, publication_event_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
    boundedRows<CommercialAcceptanceBindingRecord>(
      env,
      `SELECT * FROM commercial_acceptance_bindings
        WHERE tenant_id = ? ORDER BY accepted_at DESC, acceptance_binding_id ASC LIMIT ?`,
      tenantId,
      limit,
    ),
  ]);
  const names = [
    "operating_leads",
    "operating_roof_jobs",
    "operating_instant_estimates",
    "operating_consents",
    "commercial_lead_triage_decisions",
    "commercial_quote_revisions",
    "commercial_proposal_revisions",
    "commercial_proposal_publication_events",
    "commercial_acceptance_bindings",
  ] as const;
  const partialSources = reads.flatMap((read, index) =>
    read.partial ? [names[index]!] : [],
  );
  const [
    leadRead,
    jobRead,
    estimateRead,
    consentRead,
    triageRead,
    quoteRead,
    proposalRead,
    publicationRead,
    acceptanceRead,
  ] = reads;
  return {
    leads: leadRead.rows,
    jobs: jobRead.rows,
    estimates: estimateRead.rows,
    consents: consentRead.rows,
    triageDecisions: triageRead.rows,
    quotes: quoteRead.rows,
    proposals: proposalRead.rows,
    publications: publicationRead.rows,
    acceptances: acceptanceRead.rows,
    partialSources,
  };
}

async function boundedRows<T>(
  env: AppEnv,
  sql: string,
  tenantId: string,
  limit: number,
): Promise<{ rows: T[]; partial: boolean }> {
  const result = await env.DB.prepare(sql)
    .bind(tenantId, limit + 1)
    .all<T>();
  const rows = result.results ?? [];
  return { rows: rows.slice(0, limit), partial: rows.length > limit };
}
