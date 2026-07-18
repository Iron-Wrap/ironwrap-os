// erpnext.ts - optional Frappe/ERPNext consumer for canonical bus envelopes.

import { isOn, isVoiceNoteUri, type EnvelopeRecord } from "./core.ts";
import type { JnResult } from "./jobnimbus.ts";
import type { NewoSessionRecord } from "./newo-store.ts";

type ErpEnv = Env & {
  ERPNEXT_ENABLED?: string;
  ERPNEXT_BASE_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
  ERPNEXT_LEAD_ENVELOPE_DOCTYPE?: string;
  /**
   * Exact Frappe User behind the dedicated Worker API pair.  Public-estimator
   * consent is an immutable business fact, so its capture actor must never be
   * inferred from untrusted browser input.
   */
  ERPNEXT_INTEGRATION_USER?: string;
  NEWO_BOOKING_MODE?: string;
};

export interface ErpNextResult {
  name: string;
  reused: boolean;
  roofingPropertyName?: string;
  roofJobName?: string;
  productionGateCount?: number;
  evidenceItemName?: string;
  instantEstimateSessionName?: string;
}

export interface ErpNextTransportSyncResult {
  name: string;
  roofJobName?: string;
}

export interface ErpNextNewoSyncResult {
  receptionSessionName: string;
  appointmentRequestName?: string;
}

export interface ErpNextNewoLinks {
  leadEnvelopeName?: string;
  roofingPropertyName?: string;
  roofJobName?: string;
}

export interface ErpNextPhotoEvidenceResult {
  names: string[];
  reused: boolean;
  fieldCheckInName?: string;
}

export interface ErpNextMeasurementResult extends ErpNextResult {
  /** Whether the supplied job number resolved to a canonical Roof Job. */
  roofJobMatched: boolean;
}

export interface ErpNextMeasurementInput {
  measurementId: string;
  /** A report can arrive before dispatch has matched it to a Roof Job. */
  jobNumber: string | null;
  reportUrl: string | null;
  reportFileUrl?: string | null;
  rawKey: string;
  parsedAt: string;
  measurements: Record<string, number>;
  /** Measurement source; defaults to RoofRuler for the legacy report path. */
  provider?: string;
  /** True when first-principles geometry verification flagged a mismatch. */
  needsReview?: boolean;
  /** metric -> in-file source ref from the geometry engine (evidence graph). */
  sourceRefs?: Record<string, string>;
}

export interface ErpNextPhotoEvidenceInput {
  submissionId: string;
  jobNumber: string;
  rawKey: string;
  capturedAt: string;
  caption: string | null;
  driveFolderUrl?: string | null;
  photos: Array<{
    index: number;
    sourceUri: string;
    fileName: string;
    driveFileUrl?: string | null;
    driveFileId?: string | null;
    error?: string | null;
  }>;
}

export interface ErpNextQuickBooksEventInput {
  realmId: string;
  type: string;
  id: string;
  operation: string;
  rawKey: string;
  eventTs: string;
}

export async function pushToErpNext(
  env: Env,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<ErpNextResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
  const p = safeJson(rec.payload_json);
  const lead = await upsertLeadEnvelope(cfg, base, doctype, rec, jn);
  const property = await upsertProperty(cfg, base, rec, p, lead.name);
  const customer = await upsertRoofingCustomer(cfg, base, rec, lead.name);
  const roofJob = await upsertRoofJob(
    cfg,
    base,
    rec,
    p,
    lead.name,
    property?.name,
    customer.name,
    jn,
  );
  const productionGateCount = await ensureInitialProductionGates(cfg, base, roofJob.name);
  const instantEstimate = await upsertInstantEstimateSession(cfg, base, rec, p, lead.name, roofJob.name);
  await mirrorPublicEstimatorConsent(
    cfg,
    base,
    rec,
    p,
    lead.name,
    roofJob.name,
    customer.name,
  );

  return {
    name: lead.name,
    reused: lead.reused,
    roofingPropertyName: property?.name,
    roofJobName: roofJob?.name,
    productionGateCount,
    ...(instantEstimate ? { instantEstimateSessionName: instantEstimate.name } : {}),
  };
}

/**
 * A public estimator checkbox alone is not operational consent.  For the
 * hardened public flow, retain the exact raw request in R2 as an Evidence
 * Item and append one channel-specific Communication Consent record.  The
 * source records are immutable; a later opt-out must supersede rather than
 * rewrite them.
 *
 * This intentionally accepts only the canonical marker set by the public
 * Worker route, never a look-alike value from another estimator integration.
 */
