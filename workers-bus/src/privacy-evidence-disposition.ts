import { validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { assertNoPendingEvidenceUploadWrites, EvidenceUploadError, evidenceUploadFailure, type EvidenceUploadReceipt } from "./evidence-uploads.ts";
import { assertExternalEvidenceMarkerCompatible, assertExternalEvidenceMarkerUnchanged,
  ensureExternalEvidenceMarker, EvidencePrivacyMarkerConflict, externalEvidenceMarkerPresent,
  readExternalEvidenceMarker, type EvidencePrivacyMarker } from "./evidence-privacy-ledger.ts";
import { assertCurrentOwner, inspectBusinessLinks } from "./privacy-evidence-audit.ts";

const RECEIPT_PATH = /^\/api\/v1\/privacy\/evidence-uploads\/(evu_[0-9a-f]{64})\/(holds|destruction|reconciliation)$/;
const RELEASE_PATH = /^\/api\/v1\/privacy\/evidence-uploads\/(evu_[0-9a-f]{64})\/holds\/([A-Za-z0-9][A-Za-z0-9._:-]{7,119})\/release$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const POLICY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;
const SHA256 = /^[0-9a-f]{64}$/;
type Basis = "subject_request" | "approved_retention" | "manual_correction";
interface Disposition {
  receipt_id: string;
  tenant_id: string;
  decision_id: string;
  basis: Basis;
  authority_ref: string;
  policy_version: string;
  reason: string;
  requested_by: string;
  state: "destroying" | "failed" | "destroyed";
  reappearance_detected_at: string | null;
  reappearance_reverified_at: string | null;
}

/** Explicit owner action only. No retention schedule or automatic deletion is inferred here. */
export async function handlePrivacyEvidenceDispositionRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const action = path.match(RECEIPT_PATH);
  const release = path.match(RELEASE_PATH);
  if (!action && !release) return null;
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  try {
    await assertCurrentOwner(env, auth);
    const receipt = await readReceipt(env, auth.session.tenant_id, (action ?? release)![1]!);
    if (!receipt) return json({ error: "not_found" }, 404);
    const body = await boundedJson(req);
    if (release) return await releaseHold(env, auth, receipt, release[2]!, body);
    if (action![2] === "holds") return await createHold(env, auth, receipt, body);
    if (action![2] === "reconciliation") return await reconcile(env, auth, receipt, body);
    return await destroy(env, auth, receipt, body);
  } catch (error) { return evidenceUploadFailure(error); }
}

