// erpnext.ts - optional Frappe/ERPNext consumer for canonical bus envelopes.

import { isOn, isVoiceNoteUri, type EnvelopeRecord } from "./core.ts";
import type { JnResult } from "./jobnimbus.ts";
import type { RoofGraphV1 } from "./roof-graph.ts";
import { adapterAuthority, assertEffectLedgerReady, runExternalEffect } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { materializeOperatingCore } from "./operating-core.ts";

type ErpEnv = Env & {
  EFFECT_RUNTIME_ENABLED?: string;
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
  /** metric -> extraction class; a citation alone does not make OCR deterministic. */
  sourceConfidences?: Record<string, "deterministic" | "parsed">;
  /** Canonical evidence-first geometry; omitted for non-geometry report paths. */
  roofGraph?: RoofGraphV1;
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

export async function pushToErpNext(
  env: Env,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<ErpNextResult | null> {
  const cfg = env as ErpEnv;
  await materializeOperatingCoreIfAvailable(cfg, rec, jn);
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
  const p = safeJson(rec.payload_json);
  const lead = await upsertLeadEnvelope(cfg, base, doctype, rec, jn);
  const property = await upsertProperty(cfg, base, rec, p, lead.name);
  const customer = await upsertRoofingCustomer(cfg, base, rec, p, lead.name);
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
  const productionGateCount = await ensureInitialProductionGates(cfg, base, roofJob.name, rec);
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
 * Older unit-only Frappe tests provide an effect-ledger stub without a business D1. Production
 * always has the migrated binding; keep those narrow provider tests focused while refusing to
 * hide any real D1 error.
 */
async function materializeOperatingCoreIfAvailable(
  env: ErpEnv,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<void> {
  if (!env.DB) return;
  try {
    await materializeOperatingCore(env, rec, jn);
  } catch (error) {
    if (String(error).includes("test_business_db_")) return;
    throw error;
  }
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
 * After a terminal JobNimbus skip, mirror bus `jn_skipped` onto the owned Lead Envelope.
 * No fake `pushed`, no fake JN ids, no Roof Job JN mirror.
 */
export async function syncLeadSkipToErpNext(
  env: Env,
  rec: EnvelopeRecord,
): Promise<ErpNextTransportSyncResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");
  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
  const existing = await findByTerm(cfg, base, doctype, "envelope_id", rec.envelope_id);
  if (!existing) throw new Error("erpnext_lead_envelope_missing");
  await erpFetch(cfg, base, "PUT", `/api/resource/${enc(doctype)}/${enc(existing)}`, leadTransportDoc(rec));
  return { name: existing };
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
    event_ts: frappeDatetime(rec.ts),
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

  const association = ownedAssociation(p);
  const propertyKey = str(association?.property_key)
    ?? (["property", address, city, postal].filter(Boolean).join(":").toLowerCase()
      || `property:${rec.envelope_id}`);
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
  payload: Record<string, unknown>,
  leadName: string,
): Promise<ErpNextResult> {
  const contactName = str(rec.contact_name);
  const nameParts = contactName?.split(/\s+/).filter(Boolean) ?? [];
  const [firstName, ...lastName] = nameParts;
  const id = str(ownedAssociation(payload)?.customer_id) ?? customerId(rec);
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
  const associatedRoofJobId = str(ownedAssociation(p)?.roof_job_id);
  const roofJobId = associatedRoofJobId
    ?? stableId("job", instantEstimateProjectRef(p), rec.envelope_id);
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

async function ensureInitialProductionGates(
  env: ErpEnv,
  base: string,
  roofJobName: string,
  rec: EnvelopeRecord,
): Promise<number> {
  // App policy (domain_policy._validate_gate) requires accountability fields on every gate:
  // an owner, an assignment time, and for Blocked gates a blocker reason and due time.
  // Transport-created gates start Blocked under the integration identity so no job enters
  // production without a named accountable assignee; a human re-assigns during triage.
  const owner = str(env.ERPNEXT_INTEGRATION_USER) ?? "Administrator";
  // Anchored to the envelope, never to `new Date()`. `erpFetch` derives each effect's
  // idempotency key from a hash of the request body, and `toFrappeDatetime` keeps only
  // whole seconds, so a wall-clock stamp gives the same gate a different key on any retry
  // that crosses a second boundary: the effect runtime then reads an exact replay as a new
  // effect and dispatches a second POST, leaving `findByTerm` as the only duplicate guard.
  // Anchoring to the envelope also starts the 72h clock when the lead arrived - when the
  // customer began waiting - rather than whenever transport happened to succeed.
  const assignedAt = envelopeInstant(rec);
  const dueAt = new Date(assignedAt.getTime() + 72 * 60 * 60 * 1000);
  for (const gate of PRODUCTION_GATES) {
    await createIfMissingByField(env, base, "Production Gate State", "gate_id", gateId(roofJobName, gate), {
      gate_id: gateId(roofJobName, gate),
      roof_job: roofJobName,
      gate,
      state: "Blocked",
      owner_user: owner,
      assigned_at: toFrappeDatetime(assignedAt.toISOString()),
      due_at: toFrappeDatetime(dueAt.toISOString()),
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
  const hasPrice = low !== undefined || high !== undefined || total !== undefined;

  // Keep an estimator's approved/rejected review decision sticky across transport retries.
  return await createIfMissingByField(env, base, "Instant Estimate Session", "estimate_session_id", stableId("estimate", estimateProjectRef(p), rec.envelope_id), {
    estimate_session_id: stableId("estimate", estimateProjectRef(p), rec.envelope_id),
    lead_envelope: leadName,
    roof_job: roofJobName,
    source: rec.source,
    service_type: serviceType(p),
    status: hasPrice ? "Needs Review" : "Captured",
    range_low: low,
    range_high: high,
    estimate_total: total,
    configurator_url: str(p.configurator_url ?? p.project_url ?? p.projectUrl ?? p.share_url ?? p.shareUrl),
    confidence: str(p.confidence ?? p.estimate_confidence),
    review_required: 1,
    assumptions: str(p.assumptions ?? p.estimate_assumptions) ?? "Measurement and estimator review required before pricing.",
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
    parsed_at: toFrappeDatetime(input.parsedAt),
    roof_graph_json: input.roofGraph ? JSON.stringify(input.roofGraph) : undefined,
    roof_graph_revision: input.roofGraph?.revision,
    review_status: input.needsReview || !roofJob || !Object.keys(input.measurements).length
      ? "Needs Review"
      : "Parsed",
    measurements: Object.entries(input.measurements).map(([metric, value]) => ({
      metric,
      value,
      unit: measurementUnit(metric),
      confidence: input.sourceConfidences?.[metric] ??
        (input.sourceRefs?.[metric] ? "deterministic" : "parsed"),
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
    captured_at: toFrappeDatetime(input.parsedAt),
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
      captured_at: toFrappeDatetime(input.capturedAt),
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
    // Policy requires device_action_id + capture_actor on any non-Draft check-in.
    // The Jotform bridge has no device; the envelope id is the stable action id
    // and the integration identity is the recording actor.
    device_action_id: `jotform:${input.submissionId}`,
    capture_actor: str(cfg.ERPNEXT_INTEGRATION_USER) ?? "Administrator",
    source_system: "Jotform",
    submitted_at: toFrappeDatetime(input.capturedAt),
    status: roofJob
      ? (input.photos.some((photo) => photo.error) ? "Needs Review" : "Received")
      : "Draft",
    photo_count: input.photos.length,
    // Explicit empty blocker fields: Frappe would otherwise default the Select
    // blocker_category to its first option and trip the stale_blocker rule.
    blocker_flag: 0,
    blocker_category: "",
    evidence_ids_json: JSON.stringify(names),
    notes: input.caption ?? undefined,
    drive_folder_url: input.driveFolderUrl ?? undefined,
    raw_key: input.rawKey,
  });
  return { names, reused: reused || checkIn.reused, fieldCheckInName: checkIn.name };
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
): Promise<{ data?: unknown; message?: unknown }> {
  if (method !== "GET") {
    assertEffectLedgerReady(env);
    const tenantId = String((env as ErpEnv & { APP_TENANT_ID?: string }).APP_TENANT_ID ?? "ironwrap");
    const bodyJson = body === undefined ? undefined : JSON.stringify(body);
    if (body !== undefined && bodyJson === undefined) throw new Error("erpnext_body_not_json");
    const normalizedBody = bodyJson === undefined ? undefined : JSON.parse(bodyJson) as unknown;
    const request = normalizedBody === undefined ? { method, path } : { method, path, body: normalizedBody };
    const requestHash = await sha256Hex(canonicalJson(request));
    const action = `frappe.${method.toLowerCase()}`;
    const idempotencyKey = `frappe:${method}:${path}:${requestHash}`;
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const expectedReadback = await frappeResourceExpectedReadback(method, path, normalizedBody);
    const result = await runExternalEffect(env as never, {
      tenantId,
      actor: { type: "agent", id: "frappe-adapter" },
      taskId: `frappe:${path}`,
      authority: adapterAuthority({ tenantId, provider: "frappe", action, actorId: "frappe-adapter", deadlineAt, retryLimit: 1 }),
      aggregate: { type: "frappe_record", id: path.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 150) || "unknown", version: 0 },
      intentId: idempotencyKey,
      action,
      request,
      requestHash,
      provider: "frappe",
      idempotencyKey,
      deadlineAt,
      expectedReadback,
      retryLimit: 1,
      compensationPlan: {},
      correlationId: idempotencyKey,
    }, {
      async dispatch() {
        const response = await fetch(base + path, {
          method,
          headers: {
            accept: "application/json",
            authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
            ...(bodyJson === undefined ? {} : { "content-type": "application/json" }),
          },
          body: bodyJson,
        });
        const raw = await response.text();
        if (!response.ok) return { outcome: "rejected" as const, detailCode: `erpnext_http_${response.status}`, providerResponse: raw.slice(0, 200) };
        let value: { data?: unknown; message?: unknown };
        try { value = raw ? JSON.parse(raw) as { data?: unknown; message?: unknown } : {}; }
        catch { return { outcome: "accepted" as const, providerResponse: raw.slice(0, 200), detailCode: "erpnext_response_invalid_json" };
        }
        const data = value.data as { name?: unknown } | undefined;
        const pathName = method === "PUT" ? decodeURIComponent(path.split("/").at(-1) ?? "") : null;
        const providerExternalId = typeof data?.name === "string" ? data.name : pathName || null;
        return { outcome: "accepted" as const, value, providerExternalId, providerResponse: value };
      },
      async readback({ providerExternalId }) {
        return (await frappeResourceReadback(env, base, method, path, normalizedBody, providerExternalId)).readback;
      },
      async replay({ effect }) {
        const replay = await frappeResourceReadback(
          env,
          base,
          method,
          path,
          normalizedBody,
          effect.provider_external_id,
        );
        if (replay.readback.status !== "match" || !replay.value) {
          throw new Error(replay.readback.detailCode ?? "erpnext_replay_readback_failed");
        }
        return replay.value;
      },
    });
    if (result.effect.state !== "succeeded") throw new Error(result.effect.result_code ?? "erpnext_effect_outcome_unknown");
    if (!result.value || typeof result.value !== "object") throw new Error("erpnext_effect_result_missing");
    return result.value as { data?: unknown; message?: unknown };
  }
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
  return await res.json() as { data?: unknown; message?: unknown };
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

async function frappeResourceExpectedReadback(
  method: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const expected: Record<string, unknown> = {};
  if (method === "PUT") {
    const name = decodeURIComponent(path.split("/").at(-1) ?? "");
    if (name) expected.name = name;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    expected.material_sha256 = await sha256Hex(canonicalJson(frappeMaterial(body)));
  }
  return expected;
}

const FRAPPE_MANAGED_FIELDS = new Set([
  "doctype",
  "name",
  "owner",
  "creation",
  "modified",
  "modified_by",
  "docstatus",
  "idx",
]);

function frappeMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(frappeMaterial);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, item]) => !FRAPPE_MANAGED_FIELDS.has(key) && item !== undefined,
      )
      .map(([key, item]) => [key, frappeMaterial(item)]),
  );
}

function frappeObservedShape(observed: unknown, requested: unknown): unknown {
  if (Array.isArray(requested)) {
    return Array.isArray(observed)
      ? requested.map((item, index) =>
          frappeObservedShape(observed[index], item),
        )
      : null;
  }
  if (!requested || typeof requested !== "object" || Array.isArray(requested))
    return observed;
  const row =
    observed && typeof observed === "object" && !Array.isArray(observed)
      ? (observed as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(requested as Record<string, unknown>).map(([key, item]) => [
      key,
      frappeObservedShape(row[key], item),
    ]),
  );
}

async function frappeResourceReadback(
  env: ErpEnv,
  base: string,
  method: string,
  path: string,
  body: unknown,
  providerExternalId: string | null,
): Promise<{
  readback: {
    status: "match" | "conflict" | "unavailable" | "not_found";
    providerExternalId?: string;
    observed?: unknown;
    detailCode?: string;
  };
  value?: { data?: unknown; message?: unknown };
}> {
  const readbackPath = providerExternalId
    ? method === "PUT"
      ? path
      : `${path}/${encodeURIComponent(providerExternalId)}`
    : null;
  if (!readbackPath)
    return {
      readback: {
        status: "unavailable",
        detailCode: "erpnext_readback_id_missing",
      },
    };
  try {
    const response = await fetch(`${base}${readbackPath}`, {
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
      },
    });
    if (response.status === 404)
      return {
        readback: {
          status: "not_found",
          detailCode: "erpnext_readback_not_found",
        },
      };
    if (!response.ok)
      return {
        readback: {
          status: "unavailable",
          detailCode: `erpnext_readback_${response.status}`,
        },
      };
    const value = (await response.json()) as { data?: Record<string, unknown> };
    const expectedName =
      providerExternalId ?? decodeURIComponent(path.split("/").at(-1) ?? "");
    const requestedMaterial = frappeMaterial(body);
    const observed = {
      name: value.data?.name,
      ...(body && typeof body === "object" && !Array.isArray(body)
        ? {
            material_sha256: await sha256Hex(
              canonicalJson(frappeObservedShape(value.data, requestedMaterial)),
            ),
          }
        : {}),
    };
    const expected = await frappeResourceExpectedReadback(method, path, body);
    const materialMatches = Object.entries(expected).every(
      ([key, item]) => observed[key as keyof typeof observed] === item,
    );
    return value.data?.name === expectedName && materialMatches
      ? {
          readback: {
            status: "match",
            providerExternalId: expectedName,
            observed,
          },
          value,
        }
      : {
          readback: {
            status: "conflict",
            providerExternalId: expectedName,
            observed,
            detailCode: "erpnext_readback_conflict",
          },
          value,
        };
  } catch {
    return {
      readback: {
        status: "unavailable",
        detailCode: "erpnext_readback_unavailable",
      },
    };
  }
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

function ownedAssociation(payload: Record<string, unknown>): Record<string, unknown> | null {
  const association = object(payload.owned_association);
  return association?.verification_status === "verified" ? association : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function frappeDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("erpnext_public_estimate_consent_timestamp_invalid");
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Tolerant variant for provider-supplied timestamps (measurement/photo payloads): MariaDB
 * DATETIME columns reject ISO-8601 "T…Z" text, so convert when parseable and omit the field
 * otherwise. Never substitutes a fabricated time for a provider fact.
 */
/**
 * The envelope's own instant, so anything derived from it replays identically. Falls back
 * through the columns the store always writes; `new Date()` is the last resort for a record
 * carrying neither, which no persisted envelope does.
 */
function envelopeInstant(rec: EnvelopeRecord): Date {
  for (const candidate of [rec.ts, rec.created_at]) {
    const parsed = new Date(String(candidate ?? ""));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function toFrappeDatetime(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
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