async function mirrorPublicEstimatorConsent(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  payload: Record<string, unknown>,
  leadEnvelopeName: string,
  roofJobName: string,
  customerName: string,
): Promise<void> {
  const consent = publicEstimatorConsent(payload);
  if (!consent) return;

  const actor = str(env.ERPNEXT_INTEGRATION_USER);
  if (!actor) throw new Error("erpnext_public_estimate_integration_user_missing");
  if (!rec.raw_key) throw new Error("erpnext_public_estimate_raw_evidence_missing");

  const raw = await env.RAW.get(rec.raw_key);
  if (!raw) throw new Error("erpnext_public_estimate_raw_evidence_unavailable");
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const evidence = await createIfMissingByField(
    env,
    base,
    "Evidence Item",
    "evidence_id",
    publicEstimateConsentEvidenceId(rec),
    {
      evidence_id: publicEstimateConsentEvidenceId(rec),
      lead_envelope: leadEnvelopeName,
      roof_job: roofJobName,
      evidence_type: "Other",
      proof_owner: actor,
      proof_slot: "Communication",
      source_system: "ironwrap-public-estimator",
      r2_key: rec.raw_key,
      content_checksum: await sha256Bytes(bytes),
      checksum_algorithm: "SHA-256",
      content_type: "application/json",
      content_length: bytes.byteLength,
      capture_actor: actor,
      captured_at: frappeDatetime(consent.recordedAt),
      // The Worker has durably stored the raw object but no human has reviewed
      // it.  Do not overstate that as Verified evidence.
      sync_state: "Uploaded",
      customer_safe: 0,
      summary: "Public instant-estimate follow-up consent source.",
    },
  );

  for (const channel of consentChannels(rec)) {
    const consentId = publicEstimateConsentId(rec, channel);
    await createIfMissingByField(
      env,
      base,
      "Communication Consent",
      "consent_id",
      consentId,
      {
        consent_id: consentId,
        customer: customerName,
        lead_envelope: leadEnvelopeName,
        roof_job: roofJobName,
        channel,
        purpose: "Estimate Follow-up",
        status: "Granted",
        jurisdiction: consent.jurisdiction,
        consent_basis: "Express",
        source_system: "ironwrap-public-estimator",
        source_reference: rec.envelope_id,
        captured_by: actor,
        captured_at: frappeDatetime(consent.recordedAt),
        effective_from: frappeDatetime(consent.recordedAt),
        proof_evidence: evidence.name,
        notes: "Captured by the public instant-estimate flow; customer follow-up only.",
      },
    );
  }
}

function publicEstimatorConsent(
  payload: Record<string, unknown>,
): { recordedAt: string; jurisdiction: string } | null {
  if (str(payload.source_detail) !== "ironwrap_public_estimator") return null;
  const publicEstimator = object(payload.public_estimator);
  if (publicEstimator === null) return null;
  const consent = object(publicEstimator.consent);
  if (consent?.contact !== true || consent.privacy !== true) return null;
  const recordedAt = str(consent.recorded_at);
  if (!recordedAt || Number.isNaN(new Date(recordedAt).getTime())) {
    throw new Error("erpnext_public_estimate_consent_timestamp_invalid");
  }
  const jurisdiction = str(publicEstimator.jurisdiction);
  if (!jurisdiction) {
    throw new Error("erpnext_public_estimate_consent_jurisdiction_missing");
  }
  return { recordedAt, jurisdiction };
}

function consentChannels(rec: EnvelopeRecord): Array<"Email" | "Phone"> {
  const channels: Array<"Email" | "Phone"> = [];
  if (str(rec.contact_email)) channels.push("Email");
  if (str(rec.contact_phone)) channels.push("Phone");
  return channels;
}

function publicEstimateConsentEvidenceId(rec: EnvelopeRecord): string {
  return `evidence:public-estimate-consent:${rec.envelope_id}`;
}

function publicEstimateConsentId(
  rec: EnvelopeRecord,
  channel: "Email" | "Phone",
): string {
  return `consent:public-estimate:${rec.envelope_id}:${channel.toLowerCase()}`;
}

/**
 * Reconcile only bridge/transport facts after JobNimbus succeeds. This deliberately avoids the
 * business triage fields, so a later queue retry cannot erase a human Triaged decision.
 */
