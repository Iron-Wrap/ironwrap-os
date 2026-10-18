import assert from "node:assert/strict";
import { test } from "node:test";

import { fieldItemResolutionsResponseSchema } from "../../app/src/storage/field-item-resolution-contracts.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import {
  FIELD_ITEM_PROPOSAL_ACTION,
  recordFieldItemResolution,
  type FieldItemResolutionInput,
} from "../src/field-item-resolutions.ts";
import { sha256Hex } from "../src/newo-hash.ts";
import { SqliteD1 } from "./pipeline-board-fixture.ts";

const TENANT = "ironwrap";
const OTHER = "other-co";
const AT = "2026-10-01T12:00:00.000Z";
const PATH = "/api/v1/field-item-resolutions";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const DEVICE = "device-fir-0001";

const USERS = {
  owner: { userId: "appu_fir_owner", tenant: TENANT, role: "owner", access: "owner" },
  ops: { userId: "appu_fir_ops", tenant: TENANT, role: "ops", access: "ops" },
  sales: { userId: "appu_fir_sales", tenant: TENANT, role: "ops", access: "sales" },
  production: { userId: "appu_fir_prod", tenant: TENANT, role: "ops", access: "production" },
  crewA: { userId: "appu_fir_crew_a", tenant: TENANT, role: "field", access: "field" },
  crewB: { userId: "appu_fir_crew_b", tenant: TENANT, role: "field", access: "field" },
  otherOwner: { userId: "appu_fir_other_owner", tenant: OTHER, role: "owner", access: "owner" },
  otherCrew: { userId: "appu_fir_other_crew", tenant: OTHER, role: "field", access: "field" },
} as const;
type Who = keyof typeof USERS;

function setup() {
  const db = new SqliteD1();
  const insert = db.raw.prepare(
    `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role,
       frappe_user_id, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
  );
  for (const [name, user] of Object.entries(USERS))
    insert.run(user.userId, user.tenant, `${name.toLowerCase()}@example.invalid`, name, user.role,
      user.access, `${name.toLowerCase()}@example.invalid`, AT, AT);
  return { db, env: { DB: db as never, APP_TENANT_ID: TENANT } as AppEnv };
}
type Fixture = ReturnType<typeof setup>;

function auth(who: Who, deviceId: string | null = null): AuthContext {
  const user = USERS[who];
  const role = user.access as AppRole;
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf-token",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64), session_created_at: AT,
      session_expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null,
      device_id: deviceId, device_proof_hash: null, user_id: user.userId, tenant_id: user.tenant,
      email_normalized: `${who}@example.invalid`, display_name: who, role,
      frappe_user_id: `${who}@example.invalid`, active: 1, created_by: "seed", created_at: AT,
      updated_at: AT,
    },
  };
}

const key = () => `field-item-resolution:${crypto.randomUUID()}`;

function post(
  f: Fixture,
  body: unknown,
  options: { who?: Who; id?: string; csrf?: boolean; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf-token");
  headers.set("idempotency-key", options.id ?? key());
  return handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${PATH}`, {
      method: "POST", headers, body: JSON.stringify(body),
    }),
    f.env,
    auth(options.who ?? "ops"),
  );
}

function get(f: Fixture, ids: string[], who: Who = "crewA", deviceId: string | null = null, extra = "") {
  const query = ids.map((id) => `device_action_id=${encodeURIComponent(id)}`).join("&");
  return handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${PATH}?${query}${extra}`),
    f.env,
    auth(who, deviceId),
  );
}

async function expectError(response: Response, status: number, code: string) {
  const body = (await response.json()) as { error?: string };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error, code);
}

function arrived(deviceActionId: string, overrides: Partial<FieldItemResolutionInput> = {}) {
  return {
    device_action_id: deviceActionId,
    item_kind: "fleet_pre_trip_inspection",
    payload_sha256: HASH,
    resolution: "arrived",
    linked_record: { type: "fleet_asset_action", id: deviceActionId },
    crew_user_id: USERS.crewA.userId,
    ai_proposal: null,
    ...overrides,
  } as FieldItemResolutionInput;
}

function notArrived(deviceActionId: string, itemKind = "fleet_pre_trip_inspection") {
  return {
    device_action_id: deviceActionId, item_kind: itemKind, payload_sha256: null,
    resolution: "not_arrived", linked_record: null, crew_user_id: USERS.crewA.userId,
    ai_proposal: null,
  } as FieldItemResolutionInput;
}

function seedFleet(
  f: Fixture,
  deviceActionId: string,
  options: { tenant?: string; user?: string; kind?: string; status?: string; hash?: string } = {},
) {
  const status = options.status ?? "verified";
  f.db.raw.prepare(
    `INSERT INTO fleet_asset_actions (device_action_id, tenant_id, user_id, fleet_asset_id,
       action_kind, payload_hash, status, response_json, created_at, updated_at, verified_at)
     VALUES (?, ?, ?, 'TRUCK-1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(deviceActionId, options.tenant ?? TENANT, options.user ?? USERS.crewA.userId,
    options.kind ?? "pre_trip_inspection", options.hash ?? HASH, status,
    status === "verified" ? "{}" : null, AT, AT, status === "verified" ? AT : null);
}

