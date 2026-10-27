// production-cancellation-window.test.ts - the OD-01 cancellation window (migration 0160): its
// derived state next to the gates, the holds on a firm start, the Materials attestation and a job's
// purchase order lines, a person's record of when the customer received the signed copy, the
// fail-safe end across a DST change, and the list of signed jobs still missing that time.
//
// The jobs here have no contract in D1, as one imported from the old system: the record carries no
// floor. A contract signed through the portal (the copy shown at signing, the floor of a record)
// is proven on the real acceptance flow in customer-contract-acceptance.test.ts. Each rule is driven
// through the real routes with a person's real cookie session, then broken by direct SQL the way a
// defective writer would, and refused by its own code.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import {
  OperatingJobAssignmentError,
  recordOperatingJobAssignment,
  type RecordOperatingJobAssignmentInput,
} from "../src/operating-job-assignment-store.ts";
import {
  businessDayTable,
  calendarEndOfTenthDay,
  cancellationWindowEndsAt,
  receivedAtInstant,
  windowEndSql,
  zoneOffsets,
} from "../src/production-cancellation-window.ts";
import {
  attestGateInLedger,
  bindCrewInLedger,
  d1Now,
  endCancellationWindow,
  fixtureSchedule,
  waiveGateInLedger,
} from "./production-gate-ledger-fixture.ts";

// Synthetic fixtures only: reserved example.invalid identities, and times relative to D1's clock.
const TENANT = "ironwrap";
const PEPPER = "synthetic-cancellation-window-pepper-0123456789";
const ZONE = "America/Edmonton";
const JOB = "job:window:0001";
const OTHER_JOB = "job:window:0002";
const ENDED_JOB = "job:window:0003";
const CREW = "crew:window:a";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const ITEM = "item_window_panel";
const UOM = "uom_window_each";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REASON = "The signed copy was emailed; the delivery receipt shows it arrived.";
const EVIDENCE = "Delivered email · signed copy.pdf";

const USERS = {
  owner: { id: "appu_owner_window_01", role: "owner", access: "owner" },
  ops: { id: "appu_ops_window_0001", role: "ops", access: "ops" },
  production: { id: "appu_production_window", role: "ops", access: "production" },
  seed: { id: "appu_seed_owner_window", role: "owner", access: "owner" },
  field: { id: "appu_field_window_001", role: "field", access: "field" },
} as const;
type User = (typeof USERS)[keyof typeof USERS];

/**
 * A database whose clock is the test's: every `'now'` the migrations' triggers and each statement
 * read is the (mocked) `Date`, so a case can stand D1 a millisecond either side of a window's end.
 */
class ClockedDatabase extends DatabaseSync {
  constructor() {
    super(":memory:");
    this.function("fixture_now", () => new Date().toISOString().replace("T", " ").replace("Z", ""));
  }

  prepare(sql: string) {
    return super.prepare(sql.replaceAll("'now'", "fixture_now()"));
  }

  exec(sql: string) {
    return super.exec(sql.replaceAll("'now'", "fixture_now()"));
  }
}

class TestD1 {
  readonly sqlite: DatabaseSync;

  constructor(sqlite = new DatabaseSync(":memory:")) {
    this.sqlite = sqlite;
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          async all<T>() {
            return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] };
          },
          async first<T>() {
            return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null;
          },
          async run() {
            return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...(values as never[])).changes) } };
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

interface Harness {
  env: AppEnv;
  db: TestD1;
  sqlite: DatabaseSync;
}

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
let keyCounter = 0;
const nextKey = () => `window-test-key-${String(++keyCounter).padStart(8, "0")}`;

function insertUser(db: DatabaseSync, user: User, createdBy = "owner@example.invalid") {
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    user.id, TENANT, `${user.id}@example.invalid`, `Synthetic ${user.access}`, user.role, user.access,
    user.role === "field" ? `${user.id}@example.invalid` : null, createdBy, at(-DAY), at(-DAY),
  );
}

function seedJob(db: DatabaseSync, jobId: string, suffix: string, status = "qualified"): void {
  const now = at(-DAY);
  const email = `window-${suffix}@example.invalid`;
  db.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES (?, 'manual', 'Window Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(`ow_window_${suffix}`, email, `raw/window/${suffix}.json`, now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'Window Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(`lead:window:${suffix}`, TENANT, `ow_window_${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
  ).run(`customer:window:${suffix}`, TENANT, `ow_window_${suffix}`, `Window Customer ${suffix}`, email, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
        service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ironwrap', ?, 'Roofing', ?, 'blocked', 1, ?, ?)`,
  ).run(
    jobId, TENANT, `lead:window:${suffix}`, `customer:window:${suffix}`, `ow_window_${suffix}`,
    `IW-WINDOW-${suffix}`, status, now, now,
  );
  for (const gate of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) {
    db.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'owner@example.invalid', ?, ?, 'No active blocker', ?, ?)`,
    ).run(`gate:${jobId}:${gate.toLowerCase()}`, TENANT, jobId, `ow_window_${suffix}`, gate, now, at(7 * DAY), now, now);
  }
}

/**
 * The full migration chain, three open jobs with six blocked gates each, a crew and the people.
 * `clocked` gives D1 the test's mocked clock (`ClockedDatabase`) instead of the real one.
 */
function setup(options: { clocked?: boolean } = {}): Harness {
  const db = new TestD1(options.clocked ? new ClockedDatabase() : undefined);
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    db.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of Object.values(USERS)) {
    insertUser(db.sqlite, user, user === USERS.seed ? SEED_CREATED_BY : undefined);
  }
  seedJob(db.sqlite, JOB, "0001");
  seedJob(db.sqlite, OTHER_JOB, "0002");
  seedJob(db.sqlite, ENDED_JOB, "0003");
  db.sqlite.prepare(
    `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES (?, ?, 'Window Crew', 'Active', 1, ?, ?)`,
  ).run(CREW, TENANT, at(-DAY), at(-DAY));
  db.sqlite.prepare(
    `INSERT INTO fleet_crew_members
       (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
     VALUES ('membership:window:field', ?, ?, ?, 1, 1, ?, ?)`,
  ).run(TENANT, CREW, USERS.field.id, at(-DAY), at(-DAY));
  const env = {
    DB: db as never,
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
    APP_TIME_ZONE: ZONE,
  } as AppEnv;
  return { env, db, sqlite: db.sqlite };
}

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function person(h: Harness, user: User): Promise<AuthContext> {
  const token = randomToken();
  h.sqlite.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(await sessionHashFor(h.env, token), user.id, TENANT, at(-MINUTE), at(HOUR), at(-MINUTE), "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    h.env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** A signed-in role without a person's cookie token: a connector, an agent host, a service token. */
function machine(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: at(-MINUTE),
      session_expires_at: at(HOUR),
      revoked_at: null,
      user_id: USERS.owner.id,
      tenant_id: TENANT,
      email_normalized: `${USERS.owner.id}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: at(-DAY),
      updated_at: at(-DAY),
    },
  };
}

