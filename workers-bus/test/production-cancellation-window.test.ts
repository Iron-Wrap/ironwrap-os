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
import { cancellationWindowEndsAt, receivedAtInstant } from "../src/production-cancellation-window.ts";
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

/** The full migration chain, three open jobs with six blocked gates each, a crew and the people. */
function setup(): Harness {
  const db = new TestD1();
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

/** The local clock reading of an instant in the business time zone, as "HH:MM". */
function localClock(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(new Date(instant));
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

  // An hour ago: the window is open, and ends on the business clock ten days after the receipt.
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

  // Eleven days ago: the window has ended and holds nothing.
  const ended = await recordReceipt(h, owner, ENDED_JOB, {
    received_at: d1At(h, -11 * DAY), reason: REASON, evidence_ref: EVIDENCE,
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
  h.sqlite.exec(guard.sql);
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
  // A later time moves the window later, and keeps the first record.
  const later = d1At(h, -HOUR);
  const moved = await recordReceipt(h, owner, JOB, { ...body, received_at: later });
  assert.equal(moved.status, 201);
  assert.equal(moved.body.cancellation_window.ends_at, cancellationWindowEndsAt(later, ZONE));
  assert.ok(moved.body.cancellation_window.ends_at > stored!.window_ends_at);
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

test("across a DST change the window never ends early in local time, and D1 bounds every end", async () => {
  // The November change (Edmonton falls back on 2 November 2025): received Sun 26 Oct 18:26 MDT,
  // the window ends Thu 6 Nov 18:26 MST, 241 hours later, not an hour early at 17:26.
  const fall = "2025-10-27T00:26:00.000Z";
  assert.equal(cancellationWindowEndsAt(fall, ZONE), "2025-11-06T01:26:00.000Z");
  assert.equal(localClock(fall), "18:26");
  assert.equal(localClock(cancellationWindowEndsAt(fall, ZONE)), "18:26");
  // The March change (Edmonton springs forward on 8 March 2026): received Mon 2 Mar 18:26 MST.
  // Ten calendar days would be 239 hours; the window keeps the full 240 and ends at 19:26 MDT,
  // an hour late, never early.
  const spring = "2026-03-03T01:26:00.000Z";
  assert.equal(cancellationWindowEndsAt(spring, ZONE), "2026-03-13T01:26:00.000Z");
  assert.equal(localClock(cancellationWindowEndsAt(spring, ZONE)), "19:26");
  // A clock time the change skips ends after the gap; one it repeats ends at the later instant.
  assert.equal(cancellationWindowEndsAt("2026-02-26T09:30:00.000Z", ZONE), "2026-03-08T09:30:00.000Z");
  assert.equal(cancellationWindowEndsAt("2025-10-23T07:30:00.000Z", ZONE), "2025-11-02T08:30:00.000Z");
  // No change: exactly 240 hours. A later previous end is kept.
  assert.equal(cancellationWindowEndsAt("2026-06-01T00:00:00.000Z", ZONE), "2026-06-11T00:00:00.000Z");
  assert.equal(
    cancellationWindowEndsAt("2026-06-01T00:00:00.000Z", ZONE, "2026-06-11T00:30:00.000Z"),
    "2026-06-11T00:30:00.000Z",
  );
  // The full timestamp, with its offset, is the only form a time is read in.
  assert.equal(receivedAtInstant("2025-10-26T18:26:00-06:00"), fall);
  assert.equal(receivedAtInstant("2025-10-27T00:26Z"), fall);
  assert.equal(receivedAtInstant("2025-10-26T18:26:00.5-06:00"), "2025-10-27T00:26:00.500Z");
  for (const invalid of ["2025-10-26T18:26:00", "2025-02-29T10:00:00Z", "2025-10-26 18:26Z", "0025-10-26T18:26Z", "2025-10-26T24:00Z"]) {
    assert.equal(receivedAtInstant(invalid), null, invalid);
  }

  // The route stores the fail-safe end: a receipt before the November change ends at 18:26 MST.
  const h = setup();
  const owner = await person(h, USERS.owner);
  const recorded = await recordReceipt(h, owner, JOB, {
    received_at: "2025-10-26T18:26:00-06:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  assert.equal(receipts(h, JOB)[0]!.window_ends_at, "2025-11-06T01:26:00.000Z");
  const springRecord = await recordReceipt(h, owner, OTHER_JOB, {
    received_at: "2026-03-02T18:26:00-07:00", reason: REASON, evidence_ref: EVIDENCE,
  });
  assert.equal(springRecord.status, 201);
  assert.equal(receipts(h, OTHER_JOB)[0]!.window_ends_at, "2026-03-13T01:26:00.000Z");

  // D1 has no time zone database: it holds any writer to [received + 240 h, received + 241 h],
  // and to no earlier than the job's previous end.
  const base = Date.parse(d1At(h, -30 * DAY));
  const end = (receivedMs: number, hours: number, ms = 0) =>
    new Date(receivedMs + hours * HOUR + ms).toISOString();
  const received = (offset: number) => new Date(base + offset * HOUR).toISOString();
  refusedWith(
    () => insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(0), window_ends_at: end(base, 240, -1) }),
    "cancellation_window_receipt_end_invalid",
  );
  refusedWith(
    () => insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(0), window_ends_at: end(base, 241, 1) }),
    "cancellation_window_receipt_end_invalid",
  );
  insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(0), window_ends_at: end(base, 241) });
  // A later receipt whose own end would come before the previous end is refused...
  refusedWith(
    () => insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(0.5), window_ends_at: end(base + 0.5 * HOUR, 240) }),
    "cancellation_window_receipt_end_invalid",
  );
  // ...and stands with the previous end kept.
  insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(0.5), window_ends_at: end(base, 241) });
  insertReceipt(h, { roof_job_id: ENDED_JOB, received_at: received(2), window_ends_at: end(base + 2 * HOUR, 240) });
  assert.deepEqual(
    receipts(h, ENDED_JOB).map((row) => row.window_ends_at),
    [end(base, 241), end(base, 241), end(base + 2 * HOUR, 240)],
  );
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
      complete: true,
      jobs: [{
        roof_job_id: JOB,
        job_number: "IW-WINDOW-0001",
        customer_display_name: "Window Customer 0001",
        address_line1: null,
        unknown_reason: "signed_copy_time_missing",
        contract_on_record: false,
        contract_signed_at: null,
      }],
    },
  });
  assert.deepEqual(await call(h, ops, MISSING), listed);

  // Once its time is recorded, the job leaves the list.
  await recordReceipt(h, ops, JOB, { received_at: d1At(h, -HOUR), reason: REASON, evidence_ref: EVIDENCE });
  assert.deepEqual(await call(h, owner, MISSING), { status: 200, body: { count: 0, complete: true, jobs: [] } });
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
