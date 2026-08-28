/** Authenticated schema-field and document-template HTTP boundary (IRO-242 checkpoint 3A). */
import { validAppCsrf } from "./app-auth.ts";
import {
  ROLE_PERMISSIONS,
  appUserIdentities,
  type AppEnv,
  type AuthContext,
} from "./app-types.ts";
import {
  createSchemaFieldDefinition,
  getSchemaFieldDefinition,
  listAuthorizedSchemaFieldValues,
  listSchemaFieldDefinitionRevisions,
  recordReadableByActor,
  listSchemaFieldDefinitions,
  listSchemaFieldValueRevisions,
  recordSchemaFieldValue,
  reviseSchemaFieldDefinition,
  SCHEMA_EVIDENCE_CLASSES,
  SCHEMA_FIELD_TYPES,
  SCHEMA_OFFLINE_MODES,
  SCHEMA_RETENTION_POLICIES,
  SCHEMA_SCOPES,
  SCHEMA_VALIDATORS,
  SCHEMA_VISIBILITY_RULES,
  SchemaFormsError,
  type RecordSchemaFieldValueInput,
  type SchemaFieldActor,
  type SchemaFieldDefinition,
  type SchemaFieldDefinitionInput,
  type SchemaFieldValue,
} from "./schema-forms.ts";
import {
  createDocumentTemplate,
  DOCUMENT_TEMPLATE_ACTIONS,
  DOCUMENT_TEMPLATE_BLOCK_KINDS,
  DocumentTemplatesError,
  getDocumentTemplate,
  listDocumentTemplateRevisions,
  listDocumentTemplates,
  reviseDocumentTemplate,
  getDocumentGenerationReceipt,
  type DocumentGenerationReceipt,
  type DocumentTemplateInput,
  type DocumentTemplateRevision,
} from "./document-templates.ts";
import {
  generateDocumentToR2,
  reconcileDocumentR2,
  type R2DocumentGenerationResult,
} from "./document-generation-r2.ts";
import { EffectRuntimeError } from "./effect-runtime.ts";
import { knownEntityType } from "./pipeline-board-store.ts";

const ADMIN_FIELDS = "/api/v1/admin/schema-fields";
const ADMIN_TEMPLATES = "/api/v1/admin/document-templates";
const RECORD_FIELDS = "/api/v1/schema-fields";
const RECORD_DOCUMENTS = "/api/v1/documents";
const DOCUMENT_GENERATIONS = "/api/v1/document-generations";
const MAX_BODY_BYTES = 32 * 1024;

const ADMIN_FIELD_ROUTE = /^\/api\/v1\/admin\/schema-fields\/([^/]+)$/;
const ADMIN_FIELD_REVISIONS_ROUTE = /^\/api\/v1\/admin\/schema-fields\/([^/]+)\/revisions$/;
const ADMIN_TEMPLATE_ROUTE = /^\/api\/v1\/admin\/document-templates\/([^/]+)$/;
const ADMIN_TEMPLATE_REVISIONS_ROUTE = /^\/api\/v1\/admin\/document-templates\/([^/]+)\/revisions$/;
const RECORD_VALUES_ROUTE = /^\/api\/v1\/schema-fields\/([^/]+)\/([^/]+)$/;
const RECORD_VALUE_WRITE_ROUTE = /^\/api\/v1\/schema-fields\/([^/]+)\/([^/]+)\/([^/]+)\/values$/;
const RECORD_VALUE_REVISIONS_ROUTE = /^\/api\/v1\/schema-fields\/([^/]+)\/([^/]+)\/([^/]+)\/revisions$/;
const RECORD_DOCUMENTS_ROUTE = /^\/api\/v1\/documents\/([^/]+)\/([^/]+)$/;
const DOCUMENT_GENERATION_RECONCILE_ROUTE = /^\/api\/v1\/document-generations\/([^/]+)\/reconcile$/;
const DOCUMENT_GENERATION_ROUTE = /^\/api\/v1\/document-generations\/([^/]+)$/;

