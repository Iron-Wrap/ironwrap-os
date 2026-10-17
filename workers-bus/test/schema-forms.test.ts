import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import { canonicalJson } from "../src/newo-hash.ts";
import {
  createSchemaFieldDefinition,
  listAuthorizedSchemaFieldValues,
  listSchemaFieldDefinitionRevisions,
  listSchemaFieldValueRevisions,
  recordSchemaFieldValue,
  reviseSchemaFieldDefinition,
  SchemaFormsError,
  type RecordSchemaFieldValueInput,
  type SchemaFieldActor,
  type SchemaFieldDefinitionInput,
} from "../src/schema-forms.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "othertenant";
const LEAD_ID = "lead:schema:0001";
const OTHER_LEAD_ID = "lead:schema:0002";
const OWNER_ID = "appu_schema_owner";
const OPS_ID = "appu_schema_ops";
const SALES_ID = "appu_schema_sales";
const FIELD_ID = "appu_schema_field";
const UNASSIGNED_FIELD_ID = "appu_schema_unassigned";
const JOB_ID = "job:schema:assigned:0001";
const NOW = new Date("2026-08-27T08:00:00.000Z");

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

  constructor(database: DatabaseSync, statement: StatementSync, args: unknown[] = []) {
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
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never } as AppEnv;
}

function actor(role: "owner" | "ops" | "sales" | "field", userId = role === "owner" ? OWNER_ID : role === "ops" ? OPS_ID : role === "sales" ? SALES_ID : FIELD_ID): SchemaFieldActor {
  return { type: role === "owner" ? "owner" : role === "field" ? "worker" : "agent", role, userId };
}

function definition(overrides: Partial<SchemaFieldDefinitionInput> = {}): SchemaFieldDefinitionInput {
  return {
    tenantId: TENANT,
    entityType: "lead",
    fieldKey: "roof-color",
    label: "Roof colour",
    position: 1,
    fieldType: "text",
    validatorKey: "none",
    validatorConfig: {},
    visibilityKey: "always",
    visibilityConfig: {},
    evidenceClass: "source",
    retentionPolicy: "standard",
    offlineMode: "online_only",
    readScope: "all",
    writeScope: "all",
    readRoles: ["owner", "ops"],
    writeRoles: ["owner", "ops"],
    active: true,
    actor: actor("owner"),
    idempotencyKey: "schema-definition-create-0001",
    ...overrides,
  };
}

function valueInput(fieldId: string, overrides: Partial<RecordSchemaFieldValueInput> = {}): RecordSchemaFieldValueInput {
  return {
    tenantId: TENANT,
    entityType: "lead",
    entityId: LEAD_ID,
    fieldId,
    expectedVersion: 0,
    value: "blue",
    actor: actor("owner"),
    idempotencyKey: "schema-value-create-0001",
    ...overrides,
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof SchemaFormsError && error.code === code);
}

