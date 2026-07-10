import { getDatabase } from "./db";
import { notifyOutboxChanged } from "./outbox-store";
import type {
  OutboxAction,
  OutboxBlobRecord,
  OutboxConflict,
  OutboxErrorDetail,
  OutboxState,
  OutboxVerification,
  SaveOutboxActionInput,
} from "./outbox-types";

const allowedTransitions: Record<OutboxState, readonly OutboxState[]> = {
  saved_locally: ["queued"],
  queued: ["uploading", "needs_attention"],
  uploading: ["queued", "verified", "needs_attention"],
  verified: [],
  needs_attention: ["queued"],
};

export interface OutboxActionWithBlobs {
  action: OutboxAction;
  blobs: OutboxBlobRecord[];
}

export interface OutboxClock {
  now(): number;
  randomId(): string;
}

const systemClock: OutboxClock = {
  now: () => Date.now(),
  randomId: () => crypto.randomUUID(),
};

export async function saveOutboxAction(
  input: SaveOutboxActionInput,
  clock: OutboxClock = systemClock,
): Promise<OutboxAction> {
  assertOutboxInput(input);
  const database = await getDatabase();
  const now = clock.now();
  const deviceActionId = input.deviceActionId ?? clock.randomId();
  const attachments = (input.attachments ?? []).map((attachment) => {
    const attachmentId = attachment.attachmentId ?? clock.randomId();
    return {
      attachmentId,
      blobKey: `${deviceActionId}:${attachmentId}`,
      fileName: attachment.fileName,
      mimeType: attachment.blob.type || "application/octet-stream",
      size: attachment.blob.size,
      ...(attachment.lastModified === undefined ? {} : { lastModified: attachment.lastModified }),
    };
  });
  const action: OutboxAction = {
    deviceActionId,
    kind: input.kind,
    endpoint: input.endpoint,
    method: input.method ?? "POST",
    payload: structuredClone(input.payload),
    attachments,
    state: "saved_locally",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readwrite");
  await transaction.objectStore("outbox_actions").add(action);
  for (const [index, attachment] of (input.attachments ?? []).entries()) {
    const metadata = attachments[index];
    if (!metadata) throw new Error("Attachment metadata could not be created.");
    await transaction.objectStore("outbox_blobs").add({
      blobKey: metadata.blobKey,
      deviceActionId,
      attachmentId: metadata.attachmentId,
      blob: attachment.blob,
    });
  }
  await transaction.done;
  notifyOutboxChanged();
  return action;
}

export async function queueOutboxAction(
  deviceActionId: string,
  now = Date.now(),
): Promise<OutboxAction> {
  const action = await transitionOutboxAction(deviceActionId, "queued", now, {
    attempts: 0,
    nextAttemptAt: now,
    lastError: undefined,
    conflict: undefined,
  });
  return action;
}

export async function retryOutboxAction(
  deviceActionId: string,
  now = Date.now(),
): Promise<OutboxAction> {
  return queueOutboxAction(deviceActionId, now);
}

export async function transitionOutboxAction(
  deviceActionId: string,
  nextState: OutboxState,
  now = Date.now(),
  patch: Partial<OutboxAction> = {},
): Promise<OutboxAction> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  assertTransition(action.state, nextState);
  const updated = { ...action, ...patch, deviceActionId, state: nextState, updatedAt: now };
  await store.put(updated);
  await transaction.done;
  notifyOutboxChanged();
  return updated;
}

export async function claimNextQueuedAction(now = Date.now()): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const candidates = await store.index("by_state").getAll("queued");
  const candidate = candidates
    .filter((action) => action.nextAttemptAt <= now)
    .sort(
      (left, right) => left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt,
    )[0];
  if (!candidate) {
    await transaction.done;
    return undefined;
  }
  assertTransition(candidate.state, "uploading");
  const claimed: OutboxAction = {
    ...candidate,
    state: "uploading",
    attempts: candidate.attempts + 1,
    updatedAt: now,
  };
  await store.put(claimed);
  await transaction.done;
  notifyOutboxChanged();
  return claimed;
}

