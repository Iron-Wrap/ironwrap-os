/** Governed schema fields (IRO-242 checkpoint 1).
 *
 * The database owns append-only history and monotonic heads.  This module owns the small closed
 * vocabulary and server-side authority/validation rules; it is intentionally not a form engine.
 */
import { ROLE_PERMISSIONS, type AppEnv, type AppRole } from "./app-types.ts";
import { entityExists, knownEntityType } from "./pipeline-board-store.ts";
import { listCurrentOperatingJobAssignments } from "./operating-job-assignment-store.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const SCHEMA_FIELD_TYPES = [
  "text", "integer", "number", "boolean", "date", "datetime", "select",
  "multiselect", "image", "attachment", "money", "provider_fact",
] as const;
export type SchemaFieldType = (typeof SCHEMA_FIELD_TYPES)[number];

export const SCHEMA_VALIDATORS = [
  "none", "required", "email", "phone", "nonnegative", "options", "range",
  "date", "datetime", "provider_receipt",
] as const;
export type SchemaValidator = (typeof SCHEMA_VALIDATORS)[number];

export const SCHEMA_VISIBILITY_RULES = [
  "always", "when_field_present", "when_field_equals",
] as const;
export type SchemaVisibilityRule = (typeof SCHEMA_VISIBILITY_RULES)[number];

export const SCHEMA_RETENTION_POLICIES = ["standard", "extended", "legal_hold"] as const;
export type SchemaRetentionPolicy = (typeof SCHEMA_RETENTION_POLICIES)[number];

export const SCHEMA_EVIDENCE_CLASSES = [
  "none", "source", "derived", "physical", "authority", "financial", "decision", "negative",
] as const;
export type SchemaEvidenceClass = (typeof SCHEMA_EVIDENCE_CLASSES)[number];

export const SCHEMA_OFFLINE_MODES = ["online_only", "queueable", "offline_read"] as const;
export type SchemaOfflineMode = (typeof SCHEMA_OFFLINE_MODES)[number];
export const SCHEMA_SCOPES = ["all", "assigned"] as const;
export type SchemaScope = (typeof SCHEMA_SCOPES)[number];
const SCHEMA_PROVENANCE_ACTORS = ["owner", "agent", "worker", "device", "external_authority"] as const;
const PROVIDER_READBACK_SCHEMA = "ironwrap.schema-field-provider-fact.v1";

const MAX_TEXT = 8_192;
const MAX_CONFIG_BYTES = 4_096;

export interface SchemaFieldActor {
  type: "owner" | "agent" | "worker";
  role: AppRole;
  userId: string;
  authorityRef?: string;
  identities?: readonly string[];
}

export interface SchemaFieldDefinitionInput {
  tenantId: string;
  fieldId?: string;
  entityType: string;
  fieldKey: string;
  label: string;
  position?: number;
  fieldType: unknown;
  validatorKey?: unknown;
  validatorConfig?: unknown;
  visibilityKey?: unknown;
  visibilityConfig?: unknown;
  evidenceClass?: unknown;
  retentionPolicy?: unknown;
  offlineMode?: unknown;
  readScope?: unknown;
  writeScope?: unknown;
  readRoles?: unknown;
  writeRoles?: unknown;
  active?: unknown;
  action?: unknown;
  expectedVersion?: unknown;
  actor: SchemaFieldActor;
  idempotencyKey: string;
}

interface NormalizedSchemaFieldDefinitionInput {
  tenantId: string;
  fieldId?: string;
  entityType: string;
  fieldKey: string;
  label: string;
  position: number;
  fieldType: SchemaFieldType;
  validatorKey: SchemaValidator;
  validatorConfig: Record<string, unknown>;
  visibilityKey: SchemaVisibilityRule;
  visibilityConfig: Record<string, unknown>;
  evidenceClass: SchemaEvidenceClass;
  retentionPolicy: SchemaRetentionPolicy;
  offlineMode: SchemaOfflineMode;
  readScope: SchemaScope;
  writeScope: SchemaScope;
  readRoles: string[];
  writeRoles: string[];
  active: boolean;
  action: SchemaFieldDefinition["action"];
  expectedVersion?: number;
  actor: SchemaFieldActor;
}

export interface SchemaFieldDefinition {
  field_id: string;
  tenant_id: string;
  entity_type: string;
  field_key: string;
  revision_id: string;
  version: number;
  prior_revision_id: string | null;
  action: "create" | "revise" | "relabel" | "reorder" | "retire";
  label: string;
  position: number;
  field_type: SchemaFieldType;
  validator_key: SchemaValidator;
  validator_config: Record<string, unknown>;
  visibility_key: SchemaVisibilityRule;
  visibility_config: Record<string, unknown>;
  evidence_class: SchemaEvidenceClass;
  retention_policy: SchemaRetentionPolicy;
  offline_mode: SchemaOfflineMode;
  read_scope: SchemaScope;
  write_scope: SchemaScope;
  read_roles: string[];
  write_roles: string[];
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

export interface RecordSchemaFieldValueInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  fieldId: string;
  fieldDefinitionRevisionId?: string | null;
  expectedVersion: number;
  value: unknown;
  basedOnValueRevisionId?: string | null;
  correctionReason?: string | null;
  sourceRef?: string | null;
  evidenceRef?: string | null;
  providerReceiptId?: string | null;
  actor: SchemaFieldActor;
  idempotencyKey: string;
}

/** Server-verified immutable object evidence. Browser routes never accept this shape directly. */
export interface VerifiedSchemaObjectEvidence {
  receiptId: string;
  objectRef: string;
  objectDigest: string;
  capturedAt: string;
  evidenceClass: Exclude<SchemaEvidenceClass, "none">;
}

export interface SchemaFieldValue {
  value_revision_id: string;
  tenant_id: string;
  value_head_id: string;
  entity_type: string;
  entity_id: string;
  field_id: string;
  field_definition_revision_id: string;
  version: number;
  prior_value_revision_id: string | null;
  based_on_value_revision_id: string | null;
  correction_reason: string | null;
  value: unknown;
  value_digest: string;
  provenance_actor_type: "owner" | "agent" | "worker" | "device" | "external_authority";
  provenance_actor_id: string;
  source_ref: string | null;
  evidence_ref: string | null;
  provider_receipt_id: string | null;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

export class SchemaFormsError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.name = "SchemaFormsError";
  }
}

interface FieldDefinitionRow {
  field_id: string;
  tenant_id: string;
  entity_type: string;
  field_key: string;
  revision_id: string;
  version: number;
  prior_revision_id: string | null;
  action: SchemaFieldDefinition["action"];
  label: string;
  position: number;
  field_type: SchemaFieldType;
  validator_key: SchemaValidator;
  validator_config_json: string;
  visibility_key: SchemaVisibilityRule;
  visibility_config_json: string;
  evidence_class: SchemaEvidenceClass;
  retention_policy: SchemaRetentionPolicy;
  offline_mode: SchemaOfflineMode;
  read_scope: SchemaScope;
  write_scope: SchemaScope;
  read_roles_json: string;
  write_roles_json: string;
  active: number;
  actor_type: SchemaFieldActor["type"];
  actor_role: string;
  actor_id: string;
  authority_ref: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  effective_at: string;
  created_at: string;
}

interface ValueRow {
  value_revision_id: string;
  tenant_id: string;
  value_head_id: string;
  entity_type: string;
  entity_id: string;
  field_id: string;
  field_definition_revision_id: string;
  version: number;
  prior_value_revision_id: string | null;
  based_on_value_revision_id: string | null;
  correction_reason: string | null;
  value_json: string;
  value_digest: string;
  provenance_actor_type: SchemaFieldValue["provenance_actor_type"];
  provenance_actor_id: string;
  source_ref: string | null;
  evidence_ref: string | null;
  provider_receipt_id: string | null;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

export function validateSchemaFieldActor(actor: SchemaFieldActor): SchemaFieldActor {
  if (!actor || !["owner", "agent", "worker"].includes(actor.type))
    fail("schema_field_actor_invalid");
  const role = typeof actor.role === "string" && Object.hasOwn(ROLE_PERMISSIONS, actor.role)
    ? actor.role as AppRole
    : null;
  const userId = text(actor.userId, 1, 160);
  if (!role || !userId) fail("schema_field_actor_invalid");
  const authorityRef = text(actor.authorityRef ?? `app:${userId}`, 1, 280) as string;
  const identities = [...new Set([
    userId.toLowerCase(),
    ...(actor.identities ?? []).filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase()),
  ])].slice(0, 5);
  return { type: actor.type, role, userId, authorityRef, identities };
}

