import { z } from "zod";

import { deleteMeta, getMeta, setMeta } from "../storage/db";
import { ApiError, apiRequest, isRetryableApiError } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { appRoles } from "../lib/roles";
import { clearDeviceSecret, getDeviceSecret } from "./device-credential";

const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  display_name: z.string().min(1),
  role: z.enum(appRoles),
  frappe_user_id: z.string().min(1).nullable(),
});

const tenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().min(1),
  locale: z.string().min(2),
  time_zone: z.string().min(1),
  currency: z.string().length(3),
  /** The company's office phone from its profile, dialable from a crew phone; absent until set. */
  office_phone: z
    .string()
    .trim()
    .transform((value) => value || null)
    .nullish(),
});

const sessionBaseSchema = z.object({
  version: z.literal(1),
  permissions: z.array(z.string()),
  allowed_actions: z.array(z.string()),
  source_updated_at: z.string().min(1).nullable(),
  read_model_generated_at: z.string().min(1),
  stale_fields: z.array(z.string()),
});

export const sessionResponseSchema = z.discriminatedUnion("authenticated", [
  sessionBaseSchema.extend({
    authenticated: z.literal(false),
    user: z.null(),
    tenant: tenantSchema.nullable(),
    csrf_token: z.null(),
    session_expires_at: z.null(),
  }),
  sessionBaseSchema.extend({
    authenticated: z.literal(true),
    user: userSchema,
    tenant: tenantSchema,
    csrf_token: z.string().min(1),
    session_expires_at: z.string().min(1),
  }),
]);

export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type AuthenticatedSession = Extract<SessionResponse, { authenticated: true }>;

const SNAPSHOT_KEY = "authenticated-session-v1";
/**
 * The expiry of this browser's sign-in, kept in localStorage beside the snapshot: written with it,
 * removed with it (sign-out, or a session read that finds no sign-in), and holding no identity. The
 * customer portal reads it synchronously, so a customer's device never opens the local database
 * just to learn that nobody from the office signed in there.
 */
const OFFICE_SESSION_MARKER = "ironwrap.office-session-expires-at";

interface OfflineSessionSnapshot {
  session: AuthenticatedSession;
  expiresAt: number;
}

export async function fetchSession(fetcher: typeof fetch = fetch): Promise<SessionResponse> {
  try {
    const session = await apiRequest({
      path: API_PATHS.session,
      schema: sessionResponseSchema,
      fetcher,
      deviceProof: getDeviceSecret,
    });
    return await persistOrInvalidateSession(session);
  } catch (error) {
    return await recoverOfflineSession(error);
  }
}

export async function persistOrInvalidateSession(
  session: SessionResponse,
): Promise<SessionResponse> {
  if (session.authenticated) {
    await persistAuthenticatedSession(session);
    return session;
  }

  const snapshot = await getMeta<OfflineSessionSnapshot>(SNAPSHOT_KEY);
  await clearSessionSnapshot();
  if (snapshot?.session.user.role !== "field") return session;
  await clearDeviceSecret();
  return {
    ...session,
    stale_fields: [...new Set([...session.stale_fields, "field_device_repair_required"])],
  };
}

export async function persistAuthenticatedSession(session: AuthenticatedSession): Promise<void> {
  const expiresAt = Date.parse(session.session_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  writeOfficeSessionMarker(expiresAt);
  await setMeta(SNAPSHOT_KEY, {
    session: { ...session, csrf_token: "offline-session-no-csrf" },
    expiresAt,
  } satisfies OfflineSessionSnapshot);
}

export async function recoverOfflineSession(error: unknown): Promise<SessionResponse> {
  if (!isRetryableApiError(error)) throw error;
  const snapshot = await getMeta<OfflineSessionSnapshot>(SNAPSHOT_KEY);
  if (!snapshot || snapshot.expiresAt <= Date.now()) {
    await clearSessionSnapshot();
    throw error;
  }
  const parsed = sessionResponseSchema.safeParse(snapshot.session);
  if (!parsed.success || !parsed.data.authenticated) {
    await clearSessionSnapshot();
    throw new ApiError({
      status: 0,
      code: "offline_session_invalid",
      message: "We could not check the saved sign-in. Go online and sign in again.",
      cause: parsed.success ? undefined : parsed.error,
    });
  }
  return {
    ...parsed.data,
    csrf_token: "offline-session-no-csrf",
    stale_fields: [...new Set([...parsed.data.stale_fields, "session.offline_snapshot"])],
  };
}

/**
 * True while this browser holds an unexpired sign-in, read from its localStorage marker without
 * touching the local database or sending the office cookie anywhere. Unreadable storage is false.
 */
export function officeSessionIsLive(): boolean {
  try {
    return Number(window.localStorage.getItem(OFFICE_SESSION_MARKER)) > Date.now();
  } catch {
    return false;
  }
}

function writeOfficeSessionMarker(expiresAt: number | null): void {
  try {
    if (expiresAt === null) window.localStorage.removeItem(OFFICE_SESSION_MARKER);
    else window.localStorage.setItem(OFFICE_SESSION_MARKER, String(expiresAt));
  } catch {
    // Storage can be unavailable (private browsing, a worker); the portal then records the open.
  }
}

export async function clearSessionSnapshot(): Promise<void> {
  writeOfficeSessionMarker(null);
  await deleteMeta(SNAPSHOT_KEY);
}

export function isOfflineSession(session: AuthenticatedSession): boolean {
  return session.csrf_token === "offline-session-no-csrf";
}
