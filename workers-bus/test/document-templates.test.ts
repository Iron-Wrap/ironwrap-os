import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import {
  reconcileExternalEffect,
  runExternalEffect,
  type EffectAuthority,
} from "../src/effect-runtime.ts";
import { canonicalJson } from "../src/newo-hash.ts";
import {
  beginDocumentGeneration,
  createDocumentTemplate,
  DocumentTemplatesError,
  getDocumentGenerationReceipt,
  getDocumentTemplate,
  listDocumentTemplateRevisions,
  parseDocumentTemplateBlocks,
  prepareDocumentGenerationInputs,
  recordDocumentGenerationTerminal,
  renderDocumentTemplate,
  retireDocumentTemplate,
  reviseDocumentTemplate,
  type BeginDocumentGenerationInput,
  type DocumentGenerationFieldSnapshot,
  type DocumentGenerationServiceAuthority,
  type DocumentTemplateInput,
  type PrepareDocumentGenerationInput,
  type RecordDocumentGenerationTerminalInput,
} from "../src/document-templates.ts";
import {
  createSchemaFieldDefinition,
  recordSchemaFieldValue,
  type SchemaFieldActor,
} from "../src/schema-forms.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const LEAD_ID = "lead:documents:0001";
const OTHER_LEAD_ID = "lead:documents:0002";
const OWNER_ID = "appu_documents_owner";
const NOW = new Date("2026-08-27T08:00:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort())
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    seed(this.raw);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  async batch(statements: readonly SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // Preserve the original statement error.
      }
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.execute();
  }

  execute(): { success: true; meta: { changes: number } } {
    const before = Number((this.database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
    this.statement.run(...this.args);
    const after = Number((this.database.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
    return { success: true, meta: { changes: after - before } };
  }
}

function seed(db: DatabaseSync): void {
  const now = NOW.toISOString();
  for (const [tenantId, leadId, envelopeId] of [
    [TENANT, LEAD_ID, "ow_documents_0001"],
    [OTHER_TENANT, OTHER_LEAD_ID, "ow_documents_0002"],
  ] as const) {
    db.prepare(
      `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status, created_at, updated_at)
       VALUES (?, 'manual', 'Document Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
    ).run(envelopeId, `${leadId}@example.invalid`, `raw/documents/${leadId}.json`, now, now, now);
    db.prepare(
      `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'Document Customer', ?, 'qualified', 1, ?, ?)`,
    ).run(leadId, tenantId, envelopeId, `raw/documents/${leadId}.json`, `${leadId}@example.invalid`, now, now);
  }
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'Document Owner', 'owner', 'owner', 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, "documents-owner@example.invalid", now, now);
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never, EFFECT_RUNTIME_ENABLED: "true" } as AppEnv;
}

function owner(): SchemaFieldActor {
  return { type: "owner", role: "owner", userId: OWNER_ID, authorityRef: "permit:documents:owner" };
}

function fieldInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    entityType: "lead",
    fieldKey: "document-customer-name",
    label: "Customer name",
    position: 1,
    fieldType: "text",
    validatorKey: "required",
    validatorConfig: {},
    visibilityKey: "always",
    visibilityConfig: {},
    evidenceClass: "source",
    retentionPolicy: "standard",
    offlineMode: "online_only",
    readScope: "all",
    writeScope: "all",
    readRoles: ["owner"],
    writeRoles: ["owner"],
    active: true,
    actor: owner(),
    idempotencyKey: "documents-field-create-0001",
    ...overrides,
  };
}

function templateInput(fieldId: string, overrides: Partial<DocumentTemplateInput> = {}): DocumentTemplateInput {
  return {
    tenantId: TENANT,
    templateId: "template:documents:0001",
    entityType: "lead",
    templateKey: "customer-summary",
    label: "Customer summary",
    blocks: [
      { kind: "heading", level: 1, text: "Customer summary" },
      { kind: "text", text: "Name" },
      { kind: "field", field_id: fieldId },
    ],
    retentionPolicy: "standard",
    active: true,
    actor: owner(),
    idempotencyKey: "documents-template-create-0001",
    ...overrides,
  };
}

async function fieldAndTemplate(runtime: AppEnv) {
  const field = await createSchemaFieldDefinition(runtime, fieldInput(), NOW);
  await recordSchemaFieldValue(runtime, {
    tenantId: TENANT,
    entityType: "lead",
    entityId: LEAD_ID,
    fieldId: field.definition.field_id,
    expectedVersion: 0,
    value: "<Alice>",
    actor: owner(),
    idempotencyKey: "documents-value-create-0001",
  }, NOW);
  const template = await createDocumentTemplate(runtime, templateInput(field.definition.field_id), NOW);
  return { field: field.definition, template: template.template };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof DocumentTemplatesError && error.code === code);
}

function generationServiceAuthority(
  prepared: Awaited<ReturnType<typeof prepareDocumentGenerationInputs>>,
  maxAttempts: number,
  permitRef: string,
): DocumentGenerationServiceAuthority {
  return {
    kind: "service",
    permitRef,
    policyRef: "policy:documents:generate",
    policyVersion: "v1",
    tenantId: TENANT,
    entityType: prepared.template.entity_type,
    entityId: LEAD_ID,
    templateId: prepared.template.template_id,
    action: "document.generate",
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxAttempts,
    stopPolicy: "stop_on_unknown",
    compensationPolicy: "none",
    actor: {
      type: "worker",
      role: "owner",
      userId: "worker:documents-generator",
      authorityRef: "authority:documents-generator",
    },
  };
}

test("templates use a closed vocabulary and preserve immutable replay/drift history", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    assert.deepEqual(parseDocumentTemplateBlocks([
      { kind: "heading", level: 2, text: "Heading" },
      { kind: "field", field_id: "field:documents:0001" },
    ]), [
      { kind: "heading", level: 2, text: "Heading" },
      { kind: "field", field_id: "field:documents:0001" },
    ]);
    for (const blocks of [
      [{ kind: "html", html: "<script>bad</script>" }],
      [{ kind: "text", text: "<script>bad</script>" }],
      [{ kind: "field", field_id: "field:documents:0001" }, { kind: "field", field_id: "field:documents:0001" }],
      [{ kind: "heading", level: 4, text: "bad" }],
    ]) await assert.throws(() => parseDocumentTemplateBlocks(blocks), DocumentTemplatesError);
    await expectCode(
      () => createDocumentTemplate(runtime, templateInput("field:documents:0001", { action: "revise" }), NOW),
      "document_template_action_invalid",
    );
    const { field, template } = await fieldAndTemplate(runtime);
    assert.equal(template.version, 1);
    const replay = await createDocumentTemplate(runtime, templateInput(field.field_id), NOW);
    assert.equal(replay.kind, "replayed");
    const revision = await reviseDocumentTemplate(runtime, templateInput(field.field_id, {
      label: "Customer summary v2",
      blocks: [
        { kind: "heading", level: 1, text: "Customer summary v2" },
        { kind: "field", field_id: field.field_id },
      ],
      action: "revise",
      expectedVersion: 1,
      idempotencyKey: "documents-template-revise-0001",
    }), NOW);
    assert.equal(revision.template.version, 2);
    assert.equal(revision.template.prior_revision_id, template.revision_id);
    const revisionReplay = await reviseDocumentTemplate(runtime, templateInput(field.field_id, {
      label: "Customer summary v2",
      blocks: [
        { kind: "heading", level: 1, text: "Customer summary v2" },
        { kind: "field", field_id: field.field_id },
      ],
      action: "revise",
      expectedVersion: 1,
      idempotencyKey: "documents-template-revise-0001",
    }), NOW);
    assert.equal(revisionReplay.kind, "replayed");
    const heldRevision = await reviseDocumentTemplate(runtime, templateInput(field.field_id, {
      retentionPolicy: "legal_hold",
      action: "revise",
      expectedVersion: 2,
      idempotencyKey: "documents-template-hold-0001",
    }), NOW);
    assert.equal(heldRevision.template.retention_policy, "legal_hold");
    await expectCode(
      () => reviseDocumentTemplate(runtime, templateInput(field.field_id, {
        retentionPolicy: "standard",
        action: "revise",
        expectedVersion: 3,
        idempotencyKey: "documents-template-hold-weakening-0001",
      }), NOW),
      "document_template_retention_hold",
    );
    await expectCode(
      () => reviseDocumentTemplate(runtime, templateInput(field.field_id, {
        label: "Different command",
        action: "revise",
        expectedVersion: 1,
        idempotencyKey: "documents-template-revise-0001",
      }), NOW),
      "document_template_idempotency_conflict",
    );
    const history = await listDocumentTemplateRevisions(runtime, TENANT, template.template_id);
    assert.deepEqual(history.map((entry) => entry.version), [1, 2, 3]);
    assert.throws(() => db.raw.prepare(
      `INSERT INTO document_template_revisions
       (revision_id, tenant_id, template_id, version, prior_revision_id, action, entity_type,
        template_key, label, blocks_json, retention_policy, active, actor_type, actor_role, actor_id,
        authority_ref, command_fingerprint, idempotency_key_hash, effective_at, created_at)
       VALUES (?, ?, ?, 4, ?, 'revise', ?, ?, ?, ?, 'legal_hold', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "docrev:documents:invalid", TENANT, template.template_id, heldRevision.template.revision_id,
      template.entity_type, template.template_key, template.label, JSON.stringify([{ kind: "text" }]),
      owner().type, owner().role, OWNER_ID, owner().authorityRef, "0".repeat(64), "1".repeat(64), NOW.toISOString(), NOW.toISOString(),
    ), /document_template_block_invalid/);
    assert.throws(() => db.raw.prepare("UPDATE document_template_revisions SET label = 'tampered'").run(), /document_template_revisions_append_only/);
    assert.throws(() => db.raw.prepare("DELETE FROM document_template_revisions").run(), /document_template_revisions_append_only/);
    assert.throws(() => db.raw.prepare("INSERT OR REPLACE INTO document_template_revisions SELECT * FROM document_template_revisions LIMIT 1").run(), /document_template_revisions_append_only|document_template_revision_duplicate/);

    const retired = await retireDocumentTemplate(runtime, {
      tenantId: TENANT,
      templateId: template.template_id,
      entityType: template.entity_type,
      templateKey: template.template_key,
      actor: owner(),
      idempotencyKey: "documents-template-retire-0001",
    }, NOW);
    assert.equal(retired.template.action, "retire");
    const retiredReplay = await retireDocumentTemplate(runtime, {
      tenantId: TENANT,
      templateId: template.template_id,
      entityType: template.entity_type,
      templateKey: template.template_key,
      actor: owner(),
      idempotencyKey: "documents-template-retire-0001",
    }, NOW);
    assert.equal(retiredReplay.kind, "replayed");
  } finally {
    db.close();
  }
});

test("generation preparation re-evaluates authority, snapshots exact values, and escapes output", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const { field, template } = await fieldAndTemplate(runtime);
    const prepared = await prepareDocumentGenerationInputs(runtime, {
      tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
    });
    assert.equal(prepared.inputs[0]?.field_id, field.field_id);
    assert.equal(prepared.inputs[0]?.value, "<Alice>");
    const rendered = renderDocumentTemplate(template.blocks, prepared.inputs);
    assert.match(rendered, /&lt;Alice&gt;/);
    assert.doesNotMatch(rendered, /<Alice>/);
    await expectCode(
      () => prepareDocumentGenerationInputs(runtime, {
        tenantId: OTHER_TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
      }),
      "document_template_not_found",
    );
    await expectCode(
      () => prepareDocumentGenerationInputs(runtime, {
        tenantId: TENANT, entityType: "lead", entityId: OTHER_LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
      }),
      "document_generation_entity_not_found",
    );
    const hidden = await createSchemaFieldDefinition(runtime, fieldInput({
      fieldKey: "document-hidden", label: "Hidden", readRoles: ["ops"], writeRoles: ["owner"], idempotencyKey: "documents-hidden-field-0001",
    }), NOW);
    const hiddenTemplate = await createDocumentTemplate(runtime, templateInput(hidden.definition.field_id, {
      templateId: "template:documents:hidden",
      templateKey: "hidden-summary",
      idempotencyKey: "documents-hidden-template-0001",
    }), NOW);
    await expectCode(
      () => prepareDocumentGenerationInputs(runtime, {
        tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: hiddenTemplate.template.template_id, actor: owner(), now: NOW,
      }),
      "document_generation_input_forbidden",
    );
  } finally {
    db.close();
  }
});

