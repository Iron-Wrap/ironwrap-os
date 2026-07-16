import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  customerPortalIssueInputSchema,
  customerPortalIssueResponseSchema,
  customerPortalLinksResponseSchema,
  customerPortalRevokeResponseSchema,
  type CustomerPortalIssueInput,
  type CustomerPortalIssueResponse,
  type CustomerPortalLinksResponse,
} from "./customer-portal-office-contracts";

const portalTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export async function loadCustomerPortalLinks(
  roofJobId: string,
  fetcher: typeof fetch = fetch,
): Promise<CustomerPortalLinksResponse> {
  const path = new URLSearchParams({ roof_job_id: roofJobId });
  return await apiRequest({
    path: `${API_PATHS.customerPortalLinks}?${path.toString()}`,
    schema: customerPortalLinksResponseSchema,
    fetcher,
  });
}

export async function issueCustomerPortalLink(
  session: AuthenticatedSession,
  input: CustomerPortalIssueInput,
  fetcher: typeof fetch = fetch,
): Promise<CustomerPortalIssueResponse> {
  const issue = customerPortalIssueInputSchema.parse(input);
  const result = await apiRequest({
    path: API_PATHS.customerPortalLinks,
    schema: customerPortalIssueResponseSchema,
    method: "POST",
    body: { roof_job_id: issue.roofJobId, expires_at: issue.expiresAt },
    csrfToken: session.csrf_token,
    fetcher,
  });
  const portalUrl = verifiedCustomerPortalUrl(result.portal_url);
  if (!portalUrl) {
    throw new ApiError({
      status: 200,
      code: "invalid_portal_url",
      message: "The server returned an invalid customer access link.",
    });
  }
  return { ...result, portal_url: portalUrl };
}

export async function revokeCustomerPortalLink(
  session: AuthenticatedSession,
  linkId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await apiRequest({
    path: API_PATHS.customerPortalLinkRevoke(linkId),
    schema: customerPortalRevokeResponseSchema,
    method: "POST",
    csrfToken: session.csrf_token,
    fetcher,
  });
}

/**
 * The raw capability may only be rendered for the exact same-origin fixed portal route.
 * It remains in component-local state and is never put into a query cache or history link.
 */
export function verifiedCustomerPortalUrl(
  value: string,
  expectedOrigin = window.location.origin,
): string | null {
  try {
    const portal = new URL(value);
    if (
      portal.origin !== expectedOrigin ||
      portal.pathname !== "/portal" ||
      portal.search ||
      portal.username ||
      portal.password
    ) {
      return null;
    }
    const fragment = new URLSearchParams(portal.hash.slice(1));
    if (fragment.size !== 1) return null;
    const token = fragment.get("token");
    if (!token || !portalTokenPattern.test(token) || portal.hash !== `#token=${token}`) return null;
    return portal.toString();
  } catch {
    return null;
  }
}
