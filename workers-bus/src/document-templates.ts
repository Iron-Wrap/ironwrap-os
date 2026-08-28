/**
 * Closed document-template and generation-receipt domain (IRO-242 checkpoint 2).
 *
 * This is deliberately two small aggregates, not a general form engine:
 * template revisions describe a deterministic server-rendered document and a
 * generation attempt snapshots the exact schema values used for that document.
 * Provider work remains in `effect-runtime.ts`; this module only binds its
 * already durable effect/readback to the immutable generation evidence.
 */
import type { AppEnv, AppRole } from "./app-types.ts";
import {
  SCHEMA_RETENTION_POLICIES,
  getSchemaFieldDefinition,
  listAuthorizedSchemaFieldValues,
  validateSchemaFieldActor,
  type SchemaFieldActor,
  type SchemaRetentionPolicy,
} from "./schema-forms.ts";
import { entityExists, knownEntityType } from "./pipeline-board-store.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const DOCUMENT_TEMPLATE_ACTIONS = ["create", "revise", "retire"] as const;
export type DocumentTemplateAction = (typeof DOCUMENT_TEMPLATE_ACTIONS)[number];

export const DOCUMENT_TEMPLATE_BLOCK_KINDS = ["text", "heading", "field"] as const;

export type DocumentTemplateBlock =
  | { kind: "text"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "field"; field_id: string };

export const DOCUMENT_GENERATION_TERMINAL_STATUSES = ["succeeded", "failed", "unknown"] as const;
export type DocumentGenerationTerminalStatus = (typeof DOCUMENT_GENERATION_TERMINAL_STATUSES)[number];
export const DOCUMENT_GENERATION_RECONCILIATION_OUTCOMES = [
  ...DOCUMENT_GENERATION_TERMINAL_STATUSES,
  "not_executed",
  "manual_exception",
] as const;
export type DocumentGenerationReconciliationOutcome = (typeof DOCUMENT_GENERATION_RECONCILIATION_OUTCOMES)[number];
export const DOCUMENT_GENERATION_READBACK_STATUSES = ["match", "conflict", "not_found", "unavailable"] as const;
export type DocumentGenerationReadbackStatus = (typeof DOCUMENT_GENERATION_READBACK_STATUSES)[number];
export const DOCUMENT_GENERATION_STOP_POLICIES = ["stop_on_unknown", "stop_on_conflict"] as const;
export type DocumentGenerationStopPolicy = (typeof DOCUMENT_GENERATION_STOP_POLICIES)[number];
export const DOCUMENT_GENERATION_COMPENSATION_POLICIES = ["none", "manual_review"] as const;
export type DocumentGenerationCompensationPolicy = (typeof DOCUMENT_GENERATION_COMPENSATION_POLICIES)[number];

const MAX_BLOCKS = 200;
const MAX_BLOCK_TEXT = 4_000;
const MAX_LABEL = 160;
const READBACK_SCHEMA = "ironwrap.document-generation-readback.v1";
const TEMPLATE_COMMAND_SCHEMA = "ironwrap.document-template.v1";
const GENERATION_COMMAND_SCHEMA = "ironwrap.document-generation.v1";
const RECEIPT_COMMAND_SCHEMA = "ironwrap.document-generation-receipt.v1";

export class DocumentTemplatesError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.name = "DocumentTemplatesError";
  }
}

export interface DocumentTemplateInput {
  tenantId: string;
  templateId?: string;
  entityType: string;
  templateKey: string;
  label: string;
  blocks: unknown;
  retentionPolicy?: unknown;
  active?: unknown;
  expectedVersion?: unknown;
  action?: unknown;
  actor: SchemaFieldActor;
  idempotencyKey: string;
}

export interface DocumentTemplateRevision {
  template_id: string;
  tenant_id: string;
  version: number;
  revision_id: string;
  prior_revision_id: string | null;
  action: DocumentTemplateAction;
  entity_type: string;
  template_key: string;
  label: string;
  blocks: DocumentTemplateBlock[];
  retention_policy: SchemaRetentionPolicy;
  active: boolean;
  actor_type: SchemaFieldActor["type"];
  actor_role: AppRole;
  actor_id: string;
  authority_ref: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  effective_at: string;
  created_at: string;
}

export type DocumentTemplate = DocumentTemplateRevision;

export interface DocumentTemplateMutation {
  kind: "created" | "replayed";
  template: DocumentTemplateRevision;
  revision: DocumentTemplateRevision;
}

export interface DocumentGenerationServiceAuthority {
  kind?: "service";
  permitRef: string;
  policyRef: string;
  policyVersion: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  templateId: string;
  action: "document.generate";
  expiresAt: string;
  maxAttempts: number;
  stopPolicy: DocumentGenerationStopPolicy;
  compensationPolicy: DocumentGenerationCompensationPolicy;
  actor: SchemaFieldActor;
}

export type DocumentGenerationAuthority = SchemaFieldActor | DocumentGenerationServiceAuthority;

export interface PrepareDocumentGenerationInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  templateId: string;
  templateRevisionId?: string | null;
  actor?: SchemaFieldActor;
  serviceAuthority?: DocumentGenerationServiceAuthority;
  authority?: DocumentGenerationAuthority;
  now?: Date;
}

export interface DocumentGenerationFieldSnapshot {
  sequence: number;
  field_id: string;
  field_key: string;
  label: string;
  field_definition_revision_id: string;
  field_definition_version: number;
  value_revision_id: string;
  value_version: number;
  value_digest: string;
  value: unknown;
}

export interface PreparedDocumentGeneration {
  template: DocumentTemplateRevision;
  authority: NormalizedGenerationAuthority;
  inputs: DocumentGenerationFieldSnapshot[];
  inputSnapshotDigest: string;
  renderedOutput: string;
  outputDigest: string;
}

export interface BeginDocumentGenerationInput extends PrepareDocumentGenerationInput {
  generationAttemptId: string;
  externalEffectId: string;
  provider: string;
  idempotencyKey: string;
  expectedInputSnapshotDigest?: string | null;
}

export interface DocumentGenerationAttempt {
  generation_attempt_id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  template_id: string;
  template_revision_id: string;
  template_version: number;
  external_effect_id: string;
  provider: string;
  authority_kind: "actor" | "service";
  actor_type: SchemaFieldActor["type"];
  actor_role: AppRole;
  actor_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  permit_expires_at: string | null;
  max_attempts: number;
  stop_policy: DocumentGenerationStopPolicy;
  compensation_policy: DocumentGenerationCompensationPolicy;
  input_count: number;
  input_snapshot_digest: string;
  output_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
  inputs: DocumentGenerationFieldSnapshot[];
}

export interface BeginDocumentGenerationResult {
  kind: "created" | "replayed";
  attempt: DocumentGenerationAttempt;
  prepared?: PreparedDocumentGeneration;
}

export interface RecordDocumentGenerationTerminalInput {
  tenantId: string;
  generationAttemptId: string;
  externalEffectId?: string;
  provider?: string;
  terminalStatus: DocumentGenerationTerminalStatus;
  reconciliationOutcome?: DocumentGenerationReconciliationOutcome;
  readbackStatus?: DocumentGenerationReadbackStatus;
  providerDocumentId?: string | null;
  outputDigest?: string | null;
  readbackDigest?: string | null;
  receiptId?: string;
  actor?: SchemaFieldActor;
  serviceAuthority?: DocumentGenerationServiceAuthority;
  authority?: DocumentGenerationAuthority;
  idempotencyKey: string;
  now?: Date;
}

export interface DocumentGenerationReceipt {
  receipt_id: string;
  generation_attempt_id: string;
  receipt_version: number;
  prior_receipt_id: string | null;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  template_id: string;
  template_revision_id: string;
  template_version: number;
  input_snapshot_digest: string;
  external_effect_id: string;
  provider: string;
  provider_document_id: string | null;
  output_digest: string;
  readback_digest: string | null;
  readback_status: DocumentGenerationReadbackStatus;
  terminal_status: DocumentGenerationTerminalStatus;
  reconciliation_outcome: DocumentGenerationReconciliationOutcome;
  authority_kind: "actor" | "service";
  actor_type: SchemaFieldActor["type"];
  actor_role: AppRole;
  actor_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  permit_expires_at: string | null;
  max_attempts: number;
  stop_policy: DocumentGenerationStopPolicy;
  compensation_policy: DocumentGenerationCompensationPolicy;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
  attempt?: DocumentGenerationAttempt;
  template?: DocumentTemplateRevision;
}

interface NormalizedTemplateInput {
  tenantId: string;
  templateId?: string;
  entityType: string;
  templateKey: string;
  label: string;
  blocks: DocumentTemplateBlock[];
  retentionPolicy: SchemaRetentionPolicy;
  active: boolean;
  action: DocumentTemplateAction;
  expectedVersion?: number;
  actor: SchemaFieldActor;
}

