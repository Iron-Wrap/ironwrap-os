import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  adminPipelineListResponseSchema,
  adminPipelineMutationResponseSchema,
  adminPipelineOrderResponseSchema,
  adminPipelineStageMutationResponseSchema,
  automationActivityResponseSchema,
  automationHistoryResponseSchema,
  automationListResponseSchema,
  automationMutationResponseSchema,
  documentTemplateHistoryResponseSchema,
  documentTemplateListResponseSchema,
  documentTemplateMutationResponseSchema,
  schemaFieldHistoryResponseSchema,
  schemaFieldListResponseSchema,
  schemaFieldMutationResponseSchema,
  type AdminDocumentTemplate,
  type AdminPipelineListResponse,
  type AutomationActivityResponse,
  type AutomationHistoryResponse,
  type AutomationListResponse,
  type AutomationWriteInput,
  type DocumentTemplateHistoryResponse,
  type DocumentTemplateListResponse,
  type DocumentTemplateWriteInput,
  type PipelineCreateInput,
  type PipelineRoleGrant,
  type PipelineStageInput,
  type SchemaFieldListResponse,
  type SchemaFieldWriteInput,
} from "./configuration-contracts";

export const DEFAULT_CARD_TEMPLATE = {
  version: 1,
  slots: [{ slot: "title", sources: ["entity.contact_name", "entity.contact_email"] }],
} as const;

export function newConfigurationActionKey(scope: string): string {
  return `configuration:${scope}:${crypto.randomUUID()}`;
}

export async function loadAdminPipelines(
  fetcher: typeof fetch = fetch,
): Promise<AdminPipelineListResponse> {
  return await apiRequest({
    path: API_PATHS.adminPipelines,
    schema: adminPipelineListResponseSchema,
    fetcher,
  });
}

export async function createAdminPipeline(
  session: AuthenticatedSession,
  input: PipelineCreateInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelines,
    method: "POST",
    body: { ...input, card_template: input.card_template ?? DEFAULT_CARD_TEMPLATE },
    schema: adminPipelineMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("pipeline-create"),
    fetcher,
  });
}

export async function updateAdminPipeline(
  session: AuthenticatedSession,
  pipelineId: string,
  expectedVersion: number,
  input: { name?: string; owning_role?: string | null; is_active?: boolean },
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipeline(pipelineId),
    method: "POST",
    body: { ...input, expected_version: expectedVersion },
    schema: adminPipelineMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("pipeline-update"),
    fetcher,
  });
}

export async function copyAdminPipeline(
  session: AuthenticatedSession,
  pipelineId: string,
  input: { key: string; name: string; owning_role?: string | null; copy_role_grants?: boolean },
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineCopy(pipelineId),
    method: "POST",
    body: input,
    schema: adminPipelineMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("pipeline-copy"),
    fetcher,
  });
}

export async function reorderAdminPipelines(
  session: AuthenticatedSession,
  pipelines: Array<{ pipeline_id: string; expected_version: number }>,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineOrder,
    method: "POST",
    body: { pipelines },
    schema: adminPipelineOrderResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("pipeline-order"),
    fetcher,
  });
}

export async function updateAdminPipelineRoles(
  session: AuthenticatedSession,
  pipelineId: string,
  expectedVersion: number,
  grants: PipelineRoleGrant[],
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineRoles(pipelineId),
    method: "POST",
    body: { expected_version: expectedVersion, grants },
    schema: adminPipelineMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("pipeline-roles"),
    fetcher,
  });
}

export async function addAdminPipelineStage(
  session: AuthenticatedSession,
  pipelineId: string,
  expectedVersion: number,
  stage: PipelineStageInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineStages(pipelineId),
    method: "POST",
    body: { ...stage, expected_version: expectedVersion },
    schema: adminPipelineStageMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("stage-add"),
    fetcher,
  });
}

export async function updateAdminPipelineStage(
  session: AuthenticatedSession,
  pipelineId: string,
  stageId: string,
  expectedVersion: number,
  stage: Omit<PipelineStageInput, "key"> & {
    is_won?: boolean;
    is_lost?: boolean;
    is_active?: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineStage(pipelineId, stageId),
    method: "POST",
    body: { ...stage, expected_version: expectedVersion },
    schema: adminPipelineStageMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("stage-update"),
    fetcher,
  });
}

export async function reorderAdminPipelineStages(
  session: AuthenticatedSession,
  pipelineId: string,
  expectedVersion: number,
  stageIds: string[],
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineStageOrder(pipelineId),
    method: "POST",
    body: { expected_version: expectedVersion, stage_ids: stageIds },
    schema: adminPipelineStageMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("stage-order"),
    fetcher,
  });
}

