import { getDatabase } from "./db";
import type { OutboxState, OutboxSummary } from "./outbox-types";

const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

export function emptyOutboxSummary(): OutboxSummary {
  return {
    savedLocally: 0,
    queued: 0,
    uploading: 0,
    verified: 0,
    needsAttention: 0,
    unclaimed: 0,
    pending: 0,
    total: 0,
  };
}

export function subscribeOutboxChanges(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof BroadcastChannel !== "undefined") channel ??= createChannel();
  return () => listeners.delete(listener);
}

export function notifyOutboxChanged(broadcast = true): void {
  listeners.forEach((listener) => listener());
  if (broadcast && typeof BroadcastChannel !== "undefined") {
    channel ??= createChannel();
    channel.postMessage("changed");
  }
}

export async function getOutboxSummary(principal: {
  tenantId: string;
  userId: string;
}): Promise<OutboxSummary> {
  const database = await getDatabase();
  const count = async (state: OutboxState) =>
    await database.countFromIndex("outbox_actions", "by_principal_state", [
      principal.tenantId,
      principal.userId,
      state,
    ]);
  const [savedLocally, queued, uploading, verified, needsAttention, actions] = await Promise.all([
    count("saved_locally"),
    count("queued"),
    count("uploading"),
    count("verified"),
    count("needs_attention"),
    database.getAll("outbox_actions"),
  ]);
  const unclaimed = actions.filter(
    (action) =>
      (!action.tenantId || !action.userId || action.version !== 2) && action.state !== "verified",
  ).length;
  return {
    savedLocally,
    queued,
    uploading,
    verified,
    needsAttention,
    unclaimed,
    pending: savedLocally + queued + uploading,
    total: savedLocally + queued + uploading + verified + needsAttention + unclaimed,
  };
}

function createChannel(): BroadcastChannel {
  const next = new BroadcastChannel("ironwrap-outbox");
  next.addEventListener("message", () => notifyOutboxChanged(false));
  return next;
}
