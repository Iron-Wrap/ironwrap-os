// deposit-policy.test.ts - the owner's deposit policy: who may change it, how it is kept, and the
// contract terms each policy allows (migration 0155).
//
// The route cases drive `/api/v1/owner/deposit-policy` through a person's real cookie session into
// the revisions table and assert what the revisions and the audit log hold. D1's own refusals are
// proved with direct SQL. Acceptance and the Deposit gate entries are proved end to end in
// customer-contract-acceptance.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import {
  contractDepositTerms,
  depositGateEvidence,
  depositTermsRefusalFor,
  type DepositGateEvidenceFacts,
} from "../src/deposit-policy.ts";

// Synthetic fixtures only: reserved example.invalid identities and run-relative times.
const TENANT = "ironwrap";
const PEPPER = "synthetic-deposit-policy-route-pepper-012345";
const PATH = "/api/v1/owner/deposit-policy";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const REASON = "MD-13 input arrived: contracts carry a deposit again.";
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const USERS = {
  owner: { id: "appu_owner_policy_0001", role: "owner", access: "owner" },
  production: { id: "appu_production_policy", role: "ops", access: "production" },
  ops: { id: "appu_ops_policy_000001", role: "ops", access: "ops" },
  seed: { id: "appu_seed_owner_policy", role: "owner", access: "owner" },
} as const;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

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
}

interface Harness {
  env: AppEnv;
  db: TestD1;
}

function setup(): Harness {
  const db = new TestD1();
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    db.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of Object.values(USERS)) {
    db.sqlite.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
    ).run(
      user.id, TENANT, `${user.id}@example.invalid`, `Synthetic ${user.access}`, user.role, user.access,
      user === USERS.seed ? SEED_CREATED_BY : "owner@example.invalid", at(-60), at(-60),
    );
  }
  const env = {
    DB: db as never,
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
    APP_TIME_ZONE: "America/Edmonton",
  } as AppEnv;
  return { env, db };
}

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function person(h: Harness, userId: string): Promise<AuthContext> {
  const token = randomToken();
  h.db.sqlite.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(await sessionHashFor(h.env, token), userId, TENANT, at(-1), at(60), at(-1), "d".repeat(64), "e".repeat(64));
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: { cookie: `__Host-ironwrap_session=${token}` },
    }),
    h.env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** An owner role without a person's cookie token: a connector, an agent host, a service token. */
