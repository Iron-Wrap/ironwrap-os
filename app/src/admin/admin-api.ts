import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import type { AppRole } from "../lib/roles";
import {
  ADMIN_ERROR_MESSAGES,
  accessConflictSchema,
  appUserListResponseSchema,
  appUserMutationResponseSchema,
  companyProfileResponseSchema,
  setupProgressResponseSchema,
  type AccessConflict,
  type CompanyProfileInput,
  type CompanyProfileResponse,
  type SetupProgressResponse,
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
  expectedProfileVersion: number,
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyProfile,
    method: "PUT",
    body: { ...input, expected_profile_version: expectedProfileVersion },
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: companyProfileActionKey("details"),
    fetcher,
  });
}

export async function uploadCompanyLogo(
  session: AuthenticatedSession,
  logo: { contentType: string; dataBase64: string },
  expectedProfileVersion: number,
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyLogo,
    method: "PUT",
    body: {
      content_type: logo.contentType,
      data_base64: logo.dataBase64,
      expected_profile_version: expectedProfileVersion,
    },
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: companyProfileActionKey("logo-upload"),
    // A logo is larger than a form post and can be uploaded on a job-site connection.
    timeoutMs: 30_000,
    fetcher,
  });
}

export async function removeCompanyLogo(
  session: AuthenticatedSession,
  expectedProfileVersion: number,
  fetcher: typeof fetch = fetch,
): Promise<CompanyProfileResponse> {
  return await apiRequest({
    path: API_PATHS.adminCompanyLogo,
    method: "DELETE",
    body: { expected_profile_version: expectedProfileVersion },
    schema: companyProfileResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: companyProfileActionKey("logo-remove"),
    fetcher,
  });
}

export async function loadSetupProgress(
  fetcher: typeof fetch = fetch,
): Promise<SetupProgressResponse> {
  return await apiRequest({
    path: API_PATHS.adminSetupProgress,
    schema: setupProgressResponseSchema,
    fetcher,
  });
}

function companyProfileActionKey(kind: string): string {
  return `company-profile:${kind}:${crypto.randomUUID()}`;
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
  input: {
    email: string;
    displayName: string;
    role: AppRole;
    active: boolean;
    /** The version the person's access carried when this change was decided; none for a new person. */
    expectedAccessVersion?: number;
  },
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
      ...(input.expectedAccessVersion === undefined
        ? {}
        : { expected_access_version: input.expectedAccessVersion }),
    },
    schema: appUserMutationResponseSchema,
    csrfToken: session.csrf_token,
    fetcher,
  });
}

/**
 * Whether a change was refused because the person's access moved since it was decided, and what
 * the Worker says moved: `undefined` for any other failure, `null` for a conflict whose body this
 * app cannot read (it still is a conflict).
 */
export function accessConflictOf(error: unknown): AccessConflict | null | undefined {
  if (!(error instanceof ApiError) || error.code !== "access_version_conflict") return undefined;
  const parsed = accessConflictSchema.safeParse(error.details.conflict);
  return parsed.success ? parsed.data : null;
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
  // ADMIN_ERROR_MESSAGES is the written copy for the codes this product raises.
  // An uncurated code means no sentence was written for it, and `error.message`
  // there is whatever the transport produced - for a bare 503 that is the HTTP
  // phrase "Service Unavailable", which reached the setup hub verbatim. A
  // status phrase is a policy code wearing title case; write a sentence instead.
  if (error instanceof ApiError) {
    return ADMIN_ERROR_MESSAGES[error.code] ?? "That did not go through. Try again in a moment.";
  }
  return "Something stopped that from saving. Check your connection and try again.";
}
