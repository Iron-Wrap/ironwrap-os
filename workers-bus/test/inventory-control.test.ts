import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  applyInventoryCommand,
  appliedLedgerTotals,
  classifyReceiptException,
  classifyThreeWayMatch,
  convertQuantity,
  getInventoryPosition,
  InventoryLedgerError,
  inventoryTotals,
  planValuationDraw,
  recordInventoryScan,
  SHARED_CUSTODY,
  type ApplyInventoryCommandInput,
} from "../src/inventory-control.ts";
import type { AppEnv } from "../src/app-types.ts";

const TENANT = "ironwrap";
const NOW = "2026-08-17T12:00:00.000Z";
const RECEIVER = "appu_ops_receiver_01";
const COUNTER = "appu_ops_counter_001";
const APPROVER = "appu_ops_approver_01";
const FINANCE = "appu_own_finance_001";
const FINGERPRINT = "a".repeat(64);

const UOM_EACH = "uom_each_0001";
const UOM_BUNDLE = "uom_bundle_01";
const ITEM_PANEL = "item_panel_001";
const ITEM_SCREW = "item_screw_001";
const BIN_A = "bin_stock_a01";
const BIN_B = "bin_stock_b01";
const BIN_Q = "bin_quar_a001";
const LOT_ONE = "lot_panel_0001";
const LOT_TWO = "lot_panel_0002";
const LOT_SCREW_A = "lot_screw_0001";
const LOT_SCREW_B = "lot_screw_0002";
const POS_A = "pos_panel_a001";
const POS_B = "pos_panel_b001";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    // The full chain, so the harness sees the same schema production does - including
    // the 0038 access_role column the inventory actor guards resolve against.
    for (const migration of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    const users = this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role,
          frappe_user_id, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    for (const [id, email, name, role] of [
      [RECEIVER, "receiver@example.invalid", "Receiver", "ops"],
      [COUNTER, "counter@example.invalid", "Counter", "ops"],
      [APPROVER, "approver@example.invalid", "Approver", "ops"],
      [FINANCE, "finance@example.invalid", "Finance", "owner"],
    ] as const) {
      users.run(id, TENANT, email, name, role, role, email, NOW, NOW);
    }
    this.seedMasterData();
  }

  private seedMasterData(): void {
    const uom = this.raw.prepare(
      `INSERT INTO inventory_uoms (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
    );
    uom.run(UOM_EACH, TENANT, "EA", "count", NOW, NOW);
    uom.run(UOM_BUNDLE, TENANT, "BDL", "count", NOW, NOW);
    this.raw.prepare(
      `INSERT INTO inventory_uom_conversions
         (conversion_id, tenant_id, from_uom_id, to_uom_id, numerator, denominator, dimension,
          status, effective_from, source_ref, created_at)
       VALUES ('conv_bdl_ea01', ?, ?, ?, 12, 1, 'count', 'active', ?, 'supplier-catalogue', ?)`,
    ).run(TENANT, UOM_BUNDLE, UOM_EACH, NOW, NOW);

    const item = this.raw.prepare(
      `INSERT INTO inventory_items
         (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale,
          lot_controlled, valuation_method, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'raw_material', ?, 0, ?, ?, 'seed', ?, ?)`,
    );
    item.run(ITEM_PANEL, TENANT, "PANEL-24", UOM_EACH, 1, "actual", NOW, NOW);
    item.run(ITEM_SCREW, TENANT, "SCREW-10", UOM_EACH, 0, "fifo", NOW, NOW);

    this.raw.prepare(
      `INSERT INTO inventory_locations
         (location_id, tenant_id, location_code, name, location_kind, status, source_ref, created_at, updated_at)
       VALUES ('loc_wh_000001', ?, 'WH1', 'Warehouse', 'warehouse', 'active', 'seed', ?, ?)`,
    ).run(TENANT, NOW, NOW);

    const bin = this.raw.prepare(
      `INSERT INTO inventory_bins
         (bin_id, tenant_id, location_id, bin_code, bin_kind, status, created_at, updated_at)
       VALUES (?, ?, 'loc_wh_000001', ?, ?, 'active', ?, ?)`,
    );
    bin.run(BIN_A, TENANT, "A1", "stock", NOW, NOW);
    bin.run(BIN_B, TENANT, "B1", "stock", NOW, NOW);
    bin.run(BIN_Q, TENANT, "Q1", "quarantine", NOW, NOW);

    const lot = this.raw.prepare(
      `INSERT INTO inventory_lots
         (lot_id, tenant_id, item_id, lot_code, lot_kind, status, unit_cost_minor,
          evidence_refs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    );
    lot.run(LOT_ONE, TENANT, ITEM_PANEL, "L-0001", "purchased", "available", 500, NOW, NOW);
    lot.run(LOT_TWO, TENANT, ITEM_PANEL, "L-0002", "purchased", "available", 700, NOW, NOW);
    lot.run(LOT_SCREW_A, TENANT, ITEM_SCREW, "S-0001", "purchased", "available", 10, NOW, NOW);
    lot.run(LOT_SCREW_B, TENANT, ITEM_SCREW, "S-0002", "purchased", "available", 14, NOW, NOW);

    this.raw.prepare(
      `INSERT INTO inventory_barcodes
         (barcode_id, tenant_id, barcode, symbology, entity_type, entity_id, status, created_at)
       VALUES ('bc_lot_000001', ?, 'LOT-0001-BARCODE', 'code128', 'lot', ?, 'active', ?)`,
    ).run(TENANT, LOT_ONE, NOW);
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never } as AppEnv;
}

function command(
  overrides: Partial<ApplyInventoryCommandInput> & Pick<ApplyInventoryCommandInput, "commandId" | "transition" | "movements">,
): ApplyInventoryCommandInput {
  return {
    tenantId: TENANT,
    actorType: "worker",
    actorUserId: RECEIVER,
    authorityRef: "assignment:inventory",
    policyRef: "policy:inventory",
    policyVersion: "v1",
    idempotencyKey: overrides.commandId,
    requestFingerprintSha256: FINGERPRINT,
    evidenceRefs: [{ ref: "r2://evidence/receipt", sha256: "b".repeat(64) }],
    payload: {},
    now: NOW,
    ...overrides,
  };
}

/** Receive `quantity` of LOT_ONE at `unitCost` into bin A, opening the position. */
async function seedReceipt(
  appEnv: AppEnv,
  options: { commandId: string; quantity: number; unitCost: number; freight?: number },
) {
  const freight = options.freight ?? 0;
  return await applyInventoryCommand(
    appEnv,
    command({
      commandId: options.commandId,
      transition: "receive",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: options.quantity,
          valueDelta: options.unitCost * options.quantity + freight,
        },
      ],
      layers: [
        {
          layerId: `${options.commandId}.layer`,
          movementIndex: 0,
          layerKind: "receipt",
          unitCostMinor: options.unitCost,
          freightMinor: freight,
        },
      ],
    }),
  );
}

test("a receipt opens the position, creates its valuation layer, and conserves the ledger", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const result = await seedReceipt(appEnv, {
    commandId: "cmd_receive_0001",
    quantity: 10,
    unitCost: 500,
    freight: 250,
  });
  assert.equal(result.kind, "applied");
  assert.equal(result.kind === "applied" && result.command.status, "applied");

  const position = await getInventoryPosition(appEnv, TENANT, POS_A);
  assert.equal(position?.quantity_scaled, 10);
  assert.equal(position?.value_minor, 5250);
  assert.equal(position?.version, 1);
  assert.equal(position?.job_custody, SHARED_CUSTODY);

  const layer = db.raw
    .prepare("SELECT * FROM inventory_valuation_layers WHERE layer_id = ?")
    .get("cmd_receive_0001.layer") as {
      quantity_scaled: number;
      remaining_scaled: number;
      unit_cost_minor: number;
      value_minor: number;
      freight_minor: number;
    };
  assert.equal(layer.quantity_scaled, 10);
  assert.equal(layer.remaining_scaled, 10);
  assert.equal(layer.unit_cost_minor, 500);
  assert.equal(layer.freight_minor, 250);
  assert.equal(layer.value_minor, 5250);

  // Quantity in equals quantity out: the projection is exactly the applied movements.
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5250,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5250,
  });
});

