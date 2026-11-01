// The canonical objects' read models for the AI team (AI-TEAM-CONTRACT.md "Canonical objects").
// Each reads the rows its role screen reads, reusing that screen's reader where one exists, and
// each view names the role-screen permission that shows it. Values are exact: money in integer
// minor units with its currency (or the source's own exact integer column), quantities as scaled
// integers, ids as stored. Contact values (phone, email), payee details, provider payloads and
// free-text notes are left out. Names and references typed at intake (a display name, a lead's
// contact name, a job reference) are kept as identity fields, as the role screens show them.
//
// Not registered, because D1 holds no such object yet: supplier and conversation. A citation of
// one cannot be read and abstains `citation_unverifiable`.

import type { AppEnv } from "../app-types.ts";
import { readCommercialJobPhase } from "../commercial-job-phase.ts";
import { readTenantDepositPolicy } from "../deposit-policy.ts";
import { readEstimatorEvidenceHead } from "../estimator-native-store.ts";
import { getInventoryPosition } from "../inventory-control.ts";
import { listCurrentJobMeasurements } from "../measurement-intake-store.ts";
import { canonicalJson, sha256Hex } from "../newo-hash.ts";
import type { ObjectModel, ObjectRead } from "./memory.ts";
import type { AgentDb } from "./store.ts";
import { delegationRecord } from "./shadow.ts";
import { leadProposal, openLeadProposals } from "./lead-proposals.ts";

/** The role-screen readers take the Worker environment; they read only its D1 binding. */
const envOf = (db: AgentDb) => ({ DB: db }) as unknown as AppEnv;

const LINKED_JOBS = 8;
const MONEY_OBSERVATIONS = 10;

async function rows<T>(db: AgentDb, sql: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results ?? [];
}

const jobLinks = (ids: Array<{ roof_job_id: string }>) => ids.map((row) => ({ kind: "job", id: row.roof_job_id }));

function withoutKey<T extends Record<string, unknown>>(value: T, key: string): Omit<T, typeof key> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

