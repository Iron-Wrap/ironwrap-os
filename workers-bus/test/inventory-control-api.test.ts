import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleInventoryRoute as inventoryRoute } from "../src/inventory-control-api.ts";
import { INVENTORY_TRANSITIONS } from "../src/inventory-control.ts";
import { EVIDENCE_BYTES, EvidenceR2, uploadedEvidence } from "./evidence-upload-fixture.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const NOW = "2026-08-17T12:00:00.000Z";
const FINGERPRINT = "a".repeat(64);
const AUTHORITY_RECORD = "Authority-Inventory-0001";
const AUTHORITY_READBACK = "Authority-Inventory-Readback-01";
const OTHER_AUTHORITY_READBACK = "Authority-Other-Readback-01";
const UNRELATED_AUTHORITY_READBACK = "Authority-Licence-Readback-01";
const UOM_EACH = "uom_each_0001";
const ITEM_PANEL = "item_panel_001";
const BIN_A = "bin_stock_a01";
const BIN_B = "bin_stock_b01";
const LOT_ONE = "lot_panel_0001";
const POS_A = "pos_panel_a001";
const PO_LINE = "po_line_panel_001";
const EVIDENCE_REF = `r2://inventory-evidence/${TENANT}/receipt`;
const EVIDENCE_SHA256 = "6f32860910ca0fb2a20c7fda143666b09dbf8db5238195c90a586fb542ff0cad";

function inventoryAuthorityScopeJson(tenantId: string): string {
  return JSON.stringify({
    purpose: "inventory-command",
    tenant_id: tenantId,
    allowed_roles: ["owner", "ops", "field"],
    operational_scope: { scope_type: "Tenant", scope_ref: tenantId },
  });
}

type AuthorityState = "verified" | "revoked" | "contradictory" | "unavailable";

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

  constructor(options: { authorityState?: AuthorityState } = {}) {
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
    users.run(
      "appu_ops_other_00001", OTHER_TENANT, "ops@other.example.invalid", "Other Ops", "ops", "ops",
      "ops@other.example.invalid", NOW, NOW,
    );

    const authority = this.raw.prepare(
      `INSERT INTO authority_record_readbacks
         (readback_id, tenant_id, authority_record_id, authority_version,
          subject_type, subject_role, person_user, organization, authority_kind,
          authority_scope, scope_type, scope_ref, roof_job, scope_json,
         issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
          verification_state, evidence_refs_json, evidence_sha256,
          authority_state_digest_sha256, authority_effective_from, authority_expires_at,
          authority_revoked_at, supersedes_authority_record_id, authority_verification_method,
          issuer_receipt_sha256,
          observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id)
       VALUES (?, ?, ?, 1, 'Organization', 'Inventory Authority', NULL, ?,
               'Inventory Command Authority', 'inventory-command', 'Tenant', ?, NULL, ?,
               'IronWrap Operations', 'AB-CA', 'internal:inventory-authority:1',
               'inventory-authority:1', ?, '[]', ?, ?, '2026-08-01', '2026-12-31',
               NULL, NULL, 'Internal Competency Assessment', ?, ?, ?, ?, NULL)`,
    );
    authority.run(
      AUTHORITY_READBACK,
      TENANT,
      AUTHORITY_RECORD,
      TENANT,
      TENANT,
      inventoryAuthorityScopeJson(TENANT),
      options.authorityState ?? "verified",
      "b".repeat(64),
      "c".repeat(64),
      null,
      USERS.owner,
      NOW,
      "d".repeat(64),
    );
    authority.run(
      OTHER_AUTHORITY_READBACK,
      OTHER_TENANT,
      "Authority-Other-Inventory-01",
      OTHER_TENANT,
      OTHER_TENANT,
      inventoryAuthorityScopeJson(OTHER_TENANT),
      "verified",
      "e".repeat(64),
      "f".repeat(64),
      "2".repeat(64),
      "appu_ops_other_00001",
      NOW,
      "0".repeat(64),
    );

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
      `INSERT INTO inventory_po_lines
         (po_line_id, tenant_id, supplier_order_id, provider_po_id, line_no, item_id, uom_id,
          ordered_quantity_scaled, unit_price_minor, tax_minor, freight_minor, currency,
          line_identity_sha256, status, version, created_at, updated_at)
       VALUES (?, ?, 'SUP-ORDER-001', 'PO-001', 1, ?, ?, 100, 500, 0, 0, 'CAD', ?, 'ordered', 1, ?, ?)`,
    ).run(PO_LINE, TENANT, ITEM_PANEL, UOM_EACH, "1".repeat(64), NOW, NOW);
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
      `INSERT INTO inventory_bins
         (bin_id, tenant_id, location_id, bin_code, bin_kind, status, created_at, updated_at)
       VALUES (?, ?, 'loc_wh_000001', 'B1', 'stock', 'active', ?, ?)`,
    ).run(BIN_B, TENANT, NOW, NOW);
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
  return {
    DB: db as never,
    RAW: new EvidenceR2() as never,
    APP_EVIDENCE_RECEIPTS_REQUIRED: "true",
  } as AppEnv;
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

// Every successful fixture crosses the actual multipart upload + D1 receipt + binary R2 readback.
async function handleInventoryRoute(req: Request, appEnv: AppEnv, actor: AuthContext): Promise<Response | null> {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/api/v1/inventory/commands") return inventoryRoute(req, appEnv, actor);
  const body = await req.clone().json() as Record<string, unknown>;
  const refs = body.evidence_refs as Array<{ ref: string; sha256: string }> | undefined;
  if (refs?.length === 1 && refs[0].ref === EVIDENCE_REF && refs[0].sha256 === EVIDENCE_SHA256) {
    delete body.evidence_refs;
    body.evidence_receipt_ids = [`evu_${"0".repeat(64)}`];
    const allowed = actor.session.role === "owner" || actor.session.role === "ops" || actor.session.role === "field" && ["issue_use", "return", "quarantine"].includes(String(body.transition));
    if (allowed && req.headers.has("x-csrf-token") && INVENTORY_TRANSITIONS.some((transition) => transition === body.transition)) {
      const db = appEnv.DB as never as SqliteD1;
      db.raw.exec("DELETE FROM app_action_throttles");
      const position = db.raw.prepare("SELECT lot_id FROM inventory_positions WHERE tenant_id = ? AND position_id = ?").get(actor.session.tenant_id, String(body.source_position_id ?? "")) as { lot_id: string } | undefined;
      body.evidence_receipt_ids = [await uploadedEvidence(appEnv, actor, {
        purpose: "stock", targetId: position?.lot_id ?? String(body.lot_id), action: String(body.transition), operationId: String(body.command_id),
      }, `upload-${body.command_id}`)];
    }
    req = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) });
  }
  return inventoryRoute(req, appEnv, actor);
}