export async function handleSchemaFormsRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const administration = path === ADMIN_FIELDS || path.startsWith(`${ADMIN_FIELDS}/`) ||
    path === ADMIN_TEMPLATES || path.startsWith(`${ADMIN_TEMPLATES}/`);
  const records = path === RECORD_FIELDS || path.startsWith(`${RECORD_FIELDS}/`);
  // Record document reads are deliberately NOT part of `generations`: authoring and generating a
  // document are owner-only commands, reading the layout the owner authored is not.
  const documents = path === RECORD_DOCUMENTS || path.startsWith(`${RECORD_DOCUMENTS}/`);
  const generations = path === DOCUMENT_GENERATIONS || path.startsWith(`${DOCUMENT_GENERATIONS}/`);
  if (!administration && !records && !documents && !generations) return null;

  if (administration && auth.session.role !== "owner")
    return json({ error: "schema_configuration_forbidden" }, 403);
  if (generations && auth.session.role !== "owner")
    return json({ error: "document_generation_forbidden" }, 403);

  try {
    if (path === ADMIN_FIELDS) return await adminFieldsRoot(req, env, auth, url, now);
    const fieldRevisions = path.match(ADMIN_FIELD_REVISIONS_ROUTE);
    if (fieldRevisions) return await adminFieldRevisions(req, env, auth, fieldRevisions[1] ?? "");
    const field = path.match(ADMIN_FIELD_ROUTE);
    if (field) return await adminField(req, env, auth, field[1] ?? "", now);

    if (path === ADMIN_TEMPLATES) return await adminTemplatesRoot(req, env, auth, url, now);
    const templateRevisions = path.match(ADMIN_TEMPLATE_REVISIONS_ROUTE);
    if (templateRevisions)
      return await adminTemplateRevisions(req, env, auth, templateRevisions[1] ?? "");
    const template = path.match(ADMIN_TEMPLATE_ROUTE);
    if (template) return await adminTemplate(req, env, auth, template[1] ?? "", now);

    const valueRevisions = path.match(RECORD_VALUE_REVISIONS_ROUTE);
    if (valueRevisions)
      return await recordValueRevisions(req, env, auth, valueRevisions.slice(1));
    const valueWrite = path.match(RECORD_VALUE_WRITE_ROUTE);
    if (valueWrite) return await recordValueWrite(req, env, auth, valueWrite.slice(1), now);
    const values = path.match(RECORD_VALUES_ROUTE);
    if (values) return await recordValues(req, env, auth, values.slice(1));
    const documentsRead = path.match(RECORD_DOCUMENTS_ROUTE);
    if (documentsRead) return await recordDocuments(req, env, auth, documentsRead.slice(1));

    if (path === DOCUMENT_GENERATIONS) return await documentGenerationRoot(req, env, auth, now);
    const reconcile = path.match(DOCUMENT_GENERATION_RECONCILE_ROUTE);
    if (reconcile) return await documentGenerationReconcile(req, env, auth, reconcile[1] ?? "", now);
    const generation = path.match(DOCUMENT_GENERATION_ROUTE);
    if (generation) return await documentGenerationRead(req, env, auth, generation[1] ?? "");
  } catch (error) {
    return domainFailure(error);
  }
  return json({ error: "not_found" }, 404);
}

async function documentGenerationRoot(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const body = mutation.body;
  const result = await generateDocumentToR2(env, {
    tenantId: auth.session.tenant_id,
    entityType: body.entity_type as string,
    entityId: body.entity_id as string,
    templateId: body.template_id as string,
    templateRevisionId: body.template_revision_id as string | null | undefined,
    expectedInputSnapshotDigest: body.expected_input_snapshot_digest as string | null | undefined,
    outputFieldId: body.output_field_id as string | null | undefined,
    expectedOutputFieldVersion: body.expected_output_field_version as number | null | undefined,
    actor: sessionActor(auth),
    idempotencyKey: mutation.idempotencyKey,
  }, now);
  return generationResponse(result);
}

