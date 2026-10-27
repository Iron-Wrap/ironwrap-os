import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor, sha256Hex } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import { parseSafetyActionRequest, processSafetyDeviceAction } from "../src/safety-actions.ts";
import {
  keepSafetyStop,
  recordMakeSafe,
  recordSafetyResponse,
  reportSafetyOccurrence,
  SafetyError,
  type SafetyResponseCommand,
} from "../src/safety-lifecycle.ts";

// The P33 safety-stop route gaps (owner-accepted rulings): the stop reads name the raiser and say
// whether this viewer may release the stop (L06-aware), and show the controlled step. Every fixture
// is synthetic: reserved example.invalid identities, and times relative to the run.

const TENANT = "ironwrap";
const PEPPER = "synthetic-safety-stop-route-gaps-pepper-0123456789";
const BASE = Date.now() - 6 * 60 * 60 * 1_000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const SCOPE = { type: "roof_job" as const, id: "JOB-SAFETY-GAPS-1" };

interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: "owner" | "ops" | "field";
  access: string;
  frappe?: string;
}

const USERS = {
  owner: { id: "appu_owner_stop_gaps", email: "owner@example.invalid", name: "Synthetic Owner", role: "owner", access: "owner" },
  ops: { id: "appu_ops_stop_gaps", email: "ops@example.invalid", name: "Synthetic Ops", role: "ops", access: "ops" },
  production: { id: "appu_production_stop_gaps", email: "production@example.invalid", name: "Synthetic Production", role: "ops", access: "production" },
  sales: { id: "appu_sales_stop_gaps", email: "sales@example.invalid", name: "Synthetic Sales", role: "ops", access: "sales" },
  crew: { id: "appu_crew_stop_gaps", email: "crew@example.invalid", name: "Synthetic Crew", role: "field", access: "field", frappe: "crew@example.invalid" },
  mate: { id: "appu_mate_stop_gaps", email: "mate@example.invalid", name: "Synthetic Mate", role: "field", access: "field", frappe: "mate@example.invalid" },
} satisfies Record<string, FixtureUser>;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  /** Batches the Worker sent, so a test can prove a refusal came before any write. */
  batches = 0;

  prepare(sql: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] };
          },
          first<T>() {
            return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null;
          },
          async run() {
            const result = sqlite.prepare(sql).run(...(values as never[]));
            return { meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  /** D1 runs a batch as one transaction: every statement commits, or none does. */
  async batch(statements: Array<{ run(): unknown }>) {
    this.batches += 1;
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

type TestEnv = AppEnv & { DB: TestD1 };

function testEnv(users: FixtureUser[] = Object.values(USERS)): TestEnv {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of users) {
    DB.sqlite
      .prepare(
        `INSERT INTO app_users
          (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
           active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(user.id, TENANT, user.email, user.name, user.role, user.access, user.frappe ?? null,
        "owner@example.invalid", at(-60), at(-60));
  }
  return { APP_TENANT_ID: TENANT, APP_AUTH_PEPPER: PEPPER, DB } as unknown as TestEnv;
}

function setFrappeLogin(env: TestEnv, user: FixtureUser, login: string) {
  env.DB.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?").run(login, user.id);
}

// --- Occurrences ---------------------------------------------------------------------------------

let nextOccurrence = 0;

async function respond(
  env: TestEnv,
  actor: FixtureUser,
  occurrenceId: string,
  command: SafetyResponseCommand,
  detail = `Recorded ${command}.`,
) {
  return await recordSafetyResponse(env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: actor.id,
    command,
    detail,
    evidence: null,
    now: new Date().toISOString(),
  });
}

/** A stop raised by `raiser`, made safe, and driven to `upTo` by `supervisor`. */
async function raisedStop(
  env: TestEnv,
  raiser: FixtureUser,
  options: {
    upTo?: "reported" | "made_safe" | "investigating" | "controlled";
    supervisor?: FixtureUser;
    rescueRequired?: boolean;
  } = {},
): Promise<string> {
  nextOccurrence += 1;
  const occurrenceId = `so_gaps_stop_${String(nextOccurrence).padStart(4, "0")}`;
  await reportSafetyOccurrence(env, {
    occurrenceId,
    tenantId: TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope: SCOPE,
    reportedByUserId: raiser.id,
    reportedAt: at(nextOccurrence),
    summary: `Ice on the north slope, report ${nextOccurrence}.`,
    rescueRequired: options.rescueRequired ?? false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: at(nextOccurrence),
  });
  const upTo = options.upTo ?? "controlled";
  if (upTo === "reported") return occurrenceId;
  await recordMakeSafe(env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: raiser.access === "field" ? raiser.id : USERS.crew.id,
    detail: "Crew off the roof, ladder roped off.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: at(nextOccurrence),
    now: at(nextOccurrence),
  });
  if (upTo === "made_safe") return occurrenceId;
  const supervisor = options.supervisor ?? USERS.ops;
  await respond(env, supervisor, occurrenceId, "investigation_opened");
  if (upTo === "investigating") return occurrenceId;
  await respond(env, supervisor, occurrenceId, "controlled", "Salt on the deck and ladder.");
  return occurrenceId;
}

// --- Person sessions and requests ----------------------------------------------------------------

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function personAuth(
  env: TestEnv,
  user: FixtureUser,
  signedInMinutesAgo = 1,
): Promise<AuthContext> {
  const token = randomToken();
  const now = Date.now();
  const signedIn = new Date(now - signedInMinutesAgo * 60_000).toISOString();
  // A field session lives on a paired crew phone and carries that phone's proof.
  const field = user.access === "field";
  const proof = field ? randomToken() : null;
  const deviceId = field ? `device-${randomToken().slice(0, 20)}` : null;
  if (proof && deviceId) {
    env.DB.sqlite
      .prepare(
        `INSERT INTO app_devices
          (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
           created_ip_hash, created_user_agent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(deviceId, TENANT, user.id, await sha256Hex(proof), signedIn, signedIn,
        "d".repeat(64), "e".repeat(64));
  }
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(await sessionHashFor(env, token), user.id, TENANT, signedIn,
      new Date(now + 3_600_000).toISOString(), signedIn, "d".repeat(64), "e".repeat(64), deviceId);
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: {
        cookie: `__Host-ironwrap_session=${token}`,
        ...(proof ? { "x-ironwrap-device-proof": proof } : {}),
      },
    }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** The context an agent host, desktop connector or service credential carries: no cookie token. */
function connectorAuth(user: FixtureUser): AuthContext {
  return {
    rawSessionToken: "",
    csrfToken: "",
    permissions: permissionsForRole(user.access as "production"),
    session: {
      session_hash: "f".repeat(64),
      session_created_at: new Date(Date.now() - 60_000).toISOString(),
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: "device-synthetic-connector",
      device_proof_hash: null,
      user_id: user.id,
      tenant_id: TENANT,
      email_normalized: user.email,
      display_name: user.name,
      role: user.access as "production",
      frappe_user_id: null,
      active: 1,
      created_by: USERS.owner.email,
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

async function call(
  env: TestEnv,
  auth: AuthContext,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "content-type": "application/json", "x-csrf-token": auth.csrfToken, ...headers }
        : headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const occurrencePath = (occurrenceId: string) =>
  `/api/v1/safety/occurrences/${encodeURIComponent(occurrenceId)}`;

const release = { command: "released", detail: "Ice gone; the whole slope checked." };

async function detailFor(env: TestEnv, auth: AuthContext, occurrenceId: string) {
  const read = await call(env, auth, occurrencePath(occurrenceId));
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body;
}

async function panelRow(env: TestEnv, auth: AuthContext, occurrenceId: string) {
  const read = await call(env, auth, "/api/v1/safety/panel");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const row = (read.body.panel.open_occurrences as Array<Record<string, any>>)
    .find((candidate) => candidate.occurrence_id === occurrenceId);
  assert.ok(row, `panel lists ${occurrenceId}`);
  return row;
}

// --- Item 8: the raiser's name and can_release on the detail and panel reads ---------------------

test("the stop detail names the raiser and shows every step, controlled as its own step", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew, { upTo: "made_safe" });
  const production = await personAuth(env, USERS.production);

  let detail = await detailFor(env, production, occurrenceId);
  assert.equal(detail.version, 1);
  assert.equal(detail.occurrence.occurrence_id, occurrenceId);
  assert.equal(detail.occurrence.reported_by_user_id, USERS.crew.id);
  assert.equal(detail.raised_by_display_name, USERS.crew.name);
  assert.deepEqual(Object.keys(detail.lifecycle),
    ["reported", "made_safe", "investigating", "controlled", "released", "closed"]);
  assert.deepEqual(detail.lifecycle.reported, {
    at: detail.occurrence.reported_at,
    by_user_id: USERS.crew.id,
    by_display_name: USERS.crew.name,
    detail: detail.occurrence.summary,
  });
  assert.equal(detail.lifecycle.made_safe.by_display_name, USERS.crew.name);
  assert.equal(detail.lifecycle.made_safe.detail, "Crew off the roof, ladder roped off.");
  assert.equal(detail.lifecycle.investigating, null);
  assert.equal(detail.lifecycle.controlled, null);
  assert.equal(detail.can_release, false);
  assert.equal(detail.release_unavailable_reason, "not_controlled");

  await respond(env, USERS.ops, occurrenceId, "investigation_opened", "Calling the crew.");
  detail = await detailFor(env, production, occurrenceId);
  assert.equal(detail.occurrence.state, "investigating");
  assert.equal(detail.lifecycle.investigating.by_display_name, USERS.ops.name);
  assert.equal(detail.lifecycle.controlled, null);
  assert.equal(detail.release_unavailable_reason, "not_controlled");

  // Controlled is its own step: the fix is in place and checked, and the stop stays on.
  await respond(env, USERS.ops, occurrenceId, "controlled", "Salt on the deck and ladder.");
  detail = await detailFor(env, production, occurrenceId);
  assert.equal(detail.occurrence.state, "controlled");
  assert.equal(detail.occurrence.stop_active, 1);
  assert.equal(detail.lifecycle.controlled.by_user_id, USERS.ops.id);
  assert.equal(detail.lifecycle.controlled.by_display_name, USERS.ops.name);
  assert.equal(detail.lifecycle.controlled.detail, "Salt on the deck and ladder.");
  assert.match(detail.lifecycle.controlled.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detail.lifecycle.released, null);
  assert.equal(detail.can_release, true);
  assert.equal(detail.release_unavailable_reason, null);

  const lifted = await call(env, production, `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  detail = await detailFor(env, production, occurrenceId);
  assert.equal(detail.lifecycle.released.by_display_name, USERS.production.name);
  assert.equal(detail.lifecycle.released.detail, release.detail);
  assert.equal(detail.can_release, false);
  assert.equal(detail.release_unavailable_reason, "stop_released");

  // An unknown or malformed id is still a 404.
  assert.equal((await call(env, production, occurrencePath("so_gaps_unknown_0001"))).status, 404);
  assert.equal((await call(env, production, occurrencePath("x"))).status, 404);
});

test("can_release is false for the raiser under every identity, on the detail and the panel", async () => {
  const cases: Array<[string, (env: TestEnv) => void, FixtureUser]> = [
    ["the raiser's own user id", () => {}, USERS.production],
    ["the viewer's Frappe login is the raiser's email",
      (env) => setFrappeLogin(env, USERS.owner, USERS.production.email), USERS.owner],
    ["the same alias, in other case and with spaces",
      (env) => setFrappeLogin(env, USERS.owner, "  PRODUCTION@Example.Invalid "), USERS.owner],
    ["the raiser's Frappe login is the viewer's email",
      (env) => setFrappeLogin(env, USERS.production, USERS.owner.email), USERS.owner],
    ["both carry the same Frappe user", (env) => {
      setFrappeLogin(env, USERS.production, "shared.frappe.login");
      setFrappeLogin(env, USERS.owner, "Shared.Frappe.Login");
    }, USERS.owner],
  ];
  for (const [label, alias, viewer] of cases) {
    const env = testEnv();
    const occurrenceId = await raisedStop(env, USERS.production);
    alias(env);
    const auth = await personAuth(env, viewer);
    const detail = await detailFor(env, auth, occurrenceId);
    assert.equal(detail.raised_by_display_name, USERS.production.name, label);
    assert.equal(detail.can_release, false, label);
    assert.equal(detail.release_unavailable_reason, "raised_by_viewer", label);
    const row = await panelRow(env, auth, occurrenceId);
    assert.equal(row.raised_by_display_name, USERS.production.name, label);
    assert.equal(row.can_release, false, label);
    assert.equal(row.release_unavailable_reason, "raised_by_viewer", label);
    // The read says what the release does.
    const refused = await call(env, auth, `${occurrencePath(occurrenceId)}/commands`, release);
    assert.equal(refused.status, 403, label);
    assert.equal(refused.body.error, "safety_stop_release_by_raiser_forbidden", label);
    // Another person with authority may.
    const ops = await personAuth(env, USERS.ops);
    assert.equal((await detailFor(env, ops, occurrenceId)).can_release, true, label);
    assert.equal((await panelRow(env, ops, occurrenceId)).can_release, true, label);
  }
});

test("can_release is false without release authority, outside a person's session, and before the rescue", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  for (const [viewer, reason] of [
    [USERS.sales, "release_authority_required"],
    [USERS.mate, "release_authority_required"],
    [USERS.crew, "release_authority_required"],
    [USERS.owner, null],
    [USERS.ops, null],
    [USERS.production, null],
  ] as const) {
    const auth = await personAuth(env, viewer);
    const detail = await detailFor(env, auth, occurrenceId);
    assert.equal(detail.release_unavailable_reason, reason, viewer.access);
    assert.equal(detail.can_release, reason === null, viewer.access);
    const row = await panelRow(env, auth, occurrenceId);
    assert.equal(row.release_unavailable_reason, reason, viewer.access);
    assert.equal(row.can_release, reason === null, viewer.access);
  }

  // An agent, connector or service credential can read the stop but never release it.
  const connector = connectorAuth(USERS.production);
  const detail = await detailFor(env, connector, occurrenceId);
  assert.equal(detail.can_release, false);
  assert.equal(detail.release_unavailable_reason, "person_session_required");
  assert.equal((await panelRow(env, connector, occurrenceId)).release_unavailable_reason,
    "person_session_required");

  // A controlled stop whose required rescue is not recorded as completed.
  const rescue = await raisedStop(env, USERS.crew, { rescueRequired: true });
  const ops = await personAuth(env, USERS.ops);
  assert.equal((await detailFor(env, ops, rescue)).release_unavailable_reason, "rescue_not_completed");
  assert.equal((await panelRow(env, ops, rescue)).release_unavailable_reason, "rescue_not_completed");
  await respond(env, USERS.ops, rescue, "rescue_completed", "Worker brought down safely.");
  assert.equal((await detailFor(env, ops, rescue)).can_release, true);
});

test("the panel row carries the raiser's name, the controlled time and can_release", async () => {
  const env = testEnv();
  const reported = await raisedStop(env, USERS.crew, { upTo: "reported" });
  const controlled = await raisedStop(env, USERS.crew);
  const ops = await personAuth(env, USERS.ops);
  const reportedRow = await panelRow(env, ops, reported);
  assert.deepEqual(Object.keys(reportedRow).sort(), [
    "can_release", "controlled_at", "occurrence_id", "occurrence_kind", "raised_by_display_name",
    "release_unavailable_reason", "scope_id", "scope_type", "severity", "state", "stop_active",
    "summary",
  ]);
  assert.equal(reportedRow.raised_by_display_name, USERS.crew.name);
  assert.equal(reportedRow.controlled_at, null);
  assert.equal(reportedRow.stop_active, true);
  assert.equal(reportedRow.release_unavailable_reason, "not_controlled");
  const controlledRow = await panelRow(env, ops, controlled);
  assert.equal(controlledRow.state, "controlled");
  assert.equal(controlledRow.controlled_at,
    (await detailFor(env, ops, controlled)).lifecycle.controlled.at);
  assert.equal(controlledRow.can_release, true);
  // A lifted stop that is not closed yet stays on the panel and can no longer be released.
  const lifted = await call(env, ops, `${occurrencePath(controlled)}/commands`, release);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  const liftedRow = await panelRow(env, ops, controlled);
  assert.equal(liftedRow.stop_active, false);
  assert.equal(liftedRow.release_unavailable_reason, "stop_released");
});

// --- Item 1: raise defaults, applied on the server -----------------------------------------------

let nextAction = 0;

/** A raise or make-safe through the offline safety rail, as a crew phone replays it. */
async function deviceAction(
  env: TestEnv,
  actor: FixtureUser,
  kind: "report_occurrence" | "make_safe",
  scope: { type: "tenant" | "roof_job" | "work_package" | "shop" | "vehicle"; id: string },
  payload: Record<string, unknown>,
  deviceActionId = `gaps-action-${String(++nextAction).padStart(4, "0")}`,
  // Each raise its own moment, so two raises never converge as one physical event.
  capturedAt = at(150 + nextAction),
) {
  const submission = await parseSafetyActionRequest(new Request("https://app.example.invalid/api/v1/safety/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_action_id: deviceActionId,
      payload: { kind, scope_type: scope.type, scope_id: scope.id, captured_at: capturedAt, ...payload },
    }),
  }));
  return await processSafetyDeviceAction(env, connectorAuth(actor), submission, {
    objects: { async ensure() {} },
  });
}

function occurrence(env: TestEnv, occurrenceId: string) {
  return { ...(env.DB.sqlite.prepare(
    `SELECT occurrence_kind, severity, summary, state, version, stop_active
       FROM safety_occurrences WHERE occurrence_id = ?`,
  ).get(occurrenceId) as Record<string, unknown>) };
}

/** A native job row, written straight to D1 with only the columns these reads use. */
function insertJob(env: TestEnv, jobId: string, jobNumber: string | null) {
  const sqlite = env.DB.sqlite;
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, service_type, job_number,
        job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, 'lead:gaps', 'customer:gaps', 'ow_gaps', 'roof_replacement', ?, 'qualified',
       'qualification', 1, ?, ?)`,
  ).run(jobId, TENANT, jobNumber, at(-30), at(-30));
  sqlite.exec("PRAGMA foreign_keys = ON");
}

test("a raise that leaves out its category, severity or words is a high hazard on its job", async () => {
  const env = testEnv();
  insertJob(env, "JOB-GAPS-NUMBERED", "IW-1001");
  insertJob(env, "JOB-GAPS-UNNUMBERED", null);
  for (const [scope, summary] of [
    [{ type: "roof_job", id: "JOB-GAPS-NUMBERED" }, "Work stopped on IW-1001"],
    [{ type: "roof_job", id: "JOB-GAPS-UNNUMBERED" }, "Work stopped on JOB-GAPS-UNNUMBERED"],
    [{ type: "roof_job", id: "JOB-GAPS-TYPO" }, "Work stopped on JOB-GAPS-TYPO"],
    [{ type: "work_package", id: "wp_gaps_typo" }, "Work stopped on wp_gaps_typo"],
    [{ type: "tenant", id: TENANT }, "Work stopped on every job"],
    [{ type: "vehicle", id: "TRUCK-7" }, "Work stopped on vehicle TRUCK-7"],
    [{ type: "shop", id: "SHOP-1" }, "Work stopped on shop SHOP-1"],
  ] as const) {
    const raised = await deviceAction(env, USERS.crew, "report_occurrence", scope, {});
    assert.deepEqual(occurrence(env, raised.server_ref), {
      occurrence_kind: "hazard", severity: "high", summary, state: "reported", version: 1, stop_active: 1,
    }, scope.id);
  }
  // What the crew said is kept, and so is each value they chose.
  const chosen = await deviceAction(env, USERS.crew, "report_occurrence",
    { type: "roof_job", id: "JOB-GAPS-NUMBERED" },
    { occurrence_kind: "injury", severity: "critical", detail: "Fell from the ladder." });
  assert.deepEqual(occurrence(env, chosen.server_ref), {
    occurrence_kind: "injury", severity: "critical", summary: "Fell from the ladder.",
    state: "reported", version: 1, stop_active: 1,
  });
  const partial = await deviceAction(env, USERS.crew, "report_occurrence",
    { type: "roof_job", id: "JOB-GAPS-NUMBERED" }, { severity: "moderate" });
  assert.deepEqual([occurrence(env, partial.server_ref).occurrence_kind, occurrence(env, partial.server_ref).severity],
    ["hazard", "moderate"]);
  // A value that is present must still be valid.
  for (const payload of [{ occurrence_kind: "storm" }, { severity: "extreme" }, { detail: "ok" }]) {
    await assert.rejects(
      deviceAction(env, USERS.crew, "report_occurrence", { type: "tenant", id: TENANT }, payload),
      (error) => error instanceof SafetyError && error.code === "invalid_safety_action",
      JSON.stringify(payload),
    );
  }
  // A replay returns the first answer.
  const first = await deviceAction(env, USERS.crew, "report_occurrence",
    { type: "roof_job", id: "JOB-GAPS-UNNUMBERED" }, {}, "gaps-replayed-0001", at(149));
  const again = await deviceAction(env, USERS.crew, "report_occurrence",
    { type: "roof_job", id: "JOB-GAPS-UNNUMBERED" }, {}, "gaps-replayed-0001", at(149));
  assert.deepEqual(again, first);
  // A retry after the stop was recorded but before its answer was, whose default summary now reads
  // differently (the job got its number in between), lands on the stop already recorded.
  env.DB.sqlite.prepare(
    "UPDATE operating_roof_jobs SET job_number = 'IW-2002', version = version + 1 WHERE roof_job_id = ?",
  ).run("JOB-GAPS-UNNUMBERED");
  const retried = await reportSafetyOccurrence(env, {
    occurrenceId: first.server_ref, tenantId: TENANT, occurrenceKind: "hazard", severity: "high",
    scope: { type: "roof_job", id: "JOB-GAPS-UNNUMBERED" }, reportedByUserId: USERS.crew.id,
    reportedAt: at(149), summary: "Work stopped on IW-2002", rescueRequired: false, evidence: null,
    capturedOffline: true, deviceActionId: "gaps-replayed-0001", now: at(149),
  });
  assert.equal(retried.kind, "duplicate");
  assert.equal(retried.occurrence.summary, "Work stopped on JOB-GAPS-UNNUMBERED");
});

// --- Item 2: an office made-safe names an on-site confirmer --------------------------------------

function eventCount(env: TestEnv, occurrenceId: string): number {
  return Number((env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM safety_occurrence_events WHERE occurrence_id = ?",
  ).get(occurrenceId) as { count: number }).count);
}

async function makeSafe(env: TestEnv, actor: FixtureUser, occurrenceId: string, confirmer: string | null) {
  return await recordMakeSafe(env, {
    tenantId: TENANT, occurrenceId, actorUserId: actor.id, confirmerUserId: confirmer,
    detail: "Crew off the roof, ladder roped off.", evidence: null, capturedOffline: false,
    deviceActionId: null, occurredAt: at(160), now: at(160),
  });
}

const refusedWith = (code: string) => (error: unknown) =>
  error instanceof SafetyError && error.code === code;

test("the office records made safe only with a named on-site confirmer who is someone else", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew, { upTo: "reported" });
  for (const [actor, confirmer, code] of [
    [USERS.ops, null, "safety_make_safe_confirmer_required"],
    [USERS.production, null, "safety_make_safe_confirmer_required"],
    [USERS.ops, "appu_not_a_person_0001", "safety_make_safe_confirmer_unknown"],
    [USERS.ops, "not a user id", "safety_make_safe_confirmer_unknown"],
    [USERS.ops, USERS.ops.id, "safety_make_safe_confirmer_is_recorder"],
    [USERS.crew, USERS.crew.id, "safety_make_safe_confirmer_is_recorder"],
  ] as const) {
    const batches = env.DB.batches;
    await assert.rejects(makeSafe(env, actor, occurrenceId, confirmer), refusedWith(code), `${actor.access} ${confirmer}`);
    assert.equal(env.DB.batches, batches, "refused before anything is written");
    assert.equal(occurrence(env, occurrenceId).state, "reported");
  }
  // The same person under another identity is still the recorder.
  setFrappeLogin(env, USERS.mate, USERS.ops.email);
  await assert.rejects(makeSafe(env, USERS.ops, occurrenceId, USERS.mate.id),
    refusedWith("safety_make_safe_confirmer_is_recorder"));
  setFrappeLogin(env, USERS.mate, "mate@example.invalid");
  // A deactivated person confirms nothing.
  env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.mate.id);
  await assert.rejects(makeSafe(env, USERS.ops, occurrenceId, USERS.mate.id),
    refusedWith("safety_make_safe_confirmer_unknown"));
  env.DB.sqlite.prepare("UPDATE app_users SET active = 1 WHERE user_id = ?").run(USERS.mate.id);

  const made = await makeSafe(env, USERS.ops, occurrenceId, USERS.crew.id);
  assert.equal(made.state, "made_safe");
  const ops = await personAuth(env, USERS.ops);
  const step = (await detailFor(env, ops, occurrenceId)).lifecycle.made_safe;
  assert.equal(step.by_display_name, USERS.ops.name);
  assert.equal(step.confirmed_by_user_id, USERS.crew.id);
  assert.equal(step.confirmed_by_display_name, USERS.crew.name);

  // A crew member makes it safe themselves with no confirmer, and may name a crewmate.
  const own = await raisedStop(env, USERS.crew, { upTo: "reported" });
  await makeSafe(env, USERS.crew, own, null);
  const ownStep = (await detailFor(env, ops, own)).lifecycle.made_safe;
  assert.deepEqual([ownStep.confirmed_by_user_id, ownStep.confirmed_by_display_name], [null, null]);
  const mates = await raisedStop(env, USERS.crew, { upTo: "reported" });
  await makeSafe(env, USERS.crew, mates, USERS.mate.id);
  assert.equal((await detailFor(env, ops, mates)).lifecycle.made_safe.confirmed_by_display_name, USERS.mate.name);
});

test("the made-safe confirmer travels on the offline safety rail", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew, { upTo: "reported" });
  await assert.rejects(
    deviceAction(env, USERS.ops, "make_safe", { type: "tenant", id: TENANT },
      { occurrence_id: occurrenceId, detail: "Sam roped off the ladder." }),
    refusedWith("safety_make_safe_confirmer_required"),
  );
  const made = await deviceAction(env, USERS.ops, "make_safe", { type: "tenant", id: TENANT },
    { occurrence_id: occurrenceId, detail: "Sam roped off the ladder.", on_site_confirmer_user_id: USERS.crew.id });
  assert.equal(made.server_ref, occurrenceId);
  const row = env.DB.sqlite.prepare(
    `SELECT confirmed_by_user_id FROM safety_occurrence_events
      WHERE occurrence_id = ? AND event_kind = 'make_safe'`,
  ).get(occurrenceId) as { confirmed_by_user_id: string };
  assert.equal(row.confirmed_by_user_id, USERS.crew.id);
});