interface SeedGenerationEffectOptions {
  retryLimit?: number;
  effectMaxAttempts?: number;
  serviceAuthority?: DocumentGenerationServiceAuthority;
}

async function seedGenerationEffect(
  runtime: AppEnv,
  prepared: Awaited<ReturnType<typeof prepareDocumentGenerationInputs>>,
  generationAttemptId: string,
  effectId: string,
  outcome: "succeeded" | "failed" | "unknown" | "conflict",
  options: SeedGenerationEffectOptions = {},
) {
  const providerDocumentId = `provider-document:${generationAttemptId}`;
  const expectedReadback = {
    schema_version: "ironwrap.document-generation-readback.v1",
    tenant_id: prepared.template.tenant_id,
    entity_type: prepared.template.entity_type,
    entity_id: LEAD_ID,
    generation_attempt_id: generationAttemptId,
    template_id: prepared.template.template_id,
    template_revision_id: prepared.template.revision_id,
    template_version: prepared.template.version,
    input_snapshot_digest: prepared.inputSnapshotDigest,
    provider: "test-document-provider",
    provider_document_id: providerDocumentId,
    output_digest: prepared.outputDigest,
  };
  const conflictReadback = { ...expectedReadback, provider_document_id: "provider-document:conflict-observed" };
  const readbackDigest = sha256(canonicalJson(expectedReadback));
  const conflictReadbackDigest = sha256(canonicalJson(conflictReadback));
  const actor = owner();
  const effectActor = options.serviceAuthority?.actor ?? actor;
  const authority: EffectAuthority = {
    permitRef: options.serviceAuthority?.permitRef ?? actor.authorityRef!,
    policyRef: options.serviceAuthority?.policyRef ?? "role:owner:document.generate",
    policyVersion: options.serviceAuthority?.policyVersion ?? "v1",
    tenantId: TENANT,
    actorType: effectActor.type,
    actorId: effectActor.userId,
    expiresAt: "2030-01-01T00:00:00.000Z",
    allowedActions: ["document.generate"],
    maxAttempts: options.effectMaxAttempts ?? options.serviceAuthority?.maxAttempts ?? (options.retryLimit ?? 0) + 1,
  };
  const request = {
    effectId,
    tenantId: TENANT,
    actor: { type: effectActor.type, id: effectActor.userId },
    taskId: `task:${generationAttemptId}`,
    authority,
    aggregate: { type: "document_generation", id: generationAttemptId, version: prepared.template.version },
    intentId: generationAttemptId,
    action: "document.generate",
    request: {
      generation_attempt_id: generationAttemptId,
      template_revision_id: prepared.template.revision_id,
      input_snapshot_digest: prepared.inputSnapshotDigest,
    },
    provider: "test-document-provider",
    idempotencyKey: `effect-${generationAttemptId}`,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    expectedReadback,
    retryLimit: options.retryLimit ?? 0,
    correlationId: `correlation:${generationAttemptId}`,
    now: NOW.toISOString(),
  };
  const executor = (nextOutcome: "succeeded" | "failed" | "unknown" | "conflict") => ({
    async dispatch() {
      if (nextOutcome === "failed") return { outcome: "rejected" as const, detailCode: "provider_rejected" };
      if (nextOutcome === "unknown") return { outcome: "unknown" as const, providerExternalId: providerDocumentId, detailCode: "provider_timeout" };
      return { outcome: "accepted" as const, providerExternalId: providerDocumentId, providerResponse: { id: providerDocumentId } };
    },
    async readback() {
      if (nextOutcome === "unknown") return { status: "unavailable" as const, detailCode: "provider_unavailable" };
      if (nextOutcome === "conflict") return {
        status: "conflict" as const,
        providerExternalId: providerDocumentId,
        observed: conflictReadback,
        detailCode: "provider_conflict",
      };
      return {
        status: "match" as const,
        providerExternalId: providerDocumentId,
        observed: expectedReadback,
      };
    },
    async replay() {
      return { providerDocumentId };
    },
  });
  const result = await runExternalEffect(runtime, request, executor(outcome), new Date(NOW));
  return {
    providerDocumentId,
    readbackDigest,
    conflictReadbackDigest,
    expectedReadback,
    effect: result.effect,
    rerun: (nextOutcome: "succeeded" | "failed" | "unknown" | "conflict") =>
      runExternalEffect(runtime, request, executor(nextOutcome), new Date(NOW)),
  };
}

