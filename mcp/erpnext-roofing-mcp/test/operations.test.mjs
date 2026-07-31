import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { approvedArgs, digest, signApprovalReceipt } from "../src/approval-contract.mjs";
import {
  CommunicationConsentInputSchema,
  ChangeOrderDraftInputSchema,
  InsuranceSupplementDraftInputSchema,
  InsuranceSupplementEvidenceUpdateInputSchema,
  InsuranceSupplementTransitionInputSchema,
  JobAssignmentInputSchema,
  SafetyAcknowledgementInputSchema,
  TenantExportInputSchema,
  approvedWriteInputSchema,
  assertComplianceTransition,
  assertConsentLineage,
  assertCorrectionVersion,
  assertVerifiedEvidence,
  assertLinkedRoofJob,
  assertRoofJobCustomer,
  buildChangeOrderDraft,
  buildChangeOrderTransitionPatch,
  buildCommunicationConsentDraft,
  buildComplianceRecordDraft,
  buildCustomerDecisionDraft,
  buildInsuranceSupplementDraft,
  buildInsuranceSupplementEvidencePatch,
  buildInsuranceSupplementTransitionPatch,
  buildJobAssignmentDraft,
  buildProductionScheduleGatePreview,
  buildReconciliationResolutionPatch,
  buildSafetyAcknowledgementPatch,
  buildSafetyPlanDraft,
  buildTenantExportRequestDraft,
  buildServer,
  redactApprovalArgs,
} from "../src/server.mjs";

const NOW = "2026-07-10T18:00:00.000Z";
const serverSource = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

const assignmentInput = {
  roof_job_id: "job:1",
  assignment_type: "Production",
  crew_profile_id: "crew:metal-1",
  scheduled_start: "2026-07-11T14:00:00.000Z",
  scheduled_end: "2026-07-11T22:00:00.000Z",
  assigned_by: "owner@example.com",
};
const assignmentDraftInput = {
  roofJobId: assignmentInput.roof_job_id,
  assignmentType: assignmentInput.assignment_type,
  crewProfileId: assignmentInput.crew_profile_id,
  scheduledStart: assignmentInput.scheduled_start,
  scheduledEnd: assignmentInput.scheduled_end,
  assignedBy: assignmentInput.assigned_by,
};

const consentInput = {
  customer_id: "customer:1",
  channel: "SMS",
  purpose: "Job Updates",
  status: "Granted",
  jurisdiction: "Alberta, Canada",
  consent_basis: "Express",
  source_system: "Customer Portal",
  source_reference: "portal-consent-1",
  captured_by: "owner@example.com",
  captured_at: NOW,
  effective_from: NOW,
  proof_evidence_id: "evidence:consent-1",
};

test("new command schemas reject unknown keys and unsafe acknowledgement methods", () => {
  assert.equal(JobAssignmentInputSchema.safeParse(assignmentInput).success, true);
  assert.equal(JobAssignmentInputSchema.safeParse({ ...assignmentInput, arbitrary: true }).success, false);

  const safety = {
    safety_plan_id: "safety:1",
    roof_job_id: "job:1",
    acknowledged_by: "crew@example.com",
    acknowledgement_method: "QR Device Pairing",
    device_action_id: "device-action-0001",
    evidence_item_id: "evidence:safety-1",
  };
  assert.equal(SafetyAcknowledgementInputSchema.safeParse(safety).success, true);
  assert.equal(SafetyAcknowledgementInputSchema.safeParse({ ...safety, extra: "no" }).success, false);
  assert.equal(SafetyAcknowledgementInputSchema.safeParse({
    ...safety,
    acknowledgement_method: "Owner Attestation",
  }).success, false);
  assert.equal(SafetyAcknowledgementInputSchema.safeParse({
    ...safety,
    device_action_id: undefined,
  }).success, false);
  assert.equal(SafetyAcknowledgementInputSchema.safeParse({
    ...safety,
    device_action_id: "x".repeat(141),
  }).success, false);
});

test("production scheduling eligibility is bounded, excludes closeout, and rejects orphaned ends", () => {
  const draft = buildJobAssignmentDraft({ ...assignmentDraftInput, nowIso: NOW });
  const gates = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
    gate,
    state: gate === "Safety" ? "Waived" : "Ready",
  }));
  const preview = buildProductionScheduleGatePreview(draft, gates);
  assert.equal(preview.required, true);
  assert.equal(preview.state_eligible, true);
  assert.deepEqual(preview.required_gates, ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]);
  assert.equal(preview.gates.some(({ gate }) => gate === "Completion"), false);
  assert.equal(
    buildProductionScheduleGatePreview(draft, [...gates, { gate: "Safety", state: "Done" }]).state_eligible,
    false,
  );
  assert.throws(
    () => buildJobAssignmentDraft({ ...assignmentDraftInput, scheduledStart: undefined, nowIso: NOW }),
    /scheduled_end_requires_start/,
  );
  assert.throws(
    () => buildJobAssignmentDraft({
      ...assignmentDraftInput,
      scheduledEnd: assignmentDraftInput.scheduledStart,
      nowIso: NOW,
    }),
    /assignment_schedule_invalid/,
  );
});

