import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAcceptanceCertificate } from "./acceptance-certificate.mjs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST_DIR = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "4173");
const ACCEPTANCE_MODE = process.env.ACCEPTANCE_MODE ?? "field";
const ACCEPTANCE_PROTOCOL = process.env.ACCEPTANCE_PROTOCOL ?? "http1";
const FIXTURE_FIELD_DEVICE_PROOF = "a".repeat(43);

if (!new Set(["field", "estimator"]).has(ACCEPTANCE_MODE)) {
  throw new Error(`Unsupported ACCEPTANCE_MODE: ${ACCEPTANCE_MODE}`);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const fixtureEnvelope = {
  version: 1,
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
};

const fixtureSession = {
  ...fixtureEnvelope,
  authenticated: true,
  user: {
    id: "appu_acceptance_field",
    email: "field.acceptance@example.test",
    display_name: "Acceptance Crew",
    role: "field",
    frappe_user_id: "field.acceptance@example.test",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  csrf_token: "acceptance-csrf",
  session_expires_at: "2030-07-10T12:00:00.000Z",
};

const fixtureUnauthenticatedSession = {
  ...fixtureEnvelope,
  authenticated: false,
  user: null,
  tenant: fixtureSession.tenant,
  permissions: [],
  allowed_actions: ["auth.magic_link.request", "auth.device_pairing.consume"],
  csrf_token: null,
  session_expires_at: null,
  source_updated_at: null,
};

const fixtureToday = {
  ...fixtureEnvelope,
  date: "2026-07-10",
  jobs: [
    {
      id: "JOB-ACCEPTANCE",
      job_number: "IW-ACCEPTANCE",
      brand: "IronWrap Exteriors",
      status: "In Production",
      address: "123 Acceptance Avenue, Calgary, AB",
      scheduled_start: "2026-07-10T16:00:00.000Z",
      scheduled_end: null,
      blocked_gate_count: 1,
      next_action: "Delivery confirmation is missing",
      assignment: {
        id: "ASSIGNMENT-ACCEPTANCE",
        assignment_id: "assignment-acceptance",
        type: "Production",
        status: "Assigned",
        crew_profile: null,
        scheduled_start: "2026-07-10T16:00:00.000Z",
        scheduled_end: null,
        blocker_reason: "Delivery confirmation is missing",
      },
    },
  ],
};

const fixtureJob = {
  ...fixtureEnvelope,
  allowed_actions: ["field.checkin.create", "work_package.acknowledge", "work_package.stop_work"],
  job: {
    id: "JOB-ACCEPTANCE",
    roof_job_id: "roof-job-acceptance",
    job_number: "IW-ACCEPTANCE",
    brand: "IronWrap Exteriors",
    service_type: "Roofing",
    status: "In Production",
    address: "123 Acceptance Avenue, Calgary, AB",
    current_gate_state: "Blocked",
  },
  assignment: fixtureToday.jobs[0].assignment,
  gates: [
    {
      id: "GATE-ACCEPTANCE",
      name: "Materials",
      state: "Blocked",
      blocker_reason: "Delivery confirmation is missing",
      owner: "Production dispatch",
      due_at: "2026-07-10T17:00:00.000Z",
    },
  ],
  packet: {
    scope_clauses: [
      {
        id: "SCOPE-ACCEPTANCE",
        type: "Scope",
        title: "Replace shingles",
        text: "North slope",
        version: "1",
      },
    ],
    measurements: [
      {
        id: "MEASUREMENT-ACCEPTANCE",
        provider: "RoofRuler",
        review_status: "Reviewed",
        parsed_at: "2026-07-10T15:00:00.000Z",
      },
    ],
    materials: { takeoffs: [], supplier_orders: [] },
    change_orders: [],
    safety_plan: {
      id: "SAFETY-ACCEPTANCE",
      version: 2,
      status: "Ready",
      effective_date: "2026-07-10",
      hazard_summary: "Steep-slope fall exposure",
      controls: "Use roof anchors and harnesses",
      emergency_plan: "Call dispatch and emergency services",
      ppe_requirements: "Harness and eye protection",
      weather_limits: "Stop above plan wind limit",
    },
    contact: {
      display_name: "Acceptance Homeowner",
      phone: "+14035550123",
      access_instructions: null,
    },
    work_package: {
      id: "WP-ACCEPTANCE-3",
      version: 3,
      status: "Released",
      title: "North slope replacement",
      objective: "Replace the north slope to the released drawing.",
      boundaries: "North slope only; no fascia scope.",
      prerequisites: "Materials staged and fall protection inspected.",
      expected_result: "Weather-tight completed north slope.",
      stop_conditions: "Stop for wind above the plan limit or unprotected edge exposure.",
      make_safe_procedure: "Secure loose materials and maintain the fall-protection boundary.",
      issued_at: "2026-07-10T15:00:00.000Z",
      released_at: "2026-07-10T15:15:00.000Z",
      expires_at: "2026-07-10T23:00:00.000Z",
      release_attempt_id: "wpe_acceptance_release_00000003",
      supersession: null,
      acknowledgement: {
        current_user_acknowledged: false,
        acknowledged_at: null,
        workers: [
          {
            worker_user: "field.acceptance@example.test",
            worker_role: "field",
            required: true,
            acknowledged: false,
            acknowledged_at: null,
          },
        ],
      },
      steps: [
        {
          sequence: 1,
          instruction: "Inspect anchors before roof access.",
          required_evidence: "Anchor inspection photo.",
          acceptance_criteria: "Anchor and harness connection are visible.",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Deck condition review",
          release_authority: "Production manager",
          required_evidence: "Deck condition photo.",
          acceptance_criteria: "Production manager independently releases the hold.",
          released: false,
        },
      ],
    },
  },
  proof_stream: [],
  proof_page: { next_cursor: null, page_size: 100 },
  required_proof: [
    {
      id: "GATE-ACCEPTANCE",
      slot: "Materials",
      label: "Materials proof",
      state: "Blocked",
      blocker_reason: "Delivery confirmation is missing",
    },
  ],
};

// Test-only: mirrors the browser-safe estimator read contract, never source storage identifiers.
const fixtureEstimatorEnvelope = {
  version: 1,
  source_updated_at: "2026-07-18T12:00:00.000Z",
  read_model_generated_at: "2026-07-18T12:00:01.000Z",
  stale_fields: [],
  permissions: ["sales:read", "estimator:read"],
  allowed_actions: ["sales.read", "estimator.read"],
};

const fixtureEstimatorSession = {
  ...fixtureEstimatorEnvelope,
  authenticated: true,
  user: {
    id: "appu_acceptance_owner",
    email: "owner.acceptance@example.test",
    display_name: "Acceptance Owner",
    role: "owner",
    frappe_user_id: "owner.acceptance@example.test",
  },
  tenant: fixtureSession.tenant,
  csrf_token: "estimator-acceptance-csrf",
  session_expires_at: "2030-07-18T12:00:00.000Z",
};

const fixtureEstimatorWorkbench = {
  ...fixtureEstimatorEnvelope,
  partial_sources: [],
  job: {
    id: "JOB-ESTIMATOR-ACCEPTANCE",
    roof_job_id: "roof-job-estimator-acceptance",
    job_number: "IW-EST-1001",
    brand: "IronWrap Exteriors",
    service_type: "Roof replacement",
    status: "Proposal",
    workflow_profile: "Residential Retail",
  },
  lineage: { measurement_to_takeoff: "linked", quote_to_proposal: "linked" },
  measurements: {
    reports: [
      {
        id: "MEASUREMENT-ESTIMATOR-ACCEPTANCE",
        provider: "AppliCad",
        review_status: "Needs Review",
        parsed_at: "2026-07-18T12:00:00.000Z",
        approved_at: null,
      },
    ],
    selected: {
      id: "MEASUREMENT-ESTIMATOR-ACCEPTANCE",
      provider: "AppliCad",
      review_status: "Needs Review",
      parsed_at: "2026-07-18T12:00:00.000Z",
      approved_at: null,
      metrics: [
        {
          metric: "roof_area",
          value: 2145,
          unit: "sq ft",
          confidence: "deterministic",
          source_ref: "roof facets",
          needs_review: true,
        },
      ],
      metrics_truncated: false,
      geometry: {
        state: "needs_review",
        reason: null,
        check_count: 2,
        failed_check_count: 1,
        checks_truncated: false,
        facet_count: 2,
        facets_truncated: false,
        metrics_truncated: false,
        checks: [
          {
            check: "facet_reconciliation",
            target: "South plane",
            ok: false,
            detail: "Source area requires human review.",
          },
          {
            check: "ring_closed",
            target: "North plane",
            ok: true,
            detail: "Facet boundary is closed.",
          },
        ],
        facets: [
          {
            id: "south-plane",
            type: "Roof",
            material: "Asphalt",
            pitch: 6,
            orientation: 180,
            declared_area: 1120,
            computed_area: 1115,
            deviation: 0.4,
            ring_closed: true,
          },
          {
            id: "north-plane",
            type: "Roof",
            material: "Asphalt",
            pitch: 6,
            orientation: 0,
            declared_area: 1025,
            computed_area: 1025,
            deviation: 0,
            ring_closed: true,
          },
        ],
        metrics: [{ metric: "roof_area", value: 2145, source_ref: "roof facets" }],
      },
      roof_graph: {
        state: "needs_review",
        revision: "roof_graph/v1",
        source: "Captured measurement drawing",
        provider: "AppliCad",
        confidence: 87,
        review_status: "Needs Review",
        captured_at: "2026-07-18T12:00:00.000Z",
        units: "ft",
        points: [
          { id: "p1", x: 0, y: 60 },
          { id: "p2", x: 100, y: 0 },
          { id: "p3", x: 200, y: 60 },
          { id: "p4", x: 100, y: 120 },
          { id: "p5", x: 300, y: 120 },
          { id: "p6", x: 200, y: 180 },
        ],
        edges: [
          { id: "e1", start_point_id: "p1", end_point_id: "p2" },
          { id: "e2", start_point_id: "p2", end_point_id: "p3" },
          { id: "e3", start_point_id: "p3", end_point_id: "p4" },
          { id: "e4", start_point_id: "p4", end_point_id: "p1" },
          { id: "e5", start_point_id: "p3", end_point_id: "p5" },
          { id: "e6", start_point_id: "p5", end_point_id: "p6" },
          { id: "e7", start_point_id: "p6", end_point_id: "p4" },
        ],
        facets: [
          {
            id: "south-plane",
            label: "South plane",
            point_ids: ["p1", "p2", "p3", "p4"],
            confidence: 82,
            review_status: "Needs Review",
          },
          {
            id: "north-plane",
            label: "North plane",
            point_ids: ["p4", "p3", "p5", "p6"],
            confidence: 92,
            review_status: "Approved",
          },
        ],
        check_count: 2,
        failed_check_count: 1,
      },
    },
  },
  visual_model: {
    provider: "Captured measurement drawing",
    model_state: "needs_review",
    confidence: 87,
    review_required: true,
    approval_recorded: false,
    captured_at: "2026-07-18T12:00:00.000Z",
    approved_at: null,
    measurement_link: "selected_measurement",
    preview: { state: "not_recorded", url: null },
  },
  takeoffs: {
    records: [
      {
        id: "TAKEOFF-ESTIMATOR-ACCEPTANCE",
        measurement_report_id: "MEASUREMENT-ESTIMATOR-ACCEPTANCE",
        status: "Needs Review",
        prepared_at: "2026-07-18T12:00:00.000Z",
        approved_at: null,
      },
    ],
    selected: {
      id: "TAKEOFF-ESTIMATOR-ACCEPTANCE",
      measurement_report_id: "MEASUREMENT-ESTIMATOR-ACCEPTANCE",
      status: "Needs Review",
      prepared_at: "2026-07-18T12:00:00.000Z",
      approved_at: null,
      assumptions: "One existing layer.",
      exclusions: "Deck repairs require review.",
      items: [
        {
          category: "Shingle",
          item_name: "Architectural shingles",
          quantity: 24,
          unit: "squares",
          waste_factor: 12,
          source_ref: "roof_area",
          confidence: "deterministic",
          needs_review: true,
        },
      ],
      items_truncated: false,
    },
  },
  quote: {
    id: "QUOTE-ESTIMATOR-ACCEPTANCE",
    version: 1,
    status: "Needs Review",
    price_book_version: "2026-07-18",
    pricing_effective_at: "2026-07-18T12:00:00.000Z",
    subtotal: 17450,
    tax_amount: 872.5,
    tax_code: "GST",
    tax_rate: 5,
    quote_total: 18322.5,
    currency: "CAD",
    deposit_amount: 3500,
    amount_due: 3500,
    amount_paid: 0,
    balance_due: 18322.5,
    payment_status: "Not Due",
    payment_due_date: null,
    valid_until: "2026-08-01",
    prepared_at: "2026-07-18T12:00:00.000Z",
    approved_at: null,
    accepted_at: null,
    scope_summary: "Replace roof system and flashings.",
    assumptions: "One existing layer.",
    exclusions: "Deck repairs excluded.",
    supersedes: null,
    correction_reason: null,
  },
  pricing_snapshot: {
    state: "review_required",
    quote_id: "QUOTE-ESTIMATOR-ACCEPTANCE",
    quote_version: 1,
    price_book_version: "2026-07-18",
    pricing_effective_at: "2026-07-18T12:00:00.000Z",
    valid_until: "2026-08-01",
  },
  quote_revision: { state: "not_revised", prior_quote: null, delta: null },
  proposal: {
    id: "PROPOSAL-ESTIMATOR-ACCEPTANCE",
    quote_id: "QUOTE-ESTIMATOR-ACCEPTANCE",
    status: "Draft",
    prepared_at: "2026-07-18T12:00:00.000Z",
    approved_at: null,
    signed_at: null,
    assumptions: "One existing layer.",
    exclusions: "Deck repairs excluded.",
  },
  scope_changes: [],
  insurance_supplements: [],
  proposal_readiness: {
    state: "review_required",
    reasons: ["measurement_source_review_required", "takeoff_not_approved", "quote_not_approved"],
  },
  scope_clauses: [
    {
      id: "CLAUSE-ESTIMATOR-ACCEPTANCE",
      type: "Risk",
      title: "Deck condition",
      text: "Hidden deck conditions require evidence and written approval.",
      version: "v1",
      status: "Approved",
      source_ref: "Acceptance fixture",
      customer_visible: true,
      approved_at: "2026-07-18T12:00:00.000Z",
    },
  ],
};

const requestListener = async (request, response) => {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === "/healthz") {
    return sendJson(response, method, 200, { ok: true });
  }
  if (method !== "GET" && method !== "HEAD") {
    return sendJson(response, method, 405, { error: "method_not_allowed" });
  }
  if (requestUrl.pathname === "/api/v1/session") {
    return sendJson(
      response,
      method,
      200,
      ACCEPTANCE_MODE === "estimator" ? fixtureEstimatorSession : fixtureSession,
    );
  }
  if (requestUrl.pathname === "/api/v1/field/bootstrap") {
    if (request.headers["x-ironwrap-device-proof"] !== FIXTURE_FIELD_DEVICE_PROOF) {
      return sendJson(response, method, 200, {
        version: 1,
        session: fixtureUnauthenticatedSession,
      });
    }
    return sendJson(response, method, 200, {
      version: 1,
      session: fixtureSession,
      today: fixtureToday,
    });
  }
  if (requestUrl.pathname === "/api/v1/today") {
    return sendJson(response, method, 200, fixtureToday);
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE") {
    return sendJson(response, method, 200, fixtureJob);
  }
  if (
    ACCEPTANCE_MODE === "estimator" &&
    requestUrl.pathname === "/api/v1/estimator/jobs/JOB-ESTIMATOR-ACCEPTANCE"
  ) {
    return sendJson(response, method, 200, fixtureEstimatorWorkbench);
  }
  if (requestUrl.pathname.startsWith("/api/")) {
    return sendJson(response, method, 404, { error: "fixture_route_not_found" });
  }

  try {
    const file = await findStaticFile(requestUrl.pathname);
    const body = await readFile(file.path);
    const contentType = contentTypes[extname(file.path)] ?? "application/octet-stream";
    const compressed = compressStaticBody(request.headers["accept-encoding"], contentType, body);
    const headers = {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      Vary: "Accept-Encoding",
    };
    if (compressed.encoding) headers["Content-Encoding"] = compressed.encoding;
    response.writeHead(200, headers);
    if (method !== "HEAD") response.end(compressed.body);
    else response.end();
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
};

// Browsers negotiate HTTP/2 only over TLS. Behaviour suites keep the plain HTTP/1.1
// server — the protocol does not change what the app does — while the paired-device
// Lighthouse profile serves over TLS/HTTP/2, because Cloudflare does in production and
// HTTP/1.1's six-connection cap otherwise queues this app's subresources into extra
// round trips the real device never pays. `allowHTTP1` keeps a plain client working
// against the same server, and the compatibility API means one request listener serves
// both.
const server =
  ACCEPTANCE_PROTOCOL === "h2"
    ? createSecureServer(
        { ...(await ensureAcceptanceCertificate()), allowHTTP1: true },
        requestListener,
      )
    : createServer(requestListener);

server.listen(PORT, HOST, () => {
  const scheme = ACCEPTANCE_PROTOCOL === "h2" ? "https" : "http";
  console.log(
    `IronWrap ${ACCEPTANCE_MODE} acceptance server listening at ${scheme}://${HOST}:${PORT}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function findStaticFile(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const candidate = resolve(DIST_DIR, `.${decodedPath}`);
  if (!candidate.startsWith(`${DIST_DIR}${sep}`) && candidate !== DIST_DIR) {
    throw new Error("invalid static path");
  }
  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) return { path: candidate };
  } catch {
    if (extname(candidate)) throw new Error("static file not found");
    // Client-side routes deliberately fall through to the built application shell.
  }
  return { path: resolve(DIST_DIR, "index.html") };
}

function compressStaticBody(acceptEncoding, contentType, body) {
  if (
    !/^(?:text\/(?:css|html|javascript)|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/.test(
      contentType,
    )
  ) {
    return { body, encoding: undefined };
  }
  if (acceptEncoding?.includes("br")) {
    return {
      body: brotliCompressSync(body, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      encoding: "br",
    };
  }
  if (acceptEncoding?.includes("gzip")) return { body: gzipSync(body), encoding: "gzip" };
  return { body, encoding: undefined };
}

function sendJson(response, method, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (method !== "HEAD") response.end(JSON.stringify(body));
  else response.end();
}
