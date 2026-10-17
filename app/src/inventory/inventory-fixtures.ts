import type { InventoryCommandResponse, InventoryOverviewResponse } from "./inventory-contracts";

// Synthetic stock fixtures for browser specs. One lot in one bin, every transition allowed, and an
// authority that reads back as verified, so the desk is open for a stock action. Nothing here is a
// real material, lot, price or person.

export const FIXTURE_LOT_ID = "lot_panel_0001";

export function inventoryOverview(): InventoryOverviewResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_transitions: ["receive", "issue_use", "return", "quarantine", "reversal"],
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
      position_count: 1,
      item_count: 1,
      quantity_scaled: 10,
      reserved_scaled: 0,
      quarantined_scaled: 0,
      value_minor: 5000,
      quantity_by_uom: [
        {
          uom_id: "uom_each_0001",
          uom_code: "EA",
          uom_scale: 0,
          quantity_scaled: 10,
          reserved_scaled: 0,
          quarantined_scaled: 0,
        },
      ],
      value_by_currency: [{ currency: "CAD", value_minor: 5000 }],
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
        lot_id: FIXTURE_LOT_ID,
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
        reserved_scaled: 0,
        quarantined_scaled: 0,
        value_minor: 5000,
        currency: "CAD",
        version: 1,
        last_event_id: "event_inventory_0001",
        updated_at: "2026-08-20T09:00:00.000Z",
      },
    ],
    valuation_layers: [],
    uom_conversions: [],
    recent_scans: [],
  };
}

export function appliedCommandResponse(commandId: string): InventoryCommandResponse {
  return {
    version: 1,
    kind: "applied",
    command: {
      command_id: commandId,
      tenant_id: "ironwrap",
      transition: "issue_use",
      actor_type: "worker",
      actor_user_id: "appu_acceptance_owner",
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
  };
}
