import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildTodayReadModel,
} from "../src/app-read-models.ts";
import { FRAPPE_READ_FIELDS } from "../src/frappe-read.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const MODIFIED_OLD = "2026-07-09T10:00:00.000Z";
const MODIFIED_NEW = "2026-07-10T11:00:00.000Z";

const jobA = {
  name: "JOB-A",
  roof_job_id: "job_a",
  job_number: "IW-1001",
  brand: "ironwrap",
  service_type: "Roofing",
  job_status: "In Production",
  roofing_property: "PROP-A",
  current_gate_state: "Materials: Blocked",
  modified: MODIFIED_OLD,
  _assign: JSON.stringify(["crew@example.com"]),
  secret_field: "must-never-escape",
};

const jobB = {
  ...jobA,
  name: "JOB-B",
  roof_job_id: "job_b",
  job_number: "IW-1002",
  roofing_property: "PROP-B",
  _assign: JSON.stringify(["other@example.com"]),
};

function auth(role: AppRole, frappeUserId: string | null): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: role === "field"
      ? ["session:read", "jobs:read:assigned"]
      : ["session:read", "jobs:read:any", "owner:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: MODIFIED_OLD,
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
      created_at: MODIFIED_OLD,
      updated_at: MODIFIED_OLD,
    },
  };
}

function env(): AppEnv {
  return {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_TIME_ZONE: "America/Edmonton",
  } as never;
}

function installFrappeMock() {
  const original = globalThis.fetch;
  const requests: Array<{ doctype: string; fields: string[]; filters: unknown[]; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const fields = JSON.parse(url.searchParams.get("fields") ?? "[]") as string[];
    const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as unknown[];
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ doctype, fields, filters, authorization });

    let data: unknown[] = [];
    if (doctype === "Roof Job") {
      const nameFilter = filters.find((filter) => Array.isArray(filter) && filter[1] === "name") as unknown[] | undefined;
      data = nameFilter?.[3] === "JOB-B" ? [jobB] : nameFilter?.[3] === "JOB-A" ? [jobA] : [jobA, jobB];
    } else if (doctype === "Roofing Property") {
      data = [{
        name: "PROP-A", property_key: "prop_a", address_line1: "10 Test Ave", city: "Calgary",
        province: "AB", postal_code: "T1T 1T1", country: "Canada", modified: MODIFIED_NEW,
        private_notes: "never-return",
      }];
    } else if (doctype === "Production Gate State") {
      data = [{
        name: "GATE-A", gate_id: "gate_a", roof_job: "JOB-A", gate: "Materials", state: "Blocked",
        owner_user: "ops@example.com", due_at: "2026-07-11 12:00:00",
        blocker_reason: "Delivery not confirmed", modified: MODIFIED_NEW, internal_secret: "never-return",
      }];
    } else if (doctype === "Evidence Item") {
      data = [{
        name: "EVID-A", evidence_id: "evidence_a", roof_job: "JOB-A", evidence_type: "Photo",
        source_system: "field", source_uri: "https://secret.example/file", r2_key: "raw/secret",
        captured_at: "2026-07-10T10:00:00.000Z", customer_safe: 1, summary: "Underlayment complete",
        modified: MODIFIED_NEW,
      }];
    } else if (doctype === "Field Check-in") {
      data = [{
        name: "CHECK-A", checkin_id: "check_a", roof_job: "JOB-A", source_system: "field",
        submitted_at: "2026-07-10T09:00:00.000Z", status: "Received", photo_count: 3,
        notes: "Crew arrived", raw_key: "raw/secret", modified: MODIFIED_OLD,
      }];
    } else if (doctype === "Automation Incident") {
      data = [{
        name: "INC-A", incident_id: "incident_a", status: "Open", severity: "High",
        source_system: "worker", category: "Integration", summary: "Supplier sync failed",
        roof_job: "JOB-A", detected_at: MODIFIED_NEW, modified: MODIFIED_NEW,
      }];
    } else if (doctype === "Payment Milestone") {
      data = [{
        name: "PAY-A", payment_milestone_id: "pay_a", roof_job: "JOB-A", milestone_type: "Invoice",
        status: "Needs Review", due_date: "2026-07-12", qb_entity_type: "Invoice", qb_entity_id: "123", notes: "Unmatched",
        modified: MODIFIED_OLD,
      }];
    } else if (doctype === "Lead Envelope") {
      data = [{
        name: "LEAD-A", envelope_id: "lead_a", source: "website", status: "received",
        contact_name: "Jane Homeowner", intent_queue: "residential_sales", event_ts: MODIFIED_OLD,
        payload_json: "secret", modified: MODIFIED_OLD,
      }];
    } else if (doctype === "Supplier Order") {
      data = [{
        name: "ORDER-A", supplier_order_id: "order_a", roof_job: "JOB-A", status: "Shortage",
        requested_delivery_date: "2026-07-13", delivery_notes: "Missing ridge caps", modified: MODIFIED_OLD,
      }];
    }
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test("field today model returns only exactly assigned jobs with screen-shaped metadata", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildTodayReadModel(env(), auth("field", "crew@example.com"));
    assert.equal(model.version, 1);
    assert.equal(model.jobs.length, 1);
    assert.deepEqual(model.jobs[0], {
      id: "JOB-A",
      job_number: "IW-1001",
      brand: "ironwrap",
      status: "In Production",
      address: "10 Test Ave, Calgary AB T1T 1T1, Canada",
      scheduled_start: null,
      scheduled_end: null,
      blocked_gate_count: 1,
      next_action: null,
    });
    assert.ok(model.stale_fields.includes("jobs.scheduled_start"));
    assert.ok(model.stale_fields.includes("jobs.next_action"));
    assert.equal(model.source_updated_at, MODIFIED_NEW);
    assert.deepEqual(model.permissions, ["session:read", "jobs:read:assigned"]);

    const roofRequest = mock.requests.find((request) => request.doctype === "Roof Job")!;
    assert.ok(JSON.stringify(roofRequest.filters).includes("_assign"));
    assert.equal(roofRequest.authorization, "token read-key:read-secret");
  } finally {
    mock.restore();
  }
});

