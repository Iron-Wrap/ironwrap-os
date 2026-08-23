import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import type { JsonValue } from "../storage/outbox-types";
import {
  inventoryCommandResponseSchema,
  inventoryLookupResponseSchema,
  inventoryOverviewResponseSchema,
  inventoryScanResponseSchema,
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

export async function submitInventoryCommand(
  session: AuthenticatedSession,
  input: InventoryCommandInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<InventoryCommandResponse> {
  const body = inventoryCommandBody(input, idempotencyKey);
  return await apiRequest({
    path: API_PATHS.inventoryCommands,
    schema: inventoryCommandResponseSchema,
    method: "POST",
    body: {
      ...body,
      request_fingerprint_sha256:
        input.request_fingerprint_sha256 ?? (await inventoryRequestFingerprint(body)),
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
    deviceProof: proofFor(session),
  });
}

export async function queueInventoryCommand(
  session: AuthenticatedSession,
  input: InventoryCommandInput,
  idempotencyKey: string,
): Promise<void> {
  const body = inventoryCommandBody(input, idempotencyKey);
  const payload = {
    ...body,
    request_fingerprint_sha256:
      input.request_fingerprint_sha256 ?? (await inventoryRequestFingerprint(body)),
  } as unknown as JsonValue;
  await saveOutboxAction({
    deviceActionId: idempotencyKey,
    tenantId: session.tenant.id,
    userId: session.user.id,
    kind: "inventory_command",
    endpoint: API_PATHS.inventoryCommands,
    payload,
  });
  await queueOutboxAction(idempotencyKey);
}

function inventoryCommandBody(input: InventoryCommandInput, idempotencyKey: string) {
  return {
    command_id: input.command_id,
    idempotency_key: idempotencyKey,
    transition: input.transition,
    authority_ref: input.authority_ref,
    policy_ref: input.policy_ref,
    policy_version: input.policy_version,
    evidence_refs: input.evidence_refs,
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