async function documentGenerationRead(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedReceiptId: string,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const receiptId = decoded(encodedReceiptId);
  if (!receiptId) return json({ error: "not_found" }, 404);
  const receipt = await getDocumentGenerationReceipt(env, auth.session.tenant_id, receiptId);
  return receipt ? json({ generation: generationReceiptView(receipt) }) : json({ error: "not_found" }, 404);
}

async function documentGenerationReconcile(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAttemptId: string,
  now: Date,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const generationAttemptId = decoded(encodedAttemptId);
  if (!generationAttemptId) return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await reconcileDocumentR2(env, {
    tenantId: auth.session.tenant_id,
    generationAttemptId,
    actor: sessionActor(auth),
    idempotencyKey: mutation.idempotencyKey,
  }, now);
  return generationResponse(result);
}

function generationResponse(result: R2DocumentGenerationResult): Response {
  const status = result.outcome === "unknown" ? 202
    : result.outcome === "manual_exception" || result.outcome === "not_executed" ? 409
      : result.outcome === "failed" ? 502 : 200;
  return json({
    outcome: result.outcome,
    generation: generationReceiptView(result.receipt),
    attachment: result.attachment ? recordValueView(result.attachment) : null,
  }, status);
}

function generationReceiptView(receipt: DocumentGenerationReceipt): Record<string, unknown> {
  return {
    receipt_id: receipt.receipt_id,
    generation_attempt_id: receipt.generation_attempt_id,
    receipt_version: receipt.receipt_version,
    prior_receipt_id: receipt.prior_receipt_id,
    entity_type: receipt.entity_type,
    entity_id: receipt.entity_id,
    template_id: receipt.template_id,
    template_revision_id: receipt.template_revision_id,
    template_version: receipt.template_version,
    input_snapshot_digest: receipt.input_snapshot_digest,
    external_effect_id: receipt.external_effect_id,
    provider: receipt.provider,
    provider_document_id: receipt.provider_document_id,
    output_digest: receipt.output_digest,
    readback_digest: receipt.readback_digest,
    readback_status: receipt.readback_status,
    terminal_status: receipt.terminal_status,
    reconciliation_outcome: receipt.reconciliation_outcome,
    authority: {
      kind: receipt.authority_kind,
      actor: { type: receipt.actor_type, role: receipt.actor_role, id: receipt.actor_id },
      authority_ref: receipt.authority_ref,
      policy_ref: receipt.policy_ref,
      policy_version: receipt.policy_version,
      permit_expires_at: receipt.permit_expires_at,
      max_attempts: receipt.max_attempts,
      stop_policy: receipt.stop_policy,
      compensation_policy: receipt.compensation_policy,
    },
    created_at: receipt.created_at,
    inputs: receipt.attempt?.inputs.map((input) => ({
      sequence: input.sequence,
      field_id: input.field_id,
      field_key: input.field_key,
      label: input.label,
      field_definition_revision_id: input.field_definition_revision_id,
      field_definition_version: input.field_definition_version,
      value_revision_id: input.value_revision_id,
      value_version: input.value_version,
      value_digest: input.value_digest,
      value: input.value,
    })) ?? [],
  };
}