test("an identical retry replays the same command and never doubles stock", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });
  const replay = await seedReceipt(appEnv, {
    commandId: "cmd_receive_0001",
    quantity: 10,
    unitCost: 500,
  });

  assert.equal(replay.kind, "replayed");
  const position = await getInventoryPosition(appEnv, TENANT, POS_A);
  assert.equal(position?.quantity_scaled, 10);
  assert.equal(position?.version, 1);
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
});

test("a direct inventory command cannot claim an upload receipt without its scoped manifest", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await assert.rejects(
    applyInventoryCommand(appEnv, command({
      commandId: "cmd_reserved_evidence_0001",
      transition: "receive",
      evidenceRefs: [{ ref: `evidence-upload://evu_${"a".repeat(64)}`, sha256: "a".repeat(64) }],
      movements: [{
        positionId: POS_A,
        itemId: ITEM_PANEL,
        lotId: LOT_ONE,
        binId: BIN_A,
        uomId: UOM_EACH,
        jobCustody: SHARED_CUSTODY,
        quantityDelta: 1,
        valueDelta: 500,
      }],
    })),
    (error: unknown) => error instanceof InventoryLedgerError && error.code === "inventory_evidence_manifest_required",
  );
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM inventory_commands").get() as { n: number }).n, 0);
});

test("the same idempotency key with a different request is a conflict, not an apply", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const conflicting = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_receive_0009",
      idempotencyKey: "cmd_receive_0001",
      requestFingerprintSha256: "c".repeat(64),
      transition: "receive",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 5,
          valueDelta: 2500,
        },
      ],
    }),
  );

  assert.equal(conflicting.kind, "conflict");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 10);
});

test("reserve then issue draws the lot's actual cost and conserves quantity and value", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const reserved = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_reserve_0001",
      transition: "reserve",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 0,
          reservedDelta: 4,
        },
      ],
    }),
  );
  assert.equal(reserved.kind, "applied");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.reserved_scaled, 4);

  const draw = await planValuationDraw(appEnv, {
    tenantId: TENANT,
    itemId: ITEM_PANEL,
    lotId: LOT_ONE,
    quantityScaled: 4,
    method: "actual",
  });
  assert.deepEqual(draw, [
    { layerId: "cmd_receive_0001.layer", quantityScaled: 4, unitCostMinor: 500 },
  ]);

  const issued = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_issue_000001",
      transition: "issue_use",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -4,
          reservedDelta: -4,
          valueDelta: -2000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_issue_0001",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 4,
        },
      ],
    }),
  );
  assert.equal(issued.kind, "applied");

  const position = await getInventoryPosition(appEnv, TENANT, POS_A);
  assert.equal(position?.quantity_scaled, 6);
  assert.equal(position?.reserved_scaled, 0);
  assert.equal(position?.value_minor, 3000);

  const layer = db.raw
    .prepare("SELECT remaining_scaled FROM inventory_valuation_layers WHERE layer_id = ?")
    .get("cmd_receive_0001.layer") as { remaining_scaled: number };
  assert.equal(layer.remaining_scaled, 6);

  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 6,
    value_minor: 3000,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 6,
    value_minor: 3000,
  });
});

test("an issue without a full valuation allocation is refused with an exact code", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_issue_000002",
      transition: "issue_use",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -4,
          valueDelta: -2000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_issue_0002",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 3,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(
    result.kind === "rejected" && result.code,
    "inventory_command_valuation_not_allocated",
  );
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 10);
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
});

test("issuing more than is on hand is refused and leaves no negative or phantom stock", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 3, unitCost: 500 });

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_issue_000003",
      transition: "issue_use",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -5,
          valueDelta: -2500,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_issue_0003",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 5,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" && result.code, "inventory_position_negative_quantity");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 3);
});

test("reserving more than is available is refused as an overcommitment", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 4, unitCost: 500 });

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_reserve_0002",
      transition: "reserve",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 0,
          reservedDelta: 5,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" && result.code, "inventory_position_overcommitted");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.reserved_scaled, 0);
});

test("a transfer must carry both legs; a single leg is refused as unconserved", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const oneLegged = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_transfer_bad1",
      transition: "transfer",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -3,
          valueDelta: -1500,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_xfer_bad01",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 3,
        },
      ],
    }),
  );
  assert.equal(oneLegged.kind, "rejected");
  assert.equal(
    oneLegged.kind === "rejected" && oneLegged.code,
    "inventory_command_quantity_not_conserved",
  );

  const transferred = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_transfer_0001",
      transition: "transfer",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -3,
          valueDelta: -1500,
        },
        {
          positionId: POS_B,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_B,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 3,
          valueDelta: 1500,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_xfer_00001",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 3,
        },
      ],
    }),
  );
  assert.equal(transferred.kind, "applied");

  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 7);
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_B))?.quantity_scaled, 3);
  // Nothing was created or destroyed by moving it.
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
});

test("a transfer whose value does not travel with the goods is refused", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_transfer_bad2",
      transition: "transfer",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -3,
          valueDelta: -1500,
        },
        {
          positionId: POS_B,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_B,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 3,
          valueDelta: 9000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_xfer_bad02",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 3,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" && result.code, "inventory_command_value_not_conserved");
  assert.equal(await getInventoryPosition(appEnv, TENANT, POS_B), null);
});

test("an unused issue is returned to stock and restores the exact quantity and value", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_issue_000001",
      transition: "issue_use",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -4,
          valueDelta: -2000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_issue_0001",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 4,
        },
      ],
    }),
  );
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 6);

  // The unused remainder comes back as its own valuation layer at the cost it left at,
  // so a return can never quietly revalue the stock it restores.
  const returned = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_return_000001",
      transition: "return",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 3,
          valueDelta: 1500,
        },
      ],
      layers: [
        {
          layerId: "cmd_return_000001.layer",
          movementIndex: 0,
          layerKind: "return",
          unitCostMinor: 500,
        },
      ],
    }),
  );
  assert.equal(returned.kind, "applied");

  const position = await getInventoryPosition(appEnv, TENANT, POS_A);
  assert.equal(position?.quantity_scaled, 9);
  assert.equal(position?.value_minor, 4500);

  // 10 received, 4 issued, 3 returned: 9 on hand and the ledger agrees exactly.
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 9,
    value_minor: 4500,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 9,
    value_minor: 4500,
  });

  // A return that claims more value than quantity at the stated unit cost is refused.
  const revalued = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_return_000002",
      transition: "return",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 1,
          valueDelta: 9000,
        },
      ],
      layers: [
        {
          layerId: "cmd_return_000002.layer",
          movementIndex: 0,
          layerKind: "return",
          unitCostMinor: 500,
        },
      ],
    }),
  );
  assert.equal(revalued.kind, "rejected");
  assert.equal(
    revalued.kind === "rejected" && revalued.code,
    "inventory_valuation_layer_value_mismatch",
  );
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 9);
});

test("releasing a reservation returns the commitment without moving any stock", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_reserve_0001",
      transition: "reserve",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 0,
          reservedDelta: 6,
        },
      ],
    }),
  );

  const released = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_release_00001",
      transition: "release_reservation",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 0,
          reservedDelta: -6,
        },
      ],
    }),
  );
  assert.equal(released.kind, "applied");

  const position = await getInventoryPosition(appEnv, TENANT, POS_A);
  assert.equal(position?.reserved_scaled, 0);
  assert.equal(position?.quantity_scaled, 10);
  assert.equal(position?.value_minor, 5000);

  // Releasing more than is held would drive the commitment negative and is refused.
  const overRelease = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_release_00002",
      transition: "release_reservation",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 0,
          reservedDelta: -1,
        },
      ],
    }),
  );
  assert.equal(overRelease.kind, "rejected");
  assert.equal(
    overRelease.kind === "rejected" && overRelease.code,
    "inventory_position_negative_commitment",
  );
});

