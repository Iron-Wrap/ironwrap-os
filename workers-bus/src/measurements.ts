// measurements.ts — RoofRuler/AppliCad measurement-report intake (Phase 3, spec 07).
//
// Files the report into the job's Google Drive folder (keyed by JobNimbus job number) and captures any
// structured measurements an upstream AI-Extract already produced. The deterministic → toMarkdown()
// → Mistral OCR ladder (spec 07) is a credential-gated follow-up; for now the report is filed and
// provided measurements are recorded. Raw is stored FIRST, so nothing is lost.

import { parseBody } from "./core.ts";
import * as store from "./store.ts";
import { googleConfigured, fileToJobFolder } from "./google.ts";
import { pushMeasurementToErpNext } from "./erpnext.ts";
import { isAppliCadXml, parseAppliCadGeometry, type GeometryModel } from "./geometry.ts";
import { deriveRoofGraph, type RoofGraphV1 } from "./roof-graph.ts";
import {
  claimMeasurementIntakeReceipt,
  completeMeasurementIntakeReceipt,
  getMeasurementIntakeReceipt,
  listRetryableMeasurementIntakeReceipts,
  markMeasurementIntakeRetryable,
  recordMeasurementDriveFiling,
  type MeasurementIntakeIdentity,
  type MeasurementIntakeReceipt,
} from "./measurement-intake-store.ts";

const JOB_KEYS = ["job_number", "jobnumber", "job", "job_no", "jn_job", "jobnimbus_job", "job_id", "jobid"];
const REPORT_KEYS = ["report_url", "report", "pdf", "pdf_url", "document", "document_url", "file", "url"];
const MEASURE_KEYS = ["squares", "area_sqft", "area", "pitch", "predominant_pitch", "ridge_ft", "hip_ft",
  "valley_ft", "eave_ft", "rake_ft", "perimeter_ft", "facets", "waste_factor"];
const ATTACHMENT_ID_KEYS = ["report_id", "reportid", "attachment_id", "attachmentid", "file_id", "fileid"];
const ATTACHMENT_HASH_KEYS = ["attachment_sha256", "attachment_hash", "file_sha256", "file_hash", "sha256"];
const REQUEST_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,159}$/;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MEASUREMENT_LEASE_MS = 5 * 60_000;
const RETRY_AFTER_SECONDS = 15;
const MEASUREMENT_RETRY_BATCH_SIZE = 10;
const MEASUREMENT_RETRY_BASE_MS = 60_000;
const MEASUREMENT_RETRY_MAX_MS = 6 * 60 * 60_000;
const MAX_JOB_NUMBER_LENGTH = 160;
const REPORT_FETCH_TIMEOUT_MS = 20_000;

export interface MeasurementSubmission {
  jobNumber: string | null;
  reportUrl: string | null;
  measurements: Record<string, number>;
}

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(raw)) if (keys.includes(k.toLowerCase())) return raw[k];
  return undefined;
}
function asString(v: unknown): string | null {
  return (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : null;
}
function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function firstUrl(v: unknown): string | null {
  if (typeof v === "string") return v.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
  if (Array.isArray(v)) { for (const x of v) { const u = firstUrl(x); if (u) return u; } }
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return firstUrl(o.url ?? o.href ?? null); }
  return null;
}

/** Extract job number + report URL + any structured measurements. Pure. */
export function parseMeasurementSubmission(raw: Record<string, unknown>): MeasurementSubmission {
  const jobNumber = boundedJobNumber(pick(raw, JOB_KEYS));
  let reportUrl = firstUrl(pick(raw, REPORT_KEYS));
  if (!reportUrl) { // fallback: any PDF-looking URL anywhere
    for (const v of Object.values(raw)) { const u = firstUrl(v); if (u && /\.pdf(\?|$)/i.test(u)) { reportUrl = u; break; } }
  }
  const measurements: Record<string, number> = {};
  for (const k of Object.keys(raw)) {
    if (MEASURE_KEYS.includes(k.toLowerCase())) { const n = asNumber(raw[k]); if (n != null) measurements[k.toLowerCase()] = n; }
  }
  return { jobNumber, reportUrl, measurements };
}

/** Find AppliCad XML embedded in any string field, or as the raw body itself. Pure.
 * Parsed fields are checked FIRST: a JSON envelope's raw text carries the marker but
 * with escaped quotes, so only the JSON-decoded field value parses correctly. */
