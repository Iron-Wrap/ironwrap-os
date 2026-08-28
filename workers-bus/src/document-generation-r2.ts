/** Governed immutable R2 execution for document-generation attempts (IRO-242 checkpoint 3B). */
import type { AppEnv } from "./app-types.ts";
import {
  beginDocumentGeneration,
  DocumentTemplatesError,
  getDocumentGenerationAttempt,
  getLatestDocumentGenerationReceipt,
  getDocumentTemplateRevision,
  prepareDocumentGenerationInputs,
  recordDocumentGenerationTerminal,
  renderDocumentTemplate,
  type DocumentGenerationAttempt,
  type DocumentGenerationReceipt,
  type DocumentGenerationServiceAuthority,
} from "./document-templates.ts";
import {
  assertEffectLedgerReady,
  authorizeExternalEffect,
  executeExternalEffect,
  getExternalEffect,
  proposeExternalEffect,
  reconcileExternalEffect,
  type EffectAuthority,
  type EffectReadback,
  type ExternalEffectRecord,
} from "./effect-runtime.ts";
import { bodySize, r2ObjectMatches, r2ObjectStore } from "./field-actions.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  getSchemaFieldDefinition,
  recordVerifiedSchemaObjectFieldValue,
  type SchemaFieldActor,
  type SchemaFieldValue,
} from "./schema-forms.ts";

const PROVIDER = "cloudflare-r2";
const CONTENT_TYPE = "text/html; charset=utf-8";
const READBACK_SCHEMA = "ironwrap.document-generation-readback.v1";
const DEADLINE_MS = 5 * 60_000;

interface OutputFieldBinding {
  field_id: string;
  field_definition_revision_id: string;
  expected_version: number;
  evidence_class: "derived";
}

export interface GenerateR2DocumentInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  templateId: string;
  templateRevisionId?: string | null;
  expectedInputSnapshotDigest?: string | null;
  outputFieldId?: string | null;
  expectedOutputFieldVersion?: number | null;
  /** Exactly one of `actor` (a signed-in human) or `serviceAuthority` (a scoped permit). */
  actor?: SchemaFieldActor;
  serviceAuthority?: DocumentGenerationServiceAuthority;
  idempotencyKey: string;
}

/** The authority half of a generation request, threaded verbatim into every governed call. */
type GenerationAuthorityInput =
  | { actor: SchemaFieldActor }
  | { serviceAuthority: DocumentGenerationServiceAuthority };

function authorityInput(input: {
  actor?: SchemaFieldActor;
  serviceAuthority?: DocumentGenerationServiceAuthority;
}): GenerationAuthorityInput {
  if (input.serviceAuthority && input.actor) throw new DocumentTemplatesError("document_generation_authority_invalid");
  if (input.serviceAuthority) return { serviceAuthority: input.serviceAuthority };
  if (input.actor) return { actor: input.actor };
  throw new DocumentTemplatesError("document_generation_authority_invalid");
}

/** The acting identity behind either authority - never a role widening, always the permit's own. */
function actingActor(input: {
  actor?: SchemaFieldActor;
  serviceAuthority?: DocumentGenerationServiceAuthority;
}): SchemaFieldActor {
  const authority = authorityInput(input);
  return "serviceAuthority" in authority ? authority.serviceAuthority.actor : authority.actor;
}

export interface R2DocumentGenerationResult {
  outcome: "succeeded" | "failed" | "unknown" | "manual_exception" | "not_executed";
  receipt: DocumentGenerationReceipt;
  attachment: SchemaFieldValue | null;
  /**
   * The exact bytes the effect stored, re-derived from the durable attempt and digest-checked
   * against the receipt.  A caller that has to hand the document on - a delivery rail, say - uses
   * this instead of re-rendering, so what leaves the system is what the receipt attests.
   */
  document: { providerDocumentId: string | null; outputDigest: string; body: string };
}

interface GenerationMaterial {
  attemptId: string;
  templateRevisionId: string;
  templateVersion: number;
  inputSnapshotDigest: string;
  outputDigest: string;
  renderedOutput: string;
  evidenceRefs: string[];
}

