import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { pairDevice } from "./device-pairing";
import { clearPendingPairingToken } from "./pairing-fragment";
import { fetchSession, isOfflineSession } from "./session";
import { sessionQueryKey } from "./session-query";

// Survives React StrictMode remount. A useRef resets when the tree remounts, which
// consumes the one-time QR twice and paints "already used" after a successful pair.
const startedTokens = new Set<string>();
const pendingEntries = new Map<string, Promise<void>>();
type EntryFailure = "not_sent" | "unconfirmed";

class PairEntryFailure extends Error {
  constructor(
    readonly kind: EntryFailure,
    cause: unknown,
  ) {
    super("Pairing was not verified", { cause });
  }
}

async function verifyLivePair(): Promise<void> {
  try {
    const session = await fetchSession();
    if (!session.authenticated || session.user.role !== "field" || isOfflineSession(session))
      throw new Error("unconfirmed");
  } catch (error) {
    throw new PairEntryFailure("unconfirmed", error);
  }
}

function startEntry(token: string): Promise<void> {
  const pending = pendingEntries.get(token);
  if (pending) return pending;
  const repeated = startedTokens.has(token);
  startedTokens.add(token);
  const operation = repeated
    ? verifyLivePair()
    : pairDevice(token).catch((error: unknown) => {
        if (
          error instanceof ApiError &&
          error.code === "principal_prepare_failed" &&
          error.details.dispatched === false
        ) {
          startedTokens.delete(token);
          throw new PairEntryFailure("not_sent", error);
        }
        if (
          !(error instanceof ApiError) ||
          error.status < 400 ||
          error.status >= 500 ||
          error.status === 408 ||
          error.status === 429
        )
          throw new PairEntryFailure("unconfirmed", error);
        return verifyLivePair();
      });
  if (!repeated) clearPendingPairingToken();
  pendingEntries.set(token, operation);
  const settled = () => {
    if (pendingEntries.get(token) === operation) pendingEntries.delete(token);
  };
  void operation.then(settled, settled);
  return operation;
}

export function DevicePairingConsume({ token }: { token?: string }) {
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
        async () => {
          if (!active) return;
          setState("complete");
          await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
          if (active) await navigate({ to: "/today", replace: true });
        },
        (error: unknown) => {
          if (active) {
            setFailure(error instanceof PairEntryFailure ? error.kind : undefined);
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
        title="This QR code is not complete"
        message="Ask the office for a new code. We did not change this phone."
      />
    );
  }
  if (state === "pending") return <LoadingState label="Pairing this phone…" />;
  if (state === "error") {
    if (failure === "not_sent")
      return (
        <ErrorState
          title="Pairing was not sent"
          message="This device could not prepare pairing safely. Check device storage and ask the office for a new code."
        />
      );
    if (failure === "unconfirmed")
      return (
        <ErrorState
          title="Pairing needs checking"
          message="We could not verify this phone's pairing. Keep work stopped and ask the office for help."
        />
      );
    return (
      <ErrorState
        title="We could not pair this phone"
        message="The code may be old or already used. Ask the office for a new one."
      />
    );
  }
  return <LoadingState label="Opening Today…" />;
}
