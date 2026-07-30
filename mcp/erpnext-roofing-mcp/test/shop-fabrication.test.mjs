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
    received_quantity: 10,
    available_quantity: 6,
    reserved_quantity: 0,
    consumed_quantity: 4,
    unit: "each",
    modified: "2026-07-30 10:06:00",
    ...overrides,
  };
}

function firstPieceOrderFixture(overrides = {}) {
  return shopOrderFixture({
    status: "Setup / First Piece",
    setup_started_at: "2026-07-30 10:10:00",
    fabrication_started_at: "",
    quality_hold_reason: "",
    lines: [{
      line_no: 1,
      controlled_item: "item-1",
      requested_quantity: 8,
      accepted_quantity: 0,
      billable_quantity: 0,
      unit: "each",
      dimensions: "2400 mm",
      tolerance: "+/- 3 mm",
      orientation: "North",
      invoice_basis: "Each",
      needs_review: 0,
    }],
    material_allocations: [{
      allocation_id: "alloc-1",
      line_no: 1,
      material_lot: "lot-a",
      reserved_quantity: 3,
      issued_quantity: 0,
      unit: "each",
      status: "Reserved",
      needs_review: 0,
    }],
    operations: [{
      sequence: 1,
      operation: "Cut panel",
      machine_tooling: "Shear 1 / 24ga blade",
      operator: "fabricator@example.com",
      status: "In Progress",
      started_at: "2026-07-30 10:12:00",
      completed_at: "",
      notes: "",
    }],
    inspections: [],
    ...overrides,
  });
}

function verifiedEvidenceFixture(overrides = {}) {
  return {
    name: "evidence-1",
    evidence_id: "evidence-1",
    roof_job: "JOB-1",
    evidence_type: "Photo",
    proof_owner: "production@example.com",
    proof_slot: "Production",
    source_system: "ironwrap-pwa",
    r2_key: "evidence/JOB-1/evidence-1.jpg",
    content_checksum: "a".repeat(64),
    checksum_algorithm: "SHA-256",
    content_type: "image/jpeg",
    content_length: 1_024,
    capture_actor: "production@example.com",
    captured_at: "2026-07-30 10:14:00",
    sync_state: "Verified",
    verified_at: "2026-07-30 10:15:00",
    verification_source: "r2-ingest",
    device_action_id: "device-action-1",
    modified: "2026-07-30 10:15:00",
    ...overrides,
  };
}

function firstPieceWorkPackageFixture(overrides = {}) {
  return {
    name: "package-1",
    work_package_id: "package-1",
    roof_job: "JOB-1",
    job_assignment: "assignment-1",
    safety_plan: "safety-plan-1",
    version: 1,
    status: "Released",
    expires_at: "2099-12-31 23:59:59",
    acknowledged_by: "production@example.com",
    acknowledged_at: "2026-07-30 10:10:00",
    started_at: "2026-07-30 10:11:00",
    modified: "2026-07-30 10:11:00",
    ...overrides,
  };
}

function firstPieceJobAssignmentFixture(overrides = {}) {
  return {
    name: "assignment-1",
    assignment_id: "assignment-1",
    roof_job: "JOB-1",
    assignment_type: "Production",
    status: "In Progress",
    crew_profile: "crew-1",
    assigned_user: "production@example.com",
    scheduled_start: "2026-07-30 09:00:00",
    supersedes: "",
    modified: "2026-07-30 10:10:00",
    ...overrides,
  };
}

function firstPieceCrewProfileFixture(overrides = {}) {
  return {
    name: "crew-1",
    crew_profile_id: "crew-1",
    status: "Active",
    crew_type: "Internal",
    competency_status: "Current",
    competency_checked_at: "2026-07-01 09:00:00",
    competency_expiry: "2099-12-31",
    equipment_status: "Safe",
    equipment_checked_at: "2026-07-01 09:00:00",
    equipment_expiry: "2099-12-31",
    wcb_status: "Not Required",
    wcb_checked_at: "",
    wcb_expiry: "",
    active_stop: 0,
    active_stop_at: "",
    active_stop_reason: "",
    modified: "2026-07-30 10:10:00",
    members: [],
    ...overrides,
  };
}

