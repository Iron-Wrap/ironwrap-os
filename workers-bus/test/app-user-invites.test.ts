// app-user-invites.test.ts — the office invitation credential, end to end through the real Worker.
//
// Every case here drives `worker.fetch` against a D1 built from the committed migration chain, so
// the storage CHECKs, the partial unique index, the D1 batch semantics and the real origin / CSRF
// / session stack all participate. The invitation secret is never handed to the test: it is read
// out of `dev_outbox`, which is the same local-development capture the sign-in link uses, so the
// tests exercise the real delivery path rather than a seam around it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import { csrfTokenFor, sessionHashFor } from "../src/app-auth.ts";
import { pruneAuthRecords } from "../src/app-auth-store.ts";
import { userInviteState } from "../src/app-user-invites.ts";
import { seedAppUser } from "./app-user-seed.ts";
import type { AppEnv, AppRole, AppUserRecord } from "../src/app-types.ts";

const TENANT = "ironwrap";
const ORIGIN = "https://app.example.com";
const INVITES = "/api/v1/admin/user-invites";
const APP_USERS = "/api/v1/admin/app-users";
const ACCEPT = "/api/v1/auth/invites/accept";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  private runInterception: {
    matches: (sql: string) => boolean;
    mutate: () => void;
  } | null = null;
  private afterRunInterception: {
    matches: (sql: string) => boolean;
    mutate: () => void | Promise<void>;
  } | null = null;
  private insideBatch = false;
  private deferredAfterBatch: (() => void | Promise<void>) | null = null;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (
      const migration of readdirSync(new URL("../migrations/", import.meta.url))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort()
    ) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...(args as never[])) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...(args as never[])) as T[] }),
          run: async () => {
            const interception = this.runInterception;
            if (interception?.matches(sql)) {
              this.runInterception = null;
              interception.mutate();
            }
            const result = statement.run(...(args as never[]));
            const after = this.afterRunInterception;
            if (after?.matches(sql)) {
              this.afterRunInterception = null;
              if (this.insideBatch) {
                assert.equal(this.deferredAfterBatch, null);
                this.deferredAfterBatch = after.mutate;
              } else {
                await after.mutate();
              }
            }
            return { success: true as const, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  /** D1 batches are transactional and sequential; so is this. */
  async batch(statements: Array<{ run: () => Promise<{ success: true; meta: { changes: number } }> }>) {
    this.raw.exec("BEGIN");
    this.insideBatch = true;
    let results: Array<{ success: true; meta: { changes: number } }>;
    try {
      results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      this.deferredAfterBatch = null;
      throw error;
    } finally {
      this.insideBatch = false;
    }
    const deferred = this.deferredAfterBatch;
    this.deferredAfterBatch = null;
    if (deferred) await deferred();
    return results;
  }

  /** Inject one committed concurrent write immediately before a selected D1 mutation executes. */
  beforeNextMatchingRun(matches: (sql: string) => boolean, mutate: () => void): void {
    assert.equal(this.runInterception, null, "one deterministic write race at a time");
    this.runInterception = { matches, mutate };
  }

  /**
   * Model a concurrent writer that starts after one selected statement. If that statement belongs
   * to a D1 batch, SQLite makes the other writer wait until commit, so the callback waits too.
   */
  afterNextMatchingRun(
    matches: (sql: string) => boolean,
    mutate: () => void | Promise<void>,
  ): void {
    assert.equal(this.afterRunInterception, null, "one deterministic write race at a time");
    this.afterRunInterception = { matches, mutate };
  }
}

interface Harness {
  env: AppEnv;
  db: SqliteD1;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  flush: () => Promise<void>;
}

function harness(): Harness {
  const db = new SqliteD1();
  const pending: Promise<unknown>[] = [];
  const env = {
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: ORIGIN,
    APP_ALLOWED_ORIGINS: ORIGIN,
    // The local-development capture stands in for Gmail, exactly as it does on `deploy/local`.
    // Nothing here reaches a provider; `dev_outbox` is where the hrefs land.
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_FIRST_OWNER_BOOTSTRAP_ENABLED: "false",
    APP_AUTH_PEPPER: "test-only-pepper-which-is-longer-than-thirty-two-characters",
    ADMIN_TOKEN: "admin-token",
    DB: db,
  } as never as AppEnv;
  return {
    env,
    db,
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    flush: async () => {
      await Promise.allSettled(pending.splice(0, pending.length));
    },
  };
}

async function addUser(
  env: AppEnv,
  email: string,
  role: AppRole,
  displayName = email,
): Promise<AppUserRecord> {
  return await seedAppUser(env, {
    tenant_id: TENANT,
    email_normalized: email,
    display_name: displayName,
    role,
    frappe_user_id: role === "field" ? email : null,
    active: true,
    provisioned_by: "seed",
  });
}

/**
 * A real signed-in session: the row the sign-in path would have written, addressed by the same
 * hashed session secret and answering the same CSRF token. Nothing about authority is faked.
 */
async function signIn(
  h: Harness,
  user: AppUserRecord,
  rawToken: string,
): Promise<{ cookie: string; csrf: string }> {
  const now = new Date();
  h.db.raw.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?,?,?,?,?,NULL,?,?,?,NULL)`,
  ).run(
    await sessionHashFor(h.env, rawToken),
    user.user_id,
    user.tenant_id,
    now.toISOString(),
    new Date(now.getTime() + 3_600_000).toISOString(),
    now.toISOString(),
    "a".repeat(64),
    "b".repeat(64),
  );
  return {
    cookie: `__Host-ironwrap_session=${rawToken}`,
    csrf: await csrfTokenFor(h.env, rawToken),
  };
}

interface Session {
  cookie: string;
  csrf: string;
}

/** The access version a person carries now, as the office list would have shown it. */
function accessVersionOf(h: Harness, userId: string): number {
  const row = h.db.raw.prepare(
    "SELECT access_version FROM app_users WHERE tenant_id = ? AND user_id = ?",
  ).get(TENANT, userId) as { access_version: number } | undefined;
  return Number(row?.access_version ?? 1);
}

const ACCESS_CHANGE_PATH = /^\/api\/v1\/admin\/app-users\/([^/]+)\/(role|access)$/;

async function call(
  h: Harness,
  method: "GET" | "POST",
  path: string,
  options: { session?: Session; body?: unknown; csrf?: boolean; rawBody?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // A role or access change names the version it was decided on (0157). Cases about something
  // else send the current one, as the people list does; `rawBody` sends the body exactly.
  const accessChange = path.match(ACCESS_CHANGE_PATH);
  if (
    accessChange && !options.rawBody && options.body && typeof options.body === "object" &&
    !("expected_access_version" in options.body)
  ) {
    options = {
      ...options,
      body: { ...options.body, expected_access_version: accessVersionOf(h, decodeURIComponent(accessChange[1]!)) },
    };
  }
  if (
    method === "POST" && path === APP_USERS && !options.rawBody && options.body &&
    typeof options.body === "object" && !("expected_access_version" in options.body)
  ) {
    const email = String((options.body as Record<string, unknown>).email ?? "").toLowerCase();
    const existing = h.db.raw.prepare(
      "SELECT access_version FROM app_users WHERE tenant_id = ? AND email_normalized = ?",
    ).get(TENANT, email) as { access_version: number } | undefined;
    if (existing) {
      options = { ...options, body: { ...options.body, expected_access_version: existing.access_version } };
    }
  }
  const headers = new Headers({ origin: ORIGIN });
  if (options.session) {
    headers.set("cookie", options.session.cookie);
    if (options.csrf !== false) headers.set("x-csrf-token", options.session.csrf);
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await worker.fetch(
    new Request(`https://worker.example.com${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    h.env as never,
    h.ctx as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The invitation secret, read where a local operator reads it: out of the captured href. */
function capturedToken(h: Harness, kind: string, recipient: string): string {
  const row = h.db.raw.prepare(
    `SELECT href FROM dev_outbox WHERE kind = ? AND recipient = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(kind, recipient) as { href: string } | undefined;
  assert.ok(row, `no ${kind} captured for ${recipient}`);
  const token = new URL(row.href).hash.replace(/^#token=/, "");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  return decodeURIComponent(token);
}

function captureCount(h: Harness, kind: string, recipient: string): number {
  const row = h.db.raw.prepare(
    `SELECT COUNT(*) AS captures FROM dev_outbox WHERE kind = ? AND recipient = ?`,
  ).get(kind, recipient) as { captures: number };
  return Number(row.captures);
}

function inviteRow(h: Harness, inviteId: string): Record<string, unknown> {
  return h.db.raw.prepare(
    `SELECT * FROM app_user_invites WHERE invite_id = ?`,
  ).get(inviteId) as Record<string, unknown>;
}

function userRow(h: Harness, email: string): Record<string, unknown> | undefined {
  return h.db.raw.prepare(
    `SELECT user_id, display_name, role, access_role, active FROM app_users
      WHERE tenant_id = ? AND email_normalized = ?`,
  ).get(TENANT, email) as Record<string, unknown> | undefined;
}

function scalar(h: Harness, sql: string, ...args: unknown[]): number {
  const row = h.db.raw.prepare(sql).get(...(args as never[])) as { value: number };
  return Number(row.value);
}

/** Age one invitation past its window, the way a week of wall clock would. */
function expireInvite(h: Harness, inviteId: string): void {
  h.db.raw.prepare(
    `UPDATE app_user_invites
        SET created_at = ?, last_sent_at = ?, expires_at = ?
      WHERE invite_id = ?`,
  ).run(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-08T00:00:00.000Z",
    inviteId,
  );
}

async function owner(h: Harness): Promise<{ user: AppUserRecord; session: Session }> {
  const user = await addUser(h.env, "owner@example.invalid", "owner", "Ada Owner");
  return { user, session: await signIn(h, user, "o".repeat(43)) };
}

async function invite(
  h: Harness,
  session: Session,
  body: { email: string; display_name: string; role: AppRole },
): Promise<{ status: number; body: Record<string, unknown>; invite: Record<string, unknown> }> {
  const result = await call(h, "POST", INVITES, { session, body });
  await h.flush();
  return {
    ...result,
    invite: (result.body.invite ?? {}) as Record<string, unknown>,
  };
}

// --------------------------------------------------------------------------- the happy path

test("an owner invites a teammate, who accepts and lands on the ordinary sign-in path", async () => {
  const h = harness();
  const { session } = await owner(h);

  const issued = await invite(h, session, {
    email: "Sam.Sales@Example.invalid",
    display_name: "Sam Sales",
    role: "sales",
  });
  assert.equal(issued.status, 201);
  assert.equal(issued.invite.email, "sam.sales@example.invalid", "the mailbox is normalized once");
  assert.equal(issued.invite.role, "sales");
  assert.equal(issued.invite.state, "pending");
  assert.equal(issued.invite.resend_count, 0);
  assert.ok(!("token" in issued.invite), "the projection never carries the secret");
  assert.ok(!("token_hash" in issued.invite), "nor its hash");

  // Nobody has access yet: an invitation is a credential, not a grant.
  assert.equal(userRow(h, "sam.sales@example.invalid"), undefined);

  const token = capturedToken(h, "user_invite", "sam.sales@example.invalid");
  const stored = inviteRow(h, String(issued.invite.invite_id));
  assert.notEqual(stored.token_hash, token, "only the hash is persisted");
  assert.match(String(stored.token_hash), /^[0-9a-f]{64}$/);

  const accepted = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.result, "accepted");
  assert.equal(accepted.body.role, "sales");
  assert.equal(accepted.body.next, "magic_link");
  assert.equal(accepted.body.sign_in_link_sent, true);

  const user = userRow(h, "sam.sales@example.invalid")!;
  assert.equal(user.access_role, "sales", "exactly the invited role");
  assert.equal(user.active, 1);
  assert.equal(user.display_name, "Sam Sales");

  // The sign-in credential Sam now holds is the product's ordinary magic link — not something
  // this capability minted for itself.
  assert.equal(captureCount(h, "magic_link", "sam.sales@example.invalid"), 1);
  const settled = inviteRow(h, String(issued.invite.invite_id));
  assert.equal(settled.accepted_user_id, user.user_id);
  assert.ok(settled.accepted_at);
});

test("inviting crew grants the account and says the phone still needs pairing", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "kim@example.invalid",
    display_name: "Kim Crew",
    role: "field",
  });
  const accepted = await call(h, "POST", ACCEPT, {
    body: { token: capturedToken(h, "user_invite", "kim@example.invalid") },
  });
  await h.flush();

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.role, "field");
  assert.equal(accepted.body.next, "device_pairing");
  assert.equal(accepted.body.sign_in_link_sent, false);
  assert.equal(
    captureCount(h, "magic_link", "kim@example.invalid"),
    0,
    "crew never receive a passwordless email session",
  );
  assert.equal(userRow(h, "kim@example.invalid")!.access_role, "field");
  assert.equal(inviteRow(h, String(issued.invite.invite_id)).accepted_at !== null, true);
});

// --------------------------------------------------------------------------- privacy

test("an invitation response never reveals whether the mailbox already has access", async () => {
  const h = harness();
  const { session } = await owner(h);
  await addUser(h.env, "already@example.invalid", "ops", "Already Here");
  const deactivated = await addUser(h.env, "gone@example.invalid", "sales", "Used To Work Here");
  h.db.raw.prepare(`UPDATE app_users SET active = 0 WHERE user_id = ?`)
    .run(deactivated.user_id);

  const results = [];
  for (const email of ["already@example.invalid", "gone@example.invalid", "new@example.invalid"]) {
    const issued = await invite(h, session, {
      email,
      display_name: "Candidate",
      role: "sales",
    });
    results.push(issued);
  }

  const shapes = results.map((result) => ({
    status: result.status,
    keys: Object.keys(result.invite).sort(),
    state: result.invite.state,
    role: result.invite.role,
    resend_count: result.invite.resend_count,
  }));
  for (const shape of shapes) {
    assert.deepEqual(
      shape,
      { ...shapes[0], },
      "issuing must not differ by whether the mailbox already has an account",
    );
  }
  // And the only difference between the three responses is the mailbox the caller typed and the
  // ids/timestamps the issuance itself created.
  const varying = new Set(["invite_id", "email", "invited_at", "expires_at", "last_sent_at"]);
  for (const result of results.slice(1)) {
    for (const [key, value] of Object.entries(result.invite)) {
      if (varying.has(key)) continue;
      assert.deepEqual(value, results[0].invite[key], `field ${key} leaked account existence`);
    }
  }
});

// --------------------------------------------------------------------------- refusals

test("only an office session may touch invitations, and only with a CSRF token", async () => {
  const h = harness();
  const { session: ownerSession } = await owner(h);

  for (const role of ["sales", "production", "accounting"] as const) {
    const user = await addUser(h.env, `${role}@example.invalid`, role, role);
    const session = await signIn(h, user, role.padEnd(43, "x"));
    const list = await call(h, "GET", INVITES, { session });
    assert.equal(list.status, 403, `${role} must not read invitations`);
    assert.equal(list.body.error, "office_role_required");
    const created = await call(h, "POST", INVITES, {
      session,
      body: { email: "x@example.invalid", display_name: "X", role: "sales" },
    });
    assert.equal(created.status, 403, `${role} must not issue invitations`);
    assert.equal(created.body.error, "office_role_required");
  }

  const crew = await addUser(h.env, "crew@example.invalid", "field", "Crew");
  const crewSession = await signIn(h, crew, "c".repeat(43));
  // A field session additionally has no device proof here, so it is not even authenticated.
  const crewList = await call(h, "GET", INVITES, { session: crewSession });
  assert.equal(crewList.status, 401);

  const noCsrf = await call(h, "POST", INVITES, {
    session: ownerSession,
    csrf: false,
    body: { email: "x@example.invalid", display_name: "X", role: "sales" },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "csrf_failed");

  const anonymous = await call(h, "GET", INVITES);
  assert.equal(anonymous.status, 401);
});

test("an operations account can invite the desks but never mint an owner", async () => {
  const h = harness();
  await owner(h);
  const ops = await addUser(h.env, "ops@example.invalid", "ops", "Ops");
  const session = await signIn(h, ops, "p".repeat(43));

  const refused = await call(h, "POST", INVITES, {
    session,
    body: { email: "second.owner@example.invalid", display_name: "Second Owner", role: "owner" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "owner_role_required");
  assert.equal(
    scalar(h, `SELECT COUNT(*) AS value FROM app_user_invites`),
    0,
    "a refused issuance writes nothing",
  );

  const allowed = await invite(h, session, {
    email: "desk@example.invalid",
    display_name: "Desk",
    role: "production",
  });
  assert.equal(allowed.status, 201);
});

test("an expired invitation is refused with its own code and grants nothing", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "late@example.invalid",
    display_name: "Late Riser",
    role: "sales",
  });
  const token = capturedToken(h, "user_invite", "late@example.invalid");
  expireInvite(h, String(issued.invite.invite_id));

  const accepted = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(accepted.status, 410);
  assert.equal(accepted.body.error, "invite_expired");
  assert.equal(userRow(h, "late@example.invalid"), undefined);

  const listed = await call(h, "GET", INVITES, { session });
  const rows = listed.body.invites as Array<Record<string, unknown>>;
  assert.equal(rows[0].state, "expired");
});

test("a revoked invitation is refused with its own code and grants nothing", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "revoked@example.invalid",
    display_name: "Changed Our Mind",
    role: "ops",
  });
  const token = capturedToken(h, "user_invite", "revoked@example.invalid");

  const revoked = await call(
    h,
    "POST",
    `${INVITES}/${String(issued.invite.invite_id)}/revoke`,
    { session },
  );
  assert.equal(revoked.status, 200);
  assert.equal((revoked.body.invite as Record<string, unknown>).state, "revoked");
  assert.equal((revoked.body.invite as Record<string, unknown>).revoked_reason, "office_revoked");

  const accepted = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.error, "invite_revoked");
  assert.equal(userRow(h, "revoked@example.invalid"), undefined);

  const again = await call(
    h,
    "POST",
    `${INVITES}/${String(issued.invite.invite_id)}/revoke`,
    { session },
  );
  assert.equal(again.status, 409, "revoking twice is not a second withdrawal");
  assert.equal(again.body.error, "invite_revoked");
});

test("a replayed acceptance changes nothing and says why", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "replay@example.invalid",
    display_name: "Replay Target",
    role: "sales",
  });
  const token = capturedToken(h, "user_invite", "replay@example.invalid");

  const first = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(first.status, 200);
  const granted = userRow(h, "replay@example.invalid")!;

  // The office demotes them afterwards. A stolen invitation must not undo that.
  const changed = await call(h, "POST", `${APP_USERS}/${String(granted.user_id)}/role`, {
    session,
    body: { role: "production" },
  });
  assert.equal(changed.status, 200);

  const replay = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, "invite_already_accepted");
  const after = userRow(h, "replay@example.invalid")!;
  assert.equal(after.access_role, "production", "a replay cannot re-grade the account");
  assert.equal(after.user_id, granted.user_id, "and cannot create a second account");
  assert.equal(
    scalar(h, `SELECT COUNT(*) AS value FROM app_users WHERE tenant_id = ?`, TENANT),
    2,
    "one owner plus one invitee, however many times the link is replayed",
  );
});

test("an invitation minted for another tenant is answered exactly like one that never existed", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "elsewhere@example.invalid",
    display_name: "Elsewhere",
    role: "sales",
  });
  const token = capturedToken(h, "user_invite", "elsewhere@example.invalid");
  assert.equal(inviteRow(h, String(issued.invite.invite_id)).tenant_id, TENANT);
  // The invitation outlives the deployment's configured tenant. Cross-tenant existence is not
  // this endpoint's to confirm, so the answer is the unknown-token answer, verbatim.
  const elsewhere: Harness = { ...h, env: { ...h.env, APP_TENANT_ID: "otherco" } as AppEnv };

  const mismatched = await call(elsewhere, "POST", ACCEPT, { body: { token } });
  await h.flush();
  const unknown = await call(elsewhere, "POST", ACCEPT, { body: { token: "z".repeat(43) } });
  await h.flush();

  assert.equal(mismatched.status, 404);
  assert.deepEqual(mismatched.body, unknown.body);
  assert.equal(mismatched.body.error, "invite_not_found");
  assert.equal(userRow(h, "elsewhere@example.invalid"), undefined);
});

test("a malformed acceptance is refused before anything is looked up", async () => {
  const h = harness();
  const short = await call(h, "POST", ACCEPT, { body: { token: "too-short" } });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, "invalid_request");
  const extra = await call(h, "POST", ACCEPT, {
    body: { token: "z".repeat(43), role: "owner" },
  });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error, "unexpected_field");
});

// --------------------------------------------------------------------------- re-issue

test("re-sending rotates the secret, and the superseded one stops working", async () => {
  const h = harness();
  const { session } = await owner(h);
  const issued = await invite(h, session, {
    email: "resend@example.invalid",
    display_name: "Resend Me",
    role: "ops",
  });
  const first = capturedToken(h, "user_invite", "resend@example.invalid");

  const resent = await call(
    h,
    "POST",
    `${INVITES}/${String(issued.invite.invite_id)}/resend`,
    { session },
  );
  await h.flush();
  assert.equal(resent.status, 200);
  assert.equal((resent.body.invite as Record<string, unknown>).resend_count, 1);
  assert.equal(
    (resent.body.invite as Record<string, unknown>).invite_id,
    issued.invite.invite_id,
    "re-sending keeps one invitation, it does not create a second",
  );
  const second = capturedToken(h, "user_invite", "resend@example.invalid");
  assert.notEqual(first, second);

  const stale = await call(h, "POST", ACCEPT, { body: { token: first } });
  await h.flush();
  assert.equal(stale.status, 404, "the superseded secret is not a key any more");
  assert.equal(userRow(h, "resend@example.invalid"), undefined);

  const fresh = await call(h, "POST", ACCEPT, { body: { token: second } });
  await h.flush();
  assert.equal(fresh.status, 200);
  assert.equal(userRow(h, "resend@example.invalid")!.access_role, "ops");
});

test("an expired invitation is re-sendable; a settled one is not", async () => {
  const h = harness();
  const { session } = await owner(h);
  const lapsed = await invite(h, session, {
    email: "lapsed@example.invalid",
    display_name: "Lapsed",
    role: "sales",
  });
  expireInvite(h, String(lapsed.invite.invite_id));
  const revived = await call(
    h,
    "POST",
    `${INVITES}/${String(lapsed.invite.invite_id)}/resend`,
    { session },
  );
  await h.flush();
  assert.equal(revived.status, 200);
  assert.equal((revived.body.invite as Record<string, unknown>).state, "pending");

  const settled = await invite(h, session, {
    email: "settled@example.invalid",
    display_name: "Settled",
    role: "sales",
  });
  await call(h, "POST", ACCEPT, {
    body: { token: capturedToken(h, "user_invite", "settled@example.invalid") },
  });
  await h.flush();
  const refused = await call(
    h,
    "POST",
    `${INVITES}/${String(settled.invite.invite_id)}/resend`,
    { session },
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "invite_already_accepted");
});

test("issuing a second invitation supersedes the first, leaving exactly one live secret", async () => {
  const h = harness();
  const { session } = await owner(h);
  const first = await invite(h, session, {
    email: "twice@example.invalid",
    display_name: "First Try",
    role: "sales",
  });
  const firstToken = capturedToken(h, "user_invite", "twice@example.invalid");
  const second = await invite(h, session, {
    email: "twice@example.invalid",
    display_name: "Second Try",
    role: "production",
  });
  const secondToken = capturedToken(h, "user_invite", "twice@example.invalid");
  assert.notEqual(first.invite.invite_id, second.invite.invite_id);

  const superseded = inviteRow(h, String(first.invite.invite_id));
  assert.equal(superseded.revoked_reason, "superseded");
  assert.equal(
    userInviteState(superseded as never, new Date().toISOString()),
    "revoked",
  );

  const stale = await call(h, "POST", ACCEPT, { body: { token: firstToken } });
  await h.flush();
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "invite_revoked");

  const fresh = await call(h, "POST", ACCEPT, { body: { token: secondToken } });
  await h.flush();
  assert.equal(fresh.status, 200);
  assert.equal(userRow(h, "twice@example.invalid")!.access_role, "production");
});

test("accepting into a mailbox that already has live access spends the invitation and re-grades nothing", async () => {
  const h = harness();
  const { session } = await owner(h);
  const existing = await addUser(h.env, "steady@example.invalid", "accounting", "Steady Hand");

  const issued = await invite(h, session, {
    email: "steady@example.invalid",
    display_name: "Steady Hand",
    role: "owner",
  });
  const accepted = await call(h, "POST", ACCEPT, {
    body: { token: capturedToken(h, "user_invite", "steady@example.invalid") },
  });
  await h.flush();

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.result, "already_active");
  assert.equal(accepted.body.role, "accounting", "the account keeps the role the office set");
  const after = userRow(h, "steady@example.invalid")!;
  assert.equal(after.access_role, "accounting");
  assert.equal(after.user_id, existing.user_id);
  assert.equal(
    inviteRow(h, String(issued.invite.invite_id)).accepted_user_id,
    existing.user_id,
    "the secret is still spent",
  );
});

// --------------------------------------------------------------------------- people

test("the people list is office-only and marks the caller", async () => {
  const h = harness();
  const { user, session } = await owner(h);
  await addUser(h.env, "mate@example.invalid", "sales", "Mate");

  const listed = await call(h, "GET", APP_USERS, { session });
  assert.equal(listed.status, 200);
  const users = listed.body.users as Array<Record<string, unknown>>;
  assert.equal(users.length, 2);
  assert.equal(users.find((row) => row.user_id === user.user_id)!.is_self, true);
  assert.equal(users.find((row) => row.email === "mate@example.invalid")!.is_self, false);

  const sales = await addUser(h.env, "nosy@example.invalid", "sales", "Nosy");
  const nosy = await signIn(h, sales, "n".repeat(43));
  const refused = await call(h, "GET", APP_USERS, { session: nosy });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "office_role_required");
});

test("a role change closes the AI team's open role-change drafts for that person, and a repeat closes what a failed close left", async () => {
  const h = harness();
  const { user: ownerUser, session } = await owner(h);
  const priya = await addUser(h.env, "priya@example.invalid", "ops", "Priya Nand");
  const priyaSession = await signIn(h, priya, "p".repeat(43));
  const mate = await addUser(h.env, "mate@example.invalid", "sales", "Mate");
  // A synthetic prepared draft, as access.prepare_change leaves it in the owner's Needs you, decided
  // on the access version it names.
  const draft = (stepId: string, change: string, targetRole: string | null, deviceRef: string | null, version: number) => {
    h.db.raw.exec("PRAGMA foreign_keys = OFF");
    h.db.raw
      .prepare(
        `INSERT INTO agent_run_steps (step_id, tenant_id, run_id, step_seq, step_key, specialist_id, action_id, autonomy, args_json, args_sha256,
          sources_json, policy_json, permit_json, outcome, needs_ask, undo_json, do_it_myself_json, created_at, decided_at)
        VALUES (?, ?, ?, 1, 'k', 'orchestrator', 'access.prepare_change', 'A1', ?, 'synthetic', '[]', '{"result":"allow","reason_codes":[]}',
          '{"approved_by":null}', 'succeeded', 'apply_in_own_screen', '{}', '{"context":{}}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        stepId,
        TENANT,
        `run_${stepId}`,
        JSON.stringify({ person_ref: `person:${mate.user_id}`, change, target_role: targetRole, device_ref: deviceRef, expected_access_version: version }),
      );
    h.db.raw.exec("PRAGMA foreign_keys = ON");
  };
  const closed = (stepId: string) =>
    h.db.raw.prepare("SELECT reason_code, do_it_myself_json FROM agent_run_steps WHERE step_id = ?").get(stepId) as { reason_code: string | null; do_it_myself_json: string };
  const audits = () =>
    (h.db.raw.prepare("SELECT user_id, outcome, detail_code FROM app_auth_audit WHERE event = 'agent_draft_close' ORDER BY id").all() as Array<Record<string, string>>).map((row) => ({ ...row }));
  const role = (body: Record<string, unknown>, as = session) => call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, { session: as, body });
  draft("step_role", "change_role", "field", null, 1);
  draft("step_device", "revoke_device", null, "device:synthetic", 1);

  // Refusals close nothing: ownership is an owner's to hand out (403), and a change decided on a
  // version that is not the person's is a conflict (409).
  assert.equal((await role({ role: "owner", expected_access_version: 1 }, priyaSession)).status, 403);
  assert.equal((await role({ role: "production", expected_access_version: 9 })).status, 409);
  assert.equal(closed("step_role").reason_code, null);

  const changed = await role({ role: "production", expected_access_version: 1 });
  assert.equal(changed.status, 200);
  const version = Number((changed.body.user as Record<string, unknown>).access_version);
  assert.equal(version, 2);
  assert.deepEqual(
    [closed("step_role").reason_code, JSON.parse(closed("step_role").do_it_myself_json).context.applied],
    ["applied_by_person", { field: "role", value: "production", by: ownerUser.user_id }],
  );
  assert.equal(closed("step_device").reason_code, null, "a device draft stays open");
  // Each close that closed a draft is audited, naming the role and who set it.
  assert.deepEqual(audits(), [{ user_id: mate.user_id, outcome: "closed", detail_code: `production:${ownerUser.user_id}` }]);

  // Drafts on the old version left open after the change (a close that failed) close on a repeat of
  // the same role at the version now; a draft written after the change stays.
  draft("step_left", "change_role", "field", null, 1);
  draft("step_after", "change_role", "field", null, version);
  const repeat = await role({ role: "production", expected_access_version: version });
  assert.equal(repeat.status, 200);
  assert.equal(closed("step_left").reason_code, "applied_by_person");
  assert.equal(closed("step_after").reason_code, null, "a draft decided on the version now stays open");
  assert.equal(audits().length, 2);

  // A verbatim repeat names the old version and is refused, but this viewer's own change set the
  // role it asks for, so it still closes what was left on the old version.
  draft("step_left_again", "change_role", "field", null, 1);
  const verbatim = await role({ role: "production", expected_access_version: 1 });
  assert.equal(verbatim.status, 409);
  assert.equal(verbatim.body.error, "access_version_conflict");
  assert.equal(accessVersionOf(h, mate.user_id), version, "the refused repeat changes nothing");
  assert.equal(closed("step_left_again").reason_code, "applied_by_person");
  assert.equal(closed("step_after").reason_code, null);
  assert.equal(audits().length, 3);
  // A repeat with nothing older open closes nothing and leaves no audit row.
  assert.equal((await role({ role: "production", expected_access_version: version })).status, 200);
  assert.equal(closed("step_after").reason_code, null);
  assert.equal(audits().length, 3);
  // A stale change to another role, or a conflict someone else's change caused, closes nothing.
  draft("step_kept", "change_role", "field", null, 1);
  assert.equal((await role({ role: "accounting", expected_access_version: 1 })).status, 409);
  assert.equal((await role({ role: "production", expected_access_version: 1 }, priyaSession)).status, 409);
  assert.equal(closed("step_kept").reason_code, null);
  assert.equal(audits().length, 3);

  // Provisioning refused on a stale version closes nothing either.
  const staleProvision = await call(h, "POST", APP_USERS, {
    session,
    body: { tenant_id: TENANT, email: "mate@example.invalid", display_name: "Mate", role: "production", frappe_user_id: "mate@example.invalid", active: true, expected_access_version: 1 },
  });
  assert.equal(staleProvision.status, 409);
  assert.equal(staleProvision.body.error, "access_version_conflict");
  assert.equal(closed("step_kept").reason_code, null);
  assert.equal(audits().length, 3);

  // Provisioning that re-grades an existing person closes their role-change drafts on any version
  // older than the one it produced, in one audited close.
  draft("step_provisioned", "change_role", "field", null, version);
  const provisioned = await call(h, "POST", APP_USERS, {
    session,
    body: { tenant_id: TENANT, email: "mate@example.invalid", display_name: "Mate", role: "sales", frappe_user_id: "mate@example.invalid", active: true, expected_access_version: version },
  });
  assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  assert.deepEqual(
    [
      closed("step_provisioned").reason_code,
      JSON.parse(closed("step_provisioned").do_it_myself_json).context.applied.value,
      closed("step_kept").reason_code,
      closed("step_after").reason_code,
      audits().length,
    ],
    ["applied_by_person", "sales", "applied_by_person", "applied_by_person", 4],
  );
});