test("D1 refuses an office made-safe without a confirmer, and a made-safe state without its event", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew, { upTo: "reported" });
  const insertEvent = (kind: string, actor: FixtureUser, confirmer: string | null, version = 2) =>
    env.DB.sqlite.prepare(
      `INSERT INTO safety_occurrence_events
         (event_id, tenant_id, occurrence_id, occurrence_version, event_kind, actor_user_id,
          actor_role, detail, captured_offline, occurred_at, recorded_at, confirmed_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Written straight to D1.', 0, ?, ?, ?)`,
    ).run(`soe_direct_${occurrenceId}_${version}_${kind}`, TENANT, occurrenceId, version, kind,
      actor.id, actor.access, at(170), at(170), confirmer);
  for (const [kind, actor, confirmer, code] of [
    ["make_safe", USERS.ops, null, "safety_make_safe_confirmer_required"],
    ["make_safe", USERS.ops, "appu_not_a_person_0001", "safety_make_safe_confirmer_unknown"],
    ["make_safe", USERS.ops, USERS.ops.id, "safety_make_safe_confirmer_is_recorder"],
    ["make_safe", USERS.crew, USERS.crew.id, "safety_make_safe_confirmer_is_recorder"],
    ["finding_recorded", USERS.ops, USERS.crew.id, "safety_make_safe_confirmer_not_applicable"],
  ] as const) {
    assert.throws(() => insertEvent(kind, actor, confirmer), new RegExp(code), `${kind} ${actor.access}`);
  }
  setFrappeLogin(env, USERS.crew, `  ${USERS.ops.email.toUpperCase()} `);
  assert.throws(() => insertEvent("make_safe", USERS.ops, USERS.crew.id),
    /safety_make_safe_confirmer_is_recorder/, "alias");
  setFrappeLogin(env, USERS.crew, "crew@example.invalid");
  // The occurrence never moves to made_safe without that version's own make_safe event.
  const moveTo = (version: number) => env.DB.sqlite.prepare(
    `UPDATE safety_occurrences SET version = ?, state = 'made_safe', updated_at = ?
      WHERE occurrence_id = ? AND version = ?`,
  ).run(version, at(171), occurrenceId, version - 1);
  assert.throws(() => moveTo(2), /safety_make_safe_event_required/);
  insertEvent("make_safe", USERS.ops, USERS.crew.id, 3);
  assert.throws(() => moveTo(2), /safety_make_safe_event_required/, "an event for another version");
  insertEvent("make_safe", USERS.ops, USERS.crew.id);
  moveTo(2);
  assert.equal(occurrence(env, occurrenceId).state, "made_safe");
});

