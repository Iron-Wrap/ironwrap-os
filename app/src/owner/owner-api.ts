import { apiRequest } from "../lib/api";
import { ownerNowResponseSchema, type OwnerNowResponse } from "./owner-contracts";

export const ownerNowPath = "/api/v1/owner/now";

export async function loadOwnerNow(fetcher: typeof fetch = fetch): Promise<OwnerNowResponse> {
  return await apiRequest({
    path: ownerNowPath,
    schema: ownerNowResponseSchema,
    fetcher,
  });
}
