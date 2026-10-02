import { API_PATHS } from "../lib/api-paths";
import {
  publicInstantEstimateRequestSchema,
  publicInstantEstimateResponseSchema,
  type PublicInstantEstimateRequest,
  type PublicInstantEstimateResponse,
} from "./public-estimate-contracts";
import { publicRequest } from "./public-estimate-request";

export { loadPublicEstimateConfig } from "./public-estimate-config";
export { PublicEstimateApiError } from "./public-estimate-request";

export async function submitPublicInstantEstimate(
  input: PublicInstantEstimateRequest,
  fetcher: typeof fetch = fetch,
): Promise<PublicInstantEstimateResponse> {
  const body = publicInstantEstimateRequestSchema.parse(input);
  return publicRequest(API_PATHS.publicInstantEstimate, publicInstantEstimateResponseSchema, {
    fetcher,
    body,
    idempotencyKey: body.client_submission_id,
  });
}
