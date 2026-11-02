import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAcceptanceCertificate } from "./acceptance-certificate.mjs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Field mutation fixtures (work package + safety) -- ELEC-88
//
// Until this change, the server only ever answered GET, so field-mutation
// e2e was structurally impossible: /acknowledgements, /stop-work, /start,
// /complete, /check-ins (evidence-slot capture), and /api/v1/safety/actions
// had no handlers at all. The handlers added below mirror the real routes'
// request envelope, exact-key validation, error codes/status, and the
// `{device_action_id, status:"verified", server_ref, cursor}` success shape
// from workers-bus/src/work-package-actions.ts and
// workers-bus/src/safety-actions.ts closely enough to exercise the real
// frontend code paths end to end. Known, deliberate divergences:
//
//   - Single actor drives the whole work-package journey. Production gates
//     `/complete` to a distinct owner/ops/production actor who is NOT one of
//     the acknowledging workers (see `completionReady` in
//     workers-bus/src/work-package.ts) and that role is never device-paired.
//     This fixture only ever pairs one field-role device, so it lets that
//     same session drive acknowledge -> start -> evidence -> complete. A
//     handoff to a second production actor is not exercised here.
//   - No persistence, leases, retries, or lease timeouts. The real backend
//     claims a durable per-device-action-id lease in D1; this fixture keeps
//     an in-memory idempotency map for the process lifetime.
//   - Evidence-slot capture validates the shape the real PWA actually sends
//     (typed-evidence fields, attachment presence, exact key sets) but skips
//     MIME magic-byte verification, upload rate limiting, and multi-file
//     size accounting.
//   - Safety `make_safe`/`equipment_defect` accept any referenced
//     occurrence/equipment id instead of 404ing on an unknown one.
//
// State resets per acceptance-server process. Tests needing isolation
// between cases call `POST /__acceptance__/reset` (test-only, not a real
// `/api/` route) in a beforeEach.
// ---------------------------------------------------------------------------

const DIST_DIR = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "4173");
const ACCEPTANCE_MODE = process.env.ACCEPTANCE_MODE ?? "field";
const ACCEPTANCE_PROTOCOL = process.env.ACCEPTANCE_PROTOCOL ?? "http1";
const FIXTURE_FIELD_DEVICE_PROOF = "a".repeat(43);

if (!new Set(["field", "estimator", "accounting", "onboarding"]).has(ACCEPTANCE_MODE)) {
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
    // A fictional 555-01xx number: the company profile's office phone for the emergency line.
    office_phone: "780-555-0142",
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
      active_stops: [],
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

// job|tenant|both preserve the roof-job scenarios. typed-local|typed-tenant|typed-unknown|
// typed-clear exercise the same #74 projection on a non-roof physical assignment.
const acceptanceActiveStops = {
  job: {
    occurrence_id: "so_acceptance_job_stop",
    scope: "job",
    reported_at: "2026-07-10T16:24:00.000Z",
    summary: "Ice on the north slope",
    raiser_display_name: "Tom Lachance",
  },
  tenant: {
    occurrence_id: "so_acceptance_tenant_stop",
    scope: "tenant",
    reported_at: "2026-07-10T15:50:00.000Z",
    summary: "Loose sheets on the ridge",
    raiser_display_name: "Priya Nand",
  },
  typed: {
    occurrence_id: "so_acceptance_typed_stop",
    scope: "job",
    reported_at: "2026-07-10T16:24:00.000Z",
    summary: "Loose material near the shop entrance",
    raiser_display_name: "Priya Nand",
  },
};

const fixtureTypedAssignment = {
  work_object_type: "Shop Order",
  work_object_id: "SHOP-ACCEPTANCE",
  physical_context_type: "Shop Floor",
  physical_context_id: "SHOP-FLOOR-ACCEPTANCE",
  scheduled_start: "2026-07-10T16:00:00.000Z",
  scheduled_end: null,
  next_action: "See job plan",
  assignment: {
    ...fixtureToday.jobs[0].assignment,
    id: "ASSIGNMENT-SHOP-ACCEPTANCE",
    assignment_id: "assignment-shop-acceptance",
    type: "Shop",
    blocker_reason: null,
  },
  active_stops: [],
};

function todayWithActiveStops(today) {
  const mode = process.env.ACCEPTANCE_ACTIVE_STOPS ?? "";
  const mixedPlans = process.env.ACCEPTANCE_PLAN_LIST === "mixed";
  if (!mode && !mixedPlans) return today;
  const typed = mode.startsWith("typed-");
  const unknown = mode === "typed-unknown";
  const stops = [
    ...(mode === "tenant" || mode === "both" || mode === "typed-tenant"
      ? [acceptanceActiveStops.tenant]
      : []),
    ...(mode === "job" || mode === "both" ? [acceptanceActiveStops.job] : []),
    ...(mode === "typed-local" ? [acceptanceActiveStops.typed] : []),
  ];
  // A read that includes a reported stop is built after that report. Keep the synthetic
  // response snapshot separate from the event timestamp, as the Worker's envelope does.
  const checkedAt = stops.length
    ? new Date(
        Math.max(...stops.map((stop) => Date.parse(stop.reported_at))) + 6 * 60_000,
      ).toISOString()
    : today.read_model_generated_at;
  return {
    ...today,
    read_model_generated_at: checkedAt,
    stale_fields: unknown
      ? [...today.stale_fields, "jobs.active_stops_unavailable"]
      : today.stale_fields,
    jobs: typed ? [] : today.jobs.map((job) => ({ ...job, active_stops: stops })),
    work_objects:
      typed || mixedPlans
        ? [
            {
              ...fixtureTypedAssignment,
              active_stops: unknown
                ? null
                : mixedPlans
                  ? [
                      ...stops.filter((stop) => stop.scope === "tenant"),
                      acceptanceActiveStops.typed,
                    ]
                  : stops,
            },
          ]
        : (today.work_objects ?? []),
  };
}

const fixtureOperatingIntake = {
  version: 1,
  operating_authority: "d1",
  tenant_id: "ironwrap",
  generated_at: "2026-08-21T16:00:00.000Z",
  leads: [],
};

/**
 * What an administrator configured for this account, as the record route publishes it
 * (`GET /api/v1/schema-fields/:entityType/:entityId`). Two field-key namespaces so the acceptance
 * run exercises more than one service type on a single job, plus a dependent field whose
 * controlling value does not match — the server would omit that one, and this fixture omits it the
 * same way rather than letting the client decide.
 *
 * `writable` is the server's derived per-field answer (ELEC-192): computed there from the caller's
 * role against the field's `write_roles`, published here as the finished boolean. The crew role
 * this fixture signs in as may write four of these fields and not the fifth, which is what lets
 * the acceptance run prove both the edit affordance and its absence on one card.
 *
 * The values are mutable because the write half needs somewhere to land. State resets per process
 * or through `POST /__acceptance/schema-card/reset`.
 */
function freshJobSchemaCard() {
  return {
    entity_type: "job",
    entity_id: "roof-job-acceptance",
    fields: [
      // Evidence-classed: a change to it after someone else moved it must be recorded as an
      // explicit correction, not a replacement.
      schemaCardField("roofing.deck_condition", "Deck condition", 0, "text", {
        value: "Sound, two soft sheets",
        writable: true,
        evidenceClass: "physical",
        offlineMode: "queueable",
      }),
      schemaCardField("roofing.underlayment", "Underlayment", 1, "text", {
        value: "Synthetic",
        writable: true,
        offlineMode: "queueable",
      }),
      schemaCardField("gutters.linear_feet", "Linear feet", 2, "integer", {
        value: 142,
        writable: true,
        offlineMode: "queueable",
        validatorKey: "range",
        validatorConfig: { min: 1, max: 400 },
      }),
      schemaCardField("gutters.downspouts", "Downspouts", 3, "integer", { value: 6 }),
      schemaCardField("permit_number", "Permit number", 4, "text", {
        value: null,
        writable: true,
        offlineMode: "queueable",
      }),
      // Readable by the crew, writable only by the office. The card must render it with no edit
      // control at all rather than one that 403s.
      schemaCardField("office_notes", "Office notes", 5, "text", {
        value: "Invoice on completion",
      }),
    ],
  };
}

function schemaCardField(fieldKey, label, position, fieldType, options = {}) {
  const {
    value = null,
    writable = false,
    evidenceClass = "none",
    retentionPolicy = "standard",
    offlineMode = "offline_read",
    validatorKey = "none",
    validatorConfig = {},
  } = options;
  return {
    writable,
    definition: {
      field_id: `fld_${fieldKey}`,
      field_key: fieldKey,
      revision_id: `rev_${fieldKey}`,
      version: 1,
      label,
      position,
      field_type: fieldType,
      validator_key: validatorKey,
      validator_config: validatorConfig,
      visibility_key: "always",
      visibility_config: {},
      evidence_class: evidenceClass,
      retention_policy: retentionPolicy,
      offline_mode: offlineMode,
    },
    value:
      value === null
        ? null
        : {
            value_revision_id: `val_${fieldKey}_1`,
            field_definition_revision_id: `rev_${fieldKey}`,
            version: 1,
            prior_value_revision_id: null,
            based_on_value_revision_id: null,
            correction_reason: null,
            value,
            value_digest: `digest_${fieldKey}`,
            provenance_actor_type: "owner",
            created_at: "2026-08-27T18:00:00.000Z",
          },
  };
}

/**
 * The documents an administrator authored for a job, as the record document route publishes them
 * (`GET /api/v1/documents/:entityType/:entityId`). Layout only — headings, prose and bindings.
 * Values never travel here; the acceptance run joins them from the schema-card fixture above, the
 * same way the client does, so a binding this reader was not authorized for has nothing to render.
 *
 * `fld_margin_band` is deliberately absent from the schema-card fixture: it is the withheld line.
 * `fld_office_notes` is present there but bound by no block here, so a field the crew may read and
 * not write stays a card concern and never becomes a document line.
 */
const fixtureJobDocuments = {
  entity_type: "job",
  entity_id: "roof-job-acceptance",
  documents: [
    {
      template_id: "tpl_materials_list",
      template_key: "materials_list",
      label: "Materials list",
      revision_id: "rev_tpl_materials_1",
      version: 1,
      blocks: [
        { kind: "heading", level: 1, text: "Order for the shop" },
        { kind: "field", field_id: "fld_roofing.underlayment" },
        { kind: "field", field_id: "fld_gutters.linear_feet" },
        { kind: "field", field_id: "fld_gutters.downspouts" },
        { kind: "field", field_id: "fld_permit_number" },
        { kind: "field", field_id: "fld_margin_band" },
        { kind: "text", text: "Confirm counts with the shop before the truck is loaded." },
      ],
    },
  ],
};

let jobSchemaCardState = freshJobSchemaCard();

/**
 * The governed record-value write, close enough to `recordSchemaFieldValue` for the acceptance run
 * to exercise the client against real refusals: role authority, the administrator's own validator,
 * and the optimistic-concurrency token. Everything it refuses, it refuses with the server's own
 * error code, because the client's copy is written against those codes and not against prose.
 */
function handleSchemaCardWrite(fieldId, body) {
  const entry = jobSchemaCardState.fields.find((field) => field.definition.field_id === fieldId);
  if (!entry) return jsonFixtureResponse(404, { error: "schema_field_not_found" });
  if (!entry.writable) return jsonFixtureResponse(403, { error: "schema_field_write_forbidden" });

  const currentVersion = entry.value?.version ?? 0;
  if (body?.expected_version !== currentVersion) {
    return jsonFixtureResponse(409, {
      error: "schema_field_value_version_conflict",
      expected_version: body?.expected_version ?? null,
      current_version: currentVersion,
    });
  }

  const basedOn = body?.based_on_value_revision_id ?? null;
  const reason = body?.correction_reason ?? null;
  if ((basedOn === null) !== (reason === null)) {
    return jsonFixtureResponse(400, {
      error:
        basedOn === null
          ? "schema_field_correction_reference_required"
          : "schema_field_correction_reason_required",
    });
  }

  const { validator_key: validatorKey, validator_config: validatorConfig } = entry.definition;
  const submitted = body?.value ?? null;
  if (validatorKey === "required" && (submitted === null || submitted === "")) {
    return jsonFixtureResponse(400, { error: "schema_field_required" });
  }
  if (validatorKey === "range" && submitted !== null) {
    const numeric = Number(submitted);
    const belowMinimum = validatorConfig.min !== undefined && numeric < validatorConfig.min;
    const aboveMaximum = validatorConfig.max !== undefined && numeric > validatorConfig.max;
    if (!Number.isFinite(numeric) || belowMinimum || aboveMaximum) {
      return jsonFixtureResponse(400, { error: "schema_field_range_invalid" });
    }
  }

  const version = currentVersion + 1;
  entry.value = {
    value_revision_id: `val_${entry.definition.field_key}_${version}`,
    field_definition_revision_id: entry.definition.revision_id,
    version,
    prior_value_revision_id: entry.value?.value_revision_id ?? null,
    based_on_value_revision_id: basedOn,
    correction_reason: reason,
    value: submitted,
    value_digest: `digest_${entry.definition.field_key}_${version}`,
    provenance_actor_type: "worker",
    created_at: isoNow(),
  };
  return jsonFixtureResponse(201, { outcome: "created", value: entry.value });
}

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
      emergency_plan:
        "Meet at the front of the driveway. Nearest hospital: 12 minutes by road; the route is on the job map.",
      ppe_requirements: "Harness and eye protection",
      weather_limits: "Stop work above 40 km/h wind or 60 km/h gusts",
    },
    contact: {
      display_name: "Acceptance Homeowner",
      phone: "+14035550123",
      access_instructions: null,
    },
    work_package: {
      id: "WP-ACCEPTANCE-3",
      work_object_type: "Roof Job",
      work_object_id: "JOB-ACCEPTANCE",
      physical_context_type: "Roof Site",
      physical_context_id: "JOB-ACCEPTANCE",
      version: 3,
      status: "Released",
      title: "North slope replacement",
      objective: "Replace the north slope to the released drawing.",
      boundaries: "North slope only; no fascia scope.",
      prerequisites: "Materials staged and fall protection inspected.",
      expected_result: "Weather-tight completed north slope.",
      stop_conditions:
        "Stop for wind above 40 km/h, gusts above 60 km/h, or unprotected edge exposure.",
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
          // Deliberately not "Pre-start" (field-contracts.ts's zod default for an
          // omitted release_phase): a Pre-start hold with no release UI in this
          // app would permanently block `work_package.start`, which is exactly
          // the state the offline test at field-pwa.spec.ts:86 exercises. This
          // fixture's happy-path journey (ELEC-88) needs `start` reachable, so
          // the hold is modeled as a completion-phase hold instead -- still
          // unreleased, still "this app cannot release the hold point", just not
          // a start-time blocker.
          release_phase: "Completion",
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

const FIXTURE_CSRF_TOKEN = fixtureSession.csrf_token;
const FIXTURE_ASSIGNMENT_ID = "ASSIGNMENT-ACCEPTANCE";
const FIXTURE_WORK_PACKAGE_ID = "WP-ACCEPTANCE-3";
const FIXTURE_WORK_PACKAGE_VERSION = 3;
const FIXTURE_RELEASE_ATTEMPT_ID = "wpe_acceptance_release_00000003";
const FIXTURE_WORKER_USER = fixtureSession.user.frappe_user_id;

function freshFieldMutableState() {
  return {
    workPackage: {
      status: "Released",
      currentUserAcknowledged: false,
      acknowledgedAt: null,
      blockerReason: null,
      evidenceSlots: [],
    },
    safety: {
      equipment: [
        {
          equipment_id: "eq_harness_0001",
          equipment_kind: "fall_arrest_harness",
          serial_number: "SN-ACCEPTANCE-0001",
          status: "in_service",
          inspection_due_at: null,
        },
      ],
      occurrences: [],
    },
    workPackageActions: new Map(),
    safetyActions: new Map(),
    evidenceCounter: 0,
    occurrenceCounter: 0,
  };
}

let fieldMutableState = freshFieldMutableState();

function resetFieldMutableState() {
  fieldMutableState = freshFieldMutableState();
  jobSchemaCardState = freshJobSchemaCard();
}

function isoNow() {
  return new Date().toISOString();
}

async function readRequestBuffer(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function jsonFixtureResponse(status, value, headers = {}) {
  return {
    status,
    body: JSON.stringify(value),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...headers,
    },
  };
}

function fixtureError(status, error, message, headers) {
  return jsonFixtureResponse(status, message ? { error, message } : { error }, headers);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value).sort();
  const wanted = [...allowed].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function checkCsrf(request) {
  return request.headers["x-csrf-token"] === FIXTURE_CSRF_TOKEN;
}

function checkDeviceProof(request) {
  return request.headers["x-ironwrap-device-proof"] === FIXTURE_FIELD_DEVICE_PROOF;
}

function checkActionIdHeaders(request, deviceActionId) {
  const headerActionId = request.headers["x-device-action-id"];
  const idempotencyKey = request.headers["idempotency-key"];
  if (headerActionId !== undefined && headerActionId !== deviceActionId) return false;
  if (idempotencyKey !== undefined && idempotencyKey !== deviceActionId) return false;
  return true;
}

// ---- Work package actions (acknowledgements / stop-work / start / complete) ----

const WORK_PACKAGE_REQUIRED_KEYS = {
  acknowledge: ["work_package_id", "work_package_version", "release_attempt_id"],
  start_work: ["work_package_id", "work_package_version", "release_attempt_id"],
  complete_work: ["work_package_id", "work_package_version", "release_attempt_id"],
  stop_work: ["work_package_id", "work_package_version", "blocker_reason"],
};

const WORK_PACKAGE_ALLOWED_KEYS = {
  acknowledge: ["work_package_id", "work_package_version", "release_attempt_id"],
  start_work: ["work_package_id", "work_package_version", "release_attempt_id"],
  complete_work: ["work_package_id", "work_package_version", "release_attempt_id"],
  stop_work: ["work_package_id", "work_package_version", "release_attempt_id", "blocker_reason"],
};

function invalidWorkPackageAction() {
  return fixtureError(400, "invalid_work_package_action", "The work-package action is invalid.");
}

async function handleWorkPackageActionRoute(request, kind) {
  if (!checkDeviceProof(request)) return fixtureError(401, "unauthorized");
  if (!checkCsrf(request)) return fixtureError(403, "csrf_failed");
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return invalidWorkPackageAction();
  }
  const buffer = await readRequestBuffer(request);
  let decoded;
  try {
    decoded = JSON.parse(buffer.toString("utf8"));
  } catch {
    return invalidWorkPackageAction();
  }
  if (!isRecord(decoded) || !exactKeys(decoded, ["device_action_id", "payload"])) {
    return invalidWorkPackageAction();
  }
  const deviceActionId = decoded.device_action_id;
  if (
    typeof deviceActionId !== "string" ||
    deviceActionId.length < 8 ||
    deviceActionId.length > 80
  ) {
    return invalidWorkPackageAction();
  }
  if (!checkActionIdHeaders(request, deviceActionId)) return invalidWorkPackageAction();
  const payload = decoded.payload;
  if (!isRecord(payload)) return invalidWorkPackageAction();
  const required = WORK_PACKAGE_REQUIRED_KEYS[kind];
  const allowed = WORK_PACKAGE_ALLOWED_KEYS[kind];
  const suppliedKeys = Object.keys(payload);
  if (
    !required.every((key) => suppliedKeys.includes(key)) ||
    suppliedKeys.some((key) => !allowed.includes(key))
  ) {
    return invalidWorkPackageAction();
  }
  if (payload.work_package_id !== FIXTURE_WORK_PACKAGE_ID) {
    return fixtureError(
      404,
      "work_package_not_available",
      "No current work package is available for this assignment.",
    );
  }
  if (
    typeof payload.work_package_version !== "number" ||
    !Number.isInteger(payload.work_package_version) ||
    payload.work_package_version !== FIXTURE_WORK_PACKAGE_VERSION
  ) {
    return fixtureError(
      404,
      "work_package_not_available",
      "No current work package is available for this assignment.",
    );
  }
  if (kind === "stop_work") {
    if (typeof payload.blocker_reason !== "string" || payload.blocker_reason.trim().length < 1) {
      return invalidWorkPackageAction();
    }
  } else if (
    typeof payload.release_attempt_id !== "string" ||
    payload.release_attempt_id !== FIXTURE_RELEASE_ATTEMPT_ID
  ) {
    return invalidWorkPackageAction();
  }

  const payloadHash = JSON.stringify(payload);
  const existing = fieldMutableState.workPackageActions.get(deviceActionId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return fixtureError(
        409,
        "idempotency_conflict",
        "This device action id is already bound to a different work-package action.",
      );
    }
    return jsonFixtureResponse(200, existing.response);
  }

  const wp = fieldMutableState.workPackage;
  const notAllowed = () =>
    fixtureError(
      409,
      "work_package_action_not_allowed",
      "That work-package action is no longer allowed.",
    );

  if (kind === "acknowledge") {
    if (wp.currentUserAcknowledged || !["Released", "Acknowledged"].includes(wp.status))
      return notAllowed();
    wp.currentUserAcknowledged = true;
    wp.acknowledgedAt = isoNow();
    if (wp.status === "Released") wp.status = "Acknowledged";
  } else if (kind === "start_work") {
    if (wp.status !== "Acknowledged" || !wp.currentUserAcknowledged) return notAllowed();
    wp.status = "In Progress";
  } else if (kind === "complete_work") {
    const hasEvidence = wp.evidenceSlots.some((item) => !item.superseded);
    if (wp.status !== "In Progress" || !hasEvidence) return notAllowed();
    wp.status = "Completed";
  } else {
    if (!["Released", "Acknowledged", "In Progress"].includes(wp.status)) return notAllowed();
    wp.status = "Blocked";
    wp.blockerReason = payload.blocker_reason;
  }

  const response = {
    device_action_id: deviceActionId,
    status: "verified",
    server_ref: FIXTURE_WORK_PACKAGE_ID,
    cursor: `wpe_${kind}_${fieldMutableState.workPackageActions.size + 1}`,
  };
  fieldMutableState.workPackageActions.set(deviceActionId, { payloadHash, response });
  return jsonFixtureResponse(200, response);
}

