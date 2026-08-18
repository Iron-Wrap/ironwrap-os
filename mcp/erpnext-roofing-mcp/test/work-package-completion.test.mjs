import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";
import { buildServer } from "../src/server.mjs";

const SCOPE = {
  work_object_type: "Shop Order",
  work_object_id: "SHOP-001",
  physical_context_type: "Shop Floor",
  physical_context_id: "SHOP-FLOOR-1",
};

const PACKAGE = {
  name: "WP-SHOP-001",
  work_package_id: "wp:shop:001",
  roof_job: null,
  job_assignment: "assignment:shop:001",
  ...SCOPE,
  version: 2,
  status: "In Progress",
  release_attempt_id: "release:shop:001",
};

test("MCP completion preview and execute preserve the exact typed Shop Order scope", async (t) => {
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
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    requests.push({ target, method, body: init.body ? JSON.parse(init.body) : null });
    if (method === "GET" && target.includes("Work%20Package/wp%3Ashop%3A001")) {
      return Response.json({ data: PACKAGE });
    }
    if (method === "GET" && target.includes("Work%20Package%20Event")) {
      return Response.json({ data: [] });
    }
    if (method === "GET" && target.includes("Hermes%20Run/run-shop-completion-001")) {
      return new Response("missing", { status: 404 });
    }
    if (method === "POST" && target.includes("Hermes%20Run")) {
      return Response.json({ data: { name: "run-shop-completion-001" } });
    }
    if (method === "POST" && target.includes("complete_work_package")) {
      const body = JSON.parse(init.body);
      assert.equal(body.roof_job_id, undefined);
      assert.deepEqual(
        Object.fromEntries(Object.keys(SCOPE).map((field) => [field, body[field]])),
        SCOPE,
      );
      return Response.json({
        message: {
          work_package: { name: PACKAGE.name, status: "Completed" },
          event: { name: "event:shop:completion:001" },
        },
      });
    }
    if (method === "PUT" && target.includes("Hermes%20Run/run-shop-completion-001")) {
      return Response.json({ data: { name: "run-shop-completion-001" } });
    }
    throw new Error(`unexpected request ${method} ${target}`);
  });

  const baseArgs = {
    work_package_id: PACKAGE.work_package_id,
    ...SCOPE,
    job_assignment_id: PACKAGE.job_assignment,
    completion_authority_user: "owner@example.invalid",
    device_action_id: "device:shop:completion:001",
    work_package_version: PACKAGE.version,
    release_attempt_id: PACKAGE.release_attempt_id,
  };
  const preview = JSON.parse(
    (await server._registeredTools.dry_run_complete_work_package.handler(baseArgs)).content[0].text,
  );
  assert.deepEqual(preview.requested, {
    work_package_id: PACKAGE.work_package_id,
    ...SCOPE,
    job_assignment_id: PACKAGE.job_assignment,
    completion_authority_user: baseArgs.completion_authority_user,
    device_action_id: baseArgs.device_action_id,
    work_package_version: PACKAGE.version,
    release_attempt_id: PACKAGE.release_attempt_id,
  });

  const writeArgs = {
    ...baseArgs,
    request_text: "Complete the reviewed Shop Order work package.",
    approved_by: "owner@example.invalid",
    run_id: "run-shop-completion-001",
    dry_run_receipt: preview.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_complete_work_package",
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
    (await server._registeredTools.request_complete_work_package.handler(writeArgs)).content[0].text,
  );
  assert.equal(result.audit_finalized, true);
  assert.equal(result.completed, true);
  assert.equal(
    requests.some(
      ({ method, target }) => method === "POST" && target.includes("complete_work_package"),
    ),
    true,
  );
});