interface TemplateRow {
  template_id: string;
  tenant_id: string;
  version: number;
  revision_id: string;
  prior_revision_id: string | null;
  action: DocumentTemplateAction;
  entity_type: string;
  template_key: string;
  label: string;
  blocks_json: string;
  retention_policy: SchemaRetentionPolicy;
  active: number;
  actor_type: SchemaFieldActor["type"];
  actor_role: AppRole;
  actor_id: string;
  authority_ref: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  effective_at: string;
  created_at: string;
}

interface AttemptRow {
  generation_attempt_id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  template_id: string;
  template_revision_id: string;
  template_version: number;
  external_effect_id: string;
  provider: string;
  authority_kind: "actor" | "service";
  actor_type: SchemaFieldActor["type"];
  actor_role: AppRole;
  actor_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  permit_expires_at: string | null;
  max_attempts: number;
  stop_policy: DocumentGenerationStopPolicy;
  compensation_policy: DocumentGenerationCompensationPolicy;
  input_count: number;
  input_snapshot_digest: string;
  output_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

interface InputRow {
  generation_attempt_id: string;
  tenant_id: string;
  sequence: number;
  entity_type: string;
  entity_id: string;
  field_id: string;
  field_definition_revision_id: string;
  field_definition_version: number;
  value_revision_id: string;
  value_version: number;
  value_digest: string;
  value_json: string;
  created_at: string;
  field_key?: string;
  label?: string;
}

interface ReceiptRow extends Omit<DocumentGenerationReceipt, "attempt" | "reconciliation_outcome"> {
  reconciliation_outcome: DocumentGenerationTerminalStatus;
  settled_outcome: "not_executed" | "manual_exception" | null;
}

interface ExternalEffectRow {
  effect_id: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  intent_id: string;
  action: string;
  provider: string;
  idempotency_key: string;
  deadline_at: string;
  expected_readback_json: string;
  retry_limit: number;
  attempt_count: number;
  state: string;
  provider_external_id: string | null;
  readback_hash: string | null;
}

interface NormalizedGenerationAuthority {
  kind: "actor" | "service";
  actor: SchemaFieldActor;
  authorityRef: string;
  policyRef: string;
  policyVersion: string;
  permitExpiresAt: string | null;
  maxAttempts: number;
  stopPolicy: DocumentGenerationStopPolicy;
  compensationPolicy: DocumentGenerationCompensationPolicy;
  command: Record<string, unknown>;
}

export function parseDocumentTemplateBlocks(value: unknown): DocumentTemplateBlock[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BLOCKS)
    fail("document_template_blocks_invalid");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("document_template_block_invalid");
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (kind === "text" || kind === "heading") {
      const expected = kind === "text" ? ["kind", "text"] : ["kind", "level", "text"];
      if (Object.keys(record).some((key) => !expected.includes(key))) fail("document_template_block_invalid");
      const text = boundedText(record.text, 1, MAX_BLOCK_TEXT, "document_template_block_text_invalid");
      if (text.includes("<") || text.includes(">")) fail("document_template_block_markup_invalid");
      if (kind === "text") return { kind, text } as DocumentTemplateBlock;
      if (!Number.isSafeInteger(record.level) || ![1, 2, 3].includes(Number(record.level)))
        fail("document_template_heading_level_invalid");
      return { kind, level: Number(record.level) as 1 | 2 | 3, text } as DocumentTemplateBlock;
    }
    if (kind === "field") {
      if (Object.keys(record).some((key) => key !== "kind" && key !== "field_id")) fail("document_template_block_invalid");
      const fieldId = boundedId(record.field_id, 12, 200, "document_template_field_binding_invalid");
      if (seen.has(fieldId)) fail("document_template_field_binding_duplicate");
      seen.add(fieldId);
      return { kind, field_id: fieldId } as DocumentTemplateBlock;
    }
    fail("document_template_block_kind_invalid");
  });
}

export async function createDocumentTemplate(
  env: AppEnv,
  input: DocumentTemplateInput,
  now = new Date(),
): Promise<DocumentTemplateMutation> {
  if (input.action !== undefined && input.action !== null && input.action !== "create")
    fail("document_template_action_invalid");
  const normalized = normalizeTemplateInput({ ...input, action: "create" });
  assertTemplateAuthority(normalized.actor, input.actor);
  const tenantId = normalized.tenantId;
  const templateId = normalized.templateId ?? `template:${(await sha256Hex(canonicalJson({
    tenant_id: tenantId, entity_type: normalized.entityType, template_key: normalized.templateKey,
  }))).slice(0, 40)}`;
  const withId = { ...normalized, templateId };
  const createdAt = validNow(now);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const commandFingerprint = await sha256Hex(canonicalJson(templateCommand(withId)));
  const existing = await templateByIdempotency(env, tenantId, idempotencyKeyHash);
  if (existing) return replayTemplate(existing, commandFingerprint);
  await assertTemplateBindings(env, withId);
  const revisionId = `docrev:${templateId}:1`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO document_template_heads
         (template_id, tenant_id, entity_type, template_key, current_revision_id, current_version,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
      ).bind(templateId, tenantId, normalized.entityType, normalized.templateKey, normalized.actor.userId, createdAt, createdAt),
      templateRevisionStatement(env, {
        ...withId, revisionId, version: 1, priorRevisionId: null, commandFingerprint,
        idempotencyKeyHash, createdAt,
      }),
    ]);
  } catch (error) {
    const replay = await templateByIdempotency(env, tenantId, idempotencyKeyHash);
    if (replay) return replayTemplate(replay, commandFingerprint);
    if (error instanceof DocumentTemplatesError) throw error;
    throw new DocumentTemplatesError("document_template_write_failed");
  }
  const revision = await getDocumentTemplateRevision(env, tenantId, templateId, revisionId);
  if (!revision) fail("document_template_write_failed");
  return { kind: "created", template: revision, revision };
}

export async function reviseDocumentTemplate(
  env: AppEnv,
  input: DocumentTemplateInput,
  now = new Date(),
): Promise<DocumentTemplateMutation> {
  const templateId = boundedId(input.templateId, 12, 220, "document_template_id_invalid");
  const tenantId = boundedTenant(input.tenantId);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const stored = await templateByIdempotency(env, tenantId, idempotencyKeyHash);
  if (stored) {
    const action = actionValue(input.action ?? stored.action);
    if (action === "create") fail("document_template_action_invalid");
    const replayInput = templateRevisionInput(input, stored, action);
    const replayNormalized = normalizeTemplateInput(replayInput);
    assertTemplateAuthority(replayNormalized.actor, input.actor);
    const replayExpected = input.expectedVersion === undefined || input.expectedVersion === null
      ? stored.version - 1
      : integer(input.expectedVersion, 0, 1_000_000, "document_template_version_invalid");
    const fingerprint = await sha256Hex(canonicalJson(templateCommand({ ...replayNormalized, expectedVersion: replayExpected })));
    return replayTemplate(stored, fingerprint);
  }
  const current = await getDocumentTemplate(env, tenantId, templateId);
  if (!current) fail("document_template_not_found");
  const action = actionValue(input.action ?? "revise");
  if (action === "create") fail("document_template_action_invalid");
  const normalized = normalizeTemplateInput(templateRevisionInput(input, current, action));
  assertTemplateAuthority(normalized.actor, input.actor);
  const expectedVersion = normalized.expectedVersion;
  if (expectedVersion === undefined || expectedVersion !== current.version)
    fail("document_template_version_conflict", { expected_version: expectedVersion, current_version: current.version });
  await assertTemplateBindings(env, normalized);
  if (retentionRank(normalized.retentionPolicy) < retentionRank(current.retention_policy))
    fail("document_template_retention_hold");
  if (action === "retire" && normalized.active) fail("document_template_retire_invalid");
  if (action !== "retire" && !normalized.active) fail("document_template_active_invalid");
  const createdAt = validNow(now);
  const commandFingerprint = await sha256Hex(canonicalJson(templateCommand(normalized)));
  const replay = await templateByIdempotency(env, tenantId, idempotencyKeyHash);
  if (replay) return replayTemplate(replay, commandFingerprint);
  const revisionId = `docrev:${templateId}:${current.version + 1}`;
  try {
    await templateRevisionStatement(env, {
      ...normalized, templateId, revisionId, version: current.version + 1,
      priorRevisionId: current.revision_id, commandFingerprint, idempotencyKeyHash, createdAt,
    }).run();
  } catch (error) {
    const concurrent = await templateByIdempotency(env, tenantId, idempotencyKeyHash);
    if (concurrent) return replayTemplate(concurrent, commandFingerprint);
    if (error instanceof DocumentTemplatesError) throw error;
    throw new DocumentTemplatesError("document_template_version_conflict", {
      current_version: (await getDocumentTemplate(env, tenantId, templateId))?.version,
    });
  }
  const revision = await getDocumentTemplateRevision(env, tenantId, templateId, revisionId);
  if (!revision) fail("document_template_write_failed");
  return { kind: "created", template: revision, revision };
}

