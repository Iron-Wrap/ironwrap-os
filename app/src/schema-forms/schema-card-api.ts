import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { cacheFieldModel, getCachedFieldModel } from "../field/field-cache";
import { apiRequest, isRetryableApiError } from "../lib/api";
import { listOutboxActionsByKind, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { JsonValue, OutboxAction } from "../storage/outbox-types";
import {
  schemaCardPath,
  schemaCardResponseSchema,
  schemaCardValuePath,
  schemaCardWriteBody,
  schemaCardWriteResponseSchema,
  type SchemaCardModel,
  type SchemaCardWriteCommand,
  type SchemaCardWriteResponse,
} from "./schema-card-contracts";

/**
 * Reading a record's authorized schema fields, with the same offline contract the rest of the
 * field packet already honours: try the network, cache what came back, and fall back to the cached
 * copy when the device cannot reach the server.
 *
 * A crew member who opened a job while connected keeps its card offline. One who never opened it
 * gets nothing rather than a misleading empty card — an absent field on this surface means "your
 * role may not read this", so silently rendering zero fields offline would look like an authority
 * decision that never happened.
 *
 * Writing is the other half (ELEC-193). It goes to the same governed route the server already
 * enforces authority on; this module never decides who may write, it only carries the command.
 */

export { schemaCardPath, schemaCardValuePath };

export async function loadSchemaCard(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
  fetcher: typeof fetch = fetch,
): Promise<SchemaCardModel> {
  const key = schemaCardCacheKey(session, entityType, entityId);
  try {
    const response = await apiRequest({
      path: schemaCardPath(entityType, entityId),
      schema: schemaCardResponseSchema,
      fetcher,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
    await cacheFieldModel(key, response, null);
    return { response, offline: false };
  } catch (error) {
    if (!isRetryableApiError(error)) throw error;
    const parsed = schemaCardResponseSchema.safeParse(await getCachedFieldModel(key));
    if (!parsed.success) throw error;
    return { response: parsed.data, offline: true };
  }
}

/**
 * Send one value now and wait for the server's answer.
 *
 * Every refusal — validation, authority, a stale definition, a version conflict — arrives as an
 * `ApiError` carrying the server's own code and its detail fields. Nothing here interprets them;
 * `schemaCardWriteRefusal` in `schema-card-presentation.ts` turns a code into copy, and the caller
 * decides what to do with a conflict.
 */
export async function writeSchemaCardValue(
  session: AuthenticatedSession,
  command: SchemaCardWriteCommand,
  fetcher: typeof fetch = fetch,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<SchemaCardWriteResponse> {
  return await apiRequest({
    path: schemaCardValuePath(command.entityType, command.entityId, command.fieldId),
    method: "POST",
    schema: schemaCardWriteResponseSchema,
    body: schemaCardWriteBody(command),
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
    deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
  });
}

/**
 * Keep one value on this device and let the outbox deliver it.
 *
 * This is the field-surface half of the distinction drawn in ELEC-188: a configuration surface
 * discards an unsendable change and says so, because an administrator is at a desk and can redo
 * it; a field surface QUEUES, because a crew member on a roof cannot. The durable outbox already
 * carries check-ins, safety reports and fleet inspections through a dead network, and a schema
 * value now rides the same rail — same lease, same replay, same "nothing was thrown away".
 *
 * The device action id doubles as the `Idempotency-Key`, so a replay after a dropped response
 * returns the value the server already stored rather than appending a second one.
 */
export async function queueSchemaCardValue(
  session: AuthenticatedSession,
  command: SchemaCardWriteCommand,
  fetcher: typeof fetch = fetch,
): Promise<OutboxAction> {
  const saved = await saveOutboxAction({
    tenantId: session.tenant.id,
    userId: session.user.id,
    kind: "schema_field_value",
    endpoint: schemaCardValuePath(command.entityType, command.entityId, command.fieldId),
    payload: schemaCardWriteBody(command) as JsonValue,
  });
  const queued = await queueOutboxAction(saved.deviceActionId);
  // Reconnecting mid-entry is common: the crew member walks back to the truck. Trying once now
  // costs nothing when it fails and turns a queued write into a saved one when it does not.
  if (navigator.onLine && session.csrf_token !== "offline-session-no-csrf") {
    await flushOutbox({
      tenantId: session.tenant.id,
      userId: session.user.id,
      csrfToken: session.csrf_token,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
      fetcher,
    }).catch(() => {
      // A failed flush leaves the item queued, which is the point of queueing it.
    });
  }
  return queued;
}

/**
 * The values this device is still holding for one record, keyed by field id.
 *
 * The card renders these as "waiting to send" rather than as the field's value. A queued write is
 * not yet a fact, and showing it as one is how a crew member ends up believing the office can see
 * something it cannot.
 */
export async function pendingSchemaCardWrites(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
): Promise<Map<string, OutboxAction>> {
  const prefix = `${schemaCardPath(entityType, entityId)}/`;
  const actions = await listOutboxActionsByKind(
    { tenantId: session.tenant.id, userId: session.user.id },
    "schema_field_value",
  );
  const pending = new Map<string, OutboxAction>();
  for (const action of actions) {
    if (!action.endpoint.startsWith(prefix)) continue;
    const fieldId = fieldIdOfEndpoint(action.endpoint, prefix);
    if (!fieldId) continue;
    // Newest wins: a crew member who corrected the same field twice offline is waiting on the
    // second entry, and the first is only ever history.
    const held = pending.get(fieldId);
    if (!held || held.createdAt <= action.createdAt) pending.set(fieldId, action);
  }
  return pending;
}

function fieldIdOfEndpoint(endpoint: string, prefix: string): string | null {
  const rest = endpoint.slice(prefix.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  try {
    return decodeURIComponent(rest.slice(0, separator));
  } catch {
    return null;
  }
}

/**
 * Cached per tenant AND per user, because the payload is already filtered by the reader's
 * authority. Two roles sharing a device must never read each other's cached card.
 */
function schemaCardCacheKey(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
): string {
  return `${session.tenant.id}:${session.user.id}:schema-card:${entityType}:${entityId}`;
}