// ---- Safety actions ----

const SAFETY_ACTION_KINDS = [
  "report_occurrence",
  "make_safe",
  "equipment_defect",
  "rescue_request",
];
const SAFETY_SCOPE_TYPES = ["tenant", "roof_job", "work_package", "shop", "vehicle"];
const SAFETY_OCCURRENCE_KINDS = ["injury", "near_miss", "hazard", "environmental", "emergency"];
const SAFETY_SEVERITIES = ["low", "moderate", "high", "critical"];
const SAFETY_REQUIRED_PAYLOAD_KEYS = {
  report_occurrence: ["detail", "occurrence_kind", "severity"],
  make_safe: ["detail", "occurrence_id"],
  equipment_defect: ["detail", "equipment_id"],
  rescue_request: ["detail"],
};

function invalidSafetyAction() {
  return fixtureError(400, "invalid_safety_action", "The safety action is invalid.");
}

async function handleSafetyActionRoute(request) {
  if (!checkDeviceProof(request)) return fixtureError(401, "unauthorized");
  if (!checkCsrf(request)) return fixtureError(403, "csrf_failed");
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return invalidSafetyAction();
  }
  const buffer = await readRequestBuffer(request);
  let decoded;
  try {
    decoded = JSON.parse(buffer.toString("utf8"));
  } catch {
    return invalidSafetyAction();
  }
  if (!isRecord(decoded) || !exactKeys(decoded, ["device_action_id", "payload"]))
    return invalidSafetyAction();
  const deviceActionId = decoded.device_action_id;
  if (
    typeof deviceActionId !== "string" ||
    deviceActionId.length < 8 ||
    deviceActionId.length > 80
  ) {
    return invalidSafetyAction();
  }
  if (!checkActionIdHeaders(request, deviceActionId)) return invalidSafetyAction();
  const payload = decoded.payload;
  if (!isRecord(payload)) return invalidSafetyAction();
  const kind = payload.kind;
  if (typeof kind !== "string" || !SAFETY_ACTION_KINDS.includes(kind)) return invalidSafetyAction();
  const scopeType = payload.scope_type;
  if (typeof scopeType !== "string" || !SAFETY_SCOPE_TYPES.includes(scopeType))
    return invalidSafetyAction();
  if (typeof payload.scope_id !== "string" || payload.scope_id.length < 1)
    return invalidSafetyAction();
  if (typeof payload.captured_at !== "string" || Number.isNaN(Date.parse(payload.captured_at))) {
    return invalidSafetyAction();
  }
  const envelopeKeys = ["kind", "scope_type", "scope_id", "captured_at"];
  const required = SAFETY_REQUIRED_PAYLOAD_KEYS[kind];
  const allowed = [...envelopeKeys, ...required];
  const suppliedKeys = Object.keys(payload);
  if (
    !required.every((key) => suppliedKeys.includes(key)) ||
    suppliedKeys.some((key) => !allowed.includes(key))
  ) {
    return invalidSafetyAction();
  }
  if (
    typeof payload.detail !== "string" ||
    payload.detail.trim().length < 3 ||
    payload.detail.length > 4000
  ) {
    return invalidSafetyAction();
  }
  if (kind === "report_occurrence") {
    if (
      typeof payload.occurrence_kind !== "string" ||
      !SAFETY_OCCURRENCE_KINDS.includes(payload.occurrence_kind) ||
      typeof payload.severity !== "string" ||
      !SAFETY_SEVERITIES.includes(payload.severity)
    ) {
      return invalidSafetyAction();
    }
  }
  if (
    kind === "make_safe" &&
    (typeof payload.occurrence_id !== "string" || payload.occurrence_id.length < 3)
  ) {
    return invalidSafetyAction();
  }
  if (
    kind === "equipment_defect" &&
    (typeof payload.equipment_id !== "string" || payload.equipment_id.length < 3)
  ) {
    return invalidSafetyAction();
  }

  const payloadHash = JSON.stringify(payload);
  const existing = fieldMutableState.safetyActions.get(deviceActionId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return fixtureError(
        409,
        "idempotency_conflict",
        "This device action id is already bound to a different safety action.",
      );
    }
    return jsonFixtureResponse(200, existing.response);
  }

  let serverRef;
  const safety = fieldMutableState.safety;
  if (kind === "report_occurrence" || kind === "rescue_request") {
    fieldMutableState.occurrenceCounter += 1;
    const occurrenceId = `so_acceptance_${fieldMutableState.occurrenceCounter}`;
    const occurrenceKind = kind === "rescue_request" ? "emergency" : payload.occurrence_kind;
    const severity = kind === "rescue_request" ? "critical" : payload.severity;
    safety.occurrences.push({
      occurrence_id: occurrenceId,
      occurrence_kind: occurrenceKind,
      severity,
      state: "reported",
      stop_active: kind === "rescue_request" || severity === "critical",
      scope_type: scopeType,
      scope_id: payload.scope_id,
      summary: payload.detail,
    });
    serverRef = occurrenceId;
  } else if (kind === "make_safe") {
    const occurrence = safety.occurrences.find(
      (item) => item.occurrence_id === payload.occurrence_id,
    );
    if (occurrence) {
      occurrence.state = "made_safe";
      occurrence.stop_active = false;
    }
    serverRef = payload.occurrence_id;
  } else {
    let equipment = safety.equipment.find((item) => item.equipment_id === payload.equipment_id);
    if (!equipment) {
      equipment = {
        equipment_id: payload.equipment_id,
        equipment_kind: "unspecified",
        serial_number: "unspecified",
        status: "defective",
        inspection_due_at: null,
      };
      safety.equipment.push(equipment);
    } else {
      equipment.status = "defective";
    }
    serverRef = payload.equipment_id;
  }

  const response = {
    device_action_id: deviceActionId,
    status: "verified",
    server_ref: serverRef,
    cursor: `${serverRef}:1`,
  };
  fieldMutableState.safetyActions.set(deviceActionId, { payloadHash, response });
  return jsonFixtureResponse(200, response);
}