test("a role change that loses its write to a concurrent change closes no draft", async () => {
  const h = harness();
  const { session } = await owner(h);
  const mate = await addUser(h.env, "mate@example.invalid", "sales", "Mate");
  h.db.raw.exec("PRAGMA foreign_keys = OFF");
  h.db.raw
    .prepare(
      `INSERT INTO agent_run_steps (step_id, tenant_id, run_id, step_seq, step_key, specialist_id, action_id, autonomy, args_json, args_sha256,
        sources_json, policy_json, permit_json, outcome, needs_ask, undo_json, do_it_myself_json, created_at, decided_at)
      VALUES ('step_raced', ?, 'run_step_raced', 1, 'k', 'orchestrator', 'access.prepare_change', 'A1', ?, 'synthetic', '[]', '{"result":"allow","reason_codes":[]}',
        '{"approved_by":null}', 'succeeded', 'apply_in_own_screen', '{}', '{"context":{}}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(TENANT, JSON.stringify({ person_ref: `person:${mate.user_id}`, change: "change_role", target_role: "field", device_ref: null, expected_access_version: 1 }));
  h.db.raw.exec("PRAGMA foreign_keys = ON");
  // Between the version check and the write, another writer moves the person to the same role.
  let raced = false;
  h.db.beforeNextMatchingRun(
    (sql) => sql.includes("UPDATE app_users") && sql.includes("access_version = access_version + 1") && sql.includes("SET access_role"),
    () => {
      raced = true;
      h.db.raw.prepare(
        `UPDATE app_users SET access_role = 'production', access_version = access_version + 1, updated_at = ?
          WHERE tenant_id = ? AND user_id = ?`,
      ).run("2026-08-24T12:02:00.000Z", TENANT, mate.user_id);
    },
  );

  const refused = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "production", expected_access_version: 1 },
  });
  assert.equal(raced, true, "the concurrent writer reached the write boundary");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "access_version_conflict");
  const step = h.db.raw.prepare("SELECT reason_code FROM agent_run_steps WHERE step_id = 'step_raced'").get() as { reason_code: string | null };
  assert.equal(step.reason_code, null, "a refused write closes nothing, even when the role now matches");
  assert.equal(
    scalar(h, "SELECT COUNT(*) AS value FROM app_auth_audit WHERE event = 'agent_draft_close'"),
    0,
  );
});

test("a role change is the server's decision, not the browser's", async () => {
  const h = harness();
  const { user: ownerUser, session } = await owner(h);
  const mate = await addUser(h.env, "mate@example.invalid", "sales", "Mate");

  const promoted = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "production" },
  });
  assert.equal(promoted.status, 200);
  assert.equal((promoted.body.user as Record<string, unknown>).role, "production");
  assert.equal(userRow(h, "mate@example.invalid")!.access_role, "production");

  const self = await call(h, "POST", `${APP_USERS}/${ownerUser.user_id}/role`, {
    session,
    body: { role: "sales" },
  });
  assert.equal(self.status, 409);
  assert.equal(self.body.error, "self_change_forbidden");

  const ops = await addUser(h.env, "ops@example.invalid", "ops", "Ops");
  const opsSession = await signIn(h, ops, "p".repeat(43));
  const promoteToOwner = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session: opsSession,
    body: { role: "owner" },
  });
  assert.equal(promoteToOwner.status, 403, "operations does not hand out ownership");
  assert.equal(promoteToOwner.body.error, "owner_role_required");
  const selfPromote = await call(h, "POST", `${APP_USERS}/${ops.user_id}/role`, {
    session: opsSession,
    body: { role: "owner" },
  });
  assert.equal(selfPromote.status, 409, "and cannot re-grade itself at all");
  assert.equal(selfPromote.body.error, "self_change_forbidden");
  assert.equal(userRow(h, "ops@example.invalid")!.access_role, "ops");

  const unknown = await call(h, "POST", `${APP_USERS}/appu_${"0".repeat(8)}/role`, {
    session,
    body: { role: "sales" },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "user_not_found");
  const bogus = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "superuser" },
  });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error, "invalid_role");
  const extra = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "sales", active: true },
  });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error, "unexpected_field");
});

test("a tenant cannot be locked out of itself", async () => {
  const h = harness();
  const { user: founder, session } = await owner(h);
  const spare = await addUser(h.env, "spare@example.invalid", "ops", "Spare");
  const spareSession = await signIn(h, spare, "s".repeat(43));

  // The two rules that make the invariant structural, both from the same office session.
  const selfDemote = await call(h, "POST", `${APP_USERS}/${founder.user_id}/role`, {
    session,
    body: { role: "sales" },
  });
  assert.equal(selfDemote.status, 409);
  assert.equal(selfDemote.body.error, "self_change_forbidden");
  const selfRemove = await call(h, "POST", `${APP_USERS}/${founder.user_id}/access`, {
    session,
    body: { active: false },
  });
  assert.equal(selfRemove.status, 409);
  assert.equal(selfRemove.body.error, "self_change_forbidden");

  for (const path of ["role", "access"]) {
    const attempt = await call(h, "POST", `${APP_USERS}/${founder.user_id}/${path}`, {
      session: spareSession,
      body: path === "role" ? { role: "sales" } : { active: false },
    });
    assert.equal(attempt.status, 403, `operations must not ${path}-change an owner`);
    assert.equal(attempt.body.error, "owner_role_required");
  }
  assert.equal(userRow(h, "owner@example.invalid")!.access_role, "owner");
  assert.equal(userRow(h, "owner@example.invalid")!.active, 1);

  // A second owner may be demoted by the first, because the first is still one.
  const deputy = await addUser(h.env, "deputy@example.invalid", "owner", "Deputy");
  const demoted = await call(h, "POST", `${APP_USERS}/${deputy.user_id}/role`, {
    session,
    body: { role: "ops" },
  });
  assert.equal(demoted.status, 200);
  assert.equal(
    scalar(
      h,
      `SELECT COUNT(*) AS value FROM app_users
        WHERE tenant_id = ? AND active = 1 AND access_role = 'owner'`,
      TENANT,
    ),
    1,
    "an owner always remains",
  );
});

test("removing access ends the session, the sign-in link, the paired device, and the invitation", async () => {
  const h = harness();
  const { session } = await owner(h);
  const mate = await addUser(h.env, "mate@example.invalid", "ops", "Mate");
  const mateSession = await signIn(h, mate, "m".repeat(43));
  h.db.raw.prepare(
    `INSERT INTO app_magic_links
       (token_hash, user_id, tenant_id, created_at, expires_at, consumed_at,
        request_ip_hash, request_user_agent_hash)
     VALUES (?,?,?,?,?,NULL,?,?)`,
  ).run(
    "f".repeat(64),
    mate.user_id,
    TENANT,
    "2026-08-23T00:00:00.000Z",
    "2030-01-01T00:00:00.000Z",
    "a".repeat(64),
    "b".repeat(64),
  );
  h.db.raw.prepare(
    `INSERT INTO app_devices
       (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
        revoked_at, revoked_by_user_id, created_ip_hash, created_user_agent_hash)
     VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
  ).run(
    "appd_mate_device_0001",
    TENANT,
    mate.user_id,
    "e".repeat(64),
    "2026-08-23T00:00:00.000Z",
    "2026-08-23T00:00:00.000Z",
    "a".repeat(64),
    "b".repeat(64),
  );
  const pending = await invite(h, session, {
    email: "mate@example.invalid",
    display_name: "Mate",
    role: "ops",
  });

  const alive = await call(h, "GET", "/api/v1/session", { session: mateSession });
  assert.equal(alive.body.authenticated, true);

  const removed = await call(h, "POST", `${APP_USERS}/${mate.user_id}/access`, {
    session,
    body: { active: false },
  });
  assert.equal(removed.status, 200);
  assert.equal((removed.body.user as Record<string, unknown>).active, false);

  const dead = await call(h, "GET", "/api/v1/session", { session: mateSession });
  assert.equal(dead.body.authenticated, false, "the live session ends with the decision");
  assert.equal(
    scalar(
      h,
      `SELECT COUNT(*) AS value FROM app_magic_links
        WHERE user_id = ? AND consumed_at IS NOT NULL`,
      mate.user_id,
    ),
    1,
  );
  assert.equal(
    scalar(
      h,
      `SELECT COUNT(*) AS value FROM app_devices WHERE user_id = ? AND revoked_at IS NOT NULL`,
      mate.user_id,
    ),
    1,
  );
  assert.equal(
    inviteRow(h, String(pending.invite.invite_id)).revoked_reason,
    "office_revoked",
    "and the way back in is withdrawn with it",
  );

  const restored = await call(h, "POST", `${APP_USERS}/${mate.user_id}/access`, {
    session,
    body: { active: true },
  });
  assert.equal(restored.status, 200);
  assert.equal((restored.body.user as Record<string, unknown>).active, true);
});

