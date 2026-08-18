import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertJobCostEventSources,
  buildJobCostEventCandidate,
  classifyJobCostEventReplay,
  JobCostEventInputSchema,
} from "../src/job-cost-event.mjs";
import { buildServer } from "../src/server.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const SHA = "a".repeat(64);
const baseInput = {
  job_cost_event_id: "cost:job-1:material:001",
  roof_job_id: "job:1",
  event_kind: "cost",
  category: "Material",
  quantity: 12.5,
  unit: "square_feet",
  amount_cents: 12345,
  amount_basis: "Net of Recoverable Tax",
  currency: "CAD",
  occurred_at: "2026-08-13T08:00:00.000Z",
  source_doctype: "Material Lot",
  source_name: "lot:1",
  source_digest: SHA,
  source_evidence_id: "evidence:cost:1",
  accounting_state: "Operational",
  authority_ref: "work-package:cost-capture:1",
  approved_at: "2026-08-13T10:00:00.000Z",
  approval_reference: "approval:cost:1",
};
const context = {
  tenantId: "ironwrap",
  actorUser: "finance@example.com",
  approverId: "finance@example.com",
  nowIso: NOW,
};

function sourceContext(candidate, overrides = {}) {
  return {
    tenant: { name: "ironwrap", status: "Active" },
    roofJob: { name: "job:1", roof_job_id: "job:1" },
    sourceRecord: { name: "lot:1", roof_job: "job:1" },
    evidence: {
      name: "evidence:cost:1",
      evidence_id: "evidence:cost:1",
      roof_job: "job:1",
      sync_state: "Verified",
      checksum_algorithm: "SHA-256",
      content_checksum: candidate.source_digest,
      verified_at: "2026-08-13T09:00:00.000Z",
      verification_source: "finance-import",
    },
    ...overrides,
  };
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Job Cost Event input is strict and keeps accounting states semantically distinct", () => {
  assert.equal(JobCostEventInputSchema.safeParse(baseInput).success, true);
  assert.equal(JobCostEventInputSchema.safeParse({ ...baseInput, amount_cents: 12.5 }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    amount_cents: 2_147_483_648,
  }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    amount_basis: "Unknown",
  }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({ ...baseInput, extra: true }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    source_doctype: "External Financial Record",
  }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    accounting_state: "Operational",
    accounting_system: "QuickBooks",
  }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    accounting_state: "Posted",
    accounting_system: "QuickBooks",
    accounting_entity_type: "Bill",
    accounting_entity_id: "bill:1",
  }).success, false);
  assert.equal(JobCostEventInputSchema.safeParse({
    ...baseInput,
    event_kind: "reversal",
  }).success, false);
});

test("candidate construction binds tenant and agent identity without treating it as accounting truth", () => {
  const candidate = buildJobCostEventCandidate(baseInput, context);
  assert.equal(candidate.tenant, "ironwrap");
  assert.match(candidate.actor_id, /^frappe-user:[a-f0-9]{32}$/);
  assert.equal(candidate.actor_id.includes("finance@example.com"), false);
  assert.equal(candidate.amount_cents, 12345);
  assert.equal(candidate.accounting_state, "Operational");
  assert.equal("accounting_digest" in candidate, false);
  assert.doesNotThrow(() => assertJobCostEventSources(candidate, sourceContext(candidate)));
  assert.throws(
    () => buildJobCostEventCandidate({
      ...baseInput,
      approved_at: "2026-08-13T07:00:00.000Z",
    }, context),
    /timestamp_order_invalid/,
  );
});

test("posted candidates require an exact terminal accounting reconciliation", () => {
  const input = {
    ...baseInput,
    job_cost_event_id: "cost:job-1:material:posted-001",
    accounting_state: "Posted",
    accounting_system: "QuickBooks",
    accounting_entity_type: "Bill",
    accounting_entity_id: "bill:1",
    accounting_digest: "b".repeat(64),
    accounting_posted_at: "2026-08-13T09:30:00.000Z",
    reconciliation_id: "reconciliation:bill:1",
  };
  const candidate = buildJobCostEventCandidate(input, context);
  const reconciliation = {
    name: "reconciliation:bill:1",
    roof_job: "job:1",
    system_name: "QuickBooks",
    entity_type: "Bill",
    external_entity_id: "bill:1",
    local_doctype: "Job Cost Event",
    local_name: candidate.job_cost_event_id,
    status: "Matched",
    currency: "CAD",
    source_payload_hash: "b".repeat(64),
    detected_at: "2026-08-13T10:30:00.000Z",
  };
  assert.doesNotThrow(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, { reconciliation }),
  ));
  assert.throws(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, {
      reconciliation: { ...reconciliation, local_name: "different:event" },
    }),
  ), /posted_reconciliation_invalid/);
  assert.throws(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, {
      reconciliation: { ...reconciliation, status: "Open" },
    }),
  ), /posted_reconciliation_invalid/);
  assert.throws(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, {
      reconciliation: {
        ...reconciliation,
        detected_at: "2026-08-13T09:29:59.000Z",
      },
    }),
  ), /reconciliation_timestamp_invalid/);
});

