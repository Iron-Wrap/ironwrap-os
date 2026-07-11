import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { salesResponseSchema, type SalesResponse } from "./sales-contracts";

export async function loadSales(fetcher: typeof fetch = fetch): Promise<SalesResponse> {
  return await apiRequest({
    path: API_PATHS.sales,
    schema: salesResponseSchema,
    fetcher,
  });
}