test("the people list says whether removing someone unpaired their crew phone, never which phone", async () => {
  const h = harness();
  const { user: ada, session } = await owner(h);
  const crew = await addUser(h.env, "crew@example.invalid", "field", "Crew Member");
  const desk = await addUser(h.env, "desk@example.invalid", "sales", "Desk Person");
  const officeUnpaired = await addUser(h.env, "unpaired@example.invalid", "field", "Office Unpaired");
  const pair = (userId: string, deviceId: string, proof: string, revokedBy: string | null) =>
    h.db.raw.prepare(
      `INSERT INTO app_devices
         (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
          revoked_at, revoked_by_user_id, created_ip_hash, created_user_agent_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      deviceId,
      TENANT,
      userId,
      proof.repeat(64),
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
      revokedBy ? "2026-08-24T00:00:00.000Z" : null,
      revokedBy,
      "a".repeat(64),
      "b".repeat(64),
    );
  pair(crew.user_id, "appd_crew_device_0001", "c", null);
  // The office unpaired this one's phone before the removal; the removal unpairs nothing more.
  pair(officeUnpaired.user_id, "appd_office_unpaired_01", "d", ada.user_id);
  const flags = async () =>
    Object.fromEntries(
      ((await call(h, "GET", APP_USERS, { session })).body.users as Array<Record<string, unknown>>)
        .map((user) => [user.display_name, user.crew_phone_unpaired]),
    );
  assert.deepEqual(await flags(), {
    "Ada Owner": false,
    "Crew Member": false,
    "Desk Person": false,
    "Office Unpaired": false,
  });

  const removedCrew = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: "crew@example.invalid",
      display_name: "Crew Member",
      role: "field",
      frappe_user_id: "crew@example.invalid",
      active: false,
    },
  });
  assert.equal(removedCrew.status, 200);
  assert.equal((removedCrew.body.user as Record<string, unknown>).crew_phone_unpaired, true);
  for (const person of [desk, officeUnpaired]) {
    const removed = await call(h, "POST", `${APP_USERS}/${person.user_id}/access`, {
      session,
      body: { active: false },
    });
    assert.equal(removed.status, 200);
    assert.equal((removed.body.user as Record<string, unknown>).crew_phone_unpaired, false);
  }

  assert.deepEqual(await flags(), {
    "Ada Owner": false,
    "Crew Member": true,
    "Desk Person": false,
    "Office Unpaired": false,
  });
  const listed = (await call(h, "GET", APP_USERS, { session })).body.users as Array<
    Record<string, unknown>
  >;
  assert.ok(
    listed.every((user) => !Object.keys(user).some((key) => key.includes("device"))),
    "the list carries the fact, never a device id",
  );
});

test("a crew phone a removal unpaired stops counting once a phone is paired again", async () => {
  const h = harness();
  const { session } = await owner(h);
  const crew = await addUser(h.env, "crew@example.invalid", "field", "Crew Member");
  const pair = (deviceId: string, proof: string, pairedAt: string) =>
    h.db.raw.prepare(
      `INSERT INTO app_devices
         (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
          revoked_at, revoked_by_user_id, created_ip_hash, created_user_agent_hash)
       VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
    ).run(deviceId, TENANT, crew.user_id, proof.repeat(64), pairedAt, pairedAt, "a".repeat(64), "b".repeat(64));
  const unpaired = async () =>
    ((await call(h, "GET", APP_USERS, { session })).body.users as Array<Record<string, unknown>>)
      .find((user) => user.user_id === crew.user_id)!.crew_phone_unpaired;
  pair("appd_crew_first_phone_01", "c", "2026-08-23T00:00:00.000Z");

  // The removal alone: the phone it unpaired must be paired again.
  assert.equal((await call(h, "POST", `${APP_USERS}/${crew.user_id}/access`, {
    session,
    body: { active: false },
  })).status, 200);
  assert.equal(await unpaired(), true);
  // Giving access back pairs nothing.
  assert.equal((await call(h, "POST", `${APP_USERS}/${crew.user_id}/access`, {
    session,
    body: { active: true },
  })).status, 200);
  assert.equal(await unpaired(), true);
  // A phone paired after that removal clears it.
  pair("appd_crew_second_phone1", "d", new Date(Date.now() + 1_000).toISOString());
  assert.equal(await unpaired(), false);
});