// --- Item 6: "Keep the stop" is history only ------------------------------------------------------

let nextKey = 0;

async function keep(
  env: TestEnv,
  auth: AuthContext,
  occurrenceId: string,
  body: Record<string, unknown>,
  key: string | null = `gaps-keep-${String(++nextKey).padStart(4, "0")}`,
) {
  return await call(env, auth, `${occurrencePath(occurrenceId)}/keep`, body,
    key === null ? {} : { "idempotency-key": key });
}

function occurrenceSnapshot(env: TestEnv, occurrenceId: string) {
  return {
    row: { ...(env.DB.sqlite.prepare("SELECT * FROM safety_occurrences WHERE occurrence_id = ?")
      .get(occurrenceId) as Record<string, unknown>) },
    events: eventCount(env, occurrenceId),
  };
}

test("keeping the stop records the reason to history and changes nothing on the stop", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const before = occurrenceSnapshot(env, occurrenceId);
  const ops = await personAuth(env, USERS.ops);
  const body = { occurrence_version: before.row.version, reason: "Ice still in the shade on the north slope." };
  const kept = await keep(env, ops, occurrenceId, body, "gaps-keep-first-0001");
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.deepEqual(Object.keys(kept.body.keep).sort(), [
    "keep_id", "kept_at", "kept_by_display_name", "kept_by_role", "kept_by_user_id", "occurrence_id",
    "occurrence_version", "reason",
  ]);
  assert.match(kept.body.keep.keep_id, /^ssk_[0-9a-f]{32}$/);
  assert.equal(kept.body.keep.kept_by_display_name, USERS.ops.name);
  assert.equal(kept.body.keep.kept_by_role, "ops");
  assert.equal(kept.body.keep.reason, body.reason);
  assert.equal(kept.body.keep.occurrence_version, before.row.version);
  assert.ok(Math.abs(Date.parse(kept.body.keep.kept_at) - Date.now()) < 60_000, "D1's clock");
  assert.deepEqual(occurrenceSnapshot(env, occurrenceId), before, "the stop is untouched");
  const detail = await detailFor(env, ops, occurrenceId);
  assert.deepEqual(detail.keep_decisions, [kept.body.keep]);
  assert.equal(detail.can_release, true, "keeping does not take the release away");

  // An exact replay returns the first answer; the same key for another decision conflicts.
  const replay = await keep(env, ops, occurrenceId, body, "gaps-keep-first-0001");
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, kept.body);
  const changed = await keep(env, ops, occurrenceId, { ...body, reason: "Another reason entirely." },
    "gaps-keep-first-0001");
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "idempotency_conflict");
  // Another decision later is its own record, newest first.
  const second = await keep(env, await personAuth(env, USERS.owner), occurrenceId,
    { ...body, reason: "Still waiting on the photo of the whole slope." });
  assert.equal(second.status, 201);
  assert.deepEqual((await detailFor(env, ops, occurrenceId)).keep_decisions.map((row: any) => row.keep_id),
    [second.body.keep.keep_id, kept.body.keep.keep_id]);
  assert.deepEqual(occurrenceSnapshot(env, occurrenceId), before);
});

