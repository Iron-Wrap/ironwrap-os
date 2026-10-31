import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, type ReactNode } from "react";

import { ApiError, isRetryableApiError } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { clearDeviceSecret, getDeviceSecret } from "./device-credential";
import {
  fetchFieldBootstrap,
  takePrimedFieldBootstrap,
  type FieldBootstrap,
} from "./field-bootstrap";
import { MagicLinkForm } from "./magic-link-form";
import { fetchSession, isOfflineSession } from "./session";
import { SessionProvider } from "./session-context";
import { sessionQueryKey } from "./session-query";
import { getSessionReadObservation } from "./principal-context";

export function AuthBoundary({ children }: { children: ReactNode }) {
  const primaryFieldEntry = isPrimaryFieldEntry();
  const fieldCompanionPath = isFieldCompanionPath();
  const unifiedEntry = isUnifiedEntry();
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () =>
      primaryFieldEntry
        ? takePrimedFieldBootstrap()
        : unifiedEntry
          ? fetchUnifiedEntry()
          : fetchSessionOnly(),
    staleTime: 60_000,
    retry(failureCount, error) {
      return error instanceof ApiError && error.status === 0 && failureCount < 1;
    },
  });

  // The verified session mounts the whole shell and its first screen. Committing it at transition
  // priority lets React yield between components instead of holding a paired phone's main thread
  // for the entire mount; the checking state stays on screen until that render is ready.
  const verified = useDeferredValue(sessionQuery.data);

  // An offline reload signs in from the IndexedDB snapshot, which carries no CSRF token, so
  // nothing queued can upload. The moment the network returns, ask the server for the live
  // session again; a fresh token flows to every consumer of the shared session (the outbox
  // sync among them) without a manual reload. A failed re-check keeps the offline session and
  // touches nothing in the queue.
  const heldSession = sessionQuery.data?.session;
  const offlineSession = Boolean(heldSession?.authenticated && isOfflineSession(heldSession));
  const refetchSession = sessionQuery.refetch;
  useEffect(() => {
    if (!offlineSession) return;
    const restore = () => void refetchSession();
    window.addEventListener("online", restore);
    return () => window.removeEventListener("online", restore);
  }, [offlineSession, refetchSession]);

  if (sessionQuery.isPending) return <LoadingState label="Checking your sign-in…" />;
  // Held-session policy after a failed re-check. A transient failure (network, 5xx) while the
  // held sign-in is still within its own expiry keeps serving the held session, so a flaky
  // tower never throws a crew member out. Two cases close the authenticated content instead:
  // the held snapshot has passed `session_expires_at` (the server never renewed it, and
  // `recoverOfflineSession` has already dropped it), or the server answered with a definite
  // refusal (4xx). Queued work stays in the outbox in every case; only the UI closes.
  // Compared against the moment the re-check failed, which the query records; render stays pure.
  const heldExpired =
    heldSession?.authenticated === true &&
    Date.parse(heldSession.session_expires_at) <= sessionQuery.errorUpdatedAt;
  const definiteRefusal = sessionQuery.isError && !isRetryableApiError(sessionQuery.error);
  if (sessionQuery.isError && (!sessionQuery.data || heldExpired || definiteRefusal)) {
    const offline = sessionQuery.error instanceof ApiError && sessionQuery.error.status === 0;
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title={offline ? "This device needs the internet" : "IronWrap OS is not ready"}
          message={
            offline
              ? "Go online once so we can check this device."
              : "This app is not ready yet. Try again later."
          }
          onRetry={() => void sessionQuery.refetch()}
        />
      </div>
    );
  }
  if (!verified) return <LoadingState label="Checking your sign-in…" />;
  const { session, today } = verified;
  if (!session.authenticated) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-chrome p-4 sm:p-8">
        {session.stale_fields.includes("field_device_repair_required") ? (
          <ErrorState
            title="Pair this crew phone again"
            message="This phone is no longer paired. Ask the office for a new QR code."
          />
        ) : fieldCompanionPath ? (
          <ErrorState
            title="Pair this crew phone"
            message="Ask an owner or ops user to open Settings, then Crew phones. Scan the new QR code on this phone."
          />
        ) : unifiedEntry ? (
          <UnifiedEntryAuth />
        ) : (
          <MagicLinkForm />
        )}
      </main>
    );
  }
  return (
    <SessionProvider
      session={session}
      initialToday={today}
      readObservation={verified.field_read_observation}
    >
      {children}
    </SessionProvider>
  );
}

async function fetchSessionOnly(): Promise<FieldBootstrap> {
  const session = await fetchSession();
  return {
    session,
    ...(session.authenticated && getSessionReadObservation(session)
      ? { field_read_observation: getSessionReadObservation(session) }
      : {}),
  };
}

async function fetchUnifiedEntry(): Promise<FieldBootstrap> {
  if (!(await getDeviceSecret())) return fetchSessionOnly();
  try {
    return await fetchFieldBootstrap();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "today_read_required") throw error;
    await clearDeviceSecret();
    return await fetchSessionOnly();
  }
}

function isPrimaryFieldEntry(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/today";
}

function isFieldCompanionPath(): boolean {
  if (typeof window === "undefined") return false;
  const { pathname } = window.location;
  return (
    pathname === "/" ||
    pathname === "/today" ||
    pathname.startsWith("/jobs/") ||
    pathname.startsWith("/check-in")
  );
}

function isUnifiedEntry(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/now";
}

function UnifiedEntryAuth() {
  return (
    <div className="grid w-full max-w-4xl gap-4 md:grid-cols-2 md:items-start">
      <MagicLinkForm />
      <Card>
        <CardHeader>
          <CardTitle>Crew phone</CardTitle>
          <CardDescription>Crew phones use a QR code. You do not need email.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted">
            Ask an owner or ops user to open Settings, then Crew phones. Scan the QR code on this
            phone. Your work will open.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
