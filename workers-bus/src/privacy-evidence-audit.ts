import type { AppEnv, AuthContext } from "./app-types.ts";
import { externalEvidenceMarkerPresent, listExternalEvidenceMarkers, readExternalEvidenceMarker } from "./evidence-privacy-ledger.ts";
import {
  binarySha256,
  EvidenceUploadError,
  evidenceUploadFailure,
  type EvidenceUploadReceipt,
} from "./evidence-uploads.ts";

const RECEIPT_ID = /^evu_[0-9a-f]{64}$/;
const MAX_PAGE_SIZE = 50;

/** Owner-only inventory of upload receipts. A manifest alone is not an accepted business link. */
export async function handlePrivacyEvidenceAuditRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const list = url.pathname === "/api/v1/privacy/evidence-uploads";
  const markerList = url.pathname === "/api/v1/privacy/evidence-uploads/markers";
  const writeClaims = url.pathname === "/api/v1/privacy/evidence-uploads/write-claims";
  const detail = url.pathname.match(/^\/api\/v1\/privacy\/evidence-uploads\/(evu_[0-9a-f]{64})\/audit$/);
  if (!list && !markerList && !writeClaims && !detail) return null;
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  try {
    await assertCurrentOwner(env, auth);
    const tenant = auth.session.tenant_id;
    if (writeClaims) {
      const receiptId = url.searchParams.get("receipt_id") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      const rawLimit = url.searchParams.get("limit") ?? "20";
      if (receiptId && !RECEIPT_ID.test(receiptId)) throw new EvidenceUploadError("privacy_receipt_invalid", 400);
      if (cursor && !/^ewc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor)) {
        throw new EvidenceUploadError("privacy_cursor_invalid", 400);
      }
      if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > MAX_PAGE_SIZE) {
        throw new EvidenceUploadError("privacy_limit_invalid", 400);
      }
      const limit = Number(rawLimit);
      const page = await env.DB.prepare(`SELECT claim_id, receipt_id, actor_user_id, request_sha256,
        r2_key, state, failure_code, started_at, last_transition_at, settled_at
        FROM evidence_upload_write_claims WHERE tenant_id = ? AND state != 'settled'
          AND (? = '' OR receipt_id = ?) AND claim_id > ? ORDER BY claim_id LIMIT ?`)
        .bind(tenant, receiptId, receiptId, cursor, limit + 1)
        .all<{ claim_id: string; receipt_id: string; state: string }>();
      const claims = page.results.slice(0, limit);
      return json({ version: 1, claims, automatic_expiry: false,
        next_cursor: page.results.length > limit ? claims.at(-1)?.claim_id ?? null : null });
    }
    if (markerList) {
      const rawLimit = url.searchParams.get("limit") ?? "20";
      const cursor = url.searchParams.get("cursor") ?? "";
      if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > MAX_PAGE_SIZE) {
        throw new EvidenceUploadError("privacy_limit_invalid", 400);
      }
      // R2 cursors are opaque. Bound their size and reject control characters,
      // while the server always supplies the current tenant's prefix.
      if (cursor.length > 2048 || /[\x00-\x20\x7f]/.test(cursor)) {
        throw new EvidenceUploadError("privacy_cursor_invalid", 400);
      }
      const page = await listExternalEvidenceMarkers(env, tenant, Number(rawLimit), cursor || undefined);
      const markers = [];
      for (const marker of page.markers) {
        const receipt = await env.DB.prepare(`SELECT sha256, r2_key FROM evidence_upload_receipts
          WHERE tenant_id = ? AND receipt_id = ?`).bind(tenant, marker.receipt_id)
          .first<{ sha256: string; r2_key: string }>();
        const disposition = await env.DB.prepare(`SELECT state FROM evidence_upload_dispositions
          WHERE tenant_id = ? AND receipt_id = ?`).bind(tenant, marker.receipt_id)
          .first<{ state: string }>();
        let rawObject: R2Object | null;
        try { rawObject = await env.RAW.head(marker.r2_key); }
        catch { throw new EvidenceUploadError("evidence_store_unavailable", 502); }
        markers.push({ receipt_id: marker.receipt_id, marker_decision_id: marker.decision_id,
          d1_receipt: !receipt ? "missing" : receipt.sha256 === marker.receipt_sha256 &&
            receipt.r2_key === marker.r2_key ? "matches" : "mismatch",
          d1_disposition_state: disposition?.state ?? null,
          raw_object_present: rawObject !== null });
      }
      return json({ version: 1, markers, marker_issues: page.issues,
        marker_entries_valid: page.issues.length === 0, next_cursor: page.nextCursor });
    }
    if (list) {
      const cursor = url.searchParams.get("cursor") ?? "";
      const rawLimit = url.searchParams.get("limit") ?? "20";
      if (cursor && !RECEIPT_ID.test(cursor)) throw new EvidenceUploadError("privacy_cursor_invalid", 400);
      if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > MAX_PAGE_SIZE) {
        throw new EvidenceUploadError("privacy_limit_invalid", 400);
      }
      const limit = Number(rawLimit);
      const page = await env.DB.prepare(`SELECT receipt.receipt_id, receipt.actor_user_id, receipt.purpose,
        receipt.target_id, receipt.action, receipt.operation_id, receipt.file_name,
        receipt.content_type, receipt.byte_size, receipt.created_at,
        COALESCE(disposition.state, 'available') AS disposition_state FROM evidence_upload_receipts AS receipt
        LEFT JOIN evidence_upload_dispositions AS disposition ON disposition.receipt_id = receipt.receipt_id
          AND disposition.tenant_id = receipt.tenant_id
        WHERE receipt.tenant_id = ? AND receipt.receipt_id > ? ORDER BY receipt.receipt_id LIMIT ?`)
        .bind(tenant, cursor, limit + 1)
        .all<Pick<EvidenceUploadReceipt, "receipt_id" | "actor_user_id" | "purpose" | "target_id" |
          "action" | "operation_id" | "file_name" | "content_type" | "byte_size" | "created_at">>();
      const receipts = [];
      const rows = page.results.slice(0, limit) as Array<(typeof page.results)[number] & { disposition_state: string }>;
      // Bound the owner-only R2 lookups; a D1 rollback must not label a marked
      // receipt "available" in the privacy inventory.
      for (let index = 0; index < rows.length; index += 5) {
        receipts.push(...await Promise.all(rows.slice(index, index + 5).map(async (row) => ({
          ...row,
          disposition_state: row.disposition_state === "available" &&
            await externalEvidenceMarkerPresent(env, tenant, row.receipt_id)
            ? "quarantined" : row.disposition_state,
        }))));
      }
      return json({ version: 1, receipts,
        next_cursor: page.results.length > limit ? receipts.at(-1)?.receipt_id ?? null : null });
    }
    const id = detail![1]!;
    const receipt = await env.DB.prepare("SELECT * FROM evidence_upload_receipts WHERE tenant_id = ? AND receipt_id = ?")
      .bind(tenant, id).first<EvidenceUploadReceipt>();
    if (!receipt) return json({ error: "not_found" }, 404);
    const links = await inspectBusinessLinks(env, receipt);
    const disposition = await env.DB.prepare(`SELECT state, reappearance_detected_at,
      reappearance_reverified_at FROM evidence_upload_dispositions
      WHERE tenant_id = ? AND receipt_id = ?`)
      .bind(tenant, id).first<{ state: string; reappearance_detected_at: string | null;
        reappearance_reverified_at: string | null }>();
    const externalMarker = await readExternalEvidenceMarker(env, tenant, id);
    const dispositionState = disposition?.state ?? (externalMarker ? "quarantined" : "available");
    const activeHolds = await env.DB.prepare(`SELECT count(*) AS count FROM evidence_upload_holds
      WHERE tenant_id = ? AND receipt_id = ? AND active = 1`)
      .bind(tenant, id).first<{ count: number }>();
    const objectStatus = await inspectObject(env, receipt);
    const events = await env.DB.prepare(`SELECT event_id, kind, actor_user_id, authority_ref,
      decision_id, reason, recorded_at FROM evidence_upload_privacy_events
      WHERE tenant_id = ? AND receipt_id = ? ORDER BY recorded_at DESC, event_id DESC LIMIT 50`)
      .bind(tenant, id).all();
    return json({ version: 1, receipt_id: receipt.receipt_id, purpose: receipt.purpose,
      target_id: receipt.target_id, actor_user_id: receipt.actor_user_id,
      file_name: receipt.file_name, content_type: receipt.content_type, byte_size: receipt.byte_size,
      created_at: receipt.created_at, business_linked: links.accepted,
      domain_record_linked: links.durable,
      disposition_state: dispositionState, active_hold_count: activeHolds?.count ?? 0,
      external_marker_present: externalMarker !== null,
      external_marker_decision_id: externalMarker?.decision_id ?? null,
      restore_recheck_pending: dispositionState === "quarantined" ||
        (disposition?.reappearance_detected_at != null && disposition.reappearance_reverified_at === null),
      object_status: (dispositionState === "destroyed" || dispositionState === "quarantined") && objectStatus !== "missing"
        ? "restore_reappeared" : objectStatus,
      recent_events: events.results });
  } catch (error) {
    return evidenceUploadFailure(error);
  }
}