export async function generateDocumentToR2(
  env: AppEnv,
  input: GenerateR2DocumentInput,
  now = new Date(),
): Promise<R2DocumentGenerationResult> {
  assertGenerationEnabled(env);
  const authority = authorityInput(input);
  const actor = actingActor(input);
  const ids = await generationIds(input.tenantId, input.idempotencyKey);
  const existingAttempt = await getDocumentGenerationAttempt(env, input.tenantId, ids.attemptId);
  const existingEffect = await getExternalEffect(env, ids.effectId);
  const material = existingAttempt
    ? await materialFromAttempt(env, input, existingAttempt)
    : await materialFromCurrentState(env, input, ids.attemptId, now);
  const outputBinding = await outputFieldBinding(env, input, existingEffect);
  const providerDocumentId = providerId(input.tenantId, material.attemptId, material.outputDigest);
  const expectedReadback = expectedReadbackFor(input, material, providerDocumentId);
  const deadlineAt = existingEffect?.deadline_at ?? new Date(now.getTime() + DEADLINE_MS).toISOString();
  const effectPermit = effectAuthority(input, actor, input.tenantId, deadlineAt);
  let effect = await proposeExternalEffect(env, {
    effectId: ids.effectId,
    tenantId: input.tenantId,
    actor: { type: actor.type, id: actor.userId },
    taskId: `task:${material.attemptId}`,
    authority: effectPermit,
    aggregate: { type: "document_generation", id: material.attemptId, version: material.templateVersion },
    intentId: material.attemptId,
    action: "document.generate",
    request: effectRequest(material, providerDocumentId, outputBinding),
    provider: PROVIDER,
    idempotencyKey: `document-effect:${input.idempotencyKey}`,
    deadlineAt,
    preconditions: { output_field: outputBinding },
    evidenceRefs: material.evidenceRefs,
    expectedReadback,
    retryLimit: 0,
    compensationPlan: { mode: "none" },
    correlationId: `correlation:${material.attemptId}`,
    now: now.toISOString(),
  });

  const started = await beginDocumentGeneration(env, {
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    templateId: input.templateId,
    templateRevisionId: input.templateRevisionId,
    generationAttemptId: material.attemptId,
    externalEffectId: ids.effectId,
    provider: PROVIDER,
    ...authority,
    idempotencyKey: input.idempotencyKey,
    expectedInputSnapshotDigest: input.expectedInputSnapshotDigest,
    now,
  });
  const durableMaterial = started.kind === "created" && started.prepared
    ? materialFromPrepared(material.attemptId, started.prepared)
    : await materialFromAttempt(env, input, started.attempt);
  if (durableMaterial.outputDigest !== material.outputDigest)
    throw new DocumentTemplatesError("document_generation_output_mismatch");

  if (effect.state === "proposed") effect = await authorizeExternalEffect(env, effect.effect_id, effectPermit, now.toISOString());
  if (effect.state === "authorized" || effect.state === "retry") {
    effect = (await executeExternalEffect(
      env,
      effect.effect_id,
      r2Executor(env.RAW, durableMaterial.renderedOutput, providerDocumentId, expectedReadback),
      now,
    )).effect;
  }
  return await closeGeneration(
    env, started.attempt, effect, outputBinding, authority, durableMaterial,
    `document-receipt:${input.idempotencyKey}`, now,
  );
}

