import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adapterAuthority,
  runExternalEffect,
} from "../src/effect-runtime.ts";
import {
  createPipelineAutomationRule,
  drainPipelineStageAutomation,
  getPipelineAutomationRule,
  pipelineAutomationEffectKey,
  renderStageChangeSummary,
  recoverPipelineAutomationLeases,
  revisePipelineAutomationRule,
  type AutomationSendInput,
  type AutomationSendResult,
} from "../src/pipeline-automation.ts";
import { handlePipelineRoute } from "../src/pipeline-board-api.ts";
import {
  auth,
  OTHER_TENANT,
  request,
  SALES_PIPELINE_ID,
  setup,
  stageId,
  TENANT,
  type Harness,
} from "./pipeline-board-fixture.ts";

const ADMIN = `/api/v1/admin/pipelines/${SALES_PIPELINE_ID}/automation-rules`;
const NOW = new Date("2026-08-26T10:00:00.000Z");
const RULE_BODY = (toStageId: string, overrides: Record<string, unknown> = {}) => ({
  to_stage_id: toStageId,
  action: "operations.email.send",
  recipient_ref: "owner",
  template_key: "pipeline.stage-change-summary",
  template_version: 1,
  active: true,
  ...overrides,
});

function automationEnv(harness: Harness, overrides: Record<string, unknown> = {}) {
  Object.assign(harness.env, {
    EFFECT_RUNTIME_ENABLED: "true",
    PIPELINE_AUTOMATION_ENABLED: "true",
    PIPELINE_AUTOMATION_RECIPIENTS_JSON: JSON.stringify({ owner: "owner@example.invalid" }),
    ...overrides,
  });
  return harness.env;
}

