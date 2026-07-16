import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { customerPortalResponseSchema, type CustomerPortalResponse } from "./portal-contracts";

/** Public capability resolver: never attach an office/session cookie to this request. */
export async function loadCustomerPortal(
  token: string,
  fetcher?: typeof fetch,
): Promise<CustomerPortalResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalResolve,
    method: "POST",
    body: { token },
    schema: customerPortalResponseSchema,
    credentials: "omit",
    fetcher,
  });
}