async function createHold(env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["hold_id", "reason"]);
  const id = token(body.hold_id);
  const reason = narrative(body.reason);
  const existing = await env.DB.prepare("SELECT * FROM evidence_upload_holds WHERE hold_id = ?")
    .bind(id).first<{ tenant_id: string; receipt_id: string; created_by: string; reason: string; active: number }>();
  if (existing) {
    if (existing.tenant_id !== receipt.tenant_id || existing.receipt_id !== receipt.receipt_id ||
      existing.created_by !== auth.session.user_id || existing.reason !== reason) throw new EvidenceUploadError("evidence_hold_conflict", 409);
    return json({ hold_id: id, state: existing.active ? "active" : "released", result: "replayed" });
  }
  const disposition = await readDisposition(env, receipt);
  if (disposition && disposition.state !== "failed") throw new EvidenceUploadError("evidence_destruction_pending", 409);
  if (!disposition && await externalEvidenceMarkerPresent(env, receipt.tenant_id, receipt.receipt_id)) {
    throw new EvidenceUploadError("evidence_privacy_reconciliation_required", 409);
  }
  try {
    await env.DB.prepare(`INSERT INTO evidence_upload_holds
      (hold_id, tenant_id, receipt_id, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, receipt.tenant_id, receipt.receipt_id, reason, auth.session.user_id, new Date().toISOString()).run();
  } catch (error) {
    const winner = await env.DB.prepare("SELECT tenant_id, receipt_id, created_by, reason, active FROM evidence_upload_holds WHERE hold_id = ?")
      .bind(id).first<{ tenant_id: string; receipt_id: string; created_by: string; reason: string; active: number }>();
    if (winner && winner.tenant_id === receipt.tenant_id && winner.receipt_id === receipt.receipt_id &&
      winner.created_by === auth.session.user_id && winner.reason === reason) {
      return json({ hold_id: id, state: winner.active ? "active" : "released", result: "replayed" });
    }
    const state = await readDisposition(env, receipt);
    if (state && state.state !== "failed") throw new EvidenceUploadError("evidence_destruction_pending", 409);
    throw error;
  }
  return json({ hold_id: id, state: "active", result: "created" }, 201);
}

async function releaseHold(env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt, id: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["reason"]);
  const reason = narrative(body.reason);
  const hold = await env.DB.prepare("SELECT * FROM evidence_upload_holds WHERE hold_id = ? AND tenant_id = ? AND receipt_id = ?")
    .bind(id, receipt.tenant_id, receipt.receipt_id).first<{ active: number; released_by: string | null; release_reason: string | null }>();
  if (!hold) return json({ error: "not_found" }, 404);
  if (!hold.active) {
    if (hold.released_by !== auth.session.user_id || hold.release_reason !== reason) throw new EvidenceUploadError("evidence_hold_conflict", 409);
    return json({ hold_id: id, state: "released", result: "replayed" });
  }
  await env.DB.prepare(`UPDATE evidence_upload_holds SET active = 0, released_by = ?,
    release_reason = ?, released_at = ? WHERE hold_id = ? AND tenant_id = ? AND receipt_id = ? AND active = 1`)
    .bind(auth.session.user_id, reason, new Date().toISOString(), id, receipt.tenant_id, receipt.receipt_id).run();
  const released = await env.DB.prepare("SELECT active, released_by, release_reason FROM evidence_upload_holds WHERE hold_id = ? AND tenant_id = ? AND receipt_id = ?")
    .bind(id, receipt.tenant_id, receipt.receipt_id).first<{ active: number; released_by: string | null; release_reason: string | null }>();
  if (released?.active !== 0 || released.released_by !== auth.session.user_id || released.release_reason !== reason) {
    throw new EvidenceUploadError("evidence_hold_conflict", 409);
  }
  return json({ hold_id: id, state: "released", result: "released" });
}

/** A new owner decision authorizes re-purging; it never claims to recreate the lost D1 text. */
async function reconcile(env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt,
  body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["decision_id", "marker_decision_id", "reason", "expected_sha256"]);
  const decisionId = token(body.decision_id);
  const markerDecisionId = token(body.marker_decision_id);
  const reason = narrative(body.reason);
  if (typeof body.expected_sha256 !== "string" || !SHA256.test(body.expected_sha256) ||
      body.expected_sha256 !== receipt.sha256) {
    throw new EvidenceUploadError("evidence_destruction_receipt_changed", 409);
  }
  const marker = await readExternalEvidenceMarker(env, receipt.tenant_id, receipt.receipt_id);
  if (!marker) throw new EvidenceUploadError("evidence_privacy_reconciliation_not_required", 409);
  if (marker.receipt_sha256 !== receipt.sha256 || marker.r2_key !== receipt.r2_key) {
    throw new EvidencePrivacyMarkerConflict();
  }
  if (marker.decision_id !== markerDecisionId || marker.decision_id === decisionId) {
    throw new EvidenceUploadError("evidence_destruction_conflict", 409);
  }
  return await destroy(env, auth, receipt, {
    decision_id: decisionId, basis: "manual_correction",
    authority_ref: `restore-marker:${marker.decision_sha256}`,
    policy_version: "manual-v1", reason, expected_sha256: body.expected_sha256,
  }, marker);
}

async function destroy(env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt,
  body: Record<string, unknown>, reconciliationMarker?: EvidencePrivacyMarker): Promise<Response> {
  exactKeys(body, ["decision_id", "basis", "authority_ref", "policy_version", "reason", "expected_sha256"]);
  const decisionId = token(body.decision_id);
  const basis = body.basis;
  if (typeof basis !== "string" || !["subject_request", "approved_retention", "manual_correction"].includes(basis)) {
    throw new EvidenceUploadError("evidence_destruction_basis_invalid", 400);
  }
  // DSAR identity proof and retention schedules are not yet approved in D1. Only an
  // explicit owner correction of an upload with no durable domain record is enabled.
  if (basis !== "manual_correction") throw new EvidenceUploadError("evidence_policy_not_approved", 409);
  const authorityRef = token(body.authority_ref);
  const policyVersion = typeof body.policy_version === "string" && POLICY.test(body.policy_version) ? body.policy_version : "";
  if (policyVersion !== "manual-v1") throw new EvidenceUploadError("evidence_policy_version_invalid", 400);
  const reason = narrative(body.reason);
  if (typeof body.expected_sha256 !== "string" || !SHA256.test(body.expected_sha256) || body.expected_sha256 !== receipt.sha256) {
    throw new EvidenceUploadError("evidence_destruction_receipt_changed", 409);
  }
  const proposed = { decision_id: decisionId, basis: basis as Basis, authority_ref: authorityRef,
    policy_version: policyVersion, reason, requested_by: auth.session.user_id };
  let current = await readDisposition(env, receipt);
  if (current && !sameDecision(current, proposed)) throw new EvidenceUploadError("evidence_destruction_conflict", 409);
  if (!current) {
    if (reconciliationMarker) await assertExternalEvidenceMarkerUnchanged(env, receipt, reconciliationMarker);
    else await assertExternalEvidenceMarkerCompatible(env, receipt, proposed);
    if (await hasActiveHold(env, receipt)) throw new EvidenceUploadError("evidence_legal_hold_active", 409);
    if ((await inspectBusinessLinks(env, receipt)).durable) {
      throw new EvidenceUploadError("evidence_business_record_linked", 409);
    }
  }
  if (await hasActiveHold(env, receipt)) throw new EvidenceUploadError("evidence_legal_hold_active", 409);
  await assertNoPendingEvidenceUploadWrites(env, receipt.tenant_id, receipt.receipt_id);
  const now = new Date().toISOString();
  if (!current) {
    try {
      await env.DB.prepare(`INSERT INTO evidence_upload_dispositions
        (receipt_id, tenant_id, decision_id, basis, authority_ref, policy_version, reason,
          requested_by, requested_at, last_actor_user_id, last_transition_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'destroying')`)
        .bind(receipt.receipt_id, receipt.tenant_id, decisionId, basis, authorityRef, policyVersion,
          reason, auth.session.user_id, now, auth.session.user_id, now).run();
    } catch (error) {
      current = await readDisposition(env, receipt);
      if (!current) {
        if (await hasActiveHold(env, receipt)) throw new EvidenceUploadError("evidence_legal_hold_active", 409);
        await assertNoPendingEvidenceUploadWrites(env, receipt.tenant_id, receipt.receipt_id);
        if ((await inspectBusinessLinks(env, receipt)).durable) {
          throw new EvidenceUploadError("evidence_business_record_linked", 409);
        }
        throw error;
      }
      if (!sameDecision(current, proposed)) throw new EvidenceUploadError("evidence_destruction_conflict", 409);
    }
  }
  if (current?.state === "failed") {
    await env.DB.prepare(`UPDATE evidence_upload_dispositions SET state = 'destroying',
      failure_code = NULL, last_actor_user_id = ?, last_transition_at = ?
      WHERE tenant_id = ? AND receipt_id = ? AND state = 'failed'
        AND NOT EXISTS (SELECT 1 FROM evidence_upload_holds WHERE tenant_id = ? AND receipt_id = ? AND active = 1)`)
      .bind(auth.session.user_id, now, receipt.tenant_id, receipt.receipt_id, receipt.tenant_id, receipt.receipt_id).run();
    if ((await readDisposition(env, receipt))?.state !== "destroying") {
      throw new EvidenceUploadError("evidence_legal_hold_active", 409);
    }
  }
  // The D1 decision and triggers first stop concurrent manifest or domain links. The external
  // marker is then required before any RAW deletion; an older D1 restore loses
  // neither completed disposal nor a marker already written.
  if (reconciliationMarker) await assertExternalEvidenceMarkerUnchanged(env, receipt, reconciliationMarker);
  else await ensureExternalEvidenceMarker(env, receipt, proposed);
  // A restore or provider anomaly between the D1 insert and marker write must
  // not let this request delete RAW against a missing or changed D1 decision.
  const decisionAfterMarker = await readDisposition(env, receipt);
  if (!decisionAfterMarker || !sameDecision(decisionAfterMarker, proposed)) {
    throw new EvidenceUploadError("evidence_destruction_settlement_unknown", 502);
  }
  await assertNoPendingEvidenceUploadWrites(env, receipt.tenant_id, receipt.receipt_id);
  if (current?.state === "destroyed") {
    return await reverifyDestroyedReceipt(env, auth, receipt, decisionAfterMarker);
  }
  try {
    await env.RAW.delete(receipt.r2_key);
    if (await env.RAW.head(receipt.r2_key)) {
      await markFailure(env, auth, receipt, "r2_delete_readback_present");
      throw new EvidenceUploadError("evidence_destruction_readback_present", 502);
    }
  } catch (error) {
    if (!(error instanceof EvidenceUploadError)) {
      await markFailure(env, auth, receipt, "r2_delete_or_readback_unavailable");
      throw new EvidenceUploadError("evidence_store_unavailable", 502);
    }
    throw error;
  }
  const verifiedAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE evidence_upload_dispositions SET state = 'destroyed', verified_at = ?,
    last_actor_user_id = ?, last_transition_at = ? WHERE tenant_id = ? AND receipt_id = ? AND state = 'destroying'`)
    .bind(verifiedAt, auth.session.user_id, verifiedAt, receipt.tenant_id, receipt.receipt_id).run();
  if ((await readDisposition(env, receipt))?.state !== "destroyed") {
    throw new EvidenceUploadError("evidence_destruction_settlement_unknown", 502);
  }
  return json({ receipt_id: receipt.receipt_id, state: "destroyed",
    result: reconciliationMarker ? "reconciled" : "verified" });
}