test("only a person who may release the stop may keep it, at the version they reviewed", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.production);
  const before = occurrenceSnapshot(env, occurrenceId);
  const body = { occurrence_version: before.row.version, reason: "The ladder is still iced." };
  const refuse = async (auth: AuthContext, payload: Record<string, unknown>, status: number, code: string,
    key?: string | null) => {
    const refused = await keep(env, auth, occurrenceId, payload, key);
    assert.equal(refused.status, status, `${code}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, code);
    assert.deepEqual(occurrenceSnapshot(env, occurrenceId), before, code);
  };
  const owner = await personAuth(env, USERS.owner);
  await refuse(await personAuth(env, USERS.production), body, 403, "safety_stop_release_by_raiser_forbidden");
  setFrappeLogin(env, USERS.owner, USERS.production.email);
  await refuse(owner, body, 403, "safety_stop_release_by_raiser_forbidden");
  setFrappeLogin(env, USERS.owner, "owner.login@example.invalid");
  await refuse(await personAuth(env, USERS.sales), body, 403, "safety_release_authority_required");
  await refuse(await personAuth(env, USERS.crew), body, 403, "safety_release_authority_required");
  await refuse(connectorAuth(USERS.ops), body, 403, "safety_stop_release_person_required");
  await refuse(owner, { ...body, occurrence_version: before.row.version as number - 1 }, 409,
    "safety_occurrence_version_conflict");
  await refuse(owner, { ...body, reason: "no" }, 400, "safety_stop_keep_invalid");
  await refuse(owner, { reason: body.reason }, 400, "safety_stop_keep_invalid");
  await refuse(owner, { ...body, extra: true }, 400, "safety_stop_keep_invalid");
  await refuse(owner, body, 400, "idempotency_key_required", null);
  await refuse(owner, body, 400, "idempotency_key_required", "short");
  const unknown = await call(env, owner, `${occurrencePath("so_gaps_unknown_0001")}/keep`, body,
    { "idempotency-key": "gaps-keep-unknown-0001" });
  assert.deepEqual([unknown.status, unknown.body.error], [404, "safety_occurrence_not_found"]);
  // Once released, there is nothing left to keep.
  const lifted = await call(env, await personAuth(env, USERS.ops), `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  const afterLift = await keep(env, owner, occurrenceId, { ...body, occurrence_version: lifted.body.occurrence.version });
  assert.deepEqual([afterLift.status, afterLift.body.error], [409, "safety_stop_already_released"]);
});