export async function syncLeadTransportToErpNext(
  env: Env,
  rec: EnvelopeRecord,
  jn: JnResult,
): Promise<ErpNextTransportSyncResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");
  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
  const existing = await findByTerm(cfg, base, doctype, "envelope_id", rec.envelope_id);
  if (!existing) throw new Error("erpnext_lead_envelope_missing");
  await erpFetch(cfg, base, "PUT", `/api/resource/${enc(doctype)}/${enc(existing)}`, leadTransportDoc(rec, jn));
  const roofJobName = await syncRoofJobTransport(cfg, base, rec, jn);
  return { name: existing, ...(roofJobName ? { roofJobName } : {}) };
}

/**
 * Mirror the provider-neutral receptionist snapshot after its owned D1/R2 write. Transcript and
 * recording bodies are intentionally absent: the DocTypes receive only reviewed structure and
 * opaque provider/R2 pointers.
 */
export async function pushNewoSessionToErpNext(
  env: Env,
  session: NewoSessionRecord,
  links: ErpNextNewoLinks = {},
): Promise<ErpNextNewoSyncResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");
  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const reception = await upsertByField(
    cfg,
    base,
    "Reception Session",
    "session_id",
    session.session_id,
    receptionSessionDoc(session, links),
  );
  if (!session.appointment_request_id) {
    return { receptionSessionName: reception.name };
  }
  const appointmentDoc = appointmentRequestDoc(cfg, session, reception.name, links);
  const existingAppointment = await findByTerm(
    cfg,
    base,
    "Appointment Request",
    "appointment_request_id",
    session.appointment_request_id,
  );
  const appointment = existingAppointment
    ? await updateExistingAppointment(cfg, base, existingAppointment, appointmentDoc, session)
    : await createIfMissingByField(
      cfg,
      base,
      "Appointment Request",
      "appointment_request_id",
      session.appointment_request_id,
      appointmentDoc,
    );
  return {
    receptionSessionName: reception.name,
    appointmentRequestName: appointment.name,
  };
}

function receptionSessionDoc(
  session: NewoSessionRecord,
  links: ErpNextNewoLinks,
): Record<string, unknown> {
  return {
    session_id: session.session_id,
    provider: "Newo",
    provider_project_id: session.project_id ?? undefined,
    provider_agent_id: session.agent_id ?? undefined,
    provider_user_actor_id: session.user_actor_id ?? undefined,
    provider_conversation_id: session.conversation_id ?? undefined,
    channel: titleCase(session.channel),
    direction: titleCase(session.direction),
    session_status: session.status,
    outcome: session.outcome ?? undefined,
    lead_envelope: links.leadEnvelopeName ?? undefined,
    roofing_property: links.roofingPropertyName ?? undefined,
    roof_job: links.roofJobName ?? undefined,
    contact_name: session.contact_name ?? undefined,
    contact_phone: session.contact_phone ?? undefined,
    contact_email: session.contact_email ?? undefined,
    address_line1: session.address_line1 ?? undefined,
    city: session.city ?? undefined,
    province: session.province ?? undefined,
    postal_code: session.postal_code ?? undefined,
    division: session.division ?? undefined,
    service: session.service ?? undefined,
    urgency: session.urgency ?? undefined,
    handoff_status: session.handoff_status ?? undefined,
    booking_status: session.booking_status ?? undefined,
    structured_summary: session.summary ?? undefined,
    transcript_pointer: session.transcript_ref ?? undefined,
    recording_pointer: session.recording_ref ?? undefined,
    ai_disclosed: session.ai_disclosed,
    recording_disclosed: session.recording_disclosed,
    raw_key: session.raw_key,
    payload_hash: session.payload_hash,
    structured_json: session.structured_json,
    started_at: session.started_at ? frappeDatetime(session.started_at) : undefined,
    ended_at: session.ended_at ? frappeDatetime(session.ended_at) : undefined,
    duration_seconds: session.duration_seconds ?? undefined,
    provider_updated_at: frappeDatetime(session.updated_at),
  };
}

