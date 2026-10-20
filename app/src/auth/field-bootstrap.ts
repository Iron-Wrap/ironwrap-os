import { z } from "zod";

import { getDeviceSecret } from "./device-credential";
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
}

export const FIELD_BOOTSTRAP_PRELOAD_TIMEOUT_MS = 2_000;
const FIELD_BOOTSTRAP_DEVICE_PROOF_TIMEOUT_MS = 1_000;

let primedFieldBootstrap: Promise<FieldBootstrap> | undefined;

type FieldBootstrapPreloadWindow = Window & {
  __ironwrapFieldBootstrapResponse?: Promise<Response>;
  __ironwrapFieldBootstrapPreloadConsumed?: boolean;
};

/**
 * Gets the session and initial Field Companion run sheet in one authenticated request.
 * The existing session snapshot policy remains the offline fallback; a bootstrap payload
 * is never treated as permission to use an unverified session or stale server job data.
 */
export async function fetchFieldBootstrap(fetcher: typeof fetch = fetch): Promise<FieldBootstrap> {
  try {
    const payload = await loadVerifiedFieldBootstrap(fetcher);
    if (!payload.session.authenticated) {
      return { session: await persistOrInvalidateSession(payload.session) };
    }
    // An already-validated run sheet should paint before the IndexedDB snapshot write. The
    // write stays best-effort and uses the same redacted-CSRF offline-session contract.
    void persistAuthenticatedSession(payload.session).catch((error: unknown) => {
      console.error("Could not persist the verified field session for offline use", error);
    });
    return { session: payload.session, today: payload.today! };
  } catch (error) {
    return { session: await recoverOfflineSession(error) };
  }
}

async function loadVerifiedFieldBootstrap(fetcher: typeof fetch) {
  const preloadedResponse = takeInitialFieldBootstrapPreload(fetcher);
  if (preloadedResponse) {
    const response = await awaitFieldBootstrapPreload(preloadedResponse);
    if (response) {
      return await apiRequest({
        path: API_PATHS.fieldBootstrap,
        schema: fieldBootstrapResponseSchema,
        fetcher: async () => response,
      });
    }
  }

  // A stalled IndexedDB operation must not leave a field device on the checking screen.
  // Without a readable proof, the Worker returns its safe unauthenticated bootstrap payload;
  // it never returns the run sheet just because the browser had a local storage problem.
  const deviceProof = await valueBeforeDeadline(
    getDeviceSecret(),
    FIELD_BOOTSTRAP_DEVICE_PROOF_TIMEOUT_MS,
  );
  return await apiRequest({
    path: API_PATHS.fieldBootstrap,
    schema: fieldBootstrapResponseSchema,
    fetcher,
    deviceProof: deviceProof ? async () => deviceProof : undefined,
  });
}

function takeInitialFieldBootstrapPreload(fetcher: typeof fetch): Promise<Response> | undefined {
  if (fetcher !== fetch || typeof window === "undefined") return undefined;
  const preloadWindow = window as FieldBootstrapPreloadWindow;
  // Claim the initial read even when the async head script has not arrived yet.
  preloadWindow.__ironwrapFieldBootstrapPreloadConsumed = true;
  const response = preloadWindow.__ironwrapFieldBootstrapResponse;
  delete preloadWindow.__ironwrapFieldBootstrapResponse;
  return response;
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
