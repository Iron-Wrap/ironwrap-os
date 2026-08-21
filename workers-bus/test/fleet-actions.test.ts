import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  d1FleetActionWriter,
  d1FleetActionStore,
  parseFleetActionRequest,
  processFleetAction,
  type FleetActionWriter,
  type FleetActionStore,
  type PersistFleetActionInput,
  type ProcessFleetActionDependencies,
  type VerifiedFleetActionResponse,
} from "../src/fleet-actions.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";
import {
  FieldActionError,
  type ImmutableObjectStore,
} from "../src/field-actions.ts";

class MemoryStore implements FleetActionStore {
  readonly actions = new Map<
    string,
    {
      tenantId: string;
      userId: string;
      fleetAssetId: string;
      kind: string;
      payloadHash: string;
      response?: VerifiedFleetActionResponse;
      state: "processing" | "retryable_error" | "verified";
    }
  >();
  completed = 0;
  failed = 0;
  claims = 0;

  async find(
    input: Parameters<FleetActionStore["find"]>[0],
  ): ReturnType<FleetActionStore["find"]> {
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) return null;
    if (!this.matches(existing, input)) return { state: "mismatch" };
    return existing.state === "verified" && existing.response
      ? { state: "verified", response: existing.response }
      : { state: "matching" };
  }

  async claim(
    input: Parameters<FleetActionStore["claim"]>[0],
  ): ReturnType<FleetActionStore["claim"]> {
    this.claims += 1;
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) {
      this.actions.set(input.deviceActionId, {
        tenantId: input.tenantId,
        userId: input.userId,
        fleetAssetId: input.fleetAssetId,
        kind: input.kind,
        payloadHash: input.payloadHash,
        state: "processing",
      });
      return { state: "acquired" };
    }
    if (!this.matches(existing, input)) return { state: "conflict" };
    if (existing.state === "verified" && existing.response) {
      return { state: "verified", response: existing.response };
    }
    existing.state = "processing";
    return { state: "acquired" };
  }

  async renew(_tenantId: string, deviceActionId: string): Promise<boolean> {
    return this.actions.get(deviceActionId)?.state !== "verified";
  }

  async markR2Stored(): Promise<void> {}

  async complete(
    _tenantId: string,
    deviceActionId: string,
    _token: string,
    response: VerifiedFleetActionResponse,
  ): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (!action) throw new Error("missing_action");
    action.state = "verified";
    action.response = response;
    this.completed += 1;
  }

  async fail(_tenantId: string, deviceActionId: string): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (action && action.state !== "verified") action.state = "retryable_error";
    this.failed += 1;
  }

  private matches(
    existing: {
      tenantId: string;
      userId: string;
      fleetAssetId: string;
      kind: string;
      payloadHash: string;
    },
    input: {
      tenantId: string;
      userId: string;
      fleetAssetId: string;
      kind: string;
      payloadHash: string;
    },
  ): boolean {
    return (
      existing.tenantId === input.tenantId &&
      existing.userId === input.userId &&
      existing.fleetAssetId === input.fleetAssetId &&
      existing.kind === input.kind &&
      existing.payloadHash === input.payloadHash
    );
  }
}

class MemoryObjects implements ImmutableObjectStore {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, string>();

  async ensure(key: string, body: Blob | string): Promise<void> {
    this.calls.push(key);
    if (typeof body === "string") this.bodies.set(key, body);
  }
}

class MemoryWriter implements FleetActionWriter {
  readonly calls: PersistFleetActionInput[] = [];
  failOnce = false;

  async persistAction(
    input: PersistFleetActionInput,
  ): Promise<{ recordName: string; assetName: string }> {
    this.calls.push(input);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("fleet_native_write_failed");
    }
    return {
      recordName: `REC-${input.deviceActionId}`,
      assetName: `ASSET-${input.fleetAssetId}`,
    };
  }
}

function auth(
  role: "field" | "owner" = "field",
  frappeUser: string | null = "driver@example.invalid",
): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: [],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-07-11T06:00:00.000Z",
      session_expires_at: "2026-07-12T06:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: frappeUser,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: "2026-07-11T06:00:00.000Z",
      updated_at: "2026-07-11T06:00:00.000Z",
    },
  };
}

function inspectionBody(overrides: Record<string, unknown> = {}) {
  return {
    device_action_id: "device-fleet-0001",
    payload: {
      fleet_asset_id: "asset-truck-1",
      performed_at: "2026-07-11T06:30:00.000Z",
      meter_reading: 142000,
      items: [
        { sequence: 1, check_point: "Brakes", result: "Pass" },
        { sequence: 2, check_point: "Lights", result: "Pass" },
      ],
      ...overrides,
    },
  };
}