export async function retireDocumentTemplate(
  env: AppEnv,
  input: Omit<DocumentTemplateInput, "action" | "active" | "blocks" | "label" | "retentionPolicy"> &
    Partial<Pick<DocumentTemplateInput, "blocks" | "label" | "retentionPolicy">>,
  now = new Date(),
): Promise<DocumentTemplateMutation> {
  const tenantId = boundedTenant(input.tenantId);
  const templateId = boundedId(input.templateId, 12, 220, "document_template_id_invalid");
  const stored = await templateByIdempotency(env, tenantId, await hashIdempotency(input.idempotencyKey));
  const current = stored ?? await getDocumentTemplate(env, tenantId, templateId);
  if (!current) fail("document_template_not_found");
  return reviseDocumentTemplate(env, {
    ...input,
    tenantId,
    templateId,
    entityType: input.entityType ?? current.entity_type,
    templateKey: input.templateKey ?? current.template_key,
    label: input.label ?? current.label,
    blocks: input.blocks ?? current.blocks,
    retentionPolicy: input.retentionPolicy ?? current.retention_policy,
    active: false,
    action: "retire",
    expectedVersion: input.expectedVersion ?? (stored ? stored.version - 1 : current.version),
  }, now);
}

export async function getDocumentTemplate(
  env: AppEnv,
  tenantId: string,
  templateId: string,
): Promise<DocumentTemplateRevision | null> {
  const row = await env.DB.prepare(
    `SELECT r.*
       FROM document_template_heads h
       JOIN document_template_revisions r
         ON r.tenant_id = h.tenant_id AND r.template_id = h.template_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.template_id = ? LIMIT 1`,
  ).bind(tenantId, templateId).first<TemplateRow>();
  return row ? templateFromRow(row) : null;
}

export async function getDocumentTemplateRevision(
  env: AppEnv,
  tenantId: string,
  templateId: string,
  revisionId: string,
): Promise<DocumentTemplateRevision | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_template_revisions
      WHERE tenant_id = ? AND template_id = ? AND revision_id = ? LIMIT 1`,
  ).bind(tenantId, templateId, revisionId).first<TemplateRow>();
  return row ? templateFromRow(row) : null;
}

export async function listDocumentTemplates(
  env: AppEnv,
  tenantId: string,
  entityType?: string,
): Promise<DocumentTemplateRevision[]> {
  const rows = await env.DB.prepare(
    `SELECT r.*
       FROM document_template_heads h
       JOIN document_template_revisions r
         ON r.tenant_id = h.tenant_id AND r.template_id = h.template_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? ${entityType ? "AND h.entity_type = ?" : ""}
      ORDER BY h.entity_type ASC, h.template_key ASC`,
  ).bind(...(entityType ? [tenantId, entityType] : [tenantId])).all<TemplateRow>();
  return rows.results.map(templateFromRow);
}

export async function listDocumentTemplateRevisions(
  env: AppEnv,
  tenantId: string,
  templateId: string,
): Promise<DocumentTemplateRevision[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM document_template_revisions
      WHERE tenant_id = ? AND template_id = ? ORDER BY version ASC`,
  ).bind(tenantId, templateId).all<TemplateRow>();
  return rows.results.map(templateFromRow);
}

export async function prepareDocumentGenerationInputs(
  env: AppEnv,
  input: PrepareDocumentGenerationInput,
): Promise<PreparedDocumentGeneration> {
  const scope = normalizeGenerationScope(input);
  const authority = normalizeGenerationAuthority(input, scope, input.now ?? new Date());
  const template = input.templateRevisionId
    ? await getDocumentTemplateRevision(env, scope.tenantId, scope.templateId, boundedId(input.templateRevisionId, 16, 240, "document_template_revision_invalid"))
    : await getDocumentTemplate(env, scope.tenantId, scope.templateId);
  if (!template) fail("document_template_not_found");
  if (!template.active) fail("document_template_retired");
  if (!(await entityExists(env, scope.tenantId, scope.entityType, scope.entityId))) fail("document_generation_entity_not_found");
  const authorized = await listAuthorizedSchemaFieldValues(
    env,
    scope.tenantId,
    scope.entityType,
    scope.entityId,
    authority.actor,
  );
  const byFieldId = new Map(authorized.map((entry) => [entry.definition.field_id, entry]));
  const bindings = template.blocks.filter((block): block is { kind: "field"; field_id: string } => block.kind === "field");
  if (bindings.length === 0) fail("document_template_binding_required");
  const inputs: DocumentGenerationFieldSnapshot[] = [];
  for (const [sequence, binding] of bindings.entries()) {
    const entry = byFieldId.get(binding.field_id);
    if (!entry) fail("document_generation_input_forbidden");
    const definition = entry.definition;
    const value = entry.value;
    if (!value) fail("document_generation_input_missing");
    if (value.field_definition_revision_id !== definition.revision_id)
      fail("document_generation_input_stale");
    inputs.push({
      sequence,
      field_id: definition.field_id,
      field_key: definition.field_key,
      label: definition.label,
      field_definition_revision_id: definition.revision_id,
      field_definition_version: definition.version,
      value_revision_id: value.value_revision_id,
      value_version: value.version,
      value_digest: value.value_digest,
      value: value.value,
    });
  }
  const inputSnapshotDigest = await sha256Hex(canonicalJson(inputs.map(inputSnapshotCommand)));
  const renderedOutput = renderDocumentTemplate(template.blocks, inputs);
  const outputDigest = await sha256Hex(renderedOutput);
  return { template, authority, inputs, inputSnapshotDigest, renderedOutput, outputDigest };
}

export function renderDocumentTemplate(
  blocks: readonly DocumentTemplateBlock[],
  inputs: readonly DocumentGenerationFieldSnapshot[],
): string {
  const values = new Map(inputs.map((input) => [input.field_id, displayValue(input.value)]));
  return blocks.map((block) => {
    if (block.kind === "text") return `<p>${escapeHtml(block.text)}</p>`;
    if (block.kind === "heading") return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    const value = values.get(block.field_id);
    if (value === undefined) fail("document_generation_input_missing");
    return `<p data-field-id="${escapeHtml(block.field_id)}">${escapeHtml(value)}</p>`;
  }).join("");
}

export async function beginDocumentGeneration(
  env: AppEnv,
  input: BeginDocumentGenerationInput,
): Promise<BeginDocumentGenerationResult> {
  const scope = normalizeGenerationScope(input);
  const generationAttemptId = boundedId(input.generationAttemptId, 16, 220, "document_generation_attempt_id_invalid");
  const externalEffectId = boundedId(input.externalEffectId, 16, 160, "document_generation_effect_invalid");
  const provider = boundedText(input.provider, 1, 120, "document_generation_provider_invalid");
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const existing = await attemptByIdempotency(env, scope.tenantId, idempotencyKeyHash);
  if (existing) {
    const existingScope = {
      tenantId: existing.tenant_id,
      entityType: existing.entity_type,
      entityId: existing.entity_id,
      templateId: existing.template_id,
    };
    const authority = normalizeGenerationAuthority(input, existingScope, input.now ?? new Date(), true);
    const suppliedTemplate = input.templateRevisionId === undefined || input.templateRevisionId === null
      ? existing.template_revision_id
      : boundedId(input.templateRevisionId, 16, 240, "document_template_revision_invalid");
    const suppliedDigest = input.expectedInputSnapshotDigest === undefined || input.expectedInputSnapshotDigest === null
      ? existing.input_snapshot_digest
      : digest(input.expectedInputSnapshotDigest, "document_generation_snapshot_invalid");
    const command = generationCommand({
      scope, generationAttemptId, externalEffectId, provider, templateId: existing.template_id,
      templateRevisionId: suppliedTemplate, templateVersion: existing.template_version,
      inputSnapshotDigest: suppliedDigest, outputDigest: existing.output_digest, authority,
      inputs: existing.inputs,
    });
    const fingerprint = await sha256Hex(canonicalJson(command));
    if (existing.command_fingerprint !== fingerprint) fail("document_generation_idempotency_conflict");
    return { kind: "replayed", attempt: existing };
  }
  const prepared = await prepareDocumentGenerationInputs(env, input);
  if (input.expectedInputSnapshotDigest !== undefined && input.expectedInputSnapshotDigest !== null &&
      digest(input.expectedInputSnapshotDigest, "document_generation_snapshot_invalid") !== prepared.inputSnapshotDigest)
    fail("document_generation_snapshot_stale");
  const effect = await getGenerationEffect(env, externalEffectId);
  assertGenerationEffectForAttempt(effect, {
    scope, generationAttemptId, externalEffectId, provider,
    template: prepared.template, inputSnapshotDigest: prepared.inputSnapshotDigest,
    outputDigest: prepared.outputDigest, authority: prepared.authority,
  });
  const command = generationCommand({
    scope, generationAttemptId, externalEffectId, provider, templateId: prepared.template.template_id,
    templateRevisionId: prepared.template.revision_id, templateVersion: prepared.template.version,
    inputSnapshotDigest: prepared.inputSnapshotDigest, outputDigest: prepared.outputDigest,
    authority: prepared.authority, inputs: prepared.inputs,
  });
  const commandFingerprint = await sha256Hex(canonicalJson(command));
  const createdAt = validNow(input.now ?? new Date());
  const attempt = {
    generationAttemptId, ...scope, templateId: prepared.template.template_id,
    templateRevisionId: prepared.template.revision_id, templateVersion: prepared.template.version,
    externalEffectId, provider, authority: prepared.authority, inputCount: prepared.inputs.length,
    inputSnapshotDigest: prepared.inputSnapshotDigest, outputDigest: prepared.outputDigest,
    commandFingerprint, idempotencyKeyHash, createdAt,
  };
  try {
    const statements = [attemptStatement(env, attempt), ...prepared.inputs.map((snapshot) => inputStatement(env, attempt, snapshot))];
    await env.DB.batch(statements);
  } catch (error) {
    const replay = await attemptByIdempotency(env, scope.tenantId, idempotencyKeyHash);
    if (replay) {
      if (replay.command_fingerprint !== commandFingerprint) fail("document_generation_idempotency_conflict");
      return { kind: "replayed", attempt: replay };
    }
    if (error instanceof DocumentTemplatesError) throw error;
    throw new DocumentTemplatesError(errorCode(error) ?? "document_generation_write_failed");
  }
  const stored = await attemptById(env, scope.tenantId, generationAttemptId);
  if (!stored) fail("document_generation_write_failed");
  return { kind: "created", attempt: stored, prepared };
}

