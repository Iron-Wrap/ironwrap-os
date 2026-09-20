import { ApiError, apiRequest } from "../lib/api";
import {
  customerJobHistoryPath,
  customerJobHistoryResponseSchema,
  type CustomerJobHistoryResponse,
} from "./customer-history-contracts";

/**
 * Read this customer's other work.
 *
 * Deliberately NOT cached to the device, unlike the job packet beside it. The packet is cached so a
 * crew keeps today's work in a basement with no signal; this read is office context, held only by
 * roles that work online, and it carries addresses of properties the device was never sent to.
 * Writing that to durable storage would be a new disclosure for the sake of an offline case nobody
 * asked for.
 *
 * `null` means "nothing to show here": either this reader does not hold `jobs:read:any` (403) or
 * the job is not one the server will name (404). Both are ordinary, and neither is worth
 * interrupting the job packet with an error panel.
 */
export async function loadCustomerJobHistory(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<CustomerJobHistoryResponse | null> {
  try {
    return await apiRequest({
      path: customerJobHistoryPath(jobId),
      schema: customerJobHistoryResponseSchema,
      fetcher,
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}
