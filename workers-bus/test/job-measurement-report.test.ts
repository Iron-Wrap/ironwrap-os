import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { auth, request, setup } from "./pipeline-board-fixture.ts";
import { bytesHash } from "../src/job-measurement-report-store.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import {
  parseReportResult,
  parseReportsList,
  parseReportDetail,
} from "./job-measurement-report-response-fixture.ts";
const JOB = "job:board:0001";
const BASE = `/api/v1/estimator/jobs/${encodeURIComponent(JOB)}/measurement-reports`;
const PDF = new TextEncoder().encode(
  "%PDF-1.7\nSynthetic report fixture\n%%EOF",
);
const key = (prefix = "measurement-report") =>
  `${prefix}:${crypto.randomUUID()}`;
class Bucket {
  objects = new Map<string, { bytes: Uint8Array; mime: string; sha: string }>();
  puts = 0;
  failPut = false;
  failAfterPut = false;
  failRead = false;
  async head(id: string) {
    if (this.failRead) throw Error("synthetic R2 outage");
    const o = this.objects.get(id);
    return o
      ? {
          size: o.bytes.length,
          customMetadata: { sha256: o.sha },
          checksums: {
            sha256: Uint8Array.from(o.sha.match(/../g)!, (x) => parseInt(x, 16))
              .buffer,
          },
        }
      : null;
  }
  async put(
    id: string,
    blob: Blob,
    opts: { httpMetadata: { contentType: string }; sha256: string },
  ) {
    this.puts++;
    if (this.failPut) throw Error("synthetic R2 write failed");
    if (!this.objects.has(id))
      this.objects.set(id, {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: opts.httpMetadata.contentType,
        sha: opts.sha256,
      });
    if (this.failAfterPut) throw Error("synthetic lost R2 response");
  }
  async get(id: string) {
    const head = await this.head(id);
    if (!head) return null;
    const o = this.objects.get(id)!;
    return { ...head, arrayBuffer: async () => o.bytes.slice().buffer };
  }
}
function fixture() {
  const f = setup(),
    bucket = new Bucket();
  f.env.RAW = bucket as never;
  f.db.raw
    .prepare(
      "UPDATE operating_roof_jobs SET job_number=NULL,version=version+1 WHERE roof_job_id=?",
    )
    .run(JOB);
  const original = f.db.batch.bind(f.db);
  let tail: Promise<unknown> = Promise.resolve();
  f.db.batch = (statements) => {
    const next = tail.then(() => original(statements));
    tail = next.catch(() => {});
    return next;
  };
  return { ...f, bucket };
}
type F = ReturnType<typeof fixture>;
function route(f: F, req: Request, actor = auth("owner")) {
  return handleAuthenticatedRoute(req, f.env, actor);
}
async function upload(
  f: F,
  id = key(),
  options: {
    bytes?: Uint8Array;
    mime?: string;
    name?: string;
    version?: number;
    meta?: unknown;
    actor?: ReturnType<typeof auth>;
    csrf?: boolean;
  } = {},
) {
  const bytes = options.bytes ?? PDF;
  const form = new FormData();
  form.set(
    "file",
    new File(
      [bytes as Uint8Array<ArrayBuffer>],
      options.name ?? "synthetic.pdf",
      { type: options.mime ?? "application/pdf" },
    ),
  );
  form.set(
    "metadata",
    JSON.stringify(
      options.meta ?? {
        expected_job_version: options.version ?? 2,
        file_sha256: await bytesHash(bytes),
      },
    ),
  );
  return route(
    f,
    new Request(`https://app.example.com${BASE}`, {
      method: "POST",
      headers: {
        "idempotency-key": id,
        ...(options.csrf === false ? {} : { "x-csrf-token": "csrf-token" }),
      },
      body: form,
    }),
    options.actor,
  );
}
const get = (f: F, suffix = "", actor = auth("owner")) =>
  route(f, request("GET", BASE + suffix), actor);
const post = (
  f: F,
  id: string,
  action: string,
  value: unknown,
  k = key(action === "candidate-sets" ? "report-candidates" : "report-review"),
  actor = auth("owner"),
  csrf = true,
) =>
  route(
    f,
    request("POST", `${BASE}/${id}/${action}`, {
      body: value,
      idempotency: k,
      csrf,
    }),
    actor,
  );
async function result(response: Response) {
  const value = await response.json();
  assert.ok([200, 201].includes(response.status), JSON.stringify(value));
  return parseReportResult(value);
}
async function list(response: Response) {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return parseReportsList(value);
}
async function detail(response: Response) {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return parseReportDetail(value);
}
async function error(response: Response, status: number, code?: string) {
  assert.equal(response.status, status);
  const body = (await response.json()) as { error: string };
  if (code) assert.equal(body.error, code);
  return body.error;
}
const total = (f: F) =>
  (f.db.raw.prepare("SELECT total_changes() n").get() as { n: number }).n;
