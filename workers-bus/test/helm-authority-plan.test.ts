// A tenant's helm.authority.provision.v1 plan (helm-authority-plan.ts) and its operator route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import worker from "../src/index.ts";
import { GATEWAY_EFFECT_ACTIONS, authorityPlanDigest } from "../src/helm-authority-plan.ts";
import type { DelegationSetting } from "../src/helm-gateway.ts";
import { NOW, SqliteD1, TENANT, env as baseEnv } from "./company-setup-fixture.ts";

const ADMIN = "root-admin-token";
const WORKER = "svc:ironwrap-bus:ironwrap";
const WINDOW = "valid_from=2026-11-01T00:00:00Z&valid_until=2027-02-01T00:00:00Z";
const QUERY = `worker_principal=${encodeURIComponent(WORKER)}&${WINDOW}`;

function rootEnv(db: SqliteD1, overrides: Record<string, unknown> = {}) {
  return baseEnv(db, {
    APP_MULTI_TENANT_ENABLED: "true",
    TENANT_SECRETS_KEK: "c".repeat(64),
    ADMIN_TOKEN: ADMIN,
    APP_PUBLIC_ORIGIN: "https://a.example.invalid",
    APP_ALLOWED_ORIGINS: "https://a.example.invalid",
    ...overrides,
  } as never);
}

async function get(env: unknown, path: string, token: string | null = ADMIN, method = "GET") {
  const response = await worker.fetch(
    new Request(`https://a.example.invalid${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }),
    env as never,
    { waitUntil(): void {}, passThroughOnException(): void {} } as never,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function setDelegation(db: SqliteD1, specialistId: string, actionId: string, setting: DelegationSetting) {
  const owner = db.raw.prepare("SELECT user_id FROM app_users WHERE tenant_id = ? LIMIT 1").get(TENANT) as { user_id: string };
  db.raw.prepare(
    `INSERT INTO agent_delegation_settings (setting_id, tenant_id, specialist_id, action_id, revision,
       control_revision, catalog_version, policy_version, setting, ceiling_json, reason, set_by_user_id,
       set_at, idempotency_key)
     VALUES (?, ?, ?, ?, 1, 0, 'catalog', 'policy', ?, NULL, 'test', ?, ?, ?)`,
  ).run(`setting-${specialistId}-${actionId}`, TENANT, specialistId, actionId, setting, owner.user_id, NOW, `key-${specialistId}-${actionId}`);
}

test("the digest matches HELM's published vector, the plan a naive encoder gets wrong", async () => {
  const plan = JSON.parse(readFileSync(new URL("./fixtures/helm-provision-v1-escapes.json", import.meta.url), "utf8"));
  assert.equal(await authorityPlanDigest(plan), "81bbed39150fdb7cc7988f955bcdb6be75b150b07b8ca8cd0fe425ffb386b4ef");
  assert.equal(
    await authorityPlanDigest({ ...plan, base_plan_digest: "f".repeat(64) }),
    "81bbed39150fdb7cc7988f955bcdb6be75b150b07b8ca8cd0fe425ffb386b4ef",
    "the base digest is outside the digest",
  );
});

test("the plan puts every live effect in scope for the Worker under a root it does not hold", async () => {
  const db = new SqliteD1({ seedUsers: [] });
  try {
    const { status, body } = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}`);
    assert.equal(status, 200);
    const { plan, plan_digest } = body;
    assert.match(plan_digest, /^[0-9a-f]{64}$/);
    assert.equal(plan.schema, "helm.authority.provision.v1");
    assert.equal(plan.org_ref, `org:${TENANT}`);
    assert.equal(plan.stage, "draft");
    assert.equal(plan.base_plan_digest, "");
    assert.deepEqual(plan.principals, [{ id: `org:${TENANT}`, kind: "service" }, { id: WORKER, kind: "service" }]);

    const effectTypes = GATEWAY_EFFECT_ACTIONS.map((action) => `ironwrap.${action}`);
    assert.deepEqual(plan.effect_types.map((row: { effect_type: string }) => row.effect_type), effectTypes);
    assert.ok(plan.effect_types.every((row: { risk_class: string }) => row.risk_class === "medium"), "a higher class would escalate every call and could not be lowered");
    assert.deepEqual(plan.mandates, [
      { node: `org:${TENANT}`, holder: `org:${TENANT}`, parent: null, terms: { effect_types: effectTypes, targets: null } },
      { node: "seat:ironwrap-bus#g1", holder: WORKER, parent: `org:${TENANT}`, terms: { effect_types: effectTypes, targets: null } },
    ]);
    assert.equal(plan.limits, undefined);
  } finally { db.raw.close(); }
});

test("the same inputs compile to the same digest, so re-applying changes nothing", async () => {
  const db = new SqliteD1({ seedUsers: [] });
  try {
    const first = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}`);
    const second = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}`);
    assert.equal(first.body.plan_digest, second.body.plan_digest);
    const rebased = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}&base_plan_digest=${"a".repeat(64)}`);
    assert.equal(rebased.body.plan.base_plan_digest, "a".repeat(64));
    assert.equal(rebased.body.plan_digest, first.body.plan_digest);
  } finally { db.raw.close(); }
});

test("an agent's delegation setting cannot deny or re-ask a person's permit-bound effect", async () => {
  const db = new SqliteD1();
  try {
    const before = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}`);
    setDelegation(db, "proposal_contract", "proposal.withdraw", "off");
    const after = await get(rootEnv(db), `/admin/tenants/${TENANT}/authority-plan?${QUERY}`);
    assert.equal(after.body.plan_digest, before.body.plan_digest);
    const types = after.body.plan.mandates[1].terms.effect_types;
    assert.ok(types.includes("ironwrap.proposal.withdraw") && types.includes("ironwrap.proposal.publish"));
    assert.equal(after.body.plan.mandates[1].terms.approval_threshold, undefined);
  } finally { db.raw.close(); }
});

