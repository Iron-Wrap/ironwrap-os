import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  buildNowReadModel,
  projectNowReadModel,
  projectProductionNowReadModel,
  projectSalesNowReadModel,
} from "../src/now-read-model.ts";
import type {
  OwnerNowReadModel,
  ProductionRunwayReadModel,
  SalesReadModel,
} from "../src/app-read-models.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";
import type {
  FacetV2IntakeException,
  FacetV2WorkflowEvidence,
} from "../src/facet-v2-evidence.ts";

const generatedAt = "2026-08-13T12:00:00.000Z";
const envelope = {
  version: 1,
  source_updated_at: generatedAt,
  read_model_generated_at: generatedAt,
  stale_fields: [],
  permissions: ["session:read"],
  allowed_actions: ["jobs.read"],
};

function owner(overrides: Partial<OwnerNowReadModel> = {}): OwnerNowReadModel {
  return {
    ...envelope,
    exceptions: [],
    partial_sources: [],
    summary: {
      active_jobs: 0,
      field_blockers: 0,
      blocked_gates: 0,
      open_incidents: 0,
      finance_exceptions: 0,
      untriaged_leads: 0,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 0,
    },
    ...overrides,
  };
}

function production(
  overrides: Partial<ProductionRunwayReadModel> = {},
): ProductionRunwayReadModel {
  return {
    ...envelope,
    partial_sources: [],
    summary: {
      active_jobs: 0,
      blocked: 0,
      scheduled: 0,
      needs_assignment: 0,
      ready_for_review: 0,
      needs_verification: 0,
    },
    jobs: [],
    crews: [],
    ...overrides,
  };
}

function sales(overrides: Partial<SalesReadModel> = {}): SalesReadModel {
  return {
    ...envelope,
    partial_sources: [],
    summary: {
      listed_leads: 0,
      triage_unresolved: 0,
      estimate_needs_review: 0,
      quote_needs_review: 0,
      quote_expired: 0,
      no_linked_consent_record: 0,
    },
    leads: [],
    ...overrides,
  };
}

function facet(
  evidence: FacetV2WorkflowEvidence[] = [],
  intakeExceptions: FacetV2IntakeException[] = [],
) {
  return {
    read_model_generated_at: generatedAt,
    stale_fields: [],
    permissions: ["facet:read"],
    allowed_actions: ["facet_design.read"],
    evidence,
    intake_exceptions: intakeExceptions,
  };
}

function salesLead(): SalesReadModel["leads"][number] {
  return {
    id: "LEAD-1",
    envelope_id: "lead_1",
    source: "website",
    received_at: generatedAt,
    transport_status: "received",
    intent_queue: "Estimator",
    contact: {
      display_name: "Pat Prospect",
      phone: "+14035550101",
      email: "pat@example.com",
    },
    triage: { status: "Untriaged", summary: null },
    job: null,
    estimate: null,
    quote: null,
    proposal: null,
    consent: { context: "no_linked_record", records: [] },
    attention: ["triage_unresolved"],
  };
}

function productionJob(): ProductionRunwayReadModel["jobs"][number] {
  return {
    id: "JOB-1",
    job_number: "IW-1001",
    brand: "IronWrap",
    service_type: "Roofing",
    status: "In Production",
    assignment: null,
    scheduling_preparation_allowed: false,
    lane: "blocked",
    next_action: "Resolve the materials gate.",
    gate_coverage: "complete",
    gate_summary: {
      expected: 6,
      blocked: 1,
      ready: 5,
      waived: 0,
      done: 0,
    },
    scheduling_gates: [
      { name: "Deposit", state: "Ready" },
      { name: "Materials", state: "Blocked" },
      { name: "Safety", state: "Ready" },
      { name: "Access", state: "Ready" },
      { name: "Weather", state: "Ready" },
      { name: "Crew", state: "Ready" },
    ],
    material_attention: [{ status: "Shortage", requested_delivery_date: null }],
  };
}