function machine(role: AppRole = "owner"): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: at(-1),
      session_expires_at: at(60),
      revoked_at: null,
      user_id: USERS.owner.id,
      tenant_id: TENANT,
      email_normalized: `${USERS.owner.id}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

async function call(
  h: Harness,
  auth: AuthContext,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  options: { key?: string | null; csrf?: string | null } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers = new Headers({ "content-type": "application/json" });
  const csrf = options.csrf === undefined ? auth.csrfToken : options.csrf;
  if (csrf) headers.set("x-csrf-token", csrf);
  if (options.key !== null) headers.set("idempotency-key", options.key ?? "deposit-policy-key-000001");
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${PATH}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    h.env,
    auth,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function revisions(h: Harness): Array<Record<string, unknown>> {
  return h.db.sqlite.prepare(
    `SELECT revision_id, revision, policy, reason, set_by_user_id, set_by_role
       FROM tenant_deposit_policy_revisions ORDER BY revision`,
  ).all().map((row) => ({ ...row }));
}

function refused(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(code));
    return true;
  });
}

const MD13 = { policy: "md13_deposit", expected_version: 0, reason: REASON };

/** Runs `action` while the Worker's clock reads a day behind D1's. */
async function withWorkerClockADayBehind<T>(action: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: Date.now() - 24 * 60 * 60_000 });
  try {
    return await action();
  } finally {
    mock.timers.reset();
  }
}

test("the policy reads OD-01 at version 0 until the owner records one, and only the owner reads it", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const read = await call(h, owner, "GET");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    deposit_policy: {
      policy: "od01_payment_on_completion",
      version: 0,
      revision_id: null,
      set_by_user_id: null,
      set_at: null,
      reason: null,
    },
  });
  const ops = await person(h, USERS.ops.id);
  assert.deepEqual(await call(h, ops, "GET"), { status: 403, body: { error: "owner_role_required" } });
});

test("only the owner, in their own session, with CSRF, a key, the version and a reason, changes it", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const cases: Array<[Promise<{ status: number; body: Record<string, any> }>, number, string]> = [
    [call(h, machine("owner"), "POST", MD13), 403, "person_session_required"],
    // An empty token and an empty CSRF still never make a person.
    [call(h, { ...machine("owner"), rawSessionToken: "", csrfToken: "" }, "POST", MD13, { csrf: null }), 403, "person_session_required"],
    [call(h, owner, "POST", MD13, { csrf: null }), 403, "csrf_failed"],
    [call(h, owner, "POST", MD13, { csrf: "forged" }), 403, "csrf_failed"],
    [call(h, await person(h, USERS.production.id), "POST", MD13), 403, "owner_role_required"],
    [call(h, await person(h, USERS.ops.id), "POST", MD13), 403, "owner_role_required"],
    [call(h, owner, "POST", MD13, { key: null }), 400, "idempotency_key_required"],
    [call(h, owner, "POST", { ...MD13, reason: "short" }), 400, "invalid_tenant_deposit_policy"],
    [call(h, owner, "POST", { policy: "md13_deposit", expected_version: 0 }), 400, "invalid_tenant_deposit_policy"],
    [call(h, owner, "POST", { ...MD13, policy: "deposit_25" }), 400, "invalid_tenant_deposit_policy"],
    [call(h, owner, "POST", { ...MD13, expected_version: -1 }), 400, "invalid_tenant_deposit_policy"],
    [call(h, owner, "POST", { ...MD13, deposit_percent: 25 }), 400, "invalid_tenant_deposit_policy"],
  ];
  for (const [pending, status, error] of cases) {
    assert.deepEqual(await pending, { status, body: { error } });
  }
  // The QA seed owner holds an owner session, and D1 still refuses its decision.
  const seed = await person(h, USERS.seed.id);
  assert.deepEqual(
    await call(h, seed, "POST", MD13, { key: "deposit-policy-seed-0001" }),
    { status: 403, body: { error: "tenant_deposit_policy_owner_required" } },
  );
  assert.deepEqual(revisions(h), []);
});

test("a change is versioned, audited once and replayed exactly", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const first = await call(h, owner, "POST", MD13);
  assert.equal(first.status, 200);
  const revisionId = first.body.deposit_policy.revision_id as string;
  assert.match(revisionId, /^tdp_[0-9a-f]{40}$/);
  assert.deepEqual(first.body, {
    deposit_policy: {
      policy: "md13_deposit",
      version: 1,
      revision_id: revisionId,
      set_by_user_id: USERS.owner.id,
      set_at: first.body.deposit_policy.set_at,
      reason: REASON,
    },
    replayed: false,
  });
  const audit = () => h.db.sqlite.prepare(
    `SELECT automation, trigger, source_ids, target_ids, action, result, approved_by, reason
       FROM audit_log WHERE run_id = ?`,
  ).all(revisionId).map((row) => ({ ...row }));
  assert.deepEqual(audit(), [{
    automation: "tenant_deposit_policy",
    trigger: "person",
    source_ids: `tenant:${TENANT},revision:1`,
    target_ids: `tenant_deposit_policy_revision:${revisionId}`,
    action: "set:md13_deposit",
    result: "ok",
    approved_by: USERS.owner.id,
    reason: null,
  }]);

  // An exact replay answers as the first request did and writes nothing.
  const replay = await call(h, owner, "POST", MD13);
  assert.deepEqual(replay, { status: 200, body: { ...first.body, replayed: true } });
  // The same key with another body is a conflict.
  assert.deepEqual(
    await call(h, owner, "POST", { ...MD13, policy: "od01_payment_on_completion" }),
    { status: 409, body: { error: "tenant_deposit_policy_replay_conflict" } },
  );
  // A new change names the version it read.
  assert.deepEqual(
    await call(h, owner, "POST", { ...MD13, policy: "od01_payment_on_completion" }, { key: "deposit-policy-key-000002" }),
    { status: 409, body: { error: "tenant_deposit_policy_version_conflict" } },
  );
  const second = await call(
    h,
    owner,
    "POST",
    { policy: "od01_payment_on_completion", expected_version: 1, reason: "Back to payment on completion." },
    { key: "deposit-policy-key-000003" },
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.deposit_policy.version, 2);
  assert.equal((await call(h, owner, "GET")).body.deposit_policy.policy, "od01_payment_on_completion");
  assert.deepEqual(
    revisions(h).map(({ revision, policy, set_by_role }) => ({ revision, policy, set_by_role })),
    [
      { revision: 1, policy: "md13_deposit", set_by_role: "owner" },
      { revision: 2, policy: "od01_payment_on_completion", set_by_role: "owner" },
    ],
  );
  assert.equal(audit().length, 1);
  assert.equal(
    h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE automation = 'tenant_deposit_policy'").get()!.count,
    2,
  );
});

test("a revision takes D1's time, not the Worker's, and its audit row the same", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const changed = await withWorkerClockADayBehind(() => call(h, owner, "POST", MD13));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const setAt = changed.body.deposit_policy.set_at as string;
  assert.match(setAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(setAt) - Date.now()) < 60_000, setAt);
  assert.equal(
    h.db.sqlite.prepare("SELECT ts FROM audit_log WHERE run_id = ?").get(changed.body.deposit_policy.revision_id)!.ts,
    setAt,
  );
});

test("D1 keeps the policy append-only and the decision of an active owner, whatever the writer", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  assert.equal((await call(h, owner, "POST", MD13)).status, 200);
  const insert = (overrides: Record<string, unknown>, verb = "INSERT") => {
    const row: Record<string, unknown> = {
      revision_id: `tdp_${"b".repeat(40)}`,
      tenant_id: TENANT,
      revision: 2,
      policy: "od01_payment_on_completion",
      reason: "Synthetic direct write.",
      set_by_user_id: USERS.owner.id,
      set_by_role: "owner",
      request_sha256: sha("request"),
      idempotency_key_hash: sha("direct-key"),
      set_at: at(0),
      ...overrides,
    };
    const columns = Object.keys(row);
    h.db.sqlite.prepare(
      `${verb} INTO tenant_deposit_policy_revisions (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...(columns.map((column) => row[column]) as never[]));
  };
  refused(() => h.db.sqlite.exec("UPDATE tenant_deposit_policy_revisions SET policy = 'od01_payment_on_completion'"), "tenant_deposit_policy_append_only");
  refused(() => h.db.sqlite.exec("DELETE FROM tenant_deposit_policy_revisions"), "tenant_deposit_policy_append_only");
  const [stored] = revisions(h);
  refused(() => insert({ revision_id: stored!.revision_id, revision: 1 }, "INSERT OR REPLACE"), "tenant_deposit_policy_append_only");
  refused(() => insert({ revision: 3 }), "tenant_deposit_policy_version_conflict");
  refused(() => insert({ revision: 1 }), "tenant_deposit_policy_version_conflict");
  refused(() => insert({ set_by_user_id: USERS.production.id }), "tenant_deposit_policy_owner_required");
  refused(() => insert({ set_by_user_id: USERS.seed.id }), "tenant_deposit_policy_owner_required");
  h.db.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.owner.id);
  refused(() => insert({}), "tenant_deposit_policy_owner_required");
  assert.equal(revisions(h).length, 1);
});

