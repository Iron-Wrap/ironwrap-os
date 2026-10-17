import { sha256Hex, validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { claimFieldUploadWindow } from "./field-actions.ts";
import { INVENTORY_TRANSITIONS } from "./inventory-control.ts";
import { evidenceDispositionState } from "./evidence-privacy-state.ts";
import { EvidencePrivacyLedgerUnavailable, EvidencePrivacyMarkerConflict, externalEvidenceMarkerPresent } from "./evidence-privacy-ledger.ts";

export const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_REQUEST_BYTES = MAX_EVIDENCE_FILE_BYTES + 16 * 1024;
export const MAX_EVIDENCE_RECEIPTS = 4;
const OFFICE_EVIDENCE_UPLOADS_PER_WINDOW = 16;
export function evidenceUploadsEnabled(env: AppEnv): boolean {
  return env.APP_EVIDENCE_UPLOADS_ENABLED === "true";
}
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
export interface LinkedEvidenceFile {
  receipt_id: string;
  file_name: string;
  content_type: string;
  byte_size: number;
}
export interface DetailEvidenceFiles {
  evidence_files: LinkedEvidenceFile[];
  evidence_files_unavailable: boolean;
}

/** A file-index failure must not hide the business record or its allowed actions. */
export async function evidenceFilesForDetail(
  project: () => Promise<LinkedEvidenceFile[]>,
): Promise<DetailEvidenceFiles> {
  try {
    return { evidence_files: await project(), evidence_files_unavailable: false };
  } catch (error) {
    console.warn("evidence_files_projection_unavailable",
      error instanceof EvidenceUploadError ? error.code : "store_unavailable");
    return { evidence_files: [], evidence_files_unavailable: true };
  }
}
export async function assertCurrentEvidenceReader(
  env: AppEnv, auth: AuthContext, roles?: readonly string[],
): Promise<string> {
  const user = await env.DB.prepare(`SELECT COALESCE(access_role, role) AS role FROM app_users
    WHERE tenant_id = ? AND user_id = ? AND active = 1`)
    .bind(auth.session.tenant_id, auth.session.user_id).first<{ role: string }>();
  if (!user || user.role !== auth.session.role || roles && !roles.includes(user.role)) {
    throw new EvidenceUploadError("evidence_read_role_required", 403);
  }
  return user.role;
}
export class EvidenceUploadError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status: number, details?: Record<string, unknown>) {
    super(code); this.code = code; this.status = status; this.details = details;
  }
}
export function evidenceUploadFailure(error: unknown): Response {
  if (error instanceof EvidenceUploadError) return json({ error: error.code, ...error.details }, error.status);
  if (error instanceof EvidencePrivacyLedgerUnavailable) {
    return json({ error: error.message, retryable: true }, 502);
  }
  if (error instanceof EvidencePrivacyMarkerConflict) return json({ error: error.message }, 409);
  return json({ error: "evidence_store_unavailable", retryable: true }, 502);
}
/** D1 may wrap a manifest or domain-link trigger refusal; unrelated store faults stay 502. */
export function isDisposedDomainLinkRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (message === "evidence_disposition_blocks_domain_link" || message === "evidence_disposition_blocks_manifest") return true;
  return /\b(?:SQLITE_CONSTRAINT|constraint failed|ABORT)\b/i.test(message)
    && /(?:^|[\s:])evidence_disposition_blocks_(?:domain_link|manifest)(?=[:\s]|$)/.test(message);
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
  if (!evidenceUploadsEnabled(env)) return json({ error: "evidence_uploads_disabled" }, 503);
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
    if (previous) await assertEvidenceAvailable(env, previous);
    // Claim before any RAW await, including the first read. Multiple exact attempts
    // may run, but disposal cannot start until every one has stopped writing.
    const writeClaim = previous ? null : await claimEvidenceUploadWrite(env, auth, receiptId, requestHash, r2Key);
    let putOutcomeKnown = true;
    try {
      // Check the independent marker under the claim, also when an old D1 restore
      // removed the receipt and disposition. Restore still requires writer quiescence.
      if (!previous && await externalEvidenceMarkerPresent(env, auth.session.tenant_id, receiptId)) {
        throw new EvidenceUploadError("evidence_privacy_reconciliation_required", 409);
      }
      const existing = await env.RAW.get(r2Key);
      if (existing && existing.customMetadata?.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
      if (!existing) {
        // A receipt makes this key immutable. An exact replay must not restore bytes that
        // a concurrent privacy disposition (or another loss) has removed.
        if (previous) {
          await assertEvidenceAvailable(env, previous);
          throw new EvidenceUploadError("evidence_object_missing", 409);
        }
        // An immutable key binds scope+bytes even when the following D1 insert fails.
        putOutcomeKnown = false;
        try {
          await env.RAW.put(r2Key, bytes, { sha256: digest, onlyIf: new Headers({ "If-None-Match": "*" }),
            httpMetadata: { contentType }, customMetadata: { sha256: digest, request_sha256: requestHash, immutable: "true" } });
          putOutcomeKnown = true;
        } catch {
          // A rejected provider promise is not proof that no write can complete.
          // Leave this attempt fenced; never delete bytes to compensate for it.
          try {
            await env.DB.prepare(`UPDATE evidence_upload_write_claims SET state = 'unknown',
              failure_code = 'raw_put_outcome_unknown', last_transition_at = ?
              WHERE claim_id = ? AND tenant_id = ? AND state = 'active'`)
              .bind(new Date().toISOString(), writeClaim, auth.session.tenant_id).run();
          } catch { console.warn("evidence_upload_write_unknown_state_unavailable", writeClaim); }
          throw new EvidenceUploadError("evidence_upload_write_outcome_unknown", 502, {
            retryable: false, exception: "provider_quiescence_evidence_required",
            claim_audit: evidenceUploadWriteClaimAuditPath(receiptId),
          });
        }
      }
      await assertStored(env, r2Key, file.size, contentType, digest, requestHash);
      if (previous) {
        await assertEvidenceAvailable(env, previous);
        return json({ result: "replayed", receipt: project(previous) });
      }
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
        await assertEvidenceAvailable(env, winner);
        return json({ result: "replayed", receipt: project(winner) });
      }
      await assertEvidenceAvailable(env, row);
      return json({ result: "stored", receipt: project(row) }, 201);
    } finally {
      // No later path in this attempt may PUT after this one-way settlement.
      // Unknown PUT outcomes and terminated requests retain their durable claim.
      if (writeClaim && putOutcomeKnown) {
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE evidence_upload_write_claims SET state = 'settled',
          settled_at = ?, last_transition_at = ? WHERE claim_id = ? AND tenant_id = ? AND state = 'active'`)
          .bind(now, now, writeClaim, auth.session.tenant_id).run();
        const settled = await env.DB.prepare("SELECT state FROM evidence_upload_write_claims WHERE claim_id = ? AND tenant_id = ?")
          .bind(writeClaim, auth.session.tenant_id).first<{ state: string }>();
        if (settled?.state !== "settled") throw new EvidenceUploadError("evidence_upload_write_settlement_unknown", 502);
      }
    }
  } catch (error) { return evidenceUploadFailure(error); }
}

export function evidenceUploadWriteClaimAuditPath(receiptId: string): string {
  return `/api/v1/privacy/evidence-uploads/write-claims?receipt_id=${receiptId}`;
}

/** This precheck explains refusals; the migration's triggers serialize the race. */
export async function assertNoPendingEvidenceUploadWrites(env: AppEnv, tenant: string, receiptId: string): Promise<void> {
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS pending,
    COALESCE(SUM(state = 'unknown'), 0) AS unknown FROM evidence_upload_write_claims
    WHERE tenant_id = ? AND receipt_id = ? AND state != 'settled'`)
    .bind(tenant, receiptId).first<{ pending: number; unknown: number }>();
  if (counts && counts.pending > 0) throw new EvidenceUploadError("evidence_upload_write_pending", 409, {
    pending_write_claims: counts.pending, unknown_write_claims: counts.unknown,
    claim_audit: evidenceUploadWriteClaimAuditPath(receiptId),
    exception: counts.unknown ? "provider_quiescence_evidence_required" : "upload_writers_not_settled",
  });
}