function buildSafetyPanelPayload() {
  return {
    version: 1,
    panel: {
      version: 1,
      actor_role: fixtureSession.user.role,
      assigned_equipment: fieldMutableState.safety.equipment,
      open_occurrences: fieldMutableState.safety.occurrences.filter(
        (item) => item.state !== "closed",
      ),
      my_corrective_actions: [],
      allowed_actions: [
        "safety.report_occurrence",
        "safety.make_safe",
        "safety.equipment_defect",
        "safety.rescue_request",
      ],
    },
  };
}

// ---- Evidence-slot capture (check-ins) ----

async function handleCheckInRoute(request) {
  if (!checkDeviceProof(request)) return fixtureError(401, "unauthorized");
  if (!checkCsrf(request)) return fixtureError(403, "csrf_failed");
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return fixtureError(415, "multipart_required", "Field actions require multipart form data.");
  }
  const buffer = await readRequestBuffer(request);
  let form;
  try {
    const fetchRequest = new Request("http://acceptance.local/check-ins", {
      method: "POST",
      headers: { "content-type": contentType },
      body: buffer,
    });
    form = await fetchRequest.formData();
  } catch {
    return fixtureError(400, "invalid_multipart", "The field action could not be read.");
  }
  const metadataRaw = form.get("metadata");
  if (typeof metadataRaw !== "string") return fixtureError(400, "invalid_metadata");
  let decoded;
  try {
    decoded = JSON.parse(metadataRaw);
  } catch {
    return fixtureError(400, "invalid_metadata");
  }
  // The real outbox-processor.ts metadata envelope also carries an `attachments`
  // array (blobKey stripped) alongside device_action_id/payload -- unlike the
  // two-key JSON envelope every other mutation route uses.
  if (!isRecord(decoded) || !exactKeys(decoded, ["device_action_id", "payload", "attachments"])) {
    return fixtureError(400, "invalid_metadata");
  }
  const deviceActionId = decoded.device_action_id;
  if (typeof deviceActionId !== "string" || deviceActionId.length < 8) {
    return fixtureError(400, "invalid_metadata");
  }
  if (!checkActionIdHeaders(request, deviceActionId)) return fixtureError(400, "invalid_metadata");
  const payload = decoded.payload;
  if (!isRecord(payload)) return fixtureError(400, "invalid_metadata");
  if (payload.assignment_id !== FIXTURE_ASSIGNMENT_ID) {
    return fixtureError(
      409,
      "assignment_changed",
      "This check-in is bound to a different assignment.",
    );
  }
  const attachments = form.getAll("attachments");
  const typedEvidence = payload.work_package_id != null || payload.evidence_slot_id != null;
  if (typedEvidence) {
    if (
      !payload.work_package_id ||
      !payload.evidence_slot_id ||
      !payload.work_package_version ||
      !payload.work_package_release_attempt_id ||
      !payload.evidence_requirement ||
      !payload.evidence_source
    ) {
      return fixtureError(400, "invalid_metadata");
    }
    if (payload.work_package_release_attempt_id !== FIXTURE_RELEASE_ATTEMPT_ID) {
      return fixtureError(
        409,
        "evidence_release_attempt_missing",
        "The work package has been re-released since this evidence link was issued.",
      );
    }
    if (attachments.length === 0) {
      return fixtureError(
        400,
        "evidence_attachment_required",
        "A Work Package evidence slot requires at least one photo or voice attachment.",
      );
    }
    if (payload.evidence_correction_of && attachments.length !== 1) {
      return fixtureError(
        400,
        "evidence_correction_attachment_count",
        "A correction must contain exactly one attachment.",
      );
    }
  } else if (attachments.length === 0 && !payload.notes && !payload.blocker) {
    return fixtureError(400, "invalid_metadata");
  }

  const payloadHash = JSON.stringify({ payload, attachmentCount: attachments.length });
  const existing = fieldMutableState.workPackageActions.get(deviceActionId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return fixtureError(
        409,
        "idempotency_conflict",
        "This device action id is already bound to a different check-in.",
      );
    }
    return jsonFixtureResponse(200, existing.response);
  }

  const checkinId = `fci_acceptance_${fieldMutableState.workPackageActions.size + 1}`;
  const media = [];
  for (const attachment of attachments) {
    fieldMutableState.evidenceCounter += 1;
    media.push({
      attachment_id: `att-${fieldMutableState.evidenceCounter}`,
      evidence_id: `evi_acceptance_${fieldMutableState.evidenceCounter}`,
      checksum_sha256: "0".repeat(64),
      content_length: typeof attachment.size === "number" ? attachment.size : 0,
    });
  }

  if (typedEvidence) {
    const eventId = `WPE-EVIDENCE-${fieldMutableState.workPackage.evidenceSlots.length + 1}`;
    const evidenceItem = `EVIDENCE-ITEM-${fieldMutableState.workPackage.evidenceSlots.length + 1}`;
    if (payload.evidence_correction_of) {
      const prior = fieldMutableState.workPackage.evidenceSlots.find(
        (item) => item.event_id === payload.evidence_correction_of,
      );
      if (prior) prior.superseded = true;
    }
    fieldMutableState.workPackage.evidenceSlots.push({
      event_id: eventId,
      evidence_item: evidenceItem,
      slot_id: payload.evidence_slot_id,
      requirement: payload.evidence_requirement,
      source: payload.evidence_source,
      actor_user: FIXTURE_WORKER_USER,
      device_id: "device-acceptance-0001",
      captured_at: payload.capture_completed_at ?? isoNow(),
      freshness: "Current",
      conflict_state: "None",
      correction_of: payload.evidence_correction_of ?? null,
      evidence_item_correction_of: payload.evidence_item_correction_of ?? null,
      review_reason: null,
      verification: "Verified",
      disposition: "Open",
      correction_reason: payload.correction_reason ?? null,
      superseded: false,
    });
  }

  const response = {
    device_action_id: deviceActionId,
    status: "verified",
    server_ref: checkinId,
    cursor: checkinId,
    checkin_id: checkinId,
    media,
  };
  fieldMutableState.workPackageActions.set(deviceActionId, { payloadHash, response });
  return jsonFixtureResponse(200, response);
}

// ---- Dynamic job read model ----

function computeWorkPackageAllowedActions() {
  const wp = fieldMutableState.workPackage;
  const actions = ["field.checkin.create"];
  if ((wp.status === "Released" || wp.status === "Acknowledged") && !wp.currentUserAcknowledged) {
    actions.push("work_package.acknowledge");
  }
  if (wp.status === "Acknowledged" && wp.currentUserAcknowledged) {
    actions.push("work_package.start");
  }
  if (["Released", "Acknowledged", "In Progress"].includes(wp.status)) {
    actions.push("work_package.stop_work");
  }
  if (wp.status === "In Progress" && wp.evidenceSlots.some((item) => !item.superseded)) {
    actions.push("work_package.complete");
  }
  return actions;
}

// field-contracts.ts's workPackageSchema only accepts status "Released" |
// "Acknowledged" | "In Progress" (workers-bus/src/frappe-read.ts
// FIELD_WORK_PACKAGE_CURRENT_STATUSES): the "current work package" query
// backing this read model excludes terminal packages entirely. A completed
// or stopped-to-blocked package therefore does not read back with its
// status intact -- it reads back as no current package at all, same as the
// "No current released Work Package" branch this app already renders.
const CURRENT_WORK_PACKAGE_STATUSES = ["Released", "Acknowledged", "In Progress"];

function buildFixtureJobResponse() {
  const model = structuredClone(fixtureJob);
  if (process.env.ACCEPTANCE_SITE_SAFETY_MISSING === "1") {
    model.packet.safety_plan = null;
    model.stale_fields.push("packet.safety_plan.native_unavailable");
  }
  const wp = fieldMutableState.workPackage;
  if (!CURRENT_WORK_PACKAGE_STATUSES.includes(wp.status)) {
    model.packet.work_package = null;
    model.allowed_actions = ["field.checkin.create"];
    return model;
  }
  const workPackage = model.packet.work_package;
  workPackage.status = wp.status;
  workPackage.acknowledgement.current_user_acknowledged = wp.currentUserAcknowledged;
  workPackage.acknowledgement.acknowledged_at = wp.acknowledgedAt;
  workPackage.acknowledgement.workers[0].acknowledged = wp.currentUserAcknowledged;
  workPackage.acknowledgement.workers[0].acknowledged_at = wp.acknowledgedAt;
  workPackage.evidence_slots = wp.evidenceSlots;
  model.allowed_actions = computeWorkPackageAllowedActions();
  return model;
}

/** Synthetic instance of the existing universal GET projection; it supplies no lifecycle grant. */
function buildFixtureWorkObjectResponse() {
  const job = buildFixtureJobResponse();
  const plan = job.packet.work_package;
  return {
    ...fixtureEnvelope,
    allowed_actions: ["field.checkin.create"],
    work_object: {
      workObjectType: fixtureTypedAssignment.work_object_type,
      workObjectId: fixtureTypedAssignment.work_object_id,
      physicalContextType: fixtureTypedAssignment.physical_context_type,
      physicalContextId: fixtureTypedAssignment.physical_context_id,
    },
    assignment: fixtureTypedAssignment.assignment,
    work_package: plan
      ? {
          ...plan,
          id: "WP-SHOP-ACCEPTANCE-3",
          title: "Synthetic shop panel handling",
          objective: "Move the synthetic panels within the training shop.",
          boundaries: "Training shop only; no roof work.",
          prerequisites: "Inspect the rack and keep the walkway clear.",
          expected_result: "Panels secured in the training rack.",
          stop_conditions: "Stop if loose stock enters the walkway.",
          make_safe_procedure: "Secure loose stock, close the walkway and contact the office.",
          work_object_type: fixtureTypedAssignment.work_object_type,
          work_object_id: fixtureTypedAssignment.work_object_id,
          physical_context_type: fixtureTypedAssignment.physical_context_type,
          physical_context_id: fixtureTypedAssignment.physical_context_id,
          steps: [
            {
              sequence: 1,
              instruction: "Inspect the training rack before handling panels.",
              required_evidence: "Training rack inspection record.",
              acceptance_criteria: "The rack and walkway controls are present.",
            },
          ],
        }
      : null,
  };
}

// ---- POST route dispatch for the fixtures above ----

async function routeFieldMutation(request, requestUrl) {
  if (requestUrl.pathname === "/__acceptance__/reset") {
    resetFieldMutableState();
    return jsonFixtureResponse(200, { ok: true });
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE/work-package/acknowledgements") {
    return handleWorkPackageActionRoute(request, "acknowledge");
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE/work-package/stop-work") {
    return handleWorkPackageActionRoute(request, "stop_work");
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE/work-package/start") {
    return handleWorkPackageActionRoute(request, "start_work");
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE/work-package/complete") {
    return handleWorkPackageActionRoute(request, "complete_work");
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE/check-ins") {
    return handleCheckInRoute(request);
  }
  if (requestUrl.pathname === "/api/v1/safety/actions") {
    return handleSafetyActionRoute(request);
  }
  if (requestUrl.pathname === "/__acceptance/schema-card/reset") {
    jobSchemaCardState = freshJobSchemaCard();
    return jsonFixtureResponse(200, { ok: true });
  }
  const schemaWrite = requestUrl.pathname.match(
    /^\/api\/v1\/schema-fields\/job\/roof-job-acceptance\/([^/]+)\/values$/,
  );
  if (schemaWrite) {
    return handleSchemaCardWrite(decodeURIComponent(schemaWrite[1]), await readJsonBody(request));
  }
  return null;
}

function sendPreparedJson(response, method, prepared) {
  response.writeHead(prepared.status, prepared.headers);
  if (method !== "HEAD") response.end(prepared.body);
  else response.end();
}

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
  permissions: [...fixtureEstimatorEnvelope.permissions, "sales:lead_create"],
  allowed_actions: [...fixtureEstimatorEnvelope.allowed_actions, "sales.lead.create"],
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

function currentFixtureSession() {
  if (ACCEPTANCE_MODE === "estimator") return fixtureEstimatorSession;
  if (ACCEPTANCE_MODE === "accounting") return fixtureAccountingSession;
  if (ACCEPTANCE_MODE === "onboarding") return fixtureOwnerSession;
  return fixtureSession;
}

/**
 * The runtime capability signal (`GET /api/v1/capabilities`, ELEC-240).
 *
 * These are the states the committed `workers-bus/wrangler.jsonc` really produces, copied from
 * the reference table in `docs/CAPABILITY-SIGNAL-CONTRACT.md` rather than invented: everything
 * default-off, Facet switched on over an empty route set, the proposal template mounted with no
 * document id. A fixture that showed these capabilities working would make the mobile evidence
 * for honest unavailable-capability presentation prove nothing.
 */