function inspectionRequest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(
    "https://app.example.invalid/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": "device-fleet-0001",
        "idempotency-key": "device-fleet-0001",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    deviceActionId: "device-fleet-0001",
    fleetAssetId: "asset-truck-1",
    kind: "pre_trip_inspection" as const,
    payload: {
      fleet_asset_id: "asset-truck-1",
      performed_at: "2026-07-11T06:30:00.000Z",
      items: [
        {
          sequence: 1,
          check_point: "Brakes",
          result: "Pass",
          severity: "None",
        },
        {
          sequence: 2,
          check_point: "Lights",
          result: "Pass",
          severity: "None",
        },
      ],
      meter_reading: 142000,
      ...overrides,
    },
  };
}

function dependencies(
  store = new MemoryStore(),
  objects = new MemoryObjects(),
  writer = new MemoryWriter(),
): {
  store: MemoryStore;
  objects: MemoryObjects;
  writer: MemoryWriter;
  dependency: ProcessFleetActionDependencies;
} {
  return {
    store,
    objects,
    writer,
    dependency: {
      store,
      objects,
      writer,
      now: () => new Date("2026-07-11T06:31:00.000Z"),
      randomId: () => "lease-token",
    },
  };
}

test("the pre-trip envelope accepts only a complete, bounded capture", async () => {
  assert.deepEqual(
    await parseFleetActionRequest(
      inspectionRequest(inspectionBody()),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    submission(),
  );

  const rejected: Array<[string, unknown]> = [
    ["an unknown payload key", inspectionBody({ odometer: 1 })],
    [
      "a mismatched asset id",
      inspectionBody({ fleet_asset_id: "asset-truck-9" }),
    ],
    ["an empty check-point list", inspectionBody({ items: [] })],
    [
      "a non-contiguous check-point sequence",
      inspectionBody({
        items: [{ sequence: 2, check_point: "Brakes", result: "Pass" }],
      }),
    ],
    [
      "an unsupported check-point result",
      inspectionBody({
        items: [{ sequence: 1, check_point: "Brakes", result: "Maybe" }],
      }),
    ],
    ["a negative meter reading", inspectionBody({ meter_reading: -1 })],
    [
      "a meter reading beyond thousandth precision",
      inspectionBody({ meter_reading: 1.0001 }),
    ],
    [
      "a non-UTC capture timestamp",
      inspectionBody({ performed_at: "2026-07-11 06:30:00" }),
    ],
  ];
  for (const [label, body] of rejected) {
    await assert.rejects(
      parseFleetActionRequest(
        inspectionRequest(body),
        "asset-truck-1",
        "pre_trip_inspection",
      ),
      (error: unknown) =>
        error instanceof FieldActionError &&
        error.code === "invalid_fleet_action",
      label,
    );
  }
});

test("a failed check point must carry a severity the device cannot omit", async () => {
  await assert.rejects(
    parseFleetActionRequest(
      inspectionRequest(
        inspectionBody({
          items: [{ sequence: 1, check_point: "Brakes", result: "Fail" }],
        }),
      ),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_fleet_action",
  );
  await assert.rejects(
    parseFleetActionRequest(
      inspectionRequest(
        inspectionBody({
          items: [
            {
              sequence: 1,
              check_point: "Brakes",
              result: "Pass",
              severity: "Major",
            },
          ],
        }),
      ),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_fleet_action",
  );
  const parsed = await parseFleetActionRequest(
    inspectionRequest(
      inspectionBody({
        items: [
          {
            sequence: 1,
            check_point: "Brakes",
            result: "Fail",
            severity: "Out of Service",
            observation: "Air leak at the rear chamber.",
          },
        ],
      }),
    ),
    "asset-truck-1",
    "pre_trip_inspection",
  );
  assert.equal(parsed.payload.items?.[0]?.severity, "Out of Service");
});

test("a mismatched device action header is rejected before any store write", async () => {
  await assert.rejects(
    parseFleetActionRequest(
      inspectionRequest(inspectionBody(), {
        "x-device-action-id": "device-fleet-0002",
      }),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_fleet_action",
  );
});

test("a verified pre-trip capture stores its manifest and one native authority command", async () => {
  const { store, objects, writer, dependency } = dependencies();
  const response = await processFleetAction(submission(), auth(), dependency);

  assert.deepEqual(response, {
    device_action_id: "device-fleet-0001",
    status: "verified",
    server_ref: "REC-device-fleet-0001",
    cursor: "ASSET-asset-truck-1",
  });
  assert.equal(objects.calls.length, 1);
  assert.match(
    objects.calls[0]!,
    /^fleet\/v1\/[0-9a-f]{24}\/pre_trip_inspection\/device-fleet-0001\/manifest\.json$/,
  );
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0]!.actorUserId, "appu_field");
  assert.equal(writer.calls[0]!.tenantId, "ironwrap");
  assert.match(writer.calls[0]!.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(writer.calls[0]!.manifestKey, objects.calls[0]);
  assert.equal(store.completed, 1);

  const manifest = JSON.parse(objects.bodies.get(objects.calls[0]!)!) as Record<
    string,
    unknown
  >;
  assert.equal(manifest.tenant_id, "ironwrap");
  assert.equal(manifest.actor_user_id, "appu_field");
  assert.equal(manifest.action_kind, "pre_trip_inspection");
  assert.equal(manifest.device_action_id, "device-fleet-0001");
});

test("the native writer scales meters and derives the inspection verdict", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                return null;
              },
              async run() {
                statements.push({ sql: normalized, values });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const payloadHash = "b".repeat(64);
  const result = await d1FleetActionWriter(env).persistAction({
    kind: "pre_trip_inspection",
    tenantId: "ironwrap",
    fleetAssetId: "asset-truck-1",
    actorUserId: "appu_field",
    deviceActionId: "device-fleet-0001",
    manifestKey: "fleet/v1/key/manifest.json",
    payloadHash,
    recordedAt: "2026-07-11T06:31:00.000Z",
    payload: {
      fleet_asset_id: "asset-truck-1",
      performed_at: "2026-07-11T06:30:00.000Z",
      meter_reading: 142000.125,
      items: [
        {
          sequence: 1,
          check_point: "Marker light",
          result: "Fail",
          severity: "Minor",
        },
      ],
    },
  });

  assert.deepEqual(result, {
    recordName: "inspection:device-fleet-0001",
    assetName: "asset-truck-1",
  });
  const insert = statements.find((entry) =>
    entry.sql.startsWith("INSERT INTO fleet_inspections"),
  );
  assert.ok(insert);
  assert.equal(insert.values[7], 142000125);
  assert.equal(insert.values[10], "Pass With Defects");
  assert.equal(insert.values[11], 1);
  assert.equal(insert.values[12], 0);
  assert.equal(insert.values[13], "2026-07-12");
  assert.equal(insert.values[15], payloadHash);
});

test("a lost-connectivity replay returns the first verified receipt without a second write", async () => {
  const { store, objects, writer, dependency } = dependencies();
  const first = await processFleetAction(submission(), auth(), dependency);
  const replay = await processFleetAction(submission(), auth(), dependency);

  assert.deepEqual(replay, first);
  assert.equal(
    writer.calls.length,
    1,
    "the replay must not issue a second authority command",
  );
  assert.equal(objects.calls.length, 1);
  assert.equal(store.completed, 1);
  assert.equal(
    store.claims,
    1,
    "a verified receipt short-circuits before the claim",
  );
});

test("a duplicate scan of the same device action id with different facts is a conflict", async () => {
  const { writer, dependency } = dependencies();
  await processFleetAction(submission(), auth(), dependency);

  await assert.rejects(
    processFleetAction(
      submission({ meter_reading: 142500 }),
      auth(),
      dependency,
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict" &&
      error.status === 409,
  );
  assert.equal(writer.calls.length, 1);
});

test("a failed native command leaves the capture retryable and then verifies on replay", async () => {
  const { store, writer, dependency } = dependencies();
  writer.failOnce = true;

  await assert.rejects(
    processFleetAction(submission(), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError && error.status === 502,
  );
  assert.equal(store.failed, 1);
  assert.equal(store.completed, 0);

  const recovered = await processFleetAction(submission(), auth(), dependency);
  assert.equal(recovered.status, "verified");
  assert.equal(writer.calls.length, 2);
  assert.equal(store.completed, 1);
});

test("a native field identity submits without a Frappe link, while office roles stay denied", async () => {
  const { writer, dependency } = dependencies();
  await assert.rejects(
    processFleetAction(submission(), auth("owner"), dependency),
    (error: unknown) =>
      error instanceof FieldActionError && error.code === "field_role_required",
  );
  assert.equal(writer.calls.length, 0);
  assert.equal(
    (await processFleetAction(submission(), auth("field", null), dependency))
      .status,
    "verified",
  );
  assert.equal(writer.calls[0]!.actorUserId, "appu_field");
});

test("telematics travels as supporting evidence and never as the inspector", async () => {
  const parsed = await parseFleetActionRequest(
    inspectionRequest(
      inspectionBody({ telematics_reference: "samsara:trip-9" }),
    ),
    "asset-truck-1",
    "pre_trip_inspection",
  );
  assert.equal(parsed.payload.telematics_reference, "samsara:trip-9");

  const { writer, dependency } = dependencies();
  await processFleetAction(parsed, auth(), dependency);
  // The Worker carries the reference through but the actor stays the
  // authenticated physical inspector; the D1 trigger rejects any other combination.
  assert.equal(writer.calls[0]!.actorUserId, "appu_field");
  assert.equal(writer.calls[0]!.kind, "pre_trip_inspection");
});

test("a defect report carries its own bounded envelope", async () => {
  const request = new Request(
    "https://app.example.invalid/api/v1/fleet/assets/asset-truck-1/defects",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": "device-fleet-0002",
      },
      body: JSON.stringify({
        device_action_id: "device-fleet-0002",
        payload: {
          fleet_asset_id: "asset-truck-1",
          detected_at: "2026-07-11T06:35:00.000Z",
          severity: "Out of Service",
          description: "Air brake chamber leaking.",
          asset_inspection_id: "inspection-1",
        },
      }),
    },
  );
  assert.deepEqual(
    await parseFleetActionRequest(request, "asset-truck-1", "defect_report"),
    {
      deviceActionId: "device-fleet-0002",
      fleetAssetId: "asset-truck-1",
      kind: "defect_report",
      payload: {
        fleet_asset_id: "asset-truck-1",
        detected_at: "2026-07-11T06:35:00.000Z",
        severity: "Out of Service",
        description: "Air brake chamber leaking.",
        asset_inspection_id: "inspection-1",
      },
    },
  );

  const badSeverity = new Request(
    "https://app.example.invalid/api/v1/fleet/assets/asset-truck-1/defects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_action_id: "device-fleet-0003",
        payload: {
          fleet_asset_id: "asset-truck-1",
          detected_at: "2026-07-11T06:35:00.000Z",
          severity: "Cosmetic",
          description: "Scratched paint.",
        },
      }),
    },
  );
  await assert.rejects(
    parseFleetActionRequest(badSeverity, "asset-truck-1", "defect_report"),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_fleet_action",
  );
});

