import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAppApi, handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  auth,
  OTHER_TENANT,
  request,
  setup,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const GENERATIONS = "/api/v1/document-generations";
const LEAD_ID = "lead:board:0001";

type FailureMode = "none" | "before_put" | "after_put" | "mismatch";

class MemoryR2 {
  readonly objects = new Map<
    string,
    { body: string; checksum: string; contentType: string }
  >();
  puts = 0;
  headUnavailable = false;
  mode: FailureMode = "none";

  async head(key: string) {
    if (this.headUnavailable) throw new Error("head unavailable");
    const value = this.objects.get(key);
    if (!value) return null;
    const checksum = value.checksum;
    return {
      size: new TextEncoder().encode(value.body).byteLength,
      customMetadata: { sha256: checksum },
      checksums: { sha256: hexBytes(checksum).buffer },
      httpMetadata: { contentType: value.contentType },
    };
  }

  async get(key: string) {
    if (this.headUnavailable) throw new Error("get unavailable");
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: new TextEncoder().encode(value.body).byteLength,
      body: new Blob([value.body]).stream(),
      text: async () => value.body,
      httpMetadata: { contentType: value.contentType },
    };
  }

  async put(
    key: string,
    body: Blob | string,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: { sha256?: string };
    },
  ) {
    this.puts += 1;
    if (this.mode === "before_put") throw new Error("put unavailable");
    const text = typeof body === "string" ? body : await body.text();
    this.objects.set(key, {
      body: text,
      checksum:
        this.mode === "mismatch"
          ? "f".repeat(64)
          : (options.customMetadata?.sha256 ?? ""),
      contentType:
        options.httpMetadata?.contentType ?? "application/octet-stream",
    });
    if (this.mode === "after_put") {
      this.headUnavailable = true;
      throw new Error("put acknowledgement lost");
    }
    return { key };
  }
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function runtime(mode: FailureMode = "none"): {
  harness: Harness;
  bucket: MemoryR2;
} {
  const harness = setup();
  const bucket = new MemoryR2();
  bucket.mode = mode;
  Object.assign(harness.env, {
    RAW: bucket,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_DOCUMENT_GENERATION_ENABLED: "true",
  });
  return { harness, bucket };
}

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: {
    body?: unknown;
    who?: Parameters<typeof auth>[0];
    tenant?: string;
    idempotency?: string | null;
  } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    request(method, path, {
      body: options.body,
      idempotency:
        options.idempotency === undefined
          ? method === "GET"
            ? null
            : "document-api-key-00000001"
          : options.idempotency,
    }),
    harness.env,
    auth(options.who ?? "owner", options.tenant ?? TENANT),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

async function callRaw(
  harness: Harness,
  path: string,
  options: { who?: Parameters<typeof auth>[0]; tenant?: string } = {},
): Promise<{
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, any>;
}> {
  const response = await handleAuthenticatedRoute(
    request("GET", path, { idempotency: null }),
    harness.env,
    auth(options.who ?? "owner", options.tenant ?? TENANT),
  );
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text) as Record<string, any>;
  } catch {
    /* html body */
  }
  return { status: response.status, headers: response.headers, text, body };
}