const count = (f: F, t: string) =>
  (f.db.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
const facts = {
  area_label: "South roof",
  metric: "area",
  value: 1200,
  unit: "sq_ft",
  basis: "roof_surface",
  source_page: 1,
  source_label: "Roof area",
  uncertainty: "Printed rounding",
};
const candidates = (
  report: { sha256: string },
  head: string | null = null,
) => ({
  expected_job_version: 2,
  expected_report_head: head,
  report_sha256: report.sha256,
  correction_reason: head ? "Corrected transcription" : null,
  candidates: [facts],
});
function review(
  event: NonNullable<Awaited<ReturnType<typeof result>>["receipt"]["event"]>,
  head = event.id,
  reason: string | null = null,
) {
  assert.equal(event.kind, "candidate_set");
  if (event.kind !== "candidate_set") throw Error();
  return {
    expected_job_version: 2,
    expected_report_head: head,
    candidate_set_id: event.id,
    candidate_set_sha256: event.sha256,
    correction_reason: reason,
    decisions: event.candidates.map((c) => ({
      candidate_id: c.id,
      decision: "accept",
      reason: null,
    })),
  };
}

test("PDF route: numberless native job, private verified download, strict app readback and no other authority writes", async () => {
  const f = fixture();
  try {
    const untouched = [
        "job_manual_observations",
        "measurement_intake_receipts",
        "native_measurement_revisions",
        "measurement_deltas",
        "commercial_quote_revisions",
      ].map((t) => [t, count(f, t)] as const),
      k = key();
    const saved = await result(await upload(f, k));
    assert.equal(saved.report.state, "stored");
    assert.equal(saved.report.sha256, await bytesHash(PDF));
    assert.equal(saved.receipt.actor_user_id, auth("owner").session.user_id);
    assert.equal(f.bucket.puts, 1);
    const before = total(f);
    const model = await list(
      await get(f, `?request_id=${encodeURIComponent(k)}`),
    );
    assert.equal(model.job.job_number, null);
    assert.equal(model.job.version, 2);
    assert.deepEqual(model.receipt, saved.receipt);
    assert.equal(total(f), before);
    assert.deepEqual(
      (await list(await get(f, "", auth("sales")))).allowed_actions,
      [],
    );
    const bytes = await get(f, `/${saved.report.id}/bytes`);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get("cache-control"), "private, no-store");
    assert.equal(bytes.headers.get("x-content-type-options"), "nosniff");
    assert.match(bytes.headers.get("content-disposition")!, /^attachment;/);
    assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), PDF);
    const again = await result(await upload(f, k));
    assert.equal(again.replayed, true);
    assert.equal(f.bucket.puts, 1);
    for (const [t, n] of untouched) assert.equal(count(f, t), n);
    assert.equal(
      (await detail(await get(f, `/${saved.report.id}`))).history.items.length,
      0,
    );
    assert.deepEqual(f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});

test("upload intent survives missing bytes; GET does not repair; exact original replay completes after reload and job-version change", async () => {
  const f = fixture();
  try {
    const k = key();
    f.bucket.failPut = true;
    await error(await upload(f, k), 503);
    const n = total(f);
    const normalList = await list(await get(f));
    assert.equal(normalList.requested_request_id, null);
    const normalDetail = await detail(
      await get(f, `/${normalList.reports[0]!.id}`),
    );
    assert.equal(normalDetail.upload_request_id, k);
    assert.equal(normalDetail.report.job_version, 2);
    assert.equal(normalDetail.report.sha256, await bytesHash(PDF));
    for (const role of ["ops", "sales"] as const) {
      assert.equal(
        (await detail(await get(f, `/${normalDetail.report.id}`, auth(role))))
          .upload_request_id,
        null,
      );
    }
    const model = await list(
      await get(
        f,
        `?request_id=${encodeURIComponent(normalDetail.upload_request_id!)}`,
      ),
    );
    assert.equal(total(f), n);
    assert.equal(model.receipt_report?.state, "awaiting_bytes");
    const id = model.receipt_report!.id;
    await error(await post(f, id, "resume", {}), 409, "report_bytes_missing");
    assert.equal(count(f, "job_measurement_reports"), 1);
    f.db.raw
      .prepare(
        "UPDATE operating_roof_jobs SET version=version+1 WHERE roof_job_id=?",
      )
      .run(JOB);
    f.bucket.failPut = false;
    const saved = await result(
      await upload(f, normalDetail.upload_request_id!, {
        version: normalDetail.report.job_version,
      }),
    );
    assert.equal(saved.report.job_version, 2);
    assert.equal(saved.report.state, "stored");
    assert.equal(saved.replayed, true);
    await error(
      await upload(f, k, { bytes: new TextEncoder().encode("%PDF-other") }),
      409,
      "report_idempotency_conflict",
    );
    assert.equal(count(f, "job_measurement_reports"), 1);
  } finally {
    f.db.close();
  }
});

