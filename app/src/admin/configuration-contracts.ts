import { z } from "zod";

import { documentBlockSchema, type DocumentBlock } from "../documents/document-contracts";

const nullableText = z.string().min(1).nullable();

export const adminPipelineStageSchema = z
  .object({
    stage_id: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    color: nullableText,
    position: z.number().int().nonnegative(),
    is_won: z.boolean(),
    is_lost: z.boolean(),
    min_role_to_enter: nullableText,
    is_active: z.boolean(),
    card_count: z.number().int().nonnegative(),
    updated_at: z.string().min(1),
  })
  .passthrough();

export const pipelineRoleGrantSchema = z
  .object({ role: z.string().min(1), can_write: z.boolean() })
  .passthrough();

export const adminPipelineSchema = z
  .object({
    pipeline_id: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    entity_type: z.string().min(1),
    owning_role: nullableText,
    is_active: z.boolean(),
    is_template: z.boolean(),
    template_source_id: nullableText,
    position: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    card_count: z.number().int().nonnegative(),
    card_template: z.unknown(),
    stages: z.array(adminPipelineStageSchema),
    role_grants: z.array(pipelineRoleGrantSchema),
    updated_at: z.string().min(1),
  })
  .passthrough();

export const adminPipelineListResponseSchema = z
  .object({
    version: z.literal(1),
    entity_types: z.array(z.object({ entity_type: z.string().min(1), label: z.string().min(1) })),
    roles: z.array(z.string().min(1)),
    stage_limit: z.number().int().positive(),
    pipelines: z.array(adminPipelineSchema),
  })
  .passthrough();

export const adminPipelineMutationResponseSchema = z
  .object({ pipeline: adminPipelineSchema })
  .passthrough();

export const adminPipelineOrderResponseSchema = z
  .object({ pipelines: z.array(adminPipelineSchema) })
  .passthrough();

export const adminPipelineStageMutationResponseSchema = z
  .object({
    pipeline: adminPipelineSchema,
    stage: adminPipelineStageSchema.optional(),
    stages: z.array(adminPipelineStageSchema).optional(),
    outcome: z.string().optional(),
    moved_cards: z.number().int().nonnegative().optional(),
  })
  .passthrough();

// The catalog carries whatever the server registry holds: a built-in template pinned at version 1,
// and administrator-authored document templates whose version advances every time one is revised.
// Pinning a version here would make the picker reject a revised template, so the client accepts any
// version the server publishes and echoes back exactly the pair it was offered.
export const automationCatalogSchema = z
  .object({
    actions: z.array(
      z.object({
        action: z.string().min(1),
        label: z.string().min(1),
        // Which kind of template the action consumes. The server has published it since the
        // document action was registered; it stays optional so an older deployment still parses.
        template_source: z.string().min(1).optional(),
      }),
    ),
    templates: z.array(
      z.object({
        // Named `template_key` by the wire contract, but for a document action this carries the
        // template's IDENTIFIER, not its human key. `automationTemplateOptions` is the only place
        // that reads it, and it never presents the value to an administrator as a key.
        template_key: z.string().min(1),
        version: z.number().int().positive(),
        label: z.string().min(1),
        /** The action this entry may be paired with. Absent on a deployment that predates it. */
        action: z.string().min(1).optional(),
      }),
    ),
    recipient_refs: z.array(z.string().min(1)),
    /**
     * The name an owner gave each reference, published beside the refs themselves. A picker that
     * shows only `shop` makes an administrator remember what they wired it to; showing "The shop"
     * is the whole reason the catalog carries a label. Optional so a deployment that predates the
     * tenant-administered catalog still parses — the client falls back to the raw reference.
     */
    recipient_labels: z
      .array(z.object({ recipient_ref: z.string().min(1), label: z.string().min(1) }))
      .optional(),
    /**
     * Where this tenant's recipients come from. `tenant` means the account administers its own
     * catalog and "add a recipient" is a screen. `deployment` means it is still inheriting the
     * legacy `PIPELINE_AUTOMATION_RECIPIENTS_JSON` blob, and the FIRST record written here takes
     * that list over — which the recipient screen has to say out loud before it happens.
     */
    recipient_source: z.enum(["tenant", "deployment", "none"]).optional(),
    recipient_configured: z.boolean(),
    document_generation_configured: z.boolean().optional(),
    // True when this deployment publishes what a rule DID when it fired, not only how it is
    // configured. Absent means the outcome route is not served here, and the client shows no
    // firing surface at all rather than an empty one that reads as "nothing has gone wrong".
    activity_available: z.boolean().optional(),
  })
  .passthrough();

