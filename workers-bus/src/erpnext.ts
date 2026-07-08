// erpnext.ts - optional Frappe/ERPNext consumer for canonical bus envelopes.

import { isOn, type EnvelopeRecord } from "./core.ts";
import type { JnResult } from "./jobnimbus.ts";

type ErpEnv = Env & {
  ERPNEXT_ENABLED?: string;
  ERPNEXT_BASE_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
  ERPNEXT_LEAD_ENVELOPE_DOCTYPE?: string;
};

export interface ErpNextResult {
  name: string;
  reused: boolean;
  roofingPropertyName?: string;
  roofJobName?: string;
  productionGateCount?: number;
  evidenceItemName?: string;
}

export interface ErpNextPhotoEvidenceResult {
  names: string[];
  reused: boolean;
  fieldCheckInName?: string;
}

export interface ErpNextMeasurementInput {
  measurementId: string;
  jobNumber: string;
  reportUrl: string | null;
  reportFileUrl?: string | null;
  rawKey: string;
  parsedAt: string;
  measurements: Record<string, number>;
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
  const leadDoc = {
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

  const lead = await upsertByField(cfg, base, doctype, "envelope_id", rec.envelope_id, leadDoc);
  const property = await upsertProperty(cfg, base, rec, p, lead.name);
  const roofJob = await upsertRoofJob(cfg, base, rec, p, lead.name, property?.name, jn);
  const productionGateCount = await ensureInitialProductionGates(cfg, base, roofJob.name);

  return {
    name: lead.name,
    reused: lead.reused,
    roofingPropertyName: property?.name,
    roofJobName: roofJob?.name,
    productionGateCount,
  };
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
  return await upsertByField(env, base, "Roofing Property", "property_key", propertyKey, {
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

async function upsertRoofJob(
  env: ErpEnv,
  base: string,
  rec: EnvelopeRecord,
  p: Record<string, unknown>,
  leadName: string,
  propertyName: string | undefined,
  jn?: JnResult,
): Promise<ErpNextResult> {
  const roofJobId = `job:${rec.envelope_id}`;
  return await upsertByField(env, base, "Roof Job", "roof_job_id", roofJobId, {
    roof_job_id: roofJobId,
    brand: brand(p),
    job_number: jn?.jobNumber ?? rec.job_ref ?? undefined,
    service_type: serviceType(p),
    job_status: "Qualified",
    lead_envelope: leadName,
    roofing_property: propertyName,
    current_gate_state: "qualification",
    qb_invoice_ref: undefined,
    jobnimbus_contact_id: jn?.contactId ?? rec.jn_contact_id ?? undefined,
    jobnimbus_job_id: jn?.jobId ?? rec.jn_job_id ?? undefined,
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

export async function pushMeasurementToErpNext(
  env: Env,
  input: ErpNextMeasurementInput,
): Promise<ErpNextResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const roofJob = await findByTerm(cfg, base, "Roof Job", "job_number", input.jobNumber);
  const report = await upsertByField(cfg, base, "Measurement Report", "measurement_id", input.measurementId, {
    measurement_id: input.measurementId,
    roof_job: roofJob ?? undefined,
    provider: "RoofRuler",
    source_file: input.reportFileUrl ?? input.reportUrl ?? undefined,
    report_url: input.reportUrl ?? undefined,
    raw_key: input.rawKey,
    parsed_at: input.parsedAt,
    review_status: Object.keys(input.measurements).length ? "Parsed" : "Needs Review",
    measurements: Object.entries(input.measurements).map(([metric, value]) => ({
      metric,
      value,
      unit: measurementUnit(metric),
      confidence: "parsed",
      source_ref: input.rawKey,
      needs_review: 0,
    })),
  });
  const evidence = await upsertByField(cfg, base, "Evidence Item", "evidence_id", `evidence:${input.measurementId}`, {
    evidence_id: `evidence:${input.measurementId}`,
    roof_job: roofJob ?? undefined,
    evidence_type: "Measurement Report",
    source_system: "RoofRuler",
    source_uri: input.reportFileUrl ?? input.reportUrl ?? undefined,
    r2_key: input.rawKey,
    captured_at: input.parsedAt,
    customer_safe: 1,
    summary: `Measurement report ${report.name}`,
  });
  return { ...report, evidenceItemName: evidence.name };
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
    const evidence = await upsertByField(cfg, base, "Evidence Item", "evidence_id", photoEvidenceId(input.submissionId, photo.index), {
      evidence_id: photoEvidenceId(input.submissionId, photo.index),
      roof_job: roofJob ?? undefined,
      evidence_type: "Photo",
      source_system: "Jotform",
      source_uri: photo.driveFileUrl ?? photo.sourceUri,
      r2_key: input.rawKey,
      drive_file_id: photo.driveFileId ?? undefined,
      captured_at: input.capturedAt,
      customer_safe: 0,
      summary: photoSummary(photo.index, photo.fileName, input.caption, photo.error),
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

function photoSummary(index: number, fileName: string, caption: string | null, error?: string | null): string {
  return [
    `Jobsite photo ${index + 1}: ${fileName}`,
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const enc = encodeURIComponent;
const PRODUCTION_GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"] as const;