async function seedDocumentConfiguration(harness: Harness, suffix: string) {
  const sourceField = await call(
    harness,
    "POST",
    "/api/v1/admin/schema-fields",
    {
      idempotency: `document-source-field-${suffix}`,
      body: {
        entity_type: "lead",
        field_key: `customer-name-${suffix}`,
        label: "Customer name",
        position: 1,
        field_type: "text",
        validator_key: "required",
        validator_config: {},
        visibility_key: "always",
        visibility_config: {},
        evidence_class: "source",
        retention_policy: "standard",
        offline_mode: "online_only",
        read_scope: "all",
        write_scope: "all",
        read_roles: ["owner"],
        write_roles: ["owner"],
      },
    },
  );
  assert.equal(sourceField.status, 201, JSON.stringify(sourceField.body));
  const sourceFieldId = String(sourceField.body.field.field_id);
  const sourceValue = await call(
    harness,
    "POST",
    `/api/v1/schema-fields/lead/${encodeURIComponent(LEAD_ID)}/${encodeURIComponent(sourceFieldId)}/values`,
    {
      idempotency: `document-source-value-${suffix}`,
      body: {
        field_definition_revision_id: sourceField.body.field.revision_id,
        expected_version: 0,
        value: "Alice Example",
      },
    },
  );
  assert.equal(sourceValue.status, 201, JSON.stringify(sourceValue.body));

  const outputField = await call(
    harness,
    "POST",
    "/api/v1/admin/schema-fields",
    {
      idempotency: `document-output-field-${suffix}`,
      body: {
        entity_type: "lead",
        field_key: `generated-document-${suffix}`,
        label: "Generated document",
        position: 2,
        field_type: "attachment",
        validator_key: "none",
        validator_config: {},
        visibility_key: "always",
        visibility_config: {},
        evidence_class: "derived",
        retention_policy: "standard",
        offline_mode: "online_only",
        read_scope: "all",
        write_scope: "all",
        read_roles: ["owner"],
        write_roles: ["owner"],
      },
    },
  );
  assert.equal(outputField.status, 201, JSON.stringify(outputField.body));

  const template = await call(
    harness,
    "POST",
    "/api/v1/admin/document-templates",
    {
      idempotency: `document-template-${suffix}`,
      body: {
        entity_type: "lead",
        template_key: `customer-summary-${suffix}`,
        label: "Customer summary",
        blocks: [
          { kind: "heading", level: 1, text: "Customer summary" },
          { kind: "field", field_id: sourceFieldId },
        ],
        retention_policy: "standard",
      },
    },
  );
  assert.equal(template.status, 201, JSON.stringify(template.body));
  return {
    templateId: String(template.body.template.template_id),
    templateRevisionId: String(template.body.template.revision_id),
    outputFieldId: String(outputField.body.field.field_id),
  };
}

function generationBody(
  configuration: Awaited<ReturnType<typeof seedDocumentConfiguration>>,
  includeOutput = true,
) {
  return {
    entity_type: "lead",
    entity_id: LEAD_ID,
    template_id: configuration.templateId,
    template_revision_id: configuration.templateRevisionId,
    ...(includeOutput
      ? {
          output_field_id: configuration.outputFieldId,
          expected_output_field_version: 0,
        }
      : {}),
  };
}

function count(harness: Harness, table: string): number {
  return Number(
    (
      harness.db.raw
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }
    ).count,
  );
}