/** A D1 disposition always blocks reads; this resumes removal if a restore put the bytes back. */
async function reverifyDestroyedReceipt(
  env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt, current: Disposition,
): Promise<Response> {
  const present = await env.RAW.head(receipt.r2_key);
  const pending = current.reappearance_detected_at !== null && current.reappearance_reverified_at === null;
  if (!present && !pending) {
    return json({ receipt_id: receipt.receipt_id, state: "destroyed", result: "replayed" });
  }
  if (present && !pending) {
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE evidence_upload_dispositions
      SET reappearance_detected_at = ?, reappearance_reverified_at = NULL,
        last_actor_user_id = ?, last_transition_at = ?
      WHERE tenant_id = ? AND receipt_id = ? AND state = 'destroyed'
        AND (reappearance_detected_at IS NULL OR reappearance_reverified_at IS NOT NULL)`)
      .bind(now, auth.session.user_id, now, receipt.tenant_id, receipt.receipt_id).run();
  }
  const detected = await readDisposition(env, receipt);
  if (detected?.state !== "destroyed" || detected.reappearance_detected_at === null) {
    throw new EvidenceUploadError("evidence_destruction_settlement_unknown", 502);
  }
  try {
    if (present) await env.RAW.delete(receipt.r2_key);
    if (await env.RAW.head(receipt.r2_key)) {
      throw new EvidenceUploadError("evidence_destruction_readback_present", 502);
    }
  } catch (error) {
    if (error instanceof EvidenceUploadError) throw error;
    throw new EvidenceUploadError("evidence_store_unavailable", 502);
  }
  if (detected.reappearance_reverified_at === null) {
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE evidence_upload_dispositions
      SET reappearance_reverified_at = ?, last_actor_user_id = ?, last_transition_at = ?
      WHERE tenant_id = ? AND receipt_id = ? AND state = 'destroyed'
        AND reappearance_detected_at IS NOT NULL AND reappearance_reverified_at IS NULL`)
      .bind(now, auth.session.user_id, now, receipt.tenant_id, receipt.receipt_id).run();
  }
  const settled = await readDisposition(env, receipt);
  if (settled?.state !== "destroyed" || settled.reappearance_reverified_at === null) {
    throw new EvidenceUploadError("evidence_destruction_settlement_unknown", 502);
  }
  return json({ receipt_id: receipt.receipt_id, state: "destroyed", result: "reverified" });
}