function firstPieceAuthorityResponse({
  actorUser = "production@example.com",
  workPackage = firstPieceWorkPackageFixture(),
  jobAssignment = firstPieceJobAssignmentFixture(),
  crewProfile = firstPieceCrewProfileFixture(),
} = {}) {
  return {
    authenticated_user: actorUser,
    work_package: workPackage,
    job_assignment: jobAssignment,
    crew_profile: crewProfile,
    assignment_role: "Production direct assignment",
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

test("first-piece pass stores one signed outcome and calls only the bounded Frappe method", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const actorUser = "production@example.com";
  const firstPiecePayloadJson = JSON.stringify({
    action: "pass_to_fabrication",
    inspections: [{
      line_no: 1,
      allocation_id: "alloc-1",
      operation_sequence: 1,
      issued_quantity: "1",
      measured_value: "2400.0",
      measurement_unit: "mm",
      evidence_item: "evidence-1",
    }],
  });
  const order = firstPieceOrderFixture();
  const takeoff = { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" };
  const supplierOrder = { name: "supplier-1", roof_job: "JOB-1", status: "Received" };
  const workPackage = firstPieceWorkPackageFixture();
  const jobAssignment = firstPieceJobAssignmentFixture();
  const crewProfile = firstPieceCrewProfileFixture();
  const lot = materialLotFixture({ status: "Reserved", available_quantity: 3, reserved_quantity: 3 });
  const evidence = verifiedEvidenceFixture();
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
    allowedTools: ["dry_run_record_first_piece_outcome", "request_record_first_piece_outcome"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    requests.push({ method, target, body: init.body });
    if (method === "GET" && target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (method === "GET" && target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: takeoff });
    if (method === "GET" && target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: supplierOrder });
    if (method === "GET" && target.includes("Job%20Assignment/assignment-1")) return Response.json({ data: jobAssignment });
    if (method === "GET" && target.includes("Crew%20Profile/crew-1")) return Response.json({ data: crewProfile });
    if (method === "GET" && target.includes("Material%20Lot/lot-a")) return Response.json({ data: lot });
    if (method === "GET" && target.includes("Evidence%20Item/evidence-1")) return Response.json({ data: evidence });
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.preview_first_piece_authority")) {
      return Response.json({ message: firstPieceAuthorityResponse({ actorUser, workPackage, jobAssignment, crewProfile }) });
    }
    if (method === "GET" && target.includes("Hermes%20Run/run-first-piece-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (method === "POST" && target.endsWith("/api/resource/Hermes%20Run")) {
      hermesRunCreates += 1;
      hermesRunInsert = JSON.parse(init.body);
      return Response.json({ data: { name: "run-first-piece-0001" } });
    }
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.record_first_piece_outcome")) {
      return Response.json({
        message: {
          shop_order: { shop_order_id: "shop-1", status: "In Fabrication" },
          hermes_run_id: "run-first-piece-0001",
        },
      });
    }
    if (method === "PUT" && target.includes("Hermes%20Run/run-first-piece-0001")) {
      return Response.json({ data: { ok: true } });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  });

  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_record_first_piece_outcome.handler({
      shop_order_id: "shop-1",
      first_piece_payload_json: firstPiecePayloadJson,
    }),
  );
  assert.equal(dryRun.first_piece.to_status, "In Fabrication");
  assert.equal(dryRun.first_piece.fabrication_started_at, "Frappe server time at execution");
  assert.deepEqual(dryRun.first_piece.inspections, [{
    inspection_type: "First Piece",
    line_no: 1,
    allocation_id: "alloc-1",
    operation_sequence: 1,
    result: "Pass",
    nominal_value: "2400",
    measured_value: "2400",
    tolerance_value: "3",
    measurement_unit: "mm",
    measured_result: "2400 mm; nominal 2400 +/- 3 mm",
    inspected_by: actorUser,
    inspected_at: "Frappe server time at execution",
    evidence_item: "evidence-1",
    needs_review: 0,
  }]);
  assert.deepEqual(dryRun.effects, {
    shop_order: { shop_order_id: "shop-1", status: "In Fabrication" },
    material_allocations: [{
      allocation_id: "alloc-1",
      material_lot: "lot-a",
      issued_quantity: "1",
      status: "Issued",
    }],
    material_lots: [{
      name: "lot-a",
      material_lot_id: "lot-a",
      status: "Reserved",
      available_quantity: "3",
      reserved_quantity: "2",
      consumed_quantity: "5",
    }],
  });
  assert.equal(requests.some(({ method, target }) => method === "GET" && target.includes("Work%20Package/package-1")), false);
  const args = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-first-piece-0001",
    args: { shop_order_id: "shop-1", first_piece_payload_json: firstPiecePayloadJson },
    agentRole: "production-controller",
    actorUser,
  });

  const result = parseToolPayload(
    await server._registeredTools.request_record_first_piece_outcome.handler(args),
  );

  assert.equal(result.first_piece_recorded, true);
  assert.equal(result.first_piece_action, "pass_to_fabrication");
  assert.equal(result.result.message.shop_order.status, "In Fabrication");
  assert.equal(hermesRunInsert.tool_name, "request_record_first_piece_outcome");
  assert.equal(JSON.parse(hermesRunInsert.tool_args_json).first_piece_payload_json, firstPiecePayloadJson);
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
    runId: "run-first-piece-stale-0001",
    args: { shop_order_id: "shop-1", first_piece_payload_json: firstPiecePayloadJson },
    agentRole: "production-controller",
    actorUser,
    expectedSnapshotSha256: "0".repeat(64),
  });
  await assert.rejects(
    async () => await server._registeredTools.request_record_first_piece_outcome.handler(staleArgs),
  );
  assert.equal(hermesRunCreates, 1, "a stale signed snapshot must fail before another Hermes Run");
});