function receivePayload(commandId: string, quantity: number) {
  return {
    command_id: commandId,
    idempotency_key: commandId,
    request_fingerprint_sha256: FINGERPRINT,
    transition: "receive",
    authority_ref: AUTHORITY_READBACK,
    policy_ref: "policy:inventory-command",
    policy_version: "1",
    evidence_refs: [{ ref: EVIDENCE_REF, sha256: EVIDENCE_SHA256 }],
    source_position_id: POS_A,
    item_id: ITEM_PANEL,
    lot_id: LOT_ONE,
    bin_id: BIN_A,
    uom_id: UOM_EACH,
    job_custody: "-",
    quantity_scaled: quantity,
    unit_cost_minor: 500,
    receipt_id: `receipt_${commandId}`,
    po_line_id: PO_LINE,
  };
}

function generatedPositionId(commandId: string): string {
  return `${commandId}.position`;
}

function ledgerCounts(db: SqliteD1): { commands: number; events: number; positions: number } {
  return {
    commands: Number((db.raw.prepare("SELECT COUNT(*) AS count FROM inventory_commands").get() as { count: number }).count),
    events: Number((db.raw.prepare("SELECT COUNT(*) AS count FROM inventory_events").get() as { count: number }).count),
    positions: Number((db.raw.prepare("SELECT COUNT(*) AS count FROM inventory_positions").get() as { count: number }).count),
  };
}