async function claimEvidenceUploadWrite(
  env: AppEnv, auth: AuthContext, receiptId: string, requestHash: string, r2Key: string,
): Promise<string> {
  const claimId = `ewc_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO evidence_upload_write_claims
      (claim_id, tenant_id, receipt_id, actor_user_id, request_sha256, r2_key, started_at, last_transition_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .bind(claimId, auth.session.tenant_id, receiptId, auth.session.user_id, requestHash, r2Key, now, now).run();
  } catch (error) {
    const current = await receipt(env, auth.session.tenant_id, receiptId);
    if (current) {
      if (current.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
      await assertEvidenceAvailable(env, current);
    } else if (await externalEvidenceMarkerPresent(env, auth.session.tenant_id, receiptId)) {
      throw new EvidenceUploadError("evidence_privacy_reconciliation_required", 409);
    }
    const unknown = await env.DB.prepare(`SELECT state FROM evidence_upload_write_claims
      WHERE tenant_id = ? AND receipt_id = ? AND state = 'unknown' LIMIT 1`)
      .bind(auth.session.tenant_id, receiptId).first();
    if (unknown) throw new EvidenceUploadError("evidence_upload_write_outcome_unknown", 409, {
      retryable: false, exception: "provider_quiescence_evidence_required",
      claim_audit: evidenceUploadWriteClaimAuditPath(receiptId),
    });
    const pinned = await env.DB.prepare(`SELECT request_sha256 FROM evidence_upload_write_claims
      WHERE receipt_id = ? LIMIT 1`).bind(receiptId).first<{ request_sha256: string }>();
    if (pinned && pinned.request_sha256 !== requestHash) throw new EvidenceUploadError("evidence_upload_conflict", 409);
    throw error;
  }
  return claimId;
}

/** Resolve all files before a domain mutation. Digest/refs are derived exclusively from D1 + R2. */
export async function resolveEvidenceUploads(env: AppEnv, auth: AuthContext, scope: EvidenceScope, ids: unknown): Promise<{
  refs: Array<{ ref: string; sha256: string }>;
  refsJson: string;
  sha256: string;
}> {
  if (!evidenceUploadsEnabled(env)) throw new EvidenceUploadError("evidence_uploads_disabled", 503);
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
    await assertEvidenceAvailable(env, row);
    await assertStored(env, row.r2_key, row.byte_size, row.content_type, row.sha256, row.request_sha256);
    await assertEvidenceAvailable(env, row);
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
  for (const id of ids) {
    const row = await receipt(env, auth.session.tenant_id, id);
    if (!row) throw new EvidenceUploadError("evidence_receipt_not_found", 404);
    await assertEvidenceAvailable(env, row);
  }
  return { refs, refsJson, sha256: digest };
}

/** Read metadata only from receipts referenced by a persisted business fact. */
export async function linkedEvidenceFilesForRefs(
  env: AppEnv, tenant: string, refsJson: string | null,
  expected: Partial<EvidenceScope>,
): Promise<LinkedEvidenceFile[]> {
  if (refsJson === null) return [];
  let refs: unknown;
  try { refs = JSON.parse(refsJson); }
  catch { throw new EvidenceUploadError("evidence_link_invalid", 502); }
  if (!Array.isArray(refs)) throw new EvidenceUploadError("evidence_link_invalid", 502);
  const files: LinkedEvidenceFile[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) ||
        typeof ref.ref !== "string" || typeof ref.sha256 !== "string") {
      throw new EvidenceUploadError("evidence_link_invalid", 502);
    }
    if (!ref.ref.startsWith("evidence-upload://")) continue; // historical syntactic evidence
    const id = ref.ref.slice("evidence-upload://".length);
    if (!RECEIPT_ID.test(id) || seen.has(id)) throw new EvidenceUploadError("evidence_link_invalid", 502);
    seen.add(id);
    const row = await receipt(env, tenant, id);
    if (!row || row.sha256 !== ref.sha256 ||
        (expected.purpose !== undefined && row.purpose !== expected.purpose) ||
        (expected.targetId !== undefined && row.target_id !== expected.targetId) ||
        (expected.action !== undefined && row.action !== expected.action) ||
        (expected.operationId !== undefined && row.operation_id !== expected.operationId)) {
      throw new EvidenceUploadError("evidence_link_invalid", 502);
    }
    files.push(fileMetadata(row));
  }
  return files;
}

/** Every service manifest must be reached from a recorded case event or claim. */
export async function linkedServiceEvidenceFiles(env: AppEnv, tenant: string, caseId: string): Promise<LinkedEvidenceFile[]> {
  const events = await env.DB.prepare(`SELECT evidence_digest AS digest FROM service_case_events
    WHERE tenant_id = ? AND service_case_id = ? AND evidence_digest IS NOT NULL ORDER BY event_id`)
    .bind(tenant, caseId).all<{ digest: string }>();
  const claims = await env.DB.prepare(`SELECT evidence_digest AS digest FROM service_cost_recovery_claims
    WHERE tenant_id = ? AND service_case_id = ? ORDER BY created_at, claim_id`)
    .bind(tenant, caseId).all<{ digest: string }>();
  const files: LinkedEvidenceFile[] = [];
  const seen = new Set<string>();
  for (const digest of new Set([...events.results, ...claims.results].map((row) => row.digest))) {
    const manifest = await env.DB.prepare(`SELECT purpose, target_id, action, operation_id, refs_json
      FROM evidence_upload_manifests WHERE tenant_id = ? AND sha256 = ?`)
      .bind(tenant, digest).first<{ purpose: EvidenceScope["purpose"]; target_id: string; action: string; operation_id: string; refs_json: string }>();
    if (!manifest) continue; // historical digest without uploaded files
    if (manifest.purpose !== "service_intake" && manifest.purpose !== "service_step") {
      throw new EvidenceUploadError("evidence_link_invalid", 502);
    }
    const linked = await linkedEvidenceFilesForRefs(env, tenant, manifest.refs_json, {
      purpose: manifest.purpose, targetId: manifest.target_id,
      action: manifest.action, operationId: manifest.operation_id,
    });
    for (const file of linked) if (!seen.has(file.receipt_id)) {
      seen.add(file.receipt_id);
      files.push(file);
    }
  }
  return files;
}

/** Private, linked-only content read. A receipt alone never grants file access. */
export async function handleEvidenceContentRead(env: AppEnv, auth: AuthContext, id: string): Promise<Response> {
  if (!RECEIPT_ID.test(id)) return json({ error: "not_found" }, 404);
  try {
    const tenant = auth.session.tenant_id;
    const role = await assertCurrentEvidenceReader(env, auth);
    const row = await receipt(env, tenant, id);
    if (!row) return json({ error: "not_found" }, 404);
    let files: LinkedEvidenceFile[];
    switch (row.purpose) {
      case "stock": {
        if (!["owner", "ops", "production", "field"].includes(role)) throw new EvidenceUploadError("evidence_read_role_required", 403);
        const command = await env.DB.prepare(`SELECT transition, evidence_refs_json FROM inventory_commands
          WHERE tenant_id = ? AND command_id = ? AND status = 'applied'`)
          .bind(tenant, row.operation_id).first<{ transition: string; evidence_refs_json: string }>();
        files = command ? await linkedEvidenceFilesForRefs(env, tenant, command.evidence_refs_json,
          { purpose: "stock", action: command.transition, operationId: row.operation_id }) : [];
        break;
      }
      case "service_intake":
      case "service_step":
        if (!["owner", "ops"].includes(role)) throw new EvidenceUploadError("evidence_read_role_required", 403);
        // Intake targets a roof job, while later steps target a case. The manifest digest
        // on the case event is the durable association in both cases.
        if (row.purpose === "service_intake") {
          const cases = await env.DB.prepare(`SELECT service_case_id FROM service_cases
            WHERE tenant_id = ? AND roof_job_id = ? AND intake_evidence_digest IN
              (SELECT sha256 FROM evidence_upload_manifests WHERE tenant_id = ? AND purpose = 'service_intake' AND target_id = ?)`)
            .bind(tenant, row.target_id, tenant, row.target_id).all<{ service_case_id: string }>();
          files = [];
          for (const serviceCase of cases.results) {
            files.push(...await linkedServiceEvidenceFiles(env, tenant, serviceCase.service_case_id));
          }
        } else {
          files = await linkedServiceEvidenceFiles(env, tenant, row.target_id);
        }
        break;
      case "corrective_action": {
        const action = await env.DB.prepare(`SELECT evidence_refs_json FROM safety_corrective_actions
          WHERE tenant_id = ? AND corrective_action_id = ? AND state IN ('evidence_submitted', 'verified', 'closed')`)
          .bind(tenant, row.target_id).first<{ evidence_refs_json: string | null }>();
        files = action ? await linkedEvidenceFilesForRefs(env, tenant, action.evidence_refs_json,
          { purpose: "corrective_action", targetId: row.target_id, action: "submit", operationId: "" }) : [];
        break;
      }
    }
    if (!files.some((file) => file.receipt_id === id)) return json({ error: "not_found" }, 404);
    // Disposal requires no business link, so a linked receipt is normally available; this also
    // refuses a pending, destroyed or restore-quarantined receipt whose link a D1 restore revived.
    await assertEvidenceAvailable(env, row);
    const bytes = await readStored(env, row.r2_key, row.byte_size, row.content_type, row.sha256, row.request_sha256);
    return new Response(bytes, { status: 200, headers: {
      "cache-control": "private, no-store",
      "content-type": row.content_type,
      "content-length": String(row.byte_size),
      "content-disposition": `attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(row.file_name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "x-content-type-options": "nosniff",
    } });
  } catch (error) { return evidenceUploadFailure(error); }
}

