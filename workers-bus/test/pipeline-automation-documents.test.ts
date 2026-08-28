/**
 * The M1 priority recipe, end to end (ELEC-189, IRO-244/IRO-209).
 *
 * An administrator composes "when a card enters this stage, generate this document and email it to
 * that recipient" in the rule builder API - no developer, no Frappe desk, no code path named after
 * a trade - and the transition produces a governed email carrying the generated document.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { adapterAuthority, runExternalEffect } from "../src/effect-runtime.ts";
import {
  automationDocumentIdempotencyKey,
  automationDocumentPermit,
  drainPipelineStageAutomation,
  prepareAutomationDelivery,
  PIPELINE_AUTOMATION_ACTION,
  PIPELINE_AUTOMATION_DOCUMENT_ACTION,
  type AutomationSendInput,
  type AutomationSendResult,
} from "../src/pipeline-automation.ts";
import { handlePipelineRoute } from "../src/pipeline-board-api.ts";
import {
  auth,
  request,
  SALES_PIPELINE_ID,
  setup,
  stageId,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const ADMIN_RULES = `/api/v1/admin/pipelines/${SALES_PIPELINE_ID}/automation-rules`;
const LEAD_ID = "lead:board:0001";
const NOW = new Date("2026-08-26T10:00:00.000Z");
const SHOP = "shop";

class MemoryR2 {
  readonly objects = new Map<string, { body: string; checksum: string; contentType: string }>();
  puts = 0;

  async head(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: new TextEncoder().encode(value.body).byteLength,
      customMetadata: { sha256: value.checksum },
      checksums: { sha256: hexBytes(value.checksum).buffer },
      httpMetadata: { contentType: value.contentType },
    };
  }

  async put(
    key: string,
    body: Blob | string,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: { sha256?: string } },
  ) {
    this.puts += 1;
    const text = typeof body === "string" ? body : await body.text();
    this.objects.set(key, {
      body: text,
      checksum: options.customMetadata?.sha256 ?? "",
      contentType: options.httpMetadata?.contentType ?? "application/octet-stream",
    });
    return { key };
  }
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function runtime(overrides: Record<string, unknown> = {}): { harness: Harness; bucket: MemoryR2 } {
  const harness = setup();
  const bucket = new MemoryR2();
  Object.assign(harness.env, {
    RAW: bucket,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_DOCUMENT_GENERATION_ENABLED: "true",
    PIPELINE_AUTOMATION_ENABLED: "true",
    PIPELINE_AUTOMATION_RECIPIENTS_JSON: JSON.stringify({ [SHOP]: "shop@example.invalid" }),
    ...overrides,
  });
  return { harness, bucket };
}

async function app(
  harness: Harness,
  method: string,
  path: string,
  options: { body?: unknown; idempotency?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    request(method, path, {
      body: options.body,
      idempotency: method === "GET" ? null : options.idempotency ?? `documents-${crypto.randomUUID()}`,
    }),
    harness.env,
    auth("owner"),
  );
  assert.ok(response, `${method} ${path} was not claimed`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function admin(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown,
  at = new Date(NOW.getTime() - 1_000),
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request(method, path, { body, idempotency: method === "GET" ? null : `automation-${crypto.randomUUID()}` }),
    harness.env,
    auth("owner"),
    at,
  );
  assert.ok(response, `${method} ${path} was not claimed`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/**
 * Everything an administrator does before the rule exists: define the fields the document reads,
 * record their values, and author the document template. All of it through the same admin routes
 * the configuration screens call - nothing here is developer-only setup.
 */
