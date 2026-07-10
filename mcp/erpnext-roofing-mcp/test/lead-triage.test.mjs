import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LeadTriageInputSchema,
  approvedWriteInputSchema,
  buildLeadTriagePatch,
  buildServer,
} from "../src/server.mjs";
import { approvedArgs, digest, semanticPreview, signApprovalReceipt } from "../src/approval-contract.mjs";

const NOW = "2026-07-10T18:00:00.000Z";
const FRAPPE_TRIAGED_AT = "2026-07-10 18:00:01";

function parseToolPayload(result) {
  return JSON.parse(result.content[0].text);
}

test("lead triage inputs and patch stay bounded, local, and timestamp-replay-safe", () => {
  assert.equal(LeadTriageInputSchema.safeParse({
    lead_envelope_id: "lead:1",
    triage_summary: "  Active leak reported; address confirmation still needed.  ",
  }).success, true);
  assert.equal(LeadTriageInputSchema.safeParse({
    lead_envelope_id: "lead:1",
    triage_summary: "   ",
  }).success, false);
  assert.equal(LeadTriageInputSchema.safeParse({
    lead_envelope_id: "lead:1",
    triage_summary: "x".repeat(2001),
  }).success, false);
  assert.equal(approvedWriteInputSchema(LeadTriageInputSchema).safeParse({
    lead_envelope_id: "lead:1",
    triage_summary: "Classified as an urgent leak.",
    request_text: "Approve the completed lead qualification.",
    approved_by: "owner@example.com",
    run_id: "run-lead-triage-0001",
    dry_run_receipt: "d".repeat(32),
    approval_receipt: "a".repeat(32),
    unexpected: true,
  }).success, false);

  const patch = buildLeadTriagePatch({
    triageSummary: "  Active leak reported; address confirmation still needed.  ",
    triagedBy: "owner@example.com",
    nowIso: NOW,
  });
  assert.deepEqual(patch, {
    triage_status: "Triaged",
    triaged_by: "owner@example.com",
    triaged_at: NOW,
    triage_summary: "Active leak reported; address confirmation still needed.",
  });
  assert.equal("status" in patch, false);
  assert.throws(() => buildLeadTriagePatch({
    triageSummary: "   ",
    triagedBy: "owner@example.com",
    nowIso: NOW,
  }), /lead_triage_summary_required/);

  const firstPreview = semanticPreview({ patch });
  const replayedPreview = semanticPreview({
    patch: { ...patch, triaged_at: "2026-07-10T18:00:01.000Z" },
  });
  assert.equal("triaged_at" in firstPreview.patch, false);
  assert.equal(digest(firstPreview), digest(replayedPreview));
});

