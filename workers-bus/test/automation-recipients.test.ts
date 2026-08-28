// Tenant-administered automation recipients (ELEC-204).
//
// The defect this suite locks down: an administrator could not add "the shop" as a delivery
// destination, because the catalog a rule resolves against lived in a deploy secret. Every test
// here drives the real route handlers against a real SQLite database with every migration applied,
// and the one provider hop is a fetch mock - no live call is made anywhere.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTOMATION_RECIPIENT_CHANNELS,
  maskDestination,
  validateRecipientDestination,
} from "../src/automation-recipients.ts";
import { handleAutomationRecipientRoute } from "../src/automation-recipients-api.ts";
import {
  drainPipelineStageAutomation,
  pipelineAutomationEffectKey,
  resolvePipelineAutomationRecipient,
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
  USERS,
  type Harness,
} from "./pipeline-board-fixture.ts";

const RECIPIENTS = "/api/v1/admin/automation-recipients";
const RULES = `/api/v1/admin/pipelines/${SALES_PIPELINE_ID}/automation-rules`;
const NOW = new Date("2026-08-28T10:00:00.000Z");
const SHOP = "shop@ironwrap.example";

function automationEnv(harness: Harness, overrides: Record<string, unknown> = {}): Harness["env"] {
  Object.assign(harness.env, {
    EFFECT_RUNTIME_ENABLED: "true",
    PIPELINE_AUTOMATION_ENABLED: "true",
    ...overrides,
  });
  return harness.env;
}

/** The deployment blob this change replaces, kept reachable so the fallback stays provable. */
function withDeploymentBlob(harness: Harness, entries: Record<string, string>): Harness["env"] {
  return automationEnv(harness, { PIPELINE_AUTOMATION_RECIPIENTS_JSON: JSON.stringify(entries) });
}