export async function recordDocumentGenerationTerminal(
  env: AppEnv,
  input: RecordDocumentGenerationTerminalInput,
): Promise<{ kind: "created" | "replayed"; receipt: DocumentGenerationReceipt }> {
  const tenantId = boundedTenant(input.tenantId);
  const attemptId = boundedId(input.generationAttemptId, 16, 220, "document_generation_attempt_id_invalid");
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const existing = await receiptByIdempotency(env, tenantId, idempotencyKeyHash);
  if (existing) {
    const fingerprint = await terminalFingerprintForReplay(existing, input);
    if (existing.command_fingerprint !== fingerprint) fail("document_generation_idempotency_conflict");
    return { kind: "replayed", receipt: await attachAttempt(env, existing) };
  }
  const attempt = await attemptById(env, tenantId, attemptId);
  if (!attempt) fail("document_generation_attempt_not_found");
  const scope = { tenantId, entityType: attempt.entity_type, entityId: attempt.entity_id, templateId: attempt.template_id };
  const authority = normalizeGenerationAuthority(input, scope, input.now ?? new Date(), true);
  assertSameAuthority(authority, attempt);
  const externalEffectId = boundedId(input.externalEffectId ?? attempt.external_effect_id, 16, 160, "document_generation_effect_invalid");
  const provider = boundedText(input.provider ?? attempt.provider, 1, 120, "document_generation_provider_invalid");
  if (externalEffectId !== attempt.external_effect_id || provider !== attempt.provider)
    fail("document_generation_effect_scope_invalid");
  const terminalStatus = terminalStatusValue(input.terminalStatus);
  const reconciliationOutcome = input.reconciliationOutcome === undefined || input.reconciliationOutcome === null
    ? terminalStatus
    : reconciliationOutcomeValue(input.reconciliationOutcome);
  if (reconciliationOutcome !== terminalStatus &&
      !(terminalStatus === "unknown" && (reconciliationOutcome === "not_executed" || reconciliationOutcome === "manual_exception")))
    fail("document_generation_terminal_invalid");
  const readbackStatus = input.readbackStatus === undefined || input.readbackStatus === null
    ? terminalStatus === "succeeded" ? "match" : "unavailable"
    : readbackStatusValue(input.readbackStatus);
  const outputDigest = input.outputDigest === undefined || input.outputDigest === null
    ? attempt.output_digest : digest(input.outputDigest, "document_generation_output_invalid");
  if (outputDigest !== attempt.output_digest) fail("document_generation_output_mismatch");
  const providerDocumentId = input.providerDocumentId === undefined || input.providerDocumentId === null
    ? null : boundedText(input.providerDocumentId, 1, 240, "document_generation_provider_document_invalid");
  const readbackDigest = input.readbackDigest === undefined || input.readbackDigest === null
    ? null : digest(input.readbackDigest, "document_generation_readback_invalid");
  const effect = await getGenerationEffect(env, externalEffectId);
  assertTerminalEffect(effect, {
    attempt, terminalStatus, reconciliationOutcome, readbackStatus, providerDocumentId, outputDigest, readbackDigest,
  });
  const prior = await latestReceipt(env, tenantId, attemptId);
  if (prior && (prior.terminal_status !== "unknown" || prior.reconciliation_outcome !== "unknown"))
    fail("document_generation_terminal_already_recorded");
  const receiptVersion = prior ? prior.receipt_version + 1 : 1;
  const receiptId = boundedId(input.receiptId ?? `docreceipt:${attemptId}:${receiptVersion}`, 16, 240, "document_generation_receipt_id_invalid");
  const command = terminalCommand({
    tenantId, attemptId, receiptId, receiptVersion, priorReceiptId: prior?.receipt_id ?? null,
    externalEffectId, provider, terminalStatus, reconciliationOutcome, readbackStatus,
    providerDocumentId, outputDigest, readbackDigest, authority, attempt,
  });
  const commandFingerprint = await sha256Hex(canonicalJson(command));
  const createdAt = validNow(input.now ?? new Date());
  const values = receiptValues({
    receiptId, attempt, receiptVersion, priorReceiptId: prior?.receipt_id ?? null,
    providerDocumentId, outputDigest, readbackDigest, readbackStatus, terminalStatus,
    reconciliationOutcome, authority, commandFingerprint, idempotencyKeyHash, createdAt,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO document_generation_receipts
       (receipt_id, generation_attempt_id, receipt_version, prior_receipt_id, tenant_id, entity_type,
        entity_id, template_id, template_revision_id, template_version, input_snapshot_digest,
        external_effect_id, provider, provider_document_id, output_digest, readback_digest,
        readback_status, terminal_status, reconciliation_outcome, settled_outcome, authority_kind, actor_type,
        actor_role, actor_id, authority_ref, policy_ref, policy_version, permit_expires_at,
        max_attempts, stop_policy, compensation_policy, command_fingerprint, idempotency_key_hash,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...values).run();
  } catch (error) {
    const replay = await receiptByIdempotency(env, tenantId, idempotencyKeyHash);
    if (replay) {
      if (replay.command_fingerprint !== commandFingerprint) fail("document_generation_idempotency_conflict");
      return { kind: "replayed", receipt: await attachAttempt(env, replay) };
    }
    if (error instanceof DocumentTemplatesError) throw error;
    throw new DocumentTemplatesError(errorCode(error) ?? "document_generation_receipt_write_failed");
  }
  const receipt = await receiptById(env, tenantId, receiptId);
  if (!receipt) fail("document_generation_receipt_write_failed");
  return { kind: "created", receipt: await attachAttempt(env, receipt) };
}

export async function getDocumentGenerationAttempt(
  env: AppEnv,
  tenantId: string,
  generationAttemptId: string,
): Promise<DocumentGenerationAttempt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_attempts WHERE tenant_id = ? AND generation_attempt_id = ? LIMIT 1`,
  ).bind(tenantId, generationAttemptId).first<AttemptRow>();
  return row ? attemptFromRow(row, await inputRows(env, generationAttemptId)) : null;
}

export async function getDocumentGenerationReceipt(
  env: AppEnv,
  tenantId: string,
  receiptId: string,
): Promise<DocumentGenerationReceipt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_receipts WHERE tenant_id = ? AND receipt_id = ? LIMIT 1`,
  ).bind(tenantId, receiptId).first<ReceiptRow>();
  return row ? attachAttempt(env, receiptFromRow(row)) : null;
}

export async function getLatestDocumentGenerationReceipt(
  env: AppEnv,
  tenantId: string,
  generationAttemptId: string,
): Promise<DocumentGenerationReceipt | null> {
  const receipt = await latestReceipt(env, tenantId, generationAttemptId);
  return receipt ? attachAttempt(env, receipt) : null;
}

