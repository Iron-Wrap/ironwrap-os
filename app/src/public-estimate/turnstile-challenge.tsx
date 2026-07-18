import { useEffect, useRef, useState } from "react";

type TurnstileWidgetId = string | number;

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "auto";
      size: "flexible";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => TurnstileWidgetId;
  remove?: (widgetId: TurnstileWidgetId) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScript) return turnstileScript;

  turnstileScript = new Promise<TurnstileApi>((resolve, reject) => {
    const selector = 'script[data-ironwrap-turnstile="true"]';
    const existing = document.querySelector<HTMLScriptElement>(selector);
    const script = existing ?? document.createElement("script");
    const settle = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not become available."));
    };
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile could not load.")), {
      once: true,
    });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.ironwrapTurnstile = "true";
      document.head.append(script);
    }
  }).catch((error) => {
    turnstileScript = undefined;
    throw error;
  });
  return turnstileScript;
}

type ChallengeState = "loading" | "ready" | "verified" | "failed";

export function TurnstileChallenge({
  siteKey,
  onTokenChange,
  onFailure,
}: {
  siteKey: string | null;
  onTokenChange: (token: string) => void;
  onFailure: (message?: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ChallengeState>("loading");

  useEffect(() => {
    if (!siteKey) {
      onTokenChange("");
      onFailure(undefined);
      return;
    }

    let cancelled = false;
    let widgetId: TurnstileWidgetId | undefined;
    onTokenChange("");
    onFailure(undefined);

    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        setState("ready");
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          callback: (token) => {
            if (cancelled) return;
            setState("verified");
            onTokenChange(token);
          },
          "error-callback": () => {
            if (cancelled) return;
            setState("failed");
            onTokenChange("");
            onFailure("The security check did not complete. Reload the page and try again.");
          },
          "expired-callback": () => {
            if (cancelled) return;
            setState("ready");
            onTokenChange("");
            onFailure("The security check expired. Please complete it again.");
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState("failed");
        onTokenChange("");
        onFailure("The security check could not load. Reload the page and try again.");
      });

    return () => {
      cancelled = true;
      if (widgetId !== undefined) window.turnstile?.remove?.(widgetId);
    };
  }, [siteKey, onFailure, onTokenChange]);

  if (!siteKey) return null;

  const label =
    state === "verified"
      ? "Security check complete."
      : state === "failed"
        ? "Security check unavailable."
        : state === "loading"
          ? "Preparing security check…"
          : "Complete the security check to continue.";

  return (
    <div className="space-y-2" aria-live="polite">
      <div ref={container} aria-label="Security check" />
      <p className="text-xs leading-5 text-muted">{label}</p>
    </div>
  );
}
