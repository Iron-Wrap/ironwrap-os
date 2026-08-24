import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  operatorSearchReadModelSchema,
  type OperatorSearchReadModel,
} from "./operator-search-contracts";

export async function loadOperatorSearch(
  session: AuthenticatedSession,
  query: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OperatorSearchReadModel> {
  return await apiRequest({
    path: API_PATHS.search(query),
    schema: operatorSearchReadModelSchema,
    signal,
    fetcher,
    deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
  });
}