export async function reconcileDocumentR2(
  env: AppEnv,
  input: { tenantId: string; generationAttemptId: string; actor: SchemaFieldActor; idempotencyKey: string },
  now = new Date(),
): Promise<R2DocumentGenerationResult> {
  assertGenerationEnabled(env);
  const attempt = await getDocumentGenerationAttempt(env, input.tenantId, input.generationAttemptId);
  if (!attempt) throw new DocumentTemplatesError("document_generation_attempt_not_found");
  const effect = await getExternalEffect(env, attempt.external_effect_id);
  if (!effect || effect.tenant_id !== input.tenantId) throw new DocumentTemplatesError("document_generation_effect_scope_invalid");
  const material = await materialFromAttempt(env, {
    tenantId: input.tenantId,
    entityType: attempt.entity_type,
    entityId: attempt.entity_id,
    templateId: attempt.template_id,
  }, attempt);
  const outputBinding = bindingFromEffect(effect);
  const providerDocumentId = providerId(input.tenantId, attempt.generation_attempt_id, attempt.output_digest);
  const expectedReadback = expectedReadbackFor({
    tenantId: input.tenantId,
    entityType: attempt.entity_type,
    entityId: attempt.entity_id,
    templateId: attempt.template_id,
  }, material, providerDocumentId);
  const receiptKey = `document-reconcile:${input.idempotencyKey}`;
  const latest = await getLatestDocumentGenerationReceipt(env, input.tenantId, attempt.generation_attempt_id);

  if (effect.state === "succeeded") {
    if (latest?.terminal_status === "succeeded")
      return { outcome: "succeeded", receipt: latest, attachment: null, document: documentView(material, effect) };
    return await closeGeneration(env, attempt, effect, outputBinding, { actor: input.actor }, material, receiptKey, now);
  }
  if (effect.state === "manual_exception") {
    if (latest?.reconciliation_outcome === "manual_exception")
      return { outcome: "manual_exception", receipt: latest, attachment: null, document: documentView(material, effect) };
    return await closeGeneration(env, attempt, effect, outputBinding, { actor: input.actor }, material, receiptKey, now);
  }
  if (effect.state === "reconciled") {
    if (latest?.reconciliation_outcome === "not_executed")
      return { outcome: "not_executed", receipt: latest, attachment: null, document: documentView(material, effect) };
    return await closeGeneration(env, attempt, effect, outputBinding, { actor: input.actor }, material, receiptKey, now);
  }
  if (effect.state !== "unknown") throw new DocumentTemplatesError("document_generation_not_reconcilable");

  if (!latest) await closeGeneration(
    env, attempt, effect, outputBinding, { actor: input.actor }, material,
    `document-receipt-recovery:${attempt.generation_attempt_id}`, now,
  );
  const readback = await r2Readback(env.RAW, material.renderedOutput, providerDocumentId, expectedReadback);
  if (readback.status === "unavailable") throw new DocumentTemplatesError("document_generation_readback_unavailable");
  if (readback.status === "not_found") {
    const reconciled = await reconcileExternalEffect(env, effect.effect_id, {
      outcome: "not_executed",
      evidence: { provider_document_id: providerDocumentId, status: "not_found" },
      detailCode: "r2_object_not_found",
      now: now.toISOString(),
    });
    return await closeGeneration(env, attempt, reconciled, outputBinding, { actor: input.actor }, material, receiptKey, now);
  }
  const reconciled = await reconcileExternalEffect(env, effect.effect_id, {
    outcome: readback.status === "match" ? "executed" : "inconclusive",
    evidence: readback.observed ?? {},
    detailCode: readback.status === "match" ? "r2_object_reconciled" : "r2_object_conflict",
    now: now.toISOString(),
  });
  return await closeGeneration(env, attempt, reconciled, outputBinding, { actor: input.actor }, material, receiptKey, now);
}

function assertGenerationEnabled(env: AppEnv): void {
  if (String(env.APP_DOCUMENT_GENERATION_ENABLED ?? "") !== "true")
    throw new DocumentTemplatesError("document_generation_unavailable");
  const bucket = (env as { RAW?: { head?: unknown; put?: unknown } }).RAW;
  if (typeof bucket?.head !== "function" || typeof bucket.put !== "function")
    throw new DocumentTemplatesError("document_generation_r2_unavailable");
  assertEffectLedgerReady(env);
}

async function generationIds(tenantId: string, idempotencyKey: string): Promise<{ attemptId: string; effectId: string }> {
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(idempotencyKey))
    throw new DocumentTemplatesError("document_generation_idempotency_invalid");
  const digest = await sha256Hex(canonicalJson({ tenant_id: tenantId, idempotency_key: idempotencyKey }));
  return { attemptId: `docgen:${digest.slice(0, 48)}`, effectId: `effect:docgen:${digest.slice(0, 48)}` };
}

async function materialFromCurrentState(
  env: AppEnv,
  input: GenerateR2DocumentInput,
  attemptId: string,
  now: Date,
): Promise<GenerationMaterial> {
  const prepared = await prepareDocumentGenerationInputs(env, {
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    templateId: input.templateId,
    templateRevisionId: input.templateRevisionId,
    ...authorityInput(input),
    now,
  });
  return materialFromPrepared(attemptId, prepared);
}

