import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  operatingIntakeResponseSchema,
  type OperatingIntakeResponse,
} from "./operating-intake-contracts";

export async function loadOperatingIntake(
  fetcher: typeof fetch = fetch,
): Promise<OperatingIntakeResponse> {
  return await apiRequest({
    path: API_PATHS.operatingIntake,
    schema: operatingIntakeResponseSchema,
    fetcher,
  });
}
