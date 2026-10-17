import { afterEach, describe, expect, it, vi } from "vitest";

import { accountingSession } from "../accounting/money-fixtures";
import type { AuthenticatedSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { receiptIdFor } from "../evidence/evidence-test-harness";
import { resetDatabaseForTests } from "../storage/db";
import { getOutboxActionWithBlobs } from "../storage/outbox";
import {
  loadInventoryCommand,
  loadInventoryOverview,
  lookupInventoryBarcode,
  newInventoryActionKey,
  queueInventoryCommand,
  recordInventoryScan,
  submitInventoryCommand,
} from "./inventory-api";
import { inventoryOverviewResponseSchema } from "./inventory-contracts";

vi.mock("../auth/device-credential", () => ({
  getDeviceSecret: vi.fn(async () => "d".repeat(43)),
}));

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

afterEach(async () => {
  await resetDatabaseForTests();
});

describe("inventory API client", () => {
  it("loads the tenant-scoped overview and preserves the server authority contract", async () => {
    const { fetcher, calls } = recordingFetch(overview);
    const response = await loadInventoryOverview(accountingSession("ops"), fetcher);
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
    await lookupInventoryBarcode(accountingSession("ops"), "LOT A/1", fetcher);
    expect(calls[0]?.url).toBe("/api/v1/inventory/lookup?barcode=LOT%20A%2F1");
  });

  const stockInput = (key: string) =>
    ({
      command_id: "cmd_inventory_0001",
      idempotency_key: key,
      transition: "receive",
      authority_ref: "Authority-Inventory-Readback-01",
      policy_ref: "policy:inventory-command",
      policy_version: "1",
      source_position_id: "pos_inventory_0001",
      item_id: "item_panel_001",
      lot_id: "lot_panel_0001",
      bin_id: "bin_stock_a01",
      uom_id: "uom_each_0001",
      quantity_scaled: 1,
      unit_cost_minor: 500,
      receipt_id: "receipt_inventory_0001",
      po_line_id: "po_line_inventory_0001",
    }) as const;

  it("sends CSRF, idempotency and the receipt ids of the uploaded files for commands", async () => {
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
      stockInput(key),
      key,
      [receiptIdFor(1), receiptIdFor(2)],
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
      // The business receipt reference is the stock action's own; the files are the receipt ids.
      receipt_id: "receipt_inventory_0001",
      evidence_receipt_ids: [receiptIdFor(1), receiptIdFor(2)],
    });
    // The Worker derives the replay fingerprint from the whole action and the stored files, and
    // refuses typed references beside receipt ids, so neither is built here.
    expect(calls[0]?.body).not.toHaveProperty("evidence_refs");
    expect(calls[0]?.body).not.toHaveProperty("request_fingerprint_sha256");
  });

  it("saves a command offline with its files and sends nothing yet", async () => {
    const session = accountingSession("ops");
    const key = newInventoryActionKey("receive");
    const blob = new Blob(["synthetic"], { type: "image/jpeg" });
    await queueInventoryCommand(session, stockInput(key), key, {
      scope: {
        purpose: "stock",
        targetId: "lot_panel_0001",
        action: "receive",
        operationId: "cmd_inventory_0001",
      },
      files: [
        {
          uploadKey: "evidence-key-0001",
          fileName: "dock.jpg",
          mimeType: "image/jpeg",
          size: blob.size,
          blob,
        },
      ],
    });
    const saved = await getOutboxActionWithBlobs(key);
    expect(saved?.action).toMatchObject({
      kind: "inventory_command",
      state: "queued",
      endpoint: "/api/v1/inventory/commands",
      evidence: {
        scope: { purpose: "stock", targetId: "lot_panel_0001", operationId: "cmd_inventory_0001" },
        files: [{ uploadKey: "evidence-key-0001", fileName: "dock.jpg" }],
      },
    });
    expect(saved?.blobs).toHaveLength(1);
    expect(saved?.action.payload).toMatchObject({
      command_id: "cmd_inventory_0001",
      lot_id: "lot_panel_0001",
    });
    expect(saved?.action.payload).not.toHaveProperty("evidence_refs");
    expect(saved?.action.payload).not.toHaveProperty("request_fingerprint_sha256");
    await resetDatabaseForTests();
  });

  it("sends a typed reference from the stock desk as before, never beside receipt ids", async () => {
    const { fetcher, calls } = recordingFetch({
      version: 1,
      kind: "applied",
      command,
      eventIds: [],
    });
    const session = accountingSession("ops");
    const key = newInventoryActionKey("receive");
    const evidence_refs = [{ ref: "r2://synthetic/dock.jpg", sha256: "c".repeat(64) }];
    await submitInventoryCommand(
      session,
      { ...stockInput(key), evidence_refs },
      key,
      undefined,
      fetcher,
    );
    expect(calls[0]?.body).toMatchObject({ command_id: "cmd_inventory_0001", evidence_refs });
    expect(calls[0]?.body?.request_fingerprint_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls[0]?.body).not.toHaveProperty("evidence_receipt_ids");
    // The Worker refuses a typed reference beside receipt ids, so neither goes up.
    await expect(
      submitInventoryCommand(
        session,
        { ...stockInput(key), evidence_refs },
        key,
        [receiptIdFor(1)],
        fetcher,
      ),
    ).rejects.toThrow("not both");
    expect(calls).toHaveLength(1);
  });

  it("saves a typed-reference command offline exactly as it will be sent", async () => {
    const session = accountingSession("ops");
    const key = newInventoryActionKey("receive");
    const evidence_refs = [{ ref: "r2://synthetic/dock.jpg", sha256: "c".repeat(64) }];
    await queueInventoryCommand(session, { ...stockInput(key), evidence_refs }, key);
    const saved = await getOutboxActionWithBlobs(key);
    expect(saved?.action).toMatchObject({ kind: "inventory_command", state: "queued" });
    expect(saved?.action.evidence).toBeUndefined();
    expect(saved?.blobs).toHaveLength(0);
    expect(saved?.action.payload).toMatchObject({
      command_id: "cmd_inventory_0001",
      evidence_refs,
    });
    expect(saved?.action.payload).toHaveProperty(
      "request_fingerprint_sha256",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(saved?.action.payload).not.toHaveProperty("evidence_receipt_ids");
    // With neither files nor a typed reference there is nothing to show for it.
    await expect(
      queueInventoryCommand(
        session,
        stockInput("inventory:receive:none"),
        "inventory:receive:none",
      ),
    ).rejects.toThrow("needs its evidence files");
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

  it("reads one recorded action back with the files attached to it, and a field phone's proof", async () => {
    const files = [
      {
        receipt_id: receiptIdFor(1),
        file_name: "south-eave.jpg",
        content_type: "image/jpeg",
        byte_size: 2_202_009,
      },
    ];
    const { fetcher, calls } = recordingFetch({ version: 1, command, evidence_files: files });
    const detail = await loadInventoryCommand(fieldSession(), "cmd inventory/0001", fetcher);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("/api/v1/inventory/commands/cmd%20inventory%2F0001");
    expect(calls[0]?.headers.get("X-IronWrap-Device-Proof")).toBe("d".repeat(43));
    expect(detail.evidence_files).toEqual(files);
  });

  it("reads an action from a Worker that does not list files yet", async () => {
    const { fetcher } = recordingFetch({ version: 1, command });
    const detail = await loadInventoryCommand(
      accountingSession("ops"),
      "cmd_inventory_0001",
      fetcher,
    );
    expect(detail.evidence_files).toBeUndefined();
  });

  it("refuses a file list with anything beyond the four fields the contract names", async () => {
    const { fetcher } = recordingFetch({
      version: 1,
      command,
      evidence_files: [
        {
          receipt_id: receiptIdFor(1),
          file_name: "south-eave.jpg",
          content_type: "image/jpeg",
          byte_size: 2_202_009,
          r2_key: "evidence/tenant/object",
        },
      ],
    });
    await expect(
      loadInventoryCommand(accountingSession("ops"), "cmd_inventory_0001", fetcher),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  // Inventory is one of the four surfaces a crew phone carries. A field session is only
  // authenticated when the request presents its device proof; without it the Worker
  // answers 401 AND expires the session cookie, so opening Inventory signed the paired
  // phone out and the next cold start demanded re-pairing (ELEC-157).
  it("sends the paired-device proof on a field session's inventory read", async () => {
    const { fetcher, calls } = recordingFetch(overview);
    await loadInventoryOverview(fieldSession(), fetcher);
    expect(getDeviceSecret).toHaveBeenCalled();
    expect(calls[0]?.headers.get("X-IronWrap-Device-Proof")).toBe("d".repeat(43));
  });

  it("sends no device proof on an office session, which has none to send", async () => {
    const { fetcher, calls } = recordingFetch(overview);
    await loadInventoryOverview(accountingSession("ops"), fetcher);
    expect(calls[0]?.headers.get("X-IronWrap-Device-Proof")).toBeNull();
  });
});

function fieldSession(): AuthenticatedSession {
  return {
    ...accountingSession("ops"),
    user: {
      id: "appu_field",
      email: "crew@example.invalid",
      display_name: "Cody Crew",
      role: "field",
      frappe_user_id: "crew@example.invalid",
    },
  };
}