test("owner generation verifies immutable R2, atomically records attachment evidence, and replays without duplicates", async () => {
  const { harness, bucket } = runtime();
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "success-0001",
    );
    const key = "document-generation-success-0001";
    delete (harness.env as { APP_DOCUMENT_GENERATION_ENABLED?: string })
      .APP_DOCUMENT_GENERATION_ENABLED;
    const disabled = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-disabled-0001",
      body: generationBody(configuration),
    });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.error, "document_generation_unavailable");
    assert.equal(count(harness, "external_effects"), 0);
    (
      harness.env as { APP_DOCUMENT_GENERATION_ENABLED?: string }
    ).APP_DOCUMENT_GENERATION_ENABLED = "true";
    (
      harness.env as { EFFECT_RUNTIME_ENABLED?: string }
    ).EFFECT_RUNTIME_ENABLED = "false";
    const effectRuntimeDisabled = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-effect-disabled-0001",
      body: generationBody(configuration),
    });
    assert.equal(effectRuntimeDisabled.status, 503);
    assert.equal(effectRuntimeDisabled.body.error, "effect_runtime_required");
    assert.equal(count(harness, "external_effects"), 0);
    (
      harness.env as { EFFECT_RUNTIME_ENABLED?: string }
    ).EFFECT_RUNTIME_ENABLED = "true";
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body.outcome, "succeeded");
    assert.equal(generated.body.generation.terminal_status, "succeeded");
    assert.equal(generated.body.generation.readback_status, "match");
    assert.match(
      generated.body.generation.provider_document_id,
      /^r2:documents\/v1\//,
    );
    assert.equal(bucket.objects.size, 1);
    assert.equal(bucket.puts, 1);
    assert.equal(count(harness, "external_effects"), 1);
    assert.equal(count(harness, "document_generation_attempts"), 1);
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 1);
    assert.equal(count(harness, "schema_field_value_revisions"), 2);
    assert.equal("command_fingerprint" in generated.body.generation, false);
    assert.equal("idempotency_key_hash" in generated.body.generation, false);

    const replay = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body: generationBody(configuration),
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(
      replay.body.generation.receipt_id,
      generated.body.generation.receipt_id,
    );
    assert.equal(bucket.puts, 1);
    assert.equal(count(harness, "external_effects"), 1);
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 1);

    const drift = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body: {
        ...generationBody(configuration),
        expected_output_field_version: 1,
      },
    });
    assert.equal(drift.status, 409);
    assert.equal(drift.body.error, "document_generation_idempotency_conflict");

    const reconstructed = await call(
      harness,
      "GET",
      `${GENERATIONS}/${encodeURIComponent(generated.body.generation.receipt_id)}`,
    );
    assert.equal(reconstructed.status, 200);
    assert.equal(
      reconstructed.body.generation.inputs[0].value,
      "Alice Example",
    );
    assert.equal(
      reconstructed.body.generation.receipt_id,
      generated.body.generation.receipt_id,
    );
    assert.equal(
      reconstructed.body.generation.external_effect_id,
      generated.body.generation.external_effect_id,
    );
    assert.equal(reconstructed.body.generation.authority.kind, "actor");
    assert.equal(reconstructed.body.generation.authority.actor.role, "owner");
    assert.equal(
      reconstructed.body.generation.authority.policy_ref,
      "role:owner:document.generate",
    );
    assert.equal("command_fingerprint" in reconstructed.body.generation, false);
    assert.equal(
      "idempotency_key_hash" in reconstructed.body.generation,
      false,
    );

    const denied = await call(harness, "POST", GENERATIONS, {
      who: "ops",
      idempotency: "document-generation-denied-0001",
      body: generationBody(configuration),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "document_generation_forbidden");
    const crossTenant = await call(harness, "POST", GENERATIONS, {
      tenant: OTHER_TENANT,
      idempotency: "document-generation-cross-tenant-0001",
      body: generationBody(configuration),
    });
    assert.equal(crossTenant.status, 404);
    assert.equal(bucket.puts, 1);
  } finally {
    harness.db.close();
  }
});

test("a stale output-field CAS preserves provider and generation truth without minting attachment evidence", async () => {
  const { harness, bucket } = runtime();
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "stale-output-0001",
    );
    const key = "document-generation-stale-output-0001";
    const body = {
      ...generationBody(configuration),
      expected_output_field_version: 1,
    };
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body,
    });
    assert.equal(generated.status, 409, JSON.stringify(generated.body));
    assert.equal(generated.body.error, "schema_field_value_version_conflict");
    assert.equal(bucket.puts, 1);
    assert.equal(count(harness, "external_effects"), 1);
    assert.equal(
      (
        harness.db.raw.prepare("SELECT state FROM external_effects").get() as {
          state: string;
        }
      ).state,
      "succeeded",
    );
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);

    const stored = harness.db.raw
      .prepare(
        "SELECT receipt_id FROM document_generation_receipts WHERE tenant_id = ?",
      )
      .get(TENANT) as { receipt_id: string };
    const reconstructed = await call(
      harness,
      "GET",
      `${GENERATIONS}/${encodeURIComponent(stored.receipt_id)}`,
    );
    assert.equal(reconstructed.status, 200);
    assert.equal(reconstructed.body.generation.terminal_status, "succeeded");
    assert.equal(reconstructed.body.generation.readback_status, "match");

    const replay = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body,
    });
    assert.equal(replay.status, 409);
    assert.equal(bucket.puts, 1);
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);
  } finally {
    harness.db.close();
  }
});