test("D1 keeps the keep record append-only and repeats every check for a direct write", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.production);
  const { version } = occurrence(env, occurrenceId) as { version: number };
  let next = 0;
  const insert = (overrides: Record<string, unknown> = {}, verb = "INSERT") => {
    next += 1;
    const row = {
      keep_id: `ssk_${String(next).padStart(32, "0")}`,
      tenant_id: TENANT,
      idempotency_key: `gaps-direct-${String(next).padStart(4, "0")}`,
      request_sha256: "a".repeat(64),
      occurrence_id: occurrenceId,
      occurrence_version: version,
      kept_by_user_id: USERS.ops.id,
      kept_by_role: "ops",
      reason: "Written straight to D1.",
      ...overrides,
    };
    const clock = "kept_at" in overrides ? "?" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const values = Object.values(row);
    env.DB.sqlite.prepare(
      `${verb} INTO safety_stop_keep_decisions (${Object.keys(row).filter((key) => key !== "kept_at").join(", ")}, kept_at)
       VALUES (${values.filter((_, index) => Object.keys(row)[index] !== "kept_at").map(() => "?").join(", ")}, ${clock})`,
    ).run(...(values.filter((_, index) => Object.keys(row)[index] !== "kept_at") as never[]),
      ...("kept_at" in overrides ? [overrides.kept_at as never] : []));
    return row.keep_id;
  };
  for (const [overrides, code] of [
    [{ kept_by_user_id: USERS.production.id, kept_by_role: "production" }, "safety_stop_release_by_raiser_forbidden"],
    [{ kept_by_user_id: USERS.sales.id, kept_by_role: "sales" }, "CHECK constraint failed"],
    [{ kept_by_role: "owner" }, "safety_actor_unknown"],
    [{ kept_by_user_id: "appu_not_a_person_0001" }, "FOREIGN KEY constraint failed|safety_actor_unknown"],
    [{ occurrence_version: version + 1 }, "safety_occurrence_version_conflict"],
    [{ kept_at: at(0) }, "safety_stop_keep_clock_invalid"],
  ] as const) {
    assert.throws(() => insert(overrides as Record<string, unknown>), new RegExp(code), JSON.stringify(overrides));
  }
  const kept = insert();
  assert.throws(() => env.DB.sqlite.prepare("UPDATE safety_stop_keep_decisions SET reason = 'changed' WHERE keep_id = ?").run(kept),
    /safety_stop_keep_append_only/);
  assert.throws(() => env.DB.sqlite.prepare("DELETE FROM safety_stop_keep_decisions WHERE keep_id = ?").run(kept),
    /safety_stop_keep_retained/);
  assert.throws(() => insert({ keep_id: kept }, "INSERT OR REPLACE"), /safety_stop_keep_append_only/);
  assert.throws(() => insert({ idempotency_key: "gaps-direct-0007" }, "INSERT OR REPLACE"), /safety_stop_keep_append_only/);
  // The raiser under another identity.
  setFrappeLogin(env, USERS.owner, ` ${USERS.production.email.toUpperCase()}`);
  assert.throws(() => insert({ kept_by_user_id: USERS.owner.id, kept_by_role: "owner" }),
    /safety_stop_release_by_raiser_forbidden/, "alias");
  setFrappeLogin(env, USERS.owner, "owner.login@example.invalid");
  env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.owner.id);
  assert.throws(() => insert({ kept_by_user_id: USERS.owner.id, kept_by_role: "owner" }), /safety_actor_unknown/);
  // A lifted stop has nothing left to keep, at its current version too.
  const lifted = await call(env, await personAuth(env, USERS.ops), `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  assert.throws(() => insert({ occurrence_version: lifted.body.occurrence.version }), /safety_stop_already_released/);
});

test("the Worker refuses a keep decision before D1 is asked", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.production);
  const { version } = occurrence(env, occurrenceId) as { version: number };
  // A store whose keep insert always fails: any refusal that reaches it is not the Worker's.
  const guarded = {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO safety_stop_keep_decisions")) throw new Error("d1_reached");
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    },
  } as unknown as TestEnv;
  const attempt = (actor: FixtureUser, occurrenceVersion: number) =>
    keepSafetyStop(guarded, {
      tenantId: TENANT, occurrenceId, actorUserId: actor.id, occurrenceVersion,
      reason: "Ice still in the shade.", idempotencyKey: `gaps-worker-keep-${actor.id}-${occurrenceVersion}`,
    });
  await assert.rejects(attempt(USERS.production, version), refusedWith("safety_stop_release_by_raiser_forbidden"));
  setFrappeLogin(env, USERS.owner, USERS.production.email);
  await assert.rejects(attempt(USERS.owner, version), refusedWith("safety_stop_release_by_raiser_forbidden"));
  setFrappeLogin(env, USERS.owner, "owner.login@example.invalid");
  await assert.rejects(attempt(USERS.sales, version), refusedWith("safety_release_authority_required"));
  await assert.rejects(attempt(USERS.ops, version - 1), refusedWith("safety_occurrence_version_conflict"));
  await assert.rejects(attempt(USERS.ops, version), /d1_reached/, "an admissible decision reaches D1");
  const lifted = await call(env, await personAuth(env, USERS.ops), `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  await assert.rejects(attempt(USERS.owner, lifted.body.occurrence.version), refusedWith("safety_stop_already_released"));
});

