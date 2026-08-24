import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  integrationReadinessResponseSchema,
  type IntegrationReadinessResponse,
} from "./integration-readiness-contracts";

export async function loadIntegrationReadiness(
  fetcher: typeof fetch = fetch,
): Promise<IntegrationReadinessResponse> {
  return await apiRequest({
    path: API_PATHS.integrationReadiness,
    schema: integrationReadinessResponseSchema,
    fetcher,
  });
}
