import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { safetyDeskResponseSchema, type SafetyDeskResponse } from "./safety-desk-contracts";

/** Reads only. Every state change on these rails already has its own command, and a
 *  browser-claimed equipment or corrective-action change has no fulfilment path here,
 *  so this module deliberately offers no write and touches no outbox. */
export const safetyDeskQueryKeys = { desk: ["safety", "desk"] as const };

export async function loadSafetyDesk(fetcher: typeof fetch = fetch): Promise<SafetyDeskResponse> {
  return await apiRequest({
    path: API_PATHS.safetyDesk,
    schema: safetyDeskResponseSchema,
    fetcher,
  });
}
