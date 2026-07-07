// measurements.ts — RoofRuler/AppliCad measurement-report intake (Phase 3, spec 07).
//
// Files the report into the job's Google Drive folder (keyed by JobNimbus job number) and captures any
// structured measurements an upstream AI-Extract already produced. The deterministic → toMarkdown()
// → Mistral OCR ladder (spec 07) is a credential-gated follow-up; for now the report is filed and
// provided measurements are recorded. Raw is stored FIRST, so nothing is lost.

import { newEnvelopeId, parseBody } from "./core.ts";
import * as store from "./store.ts";
import { googleConfigured, fileToJobFolder } from "./google.ts";

const JOB_KEYS = ["job_number", "jobnumber", "job", "job_no", "jn_job", "jobnimbus_job", "job_id", "jobid"];
const REPORT_KEYS = ["report_url", "report", "pdf", "pdf_url", "document", "document_url", "file", "url"];
const MEASURE_KEYS = ["squares", "area_sqft", "area", "pitch", "predominant_pitch", "ridge_ft", "hip_ft",
  "valley_ft", "eave_ft", "rake_ft", "perimeter_ft", "facets", "waste_factor"];

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
  const jobNumber = asString(pick(raw, JOB_KEYS));
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

/** Extension for the report file from URL then content-type. Pure. */
export function reportExt(url: string, contentType: string): string {
  const fromUrl = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();
  const fromCt = (contentType.split("/")[1] ?? "").split(";")[0].toLowerCase();
  return (fromUrl || fromCt || "pdf").replace(/[^a-z0-9]/g, "") || "pdf";
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/** POST /ingest/measurement handler. Auth + body-size checked by the caller (index.ts). */
export async function handleMeasurementIngest(env: Env, rawText: string, contentType: string | null): Promise<Response> {
  const sub = parseMeasurementSubmission(parseBody(rawText, contentType));
  const id = newEnvelopeId();
  const now = new Date().toISOString();
  await store.putRaw(env, `raw/measurements/${now.slice(0, 10)}/${id}.json`, rawText, "application/json");

  if (!sub.jobNumber) {
    await store.recordAudit(env, { automation: "measurement", trigger: "roofruler", envelope_id: id,
      action: "received", result: "error", error: "no_job_number" });
    return jsonResp({ error: "no_job_number" }, 400);
  }

  const haveMeasures = Object.keys(sub.measurements).length;
  if (!googleConfigured(env) || !sub.reportUrl) {
    await store.recordAudit(env, { automation: "measurement", trigger: "roofruler", envelope_id: id,
      job_number: sub.jobNumber, target_ids: haveMeasures ? JSON.stringify(sub.measurements) : null,
      action: "received", result: "ok", error: !sub.reportUrl ? "no_report_url" : "drive_not_configured" });
    return jsonResp({ ok: true, job_number: sub.jobNumber, measurements: sub.measurements, filed: false,
      note: !sub.reportUrl ? "no report_url — measurements captured only" : "drive_not_configured — raw stored" });
  }

  let report: string | null = null, folder: string | null = null;
  try {
    const r = await fetch(sub.reportUrl);
    if (r.ok) {
      const ct = r.headers.get("content-type") ?? "application/pdf";
      const res = await fileToJobFolder(env, sub.jobNumber, "02 Measurements & Reports", [{
        name: `${sub.jobNumber}-measurement-report.${reportExt(sub.reportUrl, ct)}`,
        bytes: await r.arrayBuffer(), contentType: ct,
      }]);
      report = res.files[0]?.webUrl ?? null; folder = res.folderUrl;
    } else { log({ at: "measurement_fetch", url: sub.reportUrl, status: r.status }); }
  } catch (e) { log({ at: "measurement_fetch", url: sub.reportUrl, error: String(e) }); }

  await store.recordAudit(env, { automation: "measurement", trigger: "roofruler", envelope_id: id,
    job_number: sub.jobNumber, target_ids: report ?? folder,
    action: "filed", result: report ? "ok" : "error", error: report ? null : "report_not_filed" });
  return jsonResp({ ok: true, job_number: sub.jobNumber, measurements: sub.measurements, report, folder });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
