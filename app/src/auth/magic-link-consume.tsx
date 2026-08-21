import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { clearPendingMagicLinkToken } from "./magic-link-fragment";
import { fetchSession } from "./session";
import { sessionQueryKey } from "./session-query";

// Survives React StrictMode remount. A useRef resets when the tree remounts, which
// POSTs the one-time token twice and paints "already used" after a successful sign-in.
const startedTokens = new Set<string>();

export function MagicLinkConsume({ token }: { token?: string }) {
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
    const consumption = apiCommand({ path: API_PATHS.magicLinkConsume, body: { token } });
    clearPendingMagicLinkToken();
    void consumption.then(enter).catch(() => {
      void succeedIfAlreadyIn().catch(() => {
        setState("error");
      });
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
