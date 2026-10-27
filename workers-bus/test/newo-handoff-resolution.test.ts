import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import worker from "../src/index.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import { buildNewoOperationsReadModel, newoOperationsNeedAttention } from "../src/newo-operations-read-model.ts";
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
      run() {
        return { meta: { changes: Number(sqlite.prepare(sql).run().changes) } };
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
  const changed = await call(env, owner, "newo-session-failed-1", { outcome: "unreachable", note: "No answer." });
  assert.deepEqual([changed.status, changed.body.error], [409, "newo_handoff_resolution_replay_conflict"]);
  const second = await call(env, owner, "newo-session-failed-1", { outcome: "not_needed", note: "Duplicate." }, { key: "newo-resolution-0002" });
  assert.deepEqual([second.status, second.body.error], [409, "newo_handoff_already_resolved"]);

  const read = await call(env, owner, "newo-session-failed-1");
  assert.equal(read.status, 200);
  assert.equal(read.body.handoff.handoff_status, "failed");
  assert.equal(read.body.callback, null);
  assert.deepEqual(read.body.resolution, recorded.body.resolution);
});

test("only a failed handoff or a requested callback of a known session can be resolved", async () => {
  const env = testEnv();
  const ops = await personAuth(env, USERS.ops.id);
  const connected = await call(env, ops, "newo-session-connected", { outcome: "not_needed", note: "Nothing to do." });
  assert.deepEqual([connected.status, connected.body.error], [409, "newo_handoff_not_open"]);
  const missing = await call(env, ops, "newo-session-missing", { outcome: "not_needed", note: "Nothing to do." }, { key: "newo-resolution-0003" });
  assert.deepEqual([missing.status, missing.body.error], [404, "newo_handoff_not_found"]);
  const resolved = await call(env, ops, "newo-session-failed-2", { outcome: "unreachable", note: "Voicemail full." }, { key: "newo-resolution-0004" });
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
    (await call(env, salesPerson, "newo-session-failed-1", { outcome: "called_back", note: "Called." })).body.error,
    "newo_handoff_resolution_role_required",
  );
  const connector = { ...owner, rawSessionToken: "", csrfToken: "x".repeat(43) };
  const noPerson = await call(env, connector, "newo-session-failed-1", { outcome: "called_back", note: "Called." }, { csrf: "x".repeat(43) });
  assert.deepEqual([noPerson.status, noPerson.body.error], [403, "newo_handoff_resolution_person_required"]);
  const noCsrf = await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: "Called." }, { csrf: null });
  assert.deepEqual([noCsrf.status, noCsrf.body.error], [403, "csrf_failed"]);
  const noKey = await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: "Called." }, { key: null });
  assert.deepEqual([noKey.status, noKey.body.error], [400, "idempotency_key_required"]);
  for (const [body, error] of [
    [{ outcome: "maybe", note: "Called." }, "newo_handoff_resolution_outcome_required"],
    [{ note: "Called." }, "newo_handoff_resolution_outcome_required"],
    [{ outcome: "called_back", extra: 1, note: "Called." }, "invalid_newo_handoff_resolution"],
    [{ outcome: "called_back", note: 7 }, "invalid_newo_handoff_resolution"],
    [{ outcome: "called_back" }, "newo_handoff_resolution_note_required"],
    [{ outcome: "called_back", note: null }, "newo_handoff_resolution_note_required"],
    [{ outcome: "called_back", note: "   " }, "newo_handoff_resolution_note_required"],
    [{ outcome: "called_back", note: "x".repeat(1001) }, "newo_handoff_resolution_note_too_long"],
  ] as const) {
    const refused = await call(env, owner, "newo-session-failed-1", body);
    assert.deepEqual([refused.status, refused.body.error], [400, error], JSON.stringify(body));
  }
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n, 0);
});

test("the reconcile and the operations list count only failed handoffs no person resolved", async () => {
  const env = testEnv();
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 2);
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: "Called back." });
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 1);
  const model = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(model.exceptions.failed_handoffs.map((session) => session.session_id), ["newo-session-failed-2"]);
  assert.equal(model.counts.failed_handoffs, 1);
  await call(env, owner, "newo-session-failed-2", { outcome: "not_needed", note: "Sorted by email." }, { key: "newo-resolution-0005" });
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 0);
});