export function normalizeFieldDefinitionInput(
  input: SchemaFieldDefinitionInput,
  defaults: Partial<SchemaFieldDefinition> = {},
): NormalizedSchemaFieldDefinitionInput {
  const actor = validateSchemaFieldActor(input.actor);
  const entityType = text(input.entityType, 1, 80);
  const fieldKey = text(input.fieldKey, 1, 120);
  const label = text(input.label, 1, 160);
  const tenantId = text(input.tenantId, 2, 64);
  if (!tenantId || !entityType || !fieldKey || !label || !/^[a-z0-9-]+$/.test(tenantId))
    fail("schema_field_definition_invalid");
  if (!/^[A-Za-z0-9._:-]+$/.test(entityType) || !/^[A-Za-z0-9._:-]+$/.test(fieldKey))
    fail("schema_field_definition_invalid");
  if (!knownEntityType(entityType)) fail("schema_field_entity_type_invalid");
  const fieldType = enumValue(input.fieldType ?? defaults.field_type, SCHEMA_FIELD_TYPES, "schema_field_type_invalid");
  const validatorKey = enumValue(input.validatorKey ?? defaults.validator_key ?? "none", SCHEMA_VALIDATORS, "schema_field_validator_invalid");
  const validatorConfig = objectConfig(input.validatorConfig ?? defaults.validator_config ?? {}, "schema_field_validator_config_invalid");
  const visibilityKey = enumValue(input.visibilityKey ?? defaults.visibility_key ?? "always", SCHEMA_VISIBILITY_RULES, "schema_field_visibility_invalid");
  const visibilityConfig = objectConfig(input.visibilityConfig ?? defaults.visibility_config ?? {}, "schema_field_visibility_config_invalid");
  validateValidatorConfig(validatorKey, validatorConfig);
  validateVisibilityConfig(visibilityKey, visibilityConfig);
  validateValidatorCompatibility(fieldType, validatorKey, validatorConfig);
  const evidenceClass = enumValue(input.evidenceClass ?? defaults.evidence_class ?? "none", SCHEMA_EVIDENCE_CLASSES, "schema_field_evidence_invalid");
  const retentionPolicy = enumValue(input.retentionPolicy ?? defaults.retention_policy ?? "standard", SCHEMA_RETENTION_POLICIES, "schema_field_retention_invalid");
  const offlineMode = enumValue(input.offlineMode ?? defaults.offline_mode ?? "online_only", SCHEMA_OFFLINE_MODES, "schema_field_offline_invalid");
  const readScope = enumValue(input.readScope ?? defaults.read_scope ?? "all", SCHEMA_SCOPES, "schema_field_read_scope_invalid");
  const writeScope = enumValue(input.writeScope ?? defaults.write_scope ?? "all", SCHEMA_SCOPES, "schema_field_write_scope_invalid");
  const readRoles = roles(input.readRoles ?? defaults.read_roles ?? ["owner", "ops"], "schema_field_read_roles_invalid");
  const writeRoles = roles(input.writeRoles ?? defaults.write_roles ?? ["owner", "ops"], "schema_field_write_roles_invalid");
  const action = enumValue(input.action ?? "create", ["create", "revise", "relabel", "reorder", "retire"] as const, "schema_field_action_invalid");
  const active = input.active === undefined ? action !== "retire" : input.active;
  if (typeof active !== "boolean") fail("schema_field_active_invalid");
  const position = integer(input.position ?? defaults.position ?? 0, 0, 1_000_000, "schema_field_position_invalid");
  const suppliedFieldId = input.fieldId ?? defaults.field_id;
  const fieldId = suppliedFieldId === undefined || suppliedFieldId === ""
    ? undefined
    : text(suppliedFieldId, 12, 200);
  if (suppliedFieldId !== undefined && suppliedFieldId !== "" &&
      (!fieldId || !/^[A-Za-z0-9._:-]+$/.test(fieldId)))
    fail("schema_field_id_invalid");
  const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null
    ? undefined
    : integer(input.expectedVersion, 0, 1_000_000, "schema_field_expected_version_invalid");
  if (action === "retire" && active) fail("schema_field_retire_invalid");
  const normalizedFieldId = fieldId ?? undefined;
  return {
    tenantId, fieldId: normalizedFieldId, entityType, fieldKey, label, position,
    fieldType, validatorKey, validatorConfig, visibilityKey, visibilityConfig,
    evidenceClass, retentionPolicy, offlineMode, readScope, writeScope,
    readRoles, writeRoles, active, action, expectedVersion, actor,
  };
}

