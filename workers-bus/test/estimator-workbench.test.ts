import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { buildEstimatorWorkbenchReadModel } from "../src/app-read-models.ts";
import { OFFICE_ESTIMATOR_READ_FIELDS } from "../src/frappe-read.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const MODIFIED = "2026-07-11T10:00:00.000Z";
const RAW_KEY = "raw/measurements/2026-07-11/ow_01234567-89ab-cdef-0123-456789abcdef.json";
const GEOMETRY_XML = [
  "<APPLICAD_EXPORT>",
  '<POINT id="P1" data="0,0,0"/>',
  '<POINT id="P2" data="10,0,0"/>',
  '<POINT id="P3" data="10,10,0"/>',
  '<POINT id="P4" data="0,10,0"/>',
  '<LINE id="L1" path="P1,P2" type="EAVE" length="10"/>',
  '<LINE id="L2" path="P2,P3" type="RIDGE" length="10"/>',
  '<LINE id="L3" path="P3,P4" type="EAVE" length="10"/>',
  '<LINE id="L4" path="P4,P1" type="EAVE" length="12"/>',
  '<POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" pitch="6" mat="Asphalt"/>',
  "</APPLICAD_EXPORT>",
].join("");

const rows: Record<string, Array<Record<string, unknown>>> = {
  "Roof Job": [
    {
      name: "JOB-A",
      roof_job_id: "roof_job_a",
      job_number: "IW-1001",
      brand: "ironwrap",
      service_type: "Roof replacement",
      job_status: "Proposal",
      workflow_profile: "Residential Retail",
      modified: MODIFIED,
      customer: "CUSTOMER-A",
      internal_financial_note: "private-job-note",
    },
  ],
  "Measurement Report": [
    {
      name: "MEASURE-A",
      measurement_id: "measure_a",
      roof_job: "JOB-A",
      provider: "AppliCad",
      review_status: "Needs Review",
      parsed_at: MODIFIED,
      approved_at: null,
      raw_key: RAW_KEY,
      report_url: "https://private.example/report",
      modified: MODIFIED,
      measurements: [
        {
          metric: "roof_area",
          value: 100,
          unit: "sq ft",
          confidence: "deterministic",
          source_ref: "POLYGON[type=Roof]",
          needs_review: 1,
          hidden_private_detail: "do-not-expose",
        },
      ],
    },
  ],
  "Material Takeoff": [
    {
      name: "TAKEOFF-A",
      takeoff_id: "takeoff_a",
      roof_job: "JOB-A",
      measurement_report: "MEASURE-A",
      status: "Needs Review",
      prepared_at: MODIFIED,
      approved_at: null,
      assumptions: "Waste includes valleys.",
      exclusions: "Deck repairs require separate approval.",
      source_measurements_json: "private-json",
      modified: MODIFIED,
      items: [
        {
          category: "Shingle",
          item_name: "Architectural shingles",
          quantity: 12.5,
          unit: "squares",
          waste_factor: 12,
          source_ref: "roof_area",
          confidence: "deterministic",
          needs_review: 1,
          supplier_cost: 9999,
        },
      ],
    },
  ],
  "Customer Quote": [
    {
      name: "QUOTE-A",
      customer_quote_id: "quote_a",
      roof_job: "JOB-A",
      quote_version: 3,
      status: "Needs Review",
      price_book_version: "2026-07-11",
      pricing_effective_at: MODIFIED,
      subtotal: 12000,
      tax_amount: 600,
      tax_code: "GST",
      tax_rate: 5,
      quote_total: 12600,
      currency: "CAD",
      deposit_amount: 2500,
      amount_due: 2500,
      amount_paid: 0,
      balance_due: 12600,
      payment_status: "Not Due",
      payment_due_date: null,
      valid_until: "2026-07-25",
      prepared_at: MODIFIED,
      approved_at: null,
      accepted_at: null,
      scope_summary: "Replace roof system and flashings.",
      assumptions: "One existing layer.",
      exclusions: "Deck repairs excluded.",
      supersedes: "QUOTE-OLD",
      correction_reason: "Supplier price notice",
      tax_policy_snapshot_json: "private-tax-json",
      quote_summary_json: "private-quote-json",
      modified: MODIFIED,
    },
  ],
  "Proposal Evidence Pack": [
    {
      name: "PACK-A",
      pack_id: "pack_a",
      roof_job: "JOB-A",
      quotation: "QUOTE-A",
      status: "Draft",
      prepared_at: MODIFIED,
      approved_at: null,
      signed_at: null,
      assumptions: "One existing layer.",
      exclusions: "Deck repairs excluded.",
      evidence_summary_json: "private-evidence-json",
      customer_message: "private-message",
      modified: MODIFIED,
    },
  ],
  "Scope Clause": [
    {
      name: "CLAUSE-A",
      scope_clause_id: "clause_a",
      roof_job: "JOB-A",
      clause_type: "Risk",
      title: "Deck condition",
      clause_text: "Hidden deck conditions require evidence and written approval.",
      version: "v2",
      status: "Approved",
      source_ref: "Alberta contract policy",
      customer_visible: 1,
      approved_at: MODIFIED,
      notes: "private-clause-note",
      modified: MODIFIED,
    },
  ],
};

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions:
      role === "field"
        ? ["session:read", "jobs:read:assigned", "field:write:assigned"]
        : ["session:read", "jobs:read:any", "owner:read", "sales:read", "estimator:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: MODIFIED,
      session_expires_at: "2026-07-11T22:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: `${role}@example.com`,
      active: 1,
      created_by: "owner@example.com",
      created_at: MODIFIED,
      updated_at: MODIFIED,
    },
  };
}