test("failure before R2 put stays unknown, emits no object evidence, and reconciles only as not executed", async () => {
  const { harness, bucket } = runtime("before_put");
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "before-put-0001",
    );
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-before-put-0001",
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 202, JSON.stringify(generated.body));
    assert.equal(generated.body.outcome, "unknown");
    assert.equal(bucket.objects.size, 0);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);
    assert.equal(count(harness, "schema_field_value_revisions"), 1);
    assert.equal(
      (
        harness.db.raw.prepare("SELECT state FROM external_effects").get() as {
          state: string;
        }
      ).state,
      "unknown",
    );

    bucket.mode = "none";
    const reconciled = await call(
      harness,
      "POST",
      `${GENERATIONS}/${encodeURIComponent(generated.body.generation.generation_attempt_id)}/reconcile`,
      { idempotency: "document-reconcile-before-put-0001", body: {} },
    );
    assert.equal(reconciled.status, 409, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.outcome, "not_executed");
    assert.equal(reconciled.body.generation.receipt_version, 2);
    assert.equal(
      reconciled.body.generation.prior_receipt_id,
      generated.body.generation.receipt_id,
    );
    assert.equal(reconciled.body.generation.terminal_status, "unknown");
    assert.equal(
      reconciled.body.generation.reconciliation_outcome,
      "not_executed",
    );
    assert.equal(
      (
        harness.db.raw.prepare("SELECT state FROM external_effects").get() as {
          state: string;
        }
      ).state,
      "reconciled",
    );
    assert.equal(count(harness, "document_generation_receipts"), 2);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);

    const stored = harness.db.raw
      .prepare(
        "SELECT settled_outcome FROM document_generation_receipts WHERE receipt_id = ?",
      )
      .get(reconciled.body.generation.receipt_id) as {
      settled_outcome: string;
    };
    assert.equal(stored.settled_outcome, "not_executed");
    const reconstructed = await call(
      harness,
      "GET",
      `${GENERATIONS}/${encodeURIComponent(reconciled.body.generation.receipt_id)}`,
    );
    assert.equal(reconstructed.status, 200);
    assert.equal(
      reconstructed.body.generation.reconciliation_outcome,
      "not_executed",
    );

    const replay = await call(
      harness,
      "POST",
      `${GENERATIONS}/${encodeURIComponent(generated.body.generation.generation_attempt_id)}/reconcile`,
      { idempotency: "document-reconcile-before-put-0001", body: {} },
    );
    assert.equal(replay.status, 409);
    assert.equal(
      replay.body.generation.receipt_id,
      reconciled.body.generation.receipt_id,
    );
    assert.equal(count(harness, "document_generation_receipts"), 2);
  } finally {
    harness.db.close();
  }
});

test("lost acknowledgement after R2 put stays unknown until HEAD reconciliation proves success", async () => {
  const { harness, bucket } = runtime("after_put");
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "after-put-0001",
    );
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-after-put-0001",
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 202, JSON.stringify(generated.body));
    assert.equal(generated.body.outcome, "unknown");
    assert.equal(bucket.objects.size, 1);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);

    bucket.mode = "none";
    bucket.headUnavailable = false;
    const path = `${GENERATIONS}/${encodeURIComponent(generated.body.generation.generation_attempt_id)}/reconcile`;
    const reconciled = await call(harness, "POST", path, {
      idempotency: "document-reconcile-after-put-0001",
      body: {},
    });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.outcome, "succeeded");
    assert.equal(reconciled.body.generation.receipt_version, 2);
    assert.equal(
      reconciled.body.generation.prior_receipt_id,
      generated.body.generation.receipt_id,
    );
    assert.equal(count(harness, "document_generation_receipts"), 2);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 1);
    assert.equal(count(harness, "schema_field_value_revisions"), 2);

    const replay = await call(harness, "POST", path, {
      idempotency: "document-reconcile-after-put-0001",
      body: {},
    });
    assert.equal(replay.status, 200);
    assert.equal(
      replay.body.generation.receipt_id,
      reconciled.body.generation.receipt_id,
    );
    assert.equal(count(harness, "document_generation_receipts"), 2);
    assert.equal(count(harness, "schema_field_evidence_receipts"), 1);
  } finally {
    harness.db.close();
  }
});