export async function removeAdminPipelineStage(
  session: AuthenticatedSession,
  pipelineId: string,
  stageId: string,
  expectedVersion: number,
  moveCardsToStageId?: string,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineStageRemove(pipelineId, stageId),
    method: "POST",
    body: {
      expected_version: expectedVersion,
      ...(moveCardsToStageId ? { move_cards_to_stage_id: moveCardsToStageId } : {}),
    },
    schema: adminPipelineStageMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("stage-remove"),
    fetcher,
  });
}

export async function loadSchemaFields(
  entityType = "",
  fetcher: typeof fetch = fetch,
): Promise<SchemaFieldListResponse> {
  const path = entityType
    ? `${API_PATHS.adminSchemaFields}?entity_type=${encodeURIComponent(entityType)}`
    : API_PATHS.adminSchemaFields;
  return await apiRequest({ path, schema: schemaFieldListResponseSchema, fetcher });
}

export async function createSchemaField(
  session: AuthenticatedSession,
  input: SchemaFieldWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminSchemaFields,
    method: "POST",
    body: { ...input, action: "create" },
    schema: schemaFieldMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("field-create"),
    fetcher,
  });
}

export async function reviseSchemaField(
  session: AuthenticatedSession,
  fieldId: string,
  input: SchemaFieldWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminSchemaField(fieldId),
    method: "POST",
    body: input,
    schema: schemaFieldMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("field-revise"),
    fetcher,
  });
}

export async function loadSchemaFieldHistory(fieldId: string, fetcher: typeof fetch = fetch) {
  return await apiRequest({
    path: API_PATHS.adminSchemaFieldRevisions(fieldId),
    schema: schemaFieldHistoryResponseSchema,
    fetcher,
  });
}

export async function loadAutomationRules(
  pipelineId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomationListResponse> {
  return await apiRequest({
    path: API_PATHS.adminPipelineAutomationRules(pipelineId),
    schema: automationListResponseSchema,
    fetcher,
  });
}

export async function createAutomationRule(
  session: AuthenticatedSession,
  pipelineId: string,
  input: AutomationWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineAutomationRules(pipelineId),
    method: "POST",
    body: input,
    schema: automationMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("automation-create"),
    fetcher,
  });
}

export async function reviseAutomationRule(
  session: AuthenticatedSession,
  pipelineId: string,
  ruleId: string,
  input: AutomationWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminPipelineAutomationRuleRevisions(pipelineId, ruleId),
    method: "POST",
    body: input,
    schema: automationMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("automation-revise"),
    fetcher,
  });
}

export async function loadAutomationHistory(
  pipelineId: string,
  ruleId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomationHistoryResponse> {
  return await apiRequest({
    path: API_PATHS.adminPipelineAutomationRuleRevisions(pipelineId, ruleId),
    schema: automationHistoryResponseSchema,
    fetcher,
  });
}

/**
 * Document-template authoring. The server owns identity: `create` mints a `template_id` from the
 * tenant, entity type and human key, and every later command addresses that identifier. A revise
 * and a retire are the same append-only write with a different `action`, so retiring keeps the
 * whole revision chain rather than deleting anything.
 */
export async function loadDocumentTemplates(
  entityType = "",
  fetcher: typeof fetch = fetch,
): Promise<DocumentTemplateListResponse> {
  const path = entityType
    ? `${API_PATHS.adminDocumentTemplates}?entity_type=${encodeURIComponent(entityType)}`
    : API_PATHS.adminDocumentTemplates;
  return await apiRequest({ path, schema: documentTemplateListResponseSchema, fetcher });
}

export async function createDocumentTemplate(
  session: AuthenticatedSession,
  input: DocumentTemplateWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminDocumentTemplates,
    method: "POST",
    body: { ...input, action: "create", active: true },
    schema: documentTemplateMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("document-template-create"),
    fetcher,
  });
}

export async function reviseDocumentTemplate(
  session: AuthenticatedSession,
  templateId: string,
  input: DocumentTemplateWriteInput,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminDocumentTemplate(templateId),
    method: "POST",
    body: { ...input, action: "revise", active: true },
    schema: documentTemplateMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("document-template-revise"),
    fetcher,
  });
}

/**
 * Retiring re-sends the stored layout with `active: false`. The server refuses a retire that
 * carries `active: true`, and it refuses one that lowers the retention policy, so the current
 * revision is echoed back verbatim rather than reconstructed from form state.
 */
export async function retireDocumentTemplate(
  session: AuthenticatedSession,
  template: AdminDocumentTemplate,
  fetcher: typeof fetch = fetch,
) {
  return await apiRequest({
    path: API_PATHS.adminDocumentTemplate(template.template_id),
    method: "POST",
    body: {
      entity_type: template.entity_type,
      template_key: template.template_key,
      label: template.label,
      blocks: template.blocks,
      retention_policy: template.retention_policy,
      action: "retire",
      active: false,
      expected_version: template.version,
    },
    schema: documentTemplateMutationResponseSchema,
    csrfToken: session.csrf_token,
    idempotencyKey: newConfigurationActionKey("document-template-retire"),
    fetcher,
  });
}

