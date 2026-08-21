import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { apiCommand } from "../lib/api";
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
      .catch(() => {
        setState("error");
      });
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
    return (
      <ErrorState
        title="This sign-in link did not work"
        message="The link may be old or already used. Ask for a new one."
      />
    );
  }
  return <LoadingState label="Opening IronWrap OS…" />;
}
