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
    if (session.authenticated) {
      const expiresAt = Date.parse(session.session_expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        await setMeta(SNAPSHOT_KEY, {
          session: { ...session, csrf_token: "offline-session-no-csrf" },
          expiresAt,
        } satisfies OfflineSessionSnapshot);
      }
    } else {
      const snapshot = await getMeta<OfflineSessionSnapshot>(SNAPSHOT_KEY);
      await clearSessionSnapshot();
      if (snapshot?.session.user.role !== "field") return session;
      await clearDeviceSecret();
      return {
        ...session,
        stale_fields: [...new Set([...session.stale_fields, "field_device_repair_required"])],
      };
    }
    return session;
  } catch (error) {
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
        message: "The saved sign-in could not be verified. Reconnect and sign in again.",
        cause: parsed.success ? undefined : parsed.error,
      });
    }
    return {
      ...parsed.data,
      csrf_token: "offline-session-no-csrf",
      stale_fields: [...new Set([...parsed.data.stale_fields, "session.offline_snapshot"])],
    };
  }
}

export async function clearSessionSnapshot(): Promise<void> {
  await deleteMeta(SNAPSHOT_KEY);
}

export function isOfflineSession(session: AuthenticatedSession): boolean {
  return session.csrf_token === "offline-session-no-csrf";
}
