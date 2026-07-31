import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";
import {
  SupplierOrderTransitionInputSchema,
  buildServer,
  buildSupplierOrderTransitionPatch,
} from "../src/server.mjs";

const approvedOrder = {
  name: "supplier:takeoff:job-1",
  supplier_order_id: "supplier:takeoff:job-1",
  roof_job: "job:1",
  material_takeoff: "takeoff:job-1",
  source_quote: "quote:job-1",
  supplier: "supplier:synthetic",
  status: "Approved",
  prepared_at: "2026-07-10 09:00:00",
  approved_by: "owner@example.invalid",
  approved_at: "2026-07-10 10:00:00",
  order_summary_json: '{"item_count":2}',
  assumptions: "Synthetic test order.",
  exclusions: "No supplier contact.",
  delivery_notes: "",
  items: [
    {
      category: "Roof Surface",
      item_name: "Synthetic roof panel",
      quantity: "10",
      unit: "sqft",
      source_ref: "takeoff:line-1",
      status: "Draft",
      received_qty: "0",
      shortage_qty: "0",
      substitution_notes: "",
      needs_review: 0,
    },
    {
      category: "Flashing",
      item_name: "Synthetic flashing",
      quantity: "5",
      unit: "ft",
      source_ref: "takeoff:line-2",
      status: "Draft",
      received_qty: "0",
      shortage_qty: "0",
      substitution_notes: "",
      needs_review: 0,
    },
  ],
};