test("lead-triage discovery and history are limited to lead concierge and owner", async (t) => {
  const concierge = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "lead-concierge",
    actorUser: "concierge@example.com",
  });
  const production = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "production-controller",
    actorUser: "production@example.com",
  });

  for (const name of [
    "list_untriaged_lead_envelopes",
    "list_communication_events_for_lead",
    "dry_run_mark_lead_triaged",
    "request_mark_lead_triaged",
  ]) {
    assert.ok(concierge._registeredTools[name], `lead-concierge must register ${name}`);
    assert.equal(production._registeredTools[name], undefined, `production-controller must not register ${name}`);
  }

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, method: init.method });
    if (init.method === "GET" && target.includes("Lead%20Envelope?")) {
      return new Response(JSON.stringify({ data: [{
        name: "lead:1",
        envelope_id: "lead:1",
        source: "website",
        triage_status: "Untriaged",
      }] }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Communication%20Event?")) {
      return new Response(JSON.stringify({ data: [{
        name: "comm:1",
        communication_event_id: "comm:1",
        lead_envelope: "lead:1",
        status: "Draft",
      }] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const untriaged = parseToolPayload(
    await concierge._registeredTools.list_untriaged_lead_envelopes.handler({ limit: 2 }),
  );
  assert.equal(untriaged.data[0].envelope_id, "lead:1");
  const history = parseToolPayload(
    await concierge._registeredTools.list_communication_events_for_lead.handler({
      lead_envelope_id: "lead:1",
      limit: 3,
    }),
  );
  assert.equal(history.data[0].communication_event_id, "comm:1");

  const leadQuery = new URL(calls[0].target);
  assert.deepEqual(JSON.parse(leadQuery.searchParams.get("filters")), [
    ["Lead Envelope", "triage_status", "!=", "Triaged"],
  ]);
  assert.equal(leadQuery.searchParams.get("limit_page_length"), "2");
  const eventQuery = new URL(calls[1].target);
  assert.deepEqual(JSON.parse(eventQuery.searchParams.get("filters")), [
    ["Communication Event", "lead_envelope", "=", "lead:1"],
  ]);
  assert.equal(eventQuery.searchParams.get("limit_page_length"), "3");
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("lead triage requires matching receipts, patches only local fields, and replays its Hermes Run", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "lead-concierge",
    actorUser: "concierge@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "l".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });

  let triageCommands = 0;
  let communicationWrites = 0;
  let auditDraft;
  let completedRun;
  const leadEnvelope = {
    name: "lead:1",
    envelope_id: "lead:1",
    source: "website",
    event_ts: NOW,
    status: "pushed",
    triage_status: "Untriaged",
    triaged_by: "",
    triaged_at: "",
    triage_summary: "",
  };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Lead%20Envelope/lead%3A1")) {
      return new Response(JSON.stringify({ data: leadEnvelope }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-lead-triage-0001")) {
      if (!completedRun) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify({ data: completedRun }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      auditDraft = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { name: "run-lead-triage-0001" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "POST" && target.includes("lead_triage_api.mark_lead_triaged")) {
      triageCommands += 1;
      assert.deepEqual(JSON.parse(init.body), {
        lead_envelope_id: "lead:1",
        hermes_run_id: "run-lead-triage-0001",
      });
      return new Response(JSON.stringify({ message: {
        lead_envelope: {
          name: "lead:1",
          envelope_id: "lead:1",
          triage_status: "Triaged",
          triaged_by: "owner@example.com",
          triaged_at: FRAPPE_TRIAGED_AT,
          triage_summary: "Urgent active leak; verify the Edmonton address before outreach.",
        },
        hermes_run_id: "run-lead-triage-0001",
      } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-lead-triage-0001")) {
      const finalized = JSON.parse(init.body);
      completedRun = {
        ...auditDraft,
        ...finalized,
        approval_status: "Executed",
        result_status: "OK",
      };
      return new Response(JSON.stringify({ data: { name: "run-lead-triage-0001" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (target.includes("Communication%20Event")) {
      communicationWrites += 1;
      throw new Error(`Communication Event must not be touched: ${init.method} ${target}`);
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = {
    lead_envelope_id: "lead:1",
    triage_summary: "Urgent active leak; verify the Edmonton address before outreach.",
  };
  const dryRun = parseToolPayload(
    await server._registeredTools.dry_run_mark_lead_triaged.handler(baseArgs),
  );
  assert.equal(dryRun.transport_status_unchanged, "pushed");
  assert.equal(dryRun.communication_events_mutated, false);
  assert.equal(dryRun.patch.triaged_by, "owner@example.com");
  assert.equal("status" in dryRun.patch, false);

  const writeArgs = {
    ...baseArgs,
    request_text: "Approve the completed lead qualification.",
    approved_by: "owner@example.com",
    run_id: "run-lead-triage-0001",
    dry_run_receipt: dryRun.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_mark_lead_triaged",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "lead-concierge",
    actor_user: "concierge@example.com",
    site_id: dryRun.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  const first = parseToolPayload(
    await server._registeredTools.request_mark_lead_triaged.handler(writeArgs),
  );
  assert.equal(first.updated, true);
  assert.equal(first.audit_finalized, true);
  assert.equal(first.replayed, false);
  assert.equal(triageCommands, 1);
  assert.equal(communicationWrites, 0);
  assert.equal(auditDraft.lead_envelope, "lead:1");
  assert.equal(auditDraft.target_doctype, "Lead Envelope");
  assert.equal(auditDraft.target_name, "lead:1");
  const afterTarget = JSON.parse(completedRun.after_target_ids);
  assert.equal(afterTarget.triaged_at, FRAPPE_TRIAGED_AT);
  assert.equal(afterTarget.transport_status, "pushed");

  const replay = parseToolPayload(
    await server._registeredTools.request_mark_lead_triaged.handler(writeArgs),
  );
  assert.equal(replay.replayed, true);
  assert.equal(triageCommands, 1);
  assert.equal(communicationWrites, 0);
});
