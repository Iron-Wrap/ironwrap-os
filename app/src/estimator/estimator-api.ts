import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  estimatorWorkbenchResponseSchema,
  type EstimatorWorkbenchResponse,
} from "./estimator-contracts";

export async function loadEstimatorWorkbench(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<EstimatorWorkbenchResponse> {
  return await apiRequest({
    path: API_PATHS.estimatorJob(jobId),
    schema: estimatorWorkbenchResponseSchema,
    fetcher,
  });
}