test("first-piece failure is a signed Quality Hold with a derived failed inspection", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const actorUser = "production@example.com";
  const firstPiecePayloadJson = JSON.stringify({
    action: "fail_to_quality_hold",
    inspection: {
      line_no: 1,
      allocation_id: "alloc-1",
      operation_sequence: 1,
      issued_quantity: "1",
      measured_value: "2404",
      measurement_unit: "mm",
      evidence_item: "evidence-1",
    },
    reason: "First piece needs correction before fabrication.",
  });
  const order = firstPieceOrderFixture();
  const workPackage = firstPieceWorkPackageFixture();
  const jobAssignment = firstPieceJobAssignmentFixture();
  const crewProfile = firstPieceCrewProfileFixture();
  const requests = [];
  let hermesRunInsert = null;
  let hermesRunFinalize = null;
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
    allowedTools: ["dry_run_record_first_piece_outcome", "request_record_first_piece_outcome"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    requests.push({ method, target, body: init.body });
    if (target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" } });
    if (target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: { name: "supplier-1", roof_job: "JOB-1", status: "Received" } });
    if (target.includes("Job%20Assignment/assignment-1")) return Response.json({ data: jobAssignment });
    if (target.includes("Crew%20Profile/crew-1")) return Response.json({ data: crewProfile });
    if (target.includes("Material%20Lot/lot-a")) return Response.json({ data: materialLotFixture({ status: "Reserved", available_quantity: 3, reserved_quantity: 3 }) });
    if (target.includes("Evidence%20Item/evidence-1")) return Response.json({ data: verifiedEvidenceFixture() });
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.preview_first_piece_authority")) {
      return Response.json({ message: firstPieceAuthorityResponse({ actorUser, workPackage, jobAssignment, crewProfile }) });
    }
    if (method === "GET" && target.includes("Hermes%20Run/run-first-piece-fail-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (method === "POST" && target.endsWith("/api/resource/Hermes%20Run")) {
      hermesRunInsert = JSON.parse(init.body);
      return Response.json({ data: { name: "run-first-piece-fail-0001" } });
    }
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.record_first_piece_outcome")) {
      return Response.json({
        message: {
          shop_order: { shop_order_id: "shop-1", status: "Quality Hold" },
          material_lot: { name: "lot-a", material_lot_id: "lot-a", status: "Quarantined" },
          nonconformance: {
            name: "ncr:first-piece:1234",
            nonconformance_id: "ncr:first-piece:1234",
            status: "Contained",
            shop_order: "shop-1",
            material_lot: "lot-a",
            evidence_item: "evidence-1",
          },
          hermes_run_id: "run-first-piece-fail-0001",
        },
      });
    }
    if (method === "PUT" && target.includes("Hermes%20Run/run-first-piece-fail-0001")) {
      hermesRunFinalize = JSON.parse(init.body);
      return Response.json({ data: { ok: true } });
    }
    throw new Error(`unexpected request ${target}`);
  });

  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_record_first_piece_outcome.handler({
      shop_order_id: "shop-1",
      first_piece_payload_json: firstPiecePayloadJson,
    }),
  );
  assert.equal(dryRun.first_piece.to_status, "Quality Hold");
  assert.equal(dryRun.first_piece.quality_hold_reason, "First piece needs correction before fabrication.");
  assert.equal(dryRun.first_piece.inspections[0].result, "Fail");
  assert.equal(dryRun.first_piece.inspections[0].measured_result, "2404 mm; nominal 2400 +/- 3 mm");
  assert.equal(dryRun.first_piece.inspections[0].needs_review, 1);
  assert.deepEqual(dryRun.effects, {
    shop_order: { shop_order_id: "shop-1", status: "Quality Hold" },
    material_allocations: [{
      allocation_id: "alloc-1",
      material_lot: "lot-a",
      issued_quantity: "1",
      status: "Issued",
    }],
    material_lots: [{
      name: "lot-a",
      material_lot_id: "lot-a",
      status: "Quarantined",
      available_quantity: "3",
      reserved_quantity: "2",
      consumed_quantity: "5",
    }],
    nonconformance: {
      action: "create",
      nonconformance_id: "derived from the approved Hermes Run ID at execution",
      status: "Contained",
      shop_order: "shop-1",
      material_lot: "lot-a",
      evidence_item: "evidence-1",
      containment: "Material Lot lot-a quarantined; Shop Order placed on Quality Hold.",
    },
  });
  const args = approvalArgs({
    privateKey,
    dryRun,
    runId: "run-first-piece-fail-0001",
    args: { shop_order_id: "shop-1", first_piece_payload_json: firstPiecePayloadJson },
    agentRole: "production-controller",
    actorUser,
  });
  const result = parseToolPayload(
    await server._registeredTools.request_record_first_piece_outcome.handler(args),
  );
  assert.equal(result.first_piece_action, "fail_to_quality_hold");
  assert.equal(result.result.message.shop_order.status, "Quality Hold");
  assert.equal(hermesRunInsert.tool_name, "request_record_first_piece_outcome");
  assert.equal(JSON.parse(hermesRunInsert.tool_args_json).first_piece_payload_json, firstPiecePayloadJson);
  assert.deepEqual(JSON.parse(hermesRunFinalize.after_target_ids), {
    shop_order: { shop_order_id: "shop-1", status: "Quality Hold" },
    material_lot: { name: "lot-a", material_lot_id: "lot-a", status: "Quarantined" },
    nonconformance: {
      name: "ncr:first-piece:1234",
      nonconformance_id: "ncr:first-piece:1234",
      status: "Contained",
      shop_order: "shop-1",
      material_lot: "lot-a",
      evidence_item: "evidence-1",
    },
  });
  assert.equal(
    requests.some(({ method, target }) => method === "PUT" && target.includes("/api/resource/Shop%20Order/")),
    false,
  );
});