test("schema field definition revisions are closed, attributable, replay-safe, and immutable", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ actor: actor("sales"), idempotencyKey: "schema-definition-sales-0001" }), NOW),
      "schema_field_definition_forbidden",
    );
    const fieldWorker = { ...actor("field"), authorityRef: "delegated:schema-field-worker-0001" };
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({
        fieldKey: "worker-definition-create",
        actor: fieldWorker,
        idempotencyKey: "schema-definition-worker-create-0001",
      }), NOW),
      "schema_field_definition_forbidden",
    );
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ validatorKey: "regex", idempotencyKey: "schema-definition-regex-0001" }), NOW),
      "schema_field_validator_invalid",
    );
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ fieldKey: "unbounded-select", fieldType: "select", idempotencyKey: "schema-definition-select-0001" }), NOW),
      "schema_field_validator_config_invalid",
    );
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ fieldKey: "empty-select", fieldType: "select", validatorKey: "options", validatorConfig: { options: [] }, idempotencyKey: "schema-definition-empty-select-0001" }), NOW),
      "schema_field_validator_config_invalid",
    );
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ fieldKey: "bad-range", fieldType: "number", validatorKey: "range", validatorConfig: { min: 10, max: 1 }, idempotencyKey: "schema-definition-bad-range-0001" }), NOW),
      "schema_field_validator_config_invalid",
    );

    const first = await createSchemaFieldDefinition(runtime, definition(), NOW);
    assert.equal(first.kind, "created");
    assert.equal(first.definition.version, 1);
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        label: "Worker must not revise",
        action: "relabel",
        expectedVersion: 1,
        actor: fieldWorker,
        idempotencyKey: "schema-definition-worker-revise-0001",
      }), NOW),
      "schema_field_definition_forbidden",
    );
    const undelegatedOpsWorker: SchemaFieldActor = { type: "worker", role: "ops", userId: OPS_ID };
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({
        fieldKey: "worker-definition-without-permit",
        actor: undelegatedOpsWorker,
        idempotencyKey: "schema-definition-worker-no-permit-0001",
      }), NOW),
      "schema_field_definition_forbidden",
    );
    const delegatedOpsWorker: SchemaFieldActor = {
      type: "worker",
      role: "ops",
      userId: OPS_ID,
      authorityRef: "delegated:schema-ops-worker-0001",
    };
    const workerDefinition = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "worker-definition-allowed",
      actor: delegatedOpsWorker,
      idempotencyKey: "schema-definition-worker-allowed-0001",
    }), NOW);
    assert.equal(workerDefinition.kind, "created");
    const workerRevision = await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: workerDefinition.definition.field_id,
      fieldKey: "worker-definition-allowed",
      label: "Worker definition (confirmed)",
      action: "relabel",
      expectedVersion: 1,
      actor: delegatedOpsWorker,
      idempotencyKey: "schema-definition-worker-revision-0001",
    }), NOW);
    assert.equal(workerRevision.kind, "created");
    assert.equal(workerRevision.definition.actor_type, "worker");
    assert.equal(workerRevision.definition.actor_role, "ops");
    const replay = await createSchemaFieldDefinition(runtime, definition(), NOW);
    assert.equal(replay.kind, "replayed");
    assert.equal(replay.definition.revision_id, first.definition.revision_id);
    await expectCode(
      () => createSchemaFieldDefinition(runtime, definition({ label: "Different", idempotencyKey: definition().idempotencyKey }), NOW),
      "schema_field_idempotency_conflict",
    );

    const relabel = await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: first.definition.field_id,
      label: "Roof colour (confirmed)",
      action: "relabel",
      expectedVersion: 1,
      idempotencyKey: "schema-definition-relabel-0001",
      actor: actor("ops"),
    }), NOW);
    assert.equal(relabel.kind, "created");
    assert.equal(relabel.definition.version, 2);
    assert.equal(relabel.definition.prior_revision_id, first.definition.revision_id);
    const relabelReplay = await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: first.definition.field_id,
      label: "Roof colour (confirmed)",
      action: "relabel",
      expectedVersion: 1,
      idempotencyKey: "schema-definition-relabel-0001",
      actor: actor("ops"),
    }), NOW);
    assert.equal(relabelReplay.kind, "replayed");
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        label: "Another label",
        action: "relabel",
        validatorKey: "required",
        expectedVersion: 2,
        idempotencyKey: "schema-definition-relabel-config-0001",
      }), NOW),
      "schema_field_action_invalid",
    );
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        action: "create",
        expectedVersion: 2,
        idempotencyKey: "schema-definition-create-revise-0001",
      }), NOW),
      "schema_field_action_invalid",
    );
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        label: "Stale",
        expectedVersion: 1,
        idempotencyKey: "schema-definition-stale-0001",
      }), NOW),
      "schema_field_definition_version_conflict",
    );

    const held = await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: first.definition.field_id,
      retentionPolicy: "legal_hold",
      expectedVersion: 2,
      idempotencyKey: "schema-definition-hold-0001",
    }), NOW);
    assert.equal(held.definition.retention_policy, "legal_hold");
    const heldReplay = await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: first.definition.field_id,
      retentionPolicy: "legal_hold",
      expectedVersion: 2,
      idempotencyKey: "schema-definition-hold-0001",
    }), NOW);
    assert.equal(heldReplay.kind, "replayed");
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        fieldType: "number",
        expectedVersion: 3,
        idempotencyKey: "schema-definition-type-change-0001",
      }), NOW),
      "schema_field_type_immutable",
    );
    await expectCode(
      () => reviseSchemaFieldDefinition(runtime, definition({
        fieldId: first.definition.field_id,
        retentionPolicy: "extended",
        expectedVersion: 3,
        idempotencyKey: "schema-definition-weaken-0001",
      }), NOW),
      "schema_field_retention_hold",
    );

    assert.throws(
      () => db.raw.prepare("UPDATE schema_field_definition_revisions SET label = 'rewritten'").run(),
      /schema_field_definition_revisions_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM schema_field_definition_revisions").run(),
      /schema_field_definition_revisions_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO schema_field_definition_revisions SELECT * FROM schema_field_definition_revisions LIMIT 1").run(),
      /schema_field_definition_revision_duplicate|schema_field_definition_revisions_append_only/,
    );
    const revisions = await listSchemaFieldDefinitionRevisions(runtime, TENANT, first.definition.field_id);
    assert.deepEqual(revisions.map((revision) => revision.version), [1, 2, 3]);
  } finally {
    db.close();
  }
});