test("R2 HEAD mismatch becomes a durable manual exception and never mints attachment evidence", async () => {
  const { harness } = runtime("mismatch");
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "mismatch-0001",
    );
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-mismatch-0001",
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 409, JSON.stringify(generated.body));
    assert.equal(generated.body.outcome, "manual_exception");
    assert.equal(generated.body.generation.readback_status, "conflict");
    assert.equal(generated.body.generation.terminal_status, "unknown");
    assert.equal(
      generated.body.generation.reconciliation_outcome,
      "manual_exception",
    );
    assert.equal(
      (
        harness.db.raw.prepare("SELECT state FROM external_effects").get() as {
          state: string;
        }
      ).state,
      "manual_exception",
    );
    assert.equal(count(harness, "schema_field_evidence_receipts"), 0);
    assert.equal(count(harness, "schema_field_value_revisions"), 1);

    const stored = harness.db.raw
      .prepare(
        "SELECT settled_outcome FROM document_generation_receipts WHERE receipt_id = ?",
      )
      .get(generated.body.generation.receipt_id) as { settled_outcome: string };
    assert.equal(stored.settled_outcome, "manual_exception");
    const reconstructed = await call(
      harness,
      "GET",
      `${GENERATIONS}/${encodeURIComponent(generated.body.generation.receipt_id)}`,
    );
    assert.equal(reconstructed.status, 200);
    assert.equal(
      reconstructed.body.generation.reconciliation_outcome,
      "manual_exception",
    );
  } finally {
    harness.db.close();
  }
});

test("the stored document is read back through its receipt, digest-checked, owner only", async () => {
  const { harness, bucket } = runtime();
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "readback-0001",
    );
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-readback-0001",
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const receiptId = generated.body.generation.receipt_id as string;
    const objectPath = `${GENERATIONS}/${encodeURIComponent(receiptId)}/document`;

    const read = await callRaw(harness, objectPath);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.match(String(read.headers.get("content-type")), /^text\/html/);
    assert.equal(
      read.headers.get("x-document-digest"),
      generated.body.generation.output_digest,
    );
    assert.match(
      String(read.headers.get("content-disposition")),
      /^inline; filename=/,
    );
    assert.equal(read.headers.get("cache-control"), "private, no-store");
    assert.ok(String(read.text).length > 0);
    const stored = [...bucket.objects.values()][0]!;
    assert.equal(read.text, stored.body);

    // A non-owner never reaches the object.
    const refused = await callRaw(harness, objectPath, { who: "ops" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "document_generation_forbidden");

    // Another tenant's receipt id is not found, not leaked.
    const foreign = await callRaw(harness, objectPath, {
      tenant: OTHER_TENANT,
    });
    assert.equal(foreign.status, 404);

    // Bytes that no longer match the receipt are refused rather than handed over.
    const [key, value] = [...bucket.objects.entries()][0]!;
    bucket.objects.set(key, {
      ...value,
      body: value.body + "<!-- tampered -->",
    });
    const tampered = await callRaw(harness, objectPath);
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.error, "document_generation_readback_mismatch");

    bucket.objects.delete(key);
    const missing = await callRaw(harness, objectPath);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "document_object_missing");
  } finally {
    harness.db.close();
  }
});

test("a receipt whose write never succeeded has no document to read back", async () => {
  const { harness } = runtime("before_put");
  try {
    const configuration = await seedDocumentConfiguration(
      harness,
      "readback-pending-0001",
    );
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-generation-readback-pending-0001",
      body: generationBody(configuration),
    });
    assert.equal(generated.status, 202, JSON.stringify(generated.body));
    const receiptId = generated.body.generation.receipt_id as string;
    const read = await callRaw(
      harness,
      `${GENERATIONS}/${encodeURIComponent(receiptId)}/document`,
    );
    assert.equal(read.status, 409);
    assert.ok(
      [
        "document_generation_pending",
        "document_generation_not_stored",
      ].includes(read.body.error),
    );
  } finally {
    harness.db.close();
  }
});