async function admin(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown,
  who: Parameters<typeof auth>[0] = "owner",
  tenant = TENANT,
  at = new Date(NOW.getTime() - 1_000),
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request(method, path, { body, idempotency: method === "GET" ? null : `automation-${crypto.randomUUID()}` }),
    harness.env,
    auth(who, tenant),
    at,
  );
  assert.ok(response, `${method} ${path} was not claimed`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function placeCard(
  harness: Harness,
  stageKey: string,
  key: string,
  leadId = "lead:board:0001",
  at = NOW,
): Promise<Record<string, any>> {
  const response = await handlePipelineRoute(
    request("POST", `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards`, {
      body: { entity_type: "lead", entity_id: leadId, stage_key: stageKey },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    at,
  );
  assert.ok(response);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 201, JSON.stringify(body));
  const transition = harness.db.raw.prepare(
    "SELECT outbox_id FROM pipeline_stage_automation_outbox WHERE transition_id = ?",
  ).get(body.transition_id) as { outbox_id: string };
  return { ...body, outbox_id: transition.outbox_id };
}

function outbox(harness: Harness, outboxId?: string): Record<string, any> {
  return (outboxId
    ? harness.db.raw.prepare("SELECT * FROM pipeline_stage_automation_outbox WHERE outbox_id = ?").get(outboxId)
    : harness.db.raw.prepare("SELECT * FROM pipeline_stage_automation_outbox ORDER BY created_at, outbox_id LIMIT 1").get()) as Record<string, any>;
}

function invocation(harness: Harness, outboxId?: string): Record<string, any> {
  return (outboxId
    ? harness.db.raw.prepare("SELECT * FROM pipeline_stage_automation_invocations WHERE outbox_id = ?").get(outboxId)
    : harness.db.raw.prepare("SELECT * FROM pipeline_stage_automation_invocations ORDER BY created_at, invocation_id LIMIT 1").get()) as Record<string, any>;
}

function successfulFakeSender(): (input: AutomationSendInput) => Promise<AutomationSendResult> {
  return async (input) => ({
    outcome: "succeeded",
    effectId: `fake-effect:${input.invocationId}`,
    effectState: "succeeded",
    providerExternalId: "fake-message-1",
    providerResponseHash: "a".repeat(64),
    readbackHash: "b".repeat(64),
  });
}

test("admin automation API is owner-only, validates closed catalogs, and appends revisions", async () => {
  const harness = setup();
  automationEnv(harness);
  const listed = await admin(harness, "GET", ADMIN);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.catalog.actions.map((entry: any) => entry.action), ["operations.email.send"]);
  assert.deepEqual(listed.body.catalog.templates.map((entry: any) => entry.template_key), ["pipeline.stage-change-summary"]);
  assert.deepEqual(listed.body.catalog.recipient_refs, ["owner"]);

  const created = await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.rule.version, 1);
  assert.equal(created.body.rule.recipient_ref, "owner");
  assert.equal("address" in created.body.rule, false);

  const revised = await admin(harness, "POST", `${ADMIN}/${created.body.rule.rule_id}/revisions`, {
    ...RULE_BODY(stageId("new_lead"), { active: false }),
    expected_version: 1,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.rule.version, 2);
  assert.equal(revised.body.rule.active, 0);
  const historyPath = `${ADMIN}/${created.body.rule.rule_id}/revisions`;
  const history = await admin(harness, "GET", historyPath);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.current_revision_id, revised.body.rule.revision_id);
  assert.equal(history.body.current_version, 2);
  assert.deepEqual(
    history.body.revisions.map((entry: any) => [
      entry.version,
      entry.revision_id,
      entry.prior_revision_id,
      entry.pipeline_id,
      entry.to_stage_id,
      entry.action,
      entry.recipient_ref,
      entry.template_key,
      entry.template_version,
      entry.active,
      entry.actor_role,
      entry.actor_id,
      entry.created_at,
    ]),
    [
      [
        1,
        created.body.rule.revision_id,
        null,
        SALES_PIPELINE_ID,
        stageId("new_lead"),
        "operations.email.send",
        "owner",
        "pipeline.stage-change-summary",
        1,
        1,
        "owner",
        "appu_owner_0001",
        created.body.rule.created_at,
      ],
      [
        2,
        revised.body.rule.revision_id,
        created.body.rule.revision_id,
        SALES_PIPELINE_ID,
        stageId("new_lead"),
        "operations.email.send",
        "owner",
        "pipeline.stage-change-summary",
        1,
        0,
        "owner",
        "appu_owner_0001",
        revised.body.rule.created_at,
      ],
    ],
  );
  const forbiddenHistory = await admin(harness, "GET", historyPath, undefined, "sales");
  assert.equal(forbiddenHistory.status, 403);
  const hiddenHistory = await admin(harness, "GET", historyPath, undefined, "owner", OTHER_TENANT);
  assert.equal(hiddenHistory.status, 404);
  const missingHistory = await admin(harness, "GET", `${ADMIN}/missing-rule/revisions`);
  assert.equal(missingHistory.status, 404);
  const revisions = harness.db.raw
    .prepare("SELECT version, prior_revision_id, actor_id, active FROM pipeline_automation_rule_revisions WHERE rule_id = ? ORDER BY version")
    .all(created.body.rule.rule_id) as Record<string, unknown>[];
  assert.deepEqual(revisions.map((row) => [row.version, row.prior_revision_id, row.actor_id, row.active]), [
    [1, null, "appu_owner_0001", 1],
    [2, created.body.rule.revision_id, "appu_owner_0001", 0],
  ]);
  const stale = await admin(harness, "POST", `${ADMIN}/${created.body.rule.rule_id}/revisions`, {
    ...RULE_BODY(stageId("new_lead")),
    expected_version: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "automation_rule_version_conflict");

  for (const bad of [
    { action: "sms.send" },
    { recipient_ref: "missing" },
    { template_key: "tenant.body" },
    { template_version: 2 },
    { subject: "tenant-authored subject" },
  ]) {
    const response = await admin(harness, "POST", ADMIN, {
      ...RULE_BODY(stageId("visit_booked")),
      ...bad,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  harness.env.PIPELINE_AUTOMATION_RECIPIENTS_JSON = "not-json";
  const malformedConfig = await admin(harness, "POST", ADMIN, RULE_BODY(stageId("visit_booked")));
  assert.equal(malformedConfig.status, 400);
  assert.equal(malformedConfig.body.error, "automation_recipient_config_malformed");
  automationEnv(harness);
  const sales = await admin(harness, "GET", ADMIN, undefined, "sales");
  assert.equal(sales.status, 403);
  const other = await admin(harness, "GET", ADMIN, undefined, "owner", OTHER_TENANT);
  assert.equal(other.status, 404);
  harness.db.close();
});

test("binding is deterministic and immutable across edits, replay, disablement, and no-rule drains", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  const first = await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-bind-0000000001");
  const revised = await admin(harness, "POST", `${ADMIN}/${first.body.rule.rule_id}/revisions`, {
    ...RULE_BODY(stageId("new_lead"), { active: true }),
    expected_version: 1,
  });
  assert.equal(revised.body.rule.version, 2);
  let sends = 0;
  const sender = async (input: AutomationSendInput) => {
    sends += 1;
    return successfulFakeSender()(input);
  };
  const drained = await drainPipelineStageAutomation(env, { now: NOW, sender, limit: 5 });
  assert.equal(drained.sent, 1, JSON.stringify(drained));
  const bound = outbox(harness, String(card.outbox_id));
  assert.equal(bound.binding_state, "bound");
  assert.equal(bound.rule_revision_id, revised.body.rule.revision_id);
  assert.equal(bound.rule_version, 2);
  const firstInvocation = invocation(harness, String(card.outbox_id));
  assert.equal(firstInvocation.status, "succeeded");
  assert.match(firstInvocation.invocation_id, /^parinv_[0-9a-f]{48}$/);
  const effectKey = pipelineAutomationEffectKey(String(firstInvocation.invocation_id));
  assert.equal(effectKey, `pipeline-automation:${firstInvocation.invocation_id}`);
  const replay = await drainPipelineStageAutomation(env, { now: new Date(NOW.getTime() + 1_000), sender, limit: 5 });
  assert.equal(replay.scanned, 0);
  assert.equal(sends, 1);

  const noRuleCard = await placeCard(
    harness,
    "visit_booked",
    "automation-no-rule-0000000001",
    "lead:board:0002",
  );
  const noRule = await drainPipelineStageAutomation(env, { now: new Date(NOW.getTime() + 2_000), sender, limit: 5 });
  assert.equal(noRule.no_rule, 1, JSON.stringify(noRule));
  assert.equal(outbox(harness, String(noRuleCard.outbox_id)).binding_state, "no_rule");
  assert.equal(outbox(harness, String(noRuleCard.outbox_id)).terminal_code, "no_matching_rule");

  const second = await admin(harness, "POST", `${ADMIN}/${first.body.rule.rule_id}/revisions`, {
    ...RULE_BODY(stageId("new_lead"), { active: false }),
    expected_version: 2,
  });
  assert.equal(second.body.rule.active, 0);
  assert.equal(bound.rule_revision_id, revised.body.rule.revision_id, "binding must not follow later edits");
  harness.db.close();
});

test("rules created after a transition do not capture historical outbox rows", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  const historical = await placeCard(
    harness,
    "new_lead",
    "automation-historical-0000001",
    "lead:board:0002",
    NOW,
  );
  const rule = await admin(
    harness,
    "POST",
    ADMIN,
    RULE_BODY(stageId("new_lead")),
    "owner",
    TENANT,
    new Date(NOW.getTime() + 5 * 60_000),
  );
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  let sends = 0;
  const sender = async (input: AutomationSendInput) => {
    sends += 1;
    return successfulFakeSender()(input);
  };
  const historicalDrain = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 6 * 60_000),
    sender,
    limit: 5,
  });
  assert.equal(historicalDrain.no_rule, 1, JSON.stringify(historicalDrain));
  assert.equal(historicalDrain.sent, 0);
  assert.equal(sends, 0);
  assert.equal(outbox(harness, String(historical.outbox_id)).binding_state, "no_rule");
  assert.equal(outbox(harness, String(historical.outbox_id)).status, "done");

  const later = await placeCard(
    harness,
    "new_lead",
    "automation-historical-0000002",
    "lead:board:0001",
    new Date(NOW.getTime() + 6 * 60_000),
  );
  const laterDrain = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 7 * 60_000),
    sender,
    limit: 5,
  });
  assert.equal(laterDrain.sent, 1, JSON.stringify(laterDrain));
  assert.equal(sends, 1);
  assert.equal(outbox(harness, String(later.outbox_id)).binding_state, "bound");
  assert.equal(outbox(harness, String(later.outbox_id)).rule_revision_id, rule.body.rule.revision_id);
  harness.db.close();
});

