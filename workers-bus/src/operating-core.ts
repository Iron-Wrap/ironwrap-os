import { trustedOfficeCapture } from "./office-lead-intake-store.ts";
import type { EnvelopeRecord } from "./core.ts";
import type { JnResult } from "./jobnimbus.ts";
import { sha256Hex } from "./newo-hash.ts";

type OperatingEnv = Env & {
  APP_TENANT_ID?: string;
  OPERATING_AUTOMATION_USER?: string;
};

interface Row {
  [key: string]: unknown;
}

export interface OperatingCoreResult {
  tenantId: string;
  leadId: string;
  customerId: string;
  propertyId: string | null;
  roofJobId: string;
  productionGateIds: string[];
  instantEstimateId: string | null;
  consentIds: string[];
  reused: boolean;
}

const SOURCES = new Set(["website", "phone", "gbp", "ad", "referral", "manual"]);
const PRODUCTION_GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"] as const;
const MONEY_KEYS = {
  low: ["range_low", "estimate_low", "low_estimate", "min_price"],
  high: ["range_high", "estimate_high", "high_estimate", "max_price"],
  total: ["estimate_total", "total_estimate", "totalEstimate", "total"],
} as const;

/**
 * Materialize D1-owned facts from the immutable inbound envelope. All validation and conflict
 * checks happen before one D1 batch, so malformed source input cannot leave a partial operating
 * graph behind.
 */
