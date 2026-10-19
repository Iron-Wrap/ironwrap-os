// production-gate-clearance.test.ts - the gate routes append to the ledger, and only people use them.
//
// ELEC-120 finding 3 was that nothing in the product could move a scheduling gate off `blocked`.
// These cases drive the real routes, through a person's real cookie session, the real runway read
// and a real R2 receipt, into the migration 0153 ledger, and assert what the ledger, the gate row
// and the audit log hold afterwards - not that the module agrees with itself. D1's own refusals
// are proved directly in production-gate-clearances.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import {
  CLEARABLE_PRODUCTION_GATES,
  depositSettlementReceipt,
  isWaivableProductionGate,
  parseProductionGateClearance,
  parseProductionGateWaiverDecision,
  settledDepositIntent,
  settlementObservedAt,
} from "../src/production-gate-clearance.ts";
import type { AccountingIntentRecord } from "../src/accounting-intents.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

// Synthetic fixtures only: reserved example.invalid identities and run-relative times.
const TENANT = "ironwrap";
const PEPPER = "synthetic-gate-ledger-route-pepper-0123456789";
const JOB_ID = "job:elec122";
const KEY = "gate-clearance-key-0000000001";
const SEED_CREATED_BY = "system:owner_directed_qa_seed_grant";
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const CLEARANCE_PATH = (gate: string, job = JOB_ID) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/clearance`;
const DECISION_PATH = (gate: string, job = JOB_ID) =>
  `/api/v1/production/jobs/${encodeURIComponent(job)}/gates/${gate}/waiver-decisions`;

const USERS = {
  owner: { id: "appu_owner_gate_0001", role: "owner", access: "owner" },
  secondOwner: { id: "appu_owner_gate_0002", role: "owner", access: "owner" },
  production: { id: "appu_production_gate", role: "ops", access: "production" },
  ops: { id: "appu_ops_gate_000001", role: "ops", access: "ops" },
  seed: { id: "appu_seed_owner_gate", role: "owner", access: "owner" },
  accounting: { id: "appu_accounting_gate", role: "ops", access: "accounting" },
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

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();
  failNextPut = false;

  async head(key: string) {
    return this.objects.get(key)?.object ?? null;
  }

  async put(
    key: string,
    value: string,
    options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown },
  ) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("r2_unavailable");
    }
    if (this.objects.has(key) && options.onlyIf) return null;
    const checksum = Buffer.from(options.sha256 ?? "", "hex");
    this.objects.set(key, {
      body: value,
      object: {
        size: new TextEncoder().encode(value).byteLength,
        checksums: {
          sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength),
        },
        customMetadata: options.customMetadata,
      },
    });
    return this.objects.get(key)!.object;
  }
}

interface Harness {
  env: AppEnv;
  db: TestD1;
  raw: MemoryR2;
}

function insertUser(db: TestD1, user: { id: string; role: string; access: string }, createdBy = "owner@example.invalid") {
  db.sqlite.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(user.id, TENANT, `${user.id}@example.invalid`, `Synthetic ${user.access}`, user.role, user.access, createdBy, at(-60), at(-60));
}

function seedJob(db: TestD1, jobId = JOB_ID, suffix = "0001"): void {
  const now = "2026-08-20T10:00:00.000Z";
  const email = `gate-${suffix}@example.invalid`;
  db.sqlite.prepare(
    `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
        created_at, updated_at)
     VALUES (?, 'manual', 'Gate Customer', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(`ow_gate_clearance_${suffix}`, email, `raw/gate/${suffix}.json`, now, now, now);
  db.sqlite.prepare(
    `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'Gate Customer', ?, 'qualified', 1, ?, ?)`,
  ).run(`lead:gate:${suffix}`, TENANT, `ow_gate_clearance_${suffix}`, email, now, now);
  db.sqlite.prepare(
    `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
        lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'Gate Customer', ?, 'active', 1, ?, ?)`,
  ).run(`customer:gate:${suffix}`, TENANT, `ow_gate_clearance_${suffix}`, email, now, now);
  db.sqlite.prepare(
    `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
        service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ironwrap', ?, 'Roofing', 'qualified', 'blocked', 1, ?, ?)`,
  ).run(jobId, TENANT, `lead:gate:${suffix}`, `customer:gate:${suffix}`, `ow_gate_clearance_${suffix}`, `IW-122-${suffix}`, now, now);
  for (const gate of CLEARABLE_PRODUCTION_GATES) {
    db.sqlite.prepare(
      `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at,
          due_at, blocker_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'owner@example.invalid', ?, '2026-08-21T12:00:00.000Z',
               'No active blocker', ?, ?)`,
    ).run(`gate:${suffix}:${gate.toLowerCase()}`, TENANT, jobId, `ow_gate_clearance_${suffix}`, gate, now, now, now);
  }
}

