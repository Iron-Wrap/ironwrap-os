import type { AppEnv, AuthContext } from "./app-types.ts";
import { bytesHash } from "./job-measurement-report-store.ts";
import {
  isCurrentPrivacyOwner,
  privatePrivacyJson as json,
} from "./measurement-privacy-owner.ts";

const RECEIPT_ID = /^measurement_[0-9a-f]{64}$/;
const PAGE_SIZE = 25;
const MAX_RAW_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_OCR_BYTES = 2 * 1024 * 1024;

interface IntakeRow {
  receipt_id: string;
  tenant_id: string | null;
  measurement_id: string;
  provider: string;
  job_number: string | null;
  status: string;
  native_roof_job_id: string | null;
  native_measurement_revision_id: string | null;
  current_job_customer_id: string | null;
  raw_key: string;
  payload_hash: string;
  report_raw_key: string | null;
  report_sha256: string | null;
  report_content_type: string | null;
  ocr_result_key: string | null;
  ocr_result_sha256: string | null;
  ocr_status: string;
  drive_report_url: string | null;
  drive_folder_url: string | null;
  frappe_measurement_id: string | null;
  frappe_evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

type IntakeListRow = Pick<
  IntakeRow,
  | "receipt_id"
  | "measurement_id"
  | "provider"
  | "job_number"
  | "status"
  | "native_roof_job_id"
  | "report_raw_key"
  | "ocr_result_key"
  | "created_at"
  | "updated_at"
  | "current_job_customer_id"
>;

type ObjectStatus =
  "ok" | "not_recorded" | "missing" | "mismatch" | "unavailable";

async function auditObject(
  env: AppEnv,
  key: string | null,
  sha256: string | null,
  maxBytes: number,
  expectedKey?: string,
): Promise<{ object_status: ObjectStatus; size_bytes: number | null }> {
  if (key === null && sha256 === null)
    return { object_status: "not_recorded", size_bytes: null };
  if (!key || !sha256 || (expectedKey && key !== expectedKey))
    return { object_status: "mismatch", size_bytes: null };
  try {
    const object = await env.RAW.get(key);
    if (!object) return { object_status: "missing", size_bytes: null };
    if (object.size > maxBytes)
      return { object_status: "mismatch", size_bytes: object.size };
    const bytes = await object.arrayBuffer();
    const size = bytes.byteLength;
    return {
      object_status:
        size <= maxBytes && (await bytesHash(new Uint8Array(bytes))) === sha256
          ? "ok"
          : "mismatch",
      size_bytes: size,
    };
  } catch {
    return { object_status: "unavailable", size_bytes: null };
  }
}

/**
 * Read-only inventory for attributable legacy measurement intake, fetched report and OCR bytes.
 * Rows with tenant_id NULL remain quarantined: this route never assigns them to a tenant.
 */
export async function handleMeasurementIntakePrivacyAudit(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const list = url.pathname === "/api/v1/privacy/measurement-intakes";
  const detail = url.pathname.match(
    /^\/api\/v1\/privacy\/measurement-intakes\/(measurement_[0-9a-f]{64})\/audit$/,
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
        return json({ error: "measurement_audit_query_invalid" }, 400);
      const before = url.searchParams.get("before");
      const rawLimit = url.searchParams.get("limit") ?? String(PAGE_SIZE);
      if (
        (before !== null && !RECEIPT_ID.test(before)) ||
        !/^[1-9][0-9]?$/.test(rawLimit) ||
        Number(rawLimit) > 50
      )
        return json({ error: "measurement_audit_query_invalid" }, 400);
      const limit = Number(rawLimit);
      const page = await env.DB.prepare(
        `SELECT receipt.receipt_id, receipt.measurement_id, receipt.provider,
                receipt.job_number, receipt.status, receipt.native_roof_job_id,
                receipt.report_raw_key, receipt.ocr_result_key, receipt.created_at,
                receipt.updated_at, job.customer_id AS current_job_customer_id
           FROM measurement_intake_receipts AS receipt
           LEFT JOIN operating_roof_jobs AS job
             ON job.tenant_id=receipt.tenant_id
            AND job.roof_job_id=receipt.native_roof_job_id
          WHERE receipt.tenant_id=? AND receipt.receipt_id<?
          ORDER BY receipt.receipt_id DESC LIMIT ?`,
      )
        .bind(tenant, before ?? "z", limit + 1)
        .all<IntakeListRow>();
      if (!page.success || !Array.isArray(page.results))
        return json({ error: "measurement_audit_unavailable" }, 503);
      const rows = page.results.slice(0, limit);
      return json({
        version: 1,
        items: rows,
        next_before:
          page.results.length > limit
            ? rows[rows.length - 1]!.receipt_id
            : null,
      });
    }
    if (url.search)
      return json({ error: "measurement_audit_query_invalid" }, 400);
    const id = detail![1]!;
    const row = await env.DB.prepare(
      `SELECT receipt.receipt_id, receipt.tenant_id, receipt.measurement_id,
              receipt.provider, receipt.job_number, receipt.status,
              receipt.native_roof_job_id, receipt.native_measurement_revision_id,
              receipt.raw_key, receipt.payload_hash, receipt.report_raw_key,
              receipt.report_sha256, receipt.report_content_type,
              receipt.ocr_result_key, receipt.ocr_result_sha256, receipt.ocr_status,
              receipt.drive_report_url, receipt.drive_folder_url,
              receipt.frappe_measurement_id, receipt.frappe_evidence_id,
              receipt.created_at, receipt.updated_at,
              job.customer_id AS current_job_customer_id
         FROM measurement_intake_receipts AS receipt
         LEFT JOIN operating_roof_jobs AS job
           ON job.tenant_id=receipt.tenant_id
          AND job.roof_job_id=receipt.native_roof_job_id
        WHERE receipt.tenant_id=? AND receipt.receipt_id=?`,
    )
      .bind(tenant, id)
      .first<IntakeRow>();
    if (!row) return json({ error: "measurement_receipt_not_found" }, 404);
    const [raw, report, ocr] = await Promise.all([
      auditObject(
        env,
        row.raw_key,
        row.payload_hash,
        MAX_RAW_BYTES,
        `raw/measurements/${row.payload_hash}.json`,
      ),
      auditObject(
        env,
        row.report_raw_key,
        row.report_sha256,
        MAX_REPORT_BYTES,
        row.report_sha256
          ? `raw/measurement-reports/${row.report_sha256}.bin`
          : undefined,
      ),
      auditObject(
        env,
        row.ocr_result_key,
        row.ocr_result_sha256,
        MAX_OCR_BYTES,
      ),
    ]);
    return json({
      version: 1,
      receipt_id: row.receipt_id,
      measurement_id: row.measurement_id,
      provider: row.provider,
      job_number: row.job_number,
      status: row.status,
      native_roof_job_id: row.native_roof_job_id,
      native_measurement_revision_id: row.native_measurement_revision_id,
      current_job_customer_id: row.current_job_customer_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      raw: { key: row.raw_key, sha256: row.payload_hash, ...raw },
      report: {
        key: row.report_raw_key,
        sha256: row.report_sha256,
        content_type: row.report_content_type,
        ...report,
      },
      ocr: {
        key: row.ocr_result_key,
        sha256: row.ocr_result_sha256,
        status: row.ocr_status,
        ...ocr,
      },
      external_copies: {
        drive_report_url: row.drive_report_url,
        drive_folder_url: row.drive_folder_url,
        frappe_measurement_id: row.frappe_measurement_id,
        frappe_evidence_id: row.frappe_evidence_id,
      },
    });
  } catch {
    return json({ error: "measurement_audit_unavailable" }, 503);
  }
}