export const automationRuleSchema = z
  .object({
    rule_id: z.string().min(1),
    tenant_id: z.string().min(1),
    pipeline_id: z.string().min(1),
    to_stage_id: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    prior_revision_id: nullableText,
    action: z.string().min(1),
    recipient_ref: z.string().min(1),
    template_key: z.string().min(1),
    template_version: z.number().int().positive(),
    active: z.number().int().min(0).max(1),
    actor_role: z.string().min(1),
    actor_id: z.string().min(1),
    created_at: z.string().min(1),
  })
  .passthrough();

export const automationListResponseSchema = z
  .object({
    version: z.literal(1),
    pipeline_id: z.string().min(1),
    rules: z.array(automationRuleSchema),
    catalog: automationCatalogSchema,
  })
  .passthrough();

export const automationMutationResponseSchema = z
  .object({ rule: automationRuleSchema, catalog: automationCatalogSchema })
  .passthrough();

export const automationHistoryResponseSchema = z
  .object({
    version: z.literal(1),
    pipeline_id: z.string().min(1),
    rule_id: z.string().min(1),
    current_revision_id: nullableText,
    current_version: z.number().int().positive().nullable(),
    revisions: z.array(automationRuleSchema),
  })
  .passthrough();

/**
 * Automation recipients — the administrator's authoring contract for
 * `/api/v1/admin/automation-recipients` (`workers-bus/src/automation-recipients-api.ts`).
 *
 * The destination is deliberately absent from every read. The server keeps the address in
 * `automation_recipient_revisions` and publishes only a masked form and a digest, so an owner can
 * recognise the inbox they configured and a stolen owner session still cannot harvest it. Nothing
 * in this client may treat `destination_masked` as an address: it is display text, never a value
 * to echo back on a save.
 */
export const automationRecipientSchema = z
  .object({
    recipient_id: z.string().min(1),
    recipient_ref: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    prior_revision_id: nullableText,
    action: z.enum(["create", "revise", "retire"]),
    label: z.string().min(1),
    channel: z.string().min(1),
    destination_masked: z.string().min(1),
    destination_digest: z.string().min(1),
    active: z.boolean(),
    actor: z.object({ role: z.string().min(1), id: z.string().min(1) }),
    command_fingerprint: z.string().min(1),
    created_at: z.string().min(1),
  })
  .passthrough();

export const automationRecipientListResponseSchema = z
  .object({
    version: z.literal(1),
    catalog: z.object({ channels: z.array(z.string().min(1)) }).passthrough(),
    recipients: z.array(automationRecipientSchema),
  })
  .passthrough();

export const automationRecipientMutationResponseSchema = z
  .object({ outcome: z.string().min(1), recipient: automationRecipientSchema })
  .passthrough();

/**
 * A single recipient plus what a retirement would strand. `referenced_by` is the server's own
 * answer to "which live rules still send here", published on the read so the screen can warn
 * BEFORE an administrator commits to a command the server would refuse.
 */