function json(data) {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

function verifiedMaterialsEvidence(evidenceId) {
  return {
    name: evidenceId,
    evidence_id: evidenceId,
    roof_job: "job:1",
    proof_slot: "Materials",
    evidence_type: "PDF",
    sync_state: "Verified",
    content_checksum: "a".repeat(64),
    checksum_algorithm: "SHA-256",
    verified_at: "2026-07-10 11:00:00",
    verification_source: "synthetic-test",
    r2_key: `synthetic/${evidenceId}.pdf`,
  };
}

function transitionArgs(overrides = {}) {
  return {
    supplier_order_id: approvedOrder.supplier_order_id,
    next_status: "Ordered",
    internal_transmission_id: "transmission:synthetic-1",
    ...overrides,
  };
}

test("Supplier Order lifecycle patches keep approved facts frozen and conserve cumulative quantities", () => {
  assert.equal(SupplierOrderTransitionInputSchema.safeParse(transitionArgs()).success, true);
  assert.equal(SupplierOrderTransitionInputSchema.safeParse({ ...transitionArgs(), unexpected: true }).success, false);

  assert.throws(
    () => buildSupplierOrderTransitionPatch(approvedOrder, {
      supplier_order_id: approvedOrder.supplier_order_id,
      next_status: "Received",
      receipt_evidence_item_ids: ["evidence:receipt-1"],
      item_receipts: [],
    }),
    /supplier_order_transition_invalid:Approved->Received/,
  );

  const transmitted = buildSupplierOrderTransitionPatch(
    approvedOrder,
    transitionArgs(),
    "2026-07-10T10:30:00.000Z",
  );
  assert.equal(transmitted.patch.status, "Ordered");
  assert.equal(transmitted.patch.internal_transmission_id, "transmission:synthetic-1");
  assert.equal(transmitted.patch.internal_transmitted_at, "2026-07-10T10:30:00.000Z");
  for (const [index, item] of transmitted.patch.items.entries()) {
    for (const field of [
      "category", "item_name", "quantity", "unit", "source_ref", "substitution_notes", "needs_review",
    ]) assert.equal(item[field], approvedOrder.items[index][field], `item ${index + 1} ${field} must stay frozen`);
    assert.equal(item.status, "Ordered");
  }

  const ordered = { ...approvedOrder, ...transmitted.patch };
  assert.deepEqual(
    buildSupplierOrderTransitionPatch(ordered, transitionArgs()),
    { patch: {}, idempotent: true, evidenceItemIds: [] },
  );
  const acknowledgementArgs = {
    supplier_order_id: ordered.supplier_order_id,
    next_status: "Ordered",
    supplier_acknowledgement_id: "acknowledgement:synthetic-1",
    supplier_acknowledgement_evidence_item_id: "evidence:acknowledgement-1",
  };
  const acknowledgement = buildSupplierOrderTransitionPatch(
    ordered,
    acknowledgementArgs,
    "2026-07-10T10:35:00.000Z",
  );
  assert.equal(acknowledgement.patch.supplier_acknowledgement_id, "acknowledgement:synthetic-1");
  assert.equal(acknowledgement.idempotent, false);
  const acknowledged = { ...ordered, ...acknowledgement.patch };
  assert.deepEqual(
    buildSupplierOrderTransitionPatch(acknowledged, acknowledgementArgs),
    { patch: {}, idempotent: true, evidenceItemIds: ["evidence:acknowledgement-1"] },
  );
  assert.throws(
    () => buildSupplierOrderTransitionPatch(acknowledged, {
      ...acknowledgementArgs,
      supplier_acknowledgement_id: "acknowledgement:conflict",
    }),
    /supplier_order_acknowledgement_conflict/,
  );

  const partial = buildSupplierOrderTransitionPatch(ordered, {
    supplier_order_id: ordered.supplier_order_id,
    next_status: "Partially Received",
    receipt_evidence_item_ids: ["evidence:receipt-1"],
    item_receipts: [
      { item_index: 1, received_qty: "5", shortage_qty: "0" },
      { item_index: 2, received_qty: "0", shortage_qty: "0" },
    ],
  }, "2026-07-11T08:00:00.000Z");
  assert.deepEqual(partial.patch.items.map(({ status, received_qty, shortage_qty }) => ({ status, received_qty, shortage_qty })), [
    { status: "Ordered", received_qty: "5", shortage_qty: "0" },
    { status: "Ordered", received_qty: "0", shortage_qty: "0" },
  ]);
  assert.throws(
    () => buildSupplierOrderTransitionPatch({ ...ordered, ...partial.patch }, {
      supplier_order_id: ordered.supplier_order_id,
      next_status: "Cancelled",
    }),
    /supplier_order_transition_invalid:Partially Received->Cancelled/,
  );
  assert.throws(
    () => buildSupplierOrderTransitionPatch(ordered, {
      supplier_order_id: ordered.supplier_order_id,
      next_status: "Received",
      receipt_evidence_item_ids: ["evidence:receipt-1"],
      item_receipts: [
        { item_index: 1, received_qty: "5", shortage_qty: "0" },
        { item_index: 2, received_qty: "0", shortage_qty: "0" },
      ],
    }),
    /supplier_order_received_quantity_mismatch/,
  );
  assert.throws(
    () => buildSupplierOrderTransitionPatch(ordered, {
      supplier_order_id: ordered.supplier_order_id,
      next_status: "Partially Received",
      receipt_evidence_item_ids: ["evidence:receipt-1"],
      item_receipts: [
        { item_index: 1, received_qty: "11", shortage_qty: "0" },
        { item_index: 2, received_qty: "0", shortage_qty: "0" },
      ],
    }),
    /supplier_order_quantity_overage/,
  );

  const shortage = buildSupplierOrderTransitionPatch({ ...ordered, ...partial.patch }, {
    supplier_order_id: ordered.supplier_order_id,
    next_status: "Shortage",
    receipt_evidence_item_ids: ["evidence:receipt-2"],
    item_receipts: [
      { item_index: 1, received_qty: "10", shortage_qty: "0" },
      { item_index: 2, received_qty: "0", shortage_qty: "5" },
    ],
  }, "2026-07-11T09:00:00.000Z");
  assert.equal(shortage.patch.status, "Shortage");
  assert.deepEqual(JSON.parse(shortage.patch.receipt_evidence_json), {
    evidence_item_ids: ["evidence:receipt-1", "evidence:receipt-2"],
  });
  assert.deepEqual(shortage.evidenceItemIds, ["evidence:receipt-1", "evidence:receipt-2"]);
  assert.deepEqual(shortage.patch.items.map((item) => item.status), ["Received", "Shortage"]);
});

test("a signed Supplier Order transmission writes only Frappe records and never a supplier endpoint", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "owner-operator",
    actorUser: "owner@example.invalid",
    approverId: "owner@example.invalid",
    dryRunSigningKey: "s".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.ok(server._registeredTools.dry_run_supplier_order_transition);
  assert.ok(server._registeredTools.request_transition_supplier_order);

  const requests = [];
  let supplierOrderWrites = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    requests.push({ target, method: init.method });
    if (init.method === "GET" && target.includes("Supplier%20Order/supplier%3Atakeoff%3Ajob-1")) {
      return json(approvedOrder);
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-supplier-order-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      return json({ name: "run-supplier-order-0001" });
    }
    if (init.method === "PUT" && target.includes("Supplier%20Order/supplier%3Atakeoff%3Ajob-1")) {
      supplierOrderWrites += 1;
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), [
        "internal_transmission_id",
        "internal_transmitted_at",
        "items",
        "status",
      ]);
      assert.equal(body.status, "Ordered");
      assert.equal(body.internal_transmission_id, "transmission:synthetic-1");
      assert.ok(body.items.every((item) => item.status === "Ordered"));
      return json({ name: approvedOrder.name });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-supplier-order-0001")) {
      return json({ name: "run-supplier-order-0001" });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = transitionArgs();
  const preview = JSON.parse(
    (await server._registeredTools.dry_run_supplier_order_transition.handler(baseArgs)).content[0].text,
  );
  assert.equal(preview.semantics.ordered, "internal_transmission_only");
  assert.equal(preview.semantics.external_supplier_contact, false);
  assert.equal(preview.semantics.provider_adapter_called, false);
  const writeArgs = {
    ...baseArgs,
    request_text: "Record the reviewed internal Supplier Order transmission fact.",
    approved_by: "owner@example.invalid",
    run_id: "run-supplier-order-0001",
    dry_run_receipt: preview.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_transition_supplier_order",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.invalid",
    site_id: preview.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = JSON.parse(
    (await server._registeredTools.request_transition_supplier_order.handler(writeArgs)).content[0].text,
  );
  assert.equal(result.audit_finalized, true);
  assert.equal(result.external_supplier_contact, false);
  assert.equal(supplierOrderWrites, 1);
  assert.ok(requests.length >= 5);
  assert.ok(requests.every(({ target }) => target.startsWith("https://erp.example/api/")));
  assert.equal(requests.some(({ target }) => /supplier\.(?:com|net|ca)|vendor/i.test(target)), false);
});