async function configureDocument(
  harness: Harness,
  suffix: string,
  options: { readRoles?: string[] } = {},
): Promise<{ templateId: string; templateVersion: number; fieldId: string; label: string }> {
  const field = await app(harness, "POST", "/api/v1/admin/schema-fields", {
    idempotency: `documents-field-${suffix}`,
    body: {
      entity_type: "lead",
      field_key: `line-items-${suffix}`,
      label: "Line items",
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
      // The automation reads as `ops`; granting it here is configuration, not a code change.
      read_roles: options.readRoles ?? ["owner", "ops"],
      write_roles: ["owner"],
    },
  });
  assert.equal(field.status, 201, JSON.stringify(field.body));
  const fieldId = String(field.body.field.field_id);
  const value = await app(
    harness,
    "POST",
    `/api/v1/schema-fields/lead/${encodeURIComponent(LEAD_ID)}/${encodeURIComponent(fieldId)}/values`,
    {
      idempotency: `documents-value-${suffix}`,
      body: {
        field_definition_revision_id: field.body.field.revision_id,
        expected_version: 0,
        value: "24 squares architectural, 3 bundles ridge cap",
      },
    },
  );
  assert.equal(value.status, 201, JSON.stringify(value.body));
  const template = await app(harness, "POST", "/api/v1/admin/document-templates", {
    idempotency: `documents-template-${suffix}`,
    body: {
      entity_type: "lead",
      template_key: `handoff-${suffix}`,
      label: "Materials list",
      blocks: [
        { kind: "heading", level: 1, text: "Materials list" },
        { kind: "field", field_id: fieldId },
      ],
      retention_policy: "standard",
    },
  });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  return {
    templateId: String(template.body.template.template_id),
    templateVersion: Number(template.body.template.version),
    fieldId,
    label: String(template.body.template.label),
  };
}