test("schema field values enforce server-side visibility, CAS correction lineage, and omission", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const status = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "status",
      label: "Status",
      idempotencyKey: "schema-definition-status-0001",
    }), NOW);
    const dependent = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "completion-note",
      label: "Completion note",
      visibilityKey: "when_field_present",
      visibilityConfig: { field_key: "status" },
      idempotencyKey: "schema-definition-dependent-0001",
    }), NOW);

    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(dependent.definition.field_id, {
        value: "too early",
        idempotencyKey: "schema-value-hidden-0001",
      }), NOW),
      "schema_field_not_visible",
    );
    const statusValue = await recordSchemaFieldValue(runtime, valueInput(status.definition.field_id, {
      value: "ready",
      idempotencyKey: "schema-value-status-0001",
    }), NOW);
    const dependentValue = await recordSchemaFieldValue(runtime, valueInput(dependent.definition.field_id, {
      value: "finished",
      idempotencyKey: "schema-value-dependent-0001",
    }), NOW);
    assert.equal(dependentValue.value.version, 1);

    const numberField = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "amount",
      label: "Amount",
      fieldType: "number",
      validatorKey: "nonnegative",
      idempotencyKey: "schema-definition-amount-0001",
    }), NOW);
    const first = await recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
      value: 10,
      idempotencyKey: "schema-value-amount-0001",
    }), NOW);
    await reviseSchemaFieldDefinition(runtime, definition({
      fieldId: numberField.definition.field_id,
      fieldKey: "amount",
      label: "Amount (confirmed)",
      fieldType: "number",
      validatorKey: "nonnegative",
      action: "relabel",
      expectedVersion: 1,
      idempotencyKey: "schema-definition-amount-relabel-0001",
    }), NOW);
    const replay = await recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
      value: 10,
      idempotencyKey: "schema-value-amount-0001",
    }), NOW);
    assert.equal(replay.kind, "replayed");
    assert.equal(replay.value.value_revision_id, first.value.value_revision_id);
    const headBeforeStale = db.raw.prepare(
      `SELECT current_revision_id, current_version FROM schema_field_value_heads
        WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ?`,
    ).get(TENANT, "lead", LEAD_ID, numberField.definition.field_id);
    const revisionsBeforeStale = Number(db.raw.prepare(
      `SELECT COUNT(*) AS count FROM schema_field_value_revisions
        WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ?`,
    ).get(TENANT, "lead", LEAD_ID, numberField.definition.field_id).count);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
        value: 11,
        idempotencyKey: "schema-value-amount-0001",
      }), NOW),
      "schema_field_idempotency_conflict",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
        value: 11,
        expectedVersion: 0,
        idempotencyKey: "schema-value-amount-stale-0001",
      }), NOW),
      "schema_field_value_version_conflict",
    );
    const headAfterStale = db.raw.prepare(
      `SELECT current_revision_id, current_version FROM schema_field_value_heads
        WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ?`,
    ).get(TENANT, "lead", LEAD_ID, numberField.definition.field_id);
    const revisionsAfterStale = Number(db.raw.prepare(
      `SELECT COUNT(*) AS count FROM schema_field_value_revisions
        WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? AND field_id = ?`,
    ).get(TENANT, "lead", LEAD_ID, numberField.definition.field_id).count);
    assert.deepEqual(headAfterStale, headBeforeStale);
    assert.equal(revisionsAfterStale, revisionsBeforeStale);
    const correction = await recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
      value: 11,
      expectedVersion: 1,
      basedOnValueRevisionId: first.value.value_revision_id,
      correctionReason: "Corrected from source receipt",
      idempotencyKey: "schema-value-amount-correction-0001",
    }), NOW);
    assert.equal(correction.value.version, 2);
    assert.equal(correction.value.prior_value_revision_id, first.value.value_revision_id);
    const dateField = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "inspection-date",
      label: "Inspection date",
      fieldType: "date",
      validatorKey: "date",
      idempotencyKey: "schema-definition-date-0001",
    }), NOW);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(dateField.definition.field_id, {
        value: "2026-02-31",
        idempotencyKey: "schema-value-date-invalid-0001",
      }), NOW),
      "schema_field_value_type_invalid",
    );
    const datetimeField = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "inspection-at",
      label: "Inspection at",
      fieldType: "datetime",
      validatorKey: "datetime",
      idempotencyKey: "schema-definition-datetime-0001",
    }), NOW);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(datetimeField.definition.field_id, {
        value: "2026-08-27T08:00:00Z",
        idempotencyKey: "schema-value-datetime-noncanonical-0001",
      }), NOW),
      "schema_field_value_type_invalid",
    );
    const otherNumber = await createSchemaFieldDefinition(runtime, definition({
      tenantId: OTHER_TENANT,
      fieldKey: "amount",
      label: "Amount",
      fieldType: "number",
      validatorKey: "nonnegative",
      idempotencyKey: "schema-definition-other-amount-0001",
    }), NOW);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(otherNumber.definition.field_id, {
        tenantId: OTHER_TENANT,
        entityId: OTHER_LEAD_ID,
        value: 12,
        basedOnValueRevisionId: first.value.value_revision_id,
        correctionReason: "Cross-tenant reference",
        idempotencyKey: "schema-value-cross-tenant-0001",
      }), NOW),
      "schema_field_lineage_invalid",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
        value: 12,
        expectedVersion: 2,
        basedOnValueRevisionId: statusValue.value.value_revision_id,
        correctionReason: "Cross-scope reference",
        idempotencyKey: "schema-value-cross-field-0001",
      }), NOW),
      "schema_field_lineage_invalid",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
        value: 12,
        expectedVersion: 2,
        idempotencyKey: "schema-value-correction-without-lineage-0001",
        correctionReason: "Missing reference",
      }), NOW),
      "schema_field_correction_reference_required",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(numberField.definition.field_id, {
        value: 12,
        actor: actor("sales"),
        expectedVersion: 2,
        idempotencyKey: "schema-value-sales-0001",
      }), NOW),
      "schema_field_write_forbidden",
    );

    const omitted = await listAuthorizedSchemaFieldValues(runtime, TENANT, "lead", LEAD_ID, actor("sales"));
    assert.deepEqual(omitted, []);
    const visible = await listAuthorizedSchemaFieldValues(runtime, TENANT, "lead", LEAD_ID, actor("owner"));
    assert.equal(visible.find((entry) => entry.definition.field_id === numberField.definition.field_id)?.value?.version, 2);
    assert.equal(visible.every((entry) => typeof entry.writable === "boolean"), true);
    assert.equal(visible.find((entry) => entry.definition.field_id === numberField.definition.field_id)?.writable, true);
    const history = await listSchemaFieldValueRevisions(runtime, TENANT, "lead", LEAD_ID, numberField.definition.field_id, actor("owner"));
    assert.deepEqual(history.map((value) => value.version), [1, 2]);
    const hiddenHistory = await listSchemaFieldValueRevisions(runtime, TENANT, "lead", LEAD_ID, numberField.definition.field_id, actor("sales"));
    assert.deepEqual(hiddenHistory, []);
    assert.throws(
      () => db.raw.prepare("UPDATE schema_field_value_revisions SET value_json = '12'").run(),
      /schema_field_value_revisions_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("DELETE FROM schema_field_value_revisions").run(),
      /schema_field_value_revisions_append_only/,
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO schema_field_value_revisions SELECT * FROM schema_field_value_revisions LIMIT 1").run(),
      /schema_field_value_revision_duplicate|schema_field_value_revisions_append_only/,
    );
    assert.equal(dependentValue.value.value, "finished");
  } finally {
    db.close();
  }
});