async function recipients(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown,
  who: keyof typeof USERS = "owner",
  tenant = TENANT,
  at = new Date(NOW.getTime() - 60_000),
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAutomationRecipientRoute(
    request(method, path, {
      body,
      idempotency: method === "GET" ? null : `recipient-${crypto.randomUUID()}`,
    }),
    harness.env,
    auth(who, tenant),
    at,
  );
  assert.ok(response, `${method} ${path} was not claimed`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function rules(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown,
  who: keyof typeof USERS = "owner",
  tenant = TENANT,
  at = new Date(NOW.getTime() - 30_000),
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handlePipelineRoute(
    request(method, path, {
      body,
      idempotency: method === "GET" ? null : `rule-${crypto.randomUUID()}`,
    }),
    harness.env,
    auth(who, tenant),
    at,
  );
  assert.ok(response, `${method} ${path} was not claimed`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Create the recipient an owner would create, and return its administration record. */
async function createShop(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const created = await recipients(harness, "POST", RECIPIENTS, {
    recipient_ref: "shop",
    label: "Production shop",
    channel: "email",
    destination: SHOP,
    ...overrides,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.recipient;
}

const RULE_BODY = (toStageId: string, overrides: Record<string, unknown> = {}) => ({
  to_stage_id: toStageId,
  action: "operations.email.send",
  recipient_ref: "shop",
  template_key: "pipeline.stage-change-summary",
  template_version: 1,
  active: true,
  ...overrides,
});

async function placeCard(
  harness: Harness,
  stageKey: string,
  key: string,
  at = NOW,
): Promise<Record<string, any>> {
  const response = await handlePipelineRoute(
    request("POST", `/api/v1/pipelines/${SALES_PIPELINE_ID}/cards`, {
      body: { entity_type: "lead", entity_id: "lead:board:0001", stage_key: stageKey },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    at,
  );
  assert.ok(response);
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

/* ============================================================== acceptance criteria ======== */

test("an owner creates a recipient through the API and a rule can then be built against it", async () => {
  const harness = setup();
  automationEnv(harness);

  // The defect, reproduced: with no catalog anywhere, the rule builder has nothing to offer and
  // the administrator has no screen that would change that.
  const before = await rules(harness, "GET", RULES);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.catalog.recipient_refs, []);
  assert.equal(before.body.catalog.recipient_configured, false);
  assert.equal(before.body.catalog.recipient_source, "none");

  const shop = await createShop(harness);
  assert.equal(shop.recipient_ref, "shop");
  assert.equal(shop.label, "Production shop");
  assert.equal(shop.channel, "email");
  assert.equal(shop.version, 1);
  assert.equal(shop.action, "create");
  assert.equal(shop.active, true);
  assert.equal(shop.actor.role, "owner");
  assert.equal(shop.actor.id, USERS.owner?.userId);

  // The same owner action, and only that action, populates the rule builder's picker.
  const after = await rules(harness, "GET", RULES);
  assert.deepEqual(after.body.catalog.recipient_refs, ["shop"]);
  assert.equal(after.body.catalog.recipient_configured, true);
  assert.equal(after.body.catalog.recipient_source, "tenant");
  assert.deepEqual(after.body.catalog.recipient_labels, [
    { recipient_ref: "shop", label: "Production shop" },
  ]);

  const rule = await rules(harness, "POST", RULES, RULE_BODY(stageId("new_lead")));
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  assert.equal(rule.body.rule.recipient_ref, "shop");
});

test("a rule stores only a reference, and no raw address can reach a rule or an API response", async () => {
  const harness = setup();
  automationEnv(harness);
  const shop = await createShop(harness);
  const created = await rules(harness, "POST", RULES, RULE_BODY(stageId("new_lead")));
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // The rule builder still refuses a raw address outright: an address is not a valid reference.
  for (const raw of [SHOP, "Shop <shop@ironwrap.example>", "shop@ironwrap.example,evil@x.example"]) {
    const refused = await rules(
      harness, "POST", RULES, RULE_BODY(stageId("visit_booked"), { recipient_ref: raw }),
    );
    assert.equal(refused.status, 400, `${raw} -> ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, "automation_recipient_ref_invalid");
  }

  // The destination exists in exactly one table, and nowhere a rule or an invocation can carry it.
  const holders = harness.db.raw.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  const carrying: string[] = [];
  for (const { name } of holders) {
    const columns = harness.db.raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    const predicate = columns.map((column) => `CAST("${column.name}" AS TEXT) LIKE ?`).join(" OR ");
    const hits = harness.db.raw.prepare(`SELECT COUNT(*) AS total FROM "${name}" WHERE ${predicate}`)
      .get(...columns.map(() => `%${SHOP}%`)) as { total: number };
    if (Number(hits.total) > 0) carrying.push(name);
  }
  assert.deepEqual(carrying, ["automation_recipient_revisions"]);

  // And it does not leave the Worker: every recipient read publishes a mask and a digest.
  const listed = await recipients(harness, "GET", RECIPIENTS);
  const read = await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}`);
  const history = await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}/revisions`);
  // The mask deliberately keeps the domain - that is what lets an owner recognise what they
  // configured - so what must never appear is the address itself.
  for (const payload of [created.body, listed.body, read.body, history.body])
    assert.equal(JSON.stringify(payload).includes(SHOP), false, JSON.stringify(payload));
  assert.equal(listed.body.recipients[0].destination_masked, "s***@ironwrap.example");
  assert.match(String(listed.body.recipients[0].destination_digest), /^[0-9a-f]{64}$/);
  assert.equal("destination" in listed.body.recipients[0], false);
});

test("recipients do not leak or resolve across tenants", async () => {
  const harness = setup();
  automationEnv(harness);
  const shop = await createShop(harness);

  // A second tenant's owner sees an empty catalog, and cannot read, revise or retire the record.
  const otherList = await recipients(harness, "GET", RECIPIENTS, undefined, "owner", OTHER_TENANT);
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.body.recipients, []);
  const otherRead = await recipients(
    harness, "GET", `${RECIPIENTS}/${shop.recipient_id}`, undefined, "owner", OTHER_TENANT,
  );
  assert.equal(otherRead.status, 404, JSON.stringify(otherRead.body));
  const otherRevise = await recipients(
    harness, "POST", `${RECIPIENTS}/${shop.recipient_id}`,
    { destination: "attacker@evil.example", expected_version: 1 }, "owner", OTHER_TENANT,
  );
  assert.equal(otherRevise.status, 404, JSON.stringify(otherRevise.body));
  const otherRetire = await recipients(
    harness, "POST", `${RECIPIENTS}/${shop.recipient_id}/retire`,
    { expected_version: 1 }, "owner", OTHER_TENANT,
  );
  assert.equal(otherRetire.status, 404, JSON.stringify(otherRetire.body));

  // Isolation is enforced by the resolution query, not by the caller: the reference simply does
  // not exist for the other tenant.
  await assert.rejects(
    () => resolvePipelineAutomationRecipient(harness.env, OTHER_TENANT, "shop"),
    /automation_recipient_config_unavailable/,
  );
  const resolved = await resolvePipelineAutomationRecipient(harness.env, TENANT, "shop");
  assert.equal(resolved.address, SHOP);

  // The record the first tenant wrote is untouched by every one of those attempts.
  const mine = await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}`);
  assert.equal(mine.body.recipient.version, 1);
  assert.equal(mine.body.recipient.destination_digest, shop.destination_digest);
});

test("only an owner may administer recipients", async () => {
  const harness = setup();
  automationEnv(harness);
  const shop = await createShop(harness);

  for (const who of ["sales", "ops", "production", "field"] as const) {
    for (const [method, path, body] of [
      ["GET", RECIPIENTS, undefined],
      ["POST", RECIPIENTS, { recipient_ref: "sneak", label: "Sneak", channel: "email", destination: "s@x.example" }],
      ["GET", `${RECIPIENTS}/${shop.recipient_id}`, undefined],
      ["POST", `${RECIPIENTS}/${shop.recipient_id}`, { destination: "attacker@evil.example", expected_version: 1 }],
      ["POST", `${RECIPIENTS}/${shop.recipient_id}/retire`, { expected_version: 1 }],
      ["GET", `${RECIPIENTS}/${shop.recipient_id}/revisions`, undefined],
    ] as Array<[string, string, unknown]>) {
      const refused = await recipients(harness, method, path, body, who);
      assert.equal(refused.status, 403, `${who} ${method} ${path} -> ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, "automation_recipient_admin_forbidden");
    }
  }
  // Refusal is uniform, so a non-owner cannot map the tenant by telling a real id from a fake one.
  const unknownId = await recipients(harness, "GET", `${RECIPIENTS}/arcp_does_not_exist_00000`, undefined, "sales");
  assert.equal(unknownId.status, 403);
  assert.equal(unknownId.body.error, "automation_recipient_admin_forbidden");

  // And nothing changed under any of it.
  const untouched = await recipients(harness, "GET", RECIPIENTS);
  assert.equal(untouched.body.recipients.length, 1);
  assert.equal(untouched.body.recipients[0].version, 1);
});

test("dispatch resolves the tenant catalog and delivers through the untouched Gmail effect path", async () => {
  const harness = setup();
  const env = automationEnv(harness);
  await createShop(harness);
  await rules(harness, "POST", RULES, RULE_BODY(stageId("new_lead")));
  await placeCard(harness, "new_lead", "recipient-effect-0000000001");

  // The one provider hop, mocked. Gmail's own adapter, the effect runtime and the default sender
  // all run unchanged; only the network is fake.
  const { serviceAccount } = await fakeServiceAccount();
  Object.assign(env, { GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount, FROM_EMAIL: "bus@ironwrap.example" });
  const sent: Array<{ raw: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return jsonResponse({ access_token: "test-token", expires_in: 3600 });
    if (url.endsWith("/messages/send")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
      sent.push({ raw: String(body.raw ?? "") });
      return jsonResponse({ id: "gmail-message-1" });
    }
    if (url.includes("/messages/"))
      return jsonResponse({ id: "gmail-message-1", raw: sent[sent.length - 1]?.raw ?? "" });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  let report;
  try {
    report = await drainPipelineStageAutomation(env, { now: NOW, limit: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(report.sent, 1, JSON.stringify(report));

  // The address in the delivered message is the one the owner configured, and it arrived there
  // through `sendPipelineAutomationEmail` -> `runExternalEffect` with its evidence intact.
  assert.equal(sent.length, 1);
  const message = decodeRaw(sent[0]?.raw ?? "");
  assert.match(message, new RegExp(`^To: ${SHOP}$`, "m"));
  const invocation = harness.db.raw.prepare(
    "SELECT * FROM pipeline_stage_automation_invocations LIMIT 1",
  ).get() as Record<string, any>;
  assert.equal(invocation.status, "succeeded");
  assert.equal(invocation.recipient_ref, "shop");
  const effect = harness.db.raw.prepare(
    "SELECT action, provider, state, idempotency_key, readback_hash FROM external_effects WHERE effect_id = ?",
  ).get(invocation.effect_id) as Record<string, unknown>;
  assert.equal(effect.action, "operations.email.send");
  assert.equal(effect.provider, "gmail");
  assert.equal(effect.state, "succeeded");
  assert.equal(effect.idempotency_key, pipelineAutomationEffectKey(String(invocation.invocation_id)));
  // A matching readback is what the Gmail adapter records when the provider echoed the message.
  assert.match(String(effect.readback_hash), /^[0-9a-f]{64}$/);
});

test("the deployment secret is a fallback for a tenant with no catalog, and is dropped once it has one", async () => {
  const harness = setup();
  const env = withDeploymentBlob(harness, { owner: "owner@deploy.example", shop: "shop@deploy.example" });

  // 1. An existing deployment keeps working exactly as before this change.
  const inherited = await rules(harness, "GET", RULES);
  assert.equal(inherited.body.catalog.recipient_source, "deployment");
  assert.deepEqual(inherited.body.catalog.recipient_refs, ["owner", "shop"]);
  assert.equal(
    (await resolvePipelineAutomationRecipient(env, TENANT, "shop")).address,
    "shop@deploy.example",
  );

  // 2. The first record an owner writes takes the catalog over - and the tenant's own destination
  //    wins for a reference the blob also names. The blob can never override configured data.
  await createShop(harness);
  const administered = await rules(harness, "GET", RULES);
  assert.equal(administered.body.catalog.recipient_source, "tenant");
  assert.deepEqual(administered.body.catalog.recipient_refs, ["shop"]);
  assert.equal((await resolvePipelineAutomationRecipient(env, TENANT, "shop")).address, SHOP);

  // 3. Takeover is per tenant, not per reference: a blob-only reference now fails loudly rather
  //    than silently resolving to an address nobody can see in the product.
  await assert.rejects(
    () => resolvePipelineAutomationRecipient(env, TENANT, "owner"),
    /automation_recipient_ref_unknown/,
  );
  const refused = await rules(
    harness, "POST", RULES, RULE_BODY(stageId("visit_booked"), { recipient_ref: "owner" }),
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "automation_recipient_ref_unknown");
});

test("retiring a recipient a live rule still references is refused with the rules that would break", async () => {
  const harness = setup();
  automationEnv(harness);
  const shop = await createShop(harness);
  const rule = await rules(harness, "POST", RULES, RULE_BODY(stageId("new_lead")));
  assert.equal(rule.status, 201, JSON.stringify(rule.body));

  // The read warns before the command is attempted...
  const warned = await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}`);
  assert.equal(warned.body.referenced_by.length, 1);
  assert.equal(warned.body.referenced_by[0].rule_id, rule.body.rule.rule_id);

  // ...and the command itself is refused, naming exactly what it would have stranded.
  const blocked = await recipients(
    harness, "POST", `${RECIPIENTS}/${shop.recipient_id}/retire`, { expected_version: 1 },
  );
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error, "automation_recipient_in_use");
  assert.deepEqual(blocked.body.rules.map((entry: any) => entry.rule_id), [rule.body.rule.rule_id]);
  assert.equal((await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}`)).body.recipient.active, true);

  // Deactivating the rule is the administrator's own explicit act; only then may the retirement
  // proceed, so a delivery destination never disappears out from under a live automation.
  const disabled = await rules(harness, "POST", `${RULES}/${rule.body.rule.rule_id}/revisions`, {
    ...RULE_BODY(stageId("new_lead"), { active: false }),
    expected_version: 1,
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const retired = await recipients(
    harness, "POST", `${RECIPIENTS}/${shop.recipient_id}/retire`, { expected_version: 1 },
  );
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal(retired.body.recipient.active, false);
  assert.equal(retired.body.recipient.action, "retire");
  assert.equal(retired.body.recipient.version, 2);

  // A retired recipient leaves the picker and cannot be named by a new rule.
  const catalog = await rules(harness, "GET", RULES);
  assert.deepEqual(catalog.body.catalog.recipient_refs, []);
  const rejected = await rules(harness, "POST", RULES, RULE_BODY(stageId("visit_booked")));
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "automation_recipient_ref_retired");
});

/* =========================================================== governance and validation ===== */

test("recipient revisions are append-only, attributed, and CAS-protected", async () => {
  const harness = setup();
  automationEnv(harness);
  const shop = await createShop(harness);

  const revised = await recipients(harness, "POST", `${RECIPIENTS}/${shop.recipient_id}`, {
    label: "Shop (Calgary)",
    destination: "calgary@ironwrap.example",
    expected_version: 1,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.recipient.version, 2);
  assert.equal(revised.body.recipient.action, "revise");
  assert.equal(revised.body.recipient.prior_revision_id, shop.revision_id);
  assert.notEqual(revised.body.recipient.destination_digest, shop.destination_digest);

  // A stale administration screen is refused with the exact conflict, never silently applied.
  const stale = await recipients(harness, "POST", `${RECIPIENTS}/${shop.recipient_id}`, {
    destination: "stale@ironwrap.example",
    expected_version: 1,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "automation_recipient_version_conflict");
  assert.equal(stale.body.current_version, 2);

  // The reference a rule is bound to is not renameable.
  const renamed = await recipients(harness, "POST", `${RECIPIENTS}/${shop.recipient_id}`, {
    recipient_ref: "warehouse",
    expected_version: 2,
  });
  assert.equal(renamed.status, 409, JSON.stringify(renamed.body));
  assert.equal(renamed.body.error, "automation_recipient_ref_immutable");

  // Who changed where the shop's mail goes, and when, is answerable after the fact.
  const history = await recipients(harness, "GET", `${RECIPIENTS}/${shop.recipient_id}/revisions`);
  assert.deepEqual(history.body.revisions.map((entry: any) => entry.version), [1, 2]);
  assert.deepEqual(history.body.revisions.map((entry: any) => entry.action), ["create", "revise"]);
  for (const entry of history.body.revisions) {
    assert.equal(entry.actor.role, "owner");
    assert.equal(entry.actor.id, USERS.owner?.userId);
    assert.match(String(entry.command_fingerprint), /^[0-9a-f]{64}$/);
  }

  // The revision log is append-only at the schema, not merely by convention.
  assert.throws(
    () => harness.db.raw.prepare(
      "UPDATE automation_recipient_revisions SET destination = ? WHERE version = 1",
    ).run("rewritten@ironwrap.example"),
    /automation_recipient_revisions_append_only/,
  );
  assert.throws(
    () => harness.db.raw.prepare("DELETE FROM automation_recipient_revisions WHERE version = 1").run(),
    /automation_recipient_revisions_append_only/,
  );
});

test("a replayed command returns the same revision instead of writing a second one", async () => {
  const harness = setup();
  automationEnv(harness);
  const key = "recipient-replay-0000000001";
  const first = await handleAutomationRecipientRoute(
    request("POST", RECIPIENTS, {
      body: { recipient_ref: "shop", label: "Production shop", channel: "email", destination: SHOP },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    NOW,
  );
  const second = await handleAutomationRecipientRoute(
    request("POST", RECIPIENTS, {
      body: { recipient_ref: "shop", label: "Production shop", channel: "email", destination: SHOP },
      idempotency: key,
    }),
    harness.env,
    auth("owner"),
    NOW,
  );
  assert.equal(first?.status, 201);
  assert.equal(second?.status, 200);
  const replayed = (await second?.json()) as Record<string, any>;
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.recipient.version, 1);
  const total = harness.db.raw.prepare(
    "SELECT COUNT(*) AS total FROM automation_recipient_revisions",
  ).get() as { total: number };
  assert.equal(Number(total.total), 1);
});

test("a destination is validated server-side before it can ever reach a transport", async () => {
  const harness = setup();
  automationEnv(harness);

  const refused: Array<[string, unknown]> = [
    ["a header injection", "shop@ironwrap.example\r\nBcc: evil@x.example"],
    ["a bare newline", "shop@ironwrap.example\nevil@x.example"],
    ["a recipient list", "shop@ironwrap.example, evil@x.example"],
    ["a semicolon list", "shop@ironwrap.example;evil@x.example"],
    ["an RFC display name", "Shop <shop@ironwrap.example>"],
    ["a homoglyph domain", "shop@irоnwrap.example"],
    ["no domain dot", "shop@localhost"],
    ["two at signs", "shop@@ironwrap.example"],
    ["a leading dot", ".shop@ironwrap.example"],
    ["a hyphen-edged label", "shop@-ironwrap.example"],
    ["a numeric tld", "shop@ironwrap.12"],
    ["whitespace", "shop @ironwrap.example"],
    ["an empty string", ""],
    ["a non-string", 42],
  ];
  for (const [why, value] of refused) {
    const response = await recipients(harness, "POST", RECIPIENTS, {
      recipient_ref: "shop", label: "Shop", channel: "email", destination: value,
    });
    assert.equal(response.status, 400, `${why} -> ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, "automation_recipient_destination_invalid", why);
  }
  // Nothing above created a record, so a refused destination cannot be reached by a rule either.
  assert.deepEqual((await recipients(harness, "GET", RECIPIENTS)).body.recipients, []);

  // An unregistered transport is refused with the closed registry, not silently accepted.
  const channel = await recipients(harness, "POST", RECIPIENTS, {
    recipient_ref: "shop", label: "Shop", channel: "sms", destination: SHOP,
  });
  assert.equal(channel.status, 400, JSON.stringify(channel.body));
  assert.equal(channel.body.error, "automation_recipient_channel_invalid");
  assert.deepEqual(channel.body.channels, [...AUTOMATION_RECIPIENT_CHANNELS]);

  // Normalization is part of the contract: the stored destination is the canonical lowercase form.
  const created = await createShop(harness, { destination: "  SHOP@IronWrap.Example  " });
  assert.equal(created.destination_digest,
    (await recipients(harness, "GET", RECIPIENTS)).body.recipients[0].destination_digest);
  assert.equal((await resolvePipelineAutomationRecipient(harness.env, TENANT, "shop")).address, SHOP);
});

test("the mask shows enough to recognise a destination and not enough to harvest one", () => {
  assert.equal(maskDestination("email", "shop@ironwrap.example"), "s***@ironwrap.example");
  assert.equal(maskDestination("email", "a@ironwrap.example"), "a***@ironwrap.example");
  // The star run is fixed-length, so two different local parts of different lengths mask alike.
  assert.equal(
    maskDestination("email", "sales-team-inbox@ironwrap.example"),
    maskDestination("email", "shipping@ironwrap.example"),
  );
  assert.equal(validateRecipientDestination("email", " Shop@IronWrap.Example "), "shop@ironwrap.example");
});

/* ------------------------------------------------------------------------------ helpers --- */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function decodeRaw(raw: string): string {
  const encoded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * A throwaway RSA key generated in-process, so the Gmail adapter's real JWT signing runs against a
 * real key and nothing resembling a credential is committed or read from the environment.
 */
async function fakeServiceAccount(): Promise<{ serviceAccount: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n");
  return {
    serviceAccount: JSON.stringify({
      client_email: "bus@test.iam.gserviceaccount.invalid",
      private_key: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
    }),
  };
}
