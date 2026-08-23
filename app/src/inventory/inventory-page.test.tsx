import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import {
  loadInventoryOverview,
  lookupInventoryBarcode,
  recordInventoryScan,
  submitInventoryCommand,
} from "./inventory-api";
import type { InventoryOverviewResponse } from "./inventory-contracts";
import { InventoryPage } from "./inventory-page";

vi.mock("./inventory-api", () => ({
  loadInventoryOverview: vi.fn(),
  lookupInventoryBarcode: vi.fn(),
  newInventoryActionKey: (kind: string) => `inventory:${kind}:test`,
  recordInventoryScan: vi.fn(),
  submitInventoryCommand: vi.fn(),
}));

const opsSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_ops",
    email: "ops@ironwrapexteriors.com",
    display_name: "Operations",
    role: "ops",
    frappe_user_id: "ops@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2036-08-20T09:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const overview: InventoryOverviewResponse = {
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  allowed_transitions: [
    "receive",
    "reserve",
    "release_reservation",
    "issue_use",
    "return",
    "transfer",
    "quarantine",
    "release_quarantine",
    "count_freeze",
    "count_adjustment",
    "yield",
    "reversal",
  ],
  authority_ref: "Authority-Inventory-Readback-01",
  policy_ref: "policy:inventory-command",
  policy_version: "1",
  authority: {
    authority_ref: "Authority-Inventory-Readback-01",
    authority_record_id: "Authority-Inventory-0001",
    authority_version: 1,
    observed_at: "2026-08-20T09:00:00.000Z",
    verification_state: "verified",
  },
  summary: {
    position_count: 2,
    item_count: 1,
    quantity_scaled: 15,
    reserved_scaled: 2,
    quarantined_scaled: 1,
    value_minor: 7500,
    quantity_by_uom: [
      {
        uom_id: "uom_each_0001",
        uom_code: "EA",
        uom_scale: 0,
        quantity_scaled: 15,
        reserved_scaled: 2,
        quarantined_scaled: 1,
      },
    ],
    value_by_currency: [{ currency: "CAD", value_minor: 7500 }],
  },
  items: [
    {
      item_id: "item_panel_001",
      item_code: "PANEL-24",
      status: "active",
      item_kind: "raw_material",
      base_uom_id: "uom_each_0001",
      base_uom_code: "EA",
      base_uom_dimension: "count",
      base_uom_scale: 0,
      quantity_scale: 0,
      lot_controlled: 1,
      valuation_method: "actual",
    },
  ],
  positions: [
    {
      position_id: "pos_panel_a001",
      item_id: "item_panel_001",
      item_code: "PANEL-24",
      item_kind: "raw_material",
      lot_id: "lot_panel_0001",
      lot_code: "L-0001",
      lot_status: "available",
      lot_kind: "receipt",
      parent_lot_id: null,
      bin_id: "bin_stock_a01",
      bin_code: "A1",
      location_code: "WH1",
      location_name: "Warehouse",
      job_custody: "-",
      uom_id: "uom_each_0001",
      uom_code: "EA",
      uom_dimension: "count",
      uom_scale: 0,
      quantity_scale: 0,
      quantity_scaled: 10,
      reserved_scaled: 2,
      quarantined_scaled: 1,
      value_minor: 5000,
      currency: "CAD",
      version: 1,
      last_event_id: "event_inventory_0001",
      updated_at: "2026-08-20T09:00:00.000Z",
    },
    {
      position_id: "pos_panel_b001",
      item_id: "item_panel_001",
      item_code: "PANEL-24",
      item_kind: "raw_material",
      lot_id: "lot_panel_0001",
      lot_code: "L-0001",
      lot_status: "available",
      lot_kind: "receipt",
      parent_lot_id: null,
      bin_id: "bin_stock_b01",
      bin_code: "B1",
      location_code: "WH1",
      location_name: "Warehouse",
      job_custody: "-",
      uom_id: "uom_each_0001",
      uom_code: "EA",
      uom_dimension: "count",
      uom_scale: 0,
      quantity_scale: 0,
      quantity_scaled: 5,
      reserved_scaled: 0,
      quarantined_scaled: 0,
      value_minor: 2500,
      currency: "CAD",
      version: 1,
      last_event_id: "event_inventory_0002",
      updated_at: "2026-08-20T09:00:00.000Z",
    },
    {
      position_id: "pos_panel_remnant001",
      item_id: "item_panel_001",
      item_code: "PANEL-24",
      item_kind: "raw_material",
      lot_id: "lot_panel_remnant001",
      lot_code: "REMNANT-0001",
      lot_status: "available",
      lot_kind: "remnant",
      parent_lot_id: "lot_panel_0001",
      bin_id: "bin_stock_b01",
      bin_code: "B1",
      location_code: "WH1",
      location_name: "Warehouse",
      job_custody: "-",
      uom_id: "uom_each_0001",
      uom_code: "EA",
      uom_dimension: "count",
      uom_scale: 0,
      quantity_scale: 0,
      quantity_scaled: 0,
      reserved_scaled: 0,
      quarantined_scaled: 0,
      value_minor: 0,
      currency: "CAD",
      version: 1,
      last_event_id: "event_inventory_0003",
      updated_at: "2026-08-20T09:00:00.000Z",
    },
  ],
  valuation_layers: [
    {
      layer_id: "layer_panel_0001",
      item_id: "item_panel_001",
      item_code: "PANEL-24",
      lot_id: "lot_panel_0001",
      lot_code: "L-0001",
      uom_code: "EA",
      uom_scale: 0,
      layer_kind: "receipt",
      quantity_scaled: 10,
      remaining_scaled: 10,
      unit_cost_minor: 500,
      value_minor: 5000,
      currency: "CAD",
      method: "actual",
    },
  ],
  uom_conversions: [],
  recent_scans: [],
};

