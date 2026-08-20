import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";

/**
 * The read half of the fleet capture rail (ELEC-87).
 *
 * The capture routes could always be posted to; nothing could tell a driver
 * which asset to post against. These cover the route that closes that: who may
 * ask, what leaves the Worker, and that the fence's verdict travels unaltered
 * from Frappe to the phone.
 */

const PANEL_PATH = "/api/v1/fleet/panel";
const PANEL_METHOD =
  "/api/method/ironwrap_roofing.fleet_operations_api.read_driver_fleet_panel";

function auth(
  role: "field" | "owner" | "ops" = "field",
  frappeUser: string | null = "driver@example.invalid",
): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["today:read"],
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
  } as AuthContext;
}

function panelAssetFixture(overrides: Record<string, unknown> = {}) {
  return {
    name: "asset-truck-1",
    fleet_asset_id: "TRUCK-01",
    asset_kind: "Vehicle",
    status: "Active",
    display_name: "Truck 01",
    unit_number: "01",
    licence_plate: "ABC-123",
    meter_kind: "Odometer km",
    current_meter: 142000,
    last_inspection_at: "2026-07-11 06:30:00",
    next_inspection_due: "2026-07-12",
    out_of_service_reason: null,
    relationship: "custody",
    open_out_of_service_defects: 0,
    last_pre_trip_at: "2026-07-11 06:30:00",
    last_post_trip_at: null,
    blockers: [],
    ...overrides,
  };
}

interface PanelStub {
  env: AppEnv;
  calls: Array<{ url: string; body: unknown }>;
  release: () => void;
}

function panelEnv(
  message: unknown,
  options: { status?: number; configured?: boolean } = {},
): PanelStub {
  const calls: Array<{ url: string; body: unknown }> = [];
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.invalid",
    ...(options.configured === false ? {} : { ERPNEXT_API_KEY: "key", ERPNEXT_API_SECRET: "secret" }),
  } as unknown as AppEnv;
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ message }, { status: options.status ?? 200 });
  };
  return {
    env,
    calls,
    release: () => {
      globalThis.fetch = original;
    },
  };
}

function panelRequest(): Request {
  return new Request(`https://app.example.invalid${PANEL_PATH}`);
}

test("a field session reads its own assets with the fence verdict intact", async () => {
  const stub = panelEnv({
    reference_date: "2026-07-11",
    assets: [
      panelAssetFixture({
        blockers: [
          {
            code: "overdue_fleet_inspection",
            field: "next_inspection_due",
            message:
              "[overdue_fleet_inspection] next_inspection_due: the linked Fleet Asset inspection is overdue for the scheduled or released work",
          },
        ],
      }),
    ],
  });
  try {
    const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      reference_date: string;
      allowed_actions: string[];
      assets: Array<Record<string, unknown>>;
    };
    assert.equal(body.reference_date, "2026-07-11");
    assert.deepEqual(body.allowed_actions, [
      "fleet.pre_trip_inspection.create",
      "fleet.post_trip_inspection.create",
      "fleet.defect_report.create",
    ]);
    assert.equal(body.assets.length, 1);
    assert.equal(body.assets[0]!.fleet_asset_id, "TRUCK-01");
    assert.equal(body.assets[0]!.display_name, "Truck 01");
    assert.equal(body.assets[0]!.relationship, "custody");
    // The reason travels verbatim: the Worker must not paraphrase a fence.
    assert.deepEqual(body.assets[0]!.blockers, [
      {
        code: "overdue_fleet_inspection",
        field: "next_inspection_due",
        message:
          "[overdue_fleet_inspection] next_inspection_due: the linked Fleet Asset inspection is overdue for the scheduled or released work",
      },
    ]);
  } finally {
    stub.release();
  }
});

test("the actor comes from the session, never from the request", async () => {
  const stub = panelEnv({ reference_date: "2026-07-11", assets: [] });
  try {
    const request = new Request(
      `https://app.example.invalid${PANEL_PATH}?actor_user=owner@example.invalid`,
    );
    await handleAuthenticatedRoute(request, stub.env, auth("field"));
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0]!.url.endsWith(PANEL_METHOD));
    assert.deepEqual(stub.calls[0]!.body, { actor_user: "driver@example.invalid" });
  } finally {
    stub.release();
  }
});