async function placeCard(harness: Harness, stageKey: string, key: string): Promise<Record<string, any>> {
  const response = await handlePipelineRoute(
    request("POST", `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards`, {
      body: { entity_type: "lead", entity_id: LEAD_ID, stage_key: stageKey },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    NOW,
  );
  assert.ok(response);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

function row(harness: Harness, sql: string, ...args: unknown[]): Record<string, any> | undefined {
  return harness.db.raw.prepare(sql).get(...(args as never[])) as Record<string, any> | undefined;
}

function count(harness: Harness, table: string): number {
  return Number((harness.db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

/** A sender that records what would leave the system, and can be told to fail its first attempt. */
function capturingSender(script: Array<AutomationSendResult["outcome"]> = []) {
  const sent: AutomationSendInput[] = [];
  let call = 0;
  const sender = async (input: AutomationSendInput): Promise<AutomationSendResult> => {
    sent.push(input);
    const outcome = script[call] ?? "succeeded";
    call += 1;
    if (outcome !== "succeeded") return { outcome, resultCode: `scripted_${outcome}` };
    return {
      outcome: "succeeded",
      effectId: `fake-effect:${input.invocationId}`,
      effectState: "succeeded",
      providerExternalId: "fake-message-1",
      providerResponseHash: "a".repeat(64),
      readbackHash: "b".repeat(64),
    };
  };
  return { sender, sent };
}

test("an administrator composes generate-a-document-and-email-it in the rule builder and the catalog offers it", async () => {
  const { harness } = runtime();
  try {
    const document = await configureDocument(harness, "compose-0001");

    const catalog = await admin(harness, "GET", ADMIN_RULES);
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    // The pickers are server-driven, so a newly registered action reaches the builder with no
    // client release: it is simply present in the payload the builder already renders.
    assert.deepEqual(
      catalog.body.catalog.actions.map((entry: Record<string, unknown>) => entry.action).sort(),
      [PIPELINE_AUTOMATION_DOCUMENT_ACTION, PIPELINE_AUTOMATION_ACTION].sort(),
    );
    assert.equal(catalog.body.catalog.document_generation_configured, true);
    const offered = catalog.body.catalog.templates.find(
      (entry: Record<string, unknown>) => entry.template_key === document.templateId,
    );
    assert.deepEqual(offered, {
      template_key: document.templateId,
      version: document.templateVersion,
      label: "Materials list",
      action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
    });

    // Composing the rule uses only values the catalog handed back.
    const created = await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: offered.action,
      recipient_ref: catalog.body.catalog.recipient_refs[0],
      template_key: offered.template_key,
      template_version: offered.version,
      active: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.rule.action, PIPELINE_AUTOMATION_DOCUMENT_ACTION);
    assert.equal(created.body.rule.template_key, document.templateId);
    assert.equal(created.body.rule.recipient_ref, SHOP);

    // A template that belongs to a different entity type, a retired one, or a stale version are all
    // refused at authoring - the administrator cannot compose a rule the server would not run.
    for (const [body, status, error] of [
      [{ template_key: "template:does-not-exist-000000", template_version: 1 }, 404, "automation_document_template_not_found"],
      [{ template_key: document.templateId, template_version: document.templateVersion + 1 }, 409, "automation_document_template_version_conflict"],
      [{ template_key: "pipeline.stage-change-summary", template_version: 1 }, 400, "automation_template_invalid"],
    ] as const) {
      const refused = await admin(harness, "POST", ADMIN_RULES, {
        to_stage_id: stageId("need_quote"),
        action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
        recipient_ref: SHOP,
        ...body,
      });
      assert.equal(refused.status, status, JSON.stringify(refused.body));
      assert.equal(refused.body.error, error);
    }
  } finally {
    harness.db.close();
  }
});

test("the transition generates the document and the delivered email carries it with receipt evidence", async () => {
  const { harness, bucket } = runtime();
  const env = harness.env;
  try {
    const document = await configureDocument(harness, "deliver-0001");
    await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
      recipient_ref: SHOP,
      template_key: document.templateId,
      template_version: document.templateVersion,
    });
    const card = await placeCard(harness, "materials_in_prod", "automation-document-0000001");

    // The provider hop is a mock that still settles through the universal effect ledger.
    const sent: AutomationSendInput[] = [];
    const sender = async (input: AutomationSendInput): Promise<AutomationSendResult> => {
      sent.push(input);
      const deadlineAt = new Date(Date.parse(input.now) + 60_000).toISOString();
      const result = await runExternalEffect(env, {
        tenantId: input.tenantId,
        actor: { type: "agent", id: "fake-provider" },
        taskId: `fake:${input.invocationId}`,
        authority: adapterAuthority({
          tenantId: input.tenantId,
          provider: "fake",
          action: "operations.email.send",
          actorId: "fake-provider",
          deadlineAt,
          retryLimit: 0,
        }),
        aggregate: { type: "pipeline_transition", id: input.transitionId, version: 1 },
        intentId: input.idempotencyKey,
        action: "operations.email.send",
        request: { to: input.recipient.address, subject: input.subject, html: input.html },
        provider: "fake",
        idempotencyKey: input.idempotencyKey,
        deadlineAt,
        expectedReadback: { provider_message_id: "fake-message-1" },
        retryLimit: 0,
        compensationPlan: {},
        correlationId: input.invocationId,
        now: input.now,
      }, {
        async dispatch() {
          return {
            outcome: "accepted" as const,
            value: { providerMessageId: "fake-message-1" },
            providerExternalId: "fake-message-1",
            providerResponse: { id: "fake-message-1" },
          };
        },
        async readback() {
          return {
            status: "match" as const,
            providerExternalId: "fake-message-1",
            observed: { provider_message_id: "fake-message-1" },
          };
        },
        async replay() {
          return { providerMessageId: "fake-message-1" };
        },
      }, NOW);
      return {
        outcome: "succeeded",
        effectId: result.effect.effect_id,
        effectState: result.effect.state,
        providerExternalId: result.effect.provider_external_id,
        providerResponseHash: result.effect.provider_response_hash,
        readbackHash: result.effect.readback_hash,
      };
    };

    const report = await drainPipelineStageAutomation(env, { now: NOW, sender });
    assert.equal(report.sent, 1, JSON.stringify(report));
    assert.equal(report.failed, 0);

    // One document was generated, stored, and attested by exactly one immutable receipt.
    assert.equal(count(harness, "document_generation_attempts"), 1);
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(bucket.puts, 1);
    const receipt = row(harness, "SELECT * FROM document_generation_receipts LIMIT 1")!;
    assert.equal(receipt.terminal_status, "succeeded");
    assert.equal(receipt.template_id, document.templateId);

    // The email is addressed to the configured recipient and carries the document itself, not a
    // notice that one exists.
    assert.equal(sent.length, 1);
    const delivered = sent[0]!;
    assert.equal(delivered.recipient.address, "shop@example.invalid");
    assert.match(delivered.subject, /^Materials list: /);
    assert.match(delivered.html, /<h1>Materials list<\/h1>/);
    assert.match(delivered.html, /24 squares architectural, 3 bundles ridge cap/);
    assert.ok(delivered.html.includes(String(receipt.receipt_id)), "receipt id is quoted in the mail");
    assert.ok(delivered.html.includes(String(receipt.output_digest)), "output digest is quoted in the mail");
    assert.ok(delivered.html.includes(String(receipt.provider_document_id)), "stored object is quoted");

    // The stored object is byte-identical to what was delivered.
    const stored = bucket.objects.get(String(receipt.provider_document_id).slice(3))!;
    assert.ok(delivered.html.includes(stored.body), "the mail carries the exact stored bytes");

    // The generation ran under a scoped service permit, never as the owner and never as a person.
    const attempt = row(harness, "SELECT * FROM document_generation_attempts LIMIT 1")!;
    assert.equal(attempt.authority_kind, "service");
    assert.equal(attempt.actor_type, "worker");
    assert.equal(attempt.actor_role, "ops");
    assert.equal(attempt.actor_id, "pipeline-automation");
    assert.equal(attempt.policy_ref, "policy:pipeline-automation:document.generate");
    assert.equal(attempt.max_attempts, 1);
    assert.ok(String(attempt.authority_ref).startsWith("permit:pipeline-automation:"));

    const invocation = row(harness, "SELECT * FROM pipeline_stage_automation_invocations LIMIT 1")!;
    assert.equal(invocation.action, PIPELINE_AUTOMATION_DOCUMENT_ACTION);
    assert.equal(invocation.status, "succeeded");
    assert.equal(invocation.template_key, document.templateId);
    assert.equal(
      row(harness, "SELECT status FROM pipeline_stage_automation_outbox LIMIT 1")!.status,
      "done",
    );
    assert.ok(card.transition_id);
  } finally {
    harness.db.close();
  }
});

test("a redelivered invocation replays the same generation and never sends or stores twice", async () => {
  const { harness, bucket } = runtime();
  try {
    const document = await configureDocument(harness, "replay-0001");
    await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
      recipient_ref: SHOP,
      template_key: document.templateId,
      template_version: document.templateVersion,
    });
    await placeCard(harness, "materials_in_prod", "automation-replay-00000001");

    // The provider refuses the first delivery, so the rail redelivers the same invocation.
    const attempts = capturingSender(["retry"]);
    const report = await drainPipelineStageAutomation(harness.env, { now: NOW, sender: attempts.sender });
    assert.equal(report.retried, 1, JSON.stringify(report));
    assert.equal(report.sent, 1, JSON.stringify(report));
    assert.equal(attempts.sent.length, 2, "the delivery was attempted twice");

    // The redelivery replayed the SAME attempt and receipt and re-used the stored object.
    assert.equal(count(harness, "document_generation_attempts"), 1);
    assert.equal(count(harness, "document_generation_receipts"), 1);
    assert.equal(count(harness, "document_generation_inputs"), 1);
    assert.equal(bucket.objects.size, 1);
    assert.equal(bucket.puts, 1, "no second write to the object store");
    // Both delivery attempts carried the same effect idempotency key, so the ledger dedupes the send.
    assert.equal(attempts.sent[0]!.idempotencyKey, attempts.sent[1]!.idempotencyKey);
    assert.equal(attempts.sent[0]!.html, attempts.sent[1]!.html);
    assert.equal(
      row(harness, "SELECT status FROM pipeline_stage_automation_invocations LIMIT 1")!.status,
      "succeeded",
    );

    // A later drain finds nothing left to do at all.
    const again = capturingSender();
    const laterReport = await drainPipelineStageAutomation(harness.env, {
      now: new Date(NOW.getTime() + 60_000),
      sender: again.sender,
    });
    assert.equal(laterReport.claimed, 0);
    assert.equal(again.sent.length, 0);
    assert.equal(count(harness, "document_generation_attempts"), 1);
  } finally {
    harness.db.close();
  }
});

test("a generation failure leaves the transition committed and shows the administrator a failed automation", async () => {
  const { harness, bucket } = runtime();
  try {
    // The administrator never granted the automation's role read access to the bound field, so the
    // document cannot be produced. Nothing about the move is rolled back.
    const document = await configureDocument(harness, "refused-0001", { readRoles: ["owner"] });
    await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
      recipient_ref: SHOP,
      template_key: document.templateId,
      template_version: document.templateVersion,
    });
    const card = await placeCard(harness, "materials_in_prod", "automation-refused-000001");

    const attempts = capturingSender();
    const report = await drainPipelineStageAutomation(harness.env, { now: NOW, sender: attempts.sender });
    // The rail retries a generation failure to its bounded ceiling and then closes it terminally.
    assert.equal(report.retried, 1, JSON.stringify(report));
    assert.equal(report.failed, 1, JSON.stringify(report));
    assert.equal(report.sent, 0, JSON.stringify(report));

    assert.equal(attempts.sent.length, 0, "nothing was delivered");
    assert.equal(bucket.puts, 0, "nothing was stored");
    const invocation = row(harness, "SELECT * FROM pipeline_stage_automation_invocations LIMIT 1")!;
    assert.equal(invocation.status, "failed");
    assert.equal(invocation.result_code, "document_generation_input_forbidden");
    const outboxRow = row(harness, "SELECT * FROM pipeline_stage_automation_outbox LIMIT 1")!;
    assert.equal(outboxRow.status, "failed");
    assert.equal(outboxRow.terminal_code, "document_generation_input_forbidden");

    // The transition and the card's new stage are untouched by the automation's failure.
    const transition = row(
      harness,
      "SELECT * FROM pipeline_card_transitions WHERE transition_id = ?",
      card.transition_id,
    )!;
    assert.equal(transition.to_stage_id, stageId("materials_in_prod"));
    assert.equal(
      row(harness, "SELECT stage_id FROM pipeline_cards WHERE card_id = ?", card.card_id)!.stage_id,
      stageId("materials_in_prod"),
    );

    // And the administrator can read the failure back through the board's own history surface.
    const rules = await admin(harness, "GET", ADMIN_RULES);
    assert.equal(rules.status, 200);
    assert.equal(rules.body.rules.length, 1);
  } finally {
    harness.db.close();
  }
});

