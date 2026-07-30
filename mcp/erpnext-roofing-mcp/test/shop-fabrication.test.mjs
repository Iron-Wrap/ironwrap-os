import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { approvedArgs, digest, parseToolPayload, signApprovalReceipt } from "../src/approval-contract.mjs";
import { buildServer } from "../src/server.mjs";

function controlledItemFixture(overrides = {}) {
  return {
    name: "item-1",
    controlled_item_id: "item-1",
    status: "Draft",
    source_ref: "supplier-spec:2026-07",
    modified: "2026-07-30 10:00:00",
    ...overrides,
  };
}

function shopOrderFixture(overrides = {}) {
  return {
    name: "shop-1",
    shop_order_id: "shop-1",
    roof_job: "JOB-1",
    material_takeoff: "takeoff-1",
    supplier_order: "supplier-1",
    work_package: "package-1",
    status: "Released",
    lines: [{ line_no: 1, controlled_item: "item-1", accepted_quantity: 8 }],
    material_allocations: [],
    modified: "2026-07-30 10:05:00",
    ...overrides,
  };
}

function materialLotFixture(overrides = {}) {
  return {
    name: "lot-a",
    material_lot_id: "lot-a",
    roof_job: "JOB-1",
    controlled_item: "item-1",
    source_kind: "Supplier Receipt",
    supplier_order: "supplier-1",
    source_shop_order: "",
    status: "Available",
    available_quantity: 6,
    reserved_quantity: 0,
    consumed_quantity: 4,
    unit: "each",
    modified: "2026-07-30 10:06:00",
    ...overrides,
  };
}

function approvalArgs({
  privateKey,
  dryRun,
  runId,
  args,
  agentRole,
  actorUser,
  approvedBy = "owner@example.com",
  expectedSnapshotSha256 = dryRun.expected_snapshot_sha256,
}) {
  const writeArgs = {
    ...args,
    expected_snapshot_sha256: expectedSnapshotSha256,
    request_text: "Approved governed shop command.",
    approved_by: approvedBy,
    run_id: runId,
    dry_run_receipt: dryRun.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: dryRun.approval_request.write_tool,
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: agentRole,
    actor_user: actorUser,
    site_id: dryRun.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return writeArgs;
}

test("controlled-item dry run returns a receipt-bound snapshot preview without writing", async (t) => {
  const item = controlledItemFixture();
  const requests = [];
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "owner-operator",
    actorUser: "owner@example.com",
    dryRunSigningKey: "p".repeat(32),
    allowedTools: ["dry_run_approve_controlled_item"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    requests.push({ method: init.method ?? "GET", target });
    if (target.includes("Controlled%20Item/item-1")) {
      return Response.json({ data: item });
    }
    throw new Error(`unexpected request ${init.method ?? "GET"} ${target}`);
  });

  const preview = parseToolPayload(
    await server._registeredTools.dry_run_approve_controlled_item.handler({ controlled_item_id: "item-1" }),
  );

  assert.equal(preview.required_tool, "request_approve_controlled_item");
  assert.equal(preview.target.name, "item-1");
  assert.equal(preview.before.status, "Draft");
  assert.equal(
    preview.expected_snapshot_sha256,
    digest({ controlled_item: { name: "item-1", controlled_item_id: "item-1", status: "Draft", modified: "2026-07-30 10:00:00" } }),
  );
  assert.match(preview.approval_request.dry_run_receipt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(requests.every(({ method }) => method === "GET"));
});

test("reserve-shop-order request stores the exact approved args in Hermes Run and calls only the bounded Frappe method", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const actorUser = "production@example.com";
  const allocationsJson = JSON.stringify([
    {
      allocation_id: "alloc-1",
      line_no: 1,
      material_lot: "lot-a",
      reserved_quantity: 3,
      unit: "each",
    },
  ]);
  const order = shopOrderFixture();
  const takeoff = { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" };
  const supplierOrder = { name: "supplier-1", roof_job: "JOB-1", status: "Received" };
  const workPackage = { name: "package-1", roof_job: "JOB-1", status: "Released" };
  const lot = materialLotFixture();
  const requests = [];
  let hermesRunInsert = null;
  let hermesRunCreates = 0;
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "production-controller",
    actorUser,
    approverId: "owner@example.com",
    dryRunSigningKey: "p".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    allowedTools: ["dry_run_reserve_shop_order_materials", "request_reserve_shop_order_materials"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    requests.push({ method, target, body: init.body });
    if (method === "GET" && target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (method === "GET" && target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: takeoff });
    if (method === "GET" && target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: supplierOrder });
    if (method === "GET" && target.includes("Work%20Package/package-1")) return Response.json({ data: workPackage });
    if (method === "GET" && target.includes("Material%20Lot/lot-a")) return Response.json({ data: lot });
    if (method === "GET" && target.includes("Hermes%20Run/run-shop-reserve-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (method === "POST" && target.endsWith("/api/resource/Hermes%20Run")) {
      hermesRunCreates += 1;
      hermesRunInsert = JSON.parse(init.body);
      return Response.json({ data: { name: "run-shop-reserve-0001" } });
    }
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.reserve_shop_order_materials")) {
      return Response.json({
        message: {
          shop_order: { shop_order_id: "shop-1", status: "Reserved" },
          material_lots: [{ material_lot_id: "lot-a", status: "Reserved" }],
          hermes_run_id: "run-shop-reserve-0001",
        },
      });
    }
    if (method === "PUT" && target.includes("Hermes%20Run/run-shop-reserve-0001")) {
      return Response.json({ data: { ok: true } });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  });

  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_reserve_shop_order_materials.handler({
      shop_order_id: "shop-1",
      allocations_json: allocationsJson,
    }),
  );
  const args = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-shop-reserve-0001",
    args: { shop_order_id: "shop-1", allocations_json: allocationsJson },
    agentRole: "production-controller",
    actorUser,
  });

  const result = parseToolPayload(
    await server._registeredTools.request_reserve_shop_order_materials.handler(args),
  );

  assert.equal(result.reserved, true);
  assert.equal(result.result.message.shop_order.status, "Reserved");
  assert.equal(hermesRunInsert.tool_name, "request_reserve_shop_order_materials");
  assert.equal(JSON.parse(hermesRunInsert.tool_args_json).allocations_json, allocationsJson);
  assert.equal(
    JSON.parse(hermesRunInsert.tool_args_json).expected_snapshot_sha256,
    dryRun.expected_snapshot_sha256,
  );
  assert.equal(JSON.parse(hermesRunInsert.dry_run_json).expected_snapshot_sha256, dryRun.expected_snapshot_sha256);
  assert.ok(
    requests.some(({ method, target }) =>
      method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.reserve_shop_order_materials")),
  );
  assert.equal(
    requests.some(({ method, target }) =>
      method === "PUT" && target.includes("/api/resource/Shop%20Order/")),
    false,
  );

  const staleArgs = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-shop-reserve-stale-0001",
    args: { shop_order_id: "shop-1", allocations_json: allocationsJson },
    agentRole: "production-controller",
    actorUser,
    expectedSnapshotSha256: "0".repeat(64),
  });
  await assert.rejects(
    async () => await server._registeredTools.request_reserve_shop_order_materials.handler(staleArgs),
  );
  assert.equal(hermesRunCreates, 1, "a stale signed snapshot must fail before creating another Hermes Run");
});

