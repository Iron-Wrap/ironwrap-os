import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "../lib/api";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { takePrimedFieldBootstrap, type FieldBootstrap } from "./field-bootstrap";
import { MagicLinkForm } from "./magic-link-form";
import { fetchSession } from "./session";
import { SessionProvider } from "./session-context";
import { sessionQueryKey } from "./session-query";

export function AuthBoundary({ children }: { children: ReactNode }) {
  const fieldEntry = isPrimaryFieldEntry();
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => (fieldEntry ? takePrimedFieldBootstrap() : fetchSessionOnly()),
    staleTime: 60_000,
    retry(failureCount, error) {
      return error instanceof ApiError && error.status === 0 && failureCount < 1;
    },
  });

  if (sessionQuery.isPending) return <LoadingState label="Checking this device…" />;
  if (sessionQuery.isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title="This device is not ready offline"
          message={
            sessionQuery.error instanceof ApiError
              ? sessionQuery.error.message
              : "Reconnect once so IronWrap OS can verify this device."
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

function isPrimaryFieldEntry(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/today";
}
