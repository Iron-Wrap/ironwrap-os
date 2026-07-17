import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
  mctbStatus,
} from "../src/app-read-models.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { FRAPPE_READ_FIELDS, OFFICE_PRODUCTION_READ_FIELDS, OFFICE_SALES_READ_FIELDS } from "../src/frappe-read.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const MODIFIED = "2026-07-10T11:00:00.000Z";

const jobs = [
  job("JOB-A", "IW-1001", "PROP-A", "CUSTOMER-A"),
  job("JOB-B", "IW-1002", "PROP-B", "CUSTOMER-B"),
  job("JOB-C", "IW-1003", "PROP-C", "CUSTOMER-C"),
];

const assignments = [
  {
    name: "ASSIGN-A", assignment_id: "assignment_a", roof_job: "JOB-A", assignment_type: "Production",
    status: "In Progress", assigned_user: "crew@example.com", crew_profile: null,
    scheduled_start: "2026-07-10T08:00:00.000Z", scheduled_end: "2026-07-10T16:00:00.000Z",
    blocker_reason: null, modified: MODIFIED,
  },
  {
    name: "ASSIGN-B", assignment_id: "assignment_b", roof_job: "JOB-B", assignment_type: "Quality",
    status: "Assigned", assigned_user: null, crew_profile: "CREW-1",
    scheduled_start: "2026-07-11T08:00:00.000Z", scheduled_end: null,
    blocker_reason: null, modified: MODIFIED,
  },
];

const proofRows = Array.from({ length: 1_051 }, (_, index) => ({
  name: `EVID-${String(index).padStart(4, "0")}`,
  evidence_id: `evidence_${String(index).padStart(4, "0")}`,
  device_action_id: `action_${index}`,
  roof_job: "JOB-A",
  evidence_type: "Photo",
  proof_slot: "Production",
  source_system: "ironwrap-pwa",
  captured_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
  customer_safe: 0,
  summary: `Photo ${index}`,
  sync_state: "Verified",
  modified: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
}));

function job(name: string, number: string, property: string, customer: string) {
  return {
    name,
    roof_job_id: name.toLowerCase(),
    job_number: number,
    brand: "ironwrap",
    service_type: "Roofing",
    job_status: "In Production",
    roofing_property: property,
    customer,
    current_gate_state: "Materials: Blocked",
    lead_envelope: null,
    workflow_profile: "Residential Retail",
    quotation: name === "JOB-A" ? "QUOTE-A" : null,
    modified: MODIFIED,
    _assign: JSON.stringify(["must-not-be-used@example.com"]),
    qb_invoice_ref: "financial-secret",
  };
}

function auth(role: AppRole, frappeUserId: string | null): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: role === "field"
      ? ["session:read", "jobs:read:assigned", "field:write:assigned"]
      : ["session:read", "jobs:read:any", "owner:read", "field:write:assigned"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: MODIFIED,
      session_expires_at: "2026-07-11T10:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: frappeUserId,
      active: 1,
      created_by: "owner@example.com",
      created_at: MODIFIED,
      updated_at: MODIFIED,
    },
  };
}