function env(
  rawText = JSON.stringify({
    source_xml: GEOMETRY_XML,
    internal_note: "never expose source bytes",
  }),
): AppEnv {
  return {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    RAW: {
      get: async (key: string) =>
        key === RAW_KEY
          ? {
              size: new TextEncoder().encode(rawText).byteLength,
              text: async () => rawText,
            }
          : null,
    },
  } as never;
}

function installFrappeMock(
  dataset: Record<string, Array<Record<string, unknown>>> = rows,
  options: {
    oversizedMeasurementDetail?: boolean;
    detailRows?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const original = globalThis.fetch;
  const requests: Array<{
    doctype: string;
    name: string | null;
    fields: string[];
    filters: unknown[];
  }> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const resource = segments.lastIndexOf("resource");
    const doctype = segments[resource + 1] ?? "";
    const name = segments[resource + 2] ?? null;
    const fields = JSON.parse(url.searchParams.get("fields") ?? "[]") as string[];
    const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as unknown[];
    requests.push({ doctype, name, fields, filters });
    const source = dataset[doctype] ?? [];
    if (name) {
      const document = options.detailRows?.[`${doctype}/${name}`] ?? source.find((row) => row.name === name);
      if (document && options.oversizedMeasurementDetail && doctype === "Measurement Report") {
        const body = JSON.stringify({ data: { ...document, padding: "x".repeat(800 * 1024) } });
        return new Response(body, {
          headers: {
            "content-length": String(new TextEncoder().encode(body).byteLength),
            "content-type": "application/json",
          },
        });
      }
      return document
        ? Response.json({ data: document })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({
      data: source.filter((row) => filters.every((filter) => matchesFilter(row, filter))),
    });
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function matchesFilter(row: Record<string, unknown>, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const [, field, operator, expected] = raw;
  if (operator === "=") return String(row[String(field)] ?? "") === String(expected ?? "");
  return false;
}

test("estimator workbench derives safe measurement geometry and commercial traceability without raw leakage", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("ops"), "JOB-A");
    assert.ok(model);
    assert.equal(model.job.job_number, "IW-1001");
    assert.deepEqual(model.allowed_actions.at(-1), "estimator.read");
    assert.equal(model.measurements.selected?.geometry.state, "needs_review");
    assert.equal(model.measurements.selected?.geometry.failed_check_count, 1);
    assert.equal(model.measurements.selected?.geometry.facets[0]?.declared_area, 100);
    assert.equal(model.measurements.selected?.geometry.facets[0]?.computed_area, 100);
    assert.equal(model.measurements.selected?.metrics[0]?.source_ref, "POLYGON[type=Roof]");
    assert.equal(model.takeoffs.selected?.items[0]?.source_ref, "roof_area");
    assert.deepEqual(model.lineage, {
      measurement_to_takeoff: "linked",
      quote_to_proposal: "linked",
    });
    assert.equal(model.quote?.price_book_version, "2026-07-11");
    assert.equal(model.proposal?.status, "Draft");
    assert.equal(model.scope_clauses[0]?.customer_visible, true);

    const serialized = JSON.stringify(model);
    for (const secret of [
      RAW_KEY,
      GEOMETRY_XML,
      "private-job-note",
      "private-json",
      "private-tax-json",
      "private-quote-json",
      "private-evidence-json",
      "private-message",
      "private-clause-note",
      "do-not-expose",
      "never expose source bytes",
    ])
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);

    const reportList = mock.requests.find(
      (request) => request.doctype === "Measurement Report" && request.name === null,
    );
    assert.deepEqual(reportList?.fields, OFFICE_ESTIMATOR_READ_FIELDS["Measurement Report"]);
    assert.equal(reportList?.fields.includes("raw_key"), false);
    const reportDetail = mock.requests.find(
      (request) => request.doctype === "Measurement Report" && request.name === "MEASURE-A",
    );
    assert.ok(
      reportDetail,
      "selected report should be read only through the fixed direct-detail contract",
    );
  } finally {
    mock.restore();
  }
});

