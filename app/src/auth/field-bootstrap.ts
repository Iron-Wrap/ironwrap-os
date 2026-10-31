import { z } from "zod";

import { getDeviceSecret } from "./device-credential";
import {
  principalReadStart,
  observePrincipalRead,
  getSessionReadObservation,
  type PrincipalReadObservation,
} from "./principal-context";
import {
  persistAuthenticatedSession,
  persistOrInvalidateSession,
  recoverOfflineSession,
  sessionResponseSchema,
  type SessionResponse,
} from "./session";
import { todayResponseSchema, type TodayResponse } from "../field/field-contracts";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";

export const fieldBootstrapResponseSchema = z
  .object({
    version: z.literal(1),
    session: sessionResponseSchema,
    today: todayResponseSchema.optional(),
  })
  .superRefine((payload, context) => {
    if (payload.session.authenticated && !payload.today) {
      context.addIssue({
        code: "custom",
        message: "Authenticated field bootstrap responses must include today's read model.",
        path: ["today"],
      });
    }
    if (!payload.session.authenticated && payload.today) {
      context.addIssue({
        code: "custom",
        message: "Unauthenticated field bootstrap responses must not include job data.",
        path: ["today"],
      });
    }
  });

export interface FieldBootstrap {
  session: SessionResponse;
  today?: TodayResponse;
  /** Client observation only; never a Worker signature or server grant. */
  field_read_observation?: PrincipalReadObservation;
}

export const FIELD_BOOTSTRAP_PRELOAD_TIMEOUT_MS = 2_000;
const FIELD_BOOTSTRAP_DEVICE_PROOF_TIMEOUT_MS = 1_000;

let primedFieldBootstrap: Promise<FieldBootstrap> | undefined;

type FieldBootstrapPreloadWindow = Window & {
  __ironwrapFieldBootstrapResponse?: Promise<Response>;
  __ironwrapFieldBootstrapPreloadConsumed?: boolean;
  __ironwrapFieldBootstrapReadGeneration?: string | null;
};

/**
 * Gets the session and initial Field Companion run sheet in one authenticated request.
 * The existing session snapshot policy remains the offline fallback; a bootstrap payload
 * is never treated as permission to use an unverified session or stale server job data.
 */
export async function fetchFieldBootstrap(fetcher: typeof fetch = fetch): Promise<FieldBootstrap> {
  try {
    const read = await loadVerifiedFieldBootstrap(fetcher);
    const payload = read.payload;
    if (!payload.session.authenticated)
      return { session: await persistOrInvalidateSession(payload.session) };
    const observation = await observePrincipalRead(
      payload.session,
      read.start,
      read.deviceProof,
    ).catch(() => undefined);
    void persistAuthenticatedSession(payload.session).catch((error: unknown) => {
      console.error("Could not persist the verified field session for offline use", error);
    });
    return {
      session: payload.session,
      today: payload.today!,
      ...(observation ? { field_read_observation: observation } : {}),
    };
  } catch (error) {
    const session = await recoverOfflineSession(error);
    return {
      session,
      ...(session.authenticated && getSessionReadObservation(session)
        ? { field_read_observation: getSessionReadObservation(session) }
        : {}),
    };
  }
}

async function loadVerifiedFieldBootstrap(fetcher: typeof fetch) {
  const preloaded = takeInitialFieldBootstrapPreload(fetcher);
  if (preloaded) {
    const start = { ...principalReadStart(), generation: preloaded.generation };
    const deviceProof = await valueBeforeDeadline(
      getDeviceSecret(),
      FIELD_BOOTSTRAP_DEVICE_PROOF_TIMEOUT_MS,
    );
    const response = await awaitFieldBootstrapPreload(preloaded.response);
    if (response) {
      const payload = await apiRequest({
        path: API_PATHS.fieldBootstrap,
        schema: fieldBootstrapResponseSchema,
        fetcher: async () => response,
      });
      return { payload, start, deviceProof };
    }
  }
  const start = principalReadStart();
  const deviceProof = await valueBeforeDeadline(
    getDeviceSecret(),
    FIELD_BOOTSTRAP_DEVICE_PROOF_TIMEOUT_MS,
  );
  const payload = await apiRequest({
    path: API_PATHS.fieldBootstrap,
    schema: fieldBootstrapResponseSchema,
    fetcher,
    deviceProof: deviceProof ? async () => deviceProof : undefined,
  });
  return { payload, start, deviceProof };
}

function takeInitialFieldBootstrapPreload(
  fetcher: typeof fetch,
): { response: Promise<Response>; generation: string | null } | undefined {
  if (fetcher !== fetch || typeof window === "undefined") return undefined;
  const preloadWindow = window as FieldBootstrapPreloadWindow;
  preloadWindow.__ironwrapFieldBootstrapPreloadConsumed = true;
  const response = preloadWindow.__ironwrapFieldBootstrapResponse;
  const generation = preloadWindow.__ironwrapFieldBootstrapReadGeneration ?? null;
  delete preloadWindow.__ironwrapFieldBootstrapResponse;
  delete preloadWindow.__ironwrapFieldBootstrapReadGeneration;
  return response ? { response, generation } : undefined;
}

/**
 * The static head preloader is an optimization only. If browser storage is blocked or
 * slow, give the ordinary bounded request path a chance rather than deadlocking boot.
 */
export async function awaitFieldBootstrapPreload(
  response: Promise<Response>,
  timeoutMs = FIELD_BOOTSTRAP_PRELOAD_TIMEOUT_MS,
): Promise<Response | undefined> {
  return await valueBeforeDeadline(response, timeoutMs);
}

function valueBeforeDeadline<T>(value: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    void value.then(
      (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(undefined);
      },
    );
  });
}

/**
 * Starts the authenticated field read as soon as the entry module is ready, while React
 * builds the router and app shell. It neither changes the device-proof requirement nor
 * caches a session beyond the first consumer.
 */
export function primeFieldBootstrap(
  loader: () => Promise<FieldBootstrap> = fetchFieldBootstrap,
): void {
  primedFieldBootstrap ??= loader();
}

/**
 * Waits for the entry-time read and claims it only when it succeeds, so the app can render the
 * screen the read decides instead of a checking state it would replace a moment later. A read
 * that fails stays primed for the session query, which owns the retry and error policy for it.
 */
export async function settlePrimedFieldBootstrap(): Promise<FieldBootstrap | undefined> {
  const bootstrap = primedFieldBootstrap;
  if (!bootstrap) return undefined;
  try {
    const result = await bootstrap;
    if (primedFieldBootstrap === bootstrap) primedFieldBootstrap = undefined;
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Gives the initial query the in-flight read, then clears it so ordinary React Query
 * retries and later refetches always make a fresh authenticated request.
 */
export function takePrimedFieldBootstrap(
  loader: () => Promise<FieldBootstrap> = fetchFieldBootstrap,
): Promise<FieldBootstrap> {
  const bootstrap = primedFieldBootstrap;
  primedFieldBootstrap = undefined;
  return bootstrap ?? loader();
}