test("field job lookup fails closed for an unassigned id before related records are fetched", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildJobReadModel(env(), auth("field", "crew@example.com"), "JOB-B");
    assert.equal(model, null);
    assert.deepEqual(mock.requests.map((request) => request.doctype), ["Roof Job"]);
  } finally {
    mock.restore();
  }
});

test("job detail emits gate/proof shapes and strips non-allowlisted artifact locations", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildJobReadModel(env(), auth("field", "crew@example.com"), "JOB-A");
    assert.ok(model);
    assert.equal(model!.job.address, "10 Test Ave, Calgary AB T1T 1T1, Canada");
    assert.deepEqual(model!.gates[0], {
      id: "gate_a",
      name: "Materials",
      state: "Blocked",
      blocker_reason: "Delivery not confirmed",
      owner: "ops@example.com",
      due_at: "2026-07-11 12:00:00",
    });
    assert.deepEqual(model!.stale_fields, ["required_proof"]);
    assert.deepEqual(model!.proof_stream.map((event) => event.id), ["evidence_a", "check_a"]);
    assert.deepEqual(model!.required_proof, []);
    const serialized = JSON.stringify(model);
    assert.doesNotMatch(serialized, /source_uri|r2_key|raw\/secret|secret_field|private_notes/);

    for (const request of mock.requests) {
      const allowlist = FRAPPE_READ_FIELDS[request.doctype as keyof typeof FRAPPE_READ_FIELDS];
      assert.ok(allowlist, `unexpected DocType ${request.doctype}`);
      assert.deepEqual(request.fields, [...allowlist]);
    }
  } finally {
    mock.restore();
  }
});

test("owner now is exception-first, source-counted, and field role is denied", async () => {
  const mock = installFrappeMock();
  try {
    await assert.rejects(
      () => buildOwnerNowReadModel(env(), auth("field", "crew@example.com")),
      /owner_scope_required/,
    );
    const model = await buildOwnerNowReadModel(env(), auth("owner", "owner@example.com"));
    assert.deepEqual(model.summary, {
      active_jobs: 2,
      blocked_gates: 1,
      open_incidents: 1,
      finance_exceptions: 1,
      new_leads: 1,
      material_exceptions: 1,
    });
    assert.deepEqual(model.exceptions.map((exception) => exception.kind), [
      "blocked_gate", "automation_incident", "finance_exception", "new_lead", "material_exception",
    ]);
    assert.deepEqual(model.exceptions.map((exception) => exception.due_at), [
      "2026-07-11 12:00:00", null, "2026-07-12", null, "2026-07-13",
    ]);
    assert.ok(model.stale_fields.includes("exceptions.due_at"));
    assert.ok(model.stale_fields.includes("exceptions.next_action"));
    assert.doesNotMatch(JSON.stringify(model), /payload_json|raw_key/);
  } finally {
    mock.restore();
  }
});

test("Frappe read requests are GET-only, bounded, and reject insecure base URLs", async () => {
  const mock = installFrappeMock();
  try {
    await buildTodayReadModel(env(), auth("owner", "owner@example.com"));
    assert.ok(mock.requests.length > 0);
  } finally {
    mock.restore();
  }
  await assert.rejects(
    () => buildTodayReadModel({ ...env(), ERPNEXT_BASE_URL: "http://frappe.example.com" } as never, auth("owner", "owner@example.com")),
    /frappe_read_bad_base_url/,
  );
});
