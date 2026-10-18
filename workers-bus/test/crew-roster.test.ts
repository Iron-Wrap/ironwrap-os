import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";

// Synthetic fixtures only: reserved example.invalid identities and run-relative times.
const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const PEPPER = "synthetic-crew-roster-pepper-0123456789abcdef";
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const USERS = {
  owner: { id: "appu_owner_roster", email: "owner@example.invalid", role: "owner", access: "owner" },
  ops: { id: "appu_ops_roster", email: "ops@example.invalid", role: "ops", access: "ops" },
  sales: { id: "appu_sales_roster", email: "sales@example.invalid", role: "ops", access: "sales" },
  crewA: { id: "appu_crew_a_roster", email: "crew-a@example.invalid", role: "field", access: "field" },
  crewB: { id: "appu_crew_b_roster", email: "crew-b@example.invalid", role: "field", access: "field" },
} as const;
const OTHER_OWNER = { id: "appu_owner_other", email: "owner@other.example.invalid", role: "owner", access: "owner" } as const;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
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
            return { meta: { changes: Number(sqlite.prepare(sql).run(...(values as never[])).changes) } };
          },
        };
      },
    };
  }
  async batch(statements: Array<{ run(): unknown }>) {
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

function testEnv(): TestEnv {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const insert = DB.sqlite.prepare(
    `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
       active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'owner@example.invalid', ?, ?)`,
  );
  for (const user of Object.values(USERS))
    insert.run(user.id, TENANT, user.email, `Synthetic ${user.id}`, user.role, user.access,
      user.role === "field" ? user.email : null, at(-60), at(-60));
  insert.run(OTHER_OWNER.id, OTHER_TENANT, OTHER_OWNER.email, "Other Owner", "owner", "owner", null, at(-60), at(-60));
  return { APP_TENANT_ID: TENANT, APP_AUTH_PEPPER: PEPPER, DB } as unknown as TestEnv;
}

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function personAuth(env: TestEnv, userId: string, tenantId = TENANT): Promise<AuthContext> {
  const token = randomToken();
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(await sessionHashFor(env, token), userId, tenantId, at(-1), at(60), at(-1), "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** What a connector, agent host or service credential carries: an owner role but no cookie token. */
function connectorAuth(): AuthContext {
  return {
    rawSessionToken: "",
    csrfToken: "",
    permissions: permissionsForRole("owner"),
    session: {
      session_hash: "f".repeat(64),
      session_created_at: at(-1),
      session_expires_at: at(60),
      revoked_at: null,
      device_id: "device-synthetic-connector",
      device_proof_hash: null,
      user_id: USERS.owner.id,
      tenant_id: TENANT,
      email_normalized: USERS.owner.email,
      display_name: "Synthetic Owner",
      role: "owner",
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
  body?: unknown,
  options: { csrf?: string | null; method?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const csrf = options.csrf === undefined ? auth.csrfToken : options.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const crew = (overrides: Record<string, unknown> = {}) => ({
  crew_id: "synth-north-crew",
  display_name: "Synthetic North Crew",
  status: "Active",
  expected_version: null,
  ...overrides,
});
const member = (overrides: Record<string, unknown> = {}) => ({
  user_id: USERS.crewA.id,
  active: true,
  expected_version: null,
  ...overrides,
});
const auditRows = (env: TestEnv) =>
  env.DB.sqlite
    .prepare(`SELECT action, target_ids, source_ids, approved_by FROM audit_log WHERE automation = 'crew_roster' ORDER BY id`)
    .all()
    .map((row) => ({ ...row })) as Array<Record<string, string>>;

test("an owner creates a crew once, with one audit event, and a replay changes nothing", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  const created = await call(env, owner, "/api/v1/admin/crews", crew());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    { ...created.body.crew, updated_at: undefined },
    { crew_id: "synth-north-crew", display_name: "Synthetic North Crew", status: "Active", version: 1, updated_at: undefined },
  );
  assert.equal(created.body.replayed, false);

  const replay = await call(env, owner, "/api/v1/admin/crews", crew());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.crew.version, 1);

  const clash = await call(env, owner, "/api/v1/admin/crews", crew({ display_name: "Another Crew" }));
  assert.deepEqual([clash.status, clash.body.error], [409, "crew_exists"]);

  assert.deepEqual(auditRows(env), [
    { action: "crew_create", target_ids: "crew:synth-north-crew", source_ids: "version:1,status:Active", approved_by: USERS.owner.id },
  ]);
});

test("a crew changes only at its next version, and a stale version is a conflict", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops.id);
  await call(env, ops, "/api/v1/admin/crews", crew());
  const renamed = await call(env, ops, "/api/v1/admin/crews", crew({ display_name: "Synthetic North Crew 2", expected_version: 1 }));
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.crew.version, 2);

  const replay = await call(env, ops, "/api/v1/admin/crews", crew({ display_name: "Synthetic North Crew 2", expected_version: 1 }));
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.crew.version], [200, true, 2]);

  const stale = await call(env, ops, "/api/v1/admin/crews", crew({ status: "Inactive", expected_version: 1 }));
  assert.deepEqual([stale.status, stale.body.error], [409, "crew_version_conflict"]);
  const missing = await call(env, ops, "/api/v1/admin/crews", crew({ crew_id: "synth-missing-crew", expected_version: 1 }));
  assert.deepEqual([missing.status, missing.body.error], [404, "crew_not_found"]);
  assert.deepEqual(auditRows(env).map((row) => row.action), ["crew_create", "crew_update"]);
});