test("staged R2 bytes and DB commit failure resume explicitly without new byte upload", async () => {
  const f = fixture();
  try {
    const k = key();
    f.db.raw.exec(
      "CREATE TRIGGER test_fail_stored BEFORE UPDATE ON job_measurement_reports BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;",
    );
    await error(await upload(f, k), 503);
    const model = await list(
      await get(f, `?request_id=${encodeURIComponent(k)}`),
    );
    assert.equal(model.receipt_report?.state, "awaiting_bytes");
    assert.equal(f.bucket.objects.size, 1);
    const writes = total(f),
      puts = f.bucket.puts;
    await get(f, `/${model.receipt_report!.id}`);
    assert.equal(total(f), writes);
    f.db.raw.exec("DROP TRIGGER test_fail_stored");
    const resumed = await result(
      await post(f, model.receipt_report!.id, "resume", {}),
    );
    assert.equal(resumed.report.state, "stored");
    assert.equal(f.bucket.puts, puts);
    const n = total(f);
    await result(await post(f, resumed.report.id, "resume", {}));
    assert.equal(total(f), n);
    await error(
      await post(f, resumed.report.id, "resume", { file_name: "changed" }),
      400,
    );
  } finally {
    f.db.close();
  }
});

test("upload ledger reservation and R2 lost acknowledgement are recoverable without duplicate report", async () => {
  const f = fixture();
  try {
    const k = key();
    f.bucket.failAfterPut = true;
    await error(await upload(f, k), 503);
    const model = await list(
      await get(f, `?request_id=${encodeURIComponent(k)}`),
    );
    f.bucket.failAfterPut = false;
    const saved = await result(
      await post(f, model.receipt_report!.id, "resume", {}),
    );
    assert.equal(saved.report.state, "stored");
    assert.equal(f.bucket.puts, 1);
    assert.equal(count(f, "job_measurement_reports"), 1);
    f.db.raw.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON job_measurement_report_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;",
    );
    await error(await upload(f), 503);
    assert.equal(count(f, "job_measurement_reports"), 1);
    assert.equal(f.bucket.puts, 1);
  } finally {
    f.db.close();
  }
});

test("human transcription and accepted/rejected history stay immutable, corrections need reasons and never alter manual/geometry/quote truth", async () => {
  const f = fixture();
  try {
    const report = (await result(await upload(f))).report;
    const key1 = key("report-candidates");
    const first = await result(
      await post(f, report.id, "candidate-sets", candidates(report), key1),
    );
    const event = first.receipt.event!;
    const reviewed = await result(
      await post(f, report.id, "reviews", review(event)),
    );
    assert.equal(reviewed.receipt.event?.kind, "review");
    const secondInput = candidates(report, reviewed.report.head_id);
    secondInput.candidates[0] = { ...facts, value: 1250 };
    const second = await result(
      await post(f, report.id, "candidate-sets", secondInput),
    );
    const model = await detail(await get(f, `/${report.id}`));
    assert.equal(model.current_review, null);
    assert.equal(model.current_candidates?.id, second.receipt.event?.id);
    assert.equal(model.history.items.length, 3);
    const rejected = review(
      second.receipt.event!,
      second.report.head_id!,
      "Rechecked report",
    );
    rejected.decisions[0] = {
      ...rejected.decisions[0]!,
      decision: "reject",
      reason: "Printed figure is unclear",
    } as never;
    await result(await post(f, report.id, "reviews", rejected));
    const last = await detail(await get(f, `/${report.id}`));
    assert.equal(last.current_review?.decisions[0]?.decision, "reject");
    assert.equal(last.history.items.length, 4);
    f.db.raw
      .prepare(
        "UPDATE operating_roof_jobs SET version=version+1 WHERE roof_job_id=?",
      )
      .run(JOB);
    const replay = await result(
      await post(f, report.id, "candidate-sets", candidates(report), key1),
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt.event, event);
    for (const t of [
      "job_manual_observations",
      "measurement_intake_receipts",
      "native_measurement_revisions",
      "measurement_deltas",
    ])
      assert.equal(count(f, t), 0, t);
    for (const t of [
      "job_measurement_reports",
      "job_measurement_report_events",
      "job_measurement_report_receipts",
      "job_measurement_report_heads",
    ])
      assert.throws(() => f.db.raw.exec(`DELETE FROM ${t}`), /immutable/);
  } finally {
    f.db.close();
  }
});

test("parallel upload/review commands replay once and competing candidate/review heads cannot fork", async () => {
  const f = fixture();
  try {
    const k = key();
    const pair = await Promise.all([upload(f, k), upload(f, k)]);
    const saved = await Promise.all(pair.map(result));
    assert.equal(count(f, "job_measurement_reports"), 1);
    assert.equal(saved[0]!.report.id, saved[1]!.report.id);
    const r = saved[0]!.report;
    const c = await result(
      await post(f, r.id, "candidate-sets", candidates(r)),
    );
    const rk = key("report-review");
    await Promise.all([
      post(f, r.id, "reviews", review(c.receipt.event!), rk).then(result),
      post(f, r.id, "reviews", review(c.receipt.event!), rk).then(result),
    ]);
    assert.equal(count(f, "job_measurement_report_events"), 2);
    const head = (await detail(await get(f, `/${r.id}`))).report.head_id!;
    const races = await Promise.all([
      post(f, r.id, "candidate-sets", candidates(r, head)),
      post(
        f,
        r.id,
        "reviews",
        review(c.receipt.event!, head, "Rechecked source"),
      ),
    ]);
    assert.deepEqual(races.map((x) => x.status).sort(), [201, 409]);
    assert.equal(count(f, "job_measurement_report_events"), 3);
  } finally {
    f.db.close();
  }
});

