import { z } from "zod";

/**
 * The record-level read contract of the governed schema-field boundary (IRO-242,
 * `workers-bus/src/schema-forms-api.ts`). The administration routes under
 * `/api/v1/admin/schema-fields` are the owner's configuration surface and already have a client in
 * `app/src/admin`; this is the other half — what the people who do the work actually see on a card.
 *
 * The server decides membership, not this file. `listAuthorizedSchemaFieldValues` omits a field the
 * caller's role may not read and omits a field whose configured visibility rule does not hold, so
 * an absent field here is an authority decision that already happened, never a rendering choice.
 */

const nullableText = z.string().min(1).nullable();

/**
 * Mirrors `recordFieldView`. Deliberately narrower than the administration `schemaFieldSchema`:
 * the record view publishes no `read_roles` / `write_roles` / scopes, because the server has
 * already applied them. `.passthrough()` keeps a server that grows the view from breaking a client
 * that has not shipped yet.
 */
export const schemaCardFieldDefinitionSchema = z
  .object({
    field_id: z.string().min(1),
    field_key: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    label: z.string().min(1),
    position: z.number().int().nonnegative(),
    field_type: z.string().min(1),
    validator_key: z.string().min(1),
    validator_config: z.record(z.string(), z.unknown()),
    visibility_key: z.string().min(1),
    visibility_config: z.record(z.string(), z.unknown()),
    evidence_class: z.string().min(1),
    retention_policy: z.string().min(1),
    offline_mode: z.string().min(1),
  })
  .passthrough();

/** Mirrors `recordValueView`. `value` is the closed-vocabulary payload, shaped by `field_type`. */
export const schemaCardValueSchema = z
  .object({
    value_revision_id: z.string().min(1),
    field_definition_revision_id: z.string().min(1),
    version: z.number().int().positive(),
    prior_value_revision_id: nullableText,
    based_on_value_revision_id: nullableText,
    correction_reason: nullableText,
    value: z.unknown(),
    value_digest: z.string().min(1),
    provenance_actor_type: z.string().min(1),
    created_at: z.string().min(1),
  })
  .passthrough();

export const schemaCardEntrySchema = z
  .object({
    definition: schemaCardFieldDefinitionSchema,
    value: schemaCardValueSchema.nullable(),
  })
  .passthrough();

export const schemaCardResponseSchema = z
  .object({
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
    fields: z.array(schemaCardEntrySchema),
  })
  .passthrough();

export type SchemaCardFieldDefinition = z.infer<typeof schemaCardFieldDefinitionSchema>;
export type SchemaCardValue = z.infer<typeof schemaCardValueSchema>;
export type SchemaCardEntry = z.infer<typeof schemaCardEntrySchema>;
export type SchemaCardResponse = z.infer<typeof schemaCardResponseSchema>;

/**
 * The entity types the server's registry binds schema fields to
 * (`ENTITY_REGISTRY` in `workers-bus/src/pipeline-board-store.ts`, gated again by
 * `roleCanReadField`). A module that registers a new entity type reaches the card through the
 * server catalog, so this stays a type alias over the wire value rather than a closed client enum.
 */
export type SchemaCardEntityType = "job" | "lead";

/** A card read is per session AND per record: authority is derived from the caller. */
export function schemaCardQueryKey(
  tenantId: string,
  userId: string,
  entityType: string,
  entityId: string,
) {
  return ["schema-card", tenantId, userId, entityType, entityId] as const;
}

export interface SchemaCardModel {
  response: SchemaCardResponse;
  /** True when this render came from the device cache because the network was unreachable. */
  offline: boolean;
}