export const automationRecipientDetailResponseSchema = z
  .object({
    recipient: automationRecipientSchema,
    referenced_by: z.array(
      z
        .object({
          rule_id: z.string().min(1),
          pipeline_id: z.string().min(1),
          to_stage_id: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const automationRecipientHistoryResponseSchema = z
  .object({
    recipient_id: z.string().min(1),
    current_revision_id: z.string().min(1),
    current_version: z.number().int().positive(),
    revisions: z.array(automationRecipientSchema),
  })
  .passthrough();

export const schemaFieldSchema = z
  .object({
    field_id: z.string().min(1),
    entity_type: z.string().min(1),
    field_key: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    prior_revision_id: nullableText,
    action: z.enum(["create", "revise", "relabel", "reorder", "retire"]),
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
    read_scope: z.string().min(1),
    write_scope: z.string().min(1),
    read_roles: z.array(z.string().min(1)),
    write_roles: z.array(z.string().min(1)),
    active: z.boolean(),
    actor: z.object({
      type: z.string().min(1),
      role: z.string().min(1),
      id: z.string().min(1),
      authority_ref: z.string().min(1),
    }),
    command_fingerprint: z.string().min(1),
    effective_at: z.string().min(1),
    created_at: z.string().min(1),
  })
  .passthrough();

export const schemaFieldCatalogSchema = z
  .object({
    roles: z.array(z.string().min(1)),
    field_types: z.array(z.string().min(1)),
    validators: z.array(z.string().min(1)),
    visibility_rules: z.array(z.string().min(1)),
    evidence_classes: z.array(z.string().min(1)),
    retention_policies: z.array(z.string().min(1)),
    offline_modes: z.array(z.string().min(1)),
    scopes: z.array(z.string().min(1)),
  })
  .passthrough();

export const schemaFieldListResponseSchema = z
  .object({
    version: z.literal(1),
    catalog: schemaFieldCatalogSchema,
    fields: z.array(schemaFieldSchema),
  })
  .passthrough();

export const schemaFieldMutationResponseSchema = z
  .object({ outcome: z.string().min(1), field: schemaFieldSchema })
  .passthrough();

export const schemaFieldHistoryResponseSchema = z
  .object({
    field_id: z.string().min(1),
    current_revision_id: z.string().min(1),
    current_version: z.number().int().positive(),
    revisions: z.array(schemaFieldSchema),
  })
  .passthrough();

/**
 * Document templates — the administrator's authoring contract for
 * `/api/v1/admin/document-templates` (`workers-bus/src/schema-forms-api.ts`).
 *
 * A block is the SAME shape the job-card reading surface already renders, so it is imported from
 * `documents/document-contracts` rather than declared a second time: one model, authored here and
 * read there, cannot drift apart.
 *
 * Two identifiers travel on every row and they are not interchangeable. `template_id` is what the
 * server addresses a template by — and what an automation rule stores in its `template_key` column.
 * `template_key` here is the human key an administrator types. Nothing in this client may present
 * one where the other is meant.
 */
export const adminDocumentTemplateSchema = z
  .object({
    template_id: z.string().min(1),
    revision_id: z.string().min(1),
    version: z.number().int().positive(),
    prior_revision_id: nullableText,
    action: z.enum(["create", "revise", "retire"]),
    entity_type: z.string().min(1),
    template_key: z.string().min(1),
    label: z.string().min(1),
    blocks: z.array(documentBlockSchema),
    retention_policy: z.string().min(1),
    active: z.boolean(),
    actor: z.object({
      type: z.string().min(1),
      role: z.string().min(1),
      id: z.string().min(1),
      authority_ref: z.string().min(1),
    }),
    command_fingerprint: z.string().min(1),
    effective_at: z.string().min(1),
    created_at: z.string().min(1),
  })
  .passthrough();

export const documentTemplateCatalogSchema = z
  .object({
    actions: z.array(z.string().min(1)),
    block_kinds: z.array(z.string().min(1)),
    retention_policies: z.array(z.string().min(1)),
  })
  .passthrough();

export const documentTemplateListResponseSchema = z
  .object({
    version: z.literal(1),
    catalog: documentTemplateCatalogSchema,
    templates: z.array(adminDocumentTemplateSchema),
  })
  .passthrough();

export const documentTemplateMutationResponseSchema = z
  .object({ outcome: z.string().min(1), template: adminDocumentTemplateSchema })
  .passthrough();

export const documentTemplateHistoryResponseSchema = z
  .object({
    template_id: z.string().min(1),
    current_revision_id: z.string().min(1),
    current_version: z.number().int().positive(),
    revisions: z.array(adminDocumentTemplateSchema),
  })
  .passthrough();

/**
 * Automation dispatch outcomes — what actually happened when a rule fired.
 *
 * `succeeded`, `failed` and `unknown` are three distinct terminal answers, not two. `unknown` is
 * the effect ledger refusing to claim a delivery it could not verify: the provider may well have
 * sent the message. Rendering it as either success or failure would be the client inventing an
 * answer the server deliberately declined to give, so this contract keeps it separate and
 * `automationOutcomeCopy` gives it its own sentence.
 */
export const automationDispatchStatuses = [
  "pending",
  "claimed",
  "retry",
  "succeeded",
  "failed",
  "unknown",
] as const;

export const automationDispatchSchema = z
  .object({
    invocation_id: z.string().min(1),
    outbox_id: z.string().min(1),
    transition_id: z.string().min(1),
    card_id: nullableText,
    to_stage_id: z.string().min(1),
    rule_version: z.number().int().positive(),
    action: z.string().min(1),
    status: z.enum(automationDispatchStatuses),
    attempt_count: z.number().int().nonnegative(),
    result_code: nullableText,
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    completed_at: nullableText,
  })
  .passthrough();

/**
 * `limit` and `truncated` are how the server refuses to let a WINDOW be mistaken for the whole
 * record: it publishes the cap it applied and whether it clipped anything, rather than leaving a
 * client to infer "there is more" from a conveniently full page. Both are optional here only so a
 * deployment that predates them still parses; when they are absent the client says nothing about
 * completeness rather than guessing it.
 */
export const automationActivityResponseSchema = z
  .object({
    version: z.literal(1),
    pipeline_id: z.string().min(1),
    rule_id: z.string().min(1),
    limit: z.number().int().positive().optional(),
    truncated: z.boolean().optional(),
    activity: z.array(automationDispatchSchema),
  })
  .passthrough();

export type AdminPipelineStage = z.infer<typeof adminPipelineStageSchema>;
export type PipelineRoleGrant = z.infer<typeof pipelineRoleGrantSchema>;
export type AdminPipeline = z.infer<typeof adminPipelineSchema>;
export type AdminPipelineListResponse = z.infer<typeof adminPipelineListResponseSchema>;
export type AutomationCatalog = z.infer<typeof automationCatalogSchema>;
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export type AutomationListResponse = z.infer<typeof automationListResponseSchema>;
export type AutomationHistoryResponse = z.infer<typeof automationHistoryResponseSchema>;
export type AutomationRecipient = z.infer<typeof automationRecipientSchema>;
export type AutomationRecipientListResponse = z.infer<typeof automationRecipientListResponseSchema>;
export type AutomationRecipientDetailResponse = z.infer<
  typeof automationRecipientDetailResponseSchema
>;
export type AutomationRecipientHistoryResponse = z.infer<
  typeof automationRecipientHistoryResponseSchema
>;
export type SchemaField = z.infer<typeof schemaFieldSchema>;
export type SchemaFieldCatalog = z.infer<typeof schemaFieldCatalogSchema>;
export type SchemaFieldListResponse = z.infer<typeof schemaFieldListResponseSchema>;
export type SchemaFieldHistoryResponse = z.infer<typeof schemaFieldHistoryResponseSchema>;
export type AdminDocumentTemplate = z.infer<typeof adminDocumentTemplateSchema>;
export type DocumentTemplateCatalog = z.infer<typeof documentTemplateCatalogSchema>;
export type DocumentTemplateListResponse = z.infer<typeof documentTemplateListResponseSchema>;
export type DocumentTemplateHistoryResponse = z.infer<typeof documentTemplateHistoryResponseSchema>;
export type AutomationDispatch = z.infer<typeof automationDispatchSchema>;
export type AutomationDispatchStatus = AutomationDispatch["status"];
export type AutomationActivityResponse = z.infer<typeof automationActivityResponseSchema>;

export interface PipelineStageInput {
  key: string;
  name: string;
  color?: string | null;
  is_won?: boolean;
  is_lost?: boolean;
  min_role_to_enter?: string | null;
}

export interface PipelineCreateInput {
  key: string;
  name: string;
  entity_type: string;
  owning_role?: string | null;
  card_template: unknown;
  stages: PipelineStageInput[];
  role_grants?: PipelineRoleGrant[];
  is_template?: boolean;
}

export interface SchemaFieldWriteInput {
  entity_type: string;
  field_key: string;
  label: string;
  position: number;
  field_type: string;
  validator_key: string;
  validator_config: Record<string, unknown>;
  visibility_key: string;
  visibility_config: Record<string, unknown>;
  evidence_class: string;
  retention_policy: string;
  offline_mode: string;
  read_scope: string;
  write_scope: string;
  read_roles: string[];
  write_roles: string[];
  active?: boolean;
  action?: "create" | "revise" | "relabel" | "reorder" | "retire";
  expected_version?: number;
}

export interface DocumentTemplateWriteInput {
  entity_type: string;
  /** The human key. Stable for the life of the template; it is not the identifier a rule stores. */
  template_key: string;
  label: string;
  blocks: DocumentBlock[];
  retention_policy: string;
  active?: boolean;
  action?: "create" | "revise" | "retire";
  expected_version?: number;
}

/**
 * What a recipient write carries.
 *
 * `recipient_ref` travels on a create only: the server refuses to rename a reference, because a
 * rule is bound to `shop` and renaming the record would silently re-aim every rule that names it.
 * `destination` is optional on a revise — omitting it keeps the stored address, which is the only
 * way a re-label can work at all when the client is never told what that address is.
 */
export interface AutomationRecipientWriteInput {
  recipient_ref?: string;
  label?: string;
  channel?: string;
  destination?: string;
  expected_version?: number;
}

export interface AutomationWriteInput {
  to_stage_id: string;
  action: string;
  recipient_ref: string;
  template_key: string;
  /** Whatever version the catalog offered for the chosen template; the server re-checks the pair. */
  template_version: number;
  active: boolean;
  expected_version?: number;
}

export function adminPipelineQueryKey(tenantId: string) {
  return ["admin-pipelines", tenantId] as const;
}

export function schemaFieldsQueryKey(tenantId: string, entityType = "all") {
  return ["admin-schema-fields", tenantId, entityType] as const;
}

export function automationQueryKey(tenantId: string, pipelineId: string) {
  return ["admin-automation-rules", tenantId, pipelineId] as const;
}

export function automationHistoryQueryKey(
  tenantId: string,
  pipelineId: string,
  ruleId: string,
  version: number,
) {
  return ["admin-automation-history", tenantId, pipelineId, ruleId, version] as const;
}

export function schemaFieldHistoryQueryKey(tenantId: string, fieldId: string, version: number) {
  return ["admin-schema-field-history", tenantId, fieldId, version] as const;
}

export function documentTemplateQueryKey(tenantId: string, entityType = "all") {
  return ["admin-document-templates", tenantId, entityType] as const;
}

export function documentTemplateHistoryQueryKey(
  tenantId: string,
  templateId: string,
  version: number,
) {
  return ["admin-document-template-history", tenantId, templateId, version] as const;
}

export function automationActivityQueryKey(tenantId: string, pipelineId: string, ruleId: string) {
  return ["admin-automation-activity", tenantId, pipelineId, ruleId] as const;
}

export function automationRecipientQueryKey(tenantId: string) {
  return ["admin-automation-recipients", tenantId] as const;
}

/**
 * Keyed on the version as well as the id, because what a retirement would strand changes as rules
 * are repointed. A stale "no rule uses this" would turn a refused command into a surprise.
 */
export function automationRecipientDetailQueryKey(
  tenantId: string,
  recipientId: string,
  version: number,
) {
  return ["admin-automation-recipient-detail", tenantId, recipientId, version] as const;
}

export function automationRecipientHistoryQueryKey(
  tenantId: string,
  recipientId: string,
  version: number,
) {
  return ["admin-automation-recipient-history", tenantId, recipientId, version] as const;
}