test("an oversized capture is rejected before it is parsed", async () => {
  const request = new Request(
    "https://app.example.invalid/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024),
      },
      body: JSON.stringify(inspectionBody()),
    },
  );
  await assert.rejects(
    parseFleetActionRequest(request, "asset-truck-1", "pre_trip_inspection"),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "fleet_action_too_large" &&
      error.status === 413,
  );
});

function fleetRouteEnv(options: { authorized?: boolean } = {}): {
  env: AppEnv;
  statements: string[];
  throttleAttempts: () => number;
} {
  let attempts = 0;
  const statements: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
              async first() {
                if (normalized.includes("app_action_throttles")) {
                  attempts += 1;
                  return {
                    attempts,
                    window_expires_at: "2026-07-11T06:32:00.000Z",
                  };
                }
                if (normalized.includes("FROM fleet_assets asset")) {
                  return options.authorized
                    ? {
                        fleet_asset_id: "asset-truck-1",
                        tenant_id: "ironwrap",
                      }
                    : null;
                }
                return null;
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  return { env, statements, throttleAttempts: () => attempts };
}

function captureRequest(
  path = "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
) {
  return new Request(`https://app.example.invalid${path}`, {
    method: "POST",
    headers: {
      "x-csrf-token": "csrf",
      "content-type": "application/json",
      "x-device-action-id": "device-fleet-0001",
      "idempotency-key": "device-fleet-0001",
    },
    body: JSON.stringify(inspectionBody()),
  });
}

test("a field user with no relationship to an asset is refused before any evidence write", async () => {
  const { env, statements } = fleetRouteEnv();
  const response = await handleAuthenticatedRoute(
    captureRequest(),
    env,
    auth("field"),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(
    statements.some((sql) => sql.includes("FROM fleet_assets asset")),
    true,
    "the refusal must come from the native relationship query",
  );
  assert.equal(
    statements.some((sql) => sql.includes("fleet_asset_actions")),
    false,
    "a refused capture must never claim an action row",
  );
});

test("an unknown asset is refused exactly like an unrelated one", async () => {
  const { env } = fleetRouteEnv();
  const response = await handleAuthenticatedRoute(
    captureRequest(),
    env,
    auth("field"),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("native custody, crew, and open-load relationships gate the capture rail", async () => {
  const { env, statements } = fleetRouteEnv({ authorized: true });
  const response = await handleAuthenticatedRoute(
    captureRequest(),
    env,
    auth("field"),
  );
  assert.notEqual(response.status, 404);
  assert.notEqual(response.status, 403);
  const relationshipQuery = statements.find((sql) =>
    sql.includes("FROM fleet_assets asset"),
  );
  assert.ok(relationshipQuery);
  assert.match(relationshipQuery, /custody_user_id/);
  assert.match(relationshipQuery, /fleet_crew_members/);
  assert.match(relationshipQuery, /fleet_crews/);
  assert.match(relationshipQuery, /crew\.status = 'Active'/);
  assert.match(relationshipQuery, /fleet_cargo_loads/);
  assert.match(relationshipQuery, /fleet_driver_authorities/);
  assert.match(
    relationshipQuery,
    /load\.status IN \('Loaded', 'In Transit', 'Delivered'\)/,
  );
  assert.match(relationshipQuery, /authority\.user_id = load\.driver_user_id/);
  assert.match(relationshipQuery, /authority\.status = 'Active'/);
  assert.match(relationshipQuery, /authority\.authority_source = 'Physical Document'/);
  assert.ok(
    statements.some((sql) => sql.includes("fleet_asset_actions")),
    "an authorized native relationship must reach the capture rail",
  );
});

test("fleet captures share the bounded field upload window", async () => {
  const { env, throttleAttempts } = fleetRouteEnv({ authorized: true });
  for (let index = 0; index < 8; index += 1) {
    const allowed = await handleAuthenticatedRoute(
      captureRequest(),
      env,
      auth("field"),
    );
    assert.notEqual(allowed.status, 429);
  }
  const limited = await handleAuthenticatedRoute(
    captureRequest(),
    env,
    auth("field"),
  );
  assert.equal(limited.status, 429);
  assert.equal(
    ((await limited.json()) as { error: string }).error,
    "field_upload_rate_limited",
  );
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  assert.equal(throttleAttempts(), 9);
});

test("the evidence status write is lease-guarded like every other fleet action write", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...values: unknown[]) {
            statements.push({ sql: normalized, values });
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  await d1FleetActionStore(env).markR2Stored(
    "ironwrap",
    "device-fleet-0001",
    "lease-token",
    "fleet/v1/key",
    "2026-07-11T06:31:00.000Z",
  );
  const update = statements.find((entry) =>
    entry.sql.includes("status = 'r2_stored'"),
  );
  assert.ok(update, "the evidence status write must exist");
  // A superseded worker must not write r2_stored over the row its successor
  // now owns, so this statement matches on the lease token like renew/complete.
  assert.match(update!.sql, /processing_token = \?/);
  assert.match(update!.sql, /tenant_id = \?/);
  assert.ok(update!.values.includes("lease-token"));
});

test("native fleet action lookup scopes the idempotency row by tenant", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...values: unknown[]) {
            statements.push({ sql: normalized, values });
            return {
              async first() {
                return null;
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const store = d1FleetActionStore(env);
  const result = await store.find({
    deviceActionId: "device-fleet-tenant-scope",
    tenantId: "tenant-b",
    userId: "appu_field_b",
    fleetAssetId: "asset-truck-b",
    kind: "pre_trip_inspection",
    payloadHash: "b".repeat(64),
  } as Parameters<FleetActionStore["find"]>[0]);
  assert.equal(result, null);
  assert.equal(statements.length, 1);
  assert.match(
    statements[0]!.sql,
    /FROM fleet_asset_actions WHERE tenant_id = \? AND device_action_id = \?/,
  );
  assert.deepEqual(statements[0]!.values, [
    "tenant-b",
    "device-fleet-tenant-scope",
  ]);
});

test("every fleet route refuses office roles and bad CSRF before any mutation", async () => {
  let databaseCalls = 0;
  const appEnv = {
    DB: {
      prepare() {
        databaseCalls += 1;
        throw new Error("a refused route must not query D1");
      },
    },
  } as AppEnv;
  const paths = [
    "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    "/api/v1/fleet/assets/asset-truck-1/post-trip-inspections",
    "/api/v1/fleet/assets/asset-truck-1/defects",
  ];
  for (const path of paths) {
    const request = (csrf: string) =>
      new Request(`https://app.example.invalid${path}`, {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify(inspectionBody()),
      });
    assert.equal(
      (await handleAuthenticatedRoute(request("csrf"), appEnv, auth("owner")))
        .status,
      403,
      `${path} must refuse an office role`,
    );
    assert.equal(
      (await handleAuthenticatedRoute(request("wrong"), appEnv, auth("field")))
        .status,
      403,
      `${path} must refuse a mismatched CSRF token`,
    );
  }
  assert.equal(databaseCalls, 0, "a refused route must never reach D1");
});
