import { z } from "zod";

import { deleteMeta, getDatabase, getMeta, setMeta } from "../storage/db";
import { PRINCIPAL_EPOCH_KEY, principalEpochRecordRefersTo } from "./principal-epoch";
import { ApiError, apiRequest, isRetryableApiError } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { appRoles } from "../lib/roles";
import { clearDeviceSecret, getDeviceSecret } from "./device-credential";
import {
  capturePrincipalReadStart,
  observePrincipalRead,
  getSessionReadObservation,
  restorePrincipalObservation,
  type PrincipalReadObservation,
  sessionReadContextIsCurrent,
  principalObservationCanPersist,
} from "./principal-context";

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
    .nullish()
    // A malformed value reads as none rather than failing sign-in.
    .catch(null),
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
  field_read_observation?: PrincipalReadObservation;
}

let savedFieldEntryTaken = false;

/** Only the first real field entry may choose cached-only admission before any HTTP effect. */
export async function takeVerifiedSavedFieldEntry(): Promise<AuthenticatedSession | undefined> {
  if (savedFieldEntryTaken) return undefined;
  savedFieldEntryTaken = true;
  return readVerifiedSavedFieldSession();
}

/** No request, retryability test or online hint participates in this local-only decision. */
export async function readVerifiedSavedFieldSession(): Promise<AuthenticatedSession | undefined> {
  try {
    const snapshot = await getMeta<OfflineSessionSnapshot>(SNAPSHOT_KEY);
    if (!snapshot || snapshot.expiresAt <= Date.now()) return undefined;
    const parsed = sessionResponseSchema.safeParse(snapshot.session);
    if (!parsed.success || !parsed.data.authenticated || parsed.data.user.role !== "field")
      return undefined;
    const session: AuthenticatedSession = {
      ...parsed.data,
      csrf_token: "offline-session-no-csrf",
      stale_fields: [...new Set([...parsed.data.stale_fields, "session.offline_snapshot"])],
    };
    const observation = await restorePrincipalObservation(
      session,
      snapshot.field_read_observation,
      await getDeviceSecret(),
    );
    return observation && sessionReadContextIsCurrent(session, observation) ? session : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchSession(fetcher: typeof fetch = fetch): Promise<SessionResponse> {
  const start = await capturePrincipalReadStart();
  let pairedProof: string | undefined;
  try {
    const session = await apiRequest({
      path: API_PATHS.session,
      schema: sessionResponseSchema,
      fetcher,
      onPrincipalPreparation: (prepared) => {
        start.epoch = prepared.epoch;
      },
      deviceProof: async () => {
        pairedProof = await getDeviceSecret();
        return pairedProof;
      },
    });
    if (session.authenticated)
      await observePrincipalRead(session, start, pairedProof).catch(() => undefined);
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
  const observation = getSessionReadObservation(session);
  const keepObservation =
    observation && (await principalObservationCanPersist(session, observation));
  const snapshot: OfflineSessionSnapshot = {
    session: { ...session, csrf_token: "offline-session-no-csrf" },
    expiresAt,
    ...(keepObservation ? { field_read_observation: observation } : {}),
  };
  if (session.user.role === "field" && observation) {
    const tx = (await getDatabase()).transaction("meta", "readwrite", { durability: "strict" });
    const [epoch, previous] = await Promise.all([
      tx.store.get(PRINCIPAL_EPOCH_KEY),
      tx.store.get(SNAPSHOT_KEY),
    ]);
    const held = previous?.value as OfflineSessionSnapshot | undefined;
    if (
      principalEpochRecordRefersTo(epoch?.value, held?.field_read_observation?.epoch) &&
      !principalEpochRecordRefersTo(epoch?.value, observation.epoch)
    ) {
      await tx.done;
      return; // An older field DTO may return, but cannot overwrite the newer bound snapshot.
    }
    await tx.store.put({ key: SNAPSHOT_KEY, value: snapshot, updatedAt: Date.now() });
    await tx.done;
    writeOfficeSessionMarker(expiresAt);
  } else {
    // Ordinary office snapshot/marker behavior remains unchanged.
    writeOfficeSessionMarker(expiresAt);
    await setMeta(SNAPSHOT_KEY, snapshot);
  }
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
  const recovered: AuthenticatedSession = {
    ...parsed.data,
    csrf_token: "offline-session-no-csrf",
    stale_fields: [...new Set([...parsed.data.stale_fields, "session.offline_snapshot"])],
  };
  try {
    await restorePrincipalObservation(
      recovered,
      snapshot.field_read_observation,
      await getDeviceSecret(),
    );
  } catch {
    /* ordinary offline session policy is unchanged; field observation stays unverified */
  }
  return recovered;
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