export async function loadDocumentTemplateHistory(
  templateId: string,
  fetcher: typeof fetch = fetch,
): Promise<DocumentTemplateHistoryResponse> {
  return await apiRequest({
    path: API_PATHS.adminDocumentTemplateRevisions(templateId),
    schema: documentTemplateHistoryResponseSchema,
    fetcher,
  });
}

/**
 * What a rule actually did when it fired, as opposed to how it was configured.
 *
 * SERVER HALF NOT YET IMPLEMENTED (ELEC-203 handoff to `ironwrap-engineer`). The states are
 * already tracked in `pipeline_stage_automation_invocations`; nothing publishes them yet. The
 * caller treats a 404 as "this deployment does not serve dispatch outcomes yet" and says so
 * plainly, rather than reporting a rule as healthy on the strength of a missing route.
 */
export async function loadAutomationActivity(
  pipelineId: string,
  ruleId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomationActivityResponse> {
  return await apiRequest({
    path: API_PATHS.adminPipelineAutomationRuleActivity(pipelineId, ruleId),
    schema: automationActivityResponseSchema,
    fetcher,
  });
}

export function configurationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "That did not go through. Check the connection and try again.";
  if (error.status === 403 || error.code.endsWith("_forbidden"))
    return "Only the account owner can change this configuration.";
  if (error.status === 409 || error.code.includes("conflict") || error.code.includes("stale"))
    return "This configuration changed in another session. Reload the latest version before saving.";
  if (error.code === "automation_recipient_config_unavailable")
    return "The configured email recipient service is unavailable. No automation was changed.";
  if (error.code === "automation_recipient_config_malformed")
    return "The configured email recipients could not be read safely. No automation was changed.";
  if (error.code === "automation_recipient_ref_unknown")
    return "That recipient reference is no longer configured. Refresh and choose an available reference.";
  if (error.code === "automation_recipient_ref_invalid")
    return "Choose a recipient reference from the server-provided list.";
  if (error.code === "automation_pipeline_or_stage_inactive")
    return "That pipeline or stage is inactive. Refresh before changing this rule.";
  if (error.code === "pipeline_stage_has_cards")
    return "This stage still has cards. Choose a destination to move them before removing it.";
  if (error.code === "pipeline_stage_last_remaining")
    return "A pipeline must keep at least one active stage.";
  if (error.code === "pipeline_stage_destination_invalid")
    return "Choose another active stage as the destination.";
  if (error.code === "pipeline_key_exists") return "That pipeline key is already in use.";
  if (error.code === "schema_field_type_immutable")
    return "A field type cannot change after creation. Create a new field instead.";
  if (error.code === "schema_field_retired") return "This field is already retired.";
  if (error.code === "schema_field_required") return "Complete the required field settings.";
  if (error.code === "schema_field_entity_type_invalid")
    return "Use a supported entity type such as lead or job.";
  if (error.code === "schema_field_validator_config_invalid")
    return "Enter a valid validator configuration.";
  if (error.code === "schema_field_visibility_config_invalid")
    return "Enter a valid visibility configuration.";
  if (error.code === "document_template_binding_required")
    return "A document needs at least one field block, so it can be filled from the record.";
  if (error.code === "document_template_binding_invalid")
    return "One of the chosen fields is not an active field of this record type. Refresh the field list and choose again.";
  if (error.code === "document_template_field_binding_duplicate")
    return "The same field is used twice. Each field can appear once in a document.";
  if (error.code === "document_template_block_markup_invalid")
    return "Remove the angle brackets from the text. Documents hold plain text, not markup.";
  if (error.code === "document_template_block_text_invalid")
    return "Every heading and paragraph needs text.";
  if (error.code === "document_template_blocks_invalid")
    return "Add at least one block before saving this document.";
  if (error.code === "document_template_key_invalid")
    return "Use a short key of letters, numbers, dots, dashes, colons, or underscores.";
  if (error.code === "document_template_label_invalid") return "Give this document a name.";
  if (error.code === "document_template_entity_type_invalid")
    return "Use a supported record type such as lead or job.";
  if (error.code === "document_template_retention_hold")
    return "Retention cannot be reduced once set. Keep the current policy or choose a longer one.";
  if (error.code === "document_template_retired")
    return "This document is retired. Its history stays readable, but it cannot be revised.";
  if (error.code === "document_template_not_found")
    return "That document no longer exists. Refresh the list.";
  if (error.code === "document_template_key_exists")
    return "That document key is already in use for this record type.";
  if (error.code === "csrf_failed") return "Your session moved on. Reload and try again.";
  if (error.code === "invalid_response")
    return "The server returned an invalid configuration response.";
  return "That did not go through. Check the connection and try again.";
}
