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

  if (sessionQuery.isPending) return <LoadingState label="Checking this device…" />;
  if (sessionQuery.isError) {
    const offline = sessionQuery.error instanceof ApiError && sessionQuery.error.status === 0;
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title={offline ? "This device is not ready offline" : "IronWrap OS is unavailable"}
          message={
            offline && sessionQuery.error instanceof ApiError
              ? sessionQuery.error.message
              : offline
                ? "Reconnect once so IronWrap OS can verify this device."
                : "This app is not available yet. Try again after it has been activated."
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
            title="This field device needs a new pairing"
            message="Its trusted device session is no longer active. Ask the office to issue a fresh QR code before using Field Companion again."
          />
        ) : fieldCompanionPath ? (
          <ErrorState
            title="Pair this Field Companion device"
            message="Field work opens only after the office issues a one-time QR code. Ask an owner or operations teammate to open Settings, then Crew devices, and scan a fresh code on this device."
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
          <CardDescription>
            Field Companion uses a supervised QR pairing instead of an email sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted">
            Ask an owner or operations teammate to open Settings, then Crew devices. Scan the
            one-time QR code on this phone; assigned work will open automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
