import { getDatabase } from "./db";
import type { OutboxSummary } from "./outbox-types";

const EMPTY_SUMMARY: OutboxSummary = {
  savedLocally: 0,
  queued: 0,
  uploading: 0,
  verified: 0,
  needsAttention: 0,
  pending: 0,
  total: 0,
};

let snapshot = EMPTY_SUMMARY;
let refreshPromise: Promise<void> | undefined;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

export const outboxStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    void refreshOutboxSummary();
    return () => listeners.delete(listener);
  },
  getSnapshot(): OutboxSummary {
    return snapshot;
  },
  getServerSnapshot(): OutboxSummary {
    return EMPTY_SUMMARY;
  },
};

export function notifyOutboxChanged(broadcast = true): void {
  void refreshOutboxSummary();
  if (broadcast && typeof BroadcastChannel !== "undefined") {
    channel ??= createChannel();
    channel.postMessage("changed");
  }
}

export function refreshOutboxSummary(): Promise<void> {
  refreshPromise ??= calculateSummary()
    .then((next) => {
      if (!summaryEqual(snapshot, next)) {
        snapshot = next;
        listeners.forEach((listener) => listener());
      }
    })
    .finally(() => {
      refreshPromise = undefined;
    });
  return refreshPromise;
}

async function calculateSummary(): Promise<OutboxSummary> {
  const database = await getDatabase();
  const [savedLocally, queued, uploading, verified, needsAttention] = await Promise.all([
    database.countFromIndex("outbox_actions", "by_state", "saved_locally"),
    database.countFromIndex("outbox_actions", "by_state", "queued"),
    database.countFromIndex("outbox_actions", "by_state", "uploading"),
    database.countFromIndex("outbox_actions", "by_state", "verified"),
    database.countFromIndex("outbox_actions", "by_state", "needs_attention"),
  ]);
  return {
    savedLocally,
    queued,
    uploading,
    verified,
    needsAttention,
    pending: savedLocally + queued + uploading,
    total: savedLocally + queued + uploading + verified + needsAttention,
  };
}

function createChannel(): BroadcastChannel {
  const next = new BroadcastChannel("ironwrap-outbox");
  next.addEventListener("message", () => notifyOutboxChanged(false));
  return next;
}

function summaryEqual(left: OutboxSummary, right: OutboxSummary): boolean {
  return (
    left.savedLocally === right.savedLocally &&
    left.queued === right.queued &&
    left.uploading === right.uploading &&
    left.verified === right.verified &&
    left.needsAttention === right.needsAttention &&
    left.pending === right.pending &&
    left.total === right.total
  );
}
