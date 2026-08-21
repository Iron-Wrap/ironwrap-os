import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { resetDatabaseForTests } from "../storage/db";
import { getOutboxActionsNeedingAttention } from "../storage/outbox";
import { getDatabase } from "../storage/db";
import { SafetyActionPanel } from "./safety-action-panel";

vi.mock("../storage/outbox-processor", () => ({
  flushOutbox: vi
    .fn()
    .mockResolvedValue({ processed: 1, verified: 1, requeued: 0, needsAttention: 0 }),
}));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "crew@example.invalid",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.invalid",
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
  session_expires_at: "2026-08-18T12:00:00.000Z",
  source_updated_at: "2026-08-17T12:00:00.000Z",
  read_model_generated_at: "2026-08-17T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const panelPayload = {
  version: 1,
  panel: {
    version: 1,
    actor_role: "field",
    assigned_equipment: [
      {
        equipment_id: "eq_harness_0001",
        equipment_kind: "fall_arrest_harness",
        serial_number: "SN-0001",
        status: "quarantined",
        inspection_due_at: null,
      },
    ],
    open_occurrences: [
      {
        occurrence_id: "so_ladder_slip_0001",
        occurrence_kind: "hazard",
        severity: "high",
        state: "reported",
        stop_active: true,
        scope_type: "roof_job",
        scope_id: "JOB-A",
        summary: "Unguarded skylight on the east slope.",
      },
    ],
    my_corrective_actions: [],
    allowed_actions: [
      "safety.report_occurrence",
      "safety.make_safe",
      "safety.equipment_defect",
      "safety.rescue_request",
    ],
  },
};

function panelFetcher(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(panelPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function offlineFetcher(): typeof fetch {
  return (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
}

async function queuedSafetyActions() {
  const database = await getDatabase();
  const all = await database.getAll("outbox_actions");
  return all.filter((action) => action.kind === "safety_action");
}

describe("SafetyActionPanel", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers every worker right without a job, an assignment, or a work package", async () => {
    render(<SafetyActionPanel session={session} fetcher={panelFetcher()} />);
    expect(await screen.findByRole("button", { name: /call for rescue/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /report a hazard or injury/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /record making it safe/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /mark equipment unsafe/i })).toBeTruthy();
  });

  it("shows the active stop and the equipment the worker must not use", async () => {
    render(<SafetyActionPanel session={session} fetcher={panelFetcher()} />);
    expect(await screen.findByText(/Unguarded skylight on the east slope\./i)).toBeTruthy();
    const equipment = await screen.findByLabelText(/equipment you cannot use/i);
    expect(equipment.textContent).toContain("SN-0001");
    expect(equipment.textContent?.toLowerCase()).toContain("do not use it");
  });

  it("saves a rescue call to the durable outbox even with no network", async () => {
    const user = userEvent.setup();
    render(<SafetyActionPanel session={session} fetcher={offlineFetcher()} />);
    await user.click(await screen.findByRole("button", { name: /call for rescue/i }));
    await user.type(
      screen.getByLabelText(/what you saw/i),
      "Worker suspended in harness on the north elevation.",
    );
    await user.click(screen.getByRole("button", { name: /save and send/i }));

    await waitFor(async () => {
      expect((await queuedSafetyActions()).length).toBe(1);
    });
    const [queued] = await queuedSafetyActions();
    expect(queued?.endpoint).toBe("/api/v1/safety/actions");
    expect(queued?.state).toBe("queued");
    const payload = queued?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("rescue_request");
    expect(payload.scope_type).toBe("tenant");
    expect(payload.scope_id).toBe("ironwrap");
    expect(payload.detail).toBe("Worker suspended in harness on the north elevation.");
    expect(typeof payload.captured_at).toBe("string");
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("reports against the current scope when the app knows where the worker is", async () => {
    const user = userEvent.setup();
    render(
      <SafetyActionPanel
        session={session}
        scope={{ type: "roof_job", id: "JOB-A" }}
        fetcher={offlineFetcher()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /report a hazard or injury/i }));
    await user.selectOptions(screen.getByLabelText(/what happened/i), "injury");
    await user.selectOptions(screen.getByLabelText(/how serious/i), "critical");
    await user.type(screen.getByLabelText(/what you saw/i), "Fall from the second-storey edge.");
    await user.click(screen.getByRole("button", { name: /save and send/i }));

    await waitFor(async () => {
      expect((await queuedSafetyActions()).length).toBe(1);
    });
    const [queued] = await queuedSafetyActions();
    const payload = queued?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("report_occurrence");
    expect(payload.occurrence_kind).toBe("injury");
    expect(payload.severity).toBe("critical");
    expect(payload.scope_type).toBe("roof_job");
    expect(payload.scope_id).toBe("JOB-A");
    // Nothing about a saved safety report needs office review to exist.
    expect(
      await getOutboxActionsNeedingAttention({
        tenantId: session.tenant.id,
        userId: session.user.id,
      }),
    ).toEqual([]);
  });

  it("refuses a description too short to mean anything", async () => {
    const user = userEvent.setup();
    render(<SafetyActionPanel session={session} fetcher={offlineFetcher()} />);
    await user.click(await screen.findByRole("button", { name: /call for rescue/i }));
    await user.type(screen.getByLabelText(/what you saw/i), "x");
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/few words/i);
    expect(await queuedSafetyActions()).toEqual([]);
  });

  it("marking equipment unsafe cannot be submitted without naming the item", async () => {
    const user = userEvent.setup();
    render(<SafetyActionPanel session={session} fetcher={offlineFetcher()} />);
    await user.click(await screen.findByRole("button", { name: /mark equipment unsafe/i }));
    const item = screen.getByLabelText(/which item/i) as HTMLInputElement;
    expect(item.required).toBe(true);
    expect(item.value).toBe("");
    await user.type(screen.getByLabelText(/what you saw/i), "Webbing is cut through.");
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    // A defect report with no item is not a record anyone can act on.
    expect(await queuedSafetyActions()).toEqual([]);

    await user.type(item, "eq_harness_0001");
    await user.click(screen.getByRole("button", { name: /save and send/i }));
    await waitFor(async () => {
      expect((await queuedSafetyActions()).length).toBe(1);
    });
    const [queued] = await queuedSafetyActions();
    expect((queued?.payload as Record<string, unknown>).equipment_id).toBe("eq_harness_0001");
  });

  it("keeps every control reachable by name and keyboard", async () => {
    render(<SafetyActionPanel session={session} fetcher={panelFetcher()} />);
    const region = await screen.findByRole("region", { name: /^safety$/i });
    expect(region).toBeTruthy();
    const rescue = screen.getByRole("button", { name: /call for rescue/i });
    rescue.focus();
    expect(document.activeElement).toBe(rescue);
  });
});