export async function createSchemaFieldDefinition(
  env: AppEnv,
  input: SchemaFieldDefinitionInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; definition: SchemaFieldDefinition }> {
  const normalized = normalizeFieldDefinitionInput({ ...input, action: "create" });
  assertDefinitionAuthority(normalized.actor, input.actor);
  const nowIso = validNow(now);
  const command = definitionCommand(normalized);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey, "schema_field_idempotency_invalid");
  const commandFingerprint = await sha256Hex(canonicalJson(command));
  const replayed = await definitionByIdempotency(env, normalized.tenantId, idempotencyKeyHash, commandFingerprint);
  if (replayed) return { kind: "replayed", definition: replayed };
  const fieldId = normalized.fieldId ?? `field:${(await sha256Hex(canonicalJson({
    tenant_id: normalized.tenantId, entity_type: normalized.entityType, field_key: normalized.fieldKey,
  }))).slice(0, 40)}`;
  const revisionId = `fieldrev:${fieldId}:1`;
  try {
    const head = env.DB.prepare(
      `INSERT INTO schema_field_definition_heads
       (field_id, tenant_id, entity_type, field_key, current_revision_id, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
    ).bind(fieldId, normalized.tenantId, normalized.entityType, normalized.fieldKey, normalized.actor.userId, nowIso, nowIso);
    const revision = definitionRevisionStatement(env, {
      ...normalized,
      fieldId,
      revisionId,
      version: 1,
      priorRevisionId: null,
      commandFingerprint,
      idempotencyKeyHash,
      nowIso,
    });
    await env.DB.batch([head, revision]);
  } catch {
    const replay = await definitionByIdempotency(env, normalized.tenantId, idempotencyKeyHash);
    if (replay) {
      if (replay.command_fingerprint !== commandFingerprint) fail("schema_field_idempotency_conflict");
      return { kind: "replayed", definition: replay };
    }
    const existing = await getSchemaFieldDefinition(env, normalized.tenantId, fieldId);
    if (existing) throw new SchemaFormsError("schema_field_exists");
    throw new SchemaFormsError("schema_field_definition_write_failed");
  }
  const definition = await getSchemaFieldDefinition(env, normalized.tenantId, fieldId);
  if (!definition) throw new SchemaFormsError("schema_field_definition_write_failed");
  return { kind: "created", definition };
}

export async function reviseSchemaFieldDefinition(
  env: AppEnv,
  input: SchemaFieldDefinitionInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; definition: SchemaFieldDefinition }> {
  const fieldId = text(input.fieldId, 12, 200);
  if (!fieldId) fail("schema_field_id_invalid");
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey, "schema_field_idempotency_invalid");
  const stored = await definitionByIdempotency(env, input.tenantId, idempotencyKeyHash);
  if (stored) {
    const replayAction = input.action === undefined || input.action === null
      ? stored.action
      : enumValue(input.action, ["create", "revise", "relabel", "reorder", "retire"] as const, "schema_field_action_invalid");
    if (replayAction === "create") fail("schema_field_action_invalid");
    const replayNormalized = normalizeFieldDefinitionInput(
      definitionRevisionInput(input, stored, replayAction),
    );
    assertDefinitionAuthority(replayNormalized.actor, input.actor);
    const replayExpectedVersion = typeof input.expectedVersion === "number" && Number.isInteger(input.expectedVersion)
      ? input.expectedVersion
      : null;
    if (replayExpectedVersion === null) fail("schema_field_definition_version_conflict");
    const replayFingerprint = await sha256Hex(canonicalJson(definitionCommand(replayNormalized, replayExpectedVersion)));
    if (stored.command_fingerprint !== replayFingerprint) fail("schema_field_idempotency_conflict");
    return { kind: "replayed", definition: stored };
  }
  const current = await getSchemaFieldDefinition(env, input.tenantId, fieldId);
  if (!current) fail("schema_field_not_found");
  const action = input.action === undefined || input.action === null
    ? "revise" as const
    : enumValue(input.action, ["create", "revise", "relabel", "reorder", "retire"] as const, "schema_field_action_invalid");
  if (action === "create") fail("schema_field_action_invalid");
  const normalized = normalizeFieldDefinitionInput(definitionRevisionInput(input, current, action));
  assertDefinitionAuthority(normalized.actor, input.actor);
  const expectedVersion = input.expectedVersion;
  if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version)
    fail("schema_field_definition_version_conflict", { expected_version: expectedVersion, current_version: current.version });
  assertDefinitionAction(current, normalized);
  if (retentionRank(normalized.retentionPolicy) < retentionRank(current.retention_policy))
    fail("schema_field_retention_hold");
  const nowIso = validNow(now);
  const commandFingerprint = await sha256Hex(canonicalJson(definitionCommand(normalized, expectedVersion)));
  const replayed = await definitionByIdempotency(env, normalized.tenantId, idempotencyKeyHash, commandFingerprint);
  if (replayed) return { kind: "replayed", definition: replayed };
  const revisionId = `fieldrev:${fieldId}:${current.version + 1}`;
  try {
    await insertDefinitionRevision(env, {
      ...normalized,
      fieldId,
      revisionId,
      version: current.version + 1,
      priorRevisionId: current.revision_id,
      commandFingerprint,
      idempotencyKeyHash,
      nowIso,
    });
  } catch (error) {
    const existing = await definitionByIdempotency(env, normalized.tenantId, idempotencyKeyHash, commandFingerprint);
    if (existing) return { kind: "replayed", definition: existing };
    if (error instanceof SchemaFormsError) throw error;
    throw new SchemaFormsError("schema_field_definition_version_conflict", { current_version: (await getSchemaFieldDefinition(env, normalized.tenantId, fieldId))?.version });
  }
  const definition = await getSchemaFieldDefinition(env, normalized.tenantId, fieldId);
  if (!definition) throw new SchemaFormsError("schema_field_definition_write_failed");
  return { kind: "created", definition };
}

function definitionRevisionInput(
  input: SchemaFieldDefinitionInput,
  base: SchemaFieldDefinition,
  action: SchemaFieldDefinition["action"],
): SchemaFieldDefinitionInput {
  return {
    ...input,
    fieldId: input.fieldId ?? base.field_id,
    entityType: input.entityType ?? base.entity_type,
    fieldKey: input.fieldKey ?? base.field_key,
    label: input.label ?? base.label,
    position: input.position ?? base.position,
    fieldType: input.fieldType ?? base.field_type,
    validatorKey: input.validatorKey ?? base.validator_key,
    validatorConfig: input.validatorConfig ?? base.validator_config,
    visibilityKey: input.visibilityKey ?? base.visibility_key,
    visibilityConfig: input.visibilityConfig ?? base.visibility_config,
    evidenceClass: input.evidenceClass ?? base.evidence_class,
    retentionPolicy: input.retentionPolicy ?? base.retention_policy,
    offlineMode: input.offlineMode ?? base.offline_mode,
    readScope: input.readScope ?? base.read_scope,
    writeScope: input.writeScope ?? base.write_scope,
    readRoles: input.readRoles ?? base.read_roles,
    writeRoles: input.writeRoles ?? base.write_roles,
    active: input.active ?? (action === "retire" ? false : base.active),
    action,
  };
}

function assertDefinitionAction(
  current: SchemaFieldDefinition,
  normalized: NormalizedSchemaFieldDefinitionInput,
): void {
  if (!current.active) fail("schema_field_retired");
  if (normalized.fieldType !== current.field_type) fail("schema_field_type_immutable");
  if (normalized.action === "relabel") {
    if (normalized.label === current.label || definitionChangedOutside(current, normalized, "label"))
      fail("schema_field_action_invalid");
    return;
  }
  if (normalized.action === "reorder") {
    if (normalized.position === current.position || definitionChangedOutside(current, normalized, "position"))
      fail("schema_field_action_invalid");
    return;
  }
  if (normalized.action === "retire") {
    if (normalized.active || definitionChangedOutside(current, normalized, "active"))
      fail("schema_field_action_invalid");
    return;
  }
  if (!normalized.active) fail("schema_field_action_invalid");
}

function definitionChangedOutside(
  current: SchemaFieldDefinition,
  normalized: NormalizedSchemaFieldDefinitionInput,
  allowed: "label" | "position" | "active",
): boolean {
  return (allowed !== "label" && normalized.label !== current.label) ||
    (allowed !== "position" && normalized.position !== current.position) ||
    (allowed !== "active" && normalized.active !== current.active) ||
    normalized.entityType !== current.entity_type ||
    normalized.fieldKey !== current.field_key ||
    normalized.fieldType !== current.field_type ||
    normalized.validatorKey !== current.validator_key ||
    canonicalJson(normalized.validatorConfig) !== canonicalJson(current.validator_config) ||
    normalized.visibilityKey !== current.visibility_key ||
    canonicalJson(normalized.visibilityConfig) !== canonicalJson(current.visibility_config) ||
    normalized.evidenceClass !== current.evidence_class ||
    normalized.retentionPolicy !== current.retention_policy ||
    normalized.offlineMode !== current.offline_mode ||
    normalized.readScope !== current.read_scope ||
    normalized.writeScope !== current.write_scope ||
    canonicalJson(normalized.readRoles) !== canonicalJson(current.read_roles) ||
    canonicalJson(normalized.writeRoles) !== canonicalJson(current.write_roles);
}

export async function getSchemaFieldDefinition(
  env: AppEnv,
  tenantId: string,
  fieldId: string,
): Promise<SchemaFieldDefinition | null> {
  const row = await env.DB.prepare(
    `SELECT h.field_id, h.tenant_id, h.entity_type, h.field_key,
            r.revision_id, r.version, r.prior_revision_id, r.action, r.label, r.position,
            r.field_type, r.validator_key, r.validator_config_json,
            r.visibility_key, r.visibility_config_json, r.evidence_class, r.retention_policy,
            r.offline_mode, r.read_scope, r.write_scope, r.read_roles_json, r.write_roles_json,
            r.active, r.actor_type, r.actor_role, r.actor_id, r.authority_ref,
            r.command_fingerprint, r.idempotency_key_hash, r.effective_at, r.created_at
       FROM schema_field_definition_heads h
       JOIN schema_field_definition_revisions r
         ON r.tenant_id = h.tenant_id AND r.field_id = h.field_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.field_id = ? LIMIT 1`,
  ).bind(tenantId, fieldId).first<FieldDefinitionRow>();
  return row ? definitionFromRow(row) : null;
}

export async function listSchemaFieldDefinitions(
  env: AppEnv,
  tenantId: string,
  entityType?: string,
): Promise<SchemaFieldDefinition[]> {
  const rows = await env.DB.prepare(
    `SELECT h.field_id, h.tenant_id, h.entity_type, h.field_key,
            r.revision_id, r.version, r.prior_revision_id, r.action, r.label, r.position,
            r.field_type, r.validator_key, r.validator_config_json,
            r.visibility_key, r.visibility_config_json, r.evidence_class, r.retention_policy,
            r.offline_mode, r.read_scope, r.write_scope, r.read_roles_json, r.write_roles_json,
            r.active, r.actor_type, r.actor_role, r.actor_id, r.authority_ref,
            r.command_fingerprint, r.idempotency_key_hash, r.effective_at, r.created_at
       FROM schema_field_definition_heads h
       JOIN schema_field_definition_revisions r
         ON r.tenant_id = h.tenant_id AND r.field_id = h.field_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? ${entityType ? "AND h.entity_type = ?" : ""}
      ORDER BY h.entity_type ASC, r.position ASC, h.field_key ASC`,
  ).bind(...(entityType ? [tenantId, entityType] : [tenantId])).all<FieldDefinitionRow>();
  return rows.results.map(definitionFromRow);
}

export async function listSchemaFieldDefinitionRevisions(
  env: AppEnv,
  tenantId: string,
  fieldId: string,
): Promise<SchemaFieldDefinition[]> {
  const rows = await env.DB.prepare(
    `SELECT h.field_id, h.tenant_id, h.entity_type, h.field_key,
            r.revision_id, r.version, r.prior_revision_id, r.action, r.label, r.position,
            r.field_type, r.validator_key, r.validator_config_json,
            r.visibility_key, r.visibility_config_json, r.evidence_class, r.retention_policy,
            r.offline_mode, r.read_scope, r.write_scope, r.read_roles_json, r.write_roles_json,
            r.active, r.actor_type, r.actor_role, r.actor_id, r.authority_ref,
            r.command_fingerprint, r.idempotency_key_hash, r.effective_at, r.created_at
       FROM schema_field_definition_heads h
       JOIN schema_field_definition_revisions r
         ON r.tenant_id = h.tenant_id AND r.field_id = h.field_id
      WHERE h.tenant_id = ? AND h.field_id = ?
      ORDER BY r.version ASC`,
  ).bind(tenantId, fieldId).all<FieldDefinitionRow>();
  return rows.results.map(definitionFromRow);
}

export async function recordSchemaFieldValue(
  env: AppEnv,
  input: RecordSchemaFieldValueInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; value: SchemaFieldValue }> {
  return await recordSchemaFieldValueInternal(env, input, now);
}

/** Atomically append a server-verified object receipt and its attachment/image value. */
export async function recordVerifiedSchemaObjectFieldValue(
  env: AppEnv,
  input: RecordSchemaFieldValueInput,
  evidence: VerifiedSchemaObjectEvidence,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; value: SchemaFieldValue }> {
  return await recordSchemaFieldValueInternal(env, input, now, evidence);
}

async function recordSchemaFieldValueInternal(
  env: AppEnv,
  input: RecordSchemaFieldValueInput,
  now: Date,
  objectEvidence?: VerifiedSchemaObjectEvidence,
): Promise<{ kind: "created" | "replayed"; value: SchemaFieldValue }> {
  const tenantId = text(input.tenantId, 2, 64);
  const entityType = text(input.entityType, 1, 80);
  const entityId = text(input.entityId, 1, 200);
  const fieldId = text(input.fieldId, 12, 200);
  if (!tenantId || !entityType || !entityId || !fieldId || !/^[a-z0-9-]+$/.test(tenantId)) fail("schema_field_value_scope_invalid");
  const actor = validateSchemaFieldActor(input.actor);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey, "schema_field_value_idempotency_invalid");
  const existing = await valueByIdempotency(env, tenantId, idempotencyKeyHash);
  if (existing) {
    if (existing.entity_type !== entityType || existing.entity_id !== entityId || existing.field_id !== fieldId)
      fail("schema_field_idempotency_conflict");
    const replayField = await getSchemaFieldDefinitionRevision(env, tenantId, fieldId, existing.field_definition_revision_id);
    if (!replayField) fail("schema_field_definition_stale");
    const replayPrepared = await prepareValueCommand(
      env, input, replayField, { tenantId, entityType, entityId, fieldId }, actor, objectEvidence,
    );
    if (replayPrepared.commandFingerprint !== existing.command_fingerprint)
      fail("schema_field_idempotency_conflict");
    const currentField = await getSchemaFieldDefinition(env, tenantId, fieldId);
    if (!currentField) fail("schema_field_not_found");
    await assertValueWriteAuthority(env, currentField, tenantId, entityType, entityId, actor);
    return { kind: "replayed", value: existing };
  }
  const field = await getSchemaFieldDefinition(env, tenantId, fieldId);
  if (!field) fail("schema_field_not_found");
  const prepared = await prepareValueCommand(
    env, input, field, { tenantId, entityType, entityId, fieldId }, actor, objectEvidence,
  );
  const { definitionRevisionId, expectedVersion, basedOn, correctionReason, sourceRef,
    evidenceRef, providerReceiptId, normalizedValue, valueDigest, commandFingerprint } = prepared;
  if (definitionRevisionId !== field.revision_id) fail("schema_field_definition_stale");
  await assertValueWriteAuthority(env, field, tenantId, entityType, entityId, actor);
  const basedRow = basedOn ? await valueByIdScope(env, tenantId, basedOn, entityType, entityId, fieldId) : null;
  if (basedOn && !basedRow) fail("schema_field_lineage_invalid");
  const nowIso = validNow(now);
  const current = await currentValue(env, tenantId, entityType, entityId, fieldId);
  if ((current?.version ?? 0) !== expectedVersion)
    fail("schema_field_value_version_conflict", { expected_version: expectedVersion, current_version: current?.version ?? 0 });
  const valueHeadId = await schemaFieldValueHeadId(tenantId, entityType, entityId, fieldId);
  try {
    const valueRevisionId = `value:${commandFingerprint.slice(0, 48)}`;
    const revision = env.DB.prepare(
      `INSERT INTO schema_field_value_revisions
       (value_revision_id, tenant_id, value_head_id, entity_type, entity_id, field_id,
        field_definition_revision_id, version, prior_value_revision_id, based_on_value_revision_id,
        correction_reason, value_json, value_digest, provenance_actor_type, provenance_actor_id,
        source_ref, evidence_ref, provider_receipt_id, command_fingerprint, idempotency_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      valueRevisionId, tenantId, valueHeadId, entityType, entityId, fieldId,
      definitionRevisionId, expectedVersion + 1, current?.value_revision_id ?? null, basedOn,
      correctionReason, canonicalJson(normalizedValue), valueDigest,
      actor.type === "owner" ? "owner" : actor.type === "agent" ? "agent" : "worker", actor.userId,
      sourceRef, evidenceRef, providerReceiptId, commandFingerprint, idempotencyKeyHash, nowIso,
    );
    const head = env.DB.prepare(
      `INSERT OR IGNORE INTO schema_field_value_heads
       (value_head_id, tenant_id, entity_type, entity_id, field_id, current_revision_id, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    ).bind(valueHeadId, tenantId, entityType, entityId, fieldId, nowIso, nowIso);
    const statements = [head];
    if (objectEvidence) {
      statements.push(objectEvidenceStatement(
        env, { tenantId, entityType, entityId, fieldId }, field, expectedVersion + 1,
        actor, objectEvidence, nowIso,
      ));
    }
    statements.push(revision);
    await env.DB.batch(statements);
  } catch (error) {
    const replay = await valueByIdempotency(env, tenantId, idempotencyKeyHash);
    if (replay) {
      if (replay.command_fingerprint !== commandFingerprint) fail("schema_field_idempotency_conflict");
      return { kind: "replayed", value: replay };
    }
    const latest = await currentValue(env, tenantId, entityType, entityId, fieldId);
    if ((latest?.version ?? 0) !== expectedVersion)
      fail("schema_field_value_version_conflict", { expected_version: expectedVersion, current_version: latest?.version ?? 0 });
    if (error instanceof SchemaFormsError) throw error;
    throw new SchemaFormsError(errorCode(error) ?? "schema_field_value_write_failed");
  }
  const value = await valueByIdempotency(env, tenantId, idempotencyKeyHash);
  if (!value) throw new SchemaFormsError("schema_field_value_write_failed");
  return { kind: "created", value };
}

interface ValueScope {
  tenantId: string;
  entityType: string;
  entityId: string;
  fieldId: string;
}

interface PreparedValueCommand {
  definitionRevisionId: string;
  expectedVersion: number;
  basedOn: string | null;
  correctionReason: string | null;
  sourceRef: string | null;
  evidenceRef: string | null;
  providerReceiptId: string | null;
  normalizedValue: unknown;
  valueDigest: string;
  commandFingerprint: string;
}

interface ObjectEvidenceReceiptRow {
  receipt_id: string;
  object_ref: string;
  object_digest: string;
  actor_type: string;
  actor_id: string;
  captured_at: string;
  evidence_class: string;
}

interface ProviderEvidenceReceiptRow {
  receipt_id: string;
  provider_receipt_id: string;
  provider: string;
  provider_external_id: string;
  provider_action: string;
  provider_aggregate_type: string;
  provider_aggregate_id: string;
  provider_aggregate_version: number;
  expected_readback_schema: string;
  expected_value_digest: string;
  provider_version: string;
  readback_digest: string;
}

async function getSchemaFieldDefinitionRevision(
  env: AppEnv,
  tenantId: string,
  fieldId: string,
  revisionId: string,
): Promise<SchemaFieldDefinition | null> {
  const row = await env.DB.prepare(
    `SELECT h.field_id, h.tenant_id, h.entity_type, h.field_key,
            r.revision_id, r.version, r.prior_revision_id, r.action, r.label, r.position,
            r.field_type, r.validator_key, r.validator_config_json,
            r.visibility_key, r.visibility_config_json, r.evidence_class, r.retention_policy,
            r.offline_mode, r.read_scope, r.write_scope, r.read_roles_json, r.write_roles_json,
            r.active, r.actor_type, r.actor_role, r.actor_id, r.authority_ref,
            r.command_fingerprint, r.idempotency_key_hash, r.effective_at, r.created_at
       FROM schema_field_definition_revisions r
       JOIN schema_field_definition_heads h
         ON h.tenant_id = r.tenant_id AND h.field_id = r.field_id
      WHERE r.tenant_id = ? AND r.field_id = ? AND r.revision_id = ? LIMIT 1`,
  ).bind(tenantId, fieldId, revisionId).first<FieldDefinitionRow>();
  return row ? definitionFromRow(row) : null;
}

async function prepareValueCommand(
  env: AppEnv,
  input: RecordSchemaFieldValueInput,
  field: SchemaFieldDefinition,
  scope: ValueScope,
  actor: SchemaFieldActor,
  objectEvidence?: VerifiedSchemaObjectEvidence,
): Promise<PreparedValueCommand> {
  const definitionRevisionId = text(input.fieldDefinitionRevisionId ?? field.revision_id, 12, 220);
  if (!definitionRevisionId || !/^[A-Za-z0-9._:-]+$/.test(definitionRevisionId)) fail("schema_field_definition_stale");
  const expectedVersion = integer(input.expectedVersion, 0, 1_000_000, "schema_field_value_expected_version_invalid");
  const basedOn = nullableRevisionRef(input.basedOnValueRevisionId, "schema_field_lineage_invalid");
  const correctionReason = nullableText(input.correctionReason, "schema_field_correction_reason_invalid");
  if (basedOn !== null && correctionReason === null) fail("schema_field_correction_reason_required");
  if (correctionReason !== null && basedOn === null) fail("schema_field_correction_reference_required");
  if (basedOn && !(await valueByIdScope(env, scope.tenantId, basedOn, scope.entityType, scope.entityId, scope.fieldId)))
    fail("schema_field_lineage_invalid");
  const sourceRef = nullableRef(input.sourceRef, "schema_field_source_ref_invalid");
  const evidenceRef = nullableRef(input.evidenceRef, "schema_field_evidence_ref_invalid");
  const providerReceiptId = nullableRef(input.providerReceiptId, "schema_field_provider_receipt_invalid");
  const normalizedValue = validateFieldValue(field, input.value, scope);
  if (field.field_type === "provider_fact") {
    const providerFact = normalizedValue as Record<string, unknown>;
    if (!providerReceiptId || providerFact.receipt_id !== providerReceiptId)
      fail("schema_field_provider_receipt_required");
  } else if (providerReceiptId !== null) {
    fail("schema_field_provider_receipt_invalid");
  }
  const valueDigest = await sha256Hex(canonicalJson(normalizedValue));
  if (field.field_type === "image" || field.field_type === "attachment") {
    if (objectEvidence) {
      assertPendingObjectEvidence(scope, field, expectedVersion + 1, actor, normalizedValue, objectEvidence);
    } else {
      await assertObjectEvidenceReceipt(env, scope, field, expectedVersion + 1, normalizedValue);
    }
  } else if (objectEvidence) {
    fail("schema_field_object_receipt_invalid");
  }
  if (field.field_type === "provider_fact")
    await assertProviderEvidenceReceipt(env, scope, field, expectedVersion + 1, normalizedValue, valueDigest);
  const command = valueCommand({
    ...scope,
    fieldDefinitionRevisionId: definitionRevisionId,
    expectedVersion,
    value: normalizedValue,
    basedOn,
    correctionReason,
    sourceRef,
    evidenceRef,
    providerReceiptId,
    actor,
  });
  return {
    definitionRevisionId, expectedVersion, basedOn, correctionReason, sourceRef, evidenceRef,
    providerReceiptId, normalizedValue, valueDigest,
    commandFingerprint: await sha256Hex(canonicalJson(command)),
  };
}

function assertPendingObjectEvidence(
  scope: ValueScope,
  field: SchemaFieldDefinition,
  valueVersion: number,
  actor: SchemaFieldActor,
  value: unknown,
  evidence: VerifiedSchemaObjectEvidence,
): void {
  const record = value as Record<string, unknown>;
  if (field.evidence_class === "none" || evidence.evidenceClass !== field.evidence_class ||
      record.receipt_id !== evidence.receiptId || record.object_ref !== evidence.objectRef ||
      record.digest !== evidence.objectDigest || record.tenant_id !== scope.tenantId ||
      record.entity_type !== scope.entityType || record.entity_id !== scope.entityId ||
      record.field_id !== scope.fieldId || record.actor_type !== actor.type ||
      record.actor_id !== actor.userId || record.captured_at !== evidence.capturedAt ||
      record.evidence_class !== evidence.evidenceClass || valueVersion < 1)
    fail("schema_field_object_receipt_invalid");
}

function objectEvidenceStatement(
  env: AppEnv,
  scope: ValueScope,
  field: SchemaFieldDefinition,
  valueVersion: number,
  actor: SchemaFieldActor,
  evidence: VerifiedSchemaObjectEvidence,
  nowIso: string,
) {
  return env.DB.prepare(
    `INSERT INTO schema_field_evidence_receipts
     (receipt_id, tenant_id, entity_type, entity_id, field_id, field_definition_revision_id,
      value_version, evidence_kind, object_ref, object_digest, actor_type, actor_id,
      captured_at, evidence_class, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'object', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    evidence.receiptId, scope.tenantId, scope.entityType, scope.entityId, scope.fieldId,
    field.revision_id, valueVersion, evidence.objectRef, evidence.objectDigest,
    actor.type, actor.userId, evidence.capturedAt, evidence.evidenceClass, nowIso,
  );
}

async function assertValueWriteAuthority(
  env: AppEnv,
  field: SchemaFieldDefinition,
  tenantId: string,
  entityType: string,
  entityId: string,
  actor: SchemaFieldActor,
): Promise<void> {
  if (!field.active) fail("schema_field_retired");
  if (!knownEntityType(entityType) || !(await entityExists(env, tenantId, entityType, entityId)))
    fail("schema_field_entity_not_found");
  if (!field.write_roles.includes(actor.role) || !roleCanWriteField(entityType, actor.role))
    fail("schema_field_write_forbidden");
  if (!(await assignmentAllowed(env, field, tenantId, entityType, entityId, actor, "write")))
    fail("schema_field_assignment_forbidden");
  if (!(await fieldVisible(env, field, tenantId, entityType, entityId))) fail("schema_field_not_visible");
}

function valueCommand(input: {
  tenantId: string;
  entityType: string;
  entityId: string;
  fieldId: string;
  fieldDefinitionRevisionId: string;
  expectedVersion: number;
  value: unknown;
  basedOn: string | null;
  correctionReason: string | null;
  sourceRef: string | null;
  evidenceRef: string | null;
  providerReceiptId: string | null;
  actor: SchemaFieldActor;
}): Record<string, unknown> {
  return {
    schema_version: "ironwrap.schema-field-value.v1",
    tenant_id: input.tenantId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    field_id: input.fieldId,
    field_definition_revision_id: input.fieldDefinitionRevisionId,
    expected_version: input.expectedVersion,
    value: input.value,
    based_on_value_revision_id: input.basedOn,
    correction_reason: input.correctionReason,
    source_ref: input.sourceRef,
    evidence_ref: input.evidenceRef,
    provider_receipt_id: input.providerReceiptId,
    actor: { type: input.actor.type, role: input.actor.role, id: input.actor.userId, authority_ref: input.actor.authorityRef },
  };
}

async function schemaFieldValueHeadId(
  tenantId: string,
  entityType: string,
  entityId: string,
  fieldId: string,
): Promise<string> {
  return `value-head:${(await sha256Hex(canonicalJson({ tenantId, entityType, entityId, fieldId }))).slice(0, 40)}`;
}

async function assertObjectEvidenceReceipt(
  env: AppEnv,
  scope: ValueScope,
  field: SchemaFieldDefinition,
  valueVersion: number,
  value: unknown,
): Promise<void> {
  const record = value as Record<string, unknown>;
  let row: ObjectEvidenceReceiptRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT receipt.receipt_id, receipt.object_ref, receipt.object_digest,
              receipt.actor_type, receipt.actor_id, receipt.captured_at, receipt.evidence_class
         FROM schema_field_evidence_receipts receipt
        WHERE receipt.tenant_id = ? AND receipt.receipt_id = ? AND receipt.evidence_kind = 'object'
          AND receipt.entity_type = ? AND receipt.entity_id = ? AND receipt.field_id = ?
          AND receipt.field_definition_revision_id = ? AND receipt.value_version = ?
        LIMIT 1`,
    ).bind(
      scope.tenantId, record.receipt_id, scope.entityType, scope.entityId, scope.fieldId,
      field.revision_id, valueVersion,
    ).first<ObjectEvidenceReceiptRow>();
  } catch {
    fail("schema_field_evidence_receipt_unavailable");
  }
  if (!row || row.object_ref !== record.object_ref || row.object_digest !== record.digest ||
      row.actor_type !== record.actor_type || row.actor_id !== record.actor_id ||
      row.captured_at !== record.captured_at || row.evidence_class !== record.evidence_class)
    fail("schema_field_object_receipt_required");
}

async function assertProviderEvidenceReceipt(
  env: AppEnv,
  scope: ValueScope,
  field: SchemaFieldDefinition,
  valueVersion: number,
  value: unknown,
  valueDigest: string,
): Promise<void> {
  const record = value as Record<string, unknown>;
  let row: ProviderEvidenceReceiptRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT receipt.receipt_id, receipt.provider_receipt_id, receipt.provider,
              receipt.provider_external_id, receipt.provider_action, receipt.provider_aggregate_type,
              receipt.provider_aggregate_id, receipt.provider_aggregate_version,
              receipt.expected_readback_schema, receipt.expected_value_digest,
              receipt.provider_version, receipt.readback_digest
         FROM schema_field_evidence_receipts receipt
         JOIN external_effects effect
           ON effect.tenant_id = receipt.tenant_id AND effect.effect_id = receipt.provider_receipt_id
          AND effect.state = 'succeeded'
        WHERE receipt.tenant_id = ? AND receipt.receipt_id = ? AND receipt.evidence_kind = 'provider_fact'
          AND receipt.entity_type = ? AND receipt.entity_id = ? AND receipt.field_id = ?
          AND receipt.field_definition_revision_id = ? AND receipt.value_version = ?
        LIMIT 1`,
    ).bind(
      scope.tenantId, record.receipt_id, scope.entityType, scope.entityId, scope.fieldId,
      field.revision_id, valueVersion,
    ).first<ProviderEvidenceReceiptRow>();
  } catch {
    fail("schema_field_provider_receipt_unavailable");
  }
  if (!row || row.receipt_id !== record.receipt_id || row.provider_receipt_id !== record.receipt_id ||
      row.provider !== record.provider || row.provider_external_id !== record.provider_external_id ||
      row.provider_action !== record.action || row.provider_aggregate_type !== record.aggregate_type ||
      row.provider_aggregate_id !== record.aggregate_id || row.provider_aggregate_version !== record.aggregate_version ||
      row.expected_readback_schema !== record.expected_readback_schema || row.expected_value_digest !== valueDigest ||
      row.provider_version !== record.provider_version || row.readback_digest !== record.readback_digest ||
      record.field_definition_revision_id !== field.revision_id || record.value_version !== valueVersion ||
      record.entity_type !== scope.entityType || record.entity_id !== scope.entityId || record.field_id !== scope.fieldId)
    fail("schema_field_provider_receipt_required");
}