async function markFailure(env: AppEnv, auth: AuthContext, receipt: EvidenceUploadReceipt, code: string): Promise<void> {
  await env.DB.prepare(`UPDATE evidence_upload_dispositions SET state = 'failed', failure_code = ?,
    last_actor_user_id = ?, last_transition_at = ? WHERE tenant_id = ? AND receipt_id = ? AND state = 'destroying'`)
    .bind(code, auth.session.user_id, new Date().toISOString(), receipt.tenant_id, receipt.receipt_id).run();
}
async function readReceipt(env: AppEnv, tenantId: string, id: string): Promise<EvidenceUploadReceipt | null> {
  return env.DB.prepare("SELECT * FROM evidence_upload_receipts WHERE tenant_id = ? AND receipt_id = ?")
    .bind(tenantId, id).first<EvidenceUploadReceipt>();
}
async function readDisposition(env: AppEnv, receipt: EvidenceUploadReceipt): Promise<Disposition | null> {
  return env.DB.prepare("SELECT * FROM evidence_upload_dispositions WHERE tenant_id = ? AND receipt_id = ?")
    .bind(receipt.tenant_id, receipt.receipt_id).first<Disposition>();
}
async function hasActiveHold(env: AppEnv, receipt: EvidenceUploadReceipt): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT 1 FROM evidence_upload_holds
    WHERE tenant_id = ? AND receipt_id = ? AND active = 1 LIMIT 1`)
    .bind(receipt.tenant_id, receipt.receipt_id).first();
}
function sameDecision(current: Disposition, proposed: Pick<Disposition,
  "decision_id" | "basis" | "authority_ref" | "policy_version" | "reason" | "requested_by">): boolean {
  return Object.entries(proposed).every(([key, value]) => current[key as keyof Disposition] === value);
}
function exactKeys(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key))) {
    throw new EvidenceUploadError("privacy_request_invalid", 400);
  }
}
function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new EvidenceUploadError("privacy_request_invalid", 400);
  return value;
}
function narrative(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 500 || /[\u0000-\u001f]/.test(value)) {
    throw new EvidenceUploadError("privacy_request_invalid", 400);
  }
  return value.trim();
}
async function boundedJson(req: Request): Promise<Record<string, unknown>> {
  const max = 4096;
  if (Number(req.headers.get("content-length") ?? 0) > max || !req.body) throw new EvidenceUploadError("privacy_request_invalid", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new EvidenceUploadError("privacy_request_invalid", 400); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new EvidenceUploadError("privacy_request_invalid", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvidenceUploadError("privacy_request_invalid", 400);
  return value as Record<string, unknown>;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
  } });
}