async function assertTemplateBindings(env: AppEnv, input: Pick<NormalizedTemplateInput, "tenantId" | "entityType" | "blocks">): Promise<void> {
  const bindings = input.blocks.filter((block): block is { kind: "field"; field_id: string } => block.kind === "field");
  if (bindings.length === 0) fail("document_template_binding_required");
  for (const binding of bindings) {
    const definition = await getSchemaFieldDefinition(env, input.tenantId, binding.field_id);
    if (!definition || definition.entity_type !== input.entityType || !definition.active) fail("document_template_binding_invalid");
  }
}

function normalizeTemplateInput(input: DocumentTemplateInput | Record<string, unknown>): NormalizedTemplateInput {
  const actor = validateSchemaFieldActor(input.actor as SchemaFieldActor);
  const tenantId = boundedTenant(input.tenantId);
  const entityType = boundedText(input.entityType, 1, 80, "document_template_entity_type_invalid");
  if (!knownEntityType(entityType)) fail("document_template_entity_type_invalid");
  const templateKey = boundedKey(input.templateKey, 1, 120, "document_template_key_invalid");
  const label = boundedText(input.label, 1, MAX_LABEL, "document_template_label_invalid");
  const blocks = parseDocumentTemplateBlocks(input.blocks);
  const retentionPolicy = enumValue(input.retentionPolicy ?? "standard", SCHEMA_RETENTION_POLICIES, "document_template_retention_invalid");
  const action = actionValue(input.action ?? "create");
  const active = input.active === undefined ? action !== "retire" : input.active;
  if (typeof active !== "boolean") fail("document_template_active_invalid");
  if (action === "retire" && active) fail("document_template_retire_invalid");
  if (action !== "retire" && !active) fail("document_template_active_invalid");
  const templateId = input.templateId === undefined || input.templateId === null || input.templateId === ""
    ? undefined : boundedId(input.templateId, 12, 220, "document_template_id_invalid");
  const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null
    ? undefined : integer(input.expectedVersion, 0, 1_000_000, "document_template_version_invalid");
  return { tenantId, templateId, entityType, templateKey, label, blocks, retentionPolicy, active, action, expectedVersion, actor };
}

function templateRevisionInput(
  input: DocumentTemplateInput | Record<string, unknown>,
  base: DocumentTemplateRevision,
  action: DocumentTemplateAction,
): DocumentTemplateInput {
  return {
    tenantId: String(input.tenantId ?? base.tenant_id),
    templateId: String(input.templateId ?? base.template_id),
    entityType: String(input.entityType ?? base.entity_type),
    templateKey: String(input.templateKey ?? base.template_key),
    label: String(input.label ?? base.label),
    blocks: input.blocks ?? base.blocks,
    retentionPolicy: input.retentionPolicy ?? base.retention_policy,
    active: input.active ?? (action === "retire" ? false : base.active),
    action,
    expectedVersion: input.expectedVersion,
    actor: input.actor as SchemaFieldActor,
    idempotencyKey: String(input.idempotencyKey ?? ""),
  };
}

function templateCommand(input: NormalizedTemplateInput): Record<string, unknown> {
  return {
    schema_version: TEMPLATE_COMMAND_SCHEMA,
    tenant_id: input.tenantId,
    template_id: input.templateId ?? null,
    entity_type: input.entityType,
    template_key: input.templateKey,
    label: input.label,
    blocks: input.blocks,
    retention_policy: input.retentionPolicy,
    active: input.active,
    action: input.action,
    expected_version: input.expectedVersion ?? null,
    actor: actorCommand(input.actor),
  };
}

