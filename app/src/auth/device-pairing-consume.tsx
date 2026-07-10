import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { pairDevice } from "./device-pairing";
import { clearPendingPairingToken } from "./pairing-fragment";
import { sessionQueryKey } from "./session-query";

export function DevicePairingConsume({ token }: { token?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<"idle" | "pending" | "error" | "complete">(
    token ? "pending" : "idle",
  );
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    clearPendingPairingToken();
    void (async () => {
      await pairDevice(token);
      setState("complete");
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/today", replace: true });
    })().catch((caught: unknown) => {
      setError(caught);
      setState("error");
    });
  }, [navigate, queryClient, token]);

  if (!token) {
    return (
      <ErrorState
        title="This device pairing link is incomplete"
        message="Ask the office to issue a fresh pairing code. No account changes were made."
      />
    );
  }
  if (state === "pending") return <LoadingState label="Pairing this device securely…" />;
  if (state === "error") {
    return (
      <ErrorState
        title="This device could not be paired"
        message={
          error instanceof ApiError
            ? error.message
            : "The code may be expired or already used. Ask the office to issue a new one."
        }
      />
    );
  }
  return <LoadingState label="Opening Today…" />;
}