const FIXTURE_CAPABILITY_REFERENCE = [
  {
    id: "quickbooks_oauth",
    title: "QuickBooks connection",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "QB_OAUTH_ENABLED",
    audience: ["owner", "ops", "accounting"],
  },
  {
    id: "quickbooks_final_invoice",
    title: "QuickBooks final-invoice execution",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "QB_FINAL_INVOICE_ENABLED",
    audience: ["owner", "ops", "accounting"],
  },
  {
    id: "document_generation",
    title: "Document generation",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "APP_DOCUMENT_GENERATION_ENABLED",
    audience: ["owner", "ops"],
  },
  {
    id: "hermes_desktop",
    title: "Hermes desktop pilot",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "APP_HERMES_DESKTOP_ENABLED",
    audience: ["owner", "ops"],
  },
  {
    id: "public_estimator",
    title: "Public website estimator",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "PUBLIC_ESTIMATE_ENABLED",
    audience: ["owner", "ops", "sales"],
  },
  {
    id: "newo",
    title: "Newo voice reception",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "NEWO_ENABLED",
    audience: ["owner", "ops"],
  },
  {
    id: "postiz",
    title: "Postiz marketing publication",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "POSTIZ_ENABLED",
    audience: ["owner", "ops"],
  },
  {
    id: "proposal_publication",
    title: "Proposal publication to the customer",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "APP_PROPOSAL_PUBLICATION_ENABLED",
    audience: ["owner", "ops", "sales"],
  },
  {
    id: "facet_design_ingest",
    title: "Facet design delivery",
    state: "unconfigured",
    reason: "configuration_incomplete",
    flag_state: "on",
    configuration_state: "incomplete",
    flag_binding: "FACET_V2_INGEST_ENABLED",
    flag_declared: "true",
    missing_configuration: ["FACET_V2_ROUTES_JSON", "FACET_V2_KEYS_JSON"],
    audience: ["owner", "ops", "sales"],
  },
  {
    id: "facet_launch",
    title: "Facet design launch",
    state: "unconfigured",
    reason: "configuration_incomplete",
    flag_state: "on",
    configuration_state: "incomplete",
    flag_binding: "APP_FACET_LAUNCH_ENABLED",
    flag_declared: "true",
    missing_configuration: ["FACET_LAUNCH_STATIC_ROUTES_JSON"],
    audience: ["owner", "ops"],
  },
  {
    id: "proposal_template",
    title: "Proposal document template",
    state: "unconfigured",
    reason: "configuration_incomplete",
    flag_state: "not_flagged",
    configuration_state: "incomplete",
    flag_binding: null,
    flag_declared: null,
    missing_configuration: ["PROPOSAL_TEMPLATE_DOC_ID"],
    audience: ["owner", "ops", "sales"],
  },
  {
    id: "facet_quote_revision_prepare",
    title: "Facet quote-revision preparation",
    state: "absent",
    reason: "no_source_consumer",
    flag_state: "off",
    configuration_state: "not_evaluated",
    flag_binding: "APP_FACET_QUOTE_REVISION_PREPARE_ENABLED",
    presence: "absent",
    audience: ["owner", "ops"],
  },
];

function fixtureCapabilities(session) {
  const role = session.user.role;
  const office = role === "owner" || role === "ops";
  const visible = FIXTURE_CAPABILITY_REFERENCE.filter((entry) => entry.audience.includes(role));
  return {
    version: 1,
    tenant_id: session.tenant.id,
    role,
    projection: office ? "office" : "scoped",
    read_model_generated_at: "2026-08-31T00:00:00.000Z",
    capabilities: visible.map((entry) => {
      const scoped = {
        id: entry.id,
        title: entry.title,
        presence: entry.presence ?? "present",
        state: entry.state,
        reason: entry.reason,
        flag_state: entry.flag_state,
        configuration_state: entry.configuration_state,
        readback_required: false,
      };
      if (!office) return scoped;
      return {
        ...scoped,
        flag_binding: entry.flag_binding ?? null,
        flag_declared: entry.flag_declared ?? "false",
        missing_configuration: entry.missing_configuration ?? [],
        indeterminate_configuration: [],
        dependencies: [],
      };
    }),
    proof_claimed: false,
    configuration_mutations_available: false,
    allowed_actions: ["capabilities.read"],
    readback_obligations: false,
  };
}

function fixtureOperatorSearch(query) {
  const normalizedQuery = query.trim();
  const matchesNow = normalizedQuery.toLowerCase().startsWith("no");
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-07-18T12:00:02.000Z",
    stale_fields: [],
    permissions: fixtureEstimatorSession.permissions,
    allowed_actions: ["search.read", "navigation.read"],
    query: normalizedQuery,
    query_class: normalizedQuery.length < 2 ? null : "text",
    outcome: normalizedQuery.length < 2 ? "query_too_short" : matchesNow ? "results" : "no_matches",
    groups: [
      {
        group: "go_to",
        label: "Go to",
        limit: 8,
        matched_fields: ["label"],
        results: matchesNow
          ? [
              {
                id: "now",
                label: "Now",
                detail: "Command",
                href: "/now",
                matched_field: "label",
              },
            ]
          : [],
        more_results: false,
      },
    ],
  };
}

// Synthetic, process-local manual observations only. Native D1 atomicity and authorization
// are verified by Worker tests; these isolated jobs exercise the browser's real API path.
const manualMeasurementJobs = new Map();
const manualFixtureJob = /^JOB-MANUAL-[A-Za-z0-9-]+$/;
const manualFixtureRequest =
  /^manual-measurement:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function manualFixtureState(jobId) {
  if (!manualMeasurementJobs.has(jobId))
    manualMeasurementJobs.set(jobId, { version: 1, observations: [], receipts: new Map() });
  return manualMeasurementJobs.get(jobId);
}

function manualFixtureWorkbench(jobId) {
  const model = structuredClone(fixtureEstimatorWorkbench);
  model.job = { ...model.job, id: jobId, roof_job_id: jobId, job_number: null, status: "Draft" };
  model.lineage = { measurement_to_takeoff: "no_measurement", quote_to_proposal: "no_quote" };
  model.measurements = { reports: [], selected: null };
  model.visual_model = null;
  model.takeoffs = { records: [], selected: null };
  model.quote = null;
  model.proposal = null;
  model.pricing_snapshot = {
    state: "unavailable",
    quote_id: null,
    quote_version: null,
    price_book_version: null,
    pricing_effective_at: null,
    valid_until: null,
  };
  model.scope_clauses = [];
  model.proposal_readiness = { state: "review_required", reasons: ["quote_missing"] };
  return model;
}

async function routeManualMeasurements(request, requestUrl, method) {
  const match = requestUrl.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)(\/manual-measurements)?$/,
  );
  if (!match) return null;
  const jobId = decodeURIComponent(match[1]);
  if (!manualFixtureJob.test(jobId)) return null;
  if (!match[2]) return { status: 200, body: manualFixtureWorkbench(jobId) };
  const state = manualFixtureState(jobId);
  let currentHead = state.observations.at(-1)?.id ?? null;
  if (method === "GET") {
    const requestId = requestUrl.searchParams.get("request_id");
    const before = Number(requestUrl.searchParams.get("before") ?? Infinity);
    const history = state.observations.filter((item) => item.sequence < before).toReversed();
    const latest = new Map(state.observations.map((item) => [item.area_id, item]));
    return {
      status: 200,
      body: {
        version: 1,
        tenant_id: fixtureEstimatorSession.tenant.id,
        read_model_generated_at: "2026-09-30T12:00:00.000Z",
        job: { id: jobId, version: state.version, job_number: null },
        allowed_actions: ["manual_measurement.record"],
        observation_head: currentHead,
        areas: [...latest.values()],
        history: {
          items: history.slice(0, 25),
          next_before: history.length > 25 ? history[24].sequence : null,
        },
        requested_request_id: requestId,
        receipt: state.receipts.get(requestId)?.receipt ?? null,
      },
    };
  }
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (request.headers["x-csrf-token"] !== fixtureEstimatorSession.csrf_token)
    return { status: 403, body: { error: "csrf_token_invalid" } };
  const key = request.headers["idempotency-key"];
  const input = await readJsonBody(request);
  currentHead = state.observations.at(-1)?.id ?? null;
  if (typeof key !== "string" || !manualFixtureRequest.test(key) || !input?.target)
    return { status: 400, body: { error: "invalid_manual_measurement" } };
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previousReceipt = state.receipts.get(key);
  if (previousReceipt) {
    if (previousReceipt.receipt.request_hash !== hash)
      return { status: 409, body: { error: "manual_measurement_idempotency_conflict" } };
    return { status: 200, body: { ...previousReceipt, replayed: true } };
  }
  if (input.expected_job_version !== state.version)
    return { status: 409, body: { error: "manual_measurement_job_stale" } };
  if (input.expected_observation_head !== currentHead)
    return { status: 409, body: { error: "manual_measurement_head_stale" } };
  const prior = input.target.area_id
    ? state.observations.findLast((item) => item.area_id === input.target.area_id)
    : undefined;
  if (input.target.area_id && (!prior || !input.correction_reason?.trim()))
    return { status: 400, body: { error: "invalid_manual_measurement" } };
  const digest = createHash("sha256").update(`${jobId}:${key}`).digest("hex");
  const observation = {
    id: `mobs_${digest}`,
    job_id: jobId,
    area_id: prior?.area_id ?? `marea_${digest}`,
    area_label: prior?.area_label ?? input.target.new_area_label,
    revision: (prior?.revision ?? 0) + 1,
    sequence: state.observations.length + 1,
    area_sq_ft: input.area_sq_ft,
    area_basis: input.area_basis,
    pitch_rise_per_12: input.pitch_rise_per_12,
    method: input.method,
    uncertainty: input.uncertainty,
    correction_reason: input.correction_reason,
    supersedes_observation_id: prior?.id ?? null,
    previous_head_id: currentHead,
    job_version: state.version,
    recorded_by: fixtureEstimatorSession.user.id,
    recorded_at: "2026-09-30T12:00:00.000Z",
    sha256: hash,
  };
  state.observations.push(observation);
  const result = {
    version: 1,
    tenant_id: fixtureEstimatorSession.tenant.id,
    job_id: jobId,
    receipt: { request_id: key, request_hash: hash, observation },
    replayed: false,
  };
  state.receipts.set(key, result);
  return { status: 201, body: result };
}

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

// Test-only: mirrors the money desk read contract (IRO-52 slice S9). Synthetic throughout - a fake
// QuickBooks realm, placeholder hashes, and a reserved `example.test` identity. No provider payload
// body and no tenant id appears here, because none appears on the real envelopes either.
const fixtureAccountingSession = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  stale_fields: [],
  permissions: [
    "session:read",
    "now:read",
    "accounting:read",
    "accounting:review",
    "accounting:approve",
    "accounting:reconcile",
    "accounting:compensate",
  ],
  allowed_actions: ["accounting.read"],
  authenticated: true,
  user: {
    id: "appu_acceptance_accounting",
    email: "accounting.acceptance@example.test",
    display_name: "Acceptance Accounting",
    role: "accounting",
    frappe_user_id: "accounting.acceptance@example.test",
  },
  tenant: fixtureSession.tenant,
  csrf_token: "accounting-acceptance-csrf",
  session_expires_at: "2030-08-20T09:00:00.000Z",
};

const ACCOUNTING_INTENT_ID = "acct-intent:JOB-ACCEPTANCE:deposit_invoice";
const ACCOUNTING_EXCEPTION_ID = "acct-exc-acceptance-0001";
const ACCOUNTING_SHA_EXPECTED = "a".repeat(64);
const ACCOUNTING_SHA_OBSERVED = "b".repeat(64);

const fixtureAccountingEnvelope = {
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  allowed_actions: [
    "accounting.read",
    "accounting.intent.approve",
    "accounting.intent.reject",
    "accounting.intent.reconcile",
    "accounting.intent.compensate",
    "accounting.exception.resolve",
  ],
};

const fixtureAccountingIntent = {
  intent_id: ACCOUNTING_INTENT_ID,
  kind: "deposit_invoice",
  roof_job_id: "JOB-ACCEPTANCE",
  customer_ref: "CUST-ACCEPTANCE",
  currency: "CAD",
  total_amount: "1260.00",
  settled_amount: null,
  state: "pending_review",
  badge: "pending",
  next_step: "Check the amount against the approved paperwork, then approve or reject it.",
  version: 1,
  blocker_code: null,
  reason_code: null,
  derived_at: "2026-08-20T08:00:00.000Z",
  updated_at: "2026-08-20T08:00:00.000Z",
  age_seconds: 3600,
  compensates_intent_id: null,
};

const fixtureAccountingMismatch = {
  ...fixtureAccountingIntent,
  intent_id: "acct-intent:JOB-ACCEPTANCE-2:progress_invoice",
  kind: "progress_invoice",
  roof_job_id: "JOB-ACCEPTANCE-2",
  state: "mismatch",
  badge: "mismatched",
  next_step: "QuickBooks does not agree with our figures. Open the detail and pick a remedy.",
  version: 4,
  age_seconds: 7200,
};

/**
 * A freshly posted invoice, waiting on the customer. Slice S11's copy case.
 *
 * `settled_amount` is `0.00` and not null on purpose: that is the figure the dispatch readback
 * writes when the invoice is issued and nothing has been paid yet, and it is exactly the row the
 * old copy lied about ("Part of this is paid. Waiting for the rest." for an invoice nobody had
 * paid a cent of). The next step here is what `accountingNextStep` now returns for it.
 */
const fixtureAccountingAwaiting = {
  ...fixtureAccountingIntent,
  intent_id: "acct-intent:JOB-ACCEPTANCE-3:deposit_invoice",
  roof_job_id: "JOB-ACCEPTANCE-3",
  settled_amount: "0.00",
  state: "partially_settled",
  badge: "in_flight",
  next_step: "Posted to QuickBooks. Waiting for the customer to pay it.",
  version: 5,
  age_seconds: 5400,
};

