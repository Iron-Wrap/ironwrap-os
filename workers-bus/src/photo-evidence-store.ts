import { isVoiceNoteUri } from "./core.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { tenantIdFrom } from "./operating-core.ts";

export interface NativePhotoEvidenceRef {
  index: number;
  sourceUri: string;
  fileName: string;
  driveFileUrl?: string | null;
  driveFileId?: string | null;
  error?: string | null;
}

export interface NativePhotoEvidenceRecord {
  submission_id: string;
  tenant_id: string;
  envelope_id: string;
  job_number: string;
  roof_job_id: string | null;
  association_status: "matched" | "unmatched";
  association_error: string | null;
  evidence_ids: string[];
  projection_sha256: string;
}

interface JobAnchor {
  roof_job_id: string;
  version: number;
}

export async function recordNativePhotoEvidence(
  env: Env,
  input: {
    envelopeId: string;
    jobNumber: string;
    rawKey: string;
    rawText: string;
    capturedAt: string;
    caption: string | null;
    driveFolderUrl?: string | null;
    photos: NativePhotoEvidenceRef[];
  },
): Promise<NativePhotoEvidenceRecord> {
  if (!env.DB) throw new Error("native_photo_store_unavailable");
  const tenantId = tenantIdFrom(env);
  const rawSha256 = await sha256Hex(input.rawText);
  const jobs = await env.DB.prepare(
    `SELECT roof_job_id, version
       FROM operating_roof_jobs
      WHERE tenant_id = ? AND job_number = ?
      ORDER BY roof_job_id ASC
      LIMIT 3`,
  )
    .bind(tenantId, input.jobNumber)
    .all<JobAnchor>();
  const anchors = jobs.results ?? [];
  let associationStatus: "matched" | "unmatched" = "unmatched";
  let associationError: string | null = "job_not_found";
  let roofJobId: string | null = null;
  let operatingJobVersion: number | null = null;
  if (anchors.length === 1) {
    associationStatus = "matched";
    associationError = null;
    roofJobId = anchors[0]!.roof_job_id;
    operatingJobVersion = Number(anchors[0]!.version);
  } else if (anchors.length > 1) {
    associationError = "job_number_ambiguous";
  }

  const items = input.photos.map((photo) => ({
    index: photo.index,
    evidence_type: isVoiceNoteUri(photo.sourceUri) ? "voice_note" : "photo",
    source_uri: photo.sourceUri,
    file_name: photo.fileName,
    drive_file_url: photo.driveFileUrl ?? null,
    drive_file_id: photo.driveFileId ?? null,
    fetch_error: photo.error ?? null,
  }));
  const projection = {
    schema_version: 1,
    tenant_id: tenantId,
    envelope_id: input.envelopeId,
    job_number: input.jobNumber,
    roof_job_id: roofJobId,
    operating_job_version: operatingJobVersion,
    association_status: associationStatus,
    association_error: associationError,
    raw_key: input.rawKey,
    raw_sha256: rawSha256,
    caption: input.caption,
    captured_at: input.capturedAt,
    drive_folder_url: input.driveFolderUrl ?? null,
    photos: items,
  };
  const projectionJson = canonicalJson(projection);
  const projectionSha256 = await sha256Hex(projectionJson);
  const submissionId = `psub_${await sha256Hex(
    canonicalJson({
      tenant_id: tenantId,
      envelope_id: input.envelopeId,
      raw_sha256: rawSha256,
    }),
  )}`;
  const evidenceIds = await Promise.all(
    items.map(async (item) =>
      `pevi_${await sha256Hex(
        canonicalJson({
          submission_id: submissionId,
          item_index: item.index,
          source_uri: item.source_uri,
        }),
      )}`,
    ),
  );

  try {
    await env.DB.prepare(
      `INSERT INTO native_photo_evidence_submissions (
         submission_id, tenant_id, envelope_id, job_number, roof_job_id,
         operating_job_version, association_status, association_error, raw_key, raw_sha256,
         caption, captured_at, photo_count, drive_folder_url, projection_json,
         projection_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        submissionId,
        tenantId,
        input.envelopeId,
        input.jobNumber,
        roofJobId,
        operatingJobVersion,
        associationStatus,
        associationError,
        input.rawKey,
        rawSha256,
        input.caption,
        input.capturedAt,
        items.length,
        input.driveFolderUrl ?? null,
        projectionJson,
        projectionSha256,
        input.capturedAt,
      )
      .run();
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      await env.DB.prepare(
        `INSERT INTO native_photo_evidence_items (
           evidence_id, submission_id, tenant_id, item_index, evidence_type,
           source_uri, file_name, drive_file_url, drive_file_id, fetch_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          evidenceIds[index]!,
          submissionId,
          tenantId,
          item.index,
          item.evidence_type,
          item.source_uri,
          item.file_name,
          item.drive_file_url,
          item.drive_file_id,
          item.fetch_error,
        )
        .run();
    }
  } catch (error) {
    const existing = await env.DB.prepare(
      `SELECT submission_id, tenant_id, envelope_id, job_number, roof_job_id,
              association_status, association_error, projection_sha256
         FROM native_photo_evidence_submissions
        WHERE tenant_id = ? AND envelope_id = ?`,
    )
      .bind(tenantId, input.envelopeId)
      .first<Omit<NativePhotoEvidenceRecord, "evidence_ids">>();
    if (!existing || existing.projection_sha256 !== projectionSha256) throw error;
    const storedItems = await env.DB.prepare(
      `SELECT evidence_id FROM native_photo_evidence_items
        WHERE submission_id = ? ORDER BY item_index ASC`,
    )
      .bind(existing.submission_id)
      .all<{ evidence_id: string }>();
    return {
      ...existing,
      association_status: existing.association_status as "matched" | "unmatched",
      evidence_ids: (storedItems.results ?? []).map((row) => row.evidence_id),
    };
  }

  return {
    submission_id: submissionId,
    tenant_id: tenantId,
    envelope_id: input.envelopeId,
    job_number: input.jobNumber,
    roof_job_id: roofJobId,
    association_status: associationStatus,
    association_error: associationError,
    evidence_ids: evidenceIds,
    projection_sha256: projectionSha256,
  };
}