test("only active field users join a roster, and a membership is deactivated at its next version", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "/api/v1/admin/crews", crew());
  const path = `/api/v1/admin/crews/${encodeURIComponent("synth-north-crew")}/members`;

  const added = await call(env, owner, path, member());
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.member.active, added.body.member.version], [true, 1]);
  assert.equal((await call(env, owner, path, member())).body.replayed, true);

  const office = await call(env, owner, path, member({ user_id: USERS.ops.id }));
  assert.deepEqual([office.status, office.body.error], [422, "crew_member_not_field_user"]);
  const unknown = await call(env, owner, path, member({ user_id: "appu_nobody_roster" }));
  assert.deepEqual([unknown.status, unknown.body.error], [422, "crew_member_not_field_user"]);
  const noCrew = await call(env, owner, "/api/v1/admin/crews/synth-missing-crew/members", member());
  assert.deepEqual([noCrew.status, noCrew.body.error], [404, "crew_not_found"]);

  const off = await call(env, owner, path, member({ active: false, expected_version: 1 }));
  assert.deepEqual([off.status, off.body.member.active, off.body.member.version], [200, false, 2]);

  const listed = await call(env, owner, "/api/v1/admin/crews");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.crews.map((row: any) => [row.crew_id, row.members.map((m: any) => [m.user_id, m.active, m.version])]),
    [["synth-north-crew", [[USERS.crewA.id, false, 2]]]],
  );
  assert.deepEqual(auditRows(env).map((row) => row.action), ["crew_create", "crew_member_add", "crew_member_update"]);
});

test("the roster is people-only: other roles, connectors and a missing CSRF token are refused", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  for (const role of ["sales", "production", "accounting", "field"] as const) {
    const other = { ...owner, permissions: permissionsForRole(role), session: { ...owner.session, role } };
    const refused = await call(env, other, "/api/v1/admin/crews", crew());
    assert.deepEqual([refused.status, refused.body.error], [403, "crew_roster_role_required"], role);
  }
  // The session row says ops, but the role the request carries is what this check reads first;
  // a signed-in person whose current role is not owner or ops is refused by the person check too.
  const salesPerson = await personAuth(env, USERS.sales.id);
  const salesRefused = await call(env, salesPerson, "/api/v1/admin/crews", crew());
  assert.equal(salesRefused.status, 403);
  // A connector carries an owner role but no cookie token, so it is never a person.
  const connector = await call(env, connectorAuth(), "/api/v1/admin/crews", crew(), { csrf: null });
  assert.deepEqual([connector.status, connector.body.error], [403, "person_session_required"]);
  const forged = { ...connectorAuth(), csrfToken: "x".repeat(43) };
  const noPerson = await call(env, forged, "/api/v1/admin/crews", crew(), { csrf: "x".repeat(43) });
  assert.deepEqual([noPerson.status, noPerson.body.error], [403, "person_session_required"]);
  const noCsrf = await call(env, owner, "/api/v1/admin/crews", crew(), { csrf: null });
  assert.deepEqual([noCsrf.status, noCsrf.body.error], [403, "csrf_failed"]);
  assert.deepEqual(auditRows(env), []);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM fleet_crews").get()?.n, 0);
});

test("a crew belongs to its tenant: another tenant's owner neither sees nor changes it", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "/api/v1/admin/crews", crew());
  const otherEnv = { ...env, APP_TENANT_ID: OTHER_TENANT } as TestEnv;
  const other = await personAuth(otherEnv, OTHER_OWNER.id, OTHER_TENANT);
  assert.deepEqual((await call(otherEnv, other, "/api/v1/admin/crews")).body.crews, []);
  const join = await call(otherEnv, other, `/api/v1/admin/crews/${encodeURIComponent("synth-north-crew")}/members`, member());
  assert.deepEqual([join.status, join.body.error], [404, "crew_not_found"]);
});

test("a malformed body is refused before anything is written", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  for (const body of [
    { ...crew(), extra: true },
    crew({ crew_id: "short" }),
    crew({ status: "Retired" }),
    crew({ display_name: " " }),
    crew({ expected_version: 0 }),
  ]) {
    const refused = await call(env, owner, "/api/v1/admin/crews", body);
    assert.deepEqual([refused.status, refused.body.error], [400, "invalid_crew"], JSON.stringify(body));
  }
  assert.deepEqual(auditRows(env), []);
});