test("estimator workbench projects only an allowlisted visual preview with measurement provenance", async () => {
  const allowedPreview = "https://preview.ironwrap.example/models/visual-a.png?signature=opaque";
  const blockedPreview = "https://untrusted.example/models/visual-a.png";
  const dataset = {
    ...rows,
    "Visual Property Model": [{
      name: "VISUAL-A",
      roof_job: "JOB-A",
      provider: "Renoworks Capture",
      status: "Approved",
      confidence: 82,
      needs_review: 0,
      screenshots_json: JSON.stringify([blockedPreview, allowedPreview]),
      captured_at: MODIFIED,
      approved_at: MODIFIED,
      model_uri: "https://private.example/models/visual-a.glb",
      raw_key: "raw/visual/visual-a.json",
      provider_model_id: "provider-private-id",
      modified: MODIFIED,
    }],
    "Roof Area": [{
      name: "ROOF-AREA-A",
      roof_job: "JOB-A",
      visual_model: "VISUAL-A",
      measurement_report: "MEASURE-A",
      modified: MODIFIED,
    }],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      { ...env(), APP_VISUAL_PREVIEW_ALLOWED_ORIGINS: "https://preview.ironwrap.example" },
      auth("owner"),
      "JOB-A",
    );
    assert.ok(model?.visual_model);
    assert.equal(model.visual_model.model_state, "approved");
    assert.equal(model.visual_model.approval_recorded, true);
    assert.equal(model.visual_model.measurement_link, "selected_measurement");
    assert.deepEqual(model.visual_model.preview, { state: "available", url: allowedPreview });

    const serialized = JSON.stringify(model);
    for (const privateValue of [
      "https://private.example/models/visual-a.glb",
      "raw/visual/visual-a.json",
      "provider-private-id",
      blockedPreview,
    ]) assert.equal(serialized.includes(privateValue), false, `leaked ${privateValue}`);

    const visualList = mock.requests.find(
      (request) => request.doctype === "Visual Property Model" && request.name === null,
    );
    assert.deepEqual(visualList?.fields, OFFICE_ESTIMATOR_READ_FIELDS["Visual Property Model"]);
    for (const field of ["model_uri", "raw_key", "provider_model_id", "screenshots_json", "measurements_json"]) {
      assert.equal(visualList?.fields.includes(field), false, `visual list leaked ${field}`);
    }
    assert.ok(
      mock.requests.some(
        (request) => request.doctype === "Visual Property Model" && request.name === "VISUAL-A",
      ),
      "selected visual model should be read only through the fixed direct-detail contract",
    );
  } finally {
    mock.restore();
  }
});

test("estimator workbench fails closed for an unapproved model and a blocked preview origin", async () => {
  const blockedPreview = "https://untrusted.example/models/unapproved.png";
  const dataset = {
    ...rows,
    "Visual Property Model": [{
      name: "VISUAL-REVIEW",
      roof_job: "JOB-A",
      provider: "Provider",
      status: "Approved",
      confidence: 55,
      needs_review: 1,
      screenshots_json: JSON.stringify([blockedPreview]),
      captured_at: MODIFIED,
      approved_at: MODIFIED,
      modified: MODIFIED,
    }],
    "Roof Area": [],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      { ...env(), APP_VISUAL_PREVIEW_ALLOWED_ORIGINS: "https://preview.ironwrap.example" },
      auth("ops"),
      "JOB-A",
    );
    assert.ok(model?.visual_model);
    assert.equal(model.visual_model.model_state, "needs_review");
    assert.equal(model.visual_model.review_required, true);
    assert.equal(model.visual_model.approval_recorded, false);
    assert.equal(model.visual_model.measurement_link, "unlinked");
    assert.deepEqual(model.visual_model.preview, { state: "blocked", url: null });
    assert.equal(JSON.stringify(model).includes(blockedPreview), false);
  } finally {
    mock.restore();
  }
});