test("the deposit terms each policy allows, and the term a refusal names", () => {
  const completion = { deposit_percent: 0, payment_schedule: ["completion"], payment_terms_days: 30 };
  const deposit = { deposit_percent: 25, payment_schedule: ["deposit", "completion"], payment_terms_days: 30 };
  for (const [terms, kind] of [
    [completion, "no_deposit"],
    [JSON.stringify(completion), "no_deposit"],
    [deposit, "deposit"],
    [{ ...deposit, deposit_percent: 1 }, "deposit"],
    [{ ...deposit, deposit_percent: 100 }, "deposit"],
    [{ ...completion, payment_schedule: ["deposit", "completion"] }, "invalid"],
    [{ ...completion, payment_schedule: ["completion", "completion"] }, "invalid"],
    [{ ...completion, payment_schedule: "completion" }, "invalid"],
    [{ ...deposit, deposit_percent: "25" }, "invalid"],
    [{ ...deposit, deposit_percent: 25.5 }, "invalid"],
    [{ ...deposit, deposit_percent: 101 }, "invalid"],
    [{ ...deposit, deposit_percent: -1 }, "invalid"],
    [{ payment_terms_days: 30 }, "invalid"],
    ["not json", "invalid"],
    [null, "invalid"],
  ] as const) {
    assert.equal(contractDepositTerms(terms), kind, JSON.stringify(terms));
  }
  const od01 = "od01_payment_on_completion";
  const md13 = "md13_deposit";
  assert.equal(depositTermsRefusalFor(od01, completion), null);
  assert.equal(depositTermsRefusalFor(md13, deposit), null);
  assert.deepEqual(depositTermsRefusalFor(od01, deposit), {
    error: "deposit_terms_not_allowed_by_policy", policy: od01, field: "terms.deposit_percent",
  });
  assert.deepEqual(depositTermsRefusalFor(od01, { ...completion, payment_schedule: ["deposit", "completion"] }), {
    error: "deposit_terms_not_allowed_by_policy", policy: od01, field: "terms.payment_schedule",
  });
  assert.deepEqual(depositTermsRefusalFor(md13, completion), {
    error: "deposit_terms_not_allowed_by_policy", policy: md13, field: "terms.deposit_percent",
  });
  assert.deepEqual(depositTermsRefusalFor(md13, { ...deposit, deposit_percent: 101 }), {
    error: "deposit_terms_not_allowed_by_policy", policy: md13, field: "terms.deposit_percent",
  });
});