/**
 * The record-level half of the read gate: may this actor read THIS record at all, before any
 * per-field decision is taken.  `listAuthorizedSchemaFieldValues` applies it and then narrows
 * field by field; a reader that fails here is told nothing about the record, which is why the
 * routes above it answer 404 rather than 403.
 *
 * It exists as its own export so a second record-scoped read cannot invent a parallel authority
 * vocabulary: `GET /api/v1/documents/:entityType/:entityId` publishes an administrator's document
 * LAYOUT to whoever may already read the record, and calls exactly this.  Per-field authority is
 * deliberately NOT part of it - a layout binding a field the reader may not see still reaches
 * them, and the value is simply absent from their record read.
 */
export async function recordReadableByActor(
  env: AppEnv,
  tenantId: string,
  entityType: string,
  entityId: string,
  actor: SchemaFieldActor,
): Promise<boolean> {
  if (!knownEntityType(entityType) || !roleCanReadField(entityType, validateSchemaFieldActor(actor).role))
    return false;
  return await entityExists(env, tenantId, entityType, entityId);
}

export async function listAuthorizedSchemaFieldValues(
  env: AppEnv,
  tenantId: string,
  entityType: string,
  entityId: string,
  actor: SchemaFieldActor,
): Promise<Array<{ definition: SchemaFieldDefinition; value: SchemaFieldValue | null }>> {
  const normalizedActor = validateSchemaFieldActor(actor);
  if (!(await recordReadableByActor(env, tenantId, entityType, entityId, normalizedActor))) return [];
  const definitions = await listSchemaFieldDefinitions(env, tenantId, entityType);
  const authorized: Array<{ definition: SchemaFieldDefinition; value: SchemaFieldValue | null }> = [];
  for (const definition of definitions) {
    if (!definition.active || !definition.read_roles.includes(normalizedActor.role)) continue;
    if (!(await assignmentAllowed(env, definition, tenantId, entityType, entityId, normalizedActor, "read"))) continue;
    if (!(await fieldVisible(env, definition, tenantId, entityType, entityId))) continue;
    authorized.push({
      definition,
      value: await currentValue(env, tenantId, entityType, entityId, definition.field_id),
    });
  }
  return authorized;
}