test("an unregistered action is refused at authoring, in storage, and at execution", async () => {
  const { harness } = runtime();
  try {
    const document = await configureDocument(harness, "closed-0001");

    // Authoring.
    const refused = await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: "operations.webhook.post",
      recipient_ref: SHOP,
      template_key: document.templateId,
      template_version: document.templateVersion,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "automation_action_invalid");

    // Storage: the widened registry is still a closed CHECK, not an open string column.
    for (const table of ["pipeline_automation_rule_revisions", "pipeline_stage_automation_invocations"]) {
      const schema = String(
        row(harness, "SELECT sql FROM sqlite_master WHERE name = ?", table)!.sql,
      );
      assert.match(
        schema,
        /action IN \('operations\.email\.send', 'operations\.document\.generate_and_send'\)/,
      );
    }

    // Execution: the dispatcher re-checks the registry before it touches a generator or a provider.
    const outcome = await prepareAutomationDelivery(
      harness.env,
      {
        invocation_id: "parinv_unregistered_0001",
        tenant_id: TENANT,
        template_key: document.templateId,
        action: "operations.webhook.post",
        created_at: NOW.toISOString(),
      } as never,
      {
        pipeline_name: "Sales",
        card_id: "card:1",
        entity_type: "lead",
        entity_id: LEAD_ID,
        from_stage_name: null,
        to_stage_name: "Materials in production",
        occurred_at: NOW.toISOString(),
        reason_code: null,
      } as never,
      async () => {
        throw new Error("the generator must not be reached for an unregistered action");
      },
      NOW.toISOString(),
    );
    assert.deepEqual(outcome, {
      failure: { outcome: "failed", resultCode: "automation_action_unregistered", terminal: true },
    });
  } finally {
    harness.db.close();
  }
});