test("positive reversals preserve exact source lineage and cannot double reverse", () => {
  const input = {
    ...baseInput,
    job_cost_event_id: "reversal:job-1:material:001",
    event_kind: "reversal",
    reversal_of: baseInput.job_cost_event_id,
    reversal_reason: "Incorrect quantity; corrected cost follows as a new event.",
  };
  const candidate = buildJobCostEventCandidate(input, context);
  const reversalTarget = {
    ...candidate,
    job_cost_event_id: baseInput.job_cost_event_id,
    event_kind: "cost",
    reversal_of: undefined,
    reversal_reason: undefined,
  };
  assert.doesNotThrow(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, { reversalTarget }),
  ));
  assert.throws(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, {
      reversalTarget: { ...reversalTarget, amount_cents: 12346 },
    }),
  ), /reversal_binding_mismatch/);
  assert.throws(() => assertJobCostEventSources(
    candidate,
    sourceContext(candidate, {
      reversalTarget,
      existingReversals: [{ job_cost_event_id: "reversal:other" }],
    }),
  ), /already_reversed/);
});

test("replay classification accepts only the same immutable semantic fact", () => {
  const candidate = buildJobCostEventCandidate(baseInput, context);
  assert.equal(classifyJobCostEventReplay(candidate, null), "new");
  assert.equal(classifyJobCostEventReplay(candidate, {
    ...candidate,
    name: candidate.job_cost_event_id,
    recorded_at: "2026-08-13T11:00:00.000Z",
    modified: "2026-08-13T11:01:00.000Z",
  }), "identical_replay");
  assert.equal(classifyJobCostEventReplay(candidate, {
    ...candidate,
    amount_cents: candidate.amount_cents + 1,
  }), "id_conflict");
  assert.equal(classifyJobCostEventReplay(candidate, {
    ...candidate,
    amount_basis: "Includes Non-Recoverable Tax",
  }), "id_conflict");
});

test("MCP preparation verifies every source and exposes no write companion", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    tenantId: context.tenantId,
    actorUser: context.actorUser,
    approverId: context.approverId,
    allowedTools: ["dry_run_job_cost_event"],
  });
  assert.ok(server._registeredTools.dry_run_job_cost_event);
  assert.equal(server._registeredTools.request_create_job_cost_event, undefined);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.method, "GET");
    const target = String(url);
    if (target.includes("White-Label%20Tenant/ironwrap")) {
      return response({ data: { name: "ironwrap", tenant_id: "ironwrap", status: "Active" } });
    }
    if (target.includes("Roof%20Job/job%3A1")) {
      return response({ data: { name: "job:1", roof_job_id: "job:1" } });
    }
    if (target.includes("Material%20Lot/lot%3A1")) {
      return response({ data: { name: "lot:1", roof_job: "job:1" } });
    }
    if (target.includes("Evidence%20Item/evidence%3Acost%3A1")) {
      return response({ data: sourceContext({ source_digest: SHA }).evidence });
    }
    if (target.includes("Job%20Cost%20Event/cost%3Ajob-1%3Amaterial%3A001")) {
      return response({ error: "missing" }, 404);
    }
    throw new Error(`unexpected request ${target}`);
  });

  const result = await server._registeredTools.dry_run_job_cost_event.handler(baseInput);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.would_write, false);
  assert.equal(payload.write_tool_available, false);
  assert.equal(payload.replay_state, "new");
  assert.equal(payload.accounting_mutated, false);
  assert.equal(payload.customer_mutated, false);
  assert.equal(payload.candidate.amount_cents, 12345);
  assert.equal(payload.human_gate.action, "manual_frappe_insert");
});

test("strict reads are tenant-bound and redact actor and approver identities", async (t) => {
  const server = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    tenantId: "ironwrap",
    allowedTools: ["get_job_cost_event", "list_job_cost_events_for_job"],
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target.includes("Job%20Cost%20Event?")) {
      assert.match(target, /%22tenant%22/);
      assert.match(target, /%22ironwrap%22/);
      assert.match(target, /%22roof_job%22/);
      return response({ data: [] });
    }
    return response({ data: {
      ...buildJobCostEventCandidate(baseInput, context),
      name: baseInput.job_cost_event_id,
      actor_id: "private-actor",
      approved_by: "private-approver@example.com",
      approved_at: baseInput.approved_at,
    } });
  });

  const getResult = await server._registeredTools.get_job_cost_event.handler({
    job_cost_event_id: baseInput.job_cost_event_id,
  });
  const event = JSON.parse(getResult.content[0].text).data;
  assert.equal(event.amount_cents, 12345);
  assert.equal("actor_id" in event, false);
  assert.equal("approved_by" in event, false);
  assert.equal("approved_at" in event, false);

  await server._registeredTools.list_job_cost_events_for_job.handler({ roof_job_id: "job:1" });

  const wrongTenantServer = buildServer({
    baseUrl: "https://erp.example",
    apiKey: "key",
    apiSecret: "secret",
    writeEnabled: false,
    tenantId: "other-tenant",
    allowedTools: ["get_job_cost_event"],
  });
  await assert.rejects(
    () => wrongTenantServer._registeredTools.get_job_cost_event.handler({
      job_cost_event_id: baseInput.job_cost_event_id,
    }),
    /tenant_mismatch/,
  );
});
