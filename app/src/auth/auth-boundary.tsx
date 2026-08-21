import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { clearDeviceSecret, getDeviceSecret } from "./device-credential";
import {
  fetchFieldBootstrap,
  takePrimedFieldBootstrap,
  type FieldBootstrap,
} from "./field-bootstrap";
import { MagicLinkForm } from "./magic-link-form";
import { fetchSession } from "./session";
import { SessionProvider } from "./session-context";
import { sessionQueryKey } from "./session-query";

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

  if (sessionQuery.isPending) return <LoadingState label="Checking your sign-in…" />;
  if (sessionQuery.isError) {
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
  const { session, today } = sessionQuery.data;
  if (!session.authenticated) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4 sm:p-8">
        {session.stale_fields.includes("field_device_repair_required") ? (
          <ErrorState
            title="Pair this crew phone again"
            message="This phone is no longer paired. Ask the office for a new QR code."
          />
        ) : fieldCompanionPath ? (
          <ErrorState
            title="Pair this crew phone"
            message="Ask an owner or ops user to open Settings, then Crew devices. Scan the new QR code on this phone."
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
    <SessionProvider session={session} initialToday={today}>
      {children}
    </SessionProvider>
  );
}

async function fetchSessionOnly(): Promise<FieldBootstrap> {
  return { session: await fetchSession() };
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
            Ask an owner or ops user to open Settings, then Crew devices. Scan the QR code on this
            phone. Your work will open.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