test("schema field authority intersects tenant grants with platform permissions and assignments", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    seedJobAuthority(db.raw);
    const jobField = await createSchemaFieldDefinition(runtime, definition({
      entityType: "job",
      fieldKey: "crew-note",
      label: "Crew note",
      readRoles: ["field"],
      writeRoles: ["field"],
      readScope: "all",
      writeScope: "all",
      idempotencyKey: "schema-definition-job-crew-note-0001",
    }), NOW);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(jobField.definition.field_id, {
        entityType: "job",
        entityId: JOB_ID,
        actor: actor("field", UNASSIGNED_FIELD_ID),
        value: "unassigned write",
        idempotencyKey: "schema-value-job-unassigned-0001",
      }), NOW),
      "schema_field_assignment_forbidden",
    );
    const assigned = await recordSchemaFieldValue(runtime, valueInput(jobField.definition.field_id, {
      entityType: "job",
      entityId: JOB_ID,
      actor: actor("field"),
      value: "installed note",
      idempotencyKey: "schema-value-job-assigned-0001",
    }), NOW);
    assert.equal(assigned.value.value, "installed note");
    assert.deepEqual(
      await listAuthorizedSchemaFieldValues(runtime, TENANT, "job", JOB_ID, actor("field", UNASSIGNED_FIELD_ID)),
      [],
    );
    const assignedRead = await listAuthorizedSchemaFieldValues(runtime, TENANT, "job", JOB_ID, actor("field"));
    assert.equal(assignedRead[0]?.value?.value, "installed note");
    // The case ELEC-192 exists for: the assigned crew member just wrote this field, so the card
    // they read has to say they may. `writable` is derived from the same predicate that accepted
    // the write above, never stored, so the two cannot disagree.
    assert.equal(assignedRead[0]?.writable, true);
    assert.deepEqual(
      await listAuthorizedSchemaFieldValues(runtime, TENANT, "job", JOB_ID, actor("owner")),
      [],
    );

    const leadField = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "field-only-lead",
      label: "Field-only lead",
      readRoles: ["field"],
      writeRoles: ["field"],
      idempotencyKey: "schema-definition-lead-field-only-0001",
    }), NOW);
    assert.deepEqual(
      await listAuthorizedSchemaFieldValues(runtime, TENANT, "lead", LEAD_ID, actor("field")),
      [],
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(leadField.definition.field_id, {
        actor: actor("field"),
        idempotencyKey: "schema-value-lead-field-only-0001",
      }), NOW),
      "schema_field_write_forbidden",
    );
  } finally {
    db.close();
  }
});