/** `"9860.00"` (the accounting tables' exact two-place text) as 986000 minor units; null when not exact. */
export function minorUnits(text: string | null): number | null {
  if (text === null) return null;
  const match = /^(-?)(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(text);
  if (!match) return null;
  const minor = Number(match[2]) * 100 + Number(match[3]);
  if (!Number.isSafeInteger(minor)) return null;
  return match[1] === "-" ? -minor : minor;
}

/** Consent records without the contact value they were captured for. */
async function consents(db: AgentDb, tenantId: string, column: "customer_id" | "lead_id", id: string) {
  return await rows(
    db,
    `SELECT consent_id, roof_job_id, channel, purpose, status, jurisdiction, consent_basis, recorded_at
       FROM operating_consents WHERE tenant_id = ? AND ${column} = ?
      ORDER BY recorded_at ASC, consent_id ASC`,
    tenantId,
    id,
  );
}

/** The admitted owner policy, without its reason or actor/contact identity. */
const depositPolicy: ObjectModel = {
  views: [
    { permission: "sales:read", pointers: null },
    { permission: "accounting:read", pointers: null },
  ],
  async read(db, tenantId, id) {
    // The canonical getter defaults an absent local policy; a different id is not that default.
    if (id !== tenantId) return null;
    const current = await readTenantDepositPolicy(envOf(db), tenantId);
    return {
      data: {
        policy: current.policy,
        version: current.version,
        revision_id: current.revision_id,
        set_at: current.set_at,
      },
      links: [],
    };
  },
};

const job: ObjectModel = {
  // `GET /jobs/{job}/phase` is jobs:read:any. Sales reads the offer chain its commercial-context
  // screen shows (quote, proposal, publication, acceptance); accounting reads the job's money.
  views: [
    { permission: "jobs:read:any", pointers: null },
    {
      permission: "sales:read",
      pointers: [
        "/job",
        "/facts/commercial/quote_head",
        "/facts/commercial/quote",
        "/facts/commercial/proposal",
        "/facts/commercial/publication",
        "/facts/commercial/acceptance",
        "/facts/commercial/acceptance_under_withdrawn_publication",
      ],
    },
    { permission: "accounting:read", pointers: ["/job", "/facts/accounting"] },
  ],
  async read(db, tenantId, id) {
    // The intents' currencies are read alongside the phase, so a job costs one round trip less.
    const [phase, intentCurrencies] = await Promise.all([
      readCommercialJobPhase(envOf(db), tenantId, id),
      rows<{ intent_id: string; currency: string }>(db, "SELECT intent_id, currency FROM accounting_intents WHERE tenant_id = ? AND roof_job_id = ?", tenantId, id),
    ]);
    if (!phase) return null;
    // The generation time is when the screen was drawn, not part of the job.
    const { read_model_generated_at: _drawnAt, ...data } = phase;
    // The phase shows intent amounts as two-place text; facts carry minor units and currency.
    const currencies = new Map(intentCurrencies.map((row) => [row.intent_id, row.currency]));
    const exact = (intent: Record<string, unknown>) => {
      const { total_amount, settled_amount, ...rest } = intent;
      const total = minorUnits(total_amount as string | null);
      const settled = minorUnits((settled_amount as string | null) ?? null);
      if (total === null || (settled_amount !== null && settled_amount !== undefined && settled === null)) return null;
      return { ...rest, total_minor: total, settled_minor: settled, currency: currencies.get(intent.intent_id as string) ?? null };
    };
    const accounting = data.facts.accounting;
    const deposits = accounting.deposit_intents.map(exact);
    const finals = accounting.final_invoice_intents.map(exact);
    // An amount that is not exact leaves the job's money unreadable rather than approximated; the
    // rest of the job (and every role's view of it) stays readable.
    (data.facts as Record<string, unknown>).accounting = [...deposits, ...finals].some((intent) => intent === null)
      ? { unreadable: "inexact_amount" }
      : { ...accounting, deposit_intents: deposits, final_invoice_intents: finals };
    const links: ObjectRead["links"] = [
      { kind: "customer", id: phase.job.customer_id },
      { kind: "lead", id: phase.job.lead_id },
      { kind: "roof", id: phase.job.roof_job_id },
    ];
    if (phase.job.property_id) links.splice(1, 0, { kind: "property", id: phase.job.property_id });
    links.unshift({ kind: "deposit_policy", id: tenantId });
    return { data, links };
  },
};

const customer: ObjectModel = {
  // The sales screens show consent and which contact points exist; the job screens
  // (jobs:read:any) show only who the customer is and their jobs.
  views: [
    { permission: "sales:read", pointers: null },
    { permission: "jobs:read:any", pointers: ["/identity", "/jobs"] },
  ],
  async read(db, tenantId, id) {
    const row = await db
      .prepare(
        `SELECT customer_id, display_name, lifecycle_status, version AS record_version, created_at, updated_at,
                contact_phone IS NOT NULL AS has_phone, contact_email IS NOT NULL AS has_email
           FROM operating_customers WHERE tenant_id = ? AND customer_id = ?`,
      )
      .bind(tenantId, id)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const [jobs, consented] = await Promise.all([
      rows<{ roof_job_id: string }>(
        db,
        `SELECT roof_job_id FROM operating_roof_jobs WHERE tenant_id = ? AND customer_id = ?
          ORDER BY updated_at DESC, roof_job_id ASC LIMIT ${LINKED_JOBS}`,
        tenantId,
        id,
      ),
      consents(db, tenantId, "customer_id", id),
    ]);
    const { has_phone, has_email, ...identity } = row;
    return {
      data: {
        identity,
        contact: { has_phone: has_phone === 1, has_email: has_email === 1, consents: consented },
        jobs: jobs.map((entry) => entry.roof_job_id),
      },
      links: [{ kind: "deposit_policy", id: tenantId }, ...jobLinks(jobs)],
    };
  },
};

const lead: ObjectModel = {
  views: [{ permission: "sales:read", pointers: null }],
  async read(db, tenantId, id) {
    const row = await db
      .prepare(
        `SELECT lead_id, source, contact_name, job_ref, lifecycle_status, version AS record_version, created_at, updated_at,
                contact_phone IS NOT NULL AS has_phone, contact_email IS NOT NULL AS has_email
           FROM operating_leads WHERE tenant_id = ? AND lead_id = ?`,
      )
      .bind(tenantId, id)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const [jobs, consented, proposals] = await Promise.all([
      rows<{ roof_job_id: string }>(
        db,
        `SELECT roof_job_id FROM operating_roof_jobs WHERE tenant_id = ? AND lead_id = ?
          ORDER BY updated_at DESC, roof_job_id ASC LIMIT ${LINKED_JOBS}`,
        tenantId,
        id,
      ),
      consents(db, tenantId, "lead_id", id),
      // The lead's open proposals reach a run about it, so a later inbound can confirm one.
      openLeadProposals(db, tenantId, id, LINKED_PROPOSALS),
    ]);
    return {
      data: {
        ...row,
        has_phone: row.has_phone === 1,
        has_email: row.has_email === 1,
        consents: consented,
        jobs: jobs.map((entry) => entry.roof_job_id),
      },
      links: [{ kind: "deposit_policy", id: tenantId }, ...jobLinks(jobs), ...proposals.map((stepId) => ({ kind: "lead_proposal", id: stepId }))],
    };
  },
};

const LINKED_PROPOSALS = 5;

const leadProposalModel: ObjectModel = {
  // An open lead_fact.propose draft (lead-proposals.ts); a closed one reads as no fact. Its fields
  // carry customer details, so only the sales view reads it.
  views: [{ permission: "sales:read", pointers: null }],
  async read(db, tenantId, id) {
    const proposal = await leadProposal(db, tenantId, id);
    if (!proposal?.open) return null;
    const { open: _open, ...data } = proposal;
    return { data, links: [{ kind: "lead", id: proposal.lead_id }] };
  },
};

const property: ObjectModel = {
  // The address shows on the job history (jobs:read:any) and the estimator workbench
  // (estimator:read). Roof and hazard notes are free text and stay out.
  views: [
    { permission: "jobs:read:any", pointers: null },
    { permission: "estimator:read", pointers: null },
  ],
  async read(db, tenantId, id) {
    const row = await db
      .prepare(
        `SELECT property_id, address_line1, city, province, postal_code, country, service_area, structure_type,
                verification_status, version AS record_version, created_at, updated_at
           FROM operating_properties WHERE tenant_id = ? AND property_id = ?`,
      )
      .bind(tenantId, id)
      .first<Record<string, unknown>>();
    return row ? { data: row, links: [] } : null;
  },
};

const roof: ObjectModel = {
  // Keyed by the roof job: the current measurement heads, the estimator evidence head and the
  // latest design whose Facet links still stand, each by id, revision and hash. The measurements
  // themselves are `measurement/<revision>` facts. Only the estimator screens show these.
  views: [{ permission: "estimator:read", pointers: null }],
  async read(db, tenantId, id) {
    const exists = await db
      .prepare("SELECT 1 AS found FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?")
      .bind(tenantId, id)
      .first();
    if (!exists) return null;
    const env = envOf(db);
    const [measurements, head, design] = await Promise.all([
      listCurrentJobMeasurements(env, tenantId, id),
      readEstimatorEvidenceHead(env, tenantId, id),
      db
        .prepare(
          `SELECT design_revision_id, design_revision_sha256, design_sequence, design_state, decision_kind, projected_at,
                  (SELECT COUNT(*) FROM facet_v2_link_revocations revoked
                    WHERE (revoked.link_kind = 'project' AND revoked.link_id = design.external_project_link_id)
                       OR (revoked.link_kind = 'producer_identity' AND revoked.link_id = design.producer_identity_link_id)
                       OR (revoked.link_kind = 'customer_identity' AND revoked.link_id = design.external_customer_identity_link_id)) AS revocations
             FROM facet_v2_native_design_projections design
            WHERE destination_tenant_id = ? AND roof_job_id = ?
            ORDER BY design_sequence DESC, projection_id ASC LIMIT 1`,
        )
        .bind(tenantId, id)
        .first<Record<string, unknown> & { revocations: number }>(),
    ]);
    const revision = head.revision;
    return {
      data: {
        roof_job_id: id,
        measurements: measurements.map((row) => ({
          measurement_revision_id: row.measurement_revision_id,
          provider: row.provider,
          revision_number: row.revision_number,
          review_required: Boolean(row.review_required),
          created_at: row.created_at,
        })),
        estimator_evidence: {
          state: head.state,
          competing_revision_ids: head.competing_revision_ids,
          revision: revision
            ? {
                estimator_revision_id: revision.estimator_revision_id,
                revision_number: revision.revision_number,
                operating_job_version: revision.operating_job_version,
                measurement_receipt_id: revision.measurement_receipt_id,
                measurement_raw_sha256: revision.measurement_raw_sha256,
                facet_design_revision_id: revision.facet_design_revision_id ?? null,
                facet_design_revision_sha256: revision.facet_design_revision_sha256 ?? null,
                commercial_quote_revision_id: revision.commercial_quote_revision_id ?? null,
                payload_sha256: revision.payload_sha256,
                evidence_digest: revision.evidence_digest,
                created_at: revision.created_at,
              }
            : null,
        },
        // The latest design is offered only while its Facet project, producer and customer links stand.
        design: design && Number(design.revocations) === 0 ? withoutKey(design, "revocations") : null,
        design_links_revoked: design ? Number(design.revocations) > 0 : false,
      },
      links: [
        ...measurements.map((row) => ({ kind: "measurement", id: row.measurement_revision_id })),
        { kind: "job", id },
      ],
    };
  },
};

const measurement: ObjectModel = {
  // One immutable measurement revision with its verified projection. A projection that does not
  // match its stored canonical bytes and hash is not readable.
  views: [{ permission: "estimator:read", pointers: null }],
  async read(db, tenantId, id) {
    const row = await db
      .prepare(
        `SELECT measurement_revision_id, measurement_id, receipt_id, provider, roof_job_id, association_status,
                review_required, root_measurement_id, revision_number, supersedes_measurement_revision_id,
                measurement_raw_sha256, report_sha256, projection_json, projection_sha256, created_at
           FROM native_measurement_revisions WHERE tenant_id = ? AND measurement_revision_id = ?`,
      )
      .bind(tenantId, id)
      .first<Record<string, unknown> & { projection_json: string; projection_sha256: string }>();
    if (!row) return null;
    let projection: unknown;
    try {
      projection = JSON.parse(row.projection_json);
    } catch {
      return null;
    }
    if (canonicalJson(projection) !== row.projection_json || (await sha256Hex(row.projection_json)) !== row.projection_sha256) return null;
    const { projection_json: _bytes, ...header } = row;
    const links: ObjectRead["links"] = typeof row.roof_job_id === "string" ? [{ kind: "roof", id: row.roof_job_id }] : [];
    return { data: { ...header, review_required: Boolean(row.review_required), projection }, links };
  },
};

const crew: ObjectModel = {
  views: [{ permission: "production:read", pointers: null }],
  async read(db, tenantId, id) {
    const row = await db
      .prepare("SELECT crew_id, display_name, status, version AS record_version, updated_at FROM fleet_crews WHERE tenant_id = ? AND crew_id = ?")
      .bind(tenantId, id)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const members = await rows<{ active: number }>(
      db,
      `SELECT membership_id, user_id, active, version AS record_version FROM fleet_crew_members
        WHERE tenant_id = ? AND crew_id = ? ORDER BY membership_id ASC`,
      tenantId,
      id,
    );
    return { data: { ...row, members: members.map((member) => ({ ...member, active: member.active === 1 })) }, links: [] };
  },
};

const inventoryPosition: ObjectModel = {
  // The inventory screens read positions for owner, ops, production and field.
  views: [{ permission: "production:read", pointers: null }],
  async read(db, tenantId, id) {
    const position = await getInventoryPosition(envOf(db), tenantId, id);
    if (!position) return null;
    const item = await db
      .prepare(
        `SELECT item_id, item_code, item_kind, status, base_uom_id, quantity_scale, lot_controlled, valuation_method, revision
           FROM inventory_items WHERE tenant_id = ? AND item_id = ?`,
      )
      .bind(tenantId, position.item_id)
      .first<Record<string, unknown>>();
    const lot = await db
      .prepare(
        `SELECT lot_id, lot_code, lot_kind, status, supplier_ref, parent_lot_id, unit_cost_minor, currency, version AS record_version
           FROM inventory_lots WHERE tenant_id = ? AND lot_id = ?`,
      )
      .bind(tenantId, position.lot_id)
      .first<Record<string, unknown>>();
    const reservations = await rows<{ job_id: string }>(
      db,
      `SELECT reservation_id, job_id, work_package_id, reserved_quantity_scaled, issued_quantity_scaled,
              returned_quantity_scaled, uom_id, status, version AS record_version
         FROM inventory_reservations WHERE tenant_id = ? AND position_id = ?
        ORDER BY created_at ASC, reservation_id ASC`,
      tenantId,
      id,
    );
    const { tenant_id: _tenant, ...exact } = position as unknown as Record<string, unknown>;
    return {
      data: { ...exact, item: item ?? null, lot: lot ?? null, reservations },
      links: [...new Set(reservations.map((entry) => entry.job_id))].map((jobId) => ({ kind: "job", id: jobId })),
    };
  },
};

interface IntentRow {
  intent_id: string;
  kind: string;
  roof_job_id: string;
  currency: string;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  settled_amount: string | null;
  [column: string]: unknown;
}

const moneyItem: ObjectModel = {
  // The money desk (accounting:read). The derivation basis, the provider payload and the
  // QuickBooks realm stay out; amounts are minor units, and a stored amount that is not exact
  // makes the item unreadable rather than approximated.
  views: [{ permission: "accounting:read", pointers: null }],
  async read(db, tenantId, id) {
    const row = await db
      .prepare(
        `SELECT intent_id, kind, roof_job_id, currency, subtotal, tax_amount, total_amount, settled_amount, state,
                version AS record_version, provider, provider_entity_type, provider_entity_id, final_invoice_intent_id,
                compensates_intent_id, blocker_code, blocker_next_step, reason_code, error_code, derived_at,
                approved_at, provider_submitted_at, provider_reconciled_at, created_at, updated_at
           FROM accounting_intents WHERE tenant_id = ? AND intent_id = ?`,
      )
      .bind(tenantId, id)
      .first<IntentRow>();
    if (!row) return null;
    const { subtotal, tax_amount, total_amount, settled_amount, ...rest } = row;
    const amounts = {
      subtotal_minor: minorUnits(subtotal),
      tax_minor: minorUnits(tax_amount),
      total_minor: minorUnits(total_amount),
      settled_minor: minorUnits(settled_amount),
    };
    if (amounts.subtotal_minor === null || amounts.tax_minor === null || amounts.total_minor === null) return null;
    if (settled_amount !== null && amounts.settled_minor === null) return null;
    const observations = await rows(
      db,
      `SELECT observation_id, entity_type, entity_id, observed_sha256, total_amount_cents, balance_cents,
              unapplied_amount_cents, read_at
         FROM accounting_observations WHERE tenant_id = ? AND intent_id = ?
        ORDER BY observation_seq DESC LIMIT ${MONEY_OBSERVATIONS}`,
      tenantId,
      id,
    );
    return { data: { ...rest, ...amounts, observations }, links: [{ kind: "deposit_policy", id: tenantId }, { kind: "job", id: row.roof_job_id }] };
  },
};

const delegation: ObjectModel = {
  // One specialist and action's earned-autonomy record, as the owner's AI team settings read it
  // (shadow.ts delegationRecord); the id is `<specialist_id>:<action_id>`.
  views: [{ permission: "owner:read", pointers: null }],
  async read(db, tenantId, id) {
    const record = await delegationRecord(db, tenantId, id);
    return record ? { data: record, links: [] } : null;
  },
};

export const OBJECT_MODELS: Record<string, ObjectModel> = {
  deposit_policy: depositPolicy,
  job,
  customer,
  lead,
  property,
  roof,
  measurement,
  crew,
  inventory_position: inventoryPosition,
  money_item: moneyItem,
  delegation,
  lead_proposal: leadProposalModel,
};

/**
 * The objects a report run reads: every one but an open lead proposal, whose fields carry customer
 * details and so never reach text written for a wider audience (contract "Citing facts").
 */
export const REPORT_MODELS: Record<string, ObjectModel> = Object.fromEntries(
  Object.entries(OBJECT_MODELS).filter(([kind]) => kind !== "lead_proposal"),
);
