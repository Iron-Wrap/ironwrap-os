import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  d1FleetActionStore,
  frappeFleetWriter,
  parseFleetActionRequest,
  processFleetAction,
  type FleetActionStore,
  type FleetFrappeWriter,
  type PersistFleetActionInput,
  type ProcessFleetActionDependencies,
  type VerifiedFleetActionResponse,
} from "../src/fleet-actions.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";
import { FieldActionError, type ImmutableObjectStore } from "../src/field-actions.ts";

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

  async renew(deviceActionId: string): Promise<boolean> {
    return this.actions.get(deviceActionId)?.state !== "verified";
  }

  async markR2Stored(): Promise<void> {}

  async complete(
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

  async fail(deviceActionId: string): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (action && action.state !== "verified") action.state = "retryable_error";
    this.failed += 1;
  }

  private matches(
    existing: { tenantId: string; userId: string; fleetAssetId: string; kind: string; payloadHash: string },
    input: { tenantId: string; userId: string; fleetAssetId: string; kind: string; payloadHash: string },
  ): boolean {
    return existing.tenantId === input.tenantId &&
      existing.userId === input.userId &&
      existing.fleetAssetId === input.fleetAssetId &&
      existing.kind === input.kind &&
      existing.payloadHash === input.payloadHash;
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

class MemoryFrappe implements FleetFrappeWriter {
  readonly calls: PersistFleetActionInput[] = [];
  failOnce = false;

  async persistAction(
    input: PersistFleetActionInput,
  ): Promise<{ recordName: string; assetName: string }> {
    this.calls.push(input);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("fleet_frappe_network_error");
    }
    return {
      recordName: `REC-${input.deviceActionId}`,
      assetName: `ASSET-${input.fleetAssetId}`,
    };
  }
}

function auth(role: "field" | "owner" = "field", frappeUser: string | null = "driver@example.invalid"): AuthContext {
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

function inspectionRequest(body: unknown, headers: Record<string, string> = {}) {
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
        { sequence: 1, check_point: "Brakes", result: "Pass", severity: "None" },
        { sequence: 2, check_point: "Lights", result: "Pass", severity: "None" },
      ],
      meter_reading: 142000,
      ...overrides,
    },
  };
}

function dependencies(
  store = new MemoryStore(),
  objects = new MemoryObjects(),
  frappe = new MemoryFrappe(),
): {
  store: MemoryStore;
  objects: MemoryObjects;
  frappe: MemoryFrappe;
  dependency: ProcessFleetActionDependencies;
} {
  return {
    store,
    objects,
    frappe,
    dependency: {
      store,
      objects,
      frappe,
      now: () => new Date("2026-07-11T06:31:00.000Z"),
      randomId: () => "lease-token",
    },
  };
}

test("the pre-trip envelope accepts only a complete, bounded capture", async () => {
  assert.deepEqual(
    await parseFleetActionRequest(inspectionRequest(inspectionBody()), "asset-truck-1", "pre_trip_inspection"),
    submission(),
  );

  const rejected: Array<[string, unknown]> = [
    ["an unknown payload key", inspectionBody({ odometer: 1 })],
    ["a mismatched asset id", inspectionBody({ fleet_asset_id: "asset-truck-9" })],
    ["an empty check-point list", inspectionBody({ items: [] })],
    [
      "a non-contiguous check-point sequence",
      inspectionBody({ items: [{ sequence: 2, check_point: "Brakes", result: "Pass" }] }),
    ],
    [
      "an unsupported check-point result",
      inspectionBody({ items: [{ sequence: 1, check_point: "Brakes", result: "Maybe" }] }),
    ],
    ["a negative meter reading", inspectionBody({ meter_reading: -1 })],
    ["a non-UTC capture timestamp", inspectionBody({ performed_at: "2026-07-11 06:30:00" })],
  ];
  for (const [label, body] of rejected) {
    await assert.rejects(
      parseFleetActionRequest(inspectionRequest(body), "asset-truck-1", "pre_trip_inspection"),
      (error: unknown) =>
        error instanceof FieldActionError && error.code === "invalid_fleet_action",
      label,
    );
  }
});