function count(f: Fixture, sql: string, ...args: unknown[]): number {
  return Number((f.db.raw.prepare(sql).get(...(args as never[])) as { n: number }).n);
}

test("arrived binds to the exact stored crew write, writes one audit event and replays exactly", async () => {
  const f = setup();
  seedFleet(f, "fir-fleet-0001");
  const id = key();
  const created = await post(f, arrived("fir-fleet-0001"), { id });
  const first = await created.json() as {
    replayed: boolean;
    resolution: { resolution_id: string; resolution: string; payload_sha256: string;
      linked_record: unknown; crew_user_id: string; resolved_by: unknown; ai_proposal: unknown };
  };
  assert.equal(created.status, 201, JSON.stringify(first));
  assert.equal(created.headers.get("cache-control"), "private, no-store");
  assert.equal(first.replayed, false);
  assert.match(first.resolution.resolution_id, /^fir_[0-9a-f]{64}$/);
  assert.deepEqual(
    { ...first.resolution, resolution_id: "", resolved_at: undefined },
    {
      resolution_id: "", device_action_id: "fir-fleet-0001", item_kind: "fleet_pre_trip_inspection",
      payload_sha256: HASH, resolution: "arrived",
      linked_record: { type: "fleet_asset_action", id: "fir-fleet-0001" },
      resolved_at: undefined, crew_user_id: USERS.crewA.userId,
      resolved_by: { user_id: USERS.ops.userId, role: "ops" }, ai_proposal: null, request_id: id,
    },
  );
  const audit = f.db.raw.prepare(
    "SELECT automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by, reason FROM audit_log WHERE automation = 'field_item_resolution'",
  ).all().map((entry) => ({ ...entry }));
  assert.deepEqual(audit, [{
    automation: "field_item_resolution", trigger: "office", envelope_id: first.resolution.resolution_id,
    source_ids: "device_action:fir-fleet-0001,kind:fleet_pre_trip_inspection",
    target_ids: "fleet_asset_action:fir-fleet-0001", action: "resolve_arrived", result: "ok",
    approved_by: USERS.ops.userId, reason: null,
  }]);

  // The same key and the same request is the original answer, not a second one.
  const replay = await post(f, arrived("fir-fleet-0001"), { id });
  const again = await replay.json() as { replayed: boolean; resolution: unknown };
  assert.equal(replay.status, 200);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.resolution, first.resolution);
  // The same key with a changed intent, or the same key from another person, conflicts.
  await expectError(await post(f, arrived("fir-fleet-0001", { resolution: "duplicate" }), { id }),
    409, "field_item_resolution_idempotency_conflict");
  await expectError(await post(f, arrived("fir-fleet-0001"), { id, who: "owner" }),
    409, "field_item_resolution_idempotency_conflict");
  // A new key cannot answer the same exact item twice.
  await expectError(await post(f, arrived("fir-fleet-0001", { resolution: "duplicate" })),
    409, "field_item_already_resolved");
  assert.equal(count(f, "SELECT COUNT(*) n FROM field_item_resolutions"), 1);
  assert.equal(count(f, "SELECT COUNT(*) n FROM audit_log WHERE automation = 'field_item_resolution'"), 1);
});