test("a shop yield conserves quantity and value across parent, remnant and scrap", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  // A remnant and a scrap lot are children of the consumed parent lot.
  const lot = db.raw.prepare(
    `INSERT INTO inventory_lots
       (lot_id, tenant_id, item_id, lot_code, lot_kind, status, parent_lot_id, unit_cost_minor,
        evidence_refs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', ?, ?, '[]', ?, ?)`,
  );
  lot.run("lot_remnant_001", TENANT, ITEM_PANEL, "R-0001", "remnant", LOT_ONE, 500, NOW, NOW);
  lot.run("lot_scrap_00001", TENANT, ITEM_PANEL, "X-0001", "scrap", LOT_ONE, 500, NOW, NOW);

  const yielded = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_yield_000001",
      transition: "yield",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -6,
          valueDelta: -3000,
        },
        {
          positionId: "pos_remnant_001",
          itemId: ITEM_PANEL,
          lotId: "lot_remnant_001",
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 4,
          valueDelta: 2000,
        },
        {
          positionId: "pos_scrap_000001",
          itemId: ITEM_PANEL,
          lotId: "lot_scrap_00001",
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 2,
          valueDelta: 1000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_yield_0001",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 6,
        },
      ],
    }),
  );

  assert.equal(yielded.kind, "applied");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 4);
  assert.equal(
    (await getInventoryPosition(appEnv, TENANT, "pos_remnant_001"))?.quantity_scaled,
    4,
  );
  assert.equal(
    (await getInventoryPosition(appEnv, TENANT, "pos_scrap_000001"))?.quantity_scaled,
    2,
  );
  // 10 in, 10 still accounted for; value unchanged by the conversion.
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
});

test("a yield that loses material is refused rather than absorbed as an unexplained loss", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });
  db.raw.prepare(
    `INSERT INTO inventory_lots
       (lot_id, tenant_id, item_id, lot_code, lot_kind, status, parent_lot_id, unit_cost_minor,
        evidence_refs_json, created_at, updated_at)
     VALUES ('lot_remnant_001', ?, ?, 'R-0001', 'remnant', 'available', ?, 500, '[]', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, LOT_ONE, NOW, NOW);

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_yield_000002",
      transition: "yield",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -6,
          valueDelta: -3000,
        },
        {
          positionId: "pos_remnant_001",
          itemId: ITEM_PANEL,
          lotId: "lot_remnant_001",
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 4,
          valueDelta: 2000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_yield_0002",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 6,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(
    result.kind === "rejected" && result.code,
    "inventory_command_quantity_not_conserved",
  );
});

test("FIFO draws the oldest commodity layers in order and refuses an uncovered issue", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_screw_recv01",
      transition: "receive",
      movements: [
        {
          positionId: "pos_screw_a0001",
          itemId: ITEM_SCREW,
          lotId: LOT_SCREW_A,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 100,
          valueDelta: 1000,
        },
      ],
      layers: [
        {
          layerId: "cmd_screw_recv01.layer",
          movementIndex: 0,
          layerKind: "receipt",
          unitCostMinor: 10,
        },
      ],
    }),
  );
  await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_screw_recv02",
      transition: "receive",
      now: "2026-08-17T13:00:00.000Z",
      movements: [
        {
          positionId: "pos_screw_b0001",
          itemId: ITEM_SCREW,
          lotId: LOT_SCREW_B,
          binId: BIN_B,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: 50,
          valueDelta: 700,
        },
      ],
      layers: [
        {
          layerId: "cmd_screw_recv02.layer",
          movementIndex: 0,
          layerKind: "receipt",
          unitCostMinor: 14,
        },
      ],
    }),
  );

  const draw = await planValuationDraw(appEnv, {
    tenantId: TENANT,
    itemId: ITEM_SCREW,
    lotId: LOT_SCREW_B,
    quantityScaled: 120,
    method: "fifo",
  });
  assert.deepEqual(draw, [
    { layerId: "cmd_screw_recv01.layer", quantityScaled: 100, unitCostMinor: 10 },
    { layerId: "cmd_screw_recv02.layer", quantityScaled: 20, unitCostMinor: 14 },
  ]);

  // 200 exceeds the 150 on hand across both layers, so the draw is refused outright.
  assert.equal(
    await planValuationDraw(appEnv, {
      tenantId: TENANT,
      itemId: ITEM_SCREW,
      lotId: LOT_SCREW_B,
      quantityScaled: 200,
      method: "fifo",
    }),
    null,
  );
});

test("issuing a lot that does not belong to the item is refused as a wrong-lot movement", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  await assert.rejects(
    applyInventoryCommand(
      appEnv,
      command({
        commandId: "cmd_wronglot_001",
        transition: "receive",
        movements: [
          {
            positionId: "pos_wronglot_01",
            itemId: ITEM_PANEL,
            lotId: LOT_SCREW_A,
            binId: BIN_A,
            uomId: UOM_EACH,
            jobCustody: SHARED_CUSTODY,
            quantityDelta: 1,
            valueDelta: 500,
          },
        ],
        layers: [
          {
            layerId: "cmd_wronglot_001.layer",
            movementIndex: 0,
            layerKind: "receipt",
            unitCostMinor: 500,
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof InventoryLedgerError &&
      error.code === "inventory_event_lot_item_mismatch",
  );

  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 10,
    value_minor: 5000,
  });
});

test("quarantined stock cannot be issued until an independent approval releases it", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  db.raw.prepare(
    `INSERT INTO inventory_lots
       (lot_id, tenant_id, item_id, lot_code, lot_kind, status, unit_cost_minor,
        evidence_refs_json, created_at, updated_at)
     VALUES ('lot_quar_00001', ?, ?, 'Q-0001', 'purchased', 'quarantined', 500, '[]', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, NOW, NOW);

  const blocked = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_issue_quar01",
      transition: "issue_use",
      movements: [
        {
          positionId: "pos_quar_000001",
          itemId: ITEM_PANEL,
          lotId: "lot_quar_00001",
          binId: BIN_Q,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -1,
        },
      ],
    }),
  );
  assert.equal(blocked.kind, "rejected");
  assert.equal(
    blocked.kind === "rejected" && blocked.code,
    "inventory_position_negative_quantity",
  );

  // The receiver may not approve the release of stock they received themselves.
  db.raw.prepare(
    `INSERT INTO inventory_commands
       (command_id, tenant_id, transition, actor_type, actor_user_id, authority_ref, policy_ref,
        policy_version, idempotency_key_sha256, request_fingerprint_sha256, evidence_refs_json,
        payload_json, status, created_at, updated_at)
     VALUES ('cmd_seed_recv001', ?, 'receive', 'worker', ?, 'a', 'p', 'v1', ?, ?, '[]', '{}', 'pending', ?, ?)`,
  ).run(TENANT, RECEIVER, "d".repeat(64), FINGERPRINT, NOW, NOW);
  db.raw.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id,
        ordered_quantity_scaled, unit_price_minor, line_identity_sha256, status, created_at, updated_at)
     VALUES ('po_line_000001', ?, 'SO-1', 1, ?, ?, 10, 500, ?, 'ordered', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, UOM_EACH, "e".repeat(64), NOW, NOW);
  db.raw.prepare(
    `INSERT INTO inventory_receipt_lines
       (receipt_line_id, tenant_id, receipt_id, po_line_id, line_no, item_id, lot_id, uom_id,
        received_quantity_scaled, unit_price_minor, condition_status, exception_status,
        received_by_user_id, command_id, evidence_refs_json, created_at)
     VALUES ('rl_quar_000001', ?, 'RCPT-1', 'po_line_000001', 1, ?, 'lot_quar_00001', ?, 5, 500,
             'quarantined', 'wrong_lot', ?, 'cmd_seed_recv001', '[]', ?)`,
  ).run(TENANT, ITEM_PANEL, UOM_EACH, RECEIVER, NOW);

  assert.throws(
    () =>
      db.raw.prepare(
        `INSERT INTO inventory_approvals
           (approval_id, tenant_id, approval_kind, subject_type, subject_id, requested_by_user_id,
            approved_by_user_id, decision, reason_code, evidence_refs_json, decided_at)
         VALUES ('appr_selfrel_01', ?, 'quarantine_release', 'lot', 'lot_quar_00001', ?, ?,
                 'approved', 'inspection-passed', '[]', ?)`,
      ).run(TENANT, COUNTER, RECEIVER, NOW),
    /inventory_approval_receiver_cannot_release/,
  );

  // The lot cannot leave quarantine without a decided approval.
  assert.throws(
    () =>
      db.raw.prepare(
        `UPDATE inventory_lots SET status = 'available', version = 2, updated_at = ? WHERE lot_id = 'lot_quar_00001'`,
      ).run(NOW),
    /inventory_lot_quarantine_release_approval_required/,
  );

  db.raw.prepare(
    `INSERT INTO inventory_approvals
       (approval_id, tenant_id, approval_kind, subject_type, subject_id, requested_by_user_id,
        approved_by_user_id, decision, reason_code, evidence_refs_json, decided_at)
     VALUES ('appr_release_01', ?, 'quarantine_release', 'lot', 'lot_quar_00001', ?, ?,
             'approved', 'inspection-passed', '[]', ?)`,
  ).run(TENANT, RECEIVER, APPROVER, NOW);
  db.raw.prepare(
    `UPDATE inventory_lots SET status = 'available', version = 2, updated_at = ? WHERE lot_id = 'lot_quar_00001'`,
  ).run(NOW);
  assert.equal(
    (db.raw.prepare("SELECT status FROM inventory_lots WHERE lot_id = 'lot_quar_00001'").get() as {
      status: string;
    }).status,
    "available",
  );
});

