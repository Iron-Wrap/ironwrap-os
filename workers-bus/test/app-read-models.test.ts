import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
  buildUniversalWorkPackageReadModel,
  mctbStatus,
} from "../src/app-read-models.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  FRAPPE_READ_FIELDS,
  OFFICE_PRODUCTION_READ_FIELDS,
  OFFICE_SALES_READ_FIELDS,
} from "../src/frappe-read.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const MODIFIED = "2026-07-10T11:00:00.000Z";

const jobs = [
  job("JOB-A", "IW-1001", "PROP-A", "CUSTOMER-A"),
  job("JOB-B", "IW-1002", "PROP-B", "CUSTOMER-B"),
  job("JOB-C", "IW-1003", "PROP-C", "CUSTOMER-C"),
];

const assignments = [
  {
    name: "ASSIGN-A",
    assignment_id: "assignment_a",
    roof_job: "JOB-A",
    assignment_type: "Production",
    status: "In Progress",
    assigned_user: "crew@example.com",
    crew_profile: null,
    scheduled_start: "2026-07-10T08:00:00.000Z",
    scheduled_end: "2026-07-10T16:00:00.000Z",
    blocker_reason: null,
    modified: MODIFIED,
  },
  {
    name: "ASSIGN-B",
    assignment_id: "assignment_b",
    roof_job: "JOB-B",
    assignment_type: "Quality",
    status: "Assigned",
    assigned_user: null,
    crew_profile: "CREW-1",
    scheduled_start: "2026-07-11T08:00:00.000Z",
    scheduled_end: null,
    blocker_reason: null,
    modified: MODIFIED,
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
  captured_at: new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
  ).toISOString(),
  customer_safe: 0,
  summary: `Photo ${index}`,
  sync_state: "Verified",
  modified: new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
  ).toISOString(),
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
    permissions: permissionsForRole(role),
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
                  return {
                    results: ids
                      .map((id) =>
                        id === "lead_a"
                          ? {
                              envelope_id: "lead_a",
                              received_at: "2026-07-10T10:00:00.000Z",
                              bus_status: "pushed",
                            }
                          : null,
                      )
                      .filter(Boolean),
                  };
                }
                if (sql.includes("FROM lead_ack_receipts")) {
                  return {
                    results: ids
                      .map((id) =>
                        id === "lead_a"
                          ? {
                              receipt_id: "ack_1",
                              envelope_id: "lead_a",
                              channel: "email",
                              outcome: "provider_accepted",
                              observed_at: "2026-07-10T10:00:30.000Z",
                              provider_message_id: "gmail-1",
                              error_code: null,
                              created_at: "2026-07-10T10:00:30.000Z",
                            }
                          : null,
                      )
                      .filter(Boolean),
                  };
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

function envWithProductionScheduleBroker(): AppEnv {
  return {
    ...env(),
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "http://127.0.0.1:8790",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: "production-schedule-test-key",
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET:
      "production-schedule-shared-secret-for-test-0001",
    APP_PRODUCTION_SCHEDULE_APPROVER_ID: "owner@example.com",
    APP_PRODUCTION_SCHEDULE_MAX_SESSION_AGE_SECONDS: "900",
    APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS: "5000",
    APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS: "45",
  } as AppEnv;
}

function installFrappeMock(
  sourceOverrides: Record<string, Array<Record<string, unknown>>> = {},
) {
  const original = globalThis.fetch;
  const requests: Array<{
    doctype: string;
    documentName: string | null;
    fields: string[];
    filters: unknown[];
    offset: number;
    limit: number;
  }> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const parts = url.pathname.split("/");
    const resourceIndex = parts.lastIndexOf("resource");
    const doctype = decodeURIComponent(parts[resourceIndex + 1] ?? "");
    const documentName = parts[resourceIndex + 2]
      ? decodeURIComponent(parts[resourceIndex + 2]!)
      : null;
    const fields = JSON.parse(
      url.searchParams.get("fields") ?? "[]",
    ) as string[];
    const filters = JSON.parse(
      url.searchParams.get("filters") ?? "[]",
    ) as unknown[];
    const offset = Number(url.searchParams.get("limit_start") ?? "0");
    const limit = Number(url.searchParams.get("limit_page_length") ?? "50");
    requests.push({ doctype, documentName, fields, filters, offset, limit });
    const source = sourceOverrides[doctype] ?? rowsFor(doctype);
    if (documentName) {
      const document = source.find((row) => row.name === documentName);
      return document
        ? Response.json({ data: document })
        : new Response(null, { status: 404 });
    }
    const filtered = source.filter((row) =>
      filters.every((filter) => matchFilter(row, filter)),
    );
    const ordered = [...filtered].sort((left, right) => {
      const modified = String(right.modified ?? "").localeCompare(
        String(left.modified ?? ""),
      );
      return (
        modified ||
        String(right.name ?? "").localeCompare(String(left.name ?? ""))
      );
    });
    return Response.json({ data: ordered.slice(offset, offset + limit) });
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function rowsFor(doctype: string): Array<Record<string, unknown>> {
  if (doctype === "Roof Job") return jobs;
  if (doctype === "Job Assignment") return assignments;
  if (doctype === "Crew Member")
    return [
      {
        name: "CREW-MEMBER-1",
        parent: "CREW-1",
        parenttype: "Crew Profile",
        parentfield: "members",
        crew_user: "crew@example.com",
        crew_role: "Installer",
        active: 1,
        joined_on: "2026-01-01",
        left_on: null,
        certification_summary: "private",
        notes: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Crew Profile")
    return [
      {
        name: "CREW-1",
        crew_profile_id: "crew-1",
        crew_name: "Northside Metal",
        status: "Active",
        primary_lead: "private@example.com",
        notes: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Roofing Property")
    return jobs.map((row, index) => ({
      name: row.roofing_property,
      address_line1: `${index + 10} Test Ave`,
      city: "Calgary",
      province: "AB",
      postal_code: "T1T 1T1",
      country: "Canada",
      roof_notes: "internal access secret",
      hazard_notes: "internal hazard secret",
      modified: MODIFIED,
    }));
  if (doctype === "Roofing Customer")
    return jobs.map((row, index) => ({
      name: row.customer,
      display_name: `Customer ${index + 1}`,
      phone: `+1403555000${index}`,
      email: `customer${index}@private.example`,
      notes: "internal customer note",
      modified: MODIFIED,
    }));
  if (doctype === "Production Gate State")
    return [
      {
        name: "GATE-A",
        gate_id: "gate_a",
        roof_job: "JOB-A",
        gate: "Materials",
        state: "Blocked",
        owner_user: "office-owner@example.com",
        due_at: "2026-07-11 12:00:00",
        blocker_reason: "Delivery not confirmed",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Evidence Item") return proofRows;
  if (doctype === "Field Check-in")
    return [
      {
        name: "CHECKIN-BLOCKED",
        checkin_id: "checkin_blocked",
        roof_job: "JOB-A",
        status: "Received",
        sync_state: "Verified",
        blocker_flag: 1,
        blocker_category: "Weather",
        blocker_summary: "Wind exceeds the site plan limit.",
        submitted_at: "2026-07-10 10:05:00",
        modified: MODIFIED,
      },
      {
        name: "CHECKIN-RESOLVED",
        checkin_id: "checkin_resolved",
        roof_job: "JOB-B",
        status: "Resolved",
        sync_state: "Verified",
        blocker_flag: 1,
        blocker_category: "Materials",
        blocker_summary: "Historical shortage already resolved.",
        submitted_at: "2026-07-09 10:05:00",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Scope Clause")
    return [
      {
        name: "SCOPE-A",
        scope_clause_id: "scope_a",
        roof_job: "JOB-A",
        clause_type: "Included",
        title: "Approved roof scope",
        clause_text: "Install approved system",
        version: "1",
        status: "Approved",
        customer_visible: 1,
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Measurement Report")
    return [
      {
        name: "MEASURE-A",
        measurement_id: "measure_a",
        roof_job: "JOB-A",
        provider: "RoofRuler",
        review_status: "Approved",
        parsed_at: MODIFIED,
        report_url: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Material Takeoff")
    return [
      {
        name: "TAKEOFF-A",
        takeoff_id: "takeoff_a",
        roof_job: "JOB-A",
        status: "Approved",
        prepared_at: MODIFIED,
        assumptions: "internal pricing assumption",
        exclusions: "internal exclusion",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Supplier Order")
    return [
      {
        name: "ORDER-A",
        supplier_order_id: "order_a",
        roof_job: "JOB-A",
        status: "Ordered",
        requested_delivery_date: "2026-07-12",
        delivery_notes: "Deliver to rear",
        order_summary_json: "financial",
        modified: MODIFIED,
      },
      {
        name: "ORDER-SHORT",
        supplier_order_id: "order_short",
        roof_job: "JOB-B",
        status: "Shortage",
        requested_delivery_date: "2026-07-11",
        delivery_notes: "Starter stock is short",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Automation Incident")
    return [
      {
        name: "INCIDENT-A",
        incident_id: "incident_a",
        status: "Open",
        severity: "High",
        category: "Frappe delivery",
        summary: "Frappe mirror needs review",
        roof_job: "JOB-A",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Payment Milestone")
    return [
      {
        name: "PAYMENT-A",
        payment_milestone_id: "payment_a",
        roof_job: "JOB-A",
        milestone_type: "Deposit",
        status: "Needs Review",
        due_date: "2026-07-11",
        notes: "Deposit receipt needs review",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Lead Envelope")
    return [
      {
        name: "LEAD-A",
        envelope_id: "lead_a",
        status: "received",
        source: "website",
        event_ts: "2026-07-10T10:00:00.000Z",
        intent_queue: "Estimator",
        triage_status: "Untriaged",
        triage_summary:
          "Hail repair inquiry, confirm site details before a final scope.",
        contact_name: "Pat Prospect",
        contact_phone: "+14035559999",
        contact_email: "pat@example.com",
        job_ref: "JOB-A",
        payload_json: "raw-intake-secret",
        raw_key: "r2-private-key",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Instant Estimate Session")
    return [
      {
        name: "ESTIMATE-A",
        estimate_session_id: "estimate_a",
        lead_envelope: "LEAD-A",
        roof_job: "JOB-A",
        source: "website",
        service_type: "Roofing",
        status: "Needs Review",
        range_low: 12_400,
        range_high: 15_900,
        estimate_total: null,
        confidence: "Preliminary",
        review_required: 1,
        reviewed_at: null,
        approved_at: null,
        assumptions:
          "Visible slope and access assumptions require verification.",
        exclusions: "Not a final quote or contract.",
        payload_json: "private-estimate-json",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Customer Quote")
    return [
      {
        name: "QUOTE-A",
        customer_quote_id: "quote_a",
        roof_job: "JOB-A",
        quote_version: 2,
        status: "Needs Review",
        quote_total: 14_750,
        currency: "CAD",
        valid_until: "2026-07-20",
        payment_status: "Not Due",
        prepared_at: MODIFIED,
        approved_at: null,
        accepted_at: null,
        scope_summary: "Replace affected roof system.",
        tax_policy_snapshot_json: "private-tax-policy",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Proposal Evidence Pack")
    return [
      {
        name: "PROPOSAL-A",
        pack_id: "pack_a",
        roof_job: "JOB-A",
        quotation: "QUOTE-A",
        status: "Draft",
        prepared_at: MODIFIED,
        approved_at: null,
        signed_at: null,
        evidence_summary_json: "private-proposal-summary",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Communication Consent")
    return [
      {
        name: "CONSENT-A",
        consent_id: "consent_a",
        customer: "CUSTOMER-A",
        lead_envelope: "LEAD-A",
        roof_job: "JOB-A",
        channel: "Email",
        purpose: "Estimate Follow-up",
        status: "Granted",
        jurisdiction: "AB",
        consent_basis: "Express",
        captured_at: MODIFIED,
        effective_from: MODIFIED,
        expires_at: null,
        revoked_at: null,
        supersedes: null,
        source_reference: "private-form-reference",
        notes: "private-consent-note",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Change Order")
    return [
      {
        name: "CHANGE-A",
        change_order_id: "change_a",
        roof_job: "JOB-A",
        change_number: "CO-1",
        version: 1,
        status: "Accepted",
        title: "Deck repair",
        scope_delta: "Replace damaged deck",
        currency: "CAD",
        total_amount: 50_000,
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Safety Plan")
    return [
      {
        name: "SAFETY-A",
        safety_plan_id: "safety_a",
        roof_job: "JOB-A",
        version: 1,
        status: "Ready",
        effective_date: "2026-07-10",
        hazard_summary: "Steep slope",
        controls: "Tie off",
        emergency_plan: "Call 911",
        ppe_requirements: "Harness",
        weather_limits: "Stop in lightning",
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Work Package")
    return [
      {
        name: "WORK-PACKAGE-A",
        work_package_id: "work_package_a",
        roof_job: "JOB-A",
        job_assignment: "ASSIGN-A",
        version: 1,
        status: "Released",
        title: "South roof replacement",
        objective: "Install the released metal system.",
        boundaries: "South roof only.",
        prerequisites: "Verify tie-off and material staging.",
        expected_result: "Released roof section complete.",
        stop_conditions: "Stop for unsafe weather or missing controls.",
        make_safe_procedure: "Secure the work area and notify the supervisor.",
        issued_at: "2026-07-10T07:00:00.000Z",
        expires_at: "2026-07-11T07:00:00.000Z",
        released_at: "2026-07-10T07:05:00.000Z",
        release_attempt_id: null,
        supersedes: null,
        correction_reason: null,
        acknowledged_by: null,
        acknowledged_at: null,
        assigned_workers: [
          {
            sequence: 1,
            worker_user: "crew@example.com",
            worker_role: "Installer",
            required: 1,
          },
        ],
        steps: [
          {
            sequence: 1,
            instruction: "Verify the roof zone.",
            required_evidence: "Zone photo",
            acceptance_criteria: "Zone matches package.",
          },
        ],
        hold_points: [
          {
            sequence: 1,
            hold_point: "Deck condition",
            release_authority: "Supervisor",
            required_evidence: "Deck photo",
            acceptance_criteria: "Supervisor release.",
          },
        ],
        released_by: "private-release@example.com",
        blocker_reason: "private blocker",
        raw_key: "r2/private",
        modified: MODIFIED,
      },
    ];
  return [];
}

function matchFilter(row: Record<string, unknown>, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const [, field, operator, expected] = raw;
  const actual = row[String(field)];
  if (operator === "=") return String(actual ?? "") === String(expected ?? "");
  if (operator === "in" && Array.isArray(expected))
    return expected.map(String).includes(String(actual ?? ""));
  return false;
}

test("field Today uses direct and active crew membership assignments, never generic _assign", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildTodayReadModel(
      env(),
      auth("field", "crew@example.com"),
    );
    assert.deepEqual(
      model.jobs.map((item) => item.id),
      ["JOB-A", "JOB-B"],
    );
    assert.equal(model.jobs[0]?.assignment?.id, "ASSIGN-A");
    assert.equal(model.jobs[1]?.assignment?.crew_profile, "CREW-1");
    assert.equal(
      mock.requests.some((request) =>
        request.filters.some(
          (filter) => Array.isArray(filter) && filter[1] === "_assign",
        ),
      ),
      false,
    );
    assert.equal(
      FRAPPE_READ_FIELDS["Roof Job"].includes("_assign" as never),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("typed Shop Order packet is served through the universal BFF route without a Roof Job", async () => {
  const shopAssignment = {
    name: "ASSIGN-SHOP-1",
    assignment_id: "assignment_shop_1",
    roof_job: null,
    assignment_type: "Shop",
    status: "Assigned",
    assigned_user: "crew@example.com",
    crew_profile: null,
    work_object_type: "Shop Order",
    work_object_id: "SHOP-001",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
    scheduled_start: "2026-07-10T16:00:00.000Z",
    scheduled_end: null,
    blocker_reason: null,
    modified: MODIFIED,
  };
  const shopPackage = {
    ...rowsFor("Work Package")[0]!,
    name: "WORK-PACKAGE-SHOP-1",
    work_package_id: "work_package_shop_1",
    roof_job: null,
    job_assignment: "ASSIGN-SHOP-1",
    work_object_type: "Shop Order",
    work_object_id: "SHOP-001",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
    release_attempt_id: "shop-release-attempt-1",
    assigned_workers: [
      { sequence: 1, worker_user: "crew@example.com", worker_role: "Installer", required: 1 },
    ],
  };
  const mock = installFrappeMock({
    "Job Assignment": [...assignments, shopAssignment],
    "Work Package": [shopPackage],
    "Work Package Event": [],
  });
  try {
    const response = await handleAuthenticatedRoute(
      new Request(
        "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1",
      ),
      env(),
      auth("field", "crew@example.com"),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      version: number;
      source_updated_at: string;
      read_model_generated_at: string;
      stale_fields: string[];
      permissions: string[];
      work_object: Record<string, string>;
      assignment: { id: string };
      work_package: { id: string; work_object_type: string; physical_context_type: string };
      allowed_actions: string[];
    };
    assert.equal(body.version, 1);
    assert.equal(body.source_updated_at, MODIFIED);
    assert.match(body.read_model_generated_at, /^20\d\d-/);
    assert.deepEqual(body.stale_fields, []);
    assert.equal(body.permissions.includes("jobs:read:assigned"), true);
    assert.deepEqual(body.work_object, {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    });
    assert.equal(body.assignment.id, "ASSIGN-SHOP-1");
    assert.equal(body.work_package.id, "work_package_shop_1");
    assert.equal(body.work_package.work_object_type, "Shop Order");
    assert.equal(body.work_package.physical_context_type, "Shop Floor");
    assert.equal(body.allowed_actions.includes("field.checkin.create"), true);
    assert.equal(body.allowed_actions.includes("work_package.acknowledge"), true);
  } finally {
    mock.restore();
  }
});

test("typed completion capability requires the immutable assignment authority and an independent actor", async () => {
  const scope = {
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
  } as const;
  const shopAssignment = {
    name: "ASSIGN-SHOP-1",
    assignment_id: "assignment_shop_1",
    roof_job: null,
    assignment_type: "Shop",
    status: "In Progress",
    assigned_user: "crew@example.com",
    crew_profile: null,
    authority_user: "authority@example.com",
    authority_role: "IronWrap Owner",
    assigned_by: "dispatcher@example.com",
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
    scheduled_start: "2026-07-10T16:00:00.000Z",
    scheduled_end: null,
    blocker_reason: null,
    modified: MODIFIED,
  };
  const shopPackage = {
    ...rowsFor("Work Package")[0]!,
    name: "WORK-PACKAGE-SHOP-1",
    work_package_id: "work_package_shop_1",
    roof_job: null,
    job_assignment: shopAssignment.name,
    status: "In Progress",
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
    release_attempt_id: "shop-release-attempt-1",
    assigned_workers: [
      {
        sequence: 1,
        worker_user: "crew@example.com",
        worker_role: "Installer",
        required: 1,
      },
    ],
  };
  const commonEvent = {
    work_package: shopPackage.name,
    roof_job: null,
    job_assignment: shopAssignment.name,
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
    work_package_version: 1,
    release_attempt_id: shopPackage.release_attempt_id,
    modified: MODIFIED,
  };
  const acknowledgement = {
    ...commonEvent,
    name: "WORK-PACKAGE-ACK-SHOP-1",
    event_type: "Acknowledged",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: "shop-ack-device-1",
    occurred_at: "2026-07-10T07:10:00.000Z",
  };
  const holdRelease = {
    ...commonEvent,
    name: "WORK-PACKAGE-HOLD-SHOP-1",
    event_type: "Hold Point Released",
    hold_point_sequence: 1,
    evidence_item: "SHOP-HOLD-RELEASE-EVIDENCE-1",
    actor_user: "authority@example.com",
    actor_role: "IronWrap Owner",
    device_action_id: "shop-hold-device-1",
    occurred_at: "2026-07-10T07:20:00.000Z",
  };
  const capture = (sequence: number, slot: string, requirement: string) => ({
    ...commonEvent,
    name: `WORK-PACKAGE-EVIDENCE-SHOP-${sequence}`,
    event_type: "Evidence Captured",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: `shop-evidence-device-${sequence}`,
    occurred_at: `2026-07-10T07:3${sequence}:00.000Z`,
    evidence_item: `SHOP-EVIDENCE-ITEM-${sequence}`,
    evidence_slot_id: slot,
    evidence_requirement: requirement,
    evidence_source: "worker-camera",
    evidence_device_id: `paired-device-${sequence}`,
    evidence_captured_at: `2026-07-10T07:2${sequence}:00.000Z`,
    evidence_freshness: "Current",
    evidence_conflict_state: "None",
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    evidence_verification: "Verified",
    evidence_disposition: "Open",
    correction_reason: null,
  });
  const review = (captured: ReturnType<typeof capture>) => ({
    ...commonEvent,
    name: `${captured.name}-REVIEW`,
    event_type: "Evidence Reviewed",
    actor_user: "authority@example.com",
    actor_role: "IronWrap Owner",
    device_action_id: `${captured.device_action_id}-review`,
    occurred_at: captured.occurred_at.replace(":00.000Z", ":30.000Z"),
    evidence_review_of: captured.name,
    evidence_item: captured.evidence_item,
    evidence_slot_id: captured.evidence_slot_id,
    evidence_disposition: "Accepted",
    correction_reason: null,
  });
  const stepEvidence = capture(1, "step:1", "Zone photo");
  const holdEvidence = capture(2, "hold:1", "Deck photo");
  const source = {
    "Job Assignment": [shopAssignment],
    "Work Package": [shopPackage],
    "Work Package Event": [
      acknowledgement,
      holdRelease,
      stepEvidence,
      review(stepEvidence),
      holdEvidence,
      review(holdEvidence),
    ],
  };
  const mock = installFrappeMock(source);
  try {
    const authority = await buildUniversalWorkPackageReadModel(
      env(),
      auth("owner", "authority@example.com"),
      scope,
    );
    assert.equal(
      (authority?.allowed_actions as string[]).includes("work_package.complete"),
      true,
    );
    const assigningAuthority = await buildUniversalWorkPackageReadModel(
      env(),
      auth("owner", "dispatcher@example.com"),
      scope,
    );
    assert.equal(
      (assigningAuthority?.allowed_actions as string[]).includes(
        "work_package.complete",
      ),
      false,
      "assigned_by is provenance, not typed completion authority",
    );
    for (const role of ["owner", "ops", "production"] as const) {
      const unrelated = await buildUniversalWorkPackageReadModel(
        env(),
        auth(role, `${role}@example.com`),
        scope,
      );
      assert.equal(
        (unrelated?.allowed_actions as string[]).includes("work_package.complete"),
        false,
        `${role} must not inherit typed completion from role alone`,
      );
    }
  } finally {
    mock.restore();
  }

  const wrongDeclaredRole = installFrappeMock({
    ...source,
    "Job Assignment": [
      { ...shopAssignment, authority_role: "IronWrap Production" },
    ],
  });
  try {
    const model = await buildUniversalWorkPackageReadModel(
      env(),
      auth("owner", "authority@example.com"),
      scope,
    );
    assert.equal(
      (model?.allowed_actions as string[]).includes("work_package.complete"),
      false,
      "the declared authority role must match the exact app authority role",
    );
  } finally {
    wrongDeclaredRole.restore();
  }

  const workerAuthority = installFrappeMock({
    ...source,
    "Job Assignment": [
      { ...shopAssignment, authority_user: "crew@example.com" },
    ],
  });
  try {
    const model = await buildUniversalWorkPackageReadModel(
      env(),
      auth("owner", "crew@example.com"),
      scope,
    );
    assert.equal(
      (model?.allowed_actions as string[]).includes("work_package.complete"),
      false,
      "the immutable authority must still be independent of the frozen worker roster",
    );
  } finally {
    workerAuthority.restore();
  }
});

test("field bootstrap keeps an upstream failure private", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("frappe unavailable");
  };
  try {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/field/bootstrap"),
      env(),
      auth("field", "crew@example.com"),
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
  } finally {
    globalThis.fetch = original;
  }
});

test("Today bootstrap admits an office role through the same today:read capability", async () => {
  const mock = installFrappeMock();
  try {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/field/bootstrap"),
      env(),
      auth("ops", "ops@example.com"),
    );
    const body = (await response.json()) as {
      session: { user: { role: string } };
      today: { jobs: Array<{ id: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(body.session.user.role, "ops");
    assert.deepEqual(
      new Set(body.today.jobs.map(({ id }) => id)),
      new Set(["JOB-A", "JOB-B", "JOB-C"]),
    );
  } finally {
    mock.restore();
  }
});

test("field is denied an unassigned job while office reads it and Today does not hide it", async () => {
  const mock = installFrappeMock();
  try {
    assert.equal(
      await buildJobReadModel(
        env(),
        auth("field", "crew@example.com"),
        "JOB-C",
      ),
      null,
    );
    const officeJob = await buildJobReadModel(
      env(),
      auth("ops", "ops@example.com"),
      "JOB-C",
    );
    assert.equal(officeJob?.job.id, "JOB-C");
    assert.equal(officeJob?.assignment, null);
    const officeToday = await buildTodayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(
      new Set(officeToday.jobs.map((item) => item.id)),
      new Set(["JOB-A", "JOB-B", "JOB-C"]),
    );
    assert.equal(
      officeToday.jobs.find((item) => item.id === "JOB-C")?.next_action,
      "Assign field work",
    );
  } finally {
    mock.restore();
  }
});

test("owner Now is an office-only, exception-first roofing read model", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildOwnerNowReadModel(
      env(),
      auth("owner", "owner@example.com"),
    );
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
      economics_needs_review: 3,
    });
    assert.deepEqual(
      model.economics.map((projection) => projection.job_id),
      ["JOB-A", "JOB-B", "JOB-C"],
    );
    assert.ok(
      model.economics.every(
        (projection) => projection.metrics.actual_profit.amount_cents === null,
      ),
    );
    assert.deepEqual(
      model.exceptions.map((exception) => exception.kind),
      [
        "field_blocker",
        "blocked_gate",
        "automation_incident",
        "material_exception",
        "finance_exception",
        "untriaged_lead",
      ],
    );
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
      "job.read",
      "lead.read",
      "lead_triage.read",
      "field_blocker.read",
      "incident.read",
      "finance_exception.read",
      "material_exception.read",
    ]);
    const blockerRequest = mock.requests.find(
      (request) => request.doctype === "Field Check-in",
    );
    assert.deepEqual(blockerRequest?.filters, [
      ["Field Check-in", "blocker_flag", "=", 1],
      ["Field Check-in", "status", "in", ["Received", "Needs Review"]],
      ["Field Check-in", "sync_state", "=", "Verified"],
    ]);
    await assert.rejects(
      async () =>
        await buildOwnerNowReadModel(env(), auth("field", "crew@example.com")),
      /owner_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("owner Now projects per-job economics without combining tenant or tax-inclusive facts", async () => {
  const mock = installFrappeMock({
    "Customer Quote": [
      {
        name: "QUOTE-A",
        roof_job: "JOB-A",
        quote_version: 1,
        status: "Accepted",
        subtotal: "1000.00",
        tax_amount: "50.00",
        quote_total: "1050.00",
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
    "Supplier Quote": [
      {
        name: "SQ-A",
        roof_job: "JOB-A",
        status: "Approved",
        quote_total: "400.00",
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
    "Supplier Order": [
      {
        name: "SO-A",
        roof_job: "JOB-A",
        source_quote: "SQ-A",
        status: "Ordered",
        modified: MODIFIED,
      },
    ],
    "Material Lot": [
      {
        name: "LOT-A",
        roof_job: "JOB-A",
        status: "Available",
        modified: MODIFIED,
      },
    ],
    "Payment Milestone": [
      {
        name: "PAY-A",
        roof_job: "JOB-A",
        milestone_type: "Payment",
        status: "Matched",
        total_amount: "250.00",
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
    "Job Cost Event": [
      {
        name: "COST-A",
        tenant: "ironwrap",
        roof_job: "JOB-A",
        event_kind: "cost",
        category: "Material",
        quantity: 1,
        unit: "lot",
        amount_cents: 35_000,
        amount_basis: "Net of Recoverable Tax",
        currency: "CAD",
        source_doctype: "Material Lot",
        source_name: "LOT-A",
        source_digest: "a".repeat(64),
        source_evidence: "EVID-A",
        accounting_state: "Operational",
        modified: MODIFIED,
      },
      {
        name: "COST-OTHER-TENANT",
        tenant: "other",
        roof_job: "JOB-A",
        event_kind: "cost",
        amount_cents: 99_999,
        amount_basis: "Net of Recoverable Tax",
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildOwnerNowReadModel(
      env(),
      auth("owner", "owner@example.com"),
    );
    const job = model.economics.find(
      (projection) => projection.job_id === "JOB-A",
    );
    assert.ok(job);
    assert.equal(job.metrics.forecast_revenue.known_cents, 100_000);
    assert.equal(job.metrics.committed_cost.known_cents, 40_000);
    assert.equal(job.metrics.accrued_actual_cost.known_cents, 35_000);
    assert.equal(job.metrics.cash_collected.known_cents, 25_000);
    assert.equal(job.metrics.actual_profit.amount_cents, null);
    const costRequest = mock.requests.find(
      (request) => request.doctype === "Job Cost Event",
    );
    assert.deepEqual(costRequest?.filters, [
      ["Job Cost Event", "tenant", "=", "ironwrap"],
      ["Job Cost Event", "roof_job", "in", ["JOB-A", "JOB-B", "JOB-C"]],
    ]);
  } finally {
    mock.restore();
  }
});

test("production runway is an office-only, bounded read that never treats a gate summary as dispatch authority", async () => {
  const readyGates = ["JOB-B", "JOB-C"].flatMap((roofJob) =>
    ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map(
      (gate) => ({
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
      }),
    ),
  );
  const mock = installFrappeMock({
    "Job Assignment": [
      assignments[0]!,
      { ...assignments[1]!, scheduled_start: null, scheduled_end: null },
      {
        name: "ASSIGN-C",
        assignment_id: "assignment_c",
        roof_job: "JOB-C",
        assignment_type: "Production",
        status: "Assigned",
        assigned_user: null,
        crew_profile: "CREW-1",
        scheduled_start: null,
        scheduled_end: null,
        blocker_reason: null,
        modified: MODIFIED,
      },
    ],
    "Production Gate State": [
      {
        name: "GATE-A",
        gate_id: "gate_a",
        roof_job: "JOB-A",
        gate: "Materials",
        state: "Blocked",
        owner_user: "office-owner@example.com",
        due_at: "2026-07-11 12:00:00",
        blocker_reason: "Delivery not confirmed",
        modified: MODIFIED,
      },
      ...readyGates,
      {
        name: "GATE-C-COMPLETION",
        gate_id: "gate_job_c_completion",
        roof_job: "JOB-C",
        gate: "Completion",
        state: "Blocked",
        owner_user: "office-owner@example.com",
        due_at: null,
        blocker_reason: "Awaiting closeout",
        modified: MODIFIED,
      },
    ],
    "Supplier Order": [
      {
        name: "ORDER-A",
        supplier_order_id: "order_a",
        roof_job: "JOB-A",
        status: "Ordered",
        requested_delivery_date: "2026-07-12",
        delivery_notes: "Deliver to rear",
        order_summary_json: "financial",
        modified: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildProductionRunwayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(model.summary, {
      active_jobs: 3,
      blocked: 1,
      scheduled: 0,
      needs_assignment: 1,
      ready_for_review: 1,
      needs_verification: 0,
    });
    assert.equal(model.jobs.find((job) => job.id === "JOB-A")?.lane, "blocked");
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.lane,
      "needs_assignment",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.assignment,
      null,
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.lane,
      "ready_for_review",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.gate_coverage,
      "complete",
    );
    assert.deepEqual(
      model.jobs.find((job) => job.id === "JOB-C")?.gate_summary,
      {
        expected: 6,
        blocked: 0,
        ready: 6,
        waived: 0,
        done: 0,
      },
    );
    assert.deepEqual(
      model.jobs.find((job) => job.id === "JOB-C")?.scheduling_gates,
      [
        { name: "Deposit", state: "Ready" },
        { name: "Materials", state: "Ready" },
        { name: "Safety", state: "Ready" },
        { name: "Access", state: "Ready" },
        { name: "Weather", state: "Ready" },
        { name: "Crew", state: "Ready" },
      ],
    );
    assert.deepEqual(model.allowed_actions, ["job.read", "production.read"]);
    assert.equal(
      model.jobs
        .find((job) => job.id === "JOB-C")
        ?.next_action.includes("does not dispatch"),
      true,
    );
    const serialized = JSON.stringify(model);
    for (const secret of [
      "financial-secret",
      "customer0@private.example",
      "Deliver to rear",
      "office-owner@example.com",
    ]) {
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }
    const jobRequest = mock.requests.find(
      (request) => request.doctype === "Roof Job",
    );
    assert.deepEqual(
      jobRequest?.fields,
      OFFICE_PRODUCTION_READ_FIELDS["Roof Job"],
    );
    const assignmentRequest = mock.requests.find(
      (request) => request.doctype === "Job Assignment",
    );
    assert.deepEqual(
      assignmentRequest?.fields,
      OFFICE_PRODUCTION_READ_FIELDS["Job Assignment"],
    );
    assert.deepEqual(assignmentRequest?.filters, [
      [
        "Job Assignment",
        "status",
        "in",
        ["Assigned", "Accepted", "In Progress", "Blocked"],
      ],
      ["Job Assignment", "assignment_type", "=", "Production"],
    ]);
    const gateRequest = mock.requests.find(
      (request) => request.doctype === "Production Gate State",
    );
    assert.deepEqual(
      gateRequest?.fields,
      OFFICE_PRODUCTION_READ_FIELDS["Production Gate State"],
    );
    assert.deepEqual(gateRequest?.filters, [
      ["Production Gate State", "roof_job", "in", ["JOB-C", "JOB-B", "JOB-A"]],
    ]);
    const materialRequest = mock.requests.find(
      (request) => request.doctype === "Supplier Order",
    );
    assert.deepEqual(
      materialRequest?.fields,
      OFFICE_PRODUCTION_READ_FIELDS["Supplier Order"],
    );
    assert.deepEqual(materialRequest?.filters, [
      ["Supplier Order", "roof_job", "in", ["JOB-C", "JOB-B", "JOB-A"]],
      ["Supplier Order", "status", "in", ["Needs Review", "Shortage"]],
    ]);
    const productionRole = await buildProductionRunwayReadModel(
      env(),
      auth("production", "production@example.com"),
    );
    assert.equal(productionRole.summary.active_jobs, 3);
    assert.equal(
      productionRole.allowed_actions.includes(
        "production_schedule_approval.prepare",
      ),
      false,
    );
    await assert.rejects(
      async () =>
        await buildProductionRunwayReadModel(
          env(),
          auth("field", "crew@example.com"),
        ),
      /production_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("production runway grants schedule preparation only to the configured owner with active bounded crews", async () => {
  const readyGates = ["JOB-B", "JOB-C"].flatMap((roofJob) =>
    ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map(
      (gate) => ({
        name: `GATE-${roofJob}-${gate}`,
        roof_job: roofJob,
        gate,
        state: "Ready",
        modified: MODIFIED,
      }),
    ),
  );
  const mock = installFrappeMock({
    "Job Assignment": [
      {
        name: "ASSIGN-C",
        roof_job: "JOB-C",
        assignment_type: "Production",
        status: "Assigned",
        scheduled_start: "2026-07-18T08:00:00.000Z",
        scheduled_end: null,
        modified: MODIFIED,
      },
    ],
    "Production Gate State": readyGates,
    "Supplier Order": [],
  });
  try {
    const ownerModel = await buildProductionRunwayReadModel(
      envWithProductionScheduleBroker(),
      auth("owner", "owner@example.com"),
    );
    assert.deepEqual(ownerModel.crews, [
      { id: "CREW-1", name: "Northside Metal" },
    ]);
    assert.ok(
      ownerModel.allowed_actions.includes(
        "production_schedule_approval.prepare",
      ),
    );
    assert.equal(
      ownerModel.jobs.find((job) => job.id === "JOB-B")
        ?.scheduling_preparation_allowed,
      true,
    );
    assert.equal(
      ownerModel.jobs.find((job) => job.id === "JOB-C")
        ?.scheduling_preparation_allowed,
      true,
    );
    assert.equal(
      JSON.stringify(ownerModel).includes("private@example.com"),
      false,
    );

    const opsModel = await buildProductionRunwayReadModel(
      envWithProductionScheduleBroker(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(opsModel.crews, []);
    assert.equal(
      opsModel.allowed_actions.includes("production_schedule_approval.prepare"),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("production runway does not collapse duplicate scheduling gates into a schedule-ready job", async () => {
  const readyGates = [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ].map((gate) => ({
    name: `GATE-C-${gate}`,
    roof_job: "JOB-C",
    gate,
    state: "Ready",
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({
    "Job Assignment": [
      {
        name: "ASSIGN-C",
        roof_job: "JOB-C",
        assignment_type: "Production",
        status: "Assigned",
        scheduled_start: null,
        scheduled_end: null,
        modified: MODIFIED,
      },
    ],
    "Production Gate State": [
      ...readyGates,
      {
        name: "GATE-C-MATERIALS-OLD",
        roof_job: "JOB-C",
        gate: "Materials",
        state: "Blocked",
        modified: "2026-07-10T10:00:00.000Z",
      },
    ],
  });
  try {
    const model = await buildProductionRunwayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
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
    const model = await buildProductionRunwayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.ok(model.partial_sources.includes("active_assignments"));
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.lane,
      "needs_verification",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.assignment,
      null,
    );
  } finally {
    mock.restore();
  }
});

test("production runway with a truncated material source never promotes a job to ready for review", async () => {
  const readyGates = [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ].map((gate) => ({
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
      {
        ...assignments[1]!,
        assignment_type: "Production",
        scheduled_start: null,
        scheduled_end: null,
      },
    ],
    "Production Gate State": [
      {
        name: "GATE-A",
        roof_job: "JOB-A",
        gate: "Materials",
        state: "Blocked",
        modified: MODIFIED,
      },
      ...readyGates,
    ],
    "Supplier Order": partialMaterials,
  });
  try {
    const model = await buildProductionRunwayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.ok(model.partial_sources.includes("material_exceptions"));
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.gate_coverage,
      "complete",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.lane,
      "needs_verification",
    );
  } finally {
    mock.restore();
  }
});

test("Sales Desk receives a bounded office contract without widening Owner Now or leaking raw records", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
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
        summary:
          "Hail repair inquiry, confirm site details before a final scope.",
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
        assumptions:
          "Visible slope and access assumptions require verification.",
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
        records: [
          {
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
          },
        ],
      },
      attention: [
        "triage_unresolved",
        "estimate_needs_review",
        "quote_needs_review",
      ],
    });
    const serialized = JSON.stringify(model);
    for (const secret of [
      "raw-intake-secret",
      "r2-private-key",
      "private-estimate-json",
      "private-tax-policy",
      "private-proposal-summary",
      "private-form-reference",
      "private-consent-note",
    ])
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);

    const officeLeadRequest = mock.requests.find(
      (request) =>
        request.doctype === "Lead Envelope" &&
        request.fields.includes("contact_phone"),
    );
    assert.ok(officeLeadRequest);
    assert.deepEqual(
      officeLeadRequest?.fields,
      OFFICE_SALES_READ_FIELDS["Lead Envelope"],
    );
    assert.equal(officeLeadRequest?.fields.includes("payload_json"), false);
    const legacyJobReferenceRequest = mock.requests.find(
      (request) =>
        request.doctype === "Roof Job" &&
        request.filters.some(
          (filter) =>
            Array.isArray(filter) && filter[1] === "name" && filter[2] === "in",
        ),
    );
    assert.deepEqual(legacyJobReferenceRequest?.filters, [
      ["Roof Job", "name", "in", ["JOB-A"]],
    ]);
    const proposalRequest = mock.requests.find(
      (request) => request.doctype === "Proposal Evidence Pack",
    );
    assert.deepEqual(
      proposalRequest?.fields,
      OFFICE_SALES_READ_FIELDS["Proposal Evidence Pack"],
    );
    assert.deepEqual(proposalRequest?.filters, [
      ["Proposal Evidence Pack", "quotation", "in", ["QUOTE-A"]],
    ]);

    const ownerModel = await buildOwnerNowReadModel(
      env(),
      auth("owner", "owner@example.com"),
    );
    assert.equal(ownerModel.summary.untriaged_leads, 1);
    const ownerLeadRequest = mock.requests.find(
      (request) =>
        request.doctype === "Lead Envelope" &&
        request.fields.includes("contact_phone") === false,
    );
    assert.deepEqual(
      ownerLeadRequest?.fields,
      FRAPPE_READ_FIELDS["Lead Envelope"],
    );

    await assert.rejects(
      async () =>
        await buildSalesReadModel(env(), auth("field", "crew@example.com")),
      /office_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("Sales Desk removes superseded consent from the current bounded projection", async () => {
  const shared = {
    customer: "CUSTOMER-A",
    lead_envelope: "LEAD-A",
    roof_job: "JOB-A",
    channel: "Email",
    purpose: "Estimate Follow-up",
    jurisdiction: "AB",
    consent_basis: "Express",
    captured_at: MODIFIED,
    effective_from: MODIFIED,
    expires_at: null,
    modified: MODIFIED,
  };
  const mock = installFrappeMock({
    "Communication Consent": [
      {
        ...shared,
        name: "consent_original",
        consent_id: "consent_original",
        status: "Granted",
        revoked_at: null,
        supersedes: null,
      },
      {
        ...shared,
        name: "consent_revocation",
        consent_id: "consent_revocation",
        status: "Revoked",
        revoked_at: MODIFIED,
        supersedes: "consent_original",
      },
    ],
  });
  try {
    const model = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(
      model.leads[0]?.consent.records.map(({ id, status }) => ({ id, status })),
      [{ id: "consent_revocation", status: "Revoked" }],
    );
    assert.equal(
      mock.requests
        .filter(({ doctype }) => doctype === "Communication Consent")
        .every(({ fields }) => fields.includes("supersedes")),
      true,
    );
  } finally {
    mock.restore();
  }
});

test("Sales grants the bounded triage-prepare action only for a configured broker and Frappe identity", async () => {
  const mock = installFrappeMock();
  try {
    const ready = await buildSalesReadModel(
      envWithLeadTriageBroker(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(ready.allowed_actions.includes("approval.prepare"), true);
    assert.equal(ready.leads[0]?.triage.status, "Untriaged");
    assert.equal(ready.leads[0]?.attention.includes("triage_unresolved"), true);

    const noFrappeIdentity = await buildSalesReadModel(
      envWithLeadTriageBroker(),
      auth("ops", null),
    );
    assert.equal(
      noFrappeIdentity.allowed_actions.includes("approval.prepare"),
      false,
    );

    const noBroker = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(noBroker.allowed_actions.includes("approval.prepare"), false);

    const readOnly = auth("sales", "sales@example.com");
    readOnly.permissions = readOnly.permissions.filter(
      (permission) => permission !== "approvals:prepare",
    );
    const noPermission = await buildSalesReadModel(
      envWithLeadTriageBroker(),
      readOnly,
    );
    assert.equal(
      noPermission.allowed_actions.includes("approval.prepare"),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("Sales Desk projects proposal publication only from the selected quote version", async () => {
  const mock = installFrappeMock({
    "Customer Quote": [
      {
        name: "QUOTE-OLD",
        customer_quote_id: "quote_old",
        roof_job: "JOB-A",
        quote_version: 1,
        status: "Approved",
        quote_total: 12_000,
        currency: "CAD",
        modified: "2026-07-09T10:00:00.000Z",
      },
      {
        name: "QUOTE-CURRENT",
        customer_quote_id: "quote_current",
        roof_job: "JOB-A",
        quote_version: 2,
        status: "Approved",
        quote_total: 14_750,
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
    "Proposal Evidence Pack": [
      {
        name: "PACK-OLD",
        pack_id: "pack_old",
        roof_job: "JOB-A",
        quotation: "QUOTE-OLD",
        status: "Approved",
        approved_at: "2026-07-09T10:30:00.000Z",
        modified: "2026-07-09T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-PUBLISHED",
        pack_id: "pack_current_published",
        roof_job: "JOB-A",
        quotation: "QUOTE-CURRENT",
        status: "Approved",
        approved_at: "2026-07-10T10:30:00.000Z",
        modified: "2026-07-10T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-DRAFT",
        pack_id: "pack_current_draft",
        roof_job: "JOB-A",
        quotation: "QUOTE-CURRENT",
        status: "Draft",
        prepared_at: MODIFIED,
        modified: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
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
    const model = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    const lead = model.leads[0];
    assert.equal(
      model.partial_sources.includes("proposal_evidence_packs"),
      true,
    );
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
  const onTime = mctbStatus(
    receivedAt,
    [
      {
        receipt_id: "ack_1",
        envelope_id: "lead_a",
        channel: "email",
        outcome: "provider_accepted",
        observed_at: "2026-07-10T10:00:59.999Z",
        provider_message_id: "gmail-1",
        error_code: null,
        created_at: "2026-07-10T10:00:59.999Z",
      },
    ],
    new Date("2026-07-10T10:03:00.000Z"),
  );
  assert.equal(onTime.state, "provider_accepted_within_sla");
  assert.equal(onTime.proof_kind, "provider_receipt");

  const late = mctbStatus(
    receivedAt,
    [
      {
        receipt_id: "ack_2",
        envelope_id: "lead_a",
        channel: "email",
        outcome: "provider_accepted",
        observed_at: "2026-07-10T10:01:00.001Z",
        provider_message_id: "gmail-2",
        error_code: null,
        created_at: "2026-07-10T10:01:00.001Z",
      },
    ],
    new Date("2026-07-10T10:03:00.000Z"),
  );
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
    const office = await handleAuthenticatedRoute(
      request,
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { summary: { field_blockers: number } }).summary
        .field_blockers,
      1,
    );

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(
      request,
      env(),
      auth("field", "crew@example.com"),
    );
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
    const office = await handleAuthenticatedRoute(
      request,
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { summary: { active_jobs: number } }).summary
        .active_jobs,
      3,
    );

    const productionRole = await handleAuthenticatedRoute(
      request,
      env(),
      auth("production", "production@example.com"),
    );
    assert.equal(productionRole.status, 200);
    assert.equal(
      ((await productionRole.json()) as { summary: { active_jobs: number } })
        .summary.active_jobs,
      3,
    );

    const callsBeforeNow = mock.requests.length;
    const productionNow = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/now"),
      env(),
      auth("production", "production@example.com"),
    );
    const productionNowBody = (await productionNow.json()) as {
      role: string;
      sources: Array<{ id: string }>;
    };
    assert.equal(productionNow.status, 200);
    assert.equal(productionNowBody.role, "production");
    assert.deepEqual(
      productionNowBody.sources.map(({ id }) => id),
      ["production"],
    );
    const productionNowDoctypes = mock.requests
      .slice(callsBeforeNow)
      .map(({ doctype }) => doctype);
    for (const forbidden of [
      "Lead Envelope",
      "Instant Estimate Session",
      "Customer Quote",
      "Proposal Evidence Pack",
      "Communication Consent",
      "Automation Incident",
      "Payment Milestone",
    ]) {
      assert.equal(productionNowDoctypes.includes(forbidden), false, forbidden);
    }

    const productionJob = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/jobs/JOB-A"),
      env(),
      auth("production", "production@example.com"),
    );
    assert.equal(productionJob.status, 200);
    const productionJobBody = (await productionJob.json()) as {
      allowed_actions: string[];
      packet: { work_package: unknown };
    };
    assert.deepEqual(productionJobBody.allowed_actions, ["job.read"]);
    assert.equal(productionJobBody.packet.work_package, null);

    for (const [path, error] of [
      ["/api/v1/today", "today_read_required"],
      ["/api/v1/owner/now", "forbidden"],
      ["/api/v1/sales", "office_role_required"],
      ["/api/v1/approvals", "office_role_required"],
    ] as const) {
      const callsBeforeDeniedRead = mock.requests.length;
      const deniedRead = await handleAuthenticatedRoute(
        new Request(`https://app.example.com${path}`),
        env(),
        auth("production", "production@example.com"),
      );
      assert.equal(deniedRead.status, 403, path);
      assert.deepEqual(await deniedRead.json(), { error }, path);
      assert.equal(mock.requests.length, callsBeforeDeniedRead, path);
    }

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(
      request,
      env(),
      auth("field", "crew@example.com"),
    );
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
    const office = await handleAuthenticatedRoute(
      request,
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { leads: Array<{ id: string }> }).leads[0]?.id,
      "LEAD-A",
    );

    const salesRole = await handleAuthenticatedRoute(
      request,
      env(),
      auth("sales", "sales@example.com"),
    );
    assert.equal(salesRole.status, 200);

    const callsBeforeNow = mock.requests.length;
    const now = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/now"),
      env(),
      auth("sales", "sales@example.com"),
    );
    const nowBody = (await now.json()) as {
      role: string;
      sources: Array<{ id: string }>;
    };
    assert.equal(now.status, 200);
    assert.equal(nowBody.role, "sales");
    assert.deepEqual(
      nowBody.sources.map(({ id }) => id),
      ["sales"],
    );
    const salesNowDoctypes = mock.requests
      .slice(callsBeforeNow)
      .map(({ doctype }) => doctype);
    for (const forbidden of [
      "Production Assignment",
      "Job Gate",
      "Automation Incident",
      "Payment Milestone",
      "Supplier Order",
    ]) {
      assert.equal(salesNowDoctypes.includes(forbidden), false, forbidden);
    }

    for (const [path, error] of [
      ["/api/v1/field/bootstrap", "today_read_required"],
      ["/api/v1/today", "today_read_required"],
      ["/api/v1/jobs/JOB-A", "job_read_required"],
      ["/api/v1/jobs/JOB-A/proof", "job_read_required"],
    ] as const) {
      const callsBeforeDeniedRead = mock.requests.length;
      const deniedRead = await handleAuthenticatedRoute(
        new Request(`https://app.example.com${path}`),
        env(),
        auth("sales", "sales@example.com"),
      );
      assert.equal(deniedRead.status, 403, path);
      assert.deepEqual(await deniedRead.json(), { error }, path);
      assert.equal(mock.requests.length, callsBeforeDeniedRead, path);
    }

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(
      request,
      env(),
      auth("field", "crew@example.com"),
    );
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
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(model.packet.contact, {
      display_name: "Customer 1",
      phone: "+14035550000",
      access_instructions: null,
    });
    assert.equal(model.gates[0]?.owner, null);
    assert.equal(
      Object.hasOwn(model.packet.change_orders[0] ?? {}, "total_amount"),
      false,
    );
    assert.equal(
      Object.hasOwn(model.packet.change_orders[0] ?? {}, "currency"),
      false,
    );
    assert.deepEqual(model.packet.work_package, {
      id: "work_package_a",
      version: 1,
      status: "Released",
      title: "South roof replacement",
      objective: "Install the released metal system.",
      boundaries: "South roof only.",
      prerequisites: "Verify tie-off and material staging.",
      expected_result: "Released roof section complete.",
      stop_conditions: "Stop for unsafe weather or missing controls.",
      make_safe_procedure: "Secure the work area and notify the supervisor.",
      issued_at: "2026-07-10T07:00:00.000Z",
      expires_at: "2026-07-11T07:00:00.000Z",
      released_at: "2026-07-10T07:05:00.000Z",
      work_object_type: "Roof Job",
      work_object_id: "JOB-A",
      physical_context_type: "Roof Site",
      physical_context_id: "JOB-A",
      release_attempt_id: null,
      supersession: null,
      acknowledgement: {
        current_user_acknowledged: false,
        acknowledged_at: null,
        workers: [
          {
            worker_user: "crew@example.com",
            worker_role: "Installer",
            required: true,
            acknowledged: false,
            acknowledged_at: null,
          },
        ],
      },
      evidence_slots: [],
      steps: [
        {
          sequence: 1,
          instruction: "Verify the roof zone.",
          required_evidence: "Zone photo",
          acceptance_criteria: "Zone matches package.",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Deck condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Deck photo",
          acceptance_criteria: "Supervisor release.",
          released: false,
        },
      ],
    });
    assert.equal(
      model.allowed_actions.includes("work_package.acknowledge"),
      false,
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
    assert.equal(
      model.allowed_actions.includes("work_package.stop_work"),
      true,
    );
    assert.ok(
      model.stale_fields.includes("packet.contact.access_instructions"),
    );
    const serialized = JSON.stringify(model);
    for (const secret of [
      "office-owner@example.com",
      "customer0@private.example",
      "financial-secret",
      "internal customer note",
      "internal pricing assumption",
      "internal exclusion",
      "internal access secret",
      "internal hazard secret",
      "private-release@example.com",
      "private blocker",
      "r2/private",
    ])
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  } finally {
    mock.restore();
  }
});

test("field Work Package Start requires a complete, unique hold-release ledger", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    status: "Acknowledged",
    release_attempt_id: "attempt-a",
    acknowledged_by: "crew@example.com",
    acknowledged_at: "2026-07-10T07:10:00.000Z",
    hold_points: [
      {
        sequence: 1,
        hold_point: "Deck condition",
        release_authority: "Supervisor",
        required_evidence: "Deck photo",
        acceptance_criteria: "Supervisor release.",
      },
      {
        sequence: 2,
        hold_point: "Flashing inspection",
        release_authority: "Supervisor",
        required_evidence: "Flashing photo",
        acceptance_criteria: "Supervisor release.",
      },
    ],
  };
  const release = (sequence: number) => ({
    name: `WORK-PACKAGE-EVENT-${sequence}`,
    event_type: "Hold Point Released",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    hold_point_sequence: sequence,
    evidence_item: `EVID-${sequence}`,
    actor_user: "private-release@example.com",
    device_action_id: "private-device-action",
    payload_hash: "private-payload-hash",
    occurred_at: "2026-07-10T08:00:00.000Z",
    modified: MODIFIED,
  });
  const acknowledgement = {
    name: "WORK-PACKAGE-ACK-1",
    event_type: "Acknowledged",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: "ack-device-1",
    occurred_at: "2026-07-10T07:10:00.000Z",
    modified: MODIFIED,
  };

  const partial = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [release(1)],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(
      model.packet.work_package?.hold_points.map((hold) => hold.released),
      [true, false],
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
    const eventRequest = partial.requests.find(
      (request) => request.doctype === "Work Package Event",
    );
    assert.deepEqual(eventRequest?.fields, [
      "event_type",
      "work_package",
      "roof_job",
      "job_assignment",
      "work_object_type",
      "work_object_id",
      "physical_context_type",
      "physical_context_id",
      "work_package_version",
      "release_attempt_id",
      "hold_point_sequence",
      "evidence_item",
    ]);
    assert.deepEqual(eventRequest?.filters, [
      ["Work Package Event", "work_package", "=", "WORK-PACKAGE-A"],
      ["Work Package Event", "roof_job", "=", "JOB-A"],
      ["Work Package Event", "job_assignment", "=", "ASSIGN-A"],
      ["Work Package Event", "work_package_version", "=", 1],
      ["Work Package Event", "event_type", "=", "Hold Point Released"],
    ]);
    const serialized = JSON.stringify(model);
    for (const privateValue of [
      "private-release@example.com",
      "private-device-action",
      "private-payload-hash",
    ]) {
      assert.equal(
        serialized.includes(privateValue),
        false,
        `leaked ${privateValue}`,
      );
    }
  } finally {
    partial.restore();
  }

  const duplicate = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [release(1), release(1), release(2)],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(
      model.packet.work_package?.hold_points.map((hold) => hold.released),
      [false, false],
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
  } finally {
    duplicate.restore();
  }

  const malformed = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [release(1), { ...release(2), evidence_item: "" }],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(
      model.packet.work_package?.hold_points.map((hold) => hold.released),
      [false, false],
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
  } finally {
    malformed.restore();
  }

  const complete = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [release(1), release(2), acknowledgement],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(
      model.packet.work_package?.hold_points.map((hold) => hold.released),
      [true, true],
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), true);
  } finally {
    complete.restore();
  }
});

test("field packet exposes exact Work Package supersession identity and changed step/hold summary", async () => {
  const current = {
    ...rowsFor("Work Package")[0]!,
    status: "Released",
    release_attempt_id: "attempt-b",
    supersedes: "WORK-PACKAGE-OLD",
    correction_reason:
      "Changed condition: the deck inspection hold now requires a revised anchor check.",
    steps: [
      {
        sequence: 1,
        instruction: "Verify the revised roof zone.",
        required_evidence: "Revised zone photo",
        acceptance_criteria: "Revised zone matches package.",
      },
      {
        sequence: 2,
        instruction: "Stage the released material.",
        required_evidence: "Material staging photo",
        acceptance_criteria: "Material is protected and staged.",
      },
    ],
    hold_points: [
      {
        sequence: 1,
        hold_point: "Revised deck condition",
        release_authority: "Supervisor",
        required_evidence: "Revised deck photo",
        acceptance_criteria: "Supervisor releases revised deck condition.",
      },
      {
        sequence: 2,
        hold_point: "Material staging",
        release_authority: "Supervisor",
        required_evidence: "Material staging photo",
        acceptance_criteria: "Supervisor releases material staging.",
      },
    ],
  };
  const prior = {
    ...current,
    name: "WORK-PACKAGE-OLD",
    work_package_id: "work_package_old",
    status: "Superseded",
    release_attempt_id: "attempt-a",
    supersedes: null,
    correction_reason: null,
    steps: [
      {
        sequence: 1,
        instruction: "Verify the original roof zone.",
        required_evidence: "Original zone photo",
        acceptance_criteria: "Original zone matches package.",
      },
      current.steps[1]!,
    ],
    hold_points: [
      {
        sequence: 1,
        hold_point: "Original deck condition",
        release_authority: "Supervisor",
        required_evidence: "Original deck photo",
        acceptance_criteria: "Supervisor releases original deck condition.",
      },
      current.hold_points[1]!,
    ],
  };
  const acknowledgement = {
    name: "WORK-PACKAGE-ACK-CURRENT",
    event_type: "Acknowledged",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-b",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: "ack-current-attempt",
    occurred_at: "2026-07-10T07:20:00.000Z",
    modified: MODIFIED,
  };
  const mock = installFrappeMock({
    "Work Package": [current, prior],
    "Work Package Event": [acknowledgement],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model?.packet.work_package);
    assert.deepEqual(model.packet.work_package.supersession, {
      prior_id: "WORK-PACKAGE-OLD",
      reason:
        "Changed condition: the deck inspection hold now requires a revised anchor check.",
      changed_steps: [1],
      changed_hold_points: [1],
    });
    assert.equal(
      model.packet.work_package.acknowledgement.current_user_acknowledged,
      true,
    );
    assert.equal(
      model.packet.work_package.acknowledgement.acknowledged_at,
      "2026-07-10T07:20:00.000Z",
    );
  } finally {
    mock.restore();
  }

  const unreadablePrior = installFrappeMock({
    "Work Package": [current],
    "Work Package Event": [acknowledgement],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.equal(model?.packet.work_package, null);
  } finally {
    unreadablePrior.restore();
  }
});

test("field packet ignores acknowledgements from a prior release attempt", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    status: "Released",
    release_attempt_id: "attempt-b",
    acknowledged_by: "crew@example.com",
    acknowledged_at: "2026-07-10T07:10:00.000Z",
  };
  const staleAcknowledgement = {
    name: "WORK-PACKAGE-ACK-STALE",
    event_type: "Acknowledged",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: "ack-stale-attempt",
    occurred_at: "2026-07-10T07:10:00.000Z",
    modified: MODIFIED,
  };
  const mock = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [staleAcknowledgement],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model?.packet.work_package);
    assert.equal(
      model.packet.work_package.acknowledgement.current_user_acknowledged,
      false,
    );
    assert.equal(
      model.packet.work_package.acknowledgement.acknowledged_at,
      null,
    );
    assert.equal(
      model.packet.work_package.acknowledgement.workers[0]?.acknowledged,
      false,
    );
    assert.equal(
      model.allowed_actions.includes("work_package.acknowledge"),
      true,
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
  } finally {
    mock.restore();
  }
});

test("field packet rejects an event-to-Evidence Item cross-pair and clears the evidence ledger", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    release_attempt_id: "attempt-a",
  };
  const prior = {
    name: "EVIDENCE-EVENT-1",
    event_type: "Evidence Captured",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: "evidence-device-1",
    occurred_at: "2026-07-10T08:00:00.000Z",
    evidence_item: "EVIDENCE-ITEM-1",
    evidence_slot_id: "step:1",
    evidence_requirement: "Zone photo",
    evidence_source: "worker-camera",
    evidence_device_id: "paired-device-1",
    evidence_captured_at: "2026-07-10T07:59:00.000Z",
    evidence_freshness: "Current",
    evidence_conflict_state: "None",
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    evidence_verification: "Verified",
    evidence_disposition: "Open",
    correction_reason: null,
    modified: MODIFIED,
  };
  const crossed = {
    ...prior,
    name: "EVIDENCE-EVENT-2",
    device_action_id: "evidence-device-2",
    occurred_at: "2026-07-10T08:05:00.000Z",
    evidence_item: "EVIDENCE-ITEM-2",
    evidence_correction_of: "EVIDENCE-EVENT-1",
    evidence_item_correction_of: "EVIDENCE-ITEM-2",
  };
  const mock = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": [prior, crossed],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(model.packet.work_package?.evidence_slots, []);
    assert.equal(
      model.allowed_actions.includes("work_package.acknowledge"),
      true,
    );
  } finally {
    mock.restore();
  }
});

test("field packet binds crew roles and rejects forged typed lifecycle or review authority", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    status: "Acknowledged",
    release_attempt_id: "attempt-a",
    assigned_workers: [
      {
        sequence: 1,
        worker_user: "crew-a@example.com",
        worker_role: "Installer",
        required: 1,
      },
      {
        sequence: 2,
        worker_user: "crew-b@example.com",
        worker_role: "Spotter",
        required: 1,
      },
    ],
  };
  const assignment = {
    ...assignments[0]!,
    assigned_user: null,
    crew_profile: "CREW-1",
  };
  const crewMembers = [
    {
      name: "CREW-MEMBER-A",
      parent: "CREW-1",
      parenttype: "Crew Profile",
      parentfield: "members",
      crew_user: "crew-a@example.com",
      crew_role: "Installer",
      active: 1,
    },
    {
      name: "CREW-MEMBER-B",
      parent: "CREW-1",
      parenttype: "Crew Profile",
      parentfield: "members",
      crew_user: "crew-b@example.com",
      crew_role: "Spotter",
      active: 1,
    },
  ];
  const acknowledgements = [
    {
      name: "ACK-CREW-A",
      event_type: "Acknowledged",
      work_package: "WORK-PACKAGE-A",
      roof_job: "JOB-A",
      job_assignment: "ASSIGN-A",
      work_package_version: 1,
      release_attempt_id: "attempt-a",
      actor_user: "crew-a@example.com",
      actor_role: "Installer",
      device_action_id: "ack-crew-a",
      occurred_at: "2026-07-10T07:10:00.000Z",
    },
    {
      name: "ACK-CREW-B",
      event_type: "Acknowledged",
      work_package: "WORK-PACKAGE-A",
      roof_job: "JOB-A",
      job_assignment: "ASSIGN-A",
      work_package_version: 1,
      release_attempt_id: "attempt-a",
      actor_user: "crew-b@example.com",
      actor_role: "Spotter",
      device_action_id: "ack-crew-b",
      occurred_at: "2026-07-10T07:11:00.000Z",
    },
  ];
  const evidence = {
    name: "EVIDENCE-EVENT-1",
    event_type: "Evidence Captured",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    actor_user: "crew-a@example.com",
    actor_role: "Installer",
    device_action_id: "evidence-device-1",
    occurred_at: "2026-07-10T08:00:00.000Z",
    evidence_item: "EVIDENCE-ITEM-1",
    evidence_slot_id: "step:1",
    evidence_requirement: "Zone photo",
    evidence_source: "worker-camera",
    evidence_device_id: "paired-device-1",
    evidence_captured_at: "2026-07-10T07:59:00.000Z",
    evidence_freshness: "Current",
    evidence_conflict_state: "None",
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    evidence_verification: "Verified",
    evidence_disposition: "Open",
    correction_reason: null,
  };
  const source = {
    "Job Assignment": [assignment],
    "Crew Profile": [{ name: "CREW-1", status: "Active" }],
    "Crew Member": crewMembers,
    "Work Package": [packageRow],
    "Work Package Event": [...acknowledgements, evidence],
  };
  const mock = installFrappeMock(source);
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew-a@example.com"),
      "JOB-A",
    );
    assert.ok(model?.packet.work_package);
    assert.equal(
      model.packet.work_package.acknowledgement.current_user_acknowledged,
      true,
    );
    assert.equal(model.allowed_actions.includes("work_package.acknowledge"), false);
    assert.equal(model.packet.work_package.evidence_slots.length, 1);
  } finally {
    mock.restore();
  }

  const forgedCapture = installFrappeMock({
    ...source,
    "Work Package Event": [
      ...acknowledgements,
      { ...evidence, evidence_verification: "Pending" },
    ],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew-a@example.com"),
      "JOB-A",
    );
    assert.deepEqual(model?.packet.work_package?.evidence_slots, []);
  } finally {
    forgedCapture.restore();
  }

  const forgedReview = installFrappeMock({
    ...source,
    "Work Package Event": [
      ...acknowledgements,
      evidence,
      {
        ...evidence,
        name: "EVIDENCE-REVIEW-1",
        event_type: "Evidence Reviewed",
        actor_user: "crew-a@example.com",
        actor_role: "Installer",
        device_action_id: "review-device-1",
        occurred_at: "2026-07-10T08:05:00.000Z",
        evidence_review_of: "EVIDENCE-EVENT-1",
        evidence_disposition: "Accepted",
        evidence_verification: null,
      },
    ],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew-a@example.com"),
      "JOB-A",
    );
    assert.deepEqual(model?.packet.work_package?.evidence_slots, []);
  } finally {
    forgedReview.restore();
  }

  const sameActorReview = installFrappeMock({
    ...source,
    "Work Package Event": [
      ...acknowledgements,
      evidence,
      {
        ...evidence,
        name: "EVIDENCE-REVIEW-SAME-ACTOR",
        event_type: "Evidence Reviewed",
        actor_user: "crew-a@example.com",
        actor_role: "IronWrap Production",
        device_action_id: "review-device-same-actor",
        occurred_at: "2026-07-10T08:06:00.000Z",
        evidence_review_of: "EVIDENCE-EVENT-1",
        evidence_disposition: "Accepted",
        evidence_verification: null,
      },
    ],
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew-a@example.com"),
      "JOB-A",
    );
    assert.deepEqual(model?.packet.work_package?.evidence_slots, []);
  } finally {
    sameActorReview.restore();
  }
});

test("field packet fails closed when typed evidence exceeds the bounded ledger page", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    release_attempt_id: "attempt-a",
  };
  const evidence = Array.from({ length: 101 }, (_, index) => ({
    name: `EVIDENCE-EVENT-${String(index).padStart(3, "0")}`,
    event_type: "Evidence Captured",
    work_package: "WORK-PACKAGE-A",
    roof_job: "JOB-A",
    job_assignment: "ASSIGN-A",
    work_package_version: 1,
    release_attempt_id: "attempt-a",
    actor_user: "crew@example.com",
    actor_role: "Installer",
    device_action_id: `evidence-device-${index}`,
    occurred_at: `2026-07-10T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    evidence_item: `EVIDENCE-ITEM-${index}`,
    evidence_slot_id: "step:1",
    evidence_requirement: "Zone photo",
    evidence_source: "worker-camera",
    evidence_device_id: "paired-device-1",
    evidence_captured_at: "2026-07-10T07:59:00.000Z",
    evidence_freshness: "Current",
    evidence_conflict_state: "None",
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    evidence_verification: "Verified",
    evidence_disposition: "Open",
    correction_reason: null,
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({
    "Work Package": [packageRow],
    "Work Package Event": evidence,
  });
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(model.packet.work_package?.evidence_slots, []);
    const evidenceRequests = mock.requests.filter(
      (request) =>
        request.doctype === "Work Package Event" &&
        request.fields.includes("evidence_correction_of"),
    );
    assert.deepEqual(
      evidenceRequests.map((request) => request.offset),
      [0, 100],
    );
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
      const page = await buildJobProofReadModel(
        env(),
        auth("field", "crew@example.com"),
        "JOB-A",
        cursor,
      );
      assert.ok(page);
      assert.ok(page.items.length <= 100);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    }
    assert.equal(seen.length, 1_051);
    assert.equal(new Set(seen).size, 1_051);
    assert.equal(seen[0], "evidence_1050");
    assert.equal(seen.at(-1), "evidence_0000");
    const evidenceRequests = mock.requests.filter(
      (request) => request.doctype === "Evidence Item",
    );
    assert.equal(
      evidenceRequests.every((request) => request.limit === 100),
      true,
    );
    assert.deepEqual(
      evidenceRequests.map((request) => request.offset),
      [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
    );
  } finally {
    mock.restore();
  }
});

test("Frappe read allowlist never requests sensitive contact or commercial fields", () => {
  assert.deepEqual(FRAPPE_READ_FIELDS["Roofing Customer"], [
    "name",
    "display_name",
    "phone",
    "modified",
  ]);
  assert.equal(
    FRAPPE_READ_FIELDS["Change Order"].includes("notes" as never),
    false,
  );
  assert.equal(
    FRAPPE_READ_FIELDS["Roof Job"].includes("qb_invoice_ref" as never),
    false,
  );
  for (const financeField of [
    "recognition_posted_at",
    "recognition_digest",
    "recognition_reconciliation",
  ]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(financeField as never),
      true,
    );
  }
  for (const retainedField of ["due_date", "event_ts", "notes"]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(retainedField as never),
      true,
    );
  }
  for (const excludedField of ["raw_key", "raw_payload_hash"]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(excludedField as never),
      false,
    );
  }
  for (const privateTriageField of [
    "triaged_by",
    "triaged_at",
    "triage_summary",
  ]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Lead Envelope"].includes(privateTriageField as never),
      false,
    );
  }
  for (const rawField of [
    "payload_json",
    "raw_key",
    "tax_policy_snapshot_json",
    "source_reference",
    "notes",
  ]) {
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Lead Envelope"].includes(rawField as never),
      false,
    );
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Customer Quote"].includes(rawField as never),
      false,
    );
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Communication Consent"].includes(
        rawField as never,
      ),
      false,
    );
  }
});