export async function listSchemaFieldValueRevisions(
  env: AppEnv,
  tenantId: string,
  entityType: string,
  entityId: string,
  fieldId: string,
  actor: SchemaFieldActor,
): Promise<SchemaFieldValue[]> {
  const normalizedActor = validateSchemaFieldActor(actor);
  const field = await getSchemaFieldDefinition(env, tenantId, fieldId);
  if (!field || !field.read_roles.includes(normalizedActor.role) ||
      !roleCanReadField(entityType, normalizedActor.role)) return [];
  if (!knownEntityType(entityType) || !(await entityExists(env, tenantId, entityType, entityId))) return [];
  if (!(await assignmentAllowed(env, field, tenantId, entityType, entityId, normalizedActor, "read"))) return [];
  if (!(await fieldVisible(env, field, tenantId, entityType, entityId))) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM schema_field_value_revisions
      WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ?
      ORDER BY version ASC`,
  ).bind(tenantId, entityType, entityId, fieldId).all<ValueRow>();
  return rows.results.map(valueFromRow);
}

async function insertDefinitionRevision(
  env: AppEnv,
  input: NormalizedSchemaFieldDefinitionInput & {
    fieldId: string; revisionId: string; version: number; priorRevisionId: string | null;
    commandFingerprint: string; idempotencyKeyHash: string; nowIso: string;
  },
): Promise<void> {
  await definitionRevisionStatement(env, input).run();
}

function definitionRevisionStatement(
  env: AppEnv,
  input: NormalizedSchemaFieldDefinitionInput & {
    fieldId: string; revisionId: string; version: number; priorRevisionId: string | null;
    commandFingerprint: string; idempotencyKeyHash: string; nowIso: string;
  },
) {
  return env.DB.prepare(
    `INSERT INTO schema_field_definition_revisions
     (revision_id, tenant_id, field_id, version, prior_revision_id, action, entity_type, field_key,
      label, position, field_type, validator_key, validator_config_json, visibility_key,
      visibility_config_json, evidence_class, retention_policy, offline_mode, read_scope, write_scope,
      read_roles_json, write_roles_json, active, actor_type, actor_role, actor_id, authority_ref,
      command_fingerprint, idempotency_key_hash, effective_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.revisionId, input.tenantId, input.fieldId, input.version, input.priorRevisionId, input.action,
    input.entityType, input.fieldKey, input.label, input.position, input.fieldType, input.validatorKey,
    canonicalJson(input.validatorConfig), input.visibilityKey, canonicalJson(input.visibilityConfig),
    input.evidenceClass, input.retentionPolicy, input.offlineMode, input.readScope, input.writeScope,
    canonicalJson(input.readRoles), canonicalJson(input.writeRoles), input.active ? 1 : 0,
    input.actor.type, input.actor.role, input.actor.userId, input.actor.authorityRef,
    input.commandFingerprint, input.idempotencyKeyHash, input.nowIso, input.nowIso,
  );
}