test("a count freezes the bin, and a non-zero variance needs independent approval", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  db.raw.prepare(
    `INSERT INTO inventory_count_sessions
       (count_session_id, tenant_id, bin_id, count_type, status, opened_by_user_id, opened_at,
        evidence_refs_json, updated_at)
     VALUES ('cs_cycle_000001', ?, ?, 'cycle', 'frozen', ?, ?, '[]', ?)`,
  ).run(TENANT, BIN_A, RECEIVER, NOW, NOW);
  db.raw.prepare(
    `UPDATE inventory_bins
        SET freeze_state = 'frozen', frozen_by = ?, frozen_at = ?, freeze_count_session_id = 'cs_cycle_000001',
            version = 2, updated_at = ?
      WHERE bin_id = ?`,
  ).run(APPROVER, NOW, NOW, BIN_A);

  // While frozen the bin admits no ordinary movement.
  await assert.rejects(
    applyInventoryCommand(
      appEnv,
      command({
        commandId: "cmd_issue_frozen1",
        transition: "issue_use",
        movements: [
          {
            positionId: POS_A,
            itemId: ITEM_PANEL,
            lotId: LOT_ONE,
            binId: BIN_A,
            uomId: UOM_EACH,
            jobCustody: SHARED_CUSTODY,
            quantityDelta: -1,
            valueDelta: -500,
          },
        ],
        allocations: [
          {
            allocationId: "alloc_frozen_001",
            movementIndex: 0,
            layerId: "cmd_receive_0001.layer",
            quantityScaled: 1,
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof InventoryLedgerError && error.code === "inventory_event_bin_frozen",
  );

  db.raw.prepare(
    `INSERT INTO inventory_count_lines
       (count_line_id, tenant_id, count_session_id, position_id, expected_quantity_scaled,
        counted_quantity_scaled, variance_scaled, uom_id, status, counted_by_user_id, counted_at,
        evidence_refs_json, created_at, updated_at)
     VALUES ('cl_cycle_000001', ?, 'cs_cycle_000001', ?, 10, 8, -2, ?, 'variance', ?, ?, '[]', ?, ?)`,
  ).run(TENANT, POS_A, UOM_EACH, COUNTER, NOW, NOW, NOW);
  db.raw.prepare(
    `UPDATE inventory_count_sessions
        SET status = 'counted', counted_by_user_id = ?, counted_at = ?, version = 2, updated_at = ?
      WHERE count_session_id = 'cs_cycle_000001'`,
  ).run(COUNTER, NOW, NOW);

  // Approving a real variance without an approval row is refused.
  assert.throws(
    () =>
      db.raw.prepare(
        `UPDATE inventory_count_sessions SET status = 'approved', version = 3, updated_at = ?
          WHERE count_session_id = 'cs_cycle_000001'`,
      ).run(NOW),
    /inventory_count_variance_approval_required/,
  );

  // The counter may not approve their own count.
  assert.throws(
    () =>
      db.raw.prepare(
        `INSERT INTO inventory_approvals
           (approval_id, tenant_id, approval_kind, subject_type, subject_id, requested_by_user_id,
            approved_by_user_id, finance_reviewed_by_user_id, value_bearing, decision, reason_code,
            evidence_refs_json, decided_at)
         VALUES ('appr_selfcount1', ?, 'count_variance', 'count_session', 'cs_cycle_000001', ?, ?, ?, 1,
                 'approved', 'recount-confirmed', '[]', ?)`,
      ).run(TENANT, RECEIVER, COUNTER, FINANCE, NOW),
    /inventory_approval_counter_cannot_approve/,
  );

  // A value-bearing adjustment also needs a distinct finance reviewer.
  assert.throws(
    () =>
      db.raw.prepare(
        `INSERT INTO inventory_approvals
           (approval_id, tenant_id, approval_kind, subject_type, subject_id, requested_by_user_id,
            approved_by_user_id, value_bearing, decision, reason_code, evidence_refs_json, decided_at)
         VALUES ('appr_nofinance1', ?, 'count_variance', 'count_session', 'cs_cycle_000001', ?, ?, 1,
                 'approved', 'recount-confirmed', '[]', ?)`,
      ).run(TENANT, COUNTER, APPROVER, NOW),
    /CHECK constraint failed/,
  );

  db.raw.prepare(
    `INSERT INTO inventory_approvals
       (approval_id, tenant_id, approval_kind, subject_type, subject_id, requested_by_user_id,
        approved_by_user_id, finance_reviewed_by_user_id, value_bearing, decision, reason_code,
        evidence_refs_json, decided_at)
     VALUES ('appr_variance01', ?, 'count_variance', 'count_session', 'cs_cycle_000001', ?, ?, ?, 1,
             'approved', 'recount-confirmed', '[]', ?)`,
  ).run(TENANT, COUNTER, APPROVER, FINANCE, NOW);
  db.raw.prepare(
    `UPDATE inventory_count_sessions
        SET status = 'approved', approval_id = 'appr_variance01', version = 3, updated_at = ?
      WHERE count_session_id = 'cs_cycle_000001'`,
  ).run(NOW);

  // Only now may the adjustment reduce the position, and only behind that approval.
  const adjusted = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_countadj_001",
      transition: "count_adjustment",
      approvalId: "appr_variance01",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -2,
          valueDelta: -1000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_countadj01",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 2,
        },
      ],
    }),
  );
  assert.equal(adjusted.kind, "applied");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 8);
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 8,
    value_minor: 4000,
  });
  assert.deepEqual(await appliedLedgerTotals(appEnv, TENANT), {
    quantity_scaled: 8,
    value_minor: 4000,
  });
});