test("evidence-backed commands reject unverified, superseded, checksumless, or wrong-slot proof", () => {
  const verifiedSafetyEvidence = {
    evidence_id: "evidence:safety-1",
    roof_job: "job:1",
    evidence_type: "Photo",
    proof_slot: "Safety",
    source_uri: "r2://ironwrap/job-1/safety.jpg",
    content_checksum: "a".repeat(64),
    checksum_algorithm: "SHA-256",
    sync_state: "Verified",
    verified_at: NOW,
    verification_source: "field-replay",
  };
  assert.doesNotThrow(() => assertVerifiedEvidence(verifiedSafetyEvidence, "safety", {
    proofSlots: ["Safety"],
    evidenceTypes: ["Photo"],
  }));
  assert.throws(() => assertVerifiedEvidence({ ...verifiedSafetyEvidence, sync_state: "Queued" }, "safety"), /not_verified/);
  assert.throws(() => assertVerifiedEvidence({ ...verifiedSafetyEvidence, sync_state: "Superseded" }, "safety"), /not_verified/);
  assert.throws(() => assertVerifiedEvidence({ ...verifiedSafetyEvidence, content_checksum: "bad" }, "safety"), /checksum_invalid/);
  assert.throws(() => assertVerifiedEvidence({ ...verifiedSafetyEvidence, proof_slot: "Completion" }, "safety", {
    proofSlots: ["Safety"],
  }), /proof_slot_invalid/);
});

test("strict read tools use bounded schemas and redact sensitive fields", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
  });
  assert.equal(Object.keys(server._registeredTools).length, 151);
  assert.ok(server._registeredTools.dry_run_supplier_order_transition);
  assert.ok(server._registeredTools.request_transition_supplier_order);
  assert.ok(server._registeredTools.dry_run_record_final_shop_quality);
  assert.ok(server._registeredTools.request_record_final_shop_quality);
  assert.ok(server._registeredTools.dry_run_record_shop_handover);
  assert.ok(server._registeredTools.request_record_shop_handover);
  assert.ok(server._registeredTools.dry_run_record_shop_billing_basis);
  assert.ok(server._registeredTools.request_record_shop_billing_basis);
  assert.equal(server._registeredTools.get_contract_acceptance.inputSchema.safeParse({
    acceptance_id: "acceptance:1",
    unknown: true,
  }).success, false);

  t.mock.method(globalThis, "fetch", async (url) => {
    const record = url.includes("Insurance%20Supplement")
      ? {
          name: "supplement:1",
          insurance_supplement_id: "supplement:1",
          roof_job: "job:1",
          version: 1,
          status: "Ready for Human Review",
          measurement_report: "measurement:1",
          invoice_required: 1,
          claim_reference: "private-claim",
          policy_reference: "private-policy",
          adjuster_reference: "private-adjuster",
          supplement_basis: "private-scope",
          evidence_manifest_json: "{\"private\":true}",
          evidence: [{ evidence_item: "private-evidence", evidence_role: "Photo" }],
        }
      : url.includes("Contract%20Acceptance")
      ? {
          name: "acceptance:1",
          acceptance_id: "acceptance:1",
          roof_job: "job:1",
          status: "Accepted",
          document_checksum: "a".repeat(64),
          signer_email: "private@example.com",
          signer_ip: "192.0.2.1",
          captured_by: "provider@example.com",
        }
      : url.includes("Crew%20Profile")
        ? {
            name: "crew:1",
            crew_profile_id: "crew:1",
            crew_name: "Metal Crew",
            status: "Active",
            members: [{ crew_user: "private@example.com" }],
            safety_contact_phone: "+15875550000",
          }
        : {
            name: "export:1",
            export_run_id: "export:1",
            tenant: "tenant:1",
            status: "Completed",
            archive_key: "private/archive.zip",
            encryption_key_ref: "kms:key:private",
          };
    return new Response(JSON.stringify({ data: record }), {
      headers: { "content-type": "application/json" },
    });
  });

  const call = async (tool, args) => JSON.parse(
    (await server._registeredTools[tool].handler(args)).content[0].text,
  ).data;
  const acceptance = await call("get_contract_acceptance", { acceptance_id: "acceptance:1" });
  assert.equal(acceptance.status, "Accepted");
  assert.equal("signer_email" in acceptance, false);
  assert.equal("signer_ip" in acceptance, false);
  assert.equal("captured_by" in acceptance, false);

  const crew = await call("get_crew_profile", { crew_profile_id: "crew:1" });
  assert.equal(crew.crew_name, "Metal Crew");
  assert.equal("members" in crew, false);
  assert.equal("safety_contact_phone" in crew, false);

  const exportRun = await call("get_tenant_export_run", { export_run_id: "export:1" });
  assert.equal(exportRun.status, "Completed");
  assert.equal("archive_key" in exportRun, false);
  assert.equal("encryption_key_ref" in exportRun, false);

  const supplement = await call("get_insurance_supplement", {
    insurance_supplement_id: "supplement:1",
  });
  assert.equal(supplement.status, "Ready for Human Review");
  assert.deepEqual(supplement.evidence, [{ evidence_role: "Photo" }]);
  for (const sensitive of [
    "claim_reference",
    "policy_reference",
    "adjuster_reference",
    "supplement_basis",
    "evidence_manifest_json",
  ]) assert.equal(sensitive in supplement, false);
});

