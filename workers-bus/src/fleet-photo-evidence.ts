import { FieldActionError, r2ObjectStore } from "./field-actions.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { fleetAssetForFieldActor } from "./app-read-models.ts";
import { validAppCsrf } from "./app-auth.ts";
import { claimFieldUploadWindow } from "./field-actions.ts";

export const FLEET_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export const MAX_FLEET_PHOTOS = 4;
export const MAX_FLEET_PHOTO_BYTES = 8 * 1024 * 1024;

export type FleetPhotoContentType = (typeof FLEET_PHOTO_TYPES)[number];

export interface FleetPhotoEvidenceRef {
  attachment_id: string;
  file_name: string;
  content_type: FleetPhotoContentType;
  sha256: string;
  r2_key: string;
}

const PHOTO_TYPE_SET = new Set<string>(FLEET_PHOTO_TYPES);

export function isFleetPhotoContentType(value: string): value is FleetPhotoContentType {
  return PHOTO_TYPE_SET.has(value);
}

export function parseFleetPhotoEvidenceRefs(value: unknown): FleetPhotoEvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FLEET_PHOTOS) {
    throw invalidFleetPhoto();
  }
  const refs = value.map((row) => parseOnePhotoRef(row));
  if (new Set(refs.map((ref) => ref.attachment_id)).size !== refs.length) throw invalidFleetPhoto();
  return refs;
}

function parseOnePhotoRef(value: unknown): FleetPhotoEvidenceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidFleetPhoto();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 5
    || !keys.includes("attachment_id")
    || !keys.includes("file_name")
    || !keys.includes("content_type")
    || !keys.includes("sha256")
    || !keys.includes("r2_key")
  ) {
    throw invalidFleetPhoto();
  }
  const attachmentId = boundedId(record.attachment_id, 8, 80);
  const fileName = boundedText(record.file_name, 1, 180);
  const contentType = typeof record.content_type === "string" ? record.content_type.toLowerCase() : "";
  if (!isFleetPhotoContentType(contentType)) throw invalidFleetPhoto();
  const sha256 = boundedText(record.sha256, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalidFleetPhoto();
  const r2Key = boundedText(record.r2_key, 16, 240);
  if (!r2Key.startsWith("fleet/v1/") || !r2Key.includes("/photo/")) throw invalidFleetPhoto();
  return {
    attachment_id: attachmentId,
    file_name: fileName,
    content_type: contentType,
    sha256,
    r2_key: r2Key,
  };
}

export function fleetPhotoKey(
  scopeDigest: string,
  fleetAssetId: string,
  attachmentId: string,
): string {
  return `fleet/v1/${scopeDigest}/photo/${fleetAssetId}/${attachmentId}.bin`;
}

export interface FleetPhotoHead {
  head(key: string): Promise<{ customMetadata?: { sha256?: string } } | null>;
}

export async function assertFleetPhotosStored(
  bucket: FleetPhotoHead,
  photos: readonly FleetPhotoEvidenceRef[],
): Promise<void> {
  for (const photo of photos) {
    const existing = await bucket.head(photo.r2_key);
    if (!existing) {
      throw new FieldActionError(
        "fleet_photo_missing",
        409,
        "Fleet photo evidence is not stored yet.",
      );
    }
    if (existing.customMetadata?.sha256 !== photo.sha256) {
      throw new FieldActionError(
        "fleet_photo_mismatch",
        409,
        "Stored fleet photo does not match this capture.",
      );
    }
  }
}

export async function handleFleetPhotoUpload(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string,
): Promise<Response> {
  if (auth.session.role !== "field") {
    return json({ error: "field_role_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const assetName = decodeAsset(encodedAssetName);
  if (!assetName) return json({ error: "not_found" }, 404);
  const rateLimit = await claimFieldUploadWindow(env, auth);
  if (!rateLimit.allowed) {
    const limited = json({ error: "field_upload_rate_limited" }, 429);
    limited.headers.set("retry-after", String(rateLimit.retryAfterSeconds));
    return limited;
  }
  const asset = await fleetAssetForFieldActor(env, auth, assetName);
  if (!asset) return json({ error: "not_found" }, 404);

  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return json({ error: "multipart_required" }, 415);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_multipart" }, 400);
  }
  const file = form.get("photo");
  if (!(file instanceof File)) return json({ error: "photo_required" }, 400);
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!isFleetPhotoContentType(mime)) return json({ error: "unsupported_fleet_photo_type" }, 400);
  if (file.size < 1 || file.size > MAX_FLEET_PHOTO_BYTES) {
    return json({ error: "fleet_photo_too_large" }, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const attachmentId = crypto.randomUUID();
  const scopeDigest = (await sha256Hex(new TextEncoder().encode(`${auth.session.tenant_id}:${assetName}`))).slice(0, 24);
  const r2Key = fleetPhotoKey(scopeDigest, assetName, attachmentId);
  await r2ObjectStore(env.RAW).ensure(r2Key, new Blob([bytes], { type: mime }), mime, sha256);
  const ref: FleetPhotoEvidenceRef = {
    attachment_id: attachmentId,
    file_name: file.name.trim() || "fleet-photo.jpg",
    content_type: mime,
    sha256,
    r2_key: r2Key,
  };
  return json({ photo_evidence: ref }, 201);
}

function decodeAsset(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 140 && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function invalidFleetPhoto(): FieldActionError {
  return new FieldActionError("invalid_fleet_action", 400, "Fleet photo evidence is invalid.");
}

function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw invalidFleetPhoto();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max) throw invalidFleetPhoto();
  return parsed;
}

function boundedId(value: unknown, min: number, max: number): string {
  const parsed = boundedText(value, min, max);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw invalidFleetPhoto();
  return parsed;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
