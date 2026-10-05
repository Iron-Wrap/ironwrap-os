import { ApiError, apiRequest } from "../lib/api";
import { PlainError } from "../lib/plain-error";
import {
  jobHistoryPath,
  jobHistoryResponseSchema,
  type JobHistoryResponse,
} from "./job-history-contracts";

/**
 * Read the record of one job, finished or not.
 *
 * Not cached to the device, like the customer history beside it and unlike the job packet: this is
 * an office read held by roles that work online, and a finished job is never the work in front of a
 * crew.
 *
 * `null` means there is nothing to show: either this reader does not hold `jobs:read:any` (403), or
 * the server will not name this job (404).
 */
export async function loadJobHistory(
  jobId: string,
  cursor: string | null = null,
  fetcher: typeof fetch = fetch,
): Promise<JobHistoryResponse | null> {
  try {
    const model = await apiRequest({
      path: jobHistoryPath(jobId, cursor),
      schema: jobHistoryResponseSchema,
      fetcher,
    });
    if (model.job.id !== jobId && model.job.roof_job_id !== jobId) {
      throw new PlainError("The job record does not match this link.");
    }
    return model;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}