function templateRevisionStatement(
  env: AppEnv,
  input: NormalizedTemplateInput & {
    templateId: string; revisionId: string; version: number; priorRevisionId: string | null;
    commandFingerprint: string; idempotencyKeyHash: string; createdAt: string;
  },
) {
  return env.DB.prepare(
    `INSERT INTO document_template_revisions
     (revision_id, tenant_id, template_id, version, prior_revision_id, action, entity_type,
      template_key, label, blocks_json, retention_policy, active, actor_type, actor_role, actor_id,
      authority_ref, command_fingerprint, idempotency_key_hash, effective_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.revisionId, input.tenantId, input.templateId, input.version, input.priorRevisionId,
    input.action, input.entityType, input.templateKey, input.label, canonicalJson(input.blocks),
    input.retentionPolicy, input.active ? 1 : 0, input.actor.type, input.actor.role, input.actor.userId,
    input.actor.authorityRef, input.commandFingerprint, input.idempotencyKeyHash, input.createdAt, input.createdAt,
  );
}

async function templateByIdempotency(env: AppEnv, tenantId: string, idempotencyKeyHash: string): Promise<DocumentTemplateRevision | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_template_revisions WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<TemplateRow>();
  return row ? templateFromRow(row) : null;
}

function replayTemplate(stored: DocumentTemplateRevision, fingerprint: string): DocumentTemplateMutation {
  if (stored.command_fingerprint !== fingerprint) fail("document_template_idempotency_conflict");
  return { kind: "replayed", template: stored, revision: stored };
}

function templateFromRow(row: TemplateRow): DocumentTemplateRevision {
  return {
    template_id: row.template_id, tenant_id: row.tenant_id, version: row.version,
    revision_id: row.revision_id, prior_revision_id: row.prior_revision_id, action: row.action,
    entity_type: row.entity_type, template_key: row.template_key, label: row.label,
    blocks: JSON.parse(row.blocks_json) as DocumentTemplateBlock[], retention_policy: row.retention_policy,
    active: row.active === 1, actor_type: row.actor_type, actor_role: row.actor_role,
    actor_id: row.actor_id, authority_ref: row.authority_ref, command_fingerprint: row.command_fingerprint,
    idempotency_key_hash: row.idempotency_key_hash, effective_at: row.effective_at, created_at: row.created_at,
  };
}

function normalizeGenerationScope(input: {
  tenantId: unknown; entityType: unknown; entityId: unknown; templateId: unknown;
}): { tenantId: string; entityType: string; entityId: string; templateId: string } {
  const tenantId = boundedTenant(input.tenantId);
  const entityType = boundedText(input.entityType, 1, 80, "document_generation_entity_type_invalid");
  const entityId = boundedText(input.entityId, 1, 200, "document_generation_entity_invalid");
  const templateId = boundedId(input.templateId, 12, 220, "document_template_id_invalid");
  if (!knownEntityType(entityType)) fail("document_generation_entity_type_invalid");
  return { tenantId, entityType, entityId, templateId };
}

function normalizeGenerationAuthority(
  input: {
    actor?: SchemaFieldActor;
    serviceAuthority?: DocumentGenerationServiceAuthority;
    authority?: DocumentGenerationAuthority;
  },
  scope: { tenantId: string; entityType: string; entityId: string; templateId: string },
  now: Date,
  allowExpired = false,
): NormalizedGenerationAuthority {
  const candidates: DocumentGenerationAuthority[] = [];
  if (input.actor) candidates.push(input.actor);
  if (input.serviceAuthority) candidates.push(input.serviceAuthority);
  if (input.authority) candidates.push(input.authority);
  if (candidates.length !== 1) fail("document_generation_authority_invalid");
  const candidate = candidates[0]!;
  if (isServiceAuthority(candidate)) {
    const actor = validateSchemaFieldActor(candidate.actor);
    if (actor.type !== "worker" || !["owner", "ops"].includes(actor.role) || !candidate.actor.authorityRef)
      fail("document_generation_authority_invalid");
    if (candidate.kind !== undefined && candidate.kind !== "service") fail("document_generation_authority_invalid");
    if (candidate.action !== "document.generate" || candidate.tenantId !== scope.tenantId ||
        candidate.entityType !== scope.entityType || candidate.entityId !== scope.entityId || candidate.templateId !== scope.templateId)
      fail("document_generation_authority_scope_invalid");
    const expiresAt = canonicalDateTime(candidate.expiresAt, "document_generation_permit_invalid");
    if (!allowExpired && Date.parse(expiresAt) <= now.getTime()) fail("document_generation_permit_expired");
    const permitRef = boundedText(candidate.permitRef, 1, 280, "document_generation_permit_invalid");
    const policyRef = boundedText(candidate.policyRef, 1, 280, "document_generation_policy_invalid");
    const policyVersion = boundedText(candidate.policyVersion, 1, 80, "document_generation_policy_invalid");
    const maxAttempts = integer(candidate.maxAttempts, 1, 3, "document_generation_retry_invalid");
    const stopPolicy = enumValue(candidate.stopPolicy, DOCUMENT_GENERATION_STOP_POLICIES, "document_generation_stop_policy_invalid");
    const compensationPolicy = enumValue(candidate.compensationPolicy, DOCUMENT_GENERATION_COMPENSATION_POLICIES, "document_generation_compensation_policy_invalid");
    return {
      kind: "service", actor, authorityRef: permitRef, policyRef, policyVersion,
      permitExpiresAt: expiresAt, maxAttempts, stopPolicy, compensationPolicy,
      command: { kind: "service", permit_ref: permitRef, policy_ref: policyRef, policy_version: policyVersion,
        tenant_id: scope.tenantId, entity_type: scope.entityType, entity_id: scope.entityId,
        template_id: scope.templateId, action: "document.generate", expires_at: expiresAt,
        max_attempts: maxAttempts, stop_policy: stopPolicy, compensation_policy: compensationPolicy,
        actor: actorCommand(actor) },
    };
  }
  const actor = validateSchemaFieldActor(candidate);
  return {
    kind: "actor", actor, authorityRef: actor.authorityRef!,
    policyRef: `role:${actor.role}:document.generate`, policyVersion: "v1", permitExpiresAt: null,
    maxAttempts: 1, stopPolicy: "stop_on_unknown", compensationPolicy: "none",
    command: { kind: "actor", authority_ref: actor.authorityRef, policy_ref: `role:${actor.role}:document.generate`,
      policy_version: "v1", actor: actorCommand(actor) },
  };
}

function isServiceAuthority(value: DocumentGenerationAuthority): value is DocumentGenerationServiceAuthority {
  return typeof value === "object" && value !== null && "permitRef" in value;
}

function actorCommand(actor: SchemaFieldActor): Record<string, unknown> {
  return {
    type: actor.type,
    role: actor.role,
    id: actor.userId,
    authority_ref: actor.authorityRef ?? `app:${actor.userId}`,
    identities: [...(actor.identities ?? [])].map((identity) => identity.toLowerCase()).sort(),
  };
}

function generationCommand(input: {
  scope: { tenantId: string; entityType: string; entityId: string; templateId: string };
  generationAttemptId: string; externalEffectId: string; provider: string; templateId: string;
  templateRevisionId: string; templateVersion: number; inputSnapshotDigest: string; outputDigest: string;
  authority: NormalizedGenerationAuthority; inputs: readonly DocumentGenerationFieldSnapshot[];
}): Record<string, unknown> {
  return {
    schema_version: GENERATION_COMMAND_SCHEMA,
    tenant_id: input.scope.tenantId, entity_type: input.scope.entityType, entity_id: input.scope.entityId,
    template_id: input.templateId, template_revision_id: input.templateRevisionId,
    template_version: input.templateVersion, generation_attempt_id: input.generationAttemptId,
    external_effect_id: input.externalEffectId, provider: input.provider,
    input_snapshot_digest: input.inputSnapshotDigest, output_digest: input.outputDigest,
    inputs: input.inputs.map(inputSnapshotCommand), authority: input.authority.command,
  };
}

function inputSnapshotCommand(input: DocumentGenerationFieldSnapshot): Record<string, unknown> {
  return {
    sequence: input.sequence, field_id: input.field_id, field_definition_revision_id: input.field_definition_revision_id,
    field_definition_version: input.field_definition_version, value_revision_id: input.value_revision_id,
    value_version: input.value_version, value_digest: input.value_digest, value: input.value,
  };
}

async function getGenerationEffect(env: AppEnv, effectId: string): Promise<ExternalEffectRow | null> {
  const row = await env.DB.prepare(
    `SELECT effect_id, tenant_id, actor_type, actor_id, authority_ref, policy_ref, policy_version,
            aggregate_type, aggregate_id, aggregate_version, intent_id, action, provider,
            idempotency_key, deadline_at, expected_readback_json, state, provider_external_id,
            readback_hash, retry_limit, attempt_count
       FROM external_effects WHERE effect_id = ? LIMIT 1`,
  ).bind(effectId).first<ExternalEffectRow>();
  return row ? { ...row, retry_limit: Number(row.retry_limit), attempt_count: Number(row.attempt_count) } : null;
}

function assertGenerationEffectForAttempt(
  effect: ExternalEffectRow | null,
  input: {
    scope: { tenantId: string; entityType: string; entityId: string; templateId: string };
    generationAttemptId: string; externalEffectId: string; provider: string;
    template: DocumentTemplateRevision; inputSnapshotDigest: string; outputDigest: string;
    authority: NormalizedGenerationAuthority;
  },
): void {
  if (!effect || effect.effect_id !== input.externalEffectId || effect.tenant_id !== input.scope.tenantId ||
      effect.provider !== input.provider || effect.intent_id !== input.generationAttemptId ||
      effect.action !== "document.generate" || effect.aggregate_type !== "document_generation" ||
      effect.aggregate_id !== input.generationAttemptId || effect.aggregate_version !== input.template.version)
    fail("document_generation_effect_scope_invalid");
  assertEffectAuthority(effect, input.authority);
  const expected = parseExpectedReadback(effect.expected_readback_json);
  if (!expected || !hasExpectedReadbackShape(expected) || expected.schema_version !== READBACK_SCHEMA || expected.tenant_id !== input.scope.tenantId ||
      expected.entity_type !== input.scope.entityType || expected.entity_id !== input.scope.entityId ||
      expected.generation_attempt_id !== input.generationAttemptId || expected.template_id !== input.template.template_id ||
      expected.template_revision_id !== input.template.revision_id || expected.template_version !== input.template.version ||
      expected.input_snapshot_digest !== input.inputSnapshotDigest || expected.provider !== input.provider ||
      expected.output_digest !== input.outputDigest) fail("document_generation_effect_readback_invalid");
}

function assertEffectAuthority(effect: ExternalEffectRow, authority: NormalizedGenerationAuthority): void {
  const expectedActorType = authority.actor.type === "owner" ? "owner" : authority.actor.type;
  if (effect.actor_type !== expectedActorType || effect.actor_id !== authority.actor.userId ||
      effect.authority_ref !== authority.authorityRef || effect.policy_ref !== authority.policyRef ||
      effect.policy_version !== authority.policyVersion)
    fail("document_generation_effect_authority_invalid");
  if (authority.permitExpiresAt && Date.parse(effect.deadline_at) > Date.parse(authority.permitExpiresAt))
    fail("document_generation_effect_deadline_invalid");
  if (effect.retry_limit + 1 > authority.maxAttempts)
    fail("document_generation_retry_budget_invalid");
}

function assertTerminalEffect(
  effect: ExternalEffectRow | null,
  input: {
    attempt: DocumentGenerationAttempt; terminalStatus: DocumentGenerationTerminalStatus;
    reconciliationOutcome: DocumentGenerationReconciliationOutcome;
    readbackStatus: DocumentGenerationReadbackStatus; providerDocumentId: string | null;
    outputDigest: string; readbackDigest: string | null;
  },
): void {
  if (!effect || effect.effect_id !== input.attempt.external_effect_id || effect.tenant_id !== input.attempt.tenant_id ||
      effect.provider !== input.attempt.provider || effect.intent_id !== input.attempt.generation_attempt_id ||
      effect.action !== "document.generate" || effect.aggregate_type !== "document_generation" ||
      effect.aggregate_id !== input.attempt.generation_attempt_id || effect.aggregate_version !== input.attempt.template_version)
    fail("document_generation_effect_scope_invalid");
  if (effect.retry_limit + 1 > input.attempt.max_attempts)
    fail("document_generation_retry_budget_invalid");
  if (input.terminalStatus === "succeeded") {
    const expected = parseExpectedReadback(effect.expected_readback_json);
    if (effect.state !== "succeeded" || input.readbackStatus !== "match" || !input.providerDocumentId ||
        !input.readbackDigest || effect.provider_external_id !== input.providerDocumentId ||
        effect.readback_hash !== input.readbackDigest || !expected || !hasExpectedReadbackShape(expected) || expected.schema_version !== READBACK_SCHEMA ||
        expected.tenant_id !== input.attempt.tenant_id || expected.entity_type !== input.attempt.entity_type ||
        expected.entity_id !== input.attempt.entity_id || expected.generation_attempt_id !== input.attempt.generation_attempt_id ||
        expected.template_id !== input.attempt.template_id || expected.template_revision_id !== input.attempt.template_revision_id ||
        expected.template_version !== input.attempt.template_version || expected.input_snapshot_digest !== input.attempt.input_snapshot_digest ||
        expected.provider !== input.attempt.provider || expected.provider_document_id !== input.providerDocumentId ||
        expected.output_digest !== input.outputDigest)
      fail("document_generation_success_readback_invalid");
    return;
  }
  if (input.readbackStatus === "match") fail("document_generation_readback_invalid");
  if (input.terminalStatus === "failed" && effect.state !== "failed") fail("document_generation_failed_effect_invalid");
  if (input.terminalStatus === "failed" && effect.attempt_count < effect.retry_limit + 1)
    fail("document_generation_retry_budget_invalid");
  if (effect.state === "manual_exception" && input.readbackStatus !== "conflict")
    fail("document_generation_readback_invalid");
  if (input.reconciliationOutcome === "unknown" && input.readbackStatus === "conflict")
    fail("document_generation_readback_invalid");
  if (input.reconciliationOutcome === "unknown" && effect.state !== "unknown")
    fail("document_generation_unknown_effect_invalid");
  if (input.reconciliationOutcome === "manual_exception" &&
      (input.terminalStatus !== "unknown" || effect.state !== "manual_exception" ||
       input.readbackStatus !== "conflict" || !input.readbackDigest))
    fail("document_generation_reconciliation_invalid");
  if (input.reconciliationOutcome === "not_executed" &&
      (input.terminalStatus !== "unknown" || effect.state !== "reconciled" ||
       input.readbackStatus !== "not_found" || !input.readbackDigest))
    fail("document_generation_reconciliation_invalid");
  if (effect.provider_external_id !== input.providerDocumentId)
    fail("document_generation_provider_document_invalid");
  if (effect.readback_hash !== input.readbackDigest)
    fail("document_generation_readback_invalid");
}

function parseExpectedReadback(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasExpectedReadbackShape(value: Record<string, unknown>): boolean {
  const expected = [
    "entity_id", "entity_type", "generation_attempt_id", "input_snapshot_digest", "output_digest",
    "provider", "provider_document_id", "schema_version", "template_id", "template_revision_id",
    "template_version", "tenant_id",
  ];
  return Object.keys(value).sort().join("|") === expected.sort().join("|");
}

function assertSameAuthority(authority: NormalizedGenerationAuthority, attempt: DocumentGenerationAttempt): void {
  if (authority.kind !== attempt.authority_kind || authority.actor.type !== attempt.actor_type ||
      authority.actor.role !== attempt.actor_role || authority.actor.userId !== attempt.actor_id ||
      authority.authorityRef !== attempt.authority_ref || authority.policyRef !== attempt.policy_ref ||
      authority.policyVersion !== attempt.policy_version || authority.permitExpiresAt !== attempt.permit_expires_at ||
      authority.maxAttempts !== attempt.max_attempts || authority.stopPolicy !== attempt.stop_policy ||
      authority.compensationPolicy !== attempt.compensation_policy)
    fail("document_generation_authority_mismatch");
}

function attemptStatement(env: AppEnv, input: {
  generationAttemptId: string; tenantId: string; entityType: string; entityId: string; templateId: string;
  templateRevisionId: string; templateVersion: number; externalEffectId: string; provider: string;
  authority: NormalizedGenerationAuthority; inputCount: number; inputSnapshotDigest: string; outputDigest: string;
  commandFingerprint: string; idempotencyKeyHash: string; createdAt: string;
}) {
  return env.DB.prepare(
    `INSERT INTO document_generation_attempts
     (generation_attempt_id, tenant_id, entity_type, entity_id, template_id, template_revision_id,
      template_version, external_effect_id, provider, authority_kind, actor_type, actor_role,
      actor_id, authority_ref, policy_ref, policy_version, permit_expires_at, max_attempts,
      stop_policy, compensation_policy, input_count, input_snapshot_digest, output_digest,
      command_fingerprint, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.generationAttemptId, input.tenantId, input.entityType, input.entityId, input.templateId,
    input.templateRevisionId, input.templateVersion, input.externalEffectId, input.provider,
    input.authority.kind, input.authority.actor.type, input.authority.actor.role, input.authority.actor.userId,
    input.authority.authorityRef, input.authority.policyRef, input.authority.policyVersion,
    input.authority.permitExpiresAt, input.authority.maxAttempts, input.authority.stopPolicy,
    input.authority.compensationPolicy, input.inputCount, input.inputSnapshotDigest, input.outputDigest,
    input.commandFingerprint, input.idempotencyKeyHash, input.createdAt,
  );
}

function inputStatement(env: AppEnv, attempt: {
  generationAttemptId: string; tenantId: string; entityType: string; entityId: string; createdAt: string;
}, input: DocumentGenerationFieldSnapshot) {
  return env.DB.prepare(
    `INSERT INTO document_generation_inputs
     (generation_attempt_id, tenant_id, sequence, entity_type, entity_id, field_id,
      field_definition_revision_id, field_definition_version, value_revision_id, value_version,
      value_digest, value_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    attempt.generationAttemptId, attempt.tenantId, input.sequence, attempt.entityType, attempt.entityId,
    input.field_id, input.field_definition_revision_id, input.field_definition_version,
    input.value_revision_id, input.value_version, input.value_digest, canonicalJson(input.value),
    attempt.createdAt,
  );
}

async function attemptByIdempotency(env: AppEnv, tenantId: string, idempotencyKeyHash: string): Promise<DocumentGenerationAttempt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_attempts WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<AttemptRow>();
  return row ? attemptFromRow(row, await inputRows(env, row.generation_attempt_id)) : null;
}

async function attemptById(env: AppEnv, tenantId: string, attemptId: string): Promise<DocumentGenerationAttempt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_attempts WHERE tenant_id = ? AND generation_attempt_id = ? LIMIT 1`,
  ).bind(tenantId, attemptId).first<AttemptRow>();
  return row ? attemptFromRow(row, await inputRows(env, attemptId)) : null;
}

async function inputRows(env: AppEnv, attemptId: string): Promise<DocumentGenerationFieldSnapshot[]> {
  const rows = await env.DB.prepare(
    `SELECT input.*, definition.field_key, definition.label
       FROM document_generation_inputs input
       JOIN schema_field_definition_revisions definition
         ON definition.tenant_id = input.tenant_id
        AND definition.field_id = input.field_id
        AND definition.revision_id = input.field_definition_revision_id
      WHERE input.generation_attempt_id = ? ORDER BY input.sequence ASC`,
  ).bind(attemptId).all<InputRow>();
  return rows.results.map((row) => ({
    sequence: row.sequence, field_id: row.field_id, field_key: row.field_key ?? row.field_id, label: row.label ?? row.field_id,
    field_definition_revision_id: row.field_definition_revision_id,
    field_definition_version: row.field_definition_version, value_revision_id: row.value_revision_id,
    value_version: row.value_version, value_digest: row.value_digest, value: JSON.parse(row.value_json) as unknown,
  }));
}

function attemptFromRow(row: AttemptRow, inputs: DocumentGenerationFieldSnapshot[]): DocumentGenerationAttempt {
  return {
    generation_attempt_id: row.generation_attempt_id, tenant_id: row.tenant_id, entity_type: row.entity_type,
    entity_id: row.entity_id, template_id: row.template_id, template_revision_id: row.template_revision_id,
    template_version: row.template_version, external_effect_id: row.external_effect_id, provider: row.provider,
    authority_kind: row.authority_kind, actor_type: row.actor_type, actor_role: row.actor_role, actor_id: row.actor_id,
    authority_ref: row.authority_ref, policy_ref: row.policy_ref, policy_version: row.policy_version,
    permit_expires_at: row.permit_expires_at, max_attempts: row.max_attempts, stop_policy: row.stop_policy,
    compensation_policy: row.compensation_policy, input_count: row.input_count,
    input_snapshot_digest: row.input_snapshot_digest, output_digest: row.output_digest,
    command_fingerprint: row.command_fingerprint, idempotency_key_hash: row.idempotency_key_hash,
    created_at: row.created_at, inputs,
  };
}

function receiptValues(input: {
  receiptId: string; attempt: DocumentGenerationAttempt; receiptVersion: number; priorReceiptId: string | null;
  providerDocumentId: string | null; outputDigest: string; readbackDigest: string | null;
  readbackStatus: DocumentGenerationReadbackStatus; terminalStatus: DocumentGenerationTerminalStatus;
  reconciliationOutcome: DocumentGenerationReconciliationOutcome; authority: NormalizedGenerationAuthority;
  commandFingerprint: string; idempotencyKeyHash: string; createdAt: string;
}): unknown[] {
  const { attempt, authority } = input;
  return [
    input.receiptId, attempt.generation_attempt_id, input.receiptVersion, input.priorReceiptId,
    attempt.tenant_id, attempt.entity_type, attempt.entity_id, attempt.template_id,
    attempt.template_revision_id, attempt.template_version, attempt.input_snapshot_digest,
    attempt.external_effect_id, attempt.provider, input.providerDocumentId, input.outputDigest,
    input.readbackDigest, input.readbackStatus, input.terminalStatus, input.terminalStatus,
    input.reconciliationOutcome === "not_executed" || input.reconciliationOutcome === "manual_exception"
      ? input.reconciliationOutcome : null,
    authority.kind, authority.actor.type, authority.actor.role, authority.actor.userId,
    authority.authorityRef, authority.policyRef, authority.policyVersion, authority.permitExpiresAt,
    authority.maxAttempts, authority.stopPolicy, authority.compensationPolicy,
    input.commandFingerprint, input.idempotencyKeyHash, input.createdAt,
  ];
}

async function receiptByIdempotency(env: AppEnv, tenantId: string, idempotencyKeyHash: string): Promise<DocumentGenerationReceipt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_receipts WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<ReceiptRow>();
  return row ? receiptFromRow(row) : null;
}

