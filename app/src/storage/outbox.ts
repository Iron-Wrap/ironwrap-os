import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  evidenceMimeTypes,
  evidenceReceiptIdSchema,
  isUploadKey,
} from "../evidence/evidence-types";
import { correctiveEvidenceSchema } from "../field/safety-contracts";
import { PlainError } from "../lib/plain-error";
import { getDatabase } from "./db";
import { classifyOutboxFailure } from "./outbox-failure";
import { notifyOutboxChanged } from "./outbox-store";
import { outboxActionKinds } from "./outbox-types";
import type {
  OutboxAction,
  OutboxActionKind,
  OutboxBlobRecord,
  OutboxConflict,
  OutboxErrorDetail,
  OutboxEvidenceFile,
  OutboxEvidenceInput,
  OutboxOfficeResolution,
  OutboxState,
  OutboxVerification,
  SaveOutboxActionInput,
} from "./outbox-types";

// The browser outbox carries field evidence, durable acknowledgement/stop
// intents, duplicate-safe inventory intents/scans, and physical fleet
// observations. Inventory payloads stay business intents; the Worker derives
// ledger movements on replay. Lifecycle changes must use a fresh online read.
const fieldActionEndpoints: Record<OutboxActionKind, RegExp> = {
  field_checkin:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/check-ins|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/check-ins)$/,
  work_package_acknowledgement:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/work-package\/acknowledgements|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/work-package\/acknowledgements)$/,
  work_package_stop:
    /^\/api\/v1\/(?:jobs\/[^/?#]+\/work-package\/stop-work|work-objects\/[^/?#]+\/[^/?#]+\/physical-contexts\/[^/?#]+\/[^/?#]+\/work-package\/stop-work)$/,
  inventory_command: /^\/api\/v1\/inventory\/commands$/,
  inventory_scan: /^\/api\/v1\/inventory\/scans$/,
  // One global endpoint on purpose: the safety rail must not require a job, an
  // assignment, or a current work package.
  safety_action: /^\/api\/v1\/safety\/actions$/,
  safety_corrective_evidence: /^\/api\/v1\/safety\/corrective-actions\/[^/?#]+\/evidence$/,
  fleet_pre_trip_inspection: /^\/api\/v1\/fleet\/assets\/[^/?#]+\/pre-trip-inspections$/,
  fleet_post_trip_inspection: /^\/api\/v1\/fleet\/assets\/[^/?#]+\/post-trip-inspections$/,
  fleet_defect_report: /^\/api\/v1\/fleet\/assets\/[^/?#]+\/defects$/,
  fleet_collision_report: /^\/api\/v1\/fleet\/assets\/[^/?#]+\/collisions$/,
  // /api/v1/schema-fields/{entityType}/{entityId}/{fieldId}/values — the governed record-value
  // write route (`workers-bus/src/schema-forms-api.ts:65`). The field id is the third segment.
  schema_field_value: /^\/api\/v1\/schema-fields\/[^/?#]+\/[^/?#]+\/[^/?#]+\/values$/,
};
const WORK_PACKAGE_ID_MAX_LENGTH = 140;
const STOP_WORK_REASON_MAX_LENGTH = 4_000;
const FLEET_ASSET_ID_MAX_LENGTH = 140;
const FLEET_TEXT_MAX_LENGTH = 1_200;
const FLEET_INSPECTION_ITEM_LIMIT = 60;
const SCHEMA_REVISION_REF_MAX_LENGTH = 220;
const SCHEMA_CORRECTION_REASON_MAX_LENGTH = 1_000;
const schemaFieldValueKeys = [
  "field_definition_revision_id",
  "expected_version",
  "value",
  "based_on_value_revision_id",
  "correction_reason",
] as const;
const fleetInspectionKinds = new Set<OutboxActionKind>([
  "fleet_pre_trip_inspection",
  "fleet_post_trip_inspection",
]);
const fleetItemResults = new Set(["Pass", "Fail", "Not Applicable"]);
const fleetDefectSeverities = new Set(["Minor", "Major", "Out of Service"]);

const allowedTransitions: Record<OutboxState, readonly OutboxState[]> = {
  saved_locally: ["queued"],
  queued: ["uploading", "needs_attention"],
  uploading: ["queued", "verified", "needs_attention"],
  verified: [],
  // `verified` from here only when a person in the office confirmed the office holds the item.
  needs_attention: ["queued", "verified"],
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
  // Evidence bytes ride in the same blob store, one record per file, until the action is confirmed.
  const evidenceFiles: OutboxEvidenceFile[] = (input.evidence?.files ?? []).map((file) => ({
    uploadKey: file.uploadKey,
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.size,
    attachmentId: clock.randomId(),
    ...(file.receiptId ? { receiptId: file.receiptId } : {}),
  }));
  const action: OutboxAction = {
    deviceActionId,
    tenantId: input.tenantId.trim(),
    userId: input.userId.trim(),
    kind: input.kind,
    endpoint: input.endpoint,
    method: input.method ?? "POST",
    payload: structuredClone(input.payload),
    attachments,
    ...(input.evidence
      ? { evidence: { scope: { ...input.evidence.scope }, files: evidenceFiles } }
      : {}),
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
  for (const [index, file] of (input.evidence?.files ?? []).entries()) {
    const attachmentId = evidenceFiles[index]?.attachmentId;
    if (!attachmentId) throw new Error("Evidence file metadata could not be created.");
    await transaction.objectStore("outbox_blobs").add({
      blobKey: `${deviceActionId}:${attachmentId}`,
      deviceActionId,
      attachmentId,
      blob: file.blob,
    });
  }
  await transaction.done;
  notifyOutboxChanged();
  return action;
}

/**
 * Queues one saved action only while it is still the action the caller expects and still only
 * saved here, checked and changed in one transaction so no other tab can move it in between. An
 * action already further along, or stopped, comes back as it stands and is never moved: a stopped
 * action returns to the queue only through `retryOutboxAction`. `none`: nothing is saved under this
 * id; `other`: what is saved there is not the expected action, and it is left alone.
 */
export async function queueSavedOutboxActionIf(
  deviceActionId: string,
  isExpected: (action: OutboxAction) => boolean,
  now = Date.now(),
): Promise<{ found: "none" } | { found: "other" } | { found: "expected"; action: OutboxAction }> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (!action || !isExpected(action)) {
    await transaction.done;
    return action ? { found: "other" } : { found: "none" };
  }
  if (action.state !== "saved_locally") {
    await transaction.done;
    return { found: "expected", action };
  }
  const queued: OutboxAction = { ...action, state: "queued", nextAttemptAt: now, updatedAt: now };
  await store.put(queued);
  await transaction.done;
  notifyOutboxChanged();
  return { found: "expected", action: queued };
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
    throw new PlainError("This saved item needs office review and cannot be retried safely.");
  }
  return queueOutboxAction(deviceActionId, now);
}

/**
 * Every saved action of one kind for this device user that has not been verified yet.
 *
 * A surface that queued its own work needs to show what it is still holding. The verified ones are
 * deliberately excluded: they are already facts on the server, and the next read of that record
 * carries them, so repeating them from the queue would show the same value twice.
 */
export async function listOutboxActionsByKind(
  principal: { tenantId: string; userId: string },
  kind: OutboxActionKind,
): Promise<OutboxAction[]> {
  const database = await getDatabase();
  const actions = await database.getAll("outbox_actions");
  return actions
    .filter(
      (action) =>
        action.kind === kind &&
        action.state !== "verified" &&
        action.tenantId === principal.tenantId &&
        action.userId === principal.userId,
    )
    .sort((left, right) => left.createdAt - right.createdAt);
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
 * Items a person in the office settled that this person has not read yet. Once an item leaves the
 * needs-attention list, this is where the crew learns why, instead of it vanishing.
 */
export async function getOutboxActionsSettledByOffice(principal: {
  tenantId: string;
  userId: string;
}): Promise<OutboxAction[]> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readonly");
  const actions = await transaction.store
    .index("by_principal_state")
    .getAll([principal.tenantId, principal.userId, "verified"]);
  await transaction.done;
  return actions
    .filter(
      (action) =>
        action.verification?.officeResolution && !action.verification.officeResolution.seenAt,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

/** The person read the office's answer about this item. */
export async function markOfficeSettlementSeen(
  deviceActionId: string,
  now = Date.now(),
): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const action = await transaction.store.get(deviceActionId);
  const officeResolution = action?.verification?.officeResolution;
  if (action?.verification && officeResolution && !officeResolution.seenAt) {
    await transaction.store.put({
      ...action,
      verification: {
        ...action.verification,
        officeResolution: { ...officeResolution, seenAt: now },
      },
    });
  }
  await transaction.done;
  notifyOutboxChanged();
}

/**
 * A preserved conflict or a non-transient server refusal must not be retried
 * blindly. Only a transient answer is safe to send again, and a code the Worker
 * marks terminal stays terminal whatever status carried it (`outbox-failure.ts`).
 */
export function isOutboxActionSafeToRetry(action: OutboxAction): boolean {
  const error = action.lastError;
  if (action.state !== "needs_attention" || action.conflict || error?.status === undefined) {
    return false;
  }
  return classifyOutboxFailure({ status: error.status, code: error.code }) === "retryable";
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

/**
 * Remembers that one evidence file is confirmed, so a stop halfway through never uploads it again.
 * Its bytes stay until the action itself is confirmed: if the Worker then refuses the action, the
 * files are still on the phone.
 */
export async function recordOutboxEvidenceReceipt(
  deviceActionId: string,
  uploadKey: string,
  receiptId: string,
  now = Date.now(),
  expectedUploadLeaseId?: string,
): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readwrite");
  const actions = transaction.objectStore("outbox_actions");
  const action = await actions.get(deviceActionId);
  const file = action?.evidence?.files.find((candidate) => candidate.uploadKey === uploadKey);
  if (
    !action?.evidence ||
    !file ||
    (expectedUploadLeaseId !== undefined &&
      (action.state !== "uploading" || action.uploadLeaseId !== expectedUploadLeaseId))
  ) {
    await transaction.done;
    return undefined;
  }
  if (file.receiptId) {
    await transaction.done;
    return action;
  }
  const updated: OutboxAction = {
    ...action,
    evidence: {
      ...action.evidence,
      files: action.evidence.files.map((candidate) =>
        candidate === file ? { ...candidate, receiptId } : candidate,
      ),
    },
    updatedAt: now,
  };
  await actions.put(updated);
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

/**
 * Settle an unconfirmed item the office says it holds: no resend, and the saved files go the
 * same way a verified upload's do. Only an item still waiting on that check is touched.
 */
export async function markOutboxConfirmedByOffice(
  deviceActionId: string,
  officeResolution: OutboxOfficeResolution,
  now = Date.now(),
): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction(["outbox_actions", "outbox_blobs"], "readwrite");
  const actionStore = transaction.objectStore("outbox_actions");
  const action = await actionStore.get(deviceActionId);
  if (action?.state !== "needs_attention") {
    await transaction.done;
    return undefined;
  }
  assertTransition(action.state, "verified");
  const updated: OutboxAction = {
    ...action,
    state: "verified",
    verification: {
      verifiedAt: now,
      serverRef: officeResolution.linkedRecord.id,
      cursor: officeResolution.resolutionId,
      officeResolution,
    },
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

/**
 * The office says this item never arrived: queue it once more under the same device action id,
 * so the Worker's own idempotency and the normal verification decide what happens next. One
 * resend per office answer; the same answer read again never queues it twice.
 */
export async function requeueOutboxForOfficeResend(
  deviceActionId: string,
  resolutionId: string,
  now = Date.now(),
): Promise<OutboxAction | undefined> {
  const database = await getDatabase();
  const transaction = database.transaction("outbox_actions", "readwrite");
  const store = transaction.objectStore("outbox_actions");
  const action = await store.get(deviceActionId);
  if (action?.state !== "needs_attention" || action.officeResend?.resolutionId === resolutionId) {
    await transaction.done;
    return undefined;
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
    officeResend: { resolutionId, requeuedAt: now },
    updatedAt: now,
  };
  await store.put(queued);
  await transaction.done;
  notifyOutboxChanged();
  return queued;
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
    // Only the check-in rail carries media. A fleet capture is bound to the
    // immutable manifest the Worker stores, so queuing a blob here would
    // create a second, unverifiable evidence path.
    throw new Error("Only field check-ins can include attachments.");
  }
  assertEvidenceInput(input);
  if (input.kind === "work_package_acknowledgement") {
    assertWorkPackageAcknowledgementPayload(
      input.payload,
      input.endpoint.includes("/work-objects/"),
    );
  }
  if (input.kind === "work_package_stop") {
    assertWorkPackageStopPayload(input.payload, input.endpoint.includes("/work-objects/"));
  }
  if (fleetInspectionKinds.has(input.kind)) assertFleetInspectionPayload(input.payload);
  if (input.kind === "fleet_defect_report") assertFleetDefectPayload(input.payload);
  if (input.kind === "fleet_collision_report") assertFleetCollisionPayload(input.payload);
  if (input.kind === "schema_field_value") assertSchemaFieldValuePayload(input.payload);
  if (input.kind === "safety_corrective_evidence") correctiveEvidenceSchema.parse(input.payload);
  for (const attachment of input.attachments ?? []) {
    if (!attachment.fileName.trim()) throw new PlainError("Every attachment needs a file name.");
  }
  assertNoSessionSecrets(input.payload);
}

const EVIDENCE_KINDS: Partial<Record<OutboxActionKind, "stock" | "corrective_action">> = {
  inventory_command: "stock",
  safety_corrective_evidence: "corrective_action",
};
// eslint-disable-next-line no-control-regex -- the Worker refuses these characters in a file name.
const UNSAFE_FILE_NAME = /[\u0000-\u001f/\\]/;

/**
 * Evidence-bearing actions must say which files they carry and what those files are scoped to,
 * and nothing else may. The scope is checked against the request it will travel with, so a saved
 * file can never be sent for a different stock command or corrective action.
 *
 * The stock and safety desks that still type a digest reference save it inside the request
 * instead (`evidence_refs`, or `evidence_sha256` with `evidence_refs_json`), which the Worker
 * accepts while receipts are not required. An action carries one or the other, never both, and
 * never neither.
 */
function assertEvidenceInput(input: SaveOutboxActionInput): void {
  const purpose = EVIDENCE_KINDS[input.kind];
  const evidence = input.evidence;
  if (!purpose) {
    if (evidence) throw new Error("This action cannot carry evidence files.");
    return;
  }
  const request = objectPayload(input.payload);
  const typedReference =
    purpose === "stock"
      ? "evidence_refs" in request
      : "evidence_sha256" in request || "evidence_refs_json" in request;
  if (!evidence) {
    if (!typedReference) {
      throw new Error("This action needs its evidence files to be saved with it.");
    }
    return;
  }
  if (typedReference || "evidence_receipt_ids" in request) {
    throw new Error("This action carries its files separately, not inside the saved request.");
  }
  assertEvidenceDescriptor(evidence, purpose);
  if (purpose === "corrective_action") {
    const actionId = input.endpoint.split("/")[5];
    if (
      evidence.scope.action !== "submit" ||
      evidence.scope.operationId !== "" ||
      !actionId ||
      evidence.scope.targetId !== decodeURIComponent(actionId)
    ) {
      throw new Error("The saved files do not belong to this corrective action.");
    }
    return;
  }
  if (
    typeof request.command_id !== "string" ||
    evidence.scope.operationId !== request.command_id ||
    evidence.scope.action !== request.transition
  ) {
    throw new Error("The saved files do not belong to this stock action.");
  }
}

function assertEvidenceDescriptor(
  evidence: OutboxEvidenceInput,
  purpose: "stock" | "corrective_action",
): void {
  if (evidence.scope.purpose !== purpose || !evidence.scope.targetId.trim()) {
    throw new Error("The saved files are missing what they belong to.");
  }
  const { files } = evidence;
  if (files.length < 1 || files.length > EVIDENCE_MAX_FILES) {
    throw new Error(`Keep between 1 and ${EVIDENCE_MAX_FILES} files.`);
  }
  const keys = new Set<string>();
  for (const file of files) {
    if (
      !isUploadKey(file.uploadKey) ||
      keys.has(file.uploadKey) ||
      !file.fileName.trim() ||
      file.fileName.length > 180 ||
      UNSAFE_FILE_NAME.test(file.fileName) ||
      !(evidenceMimeTypes as readonly string[]).includes(file.mimeType) ||
      !Number.isInteger(file.size) ||
      file.size < 1 ||
      file.size > EVIDENCE_MAX_BYTES ||
      !file.blob ||
      (file.receiptId !== undefined && !evidenceReceiptIdSchema.safeParse(file.receiptId).success)
    ) {
      throw new Error("A saved file is not valid. Choose it again.");
    }
    if (file.blob.size !== file.size) {
      throw new Error("A saved file changed while it was being saved. Choose it again.");
    }
    keys.add(file.uploadKey);
  }
}

/**
 * The exact command the record-value route takes, and nothing else.
 *
 * This is a shape guard, not a validator: the field's own rules (required, options, range, type)
 * are configuration the SERVER owns and enforces, and re-deriving them here would let a client
 * refuse a value an administrator had just made legal. What it does refuse is a payload that could
 * not possibly replay — a missing concurrency token, a lineage reference without its reason, or an
 * extra key that would change the command fingerprint the server keys idempotency on.
 */
function assertSchemaFieldValuePayload(payload: unknown): void {
  const value = objectPayload(payload);
  const keys = Object.keys(value);
  if (
    keys.length !== schemaFieldValueKeys.length ||
    schemaFieldValueKeys.some((key) => !(key in value))
  ) {
    throw new Error("Configured field payload is invalid.");
  }
  assertBoundedText(
    value.field_definition_revision_id,
    "Field definition revision",
    SCHEMA_REVISION_REF_MAX_LENGTH,
  );
  if (
    typeof value.expected_version !== "number" ||
    !Number.isInteger(value.expected_version) ||
    value.expected_version < 0 ||
    value.expected_version > 1_000_000
  ) {
    throw new Error("Configured field version is required.");
  }
  const basedOn = value.based_on_value_revision_id;
  const reason = value.correction_reason;
  if (basedOn !== null)
    assertBoundedText(basedOn, "Correction reference", SCHEMA_REVISION_REF_MAX_LENGTH);
  if (reason !== null)
    assertBoundedText(reason, "Correction reason", SCHEMA_CORRECTION_REASON_MAX_LENGTH);
  // The server refuses one without the other. Catching it here keeps a half-formed correction from
  // sitting in the queue until it reaches a network only to be rejected.
  if ((basedOn === null) !== (reason === null)) {
    throw new PlainError("A correction needs both the value it replaces and a reason.");
  }
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
    !("work_package_id" in value) ||
    !("work_package_version" in value) ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    (typedScope && scopeKeys.some((key) => !(key in value)))
  ) {
    throw new Error("Stop Work payload is invalid.");
  }
  assertBoundedText(value.work_package_id, "Work Package ID", WORK_PACKAGE_ID_MAX_LENGTH);
  if ("blocker_reason" in value) {
    const reason = value.blocker_reason;
    if (
      reason !== null &&
      (typeof reason !== "string" || reason.length > STOP_WORK_REASON_MAX_LENGTH)
    )
      throw new Error("Stop Work reason is too long or invalid.");
  }
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

/**
 * Mirror the Worker envelope exactly.
 *
 * A capture saved on a roadside with no signal must fail here, in front of the
 * driver, rather than three hours later when the queue finally drains and the
 * server rejects a shape nobody can still correct.
 */
function assertFleetInspectionPayload(payload: unknown): void {
  const value = objectPayload(payload);
  assertExactKeys(
    value,
    ["fleet_asset_id", "performed_at", "items"],
    ["meter_reading", "telematics_reference"],
    "Fleet inspection payload is invalid.",
  );
  assertBoundedText(value.fleet_asset_id, "Fleet Asset ID", FLEET_ASSET_ID_MAX_LENGTH);
  assertUtcTimestamp(value.performed_at, "Inspection time");
  if (!Array.isArray(value.items) || value.items.length < 1) {
    throw new PlainError("An inspection needs at least one recorded check point.");
  }
  if (value.items.length > FLEET_INSPECTION_ITEM_LIMIT) {
    throw new PlainError("An inspection carries at most 60 check points.");
  }
  value.items.forEach((row, index) => assertFleetInspectionItem(row, index + 1));
  if (value.meter_reading !== undefined) {
    assertNonNegativeNumber(value.meter_reading, "Meter reading");
  }
  if (value.telematics_reference !== undefined) {
    assertBoundedText(
      value.telematics_reference,
      "Telematics reference",
      FLEET_ASSET_ID_MAX_LENGTH,
    );
  }
}

function assertFleetInspectionItem(row: unknown, expectedSequence: number): void {
  const value = objectPayload(row);
  assertExactKeys(
    value,
    ["sequence", "check_point", "result"],
    ["severity", "observation"],
    "An inspection check point is invalid.",
  );
  if (value.sequence !== expectedSequence) {
    throw new PlainError("Inspection check points must stay in order.");
  }
  if (typeof value.result !== "string" || !fleetItemResults.has(value.result)) {
    throw new PlainError("An inspection check point needs a Pass, Fail, or Not Applicable result.");
  }
  assertBoundedText(value.check_point, "Check point", FLEET_ASSET_ID_MAX_LENGTH);
  const severity = value.severity === undefined ? "None" : value.severity;
  if (
    typeof severity !== "string" ||
    (severity !== "None" && !fleetDefectSeverities.has(severity))
  ) {
    throw new Error("An inspection check point severity is invalid.");
  }
  // A failed check point must always name its severity; a passing one must not
  // carry one, so a device can never downgrade a real defect into a note.
  if ((value.result === "Fail") !== (severity !== "None")) {
    throw new PlainError("A failed check point needs a severity and a passing one carries none.");
  }
  if (value.observation !== undefined) {
    assertBoundedText(value.observation, "Observation", FLEET_TEXT_MAX_LENGTH);
  }
}

function assertFleetDefectPayload(payload: unknown): void {
  const value = objectPayload(payload);
  assertExactKeys(
    value,
    ["fleet_asset_id", "detected_at", "severity", "description"],
    ["asset_inspection_id"],
    "Defect report payload is invalid.",
  );
  assertBoundedText(value.fleet_asset_id, "Fleet Asset ID", FLEET_ASSET_ID_MAX_LENGTH);
  assertUtcTimestamp(value.detected_at, "Defect time");
  if (typeof value.severity !== "string" || !fleetDefectSeverities.has(value.severity)) {
    throw new PlainError("A defect report needs a Minor, Major, or Out of Service severity.");
  }
  assertBoundedText(value.description, "Defect description", FLEET_TEXT_MAX_LENGTH);
  if (value.asset_inspection_id !== undefined) {
    assertBoundedText(value.asset_inspection_id, "Inspection ID", FLEET_ASSET_ID_MAX_LENGTH);
  }
}

/** The collision route's own body (`workers-bus/src/fleet-collision-api.ts`), without photos. */
function assertFleetCollisionPayload(payload: unknown): void {
  const value = objectPayload(payload);
  assertExactKeys(
    value,
    ["collision_id", "occurred_at", "severity", "description"],
    [],
    "Collision report payload is invalid.",
  );
  if (
    typeof value.collision_id !== "string" ||
    !/^fc_[A-Za-z0-9._:-]{8,60}$/.test(value.collision_id)
  ) {
    throw new PlainError("A collision report needs its own report ID.");
  }
  assertUtcTimestamp(value.occurred_at, "Collision time");
  if (typeof value.severity !== "string" || !fleetDefectSeverities.has(value.severity)) {
    throw new PlainError("A collision report needs a Minor, Major, or Out of Service severity.");
  }
  assertBoundedText(value.description, "What happened", FLEET_TEXT_MAX_LENGTH);
  // The Worker keeps at least three characters once trimmed; a shorter report saved here would
  // only be refused after the driver has left.
  if ((value.description as string).trim().length < 3) {
    throw new Error("What happened needs at least three characters.");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  message: string,
): void {
  const keys = new Set(Object.keys(value));
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.has(key)) || [...keys].some((key) => !allowed.has(key))) {
    throw new Error(message);
  }
}

function assertUtcTimestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} must be a UTC timestamp.`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a number of zero or more.`);
  }
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("This offline action payload is invalid.");
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