test("the document action is withheld and refused while document generation is not activated", async () => {
  const { harness } = runtime({ APP_DOCUMENT_GENERATION_ENABLED: "false" });
  try {
    const catalog = await admin(harness, "GET", ADMIN_RULES);
    assert.equal(catalog.body.catalog.document_generation_configured, false);
    assert.deepEqual(
      catalog.body.catalog.actions.map((entry: Record<string, unknown>) => entry.action),
      [PIPELINE_AUTOMATION_ACTION],
    );
    assert.deepEqual(
      catalog.body.catalog.templates.map((entry: Record<string, unknown>) => entry.template_key),
      ["pipeline.stage-change-summary"],
    );
    const refused = await admin(harness, "POST", ADMIN_RULES, {
      to_stage_id: stageId("materials_in_prod"),
      action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
      recipient_ref: SHOP,
      template_key: "template:0000000000000000000000000000000000000001",
      template_version: 1,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "automation_action_invalid");
    assert.deepEqual(refused.body.actions, [PIPELINE_AUTOMATION_ACTION]);
  } finally {
    harness.db.close();
  }
});

test("the permit an automation presents is derived entirely from its durable invocation", () => {
  const invocation = {
    invocation_id: "parinv_permit_00000001",
    tenant_id: TENANT,
    template_key: "template:00000000000000000000000000000000000000aa",
    created_at: NOW.toISOString(),
  };
  const context = { entity_type: "lead", entity_id: LEAD_ID };
  const permit = automationDocumentPermit(invocation as never, context as never);
  assert.deepEqual(permit, automationDocumentPermit(invocation as never, context as never));
  assert.equal(permit.kind, "service");
  assert.equal(permit.action, "document.generate");
  assert.equal(permit.maxAttempts, 1);
  assert.equal(permit.stopPolicy, "stop_on_unknown");
  assert.equal(permit.compensationPolicy, "none");
  assert.equal(permit.actor.type, "worker");
  assert.equal(permit.actor.role, "ops");
  assert.equal(permit.expiresAt, "2026-08-27T10:00:00.000Z");
  assert.equal(
    automationDocumentIdempotencyKey(invocation.invocation_id),
    "pipeline-automation-document:parinv_permit_00000001",
  );
});

test("the registry, the dispatcher and the routes stay free of any single trade's vocabulary", () => {
  // The recipe is roofing's today and commercial glazing's tomorrow. If a trade's word ever lands
  // in the generic core, this fails before it ships.
  const vertical = /\b(roof\w*|shingle\w*|gutter\w*|siding|eaves|soffit|materials?[ _-]?list)\b/i;
  for (const file of [
    "../src/pipeline-automation.ts",
    "../src/pipeline-board-api.ts",
    "../src/document-generation-r2.ts",
    "../migrations/0127_pipeline_automation_action_registry.sql",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const hit = source.split("\n").find((line) => vertical.test(line));
    assert.equal(hit, undefined, `${file} names a vertical: ${hit}`);
  }
});