test("a failed check point must carry a severity the device cannot omit", async () => {
  await assert.rejects(
    parseFleetActionRequest(
      inspectionRequest(
        inspectionBody({ items: [{ sequence: 1, check_point: "Brakes", result: "Fail" }] }),
      ),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
  );
  await assert.rejects(
    parseFleetActionRequest(
      inspectionRequest(
        inspectionBody({
          items: [{ sequence: 1, check_point: "Brakes", result: "Pass", severity: "Major" }],
        }),
      ),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
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
      inspectionRequest(inspectionBody(), { "x-device-action-id": "device-fleet-0002" }),
      "asset-truck-1",
      "pre_trip_inspection",
    ),
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
  );
});

test("a verified pre-trip capture stores its manifest and one Frappe command", async () => {
  const { store, objects, frappe, dependency } = dependencies();
  const response = await processFleetAction(submission(), auth(), dependency);

  assert.deepEqual(response, {
    device_action_id: "device-fleet-0001",
    status: "verified",
    server_ref: "REC-device-fleet-0001",
    cursor: "ASSET-asset-truck-1",
  });
  assert.equal(objects.calls.length, 1);
  assert.match(objects.calls[0]!, /^fleet\/v1\/[0-9a-f]{24}\/pre_trip_inspection\/device-fleet-0001\/manifest\.json$/);
  assert.equal(frappe.calls.length, 1);
  assert.equal(frappe.calls[0]!.actorUser, "driver@example.invalid");
  assert.equal(frappe.calls[0]!.manifestKey, objects.calls[0]);
  assert.equal(store.completed, 1);

  const manifest = JSON.parse(objects.bodies.get(objects.calls[0]!)!) as Record<string, unknown>;
  assert.equal(manifest.tenant_id, "ironwrap");
  assert.equal(manifest.action_kind, "pre_trip_inspection");
  assert.equal(manifest.device_action_id, "device-fleet-0001");
});

test("a lost-connectivity replay returns the first verified receipt without a second write", async () => {
  const { store, objects, frappe, dependency } = dependencies();
  const first = await processFleetAction(submission(), auth(), dependency);
  const replay = await processFleetAction(submission(), auth(), dependency);

  assert.deepEqual(replay, first);
  assert.equal(frappe.calls.length, 1, "the replay must not issue a second Frappe command");
  assert.equal(objects.calls.length, 1);
  assert.equal(store.completed, 1);
  assert.equal(store.claims, 1, "a verified receipt short-circuits before the claim");
});

test("a duplicate scan of the same device action id with different facts is a conflict", async () => {
  const { frappe, dependency } = dependencies();
  await processFleetAction(submission(), auth(), dependency);

  await assert.rejects(
    processFleetAction(submission({ meter_reading: 142500 }), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict" &&
      error.status === 409,
  );
  assert.equal(frappe.calls.length, 1);
});

test("a failed Frappe command leaves the capture retryable and then verifies on replay", async () => {
  const { store, frappe, dependency } = dependencies();
  frappe.failOnce = true;

  await assert.rejects(
    processFleetAction(submission(), auth(), dependency),
    (error: unknown) => error instanceof FieldActionError && error.status === 502,
  );
  assert.equal(store.failed, 1);
  assert.equal(store.completed, 0);

  const recovered = await processFleetAction(submission(), auth(), dependency);
  assert.equal(recovered.status, "verified");
  assert.equal(frappe.calls.length, 2);
  assert.equal(store.completed, 1);
});

test("a non-field or unlinked identity cannot submit a fleet capture", async () => {
  const { frappe, dependency } = dependencies();
  await assert.rejects(
    processFleetAction(submission(), auth("owner"), dependency),
    (error: unknown) => error instanceof FieldActionError && error.code === "field_role_required",
  );
  await assert.rejects(
    processFleetAction(submission(), auth("field", null), dependency),
    (error: unknown) => error instanceof FieldActionError && error.code === "field_identity_missing",
  );
  assert.equal(frappe.calls.length, 0);
});

test("telematics travels as supporting evidence and never as the inspector", async () => {
  const parsed = await parseFleetActionRequest(
    inspectionRequest(inspectionBody({ telematics_reference: "samsara:trip-9" })),
    "asset-truck-1",
    "pre_trip_inspection",
  );
  assert.equal(parsed.payload.telematics_reference, "samsara:trip-9");

  const { frappe, dependency } = dependencies();
  await processFleetAction(parsed, auth(), dependency);
  // The Worker carries the reference through but the actor stays the
  // authenticated physical inspector; Frappe rejects any other combination.
  assert.equal(frappe.calls[0]!.actorUser, "driver@example.invalid");
  assert.equal(frappe.calls[0]!.kind, "pre_trip_inspection");
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
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
  );
});

test("an oversized capture is rejected before it is parsed", async () => {
  const request = new Request(
    "https://app.example.invalid/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
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


interface FrappeStubRow {
  readonly [key: string]: unknown;
}

/**
 * A Frappe list stub for the custody derivation the BFF runs before any write.
 * It answers per DocType from the request URL, exactly as the real REST list
 * endpoint does, so the route's read contract is exercised end to end.
 */
function fleetRouteEnv(rows: Record<string, FrappeStubRow[]>): {
  env: AppEnv;
  reads: string[];
  statements: string[];
  throttleAttempts: () => number;
} {
  let attempts = 0;
  const reads: string[] = [];
  const statements: string[] = [];
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet-secret",
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
                if (!normalized.includes("app_action_throttles")) return null;
                attempts += 1;
                return { attempts, window_expires_at: "2026-07-11T06:32:00.000Z" };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const doctype = decodeURIComponent(url.pathname.replace("/api/resource/", ""));
    reads.push(doctype);
    return Response.json({ data: rows[doctype] ?? [] });
  };
  restoreFetch.push(() => {
    globalThis.fetch = original;
  });
  return { env, reads, statements, throttleAttempts: () => attempts };
}

const restoreFetch: Array<() => void> = [];

function releaseFetch(): void {
  while (restoreFetch.length > 0) restoreFetch.pop()!();
}

const CUSTODY_ASSET = {
  name: "asset-truck-1",
  fleet_asset_id: "asset-truck-1",
  status: "Active",
  custody_holder_type: "User",
  custody_crew_profile: null,
  custody_user: "driver@example.invalid",
  modified: "2026-07-11T06:00:00.000Z",
};

function captureRequest(path = "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections") {
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
  const { env, reads, statements } = fleetRouteEnv({
    "Fleet Asset": [{ ...CUSTODY_ASSET, custody_user: "someone.else@example.invalid" }],
    "Cargo Load": [],
    "Driver Authority": [],
  });
  try {
    const response = await handleAuthenticatedRoute(captureRequest(), env, auth("field"));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    // A stranger to the asset never reaches R2, the action ledger, or the
    // Frappe capture command: the only upstream traffic is the custody read.
    assert.deepEqual(new Set(reads), new Set(["Fleet Asset", "Cargo Load", "Driver Authority"]));
    assert.equal(
      statements.some((sql) => sql.includes("fleet_asset_actions")),
      false,
      "a refused capture must never claim an action row",
    );
  } finally {
    releaseFetch();
  }
});

test("an unknown asset is refused exactly like an unrelated one", async () => {
  const { env } = fleetRouteEnv({ "Fleet Asset": [] });
  try {
    const response = await handleAuthenticatedRoute(captureRequest(), env, auth("field"));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  } finally {
    releaseFetch();
  }
});

test("the custody holder and the driver of an open load both reach the capture rail", async () => {
  for (const [label, rows] of [
    ["custody holder", { "Fleet Asset": [CUSTODY_ASSET] }],
    [
      "driver on an open cargo load",
      {
        "Fleet Asset": [{ ...CUSTODY_ASSET, custody_holder_type: "Yard", custody_user: null }],
        "Cargo Load": [
          {
            name: "load-1",
            fleet_asset: "asset-truck-1",
            trailer_asset: null,
            driver_authority: "driver-1",
            driver_user: "driver@example.invalid",
            status: "Loaded",
            modified: "2026-07-11T06:00:00.000Z",
          },
        ],
      },
    ],
  ] as Array<[string, Record<string, FrappeStubRow[]>]>) {
    const { env, statements } = fleetRouteEnv(rows);
    try {
      const response = await handleAuthenticatedRoute(captureRequest(), env, auth("field"));
      // The relationship holds, so the request proceeds into the capture rail
      // and claims its action row; it fails later only because this stub has no
      // Frappe capture command to answer.
      assert.notEqual(response.status, 404, label);
      assert.notEqual(response.status, 403, label);
      assert.ok(
        statements.some((sql) => sql.includes("fleet_asset_actions")),
        `${label} must reach the capture rail`,
      );
    } finally {
      releaseFetch();
    }
  }
});

test("fleet captures share the bounded field upload window", async () => {
  const { env, throttleAttempts } = fleetRouteEnv({ "Fleet Asset": [CUSTODY_ASSET] });
  try {
    for (let index = 0; index < 8; index += 1) {
      const allowed = await handleAuthenticatedRoute(captureRequest(), env, auth("field"));
      assert.notEqual(allowed.status, 429);
    }
    const limited = await handleAuthenticatedRoute(captureRequest(), env, auth("field"));
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { error: string }).error, "field_upload_rate_limited");
    assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.equal(throttleAttempts(), 9);
  } finally {
    releaseFetch();
  }
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
    "device-fleet-0001",
    "lease-token",
    "fleet/v1/key",
    "2026-07-11T06:31:00.000Z",
  );
  const update = statements.find((entry) => entry.sql.includes("status = 'r2_stored'"));
  assert.ok(update, "the evidence status write must exist");
  // A superseded worker must not write r2_stored over the row its successor
  // now owns, so this statement matches on the lease token like renew/complete.
  assert.match(update!.sql, /processing_token = \?/);
  assert.ok(update!.values.includes("lease-token"));
});