test("first-piece dry run rejects malformed controls before reading Frappe", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "production-controller",
    actorUser: "production@example.com",
    dryRunSigningKey: "p".repeat(32),
    allowedTools: ["dry_run_record_first_piece_outcome"],
  });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads += 1;
    throw new Error("invalid first-piece payload must fail before reading Frappe");
  });

  for (const firstPiecePayloadJson of [
    JSON.stringify({
      action: "pass_to_fabrication",
      inspections: [{
        line_no: 1,
        allocation_id: "alloc-1",
        operation_sequence: 1,
        issued_quantity: 1,
        measured_value: "2400",
        measurement_unit: "mm",
        evidence_item: "evidence-1",
      }],
    }),
    JSON.stringify({
      action: "pass_to_fabrication",
      inspections: [{
        line_no: 1,
        allocation_id: "alloc-1",
        operation_sequence: 1,
        issued_quantity: "1",
        measured_value: "2e3",
        measurement_unit: "mm",
        evidence_item: "evidence\u0000-1",
      }],
    }),
    JSON.stringify({
      action: "fail_to_quality_hold",
      inspection: {
        line_no: 1,
        allocation_id: "alloc-1",
        operation_sequence: 1,
        issued_quantity: "1",
        measured_value: "2400",
        measurement_unit: "mm\n",
        evidence_item: "evidence-1",
      },
      reason: "Rework\rrequired",
    }),
  ]) {
    await assert.rejects(
      async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({
        shop_order_id: "shop-1",
        first_piece_payload_json: firstPiecePayloadJson,
      }),
      /shop_first_piece_payload_invalid/,
    );
  }
  assert.equal(reads, 0);
});

