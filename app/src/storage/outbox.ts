import { getDatabase } from "./db";
import { notifyOutboxChanged } from "./outbox-store";
import { outboxActionKinds } from "./outbox-types";
import type {
  OutboxAction,
  OutboxActionKind,
  OutboxBlobRecord,
  OutboxConflict,
  OutboxErrorDetail,
  OutboxState,
  OutboxVerification,
  SaveOutboxActionInput,
} from "./outbox-types";

// The browser outbox is intentionally limited to field evidence and durable
// acknowledgement/stop intents. Lifecycle changes must use a fresh online read.
const fieldActionEndpoints: Record<OutboxActionKind, RegExp> = {
  field_checkin:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/check-ins|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/check-ins)$/,
  work_package_acknowledgement:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/work-package\/acknowledgements|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/work-package\/acknowledgements)$/,
  work_package_stop:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/work-package\/stop-work|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/work-package\/stop-work)$/,
};
const WORK_PACKAGE_ID_MAX_LENGTH = 140;
const STOP_WORK_REASON_MAX_LENGTH = 1_000;

const allowedTransitions: Record<OutboxState, readonly OutboxState[]> = {
  saved_locally: ["queued"],
  queued: ["uploading", "needs_attention"],
  uploading: ["queued", "verified", "needs_attention"],
  verified: [],
  needs_attention: ["queued"],
};

// This mirrors the server-side field-action lease. The client renews while a
// request is active; an expired/missing lease is a recovery heuristic, never
// proof that the server did not finish the idempotent device action.
export const OUTBOX_UPLOAD_LEASE_MS = 90_000;
export const OUTBOX_UPLOAD_HEARTBEAT_MS = 30_000;

export interface OutboxActionWithBlobs {
  action: OutboxAction;
  blobs: OutboxBlobRecord[];
}

export interface ClaimedOutboxAction extends OutboxAction {
  state: "uploading";
  uploadLeaseId: string;
  uploadLeaseExpiresAt: number;
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
    tenantId: input.tenantId.trim(),
    userId: input.userId.trim(),
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
    version: 2,
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
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  // Recovery or another tab may already be progressing the same durable action
  // between the local save and this caller's queue request. Do not regress that
  // work or turn a successful upload into a false local-save error.
  if (action.state === "queued" || action.state === "uploading" || action.state === "verified") {
    await transaction.done;
    return action;
  }
  assertTransition(action.state, "queued");
  const queued: OutboxAction = {
    ...action,
    state: "queued",
    attempts: 0,
    nextAttemptAt: now,
    uploadLeaseId: undefined,
    uploadLeaseExpiresAt: undefined,
    lastError: undefined,
    conflict: undefined,
    updatedAt: now,
  };
  await store.put(queued);
  await transaction.done;
  notifyOutboxChanged();
  return queued;
}

export async function retryOutboxAction(
  deviceActionId: string,
  now = Date.now(),
): Promise<OutboxAction> {
  const action = await getOutboxAction(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  if (!isOutboxActionSafeToRetry(action)) {
    throw new Error("This saved item needs office review and cannot be retried safely.");
  }
  return queueOutboxAction(deviceActionId, now);
}

/**
 * Returns only the saved actions belonging to this signed-in device user that
 * need a deliberate recovery decision. Newest items are shown first because
 * they are the ones a field user is most likely to have just captured.
 */
export async function getOutboxActionsNeedingAttention(principal: {
  tenantId: string;
  userId: string;
}): Promise<OutboxAction[]> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readonly");
  const actions = await transaction.store
    .index("by_principal_state")
    .getAll([principal.tenantId, principal.userId, "needs_attention"]);
  await transaction.done;
  return actions.sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
  );
}

/**
 * A preserved conflict or a non-transient server refusal must not be retried
 * blindly. This covers only transient HTTP states which may exist in an older
 * durable item after a client upgrade or manual recovery.
 */
export function isOutboxActionSafeToRetry(action: OutboxAction): boolean {
  const status = action.lastError?.status;
  return (
    action.state === "needs_attention" &&
    !action.conflict &&
    (status === 408 || status === 429 || (typeof status === "number" && status >= 500))
  );
}

export async function transitionOutboxAction(
  deviceActionId: string,
  nextState: OutboxState,
  now = Date.now(),
  patch: Partial<OutboxAction> = {},
  expectedUploadLeaseId?: string,
): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  if (
    expectedUploadLeaseId !== undefined &&
    (action.state !== "uploading" || action.uploadLeaseId !== expectedUploadLeaseId)
  ) {
    await transaction.done;
    return undefined;
  }
  assertTransition(action.state, nextState);
  const updated: OutboxAction = {
    ...action,
    ...patch,
    deviceActionId,
    state: nextState,
    ...(nextState === "uploading"
      ? {}
      : { uploadLeaseId: undefined, uploadLeaseExpiresAt: undefined }),
    updatedAt: now,
  };
  await store.put(updated);
  await transaction.done;
  notifyOutboxChanged();
  return updated;
}

