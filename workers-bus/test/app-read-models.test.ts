import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildTodayReadModel,
  mctbStatus,
} from "../src/app-read-models.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { FRAPPE_READ_FIELDS } from "../src/frappe-read.ts";
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

function installFrappeMock() {
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
    const source = rowsFor(doctype);
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
    contact_name: "Pat Prospect", job_ref: null, modified: MODIFIED,
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
});