async function adminFieldsRoot(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  now: Date,
): Promise<Response> {
  if (req.method === "GET") {
    const entityType = entityTypeFilter(url);
    if (entityType === null) return json({ error: "schema_field_entity_type_invalid" }, 400);
    return json({
      version: 1,
      catalog: fieldCatalog(),
      fields: (await listSchemaFieldDefinitions(env, auth.session.tenant_id, entityType || undefined)).map(adminFieldView),
    });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await createSchemaFieldDefinition(
    env,
    fieldDefinitionInput(mutation.body, auth, mutation.idempotencyKey),
    now,
  );
  return json({ outcome: result.kind, field: adminFieldView(result.definition) }, result.kind === "created" ? 201 : 200);
}

async function adminField(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedFieldId: string,
  now: Date,
): Promise<Response> {
  const fieldId = decoded(encodedFieldId);
  if (!fieldId) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const field = await getSchemaFieldDefinition(env, auth.session.tenant_id, fieldId);
    return field ? json({ field: adminFieldView(field) }) : json({ error: "not_found" }, 404);
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await reviseSchemaFieldDefinition(
    env,
    fieldDefinitionInput(mutation.body, auth, mutation.idempotencyKey, fieldId),
    now,
  );
  return json({ outcome: result.kind, field: adminFieldView(result.definition) });
}

async function adminFieldRevisions(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedFieldId: string,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const fieldId = decoded(encodedFieldId);
  if (!fieldId) return json({ error: "not_found" }, 404);
  const current = await getSchemaFieldDefinition(env, auth.session.tenant_id, fieldId);
  if (!current) return json({ error: "not_found" }, 404);
  return json({
    field_id: fieldId,
    current_revision_id: current.revision_id,
    current_version: current.version,
    revisions: (await listSchemaFieldDefinitionRevisions(env, auth.session.tenant_id, fieldId)).map(adminFieldView),
  });
}

async function adminTemplatesRoot(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  now: Date,
): Promise<Response> {
  if (req.method === "GET") {
    const entityType = entityTypeFilter(url);
    if (entityType === null) return json({ error: "document_template_entity_type_invalid" }, 400);
    return json({
      version: 1,
      catalog: {
        actions: [...DOCUMENT_TEMPLATE_ACTIONS],
        block_kinds: [...DOCUMENT_TEMPLATE_BLOCK_KINDS],
        retention_policies: [...SCHEMA_RETENTION_POLICIES],
      },
      templates: (await listDocumentTemplates(env, auth.session.tenant_id, entityType || undefined)).map(adminTemplateView),
    });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await createDocumentTemplate(
    env,
    templateInput(mutation.body, auth, mutation.idempotencyKey),
    now,
  );
  return json({ outcome: result.kind, template: adminTemplateView(result.template) }, result.kind === "created" ? 201 : 200);
}

async function adminTemplate(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedTemplateId: string,
  now: Date,
): Promise<Response> {
  const templateId = decoded(encodedTemplateId);
  if (!templateId) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const template = await getDocumentTemplate(env, auth.session.tenant_id, templateId);
    return template ? json({ template: adminTemplateView(template) }) : json({ error: "not_found" }, 404);
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await reviseDocumentTemplate(
    env,
    templateInput(mutation.body, auth, mutation.idempotencyKey, templateId),
    now,
  );
  return json({ outcome: result.kind, template: adminTemplateView(result.template) });
}

async function adminTemplateRevisions(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedTemplateId: string,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const templateId = decoded(encodedTemplateId);
  if (!templateId) return json({ error: "not_found" }, 404);
  const current = await getDocumentTemplate(env, auth.session.tenant_id, templateId);
  if (!current) return json({ error: "not_found" }, 404);
  return json({
    template_id: templateId,
    current_revision_id: current.revision_id,
    current_version: current.version,
    revisions: (await listDocumentTemplateRevisions(env, auth.session.tenant_id, templateId)).map(adminTemplateView),
  });
}

async function recordValues(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  segments: string[],
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const scope = recordScope(segments);
  if (!scope) return json({ error: "not_found" }, 404);
  const fields = await listAuthorizedSchemaFieldValues(
    env,
    auth.session.tenant_id,
    scope.entityType,
    scope.entityId,
    sessionActor(auth),
  );
  return json({
    entity_type: scope.entityType,
    entity_id: scope.entityId,
    fields: fields.map(({ definition, value }) => ({
      definition: recordFieldView(definition),
      value: value ? recordValueView(value) : null,
    })),
  });
}

/**
 * The record-scoped document read: what the shop and the crew open on the job.
 *
 * It publishes an administrator's document LAYOUT and nothing else.  Values stay on
 * `GET /api/v1/schema-fields/:entityType/:entityId`, which is the one read that applies per-field
 * authority; a second route carrying values would be a second, weaker path to the same data.  So a
 * reader who may read the record receives every active document bound to its entity type - blocks
 * included - and joins the values their record read already decided they may have.
 *
 * Absence is a 404 in three cases that a reader must not be able to tell apart: an entity type
 * nobody registers, a record in another tenant, and a role that may not read this kind of record
 * at all.  A record that exists and simply carries no document answers `200` with an empty array.
 */
async function recordDocuments(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  segments: string[],
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const scope = recordScope(segments);
  if (!scope) return json({ error: "not_found" }, 404);
  const readable = await recordReadableByActor(
    env,
    auth.session.tenant_id,
    scope.entityType,
    scope.entityId,
    sessionActor(auth),
  );
  if (!readable) return json({ error: "not_found" }, 404);
  const templates = await listDocumentTemplates(env, auth.session.tenant_id, scope.entityType);
  return json({
    entity_type: scope.entityType,
    entity_id: scope.entityId,
    documents: templates.filter((template) => template.active).map(recordDocumentView),
  });
}

/**
 * The authoring coordinates a reader has no use for - action, actor, fingerprint, effective_at,
 * retention - stay on `adminTemplateView`. `blocks` travels verbatim: it is the same
 * `DocumentTemplateBlock[]` `renderDocumentTemplate` consumes, in authored order.
 */
function recordDocumentView(template: DocumentTemplateRevision): Record<string, unknown> {
  return {
    template_id: template.template_id,
    template_key: template.template_key,
    label: template.label,
    revision_id: template.revision_id,
    version: template.version,
    blocks: template.blocks,
  };
}

async function recordValueWrite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  segments: string[],
  now: Date,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const scope = recordScope(segments);
  const fieldId = decoded(segments[2] ?? "");
  if (!scope || !fieldId) return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await recordSchemaFieldValue(
    env,
    fieldValueInput(mutation.body, auth, mutation.idempotencyKey, scope.entityType, scope.entityId, fieldId),
    now,
  );
  return json({ outcome: result.kind, value: recordValueView(result.value) }, result.kind === "created" ? 201 : 200);
}

async function recordValueRevisions(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  segments: string[],
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const scope = recordScope(segments);
  const fieldId = decoded(segments[2] ?? "");
  if (!scope || !fieldId) return json({ error: "not_found" }, 404);
  const revisions = await listSchemaFieldValueRevisions(
    env,
    auth.session.tenant_id,
    scope.entityType,
    scope.entityId,
    fieldId,
    sessionActor(auth),
  );
  return json({ entity_type: scope.entityType, entity_id: scope.entityId, field_id: fieldId, revisions: revisions.map(recordValueView) });
}

function fieldDefinitionInput(
  body: Record<string, unknown>,
  auth: AuthContext,
  idempotencyKey: string,
  fieldId?: string,
): SchemaFieldDefinitionInput {
  return {
    tenantId: auth.session.tenant_id,
    fieldId,
    entityType: body.entity_type as string,
    fieldKey: body.field_key as string,
    label: body.label as string,
    position: body.position as number,
    fieldType: body.field_type,
    validatorKey: body.validator_key,
    validatorConfig: body.validator_config,
    visibilityKey: body.visibility_key,
    visibilityConfig: body.visibility_config,
    evidenceClass: body.evidence_class,
    retentionPolicy: body.retention_policy,
    offlineMode: body.offline_mode,
    readScope: body.read_scope,
    writeScope: body.write_scope,
    readRoles: body.read_roles,
    writeRoles: body.write_roles,
    active: body.active,
    action: body.action,
    expectedVersion: body.expected_version,
    actor: sessionActor(auth),
    idempotencyKey,
  };
}

function templateInput(
  body: Record<string, unknown>,
  auth: AuthContext,
  idempotencyKey: string,
  templateId?: string,
): DocumentTemplateInput {
  return {
    tenantId: auth.session.tenant_id,
    templateId,
    entityType: body.entity_type as string,
    templateKey: body.template_key as string,
    label: body.label as string,
    blocks: body.blocks,
    retentionPolicy: body.retention_policy,
    active: body.active,
    action: body.action,
    expectedVersion: body.expected_version,
    actor: sessionActor(auth),
    idempotencyKey,
  };
}

function fieldValueInput(
  body: Record<string, unknown>,
  auth: AuthContext,
  idempotencyKey: string,
  entityType: string,
  entityId: string,
  fieldId: string,
): RecordSchemaFieldValueInput {
  return {
    tenantId: auth.session.tenant_id,
    entityType,
    entityId,
    fieldId,
    fieldDefinitionRevisionId: body.field_definition_revision_id as string | null | undefined,
    expectedVersion: body.expected_version as number,
    value: body.value,
    basedOnValueRevisionId: body.based_on_value_revision_id as string | null | undefined,
    correctionReason: body.correction_reason as string | null | undefined,
    sourceRef: body.source_ref as string | null | undefined,
    evidenceRef: body.evidence_ref as string | null | undefined,
    providerReceiptId: body.provider_receipt_id as string | null | undefined,
    actor: sessionActor(auth),
    idempotencyKey,
  };
}

function sessionActor(auth: AuthContext): SchemaFieldActor {
  return {
    type: auth.session.role === "owner" ? "owner" : auth.session.role === "field" ? "worker" : "agent",
    role: auth.session.role,
    userId: auth.session.user_id,
    authorityRef: `app:${auth.session.user_id}`,
    identities: appUserIdentities(auth.session),
  };
}

async function mutationInput(
  req: Request,
  auth: AuthContext,
): Promise<{ body: Record<string, unknown>; idempotencyKey: string } | { response: Response }> {
  if (!validAppCsrf(req, auth)) return { response: json({ error: "csrf_failed" }, 403) };
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(idempotencyKey))
    return { response: json({ error: "idempotency_key_required" }, 400) };
  const parsed = await readJson(req);
  if (!parsed.ok) return { response: json({ error: parsed.error }, parsed.status) };
  const body = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown>
    : null;
  return body ? { body, idempotencyKey } : { response: json({ error: "invalid_request" }, 400) };
}