test("production Now uses only the bounded runway and carries no commercial or owner source", () => {
  const model = projectProductionNowReadModel(
    {
      ok: true,
      model: production({
        permissions: [
          "session:read",
          "now:read",
          "jobs:read:any",
          "production:read",
        ],
        allowed_actions: ["job.read", "production.read"],
        jobs: [productionJob()],
      }),
    },
    new Date(generatedAt),
  );

  assert.equal(model.role, "production");
  assert.deepEqual(
    model.sources.map(({ id }) => id),
    ["production"],
  );
  assert.deepEqual(
    model.ui.sections.map(({ id }) => id),
    ["production"],
  );
  assert.equal(model.ui.primary_action?.href, "/production");
  assert.deepEqual(model.ui.primary_action?.citation_ids, ["production:JOB-1"]);
  assert.equal(JSON.stringify(model).includes('"owner"'), false);
  assert.equal(JSON.stringify(model).includes('"sales"'), false);
});

test("production Now fails closed when the runway cannot be verified", () => {
  const model = projectProductionNowReadModel(
    { ok: false },
    new Date(generatedAt),
  );

  assert.equal(model.ui.state, "limited");
  assert.equal(model.ui.primary_action?.kind, "refresh");
  assert.equal(model.ui.primary_action?.href, null);
  assert.deepEqual(model.permissions, []);
  assert.deepEqual(model.allowed_actions, []);
});

test("sales Now uses only the bounded sales source and never exposes owner or production state", () => {
  const model = projectSalesNowReadModel(
    {
      ok: true,
      model: sales({
        permissions: ["session:read", "now:read", "sales:read"],
        allowed_actions: ["sales.read", "approval.prepare"],
        leads: [salesLead()],
      }),
    },
    new Date(generatedAt),
  );

  assert.equal(model.role, "sales");
  assert.deepEqual(
    model.sources.map(({ id }) => id),
    ["sales"],
  );
  assert.deepEqual(
    model.ui.sections.map(({ id }) => id),
    ["sales"],
  );
  assert.equal(model.ui.primary_action?.href, "/sales");
  assert.deepEqual(model.ui.primary_action?.citation_ids, ["sales:LEAD-1"]);
  assert.equal(JSON.stringify(model).includes("production"), false);
  assert.equal(JSON.stringify(model).includes("owner"), false);
});

test("sales Now fails closed when its sole operational source is unavailable", () => {
  const model = projectSalesNowReadModel({ ok: false }, new Date(generatedAt));

  assert.equal(model.ui.state, "limited");
  assert.equal(model.ui.primary_action?.kind, "refresh");
  assert.equal(model.ui.primary_action?.href, null);
  assert.deepEqual(model.permissions, []);
  assert.deepEqual(model.allowed_actions, []);
});

