import { useEffect, useState } from "react";

import type { DeviceProofProvider } from "../auth/device-credential";
import { emptyOutboxSummary, getOutboxSummary, subscribeOutboxChanges } from "./outbox-store";
import { getOutboxActionsNeedingAttention, getOutboxActionsSettledByOffice } from "./outbox";
import { flushOutbox, initializeOutbox } from "./outbox-processor";
import type { OutboxAction, OutboxSummary } from "./outbox-types";

export type OutboxReadState = "checking" | "ready" | "error";

export function useOutboxSummary(principal: {
  tenantId: string;
  userId: string;
}): OutboxSummary & { readState: OutboxReadState } {
  const { tenantId, userId } = principal;
  const [snapshot, setSnapshot] = useState<{
    tenantId: string;
    userId: string;
    summary: OutboxSummary;
    readState: OutboxReadState;
  }>();
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const requestedRevision = ++revision;
      void getOutboxSummary({ tenantId, userId })
        .then((summary) => {
          if (active && requestedRevision === revision) {
            setSnapshot({ tenantId, userId, summary, readState: "ready" });
          }
        })
        .catch(() => {
          if (active && requestedRevision === revision) {
            setSnapshot((previous) => ({
              tenantId,
              userId,
              summary:
                previous?.tenantId === tenantId && previous.userId === userId
                  ? previous.summary
                  : emptyOutboxSummary(),
              readState: "error",
            }));
          }
        });
    };
    const unsubscribe = subscribeOutboxChanges(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [tenantId, userId]);
  if (snapshot?.tenantId !== tenantId || snapshot.userId !== userId) {
    return { ...emptyOutboxSummary(), readState: "checking" };
  }
  return { ...snapshot.summary, readState: snapshot.readState };
}

export function useOutboxActionsNeedingAttention(principal: {
  tenantId: string;
  userId: string;
}): OutboxAction[] {
  return useOutboxActions(principal, getOutboxActionsNeedingAttention, "need attention");
}

/** Items a person in the office settled that this person has not read yet. */
export function useOutboxActionsSettledByOffice(principal: {
  tenantId: string;
  userId: string;
}): OutboxAction[] {
  return useOutboxActions(principal, getOutboxActionsSettledByOffice, "the office settled");
}

function useOutboxActions(
  principal: { tenantId: string; userId: string },
  read: (principal: { tenantId: string; userId: string }) => Promise<OutboxAction[]>,
  what: string,
): OutboxAction[] {
  const { tenantId, userId } = principal;
  const [actions, setActions] = useState<OutboxAction[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void read({ tenantId, userId })
        .then((next) => {
          if (active) setActions(next);
        })
        .catch((error: unknown) => {
          console.error(`Could not read saved items that ${what}`, error);
          if (active) setActions([]);
        });
    };
    const unsubscribe = subscribeOutboxChanges(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [read, tenantId, userId, what]);
  return actions;
}

export function useAppOpenOutboxSync(
  principal: { tenantId: string; userId: string },
  csrfToken?: string,
  deviceProof?: DeviceProofProvider,
): void {
  const { tenantId, userId } = principal;
  useEffect(() => {
    const flush = () => {
      if (navigator.onLine && csrfToken)
        void flushOutbox({ tenantId, userId, csrfToken, deviceProof });
    };
    if (csrfToken) void initializeOutbox({ tenantId, userId, csrfToken, deviceProof });
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
  }, [csrfToken, deviceProof, tenantId, userId]);
}