function materialFromPrepared(
  attemptId: string,
  prepared: Awaited<ReturnType<typeof prepareDocumentGenerationInputs>>,
): GenerationMaterial {
  return {
    attemptId,
    templateRevisionId: prepared.template.revision_id,
    templateVersion: prepared.template.version,
    inputSnapshotDigest: prepared.inputSnapshotDigest,
    outputDigest: prepared.outputDigest,
    renderedOutput: prepared.renderedOutput,
    evidenceRefs: prepared.inputs.map((entry) => entry.value_revision_id),
  };
}

async function materialFromAttempt(
  env: AppEnv,
  input: Pick<GenerateR2DocumentInput, "tenantId" | "entityType" | "entityId" | "templateId" | "templateRevisionId">,
  attempt: DocumentGenerationAttempt,
): Promise<GenerationMaterial> {
  if (attempt.tenant_id !== input.tenantId || attempt.entity_type !== input.entityType ||
      attempt.entity_id !== input.entityId || attempt.template_id !== input.templateId ||
      (input.templateRevisionId && input.templateRevisionId !== attempt.template_revision_id))
    throw new DocumentTemplatesError("document_generation_idempotency_conflict");
  const template = await getDocumentTemplateRevision(env, attempt.tenant_id, attempt.template_id, attempt.template_revision_id);
  if (!template) throw new DocumentTemplatesError("document_template_not_found");
  const renderedOutput = renderDocumentTemplate(template.blocks, attempt.inputs);
  if (await sha256Hex(renderedOutput) !== attempt.output_digest)
    throw new DocumentTemplatesError("document_generation_output_mismatch");
  return {
    attemptId: attempt.generation_attempt_id,
    templateRevisionId: attempt.template_revision_id,
    templateVersion: attempt.template_version,
    inputSnapshotDigest: attempt.input_snapshot_digest,
    outputDigest: attempt.output_digest,
    renderedOutput,
    evidenceRefs: attempt.inputs.map((entry) => entry.value_revision_id),
  };
}

async function outputFieldBinding(
  env: AppEnv,
  input: GenerateR2DocumentInput,
  existingEffect: ExternalEffectRecord | null,
): Promise<OutputFieldBinding | null> {
  if (existingEffect) {
    const stored = bindingFromEffect(existingEffect);
    const suppliedId = input.outputFieldId ?? null;
    const suppliedVersion = input.expectedOutputFieldVersion ?? null;
    if ((stored?.field_id ?? null) !== suppliedId || (stored?.expected_version ?? null) !== suppliedVersion)
      throw new DocumentTemplatesError("document_generation_idempotency_conflict");
    return stored;
  }
  if (input.outputFieldId === undefined || input.outputFieldId === null || input.outputFieldId === "") {
    if (input.expectedOutputFieldVersion !== undefined && input.expectedOutputFieldVersion !== null)
      throw new DocumentTemplatesError("document_generation_output_field_invalid");
    return null;
  }
  if (!Number.isSafeInteger(input.expectedOutputFieldVersion) || Number(input.expectedOutputFieldVersion) < 0)
    throw new DocumentTemplatesError("document_generation_output_field_version_invalid");
  const field = await getSchemaFieldDefinition(env, input.tenantId, input.outputFieldId);
  if (!field || field.entity_type !== input.entityType) throw new DocumentTemplatesError("document_generation_output_field_not_found");
  if (!field.active || field.field_type !== "attachment" || field.evidence_class !== "derived" ||
      !field.write_roles.includes(actingActor(input).role))
    throw new DocumentTemplatesError("document_generation_output_field_invalid");
  return {
    field_id: field.field_id,
    field_definition_revision_id: field.revision_id,
    expected_version: Number(input.expectedOutputFieldVersion),
    evidence_class: "derived",
  };
}

function bindingFromEffect(effect: ExternalEffectRecord): OutputFieldBinding | null {
  try {
    const parsed = JSON.parse(effect.preconditions_json) as { output_field?: unknown };
    const value = parsed.output_field;
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const binding = value as Record<string, unknown>;
    if (typeof binding.field_id !== "string" || typeof binding.field_definition_revision_id !== "string" ||
        !Number.isSafeInteger(binding.expected_version) || binding.evidence_class !== "derived") throw new Error("invalid");
    return binding as unknown as OutputFieldBinding;
  } catch {
    throw new DocumentTemplatesError("document_generation_output_field_invalid");
  }
}

