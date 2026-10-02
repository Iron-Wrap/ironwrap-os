import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { nowResponseSchema, type DecisionKind, type NowResponse } from "./now-contracts";

export const nowPath = API_PATHS.now;

export async function loadNow(
  fetcher: typeof fetch = fetch,
  page?: { source: DecisionKind; cursor?: string },
): Promise<NowResponse> {
  const params = new URLSearchParams();
  // Older installed PWAs reject unknown response fields, so request the new
  // projection explicitly rather than changing the legacy response shape.
  params.set("include_decisions", "1");
  if (page) {
    params.set("decision_source", page.source);
    if (page.cursor) params.set("decision_cursor", page.cursor);
  }
  return await apiRequest({
    path: `${nowPath}?${params}`,
    schema: nowResponseSchema,
    fetcher,
  });
}