export function extractGeometry(rawText: string, raw: Record<string, unknown>): GeometryModel | null {
  for (const v of Object.values(raw)) {
    if (typeof v === "string" && isAppliCadXml(v)) {
      const g = parseAppliCadGeometry(v);
      if (g) return g;
    }
  }
  return isAppliCadXml(rawText) ? parseAppliCadGeometry(rawText) : null;
}

/** Extension for the report file from URL then content-type. Pure. */
export function reportExt(url: string, contentType: string): string {
  const fromUrl = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();
  const fromCt = (contentType.split("/")[1] ?? "").split(";")[0].toLowerCase();
  return (fromUrl || fromCt || "pdf").replace(/[^a-z0-9]/g, "") || "pdf";
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/**
 * Build the stable, non-secret identity for one physical report. Provider identifiers take
 * precedence over a caller retry header so a provider retry with a fresh header cannot create a
 * second canonical report. Identifiers are only ever used as hash input; receipts store neither
 * the identifier nor a signed report URL.
 */
export async function deriveMeasurementIntakeIdentity(input: {
  rawText: string;
  raw: Record<string, unknown>;
  submission: MeasurementSubmission;
  geometry: GeometryModel | null;
  requestIdempotencyKey?: string | null;
  contentType?: string | null;
}): Promise<MeasurementIntakeIdentity> {
  const payloadHash = await sha256Hex(input.rawText);
  const provider = input.geometry ? "AppliCad" : "RoofRuler";
  const headerKey = normalizeRequestIdempotencyKey(input.requestIdempotencyKey);
  const attachmentId = boundedOpaqueValue(pick(input.raw, ATTACHMENT_ID_KEYS));
  const attachmentHash = normalizedSha256(pick(input.raw, ATTACHMENT_HASH_KEYS));

  let keyStrategy: MeasurementIntakeIdentity["keyStrategy"] = "payload_hash";
  let source = payloadHash;
  if (attachmentId) {
    keyStrategy = "provider_attachment";
    source = JSON.stringify({ provider, jobNumber: input.submission.jobNumber, attachmentId });
  } else if (attachmentHash) {
    keyStrategy = "attachment_job";
    source = JSON.stringify({ provider, jobNumber: input.submission.jobNumber, attachmentHash });
  } else if (headerKey) {
    keyStrategy = "request_header";
    source = headerKey;
  }
  const idempotencyKeyHash = await sha256Hex(`measurement-intake/v1\n${keyStrategy}\n${source}`);
  return {
    receiptId: `measurement_${idempotencyKeyHash}`,
    idempotencyKeyHash,
    payloadHash,
    keyStrategy,
    measurementId: `measurement:${idempotencyKeyHash}`,
    provider,
    jobNumber: input.submission.jobNumber,
    rawKey: `raw/measurements/${payloadHash}.json`,
    contentType: normalizedContentType(input.contentType),
  };
}

/** POST /ingest/measurement handler. Auth + body-size checked by the caller (index.ts). */
export async function handleMeasurementIngest(
  env: Env,
  rawText: string,
  contentType: string | null,
  requestIdempotencyKey?: string | null,
): Promise<Response> {
  const raw = parseBody(rawText, contentType);
  const sub = parseMeasurementSubmission(raw);
  // First-principles geometry: AppliCad XML (raw or embedded) is parsed AND
  // cross-verified (lengths from coordinates, areas via Newell). Deterministic
  // values override upstream-AI-extracted keys on collision.
  const geometry = extractGeometry(rawText, raw);
  if (geometry) sub.measurements = { ...sub.measurements, ...geometry.measurements };
  const identity = await deriveMeasurementIntakeIdentity({
    rawText,
    raw,
    submission: sub,
    geometry,
    requestIdempotencyKey,
    contentType,
  });

  // Do not create a second raw object or downstream execution for a completed/intentionally
  // pending key. A different body under the same caller-provided key is an explicit conflict.
  const existing = await getMeasurementIntakeReceipt(env, identity.idempotencyKeyHash);
  if (existing) {
    if (existing.payload_hash !== identity.payloadHash) return jsonResp({ error: "measurement_idempotency_conflict" }, 409);
    if (existing.status === "matched" || existing.status === "unmatched") {
      return completedResponse(existing, undefined, true);
    }
    if (existing.status === "processing" && leaseIsActive(existing, new Date().toISOString())) {
      return processingResponse(existing);
    }
  }

  // Raw storage remains first for a fresh/takeover attempt. The key is payload-addressed, so a
  // retry writes the same forensic source rather than creating a parallel canonical execution.
  await store.putRaw(env, identity.rawKey, rawText, identity.contentType);
  const now = new Date();
  const claim = await claimMeasurementIntakeReceipt(env, {
    ...identity,
    now: now.toISOString(),
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + MEASUREMENT_LEASE_MS).toISOString(),
  });
  if (claim.kind === "conflict") return jsonResp({ error: "measurement_idempotency_conflict" }, 409);
  if (claim.kind === "completed") return completedResponse(claim.receipt, undefined, true);
  if (claim.kind === "in_progress") return processingResponse(claim.receipt);

  return await processClaimedMeasurementIntake(env, {
    receipt: claim.receipt,
    identity,
    submission: sub,
    geometry,
    parsedAt: now.toISOString(),
  });
}