const fixtureAccountingException = {
  exception_id: ACCOUNTING_EXCEPTION_ID,
  intent_id: ACCOUNTING_INTENT_ID,
  subject_ref: `accounting_intent:${ACCOUNTING_INTENT_ID}`,
  reason_code: "provider_overpayment",
  status: "open",
  expected_sha256: ACCOUNTING_SHA_EXPECTED,
  observed_sha256: ACCOUNTING_SHA_OBSERVED,
  remedies: [
    { action: "void_provider_entity", alternatives: [] },
    { action: "credit_memo_issued", alternatives: ["refund_issued"] },
  ],
  detail: { invoiceTotal: "1260.00", observedSettled: "1500.00" },
  resolution_action: null,
  opened_at: "2026-08-20T08:10:00.000Z",
  updated_at: "2026-08-20T08:10:00.000Z",
  age_seconds: 7200,
  offered_remedies: ["void_provider_entity", "credit_memo_issued", "refund_issued"],
};

const fixtureAccountingSummary = {
  ...fixtureAccountingEnvelope,
  summary: {
    queues: {
      needs_approval: { count: 1, oldest_age_seconds: 3600 },
      awaiting_provider: { count: 1, oldest_age_seconds: 5400 },
      mismatched: { count: 1, oldest_age_seconds: 7200 },
      exceptions: { count: 1, oldest_age_seconds: 7200 },
    },
    reconciliation_health: {
      open_exceptions: 1,
      acknowledged_exceptions: 0,
      oldest_open_exception_age_seconds: 7200,
      oldest_unreconciled_intent_id: ACCOUNTING_INTENT_ID,
      oldest_unreconciled_age_seconds: 7200,
      stale_observation_count: 2,
      stale_after_seconds: 86400,
      unobserved_intent_count: 1,
    },
  },
  queues: {
    needs_approval: [fixtureAccountingIntent],
    awaiting_provider: [fixtureAccountingAwaiting],
    mismatched: [fixtureAccountingMismatch],
    exceptions: [fixtureAccountingException],
  },
};

const fixtureAccountingDetail = {
  ...fixtureAccountingEnvelope,
  intent: fixtureAccountingIntent,
  basis: { roofJob: "JOB-ACCEPTANCE", customerRef: "CUST-ACCEPTANCE" },
  source_documents: [{ id: "QUOTE-ACCEPTANCE", version: 3 }],
  evidence: {
    basis_sha256: ACCOUNTING_SHA_EXPECTED,
    expected_sha256: ACCOUNTING_SHA_EXPECTED,
    observed_sha256: null,
    provider_payload_sha256: ACCOUNTING_SHA_OBSERVED,
    provider_request_id: "req-acceptance-0001",
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_entity_id: null,
    tax_policy_snapshot_sha256: ACCOUNTING_SHA_OBSERVED,
    effect_id: null,
    compensates_effect_id: null,
    authority_permit_ref: "permit:accounting:money",
    authority_policy_ref: "policy:accounting:money.create",
    authority_policy_version: "v1",
    authority_max_amount: "5000.00",
    provider_submitted_at: null,
    provider_reconciled_at: null,
  },
  comparison: {
    expected_sha256: ACCOUNTING_SHA_EXPECTED,
    observed_sha256: null,
    verdict_observed_sha256: null,
    hashes_agree: false,
    awaiting_readback: true,
    fields: [
      { field: "realm_id", expected: "4620816365000000000", observed: null, agrees: false },
      { field: "provider_entity_type", expected: "Invoice", observed: null, agrees: false },
      { field: "provider_entity_id", expected: null, observed: null, agrees: true },
      { field: "total_amount", expected: "1260.00", observed: null, agrees: false },
      { field: "currency", expected: "CAD", observed: null, agrees: false },
    ],
    observed_facts: null,
    read_at: null,
    read_source: null,
  },
  events: [
    {
      event_seq: 1,
      intent_version: 1,
      event_type: "derived",
      state_from: null,
      state_to: "pending_review",
      actor_kind: "agent",
      actor_user_id: null,
      detail_code: null,
      occurred_at: "2026-08-20T08:00:00.000Z",
    },
  ],
  reconciliations: [],
  observations: [],
  tax_bindings: [
    {
      snapshot_id: "tax-snap:CA-AB:GST:v1",
      snapshot_sha256: ACCOUNTING_SHA_OBSERVED,
      jurisdiction: "CA-AB",
      tax_code: "GST",
      bound_at: "2026-08-20T08:00:00.000Z",
    },
  ],
  exceptions: [],
};

const fixtureAccountingExceptions = {
  ...fixtureAccountingEnvelope,
  exceptions: [fixtureAccountingException],
};

/**
 * The driver's own fleet, for the mobile-first vehicle acceptance (ELEC-87).
 *
 * It is stateful on purpose. The rail this suite proves is capture -> fence
 * verdict: a passing pre-trip is what clears `overdue_fleet_inspection`, so a
 * fixture that answered the same panel before and after a capture would let a
 * screen that posts nowhere pass the suite.
 */
const fleetCaptureState = { preTripAt: null, postTripAt: null, defects: [] };

function resetFleetCaptureState() {
  fleetCaptureState.preTripAt = null;
  fleetCaptureState.postTripAt = null;
  fleetCaptureState.defects = [];
}

function fixtureFleetPanel() {
  const grounded = fleetCaptureState.defects.some((defect) => defect.severity === "Out of Service");
  const blockers = [];
  if (grounded) {
    blockers.push({
      code: "unsafe_fleet_asset",
      field: "fleet_asset",
      message:
        "[unsafe_fleet_asset] fleet_asset: the linked Fleet Asset must be Active before scheduling or release",
    });
  } else if (!fleetCaptureState.preTripAt) {
    blockers.push({
      code: "overdue_fleet_inspection",
      field: "next_inspection_due",
      message:
        "[overdue_fleet_inspection] next_inspection_due: the linked Fleet Asset inspection is overdue for the scheduled or released work",
    });
  }
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-07-10T12:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: [
      "fleet.pre_trip_inspection.create",
      "fleet.post_trip_inspection.create",
      "fleet.defect_report.create",
    ],
    reference_date: "2026-07-10",
    assets: [
      {
        id: "FLEET-ACCEPTANCE",
        fleet_asset_id: "TRUCK-ACCEPTANCE",
        display_name: "Truck 12 flat deck",
        unit_number: "12",
        asset_kind: "Vehicle",
        status: grounded ? "Out of Service" : "Active",
        licence_plate: "ABC-1234",
        meter_kind: "Odometer km",
        current_meter: 142000,
        relationship: "custody",
        last_inspection_at: fleetCaptureState.preTripAt,
        next_inspection_due: fleetCaptureState.preTripAt ? "2026-07-11" : "2026-07-01",
        last_pre_trip_at: fleetCaptureState.preTripAt,
        last_post_trip_at: fleetCaptureState.postTripAt,
        out_of_service_reason: grounded ? "Out-of-service defect reported from the field." : null,
        open_out_of_service_defects: 0,
        blockers,
      },
    ],
  };
}

const FLEET_CAPTURE_ROUTES = [
  [/^\/api\/v1\/fleet\/assets\/([^/]+)\/pre-trip-inspections$/, "pre_trip"],
  [/^\/api\/v1\/fleet\/assets\/([^/]+)\/post-trip-inspections$/, "post_trip"],
  [/^\/api\/v1\/fleet\/assets\/([^/]+)\/defects$/, "defect"],
];

