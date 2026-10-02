import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  manualMeasurementInputSchema,
  manualMeasurementRequestIdSchema,
  manualMeasurementResultSchema,
  manualMeasurementsResponseSchema,
  type ManualMeasurementInput,
  type ManualMeasurementResult,
  type ManualMeasurementsResponse,
} from "./manual-measurement-contracts";

export function newManualMeasurementRequestId(): string {
  return `manual-measurement:${crypto.randomUUID()}`;
}
export async function loadManualMeasurements(
  jobId: string,
  options: { requestId?: string; before?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<ManualMeasurementsResponse> {
  if (options.requestId) manualMeasurementRequestIdSchema.parse(options.requestId);
  const query = new URLSearchParams();
  if (options.requestId) query.set("request_id", options.requestId);
  if (options.before !== undefined) query.set("before", String(options.before));
  return apiRequest({
    path: `${API_PATHS.manualMeasurements(jobId)}${query.size ? `?${query}` : ""}`,
    schema: manualMeasurementsResponseSchema.refine(
      (value) =>
        value.job.id === jobId && value.requested_request_id === (options.requestId ?? null),
      "Manual measurement identity mismatch",
    ),
    fetcher,
  });
}
export async function recordManualMeasurement(
  session: AuthenticatedSession,
  jobId: string,
  input: ManualMeasurementInput,
  requestId: string,
  fetcher: typeof fetch = fetch,
): Promise<ManualMeasurementResult> {
  manualMeasurementRequestIdSchema.parse(requestId);
  const parsed = manualMeasurementInputSchema.parse(input);
  return apiRequest({
    path: API_PATHS.manualMeasurements(jobId),
    schema: manualMeasurementResultSchema.refine(
      (value) =>
        value.tenant_id === session.tenant.id &&
        value.job_id === jobId &&
        value.receipt.request_id === requestId &&
        value.receipt.observation.recorded_by === session.user.id,
      "Manual measurement identity mismatch",
    ),
    method: "POST",
    body: parsed,
    csrfToken: session.csrf_token,
    idempotencyKey: requestId,
    fetcher,
  });
}