test("D1 keeps the record append-only and re-checks the open callback, the resolver, the note and the clock", async () => {
  const env = testEnv();
  const owner = await personAuth(env, USERS.owner.id);
  await call(env, owner, "newo-session-failed-1", { outcome: "called_back", note: "Called back." });
  const raw = env.DB.sqlite;
  assert.throws(() => raw.exec("UPDATE newo_handoff_resolutions SET outcome = 'unreachable'"));
  assert.throws(() => raw.exec("DELETE FROM newo_handoff_resolutions"));
  const insert = (
    id: string,
    session: string,
    by: string,
    role: string,
    key: string,
    options: { replace?: boolean; note?: string | null; clock?: "d1" | "worker" } = {},
  ) =>
    raw.prepare(
      `INSERT ${options.replace ? "OR REPLACE " : ""}INTO newo_handoff_resolutions
        (resolution_id, tenant_id, idempotency_key, request_sha256, session_id, outcome, note,
         resolved_by, resolved_by_role, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'not_needed', ?, ?, ?, ${options.clock === "worker" ? "?" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"})`,
    ).run(
      id, TENANT, key, "f".repeat(64), session, options.note === undefined ? "Direct." : options.note, by, role,
      ...(options.clock === "worker" ? [at(-1)] : []),
    );
  assert.throws(() => insert(`nhr_${"1".repeat(32)}`, "newo-session-connected", USERS.owner.id, "owner", "direct-key-0001"), /newo_handoff_resolution_not_open/);
  assert.throws(() => insert(`nhr_${"2".repeat(32)}`, "newo-session-failed-2", USERS.sales.id, "ops", "direct-key-0002"), /actor_invalid/);
  assert.throws(() => insert(`nhr_${"3".repeat(32)}`, "newo-session-failed-1", USERS.ops.id, "ops", "direct-key-0003", { replace: true }), /newo_handoff_already_resolved/);
  // A second resolution is refused as already resolved before any other check, even a bad clock.
  assert.throws(() => insert(`nhr_${"4".repeat(32)}`, "newo-session-failed-1", USERS.ops.id, "ops", "direct-key-0004", { clock: "worker", note: null }), /newo_handoff_already_resolved/);
  assert.throws(() => insert(`nhr_${"5".repeat(32)}`, "newo-session-failed-2", USERS.ops.id, "ops", "direct-key-0005", { note: null }), /newo_handoff_resolution_note_required/);
  assert.throws(() => insert(`nhr_${"6".repeat(32)}`, "newo-session-failed-2", USERS.ops.id, "ops", "direct-key-0006", { clock: "worker" }), /newo_handoff_resolution_clock_invalid/);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 1);
  // The same insert with D1's clock and a note goes in: those were the only reasons for the refusals.
  insert(`nhr_${"7".repeat(32)}`, "newo-session-failed-2", USERS.ops.id, "ops", "direct-key-0007");
  assert.equal(raw.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 2);
});

test("a requested callback is not a failed handoff: it is an open callback a person closes", async () => {
  const env = testEnv();
  requestCallback(env, "newo-session-requested", { urgency: "urgent" });
  assert.equal((await newoOperationalCounts(env as never)).failed_handoffs, 2);
  assert.equal((await newoOperationalCounts(env as never)).open_callbacks, 1);
  const model = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(
    model.exceptions.failed_handoffs.map((session) => session.session_id).sort(),
    ["newo-session-failed-1", "newo-session-failed-2"],
  );
  assert.deepEqual(model.exceptions.open_callbacks.map(({ session_id, urgency }) => [session_id, urgency]), [
    ["newo-session-requested", "urgent"],
  ]);
  assert.equal(model.counts.open_callbacks, 1);
  assert.equal(model.status, "attention");
  // The overview carries no caller identity or content; the resolution read carries what a
  // person needs to call back.
  assert.deepEqual(Object.keys(model.exceptions.open_callbacks[0]!).sort(), [
    "callback_id", "reason", "requested_at", "session_id", "urgency",
  ]);
  assert.equal(model.exceptions.open_callbacks[0]!.reason, "callback_requested");
  const ops = await personAuth(env, USERS.ops.id);
  const read = await call(env, ops, "newo-session-requested");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.callback.contact, {
    name: "Synthetic Caller",
    phone: "+15875550142",
    email: "caller@example.invalid",
    address: { line1: "1 Example Street", city: "Edmonton", province: "AB", postal_code: "T5J 0N3" },
  });
  assert.equal(read.body.callback.reason, "callback_requested");
  assert.equal(read.body.callback.handoff_summary, "Caller asked for a person.");
  assert.equal(read.body.resolution, null);

  const closed = await call(env, ops, "newo-session-requested", { outcome: "called_back", note: "Booked a visit." });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal((await newoOperationalCounts(env as never)).open_callbacks, 0);
  assert.deepEqual((await buildNewoOperationsReadModel(env as never)).exceptions.open_callbacks, []);
});