async function call(
  h: Harness,
  auth: AuthContext,
  path: string,
  init: { method?: string; body?: unknown; key?: string | null; csrf?: boolean } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.csrf !== false) headers["x-csrf-token"] = auth.csrfToken;
  if (init.key !== null && init.method === "POST") headers["idempotency-key"] = init.key ?? nextKey();
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    h.env,
    auth,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const signedCopyPath = (job: string) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/cancellation-window/signed-copy`;
const gatesPath = (job: string) => `/api/v1/production/jobs/${encodeURIComponent(job)}/gates`;
const MISSING = "/api/v1/production/cancellation-window/signed-copy-missing";

function recordReceipt(
  h: Harness,
  auth: AuthContext,
  job: string,
  body: Record<string, unknown>,
  key?: string,
) {
  return call(h, auth, signedCopyPath(job), { method: "POST", body, key });
}

/** An instant `offsetMs` from D1's clock, in the form D1 stores. */
const d1At = (h: Harness, offsetMs: number) => new Date(d1Now(h.sqlite) + offsetMs).toISOString();

function receipts(h: Harness, job: string): Array<Record<string, any>> {
  return h.sqlite.prepare(
    `SELECT * FROM production_cancellation_window_receipts
      WHERE tenant_id = ? AND roof_job_id = ? ORDER BY received_at`,
  ).all(TENANT, job).map((row) => ({ ...row }));
}

function refusedWith(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

/** A record written straight into D1, as a defective writer would, with `overrides` on a valid row. */
function insertReceipt(h: Harness, overrides: Record<string, unknown> = {}): void {
  const receivedAt = String(overrides.received_at ?? d1At(h, -HOUR));
  const row: Record<string, unknown> = {
    receipt_id: `pcw_${String(++keyCounter).padStart(40, "0")}`,
    tenant_id: TENANT,
    roof_job_id: JOB,
    received_at: receivedAt,
    window_ends_at: new Date(Date.parse(receivedAt) + 10 * DAY).toISOString(),
    time_zone: ZONE,
    acceptance_binding_id: null,
    contract_signed_at: null,
    reason: REASON,
    evidence_ref: EVIDENCE,
    recorded_by_user_id: USERS.owner.id,
    recorded_by_role: "owner",
    request_sha256: "a".repeat(64),
    idempotency_key_hash: String(keyCounter).padStart(64, "0"),
    ...overrides,
  };
  const recordedAt = "recorded_at" in row ? "?" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const columns = Object.keys(row).filter((column) => column !== "recorded_at");
  h.sqlite.prepare(
    `INSERT INTO production_cancellation_window_receipts (${columns.join(", ")}, recorded_at)
     VALUES (${columns.map(() => "?").join(", ")}, ${recordedAt})`,
  ).run(...(columns.map((column) => row[column]) as never[]), ...("recorded_at" in row ? [row.recorded_at as never] : []));
}

/**
 * The gates a schedule rests on, cleared inside the window: Deposit and Materials waived by the
 * owner (a waiver is allowed inside the window, and lifts no hold), Safety, Access and Weather
 * attested by a production person on no crew. Crew is bound by the schedule itself.
 */
function readyInsideWindow(h: Harness, job: string): { start: string; end: string } {
  for (const gate of ["Deposit", "Materials"] as const) {
    waiveGateInLedger(h.sqlite, {
      tenantId: TENANT, roofJobId: job, gate, ownerUserId: USERS.owner.id,
      requesterUserId: USERS.production.id, requesterRole: "production",
    });
  }
  for (const gate of ["Safety", "Access", "Weather"] as const) {
    attestGateInLedger(h.sqlite, {
      tenantId: TENANT, roofJobId: job, gate, actorUserId: USERS.production.id,
      actorRole: "production", observerUserId: USERS.owner.id,
    });
  }
  return fixtureSchedule(1, d1Now(h.sqlite));
}

function scheduleCommand(job: string, actor: User = USERS.owner): RecordOperatingJobAssignmentInput {
  const day = fixtureSchedule(1, Date.now());
  return {
    tenantId: TENANT,
    roofJobId: job,
    expectedRoofJobVersion: 1,
    crewId: CREW,
    expectedCrewVersion: 1,
    authorityRequirements: [{
      authority_record_id: "authority:window:worker",
      subject_type: "Person",
      subject_role: "Worker",
      subject_ref: USERS.field.id,
      authority_kind: "Worker Competency",
      scope_type: "Roof Job",
      scope_ref: job,
      version: 1,
      state_digest_sha256: "c".repeat(64),
    }],
    scheduledStart: day.start,
    scheduledEnd: day.end,
    actorUserId: actor.id,
    idempotencyKey: nextKey(),
  };
}

async function refusedSchedule(
  h: Harness,
  command: RecordOperatingJobAssignmentInput,
  code: string,
): Promise<Readonly<Record<string, string>>> {
  let detail: Readonly<Record<string, string>> = {};
  await assert.rejects(recordOperatingJobAssignment(h.env, command), (error: unknown) => {
    assert.ok(error instanceof OperatingJobAssignmentError, String(error));
    assert.equal(error.code, code);
    detail = error.detail;
    return true;
  });
  return detail;
}

/**
 * An assignment written straight into D1, as a defective writer would, after the Crew entry that
 * names it. A refused insert leaves that entry standing, so the next attempt writes the same one.
 */
function insertAssignment(h: Harness, job: string, actor: User = USERS.owner): void {
  const assignmentId = `assignment:window:${job}`;
  const crew = h.sqlite.prepare(
    "SELECT state FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = 'Crew'",
  ).get(TENANT, job) as { state: string };
  if (crew.state === "blocked") {
    bindCrewInLedger(h.sqlite, {
      tenantId: TENANT, roofJobId: job, crewId: CREW, assignmentId, keepCancellationWindow: true,
    });
  }
  const day = fixtureSchedule(1, d1Now(h.sqlite));
  h.sqlite.prepare(
    `INSERT INTO operating_job_assignments
       (assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version, crew_id,
        crew_version, assigned_users_json, scheduled_start, scheduled_end, supersedes_assignment_id,
        correction_reason, actor_user_id, command_fingerprint, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, 1, 1, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    assignmentId, TENANT, job, CREW, JSON.stringify([USERS.field.id]), day.start, day.end, actor.id,
    "e".repeat(64), String(keyCounter).padStart(64, "f"), at(0),
  );
}

function seedInventory(h: Harness): void {
  h.sqlite.prepare(
    `INSERT INTO inventory_uoms (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at)
     VALUES (?, ?, 'EA', 'count', 0, 'active', ?, ?)`,
  ).run(UOM, TENANT, at(-DAY), at(-DAY));
  h.sqlite.prepare(
    `INSERT INTO inventory_items
       (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale,
        lot_controlled, valuation_method, source_ref, created_at, updated_at)
     VALUES (?, ?, 'PANEL-24', 'active', 'raw_material', ?, 0, 0, 'fifo', 'seed', ?, ?)`,
  ).run(ITEM, TENANT, UOM, at(-DAY), at(-DAY));
}

/** A purchase order line, for `job` or for stock (`null`), placed the way any writer places one. */
function placeOrderLine(h: Harness, job: string | null, status = "ordered"): string {
  const id = `po_line_window_${String(++keyCounter).padStart(6, "0")}`;
  h.sqlite.prepare(
    `INSERT INTO inventory_po_lines
       (po_line_id, tenant_id, supplier_order_id, line_no, item_id, uom_id, ordered_quantity_scaled,
        unit_price_minor, line_identity_sha256, status, created_at, updated_at, roof_job_id)
     VALUES (?, ?, ?, 1, ?, ?, 10, 500, ?, ?, ?, ?, ?)`,
  ).run(id, TENANT, `SO-${id}`, ITEM, UOM, String(keyCounter).padStart(64, "b"), status, at(0), at(0), job);
  return id;
}

function moveOrderLine(h: Harness, id: string, status: string): void {
  h.sqlite.prepare(
    `UPDATE inventory_po_lines SET status = ?, version = version + 1, updated_at = ? WHERE po_line_id = ?`,
  ).run(status, at(0), id);
}