function addAuthorityReadback(
  db: SqliteD1,
  options: {
    readbackId: string;
    authorityRecordId?: string;
    authorityVersion: number;
    observedAt: string;
    verificationState?: AuthorityState;
    subjectType?: string | null;
    subjectRole?: string | null;
    personUser?: string | null;
    organization?: string | null;
    authorityKind?: string | null;
    authorityScope?: string | null;
    scopeType?: string | null;
    scopeRef?: string | null;
    roofJob?: string | null;
    scopeJson?: string | null;
    issuerJurisdiction?: string;
    issuerReference?: string;
    issuerSourceVersion?: string;
    authorityStateDigestSha256?: string;
    authorityEffectiveFrom?: string | null;
    authorityExpiresAt?: string | null;
    authorityRevokedAt?: string | null;
    supersedesAuthorityRecordId?: string | null;
    authorityVerificationMethod?: string;
    issuerReceiptSha256?: string | null;
  },
): void {
  db.raw.prepare(
      `INSERT INTO authority_record_readbacks
         (readback_id, tenant_id, authority_record_id, authority_version,
          subject_type, subject_role, person_user, organization, authority_kind,
          authority_scope, scope_type, scope_ref, roof_job, scope_json,
         issuer_name, issuer_jurisdiction, issuer_reference, issuer_source_version,
          verification_state, evidence_refs_json, evidence_sha256,
          authority_state_digest_sha256, authority_effective_from, authority_expires_at,
          authority_revoked_at, supersedes_authority_record_id, authority_verification_method,
          issuer_receipt_sha256,
          observed_by_user_id, observed_at, observation_fingerprint_sha256, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    options.readbackId,
    TENANT,
    options.authorityRecordId ?? AUTHORITY_RECORD,
    options.authorityVersion,
    options.subjectType === undefined ? "Organization" : options.subjectType,
    options.subjectRole === undefined ? "Inventory Authority" : options.subjectRole,
    options.personUser === undefined ? null : options.personUser,
    options.organization === undefined ? TENANT : options.organization,
    options.authorityKind === undefined ? "Inventory Command Authority" : options.authorityKind,
    options.authorityScope === undefined ? "inventory-command" : options.authorityScope,
    options.scopeType === undefined ? "Tenant" : options.scopeType,
    options.scopeRef === undefined ? TENANT : options.scopeRef,
    options.roofJob === undefined ? null : options.roofJob,
    options.scopeJson === undefined ? inventoryAuthorityScopeJson(TENANT) : options.scopeJson,
    "IronWrap Operations",
    options.issuerJurisdiction ?? "AB-CA",
    options.issuerReference ?? "internal:inventory-authority:1",
    options.issuerSourceVersion ?? "inventory-authority:1",
    options.verificationState ?? "verified",
    "[]",
    `${options.authorityVersion}`.repeat(64).slice(0, 64),
    options.authorityStateDigestSha256 ?? `${options.authorityVersion + 1}`.repeat(64).slice(0, 64),
    options.authorityEffectiveFrom === undefined ? "2026-08-01" : options.authorityEffectiveFrom,
    options.authorityExpiresAt === undefined ? "2026-12-31" : options.authorityExpiresAt,
    options.authorityRevokedAt === undefined ? null : options.authorityRevokedAt,
    options.supersedesAuthorityRecordId === undefined ? null : options.supersedesAuthorityRecordId,
    options.authorityVerificationMethod ?? "Internal Competency Assessment",
    options.issuerReceiptSha256 === undefined ? null : options.issuerReceiptSha256,
    USERS.owner,
    options.observedAt,
    `${options.authorityVersion + 2}`.repeat(64).slice(0, 64),
  );
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
  const created = await response?.json() as {
    kind: string;
    status: string;
    device_action_id: string;
    command: { status: string };
  };
  assert.equal(created.kind, "applied");
  assert.equal(created.status, "verified");
  assert.equal(created.device_action_id, "cmd_api_recv_001");
  assert.equal(created.command.status, "applied");

  const positionResponse = await handleInventoryRoute(
    request("GET", `/api/v1/inventory/positions/${generatedPositionId("cmd_api_recv_001")}`),
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

test("the inventory overview is tenant-scoped and advertises server-derived authority", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const applied = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_overview_recv", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(applied?.status, 201);

  const opsOverview = await handleInventoryRoute(
    request("GET", "/api/v1/inventory/overview"),
    appEnv,
    auth("ops"),
  );
  assert.equal(opsOverview?.status, 200);
  const opsRead = await opsOverview?.json() as {
    allowed_transitions: string[];
    authority_ref: string;
    policy_ref: string;
    policy_version: string;
    authority: { verification_state: string; authority_record_id: string };
    summary: {
      position_count: number;
      quantity_scaled: number;
      value_minor: number;
      quantity_by_uom: Array<{
        uom_id: string;
        uom_code: string;
        uom_scale: number;
        quantity_scaled: number;
        reserved_scaled: number;
        quarantined_scaled: number;
      }>;
      value_by_currency: Array<{ currency: string; value_minor: number }>;
    };
    items: Array<{ item_code: string }>;
    positions: Array<{
      item_code: string;
      lot_code: string;
      bin_code: string;
      quantity_scaled: number;
      uom_code: string;
      uom_dimension: string;
      quantity_scale: number;
    }>;
    uom_conversions: unknown[];
  };
  assert.deepEqual(opsRead.allowed_transitions, [
    "receive", "reserve", "release_reservation", "issue_use", "return", "transfer",
    "quarantine", "release_quarantine", "count_freeze", "count_adjustment", "yield", "reversal",
  ]);
  assert.equal(opsRead.authority_ref, AUTHORITY_READBACK);
  assert.equal(opsRead.policy_ref, "policy:inventory-command");
  assert.equal(opsRead.policy_version, "1");
  assert.equal(opsRead.authority.verification_state, "verified");
  assert.equal(opsRead.authority.authority_record_id, AUTHORITY_RECORD);
  assert.equal(opsRead.summary.position_count, 1);
  assert.equal(opsRead.summary.item_count, 1);
  assert.equal(opsRead.summary.quantity_scaled, 10);
  assert.equal(opsRead.summary.value_minor, 5000);
  assert.deepEqual(opsRead.summary.quantity_by_uom, [{
    uom_id: UOM_EACH,
    uom_code: "EA",
    uom_scale: 0,
    quantity_scaled: 10,
    reserved_scaled: 0,
    quarantined_scaled: 0,
  }]);
  assert.deepEqual(opsRead.summary.value_by_currency, [{ currency: "CAD", value_minor: 5000 }]);
  assert.equal(opsRead.items[0]?.item_code, "PANEL-24");
  assert.equal(opsRead.positions[0]?.item_code, "PANEL-24");
  assert.equal(opsRead.positions[0]?.lot_code, "L-0001");
  assert.equal(opsRead.positions[0]?.bin_code, "A1");
  assert.equal(opsRead.positions[0]?.quantity_scaled, 10);
  assert.equal(opsRead.positions[0]?.uom_code, "EA");
  assert.equal(opsRead.positions[0]?.uom_dimension, "count");
  assert.equal(opsRead.positions[0]?.quantity_scale, 0);
  assert.deepEqual(opsRead.uom_conversions, []);

  const fieldOverview = await handleInventoryRoute(
    request("GET", "/api/v1/inventory/overview"),
    appEnv,
    auth("field"),
  );
  assert.deepEqual(
    (await fieldOverview?.json() as { allowed_transitions: string[] }).allowed_transitions,
    ["issue_use", "return", "quarantine"],
  );
});

test("inventory barcode lookup is tenant-scoped and returns no guessed identity", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const found = await handleInventoryRoute(
    request("GET", "/api/v1/inventory/lookup?barcode=LOT-0001-BARCODE"),
    appEnv,
    auth("field"),
  );
  assert.equal(found?.status, 200);
  assert.deepEqual((await found?.json() as { result: unknown }).result, {
    barcode: "LOT-0001-BARCODE",
    symbology: "code128",
    entity_type: "lot",
    entity_id: LOT_ONE,
    item_code: "PANEL-24",
    lot_code: "L-0001",
    bin_code: null,
    location_code: null,
  });

  const unknown = await handleInventoryRoute(
    request("GET", "/api/v1/inventory/lookup?barcode=UNKNOWN-OTHER-TENANT"),
    appEnv,
    auth("field"),
  );
  assert.equal(unknown?.status, 200);
  assert.equal((await unknown?.json() as { result: unknown }).result, null);
});

test("the transition matrix permits field issue, return, and quarantine after an ops receipt", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);

  const received = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_matrix_recv", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(received?.status, 201);

  const issue = receivePayload("cmd_api_matrix_issue", 0);
  issue.transition = "issue_use";
  issue.source_position_id = generatedPositionId("cmd_api_matrix_recv");
  issue.quantity_scaled = 2;
  delete issue.unit_cost_minor;
  delete issue.receipt_id;
  delete issue.po_line_id;
  const issued = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", issue),
    appEnv,
    auth("field"),
  );
  assert.equal(issued?.status, 201);

  const returned = receivePayload("cmd_api_matrix_return", 0);
  returned.transition = "return";
  returned.source_position_id = generatedPositionId("cmd_api_matrix_recv");
  returned.quantity_scaled = 1;
  delete returned.receipt_id;
  delete returned.po_line_id;
  const returnedResponse = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", returned),
    appEnv,
    auth("field"),
  );
  assert.equal(returnedResponse?.status, 201);

  const quarantine = receivePayload("cmd_api_matrix_quar", 0);
  quarantine.transition = "quarantine";
  quarantine.source_position_id = generatedPositionId("cmd_api_matrix_recv");
  quarantine.quantity_scaled = 1;
  delete quarantine.unit_cost_minor;
  delete quarantine.receipt_id;
  delete quarantine.po_line_id;
  const quarantined = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", quarantine),
    appEnv,
    auth("field"),
  );
  assert.equal(quarantined?.status, 201);
  assert.deepEqual(ledgerCounts(db), { commands: 4, events: 4, positions: 1 });
  assert.equal(
    (db.raw.prepare("SELECT quarantined_scaled FROM inventory_positions WHERE position_id = ?")
      .get(generatedPositionId("cmd_api_matrix_recv")) as { quarantined_scaled: number }).quarantined_scaled,
    1,
  );
});

test("field receive and release_quarantine are denied before any ledger mutation", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const before = ledgerCounts(db);

  const deniedReceive = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_field_recv", 5)),
    appEnv,
    auth("field"),
  );
  assert.equal(deniedReceive?.status, 403);
  assert.equal(
    (await deniedReceive?.json() as { error: string }).error,
    "inventory_transition_role_required",
  );

  const deniedRelease = receivePayload("cmd_api_field_release", 0);
  deniedRelease.transition = "release_quarantine";
  deniedRelease.quantity_scaled = 1;
  delete deniedRelease.unit_cost_minor;
  delete deniedRelease.receipt_id;
  delete deniedRelease.po_line_id;
  const releaseResponse = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", deniedRelease),
    appEnv,
    auth("field"),
  );
  assert.equal(releaseResponse?.status, 403);
  assert.equal(
    (await releaseResponse?.json() as { error: string }).error,
    "inventory_transition_role_required",
  );
  assert.deepEqual(ledgerCounts(db), before);
});

test("policy identity mismatches are denied before any ledger mutation", async () => {
  for (const [field, value, error] of [
    ["policy_ref", "policy:inventory", "inventory_policy_reference_mismatch"],
    ["policy_version", "v1", "inventory_policy_version_mismatch"],
  ] as const) {
    const db = new SqliteD1();
    const payload = receivePayload(`cmd_api_policy_${field}`, 5);
    payload[field] = value;
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", payload),
      env(db),
      auth("ops"),
    );
    assert.equal(response?.status, 403);
    assert.equal((await response?.json() as { error: string }).error, error);
    assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
  }
});

test("owner commands persist the owner actor type", async () => {
  const db = new SqliteD1();
  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_owner_recv", 5)),
    env(db),
    auth("owner"),
  );
  assert.equal(response?.status, 201);
  assert.equal(
    (db.raw.prepare("SELECT actor_type FROM inventory_commands WHERE command_id = ?")
      .get("cmd_api_owner_recv") as { actor_type: string }).actor_type,
    "owner",
  );
});

test("non-current or non-verified authority readbacks fail closed without ledger writes", async () => {
  for (const [state, error] of [
    ["revoked", "inventory_authority_revoked"],
    ["contradictory", "inventory_authority_contradictory"],
    ["unavailable", "inventory_authority_unavailable"],
  ] as const) {
    const db = new SqliteD1({ authorityState: state });
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", receivePayload(`cmd_api_${state}`, 5)),
      env(db),
      auth("ops"),
    );
    assert.equal(response?.status, 403);
    assert.equal((await response?.json() as { error: string }).error, error);
    assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
  }

  const missingDb = new SqliteD1();
  const missing = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_missing", 5),
      authority_ref: "Authority-Inventory-Missing-01",
    }),
    env(missingDb),
    auth("ops"),
  );
  assert.equal(missing?.status, 403);
  assert.equal((await missing?.json() as { error: string }).error, "inventory_authority_missing");
  assert.deepEqual(ledgerCounts(missingDb), { commands: 0, events: 0, positions: 0 });

  const crossTenantDb = new SqliteD1();
  const crossTenant = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_cross", 5),
      authority_ref: OTHER_AUTHORITY_READBACK,
    }),
    env(crossTenantDb),
    auth("ops"),
  );
  assert.equal(crossTenant?.status, 403);
  assert.equal((await crossTenant?.json() as { error: string }).error, "inventory_authority_missing");
  assert.deepEqual(ledgerCounts(crossTenantDb), { commands: 0, events: 0, positions: 0 });

  const staleDb = new SqliteD1();
  addAuthorityReadback(staleDb, {
    readbackId: "Authority-Inventory-Readback-02",
    authorityVersion: 1,
    observedAt: "2026-08-18T12:00:00.000Z",
    authorityStateDigestSha256: "c".repeat(64),
  });
  const stale = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_stale", 5),
      authority_ref: AUTHORITY_READBACK,
    }),
    env(staleDb),
    auth("ops"),
  );
  assert.equal(stale?.status, 403);
  assert.equal((await stale?.json() as { error: string }).error, "inventory_authority_stale");
  assert.deepEqual(ledgerCounts(staleDb), { commands: 0, events: 0, positions: 0 });

  const supersededDb = new SqliteD1();
  addAuthorityReadback(supersededDb, {
    readbackId: "Authority-Inventory-Readback-03",
    authorityVersion: 2,
    observedAt: "2026-08-18T12:00:00.000Z",
  });
  const superseded = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_super", 5),
      authority_ref: AUTHORITY_READBACK,
    }),
    env(supersededDb),
    auth("ops"),
  );
  assert.equal(superseded?.status, 403);
  assert.equal((await superseded?.json() as { error: string }).error, "inventory_authority_superseded");
  assert.deepEqual(ledgerCounts(supersededDb), { commands: 0, events: 0, positions: 0 });

  const newerRevokedDb = new SqliteD1();
  addAuthorityReadback(newerRevokedDb, {
    readbackId: "Authority-Inventory-Readback-04",
    authorityVersion: 2,
    observedAt: "2026-08-19T12:00:00.000Z",
    verificationState: "revoked",
  });
  const newerRevoked = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_newer_revoked", 5),
      authority_ref: AUTHORITY_READBACK,
    }),
    env(newerRevokedDb),
    auth("ops"),
  );
  assert.equal(newerRevoked?.status, 403);
  assert.equal((await newerRevoked?.json() as { error: string }).error, "inventory_authority_revoked");
  assert.deepEqual(ledgerCounts(newerRevokedDb), { commands: 0, events: 0, positions: 0 });

  const expiredDb = new SqliteD1();
  addAuthorityReadback(expiredDb, {
    readbackId: "Authority-Inventory-Expired-01",
    authorityVersion: 2,
    observedAt: "2026-08-19T12:00:00.000Z",
    authorityExpiresAt: "2026-08-16",
  });
  const expired = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_expired", 5),
      authority_ref: "Authority-Inventory-Expired-01",
    }),
    env(expiredDb),
    auth("ops"),
  );
  assert.equal(expired?.status, 403);
  assert.equal((await expired?.json() as { error: string }).error, "inventory_authority_expired");
  assert.deepEqual(ledgerCounts(expiredDb), { commands: 0, events: 0, positions: 0 });

  const ambiguousDb = new SqliteD1();
  addAuthorityReadback(ambiguousDb, {
    readbackId: "Authority-Inventory-Ambiguous-01",
    authorityRecordId: "Authority-Inventory-Ambiguous-Record-01",
    authorityVersion: 2,
    observedAt: "2026-08-19T12:00:00.000Z",
    supersedesAuthorityRecordId: AUTHORITY_RECORD,
  });
  addAuthorityReadback(ambiguousDb, {
    readbackId: "Authority-Inventory-Ambiguous-02",
    authorityRecordId: "Authority-Inventory-Ambiguous-Record-02",
    authorityVersion: 2,
    observedAt: "2026-08-19T12:00:00.000Z",
    supersedesAuthorityRecordId: AUTHORITY_RECORD,
  });
  const ambiguous = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_ambiguous", 5),
      authority_ref: AUTHORITY_READBACK,
    }),
    env(ambiguousDb),
    auth("ops"),
  );
  assert.equal(ambiguous?.status, 403);
  assert.equal((await ambiguous?.json() as { error: string }).error, "inventory_authority_ambiguous");
  assert.deepEqual(ledgerCounts(ambiguousDb), { commands: 0, events: 0, positions: 0 });

  const jurisdictionDb = new SqliteD1();
  addAuthorityReadback(jurisdictionDb, {
    readbackId: "Authority-Inventory-Jurisdiction-01",
    authorityRecordId: "Authority-Inventory-Jurisdiction-Record",
    authorityVersion: 2,
    observedAt: "2026-08-19T12:00:00.000Z",
    issuerJurisdiction: "BC-CA",
  });
  const jurisdiction = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_jurisdiction", 5),
      authority_ref: "Authority-Inventory-Jurisdiction-01",
    }),
    env(jurisdictionDb),
    auth("ops"),
  );
  assert.equal(jurisdiction?.status, 403);
  assert.equal((await jurisdiction?.json() as { error: string }).error, "inventory_authority_jurisdiction_mismatch");
  assert.deepEqual(ledgerCounts(jurisdictionDb), { commands: 0, events: 0, positions: 0 });
});

test("a verified authority readback outside the inventory scope fails closed", async () => {
  const db = new SqliteD1();
  addAuthorityReadback(db, {
    readbackId: UNRELATED_AUTHORITY_READBACK,
    authorityRecordId: "Authority-Licence-0001",
    authorityVersion: 1,
    observedAt: "2026-08-19T12:00:00.000Z",
    issuerReference: "external:licence-authority:1",
    issuerSourceVersion: "licence-authority:2026",
  });

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_authority_unrelated", 5),
      authority_ref: UNRELATED_AUTHORITY_READBACK,
    }),
    env(db),
    auth("ops"),
  );
  assert.equal(response?.status, 403);
  assert.equal((await response?.json() as { error: string }).error, "inventory_authority_scope_mismatch");
  assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
});

test("same-issuer readbacks bind the inventory command to its subject, role, and scope", async () => {
  const cases = [
    {
      name: "wrong subject type",
      readbackId: "Authority-Inventory-Wrong-Subject-01",
      subjectType: "Person",
      subjectRole: "Worker",
      personUser: USERS.field,
      expected: "inventory_authority_subject_mismatch",
    },
    {
      name: "wrong subject role",
      readbackId: "Authority-Inventory-Wrong-Role-01",
      subjectRole: "Field Worker",
      expected: "inventory_authority_subject_mismatch",
    },
    {
      name: "wrong actor class in the scope",
      readbackId: "Authority-Inventory-Wrong-Actor-01",
      role: "field",
      transition: "issue_use",
      scopeJson: JSON.stringify({
        purpose: "inventory-command",
        tenant_id: TENANT,
        allowed_roles: ["owner", "ops"],
        operational_scope: { scope_type: "Tenant", scope_ref: TENANT },
      }),
      expected: "inventory_authority_scope_mismatch",
    },
    {
      name: "wrong inventory purpose",
      readbackId: "Authority-Inventory-Wrong-Purpose-01",
      authorityScope: "licence",
      scopeJson: JSON.stringify({
        purpose: "licence",
        tenant_id: TENANT,
        allowed_roles: ["owner", "ops", "field"],
        operational_scope: { scope_type: "Tenant", scope_ref: TENANT },
      }),
      expected: "inventory_authority_scope_mismatch",
    },
    {
      name: "same-issuer unrelated licence record",
      readbackId: UNRELATED_AUTHORITY_READBACK,
      authorityRecordId: "Authority-Licence-0001",
      authorityKind: "Trade Licence",
      authorityScope: "licence",
      scopeType: "Organization",
      scopeRef: TENANT,
      authorityVerificationMethod: "Issuer Portal Readback",
      issuerReceiptSha256: "f".repeat(64),
      scopeJson: JSON.stringify({
        purpose: "licence",
        tenant_id: TENANT,
        allowed_roles: ["owner", "ops"],
        operational_scope: { scope_type: "Organization", scope_ref: TENANT },
      }),
      expected: "inventory_authority_scope_mismatch",
    },
  ] as const;

  for (const testCase of cases) {
    const db = new SqliteD1();
    addAuthorityReadback(db, {
      ...testCase,
      authorityVersion: 2,
      observedAt: "2026-08-19T12:00:00.000Z",
    });
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", {
        ...receivePayload(`cmd_api_binding_${testCase.name.replaceAll(" ", "_")}`, 5),
        authority_ref: testCase.readbackId,
        ...(testCase.transition ? { transition: testCase.transition } : {}),
      }),
      env(db),
      auth(testCase.role ?? "ops"),
    );
    assert.equal(response?.status, 403, testCase.name);
    assert.equal((await response?.json() as { error: string }).error, testCase.expected, testCase.name);
    assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 }, testCase.name);
  }
});

test("a command operational scope must match the tenant authority scope", async () => {
  const db = new SqliteD1();
  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_operational_scope_mismatch", 5),
      payload: {
        operational_scope: { scope_type: "Bin", scope_ref: BIN_A },
      },
    }),
    env(db),
    auth("ops"),
  );
  assert.equal(response?.status, 403);
  assert.equal(
    (await response?.json() as { error: string }).error,
    "inventory_authority_scope_mismatch",
  );
  assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
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
    .get(generatedPositionId("cmd_api_recv_001")) as { quantity_scaled: number };
  assert.equal(position.quantity_scaled, 10);
});

test("stock intent needs no caller fingerprint and changed quantities cannot reuse a caller hash", async () => {
  const db = new SqliteD1(); const appEnv = env(db);
  const payload = receivePayload("cmd_receipt_server_hash_1", 10);
  const { request_fingerprint_sha256: _legacy, ...withoutFingerprint } = payload;
  const first = await handleInventoryRoute(request("POST", "/api/v1/inventory/commands", withoutFingerprint), appEnv, auth("ops"));
  assert.equal(first?.status, 201);
  const retry = await handleInventoryRoute(request("POST", "/api/v1/inventory/commands", payload), appEnv, auth("ops"));
  assert.equal(retry?.status, 200);
  const changed = await handleInventoryRoute(request("POST", "/api/v1/inventory/commands", { ...payload, quantity_scaled: 11 }), appEnv, auth("ops"));
  assert.equal(changed?.status, 409);
  assert.equal((db.raw.prepare("SELECT quantity_scaled FROM inventory_positions").get() as { quantity_scaled: number }).quantity_scaled, 10);
});

test("default rollout preserves legacy stock refs but verifies their binary bytes", async () => {
  const db = new SqliteD1(); const appEnv = env(db); delete appEnv.APP_EVIDENCE_RECEIPTS_REQUIRED;
  const raw = appEnv.RAW as never as EvidenceR2;
  raw.rows.set(`inventory-evidence/${TENANT}/receipt`, { bytes: EVIDENCE_BYTES.slice(), httpMetadata: { contentType: "image/png" }, customMetadata: {} });
  const payload = { ...receivePayload("cmd_legacy_binary_01", 10), evidence_refs: [{ ref: EVIDENCE_REF, sha256: createHash("sha256").update(EVIDENCE_BYTES).digest("hex") }] };
  const first = await inventoryRoute(request("POST", "/api/v1/inventory/commands", payload), appEnv, auth("ops"));
  assert.equal(first?.status, 201);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 0);
  raw.rows.values().next().value!.bytes[14] ^= 1;
  const changed = await inventoryRoute(request("POST", "/api/v1/inventory/commands", { ...payload, command_id: "cmd_legacy_binary_02", idempotency_key: "cmd_legacy_binary_02" }), appEnv, auth("ops"));
  assert.equal(changed?.status, 403);
  assert.equal((await changed!.json() as { error: string }).error, "inventory_evidence_hash_mismatch");
  assert.equal((db.raw.prepare("SELECT quantity_scaled FROM inventory_positions").get() as { quantity_scaled: number }).quantity_scaled, 10);
});

test("stock missing or tampered receipt files and wrong command scopes cannot start a ledger mutation", async () => {
  for (const failure of ["missing", "tampered", "wrong_command", "wrong_lot"]) {
    const db = new SqliteD1(); const appEnv = env(db); const actor = auth("ops");
    const payload = receivePayload("cmd_evidence_actual_01", 5);
    const id = await uploadedEvidence(appEnv, actor, { purpose: "stock", targetId: LOT_ONE, action: "receive", operationId: "cmd_evidence_actual_01" });
    const { evidence_refs: _legacy, ...command } = payload;
    command.evidence_receipt_ids = [id];
    const raw = appEnv.RAW as never as EvidenceR2;
    if (failure === "missing") raw.rows.clear();
    if (failure === "tampered") raw.rows.values().next().value!.bytes[14] ^= 1;
    if (failure === "wrong_command") command.command_id = "cmd_evidence_actual_02";
    if (failure === "wrong_lot") command.lot_id = "lot_other_0001";
    const refused = await inventoryRoute(request("POST", "/api/v1/inventory/commands", command), appEnv, actor);
    assert.ok([403,404,409].includes(refused!.status));
    assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
  }
});

test("a server-planned transfer with no distinct target moves nothing", async () => {
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
    quantity_scaled: 3,
    source_position_id: generatedPositionId("cmd_api_recv_001"),
    target_position_id: generatedPositionId("cmd_api_recv_001"),
  };

  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", oneLeggedTransfer),
    appEnv,
    auth("ops"),
  );
  assert.equal(response?.status, 409);
  const refused = await response?.json() as { error: string };
  assert.equal(refused.error, "inventory_transfer_target_required");

  const position = db.raw
    .prepare("SELECT quantity_scaled FROM inventory_positions WHERE position_id = ?")
    .get(generatedPositionId("cmd_api_recv_001")) as { quantity_scaled: number };
  assert.equal(position.quantity_scaled, 10);
});

test("a transfer requires and preserves the same item, lot, and unit at its destination", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const sourceReceipt = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_transfer_src", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(sourceReceipt?.status, 201);

  const targetReceipt = receivePayload("cmd_api_transfer_dst", 4);
  delete targetReceipt.source_position_id;
  targetReceipt.bin_id = BIN_B;
  const targetResponse = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", targetReceipt),
    appEnv,
    auth("ops"),
  );
  assert.equal(targetResponse?.status, 201);

  const transfer = receivePayload("cmd_api_transfer_move", 0);
  transfer.transition = "transfer";
  transfer.source_position_id = generatedPositionId("cmd_api_transfer_src");
  transfer.target_position_id = generatedPositionId("cmd_api_transfer_dst");
  transfer.quantity_scaled = 3;
  delete transfer.unit_cost_minor;
  delete transfer.receipt_id;
  delete transfer.po_line_id;
  const moved = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", transfer),
    appEnv,
    auth("ops"),
  );
  assert.equal(moved?.status, 201);
  const target = db.raw.prepare(
    "SELECT item_id, lot_id, uom_id, quantity_scaled FROM inventory_positions WHERE position_id = ?",
  ).get(generatedPositionId("cmd_api_transfer_dst")) as {
    item_id: string;
    lot_id: string;
    uom_id: string;
    quantity_scaled: number;
  };
  assert.equal(target.item_id, ITEM_PANEL);
  assert.equal(target.lot_id, LOT_ONE);
  assert.equal(target.uom_id, UOM_EACH);
  assert.equal(target.quantity_scaled, 7);
  assert.equal(
    (db.raw.prepare(
      "SELECT COUNT(*) AS count FROM inventory_valuation_allocations WHERE tenant_id = ? AND event_id IN (SELECT event_id FROM inventory_events WHERE command_id = ?)",
    ).get(TENANT, "cmd_api_transfer_move") as { count: number }).count,
    1,
  );
});

test("FIFO valuation draws across current tenant layers on the server", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  db.raw.prepare("UPDATE inventory_items SET valuation_method = 'fifo', lot_controlled = 0, revision = revision + 1 WHERE tenant_id = ? AND item_id = ?")
    .run(TENANT, ITEM_PANEL);
  const first = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_fifo_first", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(first?.status, 201);
  const second = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_fifo_second", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(second?.status, 201);
  const issue = receivePayload("cmd_api_fifo_issue", 0);
  issue.transition = "issue_use";
  issue.source_position_id = generatedPositionId("cmd_api_fifo_first");
  issue.quantity_scaled = 15;
  delete issue.unit_cost_minor;
  delete issue.receipt_id;
  delete issue.po_line_id;
  const issued = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", issue),
    appEnv,
    auth("ops"),
  );
  assert.equal(issued?.status, 201);
  const allocations = db.raw.prepare(
    `SELECT allocation.quantity_scaled, layer.unit_cost_minor
       FROM inventory_valuation_allocations AS allocation
       JOIN inventory_valuation_layers AS layer ON layer.layer_id = allocation.layer_id
      WHERE allocation.tenant_id = ?
        AND allocation.event_id IN (SELECT event_id FROM inventory_events WHERE command_id = ?)
      ORDER BY allocation.created_at ASC`,
  ).all(TENANT, "cmd_api_fifo_issue") as Array<{ quantity_scaled: number; unit_cost_minor: number }>;
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0]?.quantity_scaled, 10);
  assert.equal(allocations[0]?.unit_cost_minor, 500);
  assert.equal(allocations[1]?.quantity_scaled, 5);
  assert.equal(allocations[1]?.unit_cost_minor, 500);
});

test("overview totals stay grouped when tenant positions use different units", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const boxUom = "uom_box_0001";
  const boxItem = "item_box_0001";
  const boxLot = "lot_box_0001";
  const boxPoLine = "po_line_box_0001";
  const eachReceipt = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_mixed_uom_each", 1)),
    appEnv,
    auth("ops"),
  );
  assert.equal(eachReceipt?.status, 201);
  db.raw.prepare(
    `INSERT INTO inventory_uoms
       (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at)
     VALUES (?, ?, 'BOX', 'count', 0, 'active', ?, ?)`,
  ).run(boxUom, TENANT, NOW, NOW);
  db.raw.prepare(
    `INSERT INTO inventory_items
       (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale,
        lot_controlled, valuation_method, source_ref, created_at, updated_at)
     VALUES (?, ?, 'BOXED-PANEL', 'active', 'raw_material', ?, 0, 1, 'actual', 'seed', ?, ?)`,
  ).run(boxItem, TENANT, boxUom, NOW, NOW);
  db.raw.prepare(
    `INSERT INTO inventory_lots
       (lot_id, tenant_id, item_id, lot_code, lot_kind, status, unit_cost_minor,
        evidence_refs_json, created_at, updated_at)
     VALUES (?, ?, ?, 'BOX-LOT-1', 'purchased', 'available', 2500, '[]', ?, ?)`,
  ).run(boxLot, TENANT, boxItem, NOW, NOW);
  db.raw.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, provider_po_id, line_no, item_id, uom_id,
        ordered_quantity_scaled, unit_price_minor, tax_minor, freight_minor, currency,
        line_identity_sha256, status, version, created_at, updated_at)
     VALUES (?, ?, 'SUP-ORDER-BOX', 'PO-BOX-1', 1, ?, ?, 100, 2500, 0, 0, 'CAD', ?, 'ordered', 1, ?, ?)`,
  ).run(boxPoLine, TENANT, boxItem, boxUom, "2".repeat(64), NOW, NOW);
  const boxReceipt = receivePayload("cmd_api_mixed_uom_box", 2);
  delete boxReceipt.source_position_id;
  boxReceipt.item_id = boxItem;
  boxReceipt.lot_id = boxLot;
  boxReceipt.uom_id = boxUom;
  boxReceipt.po_line_id = boxPoLine;
  boxReceipt.unit_cost_minor = 2500;
  const received = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", boxReceipt),
    appEnv,
    auth("ops"),
  );
  assert.equal(received?.status, 201);

  const overview = await handleInventoryRoute(
    request("GET", "/api/v1/inventory/overview"),
    appEnv,
    auth("ops"),
  );
  const read = await overview?.json() as {
    summary: {
      quantity_scaled: number;
      value_minor: number;
      quantity_by_uom: Array<{ uom_code: string; quantity_scaled: number }>;
      value_by_currency: Array<{ currency: string; value_minor: number }>;
    };
  };
  assert.equal(read.summary.quantity_scaled, 0);
  assert.equal(read.summary.value_minor, 5500);
  assert.deepEqual(read.summary.quantity_by_uom.map((group) => [group.uom_code, group.quantity_scaled]), [
    ["BOX", 2],
    ["EA", 1],
  ]);
  assert.deepEqual(read.summary.value_by_currency, [{ currency: "CAD", value_minor: 5500 }]);
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

  for (const [payload, expected] of [
    [{ ...receivePayload("cmd_api_bad_0001", 5), transition: "teleport" }, "invalid_inventory_command"],
    [{ ...receivePayload("cmd_api_bad_0002", 5), movements: [] }, "inventory_command_intent_required"],
    [{ ...receivePayload("cmd_api_bad_0003", 5), request_fingerprint_sha256: "short" }, "invalid_inventory_command"],
    [{ ...receivePayload("cmd_api_bad_0004", 5), evidence_refs: [{ ref: "r2://x", sha256: "no" }] }, "evidence_receipts_required"],
  ] as const) {
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", payload),
      appEnv,
      auth("ops"),
    );
    assert.equal(response?.status, 400);
    assert.equal(
      (await response?.json() as { error: string }).error,
      expected,
    );
  }

  const count = db.raw
    .prepare("SELECT COUNT(*) AS count FROM inventory_commands")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("a crafted ledger-shaped body is rejected before any inventory mutation", async () => {
  const db = new SqliteD1();
  const before = ledgerCounts(db);
  const response = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", {
      ...receivePayload("cmd_api_crafted_ledger_001", 5),
      movements: [{
        position_id: "attacker-position-001",
        item_id: ITEM_PANEL,
        lot_id: LOT_ONE,
        bin_id: BIN_A,
        uom_id: UOM_EACH,
        quantity_delta_scaled: 999999,
        value_delta_minor: 1,
      }],
      layers: [{
        layer_id: "attacker-layer-001",
        movement_index: 0,
        layer_kind: "receipt",
        unit_cost_minor: 1,
      }],
      allocations: [{
        allocation_id: "attacker-allocation-001",
        movement_index: 0,
        layer_id: "attacker-layer-001",
        quantity_scaled: 999999,
      }],
    }),
    env(db),
    auth("ops"),
  );
  assert.equal(response?.status, 400);
  assert.equal((await response?.json() as { error: string }).error, "inventory_command_intent_required");
  assert.deepEqual(ledgerCounts(db), before);
});

