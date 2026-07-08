// photos.ts — Jotform "Jobsite Photo" intake (Phase 3, spec 02 §2B / 07).
//
// A field tech submits photos against a JobNimbus job number → raw to R2 FIRST → each photo is
// filed into that job's Google Drive folder (the file authority). Google creds are optional: with
// none, the raw submission is still stored + audited, and the photos sync once Drive is connected.

import { newEnvelopeId, parseBody } from "./core.ts";
import * as store from "./store.ts";
import { googleConfigured, fileToJobFolder } from "./google.ts";
import { pushPhotoEvidenceToErpNext } from "./erpnext.ts";

const JOB_KEYS = ["job_number", "jobnumber", "job", "job_no", "jn_job", "jobnimbus_job", "job_id", "jobid"];
const PHOTO_KEYS = ["photos", "photo", "images", "image", "files", "file", "attachments", "upload", "uploads", "audio", "voice", "voice_note", "voice_notes", "recordings"];
const CAPTION_KEYS = ["caption", "notes", "note", "description", "message", "comments", "comment", "transcript", "voice_transcript", "voice_note_text"];

export interface PhotoSubmission { jobNumber: string | null; photos: string[]; caption: string | null }
interface PhotoEvidenceRef {
  index: number;
  sourceUri: string;
  fileName: string;
  driveFileUrl?: string | null;
  driveFileId?: string | null;
  error?: string | null;
}

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(raw)) if (keys.includes(k.toLowerCase())) return raw[k];
  return undefined;
}

function urlsIn(v: unknown): string[] {
  if (typeof v === "string") return v.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  if (Array.isArray(v)) return v.flatMap(urlsIn);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string") return [o.url];
    if (typeof o.href === "string") return [o.href];
    return Object.values(o).flatMap(urlsIn);
  }
  return [];
}

/** Extract job number + photo URLs + caption from a Jotform/normalized submission. Pure. */
export function parsePhotoSubmission(raw: Record<string, unknown>): PhotoSubmission {
  const j = pick(raw, JOB_KEYS);
  const jobNumber = typeof j === "string" || typeof j === "number" ? String(j).trim() || null : null;

  let photos: string[] = [];
  for (const k of PHOTO_KEYS) { const v = pick(raw, [k]); if (v != null) photos.push(...urlsIn(v)); }
  if (photos.length === 0) { // fallback: any upload/image/voice URL anywhere in the payload
    for (const v of Object.values(raw)) {
      for (const u of urlsIn(v)) if (/\/uploads?\/|\.(jpe?g|png|heic|webp|gif|pdf|m4a|mp3|wav|ogg|amr|aac)(\?|$)/i.test(u)) photos.push(u);
    }
  }
  photos = [...new Set(photos)];

  const c = pick(raw, CAPTION_KEYS);
  const caption = typeof c === "string" && c.trim() ? c.trim() : null;
  return { jobNumber, photos, caption };
}

