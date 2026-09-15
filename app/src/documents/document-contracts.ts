import { z } from "zod";

/**
 * The record-level read contract for administrator-authored documents (IRO-242,
 * `workers-bus/src/document-templates.ts`).
 *
 * A document here is a LAYOUT, never data: headings, static text, and bindings naming the schema
 * fields that fill it. Values never travel on this payload. They are joined in the client from
 * `GET /api/v1/schema-fields/:entityType/:entityId`, which is the one read that applies per-field
 * authority — so a reader can only ever see a value that route already decided they may have, and
 * this contract cannot become a second, weaker way to the same data.
 *
 * The administration routes under `/api/v1/admin/document-templates` are the owner's authoring
 * surface. This is the other half: what the shop and the crew open on the job.
 */

export const DOCUMENTS_ROUTE_PREFIX = "/api/v1/documents";

/** Mirrors `DocumentTemplateBlock`. `.passthrough()` keeps a widened server from breaking a shipped client. */
export const documentBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("heading"), level: z.number().int().min(1).max(3), text: z.string() })
    .passthrough(),
  z.object({ kind: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ kind: z.literal("field"), field_id: z.string().min(1) }).passthrough(),
]);

export const entityDocumentSchema = z
  .object({
    template_id: z.string().min(1),
    template_key: z.string().min(1),
    label: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    blocks: z.array(documentBlockSchema),
  })
  .passthrough();

export const entityDocumentsResponseSchema = z
  .object({
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
    documents: z.array(entityDocumentSchema),
  })
  .passthrough();

export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type EntityDocument = z.infer<typeof entityDocumentSchema>;
export type EntityDocumentsResponse = z.infer<typeof entityDocumentsResponseSchema>;

/** A document read is per session AND per record: which documents exist follows the reader. */
export function entityDocumentsQueryKey(
  tenantId: string,
  userId: string,
  entityType: string,
  entityId: string,
) {
  return ["entity-documents", tenantId, userId, entityType, entityId] as const;
}

export interface EntityDocumentsModel {
  response: EntityDocumentsResponse;
  /** True when this render came from the device cache because the network was unreachable. */
  offline: boolean;
}

/**
 * `POST /api/v1/document-generations` (owner only). The Worker answers with the effect outcome
 * and the durable receipt it wrote: `succeeded` 200, `unknown` 202 (the R2 write was not
 * acknowledged; a reconcile may still prove it), `not_executed` / `manual_exception` 409,
 * `failed` 502. Every one of those carries a receipt, so the client shows the receipt, not a
 * guess. `.passthrough()` keeps a widened server from breaking a shipped client.
 */
export const DOCUMENT_GENERATIONS_ROUTE = "/api/v1/document-generations";

export const documentGenerationOutcomes = [
  "succeeded",
  "failed",
  "unknown",
  "manual_exception",
  "not_executed",
] as const;

export const documentGenerationReceiptSchema = z
  .object({
    receipt_id: z.string().min(1),
    generation_attempt_id: z.string().min(1),
    receipt_version: z.number().int().positive(),
    template_id: z.string().min(1),
    template_version: z.number().int().positive(),
    provider: z.string().min(1),
    provider_document_id: z.string().nullable(),
    output_digest: z.string().min(1),
    readback_status: z.string().nullable(),
    terminal_status: z.string().nullable(),
    reconciliation_outcome: z.string().nullable(),
  })
  .passthrough();

export const documentGenerationResponseSchema = z
  .object({
    outcome: z.enum(documentGenerationOutcomes),
    generation: documentGenerationReceiptSchema,
    attachment: z.unknown().nullable(),
  })
  .passthrough();

export type DocumentGenerationOutcome = (typeof documentGenerationOutcomes)[number];
export type DocumentGenerationResponse = z.infer<typeof documentGenerationResponseSchema>;