test("CAS, candidate IDs/hash and immutable request guards refuse without writing", async () => {
  const f = fixture();
  try {
    const r = (await result(await upload(f))).report;
    const c = await result(
      await post(f, r.id, "candidate-sets", candidates(r)),
    );
    const base = review(c.receipt.event!);
    const n = total(f);
    for (const input of [
      { ...base, expected_report_head: `mrce_${"e".repeat(64)}` },
      { ...base, candidate_set_sha256: "f".repeat(64) },
      { ...base, decisions: [] },
      {
        ...base,
        decisions: [
          { ...base.decisions[0], candidate_id: `mrc_${"0".repeat(64)}` },
        ],
      },
      { ...base, expected_job_version: 1 },
    ]) {
      const res = await post(f, r.id, "reviews", input);
      assert.ok([400, 409].includes(res.status));
    }
    assert.equal(total(f), n);
    const good = await result(await post(f, r.id, "reviews", base));
    await error(
      await post(f, r.id, "reviews", {
        ...base,
        expected_report_head: good.report.head_id,
      }),
      400,
      "report_correction_reason_required",
    );
  } finally {
    f.db.close();
  }
});

test("current roles, cross tenant/job/actor, CSRF, unknown IDs and strict upload metadata fail closed", async () => {
  const f = fixture();
  try {
    const k = key(),
      saved = await result(await upload(f, k)),
      n = total(f),
      puts = f.bucket.puts;
    await error(await upload(f, key(), { actor: auth("sales") }), 403);
    await error(await upload(f, key(), { csrf: false }), 403);
    await error(
      await upload(f, key(), { actor: auth("owner", "other-tenant") }),
      403,
    );
    await error(await upload(f, "bad-id"), 400);
    await error(
      await upload(f, key(), {
        meta: {
          expected_job_version: 2,
          file_sha256: await bytesHash(PDF),
          r2_key: "forged",
        },
      }),
      400,
    );
    await error(await upload(f, key(), { mime: "text/html" }), 415);
    await error(
      await upload(f, key(), {
        bytes: new TextEncoder().encode("<html>not a PDF</html>"),
      }),
      400,
    );
    await error(
      await upload(f, key(), {
        meta: { expected_job_version: 2, file_sha256: "0".repeat(64) },
      }),
      409,
    );
    await error(
      await get(f, `?request_id=${encodeURIComponent(k)}`, auth("ops")),
      404,
    );
    await error(
      await post(f, saved.report.id, "resume", {}, key(), auth("ops")),
      404,
    );
    await error(await post(f, `mrpt_${"0".repeat(64)}`, "resume", {}), 404);
    await error(await get(f, "?request_id=bad"), 400);
    await error(await get(f, "?x=anything"), 400);
    assert.equal(total(f), n);
    assert.equal(f.bucket.puts, puts);
    f.db.raw
      .prepare("UPDATE app_users SET access_role='field' WHERE user_id=?")
      .run(auth("owner").session.user_id);
    await error(await get(f, `/${saved.report.id}/bytes`), 403);
    await error(await upload(f), 403);
  } finally {
    f.db.close();
  }
});

test("R2 read failure/corruption and D1 read failure never produce an empty or repaired success", async () => {
  const f = fixture();
  try {
    const saved = await result(await upload(f));
    f.bucket.failRead = true;
    const n = total(f);
    await error(await get(f, `/${saved.report.id}/bytes`), 503);
    await error(
      await post(
        f,
        saved.report.id,
        "candidate-sets",
        candidates(saved.report),
      ),
      503,
    );
    assert.equal(total(f), n);
    f.bucket.failRead = false;
    f.bucket.objects.values().next().value!.bytes[6] = 0;
    await error(
      await get(f, `/${saved.report.id}/bytes`),
      503,
      "report_integrity_failed",
    );
    f.db.raw.exec("DROP TABLE job_measurement_report_receipts");
    await error(await get(f, `/${saved.report.id}`), 503);
    await error(
      await get(
        f,
        `?request_id=${encodeURIComponent(saved.receipt.request_id)}`,
      ),
      503,
    );
  } finally {
    f.db.close();
  }
});

test("body byte limit is enforced even without declared content length", async () => {
  const f = fixture();
  try {
    const n = total(f);
    const res = await route(
      f,
      new Request(`https://app.example.com${BASE}`, {
        method: "POST",
        headers: {
          "x-csrf-token": "csrf-token",
          "idempotency-key": key(),
          "content-type": "multipart/form-data; boundary=test",
        },
        body: new Uint8Array(20 * 1024 * 1024 + 65537),
      }),
    );
    await error(res, 413, "report_body_too_large");
    assert.equal(total(f), n);
    assert.equal(f.bucket.puts, 0);
  } finally {
    f.db.close();
  }
});