function fieldCatalog(): Record<string, unknown> {
  return {
    roles: Object.keys(ROLE_PERMISSIONS),
    field_types: [...SCHEMA_FIELD_TYPES],
    validators: [...SCHEMA_VALIDATORS],
    visibility_rules: [...SCHEMA_VISIBILITY_RULES],
    evidence_classes: [...SCHEMA_EVIDENCE_CLASSES],
    retention_policies: [...SCHEMA_RETENTION_POLICIES],
    offline_modes: [...SCHEMA_OFFLINE_MODES],
    scopes: [...SCHEMA_SCOPES],
  };
}

function adminFieldView(field: SchemaFieldDefinition): Record<string, unknown> {
  return {
    field_id: field.field_id,
    entity_type: field.entity_type,
    field_key: field.field_key,
    revision_id: field.revision_id,
    version: field.version,
    prior_revision_id: field.prior_revision_id,
    action: field.action,
    label: field.label,
    position: field.position,
    field_type: field.field_type,
    validator_key: field.validator_key,
    validator_config: field.validator_config,
    visibility_key: field.visibility_key,
    visibility_config: field.visibility_config,
    evidence_class: field.evidence_class,
    retention_policy: field.retention_policy,
    offline_mode: field.offline_mode,
    read_scope: field.read_scope,
    write_scope: field.write_scope,
    read_roles: field.read_roles,
    write_roles: field.write_roles,
    active: field.active,
    actor: { type: field.actor_type, role: field.actor_role, id: field.actor_id, authority_ref: field.authority_ref },
    command_fingerprint: field.command_fingerprint,
    effective_at: field.effective_at,
    created_at: field.created_at,
  };
}

