import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { cacheFieldModel, getCachedFieldModel } from "../field/field-cache";
import { ApiError, apiRequest, isRetryableApiError } from "../lib/api";
import {
  DOCUMENT_GENERATIONS_ROUTE,
  DOCUMENTS_ROUTE_PREFIX,
  documentGenerationResponseSchema,
  entityDocumentsResponseSchema,
  type EntityDocumentsModel,
} from "./document-contracts";

/**
 * Reading the documents a record carries, under the same offline contract as the rest of the field
 * packet: try the network, cache what came back, fall back to the cached copy when the device
 * cannot reach the server.
 *
 * A crew member who opened the job while connected keeps its documents in the truck. One who never
 * opened it gets nothing rather than an empty document — a document that renders with no lines
 * would read as "this job has no materials list", which is a claim this client is in no position
 * to make offline.
 */

export function entityDocumentsPath(entityType: string, entityId: string): string {
  return `${DOCUMENTS_ROUTE_PREFIX}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}

export async function loadEntityDocuments(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
  fetcher: typeof fetch = fetch,
): Promise<EntityDocumentsModel> {
  const key = entityDocumentsCacheKey(session, entityType, entityId);
  try {
    const response = await apiRequest({
      path: entityDocumentsPath(entityType, entityId),
      schema: entityDocumentsResponseSchema,
      fetcher,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
    await cacheFieldModel(key, response, null);
    return { response, offline: false };
  } catch (error) {
    // A record with nothing published to this reader is an empty shelf, not a failure: the server
    // answers 404 both for a record it will not name and for one that carries no document, and
    // neither is something to interrupt the job packet over.
    if (error instanceof ApiError && error.status === 404)
      return {
        response: { entity_type: entityType, entity_id: entityId, documents: [] },
        offline: false,
      };
    if (!isRetryableApiError(error)) throw error;
    const parsed = entityDocumentsResponseSchema.safeParse(await getCachedFieldModel(key));
    if (!parsed.success) throw error;
    return { response: parsed.data, offline: true };
  }
}

/**
 * Cached per tenant AND per user, matching `schemaCardCacheKey`. Which documents a reader is shown
 * follows their authority, so two roles sharing a phone must never read each other's cached shelf.
 */
function entityDocumentsCacheKey(
  session: AuthenticatedSession,
  entityType: string,
  entityId: string,
): string {
  return `${session.tenant.id}:${session.user.id}:entity-documents:${entityType}:${entityId}`;
}

/**
 * Ask the Worker to make one document from the current record. Owner only on the server; the
 * caller supplies the idempotency key and keeps it for a retry, so a lost answer replays the same
 * attempt instead of minting a second document. Non-2xx outcomes (`not_executed`,
 * `manual_exception`, `failed`) still carry a receipt and are surfaced through `ApiError.detail`.
 */
export function generateEntityDocument(
  session: AuthenticatedSession,
  input: {
    entityType: string;
    entityId: string;
    templateId: string;
    templateRevisionId: string;
    idempotencyKey: string;
  },
) {
  return apiRequest({
    path: DOCUMENT_GENERATIONS_ROUTE,
    method: "POST",
    csrfToken: session.csrf_token,
    idempotencyKey: input.idempotencyKey,
    body: {
      entity_type: input.entityType,
      entity_id: input.entityId,
      template_id: input.templateId,
      template_revision_id: input.templateRevisionId,
    },
    schema: documentGenerationResponseSchema,
  });
}
