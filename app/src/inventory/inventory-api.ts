import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { evidenceReceiptIdsField, type EvidenceScope } from "../evidence/evidence-types";
import type { EvidenceSubmission } from "../evidence/evidence-uploads";
import {
  getOutboxAction,
  isOutboxActionSafeToRetry,
  queueOutboxAction,
  queueSavedOutboxActionIf,
  saveOutboxAction,
} from "../storage/outbox";
import type { JsonValue, OutboxAction } from "../storage/outbox-types";
import {
  inventoryCommandDetailResponseSchema,
  inventoryCommandResponseSchema,
  inventoryLookupResponseSchema,
  inventoryOverviewResponseSchema,
  inventoryScanResponseSchema,
  type InventoryCommandDetailResponse,
  type InventoryCommandInput,
  type InventoryCommandResponse,
  type InventoryLookupResponse,
  type InventoryOverviewResponse,
  type InventoryScanInput,
  type InventoryScanResponse,
} from "./inventory-contracts";

/**
 * Inventory is one of the four surfaces a crew phone carries, and a field session is
 * only authenticated when the request also presents its device proof. Without it the
 * Worker answers 401 AND expires the session cookie, so opening Inventory used to sign
 * the paired phone out (ELEC-157). Office sessions carry no proof and send none.
 */
function proofFor(session: AuthenticatedSession) {
  return session.user.role === "field" ? getDeviceSecret : undefined;
}

export async function loadInventoryOverview(
  session: AuthenticatedSession,
  fetcher: typeof fetch = fetch,
): Promise<InventoryOverviewResponse> {
  return await apiRequest({
    path: API_PATHS.inventoryOverview,
    schema: inventoryOverviewResponseSchema,
    fetcher,
    deviceProof: proofFor(session),
  });
}