function appointmentRequestDoc(
  env: ErpEnv,
  session: NewoSessionRecord,
  receptionSessionName: string,
  links: ErpNextNewoLinks,
): Record<string, unknown> {
  const event = safeJson(session.structured_json);
  const appointment = object(event.appointment);
  const requestStatus = session.booking_status === "cancelled" ? "Cancelled" : "Pending";
  return {
    appointment_request_id: session.appointment_request_id,
    reception_session: receptionSessionName,
    lead_envelope: links.leadEnvelopeName ?? undefined,
    roof_job: links.roofJobName ?? undefined,
    request_status: requestStatus,
    booking_mode: String(env.NEWO_BOOKING_MODE) === "confirmed" ? "Confirmed" : "Request Only",
    provider: "Newo",
    provider_status: session.booking_status ?? undefined,
    contact_name: session.contact_name ?? undefined,
    contact_phone: session.contact_phone ?? undefined,
    contact_email: session.contact_email ?? undefined,
    service: session.service ?? undefined,
    division: session.division ?? undefined,
    urgency: session.urgency ?? undefined,
    preferred_windows_json: appointment ? jsonMaybe(appointment.preferred_windows) : undefined,
    timezone: appointment ? str(appointment.timezone) : undefined,
    raw_key: session.raw_key,
    payload_hash: session.payload_hash,
    requested_at: frappeDatetime(session.updated_at),
    cancelled_at: session.booking_status === "cancelled"
      ? frappeDatetime(session.updated_at)
      : undefined,
  };
}

async function updateExistingAppointment(
  env: ErpEnv,
  base: string,
  name: string,
  doc: Record<string, unknown>,
  session: NewoSessionRecord,
): Promise<ErpNextResult> {
  // Provider retries can refresh source facts, but cannot reset an operator's review/decision.
  const update: Record<string, unknown> = {
    provider_status: doc.provider_status,
    contact_name: doc.contact_name,
    contact_phone: doc.contact_phone,
    contact_email: doc.contact_email,
    service: doc.service,
    division: doc.division,
    urgency: doc.urgency,
    preferred_windows_json: doc.preferred_windows_json,
    timezone: doc.timezone,
    raw_key: doc.raw_key,
    payload_hash: doc.payload_hash,
  };
  if (session.booking_status === "cancelled") {
    update.request_status = "Cancelled";
    update.cancelled_at = doc.cancelled_at;
  }
  await erpFetch(
    env,
    base,
    "PUT",
    `/api/resource/${enc("Appointment Request")}/${enc(name)}`,
    update,
  );
  return { name, reused: true };
}

function leadTransportDoc(rec: EnvelopeRecord, jn?: JnResult): Record<string, unknown> {
  return {
    envelope_id: rec.envelope_id,
    source: rec.source,
    contact_name: rec.contact_name ?? undefined,
    contact_phone: rec.contact_phone ?? undefined,
    contact_email: rec.contact_email ?? undefined,
    job_ref: rec.job_ref ?? undefined,
    raw_key: rec.raw_key ?? undefined,
    event_ts: rec.ts,
    status: rec.status,
    intent_queue: rec.intent_queue ?? undefined,
    payload_json: rec.payload_json,
    jobnimbus_contact_id: jn?.contactId ?? rec.jn_contact_id ?? undefined,
    jobnimbus_job_id: jn?.jobId ?? rec.jn_job_id ?? undefined,
  };
}