test("Now prioritizes the first owner exception and keeps its source one click away", () => {
  const model = projectNowReadModel(
    "owner",
    {
      owner: {
        ok: true,
        model: owner({
          permissions: ["owner:read", "session:read"],
          allowed_actions: ["owner.read"],
          exceptions: [
            {
              id: "lead-1",
              kind: "untriaged_lead",
              severity: "High",
              title: "New roofing lead needs triage",
              why: "No service decision has been recorded.",
              next_action: "Review the lead before promising a visit.",
              job_id: null,
              occurred_at: generatedAt,
              due_at: null,
              received_at: generatedAt,
              bus_status: "pushed",
              triage_status: "Untriaged",
              mctb: null,
            },
          ],
        }),
      },
      facet: { ok: true, model: facet() },
      production: { ok: true, model: production() },
      sales: { ok: true, model: sales() },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.state, "ready");
  assert.equal(model.ui.primary_action?.href, "/sales");
  assert.equal(model.ui.primary_action?.citation_ids[0], "owner:lead-1");
  assert.equal(model.ui.sections[0]?.cards[0]?.tone, "critical");
  assert.deepEqual(model.permissions, [
    "owner:read",
    "session:read",
    "facet:read",
  ]);
});

test("Now never treats unavailable or partial sources as clear", () => {
  const model = projectNowReadModel(
    "ops",
    {
      owner: { ok: false },
      facet: { ok: true, model: facet() },
      production: {
        ok: true,
        model: production({ partial_sources: ["supplier_orders"] }),
      },
      sales: { ok: false },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.state, "limited");
  assert.equal(model.ui.primary_action?.kind, "refresh");
  assert.match(model.ui.sync_label, /not treated as clear/i);
  assert.deepEqual(
    model.sources.map(({ id, state }) => ({ id, state })),
    [
      { id: "owner", state: "unavailable" },
      { id: "facet", state: "current" },
      { id: "production", state: "limited" },
      { id: "sales", state: "unavailable" },
    ],
  );
  assert.deepEqual(model.sources[2]?.stale_fields, ["partial.supplier_orders"]);
});

test("Now asks for a fresh read instead of ranking known work above an unavailable source", () => {
  const model = projectNowReadModel(
    "ops",
    {
      owner: { ok: false },
      facet: { ok: true, model: facet() },
      production: {
        ok: true,
        model: production({
          jobs: [
            {
              id: "JOB-1",
              job_number: "IW-1001",
              brand: "IronWrap",
              service_type: "Roofing",
              status: "In Production",
              assignment: null,
              scheduling_preparation_allowed: false,
              lane: "blocked",
              next_action: "Resolve the materials gate.",
              gate_coverage: "complete",
              gate_summary: {
                expected: 6,
                blocked: 1,
                ready: 5,
                waived: 0,
                done: 0,
              },
              scheduling_gates: [
                { name: "Deposit", state: "Ready" },
                { name: "Materials", state: "Blocked" },
                { name: "Safety", state: "Ready" },
                { name: "Access", state: "Ready" },
                { name: "Weather", state: "Ready" },
                { name: "Crew", state: "Ready" },
              ],
              material_attention: [],
            },
          ],
        }),
      },
      sales: { ok: true, model: sales() },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.state, "limited");
  assert.equal(model.ui.primary_action?.kind, "refresh");
  assert.equal(model.ui.primary_action?.href, null);
  assert.match(model.ui.primary_action?.reason ?? "", /cannot safely rank/i);
  assert.equal(model.ui.sections[2]?.cards[0]?.action?.href, "/production");
});

test("Now selects production before sales after owner exceptions are clear", () => {
  const model = projectNowReadModel(
    "ops",
    {
      owner: { ok: true, model: owner() },
      facet: { ok: true, model: facet() },
      production: {
        ok: true,
        model: production({
          jobs: [
            {
              id: "JOB-1",
              job_number: "IW-1001",
              brand: "IronWrap",
              service_type: "Roofing",
              status: "In Production",
              assignment: null,
              scheduling_preparation_allowed: false,
              lane: "blocked",
              next_action: "Resolve the materials gate.",
              gate_coverage: "complete",
              gate_summary: {
                expected: 6,
                blocked: 1,
                ready: 5,
                waived: 0,
                done: 0,
              },
              scheduling_gates: [
                { name: "Deposit", state: "Ready" },
                { name: "Materials", state: "Blocked" },
                { name: "Safety", state: "Ready" },
                { name: "Access", state: "Ready" },
                { name: "Weather", state: "Ready" },
                { name: "Crew", state: "Ready" },
              ],
              material_attention: [
                { status: "Shortage", requested_delivery_date: null },
              ],
            },
          ],
        }),
      },
      sales: { ok: true, model: sales() },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.primary_action?.href, "/production");
  assert.equal(model.ui.primary_action?.reason, "Resolve the materials gate.");
});

test("Now surfaces fail-closed signed Facet attention without exposing immutable evidence hashes", () => {
  const designSha256 = "a".repeat(64);
  const evidenceSha256 = "b".repeat(64);
  const model = projectNowReadModel(
    "owner",
    {
      owner: { ok: true, model: owner() },
      facet: {
        ok: true,
        model: facet([
          {
            event_id: "facet-event-now-0001",
            tenant_id: "ironwrap",
            brand_id: "ironwrap",
            facet_project_id: "facet-project-now-0001",
            design_revision_id: `facet-json-v1:${designSha256}`,
            design_revision_sha256: designSha256,
            frozen_evidence_sha256: evidenceSha256,
            occurred_at: generatedAt,
            received_at: generatedAt,
            provenance: "customer_approved_v2",
            identity_assurance: "oidc",
            decision_kind: "approved",
            previous_event_id: null,
            roof_job_id: "roof-job-now-0001",
            customer_quote_id: "quote-now-0001",
            external_project_link_id: `ironwrap-project-v1:${"c".repeat(64)}`,
            association_sha256: "d".repeat(64),
            projection_state: "attention_required",
            status_code: "facet_v2_authority_drift",
            projection: null,
          },
        ]),
      },
      production: { ok: true, model: production() },
      sales: { ok: true, model: sales() },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.primary_action?.href, "/facet-designs");
  assert.equal(model.ui.sections[1]?.id, "facet");
  assert.match(model.ui.sections[1]?.cards[0]?.detail ?? "", /blank Draft/i);
  assert.equal(JSON.stringify(model.ui).includes(designSha256), false);
  assert.equal(JSON.stringify(model.ui).includes(evidenceSha256), false);
});

test("Now prioritizes fail-closed signed Facet intake recovery", () => {
  const model = projectNowReadModel(
    "owner",
    {
      owner: { ok: true, model: owner() },
      facet: {
        ok: true,
        model: facet([], [
          {
            event_id: "facet-unassociated-now-0001",
            received_at: generatedAt,
            state: "awaiting_association",
            status_code: "awaiting_exact_project_identity_association",
            recovery: "automatic_reconciliation",
          },
          {
            event_id: "facet-rejected-now-0002",
            received_at: generatedAt,
            state: "rejected",
            status_code: "decision_customer_identity_mismatch",
            recovery: "governed_reissue_required",
          },
        ]),
      },
      production: { ok: true, model: production() },
      sales: { ok: true, model: sales() },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.primary_action?.href, "/facet-designs");
  assert.equal(model.ui.sections[1]?.cards[0]?.title, "Waiting for the exact project link");
  assert.equal(model.ui.sections[1]?.cards[1]?.title, "Signed delivery rejected");
  assert.equal(model.ui.sections[1]?.cards[0]?.action?.label, "Review Facet recovery");
});

test("Now keeps signed Facet v2 operational evidence read-only even when legacy flags are true", async () => {
  const auth = (permissions: string[]): AuthContext => ({
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions,
    session: {
      session_hash: "a".repeat(64),
      session_created_at: generatedAt,
      session_expires_at: "2026-08-14T12:00:00.000Z",
      revoked_at: null,
      user_id: "appu_owner_0001",
      tenant_id: "ironwrap",
      email_normalized: "owner@example.com",
      display_name: "Owner",
      role: "owner",
      frappe_user_id: "owner@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: generatedAt,
      updated_at: generatedAt,
      device_id: null,
      device_proof_hash: null,
    },
  });
  const env = {
    APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "true",
    APP_IRONWRAP_LEGACY_V1_DESIGN_EVENTS_ENABLED: "true",
    DB: {
      prepare(sql: string) {
        const statement = {
          all: async () => {
            if (
              !sql.includes("FROM facet_v2_customer_decisions") &&
              !sql.includes("FROM facet_v2_raw_intakes")
            )
              throw new Error("source_unavailable");
            return { results: [] };
          },
          first: async () => { throw new Error("source_unavailable"); },
          run: async () => { throw new Error("source_unavailable"); },
        };
        return { ...statement, bind: () => statement };
      },
    },
  } as AppEnv;

  const model = await buildNowReadModel(
    env,
    auth(["facet:read", "facet:associate", "approvals:prepare", "estimator:read"]),
    new Date(generatedAt),
  );
  assert.equal(model.allowed_actions.includes("facet_design.read"), true);
  assert.equal(model.allowed_actions.includes("facet_design.associate"), false);
  assert.equal(model.allowed_actions.includes("facet_design.prepare_quote_revision"), false);
});
test("owner Now surfaces publication drift as bounded manual reconciliation", () => {
  const model = projectNowReadModel(
    "owner",
    {
      owner: { ok: true, model: owner() },
      postiz: {
        ok: true,
        model: {
          read_model_generated_at: generatedAt,
          stale_fields: [],
          permissions: ["postiz:intent:read"],
          allowed_actions: ["postiz.intent.review"],
          intents: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "Approved exterior design",
              content: "This full draft belongs only on the detail screen.",
              provider: "facebook",
              integration_id: "integration-facebook-1",
              scheduled_at: "2026-08-20T12:00:00.000Z",
              evidence_refs: ["evidence:synthetic-001"],
              citations: [
                {
                  id: "citation:synthetic-001",
                  label: "Synthetic",
                  source_ref: "event:synthetic-001",
                },
              ],
              permission_scope: "brand:ironwrap:marketing.social.review",
              state: "reconciliation_required",
              version: 1,
              error_code: "postiz_publication_drift_absent",
              created_at: generatedAt,
              updated_at: generatedAt,
            },
          ],
        },
      },
      facet: { ok: true, model: facet() },
      production: { ok: true, model: production() },
      sales: { ok: true, model: sales() },
      quickbooks_final_invoices: {
        ok: true,
        model: {
          read_model_generated_at: generatedAt,
          stale_fields: [],
          permissions: [],
          allowed_actions: [],
          intents: [],
          holds: [],
        },
      },
    },
    new Date(generatedAt),
  );

  assert.equal(
    model.ui.primary_action?.href,
    "/marketing/postiz/11111111-1111-4111-8111-111111111111",
  );
  assert.equal(model.sources[2]?.id, "postiz");
  assert.match(model.ui.primary_action?.reason ?? "", /reconcile manually/i);
  assert.match(
    model.ui.primary_action?.reason ?? "",
    /retraction is not automated/i,
  );
  assert.equal(
    JSON.stringify(model.ui).includes("This full draft belongs only"),
    false,
  );
});

test("owner Now makes the sole actionable QuickBooks invoice the main call to action", () => {
  const intentId = "qbo-final-invoice:job-0001";
  const model = projectNowReadModel(
    "owner",
    {
      owner: { ok: true, model: owner() },
      facet: { ok: true, model: facet() },
      production: { ok: true, model: production() },
      sales: { ok: true, model: sales() },
      quickbooks_final_invoices: {
        ok: true,
        model: {
          read_model_generated_at: generatedAt,
          stale_fields: [],
          permissions: ["quickbooks:read"],
          allowed_actions: ["quickbooks:review"],
          intents: [
            {
              intent_id: intentId,
              roof_job_id: "job-0001",
              shop_order_id: null,
              state: "pending_review",
              version: 1,
              currency: "CAD",
              final_balance: "1050.00",
              blocker_code: null,
              blocker_next_step: null,
              rejection_reason: null,
              evidence: [],
              updated_at: generatedAt,
            },
          ],
          holds: [],
        },
      },
    },
    new Date(generatedAt),
  );

  assert.equal(model.ui.primary_action?.label, "Review final invoice");
  assert.equal(
    model.ui.primary_action?.href,
    "/accounting/quickbooks/final-invoices/qbo-final-invoice%3Ajob-0001",
  );
  assert.match(model.ui.primary_action?.reason ?? "", /pending review/i);
  assert.deepEqual(model.ui.primary_action?.citation_ids, [
    `qbo-final-invoice:${intentId}`,
  ]);
});

test("Now API rejects field sessions before any source read", async () => {
  const auth: AuthContext = {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read", "jobs:read:assigned", "field:write:assigned"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: generatedAt,
      session_expires_at: "2026-08-14T12:00:00.000Z",
      revoked_at: null,
      user_id: "appu_field",
      tenant_id: "ironwrap",
      email_normalized: "crew@example.com",
      display_name: "Crew",
      role: "field",
      frappe_user_id: "crew@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: generatedAt,
      updated_at: generatedAt,
      device_id: "device_1",
      device_proof_hash: "b".repeat(64),
    },
  };

  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.com/api/v1/now"),
    {} as AppEnv,
    auth,
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "office_role_required" });
});