test("a count adjustment without an approval reference is refused", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  const result = await applyInventoryCommand(
    appEnv,
    command({
      commandId: "cmd_countadj_002",
      transition: "count_adjustment",
      movements: [
        {
          positionId: POS_A,
          itemId: ITEM_PANEL,
          lotId: LOT_ONE,
          binId: BIN_A,
          uomId: UOM_EACH,
          jobCustody: SHARED_CUSTODY,
          quantityDelta: -2,
          valueDelta: -1000,
        },
      ],
      allocations: [
        {
          allocationId: "alloc_countadj02",
          movementIndex: 0,
          layerId: "cmd_receive_0001.layer",
          quantityScaled: 2,
        },
      ],
    }),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" && result.code, "inventory_command_approval_required");
  assert.equal((await getInventoryPosition(appEnv, TENANT, POS_A))?.quantity_scaled, 10);
});

test("an offline scan replay converges on one observation and never double-applies", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const first = await recordInventoryScan(appEnv, {
    scanId: "scan_00000001",
    tenantId: TENANT,
    deviceId: "device_field_01",
    deviceActionId: "action_0000001",
    actorUserId: COUNTER,
    barcode: "LOT-0001-BARCODE",
    scanIntent: "issue_use",
    requestFingerprintSha256: FINGERPRINT,
    observedAt: NOW,
    capturedOffline: true,
    payload: { quantity_scaled: 2 },
    now: NOW,
  });
  assert.equal(first.kind, "recorded");
  assert.equal(first.scan.resolution, "resolved");
  assert.equal(first.scan.resolved_entity_type, "lot");
  assert.equal(first.scan.resolved_entity_id, LOT_ONE);
  assert.equal(first.scan.captured_offline, 1);

  // Same device action replayed after reconnect.
  const replay = await recordInventoryScan(appEnv, {
    scanId: "scan_00000002",
    tenantId: TENANT,
    deviceId: "device_field_01",
    deviceActionId: "action_0000001",
    actorUserId: COUNTER,
    barcode: "LOT-0001-BARCODE",
    scanIntent: "issue_use",
    requestFingerprintSha256: FINGERPRINT,
    observedAt: NOW,
    capturedOffline: true,
    payload: { quantity_scaled: 2 },
    now: NOW,
  });
  assert.equal(replay.kind, "duplicate");
  assert.equal(replay.scan.scan_id, "scan_00000001");

  // A different payload under the same device action is a conflict, not an overwrite.
  const conflicting = await recordInventoryScan(appEnv, {
    scanId: "scan_00000003",
    tenantId: TENANT,
    deviceId: "device_field_01",
    deviceActionId: "action_0000001",
    actorUserId: COUNTER,
    barcode: "LOT-0001-BARCODE",
    scanIntent: "issue_use",
    requestFingerprintSha256: "f".repeat(64),
    observedAt: NOW,
    capturedOffline: true,
    payload: { quantity_scaled: 9 },
    now: NOW,
  });
  assert.equal(conflicting.kind, "conflict");

  const stored = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_scans WHERE tenant_id = ?")
    .get(TENANT) as { count: number };
  assert.equal(stored.count, 1);
});

test("an unknown offline barcode is captured as an observation, never as stock", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const scan = await recordInventoryScan(appEnv, {
    scanId: "scan_00000010",
    tenantId: TENANT,
    deviceId: "device_field_01",
    deviceActionId: "action_0000010",
    actorUserId: COUNTER,
    barcode: "UNKNOWN-PALLET-77",
    scanIntent: "receive",
    requestFingerprintSha256: FINGERPRINT,
    observedAt: NOW,
    capturedOffline: true,
    payload: {},
    now: NOW,
  });

  assert.equal(scan.kind, "recorded");
  assert.equal(scan.scan.resolution, "observed_pending_validation");
  assert.equal(scan.scan.resolved_entity_id, null);
  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 0,
    value_minor: 0,
  });
});

test("unit conversion is exact rational arithmetic and refuses an inexact result", () => {
  assert.equal(convertQuantity(5, 12, 1), 60);
  assert.equal(convertQuantity(60, 1, 12), 5);
  assert.throws(
    () => convertQuantity(5, 1, 12),
    (error: unknown) =>
      error instanceof InventoryLedgerError && error.code === "inventory_uom_conversion_inexact",
  );
  assert.throws(
    () => convertQuantity(5, 0, 12),
    (error: unknown) =>
      error instanceof InventoryLedgerError && error.code === "inventory_uom_conversion_invalid",
  );
});

test("receipt classification turns every physical difference into a named exception", () => {
  const base = {
    orderedQuantityScaled: 10,
    previouslyReceivedScaled: 0,
    receivedQuantityScaled: 10,
    orderedUomId: UOM_EACH,
    receivedUomId: UOM_EACH,
    orderedItemId: ITEM_PANEL,
    receivedItemId: ITEM_PANEL,
    orderedUnitPriceMinor: 500,
    receivedUnitPriceMinor: 500,
    orderedTaxMinor: 25,
    receivedTaxMinor: 25,
    orderedFreightMinor: 40,
    receivedFreightMinor: 40,
    conditionStatus: "accepted" as const,
    lotBelongsToItem: true,
  };

  assert.equal(classifyReceiptException(base), "none");
  assert.equal(
    classifyReceiptException({ ...base, receivedQuantityScaled: 6 }),
    "backorder",
  );
  assert.equal(
    classifyReceiptException({ ...base, receivedQuantityScaled: 12 }),
    "overage",
  );
  assert.equal(
    classifyReceiptException({ ...base, previouslyReceivedScaled: 6, receivedQuantityScaled: 4 }),
    "none",
  );
  assert.equal(classifyReceiptException({ ...base, lotBelongsToItem: false }), "wrong_lot");
  assert.equal(
    classifyReceiptException({ ...base, receivedUomId: UOM_BUNDLE }),
    "unit_difference",
  );
  assert.equal(
    classifyReceiptException({ ...base, receivedItemId: ITEM_SCREW }),
    "substitution",
  );
  assert.equal(
    classifyReceiptException({ ...base, receivedUnitPriceMinor: 505 }),
    "price_difference",
  );
  assert.equal(classifyReceiptException({ ...base, receivedTaxMinor: 30 }), "tax_difference");
  assert.equal(
    classifyReceiptException({ ...base, receivedFreightMinor: 45 }),
    "freight_difference",
  );
});

test("three-way match requires exact identity and matches a legitimate partial delivery", () => {
  const base = {
    orderedQuantityScaled: 10,
    receivedQuantityScaled: 10,
    invoicedQuantityScaled: 10,
    orderedItemId: ITEM_PANEL,
    receivedItemId: ITEM_PANEL,
    invoicedItemId: ITEM_PANEL,
    orderedUomId: UOM_EACH,
    receivedUomId: UOM_EACH,
    invoicedUomId: UOM_EACH,
    orderedUnitPriceMinor: 500,
    receivedUnitPriceMinor: 500,
    invoicedUnitPriceMinor: 500,
    receivedTaxMinor: 25,
    invoicedTaxMinor: 25,
    receivedFreightMinor: 40,
    invoicedFreightMinor: 40,
    orderedCurrency: "CAD",
    receivedCurrency: "CAD",
    invoicedCurrency: "CAD",
    conditionStatus: "accepted" as const,
    receiptExceptionStatus: "none",
  };

  assert.deepEqual(classifyThreeWayMatch(base), {
    state: "matched",
    matchedQuantityScaled: 10,
  });

  // A partial delivery invoiced for exactly what arrived still matches for that quantity.
  assert.deepEqual(
    classifyThreeWayMatch({
      ...base,
      receivedQuantityScaled: 6,
      invoicedQuantityScaled: 6,
      receiptExceptionStatus: "none",
    }),
    { state: "matched", matchedQuantityScaled: 6 },
  );

  assert.deepEqual(
    classifyThreeWayMatch({ ...base, invoicedQuantityScaled: 12 }),
    { state: "exception", code: "overage" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, invoicedQuantityScaled: 8 }),
    { state: "exception", code: "shortage" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, invoicedUnitPriceMinor: 520 }),
    { state: "exception", code: "price_difference" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, invoicedUomId: UOM_BUNDLE }),
    { state: "exception", code: "unit_difference" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, conditionStatus: "damaged" }),
    { state: "exception", code: "condition_not_accepted" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, invoicedCurrency: "USD" }),
    { state: "exception", code: "currency_difference" },
  );
  assert.deepEqual(
    classifyThreeWayMatch({ ...base, receiptExceptionStatus: "wrong_lot" }),
    { state: "exception", code: "wrong_lot" },
  );
});