test("legacy deactivation revokes a pending invitation so it cannot restore access", async () => {
  const h = harness();
  const { user: actor, session } = await owner(h);
  const mate = await addUser(h.env, "legacy-remove@example.invalid", "ops", "Legacy Remove");
  const pending = await invite(h, session, {
    email: mate.email_normalized,
    display_name: mate.display_name,
    role: "ops",
  });
  const token = capturedToken(h, "user_invite", mate.email_normalized);

  const removed = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: mate.email_normalized,
      display_name: mate.display_name,
      role: mate.role,
      frappe_user_id: null,
      active: false,
    },
  });
  assert.equal(removed.status, 200);
  assert.equal(userRow(h, mate.email_normalized)!.active, 0);
  const revoked = inviteRow(h, String(pending.invite.invite_id));
  assert.equal(revoked.revoked_reason, "office_revoked");
  assert.equal(revoked.revoked_by_user_id, actor.user_id);

  const refused = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "invite_revoked");
  assert.equal(
    userRow(h, mate.email_normalized)!.active,
    0,
    "the spent removal credential cannot reactivate the account",
  );
});

test("deactivation atomically wins against stale invite acceptance on both access routes", async () => {
  for (const route of ["id", "legacy"] as const) {
    const h = harness();
    const { session } = await owner(h);
    const mate = await addUser(
      h.env,
      `${route}-atomic-remove@example.invalid`,
      "ops",
      `${route} Atomic Remove`,
    );
    await invite(h, session, {
      email: mate.email_normalized,
      display_name: mate.display_name,
      role: "ops",
    });
    const token = capturedToken(h, "user_invite", mate.email_normalized);
    let raced = false;

    h.db.afterNextMatchingRun(
      (sql) => route === "id"
        ? sql.includes("UPDATE app_users SET active")
        : sql.includes("UPDATE app_users") && sql.includes("display_name"),
      async () => {
        raced = true;
        const acceptance = await call(h, "POST", ACCEPT, { body: { token } });
        await h.flush();
        assert.equal(acceptance.status, 409, `${route}: a stale invite is no longer a key`);
        assert.equal(acceptance.body.error, "invite_revoked");
      },
    );

    const removed = route === "id"
      ? await call(h, "POST", `${APP_USERS}/${mate.user_id}/access`, {
        session,
        body: { active: false },
      })
      : await call(h, "POST", APP_USERS, {
        session,
        body: {
          tenant_id: TENANT,
          email: mate.email_normalized,
          display_name: mate.display_name,
          role: mate.role,
          frappe_user_id: null,
          active: false,
        },
      });
    assert.equal(removed.status, 200, `${route}: the removal itself succeeds`);
    assert.equal(raced, true, `${route}: the deterministic claimant reached the write boundary`);
    assert.equal(
      userRow(h, mate.email_normalized)!.active,
      0,
      `${route}: successful removal cannot finish with the account active`,
    );
  }
});

