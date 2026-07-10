import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { apiCommand, ApiError } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { clearPendingMagicLinkToken } from "./magic-link-fragment";
import { sessionQueryKey } from "./session-query";

export function MagicLinkConsume({ token }: { token?: string }) {
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
    const consumption = apiCommand({ path: API_PATHS.magicLinkConsume, body: { token } });
    clearPendingMagicLinkToken();
    void consumption
      .then(async () => {
        setState("complete");
        await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
        await navigate({ to: "/today", replace: true });
      })
      .catch((caught: unknown) => {
        setError(caught);
        setState("error");
      });
  }, [navigate, queryClient, token]);

  if (!token) {
    return (
      <ErrorState
        title="This sign-in link is incomplete"
        message="Request a fresh link from the sign-in screen. No account changes were made."
      />
    );
  }
  if (state === "pending") return <LoadingState label="Verifying your sign-in link…" />;
  if (state === "error") {
    return (
      <ErrorState
        title="This sign-in link did not work"
        message={
          error instanceof ApiError
            ? error.message
            : "The link may be expired or already used. Request a fresh one."
        }
      />
    );
  }
  return <LoadingState label="Opening IronWrap OS…" />;
}
