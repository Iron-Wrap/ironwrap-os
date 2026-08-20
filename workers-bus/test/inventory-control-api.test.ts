import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleInventoryRoute } from "../src/inventory-control-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const NOW = "2026-08-17T12:00:00.000Z";
const FINGERPRINT = "a".repeat(64);
const UOM_EACH = "uom_each_0001";
const ITEM_PANEL = "item_panel_001";
const BIN_A = "bin_stock_a01";
const LOT_ONE = "lot_panel_0001";
const POS_A = "pos_panel_a001";

const USERS: Record<AppRole, string> = {
  owner: "appu_owner_000001",
  ops: "appu_ops_000000001",
  sales: "appu_sales_000001",
  production: "appu_production_1",
  accounting: "appu_accounting_1",
  field: "appu_field_000001",
};

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
    // Office specialisations keep a compatible legacy storage role and carry their real
    // authority in access_role, which is exactly the case the ledger guard must not confuse.
    const STORAGE_ROLE: Record<AppRole, string> = {
      owner: "owner",
      ops: "ops",
      sales: "ops",
      production: "ops",
      accounting: "ops",
      field: "field",
    };
    for (const [role, id] of Object.entries(USERS) as Array<[AppRole, string]>) {
      users.run(
        id, TENANT, `${role}@example.invalid`, role, STORAGE_ROLE[role], role,
        `${role}@example.invalid`, NOW, NOW,
      );
    }

    this.raw.prepare(
      `INSERT INTO inventory_uoms (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at)
       VALUES (?, ?, 'EA', 'count', 0, 'active', ?, ?)`,
    ).run(UOM_EACH, TENANT, NOW, NOW);
    this.raw.prepare(
      `INSERT INTO inventory_items
         (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale,
          lot_controlled, valuation_method, source_ref, created_at, updated_at)
       VALUES (?, ?, 'PANEL-24', 'active', 'raw_material', ?, 0, 1, 'actual', 'seed', ?, ?)`,
    ).run(ITEM_PANEL, TENANT, UOM_EACH, NOW, NOW);
    this.raw.prepare(
      `INSERT INTO inventory_locations
         (location_id, tenant_id, location_code, name, location_kind, status, source_ref, created_at, updated_at)
       VALUES ('loc_wh_000001', ?, 'WH1', 'Warehouse', 'warehouse', 'active', 'seed', ?, ?)`,
    ).run(TENANT, NOW, NOW);
    this.raw.prepare(
      `INSERT INTO inventory_bins
         (bin_id, tenant_id, location_id, bin_code, bin_kind, status, created_at, updated_at)
       VALUES (?, ?, 'loc_wh_000001', 'A1', 'stock', 'active', ?, ?)`,
    ).run(BIN_A, TENANT, NOW, NOW);
    this.raw.prepare(
      `INSERT INTO inventory_lots
         (lot_id, tenant_id, item_id, lot_code, lot_kind, status, unit_cost_minor,
          evidence_refs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'L-0001', 'purchased', 'available', 500, '[]', ?, ?)`,
    ).run(LOT_ONE, TENANT, ITEM_PANEL, NOW, NOW);
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

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW,
      session_expires_at: "2026-08-18T12:00:00.000Z",
      revoked_at: null,
      user_id: USERS[role],
      tenant_id: TENANT,
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.invalid`,
      active: 1,
      created_by: USERS.owner,
      created_at: NOW,
      updated_at: NOW,
    },
  } as AuthContext;
}

function request(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
  csrf = true,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (csrf) headers.set("x-csrf-token", "csrf");
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

function receivePayload(commandId: string, quantity: number) {
  return {
    command_id: commandId,
    idempotency_key: commandId,
    request_fingerprint_sha256: FINGERPRINT,
    transition: "receive",
    authority_ref: "assignment:inventory",
    policy_ref: "policy:inventory",
    policy_version: "v1",
    evidence_refs: [{ ref: "r2://evidence/receipt", sha256: "b".repeat(64) }],
    movements: [
      {
        position_id: POS_A,
        item_id: ITEM_PANEL,
        lot_id: LOT_ONE,
        bin_id: BIN_A,
        uom_id: UOM_EACH,
        job_custody: "-",
        quantity_delta_scaled: quantity,
        value_delta_minor: quantity * 500,
      },
    ],
    layers: [
      {
        layer_id: `${commandId}.layer`,
        movement_index: 0,
        layer_kind: "receipt",
        unit_cost_minor: 500,
      },
    ],
  };
}

test("a receive command applies through the route and is readable back", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_recv_001", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(response?.status, 201);
  const created = await response?.json() as { kind: string; command: { status: string } };
  assert.equal(created.kind, "applied");
  assert.equal(created.command.status, "applied");

  const positionResponse = await handleInventoryRoute(
    request("GET", `/api/v1/inventory/positions/${POS_A}`),
    appEnv,
    auth("production"),
  );
  assert.equal(positionResponse?.status, 200);
  const read = await positionResponse?.json() as {
    position: { quantity_scaled: number; value_minor: number };
  };
  assert.equal(read.position.quantity_scaled, 10);
  assert.equal(read.position.value_minor, 5000);

  const listResponse = await handleInventoryRoute(
    request("GET", `/api/v1/inventory/positions?item_id=${ITEM_PANEL}`),
    appEnv,
    auth("field"),
  );
  assert.equal(listResponse?.status, 200);
  const listed = await listResponse?.json() as { positions: unknown[] };
  assert.equal(listed.positions.length, 1);
});

test("an identical retry over the route replays instead of applying twice", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const payload = receivePayload("cmd_api_recv_001", 10);

  const first = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", payload),
    appEnv,
    auth("ops"),
  );
  assert.equal(first?.status, 201);

  const retry = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", payload),
    appEnv,
    auth("ops"),
  );
  assert.equal(retry?.status, 200);
  assert.equal((await retry?.json() as { kind: string }).kind, "replayed");

  const position = db.raw
    .prepare("SELECT quantity_scaled FROM inventory_positions WHERE position_id = ?")
    .get(POS_A) as { quantity_scaled: number };
  assert.equal(position.quantity_scaled, 10);
});

test("a refused command returns 422 with its exact ledger code and moves nothing", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_recv_001", 10)),
    appEnv,
    auth("ops"),
  );

  const oneLeggedTransfer = {
    ...receivePayload("cmd_api_xfer_001", 0),
    transition: "transfer",
    layers: [],
    movements: [
      {
        position_id: POS_A,
        item_id: ITEM_PANEL,
        lot_id: LOT_ONE,
        bin_id: BIN_A,
        uom_id: UOM_EACH,
        job_custody: "-",
        quantity_delta_scaled: -3,
        value_delta_minor: -1500,
      },
    ],
  };

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", oneLeggedTransfer),
    appEnv,
    auth("ops"),
  );
  assert.equal(response?.status, 422);
  const refused = await response?.json() as { kind: string; code: string };
  assert.equal(refused.kind, "rejected");
  assert.equal(refused.code, "inventory_command_quantity_not_conserved");

  const position = db.raw
    .prepare("SELECT quantity_scaled FROM inventory_positions WHERE position_id = ?")
    .get(POS_A) as { quantity_scaled: number };
  assert.equal(position.quantity_scaled, 10);
});

test("only the roles the ledger admits may write, and reads stay role-scoped", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  for (const role of ["sales", "accounting"] as const) {
    const denied = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_recv_002", 5)),
      appEnv,
      auth(role),
    );
    assert.equal(denied?.status, 403);
    assert.equal(
      (await denied?.json() as { error: string }).error,
      "inventory_write_role_required",
    );
  }

  const readDenied = await handleInventoryRoute(
    request("GET", `/api/v1/inventory/positions?item_id=${ITEM_PANEL}`),
    appEnv,
    auth("sales"),
  );
  assert.equal(readDenied?.status, 403);
  assert.equal(
    (await readDenied?.json() as { error: string }).error,
    "inventory_read_role_required",
  );

  // Nothing was written by any denied attempt.
  const count = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_commands")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("a write without a CSRF token is refused before the ledger is touched", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_recv_003", 5), false),
    appEnv,
    auth("ops"),
  );
  assert.equal(response?.status, 403);
  assert.equal((await response?.json() as { error: string }).error, "csrf_failed");

  const count = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_commands")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("a malformed command is a 400 and never reaches the ledger", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  for (const payload of [
    { ...receivePayload("cmd_api_bad_0001", 5), transition: "teleport" },
    { ...receivePayload("cmd_api_bad_0002", 5), movements: [] },
    { ...receivePayload("cmd_api_bad_0003", 5), request_fingerprint_sha256: "short" },
    { ...receivePayload("cmd_api_bad_0004", 5), evidence_refs: [{ ref: "r2://x", sha256: "no" }] },
  ]) {
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", payload),
      appEnv,
      auth("ops"),
    );
    assert.equal(response?.status, 400);
    assert.equal(
      (await response?.json() as { error: string }).error,
      "invalid_inventory_command",
    );
  }

  const count = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_commands")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("an offline scan replay is a success for the device and stores one observation", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const payload = {
    scan_id: "scan_api_000001",
    device_id: "device_field_01",
    device_action_id: "action_0000001",
    barcode: "LOT-0001-BARCODE",
    scan_intent: "issue_use",
    request_fingerprint_sha256: FINGERPRINT,
    observed_at: NOW,
    captured_offline: true,
    payload: { quantity_scaled: 2 },
  };

  const first = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/scans", payload),
    appEnv,
    auth("field"),
  );
  assert.equal(first?.status, 201);
  const recorded = await first?.json() as { kind: string; scan: { resolution: string } };
  assert.equal(recorded.kind, "recorded");
  assert.equal(recorded.scan.resolution, "resolved");

  const replay = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/scans", { ...payload, scan_id: "scan_api_000002" }),
    appEnv,
    auth("field"),
  );
  assert.equal(replay?.status, 200);
  assert.equal((await replay?.json() as { kind: string }).kind, "duplicate");

  const conflicting = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/scans", {
      ...payload,
      scan_id: "scan_api_000003",
      request_fingerprint_sha256: "c".repeat(64),
    }),
    appEnv,
    auth("field"),
  );
  assert.equal(conflicting?.status, 409);

  const count = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_scans")
    .get() as { count: number };
  assert.equal(count.count, 1);
});

test("an unknown barcode scan is stored as an observation, not as stock", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/scans", {
      scan_id: "scan_api_000010",
      device_id: "device_field_01",
      device_action_id: "action_0000010",
      barcode: "UNKNOWN-PALLET-77",
      scan_intent: "receive",
      request_fingerprint_sha256: FINGERPRINT,
      observed_at: NOW,
      captured_offline: true,
    }),
    appEnv,
    auth("field"),
  );
  assert.equal(response?.status, 201);
  const stored = await response?.json() as { scan: { resolution: string; resolved_entity_id: string | null } };
  assert.equal(stored.scan.resolution, "observed_pending_validation");
  assert.equal(stored.scan.resolved_entity_id, null);

  const positions = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_positions")
    .get() as { count: number };
  assert.equal(positions.count, 0);
});

test("routes outside the inventory namespace are not claimed", async () => {
  const db = new SqliteD1();
  const response = await handleInventoryRoute(
    request("GET", "/api/v1/session"),
    env(db),
    auth("ops"),
  );
  assert.equal(response, null);
});