test("estimator workbench marks malformed visual preview payloads and other measurement links safely", async () => {
  const malformedScreenshotPayload = "{not-an-array";
  const dataset = {
    ...rows,
    "Visual Property Model": [{
      name: "VISUAL-OTHER",
      roof_job: "JOB-A",
      provider: "Provider",
      status: "Needs Review",
      confidence: 70,
      needs_review: 1,
      screenshots_json: malformedScreenshotPayload,
      captured_at: MODIFIED,
      approved_at: null,
      modified: MODIFIED,
    }],
    "Roof Area": [{
      name: "ROOF-AREA-OTHER",
      roof_job: "JOB-A",
      visual_model: "VISUAL-OTHER",
      measurement_report: "MEASURE-OTHER",
      modified: MODIFIED,
    }],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("owner"), "JOB-A");
    assert.ok(model?.visual_model);
    assert.equal(model.visual_model.model_state, "needs_review");
    assert.equal(model.visual_model.measurement_link, "other_measurement");
    assert.deepEqual(model.visual_model.preview, { state: "invalid", url: null });
    assert.equal(JSON.stringify(model).includes(malformedScreenshotPayload), false);
  } finally {
    mock.restore();
  }
});

test("estimator workbench suppresses an invalid visual model detail rather than projecting it", async () => {
  const dataset = {
    ...rows,
    "Visual Property Model": [{
      name: "VISUAL-INVALID",
      roof_job: "JOB-A",
      provider: "Provider",
      status: "Approved",
      confidence: 101,
      needs_review: 0,
      screenshots_json: JSON.stringify(["https://preview.ironwrap.example/models/invalid.png"]),
      captured_at: MODIFIED,
      approved_at: MODIFIED,
      modified: MODIFIED,
    }],
    "Roof Area": [],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      { ...env(), APP_VISUAL_PREVIEW_ALLOWED_ORIGINS: "https://preview.ironwrap.example" },
      auth("owner"),
      "JOB-A",
    );
    assert.deepEqual(model?.visual_model, {
      provider: null,
      model_state: "unavailable",
      confidence: null,
      review_required: true,
      approval_recorded: false,
      captured_at: null,
      approved_at: null,
      measurement_link: "unavailable",
      preview: { state: "unavailable", url: null },
    });
  } finally {
    mock.restore();
  }
});

test("estimator workbench rejects a stale visual detail that no longer belongs to the selected roof job", async () => {
  const dataset = {
    ...rows,
    "Visual Property Model": [{
      name: "VISUAL-STALE",
      roof_job: "JOB-A",
      provider: "Provider",
      status: "Approved",
      confidence: 80,
      needs_review: 0,
      screenshots_json: JSON.stringify(["https://preview.ironwrap.example/models/stale.png"]),
      captured_at: MODIFIED,
      approved_at: MODIFIED,
      modified: MODIFIED,
    }],
    "Roof Area": [],
  };
  const mock = installFrappeMock(dataset, {
    detailRows: {
      "Visual Property Model/VISUAL-STALE": {
        ...dataset["Visual Property Model"][0],
        roof_job: "JOB-OTHER",
      },
    },
  });
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      { ...env(), APP_VISUAL_PREVIEW_ALLOWED_ORIGINS: "https://preview.ironwrap.example" },
      auth("owner"),
      "JOB-A",
    );
    assert.equal(model?.visual_model?.model_state, "unavailable");
    assert.equal(model?.visual_model?.preview.url, null);
  } finally {
    mock.restore();
  }
});

