import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import type { AppRole } from "../lib/roles";
import {
  ADMIN_ERROR_MESSAGES,
  appUserListResponseSchema,
  appUserMutationResponseSchema,
  companyProfileResponseSchema,
  type CompanyProfileInput,
  type CompanyProfileResponse,
} from "./admin-contracts";

export async function loadCompanyProfile(
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyProfile,
    schema: companyProfileResponseSchema,
    fetcher,
  });
}

export async function saveCompanyProfile(
  session: AuthenticatedSession,
  input: CompanyProfileInput,
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyProfile,
    method: "PUT",
    body: input,
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function uploadCompanyLogo(
  session: AuthenticatedSession,
  logo: { contentType: string; dataBase64: string },
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyLogo,
    method: "PUT",
    body: { content_type: logo.contentType, data_base64: logo.dataBase64 },
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    // A logo is larger than a form post and can be uploaded on a job-site connection.
    timeoutMs: 30_000,
    fetcher,
  });
}

export async function removeCompanyLogo(
  session: AuthenticatedSession,
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyLogo,
    method: "DELETE",
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    fetcher,
  });
}

export async function listAppUsers(fetcher: typeof fetch = fetch) {
  return await apiRequest({
    path: API_PATHS.adminAppUsers,
    schema: appUserListResponseSchema,
    fetcher,
  });
}

export async function provisionAppUser(
  session: AuthenticatedSession,
  input: { email: string; displayName: string; role: AppRole; active: boolean },
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminAppUsers,
    method: "POST",
    body: {
      tenant_id: session.tenant.id,
      email: input.email,
      display_name: input.displayName,
      role: input.role,
      frappe_user_id: null,
      active: input.active,
    },
    schema: appUserMutationResponseSchema,
    csrfToken: session.csrf_token,
    fetcher,
  });
}

/** Reads a picked file as the base64 payload the logo route accepts. */
export async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so a large logo does not blow the argument limit of String.fromCharCode.
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

export function adminErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return ADMIN_ERROR_MESSAGES[error.code] ?? error.message;
  }
  return "Something stopped that from saving. Check your connection and try again.";
}