async function upsertLeadEnvelope(
  env: ErpEnv,
  base: string,
  doctype: string,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<ErpNextResult> {
  const existing = await findByTerm(env, base, doctype, "envelope_id", rec.envelope_id);
  const transport = leadTransportDoc(rec, jn);
  if (existing) {
    await erpFetch(env, base, "PUT", `/api/resource/${enc(doctype)}/${enc(existing)}`, transport);
    return { name: existing, reused: true };
  }
  const created = await erpFetch(env, base, "POST", `/api/resource/${enc(doctype)}`, {
    ...transport,
    // This is a business lifecycle, intentionally distinct from transport `status` above.
    triage_status: "Untriaged",
  });
  const name = readName(created);
  if (!name) throw new Error(`erpnext_create_no_name:${doctype}`);
  return { name, reused: false };
}

async function upsertProperty(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  p: Record<string, unknown>,
  leadName: string,
): Promise<ErpNextResult | null> {
  const address = str(p.address ?? p.address1 ?? p.address_line1);
  const city = str(p.city);
  const postal = str(p.postal ?? p.postal_code ?? p.zip);
  if (!address && !city && !postal) return null;

  const propertyKey = ["property", address, city, postal].filter(Boolean).join(":").toLowerCase() || `property:${rec.envelope_id}`;
  // A retry must complete a missing initial record, never overwrite field corrections made after
  // the first queue attempt. Source facts remain in the immutable envelope/R2 record.
  return await createIfMissingByField(env, base, "Roofing Property", "property_key", propertyKey, {
    property_key: propertyKey,
    lead_envelope: leadName,
    address_line1: address,
    city,
    province: str(p.province ?? p.state),
    postal_code: postal,
    country: str(p.country) ?? "Canada",
    service_area: str(p.service_area),
    structure_type: str(p.structure_type),
    roof_notes: str(p.roof_notes ?? p.message),
    hazard_notes: str(p.hazard_notes),
  });
}

/**
 * A customer is an owned, tenant-local identity. Prefer a normalized contact method so a later
 * lead for the same person reuses the record; never use a display name as an identity key.
 * Source retries create missing records only, preserving any human correction to the customer.
 */
async function upsertRoofingCustomer(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  leadName: string,
): Promise<ErpNextResult> {
  const contactName = str(rec.contact_name);
  const nameParts = contactName?.split(/\s+/).filter(Boolean) ?? [];
  const [firstName, ...lastName] = nameParts;
  const id = customerId(rec);
  const displayName = contactName
    ?? str(rec.contact_email)
    ?? str(rec.contact_phone)
    ?? `Lead ${rec.envelope_id.slice(-8)}`;

  return await createIfMissingByField(env, base, "Roofing Customer", "customer_id", id, {
    customer_id: id,
    display_name: displayName,
    first_name: firstName,
    last_name: lastName.length ? lastName.join(" ") : undefined,
    phone: str(rec.contact_phone),
    email: str(rec.contact_email),
    lead_envelope: leadName,
  });
}

async function upsertRoofJob(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  p: Record<string, unknown>,
  leadName: string,
  propertyName: string | undefined,
  customerName: string,
  jn?: JnResult,
): Promise<ErpNextResult> {
  const roofJobId = stableId("job", instantEstimateProjectRef(p), rec.envelope_id);
  // `job_status` and `current_gate_state` are human-owned operational state. Queue retries may
  // create a missing initial job but must not reset an in-progress job to qualification.
  const roofJob = await createIfMissingByField(env, base, "Roof Job", "roof_job_id", roofJobId, {
    roof_job_id: roofJobId,
    brand: brand(p),
    job_number: jn?.jobNumber ?? rec.job_ref ?? undefined,
    service_type: serviceType(p),
    job_status: "Qualified",
    lead_envelope: leadName,
    roofing_property: propertyName,
    customer: customerName,
    current_gate_state: "qualification",
    qb_invoice_ref: undefined,
    jobnimbus_contact_id: jn?.contactId ?? rec.jn_contact_id ?? undefined,
    jobnimbus_job_id: jn?.jobId ?? rec.jn_job_id ?? undefined,
  });
  if (roofJob.reused) await linkRoofJobCustomerIfMissing(env, base, roofJob.name, customerName);
  return roofJob;
}

/** Fill an old, unlinked job exactly once without replacing a customer selected by an operator. */
async function linkRoofJobCustomerIfMissing(
  env: ErpEnv,
  base: string,
  roofJobName: string,
  customerName: string,
): Promise<void> {
  const current = await erpFetch(
    env,
    base,
    "GET",
    `/api/resource/${enc("Roof Job")}/${enc(roofJobName)}`,
  );
  const row = current.data;
  const currentCustomer = row && typeof row === "object"
    ? str((row as Record<string, unknown>).customer)
    : undefined;
  if (currentCustomer) return;
  await erpFetch(env, base, "PUT", `/api/resource/${enc("Roof Job")}/${enc(roofJobName)}`, {
    customer: customerName,
  });
}

async function ensureInitialProductionGates(env: ErpEnv, base: string, roofJobName: string): Promise<number> {
  for (const gate of PRODUCTION_GATES) {
    await createIfMissingByField(env, base, "Production Gate State", "gate_id", gateId(roofJobName, gate), {
      gate_id: gateId(roofJobName, gate),
      roof_job: roofJobName,
      gate,
      state: "Blocked",
      blocker_reason: `Awaiting ${gate.toLowerCase()} readiness proof.`,
    });
  }
  return PRODUCTION_GATES.length;
}

async function upsertInstantEstimateSession(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  p: Record<string, unknown>,
  leadName: string,
  roofJobName: string,
): Promise<ErpNextResult | null> {
  const low = money(p.range_low ?? p.estimate_low ?? p.low_estimate ?? p.min_price);
  const high = money(p.range_high ?? p.estimate_high ?? p.high_estimate ?? p.max_price);
  const total = money(p.estimate_total ?? p.total_estimate ?? p.totalEstimate ?? p.total);
  if (!hasInstantEstimateSignal(p, low, high, total)) return null;

  // Keep an estimator's approved/rejected review decision sticky across transport retries.
  return await createIfMissingByField(env, base, "Instant Estimate Session", "estimate_session_id", stableId("estimate", estimateProjectRef(p), rec.envelope_id), {
    estimate_session_id: stableId("estimate", estimateProjectRef(p), rec.envelope_id),
    lead_envelope: leadName,
    roof_job: roofJobName,
    source: rec.source,
    service_type: serviceType(p),
    status: "Needs Review",
    range_low: low,
    range_high: high,
    estimate_total: total,
    configurator_url: str(p.configurator_url ?? p.project_url ?? p.projectUrl ?? p.share_url ?? p.shareUrl),
    confidence: str(p.confidence ?? p.estimate_confidence),
    review_required: 1,
    assumptions: str(p.assumptions ?? p.estimate_assumptions) ?? "Non-binding range; estimator review required.",
    exclusions: str(p.exclusions ?? p.estimate_exclusions) ?? "Not a final quote, contract, material order, or payment request.",
    selected_services_json: jsonMaybe(p.selected_services ?? p.services ?? p.line_items ?? p.lineItems),
    material_choices_json: jsonMaybe(p.material_choices ?? p.materials ?? p.colors),
    payload_json: rec.payload_json,
  });
}

/** Mirror only bridge identifiers into the already-created Roof Job. */
async function syncRoofJobTransport(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  jn: JnResult,
): Promise<string | null> {
  const p = safeJson(rec.payload_json);
  const roofJobId = stableId("job", instantEstimateProjectRef(p), rec.envelope_id);
  const existing = await findByTerm(env, base, "Roof Job", "roof_job_id", roofJobId);
  if (!existing) return null;
  await erpFetch(env, base, "PUT", `/api/resource/${enc("Roof Job")}/${enc(existing)}`, {
    job_number: jn.jobNumber ?? rec.job_ref ?? undefined,
    jobnimbus_contact_id: jn.contactId,
    jobnimbus_job_id: jn.jobId ?? undefined,
  });
  return existing;
}

export async function pushMeasurementToErpNext(
  env: Env,
  input: ErpNextMeasurementInput,
): Promise<ErpNextMeasurementResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const provider = input.provider ?? "RoofRuler";
  // Unmatched intake belongs in the Control Center as a Needs Review report.  Do not issue an
  // empty-term lookup: it could bind an unrelated Roof Job and turn a recoverable exception into
  // false operational evidence.
  const roofJob = input.jobNumber
    ? await findByTerm(cfg, base, "Roof Job", "job_number", input.jobNumber)
    : null;
  const report = await upsertByField(cfg, base, "Measurement Report", "measurement_id", input.measurementId, {
    measurement_id: input.measurementId,
    roof_job: roofJob ?? undefined,
    provider,
    source_file: input.reportFileUrl ?? input.reportUrl ?? undefined,
    report_url: input.reportUrl ?? undefined,
    raw_key: input.rawKey,
    parsed_at: input.parsedAt,
    review_status: input.needsReview || !roofJob || !Object.keys(input.measurements).length
      ? "Needs Review"
      : "Parsed",
    measurements: Object.entries(input.measurements).map(([metric, value]) => ({
      metric,
      value,
      unit: measurementUnit(metric),
      confidence: input.sourceRefs?.[metric] ? "deterministic" : "parsed",
      source_ref: input.sourceRefs?.[metric] ?? input.rawKey,
      needs_review: input.needsReview ? 1 : 0,
    })),
  });
  const evidence = await upsertByField(cfg, base, "Evidence Item", "evidence_id", `evidence:${input.measurementId}`, {
    evidence_id: `evidence:${input.measurementId}`,
    roof_job: roofJob ?? undefined,
    evidence_type: "Measurement Report",
    source_system: provider,
    source_uri: input.reportFileUrl ?? input.reportUrl ?? undefined,
    r2_key: input.rawKey,
    captured_at: input.parsedAt,
    customer_safe: 1,
    summary: `Measurement report ${report.name}`,
  });
  return { ...report, evidenceItemName: evidence.name, roofJobMatched: !!roofJob };
}