test("the policy's Deposit evidence fits 0153's 4000-character bound with every identifier at its D1 maximum", () => {
  const h = setup();
  // The ledger bounds its evidence at 4000 characters, and so does the gate it is copied onto.
  for (const table of ["production_gate_clearances", "operating_production_gates"]) {
    const { sql } = h.db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
      sql: string;
    };
    assert.match(sql, /length\(trim\(evidence_refs_json\)\) BETWEEN 2 AND 4000/, table);
  }
  // Each field at the longest its column allows: 0093's identifier and hash bounds, 0029's
  // acceptance id, the timestamps' 40, a revision number of 1000000, and 0011's 80 for an approver's
  // user id (0017 leaves that column unbounded, but only an app user's id is written to it).
  const long = (prefix: string, length: number) => prefix.padEnd(length, "x");
  const facts: DepositGateEvidenceFacts = {
    acceptance_binding_id: long("commercial-acceptance:", 120),
    acceptance_id: long("acceptance_", 100).replaceAll("x", "f"),
    receipt_hash: "a".repeat(64),
    accepted_at: long("2026-10-20T16:30:28.759Z", 40),
    quote_revision_id: long("quote-revision:", 160),
    customer_quote_id: long("customer-quote:", 160),
    quote_revision_number: 1_000_000,
    terms_hash: "b".repeat(64),
    terms_json: JSON.stringify({ deposit_percent: 100, payment_schedule: ["deposit", "completion"] }),
    policy_permit_id: long("permit:", 120),
    permit_actor_type: "external_authority",
    permit_actor_id: long("actor:", 160),
    quote_revision_approval_id: null,
    approval_approved_by_user_id: null,
    proposal_revision_id: long("proposal-revision:", 160),
    publication_event_id: long("publication:", 120),
    quote_evidence_digest: "c".repeat(64),
    proposal_evidence_digest: "d".repeat(64),
    publication_evidence_digest: "e".repeat(64),
    in_force_binding_id: long("commercial-acceptance:in-force:", 120),
  };
  const policy = { policy: "od01_payment_on_completion", version: 1_000_000 } as const;
  const widest = [
    depositGateEvidence(facts, { basis: "contract_superseded", reverses_id: `pgc_${"f".repeat(40)}` }, policy),
    depositGateEvidence(
      {
        ...facts,
        terms_json: JSON.stringify({ deposit_percent: 0, payment_schedule: ["completion"] }),
        policy_permit_id: null,
        permit_actor_type: null,
        permit_actor_id: null,
        quote_revision_approval_id: long("quote-approval:", 120),
        approval_approved_by_user_id: long("appu_", 80),
      },
      { basis: "contract_no_deposit", reverses_id: null },
      policy,
    ),
  ];
  for (const evidence of widest) {
    assert.ok(JSON.parse(evidence));
    assert.ok(evidence.length <= 4000, `${evidence.length} characters`);
  }
});