test("schema evidence references bind scope and provider facts to succeeded effect readback", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  try {
    const image = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "site-photo",
      label: "Site photo",
      fieldType: "image",
      evidenceClass: "physical",
      idempotencyKey: "schema-definition-image-0001",
    }), NOW);
    const imageValue = {
      receipt_id: "receipt:schema:object:0001",
      object_ref: "r2://ironwrap/evidence/schema-photo-0001",
      digest: "a".repeat(64),
      tenant_id: TENANT,
      entity_type: "lead",
      entity_id: LEAD_ID,
      field_id: image.definition.field_id,
      actor_type: "owner",
      actor_id: OWNER_ID,
      captured_at: NOW.toISOString(),
      evidence_class: "physical",
    };
    seedObjectReceipt(db.raw, image.definition, imageValue);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
        value: imageValue,
        evidenceRef: `evidence-upload://evu_${"a".repeat(64)}`,
        idempotencyKey: "schema-value-upload-ref-forged-0001",
      }), NOW),
      "schema_field_evidence_ref_invalid",
    );
    const stored = await recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
      value: imageValue,
      idempotencyKey: "schema-value-image-0001",
    }), NOW);
    assert.equal(stored.value.value_digest.length, 64);
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
        value: { ...imageValue, tenant_id: OTHER_TENANT },
        idempotencyKey: "schema-value-image-cross-tenant-0001",
      }), NOW),
      "schema_field_image_reference_scope_invalid",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
        value: "https://example.invalid/photo.jpg",
        idempotencyKey: "schema-value-image-url-0001",
      }), NOW),
      "schema_field_object_reference_invalid",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
        value: { ...imageValue, receipt_id: "receipt:schema:object:forged" },
        idempotencyKey: "schema-value-image-forged-receipt-0001",
      }), NOW),
      "schema_field_object_receipt_required",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(image.definition.field_id, {
        value: { ...imageValue, digest: "b".repeat(64) },
        idempotencyKey: "schema-value-image-mismatched-receipt-0001",
      }), NOW),
      "schema_field_object_receipt_required",
    );

    const provider = await createSchemaFieldDefinition(runtime, definition({
      fieldKey: "provider-status",
      label: "Provider status",
      fieldType: "provider_fact",
      validatorKey: "provider_receipt",
      evidenceClass: "authority",
      idempotencyKey: "schema-definition-provider-0001",
    }), NOW);
    const providerValue = {
      status: "succeeded",
      provider: "test-provider",
      receipt_id: "effect:schema:provider:1",
      provider_version: "v1",
      provider_external_id: "provider:schema:1",
      action: "schema_field.provider_fact.read",
      aggregate_type: "schema_field_value",
      aggregate_id: `schema-value:lead:${LEAD_ID}:${provider.definition.field_id}`,
      aggregate_version: 1,
      expected_readback_schema: "ironwrap.schema-field-provider-fact.v1",
      field_definition_revision_id: provider.definition.revision_id,
      value_version: 1,
      tenant_id: TENANT,
      entity_type: "lead",
      entity_id: LEAD_ID,
      field_id: provider.definition.field_id,
      readback_digest: "d".repeat(64),
    };
    const providerDigest = sha256(canonicalJson(providerValue));
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(provider.definition.field_id, {
        value: providerValue,
        providerReceiptId: "effect:schema:provider:1",
        idempotencyKey: "schema-value-provider-before-receipt-0001",
      }), NOW),
      "schema_field_provider_receipt_required",
    );
    seedSucceededEffect(db.raw, {
      effectId: "effect:schema:provider:1",
      field: provider.definition,
      aggregateId: providerValue.aggregate_id,
      expectedValueDigest: providerDigest,
      readbackHash: providerValue.readback_digest,
    });
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(provider.definition.field_id, {
        value: providerValue,
        providerReceiptId: "effect:schema:provider:1",
        idempotencyKey: "schema-value-provider-before-evidence-receipt-0001",
      }), NOW),
      "schema_field_provider_receipt_required",
    );
    seedProviderReceipt(db.raw, provider.definition, providerValue, providerDigest);
    const storedProvider = await recordSchemaFieldValue(runtime, valueInput(provider.definition.field_id, {
      value: providerValue,
      providerReceiptId: "effect:schema:provider:1",
      idempotencyKey: "schema-value-provider-0001",
    }), NOW);
    assert.equal(storedProvider.value.provider_receipt_id, "effect:schema:provider:1");
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(provider.definition.field_id, {
        value: { ...providerValue, provider: "other-provider" },
        providerReceiptId: "effect:schema:provider:1",
        idempotencyKey: "schema-value-provider-cross-provider-0001",
      }), NOW),
      "schema_field_provider_receipt_required",
    );
    await expectCode(
      () => recordSchemaFieldValue(runtime, valueInput(provider.definition.field_id, {
        value: { ...providerValue, field_id: "field:other:0000001" },
        providerReceiptId: "effect:schema:provider:1",
        idempotencyKey: "schema-value-provider-cross-field-0001",
      }), NOW),
      "schema_field_provider_scope_invalid",
    );
    assert.throws(
      () => db.raw.prepare("INSERT OR REPLACE INTO schema_field_evidence_receipts SELECT * FROM schema_field_evidence_receipts LIMIT 1").run(),
      /schema_field_evidence_receipts_append_only|schema_field_evidence_receipt_duplicate/,
    );
  } finally {
    db.close();
  }
});