test("every refusal leaves nothing behind", async () => {
  const f = setup();
  seedFleet(f, "fir-fleet-0002");
  seedFleet(f, "fir-fleet-0003", { status: "processing" });
  const body = arrived("fir-fleet-0002");
  for (const who of ["sales", "production", "crewA"] as const)
    await expectError(await post(f, body, { who }), 403, "field_item_resolution_role_required");
  await expectError(await post(f, body, { csrf: false }), 403, "csrf_failed");
  await expectError(await post(f, body, { id: "manual-measurement:not-this-key" }),
    400, "invalid_field_item_resolution_request_id");
  await expectError(await post(f, { ...body, extra: true }), 400, "invalid_field_item_resolution");
  await expectError(await post(f, { ...body, payload_sha256: null }), 400, "invalid_field_item_resolution");
  await expectError(await post(f, { ...notArrived("fir-fleet-0009"), payload_sha256: HASH }),
    400, "invalid_field_item_resolution");
  await expectError(await post(f, { ...body, resolution: "maybe" }), 400, "invalid_field_item_resolution");
  await expectError(await post(f, { ...body, item_kind: "laundry" }), 400, "invalid_field_item_resolution");
  for (const inherited of ["constructor", "__proto__", "toString"]) {
    await expectError(await post(f, { ...body, item_kind: inherited }), 400, "invalid_field_item_resolution");
  }
  for (const kind of ["fleet_collision_report", "safety_corrective_evidence"])
    await expectError(await post(f, { ...body, item_kind: kind }), 422, "field_item_kind_unbound");
  await expectError(await post(f, arrived("fir-fleet-0404")), 404, "field_item_crew_write_not_found");
  await expectError(await post(f, arrived("fir-fleet-0003")), 409, "field_item_crew_write_unsettled");
  await expectError(await post(f, arrived("fir-fleet-0002", { payload_sha256: OTHER_HASH })),
    409, "field_item_payload_mismatch");
  await expectError(await post(f, arrived("fir-fleet-0002", {
    linked_record: { type: "field_action", id: "fir-fleet-0002" },
  })), 409, "field_item_linked_record_mismatch");
  await expectError(await post(f, arrived("fir-fleet-0002", {
    linked_record: { type: "fleet_asset_action", id: "fir-fleet-9999" },
  })), 409, "field_item_linked_record_mismatch");
  await expectError(await post(f, arrived("fir-fleet-0002", { crew_user_id: USERS.crewB.userId })),
    409, "field_item_crew_mismatch");
  await expectError(await post(f, arrived("fir-fleet-0002", { crew_user_id: USERS.owner.userId })),
    404, "field_item_crew_user_not_found");
  // The item kind is part of the binding: a pre-trip write is not a defect report.
  await expectError(await post(f, arrived("fir-fleet-0002", { item_kind: "fleet_defect_report" })),
    404, "field_item_crew_write_not_found");
  await expectError(await post(f, notArrived("fir-fleet-0002")), 409, "field_item_crew_write_exists");
  // A deactivated office user is no longer a person who can answer.
  f.db.raw.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.ops.userId);
  await expectError(await post(f, body), 403, "field_item_resolution_role_required");
  assert.equal(count(f, "SELECT COUNT(*) n FROM field_item_resolutions"), 0);
  assert.equal(count(f, "SELECT COUNT(*) n FROM audit_log WHERE automation = 'field_item_resolution'"), 0);
});

test("not_arrived requires no crew write in any store, is unique per item, and an arrival after the resend is a new answer", async () => {
  const f = setup();
  const created = await post(f, notArrived("fir-missing-0001"));
  const body = await created.json() as { resolution: { payload_sha256: unknown; linked_record: unknown } };
  assert.equal(created.status, 201, JSON.stringify(body));
  assert.equal(body.resolution.payload_sha256, null);
  assert.equal(body.resolution.linked_record, null);
  await expectError(await post(f, notArrived("fir-missing-0001")), 409, "field_item_already_resolved");

  // The phone resends once under the same key and the office now holds the write.
  seedFleet(f, "fir-missing-0001");
  assert.equal((await post(f, arrived("fir-missing-0001"))).status, 201);
  assert.equal(count(f, "SELECT COUNT(*) n FROM field_item_resolutions WHERE device_action_id = 'fir-missing-0001'"), 2);

  // A write under the same id in any other crew store still refuses "did not arrive".
  f.db.raw.prepare(
    `INSERT INTO field_actions (device_action_id, tenant_id, user_id, job_id, assignment_id,
       action_kind, payload_hash, status, checkin_id, created_at, updated_at)
     VALUES ('fir-checkin-0001', ?, ?, 'job-1', 'assign-1', 'field_checkin', ?, 'processing',
       'fci_000000000001', ?, ?)`,
  ).run(TENANT, USERS.crewA.userId, HASH, AT, AT);
  await expectError(await post(f, notArrived("fir-checkin-0001", "safety_action")),
    409, "field_item_crew_write_exists");
});

