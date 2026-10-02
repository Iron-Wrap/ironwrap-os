import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  ManualMeasurementError,
  readManualHead,
  readManualJob,
  readManualObservations,
  readManualReceipt,
} from "./job-manual-measurement-store.ts";

export function canRecordManualMeasurement(auth: AuthContext) {
  return (
    (auth.session.role === "owner" || auth.session.role === "ops") &&
    auth.permissions.includes("measurements:record")
  );
}
/** Read-only snapshot. A concurrent append cannot silently pair new facts with an old head. */
export async function buildManualMeasurementsReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobId: string,
  requestId: string | null,
  before?: number,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tenant = auth.session.tenant_id;
    const job = await readManualJob(env, tenant, jobId);
    const head = await readManualHead(env, tenant, jobId);
    const facts = await readManualObservations(env, tenant, jobId, before);
    const receipt = requestId
      ? await readManualReceipt(
          env,
          tenant,
          jobId,
          auth.session.user_id,
          requestId,
        )
      : null;
    const [latestHead, latestJob] = await Promise.all([
      readManualHead(env, tenant, jobId),
      readManualJob(env, tenant, jobId),
    ]);
    if (
      (latestHead?.observation_id ?? null) !== (head?.observation_id ?? null) ||
      latestJob.version !== job.version
    )
      continue;
    return {
      version: 1,
      tenant_id: tenant,
      read_model_generated_at: new Date().toISOString(),
      job,
      allowed_actions: canRecordManualMeasurement(auth)
        ? ["manual_measurement.record"]
        : [],
      observation_head: head?.observation_id ?? null,
      ...facts,
      requested_request_id: requestId,
      receipt,
    };
  }
  throw new ManualMeasurementError("manual_measurement_read_changed", 503);
}
