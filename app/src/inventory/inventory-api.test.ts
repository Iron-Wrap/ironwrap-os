import { describe, expect, it } from "vitest";

import { accountingSession } from "../accounting/money-fixtures";
import {
  loadInventoryOverview,
  lookupInventoryBarcode,
  newInventoryActionKey,
  recordInventoryScan,
  submitInventoryCommand,
} from "./inventory-api";
import { inventoryOverviewResponseSchema } from "./inventory-contracts";

function recordingFetch(body: unknown): {
  fetcher: typeof fetch;
  calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown> | null;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown> | null;
  }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const overview = {
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  allowed_transitions: ["receive", "issue_use", "return", "quarantine"],
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
  items: [],
  positions: [],
  valuation_layers: [],
  uom_conversions: [],
  recent_scans: [],
};

const command = {
  command_id: "cmd_inventory_0001",
  tenant_id: "ironwrap",
  transition: "receive",
  actor_type: "worker",
  actor_user_id: "appu_ops_000000001",
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
};

describe("inventory API client", () => {
  it("loads the tenant-scoped overview and preserves the server authority contract", async () => {
    const { fetcher, calls } = recordingFetch(overview);
    const response = await loadInventoryOverview(fetcher);
    expect(calls[0]?.url).toBe("/api/v1/inventory/overview");
    expect(response.authority_ref).toBe("Authority-Inventory-Readback-01");
    expect(response.policy_ref).toBe("policy:inventory-command");
    expect(inventoryOverviewResponseSchema.safeParse(response).success).toBe(true);
  });

  it("encodes barcode lookup input rather than trusting it in a path or query", async () => {
    const { fetcher, calls } = recordingFetch({
      version: 1,
      barcode: "LOT A/1",
      result: null,
    });
    await lookupInventoryBarcode("LOT A/1", fetcher);
    expect(calls[0]?.url).toBe("/api/v1/inventory/lookup?barcode=LOT%20A%2F1");
  });

  it("sends CSRF, idempotency, and a body fingerprint for commands", async () => {
    const { fetcher, calls } = recordingFetch({
      version: 1,
      kind: "applied",
      command,
      eventIds: [],
    });
    const session = accountingSession("ops");
    const key = newInventoryActionKey("receive");
    await submitInventoryCommand(
      session,
      {
        command_id: "cmd_inventory_0001",
        idempotency_key: key,
        transition: "receive",
        authority_ref: "Authority-Inventory-Readback-01",
        policy_ref: "policy:inventory-command",
        policy_version: "1",
        evidence_refs: [
          { ref: "r2://inventory-evidence/ironwrap/receipt", sha256: "a".repeat(64) },
        ],
        source_position_id: "pos_inventory_0001",
        item_id: "item_panel_001",
        lot_id: "lot_panel_0001",
        bin_id: "bin_stock_a01",
        uom_id: "uom_each_0001",
        quantity_scaled: 1,
        unit_cost_minor: 500,
        receipt_id: "receipt_inventory_0001",
        po_line_id: "po_line_inventory_0001",
      },
      key,
      fetcher,
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("X-CSRF-Token")).toBe("csrf");
    expect(calls[0]?.headers.get("Idempotency-Key")).toBe(key);
    expect(calls[0]?.body).toMatchObject({
      command_id: "cmd_inventory_0001",
      authority_ref: "Authority-Inventory-Readback-01",
      policy_ref: "policy:inventory-command",
      policy_version: "1",
    });
    expect(calls[0]?.body?.request_fingerprint_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("sends CSRF and the device action identity for duplicate-safe scans", async () => {
    const { fetcher, calls } = recordingFetch({
      version: 1,
      kind: "recorded",
      scan: {
        scan_id: "scan_inventory_0001",
        tenant_id: "ironwrap",
        device_id: "pwa-device-1",
        device_action_id: "inventory-scan-action-1",
        actor_user_id: "appu_ops_000000001",
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
    await recordInventoryScan(
      accountingSession("ops"),
      {
        scan_id: "scan_inventory_0001",
        device_id: "pwa-device-1",
        device_action_id: "inventory-scan-action-1",
        barcode: "LOT-0001-BARCODE",
        scan_intent: "lookup",
        observed_at: "2026-08-20T09:00:00.000Z",
        captured_offline: false,
      },
      fetcher,
    );
    expect(calls[0]?.headers.get("X-CSRF-Token")).toBe("csrf");
    expect(calls[0]?.headers.get("X-Device-Action-Id")).toBe("inventory-scan-action-1");
    expect(calls[0]?.body?.request_fingerprint_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
