import { z } from "zod";

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

export const automationCatalogSchema = z
  .object({
    actions: z.array(z.object({ action: z.string().min(1), label: z.string().min(1) })),
    templates: z.array(
      z.object({
        template_key: z.string().min(1),
        version: z.literal(1),
        label: z.string().min(1),
      }),
    ),
    recipient_refs: z.array(z.string().min(1)),
    recipient_configured: z.boolean(),
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
    template_version: z.literal(1),
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

export type AdminPipelineStage = z.infer<typeof adminPipelineStageSchema>;
export type PipelineRoleGrant = z.infer<typeof pipelineRoleGrantSchema>;
export type AdminPipeline = z.infer<typeof adminPipelineSchema>;
export type AdminPipelineListResponse = z.infer<typeof adminPipelineListResponseSchema>;
export type AutomationCatalog = z.infer<typeof automationCatalogSchema>;
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export type AutomationListResponse = z.infer<typeof automationListResponseSchema>;
export type AutomationHistoryResponse = z.infer<typeof automationHistoryResponseSchema>;
export type SchemaField = z.infer<typeof schemaFieldSchema>;
export type SchemaFieldCatalog = z.infer<typeof schemaFieldCatalogSchema>;
export type SchemaFieldListResponse = z.infer<typeof schemaFieldListResponseSchema>;
export type SchemaFieldHistoryResponse = z.infer<typeof schemaFieldHistoryResponseSchema>;

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

export interface AutomationWriteInput {
  to_stage_id: string;
  action: string;
  recipient_ref: string;
  template_key: string;
  template_version: 1;
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
