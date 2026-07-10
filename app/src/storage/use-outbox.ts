import { useEffect, useSyncExternalStore } from "react";

import { outboxStore } from "./outbox-store";
import { flushOutbox, initializeOutbox } from "./outbox-processor";
import type { OutboxSummary } from "./outbox-types";

export function useOutboxSummary(): OutboxSummary {
  return useSyncExternalStore(
    outboxStore.subscribe,
    outboxStore.getSnapshot,
    outboxStore.getServerSnapshot,
  );
}

export function useAppOpenOutboxSync(csrfToken?: string): void {
  useEffect(() => {
    const flush = () => {
      if (navigator.onLine && csrfToken) void flushOutbox({ csrfToken });
    };
    if (csrfToken) void initializeOutbox({ csrfToken });
    window.addEventListener("online", flush);
    const visibility = () => {
      if (document.visibilityState === "visible") flush();
    };
    document.addEventListener("visibilitychange", visibility);
    const interval = window.setInterval(flush, 30_000);
    return () => {
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(interval);
    };
  }, [csrfToken]);
}