async function definitionByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
  commandFingerprint?: string,
): Promise<SchemaFieldDefinition | null> {
  const row = await env.DB.prepare(
    `SELECT h.field_id, h.tenant_id, h.entity_type, h.field_key,
            r.revision_id, r.version, r.prior_revision_id, r.action, r.label, r.position,
            r.field_type, r.validator_key, r.validator_config_json,
            r.visibility_key, r.visibility_config_json, r.evidence_class, r.retention_policy,
            r.offline_mode, r.read_scope, r.write_scope, r.read_roles_json, r.write_roles_json,
            r.active, r.actor_type, r.actor_role, r.actor_id, r.authority_ref,
            r.command_fingerprint, r.idempotency_key_hash, r.effective_at, r.created_at
       FROM schema_field_definition_revisions r
       JOIN schema_field_definition_heads h
         ON h.tenant_id = r.tenant_id AND h.field_id = r.field_id
      WHERE r.tenant_id = ? AND r.idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<FieldDefinitionRow>();
  if (!row) return null;
  if (commandFingerprint && row.command_fingerprint !== commandFingerprint)
    fail("schema_field_idempotency_conflict");
  return definitionFromRow(row);
}

async function currentValue(
  env: AppEnv,
  tenantId: string,
  entityType: string,
  entityId: string,
  fieldId: string,
): Promise<SchemaFieldValue | null> {
  const row = await env.DB.prepare(
    `SELECT r.* FROM schema_field_value_heads h
       JOIN schema_field_value_revisions r
         ON r.tenant_id = h.tenant_id AND r.value_revision_id = h.current_revision_id
        AND r.entity_type = h.entity_type AND r.entity_id = h.entity_id AND r.field_id = h.field_id
      WHERE h.tenant_id = ? AND h.entity_type = ? AND h.entity_id = ? AND h.field_id = ? LIMIT 1`,
  ).bind(tenantId, entityType, entityId, fieldId).first<ValueRow>();
  return row ? valueFromRow(row) : null;
}

async function valueByIdScope(
  env: AppEnv,
  tenantId: string,
  valueRevisionId: string,
  entityType: string,
  entityId: string,
  fieldId: string,
): Promise<SchemaFieldValue | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM schema_field_value_revisions
      WHERE tenant_id = ? AND value_revision_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ? LIMIT 1`,
  ).bind(tenantId, valueRevisionId, entityType, entityId, fieldId).first<ValueRow>();
  return row ? valueFromRow(row) : null;
}