test("the route answers only the operator, only for a known tenant, and refuses a bad plan input", async () => {
  const db = new SqliteD1({ seedUsers: [] });
  try {
    const env = rootEnv(db);
    const path = `/admin/tenants/${TENANT}/authority-plan`;
    assert.equal((await get(env, `${path}?${QUERY}`, null)).status, 401);
    assert.equal((await get(env, `${path}?${QUERY}`, "wrong-token")).status, 401);
    assert.equal((await get(rootEnv(db, { APP_MULTI_TENANT_ENABLED: "false" }), `${path}?${QUERY}`)).status, 404);
    assert.equal((await get(env, `/admin/tenants/nobody-here/authority-plan?${QUERY}`)).status, 404);
    assert.equal((await get(env, `${path}?${QUERY}`, ADMIN, "POST")).status, 405);
    for (const [query, error] of [
      [WINDOW, "invalid_worker_principal"],
      [`worker_principal=%20padded&${WINDOW}`, "invalid_worker_principal"],
      // Holding the root, the Worker would resolve to its open terms and skip every approval.
      [`worker_principal=${encodeURIComponent(`org:${TENANT}`)}&${WINDOW}`, "worker_principal_is_root"],
      [`worker_principal=x&org_ref=nope&${WINDOW}`, "invalid_org_ref"],
      [`worker_principal=x&stage=live&${WINDOW}`, "invalid_stage"],
      [`worker_principal=x&base_plan_digest=abc&${WINDOW}`, "invalid_base_plan_digest"],
      ["worker_principal=x&valid_from=2026-11-01T00:00:00Z", "invalid_validity_window"],
      ["worker_principal=x&valid_from=2027-02-30T00:00:00Z&valid_until=2027-03-01T00:00:00Z", "invalid_validity_window"],
      ["worker_principal=x&valid_from=2027-01-01T00:00:00Z&valid_until=2027-01-01T00:00:00Z", "invalid_validity_window"],
    ]) {
      const refused = await get(env, `${path}?${query}`);
      assert.deepEqual([refused.status, refused.body.error], [400, error], query);
    }
  } finally { db.raw.close(); }
});

test("the inventory fits HELM's limits and every effect type is one the gateway client would send", () => {
  assert.ok(GATEWAY_EFFECT_ACTIONS.length <= 64, "a plan registers at most 64 effect types");
  assert.deepEqual([...GATEWAY_EFFECT_ACTIONS], [...new Set(GATEWAY_EFFECT_ACTIONS)].sort());
  for (const action of GATEWAY_EFFECT_ACTIONS) assert.match(`ironwrap.${action}`, /^(?!helm\.authority\.)[a-z][a-z0-9_.-]{0,127}$/);
});

/** A proposal site whose action is not a literal, and the actions that site can carry. */
function dynamicSiteActions(file: string, source: string): string[] | null {
  switch (file) {
    case "google.ts":
      return [...source.matchAll(/action: "((?:customer|operations)\.email\.send)"/g)].map((match) => match[1]);
    case "jobnimbus.ts":
      return [...source.matchAll(/jnFetch\(env, "([A-Z]+)"/g)].map((match) => `jobnimbus.${match[1].toLowerCase()}`);
    case "newo-control.ts":
      return [...source.matchAll(/operation: "([a-z_.]+)"/g)].map((match) => match[1]);
    case "facet-design-frappe-projection.ts":
      return ["facet.design.v2.compatibility_projection", "facet.design.v2.compatibility_projection.blocked"];
    // The accounting table is imported by the inventory; the two runtime sites pass a caller's action on.
    case "accounting-dispatch-binding.ts":
    case "effect-runtime.ts":
    case "effect-runtime-admin.ts":
      return [];
    default:
      return null;
  }
}

test("every action the Worker can propose is in the plan, so enforce cannot strand a live effect", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const inventory = new Set(GATEWAY_EFFECT_ACTIONS);
  let literalSites = 0;
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!/\b(runExternalEffect|proposeExternalEffect)(<[^>]*>)?\(/.test(line) || /function/.test(line)) return;
      const literal = lines.slice(index, index + 45).join("\n").match(/^\s*action: "([a-z0-9_.-]+)",?\s*$/m);
      const dynamic = dynamicSiteActions(file, source);
      if (dynamic !== null) {
        for (const action of dynamic) assert.ok(inventory.has(action), `${file}: ${action} is missing from the plan`);
        return;
      }
      assert.ok(literal, `${file}:${index + 1} proposes a non-literal action: add it to dynamicSiteActions and the plan`);
      assert.ok(inventory.has(literal[1]), `${file}:${index + 1}: ${literal[1]} is missing from the plan`);
      literalSites += 1;
    });
  }
  assert.ok(literalSites >= 3, "the scan found the literal proposal sites");
});
