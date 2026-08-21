import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
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

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    clearPendingPairingToken();
    void (async () => {
      await pairDevice(token);
      setState("complete");
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/today", replace: true });
    })().catch(() => {
      setState("error");
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