async function valueByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<SchemaFieldValue | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM schema_field_value_revisions
      WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<ValueRow>();
  return row ? valueFromRow(row) : null;
}

async function assignmentAllowed(
  env: AppEnv,
  field: SchemaFieldDefinition,
  tenantId: string,
  entityType: string,
  entityId: string,
  actor: SchemaFieldActor,
  action: "read" | "write",
): Promise<boolean> {
  const scope = action === "read" ? field.read_scope : field.write_scope;
  const permissions = ROLE_PERMISSIONS[actor.role];
  const platformAssignment = action === "read"
    ? entityType === "job" && permissions.includes("jobs:read:assigned") && !permissions.includes("jobs:read:any")
    : permissions.includes("field:write:assigned");
  if (scope !== "assigned" && !platformAssignment) return true;
  if (entityType !== "job") return false;
  const identities = actor.identities?.length ? actor.identities : [actor.userId];
  const assignments = await listCurrentOperatingJobAssignments(env, tenantId, {
    roofJobId: entityId,
    actorUsers: identities,
  });
  return assignments.length > 0;
}

function roleCanReadField(entityType: string, role: AppRole): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  if (entityType === "job")
    return permissions.includes("jobs:read:any") || permissions.includes("jobs:read:assigned");
  if (entityType === "lead") return permissions.includes("sales:read") || permissions.includes("owner:read");
  return false;
}

function roleCanWriteField(entityType: string, role: AppRole): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  if (role === "owner") return true;
  if (role === "ops") return permissions.includes("authority:write");
  return entityType === "job" && role === "field" && permissions.includes("field:write:assigned");
}

async function fieldVisible(
  env: AppEnv,
  field: SchemaFieldDefinition,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (field.visibility_key === "always") return true;
  const definitions = await listSchemaFieldDefinitions(env, tenantId, entityType);
  const controllingKey = typeof field.visibility_config.field_key === "string"
    ? field.visibility_config.field_key
    : null;
  if (!controllingKey) return false;
  const controlling = definitions.find((definition) => definition.field_key === controllingKey);
  if (!controlling) return false;
  const value = await currentValue(env, tenantId, entityType, entityId, controlling.field_id);
  if (field.visibility_key === "when_field_present") return value?.value !== null && value?.value !== undefined && value.value !== "";
  return value?.value === field.visibility_config.value;
}

function definitionCommand(
  input: NormalizedSchemaFieldDefinitionInput,
  expectedVersion?: number,
): Record<string, unknown> {
  return {
    schema_version: "ironwrap.schema-field-definition.v1",
    tenant_id: input.tenantId,
    field_id: input.fieldId ?? null,
    entity_type: input.entityType,
    field_key: input.fieldKey,
    label: input.label,
    position: input.position,
    field_type: input.fieldType,
    validator_key: input.validatorKey,
    validator_config: input.validatorConfig,
    visibility_key: input.visibilityKey,
    visibility_config: input.visibilityConfig,
    evidence_class: input.evidenceClass,
    retention_policy: input.retentionPolicy,
    offline_mode: input.offlineMode,
    read_scope: input.readScope,
    write_scope: input.writeScope,
    read_roles: input.readRoles,
    write_roles: input.writeRoles,
    active: input.active,
    action: input.action,
    expected_version: expectedVersion ?? null,
    actor: {
      type: input.actor.type,
      role: input.actor.role,
      id: input.actor.userId,
      authority_ref: input.actor.authorityRef,
    },
  };
}

function assertDefinitionAuthority(actor: SchemaFieldActor, submittedActor?: SchemaFieldActor): void {
  const roleAllowed = actor.role === "owner" || actor.role === "ops";
  const workerHasDelegatedAuthority = actor.type !== "worker" ||
    (typeof submittedActor?.authorityRef === "string" && submittedActor.authorityRef.trim().length > 0);
  if (!roleAllowed || !workerHasDelegatedAuthority)
    fail("schema_field_definition_forbidden");
}

function validateFieldValue(
  field: SchemaFieldDefinition,
  value: unknown,
  scope?: { tenantId: string; entityType: string; entityId: string; fieldId: string },
): unknown {
  if (value === undefined) fail("schema_field_value_invalid");
  if (value === null) {
    if (field.validator_key === "required") fail("schema_field_required");
    return null;
  }
  switch (field.field_type) {
    case "text":
      if (typeof value !== "string" || value.length > MAX_TEXT) fail("schema_field_value_type_invalid");
      break;
    case "integer":
    case "money":
      if (!Number.isSafeInteger(value)) fail("schema_field_value_type_invalid");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("schema_field_value_type_invalid");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail("schema_field_value_type_invalid");
      break;
    case "date":
      if (!isCanonicalIsoDate(value)) fail("schema_field_value_type_invalid");
      break;
    case "datetime":
      if (!isCanonicalIsoDateTime(value)) fail("schema_field_value_type_invalid");
      break;
    case "select":
      if (typeof value !== "string" || value.length > 240) fail("schema_field_value_type_invalid");
      break;
    case "multiselect":
      if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || entry.length > 240) || new Set(value).size !== value.length) fail("schema_field_value_type_invalid");
      break;
    case "image":
    case "attachment":
      validateImmutableObjectReference(value, field.field_type, scope);
      break;
    case "provider_fact":
      validateProviderFact(value, scope);
      break;
  }
  applyValidator(field.validator_key, field.validator_config, value);
  return value;
}

function validateImmutableObjectReference(
  value: unknown,
  type: string,
  scope?: { tenantId: string; entityType: string; entityId: string; fieldId: string },
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("schema_field_object_reference_invalid");
  const record = value as Record<string, unknown>;
  const objectRef = text(record.object_ref, 3, 280);
  const digest = record.digest;
  const receiptId = text(record.receipt_id, 12, 220);
  const tenantId = text(record.tenant_id, 2, 64);
  const entityType = text(record.entity_type, 1, 80);
  const entityId = text(record.entity_id, 1, 200);
  const fieldId = text(record.field_id, 12, 200);
  const actorType = record.actor_type;
  const actorId = text(record.actor_id, 1, 160);
  const capturedAt = record.captured_at;
  const evidenceClass = record.evidence_class;
  if (!objectRef || /^https?:\/\//i.test(objectRef) || !/^[A-Za-z0-9._:/-]+$/.test(objectRef) ||
      typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !receiptId || !tenantId || !entityType || !entityId || !fieldId ||
      !SCHEMA_PROVENANCE_ACTORS.includes(actorType as typeof SCHEMA_PROVENANCE_ACTORS[number]) || !actorId ||
      !isCanonicalIsoDateTime(capturedAt) ||
      !SCHEMA_EVIDENCE_CLASSES.includes(evidenceClass as SchemaEvidenceClass) || evidenceClass === "none") {
    fail(`schema_field_${type}_reference_invalid`);
  }
  if (scope && (tenantId !== scope.tenantId || entityType !== scope.entityType ||
      entityId !== scope.entityId || fieldId !== scope.fieldId))
    fail(`schema_field_${type}_reference_scope_invalid`);
}