function effectAuthority(
  input: { serviceAuthority?: DocumentGenerationServiceAuthority },
  actor: SchemaFieldActor,
  tenantId: string,
  deadlineAt: string,
): EffectAuthority {
  const permit = input.serviceAuthority;
  return {
    permitRef: permit?.permitRef ?? actor.authorityRef ?? `app:${actor.userId}`,
    policyRef: permit?.policyRef ?? `role:${actor.role}:document.generate`,
    policyVersion: permit?.policyVersion ?? "v1",
    tenantId,
    actorType: actor.type,
    actorId: actor.userId,
    expiresAt: deadlineAt,
    allowedActions: ["document.generate"],
    maxAttempts: permit?.maxAttempts ?? 1,
  };
}

function providerId(tenantId: string, attemptId: string, outputDigest: string): string {
  return `r2:documents/v1/${tenantId}/${attemptId}/${outputDigest}.html`;
}

function expectedReadbackFor(
  input: Pick<GenerateR2DocumentInput, "tenantId" | "entityType" | "entityId" | "templateId">,
  material: GenerationMaterial,
  providerDocumentId: string,
): Record<string, unknown> {
  return {
    schema_version: READBACK_SCHEMA,
    tenant_id: input.tenantId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    generation_attempt_id: material.attemptId,
    template_id: input.templateId,
    template_revision_id: material.templateRevisionId,
    template_version: material.templateVersion,
    input_snapshot_digest: material.inputSnapshotDigest,
    provider: PROVIDER,
    provider_document_id: providerDocumentId,
    output_digest: material.outputDigest,
  };
}

function effectRequest(
  material: GenerationMaterial,
  providerDocumentId: string,
  outputBinding: OutputFieldBinding | null,
): Record<string, unknown> {
  return {
    generation_attempt_id: material.attemptId,
    template_revision_id: material.templateRevisionId,
    template_version: material.templateVersion,
    input_snapshot_digest: material.inputSnapshotDigest,
    output_digest: material.outputDigest,
    output_size_bytes: bodySize(material.renderedOutput),
    provider_document_id: providerDocumentId,
    output_field: outputBinding,
  };
}

function r2Executor(
  bucket: R2Bucket,
  body: string,
  providerDocumentId: string,
  expectedReadback: Record<string, unknown>,
) {
  const key = providerDocumentId.slice(3);
  const checksum = String(expectedReadback.output_digest);
  return {
    async dispatch() {
      try {
        await r2ObjectStore(bucket).ensure(key, body, CONTENT_TYPE, checksum);
        return {
          outcome: "accepted" as const,
          providerExternalId: providerDocumentId,
          providerResponse: { key, checksum, size: bodySize(body) },
        };
      } catch {
        return {
          outcome: "unknown" as const,
          providerExternalId: providerDocumentId,
          detailCode: "r2_ensure_unknown",
        };
      }
    },
    async readback() {
      return await r2Readback(bucket, body, providerDocumentId, expectedReadback);
    },
  };
}

async function r2Readback(
  bucket: R2Bucket,
  body: string,
  providerDocumentId: string,
  expectedReadback: Record<string, unknown>,
): Promise<EffectReadback> {
  const key = providerDocumentId.slice(3);
  let object: R2Object | null;
  try {
    object = await bucket.head(key);
  } catch {
    return { status: "unavailable", providerExternalId: providerDocumentId, detailCode: "r2_head_unavailable" };
  }
  if (!object) return { status: "not_found", providerExternalId: providerDocumentId, detailCode: "r2_object_not_found" };
  const observed = {
    ...expectedReadback,
    r2: {
      key,
      size: object.size,
      sha256: object.customMetadata?.sha256 ?? null,
      checksum_sha256: arrayBufferHex(object.checksums?.sha256),
      content_type: object.httpMetadata?.contentType ?? null,
    },
  };
  const matches = r2ObjectMatches(object, bodySize(body), String(expectedReadback.output_digest)) &&
    object.httpMetadata?.contentType === CONTENT_TYPE;
  return {
    status: matches ? "match" : "conflict",
    providerExternalId: providerDocumentId,
    observed,
    detailCode: matches ? null : "r2_object_conflict",
  };
}

function documentView(
  material: GenerationMaterial,
  effect: ExternalEffectRecord,
): R2DocumentGenerationResult["document"] {
  return {
    providerDocumentId: effect.provider_external_id,
    outputDigest: material.outputDigest,
    body: material.renderedOutput,
  };
}