/** A callback the Worker recorded for a session (0168), with its event receipt. Synthetic caller. */
function requestCallback(
  env: TestEnv,
  sessionId: string,
  options: { urgency?: string; sessionStatus?: string | null; minutesAgo?: number; reason?: string } = {},
) {
  const raw = env.DB.sqlite;
  const minutes = options.minutesAgo ?? 5;
  raw.prepare(
    `INSERT INTO newo_sessions
      (session_id, status, handoff_status, urgency, structured_json, raw_key, payload_hash, created_at, updated_at)
     VALUES (?, 'handoff_requested', ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(sessionId, options.sessionStatus === undefined ? "requested" : options.sessionStatus, options.urgency ?? "routine",
    `raw/newo/${sessionId}`, "d".repeat(64), at(-minutes), at(-minutes));
  raw.prepare(
    `INSERT INTO newo_event_receipts
      (event_id, session_id, event_type, payload_hash, raw_key, status, first_seen_at, last_seen_at)
     VALUES (?, ?, 'handoff_requested', ?, ?, 'accepted', ?, ?)`,
  ).run(`${sessionId}-event`, sessionId, "e".repeat(64), `raw/newo/${sessionId}`, at(-minutes), at(-minutes));
  raw.prepare(
    `INSERT INTO newo_callback_records
      (callback_id, tenant_id, session_id, event_id, reason, urgency, handoff_summary, contact_name,
       contact_phone, contact_email, address_line1, city, province, postal_code)
     VALUES (?, ?, ?, ?, ?, ?, 'Caller asked for a person.', 'Synthetic Caller',
       '+15875550142', 'caller@example.invalid', '1 Example Street', 'Edmonton', 'AB', 'T5J 0N3')`,
  ).run(`ncb_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`, TENANT, sessionId,
    `${sessionId}-event`, options.reason ?? "callback_requested", options.urgency ?? "routine");
}

test("a callback closes with an audit row in the same batch, stamped by D1's clock", async () => {
  const env = testEnv();
  requestCallback(env, "newo-session-requested");
  const owner = await personAuth(env, USERS.owner.id);
  const before = new Date().toISOString();
  const closed = await call(env, owner, "newo-session-requested", { outcome: "unreachable", note: " Rang twice, no answer. " });
  const after = new Date().toISOString();
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.resolution.note, "Rang twice, no answer.");
  assert.ok(closed.body.resolution.resolved_at >= before && closed.body.resolution.resolved_at <= after);
  assert.match(closed.body.resolution.resolved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const audit = env.DB.sqlite.prepare(
    `SELECT ts, automation, trigger, source_ids, target_ids, action, result, approved_by, reason FROM audit_log`,
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(audit, [{
    ts: closed.body.resolution.resolved_at,
    automation: "newo_callback_resolution",
    trigger: "person",
    source_ids: "newo_session:newo-session-requested",
    target_ids: `newo_handoff_resolution:${closed.body.resolution.resolution_id}`,
    action: "resolve_unreachable",
    result: "ok",
    approved_by: USERS.owner.id,
    reason: "owner:callback_requested",
  }]);
  // An exact replay writes nothing more.
  const replay = await call(env, owner, "newo-session-requested", { outcome: "unreachable", note: "Rang twice, no answer." });
  assert.deepEqual(replay, closed);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n, 1);

  // When D1 refuses the resolution, the audit row goes with it: the person left the role between
  // the route's read and the insert.
  requestCallback(env, "newo-session-requested-2");
  const ops = await personAuth(env, USERS.ops.id);
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    env.DB.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.ops.id);
    return await batch(statements);
  };
  const refused = await call(env, ops, "newo-session-requested-2", { outcome: "called_back", note: "Called." }, { key: "newo-resolution-0009" });
  assert.deepEqual([refused.status, refused.body.error], [403, "newo_handoff_resolution_role_required"]);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM newo_handoff_resolutions").get()?.n, 1);
});

test("a callback whose session failed is listed once, as a failed handoff", async () => {
  const env = testEnv();
  requestCallback(env, "newo-session-requested", { sessionStatus: "failed" });
  const counts = await newoOperationalCounts(env as never);
  assert.deepEqual([counts.failed_handoffs, counts.open_callbacks], [3, 0]);
  const model = await buildNewoOperationsReadModel(env as never);
  assert.ok(model.exceptions.failed_handoffs.some((session) => session.session_id === "newo-session-requested"));
  assert.deepEqual(model.exceptions.open_callbacks, []);
});

test("a callback recorded from a late event is open and can be closed though the session row missed it", async () => {
  // The event arrived after a newer one, so the session upsert left handoff_status untouched; the
  // callback record is still written, and it is what holds the callback.
  const env = testEnv();
  requestCallback(env, "newo-session-late", { sessionStatus: null, urgency: "emergency" });
  const model = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(model.exceptions.open_callbacks.map(({ session_id, urgency }) => [session_id, urgency]), [
    ["newo-session-late", "emergency"],
  ]);
  const owner = await personAuth(env, USERS.owner.id);
  const closed = await call(env, owner, "newo-session-late", { outcome: "called_back", note: "Called back." });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal((await newoOperationalCounts(env as never)).open_callbacks, 0);
});

test("open callbacks list the most urgent first, then the longest waiting, for this tenant only", async () => {
  const env = testEnv();
  requestCallback(env, "newo-session-routine-old", { urgency: "routine", minutesAgo: 50 });
  requestCallback(env, "newo-session-urgent-new", { urgency: "urgent", minutesAgo: 5 });
  requestCallback(env, "newo-session-urgent-old", { urgency: "urgent", minutesAgo: 40 });
  // The session's urgency rose after the callback was recorded: the higher one counts.
  requestCallback(env, "newo-session-rose", { urgency: "routine", minutesAgo: 30 });
  env.DB.sqlite.prepare("UPDATE newo_sessions SET urgency = 'emergency' WHERE session_id = 'newo-session-rose'").run();
  // Another tenant's record never shows here.
  env.DB.sqlite.prepare(
    `INSERT INTO newo_callback_records (callback_id, tenant_id, session_id, event_id, reason, urgency)
     VALUES (?, 'other-tenant', 'newo-session-urgent-new', 'newo-session-urgent-new-event', 'callback_requested', 'emergency')`,
  ).run(`ncb_${"0".repeat(32)}`);
  const model = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(model.exceptions.open_callbacks.map(({ session_id, urgency }) => [session_id, urgency]), [
    ["newo-session-rose", "emergency"],
    ["newo-session-urgent-old", "urgent"],
    ["newo-session-urgent-new", "urgent"],
    ["newo-session-routine-old", "routine"],
  ]);
  assert.equal(model.counts.open_callbacks, 4);
});

test("D1 keeps the callback record append-only, stamped by its own clock, for a claimed event", async () => {
  const env = testEnv();
  requestCallback(env, "newo-session-requested");
  const raw = env.DB.sqlite;
  const row = raw.prepare("SELECT recorded_at FROM newo_callback_records").get() as { recorded_at: string };
  assert.match(row.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.throws(() => raw.exec("UPDATE newo_callback_records SET urgency = 'emergency'"), /newo_callback_record_append_only/);
  assert.throws(() => raw.exec("DELETE FROM newo_callback_records"), /newo_callback_record_append_only/);
  const insert = (id: string, options: { replace?: boolean; recordedAt?: string; eventId?: string; tenant?: string } = {}) =>
    raw.prepare(
      `INSERT ${options.replace ? "OR REPLACE " : ""}INTO newo_callback_records
        (callback_id, tenant_id, session_id, event_id, reason, urgency${options.recordedAt ? ", recorded_at" : ""})
       VALUES (?, ?, 'newo-session-requested', ?, 'callback_requested', 'routine'${options.recordedAt ? ", ?" : ""})`,
    ).run(id, options.tenant ?? TENANT, options.eventId ?? "newo-session-requested-event",
      ...(options.recordedAt ? [options.recordedAt] : []));
  assert.throws(() => insert(`ncb_${"1".repeat(32)}`), /newo_callback_record_append_only/);
  assert.throws(() => insert(`ncb_${"1".repeat(32)}`, { replace: true }), /newo_callback_record_append_only/);
  assert.throws(() => insert(`ncb_${"2".repeat(32)}`, { tenant: "other-tenant", recordedAt: at(-1) }), /newo_callback_record_clock_invalid/);
  assert.throws(() => insert(`ncb_${"3".repeat(32)}`, { tenant: "other-tenant", eventId: "unclaimed-event" }), /newo_callback_record_event_invalid/);
  // The reason is one of three, and a failed session's record must name a phone or an email.
  const reasoned = (id: string, reason: string, phone: string | null) => raw.prepare(
    `INSERT INTO newo_callback_records (callback_id, tenant_id, session_id, event_id, reason, urgency, contact_phone)
     VALUES (?, 'other-tenant', 'newo-session-requested', 'newo-session-requested-event', ?, 'routine', ?)`,
  ).run(id, reason, phone);
  assert.throws(() => reasoned(`ncb_${"4".repeat(32)}`, "caller_hung_up", "+15875550142"), /CHECK constraint failed/);
  assert.throws(() => reasoned(`ncb_${"5".repeat(32)}`, "session_failed", null), /CHECK constraint failed/);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM newo_callback_records").get()?.n, 1);
  reasoned(`ncb_${"6".repeat(32)}`, "session_failed", "+15875550142");
  assert.equal(raw.prepare("SELECT count(*) AS n FROM newo_callback_records").get()?.n, 2);
});

test("0168 re-creates the 0151 guards with only the callback, note and clock changes", () => {
  const env = testEnv();
  const normalize = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const triggerSql = (source: string, name: string) => {
    const start = source.indexOf(`CREATE TRIGGER ${name}`);
    assert.notEqual(start, -1, name);
    return normalize(source.slice(start, source.indexOf("END;", start) + "END".length));
  };
  const migration0151 = readFileSync(new URL("../migrations/0151_newo_handoff_resolutions.sql", import.meta.url), "utf8");
  const installed = (name: string) => normalize(String(
    (env.DB.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql,
  ));
  // The no-replace guard is 0151's, unchanged.
  assert.equal(installed("newo_handoff_resolutions_no_insert_replace"), triggerSql(migration0151, "newo_handoff_resolutions_no_insert_replace"));
  // The insert guard is 0151's with the failed-only check widened to an open callback, plus the
  // note and the clock checks; the actor check is unchanged.
  const before = triggerSql(migration0151, "newo_handoff_resolutions_validate_insert");
  const failedOnly = "SELECT RAISE(ABORT, 'newo_handoff_resolution_not_failed') WHERE NOT EXISTS ( SELECT 1 FROM newo_sessions session WHERE session.session_id = NEW.session_id AND session.handoff_status = 'failed' );";
  const open = "SELECT RAISE(ABORT, 'newo_handoff_resolution_not_open') WHERE NOT EXISTS ( SELECT 1 FROM newo_sessions session WHERE session.session_id = NEW.session_id AND session.handoff_status IN ('failed', 'requested') ) AND NOT EXISTS ( SELECT 1 FROM newo_callback_records callback WHERE callback.tenant_id = NEW.tenant_id AND callback.session_id = NEW.session_id );";
  const added = "SELECT RAISE(ABORT, 'newo_handoff_resolution_note_required') WHERE NEW.note IS NULL; SELECT RAISE(ABORT, 'newo_handoff_resolution_clock_invalid') WHERE NEW.resolved_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'); END";
  assert.ok(before.includes(failedOnly), before);
  assert.equal(installed("newo_handoff_resolutions_validate_insert"), before.replace(failedOnly, open).replace(/ END$/, ` ${added}`));
});

test("an open callback alone keeps the operations model in attention", () => {
  const clear = {
    failed_sync: 0, failed_events: 0, missing_reports: 0, failed_handoffs: 0, open_callbacks: 0,
    pending_bookings: 0, control_failures: 0,
  };
  const attention = (counts: typeof clear) =>
    newoOperationsNeedAttention({ counts, dlqItems: 0, unresolvedIncidents: 0, daily: null });
  assert.equal(attention(clear), false);
  assert.equal(attention({ ...clear, open_callbacks: 1 }), true);
  assert.equal(attention({ ...clear, failed_handoffs: 1 }), true);
});

test("a requested callback from before the record existed can still be closed", async () => {
  // A session the Worker marked requested before 0168: no callback record, still a callback owed.
  const env = testEnv();
  env.DB.sqlite.prepare(
    `INSERT INTO newo_sessions
      (session_id, status, handoff_status, structured_json, raw_key, payload_hash, created_at, updated_at)
     VALUES ('newo-session-legacy', 'handoff_requested', 'requested', '{}', 'raw/newo/legacy', ?, ?, ?)`,
  ).run("f".repeat(64), at(-90), at(-90));
  const owner = await personAuth(env, USERS.owner.id);
  const read = await call(env, owner, "newo-session-legacy");
  assert.equal(read.body.callback, null);
  const closed = await call(env, owner, "newo-session-legacy", { outcome: "called_back", note: "Called back." });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
});

test("a failed session's callback, written by the Worker, is open until a person closes it", async () => {
  const env = testEnv();
  const raw = new Map<string, string>();
  const newoEnv = {
    ...env,
    NEWO_ENABLED: "true",
    NEWO_WEBHOOK_TOKEN: "synthetic-newo-webhook-token",
    NEWO_BOOKING_MODE: "request_only",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    FROM_EMAIL: "ops@example.invalid",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    RAW: {
      put: async (key: string, body: string) => { raw.set(key, body); },
      head: async (key: string) => (raw.has(key) ? { key } : null),
    },
    NEWO_QUEUE: { send: async () => {} },
    JN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  };
  // A synthetic failed session: the call dropped before any handoff, and the caller gave a phone.
  const event = {
    schema_version: "newo.event.v1",
    event_id: "event-session-failed-1",
    session_id: "newo-session-dropped",
    event_type: "session_failed",
    occurred_at: at(-3),
    provider: { project_id: null, agent_id: null, user_actor_id: null, conversation_id: null },
    channel: "phone",
    direction: "inbound",
    contact: {
      name: "Synthetic Caller",
      phone: "+1 (587) 555-0142",
      email: null,
      address: { line1: null, city: null, province: null, postal_code: null },
    },
    intent: { service: null, division: null, urgency: "routine", message: null },
    consent: { ai_disclosed: true, recording_disclosed: false, follow_up_email: false, follow_up_phone: true },
    appointment: { request_id: null, preferred_windows: [], timezone: "America/Edmonton" },
    outcome: {
      status: "failed", summary: null, handoff_status: null, booking_status: null, transcript_ref: null,
      recording_ref: null, started_at: null, ended_at: null, duration_seconds: null,
    },
    handoff_summary: null,
  };
  const deliver = async () => (await worker.fetch(
    new Request("https://bus.example.invalid/webhook/newo/report", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-newo-webhook-token", "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
    newoEnv as never,
    { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}) } as never,
  )).status;
  assert.equal(await deliver(), 200);
  assert.equal(await deliver(), 200);
  const records = env.DB.sqlite.prepare(
    "SELECT session_id, event_id, reason, contact_phone FROM newo_callback_records",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(records, [{
    session_id: "newo-session-dropped",
    event_id: "event-session-failed-1",
    reason: "session_failed",
    contact_phone: "+15875550142",
  }]);

  const before = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(before.exceptions.open_callbacks.map(({ session_id, reason }) => [session_id, reason]), [
    ["newo-session-dropped", "session_failed"],
  ]);
  assert.ok(!before.exceptions.failed_handoffs.some((session) => session.session_id === "newo-session-dropped"));
  assert.equal(before.counts.open_callbacks, 1);

  const ops = await personAuth(env, USERS.ops.id);
  const read = await call(env, ops, "newo-session-dropped");
  assert.equal(read.body.callback.reason, "session_failed");
  assert.equal(read.body.callback.contact.phone, "+15875550142");
  const closed = await call(env, ops, "newo-session-dropped", { outcome: "called_back", note: "Reached them; booked a visit." });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const after = await buildNewoOperationsReadModel(env as never);
  assert.deepEqual(after.exceptions.open_callbacks, []);
  assert.equal(after.counts.open_callbacks, 0);
  assert.equal(
    (env.DB.sqlite.prepare("SELECT reason FROM audit_log WHERE automation = 'newo_callback_resolution'").get() as { reason: string }).reason,
    "ops:session_failed",
  );
});