async function processClaimedMeasurementIntake(
  env: Env,
  input: {
    receipt: MeasurementIntakeReceipt;
    identity: MeasurementIntakeIdentity;
    submission: MeasurementSubmission;
    geometry: GeometryModel | null;
    parsedAt: string;
  },
): Promise<Response> {
  const { receipt, identity, submission: sub, geometry, parsedAt } = input;
  const roofGraph = geometry
    ? deriveRoofGraph({
      geometry,
      rawKey: identity.rawKey,
      rawSha256: identity.payloadHash,
      provider: identity.provider,
      ingestedAt: parsedAt,
    })
    : null;
  try {
    if (!sub.jobNumber) {
      const erp = await syncMeasurementToErpNext(env, receipt, sub, identity.rawKey, parsedAt, null, geometry, roofGraph);
      await store.recordAudit(env, {
        automation: "measurement",
        trigger: identity.provider.toLowerCase(),
        envelope_id: receipt.receipt_id,
        target_ids: erp.name ?? receipt.measurement_id,
        action: "unmatched",
        result: "ok",
        error: "no_job_number",
      });
      const completed = await completeMeasurementIntakeReceipt(env, {
        receiptId: receipt.receipt_id,
        leaseToken: receipt.lease_token!,
        status: "unmatched",
        frappeMeasurementId: erp.name,
        frappeEvidenceId: erp.evidenceItemName,
        frappeError: erp.error,
        lastError: "no_job_number",
        now: new Date().toISOString(),
      });
      return completedResponse(completed, { measurements: sub.measurements, geometry: geometrySummary(geometry) });
    }

    const filing = await fileMeasurementReport(env, receipt, sub);
    if (filing.report && filing.report !== receipt.drive_report_url) {
      await recordMeasurementDriveFiling(env, {
        receiptId: receipt.receipt_id,
        leaseToken: receipt.lease_token!,
        reportUrl: filing.report,
        folderUrl: filing.folder,
        now: new Date().toISOString(),
      });
    }

    const erp = await syncMeasurementToErpNext(env, receipt, sub, identity.rawKey, parsedAt, filing.report, geometry, roofGraph);
    if (erp.error) throw new MeasurementIntakeFailure("frappe_measurement_sync_failed", erp.error);
    const unmatchedJob = erp.jobMatched === false;
    await store.recordAudit(env, {
      automation: "measurement",
      trigger: identity.provider.toLowerCase(),
      envelope_id: receipt.receipt_id,
      job_number: sub.jobNumber,
      target_ids: filing.report ?? filing.folder ?? receipt.measurement_id,
      action: unmatchedJob ? "unmatched" : filing.report ? "filed" : "received",
      result: "ok",
      error: unmatchedJob ? "roof_job_not_found" : filing.note,
    });
    const completed = await completeMeasurementIntakeReceipt(env, {
      receiptId: receipt.receipt_id,
      leaseToken: receipt.lease_token!,
      status: unmatchedJob ? "unmatched" : "matched",
      frappeMeasurementId: erp.name,
      frappeEvidenceId: erp.evidenceItemName,
      frappeError: null,
      lastError: unmatchedJob ? "roof_job_not_found" : filing.note,
      now: new Date().toISOString(),
    });
    return completedResponse(completed, {
      measurements: sub.measurements,
      report: filing.report,
      folder: filing.folder,
      geometry: geometrySummary(geometry),
    });
  } catch (error) {
    return await markClaimedMeasurementRetryable(env, receipt, error);
  }
}