test("drain leases are exact, retries are bounded, and unknown provider outcomes do not redispatch", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-retry-0000000001");
  let sends = 0;
  const retrySender = async (_input: AutomationSendInput): Promise<AutomationSendResult> => {
    sends += 1;
    return sends === 1 ? { outcome: "retry", resultCode: "provider_temporarily_unavailable" } : successfulFakeSender()(_input);
  };
  const first = await drainPipelineStageAutomation(env, { now: NOW, sender: retrySender, limit: 1 });
  assert.equal(first.retried, 1, JSON.stringify(first));
  const pending = invocation(harness, String(card.outbox_id));
  assert.equal(pending.status, "retry");
  const staleLease = "stale-lease-reference-0000000001";
  harness.db.raw.prepare(
    `UPDATE pipeline_stage_automation_outbox SET status = 'claimed', lease_ref = ?, lease_expires_at = ? WHERE outbox_id = ?`,
  ).run(staleLease, "2026-08-26T09:00:00.000Z", card.outbox_id);
  harness.db.raw.prepare(
    `UPDATE pipeline_stage_automation_invocations SET status = 'claimed', lease_ref = ?, lease_expires_at = ? WHERE outbox_id = ?`,
  ).run(staleLease, "2026-08-26T09:00:00.000Z", card.outbox_id);
  const wrongLease = harness.db.raw.prepare(
    `UPDATE pipeline_stage_automation_invocations SET status = 'retry' WHERE outbox_id = ? AND status = 'claimed' AND lease_ref = ?`,
  ).run(card.outbox_id, "not-the-owner");
  assert.equal(wrongLease.changes, 0);
  const recovered = await recoverPipelineAutomationLeases(env, NOW.toISOString(), 5);
  assert.equal(recovered.retried, 1, JSON.stringify(recovered));
  assert.equal(invocation(harness, String(card.outbox_id)).status, "retry");
  assert.equal(outbox(harness, String(card.outbox_id)).status, "pending");
  const completed = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 1_000),
    sender: retrySender,
    limit: 1,
  });
  assert.equal(completed.sent, 1, JSON.stringify(completed));
  assert.equal(sends, 2);

  const unknownCard = await placeCard(
    harness,
    "new_lead",
    "automation-unknown-0000000001",
    "lead:board:0002",
  );
  let unknownSends = 0;
  const unknownSender = async (_input: AutomationSendInput): Promise<AutomationSendResult> => {
    unknownSends += 1;
    return { outcome: "unknown", effectState: "unknown", resultCode: "provider_uncertain" };
  };
  const unknown = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 2_000),
    sender: unknownSender,
    limit: 1,
  });
  assert.equal(unknown.unknown, 1, JSON.stringify(unknown));
  assert.equal(invocation(harness, String(unknownCard.outbox_id)).status, "unknown");
  assert.equal(outbox(harness, String(unknownCard.outbox_id)).status, "failed");
  const noRedispatch = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 3_000),
    sender: unknownSender,
    limit: 1,
  });
  assert.equal(noRedispatch.scanned, 0);
  assert.equal(unknownSends, 1);
  harness.db.close();
});