export async function pushPhotoEvidenceToErpNext(
  env: Env,
  input: ErpNextPhotoEvidenceInput,
): Promise<ErpNextPhotoEvidenceResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const roofJob = await findByTerm(cfg, base, "Roof Job", "job_number", input.jobNumber);
  const names: string[] = [];
  let reused = false;
  for (const photo of input.photos) {
    const isVoice = isVoiceNoteUri(photo.sourceUri);
    const evidence = await upsertByField(cfg, base, "Evidence Item", "evidence_id", photoEvidenceId(input.submissionId, photo.index), {
      evidence_id: photoEvidenceId(input.submissionId, photo.index),
      roof_job: roofJob ?? undefined,
      evidence_type: isVoice ? "Voice Note" : "Photo",
      source_system: "Jotform",
      source_uri: photo.driveFileUrl ?? photo.sourceUri,
      r2_key: input.rawKey,
      drive_file_id: photo.driveFileId ?? undefined,
      captured_at: input.capturedAt,
      customer_safe: 0,
      summary: photoSummary(photo.index, photo.fileName, input.caption, photo.error, isVoice),
    });
    names.push(evidence.name);
    reused = reused || evidence.reused;
  }
  const checkIn = await upsertByField(cfg, base, "Field Check-in", "checkin_id", fieldCheckInId(input.submissionId), {
    checkin_id: fieldCheckInId(input.submissionId),
    roof_job: roofJob ?? undefined,
    job_number: input.jobNumber,
    source_system: "Jotform",
    submitted_at: input.capturedAt,
    status: input.photos.some((photo) => photo.error) ? "Needs Review" : "Received",
    photo_count: input.photos.length,
    evidence_ids_json: JSON.stringify(names),
    notes: input.caption ?? undefined,
    drive_folder_url: input.driveFolderUrl ?? undefined,
    raw_key: input.rawKey,
  });
  return { names, reused: reused || checkIn.reused, fieldCheckInName: checkIn.name };
}

