import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  estimatorWorkbenchResponseSchema,
  facetLaunchResponseSchema,
  type FacetLaunchResponse,
  type EstimatorWorkbenchResponse,
} from "./estimator-contracts";

export async function loadEstimatorWorkbench(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<EstimatorWorkbenchResponse> {
  return await apiRequest({
    path: `${API_PATHS.estimatorJob(jobId)}?include_job_identity=1`,
    schema: estimatorWorkbenchResponseSchema,
    fetcher,
  });
}

export function newFacetLaunchKey(): string {
  return `facet-launch:${crypto.randomUUID()}`;
}

export async function createFacetLaunch(
  jobId: string,
  csrfToken: string,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<FacetLaunchResponse> {
  return await apiRequest({
    path: API_PATHS.estimatorFacetLaunch(jobId),
    schema: facetLaunchResponseSchema,
    method: "POST",
    body: {},
    csrfToken,
    idempotencyKey,
    fetcher,
  });
}

export function navigateToFacetLaunch(
  response: FacetLaunchResponse,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  const validated = facetLaunchResponseSchema.parse(response);
  navigate(validated.launch.launch_url);
}