test("estimator workbench does not select a visual model from a truncated source window", async () => {
  const visualModels = Array.from({ length: 100 }, (_, index) => ({
    name: `VISUAL-${index}`,
    roof_job: "JOB-A",
    provider: "Provider",
    status: "Approved",
    confidence: 80,
    needs_review: 0,
    screenshots_json: JSON.stringify(["https://preview.ironwrap.example/models/window.png"]),
    captured_at: MODIFIED,
    approved_at: MODIFIED,
    modified: MODIFIED,
  }));
  const mock = installFrappeMock({ ...rows, "Visual Property Model": visualModels, "Roof Area": [] });
  try {
    const model = await buildEstimatorWorkbenchReadModel(
      { ...env(), APP_VISUAL_PREVIEW_ALLOWED_ORIGINS: "https://preview.ironwrap.example" },
      auth("owner"),
      "JOB-A",
    );
    assert.equal(model?.visual_model?.model_state, "unavailable");
    assert.equal(
      mock.requests.some((request) => request.doctype === "Visual Property Model" && request.name !== null),
      false,
      "a partial visual window must not be promoted through a direct record read",
    );
  } finally {
    mock.restore();
  }
});

test("estimator workbench projects restricted insurance evidence without claim or storage leakage", async () => {
  const dataset = {
    ...rows,
    "Insurance Supplement": [{
      name: "SUPPLEMENT-A",
      insurance_supplement_id: "private-claim-reference",
      roof_job: "JOB-A",
      version: 1,
      status: "Ready for Human Review",
      measurement_report: "MEASURE-A",
      invoice_required: 1,
      claim_reference: "private-claim-reference",
      policy_reference: "private-policy-reference",
      adjuster_reference: "private-adjuster-reference",
      supplement_basis: "private-carrier-scope-analysis",
      evidence_manifest_json: "{\"private\":\"manifest\"}",
      approved_at: null,
      submitted_at: null,
      carrier_response_at: null,
      closed_at: null,
      modified: MODIFIED,
      evidence: [
        { evidence_item: "private-evidence-carrier", evidence_role: "Carrier Scope" },
        { evidence_item: "private-evidence-code", evidence_role: "Code/Manufacturer" },
        { evidence_item: "private-evidence-photo", evidence_role: "Photo" },
        { evidence_item: "private-evidence-invoice", evidence_role: "Invoice" },
      ],
    }],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("owner"), "JOB-A");
    assert.deepEqual(model?.insurance_supplements, [{
      presentation_key: "insurance-supplement-1",
      version: 1,
      status: "Ready for Human Review",
      measurement_state: "review_required",
      evidence_roles: ["Carrier Scope", "Code/Manufacturer", "Photo", "Invoice"],
      missing_requirements: ["approved_measurement"],
      invoice_state: "recorded",
      approval_recorded: false,
      submission_recorded: false,
      carrier_response_recorded: false,
      closed_recorded: false,
    }]);
    const serialized = JSON.stringify(model);
    for (const privateValue of [
      "private-claim-reference",
      "private-policy-reference",
      "private-adjuster-reference",
      "private-carrier-scope-analysis",
      "SUPPLEMENT-A",
      "private-evidence-carrier",
      "private-evidence-invoice",
      "manifest",
    ]) assert.equal(serialized.includes(privateValue), false);

    const list = mock.requests.find(
      (request) => request.doctype === "Insurance Supplement" && request.name === null,
    );
    assert.deepEqual(list?.fields, OFFICE_ESTIMATOR_READ_FIELDS["Insurance Supplement"]);
    for (const forbiddenField of [
      "claim_reference",
      "insurance_supplement_id",
      "policy_reference",
      "adjuster_reference",
      "supplement_basis",
      "evidence_manifest_json",
    ]) assert.equal(list?.fields.includes(forbiddenField), false);
    const detail = mock.requests.find(
      (request) => request.doctype === "Insurance Supplement" && request.name === "SUPPLEMENT-A",
    );
    assert.ok(detail);
  } finally {
    mock.restore();
  }
});

test("estimator workbench never places an internal supplement document name in stale browser state", async () => {
  const dataset = {
    ...rows,
    "Insurance Supplement": [{
      name: "SUPPLEMENT-A",
      insurance_supplement_id: "supplement_a",
      roof_job: "JOB-A",
      version: 1,
      status: "Draft",
      measurement_report: null,
      invoice_required: 1,
      approved_at: null,
      submitted_at: null,
      carrier_response_at: null,
      closed_at: null,
      modified: MODIFIED,
    }],
  };
  const mock = installFrappeMock(dataset, {
    detailRows: { "Insurance Supplement/SUPPLEMENT-A": {} },
  });
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("owner"), "JOB-A");
    assert.deepEqual(model?.insurance_supplements[0]?.missing_requirements, ["source_detail_unavailable"]);
    assert.ok(model?.stale_fields.includes("insurance_supplements.detail_unavailable"));
    assert.equal(JSON.stringify(model).includes("SUPPLEMENT-A"), false);
  } finally {
    mock.restore();
  }
});