test("an AP invoice line is inadmissible without a succeeded authenticated readback", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  db.raw.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id,
        ordered_quantity_scaled, unit_price_minor, line_identity_sha256, status, created_at, updated_at)
     VALUES ('po_line_000001', ?, 'SO-1', 1, ?, ?, 10, 500, ?, 'ordered', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, UOM_EACH, "e".repeat(64), NOW, NOW);

  const insertInvoiceLine = (effectId: string) =>
    db.raw.prepare(
      `INSERT INTO inventory_invoice_lines
         (invoice_line_id, tenant_id, provider, provider_invoice_id, provider_vendor_id,
          po_line_id, line_no, item_id, uom_id, invoiced_quantity_scaled, unit_price_minor,
          line_identity_sha256, readback_effect_id, readback_hash_sha256, evidence_refs_json, created_at)
       VALUES ('il_000000001', ?, 'quickbooks', 'BILL-1', 'VENDOR-1', 'po_line_000001', 1, ?, ?,
               10, 500, ?, ?, ?, '[]', ?)`,
    ).run(TENANT, ITEM_PANEL, UOM_EACH, "e".repeat(64), effectId, "9".repeat(64), NOW);

  // No effect at all: the readback guard refuses it before the foreign key is reached.
  assert.throws(
    () => insertInvoiceLine("effect_missing_00001"),
    /inventory_invoice_line_authenticated_readback_required/,
  );

  // An effect that has not succeeded is not proof either.
  const insertEffect = (effectId: string, state: string, readback: string | null) =>
    db.raw.prepare(
      `INSERT INTO external_effects
         (effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
          policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
          request_hash, envelope_hash, provider, idempotency_key, deadline_at, preconditions_json,
          evidence_refs_json, expected_readback_json, retry_limit, compensation_plan_json,
          correlation_id, state, readback_hash, created_at, updated_at)
       VALUES (?, ?, 'agent', 'integration-worker', 'task-1', 'a', 'p', 'v1', 'invoice_line',
               'po_line_000001', 1, 'intent-1', 'quickbooks.bill.read', ?, ?, 'quickbooks', ?,
               ?, '{}', '[]', '{}', 0, '{}', 'correlation-0001', ?, ?, ?, ?)`,
    ).run(
      effectId, TENANT, "1".repeat(64), "2".repeat(64), `idem-${effectId}`,
      "2026-08-18T12:00:00.000Z", state, readback, NOW, NOW,
    );

  insertEffect("effect_pending_00001", "executing", null);
  assert.throws(
    () => insertInvoiceLine("effect_pending_00001"),
    /inventory_invoice_line_authenticated_readback_required/,
  );

  // A succeeded effect whose readback digest disagrees is still refused.
  insertEffect("effect_mismatch_0001", "succeeded", "8".repeat(64));
  assert.throws(
    () => insertInvoiceLine("effect_mismatch_0001"),
    /inventory_invoice_line_authenticated_readback_required/,
  );

  insertEffect("effect_verified_0001", "succeeded", "9".repeat(64));
  insertInvoiceLine("effect_verified_0001");
  const stored = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_invoice_lines WHERE tenant_id = ?")
    .get(TENANT) as { count: number };
  assert.equal(stored.count, 1);
});

// 0169 re-creates 0067's readback guard: the cited effect must be a QuickBooks bill read through the
// line's own provider, and a supplier_ap line is refused until a read action exists for it.
const READBACK_GUARD = "inventory_invoice_lines_readback_guard";
const migrationText = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
const guardText = (text: string) =>
  new RegExp(`CREATE TRIGGER (?:IF NOT EXISTS )?${READBACK_GUARD}\\n[\\s\\S]*?\\nEND`).exec(text)![0];
/** What 0169 adds to 0067's body, exactly; everything else is 0067's text. */
const GUARD_ADDITIONS = [
  "  SELECT RAISE(ABORT, 'inventory_invoice_line_supplier_ap_readback_unsupported')\n" +
    "  WHERE NEW.provider = 'supplier_ap';\n\n",
  "\n      AND effect.action = 'quickbooks.bill.read'",
  "\n      AND effect.provider = NEW.provider",
];

/** A database with one ordered PO line and a writer for effects and AP lines against it. */
async function readbackGuardFixture() {
  const db = new SqliteD1();
  await seedReceipt(env(db), { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });
  db.raw.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id,
        ordered_quantity_scaled, unit_price_minor, line_identity_sha256, status, created_at, updated_at)
     VALUES ('po_line_000001', ?, 'SO-1', 1, ?, ?, 10, 500, ?, 'ordered', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, UOM_EACH, "e".repeat(64), NOW, NOW);
  let lines = 0;
  return {
    db,
    effect(effectId: string, overrides: Partial<{ action: string; provider: string; state: string; tenant: string; readback: string }> = {}) {
      db.raw.prepare(
        `INSERT INTO external_effects
           (effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
            policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
            request_hash, envelope_hash, provider, idempotency_key, deadline_at, preconditions_json,
            evidence_refs_json, expected_readback_json, retry_limit, compensation_plan_json,
            correlation_id, state, readback_hash, created_at, updated_at)
         VALUES (?, ?, 'agent', 'integration-worker', 'task-1', 'a', 'p', 'v1', 'invoice_line',
                 'po_line_000001', 1, 'intent-1', ?, ?, ?, ?, ?,
                 ?, '{}', '[]', '{}', 0, '{}', 'correlation-0001', ?, ?, ?, ?)`,
      ).run(
        effectId, overrides.tenant ?? TENANT, overrides.action ?? "quickbooks.bill.read", "1".repeat(64), "2".repeat(64),
        overrides.provider ?? "quickbooks", `idem-${effectId}`, "2026-08-18T12:00:00.000Z",
        overrides.state ?? "succeeded", overrides.readback ?? "9".repeat(64), NOW, NOW,
      );
    },
    line(effectId: string, provider = "quickbooks") {
      lines += 1;
      db.raw.prepare(
        `INSERT INTO inventory_invoice_lines
           (invoice_line_id, tenant_id, provider, provider_invoice_id, provider_vendor_id,
            po_line_id, line_no, item_id, uom_id, invoiced_quantity_scaled, unit_price_minor,
            line_identity_sha256, readback_effect_id, readback_hash_sha256, evidence_refs_json, created_at)
         VALUES (?, ?, ?, ?, 'VENDOR-1', 'po_line_000001', 1, ?, ?, 10, 500, ?, ?, ?, '[]', ?)`,
      ).run(
        `il_readback_${String(lines).padStart(4, "0")}`, TENANT, provider, `BILL-${lines}`,
        ITEM_PANEL, UOM_EACH, "e".repeat(64), effectId, "9".repeat(64), NOW,
      );
    },
    count: () => (db.raw.prepare("SELECT COUNT(*) AS n FROM inventory_invoice_lines").get() as { n: number }).n,
  };
}