function recordFieldView(field: SchemaFieldDefinition): Record<string, unknown> {
  return {
    field_id: field.field_id,
    field_key: field.field_key,
    revision_id: field.revision_id,
    version: field.version,
    label: field.label,
    position: field.position,
    field_type: field.field_type,
    validator_key: field.validator_key,
    validator_config: field.validator_config,
    visibility_key: field.visibility_key,
    visibility_config: field.visibility_config,
    evidence_class: field.evidence_class,
    retention_policy: field.retention_policy,
    offline_mode: field.offline_mode,
  };
}

function recordValueView(value: SchemaFieldValue): Record<string, unknown> {
  return {
    value_revision_id: value.value_revision_id,
    field_definition_revision_id: value.field_definition_revision_id,
    version: value.version,
    prior_value_revision_id: value.prior_value_revision_id,
    based_on_value_revision_id: value.based_on_value_revision_id,
    correction_reason: value.correction_reason,
    value: value.value,
    value_digest: value.value_digest,
    provenance_actor_type: value.provenance_actor_type,
    created_at: value.created_at,
  };
}

function adminTemplateView(template: DocumentTemplateRevision): Record<string, unknown> {
  return {
    template_id: template.template_id,
    revision_id: template.revision_id,
    version: template.version,
    prior_revision_id: template.prior_revision_id,
    action: template.action,
    entity_type: template.entity_type,
    template_key: template.template_key,
    label: template.label,
    blocks: template.blocks,
    retention_policy: template.retention_policy,
    active: template.active,
    actor: { type: template.actor_type, role: template.actor_role, id: template.actor_id, authority_ref: template.authority_ref },
    command_fingerprint: template.command_fingerprint,
    effective_at: template.effective_at,
    created_at: template.created_at,
  };
}