function fileMetadata(row: EvidenceUploadReceipt): LinkedEvidenceFile {
  return { receipt_id: row.receipt_id, file_name: row.file_name,
    content_type: row.content_type, byte_size: row.byte_size };
}
async function receipt(env: AppEnv, tenant: string, id: string): Promise<EvidenceUploadReceipt | null> {
  return env.DB.prepare("SELECT * FROM evidence_upload_receipts WHERE tenant_id = ? AND receipt_id = ?").bind(tenant, id).first<EvidenceUploadReceipt>();
}
export async function assertEvidenceAvailable(env: AppEnv, row: EvidenceUploadReceipt): Promise<void> {
  const state = await evidenceDispositionState(env, row.tenant_id, row.receipt_id);
  if (state === "destroyed") throw new EvidenceUploadError("evidence_destroyed", 410);
  if (state === "quarantined") throw new EvidenceUploadError("evidence_privacy_reconciliation_required", 409);
  if (state) throw new EvidenceUploadError("evidence_destruction_pending", 409);
}
async function assertStored(env: AppEnv, key: string, size: number, type: string, hash: string, requestHash: string): Promise<void> {
  await readStored(env, key, size, type, hash, requestHash);
}
async function readStored(env: AppEnv, key: string, size: number, type: string, hash: string, requestHash: string): Promise<ArrayBuffer> {
  const object = await env.RAW.get(key);
  if (!object) throw new EvidenceUploadError("evidence_object_missing", 409);
  if (size > MAX_EVIDENCE_FILE_BYTES || object.size !== size || object.httpMetadata?.contentType !== type ||
      object.customMetadata?.sha256 !== hash || object.customMetadata?.request_sha256 !== requestHash) {
    throw new EvidenceUploadError("evidence_object_mismatch", 409);
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== size || await binarySha256(bytes) !== hash) throw new EvidenceUploadError("evidence_object_mismatch", 409);
  return bytes;
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