test("a failed authority CAS has zero deactivation cleanup side effects", async () => {
  const h = harness();
  const actor = await addUser(h.env, "cleanup-race-ops@example.invalid", "ops", "Cleanup Ops");
  const session = await signIn(h, actor, "c".repeat(43));
  const mate = await addUser(h.env, "cleanup-race-target@example.invalid", "sales", "Cleanup Target");
  const mateSession = await signIn(h, mate, "t".repeat(43));
  const pending = await invite(h, session, {
    email: mate.email_normalized,
    display_name: mate.display_name,
    role: "sales",
  });
  h.db.raw.prepare(
    `INSERT INTO app_magic_links
       (token_hash, user_id, tenant_id, created_at, expires_at, consumed_at,
        request_ip_hash, request_user_agent_hash)
     VALUES (?,?,?,?,?,NULL,?,?)`,
  ).run(
    "d".repeat(64),
    mate.user_id,
    TENANT,
    "2026-08-24T00:00:00.000Z",
    "2030-01-01T00:00:00.000Z",
    "a".repeat(64),
    "b".repeat(64),
  );
  h.db.raw.prepare(
    `INSERT INTO app_devices
       (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
        revoked_at, revoked_by_user_id, created_ip_hash, created_user_agent_hash)
     VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
  ).run(
    "appd_cleanup_race_0001",
    TENANT,
    mate.user_id,
    "e".repeat(64),
    "2026-08-24T00:00:00.000Z",
    "2026-08-24T00:00:00.000Z",
    "a".repeat(64),
    "b".repeat(64),
  );
  h.db.beforeNextMatchingRun(
    (sql) => sql.includes("UPDATE app_users") && sql.includes("display_name"),
    () => {
      h.db.raw.prepare(
        `UPDATE app_users SET active = 0, updated_at = ?
          WHERE tenant_id = ? AND user_id = ?`,
      ).run("2026-08-24T12:02:00.000Z", TENANT, actor.user_id);
    },
  );

  const refused = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: mate.email_normalized,
      display_name: mate.display_name,
      role: mate.role,
      frappe_user_id: null,
      active: false,
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "app_user_state_changed");
  assert.equal(userRow(h, mate.email_normalized)!.active, 1);
  assert.equal(
    scalar(h, `SELECT COUNT(*) AS value FROM app_sessions WHERE user_id = ? AND revoked_at IS NULL`, mate.user_id),
    1,
    "the target session remains live",
  );
  assert.equal(
    scalar(h, `SELECT COUNT(*) AS value FROM app_magic_links WHERE user_id = ? AND consumed_at IS NULL`, mate.user_id),
    1,
    "the target magic link remains open",
  );
  assert.equal(
    scalar(h, `SELECT COUNT(*) AS value FROM app_devices WHERE user_id = ? AND revoked_at IS NULL`, mate.user_id),
    1,
    "the target device remains paired",
  );
  assert.equal(inviteRow(h, String(pending.invite.invite_id)).revoked_at, null);
  const stillAlive = await call(h, "GET", "/api/v1/session", { session: mateSession });
  assert.equal(stillAlive.body.authenticated, true);
});

test("legacy provisioning refuses a target role that changes after authorization", async () => {
  const h = harness();
  const ops = await addUser(h.env, "race-ops@example.invalid", "ops", "Race Ops");
  const session = await signIn(h, ops, "r".repeat(43));
  const mate = await addUser(h.env, "race-target@example.invalid", "sales", "Race Target");
  h.db.beforeNextMatchingRun(
    (sql) => sql.includes("INSERT INTO app_users") ||
      (sql.includes("UPDATE app_users") && sql.includes("display_name")),
    () => {
      h.db.raw.prepare(
        `UPDATE app_users
            SET role = 'owner', access_role = 'owner', updated_at = ?
          WHERE tenant_id = ? AND user_id = ?`,
      ).run("2026-08-24T12:00:00.000Z", TENANT, mate.user_id);
    },
  );

  const refused = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: mate.email_normalized,
      display_name: mate.display_name,
      role: "sales",
      frappe_user_id: null,
      active: true,
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "app_user_state_changed");
  assert.equal(userRow(h, mate.email_normalized)!.access_role, "owner");
});

test("legacy provisioning refuses an actor whose owner authority changes before the write", async () => {
  const h = harness();
  const { user: actor, session } = await owner(h);
  const lastOwner = await addUser(h.env, "race-owner@example.invalid", "owner", "Race Owner");
  h.db.beforeNextMatchingRun(
    (sql) => sql.includes("INSERT INTO app_users") ||
      (sql.includes("UPDATE app_users") && sql.includes("display_name")),
    () => {
      h.db.raw.prepare(
        `UPDATE app_users
            SET role = 'ops', access_role = 'ops', updated_at = ?
          WHERE tenant_id = ? AND user_id = ?`,
      ).run("2026-08-24T12:01:00.000Z", TENANT, actor.user_id);
    },
  );

  const refused = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: lastOwner.email_normalized,
      display_name: lastOwner.display_name,
      role: "ops",
      frappe_user_id: null,
      active: true,
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "app_user_state_changed");
  assert.equal(userRow(h, lastOwner.email_normalized)!.access_role, "owner");
  assert.equal(
    scalar(
      h,
      `SELECT COUNT(*) AS value FROM app_users
        WHERE tenant_id = ? AND active = 1 AND access_role = 'owner'`,
      TENANT,
    ),
    1,
    "the concurrent demotion cannot consume the final owner",
  );
});

// --------------------------------------------------------------------------- retention

test("settled invitations are pruned on the ordinary auth sweep; live ones are not", async () => {
  const h = harness();
  const { session } = await owner(h);
  const keep = await invite(h, session, {
    email: "keep@example.invalid",
    display_name: "Keep",
    role: "sales",
  });
  const drop = await invite(h, session, {
    email: "drop@example.invalid",
    display_name: "Drop",
    role: "sales",
  });
  h.db.raw.prepare(
    `UPDATE app_user_invites
        SET revoked_at = '2020-01-01T00:00:00.000Z', revoked_reason = 'office_revoked',
            revoked_by_user_id = invited_by_user_id, created_at = '2019-01-01T00:00:00.000Z'
      WHERE invite_id = ?`,
  ).run(String(drop.invite.invite_id));

  await pruneAuthRecords(h.env, new Date());

  assert.ok(inviteRow(h, String(keep.invite.invite_id)), "a live invitation survives the sweep");
  assert.equal(inviteRow(h, String(drop.invite.invite_id)), undefined);
});

test("an operations account cannot re-send or withdraw an owner's invitation", async () => {
  const h = harness();
  const { session } = await owner(h);
  const ops = await addUser(h.env, "ops@example.invalid", "ops", "Ops");
  const opsSession = await signIn(h, ops, "p".repeat(43));
  const issued = await invite(h, session, {
    email: "heir@example.invalid",
    display_name: "Heir",
    role: "owner",
  });

  for (const action of ["resend", "revoke"]) {
    const refused = await call(
      h,
      "POST",
      `${INVITES}/${String(issued.invite.invite_id)}/${action}`,
      { session: opsSession },
    );
    assert.equal(refused.status, 403, `operations must not ${action} an owner invitation`);
    assert.equal(refused.body.error, "owner_role_required");
  }
  const still = inviteRow(h, String(issued.invite.invite_id));
  assert.equal(still.revoked_at, null);
  assert.equal(still.resend_count, 0);
});

test("an unknown invitation is not found, whatever the office asks of it", async () => {
  const h = harness();
  const { session } = await owner(h);
  for (const inviteId of [`appi_${crypto.randomUUID()}`, "not-an-invite", "appi_short"]) {
    for (const action of ["resend", "revoke"]) {
      const missing = await call(
        h,
        "POST",
        `${INVITES}/${encodeURIComponent(inviteId)}/${action}`,
        { session },
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "invite_not_found");
    }
  }
});

test("an invitation is refused before it is written when the request is malformed", async () => {
  const h = harness();
  const { session } = await owner(h);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ email: "not-an-email", display_name: "X", role: "sales" }, "invalid_email"],
    [{ email: "a@example.invalid", display_name: "  ", role: "sales" }, "invalid_display_name"],
    [{ email: "a@example.invalid", display_name: "X", role: "superuser" }, "invalid_role"],
    [{ email: "a@example.invalid", display_name: "X" }, "invalid_role"],
    [
      { email: "a@example.invalid", display_name: "X", role: "sales", active: true },
      "unexpected_field",
    ],
  ];
  for (const [body, error] of cases) {
    const refused = await call(h, "POST", INVITES, { session, body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, error);
  }
  assert.equal(scalar(h, `SELECT COUNT(*) AS value FROM app_user_invites`), 0);
});

test("every act on an invitation lands in the auth audit with its actor", async () => {
  const h = harness();
  const { user: ownerUser, session } = await owner(h);
  const issued = await invite(h, session, {
    email: "audited@example.invalid",
    display_name: "Audited",
    role: "sales",
  });
  await call(h, "POST", `${INVITES}/${String(issued.invite.invite_id)}/resend`, { session });
  await h.flush();
  const token = capturedToken(h, "user_invite", "audited@example.invalid");
  await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();

  const events = h.db.raw.prepare(
    `SELECT event, outcome, user_id, detail_code FROM app_auth_audit
      WHERE event LIKE 'user_invite%' ORDER BY id ASC`,
  ).all() as Array<{ event: string; outcome: string; user_id: string; detail_code: string }>;
  assert.deepEqual(
    events.map((row) => `${row.event}:${row.outcome}`),
    [
      "user_invite_create:issued",
      "user_invite_delivery:sent",
      "user_invite_resend:issued",
      "user_invite_delivery:sent",
      "user_invite_accept:granted",
    ],
  );
  assert.equal(events[0].user_id, ownerUser.user_id, "the issuing office user is named");
  assert.ok(
    events.every((row) => row.detail_code.endsWith(String(issued.invite.invite_id))),
    "every entry binds the exact invitation",
  );
  assert.equal(
    events.at(-1)!.user_id,
    String(userRow(h, "audited@example.invalid")!.user_id),
    "and the acceptance names the account it created",
  );
});

test("a role or access change applies only against the access version it was decided on", async () => {
  const h = harness();
  const { session } = await owner(h);
  const mate = await addUser(h.env, "versioned@example.invalid", "sales", "Versioned Mate");
  const auditCount = (event: string) =>
    scalar(
      h,
      "SELECT count(*) AS value FROM app_auth_audit WHERE event = ? AND user_id = ?",
      event,
      mate.user_id,
    );

  const listed = await call(h, "GET", APP_USERS, { session });
  const listedMate = (listed.body.users as Array<Record<string, unknown>>)
    .find((user) => user.user_id === mate.user_id)!;
  assert.equal(listedMate.access_version, 1, "the people list carries the version a change names");

  const missing = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "production" },
    rawBody: true,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "expected_access_version_required");

  const promoted = await call(h, "POST", `${APP_USERS}/${mate.user_id}/role`, {
    session,
    body: { role: "production", expected_access_version: 1 },
  });
  assert.equal(promoted.status, 200);
  assert.equal((promoted.body.user as Record<string, unknown>).access_version, 2);
  assert.equal(auditCount("user_role_change"), 1, "one audit row, committed with the change");

  // A second decision made on the same screen, before the first landed, is refused, not applied.
  const stale = await call(h, "POST", `${APP_USERS}/${mate.user_id}/access`, {
    session,
    body: { active: false, expected_access_version: 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "access_version_conflict");
  assert.equal(userRow(h, "versioned@example.invalid")!.active, 1);
  assert.equal(auditCount("user_access_change"), 0, "a refused change writes no audit row");

  const removed = await call(h, "POST", `${APP_USERS}/${mate.user_id}/access`, {
    session,
    body: { active: false, expected_access_version: 2 },
  });
  assert.equal(removed.status, 200);
  assert.equal((removed.body.user as Record<string, unknown>).access_version, 3);
  assert.equal(auditCount("user_access_change"), 1);
});

test("a refused change says who changed the access since, what is different and the version now", async () => {
  const h = harness();
  const { user: ada, session } = await owner(h);
  const priya = await addUser(h.env, "priya@example.invalid", "ops", "Priya Nand");
  const priyaSession = await signIn(h, priya, "p".repeat(43));
  const grace = await addUser(h.env, "grace@example.invalid", "sales", "Grace Obi");
  const provision = (role: AppRole, active: boolean, expected: number) => ({
    tenant_id: TENANT,
    email: "grace@example.invalid",
    display_name: "Grace Obi",
    role,
    frappe_user_id: null,
    active,
    expected_access_version: expected,
  });

  // Ada changes Grace's role on one screen; the same change decided on another screen is refused.
  assert.equal((await call(h, "POST", APP_USERS, {
    session,
    body: provision("production", true, 1),
  })).status, 200);
  const own = await call(h, "POST", APP_USERS, { session, body: provision("accounting", true, 1) });
  assert.equal(own.status, 409);
  assert.equal(own.body.error, "access_version_conflict");
  const ownConflict = own.body.conflict as Record<string, unknown>;
  assert.match(String(ownConflict.changed_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...ownConflict, changed_at: "recorded" }, {
    user_id: grace.user_id,
    access_version: 2,
    changed_at: "recorded",
    changed_by: { user_id: ada.user_id, display_name: "Ada Owner", is_self_actor: true },
    change: {
      before: { role: "sales", active: true },
      after: { role: "production", active: true },
    },
  });

  // Priya removes Grace; Ada's change decided on version 2 names Priya, through either route.
  assert.equal((await call(h, "POST", `${APP_USERS}/${grace.user_id}/access`, {
    session: priyaSession,
    body: { active: false, expected_access_version: 2 },
  })).status, 200);
  const other = await call(h, "POST", `${APP_USERS}/${grace.user_id}/role`, {
    session,
    body: { role: "accounting", expected_access_version: 2 },
  });
  assert.equal(other.status, 409);
  const otherConflict = other.body.conflict as Record<string, unknown>;
  assert.deepEqual(otherConflict.changed_by, {
    user_id: priya.user_id,
    display_name: "Priya Nand",
    is_self_actor: false,
  });
  assert.deepEqual(otherConflict.change, {
    before: { role: "production", active: true },
    after: { role: "production", active: false },
  });
  assert.equal(otherConflict.access_version, 3);

  // Two changes since the version a screen decided on: the newest names the actor, the first the
  // access that screen showed.
  const twoBehind = await call(h, "POST", APP_USERS, {
    session,
    body: provision("accounting", true, 1),
  });
  assert.equal(twoBehind.status, 409);
  const twoBehindConflict = twoBehind.body.conflict as Record<string, unknown>;
  assert.equal((twoBehindConflict.changed_by as Record<string, unknown>).user_id, priya.user_id);
  assert.deepEqual(twoBehindConflict.change, {
    before: { role: "sales", active: true },
    after: { role: "production", active: false },
  });

  // The audit rows carry each change as JSON: the version it produced, the access before and
  // after it, and who decided it; their short detail text is unchanged.
  assert.deepEqual(
    h.db.raw.prepare(
      `SELECT event, detail_code, access_change FROM app_auth_audit
        WHERE user_id = ? AND access_change IS NOT NULL ORDER BY id`,
    ).all(grace.user_id).map((row) => ({
      event: (row as Record<string, unknown>).event,
      detail_code: (row as Record<string, unknown>).detail_code,
      access_change: JSON.parse(String((row as Record<string, unknown>).access_change)),
    })),
    [
      {
        event: "user_provision",
        detail_code: "production:owner@example.invalid",
        access_change: {
          v: 2,
          before: { role: "sales", active: true },
          after: { role: "production", active: true },
          actor: ada.user_id,
        },
      },
      {
        event: "user_access_change",
        detail_code: `production:${priya.user_id}`,
        access_change: {
          v: 3,
          before: { role: "production", active: true },
          after: { role: "production", active: false },
          actor: priya.user_id,
        },
      },
    ],
  );
  // A row that is not JSON never lands: the column refuses it.
  assert.throws(() =>
    h.db.raw.prepare(
      `INSERT INTO app_auth_audit
         (created_at, tenant_id, user_id, event, outcome, ip_hash, user_agent_hash, access_change)
       VALUES (?, ?, ?, 'user_access_change', 'removed', ?, ?, ?)`,
    ).run(new Date().toISOString(), TENANT, grace.user_id, "a".repeat(64), "b".repeat(64), "v4:not json")
  );
});

test("giving access back keeps the role it had and applies against the version the removal left", async () => {
  const h = harness();
  const { session } = await owner(h);
  const grace = await addUser(h.env, "grace@example.invalid", "sales", "Grace Obi");
  const provision = (role: AppRole, active: boolean, expected: number) => ({
    tenant_id: TENANT,
    email: "grace@example.invalid",
    display_name: "Grace Obi",
    role,
    frappe_user_id: null,
    active,
    expected_access_version: expected,
  });
  assert.equal(
    (await call(h, "POST", APP_USERS, { session, body: provision("sales", false, 1) })).status,
    200,
  );

  // A screen that still holds a role change for Grace gives her access back first, with the role
  // she had, against the version the removal left; the role change waits for its own save.
  const restored = await call(h, "POST", APP_USERS, { session, body: provision("sales", true, 2) });
  assert.equal(restored.status, 200);
  assert.deepEqual(
    {
      role: (restored.body.user as Record<string, unknown>).role,
      active: (restored.body.user as Record<string, unknown>).active,
      access_version: (restored.body.user as Record<string, unknown>).access_version,
    },
    { role: "sales", active: true, access_version: 3 },
  );
  const staleSave = await call(h, "POST", APP_USERS, {
    session,
    body: provision("production", true, 2),
  });
  assert.equal(staleSave.status, 409, "the save names the version the restore produced");
  const saved = await call(h, "POST", APP_USERS, { session, body: provision("production", true, 3) });
  assert.equal(saved.status, 200);
  assert.equal((saved.body.user as Record<string, unknown>).access_version, 4);
  assert.equal(userRow(h, "grace@example.invalid")!.access_role, "production");
  assert.equal(userRow(h, "grace@example.invalid")!.active, 1);
  assert.equal(grace.user_id, userRow(h, "grace@example.invalid")!.user_id);
});

test("an accepted invitation moves a removed person's access version, so an older decision is refused", async () => {
  const h = harness();
  const { user: ada, session } = await owner(h);
  const grace = await addUser(h.env, "grace@example.invalid", "sales", "Grace Obi");

  // Ada removes Grace; the people list shows her removed at version 2, and the next decision taken
  // on that screen names version 2.
  assert.equal((await call(h, "POST", `${APP_USERS}/${grace.user_id}/access`, {
    session,
    body: { active: false, expected_access_version: 1 },
  })).status, 200);
  const listed = await call(h, "GET", APP_USERS, { session });
  const seen = (listed.body.users as Array<Record<string, unknown>>)
    .find((user) => user.user_id === grace.user_id)!;
  assert.deepEqual(
    { active: seen.active, access_version: seen.access_version },
    { active: false, access_version: 2 },
  );

  // Grace is invited again and accepts: her access comes back and its version moves on, with the
  // granted row and the change committed in the claim's own batch.
  const issued = await invite(h, session, {
    email: "grace@example.invalid",
    display_name: "Grace Obi",
    role: "sales",
  });
  const token = capturedToken(h, "user_invite", "grace@example.invalid");
  const accepted = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(accepted.status, 200);
  assert.equal(userRow(h, "grace@example.invalid")!.active, 1);
  assert.equal(accessVersionOf(h, grace.user_id), 3);
  const granted = h.db.raw.prepare(
    `SELECT detail_code, access_change FROM app_auth_audit
      WHERE user_id = ? AND event = 'user_invite_accept' AND outcome = 'granted'`,
  ).all(grace.user_id) as Array<{ detail_code: string; access_change: string }>;
  assert.equal(granted.length, 1, "one granted row, committed with the claim");
  assert.equal(granted[0]!.detail_code, `sales:${String(issued.invite.invite_id)}`);
  // The person who accepted made the change, not whoever issued the invitation.
  assert.deepEqual(JSON.parse(granted[0]!.access_change), {
    v: 3,
    before: { role: "sales", active: false },
    after: { role: "sales", active: true },
    actor: grace.user_id,
  });

  // The screen still holding version 2 gives her access back: refused, saying what moved.
  const stale = await call(h, "POST", APP_USERS, {
    session,
    body: {
      tenant_id: TENANT,
      email: "grace@example.invalid",
      display_name: "Grace Obi",
      role: "sales",
      frappe_user_id: null,
      active: true,
      expected_access_version: 2,
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "access_version_conflict");
  const conflict = stale.body.conflict as Record<string, unknown>;
  assert.equal(conflict.access_version, 3);
  // Ada's stale tab is not told she made this change: Grace did, by accepting.
  assert.deepEqual(conflict.changed_by, {
    user_id: grace.user_id,
    display_name: "Grace Obi",
    is_self_actor: false,
  });
  // Removed before, active now: the app reads this as "they have access again".
  assert.deepEqual(conflict.change, {
    before: { role: "sales", active: false },
    after: { role: "sales", active: true },
  });
  assert.equal(accessVersionOf(h, grace.user_id), 3, "the refused decision changed nothing");
});

test("an invitation claim applies only against the access version it read", async () => {
  const h = harness();
  const { session } = await owner(h);
  const grace = await addUser(h.env, "grace@example.invalid", "sales", "Grace Obi");
  assert.equal((await call(h, "POST", `${APP_USERS}/${grace.user_id}/access`, {
    session,
    body: { active: false, expected_access_version: 1 },
  })).status, 200);
  const issued = await invite(h, session, {
    email: "grace@example.invalid",
    display_name: "Grace Obi",
    role: "production",
  });
  const token = capturedToken(h, "user_invite", "grace@example.invalid");

  // Someone changes Grace's access between the claim's read and its write.
  h.db.beforeNextMatchingRun(
    (sql) => sql.includes("INSERT INTO app_users") && sql.includes("ON CONFLICT"),
    () => {
      h.db.raw.prepare(
        `UPDATE app_users SET access_role = 'accounting', access_version = access_version + 1
          WHERE user_id = ?`,
      ).run(grace.user_id);
    },
  );
  const raced = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(raced.status, 503);
  assert.equal(raced.body.error, "invite_unavailable");
  assert.equal(userRow(h, "grace@example.invalid")!.active, 0, "nothing granted over a moved version");
  assert.equal(userRow(h, "grace@example.invalid")!.access_role, "accounting");
  assert.equal(inviteRow(h, String(issued.invite.invite_id)).accepted_at, null, "the invitation is not spent");
  assert.equal(
    scalar(
      h,
      `SELECT count(*) AS value FROM app_auth_audit
        WHERE user_id = ? AND event = 'user_invite_accept' AND outcome = 'granted'`,
      grace.user_id,
    ),
    0,
  );

  // Accepting again reads the version as it is now and lands.
  const retried = await call(h, "POST", ACCEPT, { body: { token } });
  await h.flush();
  assert.equal(retried.status, 200);
  assert.equal(userRow(h, "grace@example.invalid")!.active, 1);
  assert.equal(userRow(h, "grace@example.invalid")!.access_role, "production");
  assert.equal(accessVersionOf(h, grace.user_id), 4);
});

test("provisioning names the access version for an existing person and none for a new one", async () => {
  const h = harness();
  const { session } = await owner(h);
  await addUser(h.env, "existing@example.invalid", "sales", "Existing Person");
  const body = (email: string, extra: Record<string, unknown> = {}) => ({
    tenant_id: TENANT,
    email,
    display_name: "Some Person",
    role: "production",
    frappe_user_id: null,
    active: true,
    ...extra,
  });

  const noVersion = await call(h, "POST", APP_USERS, {
    session,
    body: body("existing@example.invalid"),
    rawBody: true,
  });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.error, "expected_access_version_required");
  const stale = await call(h, "POST", APP_USERS, {
    session,
    body: body("existing@example.invalid", { expected_access_version: 7 }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "access_version_conflict");
  const changed = await call(h, "POST", APP_USERS, {
    session,
    body: body("existing@example.invalid", { expected_access_version: 1 }),
  });
  assert.equal(changed.status, 200);
  assert.equal((changed.body.user as Record<string, unknown>).access_version, 2);

  const ghost = await call(h, "POST", APP_USERS, {
    session,
    body: body("brand-new@example.invalid", { expected_access_version: 1 }),
  });
  assert.equal(ghost.status, 409, "a version for a person who does not exist yet is stale too");
  assert.equal(ghost.body.error, "access_version_conflict");
  const created = await call(h, "POST", APP_USERS, {
    session,
    body: body("brand-new@example.invalid"),
  });
  assert.equal(created.status, 200);
  assert.equal((created.body.user as Record<string, unknown>).access_version, 1);
  assert.equal(
    scalar(
      h,
      "SELECT count(*) AS value FROM app_auth_audit WHERE event = 'user_provision' AND user_id = ?",
      String((created.body.user as Record<string, unknown>).user_id),
    ),
    1,
  );
});
