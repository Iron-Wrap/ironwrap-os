import type { AppEnv, AuthContext } from "./app-types.ts";
import { validAppCsrf } from "./app-auth.ts";
import {
  buildManualMeasurementsReadModel,
  canRecordManualMeasurement,
} from "./job-manual-measurement-read-model.ts";
import {
  MANUAL_REQUEST_ID,
  ManualMeasurementError,
  parseManualMeasurementInput,
  recordManualMeasurement,
  validManualJobId,
} from "./job-manual-measurement-store.ts";

const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function body(req: Request) {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ManualMeasurementError(
      "invalid_manual_measurement_content_type",
      415,
    );
  if (Number(req.headers.get("content-length") ?? "0") > 8192)
    throw new ManualMeasurementError("manual_measurement_body_too_large", 413);
  const reader = req.body?.getReader();
  if (!reader)
    throw new ManualMeasurementError("invalid_manual_measurement", 400);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new ManualMeasurementError(
        "manual_measurement_body_too_large",
        413,
      );
    }
    parts.push(next.value);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data),
    );
  } catch {
    throw new ManualMeasurementError("invalid_manual_measurement", 400);
  }
}
export async function handleJobManualMeasurements(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobId: string,
): Promise<Response> {
  if (!auth.permissions.includes("estimator:read"))
    return reply({ error: "estimator_read_required" }, 403);
  if (env.APP_TENANT_ID !== auth.session.tenant_id)
    return reply({ error: "tenant_identity_required" }, 403);
  let jobId: string;
  try {
    jobId = decodeURIComponent(encodedJobId);
  } catch {
    return reply({ error: "manual_measurement_job_not_found" }, 404);
  }
  if (!validManualJobId(jobId))
    return reply({ error: "manual_measurement_job_not_found" }, 404);
  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (
        [...url.searchParams.keys()].some(
          (k) => !["request_id", "before"].includes(k),
        ) ||
        url.searchParams.getAll("request_id").length > 1 ||
        url.searchParams.getAll("before").length > 1
      )
        throw new ManualMeasurementError(
          "invalid_manual_measurement_query",
          400,
        );
      const requestId = url.searchParams.get("request_id");
      const rawBefore = url.searchParams.get("before");
      if (requestId !== null && !MANUAL_REQUEST_ID.test(requestId))
        throw new ManualMeasurementError(
          "invalid_manual_measurement_request_id",
          400,
        );
      if (rawBefore !== null && !/^[1-9][0-9]{0,6}$/.test(rawBefore))
        throw new ManualMeasurementError(
          "invalid_manual_measurement_cursor",
          400,
        );
      const before = rawBefore === null ? undefined : Number(rawBefore);
      if (before !== undefined && before > 1_000_000)
        throw new ManualMeasurementError(
          "invalid_manual_measurement_cursor",
          400,
        );
      return reply(
        await buildManualMeasurementsReadModel(
          env,
          auth,
          jobId,
          requestId,
          before,
        ),
      );
    }
    if (req.method !== "POST") return reply({ error: "not_found" }, 404);
    if (url.search)
      return reply({ error: "invalid_manual_measurement_query" }, 400);
    if (!canRecordManualMeasurement(auth))
      return reply({ error: "manual_measurement_record_required" }, 403);
    if (!validAppCsrf(req, auth)) return reply({ error: "csrf_failed" }, 403);
    const actor = await env.DB.prepare(
      "SELECT user_id FROM app_users WHERE tenant_id=? AND user_id=? AND active=1 AND COALESCE(access_role,role) IN ('owner','ops')",
    )
      .bind(auth.session.tenant_id, auth.session.user_id)
      .first();
    if (!actor)
      return reply({ error: "manual_measurement_record_required" }, 403);
    const requestId = req.headers.get("idempotency-key") ?? "";
    if (!MANUAL_REQUEST_ID.test(requestId))
      return reply({ error: "invalid_manual_measurement_request_id" }, 400);
    const input = parseManualMeasurementInput(await body(req));
    const result = await recordManualMeasurement(
      env,
      { tenantId: auth.session.tenant_id, userId: auth.session.user_id },
      jobId,
      requestId,
      input,
    );
    return reply(result, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof ManualMeasurementError)
      return reply({ error: error.code }, error.status);
    return reply({ error: "manual_measurement_unavailable" }, 503);
  }
}