test("advance-shop-order-setup sends one signed route only to the bounded Frappe method", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const actorUser = "production@example.com";
  const setupPayloadJson = JSON.stringify({
    action: "begin_setup",
    operations: [{
      sequence: 1,
      operation: "Cut panel",
      machine_tooling: "Shear 1 / 24ga blade",
      operator: "fabricator@example.com",
    }],
  });
  const order = shopOrderFixture({ status: "Reserved", operations: [] });
  const takeoff = { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" };
  const supplierOrder = { name: "supplier-1", roof_job: "JOB-1", status: "Received" };
  const workPackage = { name: "package-1", roof_job: "JOB-1", status: "Released" };
  const requests = [];
  let hermesRunInsert = null;
  let hermesRunCreates = 0;
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "production-controller",
    actorUser,
    approverId: "owner@example.com",
    dryRunSigningKey: "p".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    allowedTools: ["dry_run_advance_shop_order_setup", "request_advance_shop_order_setup"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    requests.push({ method, target, body: init.body });
    if (method === "GET" && target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (method === "GET" && target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: takeoff });
    if (method === "GET" && target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: supplierOrder });
    if (method === "GET" && target.includes("Work%20Package/package-1")) return Response.json({ data: workPackage });
    if (method === "GET" && target.includes("Hermes%20Run/run-shop-setup-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (method === "POST" && target.endsWith("/api/resource/Hermes%20Run")) {
      hermesRunCreates += 1;
      hermesRunInsert = JSON.parse(init.body);
      return Response.json({ data: { name: "run-shop-setup-0001" } });
    }
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.advance_shop_order_setup")) {
      return Response.json({
        message: {
          shop_order: { shop_order_id: "shop-1", status: "Setup / First Piece" },
          hermes_run_id: "run-shop-setup-0001",
        },
      });
    }
    if (method === "PUT" && target.includes("Hermes%20Run/run-shop-setup-0001")) {
      return Response.json({ data: { ok: true } });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  });

  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_advance_shop_order_setup.handler({
      shop_order_id: "shop-1",
      setup_payload_json: setupPayloadJson,
    }),
  );
  assert.equal(dryRun.setup.to_status, "Setup / First Piece");
  assert.deepEqual(dryRun.setup.operations, [
    {
      sequence: 1,
      operation: "Cut panel",
      machine_tooling: "Shear 1 / 24ga blade",
      operator: "fabricator@example.com",
    },
  ]);
  const args = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-shop-setup-0001",
    args: { shop_order_id: "shop-1", setup_payload_json: setupPayloadJson },
    agentRole: "production-controller",
    actorUser,
  });

  const result = parseToolPayload(
    await server._registeredTools.request_advance_shop_order_setup.handler(args),
  );

  assert.equal(result.advanced, true);
  assert.equal(result.setup_action, "begin_setup");
  assert.equal(result.result.message.shop_order.status, "Setup / First Piece");
  assert.equal(hermesRunInsert.tool_name, "request_advance_shop_order_setup");
  assert.equal(JSON.parse(hermesRunInsert.tool_args_json).setup_payload_json, setupPayloadJson);
  assert.equal(
    JSON.parse(hermesRunInsert.tool_args_json).expected_snapshot_sha256,
    dryRun.expected_snapshot_sha256,
  );
  assert.equal(
    requests.some(({ method, target }) => method === "PUT" && target.includes("/api/resource/Shop%20Order/")),
    false,
  );

  const staleArgs = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-shop-setup-stale-0001",
    args: { shop_order_id: "shop-1", setup_payload_json: setupPayloadJson },
    agentRole: "production-controller",
    actorUser,
    expectedSnapshotSha256: "0".repeat(64),
  });
  await assert.rejects(
    async () => await server._registeredTools.request_advance_shop_order_setup.handler(staleArgs),
  );
  assert.equal(hermesRunCreates, 1, "a stale signed snapshot must fail before another Hermes Run");
});