test("estimator workbench requests restricted supplement evidence only for an owner or configured estimator identity", async () => {
  const dataset = {
    ...rows,
    "Insurance Supplement": [{
      name: "PRIVATE-SUPPLEMENT-DOCUMENT",
      insurance_supplement_id: "private-claim-reference",
      roof_job: "JOB-A",
      version: 1,
      status: "Draft",
      measurement_report: null,
      invoice_required: 1,
      approved_at: null,
      submitted_at: null,
      carrier_response_at: null,
      closed_at: null,
      modified: MODIFIED,
      evidence: [],
    }],
  };
  const unconfigured = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("ops"), "JOB-A");
    assert.deepEqual(model?.insurance_supplements, []);
    assert.equal(unconfigured.requests.some((request) => request.doctype === "Insurance Supplement"), false);
  } finally {
    unconfigured.restore();
  }

  const configured = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel({
      ...env(),
      APP_INSURANCE_ESTIMATOR_FRAPPE_USERS: "reviewer@example.com, OPS@example.com",
    }, auth("ops"), "JOB-A");
    assert.equal(model?.insurance_supplements.length, 1);
    assert.equal(model?.insurance_supplements[0]?.presentation_key, "insurance-supplement-1");
    assert.equal(JSON.stringify(model).includes("PRIVATE-SUPPLEMENT-DOCUMENT"), false);
    assert.ok(configured.requests.some((request) => request.doctype === "Insurance Supplement"));
  } finally {
    configured.restore();
  }
});

test("estimator workbench grants the draft-revision entry only for a configured isolated broker and versioned non-accepted source", async () => {
  const configured = {
    ...env(),
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_QUOTE_REVISION_BROKER_URL: "http://127.0.0.1:8789",
    APP_QUOTE_REVISION_BROKER_KEY_ID: "quote-revision-test-key",
    QUOTE_REVISION_BROKER_SHARED_SECRET: "q".repeat(48),
    APP_APPROVAL_APPROVER_ID: "owner@example.com",
    APP_APPROVAL_MAX_SESSION_AGE_SECONDS: "900",
  } as AppEnv;

  const configuredMock = installFrappeMock();
  try {
    const model = await buildEstimatorWorkbenchReadModel(configured, auth("ops"), "JOB-A");
    assert.ok(model?.allowed_actions.includes("quote_revision_approval.prepare"));
  } finally {
    configuredMock.restore();
  }

  const acceptedRows = {
    ...rows,
    "Customer Quote": rows["Customer Quote"].map((row) => ({ ...row, status: "Accepted" })),
  };
  const acceptedMock = installFrappeMock(acceptedRows);
  try {
    const accepted = await buildEstimatorWorkbenchReadModel(configured, auth("ops"), "JOB-A");
    assert.equal(accepted?.allowed_actions.includes("quote_revision_approval.prepare"), false);
  } finally {
    acceptedMock.restore();
  }

  const unversionedRows = {
    ...rows,
    "Customer Quote": rows["Customer Quote"].map((row) => ({ ...row, quote_version: null })),
  };
  const unversionedMock = installFrappeMock(unversionedRows);
  try {
    const unversioned = await buildEstimatorWorkbenchReadModel(configured, auth("ops"), "JOB-A");
    assert.equal(unversioned?.allowed_actions.includes("quote_revision_approval.prepare"), false);
  } finally {
    unversionedMock.restore();
  }
});

test("estimator workbench does not join a remeasurement to an unlinked takeoff or an older proposal", async () => {
  const dataset = {
    ...rows,
    "Measurement Report": [
      ...rows["Measurement Report"],
      {
        ...rows["Measurement Report"][0],
        name: "MEASURE-B",
        measurement_id: "measure_b",
        modified: "2026-07-12T10:00:00.000Z",
      },
    ],
    "Customer Quote": [
      ...rows["Customer Quote"],
      {
        ...rows["Customer Quote"][0],
        name: "QUOTE-OLD",
        customer_quote_id: "quote_old",
        quote_version: 2,
        modified: "2026-07-14T10:00:00.000Z",
      },
    ],
    "Proposal Evidence Pack": [
      {
        ...rows["Proposal Evidence Pack"][0],
        quotation: "QUOTE-OLD",
        modified: "2026-07-14T10:00:00.000Z",
      },
    ],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("owner"), "JOB-A");
    assert.ok(model);
    assert.equal(model.measurements.selected?.id, "measure_b");
    assert.equal(model.takeoffs.selected, null);
    assert.equal(model.lineage.measurement_to_takeoff, "mismatch");
    assert.equal(model.quote?.id, "quote_a", "highest quote_version wins over modified timestamp");
    assert.equal(model.proposal, null);
    assert.equal(model.lineage.quote_to_proposal, "mismatch");
  } finally {
    mock.restore();
  }
});