async function beginWithEffect(
  runtime: AppEnv,
  prepared: Awaited<ReturnType<typeof prepareDocumentGenerationInputs>>,
  suffix: string,
  outcome: "succeeded" | "failed" | "unknown" | "conflict" = "succeeded",
  options: SeedGenerationEffectOptions = {},
) {
  const generationAttemptId = `generation:documents:${suffix}`;
  const effectId = `effect:documents:${suffix}`;
  const effect = await seedGenerationEffect(runtime, prepared, generationAttemptId, effectId, outcome, options);
  const authorityInput = options.serviceAuthority ? { serviceAuthority: options.serviceAuthority } : { actor: owner() };
  const started = await beginDocumentGeneration(runtime, {
    tenantId: TENANT,
    entityType: prepared.template.entity_type,
    entityId: LEAD_ID,
    templateId: prepared.template.template_id,
    templateRevisionId: prepared.template.revision_id,
    generationAttemptId,
    externalEffectId: effect.effect.effect_id,
    provider: "test-document-provider",
    ...authorityInput,
    idempotencyKey: `generation-${suffix}`,
    expectedInputSnapshotDigest: prepared.inputSnapshotDigest,
    now: NOW,
  });
  return { generationAttemptId, effect, started, prepared };
}

test("generation attempts snapshot exact template/value revisions and receipts require succeeded readback", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const { field, template } = await fieldAndTemplate(runtime);
    const prepared = await prepareDocumentGenerationInputs(runtime, {
      tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
    });
    const success = await beginWithEffect(runtime, prepared, "success-0001");
    assert.equal(success.started.kind, "created");
    assert.equal(success.started.attempt.template_revision_id, template.revision_id);
    assert.equal(success.started.attempt.inputs[0]?.field_definition_revision_id, field.revision_id);
    assert.equal(success.started.attempt.inputs[0]?.value_revision_id, prepared.inputs[0]?.value_revision_id);
    const terminalInput: RecordDocumentGenerationTerminalInput = {
      tenantId: TENANT,
      generationAttemptId: success.generationAttemptId,
      externalEffectId: success.effect.effect.effect_id,
      provider: "test-document-provider",
      terminalStatus: "succeeded",
      readbackStatus: "match",
      providerDocumentId: success.effect.providerDocumentId,
      outputDigest: prepared.outputDigest,
      readbackDigest: success.effect.readbackDigest,
      actor: owner(),
      idempotencyKey: "receipt-documents-success-0001",
      now: NOW,
    };
    const receipt = await recordDocumentGenerationTerminal(runtime, terminalInput);
    assert.equal(receipt.kind, "created");
    assert.equal(receipt.receipt.terminal_status, "succeeded");
    assert.equal(receipt.receipt.reconciliation_outcome, "succeeded");
    assert.equal(receipt.receipt.attempt?.inputs[0]?.value_digest, prepared.inputs[0]?.value_digest);
    const receiptReplay = await recordDocumentGenerationTerminal(runtime, terminalInput);
    assert.equal(receiptReplay.kind, "replayed");
    await expectCode(
      () => recordDocumentGenerationTerminal(runtime, { ...terminalInput, providerDocumentId: "provider-document:other", idempotencyKey: terminalInput.idempotencyKey }),
      "document_generation_idempotency_conflict",
    );
    const reconstructed = await getDocumentGenerationReceipt(runtime, TENANT, receipt.receipt.receipt_id);
    assert.equal(reconstructed?.attempt?.template_revision_id, template.revision_id);
    assert.equal(reconstructed?.attempt?.inputs[0]?.value_revision_id, prepared.inputs[0]?.value_revision_id);
    assert.equal(reconstructed?.external_effect_id, success.effect.effect.effect_id);

    const mismatchedAttemptId = "generation:documents:provider-mismatch-0001";
    const mismatchedEffect = await seedGenerationEffect(
      runtime, prepared, mismatchedAttemptId, "effect:documents:provider-mismatch-0001", "succeeded",
    );
    await expectCode(
      () => beginDocumentGeneration(runtime, {
        tenantId: TENANT,
        entityType: "lead",
        entityId: LEAD_ID,
        templateId: template.template_id,
        templateRevisionId: template.revision_id,
        generationAttemptId: mismatchedAttemptId,
        externalEffectId: mismatchedEffect.effect.effect_id,
        provider: "other-document-provider",
        actor: owner(),
        idempotencyKey: "generation-provider-mismatch-0001",
        now: NOW,
      }),
      "document_generation_effect_scope_invalid",
    );

    const staleInputSnapshotDigest = prepared.inputSnapshotDigest;
    await recordSchemaFieldValue(runtime, {
      tenantId: TENANT,
      entityType: "lead",
      entityId: LEAD_ID,
      fieldId: field.field_id,
      expectedVersion: 1,
      value: "Alice corrected",
      basedOnValueRevisionId: prepared.inputs[0]!.value_revision_id,
      correctionReason: "Corrected source value",
      actor: owner(),
      idempotencyKey: "documents-value-correction-0001",
    }, NOW);
    const refreshed = await prepareDocumentGenerationInputs(runtime, {
      tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
    });
    assert.notEqual(refreshed.inputSnapshotDigest, staleInputSnapshotDigest);
    const staleAttemptId = "generation:documents:stale-0001";
    const staleEffect = await seedGenerationEffect(runtime, refreshed, staleAttemptId, "effect:documents:stale-0001", "succeeded");
    const attemptCountBeforeStale = Number((db.raw.prepare("SELECT COUNT(*) AS count FROM document_generation_attempts").get() as { count: number }).count);
    await expectCode(
      () => beginDocumentGeneration(runtime, {
        tenantId: TENANT,
        entityType: "lead",
        entityId: LEAD_ID,
        templateId: template.template_id,
        templateRevisionId: template.revision_id,
        generationAttemptId: staleAttemptId,
        externalEffectId: staleEffect.effect.effect_id,
        provider: "test-document-provider",
        actor: owner(),
        idempotencyKey: "generation-stale-0001",
        expectedInputSnapshotDigest: staleInputSnapshotDigest,
        now: NOW,
      }),
      "document_generation_snapshot_stale",
    );
    const attemptCountAfterStale = Number((db.raw.prepare("SELECT COUNT(*) AS count FROM document_generation_attempts").get() as { count: number }).count);
    assert.equal(attemptCountAfterStale, attemptCountBeforeStale);

    const revised = await reviseDocumentTemplate(runtime, templateInput(field.field_id, {
      label: "Customer summary drifted",
      action: "revise",
      expectedVersion: 1,
      idempotencyKey: "documents-template-drift-0001",
    }), NOW);
    assert.equal(revised.template.version, 2);
    const replayedAttempt = await beginDocumentGeneration(runtime, {
      tenantId: TENANT,
      entityType: "lead",
      entityId: LEAD_ID,
      templateId: template.template_id,
      generationAttemptId: success.generationAttemptId,
      externalEffectId: success.effect.effect.effect_id,
      provider: "test-document-provider",
      actor: owner(),
      idempotencyKey: "generation-success-0001",
      now: NOW,
    });
    assert.equal(replayedAttempt.kind, "replayed");
    assert.equal(replayedAttempt.attempt.template_version, 1);
    await expectCode(
      () => beginDocumentGeneration(runtime, {
        tenantId: TENANT,
        entityType: "lead",
        entityId: LEAD_ID,
        templateId: template.template_id,
        generationAttemptId: success.generationAttemptId,
        externalEffectId: success.effect.effect.effect_id,
        provider: "other-document-provider",
        actor: owner(),
        idempotencyKey: "generation-success-0001",
        now: NOW,
      }),
      "document_generation_idempotency_conflict",
    );
  } finally {
    db.close();
  }
});