export async function claimNextQueuedAction(
  principal: { tenantId: string; userId: string },
  now = Date.now(),
): Promise<ClaimedOutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const candidates = await store
    .index("by_principal_state")
    .getAll([principal.tenantId, principal.userId, "queued"]);
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
  const claimed: ClaimedOutboxAction = {
    ...candidate,
    state: "uploading",
    attempts: candidate.attempts + 1,
    uploadLeaseId: systemClock.randomId(),
    uploadLeaseExpiresAt: now + OUTBOX_UPLOAD_LEASE_MS,
    updatedAt: now,
  };
  await store.put(claimed);
  await transaction.done;
  notifyOutboxChanged();
  return claimed;
}

export async function renewOutboxUploadLease(
  deviceActionId: string,
  uploadLeaseId: string,
  now = Date.now(),
): Promise<boolean> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (action?.state !== "uploading" || action.uploadLeaseId !== uploadLeaseId) {
    await transaction.done;
    return false;
  }
  await store.put({
    ...action,
    uploadLeaseExpiresAt: now + OUTBOX_UPLOAD_LEASE_MS,
    updatedAt: now,
  });
  await transaction.done;
  notifyOutboxChanged();
  return true;
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
  expectedUploadLeaseId?: string,
): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readwrite");
  const actionStore = transaction.objectStore("outbox_actions");
  const action = await actionStore.get(deviceActionId);
  if (!action) throw new Error(`Outbox action ${deviceActionId} was not found.`);
  if (
    expectedUploadLeaseId !== undefined &&
    (action.state !== "uploading" || action.uploadLeaseId !== expectedUploadLeaseId)
  ) {
    await transaction.done;
    return undefined;
  }
  assertTransition(action.state, "verified");
  const updated: OutboxAction = {
    ...action,
    state: "verified",
    verification,
    uploadLeaseId: undefined,
    uploadLeaseExpiresAt: undefined,
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
  expectedUploadLeaseId?: string,
): Promise<OutboxAction | undefined> {
  return transitionOutboxAction(
    deviceActionId,
    "needs_attention",
    now,
    {
      lastError: detail.error,
      conflict: detail.conflict,
    },
    expectedUploadLeaseId,
  );
}

export async function requeueOutboxAction(
  deviceActionId: string,
  detail: { error: OutboxErrorDetail; nextAttemptAt: number },
  now = Date.now(),
  expectedUploadLeaseId?: string,
): Promise<OutboxAction | undefined> {
  return transitionOutboxAction(
    deviceActionId,
    "queued",
    now,
    {
      lastError: detail.error,
      nextAttemptAt: detail.nextAttemptAt,
    },
    expectedUploadLeaseId,
  );
}

export async function recoverResumableOutboxActions(
  principal: { tenantId: string; userId: string },
  now = Date.now(),
): Promise<number> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const savedLocally = await store
    .index("by_principal_state")
    .getAll([principal.tenantId, principal.userId, "saved_locally"]);
  const interruptedUploads = await store
    .index("by_principal_state")
    .getAll([principal.tenantId, principal.userId, "uploading"]);
  for (const action of savedLocally) {
    await store.put({
      ...action,
      state: "queued",
      nextAttemptAt: now,
      uploadLeaseId: undefined,
      uploadLeaseExpiresAt: undefined,
      updatedAt: now,
      lastError: {
        code: "queue_interrupted",
        message: "Local evidence was saved before queueing. It is queued safely for another try.",
        occurredAt: now,
      },
    });
  }
  const expiredUploads = interruptedUploads.filter((action) => !hasActiveUploadLease(action, now));
  for (const action of expiredUploads) {
    await store.put({
      ...action,
      state: "queued",
      nextAttemptAt: now,
      uploadLeaseId: undefined,
      uploadLeaseExpiresAt: undefined,
      updatedAt: now,
      lastError: {
        code: "upload_interrupted",
        message: "Upload was interrupted. It is queued safely for another try.",
        occurredAt: now,
      },
    });
  }
  await transaction.done;
  const recoveredCount = savedLocally.length + expiredUploads.length;
  if (recoveredCount > 0) notifyOutboxChanged();
  return recoveredCount;
}

function hasActiveUploadLease(action: OutboxAction, now: number): boolean {
  return (
    typeof action.uploadLeaseId === "string" &&
    action.uploadLeaseId.length > 0 &&
    typeof action.uploadLeaseExpiresAt === "number" &&
    action.uploadLeaseExpiresAt > now
  );
}