test("estimator workbench exposes immutable revision and scope-change decisions without pricing a new quote", async () => {
  const dataset = {
    ...rows,
    "Measurement Report": [{ ...rows["Measurement Report"][0] }],
    "Material Takeoff": [{ ...rows["Material Takeoff"][0], status: "Approved" }],
    "Customer Quote": [
      { ...rows["Customer Quote"][0], status: "Approved" },
      {
        ...rows["Customer Quote"][0],
        name: "QUOTE-B",
        customer_quote_id: "quote_b",
        quote_version: 4,
        status: "Approved",
        price_book_version: "2026-07-12",
        pricing_effective_at: "2026-07-12T10:00:00.000Z",
        subtotal: 12400,
        tax_amount: 620,
        quote_total: 13020,
        deposit_amount: 3000,
        amount_due: 3000,
        balance_due: 13020,
        scope_summary: "Replace roof system, flashings, and one added ridge vent.",
        assumptions: "One existing layer and clear driveway.",
        exclusions: "Deck repairs excluded pending written change order.",
        supersedes: "QUOTE-A",
        correction_reason: "Supplier price notice and revised ridge ventilation scope.",
        modified: "2026-07-14T10:00:00.000Z",
      },
    ],
    "Proposal Evidence Pack": [{
      ...rows["Proposal Evidence Pack"][0],
      name: "PACK-B",
      pack_id: "pack_b",
      quotation: "QUOTE-B",
      modified: "2026-07-14T10:00:00.000Z",
    }],
    "Change Order": [
      {
        name: "CHANGE-B",
        change_order_id: "change_b",
        roof_job: "JOB-A",
        customer_quote: "QUOTE-B",
        change_number: "CO-02",
        version: 1,
        status: "Presented",
        title: "Ridge ventilation addition",
        reason: "Field ventilation condition needs customer decision.",
        scope_delta: "Add ridge vent after written customer approval.",
        currency: "CAD",
        subtotal: 400,
        tax_amount: 20,
        total_amount: 420,
        price_book_version: "2026-07-12",
        requested_at: "2026-07-14T10:00:00.000Z",
        approved_at: "2026-07-14T10:30:00.000Z",
        accepted_at: null,
        correction_reason: null,
        tax_policy_snapshot_json: "private-change-tax-policy",
        notes: "private-change-note",
        modified: "2026-07-14T10:00:00.000Z",
      },
      {
        name: "CHANGE-A",
        change_order_id: "change_a",
        roof_job: "JOB-A",
        customer_quote: "QUOTE-A",
        change_number: "CO-01",
        version: 1,
        status: "Accepted",
        title: "Prior scope decision",
        reason: "Prior accepted condition.",
        scope_delta: "Prior accepted scope change.",
        currency: "CAD",
        subtotal: 100,
        tax_amount: 5,
        total_amount: 105,
        price_book_version: "2026-07-11",
        requested_at: MODIFIED,
        approved_at: MODIFIED,
        accepted_at: MODIFIED,
        correction_reason: null,
        modified: MODIFIED,
      },
    ],
  };
  const mock = installFrappeMock(dataset);
  try {
    const verifiedGeometry = JSON.stringify({
      source_xml: GEOMETRY_XML.replace('length="12"', 'length="10"'),
    });
    const model = await buildEstimatorWorkbenchReadModel(env(verifiedGeometry), auth("owner"), "JOB-A");
    assert.ok(model);
    assert.equal(model.measurements.selected?.geometry.state, "recomputed");
    assert.equal(model.quote?.id, "quote_b");
    assert.deepEqual(model.pricing_snapshot, {
      state: "recorded",
      quote_id: "quote_b",
      quote_version: 4,
      price_book_version: "2026-07-12",
      pricing_effective_at: "2026-07-12T10:00:00.000Z",
      valid_until: "2026-07-25",
    });
    assert.equal(model.quote_revision.state, "compared");
    assert.equal(model.quote_revision.prior_quote?.id, "quote_a");
    assert.equal(model.quote_revision.delta?.quote_total, 420);
    assert.equal(model.quote_revision.delta?.scope_summary_changed, true);
    assert.equal(model.scope_changes[0]?.quote_link, "selected_quote");
    assert.equal(model.scope_changes[0]?.status, "Presented");
    assert.equal(model.scope_changes[1]?.quote_link, "other_quote");
    assert.deepEqual(model.proposal_readiness, {
      state: "blocked",
      reasons: ["scope_change_unresolved"],
    });
    const serialized = JSON.stringify(model);
    assert.equal(serialized.includes("private-change-tax-policy"), false);
    assert.equal(serialized.includes("private-change-note"), false);
  } finally {
    mock.restore();
  }
});

