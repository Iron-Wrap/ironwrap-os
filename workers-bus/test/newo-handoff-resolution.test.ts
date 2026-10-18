import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import { buildNewoOperationsReadModel } from "../src/newo-operations-read-model.ts";
import { newoOperationalCounts } from "../src/newo-store.ts";

// Synthetic fixtures only: reserved example.invalid identities and run-relative times.
const TENANT = "ironwrap";
const PEPPER = "synthetic-newo-resolution-pepper-0123456789abcdef";
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const USERS = {
  owner: { id: "appu_owner_newo", role: "owner", access: "owner" },
  ops: { id: "appu_ops_newo", role: "ops", access: "ops" },
  sales: { id: "appu_sales_newo", role: "ops", access: "sales" },
  production: { id: "appu_production_newo", role: "ops", access: "production" },
} as const;

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
      all<T>() {
        return { results: sqlite.prepare(sql).all() as T[] };
      },
      first<T>() {
        return (sqlite.prepare(sql).get() as T | undefined) ?? null;
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
  const user = DB.sqlite.prepare(
    `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
       active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 'owner@example.invalid', ?, ?)`,
  );
  for (const person of Object.values(USERS))
    user.run(person.id, TENANT, `${person.id}@example.invalid`, person.id, person.role, person.access, at(-60), at(-60));
  const session = DB.sqlite.prepare(
    `INSERT INTO newo_sessions
      (session_id, status, handoff_status, structured_json, raw_key, payload_hash, created_at, updated_at)
     VALUES (?, 'completed', ?, '{}', ?, ?, ?, ?)`,
  );
  session.run("newo-session-failed-1", "failed", "raw/newo/1", "a".repeat(64), at(-30), at(-30));
  session.run("newo-session-failed-2", "failed", "raw/newo/2", "b".repeat(64), at(-20), at(-20));
  session.run("newo-session-connected", "connected", "raw/newo/3", "c".repeat(64), at(-10), at(-10));
  return { APP_TENANT_ID: TENANT, APP_AUTH_PEPPER: PEPPER, DB } as unknown as TestEnv;
}