test("generation retry ceilings and terminal readback states stay evidence-bound", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const { template } = await fieldAndTemplate(runtime);
    const prepared = await prepareDocumentGenerationInputs(runtime, {
      tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
    });

    await expectCode(
      () => prepareDocumentGenerationInputs(runtime, {
        tenantId: TENANT,
        entityType: "lead",
        entityId: LEAD_ID,
        templateId: template.template_id,
        serviceAuthority: { ...generationServiceAuthority(prepared, 2, "permit:documents:human-owner-0001"), actor: owner() },
        now: NOW,
      }),
      "document_generation_authority_invalid",
    );
    const humanService = {
      ...generationServiceAuthority(prepared, 1, "permit:documents:human-owner-db-0001"),
      actor: owner(),
    };
    const humanServiceEffect = await seedGenerationEffect(
      runtime,
      prepared,
      "generation:documents:human-owner-db-0001",
      "effect:documents:human-owner-db-0001",
      "succeeded",
      { serviceAuthority: humanService },
    );
    const attemptsBeforeHumanServiceDb = Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_attempts",
    ).get() as { count: number }).count);
    assert.throws(() => db.raw.prepare(
      `INSERT INTO document_generation_attempts
       (generation_attempt_id, tenant_id, entity_type, entity_id, template_id, template_revision_id,
        template_version, external_effect_id, provider, authority_kind, actor_type, actor_role, actor_id,
        authority_ref, policy_ref, policy_version, permit_expires_at, max_attempts, stop_policy,
        compensation_policy, input_count, input_snapshot_digest, output_digest, command_fingerprint,
        idempotency_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "generation:documents:human-owner-db-0001", TENANT, "lead", LEAD_ID, template.template_id,
      template.revision_id, template.version, humanServiceEffect.effect.effect_id, "test-document-provider",
      "service", "owner", "owner", OWNER_ID, humanService.permitRef, humanService.policyRef,
      humanService.policyVersion, humanService.expiresAt, humanService.maxAttempts,
      humanService.stopPolicy, humanService.compensationPolicy, prepared.inputs.length,
      prepared.inputSnapshotDigest, prepared.outputDigest, "a".repeat(64), "b".repeat(64), NOW.toISOString(),
    ), /document_generation_service_authority_invalid/);
    assert.equal(Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_attempts",
    ).get() as { count: number }).count), attemptsBeforeHumanServiceDb);
    const boundedService = generationServiceAuthority(prepared, 2, "permit:documents:retry-bound-0001");
    const premature = await beginWithEffect(runtime, prepared, "premature-failure-0001", "failed", {
      retryLimit: 1,
      serviceAuthority: boundedService,
    });
    assert.equal(premature.effect.effect.attempt_count, 1);
    const prematureAttemptBefore = db.raw.prepare(
      "SELECT * FROM document_generation_attempts WHERE generation_attempt_id = ?",
    ).get(premature.generationAttemptId);
    const prematureReceiptsBefore = Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_receipts",
    ).get() as { count: number }).count);
    assert.throws(() => db.raw.prepare(
      `INSERT INTO document_generation_receipts
       (receipt_id, generation_attempt_id, receipt_version, prior_receipt_id, tenant_id, entity_type,
        entity_id, template_id, template_revision_id, template_version, input_snapshot_digest,
        external_effect_id, provider, provider_document_id, output_digest, readback_digest,
        readback_status, terminal_status, reconciliation_outcome, authority_kind, actor_type,
        actor_role, actor_id, authority_ref, policy_ref, policy_version, permit_expires_at,
        max_attempts, stop_policy, compensation_policy, command_fingerprint, idempotency_key_hash,
        created_at)
       SELECT ?, a.generation_attempt_id, 1, NULL, a.tenant_id, a.entity_type, a.entity_id,
              a.template_id, a.template_revision_id, a.template_version, a.input_snapshot_digest,
              a.external_effect_id, a.provider, effect.provider_external_id, a.output_digest,
              effect.readback_hash, 'unavailable', 'failed', 'failed', a.authority_kind,
              a.actor_type, a.actor_role, a.actor_id, a.authority_ref, a.policy_ref,
              a.policy_version, a.permit_expires_at, a.max_attempts, a.stop_policy,
              a.compensation_policy, ?, ?, ?
         FROM document_generation_attempts a
         JOIN external_effects effect ON effect.effect_id = a.external_effect_id
        WHERE a.generation_attempt_id = ?`
    ).run(
      "receipt:documents:premature-failure-db-0001", "e".repeat(64), "f".repeat(64),
      NOW.toISOString(), premature.generationAttemptId,
    ), /document_generation_retry_budget_invalid/);
    assert.deepEqual(db.raw.prepare(
      "SELECT * FROM document_generation_attempts WHERE generation_attempt_id = ?",
    ).get(premature.generationAttemptId), prematureAttemptBefore);
    assert.equal(Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_receipts",
    ).get() as { count: number }).count), prematureReceiptsBefore);
    await expectCode(
      () => recordDocumentGenerationTerminal(runtime, {
        tenantId: TENANT,
        generationAttemptId: premature.generationAttemptId,
        terminalStatus: "failed",
        readbackStatus: "unavailable",
        serviceAuthority: boundedService,
        idempotencyKey: "receipt-documents-premature-failure-0001",
        now: NOW,
      }),
      "document_generation_retry_budget_invalid",
    );
    assert.deepEqual(db.raw.prepare(
      "SELECT * FROM document_generation_attempts WHERE generation_attempt_id = ?",
    ).get(premature.generationAttemptId), prematureAttemptBefore);
    assert.equal(Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_receipts",
    ).get() as { count: number }).count), prematureReceiptsBefore);

    const retried = await premature.effect.rerun("succeeded");
    assert.equal(retried.effect.state, "succeeded");
    assert.equal(retried.effect.attempt_count, 2);
    const recoveredReceipt = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: premature.generationAttemptId,
      terminalStatus: "succeeded",
      readbackStatus: "match",
      providerDocumentId: premature.effect.providerDocumentId,
      outputDigest: prepared.outputDigest,
      readbackDigest: premature.effect.readbackDigest,
      serviceAuthority: boundedService,
      idempotencyKey: "receipt-documents-recovered-success-0001",
      now: NOW,
    });
    assert.equal(recoveredReceipt.receipt.terminal_status, "succeeded");

    const overBudgetService = generationServiceAuthority(prepared, 3, "permit:documents:retry-bound-0002");
    const overBudget = await seedGenerationEffect(
      runtime,
      prepared,
      "generation:documents:db-budget-0001",
      "effect:documents:db-budget-0001",
      "succeeded",
      { retryLimit: 20, effectMaxAttempts: 21, serviceAuthority: overBudgetService },
    );
    const attemptsBeforeDbBudget = Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_attempts",
    ).get() as { count: number }).count);
    await expectCode(
      () => beginDocumentGeneration(runtime, {
        tenantId: TENANT,
        entityType: prepared.template.entity_type,
        entityId: LEAD_ID,
        templateId: prepared.template.template_id,
        templateRevisionId: prepared.template.revision_id,
        generationAttemptId: "generation:documents:db-budget-0001",
        externalEffectId: overBudget.effect.effect_id,
        provider: "test-document-provider",
        serviceAuthority: overBudgetService,
        idempotencyKey: "generation-documents-db-budget-0001",
        now: NOW,
      }),
      "document_generation_retry_budget_invalid",
    );
    assert.throws(() => db.raw.prepare(
      `INSERT INTO document_generation_attempts
       (generation_attempt_id, tenant_id, entity_type, entity_id, template_id, template_revision_id,
        template_version, external_effect_id, provider, authority_kind, actor_type, actor_role, actor_id,
        authority_ref, policy_ref, policy_version, permit_expires_at, max_attempts, stop_policy,
        compensation_policy, input_count, input_snapshot_digest, output_digest, command_fingerprint,
        idempotency_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "generation:documents:db-budget-0001", TENANT, "lead", LEAD_ID, template.template_id,
      template.revision_id, template.version, overBudget.effect.effect_id, "test-document-provider",
      "service", overBudgetService.actor.type, overBudgetService.actor.role, overBudgetService.actor.userId,
      overBudgetService.permitRef, overBudgetService.policyRef,
      overBudgetService.policyVersion, overBudgetService.expiresAt, overBudgetService.maxAttempts,
      overBudgetService.stopPolicy, overBudgetService.compensationPolicy, prepared.inputs.length,
      prepared.inputSnapshotDigest, prepared.outputDigest, "a".repeat(64), "b".repeat(64), NOW.toISOString(),
    ), /document_generation_retry_budget_invalid/);
    assert.equal(Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_attempts",
    ).get() as { count: number }).count), attemptsBeforeDbBudget);

    const failed = await beginWithEffect(runtime, prepared, "failed-0001", "failed");
    const failedReceipt = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: failed.generationAttemptId,
      terminalStatus: "failed",
      readbackStatus: "unavailable",
      actor: owner(),
      idempotencyKey: "receipt-documents-failed-0001",
      now: NOW,
    });
    assert.equal(failedReceipt.receipt.terminal_status, "failed");
    const unknown = await beginWithEffect(runtime, prepared, "unknown-0001", "unknown");
    const unknownAttemptBefore = db.raw.prepare(
      "SELECT * FROM document_generation_attempts WHERE generation_attempt_id = ?",
    ).get(unknown.generationAttemptId);
    const unknownReceiptsBefore = Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_receipts",
    ).get() as { count: number }).count);
    assert.throws(() => db.raw.prepare(
      `INSERT INTO document_generation_receipts
       (receipt_id, generation_attempt_id, receipt_version, prior_receipt_id, tenant_id, entity_type,
        entity_id, template_id, template_revision_id, template_version, input_snapshot_digest,
        external_effect_id, provider, provider_document_id, output_digest, readback_digest,
        readback_status, terminal_status, reconciliation_outcome, authority_kind, actor_type,
        actor_role, actor_id, authority_ref, policy_ref, policy_version, permit_expires_at,
        max_attempts, stop_policy, compensation_policy, command_fingerprint, idempotency_key_hash,
        created_at)
       SELECT ?, a.generation_attempt_id, 1, NULL, a.tenant_id, a.entity_type, a.entity_id,
              a.template_id, a.template_revision_id, a.template_version, a.input_snapshot_digest,
              a.external_effect_id, a.provider, NULL, a.output_digest, NULL,
              'unavailable', 'unknown', 'unknown', a.authority_kind, a.actor_type, a.actor_role,
              a.actor_id, a.authority_ref, a.policy_ref, a.policy_version, a.permit_expires_at,
              a.max_attempts, a.stop_policy, a.compensation_policy, ?, ?, ?
         FROM document_generation_attempts a
        WHERE a.generation_attempt_id = ?`
    ).run(
      "receipt:documents:unknown-omitted-provider-0001", "c".repeat(64), "d".repeat(64),
      NOW.toISOString(), unknown.generationAttemptId,
    ), /document_generation_receipt_terminal_invalid/);
    assert.deepEqual(db.raw.prepare(
      "SELECT * FROM document_generation_attempts WHERE generation_attempt_id = ?",
    ).get(unknown.generationAttemptId), unknownAttemptBefore);
    assert.equal(Number((db.raw.prepare(
      "SELECT COUNT(*) AS count FROM document_generation_receipts",
    ).get() as { count: number }).count), unknownReceiptsBefore);
    await expectCode(
      () => recordDocumentGenerationTerminal(runtime, {
        tenantId: TENANT,
        generationAttemptId: unknown.generationAttemptId,
        terminalStatus: "unknown",
        readbackStatus: "conflict",
        actor: owner(),
        idempotencyKey: "receipt-documents-unknown-as-conflict-0001",
        now: NOW,
      }),
      "document_generation_readback_invalid",
    );
    await expectCode(
      () => recordDocumentGenerationTerminal(runtime, {
        tenantId: TENANT,
        generationAttemptId: unknown.generationAttemptId,
        terminalStatus: "succeeded",
        readbackStatus: "match",
        providerDocumentId: unknown.effect.providerDocumentId,
        outputDigest: prepared.outputDigest,
        readbackDigest: unknown.effect.readbackDigest,
        actor: owner(),
        idempotencyKey: "receipt-documents-unknown-as-success-0001",
        now: NOW,
      }),
      "document_generation_success_readback_invalid",
    );
    const unknownReceipt = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: unknown.generationAttemptId,
      terminalStatus: "unknown",
      readbackStatus: "unavailable",
      providerDocumentId: unknown.effect.providerDocumentId,
      actor: owner(),
      idempotencyKey: "receipt-documents-unknown-0001",
      now: NOW,
    });
    assert.equal(unknownReceipt.receipt.terminal_status, "unknown");

    const reconciled = await reconcileExternalEffect(runtime, unknown.effect.effect.effect_id, {
      outcome: "executed",
      evidence: unknown.effect.expectedReadback,
      now: NOW.toISOString(),
    });
    assert.equal(reconciled.state, "succeeded");
    const successAfterUnknown = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: unknown.generationAttemptId,
      terminalStatus: "succeeded",
      readbackStatus: "match",
      providerDocumentId: unknown.effect.providerDocumentId,
      outputDigest: prepared.outputDigest,
      readbackDigest: unknown.effect.readbackDigest,
      actor: owner(),
      idempotencyKey: "receipt-documents-unknown-reconciled-0001",
      now: NOW,
    });
    assert.equal(successAfterUnknown.receipt.receipt_version, 2);
    assert.equal(successAfterUnknown.receipt.prior_receipt_id, unknownReceipt.receipt.receipt_id);

    const manual = await beginWithEffect(runtime, prepared, "manual-exception-0001", "conflict");
    await expectCode(
      () => recordDocumentGenerationTerminal(runtime, {
        tenantId: TENANT,
        generationAttemptId: manual.generationAttemptId,
        terminalStatus: "unknown",
        readbackStatus: "unavailable",
        actor: owner(),
        idempotencyKey: "receipt-documents-manual-as-unavailable-0001",
        now: NOW,
      }),
      "document_generation_readback_invalid",
    );
    const manualReceipt = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: manual.generationAttemptId,
      terminalStatus: "unknown",
      reconciliationOutcome: "manual_exception",
      readbackStatus: "conflict",
      providerDocumentId: manual.effect.providerDocumentId,
      readbackDigest: manual.effect.conflictReadbackDigest,
      actor: owner(),
      idempotencyKey: "receipt-documents-manual-conflict-0001",
      now: NOW,
    });
    assert.equal(manualReceipt.receipt.readback_status, "conflict");
    assert.equal(manualReceipt.receipt.reconciliation_outcome, "manual_exception");

    const notExecuted = await beginWithEffect(runtime, prepared, "not-executed-0001", "unknown");
    const reconciledNotExecuted = await reconcileExternalEffect(runtime, notExecuted.effect.effect.effect_id, {
      outcome: "not_executed",
      evidence: { provider_document_id: notExecuted.effect.providerDocumentId, status: "not_found" },
      now: NOW.toISOString(),
    });
    const notExecutedReceipt = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: notExecuted.generationAttemptId,
      terminalStatus: "unknown",
      reconciliationOutcome: "not_executed",
      readbackStatus: "not_found",
      providerDocumentId: notExecuted.effect.providerDocumentId,
      readbackDigest: reconciledNotExecuted.readback_hash,
      actor: owner(),
      idempotencyKey: "receipt-documents-not-executed-0001",
      now: NOW,
    });
    assert.equal(notExecutedReceipt.receipt.reconciliation_outcome, "not_executed");
    assert.equal((db.raw.prepare(
      "SELECT settled_outcome FROM document_generation_receipts WHERE receipt_id = ?",
    ).get(notExecutedReceipt.receipt.receipt_id) as { settled_outcome: string }).settled_outcome, "not_executed");
  } finally {
    db.close();
  }
});

