import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor, sha256Hex } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import {
  recordMakeSafe,
  recordSafetyResponse,
  reportSafetyOccurrence,
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
          run() {
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