test("ordinary retry outcomes become terminal at the ceiling and do not send a third time", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-retry-ceiling-000001");
  let sends = 0;
  const retrySender = async (_input: AutomationSendInput): Promise<AutomationSendResult> => {
    sends += 1;
    return { outcome: "retry", resultCode: "provider_temporarily_unavailable" };
  };
  const drained = await drainPipelineStageAutomation(env, { now: NOW, sender: retrySender, limit: 10 });
  assert.equal(drained.scanned, 2, JSON.stringify(drained));
  assert.equal(drained.claimed, 2, JSON.stringify(drained));
  assert.equal(drained.retried, 1, JSON.stringify(drained));
  assert.equal(drained.failed, 1, JSON.stringify(drained));
  assert.equal(sends, 2);
  assert.equal(invocation(harness, String(card.outbox_id)).status, "failed");
  assert.equal(invocation(harness, String(card.outbox_id)).attempt_count, 2);
  assert.equal(invocation(harness, String(card.outbox_id)).result_code, "automation_retry_exhausted");
  assert.equal(outbox(harness, String(card.outbox_id)).status, "failed");
  const replay = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 1_000),
    sender: retrySender,
    limit: 10,
  });
  assert.equal(replay.scanned, 0, JSON.stringify(replay));
  assert.equal(sends, 2);
  harness.db.close();
});

