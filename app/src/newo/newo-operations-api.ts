import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  newoOperationsResponseSchema,
  type NewoOperationsResponse,
} from "./newo-operations-contracts";

export async function loadNewoOperations(
  fetcher: typeof fetch = fetch,
): Promise<NewoOperationsResponse> {
  return await apiRequest({
    path: API_PATHS.newoOperations,
    schema: newoOperationsResponseSchema,
    fetcher,
  });
}