test("actual PDF file limit and immutable upload metadata are checked before storage", async () => {
  const f = fixture();
  try {
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    oversized.set(PDF);
    await error(
      await upload(f, key(), { bytes: oversized }),
      413,
      "report_file_size_invalid",
    );
    assert.equal(count(f, "job_measurement_reports"), 0);
    assert.equal(f.bucket.puts, 0);
    const k = key();
    const saved = await result(await upload(f, k));
    const n = total(f),
      puts = f.bucket.puts;
    await error(
      await upload(f, k, { name: "renamed.pdf" }),
      409,
      "report_idempotency_conflict",
    );
    await error(
      await upload(f, k, { version: saved.report.job_version + 1 }),
      409,
      "report_idempotency_conflict",
    );
    assert.equal(total(f), n);
    assert.equal(f.bucket.puts, puts);
  } finally {
    f.db.close();
  }
});

test("unsuccessful database list/history responses stay unavailable rather than empty", async () => {
  const f = fixture();
  try {
    const saved = await result(await upload(f));
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (
        sql.startsWith("SELECT * FROM job_measurement_reports WHERE") ||
        sql.startsWith("SELECT * FROM job_measurement_report_events WHERE")
      ) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          bound.all = async () => ({ success: false, results: [] }) as never;
          return bound;
        };
      }
      return statement;
    };
    const n = total(f),
      puts = f.bucket.puts;
    await error(await get(f), 503, "report_readback_unavailable");
    await error(
      await get(f, `/${saved.report.id}`),
      503,
      "report_readback_unavailable",
    );
    assert.equal(total(f), n);
    assert.equal(f.bucket.puts, puts);
  } finally {
    f.db.close();
  }
});

test("receipt input hashes cannot mask a mismatch with immutable upload or event facts", async () => {
  for (const kind of ["upload", "candidate_set", "review"] as const) {
    const f = fixture();
    try {
      const uploaded = await result(await upload(f));
      let saved = uploaded;
      if (kind !== "upload")
        saved = await result(
          await post(
            f,
            uploaded.report.id,
            "candidate-sets",
            candidates(uploaded.report),
          ),
        );
      if (kind === "review")
        saved = await result(
          await post(
            f,
            uploaded.report.id,
            "reviews",
            review(saved.receipt.event!),
          ),
        );
      const row = f.db.raw
        .prepare(
          "SELECT input_json FROM job_measurement_report_receipts WHERE request_id=?",
        )
        .get(saved.receipt.request_id) as { input_json: string };
      const input = JSON.parse(row.input_json);
      if (kind === "upload") input.file_name = "different.pdf";
      if (kind === "candidate_set") input.candidates[0].value += 1;
      if (kind === "review")
        input.decisions[0].reason = "Different review reason";
      const json = canonicalJson(input);
      f.db.raw.exec("DROP TRIGGER job_measurement_report_receipts_no_update");
      f.db.raw
        .prepare(
          "UPDATE job_measurement_report_receipts SET input_json=?,request_hash=? WHERE request_id=?",
        )
        .run(json, await sha256Hex(json), saved.receipt.request_id);
      const n = total(f),
        puts = f.bucket.puts;
      await error(
        await get(
          f,
          `?request_id=${encodeURIComponent(saved.receipt.request_id)}`,
        ),
        503,
        "report_evidence_invalid",
      );
      if (kind === "upload") {
        await error(
          await get(f, `/${uploaded.report.id}`),
          503,
          "report_evidence_invalid",
        );
        await error(
          await post(f, uploaded.report.id, "resume", {}),
          503,
          "report_evidence_invalid",
        );
        await error(
          await upload(f, saved.receipt.request_id, { name: "different.pdf" }),
          503,
          "report_evidence_invalid",
        );
      }
      assert.equal(total(f), n);
      assert.equal(f.bucket.puts, puts);
    } finally {
      f.db.close();
    }
  }
});

test("report and event keyset pages retain exact receipt recovery beyond the first25 rows", async () => {
  const f = fixture();
  try {
    const saved = [];
    for (let i = 0; i < 27; i++) saved.push(await result(await upload(f)));
    const first = await list(await get(f));
    assert.equal(first.reports.length, 25);
    assert.ok(first.next_before);
    const second = await list(await get(f, `?before=${first.next_before}`));
    assert.equal(second.reports.length, 2);
    assert.equal(second.next_before, null);
    assert.equal(
      new Set([...first.reports, ...second.reports].map((r) => r.id)).size,
      27,
    );
    const old = saved.find((s) =>
      second.reports.some((r) => r.id === s.report.id),
    )!;
    const exact = await list(
      await get(f, `?request_id=${encodeURIComponent(old.receipt.request_id)}`),
    );
    assert.equal(exact.receipt_report?.id, old.report.id);
    const r = saved[0]!.report;
    let head: string | null = null;
    for (let i = 0; i < 27; i++) {
      const next = await result(
        await post(f, r.id, "candidate-sets", candidates(r, head)),
      );
      head = next.report.head_id;
    }
    const one = await detail(await get(f, `/${r.id}`));
    assert.equal(one.history.items.length, 25);
    assert.equal(one.current_candidates?.id, head);
    const two = await detail(
      await get(f, `/${r.id}?before=${one.history.next_before}`),
    );
    assert.equal(two.history.items.length, 2);
    assert.equal(two.history.next_before, null);
    assert.equal(
      new Set([...one.history.items, ...two.history.items].map((e) => e.id))
        .size,
      27,
    );
  } finally {
    f.db.close();
  }
});