test("every fleet route refuses office roles and bad CSRF before any mutation", async () => {
  const appEnv = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet-secret",
  } as AppEnv;
  const paths = [
    "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    "/api/v1/fleet/assets/asset-truck-1/post-trip-inspections",
    "/api/v1/fleet/assets/asset-truck-1/defects",
  ];
  let upstreamCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ data: [] });
  };
  try {
    for (const path of paths) {
      const request = (csrf: string) =>
        new Request(`https://app.example.invalid${path}`, {
          method: "POST",
          headers: { "x-csrf-token": csrf, "content-type": "application/json" },
          body: JSON.stringify(inspectionBody()),
        });
      assert.equal(
        (await handleAuthenticatedRoute(request("csrf"), appEnv, auth("owner"))).status,
        403,
        `${path} must refuse an office role`,
      );
      assert.equal(
        (await handleAuthenticatedRoute(request("wrong"), appEnv, auth("field"))).status,
        403,
        `${path} must refuse a mismatched CSRF token`,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(upstreamCalls, 0, "a refused route must never reach Frappe");
});

const DEFECT_INPUT: PersistFleetActionInput = {
  kind: "defect_report",
  fleetAssetId: "asset-truck-1",
  actorUser: "driver@example.invalid",
  deviceActionId: "device-action-fleet-1",
  manifestKey: "fleet/manifest.json",
  payload: {
    fleet_asset_id: "asset-truck-1",
    detected_at: "2026-07-11T06:30:00.000Z",
    severity: "Out of Service",
    description: "Brake line weeping at the rear axle.",
  },
};

test("the fleet-capture rail presents its own Frappe issuer, never the shared bus pair", async () => {
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet-secret",
  } as unknown as AppEnv;
  const original = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    return Response.json({ message: {
      record: { name: "ASI-0001" },
      fleet_asset: { name: "asset-truck-1" },
    } });
  };
  try {
    assert.deepEqual(await frappeFleetWriter(env).persistAction(DEFECT_INPUT), {
      recordName: "ASI-0001",
      assetName: "asset-truck-1",
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(authorization, "token fleet-key:fleet-secret");
});

test("the fleet-capture rail refuses the shared bus pair before contacting Frappe", async () => {
  // Same identity behind a rail-shaped binding name is the state the split exists to prevent.
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    FLEET_CAPTURE_FRAPPE_API_KEY: "bus-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "bus-secret",
  } as unknown as AppEnv;
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({});
  };
  try {
    await assert.rejects(
      frappeFleetWriter(env).persistAction(DEFECT_INPUT),
      /fleet_frappe_shared_credential_rejected/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false);
});

test("an unissued fleet-capture credential fails closed rather than borrowing the bus pair", async () => {
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
  } as unknown as AppEnv;
  await assert.rejects(
    frappeFleetWriter(env).persistAction(DEFECT_INPUT),
    /fleet_frappe_not_configured/,
  );
});