/** An instant on the business clock, as "Tue 2026-11-03 18:26:00.000". */
function localDateTime(instant: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

// ------------------------------------------------------------------------------- the state

test("the window is a System state next to the gates, unknown until recorded, then open, then ended", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  const before = await call(h, owner, gatesPath(JOB));
  assert.equal(before.status, 200);
  assert.equal(before.body.gates.length, 6);
  assert.deepEqual(before.body.cancellation_window, {
    kind: "system_state",
    state: "unknown",
    waivable: false,
    unknown_reason: "signed_copy_time_missing",
    starts_at: null,
    started_from: null,
    ends_at: null,
    contract: null,
    signed_copy_shown: null,
    signed_copy_received: null,
    holds: ["firm_start", "materials_attestation", "supplier_order"],
    time_zone: ZONE,
    as_of: before.body.cancellation_window.as_of,
  });
  assert.ok(Math.abs(Date.parse(before.body.cancellation_window.as_of) - d1Now(h.sqlite)) < MINUTE);

  // An hour ago: the window is open, and ends at the end of the 10th business day after the receipt.
  const receivedAt = d1At(h, -HOUR);
  const recorded = await recordReceipt(h, owner, JOB, {
    received_at: receivedAt, reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const open = recorded.body.cancellation_window;
  assert.equal(open.state, "open");
  assert.equal(open.ends_at, cancellationWindowEndsAt(receivedAt, ZONE));
  assert.equal(open.starts_at, receivedAt);
  assert.equal(open.started_from, "manual_record");
  assert.equal(open.unknown_reason, null);
  assert.deepEqual(open.holds, ["firm_start", "materials_attestation", "supplier_order"]);
  assert.deepEqual(
    { ...open.signed_copy_received, id: undefined, recorded_at: undefined },
    {
      id: undefined,
      received_at: receivedAt,
      window_ends_at: open.ends_at,
      time_zone: ZONE,
      contract_signed_at: null,
      acceptance_binding_id: null,
      // No contract in D1, so no floor applied: the receipt says so.
      no_d1_contract: true,
      reason: REASON,
      evidence_ref: EVIDENCE,
      recorded_at: undefined,
      recorded_by: { display_name: "Synthetic owner", role: "owner" },
    },
  );
  assert.deepEqual((await call(h, owner, gatesPath(JOB))).body.cancellation_window.signed_copy_received.id, recorded.body.receipt_id);

  // Twelve days ago: the window has ended and holds nothing.
  const ended = await recordReceipt(h, owner, ENDED_JOB, {
    received_at: d1At(h, -12 * DAY), reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(ended.status, 201);
  assert.equal(ended.body.cancellation_window.state, "ended");
  assert.deepEqual(ended.body.cancellation_window.holds, []);
  assert.ok(Date.parse(ended.body.cancellation_window.ends_at) < d1Now(h.sqlite));
});

test("the window is not a gate and cannot be waived: no gate, no ledger, and a Materials waiver lifts no hold", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  const production = await person(h, USERS.production);
  // There is no gate to clear or waive: the routes know only the scheduling gates.
  for (const gate of ["Cancellation", "Cancellation%20window", "cancellation_window"]) {
    const waiver = await call(h, production, `/api/v1/production/jobs/${encodeURIComponent(JOB)}/gates/${gate}/clearance`, {
      method: "POST", body: { basis: "office_waiver", reason: "Synthetic attempt to waive the window." },
    });
    assert.equal(waiver.status, 400, gate);
    assert.equal(waiver.body.error, "invalid_production_gate_clearance");
    const decision = await call(h, owner, `/api/v1/production/jobs/${encodeURIComponent(JOB)}/gates/${gate}/waiver-decisions`, {
      method: "POST",
      body: { request_id: `pgc_${"0".repeat(40)}`, expected_gate_version: 1, decision: "approve", reason: "Synthetic decision." },
    });
    assert.ok(decision.status >= 400, gate);
  }
  refusedWith(
    () => h.sqlite.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES ('gate:window:cancellation', ?, ?, 'ow_window_0001', 'Cancellation window',
               'owner@example.invalid', ?, ?, 'No active blocker', ?, ?)`,
    ).run(TENANT, JOB, at(0), at(DAY), at(0), at(0)),
    "CHECK constraint failed",
  );

  // Materials waived inside the window: Materials reads waived, and the window still holds the
  // firm start and every purchase order line of the job.
  seedInventory(h);
  readyInsideWindow(h, JOB);
  const gates = (await call(h, owner, gatesPath(JOB))).body;
  assert.equal(gates.gates.find((gate: { gate: string }) => gate.gate === "Materials").state, "waived");
  assert.equal(gates.cancellation_window.state, "unknown");
  assert.equal(gates.cancellation_window.waivable, false);
  await refusedSchedule(h, scheduleCommand(JOB), "operating_job_assignment_cancellation_window_unknown");
  refusedWith(() => placeOrderLine(h, JOB), "inventory_po_line_cancellation_window_unknown");
});

// ------------------------------------------------------------------------------- the holds

test("a firm start waits for the window by name on the store, the route and in D1, after 0098 and before 0159", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  // 0098 answers first: with its gates blocked the job is refused for the gates, window or not,
  // on the store and in D1, where 0160 re-creates 0098's trigger to fire before its own hold.
  await refusedSchedule(h, scheduleCommand(JOB), "operating_job_assignment_gates_blocked");
  refusedWith(() => insertAssignment(h, OTHER_JOB), "operating_job_assignment_gates_blocked");

  readyInsideWindow(h, JOB);
  const unknown = await refusedSchedule(h, scheduleCommand(JOB), "operating_job_assignment_cancellation_window_unknown");
  assert.deepEqual(unknown, { unknown_reason: "signed_copy_time_missing" });
  const day = fixtureSchedule(1, Date.now());
  const route = await call(h, owner, `/api/v1/jobs/${encodeURIComponent(JOB)}/schedule`, {
    method: "POST",
    body: {
      expected_roof_job_version: 1,
      crew_id: CREW,
      expected_crew_version: 1,
      authority_requirements: scheduleCommand(JOB).authorityRequirements,
      scheduled_start: day.start,
      scheduled_end: day.end,
      supersedes_assignment_id: null,
      correction_reason: null,
    },
  });
  assert.equal(route.status, 409);
  assert.deepEqual(route.body, {
    unknown_reason: "signed_copy_time_missing",
    error: "operating_job_assignment_cancellation_window_unknown",
  });
  refusedWith(() => insertAssignment(h, JOB), "operating_job_assignment_cancellation_window_unknown");

  // Recorded an hour ago, the window is open until it ends; the refusal names the end.
  const recorded = await recordReceipt(h, owner, JOB, {
    received_at: d1At(h, -HOUR), reason: REASON, evidence_ref: EVIDENCE,
  });
  const endsAt = recorded.body.cancellation_window.ends_at as string;
  const open = await refusedSchedule(h, scheduleCommand(JOB), "operating_job_assignment_cancellation_window_open");
  assert.deepEqual(open, { window_ends_at: endsAt });
  refusedWith(() => insertAssignment(h, JOB), "operating_job_assignment_cancellation_window_open");
  // The window answers before 0159's rules: the QA seed owner is refused by the window first...
  await refusedSchedule(h, scheduleCommand(JOB, USERS.seed), "operating_job_assignment_cancellation_window_open");
  assert.equal(
    (h.sqlite.prepare("SELECT COUNT(*) AS n FROM operating_job_assignments").get() as { n: number }).n,
    0,
  );

  // ...and once a window has ended, 0159 answers for the seed owner, and a person schedules.
  readyInsideWindow(h, ENDED_JOB);
  endCancellationWindow(h.sqlite, { tenantId: TENANT, roofJobId: ENDED_JOB });
  await refusedSchedule(h, scheduleCommand(ENDED_JOB, USERS.seed), "operating_job_assignment_seed_identity_refused");
  const scheduled = await recordOperatingJobAssignment(h.env, scheduleCommand(ENDED_JOB));
  assert.equal(scheduled.kind, "created");
});

test("the Materials attestation waits for the window, on the route and in D1; Safety, Access and a waiver do not", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  const production = await person(h, USERS.production);
  const attestMaterials = (job: string) =>
    call(h, production, `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/Materials/clearance`, {
      method: "POST",
      body: {
        basis: "person_attestation",
        expected_gate_version: 1,
        attestation: { source: "supplier_delivery", reference: "DELIVERY-WINDOW-0001" },
      },
    });
  const materialsEntries = (job: string) => (h.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM production_gate_clearances WHERE roof_job_id = ? AND gate = 'Materials'`,
  ).get(job) as { n: number }).n;
  const directMaterialsClear = (job: string) => h.sqlite.prepare(
    `INSERT INTO production_gate_clearances
       (clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
        from_gate_version, actor_kind, actor_user_id, actor_role, attestation_json,
        evidence_refs_json, request_sha256, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, ?, 'Materials', 'clear', 'person_attestation', 'ready', 1, 'person', ?,
             'production', '{"reference":"DELIVERY-WINDOW-0002","source":"supplier_delivery"}',
             '[]', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(
    `pgc_${String(++keyCounter).padStart(40, "0")}`, TENANT, `gate:${job}:materials`, job,
    USERS.production.id, "a".repeat(64), String(keyCounter).padStart(64, "c"),
  );

  // Unknown: refused by name, with the reason the UI offers its one fix for; nothing appended.
  const unknown = await attestMaterials(JOB);
  assert.equal(unknown.status, 409);
  assert.deepEqual(unknown.body, {
    unknown_reason: "signed_copy_time_missing",
    error: "production_gate_cancellation_window_unknown",
  });
  refusedWith(() => directMaterialsClear(JOB), "production_gate_cancellation_window_unknown");
  assert.equal(materialsEntries(JOB), 0);

  // Inside the window a person still clears Access on the route, and Safety; and asks for a
  // Materials waiver, which the owner decides.
  const access = await call(h, production, `/api/v1/production/jobs/${encodeURIComponent(JOB)}/gates/Access/clearance`, {
    method: "POST",
    body: {
      basis: "person_attestation",
      expected_gate_version: 1,
      attestation: { confirmed_with: "customer", confirmed_at: d1At(h, -HOUR) },
    },
  });
  assert.equal(access.status, 200, JSON.stringify(access.body));
  assert.equal(access.body.gate.state, "ready");
  attestGateInLedger(h.sqlite, {
    tenantId: TENANT, roofJobId: JOB, gate: "Safety", actorUserId: USERS.production.id,
    actorRole: "production", observerUserId: USERS.owner.id,
  });
  const requested = await call(h, production, `/api/v1/production/jobs/${encodeURIComponent(JOB)}/gates/Materials/clearance`, {
    method: "POST", body: { basis: "office_waiver", reason: "Synthetic: the panels are already in the yard." },
  });
  assert.equal(requested.status, 409);
  assert.equal(requested.body.error, "production_gate_waiver_requested");
  const gates = (await call(h, owner, gatesPath(JOB))).body.gates;
  const materials = gates.find((gate: { gate: string }) => gate.gate === "Materials");
  const decided = await call(h, owner, `/api/v1/production/jobs/${encodeURIComponent(JOB)}/gates/Materials/waiver-decisions`, {
    method: "POST",
    body: {
      request_id: materials.open_waiver_requests[0].request_id,
      expected_gate_version: materials.version,
      decision: "approve",
      reason: "Synthetic: the owner checked the yard this morning.",
    },
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.gate.state, "waived");

  // Open: refused with the end.
  const recorded = await recordReceipt(h, owner, OTHER_JOB, {
    received_at: d1At(h, -HOUR), reason: REASON, evidence_ref: EVIDENCE,
  });
  const open = await attestMaterials(OTHER_JOB);
  assert.equal(open.status, 409);
  assert.deepEqual(open.body, {
    window_ends_at: recorded.body.cancellation_window.ends_at,
    error: "production_gate_cancellation_window_open",
  });
  refusedWith(() => directMaterialsClear(OTHER_JOB), "production_gate_cancellation_window_open");
  assert.equal(materialsEntries(OTHER_JOB), 0);

  // Ended: Materials clears with its proof.
  endCancellationWindow(h.sqlite, { tenantId: TENANT, roofJobId: ENDED_JOB });
  const ended = await attestMaterials(ENDED_JOB);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.gate.state, "ready");
});

test("a job's purchase order line waits for the window; a stock line never does; the link never changes", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  seedInventory(h);
  // Unknown: the job's line is refused; coil into stock, with no job, is not held.
  placeOrderLine(h, null);
  refusedWith(() => placeOrderLine(h, JOB), "inventory_po_line_cancellation_window_unknown");
  refusedWith(() => placeOrderLine(h, JOB, "backordered"), "inventory_po_line_cancellation_window_unknown");
  refusedWith(() => placeOrderLine(h, "job:window:9999"), "inventory_po_line_job_unknown");

  // Open: still refused, with no exception for a waived Materials gate.
  waiveGateInLedger(h.sqlite, {
    tenantId: TENANT, roofJobId: JOB, gate: "Materials", ownerUserId: USERS.owner.id,
    requesterUserId: USERS.production.id, requesterRole: "production",
  });
  await recordReceipt(h, owner, JOB, { received_at: d1At(h, -HOUR), reason: REASON, evidence_ref: EVIDENCE });
  refusedWith(() => placeOrderLine(h, JOB), "inventory_po_line_cancellation_window_open");
  placeOrderLine(h, null);

  // A line of this job written before the hold existed may be received or cancelled while the
  // window holds, but never moved back to ordered.
  const guard = h.sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'inventory_po_lines_cancellation_window_hold'",
  ).get() as { sql: string };
  h.sqlite.exec("DROP TRIGGER inventory_po_lines_cancellation_window_hold");
  const legacy = placeOrderLine(h, JOB, "backordered");
  const other = placeOrderLine(h, JOB, "backordered");
  const unknownLine = placeOrderLine(h, OTHER_JOB, "backordered");
  const stillOrdered = placeOrderLine(h, JOB, "ordered");
  h.sqlite.exec(guard.sql);
  // A line already ordered stays as it is: only a move back to ordered is held.
  h.sqlite.prepare(
    "UPDATE inventory_po_lines SET provider_po_id = 'PO-WINDOW-1', version = version + 1 WHERE po_line_id = ?",
  ).run(stillOrdered);
  moveOrderLine(h, stillOrdered, "partially_received");
  refusedWith(() => moveOrderLine(h, legacy, "ordered"), "inventory_po_line_cancellation_window_open");
  refusedWith(() => moveOrderLine(h, unknownLine, "ordered"), "inventory_po_line_cancellation_window_unknown");
  moveOrderLine(h, unknownLine, "cancelled");
  moveOrderLine(h, legacy, "cancelled");
  moveOrderLine(h, other, "exception");
  refusedWith(
    () => h.sqlite.prepare(
      "UPDATE inventory_po_lines SET roof_job_id = ?, version = version + 1 WHERE po_line_id = ?",
    ).run(OTHER_JOB, other),
    "inventory_po_line_job_link_immutable",
  );
  refusedWith(
    () => h.sqlite.prepare(
      "UPDATE inventory_po_lines SET roof_job_id = NULL, version = version + 1 WHERE po_line_id = ?",
    ).run(other),
    "inventory_po_line_job_link_immutable",
  );

  // Ended: the job's line is placed, and may move back to ordered.
  endCancellationWindow(h.sqlite, { tenantId: TENANT, roofJobId: ENDED_JOB });
  const placed = placeOrderLine(h, ENDED_JOB);
  moveOrderLine(h, placed, "backordered");
  moveOrderLine(h, placed, "ordered");
  assert.deepEqual(
    h.sqlite.prepare("SELECT roof_job_id, status FROM inventory_po_lines ORDER BY po_line_id").all()
      .map((row) => ({ ...row })),
    [
      { roof_job_id: null, status: "ordered" },
      { roof_job_id: null, status: "ordered" },
      { roof_job_id: JOB, status: "cancelled" },
      { roof_job_id: JOB, status: "exception" },
      { roof_job_id: OTHER_JOB, status: "cancelled" },
      { roof_job_id: JOB, status: "partially_received" },
      { roof_job_id: ENDED_JOB, status: "ordered" },
    ],
  );
});

// ------------------------------------------------------------------------------- the record step

test("an owner or ops person records when the copy was received, people only, with a reason and evidence", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  const ops = await person(h, USERS.ops);
  const production = await person(h, USERS.production);
  const seed = await person(h, USERS.seed);
  const body = { received_at: d1At(h, -2 * HOUR), reason: REASON, evidence_ref: EVIDENCE };

  assert.deepEqual(await recordReceipt(h, production, JOB, body), {
    status: 403, body: { error: "cancellation_window_receipt_owner_or_ops_required" },
  });
  assert.deepEqual(await recordReceipt(h, machine("owner"), JOB, body), {
    status: 403, body: { error: "person_session_required" },
  });
  assert.deepEqual(await call(h, owner, signedCopyPath(JOB), { method: "POST", body, csrf: false }), {
    status: 403, body: { error: "csrf_failed" },
  });
  assert.deepEqual(await call(h, owner, signedCopyPath(JOB), { method: "POST", body, key: null }), {
    status: 400, body: { error: "idempotency_key_required" },
  });
  // Frame 20c: each missing piece has its own code, and so do both together.
  for (const [patch, code] of [
    [{ reason: "" }, "cancellation_window_receipt_reason_required"],
    [{ reason: "short" }, "cancellation_window_receipt_reason_required"],
    [{ evidence_ref: "  " }, "cancellation_window_receipt_evidence_required"],
    [{ reason: undefined, evidence_ref: undefined }, "cancellation_window_receipt_reason_and_evidence_required"],
    [{ received_at: "2026-10-20T18:26:00" }, "cancellation_window_receipt_time_invalid"],
    [{ received_at: "2026-02-30T18:26:00-07:00" }, "cancellation_window_receipt_time_invalid"],
    [{ received_at: "Tue 18:26" }, "cancellation_window_receipt_time_invalid"],
  ] as const) {
    const refused = await recordReceipt(h, owner, JOB, { ...body, ...patch });
    assert.deepEqual(refused, { status: 400, body: { error: code } }, JSON.stringify(patch));
  }
  // Frame 22: a time after the server's now, full timestamp, read on the business clock.
  const future = d1At(h, HOUR);
  const inFuture = await recordReceipt(h, owner, JOB, { ...body, received_at: future });
  assert.equal(inFuture.status, 409);
  assert.equal(inFuture.body.error, "cancellation_window_receipt_in_future");
  assert.equal(inFuture.body.received_at, future);
  assert.equal(inFuture.body.time_zone, ZONE);
  assert.ok(Math.abs(Date.parse(inFuture.body.now) - d1Now(h.sqlite)) < MINUTE);
  // The QA seed owner is no person: D1 refuses it by name.
  assert.deepEqual(await recordReceipt(h, seed, JOB, body), {
    status: 403, body: { error: "cancellation_window_receipt_seed_identity_refused" },
  });
  assert.deepEqual(receipts(h, JOB), []);

  // Ops records it while the Worker's clock reads a day behind D1's: D1 stamps the record.
  const key = nextKey();
  mock.timers.enable({ apis: ["Date"], now: Date.now() - DAY });
  let first: Awaited<ReturnType<typeof recordReceipt>>;
  try {
    first = await recordReceipt(h, ops, JOB, body, key);
  } finally {
    mock.timers.reset();
  }
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const [stored] = receipts(h, JOB);
  assert.ok(Math.abs(Date.parse(stored!.recorded_at) - d1Now(h.sqlite)) < MINUTE, stored!.recorded_at);
  assert.deepEqual(
    { ...stored, recorded_at: undefined, request_sha256: undefined, idempotency_key_hash: undefined },
    {
      receipt_id: first.body.receipt_id,
      tenant_id: TENANT,
      roof_job_id: JOB,
      received_at: body.received_at,
      window_ends_at: cancellationWindowEndsAt(body.received_at, ZONE),
      time_zone: ZONE,
      acceptance_binding_id: null,
      contract_signed_at: null,
      reason: REASON,
      evidence_ref: EVIDENCE,
      recorded_by_user_id: USERS.ops.id,
      recorded_by_role: "ops",
      recorded_at: undefined,
      request_sha256: undefined,
      idempotency_key_hash: undefined,
    },
  );
  assert.equal(first.body.cancellation_window.signed_copy_received.recorded_by.role, "ops");
  // One audit row, written in the same statement, keyed by the record.
  assert.deepEqual(
    h.sqlite.prepare("SELECT ts, automation, trigger, action, approved_by, target_ids FROM audit_log WHERE run_id = ?")
      .all(stored!.receipt_id).map((row) => ({ ...row })),
    [{
      ts: stored!.recorded_at,
      automation: "production_cancellation_window",
      trigger: "person",
      action: "record:signed_copy_received",
      approved_by: USERS.ops.id,
      target_ids: `production_cancellation_window_receipt:${stored!.receipt_id}`,
    }],
  );

  // An exact replay answers as the first did; the same key with another body is a conflict.
  const replay = await recordReceipt(h, ops, JOB, body, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receipt_id, first.body.receipt_id);
  assert.deepEqual(
    await recordReceipt(h, ops, JOB, { ...body, evidence_ref: "Another reference" }, key),
    { status: 409, body: { error: "cancellation_window_receipt_replay_conflict" } },
  );

  // Frame 23: later only. Earlier is refused with the time on record, and nothing is saved.
  const earlier = d1At(h, -3 * HOUR);
  const refused = await recordReceipt(h, owner, JOB, { ...body, received_at: earlier });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    received_at: earlier,
    recorded_received_at: body.received_at,
    recorded_source: "manual_record",
    window_ends_at: stored!.window_ends_at,
    time_zone: ZONE,
    error: "cancellation_window_receipt_earlier_than_recorded",
  });
  // The same time again changes nothing.
  const same = await recordReceipt(h, owner, JOB, body);
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.recorded, false);
  assert.equal(receipts(h, JOB).length, 1);
  // A later time is recorded, keeps the first record, and never ends the window sooner: on the
  // same local day it ends at the same instant, and on a later day, later.
  const later = d1At(h, -HOUR);
  const moved = await recordReceipt(h, owner, JOB, { ...body, received_at: later });
  assert.equal(moved.status, 201);
  assert.equal(moved.body.cancellation_window.ends_at, cancellationWindowEndsAt(later, ZONE, stored!.window_ends_at));
  assert.ok(moved.body.cancellation_window.ends_at >= stored!.window_ends_at);
  assert.equal(moved.body.cancellation_window.starts_at, later);
  assert.deepEqual(receipts(h, JOB).map((row) => row.received_at), [body.received_at, later]);
});

test("D1 holds every record to its rules for a writer that skips the Worker", () => {
  const h = setup();
  h.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.ops.id);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ recorded_by_user_id: USERS.production.id, recorded_by_role: "ops" }, "cancellation_window_receipt_recorder_invalid"],
    [{ recorded_by_user_id: USERS.owner.id, recorded_by_role: "ops" }, "cancellation_window_receipt_recorder_invalid"],
    [{ recorded_by_user_id: USERS.ops.id, recorded_by_role: "ops" }, "cancellation_window_receipt_recorder_invalid"],
    [{ recorded_by_user_id: USERS.seed.id }, "cancellation_window_receipt_seed_identity_refused"],
    [{ roof_job_id: "job:window:9999" }, "cancellation_window_receipt_job_unknown"],
    [{ reason: " " }, "cancellation_window_receipt_reason_required"],
    [{ evidence_ref: "" }, "cancellation_window_receipt_evidence_required"],
    [{ reason: null, evidence_ref: null }, "cancellation_window_receipt_reason_and_evidence_required"],
    [{ received_at: "2026-10-20T18:26:00Z" }, "cancellation_window_receipt_time_invalid"],
    [{ received_at: d1At(h, 2 * MINUTE) }, "cancellation_window_receipt_in_future"],
    [{ acceptance_binding_id: "commercial-acceptance:none", contract_signed_at: d1At(h, -DAY) }, "cancellation_window_receipt_contract_changed"],
    [{ recorded_at: d1At(h, -DAY) }, "cancellation_window_receipt_recorded_at_invalid"],
  ];
  for (const [overrides, code] of cases) {
    refusedWith(() => insertReceipt(h, overrides), code);
  }
  assert.deepEqual(receipts(h, JOB), []);

  const receivedAt = d1At(h, -2 * HOUR);
  insertReceipt(h, { received_at: receivedAt });
  refusedWith(() => insertReceipt(h, { received_at: d1At(h, -3 * HOUR) }), "cancellation_window_receipt_earlier_than_recorded");
  refusedWith(() => insertReceipt(h, { received_at: receivedAt }), "cancellation_window_receipt_unchanged");
  // Append-only: no update, no delete, and REPLACE never overwrites a record.
  const [row] = receipts(h, JOB);
  refusedWith(
    () => h.sqlite.prepare("UPDATE production_cancellation_window_receipts SET reason = 'changed' WHERE receipt_id = ?").run(row!.receipt_id),
    "cancellation_window_receipt_append_only",
  );
  refusedWith(
    () => h.sqlite.prepare("DELETE FROM production_cancellation_window_receipts WHERE receipt_id = ?").run(row!.receipt_id),
    "cancellation_window_receipt_append_only",
  );
  refusedWith(
    () => h.sqlite.prepare(
      `INSERT OR REPLACE INTO production_cancellation_window_receipts
         SELECT * FROM production_cancellation_window_receipts WHERE receipt_id = ?`,
    ).run(row!.receipt_id),
    "cancellation_window_receipt_append_only",
  );
  assert.equal(receipts(h, JOB).length, 1);
});

// ------------------------------------------------------------------------------- the clock

test("the window ends at the end of the 10th local day after its start, at the latest of the zone's offsets (interim, pending counsel)", async () => {
  // The copy-source fixture: received Tue 18:26, so day 0 is that Tuesday, and the window holds
  // through the end of Friday the following week. It ends at the first instant of Saturday. Every
  // fixed time here is on a date whose offsets no time zone database release disagrees on. The day
  // is read by the runtime's rules and across the offsets Edmonton keeps (UTC-7 and UTC-6): the
  // latest day the receipt falls on, and the 11th day's midnight at UTC-7. The latest reading wins.
  assert.deepEqual(zoneOffsets(Date.parse("2025-11-05T01:26:00.000Z"), ZONE), [-7 * HOUR, -6 * HOUR]);
  const tuesday = "2025-11-05T01:26:00.000Z";
  assert.equal(localDateTime(tuesday), "Tue 2025-11-04 18:26:00.000");
  assert.equal(cancellationWindowEndsAt(tuesday, ZONE), "2025-11-15T07:00:00.000Z");
  assert.equal(localDateTime("2025-11-15T06:59:59.999Z"), "Fri 2025-11-14 23:59:59.999");
  assert.equal(localDateTime("2025-11-15T07:00:00.000Z"), "Sat 2025-11-15 00:00:00.000");
  // Across the November change (Edmonton falls back on 2 November 2025): received Sun 26 Oct 18:26
  // MDT, the window holds through Wed 5 Nov and ends at its midnight MST.
  const fall = "2025-10-27T00:26:00.000Z";
  assert.equal(cancellationWindowEndsAt(fall, ZONE), "2025-11-06T07:00:00.000Z");
  assert.equal(localDateTime("2025-11-06T07:00:00.000Z"), "Thu 2025-11-06 00:00:00.000");
  // Across the March change (Edmonton springs forward on 8 March 2026): received Mon 2 Mar 18:26
  // MST, the window holds through Thu 12 Mar. Its midnight MDT is 06:00Z, but at UTC-7, the offset
  // the receipt was read at, it is 07:00Z: the later one, 01:00 MDT.
  const spring = "2026-03-03T01:26:00.000Z";
  assert.equal(calendarEndOfTenthDay(spring, ZONE), "2026-03-13T06:00:00.000Z");
  assert.equal(cancellationWindowEndsAt(spring, ZONE), "2026-03-13T07:00:00.000Z");
  assert.equal(localDateTime("2026-03-13T07:00:00.000Z"), "Fri 2026-03-13 01:00:00.000");
  // Received Sun 1 Mar 23:30 MST, before that change. By the rules the end of the 10th day comes
  // 239.5 hours later; at UTC-6 the receipt is already Monday, so the window holds through the end
  // of Thu 12 Mar at UTC-7, 264.5 hours, never under 240.
  const lateBeforeSpring = "2026-03-02T06:30:00.000Z";
  assert.equal(localDateTime(lateBeforeSpring), "Sun 2026-03-01 23:30:00.000");
  assert.equal(Date.parse(calendarEndOfTenthDay(lateBeforeSpring, ZONE)) - Date.parse(lateBeforeSpring), 239.5 * HOUR);
  assert.equal(cancellationWindowEndsAt(lateBeforeSpring, ZONE), "2026-03-13T07:00:00.000Z");
  // The longest window: received at midnight at UTC-6, 265 hours, 264 plus the hour between
  // Edmonton's offsets, whether or not a change falls inside it. D1 allows 266.
  const midnightBeforeFall = "2025-10-26T06:00:00.000Z";
  assert.equal(localDateTime(midnightBeforeFall), "Sun 2025-10-26 00:00:00.000");
  assert.equal(Date.parse(cancellationWindowEndsAt(midnightBeforeFall, ZONE)) - Date.parse(midnightBeforeFall), 265 * HOUR);
  assert.equal(cancellationWindowEndsAt("2026-06-01T06:00:00.000Z", ZONE), "2026-06-12T07:00:00.000Z");
  // Until 23:00 MST the receipt's day is Tuesday at both offsets. From 23:00 MST it is already
  // Wednesday at UTC-6, so the window holds a day longer, through the end of Saturday.
  assert.equal(cancellationWindowEndsAt("2025-11-05T05:59:59.999Z", ZONE), "2025-11-15T07:00:00.000Z");
  assert.equal(cancellationWindowEndsAt("2025-11-05T06:00:00.000Z", ZONE), "2025-11-16T07:00:00.000Z");
  assert.equal(cancellationWindowEndsAt("2025-11-05T07:00:00.000Z", ZONE), "2025-11-16T07:00:00.000Z");
  // Where a local midnight repeats (Havana falls back from 01:00 to 00:00), the window ends at the
  // later of the two, never the earlier; where one is skipped (Havana springs forward at 00:00),
  // at the instant just after the gap, the first of that day.
  assert.equal(cancellationWindowEndsAt("2025-10-22T16:00:00.000Z", "America/Havana"), "2025-11-02T05:00:00.000Z");
  assert.equal(cancellationWindowEndsAt("2025-02-26T17:00:00.000Z", "America/Havana"), "2025-03-09T05:00:00.000Z");
  // Both instants of the hour the clocks repeat fall on the same day, and end together.
  assert.equal(cancellationWindowEndsAt("2025-11-02T07:30:00.000Z", ZONE), "2025-11-13T07:00:00.000Z");
  assert.equal(cancellationWindowEndsAt("2025-11-02T08:30:00.000Z", ZONE), "2025-11-13T07:00:00.000Z");
  // A later previous end is kept.
  assert.equal(cancellationWindowEndsAt(tuesday, ZONE, "2025-11-15T08:00:00.000Z"), "2025-11-15T08:00:00.000Z");
  // The full timestamp, with its offset, is the only form a time is read in.
  assert.equal(receivedAtInstant("2025-10-26T18:26:00-06:00"), fall);
  assert.equal(receivedAtInstant("2025-10-27T00:26Z"), fall);
  assert.equal(receivedAtInstant("2025-10-26T18:26:00.5-06:00"), "2025-10-27T00:26:00.500Z");
  for (const invalid of ["2025-10-26T18:26:00", "2025-02-29T10:00:00Z", "2025-10-26 18:26Z", "0025-10-26T18:26Z", "2025-10-26T24:00Z"]) {
    assert.equal(receivedAtInstant(invalid), null, invalid);
  }

  // The route stores that end, read on the business clock.
  const h = setup();
  const owner = await person(h, USERS.owner);
  const recorded = await recordReceipt(h, owner, JOB, {
    received_at: "2025-10-26T18:26:00-06:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  assert.equal(receipts(h, JOB)[0]!.window_ends_at, "2025-11-06T07:00:00.000Z");
  const springRecord = await recordReceipt(h, owner, OTHER_JOB, {
    received_at: "2026-03-01T23:30:00-07:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(springRecord.status, 201);
  assert.equal(receipts(h, OTHER_JOB)[0]!.window_ends_at, "2026-03-13T07:00:00.000Z");
  // Never before the job's previous end: a later time read in a business time zone hours ahead (the
  // tenant's zone changed) would end the 10th day sooner, so the window keeps the earlier end.
  const first = await recordReceipt(h, owner, ENDED_JOB, {
    received_at: "2026-06-01T01:00:00-06:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(first.body.cancellation_window.ends_at, "2026-06-12T07:00:00.000Z");
  h.env.APP_TIME_ZONE = "Asia/Tokyo";
  assert.equal(cancellationWindowEndsAt("2026-06-01T08:00:00.000Z", "Asia/Tokyo"), "2026-06-11T15:00:00.000Z");
  const later = await recordReceipt(h, owner, ENDED_JOB, {
    received_at: "2026-06-01T17:00:00+09:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  assert.deepEqual(
    receipts(h, ENDED_JOB).map((row) => [row.window_ends_at, row.time_zone]),
    [["2026-06-12T07:00:00.000Z", ZONE], ["2026-06-12T07:00:00.000Z", "Asia/Tokyo"]],
  );
});

test("D1 ends a copy's window on its own clock exactly as the Worker does, whichever local day that clock is on", () => {
  const db = new DatabaseSync(":memory:");
  // D1's end for a window starting at `d1Now`, from the day table the Worker builds at `workerNow`.
  const d1End = (timeZone: string, d1Now: number, workerNow: number) => (db.prepare(
    `SELECT ${windowEndSql("clock.now")} AS ends FROM (SELECT ? AS now) clock`,
  ).get(JSON.stringify(businessDayTable(timeZone, workerNow)), new Date(d1Now).toISOString()) as { ends: string | null }).ends;
  // Every 29 minutes across a fall-back and a spring-forward in Edmonton, and across changes that
  // skip or repeat a local midnight (Havana falls back from 01:00 to 00:00 and springs forward at
  // 00:00; Santiago changes at midnight), with the Worker's clock a little behind, level with or
  // ahead of D1's: the same end as `cancellationWindowEndsAt`, inside D1's [240 hours, 265 hours].
  const sweeps: Array<[string, string, string]> = [
    [ZONE, "2025-10-24T00:00:00.000Z", "2025-11-04T00:00:00.000Z"],
    [ZONE, "2026-02-27T00:00:00.000Z", "2026-03-10T00:00:00.000Z"],
    ["America/Havana", "2025-10-31T00:00:00.000Z", "2025-11-04T00:00:00.000Z"],
    ["America/Havana", "2025-03-07T00:00:00.000Z", "2025-03-11T00:00:00.000Z"],
    ["America/Santiago", "2025-04-03T00:00:00.000Z", "2025-04-08T00:00:00.000Z"],
    ["America/Santiago", "2025-09-04T00:00:00.000Z", "2025-09-09T00:00:00.000Z"],
  ];
  let probes = 0;
  for (const [timeZone, from, to] of sweeps) {
    for (let start = Date.parse(from); start < Date.parse(to); start += 29 * MINUTE) {
      const worker = cancellationWindowEndsAt(new Date(start).toISOString(), timeZone);
      const length = Date.parse(worker) - start;
      assert.ok(length >= 240 * HOUR && length <= 265 * HOUR, `${timeZone} ${new Date(start).toISOString()}`);
      for (const skew of [-90_000, 0, 90_000]) {
        assert.equal(d1End(timeZone, start, start + skew), worker, `${timeZone} ${new Date(start).toISOString()} ${skew}`);
        probes += 1;
      }
    }
  }
  assert.ok(probes > 2_000);
  // Either side of the midnight that changes the end (UTC-6's, at 06:00Z), D1 reads the stretch its
  // own clock is in, not the Worker's.
  const tuesdayLate = Date.parse("2025-11-05T06:00:00.000Z");
  assert.equal(d1End(ZONE, tuesdayLate - 1, tuesdayLate + 501), "2025-11-15T07:00:00.000Z");
  assert.equal(d1End(ZONE, tuesdayLate, tuesdayLate - 1_000), "2025-11-16T07:00:00.000Z");
  // A D1 clock outside the days the Worker read gives no end, so no copy is recorded as shown.
  assert.equal(d1End(ZONE, tuesdayLate - 4 * DAY, tuesdayLate), null);
  assert.equal(d1End(ZONE, tuesdayLate + 4 * DAY, tuesdayLate), null);
  db.close();
});

test("the end is never earlier than the calendar reading under either time zone data release", () => {
  // Releases disagree on Edmonton: a current one keeps UTC-6 all year after its latest
  // spring-forward, and an older one falls back to UTC-7 each autumn, as Denver still does. A runtime
  // holding either, while the real rule is either, never ends the window before the end of the 10th
  // local day under the real rule, and never more than 265 hours after the start. Where the two
  // releases already agree, as they do in the past, both readings are the same.
  const releases = ["America/Edmonton", "America/Denver"];
  let probes = 0;
  for (const [from, to] of [
    ["2026-10-24T00:00:00.000Z", "2026-11-12T00:00:00.000Z"],
    ["2027-02-26T00:00:00.000Z", "2027-03-20T00:00:00.000Z"],
  ]) {
    for (let start = Date.parse(from!); start < Date.parse(to!); start += 37 * MINUTE) {
      const startsAt = new Date(start).toISOString();
      for (const runtime of releases) {
        const end = Date.parse(cancellationWindowEndsAt(startsAt, runtime));
        assert.ok(end - start <= 265 * HOUR, `${runtime} ${startsAt}`);
        for (const real of releases) {
          assert.ok(end >= Date.parse(calendarEndOfTenthDay(startsAt, real)), `${runtime} read for ${real} ${startsAt}`);
          probes += 1;
        }
      }
    }
  }
  assert.ok(probes > 6_000);
  // The case the review found: an older release reads 00:30 at UTC-6 on a Wednesday as 23:30 on
  // Tuesday at UTC-7, whose calendar reading ends about 23 hours short. The window ends no earlier.
  const wednesday = "2026-11-04T06:30:00.000Z";
  assert.equal(calendarEndOfTenthDay(wednesday, "America/Denver"), "2026-11-14T07:00:00.000Z");
  assert.equal(calendarEndOfTenthDay(wednesday, "America/Edmonton"), "2026-11-15T06:00:00.000Z");
  assert.equal(cancellationWindowEndsAt(wednesday, "America/Denver"), "2026-11-15T07:00:00.000Z");
  assert.equal(cancellationWindowEndsAt(wednesday, "America/Edmonton"), "2026-11-15T07:00:00.000Z");
});

test("D1 holds every end to [start + 240 hours, start + 266 hours] and never before the job's previous end", () => {
  // D1 has no time zone database: a reading of the 10th local day's end is at most 264 hours after
  // a start at local midnight plus the span of the zone's offsets, which D1 allows up to two hours,
  // and never before 240 hours.
  const h = setup();
  const BOUNDS_JOB = "job:window:0005";
  seedJob(h.sqlite, BOUNDS_JOB, "0005");
  const base = Date.parse(d1At(h, -30 * DAY));
  const end = (receivedMs: number, hours: number, ms = 0) =>
    new Date(receivedMs + hours * HOUR + ms).toISOString();
  const received = (offset: number) => new Date(base + offset * HOUR).toISOString();
  refusedWith(
    () => insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(0), window_ends_at: end(base, 240, -1) }),
    "cancellation_window_receipt_end_invalid",
  );
  refusedWith(
    () => insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(0), window_ends_at: end(base, 266, 1) }),
    "cancellation_window_receipt_end_invalid",
  );
  insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(0), window_ends_at: end(base, 266) });
  // A later receipt whose own end would come before the previous end is refused...
  refusedWith(
    () => insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(0.5), window_ends_at: end(base + 0.5 * HOUR, 240) }),
    "cancellation_window_receipt_end_invalid",
  );
  // ...and stands with the previous end kept.
  insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(0.5), window_ends_at: end(base, 266) });
  insertReceipt(h, { roof_job_id: BOUNDS_JOB, received_at: received(30), window_ends_at: end(base + 30 * HOUR, 240) });
  assert.deepEqual(
    receipts(h, BOUNDS_JOB).map((row) => row.window_ends_at),
    [end(base, 266), end(base, 266), end(base + 30 * HOUR, 240)],
  );
});

// ------------------------------------------------------------------------------- the boundary

test("each hold stands to the last millisecond of the 10th local day and lifts the millisecond after", async () => {
  // Received Tue 4 Nov 2025 18:26 MST: the window holds through Friday 14 Nov and ends at the first
  // instant of Saturday 15 Nov, 00:00 MST. D1's clock and the Worker's are both the test's.
  const RECEIVED = "2025-11-05T01:26:00.000Z";
  const END = "2025-11-15T07:00:00.000Z";
  const endMs = Date.parse(END);
  mock.timers.enable({ apis: ["Date"], now: Date.parse(RECEIVED) + HOUR });
  try {
    const h = setup({ clocked: true });
    assert.equal(d1Now(h.sqlite), Date.parse(RECEIVED) + HOUR);
    // One job per surface: the firm start on the store, on the route and in D1; Materials on the
    // route and in D1; a supplier order and a line moving back to ordered in D1.
    const MATERIALS_ROUTE_JOB = "job:window:0006";
    const MATERIALS_D1_JOB = "job:window:0007";
    seedJob(h.sqlite, MATERIALS_ROUTE_JOB, "0006");
    seedJob(h.sqlite, MATERIALS_D1_JOB, "0007");
    seedInventory(h);
    // A backordered line of a job, written before the hold existed.
    const hold = h.sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'inventory_po_lines_cancellation_window_hold'",
    ).get() as { sql: string };
    h.sqlite.exec("DROP TRIGGER inventory_po_lines_cancellation_window_hold");
    const backordered = placeOrderLine(h, MATERIALS_D1_JOB, "backordered");
    h.sqlite.exec(hold.sql);

    const recorder = await person(h, USERS.owner);
    for (const job of [JOB, OTHER_JOB, ENDED_JOB, MATERIALS_ROUTE_JOB, MATERIALS_D1_JOB]) {
      const recorded = await recordReceipt(h, recorder, job, {
        received_at: "2025-11-04T18:26:00-07:00", reason: REASON, evidence_ref: EVIDENCE,
      });
      assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
      assert.equal(recorded.body.cancellation_window.ends_at, END);
    }
    // An hour before the end, the gates a schedule rests on are cleared inside the window.
    mock.timers.setTime(endMs - HOUR);
    for (const job of [JOB, OTHER_JOB, ENDED_JOB]) readyInsideWindow(h, job);

    const scheduleOnRoute = (auth: AuthContext, job: string) => {
      const day = fixtureSchedule(1, Date.now());
      return call(h, auth, `/api/v1/jobs/${encodeURIComponent(job)}/schedule`, {
        method: "POST",
        body: {
          expected_roof_job_version: 1,
          crew_id: CREW,
          expected_crew_version: 1,
          authority_requirements: scheduleCommand(job).authorityRequirements,
          scheduled_start: day.start,
          scheduled_end: day.end,
          supersedes_assignment_id: null,
          correction_reason: null,
        },
      });
    };
    const attestMaterials = (auth: AuthContext, job: string) =>
      call(h, auth, `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/Materials/clearance`, {
        method: "POST",
        body: {
          basis: "person_attestation",
          expected_gate_version: 1,
          attestation: { source: "supplier_delivery", reference: "DELIVERY-WINDOW-0009" },
        },
      });
    const clearMaterialsInD1 = (job: string) => h.sqlite.prepare(
      `INSERT INTO production_gate_clearances
         (clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
          from_gate_version, actor_kind, actor_user_id, actor_role, attestation_json,
          evidence_refs_json, request_sha256, idempotency_key_hash, created_at)
       VALUES (?, ?, ?, ?, 'Materials', 'clear', 'person_attestation', 'ready', 1, 'person', ?,
               'production', '{"reference":"DELIVERY-WINDOW-0010","source":"supplier_delivery"}',
               '[]', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(
      `pgc_${String(++keyCounter).padStart(40, "0")}`, TENANT, `gate:${job}:materials`, job,
      USERS.production.id, "a".repeat(64), String(keyCounter).padStart(64, "c"),
    );
    const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
    const written = () => ({
      assignments: count("SELECT COUNT(*) AS n FROM operating_job_assignments"),
      materials: count("SELECT COUNT(*) AS n FROM production_gate_clearances WHERE gate = 'Materials' AND entry_kind = 'clear'"),
      jobLines: count("SELECT COUNT(*) AS n FROM inventory_po_lines WHERE roof_job_id IS NOT NULL AND status = 'ordered'"),
    });

    // The last millisecond of Friday: every hold stands, by name, with the end.
    mock.timers.setTime(endMs - 1);
    const owner = await person(h, USERS.owner);
    const production = await person(h, USERS.production);
    const before = written();
    const window = (await call(h, owner, gatesPath(JOB))).body.cancellation_window;
    assert.deepEqual([window.state, window.ends_at, window.holds.length], ["open", END, 3]);
    assert.deepEqual(
      await refusedSchedule(h, scheduleCommand(JOB), "operating_job_assignment_cancellation_window_open"),
      { window_ends_at: END },
    );
    assert.deepEqual(await scheduleOnRoute(owner, OTHER_JOB), {
      status: 409,
      body: { window_ends_at: END, error: "operating_job_assignment_cancellation_window_open" },
    });
    refusedWith(() => insertAssignment(h, ENDED_JOB), "operating_job_assignment_cancellation_window_open");
    assert.deepEqual(await attestMaterials(production, MATERIALS_ROUTE_JOB), {
      status: 409,
      body: { window_ends_at: END, error: "production_gate_cancellation_window_open" },
    });
    refusedWith(() => clearMaterialsInD1(MATERIALS_D1_JOB), "production_gate_cancellation_window_open");
    refusedWith(() => placeOrderLine(h, MATERIALS_ROUTE_JOB), "inventory_po_line_cancellation_window_open");
    refusedWith(() => moveOrderLine(h, backordered, "ordered"), "inventory_po_line_cancellation_window_open");
    assert.deepEqual(written(), before);

    // At the end itself the window has ended: the bound is exclusive.
    mock.timers.setTime(endMs);
    const ended = (await call(h, owner, gatesPath(JOB))).body.cancellation_window;
    assert.deepEqual([ended.state, ended.ends_at, ended.holds], ["ended", END, []]);

    // The first millisecond after: each is allowed, on every surface.
    mock.timers.setTime(endMs + 1);
    assert.equal((await recordOperatingJobAssignment(h.env, scheduleCommand(JOB))).kind, "created");
    const routed = await scheduleOnRoute(owner, OTHER_JOB);
    assert.equal(routed.status, 201, JSON.stringify(routed.body));
    insertAssignment(h, ENDED_JOB);
    const materials = await attestMaterials(production, MATERIALS_ROUTE_JOB);
    assert.equal(materials.status, 200, JSON.stringify(materials.body));
    assert.equal(materials.body.gate.state, "ready");
    // In D1 directly: Materials attested through the ledger's every guard, a supplier order placed,
    // and the backordered line ordered again.
    attestGateInLedger(h.sqlite, {
      tenantId: TENANT, roofJobId: MATERIALS_D1_JOB, gate: "Materials", actorUserId: USERS.production.id,
      actorRole: "production", observerUserId: USERS.owner.id,
    });
    placeOrderLine(h, MATERIALS_ROUTE_JOB);
    moveOrderLine(h, backordered, "ordered");
    assert.deepEqual(written(), {
      assignments: before.assignments + 3,
      materials: before.materials + 2,
      jobLines: before.jobLines + 2,
    });
  } finally {
    mock.timers.reset();
  }
});

// ------------------------------------------------------------------------------- the work queue

test("the work queue lists the open signed jobs whose window is unknown, for owner and ops only", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner);
  const ops = await person(h, USERS.ops);
  const production = await person(h, USERS.production);
  // JOB was signed outside D1: its Deposit cleared by the owner's waiver. OTHER_JOB is not signed:
  // no contract, Deposit blocked. A finished job is not open.
  seedJob(h.sqlite, "job:window:0004", "0004", "complete");
  for (const job of [JOB, "job:window:0004"]) {
    waiveGateInLedger(h.sqlite, {
      tenantId: TENANT, roofJobId: job, gate: "Deposit", ownerUserId: USERS.owner.id,
      requesterUserId: USERS.production.id, requesterRole: "production",
    });
  }
  assert.deepEqual(await call(h, production, MISSING), { status: 403, body: { error: "owner_or_ops_required" } });
  const listed = await call(h, owner, MISSING);
  assert.deepEqual(listed, {
    status: 200,
    body: {
      count: 1,
      counts: { window_unknown: 1, window_started_copy_unconfirmed: 0 },
      complete: true,
      jobs: [{
        roof_job_id: JOB,
        job_number: "IW-WINDOW-0001",
        customer_display_name: "Window Customer 0001",
        address_line1: null,
        category: "window_unknown",
        unknown_reason: "signed_copy_time_missing",
        window_started_at: null,
        contract_on_record: false,
        contract_signed_at: null,
      }],
    },
  });
  assert.deepEqual(await call(h, ops, MISSING), listed);

  // Once its time is recorded, the job leaves the list.
  await recordReceipt(h, ops, JOB, { received_at: d1At(h, -HOUR), reason: REASON, evidence_ref: EVIDENCE });
  assert.deepEqual(await call(h, owner, MISSING), {
    status: 200,
    body: { count: 0, counts: { window_unknown: 0, window_started_copy_unconfirmed: 0 }, complete: true, jobs: [] },
  });
});

test("the four holds read the window with the same two predicates, and 0160 keeps 0098 and 0153 firing first", () => {
  const h = setup();
  const sql = (name: string) => String((h.sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(name) as { sql: string }).sql);
  // Each hold's two refusals, with the predicate after its code, normalized for whitespace.
  const predicates = (name: string, unknownCode: string, openCode: string) => {
    const text = sql(name).replace(/\s+/g, " ");
    const unknownAt = text.indexOf(`'${unknownCode}')`);
    const openAt = text.indexOf(`'${openCode}')`);
    assert.ok(unknownAt > 0 && openAt > unknownAt, name);
    const unknown = text.slice(text.indexOf("NOT EXISTS ( SELECT 1 FROM contract_signed_copy_events", unknownAt), openAt);
    // The open refusal is each hold's last statement: its predicate runs to the closing ";".
    const open = text.slice(text.indexOf("EXISTS ( SELECT 1 FROM contract_signed_copy_events", openAt), text.lastIndexOf(";"));
    assert.ok(unknown.length > 600 && open.length > 300, name);
    return {
      unknown: unknown.slice(0, unknown.lastIndexOf(")") + 1),
      open: open.trim(),
    };
  };
  const holds = [
    predicates("operating_job_assignments_cancellation_window_hold",
      "operating_job_assignment_cancellation_window_unknown", "operating_job_assignment_cancellation_window_open"),
    predicates("production_gate_clearances_cancellation_window_hold",
      "production_gate_cancellation_window_unknown", "production_gate_cancellation_window_open"),
    predicates("inventory_po_lines_cancellation_window_hold",
      "inventory_po_line_cancellation_window_unknown", "inventory_po_line_cancellation_window_open"),
  ];
  for (const hold of holds.slice(1)) assert.deepEqual(hold, holds[0]);
  // The update hold reads the same predicates, after its own conditions.
  const update = sql("inventory_po_lines_cancellation_window_update_hold").replace(/\s+/g, " ");
  assert.ok(update.includes(holds[0]!.unknown), "the update hold carries the unknown predicate");
  for (const part of holds[0]!.open.split(" OR EXISTS ")) {
    assert.ok(update.includes(part.replace(/^EXISTS /, "")), "the update hold carries the open predicate");
  }
  for (const name of [
    "operating_job_assignments_cancellation_window_hold",
    "production_gate_clearances_cancellation_window_hold",
    "inventory_po_lines_cancellation_window_hold",
    "inventory_po_lines_cancellation_window_update_hold",
  ]) {
    assert.ok(!sql(name).includes("NEW.created_at"), `${name} reads D1's clock, never the row's time`);
    assert.ok(sql(name).includes("julianday('now')"), name);
  }
  // Triggers on one table fire newest first: 0098's validate trigger and 0153's replace guard are
  // re-created after the holds, so they still answer first.
  const newest = (table: string) => (h.sqlite.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE INSERT%'
      ORDER BY rowid DESC LIMIT 2`,
  ).all(table) as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(newest("operating_job_assignments"), [
    "operating_job_assignments_validate_insert",
    "operating_job_assignments_cancellation_window_hold",
  ]);
  assert.deepEqual(newest("production_gate_clearances"), [
    "production_gate_clearances_no_insert_replace",
    "production_gate_clearances_cancellation_window_hold",
  ]);
  const migration = readFileSync(new URL("../migrations/0160_production_cancellation_window.sql", import.meta.url), "utf8");
  const body = (text: string, name: string) => {
    const match = text.match(new RegExp(`CREATE TRIGGER (?:IF NOT EXISTS )?${name}\\b[\\s\\S]*?\\nEND;`));
    assert.ok(match, name);
    return match[0].replace(/^CREATE TRIGGER (?:IF NOT EXISTS )?/, "");
  };
  for (const [source, name] of [
    ["0098_native_operating_job_assignments.sql", "operating_job_assignments_validate_insert"],
    ["0153_production_gate_clearances.sql", "production_gate_clearances_no_insert_replace"],
  ] as const) {
    const shipped = readFileSync(new URL(`../migrations/${source}`, import.meta.url), "utf8");
    assert.equal(body(migration, name), body(shipped, name), `0160 re-creates ${name} unchanged`);
  }
});