test("insurance supplement preview verifies evidence but never returns claim or document details", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target.includes("Insurance%20Supplement/supplement%3A1")) {
      return new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.includes("Measurement%20Report/measurement%3A1")) {
      return new Response(JSON.stringify({ data: {
        name: "measurement:1",
        roof_job: "job:1",
        review_status: "Approved",
      } }), { headers: { "content-type": "application/json" } });
    }
    const evidenceId = decodeURIComponent(target).match(/Evidence Item\/([^?]+)/)?.[1];
    if (evidenceId) {
      const evidenceType = evidenceId.includes("photo")
        ? "Photo"
        : evidenceId.includes("invoice")
          ? "Invoice"
          : "PDF";
      return new Response(JSON.stringify({ data: {
        name: evidenceId,
        roof_job: "job:1",
        evidence_type: evidenceType,
        proof_slot: "Other",
        sync_state: "Verified",
        content_checksum: "a".repeat(64),
        checksum_algorithm: "SHA-256",
        verified_at: NOW,
        verification_source: "worker-checksum",
        r2_key: "private/raw/evidence",
      } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected request " + target);
  });

  const response = await server._registeredTools.dry_run_insurance_supplement.handler({
    insurance_supplement_id: "supplement:1",
    roof_job_id: "job:1",
    carrier_name: "Private carrier",
    claim_reference: "claim-private",
    policy_reference: "policy-private",
    date_of_loss: "2026-06-18",
    adjuster_reference: "adjuster-private",
    supplement_basis: "Private scope narrative",
    measurement_report_id: "measurement:1",
    evidence: [
      { evidence_item_id: "evidence:carrier", evidence_role: "Carrier Scope" },
      { evidence_item_id: "evidence:code", evidence_role: "Code/Manufacturer" },
      { evidence_item_id: "evidence:photo", evidence_role: "Photo" },
      { evidence_item_id: "evidence:invoice", evidence_role: "Invoice" },
    ],
  });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.required_tool, "request_create_insurance_supplement");
  assert.deepEqual(payload.source.evidence_roles, [
    "Carrier Scope",
    "Code/Manufacturer",
    "Invoice",
    "Photo",
  ]);
  const serialized = JSON.stringify(payload);
  for (const privateValue of [
    "Private carrier",
    "claim-private",
    "policy-private",
    "adjuster-private",
    "Private scope narrative",
    "private/raw/evidence",
  ]) assert.equal(serialized.includes(privateValue), false);
});

test("runtime role filtering and field assignment scoping are enforced in the MCP server", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "field-companion",
    actorUser: "tech@example.com",
  });
  assert.ok(server._registeredTools.get_roof_job);
  assert.ok(server._registeredTools.request_record_safety_acknowledgement);
  assert.equal(server._registeredTools.get_tenant_export_run, undefined);
  assert.equal(server._registeredTools.request_tenant_export, undefined);

  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target.includes("Job%20Assignment?")) {
      return new Response(JSON.stringify({ data: [{
        name: "assignment:1",
        roof_job: "job:1",
        status: "Assigned",
        assigned_user: "tech@example.com",
      }] }), { headers: { "content-type": "application/json" } });
    }
    if (target.includes("Roof%20Job/job%3A1")) {
      return new Response(JSON.stringify({ data: {
        name: "job:1",
        roof_job_id: "job:1",
        job_number: "IW-001",
        status: "Production",
        address_line1: "100 Main St",
        customer_email: "private@example.com",
        contract_total: 99999,
      } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${target}`);
  });

  const response = await server._registeredTools.get_roof_job.handler({ roof_job_id: "job:1" });
  const data = JSON.parse(response.content[0].text).data;
  assert.equal(data.job_number, "IW-001");
  assert.equal("customer_email" in data, false);
  assert.equal("contract_total" in data, false);
});

test("field visual-model reads resolve the declared visual_model_id before assignment scoping", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    agentRole: "field-companion",
    actorUser: "tech@example.com",
  });
  let modelReads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target.includes("Job%20Assignment?")) {
      return new Response(JSON.stringify({ data: [{
        name: "assignment:1",
        roof_job: "job:1",
        status: "Assigned",
        assigned_user: "tech@example.com",
      }] }), { headers: { "content-type": "application/json" } });
    }
    if (target.includes("Visual%20Property%20Model/model%3A1")) {
      modelReads += 1;
      return new Response(JSON.stringify({ data: {
        name: "model:1",
        visual_model_id: "model:1",
        roof_job: "job:1",
        status: "Ready",
      } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${target}`);
  });

  const response = await server._registeredTools.get_visual_property_model.handler({
    visual_model_id: "model:1",
  });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.data.visual_model_id, "model:1");
  assert.equal(modelReads, 2);
});

