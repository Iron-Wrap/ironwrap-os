import type { AuthenticatedSession } from "../auth/session";
import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  adminPipelineListResponseSchema,
  adminPipelineMutationResponseSchema,
  adminPipelineOrderResponseSchema,
  adminPipelineStageMutationResponseSchema,
  automationHistoryResponseSchema,
  automationListResponseSchema,
  automationMutationResponseSchema,
  schemaFieldHistoryResponseSchema,
  schemaFieldListResponseSchema,
  schemaFieldMutationResponseSchema,
  type AdminPipelineListResponse,
  type AutomationHistoryResponse,
  type AutomationListResponse,
  type AutomationWriteInput,
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
  if (error.code === "csrf_failed") return "Your session moved on. Reload and try again.";
  if (error.code === "invalid_response")
    return "The server returned an invalid configuration response.";
  return "That did not go through. Check the connection and try again.";
}
