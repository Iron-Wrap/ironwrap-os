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
 *
 * The derived `writable` answer lives on the entry, not here — see `schemaCardEntrySchema`.
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

/**
 * `writable` is the one derived answer the record view publishes (ELEC-192, #202): "may THIS
 * caller write THIS field", computed server-side by the same `valueWriteRefusal` the write route
 * raises, so the flag a card renders and the answer a write gets cannot drift. It is the answer,
 * never the inputs — the role lists it derives from stay withheld from non-admin reads.
 *
 * Optional so a card cached by a client older than #202 still parses; `schemaCardFieldWritable`
 * reads an absent flag as "not writable".
 */
export const schemaCardEntrySchema = z
  .object({
    writable: z.boolean().optional(),
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

/**
 * Whether this caller may write this field, as the server derived it.
 *
 * An accessor rather than a plain property read for one reason: absent means NOT writable. A card
 * cached by an older client and a field the caller genuinely may not write are indistinguishable
 * from here, and the only safe reading of both is "do not offer an edit". Failing closed keeps the
 * card exactly as read-only as it shipped in #200 whenever the flag is missing, which is also what
 * kept this client landable before the server half existed.
 *
 * #202 settled the position: the flag sits on the entry, beside `definition` and `value`, derived
 * from the same `valueWriteRefusal` the write route raises. So this reads the entry and nothing
 * else — a `writable` that turned up on the definition would be a different server's idea of the
 * contract, and honouring it would be guessing.
 */
export function schemaCardFieldWritable(entry: SchemaCardEntry): boolean {
  return (entry as SchemaCardEntry & { writable?: unknown }).writable === true;
}

/**
 * One record-value write, as `POST /api/v1/schema-fields/{entityType}/{entityId}/{fieldId}/values`
 * takes it (`workers-bus/src/schema-forms-api.ts:409`, `fieldValueInput` at `:511`).
 *
 * The third path segment is the field ID, not the field key — `recordSchemaFieldValue` requires at
 * least 12 characters there and matches it against `schema_field_definition_heads.field_id`.
 */
export interface SchemaCardWriteCommand {
  entityType: string;
  entityId: string;
  fieldId: string;
  /** Pinning the revision is what makes the server refuse a write against a redefined field. */
  fieldDefinitionRevisionId: string;
  /** Optimistic concurrency: the version this write believes it is following. */
  expectedVersion: number;
  value: unknown;
  /** Set together, or not at all — the server refuses one without the other. */
  basedOnValueRevisionId?: string | null;
  correctionReason?: string | null;
}

/** The write route's answer. `replayed` is an idempotent re-send, not a second value. */
export const schemaCardWriteResponseSchema = z
  .object({
    outcome: z.enum(["created", "replayed"]),
    value: schemaCardValueSchema,
  })
  .passthrough();

export type SchemaCardWriteResponse = z.infer<typeof schemaCardWriteResponseSchema>;

/**
 * The request body, built in exactly one place so a value written online and the same value
 * replayed from the offline queue are the same command. The server fingerprints the command for
 * idempotency, so two builders that drift would turn one retry into an unexplained refusal.
 */
export function schemaCardWriteBody(command: SchemaCardWriteCommand): Record<string, unknown> {
  return {
    field_definition_revision_id: command.fieldDefinitionRevisionId,
    expected_version: command.expectedVersion,
    value: command.value ?? null,
    based_on_value_revision_id: command.basedOnValueRevisionId ?? null,
    correction_reason: command.correctionReason ?? null,
  };
}

/** The write route's path for one field on one record. */
export function schemaCardValuePath(entityType: string, entityId: string, fieldId: string): string {
  return `${schemaCardPath(entityType, entityId)}/${encodeURIComponent(fieldId)}/values`;
}

/**
 * The record read's path. Declared here beside the write path so the two can never disagree about
 * how a scope is encoded; `schema-card-api.ts` re-exports it as the module's public read entry.
 */
export function schemaCardPath(entityType: string, entityId: string): string {
  return `/api/v1/schema-fields/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
}