test("an AP invoice line cites a QuickBooks bill read through its own provider; any other finished effect is refused (0169)", async () => {
  const f = await readbackGuardFixture();
  // Each new clause alone: an effect that passes 0067's every clause, but did something else.
  for (const action of [
    "mcp.request_create_purchase_invoice",
    "accounting.invoice.submit",
    "proposal.publish",
    "customer.email.send",
    "quickbooks.bill.create",
    "quickbooks.bill.read ",
    "QUICKBOOKS.BILL.READ",
  ]) {
    const effectId = `effect_action_${action.replace(/[^a-z]/gi, "").slice(0, 24)}`;
    f.effect(effectId, { action });
    assert.throws(() => f.line(effectId), /inventory_invoice_line_authenticated_readback_required/, action);
  }
  // The bill read itself, through another provider than the line's.
  for (const provider of ["frappe", "supplier_ap", "qa-synthetic-publication", "Quickbooks"]) {
    const effectId = `effect_provider_${provider.replace(/[^a-z]/gi, "")}`;
    f.effect(effectId, { provider });
    assert.throws(() => f.line(effectId), /inventory_invoice_line_authenticated_readback_required/, provider);
  }
  // A supplier_ap line has no read action yet: refused by name, even citing an effect that
  // matches it in every other way, or a good QuickBooks read.
  f.effect("effect_supplier_ap_read", { provider: "supplier_ap" });
  f.effect("effect_quickbooks_read");
  for (const effectId of ["effect_supplier_ap_read", "effect_quickbooks_read", "effect_missing_00001"]) {
    assert.throws(() => f.line(effectId, "supplier_ap"), /inventory_invoice_line_supplier_ap_readback_unsupported/, effectId);
  }
  assert.equal(f.count(), 0);

  // 0067's clauses stand: another tenant's read, an unfinished one, or a digest that disagrees.
  f.effect("effect_other_tenant", { tenant: "tenant-other" });
  f.effect("effect_still_executing", { state: "executing", readback: "9".repeat(64) });
  f.effect("effect_wrong_digest", { readback: "8".repeat(64) });
  for (const effectId of ["effect_other_tenant", "effect_still_executing", "effect_wrong_digest"]) {
    assert.throws(() => f.line(effectId), /inventory_invoice_line_authenticated_readback_required/, effectId);
  }
  assert.equal(f.count(), 0);

  // The legitimate readbacks pass: a succeeded bill read, and a reconciled one (0067 keeps both).
  f.line("effect_quickbooks_read");
  f.effect("effect_reconciled_read", { state: "reconciled" });
  f.line("effect_reconciled_read");
  assert.equal(f.count(), 2);
  // The PO identity clause still follows the readback: a line for another item is refused.
  f.effect("effect_identity_read");
  assert.throws(
    () => f.db.raw.prepare(
      `INSERT INTO inventory_invoice_lines
         (invoice_line_id, tenant_id, provider, provider_invoice_id, provider_vendor_id,
          po_line_id, line_no, item_id, uom_id, invoiced_quantity_scaled, unit_price_minor,
          line_identity_sha256, readback_effect_id, readback_hash_sha256, evidence_refs_json, created_at)
       VALUES ('il_identity_0001', ?, 'quickbooks', 'BILL-ID', 'VENDOR-1', 'po_line_000001', 1, ?, ?, 10, 500, ?,
               'effect_identity_read', ?, '[]', ?)`,
    ).run(TENANT, ITEM_SCREW, UOM_EACH, "e".repeat(64), "9".repeat(64), NOW),
    /inventory_invoice_line_po_identity_mismatch/,
  );

  // A cited read cannot be re-pointed after the line is written: its tenant, action and provider
  // are frozen (0042, re-created by 0156), and the line itself is append-only (0067).
  for (const change of ["action = 'mcp.synthetic'", "provider = 'frappe'", "tenant_id = 'tenant-other'"]) {
    assert.throws(
      () => f.db.raw.prepare(`UPDATE external_effects SET ${change} WHERE effect_id = 'effect_quickbooks_read'`).run(),
      /external_effect_binding_immutable/,
      change,
    );
  }
  assert.throws(
    () => f.db.raw.prepare("UPDATE inventory_invoice_lines SET readback_effect_id = 'effect_other_tenant'").run(),
    /inventory_invoice_lines_append_only/,
  );
});

test("0169's readback guard is 0067's, line for line, plus the three ruled additions, and reads only its pinned columns", async () => {
  const { db } = await readbackGuardFixture();
  const live = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(READBACK_GUARD) as { sql: string }).sql;
  const base = guardText(migrationText("0067_inventory_control.sql"));
  const own = guardText(migrationText("0169_inventory_invoice_readback_action.sql"));
  // The schema holds 0169's version.
  assert.equal(live, own);
  // Each addition appears once; without them the body is 0067's, character for character.
  let stripped = live;
  for (const addition of GUARD_ADDITIONS) {
    assert.equal(live.split(addition).length, 2, `added once: ${addition.trim()}`);
    stripped = stripped.replace(addition, "");
  }
  assert.equal(stripped, base.replace("IF NOT EXISTS ", ""));
  // The columns it reads, pinned: the line's, the cited effect's and the ordered PO line's.
  const read = (alias: string) => [...new Set([...live.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, "g"))].map((m) => m[1]))].sort();
  assert.deepEqual(read("NEW"), ["item_id", "po_line_id", "provider", "readback_effect_id", "readback_hash_sha256", "tenant_id"]);
  assert.deepEqual(read("effect"), ["action", "effect_id", "provider", "readback_hash", "state", "tenant_id"]);
  assert.deepEqual(read("ordered"), ["item_id", "po_line_id", "tenant_id"]);
  const tables = [...new Set([...live.matchAll(/\b(?:FROM|JOIN|ON)\s+([a-z_]+)/gi)].map((m) => m[1]))].sort();
  assert.deepEqual(tables, ["external_effects", "inventory_invoice_lines", "inventory_po_lines"]);
  // No clock: the guard reads no time.
  assert.doesNotMatch(live, /strftime|datetime|julianday|_at\b/);
  // 0067's guard run again (its IF NOT EXISTS) keeps 0169's version.
  db.raw.exec(`${base};`);
  assert.equal((db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(READBACK_GUARD) as { sql: string }).sql, own);
});

test("only 0067 and 0169 write the readback guard, and no Worker code writes an AP invoice line yet", () => {
  const migrations = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.deepEqual(
    migrations.filter((name) => migrationText(name).includes(READBACK_GUARD)),
    ["0067_inventory_control.sql", "0169_inventory_invoice_readback_action.sql"],
  );
  // The guard is the only gate an AP line passes: the first Worker writer must cite a
  // quickbooks.bill.read effect and comes with its own tests, so it updates this list on purpose.
  const sources = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(new URL(`${entry.name}/`, dir)) : entry.name.endsWith(".ts") ? [new URL(entry.name, dir).pathname] : []);
  const writers = sources(new URL("../src/", import.meta.url)).filter((file) => /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+inventory_invoice_lines/i.test(readFileSync(file, "utf8")));
  assert.deepEqual(writers, []);
});

test("the movement ledger and every projection stay append-only", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  assert.throws(
    () => db.raw.prepare("DELETE FROM inventory_events").run(),
    /inventory_events_retained/,
  );
  assert.throws(
    () =>
      db.raw.prepare("UPDATE inventory_events SET quantity_delta_scaled = 99").run(),
    /inventory_events_append_only/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM inventory_positions").run(),
    /inventory_positions_retained/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM inventory_commands").run(),
    /inventory_commands_retained/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM inventory_valuation_layers").run(),
    /inventory_valuation_layers_retained/,
  );

  // A projection can never be restated without a matching movement.
  assert.throws(
    () =>
      db.raw.prepare(
        `UPDATE inventory_positions SET quantity_scaled = 999, version = 2, updated_at = ? WHERE position_id = ?`,
      ).run(NOW, POS_A),
    /inventory_position_event_delta_mismatch/,
  );
});