export async function assertCurrentOwner(env: AppEnv, auth: AuthContext): Promise<void> {
  const user = await env.DB.prepare(
    "SELECT COALESCE(access_role, role) AS role FROM app_users WHERE tenant_id = ? AND user_id = ? AND active = 1",
  ).bind(auth.session.tenant_id, auth.session.user_id).first<{ role: string }>();
  if (!user || user.role !== auth.session.role || user.role !== "owner") {
    throw new EvidenceUploadError("owner_role_required", 403);
  }
}

/** A failed step can leave an immutable child row before the case transition is accepted. */
export async function inspectBusinessLinks(
  env: AppEnv,
  receipt: EvidenceUploadReceipt,
): Promise<{ accepted: boolean; durable: boolean }> {
  const ref = `evidence-upload://${receipt.receipt_id}`;
  const tenant = receipt.tenant_id;
  if (receipt.purpose === "stock") {
    const linked = await env.DB.prepare(`SELECT command.status FROM inventory_commands AS command,
      json_each(command.evidence_refs_json) AS link
      WHERE command.tenant_id = ? AND command.command_id = ? AND command.transition = ?
        AND json_extract(link.value, '$.ref') = ?
        AND json_extract(link.value, '$.sha256') = ? LIMIT 1`)
      .bind(tenant, receipt.operation_id, receipt.action, ref, receipt.sha256)
      .first<{ status: string }>();
    return { accepted: linked?.status === "applied", durable: linked !== null };
  }
  if (receipt.purpose === "corrective_action") {
    const linked = await env.DB.prepare(`SELECT 1 FROM safety_corrective_actions AS action,
      json_each(action.evidence_refs_json) AS link
      WHERE action.tenant_id = ? AND action.corrective_action_id = ?
        AND json_extract(link.value, '$.ref') = ?
        AND json_extract(link.value, '$.sha256') = ? LIMIT 1`)
      .bind(tenant, receipt.target_id, ref, receipt.sha256).first();
    const digestLinked = await env.DB.prepare(`SELECT 1 FROM evidence_upload_manifests AS manifest,
      json_each(manifest.refs_json) AS link
      JOIN safety_corrective_actions AS action ON action.tenant_id = manifest.tenant_id
        AND action.evidence_sha256 = manifest.sha256
      WHERE manifest.tenant_id = ? AND manifest.purpose = 'corrective_action'
        AND json_extract(link.value, '$.ref') = ?
        AND json_extract(link.value, '$.sha256') = ? LIMIT 1`)
      .bind(tenant, ref, receipt.sha256).first();
    const accepted = linked !== null || digestLinked !== null;
    return { accepted, durable: accepted };
  }
  const manifests = await env.DB.prepare(`SELECT manifest.sha256 FROM evidence_upload_manifests AS manifest,
    json_each(manifest.refs_json) AS link
    WHERE manifest.tenant_id = ? AND manifest.purpose = ? AND manifest.target_id = ?
      AND manifest.action = ? AND manifest.operation_id = ?
      AND json_extract(link.value, '$.ref') = ?
      AND json_extract(link.value, '$.sha256') = ?`)
    .bind(tenant, receipt.purpose, receipt.target_id, receipt.action,
      receipt.operation_id, ref, receipt.sha256).all<{ sha256: string }>();
  let durable = false;
  for (const manifest of manifests.results) {
    const accepted = receipt.purpose === "service_intake"
      ? await env.DB.prepare(`SELECT 1 FROM service_cases WHERE tenant_id = ? AND roof_job_id = ?
          AND intake_evidence_digest = ? LIMIT 1`)
        .bind(tenant, receipt.target_id, manifest.sha256).first()
      : await env.DB.prepare(`SELECT 1 FROM service_case_events WHERE tenant_id = ? AND service_case_id = ?
          AND evidence_digest = ? LIMIT 1`)
        .bind(tenant, receipt.target_id, manifest.sha256).first() ??
        await env.DB.prepare(`SELECT 1 FROM service_cost_recovery_claims WHERE tenant_id = ?
          AND service_case_id = ? AND evidence_digest = ? LIMIT 1`)
          .bind(tenant, receipt.target_id, manifest.sha256).first();
    if (accepted) return { accepted: true, durable: true };
    if (receipt.purpose === "service_intake") continue;
    // A case's last digest or a child row is durable even without a matching
    // transition event. Neither may be classified as an abandoned upload.
    const child = await env.DB.prepare(`SELECT 1 FROM service_cases
        WHERE tenant_id = ? AND service_case_id = ? AND last_evidence_digest = ?
      UNION SELECT 1 FROM service_case_triage
        WHERE tenant_id = ? AND service_case_id = ? AND evidence_digest = ?
      UNION SELECT 1 FROM service_case_diagnoses
        WHERE tenant_id = ? AND service_case_id = ? AND evidence_digest = ?
      UNION SELECT 1 FROM service_case_remedies
        WHERE tenant_id = ? AND service_case_id = ?
          AND (parts_manifest_digest = ? OR field_evidence_digest = ?) LIMIT 1`)
      .bind(tenant, receipt.target_id, manifest.sha256,
        tenant, receipt.target_id, manifest.sha256,
        tenant, receipt.target_id, manifest.sha256,
        tenant, receipt.target_id, manifest.sha256, manifest.sha256).first();
    durable ||= child !== null;
  }
  return { accepted: false, durable };
}

async function inspectObject(
  env: AppEnv,
  receipt: EvidenceUploadReceipt,
): Promise<"verified" | "missing" | "mismatch"> {
  const object = await env.RAW.get(receipt.r2_key);
  if (!object) return "missing";
  if (object.size !== receipt.byte_size || object.httpMetadata?.contentType !== receipt.content_type ||
    object.customMetadata?.sha256 !== receipt.sha256 ||
    object.customMetadata?.request_sha256 !== receipt.request_sha256) return "mismatch";
  const bytes = await object.arrayBuffer();
  return bytes.byteLength === receipt.byte_size && await binarySha256(bytes) === receipt.sha256
    ? "verified" : "mismatch";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
  } });
}