export async function materializeOperatingCore(
  env: OperatingEnv,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<OperatingCoreResult> {
  const tenantId = tenantIdFrom(env);
  const source = cleanSource(rec.source);
  const payload = parsePayload(rec.payload_json);
  const now = validIso(rec.updated_at || rec.ts, "operating_core_timestamp_invalid");
  const occurredAt = validIso(rec.ts || rec.created_at, "operating_core_timestamp_invalid");
  const sourceRawKey = bounded(rec.raw_key, "source_raw_key", 280);
  const envelopeId = boundedRequired(rec.envelope_id, "envelope_id", 200);
  const contactPhone = normalizedPhone(rec.contact_phone);
  const contactEmail = normalizedEmail(rec.contact_email);
  if (!contactPhone && !contactEmail) throw new Error("operating_core_contact_missing");

  const association = verifiedAssociation(payload);
  const leadId = await stableId("lead", tenantId, envelopeId);
  const associatedCustomerId = bounded(association?.customer_id, "customer_id", 180);
  if (association && !associatedCustomerId) {
    throw new Error("operating_core_verified_association_customer_missing");
  }
  const customerIdentity = associatedCustomerId
    ? `association:${associatedCustomerId}`
    : contactEmail
      ? `email:${contactEmail}`
      : `phone:${contactPhone}`;
  const customerId = await stableId("customer", tenantId, customerIdentity);
  const displayName = bounded(rec.contact_name, "display_name", 160)
    ?? contactEmail
    ?? contactPhone
    ?? `Lead ${envelopeId.slice(-8)}`;

  const address = bounded(payload.address ?? payload.address1 ?? payload.address_line1, "address_line1", 240);
  const city = bounded(payload.city, "city", 120);
  const province = bounded(payload.province ?? payload.state, "province", 80);
  const postal = bounded(payload.postal ?? payload.postal_code ?? payload.zip, "postal_code", 32);
  const propertyKey = bounded(association?.property_key, "property_key", 180)
    ?? (address || city || postal
      ? `property:${[address, city, postal].filter(Boolean).join(":").toLowerCase()}`
      : null);
  const propertyId = propertyKey ? await stableId("property", tenantId, propertyKey) : null;

  const projectRef = instantEstimateProjectRef(payload);
  const roofJobIdentity = projectRef ? `project:${projectRef}` : `envelope:${envelopeId}`;
  const roofJobId = bounded(association?.roof_job_id, "roof_job_id", 180)
    ? await stableId("job", tenantId, String(association?.roof_job_id))
    : await stableId("job", tenantId, roofJobIdentity);
  const jobNumber = bounded(jn?.jobNumber ?? rec.job_ref, "job_number", 160);
  const jobNimbusContactId = bounded(jn?.contactId ?? rec.jn_contact_id, "jobnimbus_contact_id", 160);
  const jobNimbusJobId = bounded(jn?.jobId ?? rec.jn_job_id, "jobnimbus_job_id", 160);

  const moneyValues = estimateMoney(payload);
  const estimateSignal = hasInstantEstimateSignal(payload, moneyValues);
  const estimateId = estimateSignal
    ? await stableId("estimate", tenantId, projectRef ? `project:${projectRef}` : `envelope:${envelopeId}`)
    : null;
  const capturedBy = bounded(env.OPERATING_AUTOMATION_USER, "captured_by", 160) ?? "ironwrap-worker";
  const consent = await consentFacts(
    env.DB, tenantId, payload, rec, sourceRawKey, customerId, leadId, roofJobId, capturedBy, contactEmail, contactPhone,
  );

  const db = env.DB;
  if (!db) throw new Error("operating_core_db_missing");

  const existingLead = await db.prepare(
    `SELECT lead_id, tenant_id, source_envelope_id, source_raw_key FROM operating_leads
     WHERE tenant_id = ? AND lead_id = ?`,
  ).bind(tenantId, leadId).first<Row>();
  const existingCustomerRows = await findCustomers(db, tenantId, contactEmail, contactPhone);
  const associatedCustomer = associatedCustomerId
    ? await db.prepare(
      `SELECT customer_id, tenant_id, contact_email, contact_phone
       FROM operating_customers WHERE tenant_id = ? AND customer_id = ?`,
    ).bind(tenantId, customerId).first<Row>()
    : null;
  const existingCustomer = resolveCustomer(
    existingCustomerRows,
    customerId,
    contactEmail,
    contactPhone,
    Boolean(associatedCustomerId),
    associatedCustomer,
  );
  const existingProperty = propertyId
    ? await db.prepare(
      `SELECT property_id, tenant_id, property_key FROM operating_properties
       WHERE tenant_id = ? AND property_id = ?`,
    ).bind(tenantId, propertyId).first<Row>()
    : null;
  const existingJob = await db.prepare(
    `SELECT roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
            job_number, jobnimbus_contact_id, jobnimbus_job_id, version
     FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
  ).bind(tenantId, roofJobId).first<Row>();
  const existingEstimate = estimateId
    ? await db.prepare(
      `SELECT estimate_session_id, tenant_id, lead_id, roof_job_id, source_envelope_id,
              range_low_cents, range_high_cents, estimate_total_cents, service_type
       FROM operating_instant_estimates WHERE tenant_id = ? AND estimate_session_id = ?`,
    ).bind(tenantId, estimateId).first<Row>()
    : null;

  assertExistingLead(existingLead, tenantId, envelopeId, sourceRawKey);
  assertExistingProperty(existingProperty, tenantId, propertyKey);
  assertExistingJob(existingJob, tenantId, String(existingCustomer?.customer_id ?? customerId), propertyId);
  assertExistingJobNimbusTransport(existingJob, jobNimbusContactId, jobNimbusJobId);
  assertExistingEstimate(existingEstimate, tenantId, roofJobId, moneyValues, serviceType(payload));

  const currentJobNumber = existingJob?.job_number == null ? null : String(existingJob.job_number);
  const currentJobNimbusContactId = existingJob?.jobnimbus_contact_id == null
    ? null
    : String(existingJob.jobnimbus_contact_id);
  const currentJobNimbusJobId = existingJob?.jobnimbus_job_id == null
    ? null
    : String(existingJob.jobnimbus_job_id);
  const committedJobNumber = currentJobNumber ?? jobNumber;
  const committedJobNimbusContactId = currentJobNimbusContactId ?? jobNimbusContactId;
  const committedJobNimbusJobId = currentJobNimbusJobId ?? jobNimbusJobId;
  const needsTransportUpdate = !!existingJob && (
    (currentJobNumber === null && jobNumber !== null)
    || (currentJobNimbusContactId === null && jobNimbusContactId !== null)
    || (currentJobNimbusJobId === null && jobNimbusJobId !== null)
  );
  const existingJobVersion = existingJob ? Number(existingJob.version) : null;
  if (existingJob && (!Number.isSafeInteger(existingJobVersion) || existingJobVersion! < 1)) {
    throw new Error("operating_core_roof_job_version_invalid");
  }

  const customerIdToWrite = existingCustomer?.customer_id
    ? String(existingCustomer.customer_id)
    : customerId;
  // Contact lookup may reuse a customer whose deterministic identity was established from the
  // other contact method (for example, an email-first lead followed by a phone-only retry).
  // Consent rows must reference that exact bound customer, never the candidate identity that lost
  // the lookup, or the FK would either fail or point at the wrong person.
  const consentForCustomer = consent.map((fact) => ({ ...fact, customerId: customerIdToWrite }));
  const existingConsents = consentForCustomer.length
    ? await db.prepare(
      `SELECT consent_id, lead_id, customer_id, roof_job_id, source_envelope_id, channel,
              purpose, jurisdiction, consent_basis FROM operating_consents
       WHERE tenant_id = ? AND lead_id = ?`,
    ).bind(tenantId, leadId).all<Row>()
    : { results: [] as Row[] };
  assertExistingConsents(existingConsents.results ?? [], consentForCustomer);
  const createdGateIds = await Promise.all(
    PRODUCTION_GATES.map((gate) => stableId("gate", tenantId, `${roofJobId}:${gate.toLowerCase()}`)),
  );
  const estimate = estimateSignal && estimateId
    ? estimateRow(estimateId, payload, moneyValues)
    : null;
  const gateRows = PRODUCTION_GATES.map((gate, index) => ({
    gate,
    gateId: createdGateIds[index]!,
  }));
  const eventTargets = [
    ["lead", leadId],
    ["customer", customerIdToWrite],
    ...(propertyId ? [["property", propertyId] as [string, string]] : []),
    ["roof_job", roofJobId],
    ...gateRows.map(({ gateId }) => ["production_gate", gateId] as [string, string]),
    ...(estimateId ? [["instant_estimate", estimateId] as [string, string]] : []),
    ...consent.map(({ consentId }) => ["consent", consentId] as [string, string]),
  ];

  const eventRows = await Promise.all(eventTargets.map(async ([entityType, entityId]) => ({
    eventId: await stableId("event", tenantId, `${envelopeId}:${entityType}:${entityId}`),
    entityType,
    entityId,
  })));
  const auditId = await stableId("audit", tenantId, envelopeId);
  const statements = [
    db.prepare(
      `INSERT INTO operating_leads (
         lead_id, tenant_id, source_envelope_id, source_raw_key, source,
         contact_name, contact_phone, contact_email, job_ref, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id) DO NOTHING`,
    ).bind(
      leadId, tenantId, envelopeId, sourceRawKey, source,
      bounded(rec.contact_name, "contact_name", 160), contactPhone, contactEmail,
      bounded(rec.job_ref, "job_ref", 160), now, now,
    ),
    db.prepare(
      `INSERT INTO operating_customers (
         customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
         contact_phone, contact_email, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO NOTHING`,
    ).bind(customerIdToWrite, tenantId, envelopeId, sourceRawKey, displayName, contactPhone, contactEmail, now, now),
    ...(propertyId && propertyKey
      ? [db.prepare(
        `INSERT INTO operating_properties (
           property_id, tenant_id, property_key, lead_id, source_envelope_id, source_raw_key,
           address_line1, city, province, postal_code, country, service_area, structure_type,
           roof_notes, hazard_notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(property_id) DO NOTHING`,
      ).bind(
        propertyId, tenantId, propertyKey, leadId, envelopeId, sourceRawKey,
        address, city, province, postal, bounded(payload.country, "country", 80) ?? "Canada",
        bounded(payload.service_area, "service_area", 120), bounded(payload.structure_type, "structure_type", 120),
        bounded(payload.roof_notes ?? payload.message, "roof_notes", 1000), bounded(payload.hazard_notes, "hazard_notes", 1000),
        now, now,
      )]
      : []),
    db.prepare(
      `INSERT INTO operating_roof_jobs (
         roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, source_raw_key,
         brand, job_number, service_type, jobnimbus_contact_id, jobnimbus_job_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(roof_job_id) DO NOTHING`,
    ).bind(
      roofJobId, tenantId, leadId, customerIdToWrite, propertyId, envelopeId, sourceRawKey,
      normalizedBrand(payload.brand), jobNumber, serviceType(payload),
      jobNimbusContactId, jobNimbusJobId, now, now,
    ),
    ...(needsTransportUpdate ? [db.prepare(
      `UPDATE operating_roof_jobs
          SET job_number = COALESCE(job_number, ?),
              jobnimbus_contact_id = COALESCE(jobnimbus_contact_id, ?),
              jobnimbus_job_id = COALESCE(jobnimbus_job_id, ?),
              version = version + 1,
              updated_at = ?
        WHERE tenant_id = ? AND roof_job_id = ? AND version = ?`,
    ).bind(
      jobNumber, jobNimbusContactId, jobNimbusJobId, now,
      tenantId, roofJobId, existingJobVersion,
    )] : []),
    ...gateRows.map(({ gate, gateId }) => db.prepare(
      `INSERT INTO operating_production_gates (
         gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key, gate,
         owner_user, assigned_at, due_at, blocker_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gate_id) DO NOTHING`,
    ).bind(
      gateId, tenantId, roofJobId, envelopeId, sourceRawKey, gate,
      bounded(env.OPERATING_AUTOMATION_USER, "owner_user", 160) ?? "ironwrap-worker",
      assignedAt(rec), dueAt(rec), `Awaiting ${gate.toLowerCase()} readiness proof.`, now, now,
    )),
    ...(estimate ? [db.prepare(
      `INSERT INTO operating_instant_estimates (
         estimate_session_id, tenant_id, lead_id, roof_job_id, source_envelope_id, source_raw_key,
         source, service_type, status, range_low_cents, range_high_cents, estimate_total_cents,
         configurator_url, confidence, assumptions, exclusions, selected_services_json,
         material_choices_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(estimate_session_id) DO NOTHING`,
    ).bind(
      estimate.estimateSessionId, tenantId, leadId, roofJobId, envelopeId, sourceRawKey,
      source, estimate.serviceType, estimate.status, estimate.rangeLowCents, estimate.rangeHighCents,
      estimate.totalCents, estimate.configuratorUrl, estimate.confidence, estimate.assumptions,
      estimate.exclusions, estimate.selectedServicesJson, estimate.materialChoicesJson, now, now,
    )] : []),
    ...consentForCustomer.map((fact) => db.prepare(
      `INSERT INTO operating_consents (
         consent_id, tenant_id, lead_id, customer_id, roof_job_id, source_envelope_id, source_raw_key,
         channel, purpose, status, jurisdiction, consent_basis, captured_by, recorded_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(consent_id) DO NOTHING`,
    ).bind(
      fact.consentId, tenantId, leadId, customerIdToWrite, roofJobId, envelopeId, sourceRawKey,
      fact.channel, fact.purpose, fact.status, fact.jurisdiction, fact.consentBasis,
      fact.capturedBy, fact.recordedAt, now,
    )),
    ...eventRows.map(({ eventId, entityType, entityId }) => db.prepare(
      `INSERT INTO operating_core_events (
         event_id, tenant_id, source_envelope_id, source_raw_key, event_type,
         entity_type, entity_id, details_json, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, 'operating_core_materialized', ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).bind(
      eventId, tenantId, envelopeId, sourceRawKey,
      entityType, entityId, JSON.stringify({ source, entity_type: entityType, entity_id: entityId }), occurredAt, now,
    )),
    db.prepare(
      `INSERT INTO operating_core_audit (
         audit_id, tenant_id, source_envelope_id, source_raw_key, action, result,
         target_ids_json, created_at
       ) VALUES (?, ?, ?, ?, 'materialize', 'ok', ?, ?)
       ON CONFLICT(audit_id) DO NOTHING`,
    ).bind(
      auditId, tenantId, envelopeId, sourceRawKey,
      JSON.stringify(eventTargets.map(([entityType, entityId]) => `${entityType}:${entityId}`)), now,
    ),
  ];

  await db.batch(statements);
  await assertCommittedOperatingCore(
    db,
    tenantId,
    leadId,
    envelopeId,
    sourceRawKey,
    customerIdToWrite,
    contactEmail,
    contactPhone,
    propertyId,
    propertyKey,
    roofJobId,
    estimateId,
    moneyValues,
    serviceType(payload),
    consentForCustomer,
    committedJobNumber,
    committedJobNimbusContactId,
    committedJobNimbusJobId,
  );
  return {
    tenantId,
    leadId,
    customerId: customerIdToWrite,
    propertyId,
    roofJobId,
    productionGateIds: createdGateIds,
    instantEstimateId: estimateId,
    consentIds: consent.map(({ consentId }) => consentId),
    reused: !!existingLead,
  };
}

async function findCustomers(
  db: D1Database,
  tenantId: string,
  email: string | null,
  phone: string | null,
): Promise<Row[]> {
  const predicates: string[] = [];
  const args: unknown[] = [tenantId];
  if (email) { predicates.push("contact_email = ?"); args.push(email); }
  if (phone) { predicates.push("contact_phone = ?"); args.push(phone); }
  if (!predicates.length) return [];
  const result = await db.prepare(
    `SELECT customer_id, tenant_id, contact_email, contact_phone
     FROM operating_customers WHERE tenant_id = ? AND (${predicates.join(" OR ")})
     ORDER BY customer_id`,
  ).bind(...args).all<Row>();
  return result.results ?? [];
}

function resolveCustomer(
  rows: Row[],
  expectedId: string,
  email: string | null,
  phone: string | null,
  associationBound: boolean,
  exactAssociation: Row | null,
): Row | null {
  if (associationBound) {
    if (rows.some((row) => String(row.customer_id) !== expectedId)) {
      throw new Error("operating_core_customer_identity_conflict");
    }
    if (exactAssociation) return exactAssociation;
    if (rows.length) throw new Error("operating_core_customer_identity_conflict");
    return null;
  }
  if (!rows.length) return null;
  const ids = new Set(rows.map((row) => String(row.customer_id)));
  if (ids.size > 1) throw new Error("operating_core_customer_identity_conflict");
  const row = rows[0]!;
  if (String(row.customer_id) !== expectedId) {
    if (email && row.contact_email !== email && phone && row.contact_phone !== phone) {
      throw new Error("operating_core_customer_identity_conflict");
    }
  }
  return row;
}

async function assertCommittedOperatingCore(
  db: D1Database,
  tenantId: string,
  leadId: string,
  envelopeId: string,
  sourceRawKey: string | null,
  customerId: string,
  contactEmail: string | null,
  contactPhone: string | null,
  propertyId: string | null,
  propertyKey: string | null,
  roofJobId: string,
  estimateId: string | null,
  money: EstimateMoney,
  service: string,
  consent: ConsentFact[],
  jobNumber: string | null,
  jobNimbusContactId: string | null,
  jobNimbusJobId: string | null,
): Promise<void> {
  const lead = await db.prepare(
    `SELECT lead_id, tenant_id, source_envelope_id, source_raw_key
     FROM operating_leads WHERE tenant_id = ? AND lead_id = ?`,
  ).bind(tenantId, leadId).first<Row>();
  if (!lead) throw new Error("operating_core_lead_conflict");
  assertExistingLead(lead, tenantId, envelopeId, sourceRawKey);

  const customer = await db.prepare(
    `SELECT customer_id, tenant_id, source_envelope_id, source_raw_key, contact_email, contact_phone
     FROM operating_customers WHERE tenant_id = ? AND customer_id = ?`,
  ).bind(tenantId, customerId).first<Row>();
  assertCommittedCustomer(customer, tenantId, contactEmail, contactPhone);

  if (propertyId) {
    const property = await db.prepare(
      `SELECT property_id, tenant_id, property_key
       FROM operating_properties WHERE tenant_id = ? AND property_id = ?`,
    ).bind(tenantId, propertyId).first<Row>();
    if (!property) throw new Error("operating_core_property_conflict");
    assertExistingProperty(property, tenantId, propertyKey);
  }

  const job = await db.prepare(
    `SELECT roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
            job_number, jobnimbus_contact_id, jobnimbus_job_id
     FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
  ).bind(tenantId, roofJobId).first<Row>();
  if (!job) throw new Error("operating_core_roof_job_conflict");
  assertExistingJob(job, tenantId, customerId, propertyId);
  if (
    (job.job_number ?? null) !== jobNumber
    || (job.jobnimbus_contact_id ?? null) !== jobNimbusContactId
    || (job.jobnimbus_job_id ?? null) !== jobNimbusJobId
  ) throw new Error("operating_core_jobnimbus_transport_conflict");

  if (estimateId) {
    const estimate = await db.prepare(
      `SELECT estimate_session_id, tenant_id, lead_id, roof_job_id, source_envelope_id,
              range_low_cents, range_high_cents, estimate_total_cents, service_type
       FROM operating_instant_estimates WHERE tenant_id = ? AND estimate_session_id = ?`,
    ).bind(tenantId, estimateId).first<Row>();
    if (!estimate) throw new Error("operating_core_estimate_conflict");
    assertExistingEstimate(estimate, tenantId, roofJobId, money, service);
  }

  if (consent.length) {
    const committedConsents = await db.prepare(
      `SELECT consent_id, lead_id, customer_id, roof_job_id, source_envelope_id, channel,
              purpose, jurisdiction, consent_basis
       FROM operating_consents WHERE tenant_id = ? AND lead_id = ?`,
    ).bind(tenantId, leadId).all<Row>();
    assertExistingConsents(committedConsents.results ?? [], consent);
  }
}

function assertExistingLead(row: Row | null, tenantId: string, envelopeId: string, sourceRawKey: string | null): void {
  if (!row) return;
  if (
    row.tenant_id !== tenantId
    || row.source_envelope_id !== envelopeId
    || (row.source_raw_key ?? null) !== sourceRawKey
  ) {
    throw new Error("operating_core_lead_conflict");
  }
}

function assertCommittedCustomer(
  row: Row | null,
  tenantId: string,
  contactEmail: string | null,
  contactPhone: string | null,
): void {
  if (!row) throw new Error("operating_core_customer_conflict");
  // Contacts are immutable once the customer exists (identity guard). A later envelope may carry
  // a method the row lacks; only a differing known value, or none shared, is a conflict.
  const storedEmail = row.contact_email ?? null;
  const storedPhone = row.contact_phone ?? null;
  const emailKnown = contactEmail !== null && storedEmail !== null;
  const phoneKnown = contactPhone !== null && storedPhone !== null;
  if (
    row.tenant_id !== tenantId
    || (!emailKnown && !phoneKnown)
    || (emailKnown && storedEmail !== contactEmail)
    || (phoneKnown && storedPhone !== contactPhone)
  ) {
    throw new Error("operating_core_customer_conflict");
  }
}

function assertExistingProperty(row: Row | null, tenantId: string, propertyKey: string | null): void {
  if (!row) return;
  if (row.tenant_id !== tenantId || row.property_key !== propertyKey) {
    throw new Error("operating_core_property_conflict");
  }
}

function assertExistingJob(
  row: Row | null,
  tenantId: string,
  customerId: string,
  propertyId: string | null,
): void {
  if (!row) return;
  // A verified/project association can legitimately bring a later source envelope to the same
  // job. The job's original lead provenance remains immutable; only its tenant/customer/property
  // binding must agree before this retry can reuse the exact D1 job identity.
  if (
    row.tenant_id !== tenantId || row.customer_id !== customerId || (row.property_id ?? null) !== propertyId
  ) throw new Error("operating_core_roof_job_conflict");
}

function assertExistingJobNimbusTransport(
  row: Row | null,
  contactId: string | null,
  jobId: string | null,
): void {
  if (!row) return;
  if (
    (contactId !== null && row.jobnimbus_contact_id != null && row.jobnimbus_contact_id !== contactId)
    || (jobId !== null && row.jobnimbus_job_id != null && row.jobnimbus_job_id !== jobId)
  ) throw new Error("operating_core_jobnimbus_transport_conflict");
}

function assertExistingEstimate(
  row: Row | null,
  tenantId: string,
  roofJobId: string,
  money: EstimateMoney,
  service: string,
): void {
  if (!row) return;
  // Project/association identities can be reused by a later source envelope for the same job;
  // retain the estimate's original lead provenance while enforcing its exact job and facts.
  if (
    row.tenant_id !== tenantId || row.roof_job_id !== roofJobId || row.service_type !== service
    || (row.range_low_cents ?? null) !== money.lowCents
    || (row.range_high_cents ?? null) !== money.highCents
    || (row.estimate_total_cents ?? null) !== money.totalCents
  ) throw new Error("operating_core_estimate_conflict");
}

function assertExistingConsents(rows: Row[], facts: ConsentFact[]): void {
  for (const fact of facts) {
    const row = rows.find((candidate) => candidate.consent_id === fact.consentId);
    if (!row) continue;
    if (
      row.lead_id !== fact.leadId || row.customer_id !== fact.customerId || row.roof_job_id !== fact.roofJobId
      || row.source_envelope_id !== fact.sourceEnvelopeId || row.channel !== fact.channel
      || row.purpose !== fact.purpose || row.jurisdiction !== fact.jurisdiction
      || row.consent_basis !== fact.consentBasis
    ) throw new Error("operating_core_consent_conflict");
  }
}

interface EstimateMoney {
  lowCents: number | null;
  highCents: number | null;
  totalCents: number | null;
}

function estimateMoney(payload: Row): EstimateMoney {
  const lowCents = moneyField(payload, MONEY_KEYS.low, "range_low");
  const highCents = moneyField(payload, MONEY_KEYS.high, "range_high");
  const totalCents = moneyField(payload, MONEY_KEYS.total, "estimate_total");
  if (lowCents !== null && highCents !== null && lowCents > highCents) {
    throw new Error("operating_core_money_range_invalid");
  }
  return { lowCents, highCents, totalCents };
}

function moneyField(payload: Row, keys: readonly string[], label: string): number | null {
  const centsKey = keys.map((key) => `${key}_cents`).find((key) => payload[key] !== undefined && payload[key] !== null);
  const explicit = centsKey ? payload[centsKey] : undefined;
  const selectedKey = keys.find((key) => payload[key] !== undefined && payload[key] !== null);
  if (centsKey && explicit !== undefined && explicit !== null) return parseCents(explicit, centsKey);
  if (!selectedKey) return null;
  return parseDollars(payload[selectedKey], label);
}

function parseCents(value: unknown, label: string): number {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw)) throw new Error(`operating_core_money_invalid:${label}`);
  const cents = Number(raw);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`operating_core_money_invalid:${label}`);
  return cents;
}

function parseDollars(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`operating_core_money_invalid:${label}`);
    const cents = value * 100;
    if (!Number.isSafeInteger(cents)) throw new Error(`operating_core_money_invalid:${label}`);
    return cents;
  }
  if (typeof value !== "string") throw new Error(`operating_core_money_invalid:${label}`);
  const raw = value.trim().replace(/^\$/, "");
  if (!/^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(`operating_core_money_invalid:${label}`);
  }
  const normalized = raw.replaceAll(",", "");
  const [whole, fractional = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`operating_core_money_invalid:${label}`);
  return cents;
}

function hasInstantEstimateSignal(payload: Row, money: EstimateMoney): boolean {
  return payload.instant_estimate === true
    || clean(payload.estimate_type)?.toLowerCase() === "instant"
    || money.lowCents !== null || money.highCents !== null || money.totalCents !== null;
}

interface EstimateRow {
  estimateSessionId: string;
  serviceType: string;
  status: "captured" | "needs_review";
  rangeLowCents: number | null;
  rangeHighCents: number | null;
  totalCents: number | null;
  configuratorUrl: string | null;
  confidence: string | null;
  assumptions: string;
  exclusions: string;
  selectedServicesJson: string | null;
  materialChoicesJson: string | null;
}

function estimateRow(
  estimateSessionId: string,
  payload: Row,
  money: EstimateMoney,
): EstimateRow {
  const selectedServicesJson = smallJsonArray(payload.selected_services ?? payload.services ?? payload.line_items ?? payload.lineItems, "selected_services");
  const materialChoicesJson = smallJsonObject(payload.material_choices ?? payload.materials ?? payload.colors, "material_choices");
  const hasPrice = money.lowCents !== null || money.highCents !== null || money.totalCents !== null;
  return {
    estimateSessionId,
    serviceType: serviceType(payload),
    status: hasPrice ? "needs_review" : "captured",
    rangeLowCents: money.lowCents,
    rangeHighCents: money.highCents,
    totalCents: money.totalCents,
    configuratorUrl: bounded(payload.configurator_url ?? payload.project_url ?? payload.projectUrl ?? payload.share_url ?? payload.shareUrl, "configurator_url", 1000),
    confidence: bounded(payload.confidence ?? payload.estimate_confidence, "confidence", 80),
    assumptions: bounded(payload.assumptions ?? payload.estimate_assumptions, "assumptions", 2000)
      ?? "Measurement and estimator review required before pricing.",
    exclusions: bounded(payload.exclusions ?? payload.estimate_exclusions, "exclusions", 2000)
      ?? "Not a final quote, contract, material order, or payment request.",
    selectedServicesJson,
    materialChoicesJson,
  };
}

function smallJsonArray(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new Error(`operating_core_json_invalid:${label}`); }
  }
  if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some((item) => typeof item !== "string" || item.length > 200)) {
    throw new Error(`operating_core_json_invalid:${label}`);
  }
  const json = JSON.stringify(parsed);
  return json.length <= 16384 ? json : (() => { throw new Error(`operating_core_json_invalid:${label}`); })();
}

function smallJsonObject(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new Error(`operating_core_json_invalid:${label}`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`operating_core_json_invalid:${label}`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([key, item]) => (
    key.length > 120
    || (typeof item !== "string" && (typeof item !== "number" || !Number.isFinite(item))
      && typeof item !== "boolean" && !isStringArray(item))
  ))) {
    throw new Error(`operating_core_json_invalid:${label}`);
  }
  const json = JSON.stringify(Object.fromEntries(entries));
  return json.length <= 16384 ? json : (() => { throw new Error(`operating_core_json_invalid:${label}`); })();
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string" && item.length <= 200);
}

interface ConsentFact {
  consentId: string;
  leadId: string;
  customerId: string;
  roofJobId: string;
  sourceEnvelopeId: string;
  channel: "email" | "phone";
  purpose: "estimate_follow_up";
  status: "granted";
  jurisdiction: string;
  consentBasis: "express";
  capturedBy: string;
  recordedAt: string;
}

async function consentFacts(
  db: D1Database,
  tenantId: string,
  payload: Row,
  rec: EnvelopeRecord,
  sourceRawKey: string | null,
  customerId: string,
  leadId: string,
  roofJobId: string,
  capturedBy: string,
  contactEmail: string | null,
  contactPhone: string | null,
): Promise<ConsentFact[]> {
  if (payload.source_detail === "ironwrap_office_intake") {
    const capture = await trustedOfficeCapture(db, tenantId, rec);
    if (!capture) return []; // A raw marker alone confers no consent authority.
    const input = JSON.parse(capture.input_json) as Record<string, unknown>;
    if (input.email_estimate_follow_up_consent !== true) return [];
    if (!contactEmail || !sourceRawKey || !capture.consent_jurisdiction)
      throw new Error("operating_core_office_consent_incomplete");
    return [{ consentId: await stableId("consent", tenantId, `${rec.envelope_id}:email`), leadId, customerId, roofJobId,
      sourceEnvelopeId: rec.envelope_id, channel: "email", purpose: "estimate_follow_up", status: "granted",
      jurisdiction: capture.consent_jurisdiction, consentBasis: "express", capturedBy: capture.actor_user_id,
      recordedAt: capture.captured_at }];
  }
  if (payload.source_detail !== "ironwrap_public_estimator") return [];
  const estimator = asObject(payload.public_estimator);
  const consent = asObject(estimator?.consent);
  if (consent?.contact !== true || consent.privacy !== true) return [];
  if (!sourceRawKey) throw new Error("operating_core_consent_raw_missing");
  const recordedAt = validIso(consent.recorded_at, "operating_core_consent_timestamp_invalid");
  const jurisdiction = bounded(estimator?.jurisdiction, "jurisdiction", 120);
  if (!jurisdiction) throw new Error("operating_core_consent_jurisdiction_missing");
  return Promise.all(([["email", contactEmail], ["phone", contactPhone]] as const)
    .filter(([, identity]) => Boolean(identity))
    .map(async ([channel]) => ({
      consentId: await stableId("consent", tenantId, `${rec.envelope_id}:${channel}`),
      leadId,
      customerId,
      roofJobId,
      sourceEnvelopeId: rec.envelope_id,
      channel,
      purpose: "estimate_follow_up",
      status: "granted",
      jurisdiction,
      consentBasis: "express",
      capturedBy,
      recordedAt,
    })));
}

function assignedAt(rec: EnvelopeRecord): string {
  return validIso(rec.ts || rec.created_at, "operating_core_timestamp_invalid");
}

function dueAt(rec: EnvelopeRecord): string {
  const start = new Date(assignedAt(rec));
  return new Date(start.getTime() + 72 * 60 * 60 * 1000).toISOString();
}

export function tenantIdFrom(env: OperatingEnv): string {
  // Wrangler pins APP_TENANT_ID to "ironwrap" in every deployed environment. Keep the
  // legacy fallback for effect-only/unit callers that do not carry the binding, but never
  // accept an unvalidated value into tenant-scoped keys or queries.
  const tenant = clean(env.APP_TENANT_ID) ?? "ironwrap";
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tenant)) throw new Error("operating_core_tenant_invalid");
  return tenant;
}

function cleanSource(value: unknown): string {
  const source = clean(value);
  if (!source || !SOURCES.has(source)) throw new Error("operating_core_source_invalid");
  return source;
}

async function stableId(prefix: string, tenant: string, identity: string): Promise<string> {
  // Keep kind and tenant visible for D1 operations while hashing every external identity. This
  // prevents delimiter sanitization/truncation collisions and avoids putting email, phone, raw
  // keys, or provider identifiers into tenant-owned primary keys.
  const digest = await sha256Hex(`${prefix}\u0000${tenant}\u0000${identity}`);
  return `${prefix}:${tenant}:${digest}`;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bounded(value: unknown, label: string, max: number): string | null {
  const text = clean(value);
  if (text === null) return null;
  if (text.length > max) throw new Error(`operating_core_${label}_too_long`);
  return text;
}

function boundedRequired(value: unknown, label: string, max: number): string {
  const text = bounded(value, label, max);
  if (!text) throw new Error(`operating_core_${label}_missing`);
  return text;
}

function normalizedPhone(value: unknown): string | null {
  const text = clean(value);
  if (!text) return null;
  const plus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 20) throw new Error("operating_core_phone_invalid");
  return `${plus ? "+" : ""}${digits}`;
}

function normalizedEmail(value: unknown): string | null {
  const text = clean(value)?.toLowerCase() ?? null;
  if (!text) return null;
  if (text.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error("operating_core_email_invalid");
  }
  return text;
}

function validIso(value: unknown, error: string): string {
  const text = clean(value);
  if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(error);
  return new Date(text).toISOString();
}

function parsePayload(value: string): Row {
  try {
    const parsed: unknown = JSON.parse(value);
    const object = asObject(parsed);
    if (!object) throw new Error("operating_core_payload_invalid");
    return object;
  } catch (error) {
    if (error instanceof Error && error.message === "operating_core_payload_invalid") throw error;
    throw new Error("operating_core_payload_invalid");
  }
}

function asObject(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function verifiedAssociation(payload: Row): Row | null {
  const association = asObject(payload.owned_association);
  return association?.verification_status === "verified" ? association : null;
}

function instantEstimateProjectRef(payload: Row): string | null {
  if (payload.instant_estimate !== true && clean(payload.estimate_type)?.toLowerCase() !== "instant") return null;
  return bounded(payload.estimate_project_id ?? payload.project_id ?? payload.projectId ?? payload.configurator_project_id, "estimate_project_id", 180);
}

function normalizedBrand(value: unknown): "ironwrap" | "iroof" | null {
  const brand = clean(value)?.toLowerCase();
  return brand === "ironwrap" || brand === "iroof" ? brand : null;
}

function serviceType(payload: Row): string {
  const text = `${clean(payload.service) ?? ""} ${clean(payload.service_intent) ?? ""}`.toLowerCase();
  if (text.includes("metal")) return "Metal Roofing";
  if (text.includes("siding")) return "Siding";
  if (text.includes("gutter")) return "Gutters";
  if (text.includes("soffit") || text.includes("fascia")) return "Soffit/Fascia";
  if (text.includes("commercial")) return "Commercial";
  if (text.includes("roof")) return "Roofing";
  return "Other";
}