function recordScope(segments: string[]): { entityType: string; entityId: string } | null {
  const entityType = decoded(segments[0] ?? "");
  const entityId = decoded(segments[1] ?? "");
  return entityType && entityId && knownEntityType(entityType) ? { entityType, entityId } : null;
}

function entityTypeFilter(url: URL): string | null {
  const raw = url.searchParams.get("entity_type");
  if (raw === null || raw === "") return "";
  const value = raw.trim();
  return value.length <= 80 && knownEntityType(value) ? value : null;
}

function decoded(value: string): string | null {
  try {
    const result = decodeURIComponent(value).trim();
    return result.length >= 1 && result.length <= 240 ? result : null;
  } catch {
    return null;
  }
}

async function readJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return { ok: false, error: "payload_too_large", status: 413 };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function domainFailure(error: unknown): Response {
  if (!(error instanceof SchemaFormsError) && !(error instanceof DocumentTemplatesError) &&
      !(error instanceof EffectRuntimeError)) throw error;
  const code = error.code;
  const status = code === "effect_runtime_required" ? 503
    : code.includes("write_failed") ? 500
    : code.includes("unavailable") ? 503
    : code.includes("forbidden") ? 403
    : code.endsWith("_not_found") || code.endsWith("_entity_not_found") ? 404
    : /conflict|stale|retired|retention_hold|_exists|not_visible|in_flight|not_reconcilable|unknown_requires/.test(code) ? 409
    : 400;
  const detail = "detail" in error ? error.detail : {};
  return json({ error: code, ...detail }, status);
}

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}