function env(): AppEnv {
  return {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_TIME_ZONE: "America/Edmonton",
    DB: {
      prepare(sql: string) {
        return {
          bind(...ids: unknown[]) {
            return {
              all: async () => {
                if (sql.includes("FROM envelopes")) {
                  return { results: ids.map((id) => id === "lead_a" ? {
                    envelope_id: "lead_a",
                    received_at: "2026-07-10T10:00:00.000Z",
                    bus_status: "pushed",
                  } : null).filter(Boolean) };
                }
                if (sql.includes("FROM lead_ack_receipts")) {
                  return { results: ids.map((id) => id === "lead_a" ? {
                    receipt_id: "ack_1", envelope_id: "lead_a", channel: "email",
                    outcome: "provider_accepted", observed_at: "2026-07-10T10:00:30.000Z",
                    provider_message_id: "gmail-1", error_code: null, created_at: "2026-07-10T10:00:30.000Z",
                  } : null).filter(Boolean) };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as never;
}

function envWithLeadTriageBroker(): AppEnv {
  return {
    ...env(),
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_APPROVAL_BROKER_URL: "http://127.0.0.1:8788",
    APP_APPROVAL_BROKER_KEY_ID: "sales-triage-test-key",
    APPROVAL_BROKER_SHARED_SECRET: "sales-triage-shared-secret-for-test-0001",
    APP_APPROVAL_APPROVER_ID: "owner@example.com",
    APP_APPROVAL_MAX_SESSION_AGE_SECONDS: "900",
    APP_APPROVAL_BROKER_TIMEOUT_MS: "5000",
    APP_APPROVAL_EXECUTION_LEASE_SECONDS: "45",
  } as AppEnv;
}

function installFrappeMock(sourceOverrides: Record<string, Array<Record<string, unknown>>> = {}) {
  const original = globalThis.fetch;
  const requests: Array<{ doctype: string; fields: string[]; filters: unknown[]; offset: number; limit: number }> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const fields = JSON.parse(url.searchParams.get("fields") ?? "[]") as string[];
    const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as unknown[];
    const offset = Number(url.searchParams.get("limit_start") ?? "0");
    const limit = Number(url.searchParams.get("limit_page_length") ?? "50");
    requests.push({ doctype, fields, filters, offset, limit });
    const source = sourceOverrides[doctype] ?? rowsFor(doctype);
    const filtered = source.filter((row) => filters.every((filter) => matchFilter(row, filter)));
    const ordered = [...filtered].sort((left, right) => {
      const modified = String(right.modified ?? "").localeCompare(String(left.modified ?? ""));
      return modified || String(right.name ?? "").localeCompare(String(left.name ?? ""));
    });
    return Response.json({ data: ordered.slice(offset, offset + limit) });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

function rowsFor(doctype: string): Array<Record<string, unknown>> {
  if (doctype === "Roof Job") return jobs;
  if (doctype === "Job Assignment") return assignments;
  if (doctype === "Crew Member") return [{
    name: "CREW-MEMBER-1", parent: "CREW-1", parenttype: "Crew Profile", parentfield: "members",
    crew_user: "crew@example.com", crew_role: "Installer", active: 1, joined_on: "2026-01-01",
    left_on: null, certification_summary: "private", notes: "private", modified: MODIFIED,
  }];
  if (doctype === "Roofing Property") return jobs.map((row, index) => ({
    name: row.roofing_property,
    address_line1: `${index + 10} Test Ave`,
    city: "Calgary", province: "AB", postal_code: "T1T 1T1", country: "Canada",
    roof_notes: "internal access secret", hazard_notes: "internal hazard secret", modified: MODIFIED,
  }));
  if (doctype === "Roofing Customer") return jobs.map((row, index) => ({
    name: row.customer,
    display_name: `Customer ${index + 1}`,
    phone: `+1403555000${index}`,
    email: `customer${index}@private.example`,
    notes: "internal customer note",
    modified: MODIFIED,
  }));
  if (doctype === "Production Gate State") return [{
    name: "GATE-A", gate_id: "gate_a", roof_job: "JOB-A", gate: "Materials", state: "Blocked",
    owner_user: "office-owner@example.com", due_at: "2026-07-11 12:00:00",
    blocker_reason: "Delivery not confirmed", modified: MODIFIED,
  }];
  if (doctype === "Evidence Item") return proofRows;
  if (doctype === "Field Check-in") return [{
    name: "CHECKIN-BLOCKED", checkin_id: "checkin_blocked", roof_job: "JOB-A", status: "Received",
    sync_state: "Verified", blocker_flag: 1, blocker_category: "Weather",
    blocker_summary: "Wind exceeds the site plan limit.", submitted_at: "2026-07-10 10:05:00", modified: MODIFIED,
  }, {
    name: "CHECKIN-RESOLVED", checkin_id: "checkin_resolved", roof_job: "JOB-B", status: "Resolved",
    sync_state: "Verified", blocker_flag: 1, blocker_category: "Materials",
    blocker_summary: "Historical shortage already resolved.", submitted_at: "2026-07-09 10:05:00", modified: MODIFIED,
  }];
  if (doctype === "Scope Clause") return [{
    name: "SCOPE-A", scope_clause_id: "scope_a", roof_job: "JOB-A", clause_type: "Included",
    title: "Approved roof scope", clause_text: "Install approved system", version: "1", status: "Approved",
    customer_visible: 1, notes: "internal", modified: MODIFIED,
  }];
  if (doctype === "Measurement Report") return [{
    name: "MEASURE-A", measurement_id: "measure_a", roof_job: "JOB-A", provider: "RoofRuler",
    review_status: "Approved", parsed_at: MODIFIED, report_url: "private", modified: MODIFIED,
  }];
  if (doctype === "Material Takeoff") return [{
    name: "TAKEOFF-A", takeoff_id: "takeoff_a", roof_job: "JOB-A", status: "Approved",
    prepared_at: MODIFIED, assumptions: "internal pricing assumption", exclusions: "internal exclusion", modified: MODIFIED,
  }];
  if (doctype === "Supplier Order") return [{
    name: "ORDER-A", supplier_order_id: "order_a", roof_job: "JOB-A", status: "Ordered",
    requested_delivery_date: "2026-07-12", delivery_notes: "Deliver to rear", order_summary_json: "financial", modified: MODIFIED,
  }, {
    name: "ORDER-SHORT", supplier_order_id: "order_short", roof_job: "JOB-B", status: "Shortage",
    requested_delivery_date: "2026-07-11", delivery_notes: "Starter stock is short", modified: MODIFIED,
  }];
  if (doctype === "Automation Incident") return [{
    name: "INCIDENT-A", incident_id: "incident_a", status: "Open", severity: "High",
    category: "Frappe delivery", summary: "Frappe mirror needs review", roof_job: "JOB-A", modified: MODIFIED,
  }];
  if (doctype === "Payment Milestone") return [{
    name: "PAYMENT-A", payment_milestone_id: "payment_a", roof_job: "JOB-A",
    milestone_type: "Deposit", status: "Needs Review", due_date: "2026-07-11",
    notes: "Deposit receipt needs review", modified: MODIFIED,
  }];
  if (doctype === "Lead Envelope") return [{
    name: "LEAD-A", envelope_id: "lead_a", status: "received", source: "website",
    event_ts: "2026-07-10T10:00:00.000Z", intent_queue: "Estimator", triage_status: "Untriaged",
    triage_summary: "Hail repair inquiry, confirm site details before a final scope.",
    contact_name: "Pat Prospect", contact_phone: "+14035559999", contact_email: "pat@example.com",
    job_ref: "JOB-A", payload_json: "raw-intake-secret", raw_key: "r2-private-key", modified: MODIFIED,
  }];
  if (doctype === "Instant Estimate Session") return [{
    name: "ESTIMATE-A", estimate_session_id: "estimate_a", lead_envelope: "LEAD-A", roof_job: "JOB-A",
    source: "website", service_type: "Roofing", status: "Needs Review", range_low: 12_400, range_high: 15_900,
    estimate_total: null, confidence: "Preliminary", review_required: 1, reviewed_at: null, approved_at: null,
    assumptions: "Visible slope and access assumptions require verification.",
    exclusions: "Not a final quote or contract.", payload_json: "private-estimate-json", modified: MODIFIED,
  }];
  if (doctype === "Customer Quote") return [{
    name: "QUOTE-A", customer_quote_id: "quote_a", roof_job: "JOB-A", quote_version: 2,
    status: "Needs Review", quote_total: 14_750, currency: "CAD", valid_until: "2026-07-20",
    payment_status: "Not Due", prepared_at: MODIFIED, approved_at: null, accepted_at: null,
    scope_summary: "Replace affected roof system.", tax_policy_snapshot_json: "private-tax-policy", modified: MODIFIED,
  }];
  if (doctype === "Proposal Evidence Pack") return [{
    name: "PROPOSAL-A", pack_id: "pack_a", roof_job: "JOB-A", quotation: "QUOTE-A", status: "Draft",
    prepared_at: MODIFIED, approved_at: null, signed_at: null, evidence_summary_json: "private-proposal-summary",
    modified: MODIFIED,
  }];
  if (doctype === "Communication Consent") return [{
    name: "CONSENT-A", consent_id: "consent_a", customer: "CUSTOMER-A", lead_envelope: "LEAD-A", roof_job: "JOB-A",
    channel: "Email", purpose: "Estimate Follow-up", status: "Granted", jurisdiction: "AB",
    consent_basis: "Express", captured_at: MODIFIED, effective_from: MODIFIED, expires_at: null, revoked_at: null,
    source_reference: "private-form-reference", notes: "private-consent-note", modified: MODIFIED,
  }];
  if (doctype === "Change Order") return [{
    name: "CHANGE-A", change_order_id: "change_a", roof_job: "JOB-A", change_number: "CO-1",
    version: 1, status: "Accepted", title: "Deck repair", scope_delta: "Replace damaged deck",
    currency: "CAD", total_amount: 50_000, notes: "internal", modified: MODIFIED,
  }];
  if (doctype === "Safety Plan") return [{
    name: "SAFETY-A", safety_plan_id: "safety_a", roof_job: "JOB-A", version: 1,
    status: "Ready", effective_date: "2026-07-10", hazard_summary: "Steep slope",
    controls: "Tie off", emergency_plan: "Call 911", ppe_requirements: "Harness",
    weather_limits: "Stop in lightning", notes: "internal", modified: MODIFIED,
  }];
  return [];
}

function matchFilter(row: Record<string, unknown>, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const [, field, operator, expected] = raw;
  const actual = row[String(field)];
  if (operator === "=") return String(actual ?? "") === String(expected ?? "");
  if (operator === "in" && Array.isArray(expected)) return expected.map(String).includes(String(actual ?? ""));
  return false;
}

test("field Today uses direct and active crew membership assignments, never generic _assign", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildTodayReadModel(env(), auth("field", "crew@example.com"));
    assert.deepEqual(model.jobs.map((item) => item.id), ["JOB-A", "JOB-B"]);
    assert.equal(model.jobs[0]?.assignment?.id, "ASSIGN-A");
    assert.equal(model.jobs[1]?.assignment?.crew_profile, "CREW-1");
    assert.equal(mock.requests.some((request) => request.filters.some((filter) => Array.isArray(filter) && filter[1] === "_assign")), false);
    assert.equal(FRAPPE_READ_FIELDS["Roof Job"].includes("_assign" as never), false);
  } finally {
    mock.restore();
  }
});

test("field is denied an unassigned job while office reads it and Today does not hide it", async () => {
  const mock = installFrappeMock();
  try {
    assert.equal(await buildJobReadModel(env(), auth("field", "crew@example.com"), "JOB-C"), null);
    const officeJob = await buildJobReadModel(env(), auth("ops", "ops@example.com"), "JOB-C");
    assert.equal(officeJob?.job.id, "JOB-C");
    assert.equal(officeJob?.assignment, null);
    const officeToday = await buildTodayReadModel(env(), auth("ops", "ops@example.com"));
    assert.deepEqual(new Set(officeToday.jobs.map((item) => item.id)), new Set(["JOB-A", "JOB-B", "JOB-C"]));
    assert.equal(officeToday.jobs.find((item) => item.id === "JOB-C")?.next_action, "Assign field work");
  } finally {
    mock.restore();
  }
});

test("owner Now is an office-only, exception-first roofing read model", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildOwnerNowReadModel(env(), auth("owner", "owner@example.com"));
    assert.deepEqual(model.summary, {
      active_jobs: 3,
      field_blockers: 1,
      blocked_gates: 1,
      open_incidents: 1,
      finance_exceptions: 1,
      untriaged_leads: 1,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 1,
    });
    assert.deepEqual(model.exceptions.map((exception) => exception.kind), [
      "field_blocker", "blocked_gate", "automation_incident", "material_exception", "finance_exception", "untriaged_lead",
    ]);
    assert.deepEqual(model.exceptions[0], {
      id: "checkin_blocked",
      kind: "field_blocker",
      severity: null,
      title: "Weather work-stop reported",
      why: "Wind exceeds the site plan limit.",
      next_action: null,
      job_id: "JOB-A",
      occurred_at: "2026-07-10 10:05:00",
      due_at: null,
      received_at: null,
      bus_status: null,
      triage_status: null,
      mctb: null,
    });
    assert.deepEqual(model.exceptions[1], {
      id: "gate_a",
      kind: "blocked_gate",
      severity: null,
      title: "Materials gate blocked",
      why: "Delivery not confirmed",
      next_action: null,
      job_id: "JOB-A",
      occurred_at: null,
      due_at: "2026-07-11 12:00:00",
      received_at: null,
      bus_status: null,
      triage_status: null,
      mctb: null,
    });
    assert.ok(model.stale_fields.includes("exceptions.next_action"));
    assert.ok(model.stale_fields.includes("exceptions.due_at"));
    assert.deepEqual(model.partial_sources, []);
    assert.deepEqual(model.allowed_actions, [
      "job.read", "lead.read", "lead_triage.read", "field_blocker.read", "incident.read", "finance_exception.read", "material_exception.read",
    ]);
    const blockerRequest = mock.requests.find((request) => request.doctype === "Field Check-in");
    assert.deepEqual(blockerRequest?.filters, [
      ["Field Check-in", "blocker_flag", "=", 1],
      ["Field Check-in", "status", "in", ["Received", "Needs Review"]],
      ["Field Check-in", "sync_state", "=", "Verified"],
    ]);
    await assert.rejects(
      async () => await buildOwnerNowReadModel(env(), auth("field", "crew@example.com")),
      /owner_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("production runway is an office-only, bounded read that never treats a gate summary as dispatch authority", async () => {
  const readyGates = ["JOB-B", "JOB-C"].flatMap((roofJob) =>
    ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
      name: `GATE-${roofJob}-${gate}`,
      gate_id: `gate_${roofJob.toLowerCase()}_${gate.toLowerCase()}`,
      roof_job: roofJob,
      gate,
      state: "Ready",
      owner_user: "office-owner@example.com",
      assigned_at: MODIFIED,
      due_at: null,
      blocker_reason: null,
      modified: MODIFIED,
    })),
  );
  const mock = installFrappeMock({
    "Job Assignment": [
      assignments[0]!,
      { ...assignments[1]!, scheduled_start: null, scheduled_end: null },
      {
        name: "ASSIGN-C", assignment_id: "assignment_c", roof_job: "JOB-C", assignment_type: "Production",
        status: "Assigned", assigned_user: null, crew_profile: "CREW-1",
        scheduled_start: null, scheduled_end: null, blocker_reason: null, modified: MODIFIED,
      },
    ],
    "Production Gate State": [
      {
        name: "GATE-A", gate_id: "gate_a", roof_job: "JOB-A", gate: "Materials", state: "Blocked",
        owner_user: "office-owner@example.com", due_at: "2026-07-11 12:00:00",
        blocker_reason: "Delivery not confirmed", modified: MODIFIED,
      },
      ...readyGates,
      {
        name: "GATE-C-COMPLETION", gate_id: "gate_job_c_completion", roof_job: "JOB-C", gate: "Completion",
        state: "Blocked", owner_user: "office-owner@example.com", due_at: null,
        blocker_reason: "Awaiting closeout", modified: MODIFIED,
      },
    ],
    "Supplier Order": [{
      name: "ORDER-A", supplier_order_id: "order_a", roof_job: "JOB-A", status: "Ordered",
      requested_delivery_date: "2026-07-12", delivery_notes: "Deliver to rear", order_summary_json: "financial", modified: MODIFIED,
    }],
  });
  try {
    const model = await buildProductionRunwayReadModel(env(), auth("ops", "ops@example.com"));
    assert.deepEqual(model.summary, {
      active_jobs: 3,
      blocked: 1,
      scheduled: 0,
      needs_assignment: 1,
      ready_for_review: 1,
      needs_verification: 0,
    });
    assert.equal(model.jobs.find((job) => job.id === "JOB-A")?.lane, "blocked");
    assert.equal(model.jobs.find((job) => job.id === "JOB-B")?.lane, "needs_assignment");
    assert.equal(model.jobs.find((job) => job.id === "JOB-B")?.assignment, null);
    assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.lane, "ready_for_review");
    assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.gate_coverage, "complete");
    assert.deepEqual(model.jobs.find((job) => job.id === "JOB-C")?.gate_summary, {
      expected: 6, blocked: 0, ready: 6, waived: 0, done: 0,
    });
    assert.deepEqual(model.jobs.find((job) => job.id === "JOB-C")?.scheduling_gates, [
      { name: "Deposit", state: "Ready" },
      { name: "Materials", state: "Ready" },
      { name: "Safety", state: "Ready" },
      { name: "Access", state: "Ready" },
      { name: "Weather", state: "Ready" },
      { name: "Crew", state: "Ready" },
    ]);
    assert.deepEqual(model.allowed_actions, ["job.read", "production.read"]);
    assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.next_action.includes("does not dispatch"), true);
    const serialized = JSON.stringify(model);
    for (const secret of ["financial-secret", "customer0@private.example", "Deliver to rear", "office-owner@example.com"]) {
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }
    const jobRequest = mock.requests.find((request) => request.doctype === "Roof Job");
    assert.deepEqual(jobRequest?.fields, OFFICE_PRODUCTION_READ_FIELDS["Roof Job"]);
    const assignmentRequest = mock.requests.find((request) => request.doctype === "Job Assignment");
    assert.deepEqual(assignmentRequest?.fields, OFFICE_PRODUCTION_READ_FIELDS["Job Assignment"]);
    assert.deepEqual(assignmentRequest?.filters, [
      ["Job Assignment", "status", "in", ["Assigned", "Accepted", "In Progress", "Blocked"]],
      ["Job Assignment", "assignment_type", "=", "Production"],
    ]);
    const gateRequest = mock.requests.find((request) => request.doctype === "Production Gate State");
    assert.deepEqual(gateRequest?.fields, OFFICE_PRODUCTION_READ_FIELDS["Production Gate State"]);
    assert.deepEqual(gateRequest?.filters, [["Production Gate State", "roof_job", "in", ["JOB-C", "JOB-B", "JOB-A"]]]);
    const materialRequest = mock.requests.find((request) => request.doctype === "Supplier Order");
    assert.deepEqual(materialRequest?.fields, OFFICE_PRODUCTION_READ_FIELDS["Supplier Order"]);
    assert.deepEqual(materialRequest?.filters, [
      ["Supplier Order", "roof_job", "in", ["JOB-C", "JOB-B", "JOB-A"]],
      ["Supplier Order", "status", "in", ["Needs Review", "Shortage"]],
    ]);
    await assert.rejects(
      async () => await buildProductionRunwayReadModel(env(), auth("field", "crew@example.com")),
      /owner_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("production runway does not collapse duplicate scheduling gates into a schedule-ready job", async () => {
  const readyGates = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
    name: `GATE-C-${gate}`,
    roof_job: "JOB-C",
    gate,
    state: "Ready",
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({
    "Job Assignment": [{
      name: "ASSIGN-C", roof_job: "JOB-C", assignment_type: "Production", status: "Assigned",
      scheduled_start: null, scheduled_end: null, modified: MODIFIED,
    }],
    "Production Gate State": [
      ...readyGates,
      {
        name: "GATE-C-MATERIALS-OLD", roof_job: "JOB-C", gate: "Materials", state: "Blocked",
        modified: "2026-07-10T10:00:00.000Z",
      },
    ],
  });
  try {
    const model = await buildProductionRunwayReadModel(env(), auth("ops", "ops@example.com"));
    const job = model.jobs.find((row) => row.id === "JOB-C");
    assert.equal(job?.gate_coverage, "incomplete");
    assert.equal(job?.lane, "needs_verification");
  } finally {
    mock.restore();
  }
});

test("production runway with a truncated assignment source does not claim an unreturned crew is missing", async () => {
  const partialAssignments = Array.from({ length: 100 }, (_, index) => ({
    name: `ASSIGN-PARTIAL-${index}`,
    roof_job: `OTHER-${index}`,
    assignment_type: "Production",
    status: "Assigned",
    scheduled_start: null,
    scheduled_end: null,
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({ "Job Assignment": partialAssignments });
  try {
    const model = await buildProductionRunwayReadModel(env(), auth("ops", "ops@example.com"));
    assert.ok(model.partial_sources.includes("active_assignments"));
    assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.lane, "needs_verification");
    assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.assignment, null);
  } finally {
    mock.restore();
  }
});

test("production runway with a truncated material source never promotes a job to ready for review", async () => {
  const readyGates = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map((gate) => ({
    name: `GATE-B-${gate}`,
    roof_job: "JOB-B",
    gate,
    state: "Ready",
    modified: MODIFIED,
  }));
  const partialMaterials = Array.from({ length: 100 }, (_, index) => ({
    name: `ORDER-PARTIAL-${index}`,
    roof_job: "JOB-C",
    status: "Shortage",
    requested_delivery_date: null,
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({
    "Job Assignment": [
      assignments[0]!,
      { ...assignments[1]!, assignment_type: "Production", scheduled_start: null, scheduled_end: null },
    ],
    "Production Gate State": [
      { name: "GATE-A", roof_job: "JOB-A", gate: "Materials", state: "Blocked", modified: MODIFIED },
      ...readyGates,
    ],
    "Supplier Order": partialMaterials,
  });
  try {
    const model = await buildProductionRunwayReadModel(env(), auth("ops", "ops@example.com"));
    assert.ok(model.partial_sources.includes("material_exceptions"));
    assert.equal(model.jobs.find((job) => job.id === "JOB-B")?.gate_coverage, "complete");
    assert.equal(model.jobs.find((job) => job.id === "JOB-B")?.lane, "needs_verification");
  } finally {
    mock.restore();
  }
});

test("Sales Desk receives a bounded office contract without widening Owner Now or leaking raw records", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(env(), auth("ops", "ops@example.com"));
    assert.deepEqual(model.summary, {
      listed_leads: 1,
      triage_unresolved: 1,
      estimate_needs_review: 1,
      quote_needs_review: 1,
      quote_expired: 0,
      no_linked_consent_record: 0,
    });
    assert.deepEqual(model.partial_sources, []);
    assert.deepEqual(model.allowed_actions.at(-1), "sales.read");
    assert.deepEqual(model.leads[0], {
      id: "LEAD-A",
      envelope_id: "lead_a",
      source: "website",
      received_at: "2026-07-10T10:00:00.000Z",
      transport_status: "received",
      intent_queue: "Estimator",
      contact: {
        display_name: "Pat Prospect",
        phone: "+14035559999",
        email: "pat@example.com",
      },
      triage: {
        status: "Untriaged",
        summary: "Hail repair inquiry, confirm site details before a final scope.",
      },
      job: {
        id: "JOB-A",
        job_number: "IW-1001",
        status: "In Production",
        service_type: "Roofing",
        workflow_profile: "Residential Retail",
      },
      estimate: {
        id: "estimate_a",
        status: "Needs Review",
        service_type: "Roofing",
        range_low: 12_400,
        range_high: 15_900,
        estimate_total: null,
        confidence: "Preliminary",
        review_required: true,
        reviewed_at: null,
        approved_at: null,
        assumptions: "Visible slope and access assumptions require verification.",
        exclusions: "Not a final quote or contract.",
      },
      quote: {
        id: "quote_a",
        version: 2,
        status: "Needs Review",
        quote_total: 14_750,
        currency: "CAD",
        valid_until: "2026-07-20",
        payment_status: "Not Due",
        prepared_at: MODIFIED,
        approved_at: null,
        accepted_at: null,
        scope_summary: "Replace affected roof system.",
      },
      proposal: {
        id: "pack_a",
        status: "Draft",
        prepared_at: MODIFIED,
        approved_at: null,
        signed_at: null,
        has_published_pack: false,
        published_status: null,
      },
      consent: {
        context: "recorded",
        records: [{
          id: "consent_a",
          channel: "Email",
          purpose: "Estimate Follow-up",
          status: "Granted",
          jurisdiction: "AB",
          basis: "Express",
          captured_at: MODIFIED,
          effective_from: MODIFIED,
          expires_at: null,
          revoked_at: null,
        }],
      },
      attention: ["triage_unresolved", "estimate_needs_review", "quote_needs_review"],
    });
    const serialized = JSON.stringify(model);
    for (const secret of [
      "raw-intake-secret", "r2-private-key", "private-estimate-json", "private-tax-policy",
      "private-proposal-summary", "private-form-reference", "private-consent-note",
    ]) assert.equal(serialized.includes(secret), false, `leaked ${secret}`);

    const officeLeadRequest = mock.requests.find((request) =>
      request.doctype === "Lead Envelope" && request.fields.includes("contact_phone"),
    );
    assert.ok(officeLeadRequest);
    assert.deepEqual(officeLeadRequest?.fields, OFFICE_SALES_READ_FIELDS["Lead Envelope"]);
    assert.equal(officeLeadRequest?.fields.includes("payload_json"), false);
    const legacyJobReferenceRequest = mock.requests.find((request) =>
      request.doctype === "Roof Job"
      && request.filters.some((filter) => Array.isArray(filter) && filter[1] === "name" && filter[2] === "in"),
    );
    assert.deepEqual(legacyJobReferenceRequest?.filters, [["Roof Job", "name", "in", ["JOB-A"]]]);
    const proposalRequest = mock.requests.find((request) => request.doctype === "Proposal Evidence Pack");
    assert.deepEqual(proposalRequest?.fields, OFFICE_SALES_READ_FIELDS["Proposal Evidence Pack"]);
    assert.deepEqual(proposalRequest?.filters, [["Proposal Evidence Pack", "quotation", "in", ["QUOTE-A"]]]);

    const ownerModel = await buildOwnerNowReadModel(env(), auth("owner", "owner@example.com"));
    assert.equal(ownerModel.summary.untriaged_leads, 1);
    const ownerLeadRequest = mock.requests.find((request) =>
      request.doctype === "Lead Envelope" && request.fields.includes("contact_phone") === false,
    );
    assert.deepEqual(ownerLeadRequest?.fields, FRAPPE_READ_FIELDS["Lead Envelope"]);

    await assert.rejects(
      async () => await buildSalesReadModel(env(), auth("field", "crew@example.com")),
      /office_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("Sales grants the bounded triage-prepare action only for a configured broker and Frappe identity", async () => {
  const mock = installFrappeMock();
  try {
    const ready = await buildSalesReadModel(envWithLeadTriageBroker(), auth("ops", "ops@example.com"));
    assert.equal(ready.allowed_actions.includes("approval.prepare"), true);
    assert.equal(ready.leads[0]?.triage.status, "Untriaged");
    assert.equal(ready.leads[0]?.attention.includes("triage_unresolved"), true);

    const noFrappeIdentity = await buildSalesReadModel(envWithLeadTriageBroker(), auth("ops", null));
    assert.equal(noFrappeIdentity.allowed_actions.includes("approval.prepare"), false);

    const noBroker = await buildSalesReadModel(env(), auth("ops", "ops@example.com"));
    assert.equal(noBroker.allowed_actions.includes("approval.prepare"), false);
  } finally {
    mock.restore();
  }
});

test("Sales Desk projects proposal publication only from the selected quote version", async () => {
  const mock = installFrappeMock({
    "Customer Quote": [
      {
        name: "QUOTE-OLD", customer_quote_id: "quote_old", roof_job: "JOB-A", quote_version: 1,
        status: "Approved", quote_total: 12_000, currency: "CAD", modified: "2026-07-09T10:00:00.000Z",
      },
      {
        name: "QUOTE-CURRENT", customer_quote_id: "quote_current", roof_job: "JOB-A", quote_version: 2,
        status: "Approved", quote_total: 14_750, currency: "CAD", modified: MODIFIED,
      },
    ],
    "Proposal Evidence Pack": [
      {
        name: "PACK-OLD", pack_id: "pack_old", roof_job: "JOB-A", quotation: "QUOTE-OLD", status: "Approved",
        approved_at: "2026-07-09T10:30:00.000Z", modified: "2026-07-09T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-PUBLISHED", pack_id: "pack_current_published", roof_job: "JOB-A", quotation: "QUOTE-CURRENT", status: "Approved",
        approved_at: "2026-07-10T10:30:00.000Z", modified: "2026-07-10T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-DRAFT", pack_id: "pack_current_draft", roof_job: "JOB-A", quotation: "QUOTE-CURRENT", status: "Draft",
        prepared_at: MODIFIED, modified: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildSalesReadModel(env(), auth("ops", "ops@example.com"));
    const lead = model.leads[0];
    assert.equal(lead?.quote?.id, "quote_current");
    assert.deepEqual(lead?.proposal, {
      id: "pack_current_draft",
      status: "Draft",
      prepared_at: MODIFIED,
      approved_at: null,
      signed_at: null,
      has_published_pack: true,
      published_status: "Approved",
    });
  } finally {
    mock.restore();
  }
});

test("Sales Desk makes proposal publication inconclusive when its bounded source is partial", async () => {
  const proposalRows = Array.from({ length: 100 }, (_, index) => ({
    name: `PACK-${String(index).padStart(3, "0")}`,
    pack_id: `pack_${index}`,
    roof_job: "JOB-A",
    quotation: "QUOTE-A",
    status: index === 1 ? "Approved" : "Draft",
    prepared_at: index === 0 ? MODIFIED : null,
    approved_at: index === 1 ? "2026-07-10T10:59:59.000Z" : null,
    signed_at: null,
    modified: new Date(Date.parse(MODIFIED) - index * 1_000).toISOString(),
  }));
  const mock = installFrappeMock({ "Proposal Evidence Pack": proposalRows });
  try {
    const model = await buildSalesReadModel(env(), auth("ops", "ops@example.com"));
    const lead = model.leads[0];
    assert.equal(model.partial_sources.includes("proposal_evidence_packs"), true);
    assert.deepEqual(lead?.proposal, {
      id: "pack_0",
      status: "Draft",
      prepared_at: MODIFIED,
      approved_at: null,
      signed_at: null,
      has_published_pack: null,
      published_status: null,
    });
  } finally {
    mock.restore();
  }
});

test("MCTB status distinguishes provider acceptance from delivery and never guesses without timing proof", () => {
  const receivedAt = "2026-07-10T10:00:00.000Z";
  const onTime = mctbStatus(receivedAt, [{
    receipt_id: "ack_1", envelope_id: "lead_a", channel: "email", outcome: "provider_accepted",
    observed_at: "2026-07-10T10:00:59.999Z", provider_message_id: "gmail-1", error_code: null,
    created_at: "2026-07-10T10:00:59.999Z",
  }], new Date("2026-07-10T10:03:00.000Z"));
  assert.equal(onTime.state, "provider_accepted_within_sla");
  assert.equal(onTime.proof_kind, "provider_receipt");

  const late = mctbStatus(receivedAt, [{
    receipt_id: "ack_2", envelope_id: "lead_a", channel: "email", outcome: "provider_accepted",
    observed_at: "2026-07-10T10:01:00.001Z", provider_message_id: "gmail-2", error_code: null,
    created_at: "2026-07-10T10:01:00.001Z",
  }], new Date("2026-07-10T10:03:00.000Z"));
  assert.equal(late.state, "provider_accepted_late");

  assert.equal(
    mctbStatus(receivedAt, [], new Date("2026-07-10T10:01:00.000Z")).state,
    "awaiting_proof",
  );
  assert.equal(
    mctbStatus(receivedAt, [], new Date("2026-07-10T10:01:00.001Z")).state,
    "unproven_after_sla",
  );
});

test("owner Now HTTP route does not expose the office queue to field sessions", async () => {
  const mock = installFrappeMock();
  try {
    const request = new Request("https://app.example.com/api/v1/owner/now");
    const office = await handleAuthenticatedRoute(request, env(), auth("ops", "ops@example.com"));
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal((await office.json() as { summary: { field_blockers: number } }).summary.field_blockers, 1);

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(request, env(), auth("field", "crew@example.com"));
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "forbidden" });
    assert.equal(mock.requests.length, callsBeforeDenied);
  } finally {
    mock.restore();
  }
});

test("production runway HTTP route is private and starts no upstream read for field sessions", async () => {
  const mock = installFrappeMock();
  try {
    const request = new Request("https://app.example.com/api/v1/production");
    const office = await handleAuthenticatedRoute(request, env(), auth("ops", "ops@example.com"));
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal((await office.json() as { summary: { active_jobs: number } }).summary.active_jobs, 3);

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(request, env(), auth("field", "crew@example.com"));
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "office_role_required" });
    assert.equal(mock.requests.length, callsBeforeDenied);
  } finally {
    mock.restore();
  }
});

test("Sales Desk HTTP route is private and never starts office reads for field sessions", async () => {
  const mock = installFrappeMock();
  try {
    const request = new Request("https://app.example.com/api/v1/sales");
    const office = await handleAuthenticatedRoute(request, env(), auth("ops", "ops@example.com"));
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal((await office.json() as { leads: Array<{ id: string }> }).leads[0]?.id, "LEAD-A");

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(request, env(), auth("field", "crew@example.com"));
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "office_role_required" });
    assert.equal(mock.requests.length, callsBeforeDenied);
  } finally {
    mock.restore();
  }
});

test("field packet contains job-safe contact details and excludes email, financials and internal notes", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildJobReadModel(env(), auth("field", "crew@example.com"), "JOB-A");
    assert.ok(model);
    assert.deepEqual(model.packet.contact, {
      display_name: "Customer 1",
      phone: "+14035550000",
      access_instructions: null,
    });
    assert.equal(model.gates[0]?.owner, null);
    assert.equal(Object.hasOwn(model.packet.change_orders[0] ?? {}, "total_amount"), false);
    assert.equal(Object.hasOwn(model.packet.change_orders[0] ?? {}, "currency"), false);
    assert.ok(model.stale_fields.includes("packet.contact.access_instructions"));
    const serialized = JSON.stringify(model);
    for (const secret of [
      "office-owner@example.com", "customer0@private.example", "financial-secret",
      "internal customer note", "internal pricing assumption", "internal exclusion",
      "internal access secret", "internal hazard secret",
    ]) assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  } finally {
    mock.restore();
  }
});

test("proof pages deterministically traverse 1,051 immutable items in bounded pages", async () => {
  const mock = installFrappeMock();
  try {
    const seen: string[] = [];
    let cursor: string | null = "0";
    while (cursor !== null) {
      const page = await buildJobProofReadModel(env(), auth("field", "crew@example.com"), "JOB-A", cursor);
      assert.ok(page);
      assert.ok(page.items.length <= 100);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    }
    assert.equal(seen.length, 1_051);
    assert.equal(new Set(seen).size, 1_051);
    assert.equal(seen[0], "evidence_1050");
    assert.equal(seen.at(-1), "evidence_0000");
    const evidenceRequests = mock.requests.filter((request) => request.doctype === "Evidence Item");
    assert.equal(evidenceRequests.every((request) => request.limit === 100), true);
    assert.deepEqual(evidenceRequests.map((request) => request.offset), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  } finally {
    mock.restore();
  }
});

test("Frappe read allowlist never requests sensitive contact or commercial fields", () => {
  assert.deepEqual(FRAPPE_READ_FIELDS["Roofing Customer"], ["name", "display_name", "phone", "modified"]);
  assert.equal(FRAPPE_READ_FIELDS["Change Order"].includes("notes" as never), false);
  assert.equal(FRAPPE_READ_FIELDS["Roof Job"].includes("qb_invoice_ref" as never), false);
  for (const privateTriageField of ["triaged_by", "triaged_at", "triage_summary"]) {
    assert.equal(FRAPPE_READ_FIELDS["Lead Envelope"].includes(privateTriageField as never), false);
  }
  for (const rawField of ["payload_json", "raw_key", "tax_policy_snapshot_json", "source_reference", "notes"]) {
    assert.equal(OFFICE_SALES_READ_FIELDS["Lead Envelope"].includes(rawField as never), false);
    assert.equal(OFFICE_SALES_READ_FIELDS["Customer Quote"].includes(rawField as never), false);
    assert.equal(OFFICE_SALES_READ_FIELDS["Communication Consent"].includes(rawField as never), false);
  }
});
