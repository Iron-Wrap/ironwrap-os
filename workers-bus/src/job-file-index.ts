/**
 * IRO-48: append-only pointers from operating_roof_jobs to Drive / R2 artifacts.
 * Does not send files to customers or suppliers. A missing 0108 table or
 * unmatched job must not fail photo, measurement, or Facet intake.
 */

import type { AppEnv } from "./app-types.ts";

export const JOB_FILE_ARTIFACT_KINDS = [
  "facet_design",
  "measurement",
  "photo",
  "proposal",
  "check_in",
  "archive",
] as const;

export type JobFileArtifactKind = (typeof JOB_FILE_ARTIFACT_KINDS)[number];

export type RecordOperatingJobFileOutcome =
  | "recorded"
  | "replayed"
  | "conflict"
  | "skipped_schema"
  | "skipped_no_job"
  | "skipped_invalid"
  | "skipped_error";

export interface RecordOperatingJobFileInput {
  tenantId: string;
  roofJobId: string;
  artifactKind: JobFileArtifactKind;
  artifactId: string;
  driveFolderId?: string | null;
  driveFileId?: string | null;
  r2Key?: string | null;
  contentSha256?: string | null;
  idempotencyKey?: string | null;
  createdAt?: string;
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const DRIVE_ID = /^[\S]{8,128}$/;
const R2_KEY = /^[\S]{8,512}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[\S]{8,160}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type JobFileDb = Pick<AppEnv, "DB"> | { DB: AppEnv["DB"] };

export function isJobFileArtifactKind(value: string): value is JobFileArtifactKind {
  return (JOB_FILE_ARTIFACT_KINDS as readonly string[]).includes(value);
}

export async function recordOperatingJobFile(
  env: JobFileDb,
  input: RecordOperatingJobFileInput,
): Promise<RecordOperatingJobFileOutcome> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.roofJobId)
    || !isJobFileArtifactKind(input.artifactKind) || !OPAQUE_ID.test(input.artifactId)
    || !ISO_INSTANT.test(createdAt)) {
    return "skipped_invalid";
  }
  const driveFolderId = optional(input.driveFolderId, DRIVE_ID);
  const driveFileId = optional(input.driveFileId, DRIVE_ID);
  const r2Key = optional(input.r2Key, R2_KEY);
  const contentSha256 = optional(input.contentSha256, SHA256);
  const idempotencyKey = optional(input.idempotencyKey, IDEMPOTENCY);
  if (driveFolderId === false || driveFileId === false || r2Key === false
    || contentSha256 === false || idempotencyKey === false) {
    return "skipped_invalid";
  }
  if (driveFileId === null && r2Key === null) return "skipped_invalid";
  const normalized = {
    tenant_id: input.tenantId,
    roof_job_id: input.roofJobId,
    artifact_kind: input.artifactKind,
    artifact_id: input.artifactId,
    drive_folder_id: driveFolderId,
    drive_file_id: driveFileId,
    r2_key: r2Key,
    content_sha256: contentSha256,
    idempotency_key: idempotencyKey,
  };

  try {
    const existing = await readExistingBindings(env, normalized);
    if (existing.length > 0) {
      return existing.every((row) => sameBinding(row, normalized)) ? "replayed" : "conflict";
    }
    const inserted = await env.DB.prepare(
      `INSERT INTO operating_job_file_index
         (tenant_id, roof_job_id, artifact_kind, artifact_id, drive_folder_id,
          drive_file_id, r2_key, content_sha256, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, artifact_kind, artifact_id) DO NOTHING`,
    )
      .bind(
        input.tenantId,
        input.roofJobId,
        input.artifactKind,
        input.artifactId,
        driveFolderId,
        driveFileId,
        r2Key,
        contentSha256,
        idempotencyKey,
        createdAt,
      )
      .run();
    if ((inserted.meta?.changes ?? 0) === 0) {
      const raced = await readExistingBindings(env, normalized);
      if (raced.length === 0) return "skipped_error";
      return raced.every((row) => sameBinding(row, normalized)) ? "replayed" : "conflict";
    }
    return "recorded";
  } catch (error) {
    if (isMissingSchema(error)) return "skipped_schema";
    if (isForeignKey(error)) return "skipped_no_job";
    throw error;
  }
}

type JobFileBinding = {
  tenant_id: string;
  roof_job_id: string;
  artifact_kind: JobFileArtifactKind;
  artifact_id: string;
  drive_folder_id: string | null;
  drive_file_id: string | null;
  r2_key: string | null;
  content_sha256: string | null;
  idempotency_key: string | null;
};

async function readExistingBindings(
  env: JobFileDb,
  input: JobFileBinding,
): Promise<JobFileBinding[]> {
  const rows: JobFileBinding[] = [];
  const artifact = await env.DB.prepare(
    `SELECT tenant_id, roof_job_id, artifact_kind, artifact_id, drive_folder_id,
            drive_file_id, r2_key, content_sha256, idempotency_key
       FROM operating_job_file_index
      WHERE tenant_id = ? AND artifact_kind = ? AND artifact_id = ?
      LIMIT 1`,
  ).bind(input.tenant_id, input.artifact_kind, input.artifact_id)
    .first<JobFileBinding>();
  if (artifact) rows.push(artifact);
  if (input.idempotency_key) {
    const idempotency = await env.DB.prepare(
      `SELECT tenant_id, roof_job_id, artifact_kind, artifact_id, drive_folder_id,
              drive_file_id, r2_key, content_sha256, idempotency_key
         FROM operating_job_file_index
        WHERE tenant_id = ? AND idempotency_key = ?
        LIMIT 1`,
    ).bind(input.tenant_id, input.idempotency_key)
      .first<JobFileBinding>();
    if (idempotency && !rows.some((row) => sameIdentity(row, idempotency))) rows.push(idempotency);
  }
  return rows;
}

function sameIdentity(left: JobFileBinding, right: JobFileBinding): boolean {
  return left.tenant_id === right.tenant_id
    && left.artifact_kind === right.artifact_kind
    && left.artifact_id === right.artifact_id;
}

function sameBinding(left: JobFileBinding, right: JobFileBinding): boolean {
  return left.tenant_id === right.tenant_id
    && left.roof_job_id === right.roof_job_id
    && left.artifact_kind === right.artifact_kind
    && left.artifact_id === right.artifact_id
    && left.drive_folder_id === right.drive_folder_id
    && left.drive_file_id === right.drive_file_id
    && left.r2_key === right.r2_key
    && left.content_sha256 === right.content_sha256
    && left.idempotency_key === right.idempotency_key;
}

export async function recordOperatingJobFileBestEffort(
  env: JobFileDb,
  input: RecordOperatingJobFileInput,
): Promise<RecordOperatingJobFileOutcome> {
  try {
    return await recordOperatingJobFile(env, input);
  } catch {
    return "skipped_error";
  }
}

function optional(value: string | null | undefined, pattern: RegExp): string | null | false {
  if (value == null || value === "") return null;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : false;
}

function isMissingSchema(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /no such table: operating_job_file_index/i.test(message)
    || /no such column/i.test(message);
}

function isForeignKey(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /FOREIGN KEY constraint failed/i.test(message);
}