test("request recovery reads the latest reconciliation without executing another write", async () => {
  const { harness, bucket } = runtime("after_put");
  try {
    const config = await seedDocumentConfiguration(harness, "recover-0001");
    const key = "document-request-recover-0001";
    const initial = await call(harness, "POST", GENERATIONS, {
      idempotency: key,
      body: generationBody(config),
    });
    assert.equal(initial.status, 202);
    const pending = await call(harness, "GET", GENERATIONS, {
      idempotency: key,
    });
    assert.equal(pending.body.outcome, "unknown");
    bucket.headUnavailable = false;
    const reconciled = await call(
      harness,
      "POST",
      `${GENERATIONS}/${encodeURIComponent(initial.body.generation.generation_attempt_id)}/reconcile`,
      { idempotency: "document-recover-reconcile-0001", body: {} },
    );
    assert.equal(reconciled.status, 200);
    const recovered = await call(harness, "GET", GENERATIONS, {
      idempotency: key,
    });
    assert.equal(recovered.body.outcome, "succeeded");
    assert.equal(
      recovered.body.generation.receipt_id,
      reconciled.body.generation.receipt_id,
    );
    assert.equal(bucket.puts, 1);
    assert.equal(
      (
        await call(harness, "GET", GENERATIONS, {
          idempotency: key,
          tenant: OTHER_TENANT,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(harness, "GET", GENERATIONS, {
          idempotency: key,
          who: "ops",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(harness, "GET", GENERATIONS, {
          idempotency: "document-request-absent-0001",
        })
      ).status,
      404,
    );
    assert.equal((await call(harness, "GET", GENERATIONS)).status, 400);
  } finally {
    harness.db.close();
  }
});

test("document retrieval bounds declared and streamed bytes and handles interrupted reads", async () => {
  const { harness, bucket } = runtime();
  try {
    const config = await seedDocumentConfiguration(harness, "bounded-0001");
    const generated = await call(harness, "POST", GENERATIONS, {
      idempotency: "document-bounded-0001",
      body: generationBody(config),
    });
    const path = `${GENERATIONS}/${encodeURIComponent(generated.body.generation.receipt_id)}/document`;
    const originalGet = bucket.get.bind(bucket);
    let cancelled = false;
    bucket.get = async () =>
      ({
        size: 8 * 1024 * 1024 + 1,
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }) as never;
    assert.equal((await callRaw(harness, path)).status, 413);
    assert.equal(cancelled, true);
    bucket.get = async () =>
      ({
        size: 1,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2));
          },
        }),
      }) as never;
    assert.equal((await callRaw(harness, path)).status, 413);
    bucket.get = async () =>
      ({
        size: 10,
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("connection lost"));
          },
        }),
      }) as never;
    assert.equal((await callRaw(harness, path)).status, 503);
    bucket.get = originalGet;
    const download = await callRaw(harness, `${path}?download=1`);
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /^attachment;/,
    );
    assert.match(
      download.headers.get("content-security-policy") ?? "",
      /sandbox;/,
    );
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  } finally {
    harness.db.close();
  }
});

test("the raw file and request read reject a missing browser session before storage access", async () => {
  const { harness, bucket } = runtime();
  try {
    Object.assign(harness.env, {
      APP_BFF_ENABLED: "true",
      APP_TENANT_NAME: "Synthetic IronWrap",
      APP_TENANT_BRAND: "IronWrap",
      APP_LOCALE: "en-CA",
      APP_TIME_ZONE: "America/Edmonton",
      APP_CURRENCY: "CAD",
      APP_PUBLIC_ORIGIN: "http://localhost:7100",
      APP_ALLOWED_ORIGINS: "http://localhost:7100",
      APP_ALLOW_INSECURE_LOCAL: "true",
      APP_AUTH_PEPPER:
        "synthetic-local-auth-pepper-at-least-thirty-two-characters",
    });
    let reads = 0;
    bucket.get = async () => {
      reads += 1;
      throw new Error("must not reach R2");
    };
    for (const path of [
      GENERATIONS,
      `${GENERATIONS}/docreceipt:unknown:1/document`,
    ]) {
      const response = await handleAppApi(
        new Request(`http://localhost:7100${path}`, {
          headers: { "idempotency-key": "document-no-session-0001" },
        }),
        harness.env,
        { waitUntil() {} } as never,
      );
      assert.equal(response.status, 401);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        "unauthorized",
      );
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    assert.equal(reads, 0);
  } finally {
    harness.db.close();
  }
});