/** File name for the i-th photo of a job, preserving a sane extension. Pure. */
export function photoFileName(jobNumber: string, index: number, url: string, contentType: string): string {
  const fromUrl = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();
  const fromCt = (contentType.split("/")[1] ?? "").split(";")[0].replace("jpeg", "jpg").toLowerCase();
  const ext = (fromUrl || fromCt || "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
  return `${jobNumber}-photo-${String(index + 1).padStart(2, "0")}.${ext}`;
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/** POST /ingest/photo handler. Auth + body-size are checked by the caller (index.ts). */
export async function handlePhotoIngest(env: Env, rawText: string, contentType: string | null): Promise<Response> {
  const raw = parseBody(rawText, contentType);
  const sub = parsePhotoSubmission(raw);
  const id = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/photos/${now.slice(0, 10)}/${id}.json`;

  // Raw FIRST — nothing is lost even if Graph is down or unconfigured.
  await store.putRaw(env, rawKey, rawText, "application/json");

  if (!sub.jobNumber || sub.photos.length === 0) {
    const reason = !sub.jobNumber ? "no_job_number" : "no_photos";
    await store.recordAudit(env, { automation: "jobsite_photo", trigger: "jotform", envelope_id: id,
      job_number: sub.jobNumber, action: "received", result: "error", error: reason });
    return jsonResp({ error: reason }, 400);
  }

  if (!googleConfigured(env)) {
    const erp = await syncPhotoEvidenceToErpNext(env, id, sub, rawKey, now, buildPhotoRefs(sub));
    await store.recordAudit(env, { automation: "jobsite_photo", trigger: "jotform", envelope_id: id,
      job_number: sub.jobNumber, action: "received", result: "ok", error: "drive_not_configured" });
    return jsonResp({ ok: true, job_number: sub.jobNumber, photos: sub.photos.length, uploaded: 0,
      erpnext_evidence_ids: erp.names,
      erpnext_field_check_in_id: erp.fieldCheckInName,
      erpnext_error: erp.error,
      note: "drive_not_configured — raw stored; files sync once Google creds are set" });
  }

  // Fetch each photo URL → bytes, then file the batch into the job's Drive folder (03 Photos).
  const refs = buildPhotoRefs(sub);
  const files: Array<{ name: string; bytes: ArrayBuffer; contentType: string; refIndex: number }> = [];
  for (let i = 0; i < sub.photos.length; i++) {
    try {
      const r = await fetch(sub.photos[i]);
      if (!r.ok) {
        refs[i].error = `photo_fetch_${r.status}`;
        log({ at: "photo_fetch", url: sub.photos[i], status: r.status });
        continue;
      }
      const ct = r.headers.get("content-type") ?? "application/octet-stream";
      const name = photoFileName(sub.jobNumber, i, sub.photos[i], ct);
      refs[i].fileName = name;
      files.push({ name, bytes: await r.arrayBuffer(), contentType: ct, refIndex: i });
    } catch (e) {
      refs[i].error = String(e).slice(0, 120);
      log({ at: "photo_fetch", url: sub.photos[i], error: String(e) });
    }
  }

  const result = await fileToJobFolder(env, sub.jobNumber, "03 Photos", files);
  for (let i = 0; i < files.length; i++) {
    const ref = refs[files[i].refIndex];
    const uploadedFile = result.files[i];
    ref.driveFileUrl = uploadedFile?.webUrl ?? null;
    ref.driveFileId = uploadedFile?.driveFileId ?? null;
    if (uploadedFile?.error) ref.error = uploadedFile.error.slice(0, 120);
  }
  const uploaded = result.files.filter((f) => f.webUrl).length;
  const erp = await syncPhotoEvidenceToErpNext(env, id, sub, rawKey, now, refs, result.folderUrl);
  await store.recordAudit(env, { automation: "jobsite_photo", trigger: "jotform", envelope_id: id,
    job_number: sub.jobNumber, target_ids: result.folderUrl,
    action: "filed", result: uploaded ? "ok" : "error", error: uploaded ? null : "no_files_uploaded" });
  return jsonResp({ ok: true, job_number: sub.jobNumber, uploaded, folder: result.folderUrl, files: result.files,
    erpnext_evidence_ids: erp.names, erpnext_field_check_in_id: erp.fieldCheckInName, erpnext_error: erp.error });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function buildPhotoRefs(sub: PhotoSubmission): PhotoEvidenceRef[] {
  return sub.photos.map((sourceUri, index) => ({
    index,
    sourceUri,
    fileName: photoFileName(sub.jobNumber ?? "unknown", index, sourceUri, ""),
  }));
}

async function syncPhotoEvidenceToErpNext(
  env: Env,
  id: string,
  sub: PhotoSubmission,
  rawKey: string,
  capturedAt: string,
  photos: PhotoEvidenceRef[],
  driveFolderUrl?: string | null,
): Promise<{ names: string[]; fieldCheckInName?: string; error: string | null }> {
  try {
    const erp = await pushPhotoEvidenceToErpNext(env, {
      submissionId: id,
      jobNumber: sub.jobNumber ?? "",
      rawKey,
      capturedAt,
      caption: sub.caption,
      driveFolderUrl,
      photos,
    });
    if (erp) {
      await store.recordAudit(env, { automation: "erpnext_photo", trigger: "jotform",
        envelope_id: id, job_number: sub.jobNumber,
        target_ids: [
          ...erp.names.map((name) => `evidence_item:${name}`),
          erp.fieldCheckInName ? `field_check_in:${erp.fieldCheckInName}` : null,
        ].filter(Boolean).join(","),
        action: erp.reused ? "upsert_existing" : "create", result: "ok" });
    }
    return { names: erp?.names ?? [], fieldCheckInName: erp?.fieldCheckInName, error: null };
  } catch (err) {
    const error = `erpnext_photo: ${String(err)}`;
    await store.recordAudit(env, { automation: "erpnext_photo", trigger: "jotform",
      envelope_id: id, job_number: sub.jobNumber, action: "sync", result: "error", error });
    return { names: [], error };
  }
}
