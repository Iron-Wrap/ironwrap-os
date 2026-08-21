import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import { resetDatabaseForTests } from "../storage/db";
import { getOutboxAction } from "../storage/outbox";
import { FleetPage } from "./fleet-page";
import type { FleetPanelAsset, FleetPanelResponse } from "./fleet-contracts";

vi.mock("./field-cache", () => ({
  cacheFieldModel: vi.fn().mockResolvedValue(undefined),
  getCachedFieldModel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../storage/use-outbox", () => ({
  useOutboxActionsNeedingAttention: () => [],
}));

vi.mock("../auth/device-credential", () => ({
  getDeviceSecret: vi.fn().mockResolvedValue("device-proof"),
  clearDeviceSecret: vi.fn().mockResolvedValue(undefined),
}));

const flushOutbox = vi.fn().mockResolvedValue({
  processed: 1,
  verified: 1,
  requeued: 0,
  needsAttention: 0,
});

vi.mock("../storage/outbox-processor", () => ({
  flushOutbox: (...args: unknown[]) => flushOutbox(...args),
}));

const fieldSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "driver@example.com",
    display_name: "Driver",
    role: "field",
    frappe_user_id: "driver@example.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function panelAsset(overrides: Partial<FleetPanelAsset> = {}): FleetPanelAsset {
  return {
    id: "asset-truck-1",
    fleet_asset_id: "TRUCK-01",
    display_name: "Truck 01",
    unit_number: "01",
    asset_kind: "Vehicle",
    status: "Active",
    licence_plate: "ABC-123",
    meter_kind: "Odometer km",
    current_meter: 142000,
    relationship: "custody",
    last_inspection_at: null,
    next_inspection_due: "2026-07-12",
    last_pre_trip_at: null,
    last_post_trip_at: null,
    out_of_service_reason: null,
    open_out_of_service_defects: 0,
    blockers: [],
    ...overrides,
  };
}

