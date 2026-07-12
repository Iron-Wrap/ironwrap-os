import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServer } from "../src/server.mjs";
import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";

function parseToolPayload(result) {
  return JSON.parse(result.content[0].text);
}

function verifiedEvidence(overrides = {}) {
  return {
    name: "EVIDENCE-A",
    evidence_id: "EVIDENCE-A",
    roof_job: "JOB-A",
    evidence_type: "Photo",
    source_uri: "r2://private/JOB-A/proof-a.jpg",
    r2_key: "private/JOB-A/proof-a.jpg",
    customer_safe: 1,
    proof_slot: "Measurement",
    sync_state: "Verified",
    checksum_algorithm: "SHA-256",
    content_checksum: "a".repeat(64),
    verified_at: "2026-07-12T08:30:00.000Z",
    verification_source: "worker-checksum",
    summary: "Source-only note that must never enter the proposal pack.",
    ...overrides,
  };
}

test("proposal-pack dry run needs an explicit approved quote and never emits raw evidence pointers", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "estimator-assistant",
    actorUser: "estimator@example.com",
  });
  const quote = {
    name: "QUOTE-A",
    customer_quote_id: "QUOTE-A",
    roof_job: "JOB-A",
    quote_version: 2,
    status: "Approved",
    price_rule_snapshot_json: "{\"bound\":true}",
  };
  const approvedMeasurement = {
    name: "MEASUREMENT-A",
    measurement_id: "MEASUREMENT-A",
    roof_job: "JOB-A",
    provider: "RoofRuler",
    review_status: "Approved",
    approved_by: "owner@example.com",
    approved_at: "2026-07-12T08:00:00.000Z",
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    requests.push({ target, method: init.method });
    if (init.method === "GET" && target.includes("Customer%20Quote/QUOTE-A")) {
      return Response.json({ data: quote });
    }
    if (init.method === "GET" && target.includes("Measurement%20Report?")) {
      return Response.json({ data: [approvedMeasurement] });
    }
    if (init.method === "GET" && target.includes("Evidence%20Item?")) {
      return Response.json({ data: [
        verifiedEvidence(),
        verifiedEvidence({
          name: "PRIVATE-A",
          evidence_id: "PRIVATE-A",
          customer_safe: "0",
          source_uri: "r2://private/JOB-A/private-a.jpg",
          r2_key: "private/JOB-A/private-a.jpg",
        }),
      ] });
    }
    if (init.method === "GET" && target.includes("Proposal%20Evidence%20Pack/proposal%3AQUOTE-A")) {
      return new Response("missing", { status: 404 });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const preview = parseToolPayload(
    await server._registeredTools.dry_run_proposal_evidence_pack.handler({
      roof_job_id: "JOB-A",
      customer_quote_id: "QUOTE-A",
      pack_id: "proposal:attempted-override",
    }),
  );

  assert.equal(preview.target.name, "proposal:QUOTE-A");
  assert.equal(preview.draft.quotation, "QUOTE-A");
  assert.equal(preview.draft.status, "Draft");
  assert.equal("customer_message" in preview.draft, false);
  assert.equal(preview.source_counts.measurement_reports, 1);
  assert.equal(preview.source_counts.evidence_items, 2);
  const emitted = JSON.stringify(preview);
  for (const forbidden of [
    "r2://private/JOB-A/proof-a.jpg",
    "private/JOB-A/proof-a.jpg",
    "Source-only note that must never enter the proposal pack.",
    "PRIVATE-A",
  ]) {
    assert.equal(emitted.includes(forbidden), false, `must withhold ${forbidden}`);
  }
  assert.ok(requests.every(({ method }) => method === "GET"));
});

test("proposal-pack approved write re-reads the anchored quote and fails before a Hermes Run on drift", async (t) => {
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
  const quote = {
    name: "QUOTE-A",
    customer_quote_id: "QUOTE-A",
    roof_job: "JOB-A",
    quote_version: 2,
    status: "Approved",
    price_rule_snapshot_json: "{\"bound\":true}",
  };
  const approvedMeasurement = {
    name: "MEASUREMENT-A",
    measurement_id: "MEASUREMENT-A",
    roof_job: "JOB-A",
    provider: "RoofRuler",
    review_status: "Approved",
    approved_by: "owner@example.com",
    approved_at: "2026-07-12T08:00:00.000Z",
  };
  let hermesRunWrites = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Customer%20Quote/QUOTE-A")) {
      return Response.json({ data: quote });
    }
    if (init.method === "GET" && target.includes("Measurement%20Report?")) {
      return Response.json({ data: [approvedMeasurement] });
    }
    if (init.method === "GET" && target.includes("Evidence%20Item?")) {
      return Response.json({ data: [verifiedEvidence()] });
    }
    if (init.method === "GET" && target.includes("Proposal%20Evidence%20Pack/proposal%3AQUOTE-A")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-proposal-drift-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      hermesRunWrites += 1;
      throw new Error("drifted quote must not create a Hermes Run");
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = { roof_job_id: "JOB-A", customer_quote_id: "QUOTE-A" };
  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_proposal_evidence_pack.handler(baseArgs),
  );
  const writeArgs = {
    ...baseArgs,
    request_text: "Create a draft evidence pack for the approved quote.",
    approved_by: "owner@example.com",
    run_id: "run-proposal-drift-0001",
    dry_run_receipt: dryRun.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_create_proposal_evidence_pack",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "estimator-assistant",
    actor_user: "estimator@example.com",
    site_id: dryRun.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  quote.status = "Needs Review";
  await assert.rejects(
    async () => await server._registeredTools.request_create_proposal_evidence_pack.handler(writeArgs),
    /customer_quote_not_approved/,
  );
  assert.equal(hermesRunWrites, 0);
});