export async function pushQuickBooksEventToErpNext(
  env: Env,
  input: ErpNextQuickBooksEventInput,
): Promise<ErpNextResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const entityType = input.type || "Other";
  const roofJob = entityType === "Invoice"
    ? await findByTerm(cfg, base, "Roof Job", "qb_invoice_ref", input.id)
    : null;
  return await upsertByField(cfg, base, "Payment Milestone", "payment_milestone_id", paymentMilestoneId(input), {
    payment_milestone_id: paymentMilestoneId(input),
    roof_job: roofJob ?? undefined,
    milestone_type: milestoneType(entityType),
    status: input.operation === "Delete" ? "Needs Review" : "Webhook Seen",
    qb_entity_type: entityType,
    qb_entity_id: input.id,
    qb_operation: input.operation,
    realm_id: input.realmId,
    event_ts: input.eventTs,
    raw_key: input.rawKey,
    notes: "QuickBooks webhook event captured. Amount/status detail requires QuickBooks OAuth read.",
  });
}

async function createIfMissingByField(
  env: ErpEnv,
  base: string,
  doctype: string,
  field: string,
  value: string,
  doc: Record<string, unknown>,
): Promise<ErpNextResult> {
  const existing = await findByTerm(env, base, doctype, field, value);
  if (existing) return { name: existing, reused: true };
  const created = await erpFetch(env, base, "POST", `/api/resource/${enc(doctype)}`, doc);
  const name = readName(created);
  if (!name) throw new Error(`erpnext_create_no_name:${doctype}`);
  return { name, reused: false };
}

async function upsertByField(
  env: ErpEnv,
  base: string,
  doctype: string,
  field: string,
  value: string,
  doc: Record<string, unknown>,
): Promise<ErpNextResult> {
  const existing = await findByTerm(env, base, doctype, field, value);
  if (existing) {
    await erpFetch(env, base, "PUT", `/api/resource/${enc(doctype)}/${enc(existing)}`, doc);
    return { name: existing, reused: true };
  }

  const created = await erpFetch(env, base, "POST", `/api/resource/${enc(doctype)}`, doc);
  const name = readName(created);
  if (!name) throw new Error(`erpnext_create_no_name:${doctype}`);
  return { name, reused: false };
}

async function findByTerm(env: ErpEnv, base: string, doctype: string, field: string, value: string): Promise<string | null> {
  const fields = encodeURIComponent(JSON.stringify(["name"]));
  const filters = encodeURIComponent(JSON.stringify([[doctype, field, "=", value]]));
  const path = `/api/resource/${enc(doctype)}?fields=${fields}&filters=${filters}&limit_page_length=1`;
  const found = await erpFetch(env, base, "GET", path);
  const rows = Array.isArray(found.data) ? found.data as Array<{ name?: unknown }> : [];
  const name = rows[0]?.name;
  return typeof name === "string" && name ? name : null;
}

