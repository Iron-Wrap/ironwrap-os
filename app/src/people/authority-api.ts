import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  authorityDeskResponseSchema,
  authorityReadbacksResponseSchema,
  type AuthorityDeskResponse,
} from "./authority-contracts";

/** Reads only. The desk files no action: a browser-claimed action has no fulfilment path yet,
 *  so a button here would file requests nobody completes. See IRO-251. */
export const authorityQueryKeys = {
  desk: ["authority", "desk"] as const,
  readbacks: (recordId: string) => ["authority", "readbacks", recordId] as const,
};

export async function loadAuthorityDesk(
  fetcher: typeof fetch = fetch,
): Promise<AuthorityDeskResponse> {
  return await apiRequest({
    path: API_PATHS.authorityRecords,
    schema: authorityDeskResponseSchema,
    fetcher,
  });
}

export async function loadAuthorityReadbacks(recordId: string, fetcher: typeof fetch = fetch) {
  return await apiRequest({
    path: API_PATHS.authorityRecordReadbacks(recordId),
    schema: authorityReadbacksResponseSchema,
    fetcher,
  });
}