async function closeGeneration(
  env: AppEnv,
  attempt: DocumentGenerationAttempt,
  effect: ExternalEffectRecord,
  outputBinding: OutputFieldBinding | null,
  authority: GenerationAuthorityInput,
  material: GenerationMaterial,
  receiptKey: string,
  now: Date,
): Promise<R2DocumentGenerationResult> {
  const actor = actingActor(authority);
  if (["proposed", "authorized", "executing", "reconciling", "retry"].includes(effect.state))
    throw new DocumentTemplatesError("document_generation_in_flight");
  const terminalStatus = effect.state === "succeeded" ? "succeeded"
    : effect.state === "failed" ? "failed" : "unknown";
  const reconciliationOutcome = effect.state === "manual_exception" ? "manual_exception"
    : effect.state === "reconciled" ? "not_executed" : terminalStatus;
  if (terminalStatus === "unknown" &&
      effect.state !== "unknown" && effect.state !== "manual_exception" && effect.state !== "reconciled")
    throw new DocumentTemplatesError("document_generation_effect_terminal_invalid");
  const result = await recordDocumentGenerationTerminal(env, {
    tenantId: attempt.tenant_id,
    generationAttemptId: attempt.generation_attempt_id,
    terminalStatus,
    reconciliationOutcome,
    readbackStatus: terminalStatus === "succeeded" ? "match"
      : effect.state === "manual_exception" ? "conflict"
        : effect.state === "reconciled" || effect.result_code === "r2_object_not_found" ? "not_found" : "unavailable",
    providerDocumentId: effect.provider_external_id,
    outputDigest: attempt.output_digest,
    readbackDigest: effect.readback_hash,
    ...authority,
    idempotencyKey: receiptKey,
    now,
  });
  let attachment: SchemaFieldValue | null = null;
  if (terminalStatus === "succeeded" && outputBinding) {
    attachment = await attachGeneratedObject(env, attempt, effect, outputBinding, actor, now);
  }
  return {
    outcome: reconciliationOutcome,
    receipt: result.receipt,
    attachment,
    document: documentView(material, effect),
  };
}

async function attachGeneratedObject(
  env: AppEnv,
  attempt: DocumentGenerationAttempt,
  effect: ExternalEffectRecord,
  binding: OutputFieldBinding,
  actor: SchemaFieldActor,
  now: Date,
): Promise<SchemaFieldValue> {
  if (!effect.provider_external_id || !effect.readback_hash)
    throw new DocumentTemplatesError("document_generation_success_readback_invalid");
  const digest = await sha256Hex(canonicalJson({
    generation_attempt_id: attempt.generation_attempt_id,
    field_id: binding.field_id,
    field_definition_revision_id: binding.field_definition_revision_id,
    expected_version: binding.expected_version,
    object_ref: effect.provider_external_id,
    output_digest: attempt.output_digest,
  }));
  const receiptId = `evidence:document:${digest.slice(0, 48)}`;
  const capturedAt = effect.updated_at;
  const value = {
    receipt_id: receiptId,
    object_ref: effect.provider_external_id,
    digest: attempt.output_digest,
    tenant_id: attempt.tenant_id,
    entity_type: attempt.entity_type,
    entity_id: attempt.entity_id,
    field_id: binding.field_id,
    actor_type: actor.type,
    actor_id: actor.userId,
    captured_at: capturedAt,
    evidence_class: binding.evidence_class,
  };
  const recorded = await recordVerifiedSchemaObjectFieldValue(env, {
    tenantId: attempt.tenant_id,
    entityType: attempt.entity_type,
    entityId: attempt.entity_id,
    fieldId: binding.field_id,
    fieldDefinitionRevisionId: binding.field_definition_revision_id,
    expectedVersion: binding.expected_version,
    value,
    sourceRef: `document-generation:${attempt.generation_attempt_id}`,
    evidenceRef: receiptId,
    actor,
    idempotencyKey: `document-output:${digest}`,
  }, {
    receiptId,
    objectRef: effect.provider_external_id,
    objectDigest: attempt.output_digest,
    capturedAt,
    evidenceClass: binding.evidence_class,
  }, now);
  return recorded.value;
}

function arrayBufferHex(value: ArrayBuffer | undefined): string | null {
  if (!(value instanceof ArrayBuffer)) return null;
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
