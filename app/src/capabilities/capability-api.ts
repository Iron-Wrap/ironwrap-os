import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  capabilitySignalResponseSchema,
  type CapabilitySignalResponse,
} from "./capability-contracts";

export async function loadCapabilitySignal(
  fetcher: typeof fetch = fetch,
): Promise<CapabilitySignalResponse> {
  return await apiRequest({
    path: API_PATHS.capabilities,
    schema: capabilitySignalResponseSchema,
    fetcher,
  });
}