test("a write requires an unmodified server preview and separately signed human approval", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "owner-operator",
    actorUser: "owner@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "d".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  let gateWrites = 0;
  let hermesRunPosts = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Production%20Gate%20State/gate%3A1")) {
      return new Response(JSON.stringify({ data: {
        name: "gate:1",
        gate_id: "gate:1",
        roof_job: "job:1",
        state: "Blocked",
      } }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Evidence%20Item/evidence%3Adeposit-1")) {
      return new Response(JSON.stringify({ data: {
        name: "evidence:deposit-1",
        roof_job: "job:1",
        sync_state: "Verified",
        content_checksum: "a".repeat(64),
        checksum_algorithm: "SHA-256",
        verified_at: "2026-07-10 10:01:00",
        verification_source: "ironwrap-worker-r2-frappe",
        r2_key: "field/v1/job-1/deposit.jpg",
        proof_slot: "Deposit",
      } }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-gate-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      hermesRunPosts += 1;
      return new Response(JSON.stringify({ data: { name: "run-gate-0001" } }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "PUT" && target.includes("Production%20Gate%20State/gate%3A1")) {
      gateWrites += 1;
      return new Response(JSON.stringify({ data: { name: "gate:1" } }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-gate-0001")) {
      return new Response(JSON.stringify({ data: { name: "run-gate-0001" } }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = {
    gate_id: "gate:1",
    next_state: "Ready",
    reason: "Deposit verified",
    evidence_item_id: "evidence:deposit-1",
  };
  const dryRun = JSON.parse((await server._registeredTools.dry_run_update_gate.handler(baseArgs)).content[0].text);
  const writeArgs = {
    ...baseArgs,
    request_text: "Approve deposit gate transition",
    approved_by: "owner@example.com",
    run_id: "run-gate-0001",
    dry_run_receipt: dryRun.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_update_gate",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "owner-operator",
    actor_user: "owner@example.com",
    site_id: dryRun.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = JSON.parse((await server._registeredTools.request_update_gate.handler(writeArgs)).content[0].text);
  assert.equal(result.audit_finalized, true);
  assert.equal(gateWrites, 1);
  assert.equal(hermesRunPosts, 1);

  await assert.rejects(
    () => server._registeredTools.request_update_gate.handler({ ...writeArgs, next_state: "Waived" }),
    /dry_run_receipt_mismatch:args_digest/,
  );
  await assert.rejects(
    () => server._registeredTools.request_update_gate.handler({ ...writeArgs, approved_by: "spoofed@example.com" }),
    /approval_approver_identity_mismatch/,
  );
  assert.equal(gateWrites, 1);
});

test("production scheduling rechecks the signed gate preview before any write", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "owner-operator",
    actorUser: "owner@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "s".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  let gatesStillEligible = true;
  let assignmentCreateAttempts = 0;
  let assignmentCreates = 0;
  let hermesRunPosts = 0;
  let hermesRunFinalizations = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Crew%20Profile/crew%3Ametal-1")) {
      return new Response(JSON.stringify({ data: { name: "crew:metal-1", status: "Active" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "GET" && target.includes("Job%20Assignment/")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "GET" && target.includes("Production%20Gate%20State?")) {
      const states = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
        gate,
        state: gatesStillEligible ? "Ready" : "Blocked",
      }));
      return new Response(JSON.stringify({ data: states }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      hermesRunPosts += 1;
      return new Response(JSON.stringify({ data: { name: "run-production-schedule" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "POST" && target.includes("Job%20Assignment")) {
      assignmentCreateAttempts += 1;
      if (!gatesStillEligible) {
        return new Response(JSON.stringify({ exc_type: "ValidationError" }), {
          status: 422,
          statusText: "production_schedule_gate_block",
        });
      }
      assignmentCreates += 1;
      return new Response(JSON.stringify({ data: { name: "assignment:created" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/")) {
      hermesRunFinalizations += 1;
      return new Response(JSON.stringify({ data: { name: "run-production-schedule" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const approvedWriteArgs = (input, dryRun, runId) => {
    const writeArgs = {
      ...input,
      request_text: "Schedule the approved production crew.",
      approved_by: "owner@example.com",
      run_id: runId,
      dry_run_receipt: dryRun.approval_request.dry_run_receipt,
    };
    writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
      write_tool: "request_create_job_assignment",
      dry_run_receipt: writeArgs.dry_run_receipt,
      agent_role: "owner-operator",
      actor_user: "owner@example.com",
      site_id: dryRun.approval_request.site_id,
      run_id: writeArgs.run_id,
      approved_by: writeArgs.approved_by,
      args_digest: digest(approvedArgs(writeArgs)),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return writeArgs;
  };

  const stableInput = { ...assignmentInput, assignment_id: "assignment:production-stable" };
  const dryRun = JSON.parse(
    (await server._registeredTools.dry_run_job_assignment.handler(stableInput)).content[0].text,
  );
  assert.equal(dryRun.production_schedule_gate_preview.required, true);
  assert.equal(dryRun.production_schedule_gate_preview.state_eligible, true);
  assert.deepEqual(dryRun.production_schedule_gate_preview.required_gates, [
    "Deposit", "Materials", "Safety", "Access", "Weather", "Crew",
  ]);
  assert.equal(
    dryRun.production_schedule_gate_preview.gates.some(({ gate }) => gate === "Completion"),
    false,
  );
  const stableResult = JSON.parse((await server._registeredTools.request_create_job_assignment.handler(
    approvedWriteArgs(stableInput, dryRun, "run-production-schedule-stable"),
  )).content[0].text);
  assert.equal(stableResult.audit_finalized, true);
  assert.equal(assignmentCreateAttempts, 1);
  assert.equal(assignmentCreates, 1);
  assert.equal(hermesRunPosts, 1);
  assert.equal(hermesRunFinalizations, 1);

  // A previously-green preview is not permission to write. The approval
  // contract recomputes its deterministic summary before it permits a write.
  const staleInput = { ...assignmentInput, assignment_id: "assignment:production-stale" };
  const staleDryRun = JSON.parse(
    (await server._registeredTools.dry_run_job_assignment.handler(staleInput)).content[0].text,
  );
  gatesStillEligible = false;
  const writeArgs = approvedWriteArgs(
    staleInput,
    staleDryRun,
    "run-production-schedule-stale",
  );

  await assert.rejects(
    () => server._registeredTools.request_create_job_assignment.handler(writeArgs),
    /hermes_dry_run_receipt_mismatch:preview_digest/,
  );
  assert.equal(assignmentCreateAttempts, 1);
  assert.equal(assignmentCreates, 1);
  assert.equal(hermesRunPosts, 1);
  assert.equal(hermesRunFinalizations, 1);
});

test("field completion write rechecks assignment immediately before the mutation", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: true,
    agentRole: "field-companion",
    actorUser: "tech@example.com",
    approverId: "owner@example.com",
    dryRunSigningKey: "f".repeat(32),
    approvalPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  });
  let assignmentQueries = 0;
  let completionWrites = 0;
  let failedRunFinalizations = 0;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url);
    if (init.method === "GET" && target.includes("Job%20Assignment?")) {
      assignmentQueries += 1;
      const active = assignmentQueries < 3;
      return new Response(JSON.stringify({ data: active ? [{
        name: "assignment:1",
        roof_job: "job:1",
        status: "Assigned",
        assigned_user: "tech@example.com",
      }] : [] }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Field%20Check-in?")) {
      return new Response(JSON.stringify({ data: [{
        name: "checkin:1",
        checkin_id: "checkin:1",
        status: "Received",
        photo_count: 1,
        submitted_at: NOW,
      }] }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Evidence%20Item?")) {
      return new Response(JSON.stringify({ data: [{
        name: "evidence:1",
        evidence_id: "evidence:1",
        evidence_type: "Photo",
        source_uri: "r2://ironwrap/job-1/completion.jpg",
        captured_at: NOW,
      }] }), { headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && target.includes("Completion%20Packet/completion%3Ajob%3A1")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "GET" && target.includes("Hermes%20Run/run-field-completion-0001")) {
      return new Response("missing", { status: 404 });
    }
    if (init.method === "POST" && target.includes("Hermes%20Run")) {
      return new Response(JSON.stringify({ data: { name: "run-field-completion-0001" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "PUT" && target.includes("Hermes%20Run/run-field-completion-0001")) {
      failedRunFinalizations += 1;
      return new Response(JSON.stringify({ data: { name: "run-field-completion-0001" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (init.method === "POST" && target.includes("Completion%20Packet")) {
      completionWrites += 1;
      return new Response(JSON.stringify({ data: { name: "completion:job:1" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${init.method} ${target}`);
  });

  const baseArgs = { roof_job_id: "job:1", completion_packet_id: "completion:job:1" };
  const dryRun = JSON.parse(
    (await server._registeredTools.dry_run_completion_packet.handler(baseArgs)).content[0].text,
  );
  const writeArgs = {
    ...baseArgs,
    request_text: "Create the review-gated completion packet from current field proof.",
    approved_by: "owner@example.com",
    run_id: "run-field-completion-0001",
    dry_run_receipt: dryRun.approval_request.dry_run_receipt,
  };
  writeArgs.approval_receipt = signApprovalReceipt(privateKey, {
    write_tool: "request_create_completion_packet",
    dry_run_receipt: writeArgs.dry_run_receipt,
    agent_role: "field-companion",
    actor_user: "tech@example.com",
    site_id: dryRun.approval_request.site_id,
    run_id: writeArgs.run_id,
    approved_by: writeArgs.approved_by,
    args_digest: digest(approvedArgs(writeArgs)),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  await assert.rejects(
    () => server._registeredTools.request_create_completion_packet.handler(writeArgs),
    /field_assignment_required:job:1/,
  );
  assert.equal(assignmentQueries, 3);
  assert.equal(completionWrites, 0);
  assert.equal(failedRunFinalizations, 1);
});

test("approved consent schema preserves strict conditional consent rules", () => {
  const ApprovedConsentSchema = approvedWriteInputSchema(CommunicationConsentInputSchema);
  const approved = {
    ...consentInput,
    request_text: "Record portal consent evidence",
    approved_by: "owner@example.com",
    run_id: "run-consent-0001",
    dry_run_receipt: "d".repeat(32),
    approval_receipt: "a".repeat(32),
  };
  assert.equal(ApprovedConsentSchema.safeParse(approved).success, true);
  assert.equal(ApprovedConsentSchema.safeParse({ ...approved, unknown: true }).success, false);
  assert.equal(CommunicationConsentInputSchema.safeParse({
    ...consentInput,
    status: "Revoked",
    proof_evidence_id: undefined,
    revoked_at: NOW,
  }).success, false);
});

test("revoked and superseded consent require explicit append-only lineage", () => {
  const base = {
    customerId: "customer:1",
    channel: "SMS",
    purpose: "Job Updates",
    status: "Revoked",
    jurisdiction: "Alberta, Canada",
    consentBasis: "Express",
    sourceSystem: "Customer Portal",
    sourceReference: "portal-revoke-1",
    capturedBy: "owner@example.com",
    capturedAt: NOW,
    effectiveFrom: NOW,
    revokedAt: NOW,
  };
  assert.throws(() => buildCommunicationConsentDraft(base), /consent_revocation_supersedes_required/);
  assert.throws(() => buildCommunicationConsentDraft({
    ...base,
    supersedes: "consent:prior",
  }), /correction_reason_required/);
  assert.throws(() => buildCommunicationConsentDraft({
    ...base,
    status: "Superseded",
    revokedAt: undefined,
  }), /consent_superseded_link_required/);

  const draft = buildCommunicationConsentDraft({
    ...base,
    supersedes: "consent:prior",
    correctionReason: "Customer withdrew SMS consent in the portal.",
  });
  assert.equal(draft.status, "Revoked");
  assert.equal(draft.supersedes, "consent:prior");
  assert.equal(draft.correction_reason, "Customer withdrew SMS consent in the portal.");
  assert.doesNotThrow(() => assertConsentLineage({
    customer: "customer:1",
    channel: "SMS",
    purpose: "Job Updates",
  }, {
    customer_id: "customer:1",
    channel: "SMS",
    purpose: "Job Updates",
  }));
  assert.throws(() => assertConsentLineage({
    customer: "customer:2",
    channel: "SMS",
    purpose: "Job Updates",
  }, {
    customer_id: "customer:1",
    channel: "SMS",
    purpose: "Job Updates",
  }), /consent_lineage_mismatch:customer/);
});

test("cross-job references fail closed", () => {
  assert.doesNotThrow(() => assertLinkedRoofJob("job:1", { roof_job: "job:1" }, "assignment"));
  assert.throws(
    () => assertLinkedRoofJob("job:1", { roof_job: "job:2" }, "assignment"),
    /assignment_roof_job_mismatch:job:2:job:1/,
  );
  assert.throws(() => assertLinkedRoofJob("job:1", {}, "assignment"), /assignment_roof_job_missing/);
  assert.doesNotThrow(() => assertRoofJobCustomer({ customer: "customer:1" }, "customer:1"));
  assert.throws(() => assertRoofJobCustomer({}, "customer:1"), /roof_job_customer_missing/);
  assert.throws(
    () => assertRoofJobCustomer({ customer: "customer:2" }, "customer:1"),
    /roof_job_customer_mismatch:customer:2:customer:1/,
  );
});

test("assignment and change-order corrections append new identities", () => {
  assert.throws(() => buildJobAssignmentDraft({
    roofJobId: "job:1",
    assignmentType: "Production",
    crewProfileId: "crew:metal-1",
    assignedUser: "crew@example.com",
  }), /assignment_requires_exactly_one_target/);
  const initialAssignment = buildJobAssignmentDraft({
    roofJobId: "job:1",
    assignmentType: "Production",
    crewProfileId: "crew:metal-1",
    scheduledStart: "2026-07-11T14:00:00.000Z",
    assignedBy: "owner@example.com",
    nowIso: NOW,
  });
  const correctedAssignment = buildJobAssignmentDraft({
    roofJobId: "job:1",
    assignmentType: "Production",
    crewProfileId: "crew:metal-1",
    scheduledStart: "2026-07-12T14:00:00.000Z",
    assignedBy: "owner@example.com",
    supersedes: initialAssignment.assignment_id,
    correctionReason: "Weather moved the installation date.",
    nowIso: NOW,
  });
  assert.notEqual(correctedAssignment.assignment_id, initialAssignment.assignment_id);
  assert.equal(correctedAssignment.supersedes, initialAssignment.assignment_id);

  const orderBase = {
    roofJobId: "job:1",
    changeNumber: "CO-1",
    title: "Replace damaged decking",
    reason: "Hidden damage found after tear-off.",
    scopeDelta: "Replace two sheets of damaged decking.",
    taxAmount: 10,
    priceBookVersion: "2026-07",
    taxPolicySnapshot: { jurisdiction: "AB" },
    items: [{
      item_type: "Material",
      description: "Plywood decking",
      quantity: 2,
      unit: "sheet",
      unit_price: 50,
      source_ref: "evidence:deck-1",
    }],
    requestedBy: "estimator@example.com",
    nowIso: NOW,
  };
  const initialOrder = buildChangeOrderDraft({ ...orderBase, version: 1 });
  const correctedOrder = buildChangeOrderDraft({
    ...orderBase,
    version: 2,
    supersedes: initialOrder.change_order_id,
    correctionReason: "Corrected quantity after estimator review.",
  });
  assert.notEqual(correctedOrder.change_order_id, initialOrder.change_order_id);
  assert.equal(correctedOrder.supersedes, initialOrder.change_order_id);
  assert.throws(
    () => assertCorrectionVersion({ version: 1 }, { version: 1 }, "change_order_correction"),
    /change_order_correction_version_must_increase/,
  );
  assert.doesNotThrow(
    () => assertCorrectionVersion({ version: 2 }, { version: 1 }, "change_order_correction"),
  );
  assert.equal(ChangeOrderDraftInputSchema.safeParse({
    roof_job_id: "job:1",
    change_number: "CO-negative",
    title: "Invalid negative price",
    reason: "Test",
    scope_delta: "Test",
    tax_amount: -1,
    price_book_version: "2026-07",
    tax_policy_snapshot: { jurisdiction: "AB" },
    items: [{
      item_type: "Material",
      description: "Invalid",
      quantity: 1,
      unit: "sheet",
      unit_price: -1,
      source_ref: "evidence:invalid",
    }],
    requested_by: "estimator@example.com",
  }).success, false);
  assert.match(serverSource, /assignment_correction_requires_new_id/);
  assert.match(serverSource, /change_order_correction_requires_new_id/);
  assert.match(serverSource, /safety_plan_correction_requires_new_id/);
  assert.match(serverSource, /compliance_correction_requires_new_id/);
  assert.match(serverSource, /customer_decision_correction_requires_new_id/);
  assert.match(serverSource, /communication_consent_correction_requires_new_id/);
  assert.match(serverSource, /tenant_export_correction_requires_new_id/);
});

test("change-order transitions cannot impersonate a customer", () => {
  assert.throws(
    () => buildChangeOrderTransitionPatch({ status: "Presented" }, "Accepted", "", "owner", NOW),
    /customer_contract_transition_forbidden/,
  );
  assert.throws(
    () => buildChangeOrderTransitionPatch({ status: "Presented" }, "Rejected", "", "owner", NOW),
    /customer_contract_transition_forbidden/,
  );
  assert.throws(
    () => buildChangeOrderTransitionPatch({ status: "Draft" }, "Presented", "", "owner", NOW),
    /change_order_transition_invalid/,
  );
  assert.throws(
    () => buildChangeOrderTransitionPatch({ status: "Needs Review" }, "Draft", "", "owner", NOW),
    /change_order_transition_reason_required/,
  );
  assert.throws(
    () => buildChangeOrderTransitionPatch({ status: "Approved" }, "Presented", "", "owner", NOW),
    /change_order_presentation_evidence_required/,
  );
  assert.deepEqual(
    buildChangeOrderTransitionPatch(
      { status: "Approved" },
      "Presented",
      "",
      "owner",
      NOW,
      "evidence:presentation-1",
    ),
    { status: "Presented" },
  );
});

test("insurance supplements are evidence-only, privacy-redacted, and never carrier decisions", () => {
  const input = {
    insurance_supplement_id: "supplement:1",
    roof_job_id: "job:1",
    carrier_name: "Carrier internal",
    claim_reference: "claim-internal",
    policy_reference: "policy-internal",
    date_of_loss: "2026-06-18",
    adjuster_reference: "adjuster-internal",
    supplement_basis: "Verified scope evidence.",
    measurement_report_id: "measurement:1",
    evidence: [
      { evidence_item_id: "evidence:carrier", evidence_role: "Carrier Scope" },
      { evidence_item_id: "evidence:code", evidence_role: "Code/Manufacturer" },
      { evidence_item_id: "evidence:photo", evidence_role: "Photo" },
      { evidence_item_id: "evidence:invoice", evidence_role: "Invoice" },
    ],
  };
  assert.equal(InsuranceSupplementDraftInputSchema.safeParse(input).success, true);
  assert.equal(InsuranceSupplementDraftInputSchema.safeParse({
    ...input,
    unknown: true,
  }).success, false);
  assert.equal(InsuranceSupplementEvidenceUpdateInputSchema.safeParse({
    insurance_supplement_id: "supplement:1",
    roof_job_id: "job:1",
    evidence: [],
  }).success, true);
  assert.equal(InsuranceSupplementTransitionInputSchema.safeParse({
    insurance_supplement_id: "supplement:1",
    roof_job_id: "job:1",
    next_status: "Carrier Approved",
  }).success, false);

  const draft = buildInsuranceSupplementDraft({
    insuranceSupplementId: input.insurance_supplement_id,
    roofJobId: input.roof_job_id,
    carrierName: input.carrier_name,
    claimReference: input.claim_reference,
    policyReference: input.policy_reference,
    dateOfLoss: input.date_of_loss,
    adjusterReference: input.adjuster_reference,
    supplementBasis: input.supplement_basis,
    measurementReportId: input.measurement_report_id,
    evidence: input.evidence,
  });
  assert.equal(draft.status, "Draft");
  assert.equal(draft.evidence.length, 4);
  assert.throws(
    () => buildInsuranceSupplementDraft({
      insuranceSupplementId: "supplement:2",
      roofJobId: "job:1",
      evidence: [
        { evidence_item_id: "evidence:photo", evidence_role: "Photo" },
        { evidence_item_id: "evidence:photo", evidence_role: "Invoice" },
      ],
    }),
    /insurance_supplement_evidence_duplicate/,
  );
  assert.throws(
    () => buildInsuranceSupplementEvidencePatch(
      { status: "Approved for Submission" },
      { evidence: [] },
    ),
    /insurance_supplement_evidence_locked/,
  );

  const manifest = {
    roof_job: "job:1",
    measurement_report: "measurement:1",
    evidence: [],
  };
  assert.deepEqual(
    buildInsuranceSupplementTransitionPatch(
      { status: "Ready for Human Review" },
      "Approved for Submission",
      "",
      "owner@example.com",
      NOW,
      manifest,
    ),
    {
      status: "Approved for Submission",
      evidence_manifest_json: JSON.stringify(manifest),
      approved_by: "owner@example.com",
      approved_at: NOW,
    },
  );
  assert.throws(
    () => buildInsuranceSupplementTransitionPatch(
      { status: "Submitted" },
      "Closed",
      "",
      "owner@example.com",
      NOW,
      undefined,
      "",
    ),
    /insurance_supplement_resolution_required/,
  );
  const auditArgs = redactApprovalArgs({
    ...input,
    request_text: "claim-internal must stay private",
    approved_by: "owner@example.com",
  });
  const serialized = JSON.stringify(auditArgs);
  for (const secret of ["claim-internal", "policy-internal", "adjuster-internal", "Carrier internal"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serverSource, /cannot submit to a carrier/i);
  assert.match(serverSource, /cannot make a carrier determination/i);
});

test("safety acknowledgements are evidence-backed, device-bound, unique, and idempotent", () => {
  assert.throws(() => buildSafetyPlanDraft({
    roofJobId: "job:1",
    status: "Ready",
    preparedBy: "owner@example.com",
    hazardSummary: "Fall exposure",
    controls: "Guardrails",
    emergencyPlan: "Call emergency services",
    ppeRequirements: "Harness",
    weatherLimits: "No lightning",
    evidenceItemId: "evidence:safety-plan",
    nowIso: NOW,
  }), /safety_plan_effective_date_required/);
  const plan = {
    name: "safety:1",
    safety_plan_id: "safety:1",
    roof_job: "job:1",
    status: "Ready",
    acknowledgements: [],
  };
  const input = {
    safetyPlan: plan,
    roofJobId: "job:1",
    acknowledgedBy: "crew@example.com",
    acknowledgementMethod: "QR Device Pairing",
    deviceActionId: "device-action-0001",
    evidenceItemId: "evidence:safety-1",
    nowIso: NOW,
  };
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    evidenceItemId: undefined,
  }), /safety_acknowledgement_evidence_required/);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    deviceActionId: undefined,
  }), /safety_acknowledgement_device_action_required/);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    deviceActionId: "x".repeat(141),
  }), /safety_acknowledgement_device_action_too_long/);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    acknowledgementMethod: "Owner Attestation",
  }), /safety_acknowledgement_method_invalid/);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    safetyPlan: { ...plan, status: "Draft" },
  }), /safety_plan_ready_required/);

  const first = buildSafetyAcknowledgementPatch(input);
  assert.equal(first.acknowledgements.length, 1);
  const replay = buildSafetyAcknowledgementPatch({
    ...input,
    safetyPlan: { ...plan, status: "Acknowledged", acknowledgements: first.acknowledgements },
  });
  assert.equal(replay.acknowledgements.length, 1);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    deviceActionId: "device-action-0002",
    evidenceItemId: "evidence:safety-2",
    safetyPlan: { ...plan, status: "Acknowledged", acknowledgements: first.acknowledgements },
  }), /safety_acknowledgement_user_conflict/);
  assert.throws(() => buildSafetyAcknowledgementPatch({
    ...input,
    acknowledgedBy: "other@example.com",
    safetyPlan: { ...plan, status: "Acknowledged", acknowledgements: first.acknowledgements },
  }), /safety_acknowledgement_device_conflict/);
});

test("compliance and reconciliation transitions fail closed", () => {
  assert.doesNotThrow(() => assertComplianceTransition("Required", "Applied"));
  assert.throws(() => assertComplianceTransition("Required", "Passed"), /compliance_transition_invalid/);
  assert.throws(() => assertComplianceTransition("Superseded", "Applied"), /compliance_transition_invalid/);
  assert.throws(() => buildComplianceRecordDraft({
    roofJobId: "job:1",
    jurisdiction: "Calgary, Alberta",
    recordType: "Permit",
    authorityName: "City of Calgary",
    status: "Applied",
    requiredBeforeGate: "Production",
    ownerUser: "owner@example.com",
  }), /compliance_applied_at_required/);
  assert.throws(() => buildComplianceRecordDraft({
    roofJobId: "job:1",
    jurisdiction: "Calgary, Alberta",
    recordType: "Inspection",
    authorityName: "City of Calgary",
    status: "Passed",
    requiredBeforeGate: "Completion",
    ownerUser: "owner@example.com",
    evidenceItemId: "evidence:inspection-1",
  }), /compliance_external_reference_required/);

  assert.deepEqual(buildReconciliationResolutionPatch({ status: "Mismatch", attempt_count: 1 }, {
    nextStatus: "Resolved",
    resolutionAction: "Matched the webhook receipt to the mirrored payment.",
    resolutionEvidenceId: "evidence:qb-1",
    resolvedBy: "finance@example.com",
    nowIso: NOW,
  }), {
    status: "Resolved",
    resolution_action: "Matched the webhook receipt to the mirrored payment.",
    resolution_evidence: "evidence:qb-1",
    resolved_by: "finance@example.com",
    resolved_at: NOW,
    last_attempt_at: NOW,
    attempt_count: 2,
    notes: "Reconciliation record only. No accounting or external-system mutation was performed.",
  });
  assert.throws(() => buildReconciliationResolutionPatch({ status: "Resolved" }, {
    nextStatus: "Ignored",
    resolutionAction: "Ignore duplicate",
    resolutionEvidenceId: "evidence:qb-1",
  }), /reconciliation_transition_invalid/);
  assert.throws(() => buildReconciliationResolutionPatch({ status: "Pending" }, {
    nextStatus: "Resolved",
    resolutionAction: "Cannot skip mismatch review",
    resolutionEvidenceId: "evidence:qb-1",
  }), /reconciliation_transition_invalid/);
});

test("Contract Acceptance remains read-only and Customer Decision cannot sign", () => {
  const names = [
    ...serverSource.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g),
    ...serverSource.matchAll(/\b(?:getName|listName):\s*"([a-z0-9_]+)"/g),
  ].map((match) => match[1]);
  assert.ok(names.includes("get_contract_acceptance"));
  assert.ok(names.includes("list_contract_acceptances_for_job"));
  assert.equal(names.some((name) => /^(dry_run|request)_.*contract_acceptance/.test(name)), false);
  assert.doesNotMatch(serverSource, /target:\s*\{\s*doctype:\s*"Contract Acceptance"/);

  const decision = buildCustomerDecisionDraft({
    roofJobId: "job:1",
    customerId: "customer:1",
    decisionType: "Scope Approval",
    decisionValue: "Proceed with blue metal option",
    decisionSummary: "Customer selected the blue metal scope in the portal.",
    sourceChannel: "Customer Portal",
    decidedAt: NOW,
    capturedBy: "estimator@example.com",
    evidenceItemId: "evidence:decision-1",
  });
  assert.equal(decision.status, "Recorded");
  assert.equal("contract_acceptance" in decision, false);
  assert.equal("accepted_at" in decision, false);
  assert.equal("signature" in decision, false);
});

test("tenant export request excludes credentials and creates no archive", () => {
  assert.equal(TenantExportInputSchema.safeParse({
    tenant_id: "tenant:ironwrap",
    scope: { include: ["business_records"] },
  }).success, false);
  assert.equal(TenantExportInputSchema.safeParse({
    export_run_id: "export:ironwrap:2026-07-10-1",
    tenant_id: "tenant:ironwrap",
    scope: { include: ["business_records"] },
  }).success, true);
  assert.throws(() => buildTenantExportRequestDraft({
    exportRunId: "export:invalid",
    tenantId: "tenant:ironwrap",
    scope: { include: ["credentials"] },
    requestedBy: "support@example.com",
    nowIso: NOW,
  }), /tenant_export_scope_invalid/);
  const draft = buildTenantExportRequestDraft({
    exportRunId: "export:ironwrap:2026-07-10-1",
    tenantId: "tenant:ironwrap",
    scope: {
      include: ["configuration", "business_records", "configuration"],
      include_binary_evidence: true,
    },
    requestedBy: "support@example.com",
    nowIso: NOW,
    runId: "run-export-0001",
  });
  assert.equal(draft.status, "Requested");
  assert.equal(draft.export_run_id, "export:ironwrap:2026-07-10-1");
  const scope = JSON.parse(draft.scope_json);
  assert.deepEqual(scope.include, ["business_records", "configuration"]);
  assert.deepEqual(scope.excludes, ["credentials", "session_tokens", "encryption_key_material"]);
  assert.equal("archive_key" in draft, false);
  assert.equal("encryption_key_ref" in draft, false);
  assert.match(draft.notes, /separate audited worker/);
});