test("a specialised office user cannot write through the legacy storage role", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  // 0038 keeps a narrow office user under a compatible legacy storage role while the
  // effective authority lives in access_role. A guard that read the storage column would
  // silently grant this user warehouse authority.
  db.raw.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role,
        frappe_user_id, active, created_by, created_at, updated_at)
     VALUES ('appu_sales_00000001', ?, 'sales@example.invalid', 'Sales', 'ops', 'sales',
             'sales@example.invalid', 1, 'seed', ?, ?)`,
  ).run(TENANT, NOW, NOW);

  await assert.rejects(
    applyInventoryCommand(
      appEnv,
      command({
        commandId: "cmd_sales_000001",
        transition: "receive",
        actorUserId: "appu_sales_00000001",
        movements: [
          {
            positionId: POS_A,
            itemId: ITEM_PANEL,
            lotId: LOT_ONE,
            binId: BIN_A,
            uomId: UOM_EACH,
            jobCustody: SHARED_CUSTODY,
            quantityDelta: 5,
            valueDelta: 2500,
          },
        ],
        layers: [
          {
            layerId: "cmd_sales_000001.layer",
            movementIndex: 0,
            layerKind: "receipt",
            unitCostMinor: 500,
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof InventoryLedgerError &&
      error.code === "inventory_command_actor_role_required",
  );

  assert.deepEqual(await inventoryTotals(appEnv, TENANT), {
    quantity_scaled: 0,
    value_minor: 0,
  });
});

test("a three-way match row cannot claim 'matched' unless the three lines truly agree", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await seedReceipt(appEnv, { commandId: "cmd_receive_0001", quantity: 10, unitCost: 500 });

  db.raw.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id,
        ordered_quantity_scaled, unit_price_minor, tax_minor, freight_minor,
        line_identity_sha256, status, created_at, updated_at)
     VALUES ('po_line_000001', ?, 'SO-1', 1, ?, ?, 10, 500, 25, 40, ?, 'ordered', ?, ?)`,
  ).run(TENANT, ITEM_PANEL, UOM_EACH, "e".repeat(64), NOW, NOW);

  db.raw.prepare(
    `INSERT INTO inventory_commands
       (command_id, tenant_id, transition, actor_type, actor_user_id, authority_ref, policy_ref,
        policy_version, idempotency_key_sha256, request_fingerprint_sha256, evidence_refs_json,
        payload_json, status, created_at, updated_at)
     VALUES ('cmd_seed_recv001', ?, 'receive', 'worker', ?, 'a', 'p', 'v1', ?, ?, '[]', '{}', 'pending', ?, ?)`,
  ).run(TENANT, RECEIVER, "d".repeat(64), FINGERPRINT, NOW, NOW);

  // A short delivery: six of the ten ordered arrived, in good condition.
  db.raw.prepare(
    `INSERT INTO inventory_receipt_lines
       (receipt_line_id, tenant_id, receipt_id, po_line_id, line_no, item_id, lot_id, uom_id,
        received_quantity_scaled, unit_price_minor, tax_minor, freight_minor, condition_status,
        exception_status, received_by_user_id, command_id, evidence_refs_json, created_at)
     VALUES ('rl_partial_0001', ?, 'RCPT-1', 'po_line_000001', 1, ?, ?, ?, 6, 500, 25, 40,
             'accepted', 'none', ?, 'cmd_seed_recv001', '[]', ?)`,
  ).run(TENANT, ITEM_PANEL, LOT_ONE, UOM_EACH, RECEIVER, NOW);

  const insertEffect = (effectId: string, readback: string) =>
    db.raw.prepare(
      `INSERT INTO external_effects
         (effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
          policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
          request_hash, envelope_hash, provider, idempotency_key, deadline_at, preconditions_json,
          evidence_refs_json, expected_readback_json, retry_limit, compensation_plan_json,
          correlation_id, state, readback_hash, created_at, updated_at)
       VALUES (?, ?, 'agent', 'integration-worker', 'task-1', 'a', 'p', 'v1', 'invoice_line',
               'po_line_000001', 1, 'intent-1', 'quickbooks.bill.read', ?, ?, 'quickbooks', ?,
               ?, '{}', '[]', '{}', 0, '{}', 'correlation-0001', 'succeeded', ?, ?, ?)`,
    ).run(
      effectId, TENANT, "1".repeat(64), "2".repeat(64), `idem-${effectId}`,
      "2026-08-18T12:00:00.000Z", readback, NOW, NOW,
    );

  const insertInvoiceLine = (
    id: string, effectId: string, readback: string, quantity: number, price: number, lineNo: number,
  ) =>
    db.raw.prepare(
      `INSERT INTO inventory_invoice_lines
         (invoice_line_id, tenant_id, provider, provider_invoice_id, provider_vendor_id,
          po_line_id, line_no, item_id, uom_id, invoiced_quantity_scaled, unit_price_minor,
          tax_minor, freight_minor, line_identity_sha256, readback_effect_id,
          readback_hash_sha256, evidence_refs_json, created_at)
       VALUES (?, ?, 'quickbooks', 'BILL-1', 'VENDOR-1', 'po_line_000001', ?, ?, ?, ?, ?,
               25, 40, ?, ?, ?, '[]', ?)`,
    ).run(id, TENANT, lineNo, ITEM_PANEL, UOM_EACH, quantity, price, "e".repeat(64), effectId, readback, NOW);

  insertEffect("effect_agree_00001", "9".repeat(64));
  insertInvoiceLine("il_agree_00001", "effect_agree_00001", "9".repeat(64), 6, 500, 1);
  insertEffect("effect_price_00001", "7".repeat(64));
  insertInvoiceLine("il_priced_0001", "effect_price_00001", "7".repeat(64), 6, 620, 2);

  const insertMatch = (
    matchId: string, invoiceLineId: string, state: string, code: string | null, quantity: number,
  ) =>
    db.raw.prepare(
      `INSERT INTO inventory_three_way_matches
         (match_id, tenant_id, po_line_id, receipt_line_id, invoice_line_id, match_state,
          exception_code, identity_digest_sha256, matched_quantity_scaled, created_at, updated_at)
       VALUES (?, ?, 'po_line_000001', 'rl_partial_0001', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(matchId, TENANT, invoiceLineId, state, code, "f".repeat(64), quantity, NOW, NOW);

  // A price that disagrees with the order can never be recorded as matched.
  assert.throws(
    () => insertMatch("match_priced_001", "il_priced_0001", "matched", null, 6),
    /inventory_three_way_exact_identity_required/,
  );

  // Nor can a match overstate the quantity that physically arrived.
  assert.throws(
    () => insertMatch("match_overstate1", "il_agree_00001", "matched", null, 10),
    /inventory_three_way_exact_identity_required/,
  );

  // The legitimate partial delivery matches for exactly what arrived and was invoiced.
  insertMatch("match_partial_01", "il_agree_00001", "matched", null, 6);
  const stored = db.raw
    .prepare("SELECT match_state, matched_quantity_scaled FROM inventory_three_way_matches WHERE match_id = ?")
    .get("match_partial_01") as { match_state: string; matched_quantity_scaled: number };
  assert.equal(stored.match_state, "matched");
  assert.equal(stored.matched_quantity_scaled, 6);

  // The price disagreement is recordable as an exception, which is what it is.
  insertMatch("match_priced_002", "il_priced_0001", "exception", "price_difference", 0);

  // An exception never silently upgrades itself into a match.
  assert.throws(
    () =>
      db.raw.prepare(
        `UPDATE inventory_three_way_matches
            SET match_state = 'matched', exception_code = NULL, version = 2, updated_at = ?
          WHERE match_id = 'match_priced_002'`,
      ).run(NOW),
    /inventory_three_way_state_upgrade_forbidden/,
  );
});
