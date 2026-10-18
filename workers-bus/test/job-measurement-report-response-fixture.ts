import assert from "node:assert/strict";
import type {
  commandResult,
  projectReport,
  readReportReceipt,
  ReportEvent,
} from "../src/job-measurement-report-store.ts";
import type {
  reportDetail,
  reportList,
} from "../src/job-measurement-report-read-model.ts";

// Keep the private server response contract independent of any estimator UI.
type Report = Awaited<ReturnType<typeof projectReport>>;
type Receipt = NonNullable<
  Awaited<ReturnType<typeof readReportReceipt>>
>["receipt"];
type Result = Awaited<ReturnType<typeof commandResult>>;
type List = Awaited<ReturnType<typeof reportList>>;
type Detail = Awaited<ReturnType<typeof reportDetail>>;
const reportId = /^mrpt_[0-9a-f]{64}$/;
const eventId = /^mrce_[0-9a-f]{64}$/;
const candidateId = /^mrc_[0-9a-f]{64}$/;
const sha = /^[0-9a-f]{64}$/;
const requestId =
  /^(measurement-report|report-candidates|report-review):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actions = [
  "measurement_report.upload",
  "measurement_report.transcribe",
  "measurement_report.review",
];

function object(value: unknown, keys: string[]) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200, min = 1): asserts value is string {
  assert.equal(typeof value, "string");
  assert.ok((value as string).length >= min && (value as string).length <= max);
}
function matches(value: unknown, expression: RegExp) {
  text(value, Infinity);
  assert.match(value, expression);
}
function integer(value: unknown, min = 1, max = 1_000_000) {
  assert.ok(
    typeof value === "number" &&
      Number.isInteger(value) &&
      value >= min &&
      value <= max,
  );
}
function timestamp(value: unknown) {
  text(value, Infinity);
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  assert.ok(Number.isFinite(Date.parse(value)));
}
function jobId(value: unknown) {
  text(value, 200, 8);
  assert.ok(!/[\s/\\?#]/.test(value) && value !== "..");
}
function reason(value: unknown) {
  if (value === null) return;
  text(value, 500, 3);
  assert.equal(value, value.trim());
}
function array(
  value: unknown,
  min: number,
  max: number,
): asserts value is unknown[] {
  assert.ok(Array.isArray(value) && value.length >= min && value.length <= max);
}
function assertReport(value: unknown): asserts value is Report {
  const v = object(value, [
    "id",
    "job_id",
    "job_version",
    "uploaded_by",
    "created_at",
    "stored_at",
    "file_name",
    "content_type",
    "size_bytes",
    "sha256",
    "state",
    "head_id",
    "head_sequence",
  ]);
  matches(v.id, reportId);
  jobId(v.job_id);
  integer(v.job_version);
  text(v.uploaded_by);
  timestamp(v.created_at);
  if (v.stored_at !== null) timestamp(v.stored_at);
  text(v.file_name, 180);
  assert.equal(v.content_type, "application/pdf");
  integer(v.size_bytes, 5, 20 * 1024 * 1024);
  matches(v.sha256, sha);
  assert.ok(v.state === "awaiting_bytes" || v.state === "stored");
  assert.equal(v.state === "stored", v.stored_at !== null);
  if (v.head_id !== null) matches(v.head_id, eventId);
  integer(v.head_sequence, 0);
  assert.equal(v.head_id === null, v.head_sequence === 0);
}
function assertEvent(value: unknown): asserts value is ReportEvent {
  assert.ok(value !== null && typeof value === "object" && "kind" in value);
  const kind = value.kind;
  assert.ok(kind === "candidate_set" || kind === "review");
  const base = [
    "id",
    "report_id",
    "job_id",
    "sequence",
    "previous_head_id",
    "job_version",
    "recorded_by",
    "recorded_at",
    "correction_reason",
    "sha256",
    "kind",
  ];
  const v = object(value, [
    ...base,
    ...(kind === "candidate_set"
      ? ["source_kind", "candidates"]
      : ["candidate_set_id", "candidate_set_sha256", "decisions"]),
  ]);
  matches(v.id, eventId);
  matches(v.report_id, reportId);
  jobId(v.job_id);
  integer(v.sequence);
  if (v.previous_head_id !== null) matches(v.previous_head_id, eventId);
  integer(v.job_version);
  text(v.recorded_by);
  timestamp(v.recorded_at);
  reason(v.correction_reason);
  matches(v.sha256, sha);
  if (kind === "candidate_set") {
    assert.equal(v.source_kind, "human_transcription");
    array(v.candidates, 1, 25);
    for (const candidate of v.candidates) {
      const c = object(candidate, [
        "id",
        "area_label",
        "metric",
        "value",
        "unit",
        "basis",
        "source_page",
        "source_label",
        "uncertainty",
      ]);
      matches(c.id, candidateId);
      text(c.area_label, 120);
      text(c.source_label, 160);
      assert.equal(c.area_label, c.area_label.trim());
      assert.equal(c.source_label, c.source_label.trim());
      integer(c.source_page, 1, 600);
      if (c.uncertainty !== null) {
        text(c.uncertainty, 500);
        assert.equal(c.uncertainty, c.uncertainty.trim());
      }
      assert.ok(typeof c.value === "number" && Number.isFinite(c.value));
      assert.ok(
        ["roof_surface", "horizontal_plan", "unknown"].includes(
          String(c.basis),
        ),
      );
      if (c.metric === "area") {
        assert.equal(c.unit, "sq_ft");
        assert.ok(c.value > 0 && c.value <= 250000);
      } else {
        assert.equal(c.metric, "pitch");
        assert.equal(c.unit, "rise_per_12");
        assert.equal(c.basis, "unknown");
        assert.ok(c.value >= 0 && c.value <= 24);
      }
    }
  } else {
    matches(v.candidate_set_id, eventId);
    matches(v.candidate_set_sha256, sha);
    array(v.decisions, 1, 25);
    const seen = new Set();
    for (const decision of v.decisions) {
      const d = object(decision, ["candidate_id", "decision", "reason"]);
      matches(d.candidate_id, candidateId);
      assert.ok(!seen.has(d.candidate_id));
      seen.add(d.candidate_id);
      assert.ok(d.decision === "accept" || d.decision === "reject");
      reason(d.reason);
      if (d.decision === "reject") assert.notEqual(d.reason, null);
    }
  }
}
function assertReceipt(value: unknown): asserts value is Receipt {
  const v = object(value, [
    "request_id",
    "request_hash",
    "kind",
    "report_id",
    "actor_user_id",
    "recorded_at",
    "event",
  ]);
  matches(v.request_id, requestId);
  matches(v.request_hash, sha);
  matches(v.report_id, reportId);
  text(v.actor_user_id);
  timestamp(v.recorded_at);
  const prefix = {
    upload: "measurement-report:",
    candidate_set: "report-candidates:",
    review: "report-review:",
  };
  assert.ok(
    v.kind === "upload" || v.kind === "candidate_set" || v.kind === "review",
  );
  assert.ok(String(v.request_id).startsWith(prefix[v.kind]));
  if (v.kind === "upload") assert.equal(v.event, null);
  else {
    assertEvent(v.event);
    assert.equal(v.event.kind, v.kind);
    assert.equal(v.event.report_id, v.report_id);
    assert.equal(v.event.recorded_by, v.actor_user_id);
    assert.equal(v.event.recorded_at, v.recorded_at);
  }
}
function assertReceiptIdentity(receipt: Receipt, report: Report, job: string) {
  assert.equal(receipt.report_id, report.id);
  assert.equal(report.job_id, job);
  if (receipt.kind === "upload") {
    assert.equal(receipt.actor_user_id, report.uploaded_by);
    assert.equal(receipt.recorded_at, report.created_at);
  }
  if (receipt.event) assert.equal(receipt.event.job_id, job);
}
function assertBase(v: Record<string, unknown>) {
  assert.equal(v.version, 1);
  matches(v.tenant_id, /^[a-z0-9][a-z0-9-]{1,63}$/);
}
function assertReadBase(v: Record<string, unknown>) {
  assertBase(v);
  timestamp(v.read_model_generated_at);
  const job = object(v.job, ["id", "version", "job_number"]);
  jobId(job.id);
  integer(job.version);
  if (job.job_number !== null) text(job.job_number, 160);
  array(v.allowed_actions, 0, Infinity);
  for (const action of v.allowed_actions)
    assert.ok(actions.includes(String(action)));
  return job.id as string;
}
export function parseReportResult(value: unknown): Result {
  const v = object(value, [
    "version",
    "tenant_id",
    "job_id",
    "receipt",
    "report",
    "replayed",
  ]);
  assertBase(v);
  jobId(v.job_id);
  assertReport(v.report);
  assertReceipt(v.receipt);
  assert.equal(typeof v.replayed, "boolean");
  assertReceiptIdentity(v.receipt, v.report, v.job_id as string);
  return v as Result;
}
export function parseReportsList(value: unknown): List {
  const v = object(value, [
    "version",
    "tenant_id",
    "read_model_generated_at",
    "job",
    "allowed_actions",
    "reports",
    "next_before",
    "requested_request_id",
    "receipt",
    "receipt_report",
  ]);
  const job = assertReadBase(v);
  array(v.reports, 0, 25);
  for (const report of v.reports) {
    assertReport(report);
    assert.equal(report.job_id, job);
  }
  if (v.next_before !== null) matches(v.next_before, reportId);
  if (v.requested_request_id !== null)
    matches(v.requested_request_id, requestId);
  assert.equal(v.receipt === null, v.receipt_report === null);
  if (v.receipt !== null) {
    assertReceipt(v.receipt);
    assertReport(v.receipt_report);
    assert.equal(v.receipt.request_id, v.requested_request_id);
    assertReceiptIdentity(v.receipt, v.receipt_report, job);
  }
  return v as List;
}
export function parseReportDetail(value: unknown): Detail {
  const v = object(value, [
    "version",
    "tenant_id",
    "read_model_generated_at",
    "job",
    "allowed_actions",
    "report",
    "upload_request_id",
    "current_candidates",
    "current_review",
    "history",
  ]);
  const job = assertReadBase(v);
  assertReport(v.report);
  assert.equal(v.report.job_id, job);
  if (v.upload_request_id !== null) {
    matches(v.upload_request_id, requestId);
    assert.ok(String(v.upload_request_id).startsWith("measurement-report:"));
  }
  const history = object(v.history, ["items", "next_before"]);
  array(history.items, 0, 25);
  if (history.next_before !== null) integer(history.next_before);
  for (const event of [
    ...history.items,
    v.current_candidates,
    v.current_review,
  ]) {
    if (event === null) continue;
    assertEvent(event);
    assert.equal(event.job_id, job);
    assert.equal(event.report_id, v.report.id);
  }
  if (v.current_candidates !== null) {
    assertEvent(v.current_candidates);
    assert.equal(v.current_candidates.kind, "candidate_set");
  }
  if (v.current_review !== null) {
    assertEvent(v.current_review);
    assert.equal(v.current_review.kind, "review");
    assertEvent(v.current_candidates);
    assert.equal(v.current_review.candidate_set_id, v.current_candidates.id);
    assert.equal(
      v.current_review.candidate_set_sha256,
      v.current_candidates.sha256,
    );
  }
  return v as Detail;
}
