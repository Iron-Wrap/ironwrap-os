import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDatabaseForTests } from "./db";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "./outbox";
import { flushOutbox } from "./outbox-processor";

const principal = { tenantId: "ironwrap", userId: "appu_field" };

function inspectionPayload(overrides: Record<string, unknown> = {}) {
  return {
    fleet_asset_id: "asset-truck-1",
    performed_at: "2026-07-11T06:30:00.000Z",
    meter_reading: 142000,
    items: [
      { sequence: 1, check_point: "Brakes", result: "Pass" },
      { sequence: 2, check_point: "Lights", result: "Pass" },
    ],
    ...overrides,
  };
}

function defectPayload(overrides: Record<string, unknown> = {}) {
  return {
    fleet_asset_id: "asset-truck-1",
    detected_at: "2026-07-11T06:35:00.000Z",
    severity: "Out of Service",
    description: "Air brake chamber leaking.",
    ...overrides,
  };
}

async function saveInspection(overrides: Record<string, unknown> = {}) {
  return await saveOutboxAction({
    ...principal,
    deviceActionId: "device-fleet-0001",
    kind: "fleet_pre_trip_inspection",
    endpoint: "/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections",
    payload: inspectionPayload(overrides),
  });
}

describe("offline fleet captures", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
  });

  it("saves a pre-trip inspection locally with no connection", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const action = await saveInspection();

    expect(action).toMatchObject({
      deviceActionId: "device-fleet-0001",
      kind: "fleet_pre_trip_inspection",
      state: "saved_locally",
      attachments: [],
    });
  });

  it("replays the saved capture in the Worker envelope once a connection returns", async () => {
    await saveInspection();
    await queueOutboxAction("device-fleet-0001", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe("/api/v1/fleet/assets/asset-truck-1/pre-trip-inspections");
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("device-fleet-0001");
      expect(headers.get("X-Device-Action-Id")).toBe("device-fleet-0001");
      expect(JSON.parse(String(init?.body))).toEqual({
        device_action_id: "device-fleet-0001",
        payload: inspectionPayload(),
      });
      return Response.json({
        device_action_id: "device-fleet-0001",
        status: "verified",
        server_ref: "inspection:device-fleet-0001",
        cursor: "asset-truck-1",
      });
    });

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      deviceProof: async () => "device-proof",
      now: () => 3_000,
    });

    expect(result).toMatchObject({ processed: 1, verified: 1 });
    expect(await getOutboxAction("device-fleet-0001")).toMatchObject({
      state: "verified",
      verification: { serverRef: "inspection:device-fleet-0001", verifiedAt: 3_000 },
    });
  });

  it("keeps a duplicate-scan conflict for a human instead of retrying it forever", async () => {
    await saveInspection();
    await queueOutboxAction("device-fleet-0001", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: "idempotency_conflict",
          message: "This device action id is already bound to a different fleet action.",
        },
        { status: 409 },
      ),
    );

    await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      deviceProof: async () => "device-proof",
      now: () => 3_000,
    });

    const saved = await getOutboxAction("device-fleet-0001");
    expect(saved?.state).toBe("needs_attention");
    expect(saved?.conflict).toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("refuses a capture the Worker would reject after the driver has left", async () => {
    const rejected: Array<[string, Record<string, unknown>]> = [
      ["an unknown payload key", inspectionPayload({ odometer: 1 })],
      ["an empty check-point list", inspectionPayload({ items: [] })],
      [
        "an out-of-order check-point sequence",
        inspectionPayload({ items: [{ sequence: 2, check_point: "Brakes", result: "Pass" }] }),
      ],
      [
        "a failed check point with no severity",
        inspectionPayload({ items: [{ sequence: 1, check_point: "Brakes", result: "Fail" }] }),
      ],
      [
        "a passing check point carrying a severity",
        inspectionPayload({
          items: [{ sequence: 1, check_point: "Brakes", result: "Pass", severity: "Major" }],
        }),
      ],
      ["a local capture time", inspectionPayload({ performed_at: "2026-07-11 06:30:00" })],
      ["a negative meter reading", inspectionPayload({ meter_reading: -1 })],
    ];
    for (const [label, payload] of rejected) {
      await expect(saveInspection(payload), label).rejects.toThrow();
    }
  });

  it("queues a defect report and refuses an unsupported severity", async () => {
    const action = await saveOutboxAction({
      ...principal,
      deviceActionId: "device-fleet-0002",
      kind: "fleet_defect_report",
      endpoint: "/api/v1/fleet/assets/asset-truck-1/defects",
      payload: defectPayload({ asset_inspection_id: "inspection:device-fleet-0001" }),
    });
    expect(action.state).toBe("saved_locally");

    await expect(
      saveOutboxAction({
        ...principal,
        deviceActionId: "device-fleet-0003",
        kind: "fleet_defect_report",
        endpoint: "/api/v1/fleet/assets/asset-truck-1/defects",
        payload: defectPayload({ severity: "Cosmetic" }),
      }),
    ).rejects.toThrow(/severity/i);
  });

  it("keeps a fleet capture on its own endpoint and off the media rail", async () => {
    await expect(
      saveOutboxAction({
        ...principal,
        deviceActionId: "device-fleet-0004",
        kind: "fleet_pre_trip_inspection",
        endpoint: "/api/v1/jobs/job-1/check-ins",
        payload: inspectionPayload(),
      }),
    ).rejects.toThrow(/cannot be queued for offline replay/i);

    await expect(
      saveOutboxAction({
        ...principal,
        deviceActionId: "device-fleet-0005",
        kind: "fleet_defect_report",
        endpoint: "/api/v1/fleet/assets/asset-truck-1/defects",
        payload: defectPayload(),
        attachments: [
          { blob: new Blob(["photo"], { type: "image/jpeg" }), fileName: "defect.jpg" },
        ],
      }),
    ).rejects.toThrow(/attachments/i);
  });

  describe("a collision report", () => {
    const report = {
      collision_id: "fc_offlinecollision0001",
      occurred_at: "2026-07-11T07:10:00.000Z",
      severity: "Major",
      description: "Backed into a pole in the yard.",
    };
    const stored = {
      collision: {
        ...report,
        kind: "vehicle_collision",
        state: "reported",
        telematics_reference: null,
        tenant_id: "ironwrap",
        fleet_asset_id: "asset-truck-1",
        reported_by: "crew@example.invalid",
        photo_evidence: [],
        created_at: "2026-07-11T07:12:00.000Z",
        updated_at: "2026-07-11T07:12:00.000Z",
      },
    };
    async function saveCollision() {
      const saved = await saveOutboxAction({
        ...principal,
        deviceActionId: "device-collision-0001",
        kind: "fleet_collision_report",
        endpoint: "/api/v1/fleet/assets/asset-truck-1/collisions",
        payload: report,
      });
      await queueOutboxAction(saved.deviceActionId, 2_000);
    }
    function flush(fetcher: typeof fetch) {
      return flushOutbox({
        ...principal,
        fetcher,
        csrfToken: "csrf",
        deviceProof: async () => "device-proof",
        now: () => 3_000,
      });
    }

    it("is kept on the phone with no signal and sends its own body, keyed by its id", async () => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      await saveCollision();
      expect(await getOutboxAction("device-collision-0001")).toMatchObject({ state: "queued" });

      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(stored, { status: 201 }));
      expect(await flush(fetcher)).toMatchObject({ processed: 1, verified: 1 });

      const [path, init] = fetcher.mock.calls[0]!;
      expect(path).toBe("/api/v1/fleet/assets/asset-truck-1/collisions");
      // The route takes the report itself, not the field-action envelope.
      expect(JSON.parse(String(init?.body))).toEqual(report);
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("device-collision-0001");
      expect(await getOutboxAction("device-collision-0001")).toMatchObject({ state: "verified" });
    });

    it("never settles on an answer about a different report", async () => {
      await saveCollision();
      const other = { collision: { ...stored.collision, collision_id: "fc_someoneelse00000001" } };
      await flush(vi.fn<typeof fetch>().mockResolvedValue(Response.json(other, { status: 201 })));
      expect(await getOutboxAction("device-collision-0001")).toMatchObject({
        state: "needs_attention",
        lastError: { code: "verification_mismatch" },
      });
    });

    it("refuses a report without its own id, so a retry can never mint a second one", async () => {
      await expect(
        saveOutboxAction({
          ...principal,
          kind: "fleet_collision_report",
          endpoint: "/api/v1/fleet/assets/asset-truck-1/collisions",
          payload: { ...report, collision_id: "not-an-id" },
        }),
      ).rejects.toThrow("A collision report needs its own report ID.");
      await expect(
        saveOutboxAction({
          ...principal,
          kind: "fleet_collision_report",
          endpoint: "/api/v1/fleet/assets/asset-truck-1/collisions",
          payload: { ...report, photo_evidence: [] },
        }),
      ).rejects.toThrow("Collision report payload is invalid.");
    });

    it("refuses a description the office would refuse as too short once trimmed", async () => {
      await expect(
        saveOutboxAction({
          ...principal,
          kind: "fleet_collision_report",
          endpoint: "/api/v1/fleet/assets/asset-truck-1/collisions",
          payload: { ...report, description: "  ok  " },
        }),
      ).rejects.toThrow("What happened needs at least three characters.");
    });
  });
});