test("post-commit acknowledgement loss recovers through exact read only receipt", async () => {
  const f = fixture();
  try {
    const k = key(),
      prepare = f.db.prepare.bind(f.db);
    let unavailable = true;
    f.db.prepare = (sql: string) => {
      if (
        unavailable &&
        sql.startsWith("SELECT * FROM job_measurement_report_receipts") &&
        f.db.raw
          .prepare("SELECT 1 FROM job_measurement_reports WHERE state='stored'")
          .get()
      )
        throw Error("synthetic postcommit read failure");
      return prepare(sql);
    };
    await error(await upload(f, k), 503);
    assert.equal(count(f, "job_measurement_reports"), 1);
    unavailable = false;
    const n = total(f),
      puts = f.bucket.puts;
    const saved = await list(
      await get(f, `?request_id=${encodeURIComponent(k)}`),
    );
    assert.equal(saved.receipt_report?.state, "stored");
    assert.equal(total(f), n);
    assert.equal(f.bucket.puts, puts);
    assert.equal((await result(await upload(f, k))).replayed, true);
  } finally {
    f.db.close();
  }
});

test("cross-job pointers, removed permission and role revocation during R2 storage cannot finalize or adjudicate", async () => {
  const f = fixture();
  try {
    const report = (await result(await upload(f))).report;
    const n = total(f);
    const other = BASE.replace(
      encodeURIComponent(JOB),
      encodeURIComponent("job:other:0002"),
    );
    await error(
      await route(f, request("GET", `${other}/${report.id}/bytes`)),
      404,
    );
    await error(await route(f, request("GET", `${other}/${report.id}`)), 404);
    const actor = auth("owner");
    actor.permissions = actor.permissions.filter(
      (p) => p !== "measurements:record",
    );
    await error(await upload(f, key(), { actor }), 403);
    assert.equal(total(f), n);
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (...args) => {
      await put(...args);
      f.db.raw
        .prepare("UPDATE app_users SET access_role='field' WHERE user_id=?")
        .run(auth("owner").session.user_id);
    };
    const k = key();
    await error(await upload(f, k), 503);
    assert.equal(
      (
        f.db.raw
          .prepare(
            "SELECT COUNT(*) n FROM job_measurement_reports WHERE state='awaiting_bytes'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    await error(await get(f, `?request_id=${encodeURIComponent(k)}`), 403);
  } finally {
    f.db.close();
  }
});

test("review/receipt batch rollback cannot leave a decision head or orphan decision", async () => {
  const f = fixture();
  try {
    const r = (await result(await upload(f))).report;
    const c = await result(
      await post(f, r.id, "candidate-sets", candidates(r)),
    );
    f.db.raw.exec(
      "CREATE TRIGGER fail_review_receipt BEFORE INSERT ON job_measurement_report_receipts WHEN NEW.kind='review' BEGIN SELECT RAISE(ABORT,'synthetic review receipt failure'); END;",
    );
    const k = key("report-review");
    await error(
      await post(f, r.id, "reviews", review(c.receipt.event!), k),
      503,
    );
    const model = await detail(await get(f, `/${r.id}`));
    assert.equal(model.report.head_id, c.report.head_id);
    assert.equal(model.history.items.length, 1);
    assert.equal(
      (await list(await get(f, `?request_id=${encodeURIComponent(k)}`)))
        .receipt,
      null,
    );
    f.db.raw.exec("DROP TRIGGER fail_review_receipt");
    await result(await post(f, r.id, "reviews", review(c.receipt.event!), k));
  } finally {
    f.db.close();
  }
});

test("0146 objects are included in both durable recovery inventories", () => {
  const migration = readFileSync(
    new URL("../migrations/0146_job_measurement_reports.sql", import.meta.url),
    "utf8",
  );
  const tables = [...migration.matchAll(/CREATE TABLE (\w+)/g)].map(
    (m) => m[1],
  );
  const indexes = [
    ...migration.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/g),
  ].map((m) => `${m[1]}=${m[2]}`);
  const triggers = [
    ...migration.matchAll(
      /CREATE TRIGGER (\w+) (?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE) ON (\w+)/g,
    ),
  ].map((m) => `${m[1]}=${m[2]}`);
  assert.equal(tables.length, 4);
  assert.equal(indexes.length, 3);
  assert.equal(triggers.length, 17);
  for (const path of [
    "../../deploy/backup-d1-to-r2.sh",
    "../../deploy/restore-d1-from-r2.sh",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const value of [...tables, ...indexes, ...triggers])
      assert.ok(source.includes(value), value);
  }
});

test("restored report history with a missing or older head cannot present a current review", async (t) => {
  for (const mode of ["missing", "older"] as const) {
    await t.test(mode, async () => {
      const f = fixture();
      try {
        const uploaded = await result(await upload(f));
        const transcribed = await result(
          await post(
            f,
            uploaded.report.id,
            "candidate-sets",
            candidates(uploaded.report),
          ),
        );
        const reviewed = await result(
          await post(
            f,
            uploaded.report.id,
            "reviews",
            review(transcribed.receipt.event!),
          ),
        );
        if (mode === "missing") {
          f.db.raw.exec(
            "DROP TRIGGER job_measurement_report_heads_no_delete; DELETE FROM job_measurement_report_heads",
          );
        } else {
          f.db.raw.exec("DROP TRIGGER job_report_head_update_guard");
          f.db.raw
            .prepare(
              "UPDATE job_measurement_report_heads SET event_id=?,sequence=1 WHERE report_id=?",
            )
            .run(transcribed.receipt.event!.id, uploaded.report.id);
        }
        const changes = total(f);
        await error(await get(f), 503, "report_evidence_invalid");
        await error(
          await get(f, `/${uploaded.report.id}`),
          503,
          "report_evidence_invalid",
        );
        await error(
          await post(
            f,
            uploaded.report.id,
            "candidate-sets",
            candidates(uploaded.report, reviewed.report.head_id),
          ),
          503,
          "report_evidence_invalid",
        );
        assert.equal(total(f), changes);
        assert.equal(count(f, "job_measurement_report_events"), 2);
        assert.equal(count(f, "job_measurement_report_receipts"), 3);
      } finally {
        f.db.close();
      }
    });
  }
});

test("native report event guard rejects missing, null and wrongly typed metadata before changing history", async (t) => {
  const f = fixture();
  try {
    const uploaded = await result(await upload(f));
    const eventId = `mrce_${await sha256Hex("synthetic-report-metadata-guard")}`;
    const timestamp = "2026-10-02T00:00:00.000Z";
    const metadata: Record<string, unknown> = {
      id: eventId,
      kind: "candidate_set",
      report_id: uploaded.report.id,
      job_id: JOB,
      sequence: 1,
      previous_head_id: null,
      job_version: 2,
      recorded_by: auth("owner").session.user_id,
      recorded_at: timestamp,
      correction_reason: null,
      source_kind: "human_transcription",
      candidates: [],
    };
    const statement = f.db.raw.prepare(
      "INSERT INTO job_measurement_report_events (event_id,tenant_id,roof_job_id,report_id,kind,sequence,previous_head_id,job_version,recorded_by,recorded_at,payload_json,sha256) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)",
    );
    const snapshot = () =>
      [
        "job_measurement_reports",
        "job_measurement_report_events",
        "job_measurement_report_heads",
        "job_measurement_report_receipts",
      ].map((table) => f.db.raw.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    async function reject(value: unknown) {
      const payload = canonicalJson(value);
      const hash = await sha256Hex(payload);
      f.db.raw.exec("SAVEPOINT malformed_report_metadata");
      try {
        assert.throws(
          () =>
            statement.run(
              eventId,
              uploaded.tenant_id,
              JOB,
              uploaded.report.id,
              "candidate_set",
              1,
              2,
              auth("owner").session.user_id,
              timestamp,
              payload,
              hash,
            ),
          /report_event_mismatch/,
        );
        assert.deepEqual(snapshot(), before);
      } finally {
        f.db.raw.exec("ROLLBACK TO malformed_report_metadata");
        f.db.raw.exec("RELEASE malformed_report_metadata");
      }
    }
    for (const field of [
      "id",
      "kind",
      "report_id",
      "job_id",
      "sequence",
      "previous_head_id",
      "job_version",
      "recorded_by",
      "recorded_at",
    ]) {
      await t.test(`missing ${field}`, async () => {
        const invalid = { ...metadata };
        delete invalid[field];
        await reject(invalid);
      });
      if (field !== "previous_head_id") {
        await t.test(`null ${field}`, () =>
          reject({ ...metadata, [field]: null }),
        );
      }
    }
    for (const field of ["sequence", "job_version"]) {
      for (const value of [String(metadata[field]), true]) {
        await t.test(`${field} has type ${typeof value}`, () =>
          reject({ ...metadata, [field]: value }),
        );
      }
    }
    for (const value of [[], null, true]) {
      await t.test(`non-object ${JSON.stringify(value)}`, () => reject(value));
    }
    // The original valid API producer still records an explicit null parent.
    const recorded = await result(
      await post(
        f,
        uploaded.report.id,
        "candidate-sets",
        candidates(uploaded.report),
      ),
    );
    assert.equal(recorded.receipt.event?.previous_head_id, null);
    assert.equal(count(f, "job_measurement_report_events"), 1);
    assert.equal(count(f, "job_measurement_report_heads"), 1);
  } finally {
    f.db.close();
  }
});

test("owner privacy audit inventories governed reports and checks exact bytes", async () => {
  const f = fixture();
  const audit = "/api/v1/privacy/measurement-reports";
  try {
    const first = await result(await upload(f));
    const second = await result(await upload(f));
    const listed = await route(f, request("GET", `${audit}?limit=1`));
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "private, no-store");
    const page = (await listed.json()) as {
      items: Array<{
        report_id: string;
        roof_job_id: string;
        current_job_customer_id: string;
      }>;
      next_before: string;
    };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.roof_job_id, JOB);
    assert.ok(page.items[0]!.current_job_customer_id);
    assert.match(page.next_before, /^mrpt_[0-9a-f]{64}$/);
    const next = await route(
      f,
      request("GET", `${audit}?limit=1&before=${page.next_before}`),
    );
    assert.equal(next.status, 200);
    const other = (await next.json()) as {
      items: Array<{ report_id: string }>;
    };
    assert.equal(other.items.length, 1);
    assert.notEqual(other.items[0]!.report_id, page.items[0]!.report_id);
    assert.deepEqual(
      new Set([first.report.id, second.report.id]),
      new Set([page.items[0]!.report_id, other.items[0]!.report_id]),
    );

    const path = `${audit}/${first.report.id}/audit`;
    const read = () => route(f, request("GET", path));
    const status = async () => {
      const response = await read();
      assert.equal(response.status, 200);
      return (await response.json()) as {
        object_status: string;
        report_id: string;
      };
    };
    assert.deepEqual(await status(), {
      version: 1,
      report_id: first.report.id,
      roof_job_id: JOB,
      current_job_customer_id: page.items[0]!.current_job_customer_id,
      uploaded_by: auth("owner").session.user_id,
      file_name: "synthetic.pdf",
      content_type: "application/pdf",
      size_bytes: PDF.byteLength,
      sha256: await bytesHash(PDF),
      r2_key: [...f.bucket.objects.keys()].find((key) =>
        key.includes(first.report.id),
      ),
      state: "stored",
      created_at: first.report.created_at,
      stored_at: first.report.stored_at,
      object_status: "ok",
    });
    const rawKey = [...f.bucket.objects.keys()].find((key) =>
      key.includes(first.report.id),
    )!;
    const original = f.bucket.objects.get(rawKey)!;
    f.bucket.objects.set(rawKey, {
      ...original,
      bytes: new Uint8Array([1, 2, 3]),
    });
    assert.equal((await status()).object_status, "mismatch");
    f.bucket.objects.delete(rawKey);
    assert.equal((await status()).object_status, "missing");
    f.bucket.failRead = true;
    assert.equal((await status()).object_status, "unavailable");
  } finally {
    f.db.close();
  }
});

test("privacy report audit requires the current owner and rejects invalid queries", async () => {
  const f = fixture();
  const audit = "/api/v1/privacy/measurement-reports";
  try {
    await error(await route(f, request("GET", audit), auth("sales")), 403);
    await error(
      await route(f, request("GET", audit), auth("owner", "other-co")),
      403,
    );
    await error(await route(f, request("GET", `${audit}?limit=0`)), 400);
    await error(await route(f, request("GET", `${audit}?before=bad`)), 400);
    await error(await route(f, request("GET", `${audit}?extra=1`)), 400);
    f.db.raw
      .prepare(
        "UPDATE app_users SET access_role='sales' WHERE tenant_id=? AND user_id=?",
      )
      .run("ironwrap", auth("owner").session.user_id);
    await error(await route(f, request("GET", audit)), 403);
  } finally {
    f.db.close();
  }
});

test("privacy audit distinguishes an interrupted upload with staged bytes", async () => {
  const f = fixture();
  try {
    f.bucket.failPut = true;
    await error(await upload(f), 503);
    const row = f.db.raw
      .prepare("SELECT report_id, r2_key FROM job_measurement_reports")
      .get() as { report_id: string; r2_key: string };
    const read = async () => {
      const response = await route(
        f,
        request(
          "GET",
          `/api/v1/privacy/measurement-reports/${row.report_id}/audit`,
        ),
      );
      assert.equal(response.status, 200);
      return (await response.json()) as { object_status: string };
    };
    assert.equal((await read()).object_status, "awaiting_bytes_missing");
    f.bucket.objects.set(row.r2_key, {
      bytes: PDF,
      mime: "application/pdf",
      sha: await bytesHash(PDF),
    });
    assert.equal((await read()).object_status, "awaiting_bytes_present");
    const changed = PDF.slice();
    changed[5] = changed[5]! ^ 1;
    f.bucket.objects.set(row.r2_key, {
      bytes: changed,
      mime: "application/pdf",
      sha: await bytesHash(PDF),
    });
    assert.equal((await read()).object_status, "mismatch");
  } finally {
    f.db.close();
  }
});