class MeasurementIntakeFailure extends Error {
  readonly code: string;
  readonly frappeError: string | null;

  constructor(code: string, frappeError: string | null = null) {
    super(code);
    this.code = code;
    this.frappeError = frappeError;
  }
}

async function markClaimedMeasurementRetryable(
  env: Env,
  receipt: MeasurementIntakeReceipt,
  error: unknown,
): Promise<Response> {
  const code = measurementFailureCode(error);
  log({ at: "measurement_intake", receipt_id: receipt.receipt_id, measurement_id: receipt.measurement_id, error: code });
  try {
    await markMeasurementIntakeRetryable(env, {
      receiptId: receipt.receipt_id,
      leaseToken: receipt.lease_token!,
      error: code,
      frappeError: error instanceof MeasurementIntakeFailure ? error.frappeError : null,
      now: new Date().toISOString(),
    });
  } catch (markError) {
    // A concurrent retry won after this lease expired. It owns the final receipt state.
    log({ at: "measurement_intake_mark_retryable", receipt_id: receipt.receipt_id, error: measurementFailureCode(markError) });
  }
  return pendingMeasurementResponse(receipt);
}

/** Re-drive a small, backoff-limited set of durable intake failures from their raw R2 sources. */
export async function retryMeasurementIntakeReceipts(
  env: Env,
  now = new Date(),
  limit = MEASUREMENT_RETRY_BATCH_SIZE,
): Promise<void> {
  const candidates = await listRetryableMeasurementIntakeReceipts(
    env,
    now.toISOString(),
    Math.min(limit * 5, 100),
  );
  const due = candidates.filter((receipt) => retryDue(receipt, now)).slice(0, limit);
  // A report may be 20 MiB; bounded sequential replay prevents a cron tick from buffering a
  // large batch of report downloads and multipart Drive uploads in one Worker isolate.
  for (const candidate of due) {
    try {
      await retryMeasurementIntakeReceipt(env, candidate, now);
    } catch {
      log({ at: "measurement_intake_retry", receipt_id: candidate.receipt_id, error: "retry_candidate_failed" });
    }
  }
}

async function retryMeasurementIntakeReceipt(
  env: Env,
  candidate: MeasurementIntakeReceipt,
  now: Date,
): Promise<void> {
  const identity = identityFromReceipt(candidate);
  const claimed = await claimMeasurementIntakeReceipt(env, {
    ...identity,
    now: now.toISOString(),
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + MEASUREMENT_LEASE_MS).toISOString(),
  });
  if (claimed.kind !== "claimed") return;

  const receipt = claimed.receipt;
  try {
    const rawObject = await env.RAW.get(receipt.raw_key);
    if (!rawObject) throw new MeasurementIntakeFailure("raw_source_missing");
    const rawText = await rawObject.text();
    if (await sha256Hex(rawText) !== receipt.payload_hash) {
      throw new MeasurementIntakeFailure("raw_payload_hash_mismatch");
    }
    const raw = parseBody(rawText, receipt.content_type);
    const submission = parseMeasurementSubmission(raw);
    if (submission.jobNumber !== receipt.job_number) {
      throw new MeasurementIntakeFailure("receipt_submission_mismatch");
    }
    const geometry = extractGeometry(rawText, raw);
    if (geometry) submission.measurements = { ...submission.measurements, ...geometry.measurements };
    await processClaimedMeasurementIntake(env, {
      receipt,
      identity,
      submission,
      geometry,
      parsedAt: receipt.created_at,
    });
  } catch (error) {
    await markClaimedMeasurementRetryable(env, receipt, error);
  }
}