/** One recorded stock action with the files attached to it, read back after it was applied. */
export async function loadInventoryCommand(
  session: AuthenticatedSession,
  commandId: string,
  fetcher: typeof fetch = fetch,
): Promise<InventoryCommandDetailResponse> {
  return await apiRequest({
    path: API_PATHS.inventoryCommand(commandId),
    schema: inventoryCommandDetailResponseSchema,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function lookupInventoryBarcode(
  session: AuthenticatedSession,
  barcode: string,
  fetcher: typeof fetch = fetch,
): Promise<InventoryLookupResponse> {
  return await apiRequest({
    path: `${API_PATHS.inventoryLookup}?barcode=${encodeURIComponent(barcode)}`,
    schema: inventoryLookupResponseSchema,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function recordInventoryScan(
  session: AuthenticatedSession,
  input: InventoryScanInput,
  fetcher: typeof fetch = fetch,
): Promise<InventoryScanResponse> {
  const body = {
    scan_id: input.scan_id,
    device_id: input.device_id,
    device_action_id: input.device_action_id,
    barcode: input.barcode,
    scan_intent: input.scan_intent,
    observed_at: input.observed_at,
    captured_offline: input.captured_offline,
    payload: input.payload ?? {},
  };
  return await apiRequest({
    path: API_PATHS.inventoryScans,
    schema: inventoryScanResponseSchema,
    method: "POST",
    body: {
      ...body,
      request_fingerprint_sha256:
        input.request_fingerprint_sha256 ?? (await inventoryRequestFingerprint(body)),
    },
    csrfToken: session.csrf_token,
    deviceActionId: input.device_action_id,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function queueInventoryScan(
  session: AuthenticatedSession,
  input: InventoryScanInput,
): Promise<void> {
  const body = {
    scan_id: input.scan_id,
    device_id: input.device_id,
    device_action_id: input.device_action_id,
    barcode: input.barcode,
    scan_intent: input.scan_intent,
    observed_at: input.observed_at,
    captured_offline: true,
    payload: input.payload ?? {},
  };
  const payload = {
    ...body,
    request_fingerprint_sha256:
      input.request_fingerprint_sha256 ?? (await inventoryRequestFingerprint(body)),
  } as unknown as JsonValue;
  await saveOutboxAction({
    deviceActionId: input.device_action_id,
    tenantId: session.tenant.id,
    userId: session.user.id,
    kind: "inventory_scan",
    endpoint: API_PATHS.inventoryScans,
    payload,
  });
  await queueOutboxAction(input.device_action_id);
}

/**
 * Sends one stock action together with the receipts of the files that show it. Every file has
 * already been uploaded and confirmed; the Worker re-checks each against this exact lot,
 * transition and `command_id` before it changes anything. An action composed with a typed digest
 * reference goes up as before, with no receipt ids.
 */
export async function submitInventoryCommand(
  session: AuthenticatedSession,
  input: InventoryCommandInput,
  idempotencyKey: string,
  receiptIds: readonly string[] = [],
  fetcher: typeof fetch = fetch,
): Promise<InventoryCommandResponse> {
  return await apiRequest({
    path: API_PATHS.inventoryCommands,
    schema: inventoryCommandResponseSchema,
    method: "POST",
    body: await inventoryCommandRequest(input, idempotencyKey, receiptIds),
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
    deviceProof: proofFor(session),
  });
}

/**
 * Saves one stock action on this device with its files, for a session that cannot reach the
 * Worker. On reconnect the files upload first, then the action goes up with their receipts. An
 * action composed with a typed digest reference has no files and is saved as it will be sent.
 */
export async function queueInventoryCommand(
  session: AuthenticatedSession,
  input: InventoryCommandInput,
  idempotencyKey: string,
  evidence?: EvidenceSubmission,
): Promise<void> {
  if (!evidence) {
    await saveOutboxAction({
      deviceActionId: idempotencyKey,
      tenantId: session.tenant.id,
      userId: session.user.id,
      kind: "inventory_command",
      endpoint: API_PATHS.inventoryCommands,
      payload: (await inventoryCommandRequest(input, idempotencyKey, [])) as unknown as JsonValue,
    });
    await queueOutboxAction(idempotencyKey);
    return;
  }
  const handoff = await handOffInventoryCommand(session, input, idempotencyKey, evidence);
  if (handoff !== "queued") throw new Error("inventory_command_not_saved");
}

/**
 * The request for one stock action: the action with the receipt ids of its uploaded files, or,
 * when it was composed with a typed digest reference, that reference and its replay fingerprint.
 * The Worker refuses a typed reference beside receipt ids, so an action never carries both.
 */
async function inventoryCommandRequest(
  input: InventoryCommandInput,
  idempotencyKey: string,
  receiptIds: readonly string[],
) {
  const body = inventoryCommandBody(input, idempotencyKey);
  if (!input.evidence_refs) return { ...body, ...evidenceReceiptIdsField(receiptIds) };
  if (receiptIds.length > 0) {
    throw new Error("A stock action carries a typed reference or uploaded files, not both.");
  }
  return {
    ...body,
    request_fingerprint_sha256:
      input.request_fingerprint_sha256 ?? (await inventoryRequestFingerprint(body)),
  };
}

/**
 * Where one stock action stands in saved work:
 * - `queued`: saved work holds this exact action and sends it by itself under the same key.
 * - `verified`: saved work already sent it; only a read-back by its `command_id` says whether it
 *   applied or was refused.
 * - `needs_attention`: saved work holds it but stopped; it does not send by itself, only when a
 *   person tries it again from saved work.
 * - `stopped`: saved work holds it but was refused for good; it never sends from this device again,
 *   so only a read-back by its `command_id` says whether an earlier send applied.
 * - `mismatch`: something else is saved under this key (another person, another kind, another
 *   payload or other files), so nothing is assumed about this action.
 * - `missing`: it is not in saved work and its files are not here.
 */
export type InventoryHandoff =
  "queued" | "verified" | "needs_attention" | "stopped" | "mismatch" | "missing";

/**
 * Puts one stock action into saved work, resuming whatever an earlier, interrupted try already
 * did. The saved action's id is its idempotency key, so a second try finds it again: one saved but
 * not yet queued is queued, one further along is reported as it stands, and only an action saved
 * nowhere is saved anew (which needs its files). A saved record counts as this action only when its
 * person, kind, endpoint, payload and file scope all match exactly.
 */
export async function handOffInventoryCommand(
  session: AuthenticatedSession,
  input: InventoryCommandInput,
  idempotencyKey: string,
  evidence: EvidenceSubmission | null,
): Promise<InventoryHandoff> {
  const payload = inventoryCommandBody(input, idempotencyKey) as unknown as JsonValue;
  if (evidence && !isStockScopeFor(evidence.scope, input)) return "mismatch";
  const isThisAction = (saved: OutboxAction) =>
    saved.tenantId === session.tenant.id &&
    saved.userId === session.user.id &&
    saved.kind === "inventory_command" &&
    saved.endpoint === API_PATHS.inventoryCommands &&
    saved.method === "POST" &&
    canonicalJson(saved.payload) === canonicalJson(payload) &&
    saved.evidence !== undefined &&
    isStockScopeFor(saved.evidence.scope, input) &&
    (evidence === null ||
      canonicalJson(saved.evidence.files.map((file) => file.uploadKey)) ===
        canonicalJson(evidence.files.map((file) => file.uploadKey)));
  if (!(await getOutboxAction(idempotencyKey))) {
    if (!evidence) return "missing";
    try {
      await saveOutboxAction({
        deviceActionId: idempotencyKey,
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "inventory_command",
        endpoint: API_PATHS.inventoryCommands,
        payload,
        evidence,
      });
    } catch (error) {
      // Another tab may have saved it first; the check below finds that one. Anything else stands.
      if (!(await getOutboxAction(idempotencyKey))) throw error;
    }
  }
  // Checked and queued in one transaction: a record another tab moved meanwhile is read as it is
  // now, and a stopped one is never sent again from here.
  const result = await queueSavedOutboxActionIf(idempotencyKey, isThisAction);
  if (result.found === "none") return "missing";
  if (result.found === "other") return "mismatch";
  const { action } = result;
  if (action.state === "verified") return "verified";
  if (action.state === "needs_attention") {
    return isOutboxActionSafeToRetry(action) ? "needs_attention" : "stopped";
  }
  return "queued";
}

/** Files for a stock action belong to its lot, its transition and its `command_id`, nothing else. */
function isStockScopeFor(scope: EvidenceScope, input: InventoryCommandInput): boolean {
  return (
    scope.purpose === "stock" &&
    scope.targetId === input.lot_id &&
    scope.action === input.transition &&
    scope.operationId === input.command_id
  );
}

/** JSON with object keys sorted, so two equal payloads compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

export function inventoryCommandBody(input: InventoryCommandInput, idempotencyKey: string) {
  return {
    command_id: input.command_id,
    idempotency_key: idempotencyKey,
    transition: input.transition,
    authority_ref: input.authority_ref,
    policy_ref: input.policy_ref,
    policy_version: input.policy_version,
    ...(input.evidence_refs ? { evidence_refs: input.evidence_refs } : {}),
    approval_id: input.approval_id ?? null,
    source_position_id: input.source_position_id ?? null,
    target_position_id: input.target_position_id ?? null,
    item_id: input.item_id ?? null,
    lot_id: input.lot_id ?? null,
    bin_id: input.bin_id ?? null,
    uom_id: input.uom_id ?? null,
    job_custody: input.job_custody ?? null,
    quantity_scaled: input.quantity_scaled ?? null,
    counted_quantity_scaled: input.counted_quantity_scaled ?? null,
    unit_cost_minor: input.unit_cost_minor ?? null,
    currency: input.currency ?? null,
    job_id: input.job_id ?? null,
    work_package_id: input.work_package_id ?? null,
    reservation_id: input.reservation_id ?? null,
    receipt_id: input.receipt_id ?? null,
    po_line_id: input.po_line_id ?? null,
    count_session_id: input.count_session_id ?? null,
    reversal_reference: input.reversal_reference ?? null,
    condition_status: input.condition_status ?? null,
    payload: input.payload ?? {},
  };
}

export function newInventoryActionKey(action: string): string {
  return `inventory:${action}:${crypto.randomUUID()}`;
}

export async function inventoryRequestFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