function panel(overrides: Partial<FleetPanelResponse> = {}): FleetPanelResponse {
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-07-11T06:00:00.000Z",
    stale_fields: [],
    permissions: [],
    allowed_actions: [
      "fleet.pre_trip_inspection.create",
      "fleet.post_trip_inspection.create",
      "fleet.defect_report.create",
    ],
    reference_date: "2026-07-11",
    assets: [panelAsset()],
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={fieldSession}>
        <FleetPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/**
 * A fresh Response per call. The panel is re-read after every verified capture,
 * and a single shared Response body can only be consumed once.
 */
function respondWith(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("the driver's vehicle surface", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    flushOutbox.mockClear();
  });

  afterEach(async () => {
    await resetDatabaseForTests();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the asset a driver holds and offers inspection, fault, and collision", async () => {
    respondWith(panel());
    renderPage();

    expect(await screen.findByRole("heading", { name: "Truck 01" })).toBeVisible();
    expect(screen.getByText(/Signed out to you/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Pre-trip inspection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Post-trip inspection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Report a fault" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Report a collision" })).toBeVisible();
    expect(screen.getByText(/Cleared to go out/)).toBeVisible();
  });

  it("tells a driver with nothing signed out what to do instead of showing an empty screen", async () => {
    respondWith(panel({ assets: [] }));
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Nothing is signed out to you" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pre-trip inspection" })).toBeNull();
  });

  it("says why dispatch is blocked in words, never as a policy code", async () => {
    respondWith(
      panel({
        assets: [
          panelAsset({
            blockers: [
              {
                code: "overdue_fleet_inspection",
                field: "next_inspection_due",
                message:
                  "[overdue_fleet_inspection] next_inspection_due: the linked Fleet Asset inspection is overdue for the scheduled or released work",
              },
              {
                code: "expired_driver_licence",
                field: "licence_expiry",
                message:
                  "[expired_driver_licence] licence_expiry: the linked Driver Authority licence expires before the scheduled or released work",
              },
            ],
          }),
        ],
      }),
    );
    renderPage();

    const blocked = await screen.findByRole("region", { name: "This one cannot go out yet" });
    expect(
      within(blocked).getByText(/Its inspection is out of date\. Record a pre-trip that passes/),
    ).toBeVisible();
    expect(
      within(blocked).getByText(/Your licence has expired\. It has to be renewed/),
    ).toBeVisible();
    expect(within(blocked).queryByText(/overdue_fleet_inspection/)).toBeNull();
    expect(within(blocked).queryByText(/expired_driver_licence/)).toBeNull();
    // Blocked from dispatch is not blocked from reporting: the capture that
    // clears an overdue inspection is the pre-trip itself.
    expect(screen.getByRole("button", { name: "Pre-trip inspection" })).toBeEnabled();
  });

  it("falls back to the fence's own words for a policy code the app has never seen", async () => {
    respondWith(
      panel({
        assets: [
          panelAsset({
            blockers: [
              { code: "a_fence_added_later", field: null, message: "the fence refused this asset" },
            ],
          }),
        ],
      }),
    );
    renderPage();

    expect(await screen.findByText("the fence refused this asset")).toBeVisible();
  });

  it("queues a pre-trip in the Worker envelope with every check point recorded", async () => {
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Pre-trip inspection" }));
    await user.click(screen.getByRole("button", { name: "Save and send inspection" }));

    expect(await screen.findByText(/Inspection saved on this device/)).toBeVisible();
    const queued = await onlyOutboxAction();
    expect(queued).toMatchObject({
      kind: "fleet_pre_trip_inspection",
      endpoint: "/api/v1/fleet/assets/TRUCK-01/pre-trip-inspections",
      state: "queued",
      attachments: [],
    });
    const payload = queued.payload as {
      fleet_asset_id: string;
      performed_at: string;
      items: Array<{ sequence: number; check_point: string; result: string }>;
    };
    expect(payload.fleet_asset_id).toBe("TRUCK-01");
    expect(payload.performed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.items).toHaveLength(10);
    expect(payload.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(payload.items[0]).toEqual({
      sequence: 1,
      check_point: "Brakes and air system",
      result: "Pass",
    });
    expect(flushOutbox).toHaveBeenCalledTimes(1);
  });

  it("records a failed check point with its severity and note", async () => {
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Pre-trip inspection" }));
    const brakes = screen.getByRole("group", { name: "Brakes and air system" });
    await user.click(within(brakes).getByRole("radio", { name: "Fault" }));
    await user.selectOptions(
      within(brakes).getByRole("combobox", { name: "How bad is it" }),
      "Out of Service",
    );
    await user.type(
      within(brakes).getByRole("textbox", { name: "What you found" }),
      "Air chamber leaking at the rear axle.",
    );
    expect(screen.getByText(/This parks it straight away/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Save and send inspection" }));
    await screen.findByText(/Inspection saved on this device/);

    const payload = (await onlyOutboxAction()).payload as {
      items: Array<Record<string, unknown>>;
    };
    expect(payload.items[0]).toEqual({
      sequence: 1,
      check_point: "Brakes and air system",
      result: "Fail",
      severity: "Out of Service",
      observation: "Air chamber leaking at the rear axle.",
    });
    // A passing point must never carry a severity: the Worker refuses that
    // shape, and a device could otherwise downgrade a real defect to a note.
    expect(payload.items[1]).not.toHaveProperty("severity");
  });

  it("refuses to save a fault whose note says nothing, and names the point", async () => {
    // The note field is `required`, so an empty one never reaches here. A note
    // of two spaces does, and a defect nobody can act on is not a defect.
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Pre-trip inspection" }));
    const lights = screen.getByRole("group", { name: "Lights and reflectors" });
    await user.click(within(lights).getByRole("radio", { name: "Fault" }));
    await user.type(within(lights).getByRole("textbox", { name: "What you found" }), "  ");
    await user.click(screen.getByRole("button", { name: "Save and send inspection" }));

    expect(
      await screen.findByText('Say what is wrong with "Lights and reflectors" before saving.'),
    ).toBeVisible();
    expect(await countOutboxActions()).toBe(0);
  });

  it("queues a defect report and warns before it parks the asset", async () => {
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Report a fault" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "How bad is it" }),
      "Out of Service",
    );
    expect(screen.getByText(/This parks it straight away/)).toBeVisible();
    await user.type(
      screen.getByRole("textbox", { name: "What is wrong" }),
      "Steering play well past spec.",
    );
    await user.click(screen.getByRole("button", { name: "Save and send fault" }));

    expect(await screen.findByText(/Do not use this one/)).toBeVisible();
    const queued = await onlyOutboxAction();
    expect(queued).toMatchObject({
      kind: "fleet_defect_report",
      endpoint: "/api/v1/fleet/assets/TRUCK-01/defects",
    });
    expect(queued.payload).toMatchObject({
      fleet_asset_id: "TRUCK-01",
      severity: "Out of Service",
      description: "Steering play well past spec.",
    });
    expect(queued.payload).not.toHaveProperty("photo_evidence");
  });

  it("offers photo evidence on a fault and keeps it off the outbox", async () => {
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Report a fault" }));
    expect(screen.getByLabelText("Photos")).toBeVisible();
    expect(screen.getByText(/never ride the offline outbox/)).toBeVisible();
  });

  it("records a collision online as a vehicle incident, not a safety occurrence", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
      const path = String(input);
      if (path.includes("/collisions")) {
        return Response.json({
          collision: {
            collision_id: "fc_devicefleet0001aaaa",
            kind: "vehicle_collision",
            state: "reported",
            severity: "Major",
            description: "Hit a parked trailer in the yard.",
            telematics_reference: null,
          },
        });
      }
      return Response.json(panel());
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Report a collision" }));
    expect(screen.getByText(/not a worker injury or near-miss/)).toBeVisible();
    await user.type(
      screen.getByRole("textbox", { name: "What happened" }),
      "Hit a parked trailer in the yard.",
    );
    await user.click(screen.getByRole("button", { name: "Save and send collision" }));

    expect(await screen.findByText(/Collision recorded/)).toBeVisible();
    expect(await countOutboxActions()).toBe(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/collisions"))).toBe(
      true,
    );
  });

  it("saves a capture with no connection and never calls the network", async () => {
    respondWith(panel());
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "Truck 01" });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    await user.click(screen.getByRole("button", { name: "Post-trip inspection" }));
    await user.click(screen.getByRole("button", { name: "Save and send inspection" }));

    expect(await screen.findByText(/Inspection saved on this device/)).toBeVisible();
    expect(await onlyOutboxAction()).toMatchObject({
      kind: "fleet_post_trip_inspection",
      endpoint: "/api/v1/fleet/assets/TRUCK-01/post-trip-inspections",
      state: "queued",
    });
    expect(flushOutbox).not.toHaveBeenCalled();
  });

  it("lets a driver holding more than one asset choose between them", async () => {
    respondWith(
      panel({
        assets: [
          panelAsset(),
          panelAsset({
            id: "trailer-1",
            fleet_asset_id: "TRAILER-01",
            display_name: "Trailer 01",
            asset_kind: "Trailer",
            unit_number: "T1",
            meter_kind: null,
            relationship: "driver",
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Which one" }),
      "trailer-1",
    );
    expect(screen.getByRole("heading", { name: "Trailer 01" })).toBeVisible();
    expect(screen.getByText(/You are its driver/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Pre-trip inspection" }));
    // The trailer walk-around is its own list, not the truck's.
    expect(screen.getByRole("group", { name: "Coupling and safety chains" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Horn, wipers and heater" })).toBeNull();
  });

  it("reports an unreadable vehicle list rather than pretending the fleet is empty", async () => {
    respondWith({ error: "upstream_unavailable" }, 502);
    renderPage();

    expect(
      await screen.findByText("Your vehicle list could not be loaded on this device yet."),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Nothing is signed out to you" })).toBeNull();
  });
});

async function outboxActions(): Promise<string[]> {
  const { getDatabase } = await import("../storage/db");
  const database = await getDatabase();
  return (await database.getAll("outbox_actions")).map((action) => action.deviceActionId);
}

async function countOutboxActions(): Promise<number> {
  return (await outboxActions()).length;
}

async function onlyOutboxAction() {
  const ids = await outboxActions();
  expect(ids).toHaveLength(1);
  const action = await getOutboxAction(ids[0]!);
  if (!action) throw new Error("the queued outbox action disappeared");
  return action;
}