test("estimator workbench fails closed when a direct report response exceeds the read boundary", async () => {
  const mock = installFrappeMock(rows, { oversizedMeasurementDetail: true });
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("ops"), "JOB-A");
    assert.ok(model);
    assert.equal(model.measurements.selected?.geometry.state, "unavailable");
    assert.equal(model.measurements.selected?.geometry.reason, "measurement_detail_too_large");
    assert.equal(model.stale_fields.includes("measurements.selected_detail"), true);
    assert.equal(JSON.stringify(model).includes(RAW_KEY), false);
  } finally {
    mock.restore();
  }
});

test("estimator workbench caps child detail rows and preserves the truncation signal", async () => {
  const dataset = {
    ...rows,
    "Measurement Report": [{
      ...rows["Measurement Report"][0],
      measurements: Array.from({ length: 350 }, (_, index) => ({
        metric: `metric_${index}`,
        value: index,
        unit: "sq ft",
        confidence: "reported",
        source_ref: "provider",
        needs_review: 0,
      })),
    }],
  };
  const mock = installFrappeMock(dataset);
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("ops"), "JOB-A");
    assert.equal(model?.measurements.selected?.metrics.length, 120);
    assert.equal(model?.measurements.selected?.metrics_truncated, true);
  } finally {
    mock.restore();
  }
});

test("estimator workbench rejects direct detail that no longer belongs to the selected roof job", async () => {
  const detailRows = {
    "Measurement Report/MEASURE-A": {
      ...rows["Measurement Report"][0],
      roof_job: "JOB-OTHER",
    },
  };
  const mock = installFrappeMock(rows, { detailRows });
  try {
    const model = await buildEstimatorWorkbenchReadModel(env(), auth("owner"), "JOB-A");
    assert.ok(model);
    assert.equal(model.measurements.selected?.geometry.reason, "measurement_detail_mismatch");
    assert.equal(model.stale_fields.includes("measurements.selected_detail"), true);
  } finally {
    mock.restore();
  }
});

test("estimator workbench bounds provider-controlled geometry labels before returning the browser DTO", async () => {
  const mock = installFrappeMock();
  try {
    const oversizedId = `F${"x".repeat(900)}`;
    const rawText = JSON.stringify({
      source_xml: GEOMETRY_XML.replace('id="F1"', `id="${oversizedId}"`),
    });
    const model = await buildEstimatorWorkbenchReadModel(env(rawText), auth("owner"), "JOB-A");
    const facetId = model?.measurements.selected?.geometry.facets[0]?.id ?? "";
    assert.equal(facetId.length, 240);
    assert.equal(facetId.endsWith("…"), true);
  } finally {
    mock.restore();
  }
});

test("estimator workbench is office-only and the HTTP route is private before it starts a Frappe read", async () => {
  const mock = installFrappeMock();
  try {
    await assert.rejects(
      async () => await buildEstimatorWorkbenchReadModel(env(), auth("field"), "JOB-A"),
      /office_scope_required/,
    );
    assert.equal(mock.requests.length, 0);

    const request = new Request("https://app.example.com/api/v1/estimator/jobs/JOB-A");
    const field = await handleAuthenticatedRoute(request, env(), auth("field"));
    assert.equal(field.status, 403);
    assert.equal(field.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await field.json(), { error: "office_role_required" });
    assert.equal(mock.requests.length, 0);

    const office = await handleAuthenticatedRoute(request, env(), auth("owner"));
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { measurements: { selected: { geometry: { state: string } } } })
        .measurements.selected.geometry.state,
      "needs_review",
    );
  } finally {
    mock.restore();
  }
});