test("first-piece dry run rejects invalid state, lineage, independence, and evidence", async (t) => {
  const actorUser = "production@example.com";
  let order = firstPieceOrderFixture();
  let lot = materialLotFixture({ status: "Reserved", available_quantity: 3, reserved_quantity: 3 });
  let evidence = verifiedEvidenceFixture();
  let workPackage = firstPieceWorkPackageFixture();
  let jobAssignment = firstPieceJobAssignmentFixture();
  let crewProfile = firstPieceCrewProfileFixture();
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "production-controller",
    actorUser,
    dryRunSigningKey: "p".repeat(32),
    allowedTools: ["dry_run_record_first_piece_outcome"],
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    if (target.includes("Shop%20Order/shop-1")) return Response.json({ data: order });
    if (target.includes("Material%20Takeoff/takeoff-1")) return Response.json({ data: { name: "takeoff-1", roof_job: "JOB-1", status: "Approved" } });
    if (target.includes("Supplier%20Order/supplier-1")) return Response.json({ data: { name: "supplier-1", roof_job: "JOB-1", status: "Received" } });
    if (target.includes("Work%20Package/package-1")) throw new Error("first-piece authority must provide the locked Work Package snapshot");
    if (target.includes("Job%20Assignment/assignment-1")) return Response.json({ data: jobAssignment });
    if (target.includes("Crew%20Profile/crew-1")) return Response.json({ data: crewProfile });
    if (target.includes("Material%20Lot/lot-a")) return Response.json({ data: lot });
    if (target.includes("Evidence%20Item/evidence-1")) return Response.json({ data: evidence });
    if (method === "POST" && target.endsWith("/api/method/ironwrap_roofing.shop_fabrication_api.preview_first_piece_authority")) {
      if (jobAssignment.status === "Draft" || !jobAssignment.scheduled_start || workPackage.expires_at === "2000-01-01 00:00:00") {
        return new Response("authority denied", { status: 417 });
      }
      return Response.json({ message: firstPieceAuthorityResponse({ actorUser, workPackage, jobAssignment, crewProfile }) });
    }
    throw new Error(`unexpected request ${target}`);
  });
  const validPayload = (inspection = {}) => JSON.stringify({
    action: "pass_to_fabrication",
    inspections: [{
      line_no: 1,
      allocation_id: "alloc-1",
      operation_sequence: 1,
      issued_quantity: "1",
      measured_value: "2400",
      measurement_unit: "mm",
      evidence_item: "evidence-1",
      ...inspection,
    }],
  });

  order = firstPieceOrderFixture({ status: "Reserved" });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_order_not_ready_for_first_piece/,
  );

  order = firstPieceOrderFixture({
    lines: [
      ...firstPieceOrderFixture().lines,
      { ...firstPieceOrderFixture().lines[0], line_no: 2, controlled_item: "item-2" },
    ],
    material_allocations: [
      ...firstPieceOrderFixture().material_allocations,
      { ...firstPieceOrderFixture().material_allocations[0], allocation_id: "alloc-2", line_no: 2, material_lot: "lot-b" },
    ],
  });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_passes_incomplete/,
  );

  order = firstPieceOrderFixture({ operations: [{ ...firstPieceOrderFixture().operations[0], operator: actorUser }] });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_inspector_not_independent/,
  );

  order = firstPieceOrderFixture({ operations: [{ ...firstPieceOrderFixture().operations[0], status: "Ready", started_at: "" }] });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_operation_not_started/,
  );

  order = firstPieceOrderFixture({ material_allocations: [{ ...firstPieceOrderFixture().material_allocations[0], issued_quantity: 1 }] });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_allocation_already_issued/,
  );

  order = firstPieceOrderFixture();
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload({ measured_value: "2404" }) }),
    /shop_first_piece_tolerance_result_mismatch/,
  );

  const withinToleranceFailurePayload = JSON.stringify({
    action: "fail_to_quality_hold",
    inspection: {
      line_no: 1,
      allocation_id: "alloc-1",
      operation_sequence: 1,
      issued_quantity: "1",
      measured_value: "2400",
      measurement_unit: "mm",
      evidence_item: "evidence-1",
    },
    reason: "A conforming part must not be held as a failed first piece.",
  });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: withinToleranceFailurePayload }),
    /shop_first_piece_tolerance_result_mismatch/,
  );

  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload({ measurement_unit: "in" }) }),
    /shop_first_piece_measurement_unit_mismatch/,
  );

  order = firstPieceOrderFixture();
  lot = materialLotFixture({ status: "Available", available_quantity: 3, reserved_quantity: 3 });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_lot_not_reserved/,
  );

  lot = materialLotFixture({ status: "Reserved", available_quantity: 3, reserved_quantity: 3 });
  evidence = verifiedEvidenceFixture();
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload({ issued_quantity: "4" }) }),
    /shop_first_piece_issue_exceeds_reservation/,
  );

  order = firstPieceOrderFixture({
    lines: [
      ...firstPieceOrderFixture().lines,
      { ...firstPieceOrderFixture().lines[0], line_no: 2 },
    ],
    material_allocations: [
      ...firstPieceOrderFixture().material_allocations,
      { ...firstPieceOrderFixture().material_allocations[0], allocation_id: "alloc-2", line_no: 2 },
    ],
  });
  const overdrawLotPayload = JSON.stringify({
    action: "pass_to_fabrication",
    inspections: [
      {
        line_no: 1,
        allocation_id: "alloc-1",
        operation_sequence: 1,
        issued_quantity: "2",
        measured_value: "2400",
        measurement_unit: "mm",
        evidence_item: "evidence-1",
      },
      {
        line_no: 2,
        allocation_id: "alloc-2",
        operation_sequence: 1,
        issued_quantity: "2",
        measured_value: "2400",
        measurement_unit: "mm",
        evidence_item: "evidence-1",
      },
    ],
  });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: overdrawLotPayload }),
    /shop_first_piece_issue_exceeds_lot_reservation/,
  );

  order = firstPieceOrderFixture();
  evidence = verifiedEvidenceFixture({ proof_slot: "Quality" });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_evidence_semantic_invalid/,
  );

  evidence = verifiedEvidenceFixture({ sync_state: "Queued" });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /shop_first_piece_evidence_not_verified/,
  );

  evidence = verifiedEvidenceFixture();
  jobAssignment = firstPieceJobAssignmentFixture({ status: "Draft", scheduled_start: "" });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /erpnext_http_417/,
  );

  jobAssignment = firstPieceJobAssignmentFixture();
  workPackage = firstPieceWorkPackageFixture({ expires_at: "2000-01-01 00:00:00" });
  await assert.rejects(
    async () => await server._registeredTools.dry_run_record_first_piece_outcome.handler({ shop_order_id: "shop-1", first_piece_payload_json: validPayload() }),
    /erpnext_http_417/,
  );
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