/** Seed one money-lane row in the state an authenticated read-back would have left. */
function seedDepositIntent(db: TestD1, overrides: Partial<AccountingIntentRecord> = {}): void {
  const row: Record<string, unknown> = {
    intent_id: "acct-intent-deposit-0000001",
    tenant_id: TENANT,
    kind: "deposit_invoice",
    roof_job_id: JOB_ID,
    basis_json: "{}",
    basis_sha256: "a".repeat(64),
    source_documents_json: "[]",
    expected_sha256: "b".repeat(64),
    tax_policy_snapshot_sha256: "e".repeat(64),
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_payload_json: "{}",
    provider_payload_sha256: "c".repeat(64),
    provider_request_id: "req-deposit-0000000000001",
    currency: "CAD",
    subtotal: "5000.00",
    tax_amount: "250.00",
    total_amount: "5250.00",
    settled_amount: "5250.00",
    authority_permit_ref: "permit:test",
    authority_policy_ref: "policy:test",
    authority_policy_version: "1",
    authority_max_amount: "100000.00",
    effect_id: "effect:deposit-0000000000001",
    effect_idempotency_key: "effect-key-deposit-000000001",
    state: "reconciled",
    version: 1,
    derived_by_actor_kind: "owner",
    derived_by_user_id: USERS.owner.id,
    derived_at: "2026-08-20T12:00:00.000Z",
    approved_by_user_id: USERS.accounting.id,
    approved_at: "2026-08-20T12:02:00.000Z",
    provider_entity_id: "1042",
    // `reconciled` is only legal when the observed fact set matches the expected one.
    observed_sha256: "b".repeat(64),
    provider_submitted_at: "2026-08-20T12:05:00.000Z",
    provider_reconciled_at: "2026-08-20T12:10:00.000Z",
    created_at: "2026-08-20T12:00:00.000Z",
    updated_at: "2026-08-20T12:10:00.000Z",
    ...overrides,
  };
  const columns = Object.keys(row);
  db.sqlite.prepare(
    `INSERT INTO accounting_intents (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(columns.map((column) => row[column]) as never[]));
}

/**
 * The full migration chain, one roof job with six blocked gates, and the people who touch them:
 * one active owner, production, ops, and the QA seed owner, who never counts as a holder.
 */
function setup(options: { secondOwner?: boolean } = {}): Harness {
  const db = new TestD1();
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    db.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  insertUser(db, USERS.owner);
  insertUser(db, USERS.production);
  insertUser(db, USERS.ops);
  insertUser(db, USERS.seed, SEED_CREATED_BY);
  insertUser(db, USERS.accounting);
  if (options.secondOwner) insertUser(db, USERS.secondOwner);
  seedJob(db);
  const raw = new MemoryR2();
  const env = {
    DB: db as never,
    RAW: raw as never,
    APP_TENANT_ID: TENANT,
    APP_AUTH_PEPPER: PEPPER,
    APP_TIME_ZONE: "America/Edmonton",
  } as AppEnv;
  return { env, db, raw };
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

/** A signed-in role without a person's cookie token: a connector, an agent host, a service token. */
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
      frappe_user_id: role === "owner" ? "owner@example.invalid" : null,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

async function post(
  h: Harness,
  auth: AuthContext,
  path: string,
  body: Record<string, unknown>,
  options: { idempotency?: string | null; csrf?: string | null } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers = new Headers({ "content-type": "application/json" });
  const csrf = options.csrf === undefined ? auth.csrfToken : options.csrf;
  if (csrf) headers.set("x-csrf-token", csrf);
  if (options.idempotency !== null) headers.set("idempotency-key", options.idempotency ?? KEY);
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    h.env,
    auth,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function gate(h: Harness, name: string, jobId = JOB_ID): Record<string, unknown> {
  return {
    ...(h.db.sqlite.prepare(
      `SELECT state, version, clearance_basis, clearance_decision_id, cleared_by_user_id,
              evidence_refs_json
         FROM operating_production_gates WHERE tenant_id = ? AND roof_job_id = ? AND gate = ?`,
    ).get(TENANT, jobId, name) as Record<string, unknown>),
  };
}

function entries(h: Harness, name?: string): Array<Record<string, any>> {
  return h.db.sqlite.prepare(
    `SELECT clearance_id, gate, entry_kind, basis, to_state, from_gate_version, request_id,
            actor_user_id, actor_role, requested_by, self_approval, self_approval_basis, reason,
            evidence_refs_json
       FROM production_gate_clearances
      WHERE ? IS NULL OR gate = ?
      ORDER BY from_gate_version, rowid`,
  ).all(name ?? null, name ?? null).map((row) => ({ ...row }));
}

function auditRows(h: Harness, clearanceId: string): Array<Record<string, unknown>> {
  return h.db.sqlite.prepare(
    `SELECT action, approved_by, source_ids, reason FROM audit_log WHERE run_id = ?`,
  ).all(clearanceId).map((row) => ({ ...row }));
}

const WAIVER = { basis: "office_waiver", reason: "Panels staged at the shop and released for delivery." };

test("a connector, agent or service token never moves a gate, even with an owner role", async () => {
  const h = setup();
  for (const path of [CLEARANCE_PATH("Materials"), DECISION_PATH("Materials")]) {
    const body = path.endsWith("clearance")
      ? WAIVER
      : { request_id: `pgc_${"0".repeat(40)}`, expected_gate_version: 1, decision: "approve", reason: WAIVER.reason };
    const machineCall = await post(h, machine("owner"), path, body);
    assert.equal(machineCall.status, 403);
    assert.equal(machineCall.body.error, "person_session_required");
    // An empty token and an empty CSRF still never make a person.
    const anonymous = { ...machine("owner"), rawSessionToken: "", csrfToken: "" };
    const empty = await post(h, anonymous, path, body, { csrf: null });
    assert.equal(empty.status, 403);
    assert.equal(empty.body.error, "person_session_required");
  }
  assert.deepEqual(entries(h), []);
  assert.equal(gate(h, "Materials").version, 1);
});

test("CSRF is checked first, then the person, then the operation set and the idempotency key", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const noCsrf = await post(h, owner, CLEARANCE_PATH("Access"), WAIVER, { csrf: null });
  assert.deepEqual([noCsrf.status, noCsrf.body.error], [403, "csrf_failed"]);
  const wrongCsrf = await post(h, owner, CLEARANCE_PATH("Access"), WAIVER, { csrf: "forged" });
  assert.deepEqual([wrongCsrf.status, wrongCsrf.body.error], [403, "csrf_failed"]);
  const machineNoCsrf = await post(h, machine("owner"), CLEARANCE_PATH("Access"), WAIVER, { csrf: null });
  assert.deepEqual([machineNoCsrf.status, machineNoCsrf.body.error], [403, "csrf_failed"]);
  const ops = await person(h, USERS.ops.id);
  const forbidden = await post(h, ops, CLEARANCE_PATH("Weather"), WAIVER);
  assert.deepEqual([forbidden.status, forbidden.body.error], [403, "production_gate_clearance_forbidden"]);
  const noKey = await post(h, owner, CLEARANCE_PATH("Access"), WAIVER, { idempotency: null });
  assert.deepEqual([noKey.status, noKey.body.error], [400, "idempotency_key_required"]);
  const production = await person(h, USERS.production.id);
  const productionDecides = await post(h, production, DECISION_PATH("Access"), {
    request_id: `pgc_${"0".repeat(40)}`,
    expected_gate_version: 1,
    decision: "approve",
    reason: WAIVER.reason,
  });
  assert.deepEqual(
    [productionDecides.status, productionDecides.body.error],
    [403, "production_gate_waiver_decision_forbidden"],
  );
  assert.deepEqual(entries(h), []);
});

test("Completion is not clearable here, and a job off the caller's runway has no gate to clear", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const completion = await post(h, owner, CLEARANCE_PATH("Completion"), WAIVER);
  assert.deepEqual([completion.status, completion.body.error], [400, "invalid_production_gate_clearance"]);
  const elsewhere = await post(h, owner, CLEARANCE_PATH("Materials", "job:not-on-runway"), WAIVER);
  assert.deepEqual([elsewhere.status, elsewhere.body.error], [409, "production_gate_job_not_on_runway"]);
  for (const reason of ["", "ok", " ".repeat(20)]) {
    const result = await post(h, owner, CLEARANCE_PATH("Access"), { basis: "office_waiver", reason });
    assert.deepEqual([result.status, result.body.error], [400, "invalid_production_gate_clearance"]);
  }
  assert.deepEqual(entries(h), []);
});

test("Safety, Weather and Crew are never waivable, not even by the only owner", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  for (const name of ["Safety", "Weather", "Crew"]) {
    const result = await post(h, owner, CLEARANCE_PATH(name), WAIVER, { idempotency: `gate-clearance-${name}-0000001` });
    assert.deepEqual([result.status, result.body.error], [409, "production_gate_not_waivable"], name);
    const decision = await post(h, owner, DECISION_PATH(name), {
      request_id: `pgc_${"0".repeat(40)}`,
      expected_gate_version: 1,
      decision: "approve",
      reason: WAIVER.reason,
    });
    assert.deepEqual([decision.status, decision.body.error], [409, "production_gate_not_waivable"], name);
    assert.deepEqual({ state: gate(h, name).state, version: gate(h, name).version }, { state: "blocked", version: 1 });
  }
  assert.deepEqual(entries(h), []);
});

test("production cannot waive: its waiver is a request, and the owner decides it", async () => {
  const h = setup();
  const production = await person(h, USERS.production.id);
  const requested = await post(h, production, CLEARANCE_PATH("Materials"), WAIVER);
  assert.equal(requested.status, 409);
  assert.deepEqual(requested.body, { error: "production_gate_waiver_requested" });
  const [request] = entries(h, "Materials");
  assert.deepEqual(
    { ...request, clearance_id: undefined },
    {
      clearance_id: undefined,
      gate: "Materials",
      entry_kind: "waiver_request",
      basis: "office_waiver",
      to_state: "blocked",
      from_gate_version: 1,
      request_id: null,
      actor_user_id: USERS.production.id,
      actor_role: "production",
      requested_by: null,
      self_approval: 0,
      self_approval_basis: null,
      reason: WAIVER.reason,
      evidence_refs_json: null,
    },
  );
  assert.deepEqual(gate(h, "Materials"), {
    state: "blocked",
    version: 2,
    clearance_basis: null,
    clearance_decision_id: null,
    cleared_by_user_id: null,
    evidence_refs_json: null,
  });
  assert.equal(auditRows(h, request!.clearance_id).length, 1);
  // A replay of the request answers the same and appends nothing.
  const again = await post(h, production, CLEARANCE_PATH("Materials"), WAIVER);
  assert.deepEqual([again.status, again.body.error], [409, "production_gate_waiver_requested"]);
  assert.equal(entries(h).length, 1);

  const owner = await person(h, USERS.owner.id);
  const decide = (version: number, key = "gate-waiver-decision-0000000001") =>
    post(h, owner, DECISION_PATH("Materials"), {
      request_id: request!.clearance_id,
      expected_gate_version: version,
      decision: "approve",
      reason: "Owner approves: the shop holds every panel for this job.",
    }, { idempotency: key });
  const stale = await decide(1, "gate-waiver-decision-stale-00001");
  assert.deepEqual([stale.status, stale.body.error], [409, "production_gate_version_conflict"]);
  const approved = await decide(2);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.decision.decision, "approve");
  assert.equal(approved.body.decision.requested_by, USERS.production.id);
  assert.equal(approved.body.decision.decided_by, USERS.owner.id);
  assert.equal(approved.body.decision.self_approval, false);
  assert.deepEqual(approved.body.gate, {
    name: "gate:0001:materials",
    gate: "Materials",
    roof_job: JOB_ID,
    state: "waived",
    version: 3,
  });
  assert.equal(approved.body.replayed, false);
  assert.deepEqual(
    { state: gate(h, "Materials").state, basis: gate(h, "Materials").clearance_basis, by: gate(h, "Materials").cleared_by_user_id },
    { state: "waived", basis: "office_waiver", by: USERS.owner.id },
  );
  const replayed = await decide(2);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replayed, true);
  const twice = await decide(3, "gate-waiver-decision-0000000002");
  assert.deepEqual([twice.status, twice.body.error], [409, "production_gate_already_cleared"]);
  assert.equal(entries(h).length, 2);
});

test("the only owner approves their own waiver with a reason, recorded as a self-approval", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const reason = "No deposit on this insurance restoration file; the carrier pays on completion.";
  const result = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "office_waiver", reason });
  assert.equal(result.status, 200);
  // The runway's strict response: exactly these keys, nothing new.
  assert.deepEqual(result.body, {
    gate: { name: "gate:0001:deposit", gate: "Deposit", roof_job: JOB_ID, state: "Waived" },
    basis: "office_waiver",
    clearance: "waived",
    evidence_item: null,
    actor_role: "owner",
    replayed: false,
  });
  const [entry] = entries(h, "Deposit");
  assert.equal(entry!.entry_kind, "waiver_decision");
  assert.equal(entry!.request_id, null);
  assert.equal(entry!.requested_by, USERS.owner.id);
  assert.equal(entry!.actor_user_id, USERS.owner.id);
  assert.equal(entry!.self_approval, 1);
  assert.equal(entry!.self_approval_basis, "only_holder");
  assert.equal(entry!.reason, reason);
  assert.equal(entry!.evidence_refs_json, null, "the reason stays out of structured evidence");
  assert.deepEqual(gate(h, "Deposit"), {
    state: "waived",
    version: 2,
    clearance_basis: "office_waiver",
    clearance_decision_id: entry!.clearance_id,
    cleared_by_user_id: USERS.owner.id,
    evidence_refs_json: null,
  });
  // The receipt of the self-approval: one audit row naming it, and no free text in it.
  assert.deepEqual(auditRows(h, entry!.clearance_id), [{
    action: "waiver_decision:office_waiver",
    approved_by: USERS.owner.id,
    source_ids: `job:${JOB_ID},gate:Deposit,from_version:1,to_state:waived,self_approval:only_holder`,
    reason: null,
  }]);
  // A waiver is never mistaken for settled money: no receipt in immutable storage.
  assert.equal(h.raw.objects.size, 0);
});

test("with a second owner active, the requester cannot approve their own waiver and the other owner decides", async () => {
  const h = setup({ secondOwner: true });
  const owner = await person(h, USERS.owner.id);
  const secondOwner = await person(h, USERS.secondOwner.id);
  const requested = await post(h, owner, CLEARANCE_PATH("Access"), WAIVER);
  assert.deepEqual([requested.status, requested.body.error], [409, "production_gate_waiver_requested"]);
  const [request] = entries(h, "Access");
  assert.equal(request!.entry_kind, "waiver_request");
  const decision = (decision: "approve" | "decline", version: number, key: string, requestId = request!.clearance_id) => ({
    body: { request_id: requestId, expected_gate_version: version, decision, reason: "Access confirmed with the property manager." },
    key,
  });

  const own = decision("approve", 2, "gate-waiver-decision-own-0000001");
  const refused = await post(h, owner, DECISION_PATH("Access"), own.body, { idempotency: own.key });
  assert.deepEqual([refused.status, refused.body.error], [409, "production_gate_waiver_self_approval_refused"]);
  const ownDecline = decision("decline", 2, "gate-waiver-decision-own-0000002");
  const refusedDecline = await post(h, owner, DECISION_PATH("Access"), ownDecline.body, { idempotency: ownDecline.key });
  assert.deepEqual([refusedDecline.status, refusedDecline.body.error], [409, "production_gate_waiver_self_approval_refused"]);
  assert.equal(entries(h).length, 1);

  const declined = decision("decline", 2, "gate-waiver-decision-other-00001");
  const declinedResult = await post(h, secondOwner, DECISION_PATH("Access"), declined.body, { idempotency: declined.key });
  assert.equal(declinedResult.status, 200);
  assert.equal(declinedResult.body.decision.decision, "decline");
  assert.deepEqual({ state: gate(h, "Access").state, version: gate(h, "Access").version }, { state: "blocked", version: 3 });
  const again = decision("approve", 3, "gate-waiver-decision-other-00002");
  const decidedTwice = await post(h, secondOwner, DECISION_PATH("Access"), again.body, { idempotency: again.key });
  assert.deepEqual([decidedTwice.status, decidedTwice.body.error], [409, "production_gate_waiver_already_decided"]);

  // A fresh request; the other owner approves it.
  const second = await post(h, owner, CLEARANCE_PATH("Access"), WAIVER, { idempotency: "gate-clearance-key-0000000002" });
  assert.deepEqual([second.status, second.body.error], [409, "production_gate_waiver_requested"]);
  const secondRequest = entries(h, "Access").at(-1)!;
  const approve = decision("approve", 4, "gate-waiver-decision-other-00003", secondRequest.clearance_id);
  const approved = await post(h, secondOwner, DECISION_PATH("Access"), approve.body, { idempotency: approve.key });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.decision.self_approval, false);
  assert.equal(gate(h, "Access").state, "waived");
  for (const entry of entries(h)) assert.equal(auditRows(h, entry.clearance_id).length, 1);
});

test("once the other owner leaves, the requester is the only holder and may approve their own request", async () => {
  const h = setup({ secondOwner: true });
  const owner = await person(h, USERS.owner.id);
  await post(h, owner, CLEARANCE_PATH("Materials"), WAIVER);
  const [request] = entries(h, "Materials");
  h.db.sqlite.prepare("UPDATE app_users SET active = 0 WHERE user_id = ?").run(USERS.secondOwner.id);
  const approved = await post(h, owner, DECISION_PATH("Materials"), {
    request_id: request!.clearance_id,
    expected_gate_version: 2,
    decision: "approve",
    reason: "Only holder now: panels confirmed staged at the shop.",
  }, { idempotency: "gate-waiver-decision-own-0000003" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.decision.self_approval, true);
  assert.equal(approved.body.decision.self_approval_basis, "only_holder");
  assert.equal(gate(h, "Materials").state, "waived");
});

test("the QA seed owner is refused on every route, and never stands in as another holder", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  const seed = await person(h, USERS.seed.id);
  const waiver = await post(h, seed, CLEARANCE_PATH("Materials"), WAIVER);
  assert.deepEqual([waiver.status, waiver.body.error], [403, "production_gate_clearance_seed_identity_refused"]);
  const settlement = await post(h, seed, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" }, {
    idempotency: "gate-clearance-seed-settlement-01",
  });
  assert.deepEqual([settlement.status, settlement.body.error], [403, "production_gate_clearance_seed_identity_refused"]);
  const production = await person(h, USERS.production.id);
  await post(h, production, CLEARANCE_PATH("Access"), WAIVER, { idempotency: "gate-clearance-production-000001" });
  const [request] = entries(h, "Access");
  const decided = await post(h, seed, DECISION_PATH("Access"), {
    request_id: request!.clearance_id,
    expected_gate_version: 2,
    decision: "approve",
    reason: "The seed identity must never decide a waiver.",
  }, { idempotency: "gate-waiver-decision-seed-000001" });
  assert.deepEqual([decided.status, decided.body.error], [403, "production_gate_clearance_seed_identity_refused"]);
  assert.equal(entries(h).length, 1);
  assert.deepEqual(
    [gate(h, "Materials").state, gate(h, "Deposit").state, gate(h, "Access").state],
    ["blocked", "blocked", "blocked"],
  );
  // The active seed owner does not make the real owner one of two holders.
  const owner = await person(h, USERS.owner.id);
  const own = await post(h, owner, CLEARANCE_PATH("Materials"), WAIVER, { idempotency: "gate-clearance-owner-0000000001" });
  assert.equal(own.status, 200);
  assert.equal(own.body.clearance, "waived");
});

test("the Deposit gate refuses a settlement the money lane has not settled", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const none = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.deepEqual([none.status, none.body.error], [409, "deposit_settlement_not_observed"]);
  seedDepositIntent(h.db, { state: "partially_settled", settled_amount: "100.00", provider_reconciled_at: null });
  const partial = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.deepEqual([partial.status, partial.body.error], [409, "deposit_settlement_not_observed"]);
  assert.equal(h.raw.objects.size, 0);
  assert.deepEqual(entries(h), []);
  assert.deepEqual({ state: gate(h, "Deposit").state, version: gate(h, "Deposit").version }, { state: "blocked", version: 1 });
});

test("a settled deposit invoice clears the gate on a stored, hashed receipt named by its ledger entry", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  const production = await person(h, USERS.production.id);
  const result = await post(h, production, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.equal(result.status, 200);
  const [entry] = entries(h, "Deposit");
  assert.deepEqual(result.body, {
    gate: { name: "gate:0001:deposit", gate: "Deposit", roof_job: JOB_ID, state: "Ready" },
    basis: "deposit_settlement",
    clearance: "verified",
    evidence_item: `gate-clearance:${entry!.clearance_id}`,
    actor_role: "production",
    replayed: false,
  });
  assert.equal(entry!.entry_kind, "clear");
  assert.equal(entry!.to_state, "complete");
  assert.equal(entry!.reason, null);

  const [stored] = [...h.raw.objects.entries()];
  assert.match(stored![0], /^production-gate-clearance\/v1\/[a-f0-9]{64}\.json$/);
  const receipt = JSON.parse(stored![1].body) as Record<string, unknown>;
  assert.equal(receipt.kind, "production_gate_clearance");
  assert.equal(receipt.basis, "deposit_settlement");
  assert.equal(receipt.decision_id, entry!.clearance_id);
  assert.equal(receipt.cleared_by_user_id, USERS.production.id);
  assert.equal(receipt.settlement_observed_at, "2026-08-20T12:10:00.000Z");
  assert.deepEqual(receipt.money_intent, {
    intent_id: "acct-intent-deposit-0000001",
    kind: "deposit_invoice",
    state: "reconciled",
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_entity_id: "1042",
    currency: "CAD",
    total_amount: "5250.00",
    settled_amount: "5250.00",
    observed_sha256: "b".repeat(64),
    provider_reconciled_at: "2026-08-20T12:10:00.000Z",
  });

  const row = gate(h, "Deposit");
  assert.equal(row.state, "complete");
  assert.equal(row.clearance_basis, "deposit_settlement");
  assert.equal(row.clearance_decision_id, entry!.clearance_id);
  assert.equal(row.evidence_refs_json, entry!.evidence_refs_json);
  const evidence = JSON.parse(String(row.evidence_refs_json)) as Record<string, unknown>;
  assert.equal(evidence.r2_key, stored![0]);
  assert.equal(evidence.content_checksum, createHash("sha256").update(stored![1].body).digest("hex"));
  assert.equal(evidence.content_length, new TextEncoder().encode(stored![1].body).byteLength);
  assert.equal(evidence.money_intent_id, "acct-intent-deposit-0000001");
  assert.equal(auditRows(h, entry!.clearance_id).length, 1);
});

test("the same settlement twice converges on one receipt and one entry", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  const owner = await person(h, USERS.owner.id);
  const first = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  const [r2Key] = h.raw.objects.keys();
  const storedBody = h.raw.objects.get(r2Key!)!.body;
  const second = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.evidence_item, first.body.evidence_item);
  assert.equal(h.raw.objects.size, 1);
  assert.equal(h.raw.objects.get(r2Key!)!.body, storedBody);
  assert.equal(entries(h).length, 1);
  assert.equal(gate(h, "Deposit").version, 2);
});

test("a conflicting replay of a settlement key preserves the receipt, the entry and the gate", async () => {
  const h = setup({ secondOwner: true });
  seedDepositIntent(h.db);
  const owner = await person(h, USERS.owner.id);
  assert.equal((await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" })).status, 200);
  const [r2Key] = h.raw.objects.keys();
  const before = { receipt: h.raw.objects.get(r2Key!)!.body, gate: gate(h, "Deposit"), entries: entries(h) };

  const otherActor = await post(h, await person(h, USERS.secondOwner.id), CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.deepEqual([otherActor.status, otherActor.body.error], [409, "production_gate_clearance_replay_conflict"]);
  const otherBody = await post(h, owner, CLEARANCE_PATH("Deposit"), {
    basis: "office_waiver",
    reason: "Carrier exception approved for this restoration project.",
  });
  assert.deepEqual([otherBody.status, otherBody.body.error], [409, "production_gate_clearance_replay_conflict"]);
  // The key names one request in the tenant: the same key on another job is a conflict too.
  seedJob(h.db, "job:elec123", "0002");
  const otherJob = await post(h, owner, CLEARANCE_PATH("Deposit", "job:elec123"), { basis: "deposit_settlement" });
  assert.deepEqual([otherJob.status, otherJob.body.error], [409, "production_gate_clearance_replay_conflict"]);

  assert.equal(h.raw.objects.size, 1);
  assert.equal(h.raw.objects.get(r2Key!)!.body, before.receipt);
  assert.deepEqual(gate(h, "Deposit"), before.gate);
  assert.deepEqual(entries(h), before.entries);
  assert.equal(gate(h, "Deposit", "job:elec123").state, "blocked");
});

test("a new decision on a cleared gate is refused before any receipt is stored", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  const owner = await person(h, USERS.owner.id);
  assert.equal((await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" })).status, 200);
  const before = { objects: [...h.raw.objects.keys()], gate: gate(h, "Deposit") };
  const refused = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" }, {
    idempotency: "gate-clearance-key-0000000002",
  });
  assert.deepEqual([refused.status, refused.body.error], [409, "production_gate_already_cleared"]);
  const waiver = await post(h, owner, CLEARANCE_PATH("Deposit"), WAIVER, { idempotency: "gate-clearance-key-0000000003" });
  assert.deepEqual([waiver.status, waiver.body.error], [409, "production_gate_already_cleared"]);
  assert.deepEqual([...h.raw.objects.keys()], before.objects);
  assert.deepEqual(gate(h, "Deposit"), before.gate);
  assert.equal(entries(h).length, 1);
});

test("a receipt that could not be stored never becomes a ledger entry", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  h.raw.failNextPut = true;
  const owner = await person(h, USERS.owner.id);
  const result = await post(h, owner, CLEARANCE_PATH("Deposit"), { basis: "deposit_settlement" });
  assert.deepEqual([result.status, result.body.error], [503, "production_gate_receipt_unavailable"]);
  assert.deepEqual(entries(h), []);
  assert.equal(gate(h, "Deposit").state, "blocked");
});

test("settlement is a Deposit-only basis and takes no caller prose", async () => {
  const h = setup();
  seedDepositIntent(h.db);
  const owner = await person(h, USERS.owner.id);
  const wrongGate = await post(h, owner, CLEARANCE_PATH("Crew"), { basis: "deposit_settlement" });
  assert.equal(wrongGate.status, 400);
  const withReason = await post(h, owner, CLEARANCE_PATH("Deposit"), {
    basis: "deposit_settlement",
    reason: "The customer told me they paid.",
  });
  assert.equal(withReason.status, 400);
  assert.deepEqual(entries(h), []);
});

test("the same waiver key replays the stored entry, and a changed reason under it conflicts", async () => {
  const h = setup();
  const owner = await person(h, USERS.owner.id);
  const body = { basis: "office_waiver", reason: "Homeowner confirmed the side-yard gate stays unlocked." };
  const first = await post(h, owner, CLEARANCE_PATH("Access"), body);
  const second = await post(h, owner, CLEARANCE_PATH("Access"), body);
  const changed = await post(h, owner, CLEARANCE_PATH("Access"), {
    basis: "office_waiver",
    reason: "A different note about the side-yard gate entirely.",
  });
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, { ...first.body, replayed: true });
  assert.deepEqual([changed.status, changed.body.error], [409, "production_gate_clearance_replay_conflict"]);
  const other = await post(h, owner, CLEARANCE_PATH("Access"), body, { idempotency: "gate-clearance-key-0000000002" });
  assert.deepEqual([other.status, other.body.error], [409, "production_gate_already_cleared"]);
  assert.equal(gate(h, "Access").version, 2);
  assert.equal(entries(h).length, 1);
});

test("the runway advertises the clearing action only to a session that may use it", async () => {
  const h = setup();
  const owner = await handleAuthenticatedRoute(new Request("https://app.example.invalid/api/v1/production"), h.env, machine("owner"));
  const ownerBody = (await owner.json()) as { allowed_actions: string[] };
  assert.ok(ownerBody.allowed_actions.includes("production_gate.clear"));
  const ops = await handleAuthenticatedRoute(new Request("https://app.example.invalid/api/v1/production"), h.env, machine("ops"));
  const opsBody = (await ops.json()) as { allowed_actions: string[] };
  assert.ok(!opsBody.allowed_actions.includes("production_gate.clear"));
});

test("settledDepositIntent requires reconciliation and ignores partial or zero settlement", () => {
  const base = {
    kind: "deposit_invoice",
    settled_amount: "100.00",
    provider_reconciled_at: "2026-08-20T12:00:00.000Z",
  } as unknown as AccountingIntentRecord;
  const partial = { ...base, intent_id: "a", state: "partially_settled" } as AccountingIntentRecord;
  const reconciled = { ...base, intent_id: "b", state: "reconciled" } as AccountingIntentRecord;
  const zero = { ...base, intent_id: "c", state: "reconciled", settled_amount: "0.00" } as AccountingIntentRecord;
  assert.equal(settledDepositIntent([partial, reconciled])?.intent_id, "b");
  assert.equal(settledDepositIntent([partial]), null);
  assert.equal(settledDepositIntent([zero]), null);
  assert.equal(settledDepositIntent([]), null);
  assert.equal(
    settledDepositIntent([{ ...base, intent_id: "d", state: "submitted" } as AccountingIntentRecord]),
    null,
  );
});

test("the receipt is canonical, so the same observation always hashes the same", () => {
  const intent = {
    intent_id: "acct-intent-deposit-0000001",
    kind: "deposit_invoice",
    state: "reconciled",
    provider: "quickbooks",
    realm_id: "realm",
    provider_entity_type: "Invoice",
    provider_entity_id: "1042",
    currency: "CAD",
    total_amount: "5250.00",
    settled_amount: "5250.00",
    observed_sha256: "d".repeat(64),
    provider_reconciled_at: "2026-08-20T12:10:00.000Z",
  } as unknown as AccountingIntentRecord;
  const input = {
    tenantId: TENANT,
    roofJobId: JOB_ID,
    decisionId: `pgc_${"a".repeat(40)}`,
    clearedByUserId: USERS.owner.id,
    intent,
  };
  assert.equal(depositSettlementReceipt(input), depositSettlementReceipt({ ...input }));
  // No wall-clock stamp anywhere in it: R2 stores the receipt immutably, so a "when this ran"
  // field would make every retry collide with its own first attempt. Found that way on a real stack.
  const decoded = JSON.parse(depositSettlementReceipt(input)) as Record<string, unknown>;
  assert.equal(decoded.settlement_observed_at, "2026-08-20T12:10:00.000Z");
  assert.ok(!("observed_at" in decoded));
  assert.equal(settlementObservedAt({ ...intent, provider_reconciled_at: null } as AccountingIntentRecord), null);
  assert.equal(
    settlementObservedAt({
      ...intent,
      provider_reconciled_at: null,
      updated_at: "2026-08-20T12:11:00.000Z",
    } as AccountingIntentRecord),
    "2026-08-20T12:11:00.000Z",
  );
});

// The basis/gate matrix, stated once: settlement is bound to the gate that has a deposit invoice;
// a waiver's body parses on every clearable gate, and the owner ruling decides which may be waived.
test("settlement is Deposit-only, and only Deposit, Materials and Access may be waived", () => {
  for (const gateName of CLEARABLE_PRODUCTION_GATES) {
    assert.ok(
      parseProductionGateClearance(gateName, JOB_ID, KEY, {
        basis: "office_waiver",
        reason: "Recorded by the office against a stated business reason.",
      }),
      `${gateName} parses an office waiver body`,
    );
    const settlement = parseProductionGateClearance(gateName, JOB_ID, KEY, { basis: "deposit_settlement" });
    assert.equal(settlement !== null, gateName === "Deposit", gateName);
    assert.equal(isWaivableProductionGate(gateName), ["Deposit", "Materials", "Access"].includes(gateName), gateName);
  }
  assert.equal(parseProductionGateClearance("Weather", JOB_ID, "short", { basis: "office_waiver" }), null);
  assert.equal(parseProductionGateClearance("Weather", JOB_ID, KEY, { basis: "office_waiver", extra: 1 }), null);
  assert.equal(parseProductionGateClearance("Weather", JOB_ID, KEY, { basis: "nonsense" }), null);
});

test("a waiver decision body has exactly its four keys", () => {
  const body = {
    request_id: `pgc_${"b".repeat(40)}`,
    expected_gate_version: 2,
    decision: "decline",
    reason: "Declined: the materials are not on site yet.",
  };
  assert.deepEqual(parseProductionGateWaiverDecision(body), {
    requestId: body.request_id,
    expectedGateVersion: 2,
    decision: "decline",
    reason: body.reason,
  });
  assert.equal(parseProductionGateWaiverDecision({ ...body, extra: true }), null);
  assert.equal(parseProductionGateWaiverDecision({ ...body, decision: "waive" }), null);
  assert.equal(parseProductionGateWaiverDecision({ ...body, expected_gate_version: 0 }), null);
  assert.equal(parseProductionGateWaiverDecision({ ...body, expected_gate_version: "2" }), null);
  assert.equal(parseProductionGateWaiverDecision({ ...body, request_id: "pgc_short" }), null);
  assert.equal(parseProductionGateWaiverDecision({ ...body, reason: "short" }), null);
  const { reason: _reason, ...withoutReason } = body;
  assert.equal(parseProductionGateWaiverDecision(withoutReason), null);
});