async function fileMeasurementReport(
  env: Env,
  receipt: MeasurementIntakeReceipt,
  sub: MeasurementSubmission,
): Promise<{ report: string | null; folder: string | null; note: string | null }> {
  if (receipt.drive_report_url) {
    return { report: receipt.drive_report_url, folder: receipt.drive_folder_url, note: null };
  }
  if (!sub.reportUrl) return { report: null, folder: null, note: "no_report_url" };
  if (!googleConfigured(env)) throw new MeasurementIntakeFailure("drive_not_configured");

  const response = await fetchSafeReport(sub.reportUrl);
  if (!response.ok) {
    await response.body?.cancel();
    throw new MeasurementIntakeFailure(`report_fetch_status_${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "application/pdf";
  const bytes = await readBoundedResponse(response, MAX_REPORT_BYTES);
  const suffix = receipt.measurement_id.slice("measurement:".length, "measurement:".length + 16);
  const batch = await fileToJobFolder(env, sub.jobNumber!, "02 Measurements & Reports", [{
    name: `${sub.jobNumber}-measurement-${suffix}.${reportExt(sub.reportUrl, contentType)}`,
    bytes,
    contentType,
    idempotencyKey: receipt.measurement_id,
  }]);
  const filed = batch.files[0];
  if (!filed?.webUrl) throw new MeasurementIntakeFailure("drive_upload_failed");
  return { report: filed.webUrl, folder: batch.folderUrl, note: null };
}

function completedResponse(
  receipt: MeasurementIntakeReceipt,
  detail?: Record<string, unknown>,
  idempotentReplay = false,
): Response {
  const unmatched = receipt.status === "unmatched";
  return jsonResp({
    ok: true,
    status: unmatched ? "unmatched_review" : "matched",
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
    measurement_id: receipt.measurement_id,
    job_number: receipt.job_number,
    report: receipt.drive_report_url,
    folder: receipt.drive_folder_url,
    erpnext_measurement_id: receipt.frappe_measurement_id,
    erpnext_evidence_id: receipt.frappe_evidence_id,
    ...(unmatched ? { note: "unmatched report queued for operator review" } : {}),
    ...detail,
  }, unmatched ? 202 : 200);
}

function processingResponse(receipt: MeasurementIntakeReceipt): Response {
  return jsonResp(
    { ok: true, status: "processing", measurement_id: receipt.measurement_id },
    202,
    { "retry-after": String(RETRY_AFTER_SECONDS) },
  );
}

function pendingMeasurementResponse(receipt: MeasurementIntakeReceipt): Response {
  return jsonResp(
    { error: "measurement_intake_pending", measurement_id: receipt.measurement_id },
    502,
    { "retry-after": String(RETRY_AFTER_SECONDS) },
  );
}

function leaseIsActive(receipt: MeasurementIntakeReceipt, now: string): boolean {
  return receipt.status === "processing" && !!receipt.lease_token && !!receipt.lease_expires_at && receipt.lease_expires_at > now;
}

function normalizeRequestIdempotencyKey(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return REQUEST_IDEMPOTENCY_KEY.test(normalized) ? normalized : null;
}

function normalizedContentType(value: string | null | undefined): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType.length <= 120 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function boundedJobNumber(value: unknown): string | null {
  const jobNumber = asString(value);
  return jobNumber && jobNumber.length <= MAX_JOB_NUMBER_LENGTH ? jobNumber : null;
}

function identityFromReceipt(receipt: MeasurementIntakeReceipt): MeasurementIntakeIdentity {
  return {
    receiptId: receipt.receipt_id,
    idempotencyKeyHash: receipt.idempotency_key_hash,
    payloadHash: receipt.payload_hash,
    keyStrategy: receipt.key_strategy,
    measurementId: receipt.measurement_id,
    provider: receipt.provider,
    jobNumber: receipt.job_number,
    rawKey: receipt.raw_key,
    contentType: receipt.content_type,
  };
}

function retryDue(receipt: MeasurementIntakeReceipt, now: Date): boolean {
  // The query has already established that this lease expired, so reclaim it without waiting for
  // a second backoff window. No active processor can still own this receipt.
  if (receipt.status === "processing") return true;
  const updatedAt = Date.parse(receipt.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  const delay = Math.min(
    MEASUREMENT_RETRY_BASE_MS * 2 ** Math.max(0, receipt.attempts - 1),
    MEASUREMENT_RETRY_MAX_MS,
  );
  return updatedAt + delay <= now.getTime();
}

function boundedOpaqueValue(value: unknown): string | null {
  const normalized = asString(value);
  return normalized && normalized.length <= 180 ? normalized : null;
}

function normalizedSha256(value: unknown): string | null {
  const normalized = boundedOpaqueValue(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPublicReportUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.includes(":")) return false;
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return true;
  const ip = octets.map(Number);
  if (ip.some((part) => part > 255)) return false;
  return !(
    ip[0] === 0 || ip[0] === 10 || ip[0] === 127 ||
    (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) ||
    (ip[0] === 169 && ip[1] === 254) ||
    (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
    (ip[0] === 192 && ip[1] === 168) ||
    (ip[0] === 198 && (ip[1] === 18 || ip[1] === 19))
  );
}

function safeReportUrl(value: string): URL {
  if (value.length > 2048) throw new MeasurementIntakeFailure("report_url_invalid");
  try {
    const url = new URL(value);
    if (!isPublicReportUrl(url)) throw new Error("not_public_https");
    return url;
  } catch {
    throw new MeasurementIntakeFailure("report_url_invalid");
  }
}

async function fetchSafeReport(initialUrl: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_FETCH_TIMEOUT_MS);
  try {
    let target = safeReportUrl(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(target.toString(), { redirect: "manual", signal: controller.signal });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3) throw new MeasurementIntakeFailure("report_redirect_invalid");
      target = safeReportUrl(new URL(location, target).toString());
    }
    throw new MeasurementIntakeFailure("report_redirect_invalid");
  } catch (error) {
    if (error instanceof MeasurementIntakeFailure) throw error;
    if (controller.signal.aborted) throw new MeasurementIntakeFailure("report_fetch_timeout");
    throw new MeasurementIntakeFailure("report_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new MeasurementIntakeFailure("report_too_large");
  }
  if (!response.body) throw new MeasurementIntakeFailure("report_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new MeasurementIntakeFailure("report_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function measurementFailureCode(error: unknown): string {
  if (error instanceof MeasurementIntakeFailure) return error.code;
  return "measurement_processing_failed";
}

function jsonResp(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}

/** Compact response summary of a geometry parse; null when no geometry present. */
function geometrySummary(g: GeometryModel | null) {
  if (!g) return null;
  return {
    facets: g.facets.length,
    lines: g.lines.length,
    points: g.points.length,
    needs_review: g.needsReview,
    failed_checks: g.checks.filter((c) => !c.ok).map((c) => `${c.check}:${c.target}`),
  };
}

async function syncMeasurementToErpNext(
  env: Env,
  receipt: MeasurementIntakeReceipt,
  sub: MeasurementSubmission,
  rawKey: string,
  parsedAt: string,
  reportFileUrl: string | null,
  geometry: GeometryModel | null,
  roofGraph: RoofGraphV1 | null,
): Promise<{ name: string | null; evidenceItemName: string | null; jobMatched: boolean | null; error: string | null }> {
  try {
    const erp = await pushMeasurementToErpNext(env, {
      measurementId: receipt.measurement_id,
      jobNumber: sub.jobNumber,
      reportUrl: sub.reportUrl,
      reportFileUrl,
      rawKey,
      parsedAt,
      measurements: sub.measurements,
      provider: geometry ? "AppliCad" : undefined,
      needsReview: Boolean(geometry?.needsReview || !sub.jobNumber || !reportFileUrl),
      sourceRefs: geometry?.sourceRefs,
      roofGraph: roofGraph ?? undefined,
    });
    if (erp) {
      await store.recordAudit(env, { automation: "erpnext_measurement", trigger: "roofruler",
        envelope_id: receipt.receipt_id, job_number: sub.jobNumber,
        target_ids: `measurement_report:${erp.name}${erp.evidenceItemName ? ",evidence_item:" + erp.evidenceItemName : ""}`,
        action: erp.reused ? "upsert_existing" : "create", result: "ok" });
    }
    return {
      name: erp?.name ?? null,
      evidenceItemName: erp?.evidenceItemName ?? null,
      jobMatched: erp?.roofJobMatched ?? null,
      error: null,
    };
  } catch {
    const error = "erpnext_measurement_failed";
    // Frappe can echo a submitted signed report URL in an error body. The audit receives the
    // stable code; Worker logs must not turn an upstream validation echo into URL disclosure.
    log({ at: "erpnext_measurement", receipt_id: receipt.receipt_id, error });
    await store.recordAudit(env, { automation: "erpnext_measurement", trigger: "roofruler",
      envelope_id: receipt.receipt_id, job_number: sub.jobNumber, action: "sync", result: "error", error });
    return { name: null, evidenceItemName: null, jobMatched: null, error };
  }
}
