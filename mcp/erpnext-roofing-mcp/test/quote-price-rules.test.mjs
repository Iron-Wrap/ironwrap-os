import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServer } from "../src/server.mjs";
import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function quote() {
  return {
    name: "QUOTE-A",
    customer_quote_id: "QUOTE-A",
    roof_job: "JOB-A",
    quote_version: 2,
    status: "Needs Review",
    price_book_version: "retail-2026-07",
    pricing_effective_at: "2026-07-12T08:00:00.000Z",
    price_rule_snapshot_json: "",
  };
}

function rule(status = "Approved") {
  return {
    name: "RULE-A",
    price_rule_id: "RULE-A",
    rule_name: "Standing seam panel",
    rule_type: "Material",
    status,
    service_type: "Metal reroof",
    material_system: "24ga standing seam",
    unit: "sqft",
    unit_cost: 8,
    unit_price: 12.5,
    minimum_quantity: 0,
    currency: "CAD",
    source_ref: "supplier-sheet-2026-07",
    rule_json: '{"unit_price":12.5}',
    effective_from: "2026-07-01",
    effective_to: "",
    assumptions: "Standard colour.",
    exclusions: "Freight.",
    approved_by: "owner@example.com",
    approved_at: "2026-07-12T07:00:00.000Z",
  };
}

test("quote price-rule binding is receipt-bound, redacted, and fails before a Hermes Run on rule drift", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-16T21:37:12.500Z"),
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "estimator-assistant",
    actorUser: "estimator@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "p".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  const sourceQuote = quote();
  const sourceRule = rule();
  let hermesRunWrites = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Customer%20Quote/QUOTE-A")) {
      return Response.json({ data: sourceQuote });
    }
    if (init.method === "GET" && target.includes("Price%20Book%20Rule/RULE-A")) {
      return Response.json({ data: sourceRule });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-price-rule-drift-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      hermesRunWrites += 1;
      throw new Error("drifted rule must not create a Hermes Run");
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = {
    roof_job_id: "JOB-A",
    customer_quote_id: "QUOTE-A",
    price_rule_ids: ["RULE-A"],
  };
  const preview = payload(
    await server._registeredTools.dry_run_bind_quote_price_rules.handler(baseArgs),
  );
  assert.equal(preview.target.name, "QUOTE-A");
  assert.deepEqual(preview.patch, { price_rule_snapshot_bound: true });
  assert.equal(preview.source.rule_count, 1);
  const emittedSource = JSON.stringify(preview.source);
  assert.equal(emittedSource.includes("12.5"), false);
  assert.equal(emittedSource.includes("unit_price"), false);

  const writeArgs = {
    ...baseArgs,
    request_text: "Bind the current approved price rule to this review quote.",
    approved_by: "owner@example.com",
    run_id: "run-price-rule-drift-0001",
    dry_run_receipt: preview.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_bind_quote_price_rules",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "estimator-assistant",
    actor_user: "estimator@example.com",
    site_id: preview.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  sourceRule.status = "Retired";
  await assert.rejects(
    async () => await server._registeredTools.request_bind_quote_price_rules.handler(writeArgs),
    /price_rule_not_approved/,
  );
  assert.equal(hermesRunWrites, 0);
});