test("recipient remapping fails a retried invocation closed without a second provider call", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-recipient-remap-000001");
  let sends = 0;
  const addresses: string[] = [];
  const sender = async (input: AutomationSendInput): Promise<AutomationSendResult> => {
    sends += 1;
    addresses.push(input.recipient.address);
    return { outcome: "retry", resultCode: "provider_temporarily_unavailable" };
  };
  const first = await drainPipelineStageAutomation(env, { now: NOW, sender, limit: 1 });
  assert.equal(first.retried, 1, JSON.stringify(first));
  const before = invocation(harness, String(card.outbox_id));
  const originalDigest = before.recipient_digest;
  assert.match(String(originalDigest), /^[0-9a-f]{64}$/);
  assert.equal(addresses[0], "owner@example.invalid");

  env.PIPELINE_AUTOMATION_RECIPIENTS_JSON = JSON.stringify({ owner: "new-owner@example.invalid" });
  const second = await drainPipelineStageAutomation(env, {
    now: new Date(NOW.getTime() + 1_000),
    sender,
    limit: 1,
  });
  assert.equal(second.failed, 1, JSON.stringify(second));
  assert.equal(second.retried, 0, JSON.stringify(second));
  assert.equal(sends, 1);
  const after = invocation(harness, String(card.outbox_id));
  assert.equal(after.status, "failed");
  assert.equal(after.result_code, "automation_recipient_digest_changed");
  assert.equal(after.recipient_digest, originalDigest);
  assert.equal(outbox(harness, String(card.outbox_id)).status, "failed");
  harness.db.close();
});

test("lease recovery stops at the retry ceiling instead of reopening a stale claim forever", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-stale-limit-000001");
  const first = await drainPipelineStageAutomation(env, {
    now: NOW,
    sender: async () => ({ outcome: "retry", resultCode: "provider_temporarily_unavailable" }),
    limit: 1,
  });
  assert.equal(first.retried, 1, JSON.stringify(first));
  const staleLease = "stale-lease-limit-0000000001";
  harness.db.raw.prepare(
    `UPDATE pipeline_stage_automation_outbox
        SET status = 'claimed', lease_ref = ?, lease_expires_at = ?, attempt_count = 2
      WHERE outbox_id = ?`,
  ).run(staleLease, "2026-08-26T09:00:00.000Z", card.outbox_id);
  harness.db.raw.prepare(
    `UPDATE pipeline_stage_automation_invocations
        SET status = 'claimed', lease_ref = ?, lease_expires_at = ?, attempt_count = 2
      WHERE outbox_id = ?`,
  ).run(staleLease, "2026-08-26T09:00:00.000Z", card.outbox_id);
  const recovered = await recoverPipelineAutomationLeases(env, NOW.toISOString(), 5);
  assert.equal(recovered.recovered, 1, JSON.stringify(recovered));
  assert.equal(recovered.failed, 1, JSON.stringify(recovered));
  assert.equal(recovered.retried, 0, JSON.stringify(recovered));
  assert.equal(invocation(harness, String(card.outbox_id)).status, "failed");
  assert.equal(outbox(harness, String(card.outbox_id)).status, "failed");
  assert.equal(invocation(harness, String(card.outbox_id)).result_code, "automation_lease_expired");
  harness.db.close();
});