test("an idempotent supplier acknowledgement records no Supplier Order mutation", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const acknowledgedOrder = {
    ...approvedOrder,
    status: "Ordered",
    internal_transmission_id: "transmission:synthetic-1",
    internal_transmitted_at: "2026-07-10 10:30:00",
    supplier_acknowledgement_id: "acknowledgement:synthetic-1",
    supplier_acknowledged_at: "2026-07-10 10:35:00",
    supplier_acknowledgement_evidence: "evidence:acknowledgement-1",
    items: approvedOrder.items.map((item) => ({ ...item, status: "Ordered" })),
  };
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "owner-operator",
    actorUser: "owner@example.invalid",
    approverId: "owner@example.invalid",
    dryRunSigningKey: "a".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  let supplierOrderWrites = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Supplier%20Order/supplier%3Atakeoff%3Ajob-1")) return json(acknowledgedOrder);
    if (init.method === "GET" && target.includes("Evidence%20Item/evidence%3Aacknowledgement-1")) {
      return json(verifiedMaterialsEvidence("evidence:acknowledgement-1"));
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-supplier-ack-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) return json({ name: "run-supplier-ack-0001" });
    if (init.method === "PUT" && target.includes("Supplier%20Order/")) {
      supplierOrderWrites += 1;
      return json({ name: acknowledgedOrder.name });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-supplier-ack-0001")) {
      return json({ name: "run-supplier-ack-0001" });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = {
    supplier_order_id: acknowledgedOrder.supplier_order_id,
    next_status: "Ordered",
    supplier_acknowledgement_id: "acknowledgement:synthetic-1",
    supplier_acknowledgement_evidence_item_id: "evidence:acknowledgement-1",
  };
  const preview = JSON.parse(
    (await server._registeredTools.dry_run_supplier_order_transition.handler(baseArgs)).content[0].text,
  );
  assert.equal(preview.would_write, false);
  const writeArgs = {
    ...baseArgs,
    request_text: "Record a replay-safe acknowledgement fact.",
    approved_by: "owner@example.invalid",
    run_id: "run-supplier-ack-0001",
    dry_run_receipt: preview.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_transition_supplier_order",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.invalid",
    site_id: preview.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = JSON.parse(
    (await server._registeredTools.request_transition_supplier_order.handler(writeArgs)).content[0].text,
  );
  assert.equal(result.idempotent, true);
  assert.equal(result.updated, false);
  assert.equal(supplierOrderWrites, 0);
});