function validateProviderFact(
  value: unknown,
  scope?: { tenantId: string; entityType: string; entityId: string; fieldId: string },
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("schema_field_provider_fact_invalid");
  const record = value as Record<string, unknown>;
  if (record.status !== "succeeded" || !text(record.provider, 1, 120) || !text(record.receipt_id, 12, 220) ||
      !text(record.provider_version, 1, 120) || !text(record.provider_external_id, 1, 220) ||
      record.action !== "schema_field.provider_fact.read" || record.aggregate_type !== "schema_field_value" ||
      !text(record.aggregate_id, 1, 160) || !Number.isSafeInteger(record.aggregate_version) ||
      record.expected_readback_schema !== PROVIDER_READBACK_SCHEMA || !text(record.field_definition_revision_id, 12, 220) ||
      record.value_version !== record.aggregate_version || typeof record.readback_digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.readback_digest as string)) fail("schema_field_provider_receipt_required");
  if (scope && (record.tenant_id !== scope.tenantId || record.entity_type !== scope.entityType ||
      record.entity_id !== scope.entityId || record.field_id !== scope.fieldId))
    fail("schema_field_provider_scope_invalid");
}

function applyValidator(key: SchemaValidator, config: Record<string, unknown>, value: unknown): void {
  if (key === "required" && (value === null || value === "" || (Array.isArray(value) && value.length === 0))) fail("schema_field_required");
  if (key === "email" && (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) fail("schema_field_email_invalid");
  if (key === "phone" && (typeof value !== "string" || !/^[+()0-9 .-]{7,32}$/.test(value))) fail("schema_field_phone_invalid");
  if (key === "nonnegative" && (typeof value !== "number" && typeof value !== "bigint" || Number(value) < 0)) fail("schema_field_nonnegative_invalid");
  if (key === "options") {
    const options = config.options;
    const values = Array.isArray(value) ? value : [value];
    if (!Array.isArray(options) || values.some((entry) => !options.includes(entry))) fail("schema_field_option_invalid");
  }
  if (key === "range") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || (config.min !== undefined && numeric < Number(config.min)) || (config.max !== undefined && numeric > Number(config.max))) fail("schema_field_range_invalid");
  }
  if (key === "date" && !isCanonicalIsoDate(value)) fail("schema_field_date_invalid");
  if (key === "datetime" && !isCanonicalIsoDateTime(value)) fail("schema_field_datetime_invalid");
  if (key === "provider_receipt") validateProviderFact(value);
}

function validateValidatorConfig(key: SchemaValidator, config: Record<string, unknown>): void {
  const allowed: Record<SchemaValidator, readonly string[]> = {
    none: [], required: [], email: [], phone: [], nonnegative: [], options: ["options"],
    range: ["min", "max"], date: [], datetime: [], provider_receipt: [],
  };
  if (Object.keys(config).some((name) => !allowed[key].includes(name))) fail("schema_field_validator_config_invalid");
  if (key === "options" && (!Array.isArray(config.options) || config.options.length < 1 || config.options.length > 200 ||
      config.options.some((value) => typeof value !== "string" || value.length < 1 || value.length > 240) ||
      new Set(config.options).size !== config.options.length)) fail("schema_field_validator_config_invalid");
  if (key === "range" && Object.keys(config).every((name) => name !== "min" && name !== "max")) fail("schema_field_validator_config_invalid");
  if (key === "range" && Object.values(config).some((value) => typeof value !== "number" || !Number.isFinite(value))) fail("schema_field_validator_config_invalid");
  if (key === "range" && config.min !== undefined && config.max !== undefined && Number(config.min) > Number(config.max)) fail("schema_field_validator_config_invalid");
}

function validateValidatorCompatibility(
  fieldType: SchemaFieldType,
  validatorKey: SchemaValidator,
  validatorConfig: Record<string, unknown>,
): void {
  const compatible: Partial<Record<SchemaValidator, readonly SchemaFieldType[]>> = {
    email: ["text"],
    phone: ["text"],
    nonnegative: ["integer", "number", "money"],
    options: ["select", "multiselect"],
    range: ["integer", "number", "money"],
    date: ["date"],
    datetime: ["datetime"],
    provider_receipt: ["provider_fact"],
  };
  const types = compatible[validatorKey];
  if (types && !types.includes(fieldType)) fail("schema_field_validator_config_invalid");
  if ((fieldType === "select" || fieldType === "multiselect") &&
      (validatorKey !== "options" || !Array.isArray(validatorConfig.options) || validatorConfig.options.length < 1))
    fail("schema_field_validator_config_invalid");
}

function validateVisibilityConfig(key: SchemaVisibilityRule, config: Record<string, unknown>): void {
  const keys = Object.keys(config);
  if (key === "always" && keys.length > 0) fail("schema_field_visibility_config_invalid");
  if (key === "when_field_present" &&
      (!text(config.field_key, 1, 120) || !/^[A-Za-z0-9._:-]+$/.test(config.field_key as string) ||
        keys.some((name) => name !== "field_key")))
    fail("schema_field_visibility_config_invalid");
  if (key === "when_field_equals" &&
      (!text(config.field_key, 1, 120) || !/^[A-Za-z0-9._:-]+$/.test(config.field_key as string) ||
        keys.some((name) => !["field_key", "value"].includes(name)) ||
        !("value" in config) || (config.value !== null && typeof config.value === "object")))
    fail("schema_field_visibility_config_invalid");
}

function retentionRank(policy: SchemaRetentionPolicy): number {
  return policy === "legal_hold" ? 2 : policy === "extended" ? 1 : 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function definitionFromRow(row: FieldDefinitionRow): SchemaFieldDefinition {
  return {
    field_id: row.field_id, tenant_id: row.tenant_id, entity_type: row.entity_type, field_key: row.field_key,
    revision_id: row.revision_id, version: row.version, prior_revision_id: row.prior_revision_id, action: row.action,
    label: row.label, position: row.position, field_type: row.field_type, validator_key: row.validator_key,
    validator_config: parseObject(row.validator_config_json), visibility_key: row.visibility_key,
    visibility_config: parseObject(row.visibility_config_json), evidence_class: row.evidence_class,
    retention_policy: row.retention_policy, offline_mode: row.offline_mode, read_scope: row.read_scope,
    write_scope: row.write_scope, read_roles: parseStringArray(row.read_roles_json), write_roles: parseStringArray(row.write_roles_json),
    active: row.active === 1, actor_type: row.actor_type, actor_role: row.actor_role as AppRole, actor_id: row.actor_id,
    authority_ref: row.authority_ref, command_fingerprint: row.command_fingerprint,
    idempotency_key_hash: row.idempotency_key_hash, effective_at: row.effective_at, created_at: row.created_at,
  };
}

function valueFromRow(row: ValueRow): SchemaFieldValue {
  return {
    value_revision_id: row.value_revision_id, tenant_id: row.tenant_id, value_head_id: row.value_head_id,
    entity_type: row.entity_type, entity_id: row.entity_id, field_id: row.field_id,
    field_definition_revision_id: row.field_definition_revision_id, version: row.version,
    prior_value_revision_id: row.prior_value_revision_id, based_on_value_revision_id: row.based_on_value_revision_id,
    correction_reason: row.correction_reason, value: JSON.parse(row.value_json) as unknown, value_digest: row.value_digest,
    provenance_actor_type: row.provenance_actor_type, provenance_actor_id: row.provenance_actor_id,
    source_ref: row.source_ref, evidence_ref: row.evidence_ref, provider_receipt_id: row.provider_receipt_id,
    command_fingerprint: row.command_fingerprint, idempotency_key_hash: row.idempotency_key_hash, created_at: row.created_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function objectConfig(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const json = canonicalJson(value);
  if (json.length > MAX_CONFIG_BYTES) fail(code);
  return value as Record<string, unknown>;
}

function roles(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6 || value.some((entry) => typeof entry !== "string" || !Object.hasOwn(ROLE_PERMISSIONS, entry))) fail(code);
  return [...new Set(value as string[])].sort();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(code);
  return value as T;
}

function nullableRef(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const result = text(value, 1, 280);
  if (!result || /[\s?#]/.test(result)) fail(code);
  return result;
}

function nullableRevisionRef(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const result = text(value, 12, 220);
  if (!result || !/^[A-Za-z0-9._:-]+$/.test(result)) fail(code);
  return result;
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const result = text(value, 3, 1_200);
  if (!result) fail(code);
  return result;
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length >= min && result.length <= max ? result : null;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}

async function hashIdempotency(value: unknown, code: string): Promise<string> {
  const key = text(value, 8, 280);
  if (!key || !/^[A-Za-z0-9._:-]+$/.test(key)) fail(code);
  return await sha256Hex(key);
}

function validNow(now: Date): string {
  const value = now.toISOString();
  if (!Number.isFinite(Date.parse(value))) fail("schema_field_time_invalid");
  return value;
}

function errorCode(error: unknown): string | null {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/schema_field_[a-z_]+/)?.[0] ?? null;
}

function fail(code: string, detail: Readonly<Record<string, unknown>> = {}): never {
  throw new SchemaFormsError(code, detail);
}
