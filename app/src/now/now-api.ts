import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { nowResponseSchema, type NowResponse } from "./now-contracts";

export const nowPath = API_PATHS.now;

export async function loadNow(fetcher: typeof fetch = fetch): Promise<NowResponse> {
  return await apiRequest({ path: nowPath, schema: nowResponseSchema, fetcher });
}
