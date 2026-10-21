import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import {
  evaluateSafetyReadiness,
  recordMakeSafe,
  recordSafetyResponse,
  reportSafetyOccurrence,
  SafetyError,
  type SafetyResponseCommand,
} from "../src/safety-lifecycle.ts";

// Owner rule L06: a safety-occurrence stop is never lifted by the person who raised it, under any
// identity they carry, and there is no exception for working alone. Migration 0165 and the Worker
// enforce it together, and a transition always commits together with its journal event.
// Every fixture is synthetic: reserved example.invalid identities, and times relative to the run.

const TENANT = "ironwrap";
const PEPPER = "synthetic-safety-stop-release-pepper-0123456789";
const BASE = Date.now() - 6 * 60 * 60 * 1_000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const SCOPE = { type: "roof_job" as const, id: "JOB-SAFETY-STOP-1" };

interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: "owner" | "ops" | "field";
  access: string;
  frappe?: string;
}

const USERS = {
  owner: { id: "appu_owner_safety_stop", email: "owner@example.invalid", name: "Synthetic Owner", role: "owner", access: "owner" },
  ops: { id: "appu_ops_safety_stop", email: "ops@example.invalid", name: "Synthetic Ops", role: "ops", access: "ops" },
  production: { id: "appu_production_safety_stop", email: "production@example.invalid", name: "Synthetic Production", role: "ops", access: "production" },
  sales: { id: "appu_sales_safety_stop", email: "sales@example.invalid", name: "Synthetic Sales", role: "ops", access: "sales" },
  crew: { id: "appu_crew_safety_stop", email: "crew@example.invalid", name: "Synthetic Crew", role: "field", access: "field", frappe: "crew@example.invalid" },
} satisfies Record<string, FixtureUser>;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  /** Batches the Worker sent, so a test can prove a refusal came before any write. */
  batches = 0;
  /** A one-shot write by someone else, committed between the Worker's checks and its batch. */
  beforeBatch: (() => void) | null = null;

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
    const concurrent = this.beforeBatch;
    this.beforeBatch = null;
    concurrent?.();
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
  const occurrenceId = `so_l06_stop_${String(nextOccurrence).padStart(4, "0")}`;
  await reportSafetyOccurrence(env, {
    occurrenceId,
    tenantId: TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope: SCOPE,
    reportedByUserId: raiser.id,
    reportedAt: at(nextOccurrence),
    summary: `Loose panel at the ridge, report ${nextOccurrence}.`,
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
    actorUserId: raiser.id,
    detail: "Area taped off below the ridge.",
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
  await respond(env, supervisor, occurrenceId, "controlled");
  return occurrenceId;
}

interface OccurrenceRow {
  version: number;
  state: string;
  stop_active: number;
  released_by_user_id: string | null;
}

// node:sqlite rows have a null prototype; the spreads make them plain objects to compare.
function occurrenceRow(env: TestEnv, occurrenceId: string): OccurrenceRow {
  const row = env.DB.sqlite
    .prepare(
      `SELECT version, state, stop_active, released_by_user_id
         FROM safety_occurrences WHERE tenant_id = ? AND occurrence_id = ?`,
    )
    .get(TENANT, occurrenceId) as unknown as OccurrenceRow;
  return { ...row };
}

function events(env: TestEnv, occurrenceId: string) {
  const rows = env.DB.sqlite
    .prepare(
      `SELECT occurrence_version, event_kind, actor_user_id, actor_role
         FROM safety_occurrence_events
        WHERE tenant_id = ? AND occurrence_id = ?
        ORDER BY occurrence_version`,
    )
    .all(TENANT, occurrenceId) as Array<{
    occurrence_version: number;
    event_kind: string;
    actor_user_id: string;
    actor_role: string;
  }>;
  return rows.map((row) => ({ ...row }));
}

/** Proves nothing moved: the same row and the same journal as before the refused request. */
function unchanged(env: TestEnv, occurrenceId: string, before: OccurrenceRow, journal: number, label: string) {
  assert.deepEqual(occurrenceRow(env, occurrenceId), before, label);
  assert.equal(events(env, occurrenceId).length, journal, label);
}

/**
 * A lift written straight to D1, the way any other path would have to write it: an optional
 * `released` event first, then the lift naming `releaser`, in one transaction.
 */
function directLift(
  env: TestEnv,
  occurrenceId: string,
  releaser: string | null,
  event: { actor: FixtureUser; version?: number } | null,
) {
  const { version } = occurrenceRow(env, occurrenceId);
  const db = env.DB.sqlite;
  db.exec("BEGIN");
  try {
    if (event) {
      const eventVersion = event.version ?? version + 1;
      db.prepare(
        `INSERT INTO safety_occurrence_events
          (event_id, tenant_id, occurrence_id, occurrence_version, event_kind, actor_user_id,
           actor_role, detail, captured_offline, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, 'released', ?, ?, 'Lifted straight in D1.', 0, ?, ?)`,
      ).run(`soe_direct_${occurrenceId}_${eventVersion}`, TENANT, occurrenceId, eventVersion,
        event.actor.id, event.actor.access, at(90), at(90));
    }
    db.prepare(
      `UPDATE safety_occurrences
          SET version = ?, stop_active = 0, released_by_user_id = ?, updated_at = ?
        WHERE tenant_id = ? AND occurrence_id = ? AND version = ?`,
    ).run(version + 1, releaser, at(90), TENANT, occurrenceId, version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// --- Person sessions and requests ----------------------------------------------------------------

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function personAuth(env: TestEnv, user: FixtureUser): Promise<AuthContext> {
  const token = randomToken();
  const now = Date.now();
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(await sessionHashFor(env, token), user.id, TENANT, new Date(now - 60_000).toISOString(),
      new Date(now + 3_600_000).toISOString(), new Date(now - 60_000).toISOString(),
      "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
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

async function postCommand(
  env: TestEnv,
  auth: AuthContext,
  occurrenceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(
      `https://app.example.invalid/api/v1/safety/occurrences/${encodeURIComponent(occurrenceId)}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": auth.csrfToken },
        body: JSON.stringify(body),
      },
    ),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const release = { command: "released", detail: "Ridge panel refixed and inspected." };

function assertRefused(
  result: { status: number; body: Record<string, any> },
  status: number,
  code: string,
  label: string,
) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, code, label);
}

// --- Allowed --------------------------------------------------------------------------------------

test("another owner, ops or production person lifts the stop, and the row and journal name them", async () => {
  for (const releaser of [USERS.owner, USERS.ops, USERS.production]) {
    const env = testEnv();
    const occurrenceId = await raisedStop(env, USERS.crew);
    const lifted = await postCommand(env, await personAuth(env, releaser), occurrenceId, release);
    assert.equal(lifted.status, 200, `${releaser.access}: ${JSON.stringify(lifted.body)}`);
    assert.equal(lifted.body.occurrence.stop_active, 0);
    assert.equal(lifted.body.occurrence.state, "controlled");
    assert.equal(lifted.body.occurrence.released_by_user_id, releaser.id);
    const journal = events(env, occurrenceId);
    assert.deepEqual(journal.at(-1), {
      occurrence_version: lifted.body.occurrence.version,
      event_kind: "released",
      actor_user_id: releaser.id,
      actor_role: releaser.access,
    });
  }

  // D1 admits the same lift written directly, with the releaser's own event.
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  directLift(env, occurrenceId, USERS.production.id, { actor: USERS.production });
  assert.equal(occurrenceRow(env, occurrenceId).stop_active, 0);
  assert.equal(occurrenceRow(env, occurrenceId).released_by_user_id, USERS.production.id);
});

// --- The raiser ----------------------------------------------------------------------------------

test("the person who raised the stop can never lift it, by user id, email or Frappe identity", async () => {
  // The raiser is a production user, so only L06 stands between them and the lift.
  const cases: Array<[string, (env: TestEnv) => void, FixtureUser]> = [
    ["the raiser's own user id", () => {}, USERS.production],
    ["the releaser's Frappe login is the raiser's email",
      (env) => setFrappeLogin(env, USERS.owner, USERS.production.email), USERS.owner],
    ["the same alias, in other case and with spaces",
      (env) => setFrappeLogin(env, USERS.owner, "  PRODUCTION@Example.Invalid "), USERS.owner],
    ["the raiser's Frappe login is the releaser's email",
      (env) => setFrappeLogin(env, USERS.production, USERS.owner.email), USERS.owner],
    ["both carry the same Frappe user",
      (env) => {
        setFrappeLogin(env, USERS.production, "shared.frappe.login");
        setFrappeLogin(env, USERS.owner, "Shared.Frappe.Login");
      }, USERS.owner],
    ["the releaser's Frappe login is the raiser's user id",
      (env) => setFrappeLogin(env, USERS.owner, USERS.production.id), USERS.owner],
  ];
  for (const [label, alias, releaser] of cases) {
    const env = testEnv();
    const occurrenceId = await raisedStop(env, USERS.production);
    alias(env);
    const before = occurrenceRow(env, occurrenceId);
    const journal = events(env, occurrenceId).length;
    const batches = env.DB.batches;

    const refused = await postCommand(env, await personAuth(env, releaser), occurrenceId, release);
    assertRefused(refused, 403, "safety_stop_release_by_raiser_forbidden", label);
    // The Worker refused before it wrote anything.
    assert.equal(env.DB.batches, batches, label);
    unchanged(env, occurrenceId, before, journal, label);

    // D1 joins the same identities itself, for a lift written straight to the table.
    assert.throws(
      () => directLift(env, occurrenceId, releaser.id, { actor: releaser }),
      /safety_stop_release_by_raiser_forbidden/,
      label,
    );
    unchanged(env, occurrenceId, before, journal, label);

    // A releaser no identity ties to the raiser still may.
    const independent = await postCommand(env, await personAuth(env, USERS.ops), occurrenceId, release);
    assert.equal(independent.status, 200, `${label}: ${JSON.stringify(independent.body)}`);
    assert.equal(independent.body.occurrence.released_by_user_id, USERS.ops.id, label);
  }
});

test("a solo owner who raised the stop cannot lift it, and the stop stays active", async () => {
  // Nobody else in this tenant holds release authority: the crew member is a field worker.
  const env = testEnv([USERS.owner, USERS.crew]);
  const occurrenceId = await raisedStop(env, USERS.owner, { supervisor: USERS.owner });
  const before = occurrenceRow(env, occurrenceId);
  assert.equal(before.state, "controlled");
  const journal = events(env, occurrenceId).length;

  const refused = await postCommand(env, await personAuth(env, USERS.owner), occurrenceId, release);
  assertRefused(refused, 403, "safety_stop_release_by_raiser_forbidden", "solo owner");
  await assert.rejects(
    respond(env, USERS.crew, occurrenceId, "released"),
    (error) => error instanceof SafetyError && error.code === "safety_release_authority_required",
  );
  assert.throws(
    () => directLift(env, occurrenceId, USERS.owner.id, { actor: USERS.owner }),
    /safety_stop_release_by_raiser_forbidden/,
  );
  unchanged(env, occurrenceId, before, journal, "solo owner");

  // No fallback exists yet, so the job stays blocked.
  const readiness = await evaluateSafetyReadiness(env, {
    tenantId: TENANT,
    scopes: [{ type: "tenant", id: TENANT }, SCOPE],
    subjectUserIds: [],
    now: new Date().toISOString(),
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers.map((blocker) => [blocker.code, blocker.subject_id]),
    [["safety_stop_active", occurrenceId]]);
});

test("an identity that changes after the Worker's check still meets the same refusal from D1", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.production);
  const before = occurrenceRow(env, occurrenceId);
  const journal = events(env, occurrenceId).length;
  const owner = await personAuth(env, USERS.owner);
  // Committed after the Worker compared identities and before its batch: the owner's Frappe login
  // becomes the raiser's email.
  env.DB.beforeBatch = () => setFrappeLogin(env, USERS.owner, USERS.production.email);
  const raced = await postCommand(env, owner, occurrenceId, release);
  assertRefused(raced, 403, "safety_stop_release_by_raiser_forbidden", "race");
  unchanged(env, occurrenceId, before, journal, "race");
});

// --- Who may call the release at all ---------------------------------------------------------------

test("only a person's own session may lift a stop: agents, connectors and borrowed sessions are refused", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const before = occurrenceRow(env, occurrenceId);
  const journal = events(env, occurrenceId).length;
  const production = await personAuth(env, USERS.production);
  const revoked = await personAuth(env, USERS.owner);
  env.DB.sqlite.prepare("UPDATE app_sessions SET revoked_at = ? WHERE session_hash = ?")
    .run(new Date().toISOString(), revoked.session.session_hash);

  for (const [label, auth] of [
    ["agent or connector context", connectorAuth(USERS.production)],
    ["a token that is not this session", { ...production, rawSessionToken: randomToken() }],
    ["a CSRF token not derived from the session", { ...production, csrfToken: "forged-csrf-token" }],
    ["a session claimed for another user",
      { ...production, session: { ...production.session, user_id: USERS.owner.id } }],
    ["a revoked session", revoked],
  ] as const) {
    const refused = await postCommand(env, auth, occurrenceId, release);
    assertRefused(refused, 403, "safety_stop_release_person_required", label);
    unchanged(env, occurrenceId, before, journal, label);
  }

  // A person deactivated after signing in is no longer a live session, and D1 knows no such user.
  const ops = await personAuth(env, USERS.ops);
  env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.ops.id);
  assertRefused(await postCommand(env, ops, occurrenceId, release), 403,
    "safety_stop_release_person_required", "deactivated");
  // A person without a releasing role.
  assertRefused(await postCommand(env, await personAuth(env, USERS.sales), occurrenceId, release), 403,
    "safety_release_authority_required", "sales");
  unchanged(env, occurrenceId, before, journal, "person checks");
});

test("D1 refuses a lift that names nobody, an unknown or inactive user, or an agent", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const before = occurrenceRow(env, occurrenceId);
  const journal = events(env, occurrenceId).length;
  assert.throws(() => directLift(env, occurrenceId, null, { actor: USERS.ops }),
    /safety_stop_releaser_required/);
  for (const releaser of ["appu_not_a_person_0001", "agent:field_safety"]) {
    assert.throws(() => directLift(env, occurrenceId, releaser, null), /safety_actor_unknown/, releaser);
  }
  env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.production.id);
  assert.throws(() => directLift(env, occurrenceId, USERS.production.id, null), /safety_actor_unknown/);
  unchanged(env, occurrenceId, before, journal, "unnamed or unknown releaser");
});

test("D1 refuses a lift without the releaser's own released event for that version", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const before = occurrenceRow(env, occurrenceId);
  const journal = events(env, occurrenceId).length;
  for (const [label, event] of [
    ["no event", null],
    ["another person's event", { actor: USERS.ops }],
    ["an event for another version", { actor: USERS.owner, version: before.version + 2 }],
  ] as const) {
    assert.throws(() => directLift(env, occurrenceId, USERS.owner.id, event),
      /safety_stop_release_event_required/, label);
    unchanged(env, occurrenceId, before, journal, label);
  }
});

test("who lifted a stop is written by the lift and never changes afterwards", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew);
  const write = (releaser: string | null) => {
    const { version } = occurrenceRow(env, occurrenceId);
    env.DB.sqlite.prepare(
      `UPDATE safety_occurrences SET version = ?, released_by_user_id = ?, updated_at = ?
        WHERE tenant_id = ? AND occurrence_id = ?`,
    ).run(version + 1, releaser, at(95), TENANT, occurrenceId);
  };
  // Not while the stop is active: naming a releaser is part of the lift itself.
  assert.throws(() => write(USERS.ops.id), /safety_stop_releaser_immutable/);
  const lift = await postCommand(env, await personAuth(env, USERS.ops), occurrenceId, release);
  assert.equal(lift.status, 200, JSON.stringify(lift.body));
  const lifted = occurrenceRow(env, occurrenceId);
  assert.equal(lifted.released_by_user_id, USERS.ops.id);
  for (const releaser of [USERS.owner.id, null]) {
    assert.throws(() => write(releaser), /safety_stop_releaser_immutable/, String(releaser));
  }
  // A second release is refused before it is written, and the first releaser stands.
  const journal = events(env, occurrenceId).length;
  const again = await postCommand(env, await personAuth(env, USERS.owner), occurrenceId, release);
  assertRefused(again, 409, "safety_stop_already_released", "second release");
  unchanged(env, occurrenceId, lifted, journal, "second release");
  // Closing keeps the name.
  const closed = await respond(env, USERS.ops, occurrenceId, "closed");
  assert.equal(closed.state, "closed");
  assert.equal(closed.released_by_user_id, USERS.ops.id);
});

test("an uncontrolled stop or an incomplete required rescue still refuses the lift, as before", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops);
  for (const upTo of ["reported", "made_safe", "investigating"] as const) {
    const occurrenceId = await raisedStop(env, USERS.crew, { upTo });
    const before = occurrenceRow(env, occurrenceId);
    const journal = events(env, occurrenceId).length;
    assertRefused(await postCommand(env, ops, occurrenceId, release), 409,
      "safety_stop_release_not_permitted", upTo);
    // D1 refuses the same lift even with a valid releaser and event.
    assert.throws(() => directLift(env, occurrenceId, USERS.ops.id, { actor: USERS.ops }),
      /safety_stop_release_not_permitted/, upTo);
    unchanged(env, occurrenceId, before, journal, upTo);
  }

  const rescue = await raisedStop(env, USERS.crew, { rescueRequired: true });
  const before = occurrenceRow(env, rescue);
  const journal = events(env, rescue).length;
  assertRefused(await postCommand(env, ops, rescue, release), 409,
    "safety_stop_release_not_permitted", "rescue incomplete");
  assert.throws(() => directLift(env, rescue, USERS.ops.id, { actor: USERS.ops }),
    /safety_stop_release_not_permitted/);
  unchanged(env, rescue, before, journal, "rescue incomplete");
  await respond(env, USERS.ops, rescue, "rescue_completed");
  assert.equal((await postCommand(env, ops, rescue, release)).status, 200);
});

// --- Atomic transitions --------------------------------------------------------------------------

test("a command with a short detail or malformed evidence is refused before anything is written", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops);
  const controlled = await raisedStop(env, USERS.crew);
  const investigating = await raisedStop(env, USERS.crew, { upTo: "investigating" });
  const badEvidence = {
    evidence_refs_json: JSON.stringify([1]),
    evidence_sha256: "a".repeat(64),
  };
  for (const [label, occurrenceId, body, code] of [
    ["released, two characters", controlled, { ...release, detail: "ok" }, "safety_command_invalid"],
    ["released, only spaces", controlled, { ...release, detail: "     " }, "safety_command_invalid"],
    ["released, not text", controlled, { ...release, detail: 42 }, "safety_command_invalid"],
    ["released, malformed evidence", controlled, { ...release, ...badEvidence }, "safety_evidence_invalid"],
    ["controlled, two characters", investigating, { command: "controlled", detail: "ok" },
      "safety_command_invalid"],
    ["controlled, malformed evidence", investigating,
      { command: "controlled", detail: "Barrier installed.", ...badEvidence }, "safety_evidence_invalid"],
  ] as const) {
    const before = occurrenceRow(env, occurrenceId);
    const journal = events(env, occurrenceId).length;
    const batches = env.DB.batches;
    assertRefused(await postCommand(env, ops, occurrenceId, body), 400, code, label);
    assert.equal(env.DB.batches, batches, label);
    unchanged(env, occurrenceId, before, journal, label);
  }
  assert.equal(occurrenceRow(env, controlled).stop_active, 1);
});

test("an event that cannot be written leaves the occurrence unchanged, for every transition", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops);
  const forceFailure = (kind: string) =>
    env.DB.sqlite.exec(`CREATE TRIGGER test_forced_event_failure
      BEFORE INSERT ON safety_occurrence_events WHEN NEW.event_kind = '${kind}'
      BEGIN SELECT RAISE(ABORT, 'forced_event_failure'); END`);
  const allowWrites = () => env.DB.sqlite.exec("DROP TRIGGER test_forced_event_failure");

  const controlled = await raisedStop(env, USERS.crew);
  let before = occurrenceRow(env, controlled);
  let journal = events(env, controlled).length;
  forceFailure("released");
  assertRefused(await postCommand(env, ops, controlled, release), 502, "safety_store_unavailable",
    "released");
  unchanged(env, controlled, before, journal, "released");
  assert.equal(occurrenceRow(env, controlled).stop_active, 1);
  allowWrites();

  const investigating = await raisedStop(env, USERS.crew, { upTo: "investigating" });
  before = occurrenceRow(env, investigating);
  journal = events(env, investigating).length;
  forceFailure("controlled");
  assertRefused(await postCommand(env, ops, investigating, { command: "controlled", detail: "Barrier installed." }),
    502, "safety_store_unavailable", "controlled");
  unchanged(env, investigating, before, journal, "controlled");
  allowWrites();

  const reported = await raisedStop(env, USERS.crew, { upTo: "reported" });
  before = occurrenceRow(env, reported);
  journal = events(env, reported).length;
  forceFailure("make_safe");
  await assert.rejects(
    recordMakeSafe(env, {
      tenantId: TENANT,
      occurrenceId: reported,
      actorUserId: USERS.crew.id,
      detail: "Area taped off below the ridge.",
      evidence: null,
      capturedOffline: false,
      deviceActionId: null,
      occurredAt: at(99),
      now: at(99),
    }),
    /forced_event_failure/,
  );
  unchanged(env, reported, before, journal, "make_safe");
  allowWrites();
});

test("a command that lost a race writes neither its event nor its state change", async () => {
  const env = testEnv();
  const occurrenceId = await raisedStop(env, USERS.crew, { upTo: "investigating" });
  const ops = await personAuth(env, USERS.ops);
  const read = occurrenceRow(env, occurrenceId);
  // Another command moves the occurrence on after this one read it, and before it writes.
  env.DB.beforeBatch = () =>
    env.DB.sqlite.prepare(
      `UPDATE safety_occurrences SET version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND occurrence_id = ?`,
    ).run(at(97), TENANT, occurrenceId);
  const lost = await postCommand(env, ops, occurrenceId,
    { command: "controlled", detail: "Barrier installed." });
  assertRefused(lost, 409, "safety_occurrence_version_conflict", "lost race");
  assert.deepEqual(occurrenceRow(env, occurrenceId), { ...read, version: read.version + 1 });
  assert.equal(events(env, occurrenceId).some((event) => event.event_kind === "controlled"), false);
});
