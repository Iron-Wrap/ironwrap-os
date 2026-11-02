import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError, apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { landingPathFor } from "./landing-path";
import { clearPendingMagicLinkToken } from "./magic-link-fragment";
import { fetchSession, isOfflineSession, type AuthenticatedSession } from "./session";
import { sessionQueryKey } from "./session-query";

// Survives React StrictMode remount. A useRef resets when the tree remounts, which
// POSTs the one-time token twice and paints "already used" after a successful sign-in.
const startedTokens = new Set<string>();
const pendingEntries = new Map<string, Promise<AuthenticatedSession>>();
type EntryFailure = "not_sent" | "unconfirmed";

class MagicEntryFailure extends Error {
  constructor(
    readonly kind: EntryFailure,
    cause: unknown,
  ) {
    super("Sign-in was not verified", { cause });
  }
}

async function readLiveSession(): Promise<AuthenticatedSession> {
  try {
    const session = await fetchSession();
    if (!session.authenticated || isOfflineSession(session)) throw new Error("unconfirmed");
    return session;
  } catch (error) {
    throw new MagicEntryFailure("unconfirmed", error);
  }
}

function startEntry(token: string): Promise<AuthenticatedSession> {
  const pending = pendingEntries.get(token);
  if (pending) return pending;
  const repeated = startedTokens.has(token);
  startedTokens.add(token);
  const consumption = repeated
    ? Promise.resolve()
    : apiCommand({ path: API_PATHS.magicLinkConsume, body: { token } });
  if (!repeated) clearPendingMagicLinkToken();
  const operation = consumption.then(readLiveSession, (error: unknown) => {
    if (
      error instanceof ApiError &&
      error.code === "principal_prepare_failed" &&
      error.details.dispatched === false
    ) {
      startedTokens.delete(token);
      throw new MagicEntryFailure("not_sent", error);
    }
    if (
      !(error instanceof ApiError) ||
      error.status < 400 ||
      error.status >= 500 ||
      error.status === 408 ||
      error.status === 429
    )
      throw new MagicEntryFailure("unconfirmed", error);
    // Preserve already-used-link recovery only through a genuinely live sign-in read.
    return readLiveSession();
  });
  pendingEntries.set(token, operation);
  const settled = () => {
    if (pendingEntries.get(token) === operation) pendingEntries.delete(token);
  };
  void operation.then(settled, settled);
  return operation;
}

export function MagicLinkConsume({ token }: { token?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "pending" | "error" | "complete">(
    token ? "pending" : "idle",
  );
  const [failure, setFailure] = useState<EntryFailure | undefined>();

  useEffect(() => {
    if (!token) return;

    let active = true;
    void startEntry(token)
      .then(
        async (session) => {
          if (!active) return;
          setState("complete");
          await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
          if (active) await navigate({ to: landingPathFor(session), replace: true });
        },
        (error: unknown) => {
          if (active) {
            setFailure(error instanceof MagicEntryFailure ? error.kind : undefined);
            setState("error");
          }
        },
      )
      .catch(() => {
        if (active) {
          setFailure("unconfirmed");
          setState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [navigate, queryClient, token]);

  if (!token) {
    return (
      <ErrorState
        title="This sign-in link is not complete"
        message="Ask for a new link. We did not change your account."
      />
    );
  }
  if (state === "pending") return <LoadingState label="Checking your sign-in link…" />;
  if (state === "error") {
    if (failure === "not_sent")
      return (
        <ErrorState
          title="Sign-in was not sent"
          message="This device could not prepare sign-in safely. Check device storage and ask for a new sign-in link."
        />
      );
    if (failure === "unconfirmed")
      return (
        <ErrorState
          title="Sign-in needs checking"
          message="We could not verify this sign-in. Keep work stopped. Go online to check again, or ask the office for help."
        />
      );
    return (
      <ErrorState
        title="This sign-in link did not work"
        message="The link may be old or already used. Ask for a new one."
      />
    );
  }
  return <LoadingState label="Opening IronWrap OS…" />;
}