test("not_arrived is decided inside the insert, so a write that lands after the check wins", async () => {
  const f = setup();
  const original = f.db.batch.bind(f.db);
  f.db.batch = async (statements) => {
    seedFleet(f, "fir-race-0001");
    return await original(statements);
  };
  await expectError(await post(f, notArrived("fir-race-0001")), 409, "field_item_crew_write_exists");
  assert.equal(count(f, "SELECT COUNT(*) n FROM field_item_resolutions"), 0);
  assert.equal(count(f, "SELECT COUNT(*) n FROM audit_log WHERE automation = 'field_item_resolution'"), 0);
});

test("tenants are isolated on write and on read", async () => {
  const f = setup();
  seedFleet(f, "fir-other-0001", { tenant: OTHER, user: USERS.otherCrew.userId });
  await expectError(await post(f, arrived("fir-other-0001")), 404, "field_item_crew_write_not_found");
  await expectError(await post(f, arrived("fir-other-0001", { crew_user_id: USERS.otherCrew.userId })),
    404, "field_item_crew_user_not_found");
  // A session for another tenant than this deployment's is refused before anything is read.
  await expectError(await post(f, arrived("fir-other-0001"), { who: "otherOwner" }),
    403, "tenant_identity_required");
  await expectError(await get(f, ["fir-other-0001"], "otherCrew"), 403, "tenant_identity_required");
});