function fleetCaptureRoute(pathname) {
  for (const [pattern, kind] of FLEET_CAPTURE_ROUTES) {
    if (pattern.test(pathname)) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customer-portal fixtures (option-package comparison + material decision) -- ELEC-94
//
// `/portal` had no fixture handlers at all before this, so the customer half of
// the product had zero e2e coverage. These mirror the real routes'
// fixed-shape body, exact-key validation, Idempotency-Key requirement and
// success envelope from workers-bus/src/customer-portal.ts and
// workers-bus/src/customer-portal-decision.ts. Deliberate divergences: no
// D1-backed intent lease, no R2 receipt, no origin check (Playwright's page
// origin is the server's own), and no throttle. Replay is an in-memory map for
// the process lifetime.
// ---------------------------------------------------------------------------

const FIXTURE_PORTAL_TOKEN = "p".repeat(43);

const fixtureOptionPackages = [
  {
    id: "opt-good",
    package_name: "Weathered slate asphalt",
    tier: "Good",
    material_system: "Architectural asphalt shingle",
    price_delta: 0,
    currency: "CAD",
    options: { colour: "Weathered slate", panel_profile: "Laminated shingle" },
    warranty_summary: "25-year limited material warranty",
  },
  {
    id: "opt-better",
    package_name: "Charcoal standing seam",
    tier: "Better",
    material_system: "26ga standing seam steel",
    price_delta: 2400,
    currency: "CAD",
    options: { colour: "Charcoal", panel_profile: "1.5in nail strip" },
    warranty_summary: "40-year finish warranty",
  },
  {
    id: "opt-best",
    package_name: "Matte black snap-lock",
    tier: "Best",
    material_system: "24ga snap-lock steel",
    price_delta: 6100,
    currency: "CAD",
    options: { colour: "Matte black", panel_profile: "1.75in snap-lock" },
    warranty_summary: "50-year finish warranty",
  },
];

const customerPortalState = { decisions: [], byIdempotencyKey: new Map() };

function resetCustomerPortalState() {
  customerPortalState.decisions = [];
  customerPortalState.byIdempotencyKey = new Map();
}

function fixtureCustomerPortalModel() {
  return {
    version: 1,
    brand: "IronWrap Exteriors",
    contract_acceptance_available: false,
    material_decision_available: true,
    source_updated_at: "2026-08-20T07:00:00.000Z",
    read_model_generated_at: "2026-08-20T07:05:00.000Z",
    job: { job_number: "IW-2026-100", service_type: "Roofing", status: "In Production" },
    // Mirrors the Worker's office-committed native assignment (customer-portal.ts).
    install_window: {
      scheduled_start: "2026-08-26T08:00:00-06:00",
      scheduled_end: "2026-08-26T16:00:00-06:00",
      confirmed: true,
      confirmation_basis: "office_committed_assignment",
    },
    proposal: null,
    scope: [
      {
        id: "scope-1",
        type: "Included",
        title: "Tear-off and re-roof",
        text: "Remove the existing roof system and install the selected assembly.",
        version: "1",
      },
    ],
    option_packages: fixtureOptionPackages,
    progress: [],
    closeout: null,
    warranty: null,
  };
}

/** The shared exactKeys() assumes an object; a portal body arrives straight off the wire. */
function exactObjectKeys(body, keys) {
  return !!body && typeof body === "object" && !Array.isArray(body) && exactKeys(body, keys);
}

async function routeCustomerPortal(request, requestUrl) {
  if (requestUrl.pathname === "/api/v1/customer-portal/resolve") {
    const body = await readJsonBody(request);
    if (!exactObjectKeys(body, ["token"]) || body.token !== FIXTURE_PORTAL_TOKEN) {
      return { status: 404, body: { error: "not_found" } };
    }
    return { status: 200, body: fixtureCustomerPortalModel() };
  }
  if (requestUrl.pathname === "/api/v1/customer-portal/decision") {
    const idempotencyKey = request.headers["idempotency-key"];
    const body = await readJsonBody(request);
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return { status: 400, body: { error: "idempotency_key_required" } };
    }
    if (
      !exactObjectKeys(body, ["token", "option_package_id"]) ||
      body.token !== FIXTURE_PORTAL_TOKEN
    ) {
      return { status: 404, body: { error: "not_found" } };
    }
    if (!fixtureOptionPackages.some((option) => option.id === body.option_package_id)) {
      return { status: 404, body: { error: "not_found" } };
    }
    const replayed = customerPortalState.byIdempotencyKey.get(idempotencyKey);
    if (replayed) return { status: 200, body: replayed };
    const recorded = {
      status: "recorded",
      decision_id: `decision_${customerPortalState.decisions.length + 1}0000000`,
    };
    customerPortalState.decisions.push({
      option_package_id: body.option_package_id,
      idempotency_key: idempotencyKey,
    });
    customerPortalState.byIdempotencyKey.set(idempotencyKey, recorded);
    return { status: 200, body: recorded };
  }
  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const fixtureAccountingConnection = {
  version: 1,
  state: "connected",
  connection_version: 4,
  realm_id: "4620816365000000000",
  last_connected_at: "2026-08-20T07:00:00.000Z",
  allowed_actions: ["refresh"],
};

// ---------------------------------------------------------------------------
// Onboarding fixtures (ELEC-160)
//
// A brand-new company: an owner signed in, no company details saved, nobody else added, and no
// leads at all. It mirrors the real routes' request envelopes and error codes closely enough to
// drive the setup screens end to end at a Pixel-class viewport, which is where the onboarding
// evidence has to come from. State resets per process, or through
// `POST /__acceptance/onboarding/reset`.
// ---------------------------------------------------------------------------

const ACCEPTANCE_PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const fixtureOwnerSession = {
  ...fixtureEnvelope,
  authenticated: true,
  user: {
    id: "appu_acceptance_owner",
    email: "ada@freshco.example",
    display_name: "Ada Owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "freshco",
    name: "FreshCo Exteriors",
    brand: "FreshCo",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["now:read", "owner:read", "sales:read", "sales:lead_create"],
  allowed_actions: ["sales.read", "sales.lead.create"],
  csrf_token: "acceptance-csrf",
  session_expires_at: "2036-07-10T12:00:00.000Z",
};

/**
 * A tenant nobody has answered for yet.
 *
 * `company_name` is empty on purpose: the onboarding suite resets to this state to prove the
 * setup list tells a brand-new company what it still has to say about itself. Seeding a name here
 * made the company step read "Done" straight after a reset, so the fresh-company assertions were
 * being answered by a company that was already named (ELEC-233, disposition on ELEC-231).
 *
 * The shape mirrors `companyProfileDefaults` in `workers-bus/src/company-setup-store.ts`:
 * `profile_version` 0 with `is_default: true` is "these are deployment defaults, nobody has
 * confirmed them", and the first successful save moves it to 1 / `false`.
 */
const onboardingDefaults = () => ({
  profile: {
    tenant_id: "freshco",
    profile_version: 0,
    is_default: true,
    company_name: "",
    brand_name: "FreshCo",
    service_area: "",
    phone: "",
    email: "",
    website: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
    brand_labels: {},
    time_zone: "America/Edmonton",
    currency: "CAD",
    week_start: "sunday",
    logo_ref: null,
    logo: null,
    updated_at: null,
    updated_by: null,
    updated_by_user_id: null,
  },
  users: [
    {
      user_id: "appu_acceptance_owner",
      email: "ada@freshco.example",
      display_name: "Ada Owner",
      role: "owner",
      active: true,
      access_version: 1,
      updated_at: "2026-08-22T12:00:00.000Z",
      is_self: true,
      crew_phone_unpaired: false,
    },
  ],
  leads: [],
  intakeReceipts: {},
  intakeDetails: {},
  /** The Worker's versioned access audit: one entry per role or access change. */
  accessChanges: [],
});

let onboardingState = onboardingDefaults();

/** The Worker's 409 `conflict` body, read from the changes above the refused change's version. */
function onboardingAccessConflict(person, expectedVersion) {
  const since = onboardingState.accessChanges
    .filter((change) => change.user_id === person.user_id && change.version > expectedVersion)
    .sort((left, right) => right.version - left.version);
  const newest = since[0];
  const first = since.at(-1);
  const actor = newest
    ? onboardingState.users.find((user) => user.user_id === newest.actor_user_id)
    : undefined;
  return {
    user_id: person.user_id,
    access_version: person.access_version,
    changed_at: newest?.at ?? null,
    changed_by: newest
      ? {
          user_id: newest.actor_user_id,
          display_name: actor?.display_name ?? null,
          // The acceptance session is always the owner, so its other changes are its own.
          is_self_actor: newest.actor_user_id === "appu_acceptance_owner",
        }
      : null,
    change: {
      before: first?.version === expectedVersion + 1 ? first.before : null,
      after: { role: person.role, active: person.active },
    },
  };
}

function resetOnboardingState() {
  onboardingState = onboardingDefaults();
}

const fixturePipelineEnvelope = {
  version: 1,
  source_updated_at: "2026-08-22T12:00:00.000Z",
  read_model_generated_at: "2026-08-22T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.card.move"],
};

const fixturePipeline = {
  pipeline_id: "pipe-sales",
  key: "sales",
  name: "Sales \u00b7 Marketing Pipeline",
  entity_type: "lead",
  owning_role: "sales",
  position: 0,
};

function fixturePipelineBoard() {
  const names = [
    "New Lead",
    "Visit Booked",
    "Need Quote",
    "Quote Sent",
    "Contract signed",
    "Deposit",
    "Materials in prod",
  ];
  const id = (name) => name.toLowerCase().replace(/\s+/g, "_");
  const counts = { "New Lead": 1, "Need Quote": 1, "Quote Sent": 115, "Contract signed": 1 };
  const totals = { "Need Quote": 400_000, "Quote Sent": 641_420_540, "Contract signed": 1_450_000 };
  return {
    ...fixturePipelineEnvelope,
    pipeline: fixturePipeline,
    stages: names.map((name, position) => ({
      stage_id: id(name),
      key: id(name),
      name,
      position,
      is_won: name === "Contract signed",
      is_lost: false,
      card_count: counts[name] ?? 0,
      total_amount_cents: totals[name] ?? 0,
      min_role_to_enter: null,
    })),
    cards: [
      {
        card_id: "card-lead",
        stage_id: "new_lead",
        position_in_stage: 10,
        entity_type: "lead",
        entity_id: "lead-1",
        version: 1,
        summary: { title: "Jubril Mcgregor", counters: [{ kind: "messages", count: 1 }] },
      },
      {
        card_id: "card-quote",
        stage_id: "need_quote",
        position_in_stage: 10,
        entity_type: "lead",
        entity_id: "lead-2",
        version: 7,
        summary: {
          title: "Naina Tamang",
          amount_cents: 400_000,
          identifiers: [{ label: "Lead", value: "26-219-ER" }],
          tags: ["Metal Roofing"],
          counters: [
            { kind: "messages", count: 2 },
            { kind: "files", count: 8 },
          ],
          is_won: false,
        },
      },
      {
        card_id: "card-won",
        stage_id: "contract_signed",
        position_in_stage: 10,
        entity_type: "lead",
        entity_id: "lead-3",
        version: 2,
        summary: {
          title: "Petre Milouchev",
          amount_cents: 1_450_000,
          identifiers: [
            { label: "Lead", value: "26-058-ABN" },
            { label: "Job", value: "ABN26-004" },
          ],
          tags: ["Metal Roofing", "Soffit"],
          counters: [{ kind: "messages", count: 2 }],
          is_won: true,
        },
      },
    ],
  };
}

function onboardingSetupProgressPayload() {
  const named = String(onboardingState.profile.company_name ?? "").trim().length > 0;
  const peopled = (onboardingState.users ?? []).length > 1;
  const step = (id, title, done, detail) => ({
    id,
    title,
    status: done ? "done" : "later",
    detail,
    requirements: [{ id: `${id}_present`, met: done, applicable: true, detail }],
  });
  const steps = [
    step("company", "Company details", named, "The company has a name customers see."),
    step("people", "People", peopled, "Someone besides the owner can sign in."),
    step("crew_phones", "Crew phones", false, "No phone is paired yet."),
    step("money_and_intake", "Money and intake", false, "No intake route is configured."),
    step("notifications", "Notifications", false, "Nobody has chosen what to be told about."),
  ];
  const done = steps.filter((entry) => entry.status === "done").length;
  return {
    version: 1,
    read_model_generated_at: "2026-08-22T12:30:00.000Z",
    allowed_actions: [],
    progress: {
      generated_at: "2026-08-22T12:30:00.000Z",
      done,
      total: steps.length,
      percent_complete: Math.round((done / steps.length) * 100),
      steps,
    },
  };
}

/** The exact fields `missingCompanyFields` requires before the company step can read done. */
const ONBOARDING_REQUIRED_COMPANY_FIELDS = [
  "company_name",
  "brand_name",
  "phone",
  "address_line1",
  "city",
  "region",
  "postal_code",
  "time_zone",
  "currency",
  "week_start",
];

/**
 * The company-details envelope, in the shape `companyProfileResponseSchema` actually parses.
 *
 * This payload used to stop at `version` / `profile` / `logo_url` / `logo_limits` /
 * `public_brands` and omit everything the contract grew afterwards, so the Zod parse in
 * `apiRequest` threw and `/settings/company` rendered "Company details could not load" for the
 * whole harness. The screen was never mounted, which is why the acceptance run reported a missing
 * `Company name` field: the suite was blind on this surface rather than disagreeing with it
 * (ELEC-233, disposition on ELEC-231). The real Worker has emitted the full envelope since
 * `company-setup-api.ts` `companyProfileEnvelope`; this mirrors it.
 */
/**
 * Mirrors `publicCompanyContact` in workers-bus/src/company-profile.ts: the contact customers see
 * is withheld when it is a default, an unreadable phone, or a local number without CA/US.
 */
function publicContactPreview(profile) {
  if (profile.is_default) return null;
  const raw = String(profile.phone ?? "").trim();
  let phone = null;
  if (raw && /^\+?[0-9 ().-]+$/.test(raw)) {
    const digits = raw.replace(/\D/g, "");
    if (raw.startsWith("+")) {
      phone = /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : null;
    } else if (
      ["ca", "canada", "us", "usa", "united states"].includes(
        String(profile.country ?? "")
          .trim()
          .toLowerCase(),
      )
    ) {
      const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      phone = /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(ten) ? `+1${ten}` : null;
    }
  }
  const email = String(profile.email ?? "").trim();
  const publicEmail = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email) ? email : null;
  return phone || publicEmail ? { phone, email: publicEmail } : null;
}

function onboardingProfilePayload() {
  return {
    version: 1,
    read_model_generated_at: "2026-08-22T12:30:00.000Z",
    allowed_actions: ["company_profile.read", "setup_progress.read", "company_profile.update"],
    profile: onboardingState.profile,
    // What the tenant looks like before an owner has confirmed anything: the deployment-time
    // conventions, with every field only a person can answer left blank.
    defaults: onboardingDefaults().profile,
    missing_fields: ONBOARDING_REQUIRED_COMPANY_FIELDS.filter(
      (field) => String(onboardingState.profile[field] ?? "").trim().length === 0,
    ),
    week_starts: ["sunday", "monday", "saturday"],
    logo_url: onboardingState.profile.logo
      ? `/public/company-logo?v=${onboardingState.profile.logo.version}`
      : null,
    logo_limits: {
      max_bytes: 512 * 1024,
      content_types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
    },
    public_contact_preview: publicContactPreview(onboardingState.profile),
    public_brands: [
      {
        id: "freshco",
        display_name: onboardingState.profile.company_name,
        short_name: onboardingState.profile.brand_name,
        service_area: onboardingState.profile.service_area,
      },
    ],
  };
}

function onboardingSalesPayload() {
  return {
    version: 1,
    source_updated_at: "2026-08-22T12:00:00.000Z",
    read_model_generated_at: "2026-08-22T12:34:00.000Z",
    stale_fields: [],
    permissions: ["sales:read", "sales:lead_create"],
    allowed_actions: ["sales.read", "sales.lead.create"],
    partial_sources: [],
    leads: onboardingState.leads,
    summary: {
      listed_leads: onboardingState.leads.length,
      triage_unresolved: onboardingState.leads.length,
      estimate_needs_review: 0,
      quote_needs_review: 0,
      quote_expired: 0,
      no_linked_consent_record: 0,
    },
  };
}

async function routeOnboarding(request, requestUrl, method) {
  if (method === "POST" && requestUrl.pathname === "/__acceptance/onboarding/reset") {
    resetOnboardingState();
    return { status: 200, body: { ok: true } };
  }
  // The setup hub reads this to say what is already done. It was missing, so
  // the onboarding suite exercised the hub only in its no-data shape and never
  // caught that a failed read was being reported as an untouched company.
  if (requestUrl.pathname === "/api/v1/admin/setup-progress" && method === "GET") {
    if (onboardingState.setupProgressFails) {
      return { status: 503, body: { error: "setup_progress_unavailable" } };
    }
    return { status: 200, body: onboardingSetupProgressPayload() };
  }
  if (
    method === "POST" &&
    requestUrl.pathname === "/__acceptance/onboarding/setup-progress-fails"
  ) {
    onboardingState.setupProgressFails = true;
    return { status: 200, body: { ok: true } };
  }
  if (requestUrl.pathname === "/api/v1/admin/company-profile") {
    if (method === "GET") return { status: 200, body: onboardingProfilePayload() };
    if (method === "PUT") {
      const body = (await readJsonBody(request)) ?? {};
      if (!String(body.company_name ?? "").trim()) {
        return { status: 400, body: { error: "invalid_company_name" } };
      }
      if (body.website && !/^https?:\/\/\S+$/.test(String(body.website))) {
        return { status: 400, body: { error: "invalid_website" } };
      }
      // `expected_profile_version` is the request's optimistic-concurrency claim, not a profile
      // field, so it is dropped rather than merged into stored state.
      const fields = { ...body };
      delete fields.expected_profile_version;
      onboardingState.profile = {
        ...onboardingState.profile,
        ...fields,
        tenant_id: "freshco",
        profile_version: onboardingState.profile.profile_version + 1,
        is_default: false,
        updated_at: "2026-08-22T12:30:00.000Z",
        updated_by: "ada@freshco.example",
        updated_by_user_id: "appu_acceptance_owner",
      };
      return { status: 200, body: onboardingProfilePayload() };
    }
  }
  if (requestUrl.pathname === "/api/v1/admin/company-profile/logo") {
    if (method === "PUT") {
      const body = (await readJsonBody(request)) ?? {};
      if (!String(body.data_base64 ?? "")) {
        return { status: 400, body: { error: "invalid_logo_data" } };
      }
      onboardingState.profile = {
        ...onboardingState.profile,
        profile_version: onboardingState.profile.profile_version + 1,
        is_default: false,
        logo_ref: "/public/company-logo?v=acceptance",
        logo: {
          content_type: String(body.content_type ?? "image/png"),
          byte_size: String(body.data_base64).length,
          version: "acceptance",
          updated_at: "2026-08-22T12:31:00.000Z",
        },
      };
      return { status: 200, body: onboardingProfilePayload() };
    }
    if (method === "DELETE") {
      onboardingState.profile = {
        ...onboardingState.profile,
        profile_version: onboardingState.profile.profile_version + 1,
        logo_ref: null,
        logo: null,
      };
      return { status: 200, body: onboardingProfilePayload() };
    }
  }
  if (requestUrl.pathname === "/api/v1/admin/app-users") {
    if (method === "GET") {
      return { status: 200, body: { version: 1, users: onboardingState.users } };
    }
    if (method === "POST") {
      const body = (await readJsonBody(request)) ?? {};
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { status: 400, body: { error: "invalid_email" } };
      }
      const existing = onboardingState.users.find((user) => user.email === email);
      // The Worker's 0157 rule: an existing person's change names their access version, and a
      // stale one is refused with what moved since (who, the access before and now).
      const expected = body.expected_access_version;
      if (existing && expected === undefined) {
        return { status: 400, body: { error: "expected_access_version_required" } };
      }
      if (
        (existing && expected !== existing.access_version) ||
        (!existing && expected !== undefined)
      ) {
        return {
          status: 409,
          body: {
            error: "access_version_conflict",
            conflict: existing ? onboardingAccessConflict(existing, expected) : null,
          },
        };
      }
      const next = {
        user_id: existing?.user_id ?? `appu_${onboardingState.users.length}`,
        email,
        display_name: String(body.display_name ?? ""),
        role: String(body.role ?? "sales"),
        active: body.active !== false,
        access_version: existing ? existing.access_version + 1 : 1,
        updated_at: "2026-08-22T12:32:00.000Z",
        is_self: existing?.is_self ?? false,
        // The Worker's computed crew_phone_unpaired: crew members here use a crew phone, so
        // removing one unpairs it, and nobody in this fixture pairs a phone again.
        crew_phone_unpaired: Boolean(
          existing &&
          (existing.crew_phone_unpaired ||
            (existing.active && body.active === false && existing.role === "field")),
        ),
      };
      onboardingState.users = existing
        ? onboardingState.users.map((user) => (user.email === email ? next : user))
        : [...onboardingState.users, next];
      onboardingState.accessChanges.push({
        user_id: next.user_id,
        version: next.access_version,
        before: existing ? { role: existing.role, active: existing.active } : null,
        after: { role: next.role, active: next.active },
        actor_user_id: "appu_acceptance_owner",
        at: new Date().toISOString(),
      });
      return { status: 200, body: { user: next } };
    }
  }
  if (method === "GET" && requestUrl.pathname === "/api/v1/sales") {
    return { status: 200, body: onboardingSalesPayload() };
  }
  if (method === "GET" && requestUrl.pathname.startsWith("/api/v1/sales/intakes/")) {
    const requestId = decodeURIComponent(
      requestUrl.pathname.slice("/api/v1/sales/intakes/".length),
    );
    const saved = onboardingState.intakeReceipts[requestId];
    return saved
      ? { status: 200, body: saved.response }
      : { status: 404, body: { error: "office_lead_receipt_not_found" } };
  }
  if (
    method === "POST" &&
    requestUrl.pathname.startsWith("/api/v1/sales/intakes/") &&
    requestUrl.pathname.endsWith("/resume")
  ) {
    const requestId = decodeURIComponent(requestUrl.pathname.split("/").at(-2));
    const body = await readJsonBody(request);
    if (!body || Array.isArray(body) || Object.keys(body).length) {
      return { status: 400, body: { error: "invalid_body" } };
    }
    // This fixture records synchronously; resuming a recorded identity is a readback replay.
    const saved = onboardingState.intakeReceipts[requestId];
    return saved
      ? { status: 200, body: saved.response }
      : { status: 404, body: { error: "office_lead_receipt_not_found" } };
  }
  if (method === "GET" && requestUrl.pathname.startsWith("/api/v1/sales/leads/")) {
    const leadId = decodeURIComponent(requestUrl.pathname.slice("/api/v1/sales/leads/".length));
    const lead = onboardingState.leads.find((candidate) => candidate.id === leadId);
    return lead
      ? {
          status: 200,
          body: {
            version: 1,
            read_model_generated_at: "2026-09-30T12:00:00.000Z",
            permissions: ["sales:read"],
            allowed_actions: ["sales.read", "commercial.lead_triage.record"],
            stale_fields: [],
            partial_sources: [],
            lead,
            intake: onboardingState.intakeDetails[leadId] ?? null,
          },
        }
      : { status: 404, body: { error: "lead_not_found" } };
  }
  if (method === "POST" && requestUrl.pathname === "/api/v1/sales/leads") {
    const body = (await readJsonBody(request)) ?? {};
    const receiptMode = requestUrl.searchParams.get("include_receipt") === "1";
    const requestId = request.headers["idempotency-key"];
    const bodySignature = JSON.stringify(body);
    if (receiptMode) {
      if (
        typeof requestId !== "string" ||
        !/^office-lead:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          requestId,
        )
      ) {
        return { status: 400, body: { error: "invalid_idempotency_key" } };
      }
      const saved = onboardingState.intakeReceipts[requestId];
      if (saved)
        return saved.bodySignature === bodySignature
          ? { status: 200, body: saved.response }
          : { status: 409, body: { error: "idempotency_conflict" } };
    }
    if (!body.email && !body.phone) return { status: 400, body: { error: "contact_required" } };
    const contact = String(body.email || body.phone)
      .trim()
      .toLowerCase();
    let lead = onboardingState.leads.find(
      (candidate) =>
        String(candidate.contact.email || candidate.contact.phone).toLowerCase() === contact,
    );
    const duplicate = Boolean(lead);
    if (!lead) {
      const digest = createHash("sha256")
        .update(`synthetic-freshco-${onboardingState.leads.length}`)
        .digest("hex");
      lead = {
        id: `lead:freshco:${digest}`,
        envelope_id: `ow_acceptance-lead-${onboardingState.leads.length}`,
        source: "office",
        received_at: "2026-09-30T12:00:00.000Z",
        transport_status: "received",
        intent_queue: "residential_sales",
        contact: {
          display_name: String(body.name ?? "") || null,
          phone: body.phone || null,
          email: body.email || null,
        },
        triage: { status: "Untriaged", summary: null, version: 1 },
        job: null,
        estimate: null,
        quote: null,
        proposal: null,
        consent: { context: "no_linked_record", records: [] },
        partial_fields: [],
        attention: ["triage_unresolved"],
      };
      onboardingState.leads.push(lead);
      onboardingState.intakeDetails[lead.id] = {
        name: body.name,
        email: body.email || null,
        phone: body.phone || null,
        address: body.address || null,
        city: body.city || null,
        province: body.province || null,
        postal_code: body.postal_code || null,
        service: body.service || null,
        message: body.message || null,
        source: "office",
        intake_source: body.intake_source ?? null,
        preferred_contact_channel: body.preferred_contact_channel ?? null,
        email_consent: {
          status: body.email_estimate_follow_up_consent ? "granted" : "not_recorded",
          purpose: "estimate_follow_up",
          recorded_at: body.email_estimate_follow_up_consent ? "2026-09-30T12:00:00.000Z" : null,
          captured_by: body.email_estimate_follow_up_consent ? "appu_acceptance_owner" : null,
          jurisdiction: body.email_estimate_follow_up_consent ? "CA-AB" : null,
          wording_version: body.email_estimate_follow_up_consent
            ? "synthetic-estimate-follow-up-v1"
            : null,
        },
      };
    }
    if (receiptMode) {
      const response = {
        version: 1,
        receipt: {
          request_id: requestId,
          state: "recorded",
          outcome: duplicate ? "duplicate" : "created",
          canonical_envelope_id: lead.envelope_id,
          lead_id: lead.id,
          submitted_details_applied: !duplicate,
          captured_at: "2026-09-30T12:00:00.000Z",
          details: onboardingState.intakeDetails[lead.id],
        },
      };
      onboardingState.intakeReceipts[requestId] = { bodySignature, response };
      return { status: 202, body: response };
    }
    return {
      status: 200,
      body: {
        version: 1,
        lead: {
          envelope_id: lead.envelope_id,
          canonical_envelope_id: lead.envelope_id,
          tenant_id: "freshco",
          status: duplicate ? "duplicate" : "received",
          duplicate,
          queue: "residential_sales",
        },
      },
    };
  }
  return null;
}

