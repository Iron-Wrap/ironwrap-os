import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useMemo } from "react";

import type { AuthenticatedSession } from "../../auth/session";
import { jobHistoryPath, jobHistoryResponseSchema } from "../../jobs/job-history-contracts";
import { ApiError, apiRequest } from "../../lib/api";
import { loadProductionRunway } from "../production-api";
import {
  jobGatesQueryKey,
  loadJobGates,
  loadSignedCopyQueue,
  signedCopyQueueQueryKey,
} from "./gate-api";

// This office caller still reads the legacy wire contract. Actual D5 integration must
// switch both its loader/parser and representation namespace together.
const representation = "office-gates-legacy-v1";

function useOfficeGateScope(session: AuthenticatedSession) {
  const authority = JSON.stringify([
    session.user.role,
    session.user.frappe_user_id,
    [...session.permissions].sort(),
    [...session.allowed_actions].sort(),
  ]);
  // There is no public session ID. Bind this mounted view to the actual current
  // session and grants, without putting a token or raw authority in cache keys.
  const scope = useMemo(
    () => ({
      tenantId: session.tenant.id,
      userId: session.user.id,
      csrfToken: session.csrf_token,
      expiresAt: session.session_expires_at,
      authority,
      cacheScope: crypto.randomUUID(),
    }),
    [session.tenant.id, session.user.id, session.csrf_token, session.session_expires_at, authority],
  );
  return scope.cacheScope;
}

export function useJobGateReads(session: AuthenticatedSession, jobId: string) {
  const queryClient = useQueryClient();
  const scope = useOfficeGateScope(session);
  const gatesKey = [
    ...jobGatesQueryKey(session.tenant.id, session.user.id, jobId),
    scope,
    representation,
  ] as const;
  const runwayKey = [
    "production-runway",
    session.tenant.id,
    session.user.id,
    scope,
    representation,
  ] as const;
  const historyKey = [
    "job-gates-identity",
    session.tenant.id,
    session.user.id,
    jobId,
    scope,
    representation,
  ] as const;
  const gates = useQuery(
    officeRead(queryClient, gatesKey, (signal) => loadJobGates(jobId, fetch, signal)),
  );
  const runway = useQuery(
    officeRead(queryClient, runwayKey, (signal) => loadProductionRunway(fetch, signal)),
  );
  const history = useQuery({
    ...officeRead(queryClient, historyKey, (signal) =>
      apiRequest({ path: jobHistoryPath(jobId), schema: jobHistoryResponseSchema, signal }),
    ),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return { gatesKey, gates, runway, history };
}

export function useSignedCopyQueueRead(session: AuthenticatedSession) {
  const queryClient = useQueryClient();
  const scope = useOfficeGateScope(session);
  const queryKey = [
    ...signedCopyQueueQueryKey(session.tenant.id, session.user.id),
    scope,
    representation,
  ] as const;
  return useQuery(
    officeRead(queryClient, queryKey, (signal) => loadSignedCopyQueue(fetch, signal)),
  );
}

function officeRead<T>(
  client: QueryClient,
  queryKey: QueryKey,
  load: (signal: AbortSignal) => Promise<T>,
) {
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T | null> => {
      try {
        return await load(signal);
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof ApiError &&
          ([401, 403].includes(error.status) ||
            (error.status >= 200 &&
              error.status < 300 &&
              ["invalid_response", "invalid_json"].includes(error.code)))
        ) {
          // A completed JSON/schema refusal retires only this exact accepted payload.
          // Null keeps failed retries empty; body loss/abort remain transport failures.
          // Initial failures retain undefined and initial-load copy.
          // A superseded request must never erase a newer same-key accepted result.
          client.setQueryData<T | null>(queryKey, (current) =>
            current === undefined ? undefined : null,
          );
        }
        throw error;
      }
    },
  };
}