export function assertTransition(current: OutboxState, next: OutboxState): void {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid outbox transition: ${current} -> ${next}.`);
  }
}

function assertOutboxInput(input: SaveOutboxActionInput): void {
  if (!input.tenantId.trim() || input.tenantId.length > 64) {
    throw new Error("Outbox tenant identity is required.");
  }
  if (!input.userId.trim() || input.userId.length > 128) {
    throw new Error("Outbox user identity is required.");
  }
  if (!outboxActionKinds.includes(input.kind)) {
    throw new Error("This action cannot be queued for offline replay.");
  }
  if (
    !input.endpoint.startsWith("/api/v1/") ||
    input.endpoint.startsWith("//") ||
    input.endpoint.includes("\\")
  ) {
    throw new Error("Outbox endpoints must use a same-origin /api/v1/ path.");
  }
  if (!fieldActionEndpoints[input.kind].test(input.endpoint)) {
    throw new Error("This action cannot be queued for offline replay.");
  }
  if (input.method !== undefined && input.method !== "POST") {
    throw new Error("Offline field actions must use POST.");
  }
  if (input.kind !== "field_checkin" && (input.attachments?.length ?? 0) > 0) {
    throw new Error("Work Package actions cannot include attachments.");
  }
  if (input.kind === "work_package_acknowledgement") {
    assertWorkPackageAcknowledgementPayload(
      input.payload,
      input.endpoint.includes("/work-objects/"),
    );
  }
  if (input.kind === "work_package_stop") {
    assertWorkPackageStopPayload(input.payload, input.endpoint.includes("/work-objects/"));
  }
  for (const attachment of input.attachments ?? []) {
    if (!attachment.fileName.trim()) throw new Error("Every attachment needs a file name.");
  }
  assertNoSessionSecrets(input.payload);
}

function assertWorkPackageAcknowledgementPayload(payload: unknown, typedScope = false): void {
  const value = objectPayload(payload);
  const keys = Object.keys(value);
  const scopeKeys = [
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
  ];
  const allowedKeys = [
    "work_package_id",
    "work_package_version",
    "release_attempt_id",
    ...(typedScope ? scopeKeys : []),
  ];
  if (
    keys.length !== allowedKeys.length ||
    !("work_package_id" in value) ||
    !("work_package_version" in value) ||
    !("release_attempt_id" in value) ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    (typedScope && scopeKeys.some((key) => !(key in value)))
  ) {
    throw new Error("Work Package acknowledgement payload is invalid.");
  }
  assertBoundedText(value.work_package_id, "Work Package ID", WORK_PACKAGE_ID_MAX_LENGTH);
  assertPositiveInteger(value.work_package_version, "Work Package version");
  assertBoundedText(
    value.release_attempt_id,
    "Work Package release attempt",
    WORK_PACKAGE_ID_MAX_LENGTH,
  );
  if (typedScope) assertWorkObjectScopePayload(value);
}

function assertWorkPackageStopPayload(payload: unknown, typedScope = false): void {
  const value = objectPayload(payload);
  const keys = Object.keys(value);
  const scopeKeys = [
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
  ];
  const baseKeys = [
    "work_package_id",
    "blocker_reason",
    "work_package_version",
    "release_attempt_id",
  ];
  const allowedKeys = [...baseKeys, ...(typedScope ? scopeKeys : [])];
  if (
    (keys.length !== (typedScope ? 7 : 3) && keys.length !== (typedScope ? 8 : 4)) ||
    !("work_package_id" in value) ||
    !("blocker_reason" in value) ||
    !("work_package_version" in value) ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    (typedScope && scopeKeys.some((key) => !(key in value)))
  ) {
    throw new Error("Stop Work payload is invalid.");
  }
  assertBoundedText(value.work_package_id, "Work Package ID", WORK_PACKAGE_ID_MAX_LENGTH);
  assertBoundedText(value.blocker_reason, "Stop Work reason", STOP_WORK_REASON_MAX_LENGTH);
  assertPositiveInteger(value.work_package_version, "Work Package version");
  if ("release_attempt_id" in value)
    assertBoundedText(
      value.release_attempt_id,
      "Work Package release attempt",
      WORK_PACKAGE_ID_MAX_LENGTH,
    );
  if (typedScope) assertWorkObjectScopePayload(value);
}

function assertWorkObjectScopePayload(value: Record<string, unknown>): void {
  for (const [key, label] of [
    ["work_object_type", "Work object type"],
    ["work_object_id", "Work object ID"],
    ["physical_context_type", "Physical context type"],
    ["physical_context_id", "Physical context ID"],
  ] as const) {
    assertBoundedText(value[key], label, WORK_PACKAGE_ID_MAX_LENGTH);
  }
  if (value.work_object_type === "Roof Job") {
    throw new Error("Typed Work Package actions cannot use the Roof Job scope.");
  }
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("Work Package action payload is invalid.");
  }
  return payload as Record<string, unknown>;
}

function assertBoundedText(value: unknown, label: string, maximumLength: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new Error(`${label} is required.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${label} is required.`);
  }
}

function assertNoSessionSecrets(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSessionSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(csrf(_token)?|session(_token)?|access_token|refresh_token|authorization|cookie|device[_-]?(secret|proof))$/i.test(
        key,
      )
    ) {
      throw new Error(`Session secrets cannot be saved in the outbox (${path}.${key}).`);
    }
    assertNoSessionSecrets(child, `${path}.${key}`);
  }
}
