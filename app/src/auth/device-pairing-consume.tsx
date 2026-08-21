import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { pairDevice } from "./device-pairing";
import { clearPendingPairingToken } from "./pairing-fragment";
import { fetchSession } from "./session";
import { sessionQueryKey } from "./session-query";

// Survives React StrictMode remount. A useRef resets when the tree remounts, which
// consumes the one-time QR twice and paints "already used" after a successful pair.
const startedTokens = new Set<string>();

export function DevicePairingConsume({ token }: { token?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "pending" | "error" | "complete">(
    token ? "pending" : "idle",
  );

  useEffect(() => {
    if (!token) return;

    const enter = async () => {
      setState("complete");
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/today", replace: true });
    };

    const succeedIfAlreadyIn = async () => {
      const session = await fetchSession();
      if (!session.authenticated) throw new Error("unauthenticated");
      await enter();
    };

    if (startedTokens.has(token)) {
      void succeedIfAlreadyIn().catch(() => {
        setState("error");
      });
      return;
    }

    startedTokens.add(token);
    clearPendingPairingToken();
    void (async () => {
      await pairDevice(token);
      await enter();
    })().catch(() => {
      void succeedIfAlreadyIn().catch(() => {
        setState("error");
      });
    });
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
    return (
      <ErrorState
        title="We could not pair this phone"
        message="The code may be old or already used. Ask the office for a new one."
      />
    );
  }
  return <LoadingState label="Opening Today…" />;
}