test("generation scope and append-only guards preserve exact failed-write snapshots", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const { template } = await fieldAndTemplate(runtime);
    const prepared = await prepareDocumentGenerationInputs(runtime, {
      tenantId: TENANT, entityType: "lead", entityId: LEAD_ID, templateId: template.template_id, actor: owner(), now: NOW,
    });
    const started = await beginWithEffect(runtime, prepared, "guards-0001");
    const attempt = started.started.attempt;
    const input = attempt.inputs[0]!;
    const attemptCount = () => Number((db.raw.prepare("SELECT COUNT(*) AS count FROM document_generation_attempts").get() as { count: number }).count);
    const inputCount = () => Number((db.raw.prepare("SELECT COUNT(*) AS count FROM document_generation_inputs").get() as { count: number }).count);
    const attemptsBefore = attemptCount();
    const inputsBefore = inputCount();
    assert.throws(
      () => db.raw.prepare("UPDATE document_generation_attempts SET output_digest = ?").run("0".repeat(64)),
      /document_generation_attempts_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM document_generation_attempts").run(),
      /document_generation_attempts_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO document_generation_attempts SELECT * FROM document_generation_attempts LIMIT 1").run(),
      /document_generation_attempts_append_only|document_generation_attempt_duplicate/,
    );
    assert.equal(attemptCount(), attemptsBefore);

    const inputInsert = db.raw.prepare(
      `INSERT INTO document_generation_inputs
       (generation_attempt_id, tenant_id, sequence, entity_type, entity_id, field_id,
        field_definition_revision_id, field_definition_version, value_revision_id, value_version,
        value_digest, value_json, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const scope of [
      [OTHER_TENANT, "lead", OTHER_LEAD_ID],
      [TENANT, "lead", OTHER_LEAD_ID],
    ] as const) {
      assert.throws(
        () => inputInsert.run(
          attempt.generation_attempt_id, scope[0], scope[1], scope[2], "field:documents:unbound",
          input.field_definition_revision_id, input.field_definition_version, input.value_revision_id,
          input.value_version, input.value_digest, canonicalJson(input.value), NOW.toISOString(),
        ),
        /document_generation_input_scope_invalid|FOREIGN KEY/,
      );
      assert.equal(inputCount(), inputsBefore);
    }
    assert.throws(
      () => inputInsert.run(
        attempt.generation_attempt_id, TENANT, "lead", LEAD_ID, input.field_id,
        input.field_definition_revision_id, input.field_definition_version, input.value_revision_id,
        input.value_version, input.value_digest, JSON.stringify("forged"), NOW.toISOString(),
      ),
      /document_generation_inputs_append_only|document_generation_input_value_invalid/,
    );
    assert.equal(inputCount(), inputsBefore);
    assert.throws(
      () => db.raw.prepare("UPDATE document_generation_inputs SET value_json = 'null'").run(),
      /document_generation_inputs_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM document_generation_inputs").run(),
      /document_generation_inputs_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO document_generation_inputs SELECT * FROM document_generation_inputs LIMIT 1").run(),
      /document_generation_inputs_append_only|document_generation_input_duplicate/,
    );
    assert.equal(inputCount(), inputsBefore);

    const terminal = await recordDocumentGenerationTerminal(runtime, {
      tenantId: TENANT,
      generationAttemptId: started.generationAttemptId,
      externalEffectId: started.effect.effect.effect_id,
      provider: "test-document-provider",
      terminalStatus: "succeeded",
      readbackStatus: "match",
      providerDocumentId: started.effect.providerDocumentId,
      outputDigest: prepared.outputDigest,
      readbackDigest: started.effect.readbackDigest,
      actor: owner(),
      idempotencyKey: "receipt-documents-guards-0001",
      now: NOW,
    });
    const receiptCount = () => Number((db.raw.prepare("SELECT COUNT(*) AS count FROM document_generation_receipts").get() as { count: number }).count);
    const receiptsBefore = receiptCount();
    assert.throws(
      () => db.raw.prepare("UPDATE document_generation_receipts SET output_digest = ?").run("0".repeat(64)),
      /document_generation_receipts_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM document_generation_receipts").run(),
      /document_generation_receipts_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO document_generation_receipts SELECT * FROM document_generation_receipts LIMIT 1").run(),
      /document_generation_receipts_append_only|document_generation_receipt_duplicate/,
    );
    assert.equal(receiptCount(), receiptsBefore);
    assert.equal(terminal.receipt.attempt?.inputs[0]?.value_revision_id, input.value_revision_id);
  } finally {
    db.close();
  }
});