function seed(db: DatabaseSync): void {
  const now = NOW.toISOString();
  for (const [userId, role, accessRole, email, frappeUserId] of [
    [OWNER_ID, "owner", "owner", "schema-owner@example.invalid", null],
    [OPS_ID, "ops", "ops", "schema-ops@example.invalid", null],
    [SALES_ID, "ops", "sales", "schema-sales@example.invalid", null],
    [FIELD_ID, "field", "field", "schema-field@example.invalid", "schema-field-frappe"],
    [UNASSIGNED_FIELD_ID, "field", "field", "schema-unassigned@example.invalid", "schema-unassigned-frappe"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
    ).run(userId, TENANT, email, userId, role, accessRole, frappeUserId, now, now);
  }
  for (const [tenantId, leadId, envelopeId] of [
    [TENANT, LEAD_ID, "ow_schema_0001"],
    [OTHER_TENANT, OTHER_LEAD_ID, "ow_schema_0002"],
  ] as const) {
    db.prepare(
      `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status, created_at, updated_at)
       VALUES (?, 'manual', 'Schema Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
    ).run(envelopeId, `${leadId}@example.invalid`, `raw/schema/${leadId}.json`, now, now, now);
    db.prepare(
      `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'Schema Customer', ?, 'qualified', 1, ?, ?)`,
    ).run(leadId, tenantId, envelopeId, `raw/schema/${leadId}.json`, `${leadId}@example.invalid`, now, now);
  }
}

function seedJobAuthority(db: DatabaseSync): void {
  const now = NOW.toISOString();
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status, created_at, updated_at)
     VALUES ('ow_schema_job_0001', 'manual', 'Schema Job Customer', 'schema-job@example.invalid', '{}',
             'raw/schema/job/0001.json', ?, 'reconciled', ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES ('customer:schema:0001', ?, 'ow_schema_job_0001', 'Schema Job Customer',
             'schema-job@example.invalid', 'active', 1, ?, ?)`,
  ).run(TENANT, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
      service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'customer:schema:0001', 'ow_schema_job_0001', 'ironwrap', 'IW-SCHEMA-0001',
             'Roofing', 'qualified', 'ready', 1, ?, ?)`,
  ).run(JOB_ID, TENANT, LEAD_ID, now, now);
  const insertGate = db.prepare(
    `INSERT INTO operating_production_gates
     (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state, owner_user,
      assigned_at, due_at, blocker_reason, version, created_at, updated_at)
     VALUES (?, ?, ?, 'ow_schema_job_0001', ?, 'ready', ?, ?, ?, 'No active blocker', 1, ?, ?)`,
  );
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"])
    insertGate.run(`gate:schema:${gate.toLowerCase()}`, TENANT, JOB_ID, gate, OWNER_ID, now, "2030-01-01T00:00:00.000Z", now, now);
  db.prepare(
    `INSERT INTO fleet_crews
     (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES ('crew:schema:0001', ?, 'Schema Crew', 'Active', 1, ?, ?)`,
  ).run(TENANT, now, now);
  db.prepare(
    `INSERT INTO fleet_crew_members
     (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
     VALUES ('membership:schema:0001', ?, 'crew:schema:0001', ?, 1, 1, ?, ?)`,
  ).run(TENANT, FIELD_ID, now, now);
  db.prepare(
    `INSERT INTO operating_job_assignments
     (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version,
      crew_id, crew_version, assigned_users_json, scheduled_start, scheduled_end,
      supersedes_assignment_id, correction_reason, actor_user_id, command_fingerprint,
      idempotency_key_hash, created_at)
     VALUES ('assignment:schema:0001', ?, ?, 1, 1, 'crew:schema:0001', 1, ?,
             '2026-08-28T08:00:00.000Z', '2026-08-28T16:00:00.000Z', NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    TENANT,
    JOB_ID,
    JSON.stringify([FIELD_ID]),
    OWNER_ID,
    "e".repeat(64),
    "f".repeat(64),
    now,
  );
}

interface DefinitionRef {
  field_id: string;
  revision_id: string;
}

interface ProviderValueSeed {
  status: string;
  provider: string;
  receipt_id: string;
  provider_version: string;
  provider_external_id: string;
  action: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  expected_readback_schema: string;
  field_definition_revision_id: string;
  value_version: number;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  field_id: string;
  readback_digest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seedObjectReceipt(db: DatabaseSync, field: DefinitionRef, value: Record<string, unknown>): void {
  const now = NOW.toISOString();
  db.prepare(
    `INSERT INTO schema_field_evidence_receipts
     (receipt_id, tenant_id, entity_type, entity_id, field_id, field_definition_revision_id, value_version,
      evidence_kind, object_ref, object_digest, actor_type, actor_id, captured_at, evidence_class, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'object', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    value.receipt_id,
    value.tenant_id,
    value.entity_type,
    value.entity_id,
    field.field_id,
    field.revision_id,
    value.object_ref,
    value.digest,
    value.actor_type,
    value.actor_id,
    value.captured_at,
    value.evidence_class,
    now,
  );
}

function seedSucceededEffect(
  db: DatabaseSync,
  input: {
    effectId: string;
    field: DefinitionRef;
    aggregateId: string;
    expectedValueDigest: string;
    readbackHash: string;
  },
): void {
  const now = NOW.toISOString();
  const expectedReadback = {
    schema_version: "ironwrap.schema-field-provider-fact.v1",
    tenant_id: TENANT,
    entity_type: "lead",
    entity_id: LEAD_ID,
    field_id: input.field.field_id,
    field_definition_revision_id: input.field.revision_id,
    value_version: 1,
    value_digest: input.expectedValueDigest,
    provider: "test-provider",
    provider_version: "v1",
    provider_external_id: "provider:schema:1",
    readback_digest: input.readbackHash,
  };
  const values = [
    input.effectId, TENANT, "worker", "schema-worker", "schema-task", "schema-authority", "schema-policy", "v1",
    "schema_field_value", input.aggregateId, 1, input.effectId, "schema_field.provider_fact.read",
    "a".repeat(64), "b".repeat(64), "test-provider", null, `schema-effect-idempotency-${input.effectId.slice(-3)}`,
    "2030-01-01T00:00:00.000Z", null, "{}", "[]", canonicalJson(expectedReadback), 0, "{}", "corr:schema:provider:1",
    null, null, "succeeded", 0, "provider:schema:1", "c".repeat(64), input.readbackHash, "ok", null, now, now,
  ];
  db.prepare(
    `INSERT INTO external_effects
     (effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref, policy_version,
      aggregate_type, aggregate_id, aggregate_version, intent_id, action, request_hash, envelope_hash,
      provider, provider_account_ref, idempotency_key, deadline_at, lease_expires_at, preconditions_json,
      evidence_refs_json, expected_readback_json, retry_limit, compensation_plan_json, correlation_id,
      parent_effect_id, compensates_effect_id, state, attempt_count, provider_external_id,
      provider_response_hash, readback_hash, result_code, exception_ref, created_at, updated_at)
     VALUES (${values.map(() => "?").join(", ")})`,
  ).run(...values);
}

function seedProviderReceipt(
  db: DatabaseSync,
  field: DefinitionRef,
  value: ProviderValueSeed,
  valueDigest: string,
): void {
  db.prepare(
    `INSERT INTO schema_field_evidence_receipts
     (receipt_id, tenant_id, entity_type, entity_id, field_id, field_definition_revision_id, value_version,
      evidence_kind, provider_receipt_id, provider, provider_external_id, provider_action,
      provider_aggregate_type, provider_aggregate_id, provider_aggregate_version,
      expected_readback_schema, expected_value_digest, provider_version, readback_digest,
      actor_type, actor_id, captured_at, evidence_class, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'provider_fact', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'worker', 'schema-worker', ?, 'authority', ?)`,
  ).run(
    value.receipt_id,
    value.tenant_id,
    value.entity_type,
    value.entity_id,
    field.field_id,
    field.revision_id,
    value.value_version,
    value.receipt_id,
    value.provider,
    value.provider_external_id,
    value.action,
    value.aggregate_type,
    value.aggregate_id,
    value.aggregate_version,
    value.expected_readback_schema,
    valueDigest,
    value.provider_version,
    value.readback_digest,
    NOW.toISOString(),
    NOW.toISOString(),
  );
}