export async function getOutboxAction(deviceActionId: string): Promise<OutboxAction | undefined> {
  return (await getDatabase()).get("outbox_actions", deviceActionId);
}

export async function getOutboxActionWithBlobs(
  deviceActionId: string,
): Promise<OutboxActionWithBlobs | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readonly");
  const action = await transaction.objectStore("outbox_actions").get(deviceActionId);
  if (!action) return undefined;
  const blobs = await transaction
    .objectStore("outbox_blobs")
    .index("by_action")
    .getAll(deviceActionId);
  await transaction.done;
  return { action, blobs };
}

export async function markOutboxVerified(
  deviceActionId: string,
  verification: OutboxVerification,
  now = Date.now(),
): Promise<OutboxAction> {
  const database = await getDatabase();
  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readwrite");
  const actionStore = transaction.objectStore("outbox_actions");
  const action = await actionStore.get(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  assertTransition(action.state, "verified");
  const updated: OutboxAction = {
    ...action,
    state: "verified",
    verification,
    lastError: undefined,
    conflict: undefined,
    updatedAt: now,
  };
  await actionStore.put(updated);
  const blobStore = transaction.objectStore("outbox_blobs");
  for (const blob of await blobStore.index("by_action").getAll(deviceActionId)) {
    await blobStore.delete(blob.blobKey);
  }
  await transaction.done;
  notifyOutboxChanged();
  return updated;
}

export async function markOutboxNeedsAttention(
  deviceActionId: string,
  detail: { error: OutboxErrorDetail; conflict?: OutboxConflict },
  now = Date.now(),
): Promise<OutboxAction> {
  return transitionOutboxAction(deviceActionId, "needs_attention", now, {
    lastError: detail.error,
    conflict: detail.conflict,
  });
}

export async function requeueOutboxAction(
  deviceActionId: string,
  detail: { error: OutboxErrorDetail; nextAttemptAt: number },
  now = Date.now(),
): Promise<OutboxAction> {
  return transitionOutboxAction(deviceActionId, "queued", now, {
    lastError: detail.error,
    nextAttemptAt: detail.nextAttemptAt,
  });
}

export async function recoverInterruptedUploads(now = Date.now()): Promise<number> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const interrupted = await store.index("by_state").getAll("uploading");
  for (const action of interrupted) {
    await store.put({
      ...action,
      state: "queued",
      nextAttemptAt: now,
      updatedAt: now,
      lastError: {
        code: "upload_interrupted",
        message: "Upload was interrupted. It is queued safely for another try.",
        occurredAt: now,
      },
    });
  }
  await transaction.done;
  if (interrupted.length > 0) notifyOutboxChanged();
  return interrupted.length;
}

export function assertTransition(current: OutboxState, next: OutboxState): void {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid outbox transition: ${current} -> ${next}.`);
  }
}

function assertOutboxInput(input: SaveOutboxActionInput): void {
  if (!input.kind.trim()) throw new Error("Outbox action kind is required.");
  if (
    !input.endpoint.startsWith("/api/v1/") ||
    input.endpoint.startsWith("//") ||
    input.endpoint.includes("\\")
  ) {
    throw new Error("Outbox endpoints must use a same-origin /api/v1/ path.");
  }
  for (const attachment of input.attachments ?? []) {
    if (!attachment.fileName.trim()) throw new Error("Every attachment needs a file name.");
  }
  assertNoSessionSecrets(input.payload);
}

function assertNoSessionSecrets(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSessionSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(csrf(_token)?|session(_token)?|access_token|refresh_token|authorization|cookie)$/i.test(
        key,
      )
    ) {
      throw new Error(`Session secrets cannot be saved in the outbox (${path}.${key}).`);
    }
    assertNoSessionSecrets(child, `${path}.${key}`);
  }
}
