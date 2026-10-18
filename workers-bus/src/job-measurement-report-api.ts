import type { AppEnv, AuthContext } from "./app-types.ts";
import { validAppCsrf } from "./app-auth.ts";
import {
  reportList,
  reportDetail,
} from "./job-measurement-report-read-model.ts";
import {
  MAX_REPORT_BYTES,
  REPORT_ID,
  REQUEST_ID,
  ReportError,
  fail,
  validJob,
  parseUploadMetadata,
  parseCandidates,
  parseReview,
  uploadReport,
  resumeReport,
  reportBytes,
  bytesHash,
  recordReportEvent,
} from "./job-measurement-report-store.ts";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
async function bounded(req: Request, limit: number) {
  if (Number(req.headers.get("content-length") ?? 0) > limit)
    fail("report_body_too_large", 413);
  if (!req.body) fail("invalid_report_input");
  let count = 0;
  const chunks: Uint8Array[] = [];
  const reader = req.body.getReader();
  for (;;) {
    const value = await reader.read();
    if (value.done) break;
    count += value.value.byteLength;
    if (count > limit) {
      await reader.cancel();
      fail("report_body_too_large", 413);
    }
    chunks.push(value.value);
  }
  const all = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
async function jsonBody(req: Request) {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? ""))
    fail("report_json_required", 415);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        await bounded(req, 65536),
      ),
    );
  } catch (error) {
    if (error instanceof ReportError) throw error;
    fail("invalid_report_input");
  }
}
export async function handleJobMeasurementReports(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJob: string,
  encodedReport?: string,
  action?: string,
): Promise<Response> {
  try {
    if (!auth.permissions.includes("estimator:read"))
      return reply({ error: "estimator_read_required" }, 403);
    if (env.APP_TENANT_ID !== auth.session.tenant_id)
      return reply({ error: "tenant_identity_required" }, 403);
    const actor = {
      tenantId: auth.session.tenant_id,
      userId: auth.session.user_id,
    };
    const live = await env.DB.prepare(
      "SELECT COALESCE(access_role,role) AS role FROM app_users WHERE tenant_id=? AND user_id=? AND active=1",
    )
      .bind(actor.tenantId, actor.userId)
      .first<{ role: string }>();
    if (!live || !["owner", "ops", "sales"].includes(live.role))
      return reply({ error: "estimator_read_required" }, 403);
    const write =
      ["owner", "ops"].includes(auth.session.role) &&
      ["owner", "ops"].includes(live.role) &&
      auth.permissions.includes("measurements:record");
    let job: string, id: string | undefined;
    try {
      job = decodeURIComponent(encodedJob);
      id = encodedReport ? decodeURIComponent(encodedReport) : undefined;
    } catch {
      return reply({ error: "report_not_found" }, 404);
    }
    if (!validJob(job) || (id && !REPORT_ID.test(id)))
      return reply({ error: "report_not_found" }, 404);
    const url = new URL(req.url);
    if (req.method === "GET") {
      const allowed =
        id && !action ? ["before"] : !id ? ["before", "request_id"] : [];
      if (
        [...url.searchParams.keys()].some(
          (k) =>
            !allowed.includes(k) || url.searchParams.getAll(k).length !== 1,
        )
      )
        fail("invalid_report_query");
      if (id && action === "bytes") {
        const { report, bytes } = await reportBytes(
          env,
          actor.tenantId,
          job,
          id,
        );
        return new Response(bytes, {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(bytes.byteLength),
            "content-disposition": `attachment; filename="measurement-report.pdf"; filename*=UTF-8''${encodeURIComponent(report.file_name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }
      if (action) return reply({ error: "not_found" }, 404);
      const before = url.searchParams.get("before");
      if (id) {
        if (before !== null && !/^[1-9][0-9]{0,5}$|^1000000$/.test(before))
          fail("invalid_report_query");
        return reply(
          await reportDetail(
            env,
            actor,
            job,
            id,
            write,
            before === null ? undefined : Number(before),
          ),
        );
      }
      const requestId = url.searchParams.get("request_id");
      if (
        (requestId && !REQUEST_ID.test(requestId)) ||
        requestId === "" ||
        (before !== null && !REPORT_ID.test(before))
      )
        fail("invalid_report_query");
      return reply(await reportList(env, actor, job, write, requestId, before));
    }
    if (req.method !== "POST") return reply({ error: "not_found" }, 404);
    if (!write) return reply({ error: "report_write_required" }, 403);
    if (!validAppCsrf(req, auth)) return reply({ error: "csrf_failed" }, 403);
    if (url.search) fail("invalid_report_query");
    if (id && action === "resume") {
      const input = await jsonBody(req);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length
      )
        fail("invalid_report_input");
      return reply(await resumeReport(env, actor, job, id));
    }
    const key = req.headers.get("idempotency-key") ?? "";
    const prefix = !id
      ? "measurement-report:"
      : action === "candidate-sets"
        ? "report-candidates:"
        : action === "reviews"
          ? "report-review:"
          : "";
    if (!prefix) return reply({ error: "not_found" }, 404);
    if (!REQUEST_ID.test(key) || !key.startsWith(prefix))
      fail("invalid_report_request_id");
    if (!id) {
      const type = req.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("multipart/form-data;"))
        fail("report_multipart_required", 415);
      const body = await bounded(req, MAX_REPORT_BYTES + 65536);
      let form: FormData;
      try {
        form = await new Response(body, {
          headers: { "content-type": type },
        }).formData();
      } catch {
        fail("invalid_report_multipart");
      }
      if (
        [...form.keys()].length !== 2 ||
        form.getAll("file").length !== 1 ||
        form.getAll("metadata").length !== 1
      )
        fail("invalid_report_input");
      const file = form.get("file"),
        raw = form.get("metadata");
      if (
        !(file instanceof File) ||
        typeof raw !== "string" ||
        raw.length > 1024
      )
        fail("invalid_report_input");
      let meta: ReturnType<typeof parseUploadMetadata>;
      try {
        meta = parseUploadMetadata(JSON.parse(raw));
      } catch {
        fail("invalid_report_input");
      }
      if (file.type.toLowerCase() !== "application/pdf")
        fail("report_pdf_required", 415);
      if (file.size < 5 || file.size > MAX_REPORT_BYTES)
        fail("report_file_size_invalid", 413);
      if (
        !file.name ||
        file.name !== file.name.trim() ||
        file.name.length > 180 ||
        /[\u0000-\u001f\u007f/\\]/.test(file.name)
      )
        fail("invalid_report_filename");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
        fail("report_pdf_signature_invalid");
      if ((await bytesHash(bytes)) !== meta.file_sha256)
        fail("report_hash_mismatch", 409);
      const result = await uploadReport(
        env,
        actor,
        job,
        key,
        {
          ...meta,
          file_name: file.name,
          size_bytes: file.size,
          content_type: "application/pdf",
        },
        bytes,
      );
      return reply(result, result.replayed ? 200 : 201);
    }
    const value = await jsonBody(req);
    const kind = action === "candidate-sets" ? "candidate_set" : "review";
    const result = await recordReportEvent(
      env,
      actor,
      job,
      id,
      key,
      kind,
      kind === "candidate_set" ? parseCandidates(value) : parseReview(value),
    );
    return reply(result, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof ReportError)
      return reply({ error: error.code }, error.status);
    return reply({ error: "report_unavailable" }, 503);
  }
}