test("a fake provider completes through the universal effect ledger with readback evidence", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await admin(harness, "POST", ADMIN, RULE_BODY(stageId("new_lead")));
  const card = await placeCard(harness, "new_lead", "automation-effect-0000000001");
  const sender = async (input: AutomationSendInput): Promise<AutomationSendResult> => {
    const request = { to: input.recipient.address, subject: input.subject, html: input.html };
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
      request,
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
  const report = await drainPipelineStageAutomation(env, { now: NOW, sender, limit: 1 });
  assert.equal(report.sent, 1, JSON.stringify(report));
  const row = invocation(harness, String(card.outbox_id));
  assert.equal(row.action, "operations.email.send");
  assert.equal(row.effect_state, "succeeded");
  assert.equal(row.provider_external_id, "fake-message-1");
  assert.match(String(row.provider_response_hash), /^[0-9a-f]{64}$/);
  assert.match(String(row.readback_hash), /^[0-9a-f]{64}$/);
  const effect = harness.db.raw.prepare(
    "SELECT action, provider, state, idempotency_key FROM external_effects WHERE effect_id = ?",
  ).get(row.effect_id) as Record<string, unknown>;
  assert.equal(effect.action, "operations.email.send");
  assert.equal(effect.provider, "fake");
  assert.equal(effect.state, "succeeded");
  assert.equal(effect.idempotency_key, pipelineAutomationEffectKey(row.invocation_id));
  assert.match(renderStageChangeSummary({
    pipeline_name: "<Sales>",
    card_id: "card<&>",
    entity_type: "lead",
    entity_id: "lead-1",
    from_stage_name: "New",
    to_stage_name: "Ready & <sent>",
    occurred_at: NOW.toISOString(),
    reason_code: "<unsafe>",
  }).html, /&lt;Sales&gt;/);
  assert.doesNotMatch(renderStageChangeSummary({
    pipeline_name: "Sales\nBcc: evil@example.invalid",
    card_id: "card",
    entity_type: "lead",
    entity_id: "lead",
    from_stage_name: null,
    to_stage_name: "Ready",
    occurred_at: NOW.toISOString(),
    reason_code: null,
  }).subject, /[\r\n]/);
  harness.db.close();
});

test("rule and invocation identity guards refuse mutable or cross-tenant rewrites", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  const rule = await createPipelineAutomationRule(env, {
    pipelineId: SALES_PIPELINE_ID,
    toStageId: stageId("new_lead"),
    action: "operations.email.send",
    recipientRef: "owner",
    templateKey: "pipeline.stage-change-summary",
    templateVersion: 1,
    active: true,
    actor: { role: "owner", userId: "appu_owner_0001" },
  }, NOW);
  await assert.rejects(
    () => revisePipelineAutomationRule(env, {
      pipelineId: SALES_PIPELINE_ID,
      toStageId: stageId("new_lead"),
      ruleId: rule.rule_id,
      expectedVersion: 0,
      action: "operations.email.send",
      recipientRef: "owner",
      templateKey: "pipeline.stage-change-summary",
      templateVersion: 1,
      active: true,
      actor: { role: "owner", userId: "appu_owner_0001" },
    }, NOW),
    /automation_expected_version_invalid/,
  );
  assert.throws(
    () => harness.db.raw.prepare("UPDATE pipeline_automation_rule_revisions SET active = 0 WHERE revision_id = ?").run(rule.revision_id),
    /pipeline_automation_rule_revisions_append_only/,
  );
  assert.throws(
    () => harness.db.raw.prepare("UPDATE pipeline_automation_rule_heads SET current_version = 9 WHERE rule_id = ?").run(rule.rule_id),
    /pipeline_automation_rule_head_version_conflict/,
  );
  const hidden = await getPipelineAutomationRule(env, OTHER_TENANT, rule.rule_id);
  assert.equal(hidden, null);
  harness.db.close();
});
