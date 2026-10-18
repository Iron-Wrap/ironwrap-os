import type { AppEnv, AuthContext } from "./app-types.ts";
import { r2ObjectMatches } from "./field-actions.ts";
import {
  REPORT_ID,
  ReportError,
  bytesHash,
  reportBytes,
  type ReportRow,
} from "./job-measurement-report-store.ts";
import {
  isCurrentPrivacyOwner,
  privatePrivacyJson as json,
} from "./measurement-privacy-owner.ts";

const PAGE_SIZE = 25;
type InventoryRow = ReportRow & { current_job_customer_id: string | null };

/**
 * Owner inventory for the governed PDF class. Older intake receipts gained a nullable tenant
 * column in migration 0103; unattributed legacy rows cannot be shown to a tenant owner.
 */
export async function handleMeasurementReportPrivacyAudit(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const list = url.pathname === "/api/v1/privacy/measurement-reports";
  const detail = url.pathname.match(
    /^\/api\/v1\/privacy\/measurement-reports\/(mrpt_[0-9a-f]{64})\/audit$/,
  );
  if (!list && !detail) return null;
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  try {
    if (!(await isCurrentPrivacyOwner(env, auth)))
      return json({ error: "owner_role_required" }, 403);
    const tenant = auth.session.tenant_id;
    if (list) {
      const allowed = ["before", "limit"];
      if (
        [...url.searchParams.keys()].some(
          (key) =>
            !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
        )
      )
        return json({ error: "report_audit_query_invalid" }, 400);
      const before = url.searchParams.get("before");
      const rawLimit = url.searchParams.get("limit") ?? String(PAGE_SIZE);
      if (
        (before !== null && !REPORT_ID.test(before)) ||
        !/^[1-9][0-9]?$/.test(rawLimit) ||
        Number(rawLimit) > 50
      )
        return json({ error: "report_audit_query_invalid" }, 400);
      const limit = Number(rawLimit);
      const page = await env.DB.prepare(
        `SELECT report.*, job.customer_id AS current_job_customer_id FROM job_measurement_reports AS report
         LEFT JOIN operating_roof_jobs AS job
           ON job.tenant_id=report.tenant_id AND job.roof_job_id=report.roof_job_id
         WHERE report.tenant_id=? AND report.report_id<?
         ORDER BY report.report_id DESC LIMIT ?`,
      )
        .bind(tenant, before ?? "z", limit + 1)
        .all<InventoryRow>();
      if (!page.success || !Array.isArray(page.results))
        return json({ error: "report_audit_unavailable" }, 503);
      const rows = page.results.slice(0, limit);
      return json({
        version: 1,
        items: rows.map((row) => ({
          report_id: row.report_id,
          roof_job_id: row.roof_job_id,
          current_job_customer_id: row.current_job_customer_id,
          uploaded_by: row.uploaded_by,
          file_name: row.file_name,
          size_bytes: row.size_bytes,
          sha256: row.sha256,
          state: row.state,
          created_at: row.created_at,
          stored_at: row.stored_at,
        })),
        next_before:
          page.results.length > limit ? rows[rows.length - 1]!.report_id : null,
      });
    }
    if (url.search) return json({ error: "report_audit_query_invalid" }, 400);
    const id = detail![1]!;
    const row = await env.DB.prepare(
      `SELECT report.*, job.customer_id AS current_job_customer_id FROM job_measurement_reports AS report
       LEFT JOIN operating_roof_jobs AS job
         ON job.tenant_id=report.tenant_id AND job.roof_job_id=report.roof_job_id
       WHERE report.tenant_id=? AND report.report_id=?`,
    )
      .bind(tenant, id)
      .first<InventoryRow>();
    if (!row) return json({ error: "report_not_found" }, 404);
    let objectStatus:
      | "ok"
      | "awaiting_bytes_present"
      | "awaiting_bytes_missing"
      | "missing"
      | "mismatch"
      | "unavailable";
    try {
      if (row.state === "awaiting_bytes") {
        const staged = await env.RAW.get(row.r2_key);
        if (!staged) {
          objectStatus = "awaiting_bytes_missing";
        } else if (!r2ObjectMatches(staged, row.size_bytes, row.sha256)) {
          objectStatus = "mismatch";
        } else {
          const bytes = await staged.arrayBuffer();
          objectStatus =
            bytes.byteLength === row.size_bytes &&
            (await bytesHash(new Uint8Array(bytes))) === row.sha256
              ? "awaiting_bytes_present"
              : "mismatch";
        }
      } else {
        await reportBytes(env, tenant, row.roof_job_id, id);
        objectStatus = "ok";
      }
    } catch (error) {
      if (error instanceof ReportError) {
        objectStatus =
          error.code === "report_bytes_missing"
            ? "missing"
            : error.code === "report_integrity_failed"
              ? "mismatch"
              : "unavailable";
      } else {
        objectStatus = "unavailable";
      }
    }
    return json({
      version: 1,
      report_id: row.report_id,
      roof_job_id: row.roof_job_id,
      current_job_customer_id: row.current_job_customer_id,
      uploaded_by: row.uploaded_by,
      file_name: row.file_name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      r2_key: row.r2_key,
      state: row.state,
      created_at: row.created_at,
      stored_at: row.stored_at,
      object_status: objectStatus,
    });
  } catch {
    return json({ error: "report_audit_unavailable" }, 503);
  }
}