function renderPage(session: AuthenticatedSession = opsSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <InventoryPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

type GuidedTransition = (typeof overview.allowed_transitions)[number];

async function submitGuidedTransitions(transitions: readonly GuidedTransition[]) {
  const user = userEvent.setup({ delay: null });
  vi.mocked(submitInventoryCommand).mockClear();
  renderPage();
  await screen.findByRole("heading", { name: "Inventory" });
  await user.click(screen.getAllByRole("button", { name: "Use as source" })[0]!);
  expect(await screen.findByRole("form", { name: "Record warehouse action" })).toBeVisible();

  for (const transition of transitions) {
    await user.selectOptions(screen.getByLabelText("What happened?"), transition);
    if (["transfer", "yield", "reversal"].includes(transition)) {
      if (transition !== "reversal") {
        await user.selectOptions(
          screen.getByLabelText(transition === "transfer" ? "Move to" : "Usable output position"),
          transition === "yield" ? "pos_panel_remnant001" : "pos_panel_b001",
        );
      }
    }
    if (transition === "count_adjustment") {
      await user.clear(screen.getByLabelText(/^Counted quantity/));
      await user.type(screen.getByLabelText(/^Counted quantity/), "9");
      await user.clear(screen.getByLabelText(/^Approved count variance reference/));
      await user.type(screen.getByLabelText(/^Approved count variance reference/), "approval-0001");
    } else if (transition !== "count_freeze" && transition !== "reversal") {
      const quantityLabel =
        transition === "receive"
          ? "Received quantity"
          : transition === "reserve"
            ? "Quantity to reserve"
            : transition === "release_reservation"
              ? "Quantity to release"
              : transition === "issue_use"
                ? "Quantity used"
                : transition === "return"
                  ? "Quantity returned"
                  : transition === "transfer"
                    ? "Quantity to move"
                    : transition === "quarantine"
                      ? "Quantity to quarantine"
                      : transition === "release_quarantine"
                        ? "Quantity to release"
                        : transition === "yield"
                          ? "Quantity yielded"
                          : "Quantity to reverse";
      await user.clear(screen.getByLabelText(new RegExp(`^${quantityLabel}`)));
      await user.type(screen.getByLabelText(new RegExp(`^${quantityLabel}`)), "1");
    }
    if (["receive", "return", "count_adjustment"].includes(transition)) {
      await user.clear(screen.getByLabelText(/^Unit cost \(CAD\)/));
      await user.type(screen.getByLabelText(/^Unit cost \(CAD\)/), "5.00");
    }
    if (transition === "receive") {
      await user.type(screen.getByLabelText("Receipt reference"), "receipt-0001");
      await user.type(screen.getByLabelText("Purchase-order line"), "po-line-0001");
    }
    if (transition === "reserve") {
      await user.type(screen.getByLabelText("Roofing job"), "job-0001");
    }
    if (transition === "release_reservation") {
      await user.type(screen.getByLabelText("Reservation reference"), "reservation-0001");
    }
    if (transition === "count_adjustment") {
      await user.type(screen.getByLabelText("Approved count session"), "count-session-0001");
    }
    if (transition === "release_quarantine") {
      await user.type(screen.getByLabelText(/^Approval reference/), "approval-0001");
    }
    if (transition === "reversal") {
      await user.clear(screen.getByLabelText("Action being reversed"));
      await user.type(screen.getByLabelText("Action being reversed"), "command-0001");
    }
    await user.clear(screen.getByLabelText("Evidence reference"));
    await user.clear(screen.getByLabelText("Evidence SHA-256"));
    await user.type(screen.getByLabelText("Evidence reference"), `evidence:${transition}`);
    await user.type(screen.getByLabelText("Evidence SHA-256"), "a".repeat(64));
    fireEvent.submit(screen.getByRole("form", { name: "Record warehouse action" }));
    expect(await screen.findByText("Action complete")).toBeVisible();
  }
  expect(submitInventoryCommand).toHaveBeenCalledTimes(transitions.length);
  expect(vi.mocked(submitInventoryCommand).mock.calls.map((call) => call[1].transition)).toEqual(
    transitions,
  );
}

describe("InventoryPage", () => {
  beforeEach(() => {
    vi.mocked(loadInventoryOverview).mockReset().mockResolvedValue(overview);
    vi.mocked(lookupInventoryBarcode)
      .mockReset()
      .mockResolvedValue({
        version: 1,
        barcode: "LOT-0001-BARCODE",
        result: {
          barcode: "LOT-0001-BARCODE",
          symbology: "code128",
          entity_type: "lot",
          entity_id: "lot_panel_0001",
          item_code: "PANEL-24",
          lot_code: "L-0001",
          bin_code: "A1",
          location_code: "WH1",
        },
      });
    vi.mocked(recordInventoryScan)
      .mockReset()
      .mockResolvedValue({
        version: 1,
        kind: "recorded",
        scan: {
          scan_id: "scan_inventory_0001",
          tenant_id: "ironwrap",
          device_id: "pwa:appu_ops",
          device_action_id: "inventory:scan-action:test",
          actor_user_id: "appu_ops",
          barcode: "LOT-0001-BARCODE",
          scan_intent: "lookup",
          request_fingerprint_sha256: "a".repeat(64),
          observed_at: "2026-08-20T09:00:00.000Z",
          captured_offline: 0,
          resolution: "resolved",
          resolved_entity_type: "lot",
          resolved_entity_id: "lot_panel_0001",
          command_id: null,
          exception_id: null,
          payload_json: "{}",
          created_at: "2026-08-20T09:00:00.000Z",
        },
      });
    vi.mocked(submitInventoryCommand)
      .mockReset()
      .mockResolvedValue({
        version: 1,
        kind: "applied",
        command: {
          command_id: "inventory:command:test",
          tenant_id: "ironwrap",
          transition: "receive",
          actor_type: "worker",
          actor_user_id: "appu_ops",
          authority_ref: "Authority-Inventory-Readback-01",
          policy_ref: "policy:inventory-command",
          policy_version: "1",
          idempotency_key_sha256: "a".repeat(64),
          request_fingerprint_sha256: "b".repeat(64),
          approval_id: null,
          evidence_refs_json: "[]",
          payload_json: "{}",
          status: "applied",
          result_json: "{}",
          rejection_code: null,
          created_at: "2026-08-20T09:00:00.000Z",
          updated_at: "2026-08-20T09:00:00.000Z",
          completed_at: "2026-08-20T09:00:00.000Z",
        },
        eventIds: [],
      });
  });

  it("shows the server authority, policy, positions, and role transitions", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Inventory" })).toBeVisible();
    expect(screen.getByText("Authority-Inventory-Readback-01")).toBeVisible();
    expect(screen.getByText("policy:inventory-command")).toBeVisible();
    expect(screen.getAllByText("PANEL-24")[0]).toBeVisible();
    expect(screen.getAllByText("Warehouse")[0]).toBeVisible();
    expect(screen.getByText(/EA available/)).toBeVisible();
    expect(screen.getByRole("option", { name: "Receive" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Issue for use" })).toBeVisible();
    expect(screen.queryByText("pos_panel_a001")).not.toBeInTheDocument();
    expect(screen.queryByText("layer_panel_0001")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record scan" })).toBeEnabled();
  });

  it("resolves a barcode and reports the duplicate-safe scan outcome", async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();

    await screen.findByRole("heading", { name: "Inventory" });
    await user.type(screen.getByLabelText("Barcode"), "LOT-0001-BARCODE");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Barcode resolved")).toBeVisible();
    expect(lookupInventoryBarcode).toHaveBeenCalledWith(
      expect.objectContaining({ authenticated: true }),
      "LOT-0001-BARCODE",
    );

    await user.click(screen.getByRole("button", { name: "Record scan" }));
    expect(await screen.findByText("Scan complete")).toBeVisible();
    expect(recordInventoryScan).toHaveBeenCalledOnce();
  });

  it("uses barcode selection and guided evidence for inbound and issue transitions", async () => {
    await submitGuidedTransitions(["receive", "reserve", "release_reservation", "issue_use"]);
  }, 20_000);

  it("uses barcode selection and guided evidence for return, transfer, and quarantine", async () => {
    await submitGuidedTransitions(["return", "transfer", "quarantine", "release_quarantine"]);
  }, 20_000);

  it("uses barcode selection and guided evidence for count, yield, and reversal", async () => {
    await submitGuidedTransitions(["count_freeze", "count_adjustment", "yield", "reversal"]);
  }, 20_000);

  it("omits transitions the field role cannot perform", async () => {
    const fieldSession = {
      ...opsSession,
      user: { ...opsSession.user, id: "appu_field", display_name: "Field", role: "field" },
    } satisfies AuthenticatedSession;
    vi.mocked(loadInventoryOverview).mockResolvedValueOnce({
      ...overview,
      allowed_transitions: ["issue_use", "return", "quarantine"],
    });
    renderPage(fieldSession);
    await screen.findByRole("heading", { name: "Inventory" });
    expect(screen.getByRole("option", { name: "Issue for use" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Receive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Release quarantine" })).not.toBeInTheDocument();
  });

  it("retries an uncertain command with the same idempotency key and exact input", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(submitInventoryCommand)
      .mockReset()
      .mockRejectedValueOnce(
        new ApiError({ message: "gateway timeout", status: 503, code: "gateway_timeout" }),
      )
      .mockResolvedValue({
        version: 1,
        kind: "applied",
        command: {
          command_id: "inventory:command:test",
          tenant_id: "ironwrap",
          transition: "receive",
          actor_type: "worker",
          actor_user_id: "appu_ops",
          authority_ref: "Authority-Inventory-Readback-01",
          policy_ref: "policy:inventory-command",
          policy_version: "1",
          idempotency_key_sha256: "a".repeat(64),
          request_fingerprint_sha256: "b".repeat(64),
          approval_id: null,
          evidence_refs_json: "[]",
          payload_json: "{}",
          status: "applied",
          result_json: "{}",
          rejection_code: null,
          created_at: "2026-08-20T09:00:00.000Z",
          updated_at: "2026-08-20T09:00:00.000Z",
          completed_at: "2026-08-20T09:00:00.000Z",
        },
        eventIds: [],
      });
    renderPage();
    await screen.findByRole("heading", { name: "Inventory" });
    await user.click(screen.getAllByRole("button", { name: "Use as source" })[0]!);
    await user.clear(screen.getByLabelText(/^Received quantity/));
    await user.type(screen.getByLabelText(/^Received quantity/), "1");
    await user.clear(screen.getByLabelText(/^Unit cost \(CAD\)/));
    await user.type(screen.getByLabelText(/^Unit cost \(CAD\)/), "5.00");
    await user.type(screen.getByLabelText("Receipt reference"), "receipt-retry");
    await user.type(screen.getByLabelText("Purchase-order line"), "po-line-retry");
    await user.type(screen.getByLabelText("Evidence reference"), "evidence:retry");
    await user.type(screen.getByLabelText("Evidence SHA-256"), "a".repeat(64));

    fireEvent.submit(screen.getByRole("form", { name: "Record warehouse action" }));
    expect(await screen.findByText("Action outcome uncertain")).toBeVisible();
    const firstCall = vi.mocked(submitInventoryCommand).mock.calls[0]!;
    fireEvent.submit(screen.getByRole("form", { name: "Record warehouse action" }));
    expect(await screen.findByText("Action complete")).toBeVisible();
    const secondCall = vi.mocked(submitInventoryCommand).mock.calls[1]!;
    expect(secondCall[1]).toBe(firstCall[1]);
    expect(secondCall[2]).toBe(firstCall[2]);
  });
});