async function receiptById(env: AppEnv, tenantId: string, receiptId: string): Promise<DocumentGenerationReceipt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_receipts WHERE tenant_id = ? AND receipt_id = ? LIMIT 1`,
  ).bind(tenantId, receiptId).first<ReceiptRow>();
  return row ? receiptFromRow(row) : null;
}

async function latestReceipt(env: AppEnv, tenantId: string, attemptId: string): Promise<DocumentGenerationReceipt | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_generation_receipts WHERE tenant_id = ? AND generation_attempt_id = ?
      ORDER BY receipt_version DESC LIMIT 1`,
  ).bind(tenantId, attemptId).first<ReceiptRow>();
  return row ? receiptFromRow(row) : null;
}

function receiptFromRow(row: ReceiptRow): DocumentGenerationReceipt {
  const { settled_outcome: settledOutcome, ...receipt } = row;
  return { ...receipt, reconciliation_outcome: settledOutcome ?? receipt.reconciliation_outcome };
}

async function attachAttempt(env: AppEnv, receipt: DocumentGenerationReceipt): Promise<DocumentGenerationReceipt> {
  return {
    ...receipt,
    attempt: (await attemptById(env, receipt.tenant_id, receipt.generation_attempt_id)) ?? undefined,
    template: (await getDocumentTemplateRevision(env, receipt.tenant_id, receipt.template_id, receipt.template_revision_id)) ?? undefined,
  };
}

