import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  measurementIntakeOwnerExceptionsResponseSchema,
  ownerNowResponseSchema,
  ownerRuntimeResponseSchema,
  type MeasurementIntakeOwnerExceptionsResponse,
  type OwnerNowResponse,
  type OwnerRuntimeResponse,
} from "./owner-contracts";

export const ownerNowPath = "/api/v1/owner/now";
export const ownerRuntimePath = API_PATHS.ownerRuntime;
export const measurementIntakeExceptionsPath = API_PATHS.ownerMeasurementIntakeExceptions;

export async function loadOwnerNow(fetcher: typeof fetch = fetch): Promise<OwnerNowResponse> {
  return await apiRequest({
    path: ownerNowPath,
    schema: ownerNowResponseSchema,
    fetcher,
  });
}

export async function loadMeasurementIntakeExceptions(
  fetcher: typeof fetch = fetch,
): Promise<MeasurementIntakeOwnerExceptionsResponse> {
  return await apiRequest({
    path: measurementIntakeExceptionsPath,
    schema: measurementIntakeOwnerExceptionsResponseSchema,
    fetcher,
  });
}

export async function loadOwnerRuntime(
  fetcher: typeof fetch = fetch,
): Promise<OwnerRuntimeResponse> {
  return await apiRequest({
    path: ownerRuntimePath,
    schema: ownerRuntimeResponseSchema,
    fetcher,
  });
}