function initialSafetyEquipment() {
  const equipment = (equipment_id, verdict, overrides = {}) => ({
    equipment_id,
    equipment_kind: "fall_arrest_harness",
    serial_number: `ACCEPTANCE-${"S".repeat(120)}`,
    version: 1,
    inspection_interval_days: 180,
    last_inspection_at: "2026-08-20T09:00:00.000Z",
    replaced_by_equipment_id: null,
    updated_at: "2026-08-20T09:00:00.000Z",
    status: "in_service",
    assigned_user_id: `appu_acceptance_${"h".repeat(180)}`,
    inspection_due_at: "2027-01-01T00:00:00.000Z",
    last_inspection_result: "pass",
    verdict,
    detail: null,
    days_left: 134,
    ...overrides,
  });
  return Object.fromEntries(
    [
      equipment("eq_acceptance_clear", "serviceable"),
      equipment("eq_acceptance_due", "expiring", {
        days_left: 5,
        inspection_due_at: "2026-08-25T09:00:00.000Z",
      }),
      equipment("eq_acceptance_failed", "unserviceable", {
        status: "quarantined",
        last_inspection_result: "fail",
        detail: "The last inspection failed. Take this harness out of service.",
      }),
    ].map((record) => [record.equipment_id, record]),
  );
}
let safetyEquipmentState = initialSafetyEquipment();

function initialCorrectiveActions() {
  const actions = [
    {
      corrective_action_id: "ca_acceptance_blocking",
      occurrence_id: `so_acceptance_${"o".repeat(180)}`,
      state: "open",
      risk_level: "high",
      owner_user_id: `appu_acceptance_${"a".repeat(180)}`,
      due_at: "2026-08-19T09:00:00.000Z",
      description: `Install a ladder tie-off point. Reference ${"R".repeat(180)}`,
      blocking: true,
      days_left: -1,
    },
    {
      corrective_action_id: "ca_acceptance_tracking",
      occurrence_id: "so_acceptance_low",
      state: "open",
      risk_level: "low",
      owner_user_id: "appu_acceptance_field",
      due_at: "2026-08-19T09:00:00.000Z",
      description: "Replace the faded storage label.",
      blocking: false,
      days_left: -1,
    },
    // Reported by the office fixture user: the reporter holds full authority and still may
    // not verify, exactly as `verifyCorrectiveAction` refuses on the Worker.
    {
      corrective_action_id: "ca_acceptance_reported",
      occurrence_id: "so_acceptance_reported",
      reported_by_user_id: "appu_acceptance_owner",
      state: "open",
      risk_level: "low",
      owner_user_id: "appu_acceptance_field",
      due_at: "2026-08-21T09:00:00.000Z",
      description: "Re-hang the fire extinguisher sign.",
      blocking: false,
      days_left: 1,
    },
  ];
  return Object.fromEntries(
    actions.map((action) => [
      action.corrective_action_id,
      {
        version: 1,
        reported_by_user_id: "appu_acceptance_reporter",
        evidence_refs_json: null,
        evidence_sha256: null,
        evidence_captured_by_user_id: null,
        evidence_submitted_at: null,
        verified_by_user_id: null,
        verified_at: null,
        closed_at: null,
        ...action,
        ...(["ca_acceptance_tracking", "ca_acceptance_reported"].includes(
          action.corrective_action_id,
        )
          ? {
              state: "evidence_submitted",
              version: 2,
              evidence_refs_json: JSON.stringify([
                { ref: "r2://safety/label-check.pdf", sha256: "a".repeat(64) },
              ]),
              evidence_sha256: "b".repeat(64),
              evidence_captured_by_user_id: "appu_acceptance_field",
              evidence_submitted_at: "2026-08-20T09:00:00.000Z",
            }
          : {}),
      },
    ]),
  );
}
let correctiveActionState = initialCorrectiveActions();
let safetySessionRevoked = false;
const revokedSessionResponse = (response, method) =>
  sendJson(response, method, 401, {
    error: "session_invalid",
    message: "Your sign-in is no longer valid. Sign in again.",
  });

