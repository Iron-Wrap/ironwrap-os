import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "../lib/api";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { MagicLinkForm } from "./magic-link-form";
import { fetchSession } from "./session";
import { SessionProvider } from "./session-context";
import { sessionQueryKey } from "./session-query";

export function AuthBoundary({ children }: { children: ReactNode }) {
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => fetchSession(),
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
  if (!sessionQuery.data.authenticated) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4 sm:p-8">
        <MagicLinkForm />
      </main>
    );
  }
  return <SessionProvider session={sessionQuery.data}>{children}</SessionProvider>;
}
