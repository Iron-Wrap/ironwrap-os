import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { cacheFieldModel, getCachedFieldModel } from "../field/field-cache";
import { apiRequest, isRetryableApiError } from "../lib/api";
import { schemaCardResponseSchema, type SchemaCardModel } from "./schema-card-contracts";

/**
 * Reading a record's authorized schema fields, with the same offline contract the rest of the
 * field packet already honours: try the network, cache what came back, and fall back to the cached
 * copy when the device cannot reach the server.
 *
 * A crew member who opened a job while connected keeps its card offline. One who never opened it
 * gets nothing rather than a misleading empty card — an absent field on this surface means "your
 * role may not read this", so silently rendering zero fields offline would look like an authority
 * decision that never happened.
 */

export function schemaCardPath(entityType: string, entityId: string): string {
  return `/api/v1/schema-fields/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}

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