const requestListener = async (request, response) => {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === "/healthz") {
    return sendJson(response, method, 200, { ok: true });
  }
  if (ACCEPTANCE_MODE === "estimator") {
    const manual = await routeManualMeasurements(request, requestUrl, method);
    if (manual) return sendJson(response, method, manual.status, manual.body);
  }
  if (method === "POST" && requestUrl.pathname === "/__acceptance/fleet/reset") {
    resetFleetCaptureState();
    return sendJson(response, method, 200, { ok: true });
  }
  if (method === "POST" && requestUrl.pathname === "/__acceptance/customer-portal/reset") {
    resetCustomerPortalState();
    return sendJson(response, method, 200, { ok: true });
  }
  if (method === "GET" && requestUrl.pathname === "/__acceptance/customer-portal/decisions") {
    return sendJson(response, method, 200, { decisions: customerPortalState.decisions });
  }
  // The portal is a customer surface, not one of the three office/field profiles, so it is
  // served in every mode rather than gated behind one.
  if (method === "POST" && requestUrl.pathname.startsWith("/api/v1/customer-portal/")) {
    const portal = await routeCustomerPortal(request, requestUrl);
    if (portal) return sendJson(response, method, portal.status, portal.body);
  }
  // The People desk (IRO-251): current authority heads with the server's own verdict. Synthetic
  // subjects only, and no issuer is contacted here or in production for this read.
  if (method === "GET" && requestUrl.pathname === "/api/v1/authority-records") {
    return sendJson(response, method, 200, {
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      expiring_within_days: 30,
      subjects: [
        {
          subject_key: "Person|Worker|expired.acceptance@example.invalid|",
          subject_type: "Person",
          subject_role: "Worker",
          person_user: "expired.acceptance@example.invalid",
          organization: null,
          records: [
            {
              authority_record_id: "Authority-Record-Acceptance-0002",
              authority_version: 2,
              authority_kind: "Fall Protection",
              authority_scope: "field installation",
              scope_type: "Field",
              scope_ref: "field:job-acceptance",
              issuer_name: "Alberta issuer",
              issuer_jurisdiction: "AB-CA",
              verification_state: "verified",
              authority_effective_from: "2025-01-01",
              authority_expires_at: "2026-01-01",
              authority_revoked_at: null,
              observed_at: "2026-08-20T09:00:00.000Z",
              verdict: "expired",
              denial_code: "authority_expired",
              days_left: -231,
            },
          ],
        },
        {
          subject_key: "Person|Worker|clear.acceptance@example.invalid|",
          subject_type: "Person",
          subject_role: "Worker",
          person_user: "clear.acceptance@example.invalid",
          organization: null,
          records: [
            {
              authority_record_id: "Authority-Record-Acceptance-0001",
              authority_version: 1,
              authority_kind: "Worker Competency",
              authority_scope: "field installation",
              scope_type: "Field",
              scope_ref: "field:job-acceptance",
              issuer_name: "Alberta issuer",
              issuer_jurisdiction: "AB-CA",
              verification_state: "verified",
              authority_effective_from: "2026-01-01",
              authority_expires_at: "2027-06-30",
              authority_revoked_at: null,
              observed_at: "2026-08-20T09:00:00.000Z",
              verdict: "clear",
              denial_code: null,
              days_left: 314,
            },
          ],
        },
      ],
    });
  }
  if (method === "POST" && requestUrl.pathname === "/__acceptance/safety/reset") {
    safetyEquipmentState = initialSafetyEquipment();
    correctiveActionState = initialCorrectiveActions();
    safetySessionRevoked = false;
    return sendJson(response, method, 200, { ok: true });
  }
  // Test-only: the office session is revoked mid-form. Every safety command then answers the way
  // the Worker does when `requireAppSession` refuses a stale cookie, so the browser spec can prove
  // the page keeps the person's findings and job context instead of losing them.
  if (method === "POST" && requestUrl.pathname === "/__acceptance/safety/revoke-session") {
    safetySessionRevoked = true;
    return sendJson(response, method, 200, { ok: true });
  }
  const correctiveMatch = requestUrl.pathname.match(
    /^\/api\/v1\/safety\/corrective-actions\/([^/]+)(?:\/(evidence|verification|closure))?$/,
  );
  if (correctiveMatch) {
    const action = correctiveActionState[correctiveMatch[1]];
    if (!action) return sendJson(response, method, 404, { error: "not_found" });
    const actor = currentFixtureSession().user;
    const authority = ["owner", "ops", "production"].includes(actor.role);
    // Same separation of duties as the Worker: reporter, owner, and evidence capturer are out.
    const independent =
      actor.id !== action.owner_user_id &&
      actor.id !== action.evidence_captured_by_user_id &&
      actor.id !== action.reported_by_user_id;
    const allowed = [
      ...(action.state === "open" ? ["submit_evidence"] : []),
      ...(action.state === "evidence_submitted" && authority && independent
        ? ["verify", "reject"]
        : []),
      ...(action.state === "verified" && authority ? ["close"] : []),
    ];
    if (method === "GET" && !correctiveMatch[2])
      return sendJson(response, method, 200, {
        version: 1,
        corrective_action: action,
        allowed_actions: allowed,
        verification_unavailable_reason:
          action.state === "evidence_submitted" && (!authority || !independent)
            ? "The reporter, owner, and evidence capturer cannot verify this closure."
            : null,
      });
    if (method === "POST") {
      if (safetySessionRevoked) return revokedSessionResponse(response, method);
      const input = await readJsonBody(request);
      const command = correctiveMatch[2];
      if (
        command === "evidence" &&
        action.state === "open" &&
        typeof input.evidence_refs_json === "string" &&
        /^[a-f0-9]{64}$/.test(input.evidence_sha256)
      ) {
        Object.assign(action, {
          state: "evidence_submitted",
          version: action.version + 1,
          evidence_refs_json: input.evidence_refs_json,
          evidence_sha256: input.evidence_sha256,
          evidence_captured_by_user_id: actor.id,
          evidence_submitted_at: "2026-08-20T10:00:00.000Z",
        });
      } else if (
        command === "verification" &&
        allowed.includes("verify") &&
        ["verified", "rejected"].includes(input.verdict)
      ) {
        action.state = input.verdict;
        action.version += 1;
        action.verified_by_user_id = actor.id;
        action.verified_at = "2026-08-20T11:00:00.000Z";
      } else if (command === "closure" && allowed.includes("close")) {
        action.state = "closed";
        action.version += 1;
        action.closed_at = "2026-08-20T12:00:00.000Z";
      } else
        return sendJson(response, method, 409, { error: "safety_corrective_action_state_invalid" });
      return sendJson(response, method, 200, { version: 1, corrective_action: action });
    }
  }
  const safetyEquipmentMatch = requestUrl.pathname.match(
    /^\/api\/v1\/safety\/equipment\/([^/]+)(\/inspections)?$/,
  );
  if (safetyEquipmentMatch) {
    const record = safetyEquipmentState[safetyEquipmentMatch[1]];
    if (!record) return sendJson(response, method, 404, { error: "not_found" });
    if (method === "GET" && !safetyEquipmentMatch[2]) {
      return sendJson(response, method, 200, { version: 1, equipment: record });
    }
    if (method === "POST" && safetyEquipmentMatch[2]) {
      if (safetySessionRevoked) return revokedSessionResponse(response, method);
      const input = await readJsonBody(request);
      if (
        !["pass", "fail"].includes(input.result) ||
        typeof input.detail !== "string" ||
        input.detail.trim().length < 3
      ) {
        return sendJson(response, method, 400, { error: "safety_equipment_input_invalid" });
      }
      if (!Number.isInteger(input.expected_version) || input.expected_version < 1)
        return sendJson(response, method, 400, { error: "safety_equipment_input_invalid" });
      // Same rule as the Worker: a verdict binds to the revision the inspector read.
      if (input.expected_version !== record.version)
        return sendJson(response, method, 409, {
          error: "safety_equipment_version_conflict",
          message: `This equipment changed since it was read (revision ${input.expected_version} read, revision ${record.version} on file). Read the current record before inspecting.`,
        });
      record.version += 1;
      record.last_inspection_result = input.result;
      record.status = input.result === "pass" ? "in_service" : "quarantined";
      record.verdict = input.result === "pass" ? "serviceable" : "unserviceable";
      record.detail =
        input.result === "pass"
          ? null
          : "The last inspection failed. Take this harness out of service.";
      record.last_inspection_at = "2026-08-20T10:00:00.000Z";
      record.updated_at = record.last_inspection_at;
      record.inspection_due_at = "2027-02-16T10:00:00.000Z";
      return sendJson(response, method, 200, { version: 1, equipment: record });
    }
  }
  if (method === "GET" && requestUrl.pathname === "/api/v1/safety/desk") {
    return sendJson(response, method, 200, {
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      expiring_within_days: 30,
      actor_role: "owner",
      equipment: Object.values(safetyEquipmentState),
      corrective_actions: Object.values(correctiveActionState).filter(
        (action) => !["closed", "rejected"].includes(action.state),
      ),
    });
  }
  if (ACCEPTANCE_MODE === "onboarding") {
    // The real logo lives in R2 behind `/public/company-logo`. A 1x1 PNG is enough for the
    // screens to prove they point at it, and for a "no logo yet" state to 404 into its fallback.
    if (method === "GET" && requestUrl.pathname === "/public/company-logo") {
      if (!onboardingState.profile.logo) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return response.end("Not found");
      }
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return response.end(Buffer.from(ACCEPTANCE_PNG_1X1, "base64"));
    }
    const onboarding = await routeOnboarding(request, requestUrl, method);
    if (onboarding) return sendJson(response, method, onboarding.status, onboarding.body);
  }
  const captureKind =
    ACCEPTANCE_MODE === "field" && method === "POST"
      ? fleetCaptureRoute(requestUrl.pathname)
      : null;
  if (captureKind) {
    const body = await readJsonBody(request);
    const deviceActionId = body?.device_action_id;
    if (typeof deviceActionId !== "string" || !deviceActionId) {
      return sendJson(response, method, 400, { error: "invalid_fleet_action" });
    }
    const capturedAt = body?.payload?.performed_at ?? body?.payload?.detected_at ?? null;
    if (captureKind === "pre_trip") fleetCaptureState.preTripAt = capturedAt;
    if (captureKind === "post_trip") fleetCaptureState.postTripAt = capturedAt;
    if (captureKind === "defect") {
      fleetCaptureState.defects.push({ severity: body?.payload?.severity ?? "Minor" });
    }
    return sendJson(response, method, 200, {
      device_action_id: deviceActionId,
      status: "verified",
      server_ref: `${captureKind}:${deviceActionId}`,
      cursor: "FLEET-ACCEPTANCE",
    });
  }

  if (ACCEPTANCE_MODE === "field" && method === "POST") {
    const mutation = await routeFieldMutation(request, requestUrl);
    if (mutation) return sendPreparedJson(response, method, mutation);
    if (
      requestUrl.pathname.startsWith("/api/") ||
      requestUrl.pathname === "/__acceptance__/reset"
    ) {
      return sendJson(response, method, 404, { error: "not_found" });
    }
  }

  // `POST /api/v1/document-generations` mirrors the committed flag state above: owner only,
  // idempotency key required, and refused as unavailable because APP_DOCUMENT_GENERATION_ENABLED
  // is "false" in every checked-in environment. The success path is proven on the Worker
  // (`workers-bus/test/document-generation-r2-api.test.ts`), not invented here.
  if (method === "POST" && requestUrl.pathname === "/api/v1/document-generations") {
    if (currentFixtureSession().user.role !== "owner")
      return sendJson(response, method, 403, { error: "document_generation_forbidden" });
    if (!/^[A-Za-z0-9._:-]{8,140}$/.test(request.headers["idempotency-key"] ?? ""))
      return sendJson(response, method, 400, { error: "idempotency_key_required" });
    return sendJson(response, method, 503, { error: "document_generation_unavailable" });
  }
  if (method !== "GET" && method !== "HEAD") {
    return sendJson(response, method, 405, { error: "method_not_allowed" });
  }
  if (requestUrl.pathname === "/api/v1/session") {
    return sendJson(response, method, 200, currentFixtureSession());
  }
  if (requestUrl.pathname === "/api/v1/capabilities") {
    return sendJson(response, method, 200, fixtureCapabilities(currentFixtureSession()));
  }
  if (requestUrl.pathname === "/api/v1/search") {
    return sendJson(
      response,
      method,
      200,
      fixtureOperatorSearch(requestUrl.searchParams.get("q") ?? ""),
    );
  }
  if (ACCEPTANCE_MODE === "accounting") {
    if (requestUrl.pathname === "/api/v1/accounting/summary") {
      return sendJson(response, method, 200, fixtureAccountingSummary);
    }
    if (requestUrl.pathname === "/api/v1/accounting/exceptions") {
      return sendJson(response, method, 200, fixtureAccountingExceptions);
    }
    if (requestUrl.pathname.startsWith("/api/v1/accounting/intents/")) {
      return sendJson(response, method, 200, fixtureAccountingDetail);
    }
    if (requestUrl.pathname === "/api/v1/quickbooks/connection") {
      return sendJson(response, method, 200, fixtureAccountingConnection);
    }
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
      today: todayWithActiveStops(fixtureToday),
    });
  }
  if (ACCEPTANCE_MODE === "field" && requestUrl.pathname === "/api/v1/fleet/panel") {
    return sendJson(response, method, 200, fixtureFleetPanel());
  }
  if (requestUrl.pathname === "/api/v1/today") {
    return sendJson(response, method, 200, todayWithActiveStops(fixtureToday));
  }
  if (requestUrl.pathname === "/api/v1/operating-intake") {
    return sendJson(response, method, 200, fixtureOperatingIntake);
  }
  if (requestUrl.pathname === "/api/v1/schema-fields/job/roof-job-acceptance") {
    return sendJson(response, method, 200, jobSchemaCardState);
  }
  if (requestUrl.pathname === "/api/v1/documents/job/roof-job-acceptance") {
    return sendJson(response, method, 200, fixtureJobDocuments);
  }
  if (requestUrl.pathname === "/api/v1/jobs/JOB-ACCEPTANCE") {
    return sendJson(response, method, 200, buildFixtureJobResponse());
  }
  if (
    ACCEPTANCE_MODE === "field" &&
    requestUrl.pathname ===
      "/api/v1/work-objects/Shop%20Order/SHOP-ACCEPTANCE/physical-contexts/Shop%20Floor/SHOP-FLOOR-ACCEPTANCE"
  ) {
    if (request.headers["x-ironwrap-device-proof"] !== FIXTURE_FIELD_DEVICE_PROOF) {
      return sendJson(response, method, 401, { error: "not_authenticated" });
    }
    return sendJson(response, method, 200, buildFixtureWorkObjectResponse());
  }
  if (requestUrl.pathname === "/api/v1/safety/panel") {
    return sendJson(response, method, 200, buildSafetyPanelPayload());
  }
  if (
    ACCEPTANCE_MODE === "estimator" &&
    requestUrl.pathname === "/api/v1/estimator/jobs/JOB-ESTIMATOR-ACCEPTANCE"
  ) {
    return sendJson(response, method, 200, fixtureEstimatorWorkbench);
  }
  // The board's own e2e mocks these with page.route inside the spec, which
  // covers the move contract but leaves the surface unreachable outside
  // Playwright - so it could not be opened and looked at. Read-only here on
  // purpose: transitions stay the spec's stateful fixture.
  if (ACCEPTANCE_MODE === "estimator" && requestUrl.pathname === "/api/v1/pipelines") {
    return sendJson(response, method, 200, {
      ...fixturePipelineEnvelope,
      pipelines: [fixturePipeline],
    });
  }
  if (
    ACCEPTANCE_MODE === "estimator" &&
    requestUrl.pathname === "/api/v1/pipelines/pipe-sales/board"
  ) {
    return sendJson(response, method, 200, fixturePipelineBoard());
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