test("missing or tampered evidence fails closed before any inventory mutation", async () => {
  for (const [evidence, expected] of [
    [{ ref: EVIDENCE_REF, sha256: "0".repeat(64) }, "evidence_receipts_required"],
    [{ ref: `r2://inventory-evidence/${TENANT}/not-present`, sha256: EVIDENCE_SHA256 }, "evidence_receipts_required"],
  ] as const) {
    const db = new SqliteD1();
    const response = await handleInventoryRoute(
      request("POST", "/api/v1/inventory/commands", {
        ...receivePayload(`cmd_api_evidence_${expected.slice(-8)}`, 5),
        evidence_refs: [evidence],
      }),
      env(db),
      auth("ops"),
    );
    assert.equal(response?.status, 400);
    assert.equal((await response?.json() as { error: string }).error, expected);
    assert.deepEqual(ledgerCounts(db), { commands: 0, events: 0, positions: 0 });
  }
});

test("server intent writes receipt, reservation, release, and count companions atomically", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const received = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", receivePayload("cmd_api_companion_recv", 10)),
    appEnv,
    auth("ops"),
  );
  assert.equal(received?.status, 201);
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS count FROM inventory_receipt_lines WHERE command_id = ?")
      .get("cmd_api_companion_recv") as { count: number }).count,
    1,
  );

  const reserve = receivePayload("cmd_api_companion_reserve", 0);
  reserve.transition = "reserve";
  reserve.source_position_id = generatedPositionId("cmd_api_companion_recv");
  reserve.quantity_scaled = 2;
  reserve.job_id = "job-companion-001";
  delete reserve.unit_cost_minor;
  delete reserve.receipt_id;
  delete reserve.po_line_id;
  const reserved = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", reserve),
    appEnv,
    auth("ops"),
  );
  assert.equal(reserved?.status, 201);
  const reservationId = `${reserve.command_id}.reservation`;
  assert.equal(
    (db.raw.prepare("SELECT status, reserved_quantity_scaled FROM inventory_reservations WHERE reservation_id = ?")
      .get(reservationId) as { status: string; reserved_quantity_scaled: number }).status,
    "reserved",
  );

  const release = receivePayload("cmd_api_companion_release", 0);
  release.transition = "release_reservation";
  release.source_position_id = generatedPositionId("cmd_api_companion_recv");
  release.quantity_scaled = 2;
  release.reservation_id = reservationId;
  delete release.unit_cost_minor;
  delete release.receipt_id;
  delete release.po_line_id;
  const released = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", release),
    appEnv,
    auth("ops"),
  );
  assert.equal(released?.status, 201);
  const releasedRow = db.raw.prepare(
    "SELECT status, reserved_quantity_scaled FROM inventory_reservations WHERE reservation_id = ?",
  ).get(reservationId) as { status: string; reserved_quantity_scaled: number };
  assert.equal(releasedRow.status, "released");
  assert.equal(
    (db.raw.prepare("SELECT reserved_scaled FROM inventory_positions WHERE position_id = ?")
      .get(generatedPositionId("cmd_api_companion_recv")) as { reserved_scaled: number }).reserved_scaled,
    0,
  );

  const freeze = receivePayload("cmd_api_companion_freeze", 0);
  freeze.transition = "count_freeze";
  freeze.source_position_id = generatedPositionId("cmd_api_companion_recv");
  freeze.count_session_id = "count-session-companion-001";
  delete freeze.unit_cost_minor;
  delete freeze.receipt_id;
  delete freeze.po_line_id;
  const frozen = await handleInventoryRoute(
    request("POST", "/api/v1/inventory/commands", freeze),
    appEnv,
    auth("ops"),
  );
  assert.equal(frozen?.status, 201);
  assert.equal(
    (db.raw.prepare("SELECT status FROM inventory_count_sessions WHERE count_session_id = ?")
      .get(freeze.count_session_id) as { status: string }).status,
    "frozen",
  );
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS count FROM inventory_count_lines WHERE count_session_id = ?")
      .get(freeze.count_session_id) as { count: number }).count,
    1,
  );
  assert.equal(
    (db.raw.prepare("SELECT freeze_state FROM inventory_bins WHERE bin_id = ?")
      .get(BIN_A) as { freeze_state: string }).freeze_state,
    "frozen",
  );
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
