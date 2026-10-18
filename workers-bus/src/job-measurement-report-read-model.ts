import type { AppEnv } from "./app-types.ts";
import {
  fail,
  readReportJob,
  readReport,
  reportHead,
  projectReport,
  latestEvent,
  reportHistory,
  readReportReceipt,
  REQUEST_ID,
  type Actor,
  type ReportRow,
} from "./job-measurement-report-store.ts";
export const REPORT_ACTIONS = [
  "measurement_report.upload",
  "measurement_report.transcribe",
  "measurement_report.review",
];
export async function reportList(
  env: AppEnv,
  actor: Actor,
  jobId: string,
  write: boolean,
  requestId: string | null,
  before: string | null,
) {
  const job = await readReportJob(env, actor.tenantId, jobId);
  const rows = await env.DB.prepare(
    "SELECT * FROM job_measurement_reports WHERE tenant_id=? AND roof_job_id=? AND report_id<? ORDER BY report_id DESC LIMIT 26",
  )
    .bind(actor.tenantId, jobId, before ?? "z")
    .all<ReportRow>();
  if (!rows.success || !Array.isArray(rows.results))
    fail("report_readback_unavailable", 503);
  const receipt = requestId
    ? await readReportReceipt(env, actor, jobId, requestId)
    : null;
  return {
    version: 1,
    tenant_id: actor.tenantId,
    read_model_generated_at: new Date().toISOString(),
    job,
    allowed_actions: write ? REPORT_ACTIONS : [],
    reports: await Promise.all(
      rows.results.slice(0, 25).map((row) => projectReport(env, row)),
    ),
    next_before: rows.results.length > 25 ? rows.results[24]!.report_id : null,
    requested_request_id: requestId,
    receipt: receipt?.receipt ?? null,
    receipt_report: receipt
      ? await projectReport(
          env,
          await readReport(env, actor.tenantId, jobId, receipt.row.report_id),
        )
      : null,
  };
}
export async function reportDetail(
  env: AppEnv,
  actor: Actor,
  jobId: string,
  id: string,
  write: boolean,
  before?: number,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await readReportJob(env, actor.tenantId, jobId),
      row = await readReport(env, actor.tenantId, jobId, id),
      head = await reportHead(env, actor.tenantId, id);
    let uploadRequestId: string | null = null;
    if (row.uploaded_by === actor.userId) {
      const upload = await env.DB.prepare(
        "SELECT request_id FROM job_measurement_report_receipts WHERE tenant_id=? AND roof_job_id=? AND report_id=? AND actor_user_id=? AND kind='upload'",
      )
        .bind(actor.tenantId, jobId, id, actor.userId)
        .first<{ request_id: string }>();
      if (
        !upload ||
        !REQUEST_ID.test(upload.request_id) ||
        !upload.request_id.startsWith("measurement-report:")
      )
        fail("report_evidence_invalid", 503);
      const receipt = await readReportReceipt(
        env,
        actor,
        jobId,
        upload.request_id,
      );
      if (
        !receipt ||
        receipt.row.report_id !== id ||
        receipt.row.kind !== "upload"
      )
        fail("report_evidence_invalid", 503);
      uploadRequestId = upload.request_id;
    }
    const candidates = await latestEvent(
        env,
        actor.tenantId,
        id,
        "candidate_set",
      ),
      review = await latestEvent(env, actor.tenantId, id, "review"),
      history = await reportHistory(env, actor.tenantId, id, before);
    const latest = await reportHead(env, actor.tenantId, id),
      currentJob = await readReportJob(env, actor.tenantId, jobId);
    if (
      (head?.event_id ?? null) !== (latest?.event_id ?? null) ||
      job.version !== currentJob.version
    )
      continue;
    const report = await projectReport(env, row);
    if (report.head_id !== (head?.event_id ?? null)) continue;
    return {
      version: 1,
      tenant_id: actor.tenantId,
      read_model_generated_at: new Date().toISOString(),
      job,
      allowed_actions: write ? REPORT_ACTIONS : [],
      report,
      upload_request_id: uploadRequestId,
      current_candidates: candidates,
      current_review:
        review?.candidate_set_id === candidates?.id ? review : null,
      history,
    };
  }
  fail("report_read_changed", 503);
}