test("shop setup rejects control characters before reading a preview", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "production-controller",
    actorUser: "production@example.com",
    dryRunSigningKey: "p".repeat(32),
    allowedTools: ["dry_run_advance_shop_order_setup"],
  });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads += 1;
    throw new Error("invalid setup must fail before reading Frappe");
  });

  for (const setupPayloadJson of [
    JSON.stringify({
      action: "begin_setup",
      operations: [{
        sequence: 1,
        operation: "Cut\npanels",
        machine_tooling: "Shear A",
        operator: "operator@example.com",
      }],
    }),
    JSON.stringify({
      action: "begin_setup",
      operations: [{
        sequence: 1,
        operation: "Cut panels",
        machine_tooling: "Shear\rA",
        operator: "operator@example.com",
      }],
    }),
    JSON.stringify({
      action: "begin_setup",
      operations: [{
        sequence: 1,
        operation: "Cut panels",
        machine_tooling: "Shear A",
        operator: "operator\u0000@example.com",
      }],
    }),
    JSON.stringify({ action: "place_quality_hold", reason: "Awaiting\ncheck." }),
  ]) {
    await assert.rejects(
      async () => await server._registeredTools.dry_run_advance_shop_order_setup.handler({
        shop_order_id: "shop-1",
        setup_payload_json: setupPayloadJson,
      }),
      /shop_setup_payload_invalid/,
    );
  }
  assert.equal(reads, 0);
});

test("release-shop-order request fails on supplier-order drift before creating a Hermes Run", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const actorUser = "production@example.com";
  const order = shopOrderFixture({ status: "Draft" });
  const takeoff = { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" };
  const supplierOrder = { name: "supplier-1", roof_job: "JOB-1", status: "Received" };
  const workPackage = { name: "package-1", roof_job: "JOB-1", status: "Released" };
  let hermesRunWrites = 0;
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "production-controller",
    actorUser,
    approverId: "owner@example.com",
    dryRunSigningKey: "p".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    allowedTools: ["dry_run_release_shop_order", "request_release_shop_order"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    if (method === "GET" && target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (method === "GET" && target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: takeoff });
    if (method === "GET" && target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: supplierOrder });
    if (method === "GET" && target.includes("Work%20Package/package-1")) return Response.json({ data: workPackage });
    if (method === "POST" && target.endsWith("/api/resource/Hermes%20Run")) {
      hermesRunWrites += 1;
      return Response.json({ data: { name: "run-shop-release-drift-0001" } });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  });

  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_release_shop_order.handler({ shop_order_id: "shop-1" }),
  );
  const args = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-shop-release-drift-0001",
    args: { shop_order_id: "shop-1" },
    agentRole: "production-controller",
    actorUser,
  });

  supplierOrder.status = "Ordered";
  await assert.rejects(
    async () => await server._registeredTools.request_release_shop_order.handler(args),
    /shop_source_not_ready:Supplier Order/,
  );
  assert.equal(hermesRunWrites, 0);
});
