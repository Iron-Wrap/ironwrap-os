import { useEffect, useState } from "react";

import { emptyOutboxSummary, getOutboxSummary, subscribeOutboxChanges } from "./outbox-store";
import { flushOutbox, initializeOutbox } from "./outbox-processor";
import type { OutboxSummary } from "./outbox-types";

export function useOutboxSummary(principal: { tenantId: string; userId: string }): OutboxSummary {
  const { tenantId, userId } = principal;
  const [summary, setSummary] = useState<OutboxSummary>(emptyOutboxSummary);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getOutboxSummary({ tenantId, userId }).then((next) => {
        if (active) setSummary(next);
      });
    };
    const unsubscribe = subscribeOutboxChanges(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [tenantId, userId]);
  return summary;
}

export function useAppOpenOutboxSync(
  principal: { tenantId: string; userId: string },
  csrfToken?: string,
): void {
  const { tenantId, userId } = principal;
  useEffect(() => {
    const flush = () => {
      if (navigator.onLine && csrfToken) void flushOutbox({ tenantId, userId, csrfToken });
    };
    if (csrfToken) void initializeOutbox({ tenantId, userId, csrfToken });
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
  }, [csrfToken, tenantId, userId]);
}