async function personAuth(env: TestEnv, userId: string): Promise<AuthContext> {
  const token = randomToken();
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(await sessionHashFor(env, token), userId, TENANT, at(-1), at(60), at(-1), "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", { headers: { cookie: `__Host-ironwrap_session=${token}` } }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

function withRole(auth: AuthContext, role: AppRole): AuthContext {
  return { ...auth, permissions: permissionsForRole(role), session: { ...auth.session, role } };
}

async function call(
  env: TestEnv,
  auth: AuthContext,
  sessionId: string,
  body?: unknown,
  options: { key?: string | null; csrf?: string | null } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const csrf = options.csrf === undefined ? auth.csrfToken : options.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  const key = options.key === undefined ? "newo-resolution-0001" : options.key;
  if (key) headers["idempotency-key"] = key;
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/newo/operations/handoffs/${encodeURIComponent(sessionId)}/resolution`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test("an owner resolves a failed handoff once; an exact retry replays and anything else conflicts", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  const recorded = await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: " Called back, booked a visit. " });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.resolution.outcome, "called_back");
  assert.equal(recorded.body.resolution.note, "Called back, booked a visit.");
  assert.equal(recorded.body.resolution.resolved_by, USERS.owner.id);
  assert.equal(recorded.body.resolution.resolved_by_role, "owner");

  const replay = await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: "Called back, booked a visit." });
  assert.deepEqual(replay, recorded);
  const changed = await call(env, owner, "newo-session-failed-1", { outcome: "unreachable" });
  assert.deepEqual([changed.status, changed.body.error], [409, "newo_handoff_resolution_replay_conflict"]);
  const second = await call(env, owner, "newo-session-failed-1", { outcome: "not_needed" }, { key: "newo-resolution-0002" });
  assert.deepEqual([second.status, second.body.error], [409, "newo_handoff_already_resolved"]);

  const read = await call(env, owner, "newo-session-failed-1");
  assert.equal(read.status, 200);
  assert.equal(read.body.handoff.handoff_status, "failed");
  assert.deepEqual(read.body.resolution, recorded.body.resolution);
});

test("only a failed handoff of a known session can be resolved", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops.id);
  const connected = await call(env, ops, "newo-session-connected", { outcome: "not_needed" });
  assert.deepEqual([connected.status, connected.body.error], [409, "newo_handoff_not_failed"]);
  const missing = await call(env, ops, "newo-session-missing", { outcome: "not_needed" }, { key: "newo-resolution-0003" });
  assert.deepEqual([missing.status, missing.body.error], [404, "newo_handoff_not_found"]);
  const resolved = await call(env, ops, "newo-session-failed-2", { outcome: "unreachable" }, { key: "newo-resolution-0004" });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.resolution.resolved_by_role, "ops");
});

test("resolving is people-only, in the owner or ops role, with CSRF and an idempotency key", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  // Reading answers to the role on the request; recording answers to the person's role right now.
  for (const role of ["sales", "production", "accounting", "field"] as const) {
    const refused = await call(env, withRole(owner, role), "newo-session-failed-1");
    assert.deepEqual([refused.status, refused.body.error], [403, "newo_handoff_resolution_role_required"], role);
  }
  const salesPerson = await personAuth(env, USERS.sales.id);
  assert.deepEqual(
    (await call(env, salesPerson, "newo-session-failed-1", { outcome: "called_back" })).body.error,
    "newo_handoff_resolution_role_required",
  );
  const connector = { ...owner, rawSessionToken: "", csrfToken: "x".repeat(43) };
  const noPerson = await call(env, connector, "newo-session-failed-1", { outcome: "called_back" }, { csrf: "x".repeat(43) });
  assert.deepEqual([noPerson.status, noPerson.body.error], [403, "newo_handoff_resolution_person_required"]);
  const noCsrf = await call(env, owner, "newo-session-failed-1", { outcome: "called_back" }, { csrf: null });
  assert.deepEqual([noCsrf.status, noCsrf.body.error], [403, "csrf_failed"]);
  const noKey = await call(env, owner, "newo-session-failed-1", { outcome: "called_back" }, { key: null });
  assert.deepEqual([noKey.status, noKey.body.error], [400, "idempotency_key_required"]);
  for (const [body, error] of [
    [{ outcome: "maybe" }, "newo_handoff_resolution_outcome_required"],
    [{ outcome: "called_back", extra: 1 }, "invalid_newo_handoff_resolution"],
    [{ outcome: "called_back", note: "x".repeat(1001) }, "invalid_newo_handoff_resolution"],
  ] as const) {
    const refused = await call(env, owner, "newo-session-failed-1", body);
    assert.deepEqual([refused.status, refused.body.error], [400, error], JSON.stringify(body));
  }
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 0);
});

test("the reconcile and the operations list count only failed handoffs no person resolved", async () => {
  const env = testEnv();
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 2);
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "newo-session-failed-1", { outcome: "called_back" });
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 1);
  const model = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(model.exceptions.failed_handoffs.map((session) => session.session_id), ["newo-session-failed-2"]);
  assert.equal(model.counts.failed_handoffs, 1);
  await call(env, owner, "newo-session-failed-2", { outcome: "not_needed" }, { key: "newo-resolution-0005" });
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 0);
});

test("D1 keeps the record append-only and re-checks the failed status and the resolver", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "newo-session-failed-1", { outcome: "called_back" });
  const raw = env.DB.sqlite;
  assert.throws(() => raw.exec("UPDATE newo_handoff_resolutions SET outcome = 'unreachable'"));
  assert.throws(() => raw.exec("DELETE FROM newo_handoff_resolutions"));
  const insert = (id: string, session: string, by: string, role: string, key: string, replace = false) =>
    raw.prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO newo_handoff_resolutions
        (resolution_id, tenant_id, idempotency_key, request_sha256, session_id, outcome, note,
         resolved_by, resolved_by_role, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'not_needed', NULL, ?, ?, ?)`,
    ).run(id, TENANT, key, "f".repeat(64), session, by, role, at(0));
  assert.throws(() => insert(`nhr_${"1".repeat(32)}`, "newo-session-connected", USERS.owner.id, "owner", "direct-key-0001"), /not_failed/);
  assert.throws(() => insert(`nhr_${"2".repeat(32)}`, "newo-session-failed-2", USERS.sales.id, "ops", "direct-key-0002"));
  assert.throws(() => insert(`nhr_${"3".repeat(32)}`, "newo-session-failed-1", USERS.ops.id, "ops", "direct-key-0003", true));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 1);
});