test("the crew read returns only the caller's own answers with a minimal link", async () => {
  const f = setup();
  seedFleet(f, "fir-read-0001");
  assert.equal((await post(f, arrived("fir-read-0001"))).status, 201);
  assert.equal((await post(f, notArrived("fir-read-0002"))).status, 201);
  const other = notArrived("fir-read-0003");
  assert.equal((await post(f, { ...other, crew_user_id: USERS.crewB.userId })).status, 201);

  const response = await get(f, ["fir-read-0001", "fir-read-0002", "fir-read-0003", "fir-read-0404"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const read = fieldItemResolutionsResponseSchema.parse(await response.json());
  assert.deepEqual(
    read.resolutions.map(({ device_action_id, resolution, linked_record }) =>
      ({ device_action_id, resolution, linked_record })),
    [
      { device_action_id: "fir-read-0001", resolution: "arrived",
        linked_record: { type: "fleet_asset_action", id: "fir-read-0001" } },
      { device_action_id: "fir-read-0002", resolution: "not_arrived", linked_record: null },
    ],
  );
  // Another crew member never sees these answers.
  const crewB = fieldItemResolutionsResponseSchema.parse(
    await (await get(f, ["fir-read-0001", "fir-read-0002", "fir-read-0003"], "crewB")).json());
  assert.deepEqual(crewB.resolutions.map((item) => item.device_action_id), ["fir-read-0003"]);

  for (const who of ["owner", "ops"] as const)
    await expectError(await get(f, ["fir-read-0001"], who), 403, "field_role_required");
  await expectError(await get(f, []), 400, "invalid_field_item_resolution_query");
  await expectError(await get(f, ["bad id"]), 400, "invalid_field_item_resolution_query");
  await expectError(await get(f, ["fir-read-0001"], "crewA", null, "&limit=5"),
    400, "invalid_field_item_resolution_query");
  await expectError(await get(f, Array.from({ length: 51 }, (_, i) => `fir-many-${String(i).padStart(4, "0")}`)),
    400, "invalid_field_item_resolution_query");
});

test("an inventory scan answer is visible to the person who captured it, never by device", async () => {
  const f = setup();
  f.db.raw.prepare(
    `INSERT INTO inventory_scans (scan_id, tenant_id, device_id, device_action_id, actor_user_id,
       barcode, scan_intent, request_fingerprint_sha256, observed_at, captured_offline, resolution,
       payload_json, created_at)
     VALUES ('scanfir0000001', ?, ?, 'fir-scan-0001', ?, 'BAR-0001', 'count', ?, ?, 1,
       'observed_pending_validation', '{}', ?)`,
  ).run(TENANT, DEVICE, USERS.crewA.userId, HASH, AT, AT);
  const created = await post(f, arrived("fir-scan-0001", {
    item_kind: "inventory_scan", linked_record: { type: "inventory_scan", id: "scanfir0000001" },
  }));
  assert.equal(created.status, 201, await created.clone().text());
  const own = fieldItemResolutionsResponseSchema.parse(
    await (await get(f, ["fir-scan-0001"], "crewA", "device-fir-0002")).json());
  assert.equal(own.resolutions.length, 1);
  // A scan's device id is client-supplied, so sharing it grants another person nothing.
  const sameDevice = fieldItemResolutionsResponseSchema.parse(
    await (await get(f, ["fir-scan-0001"], "crewB", DEVICE)).json());
  assert.equal(sameDevice.resolutions.length, 0);

  // One action id captured on two devices is not one exact item.
  f.db.raw.prepare(
    `INSERT INTO inventory_scans (scan_id, tenant_id, device_id, device_action_id, actor_user_id,
       barcode, scan_intent, request_fingerprint_sha256, observed_at, captured_offline, resolution,
       payload_json, created_at)
     VALUES ('scanfir0000002', ?, 'device-fir-0002', 'fir-scan-0002', ?, 'BAR-0001', 'count', ?, ?, 1,
       'observed_pending_validation', '{}', ?),
            ('scanfir0000003', ?, 'device-fir-0003', 'fir-scan-0002', ?, 'BAR-0001', 'count', ?, ?, 1,
       'observed_pending_validation', '{}', ?)`,
  ).run(TENANT, USERS.crewA.userId, HASH, AT, AT, TENANT, USERS.crewA.userId, HASH, AT, AT);
  await expectError(await post(f, arrived("fir-scan-0002", {
    item_kind: "inventory_scan", linked_record: { type: "inventory_scan", id: "scanfir0000002" },
  })), 409, "field_item_ambiguous");
});

test("each bound crew store resolves by its own key, stored hash and canonical record", async () => {
  const f = setup();
  const raw = f.db.raw;
  raw.prepare(
    `INSERT INTO field_actions (device_action_id, tenant_id, user_id, job_id, assignment_id,
       action_kind, payload_hash, status, checkin_id, response_json, created_at, updated_at, verified_at)
     VALUES ('fir-store-checkin', ?, ?, 'job-1', 'assign-1', 'field_checkin', ?, 'verified',
       'fci_000000000002', '{}', ?, ?, ?)`,
  ).run(TENANT, USERS.crewA.userId, HASH, AT, AT, AT);
  const workPackage = raw.prepare(
    `INSERT INTO field_work_package_actions (device_action_id, tenant_id, user_id, job_id,
       assignment_id, work_package_id, action_kind, payload_hash, status, response_json,
       created_at, updated_at, verified_at)
     VALUES (?, ?, ?, 'job-1', 'assign-1', 'WP-1', ?, ?, 'verified', '{}', ?, ?, ?)`,
  );
  workPackage.run("fir-store-ack", TENANT, USERS.crewA.userId, "acknowledge", HASH, AT, AT, AT);
  workPackage.run("fir-store-stop", TENANT, USERS.crewA.userId, "stop_work", HASH, AT, AT, AT);
  seedFleet(f, "fir-store-post", { kind: "post_trip_inspection" });
  seedFleet(f, "fir-store-defect", { kind: "defect_report" });
  raw.prepare(
    `INSERT INTO safety_device_actions (device_action_id, tenant_id, user_id, action_kind,
       scope_type, scope_id, payload_hash, status, response_json, captured_at, created_at,
       updated_at, verified_at)
     VALUES ('fir-store-safety', ?, ?, 'report_occurrence', 'tenant', 'ironwrap', ?, 'verified',
       '{}', ?, ?, ?, ?)`,
  ).run(TENANT, USERS.crewA.userId, HASH, AT, AT, AT, AT);
  const cases = [
    ["fir-store-checkin", "field_checkin", "field_action", "fir-store-checkin"],
    ["fir-store-ack", "work_package_acknowledgement", "work_package_action", "fir-store-ack"],
    ["fir-store-stop", "work_package_stop", "work_package_action", "fir-store-stop"],
    ["fir-store-post", "fleet_post_trip_inspection", "fleet_asset_action", "fir-store-post"],
    ["fir-store-defect", "fleet_defect_report", "fleet_asset_action", "fir-store-defect"],
    ["fir-store-safety", "safety_action", "safety_device_action", "fir-store-safety"],
  ] as const;
  // A swapped kind never finds another store's write.
  await expectError(await post(f, arrived("fir-store-ack", {
    item_kind: "work_package_stop", linked_record: { type: "work_package_action", id: "fir-store-ack" },
  })), 404, "field_item_crew_write_not_found");
  for (const [deviceActionId, itemKind, type, id] of cases) {
    const input = arrived(deviceActionId, { item_kind: itemKind, linked_record: { type, id } });
    await expectError(await post(f, { ...input, payload_sha256: OTHER_HASH }), 409, "field_item_payload_mismatch");
    const response = await post(f, { ...input, resolution: "duplicate" });
    assert.equal(response.status, 201, `${itemKind}: ${await response.clone().text()}`);
  }
  // Commands and configured values are looked up by their stored idempotency hashes.
  for (const [itemKind, type] of [
    ["inventory_command", "inventory_command"],
    ["schema_field_value", "schema_field_value_revision"],
  ] as const)
    await expectError(await post(f, arrived("fir-store-none", {
      item_kind: itemKind, linked_record: { type, id: "fir-store-none" },
    })), 404, "field_item_crew_write_not_found");
});

test("only a person answers; an AI field coordinator may attach its proposal for that person to confirm", async () => {
  const f = setup();
  seedFleet(f, "fir-ai-0001");
  const input = arrived("fir-ai-0001");
  for (const kind of ["agent", "service", "effect_runtime", "mcp"] as const)
    await assert.rejects(
      recordFieldItemResolution(f.env, { kind, tenantId: TENANT, id: "field_safety" }, key(), input),
      { code: "person_session_required", status: 403 },
    );
  await expectError(await post(f, input, { headers: { authorization: "Bearer agent-host-token" } }),
    403, "person_session_required");
  await expectError(await post(f, input, { headers: { "x-ironwrap-hermes-api-audience": "https://app.example.invalid" } }),
    403, "person_session_required");
  await expectError(await post(f, { ...input, ai_proposal: { agent_id: "estimator", evidence_id: "step-fir-0001" } }),
    403, "ai_proposal_agent_refused");
  await expectError(await post(f, { ...input, ai_proposal: { agent_id: "field_safety", evidence_id: "step-fir-0404" } }),
    422, "ai_proposal_not_found");

  // A recorded field-coordinator proposal for this exact answer.
  const json = (value: unknown) => JSON.stringify(value);
  f.db.raw.prepare(
    `INSERT INTO agent_signals (signal_id, tenant_id, kind, specialist_id, source, content_json,
       content_sha256, dedupe_key, received_at)
     VALUES ('sig-fir-0001', ?, 'event', 'field_safety', 'test', '{}', ?, 'fir-0001', ?)`,
  ).run(TENANT, await sha256Hex("{}"), AT);
  f.db.raw.prepare(
    `INSERT INTO agent_runs (run_id, tenant_id, specialist_id, signal_id, host_run_key, goal,
       trigger_json, context_json, context_snapshot_hash, tool_manifest_json, tool_manifest_hash,
       catalog_version, policy_version, correlation_id, state, attempt_started_at, started_at)
     VALUES ('run-fir-0001', ?, 'field_safety', 'sig-fir-0001', 'host-fir-0001', 'resolve item',
       '{}', '{}', ?, '[]', ?, 'test', 'test', 'corr-fir-0001', 'open', ?, ?)`,
  ).run(TENANT, HASH, HASH, AT, AT);
  const step = f.db.raw.prepare(
    `INSERT INTO agent_run_steps (step_id, tenant_id, run_id, step_seq, step_key, specialist_id,
       action_id, autonomy, args_json, args_sha256, sources_json, policy_json, permit_json,
       undo_json, do_it_myself_json, created_at)
     VALUES (?, ?, 'run-fir-0001', ?, ?, 'field_safety', ?, 'A2', ?, ?, '[]', '{}', '{}', '{}', '{}', ?)`,
  );
  step.run("step-fir-0001", TENANT, 1, "k1", FIELD_ITEM_PROPOSAL_ACTION,
    json({ device_action_id: "fir-ai-0001", resolution: "arrived" }), HASH, AT);
  step.run("step-fir-0002", TENANT, 2, "k2", FIELD_ITEM_PROPOSAL_ACTION,
    json({ device_action_id: "fir-other-item", resolution: "arrived" }), HASH, AT);
  step.run("step-fir-0003", TENANT, 3, "k3", "note.add",
    json({ device_action_id: "fir-ai-0001", resolution: "arrived" }), HASH, AT);
  // A proposal about another item, or another action, is not a proposal for this answer.
  for (const evidence of ["step-fir-0002", "step-fir-0003"])
    await expectError(await post(f, { ...input, ai_proposal: { agent_id: "field_safety", evidence_id: evidence } }),
      422, "ai_proposal_not_found");

  const confirmed = await post(f, { ...input, ai_proposal: { agent_id: "field_safety", evidence_id: "step-fir-0001" } });
  const body = await confirmed.json() as { resolution: { resolved_by: unknown; ai_proposal: unknown } };
  assert.equal(confirmed.status, 201, JSON.stringify(body));
  assert.deepEqual(body.resolution.resolved_by, { user_id: USERS.ops.userId, role: "ops" });
  assert.deepEqual(body.resolution.ai_proposal, { agent_id: "field_safety", evidence_id: "step-fir-0001" });
  assert.deepEqual(
    { ...f.db.raw.prepare("SELECT trigger, approved_by, reason FROM audit_log WHERE automation = 'field_item_resolution'").get() },
    { trigger: "office_confirmed_ai_proposal", approved_by: USERS.ops.userId, reason: "field_safety:step-fir-0001" },
  );
});

test("the ledger is append-only, tenant-bound and person-resolved at the database", async () => {
  const f = setup();
  seedFleet(f, "fir-db-0001");
  assert.equal((await post(f, arrived("fir-db-0001"))).status, 201);
  const raw = f.db.raw;
  const row = raw.prepare("SELECT * FROM field_item_resolutions").get() as Record<string, unknown>;
  const columns = Object.keys(row);
  const insert = (values: Record<string, unknown>, verb = "INSERT") =>
    raw.prepare(`${verb} INTO field_item_resolutions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...(columns.map((column) => values[column]) as never[]));
  const fresh = (overrides: Record<string, unknown> = {}) => ({
    ...row,
    resolution_id: `fir_${"c".repeat(64)}`,
    request_id: `field-item-resolution:${crypto.randomUUID()}`,
    device_action_id: "fir-db-0002",
    ...overrides,
  });
  assert.throws(() => raw.prepare("UPDATE field_item_resolutions SET resolution = 'duplicate'").run(),
    /field_item_resolution_immutable/);
  assert.throws(() => raw.prepare("DELETE FROM field_item_resolutions").run(), /field_item_resolution_immutable/);
  assert.throws(() => insert(row, "INSERT OR REPLACE"), /field_item_resolution_immutable/);
  assert.throws(() => insert(fresh({ device_action_id: "fir-db-0001" }), "INSERT OR REPLACE"),
    /field_item_resolution_immutable/);
  assert.throws(() => insert(fresh({ resolved_by_user_id: USERS.crewA.userId, resolved_by_role: "ops" })),
    /field_item_resolution_person_required/);
  assert.throws(() => insert(fresh({ resolved_by_role: "owner" })), /field_item_resolution_person_required/);
  assert.throws(() => insert(fresh({ resolved_by_user_id: USERS.otherOwner.userId, resolved_by_role: "owner" })),
    /field_item_resolution_person_required/);
  assert.throws(() => insert(fresh({ crew_user_id: USERS.owner.userId })), /field_item_resolution_crew_required/);
  assert.throws(() => insert(fresh({ crew_user_id: USERS.otherCrew.userId })), /field_item_resolution_crew_required/);
  assert.throws(() => insert(fresh({ resolution: "not_arrived" })), /CHECK constraint failed/);
  assert.throws(() => insert(fresh({ proposed_by_agent_id: "estimator", proposal_evidence_id: "step-fir-0001" })),
    /CHECK constraint failed/);
  assert.throws(() => insert(fresh({ proposed_by_agent_id: "field_safety" })), /CHECK constraint failed/);
  assert.equal(count(f, "SELECT COUNT(*) n FROM field_item_resolutions"), 1);
});