test("an office role never reaches the driver's fleet panel", async () => {
  for (const role of ["owner", "ops"] as const) {
    const stub = panelEnv({ reference_date: "2026-07-11", assets: [panelAssetFixture()] });
    try {
      const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth(role));
      assert.equal(response.status, 403, role);
      assert.deepEqual(await response.json(), { error: "field_role_required" });
      assert.equal(stub.calls.length, 0, `${role} must not reach Frappe at all`);
    } finally {
      stub.release();
    }
  }
});

test("a field session with no Frappe identity owns nothing and asks nothing", async () => {
  const stub = panelEnv({ reference_date: "2026-07-11", assets: [panelAssetFixture()] });
  try {
    const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field", null));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { assets: unknown[] }).assets, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.release();
  }
});

test("an upstream refusal is reported as unavailable, not as an empty fleet", async () => {
  // An empty panel and a broken upstream must never look the same: the first
  // says "you hold no vehicle", the second would silently hide one.
  const upstreams: Array<[string, () => PanelStub]> = [
    ["a Frappe error", () => panelEnv({}, { status: 500 })],
    ["an unreadable message", () => panelEnv("not-an-object")],
    [
      "an unconfigured issuer",
      () => panelEnv({ reference_date: "2026-07-11", assets: [] }, { configured: false }),
    ],
  ];
  for (const [label, build] of upstreams) {
    const stub = build();
    try {
      const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field"));
      assert.equal(response.status, 502, label);
      assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
    } finally {
      stub.release();
    }
  }
});

test("a row the Worker cannot identify is dropped rather than half-rendered", async () => {
  const stub = panelEnv({
    reference_date: "2026-07-11",
    assets: [
      panelAssetFixture(),
      { fleet_asset_id: "TRUCK-02" },
      panelAssetFixture({ name: "asset-truck-3", fleet_asset_id: "TRUCK-03", status: null }),
      "not-an-asset",
    ],
  });
  try {
    const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field"));
    const body = (await response.json()) as { assets: Array<{ fleet_asset_id: string }> };
    assert.deepEqual(
      body.assets.map((row) => row.fleet_asset_id),
      ["TRUCK-01"],
    );
  } finally {
    stub.release();
  }
});

test("a malformed relationship falls back to the weaker claim", async () => {
  const stub = panelEnv({
    reference_date: "2026-07-11",
    assets: [panelAssetFixture({ relationship: "owner" })],
  });
  try {
    const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field"));
    const body = (await response.json()) as { assets: Array<{ relationship: string }> };
    assert.equal(body.assets[0]!.relationship, "driver");
  } finally {
    stub.release();
  }
});

test("the panel is bounded so a broken upstream cannot flood a phone", async () => {
  const stub = panelEnv({
    reference_date: "2026-07-11",
    assets: Array.from({ length: 60 }, (_value, index) =>
      panelAssetFixture({ name: `asset-${index}`, fleet_asset_id: `TRUCK-${index}` }),
    ),
  });
  try {
    const response = await handleAuthenticatedRoute(panelRequest(), stub.env, auth("field"));
    const body = (await response.json()) as { assets: unknown[] };
    assert.equal(body.assets.length, 25);
  } finally {
    stub.release();
  }
});

test("the panel is a read: it refuses every write method", async () => {
  const stub = panelEnv({ reference_date: "2026-07-11", assets: [] });
  try {
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const response = await handleAuthenticatedRoute(
        new Request(`https://app.example.invalid${PANEL_PATH}`, {
          method,
          headers: { "x-csrf-token": "csrf" },
        }),
        stub.env,
        auth("field"),
      );
      assert.notEqual(response.status, 200, method);
      assert.equal(stub.calls.length, 0, method);
    }
  } finally {
    stub.release();
  }
});