// --- Item 7: the release asks for a sign-in no older than 5 minutes -------------------------------

test("a release from a session signed in more than 5 minutes ago asks the person to sign in again", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const before = occurrenceSnapshot(env, occurrenceId);
  const stale = await personAuth(env, USERS.production, 6);
  const refused = await call(env, stale, `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, {
    error: "recent_session_required",
    message: "Releasing a safety stop asks you to sign in again if you signed in more than 5 minutes ago.",
  });
  assert.deepEqual(occurrenceSnapshot(env, occurrenceId), before);
  // Every other refusal still comes first, so nobody signs in again for a release that would fail.
  const uncontrolled = await raisedStop(env, USERS.crew, { upTo: "investigating" });
  const notYet = await call(env, stale, `${occurrencePath(uncontrolled)}/commands`, release);
  assert.equal(notYet.body.error, "safety_stop_release_not_permitted");
  const own = await raisedStop(env, USERS.production);
  const raiser = await call(env, stale, `${occurrencePath(own)}/commands`, release);
  assert.equal(raiser.body.error, "safety_stop_release_by_raiser_forbidden");
  // Other commands never ask.
  const controlled = await call(env, stale, `${occurrencePath(uncontrolled)}/commands`,
    { command: "controlled", detail: "Salt on the deck and ladder." });
  assert.equal(controlled.status, 200, JSON.stringify(controlled.body));
  // Signed in within the window, the release goes through.
  const fresh = await call(env, await personAuth(env, USERS.production, 4), `${occurrencePath(occurrenceId)}/commands`, release);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
});
