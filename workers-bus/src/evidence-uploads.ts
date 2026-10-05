import { sha256Hex, validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { claimFieldUploadWindow } from "./field-actions.ts";
import { INVENTORY_TRANSITIONS } from "./inventory-control.ts";

export const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_REQUEST_BYTES = MAX_EVIDENCE_FILE_BYTES + 16 * 1024;
export const MAX_EVIDENCE_RECEIPTS = 4;
const OFFICE_EVIDENCE_UPLOADS_PER_WINDOW = 16;
export function evidenceReceiptsRequired(env: AppEnv): boolean {
  return env.APP_EVIDENCE_RECEIPTS_REQUIRED === "true";
}
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const UPLOAD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const RECEIPT_ID = /^evu_[0-9a-f]{64}$/;
const SERVICE_ACTIONS = new Set(["triage", "diagnose", "issue_remedy", "verify_remedy", "customer_decision", "close", "recover_cost"]);

export interface EvidenceScope {
  purpose: "stock" | "service_intake" | "service_step" | "corrective_action";
  targetId: string;
  action: string;
  operationId: string;
}
export interface EvidenceUploadReceipt {
  receipt_id: string;
  tenant_id: string;
  actor_user_id: string;
  actor_role: string;
  upload_key_sha256: string;
  purpose: EvidenceScope["purpose"];
  target_id: string;
  action: string;
  operation_id: string;
  r2_key: string;
  byte_size: number;
  content_type: string;
  file_name: string;
  sha256: string;
  request_sha256: string;
  created_at: string;
}
export class EvidenceUploadError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
export function evidenceUploadFailure(error: unknown): Response {
  return error instanceof EvidenceUploadError
    ? json({ error: error.code }, error.status)
    : json({ error: "evidence_store_unavailable", retryable: true }, 502);
}
export function evidenceIdempotencyKey(req: Request): string {
  const key = req.headers.get("idempotency-key") ?? "";
  if (!UPLOAD_KEY.test(key)) throw new EvidenceUploadError("evidence_idempotency_key_required", 400);
  return key;
}
export async function binarySha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Current D1 target and role are checked on upload AND resolution. No receipt grants authority. */
export async function assertEvidenceScope(env: AppEnv, auth: AuthContext, scope: EvidenceScope): Promise<string> {
  if (!ID.test(scope.targetId) || (scope.operationId !== "" && !ID.test(scope.operationId))) {
    throw new EvidenceUploadError("evidence_scope_invalid", 400);
  }
  const user = await env.DB.prepare(
    "SELECT COALESCE(access_role, role) AS role FROM app_users WHERE tenant_id = ? AND user_id = ? AND active = 1",
  ).bind(auth.session.tenant_id, auth.session.user_id).first<{ role: string }>();
  if (!user) throw new EvidenceUploadError("evidence_actor_inactive", 403);
  const tenant = auth.session.tenant_id;
  let target: unknown;
  switch (scope.purpose) {
    case "stock":
      if (user.role !== auth.session.role || !["owner", "ops", "field"].includes(user.role)) {
        throw new EvidenceUploadError("inventory_write_role_required", 403);
      }
      if (!INVENTORY_TRANSITIONS.some((action) => action === scope.action) || !COMMAND_ID.test(scope.operationId)) {
        throw new EvidenceUploadError("evidence_scope_invalid", 400);
      }
      if (user.role === "field" && !["issue_use", "return", "quarantine"].includes(scope.action)) {
        throw new EvidenceUploadError("inventory_transition_role_required", 403);
      }
      target = await env.DB.prepare("SELECT lot_id FROM inventory_lots WHERE tenant_id = ? AND lot_id = ?")
        .bind(tenant, scope.targetId).first();
      break;
    case "service_intake":
    case "service_step":
      if (user.role !== auth.session.role || !["owner", "ops"].includes(user.role)) {
        throw new EvidenceUploadError("office_role_required", 403);
      }
      if (scope.purpose === "service_intake") {
        if (scope.action !== "open" || !UPLOAD_KEY.test(scope.operationId)) throw new EvidenceUploadError("evidence_scope_invalid", 400);
        target = await env.DB.prepare("SELECT roof_job_id FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?")
          .bind(tenant, scope.targetId).first();
      } else {
        if (!SERVICE_ACTIONS.has(scope.action)) throw new EvidenceUploadError("evidence_scope_invalid", 400);
        if (scope.action === "recover_cost" && user.role !== "owner") throw new EvidenceUploadError("owner_role_required", 403);
        const remedyAction = ["verify_remedy", "customer_decision"].includes(scope.action);
        if (remedyAction ? !ID.test(scope.operationId) : scope.operationId !== "") throw new EvidenceUploadError("evidence_scope_invalid", 400);
        target = remedyAction
          ? await env.DB.prepare("SELECT remedy_id FROM service_case_remedies WHERE tenant_id = ? AND service_case_id = ? AND remedy_id = ?")
            .bind(tenant, scope.targetId, scope.operationId).first()
          : await env.DB.prepare("SELECT service_case_id FROM service_cases WHERE tenant_id = ? AND service_case_id = ?")
            .bind(tenant, scope.targetId).first();
      }
      break;
    case "corrective_action":
      if (user.role !== auth.session.role) throw new EvidenceUploadError("evidence_actor_role_changed", 403);
      if (scope.action !== "submit" || scope.operationId !== "") throw new EvidenceUploadError("evidence_scope_invalid", 400);
      target = await env.DB.prepare("SELECT corrective_action_id FROM safety_corrective_actions WHERE tenant_id = ? AND corrective_action_id = ?")
        .bind(tenant, scope.targetId).first();
      break;
    default: throw new EvidenceUploadError("evidence_scope_invalid", 400);
  }
  if (!target) throw new EvidenceUploadError("evidence_target_not_found", 404);
  return user.role;
}

export async function handleEvidenceUpload(req: Request, env: AppEnv, auth: AuthContext): Promise<Response> {
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  try {
    const key = evidenceIdempotencyKey(req);
    const type = req.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new EvidenceUploadError("multipart_required", 415);
    // Count actual stream bytes before parsing, including absent/false Content-Length headers.
    const raw = await boundedBody(req, MAX_EVIDENCE_REQUEST_BYTES);
    let form: FormData;
    try { form = await new Response(raw, { headers: { "content-type": type } }).formData(); }
    catch { throw new EvidenceUploadError("invalid_multipart", 400); }
    const allowed = ["file", "purpose", "target_id", "action", "operation_id"];
    const seen = new Set<string>();
    for (const name of form.keys()) {
      if (!allowed.includes(name) || seen.has(name)) throw new EvidenceUploadError("unexpected_field", 400);
      seen.add(name);
    }
    const text = (name: string): string => typeof form.get(name) === "string" ? String(form.get(name)) : "";
    const scope: EvidenceScope = { purpose: text("purpose") as EvidenceScope["purpose"], targetId: text("target_id"), action: text("action"), operationId: text("operation_id") };
    const role = await assertEvidenceScope(env, auth, scope);
    const limit = await claimFieldUploadWindow(env, auth, new Date(),
      role === "owner" || role === "ops" ? OFFICE_EVIDENCE_UPLOADS_PER_WINDOW : undefined);
    if (!limit.allowed) {
      const response = json({ error: "evidence_upload_rate_limited" }, 429);
      response.headers.set("retry-after", String(limit.retryAfterSeconds));
      return response;
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new EvidenceUploadError("evidence_file_required", 400);
    if (file.size < 1 || file.size > MAX_EVIDENCE_FILE_BYTES) throw new EvidenceUploadError("evidence_file_size_invalid", 413);
    const contentType = file.type.toLowerCase();
    if (!MIME_TYPES.has(contentType)) throw new EvidenceUploadError("evidence_type_unsupported", 415);
    const name = file.name.trim();
    if (!name || name.length > 180 || /[\u0000-\u001f/\\]/.test(name)) throw new EvidenceUploadError("evidence_file_name_invalid", 400);
    const bytes = await file.arrayBuffer();
    if (!matchesMime(new Uint8Array(bytes), contentType)) throw new EvidenceUploadError("evidence_type_mismatch", 415);
    const digest = await binarySha256(bytes);
    const identity = await sha256Hex(JSON.stringify([auth.session.tenant_id, auth.session.user_id, key]));
    const requestHash = await sha256Hex(JSON.stringify([scope, name, contentType, file.size, digest]));
    const receiptId = `evu_${identity}`;
    const r2Key = `evidence/v1/${identity}.bin`;
    const previous = await receipt(env, auth.session.tenant_id, receiptId);
    if (previous && previous.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
    const existing = await env.RAW.get(r2Key);
    if (existing && existing.customMetadata?.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
    if (!existing) {
      // An immutable key binds scope+bytes even when the following D1 insert fails.
      await env.RAW.put(r2Key, bytes, { sha256: digest, onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType }, customMetadata: { sha256: digest, request_sha256: requestHash, immutable: "true" } });
    }
    await assertStored(env, r2Key, file.size, contentType, digest, requestHash);
    if (previous) return json({ result: "replayed", receipt: project(previous) });
    const row: EvidenceUploadReceipt = { receipt_id: receiptId, tenant_id: auth.session.tenant_id, actor_user_id: auth.session.user_id,
      actor_role: role, upload_key_sha256: await sha256Hex(key), purpose: scope.purpose, target_id: scope.targetId,
      action: scope.action, operation_id: scope.operationId, r2_key: r2Key, byte_size: file.size, content_type: contentType,
      file_name: name, sha256: digest, request_sha256: requestHash, created_at: new Date().toISOString() };
    try {
      await env.DB.prepare(`INSERT INTO evidence_upload_receipts (receipt_id, tenant_id, actor_user_id, actor_role,
        upload_key_sha256, purpose, target_id, action, operation_id, r2_key, byte_size, content_type, file_name, sha256, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(row.receipt_id, row.tenant_id, row.actor_user_id, row.actor_role,
        row.upload_key_sha256, row.purpose, row.target_id, row.action, row.operation_id, row.r2_key, row.byte_size,
        row.content_type, row.file_name, row.sha256, row.request_sha256, row.created_at).run();
    } catch (error) {
      const winner = await receipt(env, auth.session.tenant_id, receiptId);
      if (!winner) throw error;
      if (winner.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
      return json({ result: "replayed", receipt: project(winner) });
    }
    return json({ result: "stored", receipt: project(row) }, 201);
  } catch (error) { return evidenceUploadFailure(error); }
}

/** Resolve all files before a domain mutation. Digest/refs are derived exclusively from D1 + R2. */
export async function resolveEvidenceUploads(env: AppEnv, auth: AuthContext, scope: EvidenceScope, ids: unknown): Promise<{
  refs: Array<{ ref: string; sha256: string }>;
  refsJson: string;
  sha256: string;
}> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_EVIDENCE_RECEIPTS ||
      ids.some((id) => typeof id !== "string" || !RECEIPT_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new EvidenceUploadError("evidence_receipts_required", 400);
  }
  await assertEvidenceScope(env, auth, scope);
  const refs: Array<{ ref: string; sha256: string }> = [];
  for (const id of [...ids].sort()) {
    const row = await receipt(env, auth.session.tenant_id, id);
    if (!row) throw new EvidenceUploadError("evidence_receipt_not_found", 404);
    if (row.actor_user_id !== auth.session.user_id || row.purpose !== scope.purpose || row.target_id !== scope.targetId ||
        row.action !== scope.action || row.operation_id !== scope.operationId) throw new EvidenceUploadError("evidence_receipt_scope_mismatch", 403);
    await assertStored(env, row.r2_key, row.byte_size, row.content_type, row.sha256, row.request_sha256);
    refs.push({ ref: `evidence-upload://${row.receipt_id}`, sha256: row.sha256 });
  }
  const refsJson = JSON.stringify(refs);
  const digest = await sha256Hex(JSON.stringify([auth.session.tenant_id, auth.session.user_id, scope, refs]));
  const existing = await env.DB.prepare("SELECT sha256 FROM evidence_upload_manifests WHERE sha256 = ?").bind(digest).first();
  if (!existing) {
    try {
      await env.DB.prepare(`INSERT INTO evidence_upload_manifests
        (sha256, tenant_id, actor_user_id, purpose, target_id, action, operation_id, refs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(digest, auth.session.tenant_id, auth.session.user_id, scope.purpose, scope.targetId, scope.action, scope.operationId, refsJson, new Date().toISOString()).run();
    } catch (error) {
      if (!await env.DB.prepare("SELECT sha256 FROM evidence_upload_manifests WHERE sha256 = ?").bind(digest).first()) throw error;
    }
  }
  return { refs, refsJson, sha256: digest };
}
async function receipt(env: AppEnv, tenant: string, id: string): Promise<EvidenceUploadReceipt | null> {
  return env.DB.prepare("SELECT * FROM evidence_upload_receipts WHERE tenant_id = ? AND receipt_id = ?").bind(tenant, id).first<EvidenceUploadReceipt>();
}
async function assertStored(env: AppEnv, key: string, size: number, type: string, hash: string, requestHash: string): Promise<void> {
  const object = await env.RAW.get(key);
  if (!object) throw new EvidenceUploadError("evidence_object_missing", 409);
  if (size > MAX_EVIDENCE_FILE_BYTES || object.size !== size || object.httpMetadata?.contentType !== type ||
      object.customMetadata?.sha256 !== hash || object.customMetadata?.request_sha256 !== requestHash) {
    throw new EvidenceUploadError("evidence_object_mismatch", 409);
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== size || await binarySha256(bytes) !== hash) throw new EvidenceUploadError("evidence_object_mismatch", 409);
}
async function boundedBody(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new EvidenceUploadError("payload_too_large", 413);
  if (!req.body) throw new EvidenceUploadError("invalid_multipart", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new EvidenceUploadError("payload_too_large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function matchesMime(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end));
  switch (type) {
    case "image/jpeg": return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "image/png": return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
    case "image/webp": return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "application/pdf": return ascii(0, 5) === "%PDF-";
    case "image/heic": case "image/heif": return ascii(4, 8) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 12));
    default: return false;
  }
}
function project(row: EvidenceUploadReceipt): Record<string, unknown> {
  return { receipt_id: row.receipt_id, file_name: row.file_name, content_type: row.content_type, byte_size: row.byte_size,
    purpose: row.purpose, target_id: row.target_id, action: row.action, operation_id: row.operation_id };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
}
