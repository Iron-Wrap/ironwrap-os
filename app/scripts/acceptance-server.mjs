import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST_DIR = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "4173");
const FIXTURE_FIELD_DEVICE_PROOF = "a".repeat(43);

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

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === "/healthz") {
    return sendJson(response, method, 200, { ok: true });
  }
  if (method !== "GET" && method !== "HEAD") {
    return sendJson(response, method, 405, { error: "method_not_allowed" });
  }
  if (requestUrl.pathname === "/api/v1/session") {
    return sendJson(response, method, 200, fixtureSession);
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
});

server.listen(PORT, HOST, () => {
  console.log(`IronWrap acceptance server listening at http://${HOST}:${PORT}`);
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