async function terminalFingerprintForReplay(
  stored: DocumentGenerationReceipt,
  input: RecordDocumentGenerationTerminalInput,
): Promise<string> {
  const terminalStatus = terminalStatusValue(input.terminalStatus);
  const readbackStatus = input.readbackStatus === undefined || input.readbackStatus === null
    ? stored.readback_status : readbackStatusValue(input.readbackStatus);
  const providerDocumentId = input.providerDocumentId === undefined ? stored.provider_document_id : input.providerDocumentId;
  const outputDigest = input.outputDigest === undefined || input.outputDigest === null ? stored.output_digest : digest(input.outputDigest, "document_generation_output_invalid");
  const readbackDigest = input.readbackDigest === undefined || input.readbackDigest === null ? stored.readback_digest : digest(input.readbackDigest, "document_generation_readback_invalid");
  const authority = normalizeGenerationAuthority(input, {
    tenantId: stored.tenant_id, entityType: stored.entity_type, entityId: stored.entity_id, templateId: stored.template_id,
  }, input.now ?? new Date(), true);
  const attempt = stored.attempt ?? {
    generation_attempt_id: stored.generation_attempt_id, tenant_id: stored.tenant_id, entity_type: stored.entity_type,
    entity_id: stored.entity_id, template_id: stored.template_id, template_revision_id: stored.template_revision_id,
    template_version: stored.template_version, external_effect_id: stored.external_effect_id, provider: stored.provider,
    authority_kind: stored.authority_kind, actor_type: stored.actor_type, actor_role: stored.actor_role, actor_id: stored.actor_id,
    authority_ref: stored.authority_ref, policy_ref: stored.policy_ref, policy_version: stored.policy_version,
    permit_expires_at: stored.permit_expires_at, max_attempts: stored.max_attempts, stop_policy: stored.stop_policy,
    compensation_policy: stored.compensation_policy, input_count: 0, input_snapshot_digest: stored.input_snapshot_digest,
    output_digest: stored.output_digest, command_fingerprint: "", idempotency_key_hash: "", created_at: "", inputs: [],
  };
  const reconciliationOutcome = input.reconciliationOutcome === undefined || input.reconciliationOutcome === null
    ? stored.reconciliation_outcome : reconciliationOutcomeValue(input.reconciliationOutcome);
  const receiptId = input.receiptId ?? stored.receipt_id;
  return await sha256Hex(canonicalJson(terminalCommand({
    tenantId: stored.tenant_id, attemptId: stored.generation_attempt_id, receiptId, receiptVersion: stored.receipt_version,
    priorReceiptId: stored.prior_receipt_id, externalEffectId: input.externalEffectId ?? stored.external_effect_id,
    provider: input.provider ?? stored.provider, terminalStatus, reconciliationOutcome,
    readbackStatus, providerDocumentId: providerDocumentId === null ? null : boundedText(providerDocumentId, 1, 240, "document_generation_provider_document_invalid"),
    outputDigest, readbackDigest, authority, attempt,
  })));
}

function terminalCommand(input: {
  tenantId: string; attemptId: string; receiptId: string; receiptVersion: number; priorReceiptId: string | null;
  externalEffectId: string; provider: string; terminalStatus: DocumentGenerationTerminalStatus;
  reconciliationOutcome: DocumentGenerationReconciliationOutcome; readbackStatus: DocumentGenerationReadbackStatus;
  providerDocumentId: string | null; outputDigest: string; readbackDigest: string | null;
  authority: NormalizedGenerationAuthority; attempt: DocumentGenerationAttempt;
}): Record<string, unknown> {
  return {
    schema_version: RECEIPT_COMMAND_SCHEMA, tenant_id: input.tenantId,
    generation_attempt_id: input.attemptId, receipt_id: input.receiptId, receipt_version: input.receiptVersion,
    prior_receipt_id: input.priorReceiptId, external_effect_id: input.externalEffectId,
    provider: input.provider, terminal_status: input.terminalStatus,
    reconciliation_outcome: input.reconciliationOutcome, readback_status: input.readbackStatus,
    provider_document_id: input.providerDocumentId, output_digest: input.outputDigest,
    readback_digest: input.readbackDigest, authority: input.authority.command,
    input_snapshot_digest: input.attempt.input_snapshot_digest,
    template_revision_id: input.attempt.template_revision_id, template_version: input.attempt.template_version,
  };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  return canonicalJson(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function assertTemplateAuthority(actor: SchemaFieldActor, submittedActor?: SchemaFieldActor): void {
  const normalized = validateSchemaFieldActor(actor);
  if (normalized.role !== "owner" && normalized.role !== "ops") fail("document_template_forbidden");
  if (normalized.type === "worker" && !(typeof submittedActor?.authorityRef === "string" && submittedActor.authorityRef.trim()))
    fail("document_template_forbidden");
}

function boundedTenant(value: unknown): string {
  const result = boundedText(value, 2, 64, "document_template_tenant_invalid");
  if (!/^[a-z0-9-]+$/.test(result)) fail("document_template_tenant_invalid");
  return result;
}

function boundedKey(value: unknown, min: number, max: number, code: string): string {
  const result = boundedText(value, min, max, code);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) fail(code);
  return result;
}

function boundedId(value: unknown, min: number, max: number, code: string): string {
  return boundedKey(value, min, max, code);
}

function boundedText(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== "string") fail(code);
  const result = value.trim();
  if (result.length < min || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(code);
  return result;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(code);
  return value as T;
}

function actionValue(value: unknown): DocumentTemplateAction {
  return enumValue(value, DOCUMENT_TEMPLATE_ACTIONS, "document_template_action_invalid");
}

function terminalStatusValue(value: unknown): DocumentGenerationTerminalStatus {
  return enumValue(value, DOCUMENT_GENERATION_TERMINAL_STATUSES, "document_generation_terminal_invalid");
}

function reconciliationOutcomeValue(value: unknown): DocumentGenerationReconciliationOutcome {
  return enumValue(value, DOCUMENT_GENERATION_RECONCILIATION_OUTCOMES, "document_generation_terminal_invalid");
}

function readbackStatusValue(value: unknown): DocumentGenerationReadbackStatus {
  return enumValue(value, DOCUMENT_GENERATION_READBACK_STATUSES, "document_generation_readback_invalid");
}

function digest(value: unknown, code: string): string {
  const result = boundedText(value, 64, 64, code);
  if (!/^[0-9a-f]{64}$/.test(result)) fail(code);
  return result;
}

async function hashIdempotency(value: unknown): Promise<string> {
  const key = boundedKey(value, 8, 280, "document_generation_idempotency_invalid");
  return await sha256Hex(key);
}

function canonicalDateTime(value: unknown, code: string): string {
  const result = boundedText(value, 24, 24, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) fail(code);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) fail(code);
  return result;
}

function validNow(now: Date): string {
  const value = now.toISOString();
  if (!Number.isFinite(Date.parse(value))) fail("document_generation_time_invalid");
  return value;
}

function retentionRank(policy: SchemaRetentionPolicy): number {
  return policy === "legal_hold" ? 2 : policy === "extended" ? 1 : 0;
}

function errorCode(error: unknown): string | null {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/document_(?:template|generation)_[a-z_]+/)?.[0] ?? null;
}

function fail(code: string, detail: Readonly<Record<string, unknown>> = {}): never {
  throw new DocumentTemplatesError(code, detail);
}
