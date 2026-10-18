import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { r2ObjectStore, r2ObjectMatches } from "./field-actions.ts";

export const MAX_REPORT_BYTES = 20 * 1024 * 1024;
export const REPORT_ID = /^mrpt_[0-9a-f]{64}$/;
export const EVENT_ID = /^mrce_[0-9a-f]{64}$/;
export const REQUEST_ID =
  /^(measurement-report|report-candidates|report-review):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export class ReportError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function fail(code: string, status = 400): never {
  throw new ReportError(code, status);
}
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function exact(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !obj(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !(k in v))
  )
    fail("invalid_report_input");
  return v;
}
const int = (v: unknown, max = 1_000_000): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
const text = (v: unknown, max: number, min = 1): v is string =>
  typeof v === "string" &&
  v === v.trim() &&
  v.length >= min &&
  v.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const reason = (v: unknown) => v === null || text(v, 500, 3);
export type Actor = { tenantId: string; userId: string };
export type Candidate = {
  area_label: string;
  metric: "area" | "pitch";
  value: number;
  unit: "sq_ft" | "rise_per_12";
  basis: "roof_surface" | "horizontal_plan" | "unknown";
  source_page: number;
  source_label: string;
  uncertainty: string | null;
};
export type CandidatesInput = {
  expected_job_version: number;
  expected_report_head: string | null;
  report_sha256: string;
  correction_reason: string | null;
  candidates: Candidate[];
};
export type ReviewInput = {
  expected_job_version: number;
  expected_report_head: string;
  candidate_set_id: string;
  candidate_set_sha256: string;
  decisions: Array<{
    candidate_id: string;
    decision: "accept" | "reject";
    reason: string | null;
  }>;
  correction_reason: string | null;
};
export type UploadInput = {
  expected_job_version: number;
  file_sha256: string;
  file_name: string;
  size_bytes: number;
  content_type: "application/pdf";
};
export interface ReportRow {
  report_id: string;
  tenant_id: string;
  roof_job_id: string;
  job_version: number;
  uploaded_by: string;
  created_at: string;
  stored_at: string | null;
  file_name: string;
  content_type: "application/pdf";
  size_bytes: number;
  sha256: string;
  r2_key: string;
  state: "awaiting_bytes" | "stored";
}
export interface ReportEvent {
  id: string;
  kind: "candidate_set" | "review";
  report_id: string;
  job_id: string;
  sequence: number;
  previous_head_id: string | null;
  job_version: number;
  recorded_by: string;
  recorded_at: string;
  correction_reason: string | null;
  sha256: string;
  source_kind?: "human_transcription";
  candidates?: Array<Candidate & { id: string }>;
  candidate_set_id?: string;
  candidate_set_sha256?: string;
  decisions?: ReviewInput["decisions"];
}
interface EventRow {
  event_id: string;
  tenant_id: string;
  roof_job_id: string;
  report_id: string;
  kind: ReportEvent["kind"];
  sequence: number;
  previous_head_id: string | null;
  job_version: number;
  recorded_by: string;
  recorded_at: string;
  payload_json: string;
  sha256: string;
}
interface ReceiptRow {
  tenant_id: string;
  request_id: string;
  roof_job_id: string;
  report_id: string;
  actor_user_id: string;
  kind: "upload" | "candidate_set" | "review";
  request_hash: string;
  input_json: string;
  event_id: string | null;
  recorded_at: string;
}
export function validJob(v: string) {
  return v.length >= 8 && v.length <= 200 && !/[\s/\\?#]/.test(v) && v !== "..";
}
export function parseUploadMetadata(value: unknown) {
  const v = exact(value, ["expected_job_version", "file_sha256"]);
  if (
    !int(v.expected_job_version) ||
    typeof v.file_sha256 !== "string" ||
    !SHA.test(v.file_sha256)
  )
    fail("invalid_report_input");
  return v as { expected_job_version: number; file_sha256: string };
}
export function parseCandidates(value: unknown): CandidatesInput {
  const v = exact(value, [
    "expected_job_version",
    "expected_report_head",
    "report_sha256",
    "correction_reason",
    "candidates",
  ]);
  if (
    !int(v.expected_job_version) ||
    !(
      v.expected_report_head === null ||
      (typeof v.expected_report_head === "string" &&
        EVENT_ID.test(v.expected_report_head))
    ) ||
    typeof v.report_sha256 !== "string" ||
    !SHA.test(v.report_sha256) ||
    !reason(v.correction_reason) ||
    (v.expected_report_head !== null && v.correction_reason === null) ||
    !Array.isArray(v.candidates) ||
    v.candidates.length < 1 ||
    v.candidates.length > 25
  )
    fail("invalid_report_input");
  for (const item of v.candidates) {
    const c = exact(item, [
      "area_label",
      "metric",
      "value",
      "unit",
      "basis",
      "source_page",
      "source_label",
      "uncertainty",
    ]);
    if (
      !text(c.area_label, 120) ||
      !int(c.source_page, 600) ||
      !text(c.source_label, 160) ||
      !(c.uncertainty === null || text(c.uncertainty, 500)) ||
      typeof c.value !== "number" ||
      !Number.isFinite(c.value) ||
      !["roof_surface", "horizontal_plan", "unknown"].includes(
        String(c.basis),
      ) ||
      !(c.metric === "area"
        ? c.unit === "sq_ft" && c.value > 0 && c.value <= 250000
        : c.metric === "pitch" &&
          c.unit === "rise_per_12" &&
          c.basis === "unknown" &&
          c.value >= 0 &&
          c.value <= 24)
    )
      fail("invalid_report_input");
  }
  return v as unknown as CandidatesInput;
}
export function parseReview(value: unknown): ReviewInput {
  const v = exact(value, [
    "expected_job_version",
    "expected_report_head",
    "candidate_set_id",
    "candidate_set_sha256",
    "decisions",
    "correction_reason",
  ]);
  if (
    !int(v.expected_job_version) ||
    typeof v.expected_report_head !== "string" ||
    !EVENT_ID.test(v.expected_report_head) ||
    typeof v.candidate_set_id !== "string" ||
    !EVENT_ID.test(v.candidate_set_id) ||
    typeof v.candidate_set_sha256 !== "string" ||
    !SHA.test(v.candidate_set_sha256) ||
    !reason(v.correction_reason) ||
    !Array.isArray(v.decisions) ||
    v.decisions.length < 1 ||
    v.decisions.length > 25
  )
    fail("invalid_report_input");
  const seen = new Set();
  for (const item of v.decisions) {
    const d = exact(item, ["candidate_id", "decision", "reason"]);
    if (
      typeof d.candidate_id !== "string" ||
      !/^mrc_[0-9a-f]{64}$/.test(d.candidate_id) ||
      seen.has(d.candidate_id) ||
      !["accept", "reject"].includes(String(d.decision)) ||
      !reason(d.reason) ||
      (d.decision === "reject" && d.reason === null)
    )
      fail("invalid_report_input");
    seen.add(d.candidate_id);
  }
  return v as unknown as ReviewInput;
}
export async function readReportJob(env: AppEnv, tenant: string, job: string) {
  const row = await env.DB.prepare(
    "SELECT roof_job_id AS id,version,job_number FROM operating_roof_jobs WHERE tenant_id=? AND roof_job_id=?",
  )
    .bind(tenant, job)
    .first<{ id: string; version: number; job_number: string | null }>();
  if (!row) fail("report_job_not_found", 404);
  return row;
}
export async function readReport(
  env: AppEnv,
  tenant: string,
  job: string,
  id: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM job_measurement_reports WHERE tenant_id=? AND roof_job_id=? AND report_id=?",
  )
    .bind(tenant, job, id)
    .first<ReportRow>();
  if (!row) fail("report_not_found", 404);
  return row;
}
export async function reportHead(env: AppEnv, tenant: string, id: string) {
  // Read the projection and newest retained event in one D1 snapshot. A partial
  // restore must not turn reviewed history into an empty or older current head.
  const row = await env.DB.prepare(
    `SELECT h.event_id,h.sequence,e.event_id AS latest_event_id,e.sequence AS latest_sequence
     FROM (SELECT ? AS tenant_id,? AS report_id) scope
     LEFT JOIN job_measurement_report_heads h
       ON h.tenant_id=scope.tenant_id AND h.report_id=scope.report_id
     LEFT JOIN job_measurement_report_events e
       ON e.tenant_id=scope.tenant_id AND e.report_id=scope.report_id
       AND e.sequence=(SELECT MAX(sequence) FROM job_measurement_report_events
         WHERE tenant_id=scope.tenant_id AND report_id=scope.report_id)`,
  )
    .bind(tenant, id)
    .first<{
      event_id: string | null;
      sequence: number | null;
      latest_event_id: string | null;
      latest_sequence: number | null;
    }>();
  if (
    !row ||
    row.event_id !== row.latest_event_id ||
    row.sequence !== row.latest_sequence
  )
    fail("report_evidence_invalid", 503);
  return row.event_id === null
    ? null
    : { event_id: row.event_id, sequence: row.sequence! };
}
export async function projectReport(env: AppEnv, row: ReportRow) {
  const head = await reportHead(env, row.tenant_id, row.report_id);
  return {
    id: row.report_id,
    job_id: row.roof_job_id,
    job_version: row.job_version,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    stored_at: row.stored_at,
    file_name: row.file_name,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    state: row.state,
    head_id: head?.event_id ?? null,
    head_sequence: head?.sequence ?? 0,
  };
}
export async function eventFromRow(row: EventRow): Promise<ReportEvent> {
  let data: ReportEvent;
  try {
    data = JSON.parse(row.payload_json);
  } catch {
    fail("report_evidence_invalid", 503);
  }
  if (
    canonicalJson(data) !== row.payload_json ||
    (await sha256Hex(row.payload_json)) !== row.sha256 ||
    data.id !== row.event_id ||
    data.report_id !== row.report_id ||
    data.job_id !== row.roof_job_id ||
    data.kind !== row.kind ||
    data.sequence !== row.sequence ||
    data.previous_head_id !== row.previous_head_id ||
    data.job_version !== row.job_version ||
    data.recorded_by !== row.recorded_by ||
    data.recorded_at !== row.recorded_at
  )
    fail("report_evidence_invalid", 503);
  return { ...data, sha256: row.sha256 };
}
export async function latestEvent(
  env: AppEnv,
  tenant: string,
  report: string,
  kind: ReportEvent["kind"],
) {
  const row = await env.DB.prepare(
    "SELECT * FROM job_measurement_report_events WHERE tenant_id=? AND report_id=? AND kind=? ORDER BY sequence DESC LIMIT 1",
  )
    .bind(tenant, report, kind)
    .first<EventRow>();
  return row ? eventFromRow(row) : null;
}
export async function reportHistory(
  env: AppEnv,
  tenant: string,
  report: string,
  before?: number,
) {
  const rows = await env.DB.prepare(
    "SELECT * FROM job_measurement_report_events WHERE tenant_id=? AND report_id=? AND sequence<? ORDER BY sequence DESC LIMIT 26",
  )
    .bind(tenant, report, before ?? 1_000_001)
    .all<EventRow>();
  if (!rows.success || !Array.isArray(rows.results))
    fail("report_readback_unavailable", 503);
  const items = await Promise.all(rows.results.slice(0, 25).map(eventFromRow));
  return {
    items,
    next_before: rows.results.length > 25 ? items.at(-1)!.sequence : null,
  };
}
export async function readReportReceipt(
  env: AppEnv,
  actor: Actor,
  job: string,
  key: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM job_measurement_report_receipts WHERE tenant_id=? AND request_id=?",
  )
    .bind(actor.tenantId, key)
    .first<ReceiptRow>();
  if (!row) return null;
  if (row.roof_job_id !== job || row.actor_user_id !== actor.userId)
    fail("report_receipt_not_found", 404);
  let input: unknown;
  try {
    input = JSON.parse(row.input_json);
  } catch {
    fail("report_evidence_invalid", 503);
  }
  if (
    canonicalJson(input) !== row.input_json ||
    (await sha256Hex(row.input_json)) !== row.request_hash ||
    row.request_id !== key ||
    !REQUEST_ID.test(key) ||
    !key.startsWith(
      row.kind === "upload"
        ? "measurement-report:"
        : row.kind === "candidate_set"
          ? "report-candidates:"
          : "report-review:",
    )
  )
    fail("report_evidence_invalid", 503);
  const report = await readReport(env, actor.tenantId, job, row.report_id);
  let event: ReportEvent | null = null;
  if (row.kind === "upload") {
    if (
      row.event_id !== null ||
      report.uploaded_by !== actor.userId ||
      report.created_at !== row.recorded_at ||
      report.report_id !==
        `mrpt_${await sha256Hex(canonicalJson([actor.tenantId, actor.userId, key]))}` ||
      canonicalJson(input) !==
        canonicalJson({
          expected_job_version: report.job_version,
          file_sha256: report.sha256,
          file_name: report.file_name,
          size_bytes: report.size_bytes,
          content_type: report.content_type,
        })
    )
      fail("report_evidence_invalid", 503);
  } else {
    if (
      row.event_id !==
      `mrce_${await sha256Hex(canonicalJson([actor.tenantId, actor.userId, key]))}`
    )
      fail("report_evidence_invalid", 503);
    const e = await env.DB.prepare(
      "SELECT * FROM job_measurement_report_events WHERE tenant_id=? AND report_id=? AND event_id=?",
    )
      .bind(actor.tenantId, row.report_id, row.event_id)
      .first<EventRow>();
    if (!e) fail("report_evidence_invalid", 503);
    event = await eventFromRow(e);
    if (
      event.kind !== row.kind ||
      event.job_id !== job ||
      event.recorded_by !== actor.userId ||
      event.recorded_at !== row.recorded_at
    )
      fail("report_evidence_invalid", 503);
    let command: CandidatesInput | ReviewInput;
    try {
      command =
        row.kind === "candidate_set"
          ? parseCandidates(input)
          : parseReview(input);
    } catch {
      fail("report_evidence_invalid", 503);
    }
    if (
      command.expected_job_version !== event.job_version ||
      command.expected_report_head !== event.previous_head_id ||
      command.correction_reason !== event.correction_reason
    )
      fail("report_evidence_invalid", 503);
    if (row.kind === "candidate_set") {
      const value = command as CandidatesInput;
      const expectedCandidates = await Promise.all(
        value.candidates.map(async (candidate, index) => ({
          ...candidate,
          id: `mrc_${await sha256Hex(canonicalJson([event!.id, index, candidate]))}`,
        })),
      );
      if (
        value.report_sha256 !== report.sha256 ||
        event.source_kind !== "human_transcription" ||
        canonicalJson(event.candidates) !== canonicalJson(expectedCandidates)
      )
        fail("report_evidence_invalid", 503);
    } else {
      const value = command as ReviewInput;
      if (
        event.candidate_set_id !== value.candidate_set_id ||
        event.candidate_set_sha256 !== value.candidate_set_sha256 ||
        canonicalJson(event.decisions) !== canonicalJson(value.decisions)
      )
        fail("report_evidence_invalid", 503);
    }
  }
  return {
    row,
    input,
    receipt: {
      request_id: row.request_id,
      request_hash: row.request_hash,
      kind: row.kind,
      report_id: row.report_id,
      actor_user_id: row.actor_user_id,
      recorded_at: row.recorded_at,
      event,
    },
  };
}
function receiptStatement(
  env: AppEnv,
  actor: Actor,
  job: string,
  id: string,
  key: string,
  kind: ReceiptRow["kind"],
  input: string,
  hash: string,
  event: string | null,
  time: string,
) {
  return env.DB.prepare(
    "INSERT INTO job_measurement_report_receipts (tenant_id,request_id,roof_job_id,report_id,actor_user_id,kind,request_hash,input_json,event_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    actor.tenantId,
    key,
    job,
    id,
    actor.userId,
    kind,
    hash,
    input,
    event,
    time,
  );
}
export async function commandResult(
  env: AppEnv,
  actor: Actor,
  job: string,
  key: string,
  replayed: boolean,
) {
  const saved = await readReportReceipt(env, actor, job, key);
  if (!saved) fail("report_readback_unavailable", 503);
  return {
    version: 1,
    tenant_id: actor.tenantId,
    job_id: job,
    receipt: saved.receipt,
    report: await projectReport(
      env,
      await readReport(env, actor.tenantId, job, saved.row.report_id),
    ),
    replayed,
  };
}
async function replay(
  env: AppEnv,
  actor: Actor,
  job: string,
  key: string,
  hash: string,
  report?: string,
) {
  const old = await readReportReceipt(env, actor, job, key);
  if (
    old &&
    (old.row.request_hash !== hash || (report && old.row.report_id !== report))
  )
    fail("report_idempotency_conflict", 409);
  return old;
}
function dbFailure(error: unknown): never {
  const message = String(error);
  for (const code of [
    "report_job_stale",
    "report_head_stale",
    "report_write_required",
    "report_not_stored",
  ])
    if (message.includes(code))
      fail(code, code === "report_write_required" ? 403 : 409);
  throw error;
}
export async function uploadReport(
  env: AppEnv,
  actor: Actor,
  jobId: string,
  key: string,
  input: UploadInput,
  bytes: Uint8Array,
) {
  const json = canonicalJson(input),
    hash = await sha256Hex(json);
  let old = await replay(env, actor, jobId, key, hash);
  let replayed = !!old;
  if (!old) {
    const job = await readReportJob(env, actor.tenantId, jobId);
    if (job.version !== input.expected_job_version)
      fail("report_job_stale", 409);
    const id = `mrpt_${await sha256Hex(canonicalJson([actor.tenantId, actor.userId, key]))}`;
    const time = new Date().toISOString();
    const raw = `reports/v1/${await sha256Hex(actor.tenantId)}/${id}/${input.file_sha256}.pdf`;
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO job_measurement_reports (report_id,tenant_id,roof_job_id,job_version,uploaded_by,created_at,stored_at,file_name,content_type,size_bytes,sha256,r2_key,state) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,'awaiting_bytes')",
        ).bind(
          id,
          actor.tenantId,
          jobId,
          job.version,
          actor.userId,
          time,
          input.file_name,
          input.content_type,
          input.size_bytes,
          input.file_sha256,
          raw,
        ),
        receiptStatement(
          env,
          actor,
          jobId,
          id,
          key,
          "upload",
          json,
          hash,
          null,
          time,
        ),
      ]);
    } catch (error) {
      old = await replay(env, actor, jobId, key, hash);
      if (!old) dbFailure(error);
      replayed = true;
    }
    old = await replay(env, actor, jobId, key, hash);
    if (!old) fail("report_readback_unavailable", 503);
  }
  const report = await readReport(
    env,
    actor.tenantId,
    jobId,
    old.row.report_id,
  );
  await r2ObjectStore(env.RAW).ensure(
    report.r2_key,
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
    "application/pdf",
    report.sha256,
  );
  await markStored(env, report);
  return commandResult(env, actor, jobId, key, replayed);
}
async function markStored(env: AppEnv, report: ReportRow) {
  const object = await env.RAW.head(report.r2_key);
  if (!object) fail("report_bytes_missing", 409);
  if (!r2ObjectMatches(object, report.size_bytes, report.sha256))
    fail("report_integrity_failed", 503);
  if (report.state !== "stored")
    await env.DB.prepare(
      "UPDATE job_measurement_reports SET state='stored',stored_at=? WHERE tenant_id=? AND report_id=? AND state='awaiting_bytes'",
    )
      .bind(new Date().toISOString(), report.tenant_id, report.report_id)
      .run();
}
export async function resumeReport(
  env: AppEnv,
  actor: Actor,
  job: string,
  id: string,
) {
  const row = await env.DB.prepare(
    "SELECT request_id FROM job_measurement_report_receipts WHERE tenant_id=? AND roof_job_id=? AND report_id=? AND actor_user_id=? AND kind='upload'",
  )
    .bind(actor.tenantId, job, id, actor.userId)
    .first<{ request_id: string }>();
  if (!row) fail("report_receipt_not_found", 404);
  const saved = await readReportReceipt(env, actor, job, row.request_id);
  if (!saved) fail("report_receipt_not_found", 404);
  const report = await readReport(env, actor.tenantId, job, id);
  const original = saved.input as UploadInput;
  if (
    original.file_sha256 !== report.sha256 ||
    original.file_name !== report.file_name ||
    original.size_bytes !== report.size_bytes ||
    original.expected_job_version !== report.job_version
  )
    fail("report_evidence_invalid", 503);
  await markStored(env, report);
  return commandResult(env, actor, job, row.request_id, true);
}
export async function reportBytes(
  env: AppEnv,
  tenant: string,
  job: string,
  id: string,
) {
  const report = await readReport(env, tenant, job, id);
  if (report.state !== "stored") fail("report_not_stored", 409);
  const object = await env.RAW.get(report.r2_key);
  if (!object) fail("report_bytes_missing", 503);
  if (!r2ObjectMatches(object, report.size_bytes, report.sha256))
    fail("report_integrity_failed", 503);
  const bytes = await object.arrayBuffer();
  if (
    bytes.byteLength !== report.size_bytes ||
    (await bytesHash(new Uint8Array(bytes))) !== report.sha256
  )
    fail("report_integrity_failed", 503);
  return { report, bytes };
}
export async function bytesHash(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function recordReportEvent(
  env: AppEnv,
  actor: Actor,
  jobId: string,
  reportId: string,
  key: string,
  kind: "candidate_set" | "review",
  input: CandidatesInput | ReviewInput,
) {
  const json = canonicalJson(input),
    hash = await sha256Hex(json);
  if (await replay(env, actor, jobId, key, hash, reportId))
    return commandResult(env, actor, jobId, key, true);
  const job = await readReportJob(env, actor.tenantId, jobId);
  if (job.version !== input.expected_job_version) fail("report_job_stale", 409);
  const report = await readReport(env, actor.tenantId, jobId, reportId);
  if (report.state !== "stored") fail("report_not_stored", 409);
  const stored = await env.RAW.head(report.r2_key);
  if (!stored || !r2ObjectMatches(stored, report.size_bytes, report.sha256))
    fail("report_integrity_failed", 503);
  const head = await reportHead(env, actor.tenantId, reportId);
  if ((head?.event_id ?? null) !== input.expected_report_head)
    fail("report_head_stale", 409);
  const candidates = await latestEvent(
    env,
    actor.tenantId,
    reportId,
    "candidate_set",
  );
  const priorReview = await latestEvent(
    env,
    actor.tenantId,
    reportId,
    "review",
  );
  const id = `mrce_${await sha256Hex(canonicalJson([actor.tenantId, actor.userId, key]))}`;
  const facts: Omit<ReportEvent, "sha256"> = {
    id,
    kind,
    report_id: reportId,
    job_id: jobId,
    sequence: (head?.sequence ?? 0) + 1,
    previous_head_id: head?.event_id ?? null,
    job_version: job.version,
    recorded_by: actor.userId,
    recorded_at: new Date().toISOString(),
    correction_reason: input.correction_reason,
  };
  if (kind === "candidate_set") {
    const value = input as CandidatesInput;
    if (value.report_sha256 !== report.sha256)
      fail("report_hash_mismatch", 409);
    if (head && value.correction_reason === null)
      fail("report_correction_reason_required");
    if (!head && value.correction_reason !== null) fail("invalid_report_input");
    facts.source_kind = "human_transcription";
    facts.candidates = await Promise.all(
      value.candidates.map(async (c, i) => ({
        ...c,
        id: `mrc_${await sha256Hex(canonicalJson([id, i, c]))}`,
      })),
    );
  } else {
    const value = input as ReviewInput;
    if (
      !candidates ||
      candidates.id !== value.candidate_set_id ||
      candidates.sha256 !== value.candidate_set_sha256
    )
      fail("report_candidates_stale", 409);
    if (priorReview && value.correction_reason === null)
      fail("report_correction_reason_required");
    const ids = new Set(candidates.candidates!.map((c) => c.id));
    if (
      value.decisions.length !== ids.size ||
      value.decisions.some((d) => !ids.has(d.candidate_id))
    )
      fail("report_candidate_decisions_mismatch");
    facts.candidate_set_id = candidates.id;
    facts.candidate_set_sha256 = candidates.sha256;
    facts.decisions = value.decisions;
  }
  const payload = canonicalJson(facts),
    sha = await sha256Hex(payload);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO job_measurement_report_events (event_id,tenant_id,roof_job_id,report_id,kind,sequence,previous_head_id,job_version,recorded_by,recorded_at,payload_json,sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        actor.tenantId,
        jobId,
        reportId,
        kind,
        facts.sequence,
        facts.previous_head_id,
        job.version,
        actor.userId,
        facts.recorded_at,
        payload,
        sha,
      ),
      receiptStatement(
        env,
        actor,
        jobId,
        reportId,
        key,
        kind,
        json,
        hash,
        id,
        facts.recorded_at,
      ),
    ]);
  } catch (error) {
    if (await replay(env, actor, jobId, key, hash, reportId))
      return commandResult(env, actor, jobId, key, true);
    dbFailure(error);
  }
  return commandResult(env, actor, jobId, key, false);
}