async function erpFetch(
  env: ErpEnv,
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data?: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`erpnext_http_${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json() as { data?: unknown };
}

function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("erpnext_no_base_url");
  const base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error("erpnext_bad_base_url");
  return base;
}

function readName(created: { data?: unknown }): string | null {
  const data = created.data as { name?: unknown } | undefined;
  return typeof data?.name === "string" && data.name ? data.name : null;
}

function brand(p: Record<string, unknown>): string | undefined {
  const value = str(p.brand)?.toLowerCase();
  return value === "ironwrap" || value === "iroof" ? value : undefined;
}

function serviceType(p: Record<string, unknown>): string {
  const text = `${str(p.service) ?? ""} ${str(p.service_intent) ?? ""}`.toLowerCase();
  if (text.includes("metal")) return "Metal Roofing";
  if (text.includes("siding")) return "Siding";
  if (text.includes("gutter")) return "Gutters";
  if (text.includes("soffit") || text.includes("fascia")) return "Soffit/Fascia";
  if (text.includes("commercial")) return "Commercial";
  if (text.includes("roof")) return "Roofing";
  return "Other";
}

function hasInstantEstimateSignal(p: Record<string, unknown>, low?: number, high?: number, total?: number): boolean {
  return p.instant_estimate === true || str(p.estimate_type)?.toLowerCase() === "instant" || low !== undefined || high !== undefined || total !== undefined;
}

function money(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function measurementUnit(metric: string): string | undefined {
  if (metric.endsWith("_ft") || metric.includes("perimeter")) return "ft";
  if (metric.includes("sqft") || metric === "area") return "sqft";
  if (metric === "squares") return "sq";
  if (metric.includes("pitch")) return "pitch";
  if (metric.includes("factor")) return "ratio";
  return undefined;
}

function photoEvidenceId(submissionId: string, index: number): string {
  return `evidence:photo:${submissionId}:${String(index + 1).padStart(2, "0")}`;
}

function fieldCheckInId(submissionId: string): string {
  return `field:${submissionId}`;
}

function paymentMilestoneId(input: ErpNextQuickBooksEventInput): string {
  return `qb:${input.realmId || "unknown"}:${input.type || "Other"}:${input.id || "unknown"}`;
}

function milestoneType(type: string): string {
  if (type === "Invoice") return "Invoice";
  if (type === "Payment") return "Payment";
  return "Other";
}

function photoSummary(index: number, fileName: string, caption: string | null, error?: string | null, isVoice = false): string {
  return [
    `${isVoice ? "Field voice note" : "Jobsite photo"} ${index + 1}: ${fileName}`,
    caption,
    error ? `Upload issue: ${error}` : null,
  ].filter(Boolean).join(" - ");
}

function gateId(roofJobName: string, gate: string): string {
  return `${roofJobName}:${gate.toLowerCase()}`;
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function frappeDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("erpnext_public_estimate_consent_timestamp_invalid");
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function customerId(rec: EnvelopeRecord): string {
  const email = str(rec.contact_email)?.toLowerCase();
  if (email) return stableId("customer", `email:${email}`, rec.envelope_id);
  const phone = str(rec.contact_phone)?.replace(/\D/g, "");
  if (phone) return stableId("customer", `phone:${phone}`, rec.envelope_id);
  return stableId("customer", undefined, rec.envelope_id);
}

function estimateProjectRef(p: Record<string, unknown>): string | undefined {
  return str(p.estimate_project_id ?? p.project_id ?? p.projectId ?? p.configurator_project_id);
}

function instantEstimateProjectRef(p: Record<string, unknown>): string | undefined {
  if (p.instant_estimate !== true && str(p.estimate_type)?.toLowerCase() !== "instant") return undefined;
  return estimateProjectRef(p);
}

function stableId(prefix: string, value: string | undefined, fallback: string): string {
  const raw = value || fallback;
  const clean = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
  return `${prefix}:${clean || fallback}`;
}

function jsonMaybe(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    try {
      JSON.parse(v);
      return v;
    } catch {
      return JSON.stringify(v);
    }
  }
  return JSON.stringify(v);
}

const enc = encodeURIComponent;
const PRODUCTION_GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"] as const;
