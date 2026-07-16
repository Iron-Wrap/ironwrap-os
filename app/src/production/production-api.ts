import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  productionRunwayResponseSchema,
  type ProductionRunwayResponse,
} from "./production-contracts";

export async function loadProductionRunway(
  fetcher: typeof fetch = fetch,
): Promise<ProductionRunwayResponse> {
  return await apiRequest({
    path: API_PATHS.production,
    schema: productionRunwayResponseSchema,
    fetcher,
  });
}
