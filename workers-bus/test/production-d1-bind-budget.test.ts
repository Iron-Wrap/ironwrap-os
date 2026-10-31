import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const AT = new Date(0).toISOString();
const GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
const JOBS = Array.from({ length: 100 }, (_, index) => `job:bind-budget:${String(index).padStart(3, "0")}`);
const OUTSIDE = "job:bind-budget:outside";
const FOREIGN = "job:bind-budget:foreign";
const MAX_D1_BINDINGS = 100;

interface Rows {
  rows: Array<Record<string, unknown>>;
  partial: boolean;
}
type GateRead = (env: AppEnv, tenant: string, ids: readonly string[], state?: string, limit?: number) => Promise<Rows>;
type MaterialRead = (env: AppEnv, tenant: string, ids: readonly string[], limit?: number) => Promise<Rows>;

// Keep the query helpers private in product code. Probe their exact current declarations, with
// the actual shared bounded reader, instead of copying SQL or adding a test-only public export.
function privateReaders(): { gates: GateRead; materials: MaterialRead } {
  const source = readFileSync(new URL("../src/app-read-models.ts", import.meta.url), "utf8");
  function declaration(name: string) {
    const start = source.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `${name} declaration exists`);
    const end = source.indexOf("\nasync function ", start + 1);
    assert.ok(end > start, `${name} declaration has a boundary`);
    return source.slice(start, end);
  }
  const limit = source.match(/const PRODUCTION_SOURCE_LIMIT = \d+;/)?.[0];
  const scheduling = source.match(/const SCHEDULING_PRODUCTION_GATES = \[[\s\S]*?\] as const;/)?.[0];
  assert.ok(limit && scheduling);
  const code = stripTypeScriptTypes([
    limit, scheduling, declaration("boundedNativeRows"),
    declaration("nativeProductionGates"), declaration("nativeMaterialExceptions"),
    "({ gates: nativeProductionGates, materials: nativeMaterialExceptions })",
  ].join("\n"));
  return runInNewContext(code) as { gates: GateRead; materials: MaterialRead };
}

const readers = privateReaders();
const raw = new DatabaseSync(":memory:");
raw.exec("PRAGMA foreign_keys = ON");
const directory = new URL("../migrations/", import.meta.url);
for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
  raw.exec(readFileSync(new URL(file, directory), "utf8"));
}
after(() => raw.close());

function seedTenant(tenant: string) {
  const envelope = `envelope:bind-budget:${tenant}`;
  const lead = `lead:bind-budget:${tenant}`;
  const customer = `customer:bind-budget:${tenant}`;
  raw.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Synthetic lead', ?, '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(envelope, `lead-${tenant}@example.invalid`, `raw/synthetic/${tenant}.json`, AT, AT, AT);
  raw.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
      lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'website', 'Synthetic lead', ?, 'qualified', 1, ?, ?)`,
  ).run(lead, tenant, envelope, `lead-${tenant}@example.invalid`, AT, AT);
  raw.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, display_name, contact_email,
      lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'Synthetic Binding Customer', ?, 'active', 1, ?, ?)`,
  ).run(customer, tenant, envelope, `customer-${tenant}@example.invalid`, AT, AT);
}

function seedJob(tenant: string, job: string, complete = false) {
  raw.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'roof_replacement', ?, ?, 1, ?, ?)`,
  ).run(job, tenant, `lead:bind-budget:${tenant}`, `customer:bind-budget:${tenant}`,
    `envelope:bind-budget:${tenant}`, `SYN-${job}`, complete ? "complete" : "qualified",
    complete ? "complete" : "qualification", AT, AT);
  for (const gate of GATES) {
    raw.prepare(
      `INSERT INTO operating_production_gates
       (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state, owner_user,
        assigned_at, due_at, blocker_reason, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'blocked', 'synthetic@example.invalid', ?, ?,
               'Synthetic gate pending review', 1, ?, ?)`,
    ).run(`gate:${job}:${gate}`, tenant, job, `envelope:bind-budget:${tenant}`, gate, AT, AT, AT, AT);
  }
}

function seedMaterial(id: string, tenant: string, job: string, status = "open", type = "shortage", scope = "roof_job", clock = AT) {
  raw.prepare(
    `INSERT INTO inventory_exceptions
     (exception_id, tenant_id, exception_type, status, aggregate_type, aggregate_id,
      reason_code, expected_json, observed_json, evidence_refs_json, version,
      created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'synthetic_inventory', '{}', '{}', '[]', 1, ?, ?, ?)`,
  ).run(id, tenant, type, status, scope, job, clock, clock,
    ["resolved", "rejected"].includes(status) ? clock : null);
}

seedTenant(TENANT);
seedTenant("iroof");
for (const [index, job] of JOBS.entries()) {
  seedJob(TENANT, job);
  seedMaterial(`exception:bind-budget:${String(index).padStart(3, "0")}`, TENANT, job,
    index % 2 ? "contained" : "open", index % 2 ? "backorder" : "shortage",
    "roof_job", new Date(index * 1_000).toISOString());
}
seedJob(TENANT, OUTSIDE, true);
seedJob("iroof", FOREIGN);
seedMaterial("exception:bind-budget:outside", TENANT, OUTSIDE);
seedMaterial("exception:bind-budget:foreign", "iroof", FOREIGN);
seedMaterial("exception:bind-budget:foreign-local-id", "iroof", JOBS[0]);
seedMaterial("exception:bind-budget:resolved", TENANT, JOBS[0], "resolved");
seedMaterial("exception:bind-budget:wrong-type", TENANT, JOBS[0], "open", "shortage", "service_case");

type Statement = { sql: string; count: number; parameters: unknown[] };
class D1BudgetHarness {
  readonly statements: Statement[] = [];
  readonly maxBindings: number;

  constructor(maxBindings = MAX_D1_BINDINGS) {
    this.maxBindings = maxBindings;
  }

  prepare(sql: string) {
    const statement = raw.prepare(sql);
    return {
      bind: (...parameters: unknown[]) => {
        this.statements.push({ sql, count: parameters.length, parameters });
        if (parameters.length > this.maxBindings) {
          throw new Error(`D1 binding budget exceeded: ${parameters.length} > ${this.maxBindings}`);
        }
        return {
          first: async <T>() => (statement.get(...parameters) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...parameters) as T[] }),
        };
      },
    };
  }

  env(): AppEnv { return { DB: this as never } as AppEnv; }
}

function auth(role: AppRole = "production"): AuthContext {
  return {
    rawSessionToken: "s".repeat(43), csrfToken: "synthetic-bind-budget",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64), session_created_at: AT,
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null,
      user_id: "appu_bind_budget", tenant_id: TENANT, email_normalized: "synthetic@example.invalid",
      display_name: "Synthetic Production", role, frappe_user_id: null, active: 1,
      created_by: "seed", created_at: AT, updated_at: AT,
    },
  };
}

function jsonRows(rows: Rows) {
  return JSON.parse(JSON.stringify(rows));
}

test("100-job boundary: production route succeeds under the actual D1 binding cap", async () => {
  const db = new D1BudgetHarness();
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/production"), db.env(), auth(),
  );
  assert.equal(response.status, 200, JSON.stringify(db.statements.filter((entry) => entry.count > MAX_D1_BINDINGS).map((entry) => ({ count: entry.count, source: entry.sql.includes("FROM inventory_exceptions") ? "materials" : "gates" }))));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json() as {
    partial_sources: string[]; summary: { active_jobs: number; blocked: number };
    jobs: Array<{ id: string; customer_display_name: string | null; address: string | null;
      lane: string; gate_coverage: string; scheduling_preparation_allowed: boolean;
      gate_summary: { blocked: number }; material_attention: Array<{ status: string; requested_delivery_date: string | null }> }>;
  };
  assert.equal(body.summary.active_jobs, 100);
  assert.equal(body.summary.blocked, 100);
  assert.deepEqual(body.partial_sources, []);
  assert.deepEqual(body.jobs.map((job) => job.id), JOBS);
  for (const [index, job] of body.jobs.entries()) {
    assert.equal(job.customer_display_name, "Synthetic Binding Customer");
    assert.equal(job.address, null);
    assert.equal(job.lane, "blocked");
    assert.equal(job.gate_coverage, "complete");
    assert.equal(job.gate_summary.blocked, 6);
    assert.equal(job.scheduling_preparation_allowed, false);
    assert.deepEqual(job.material_attention, [{
      status: index % 2 ? "backorder" : "shortage", requested_delivery_date: null,
    }]);
  }
  assert.ok(db.statements.every((entry) => entry.count <= MAX_D1_BINDINGS));
});

test("100-job boundary: unfiltered gates retain all600 rows and nullable ledger join", async () => {
  const db = new D1BudgetHarness();
  const result = await readers.gates(db.env(), TENANT, JOBS);
  assert.equal(result.rows.length, 600);
  assert.equal(result.partial, false);
  assert.ok(result.rows.every((row) => row.basis_in_force === null));
  assert.deepEqual(result.rows.slice(0, 2).map((row) => row.gate), ["Access", "Crew"]);
  assert.ok(db.statements.every((entry) => entry.count <= MAX_D1_BINDINGS));
});

test("100-job boundary: state-filtered gates retain their extra filter and custom result limit", async () => {
  const db = new D1BudgetHarness();
  const blocked = await readers.gates(db.env(), TENANT, JOBS, "blocked", 2);
  assert.equal(blocked.rows.length, 2);
  assert.equal(blocked.partial, true);
  assert.ok(blocked.rows.every((row) => row.state === "blocked"));
  const other = await readers.gates(db.env(), TENANT, JOBS, "ready");
  assert.equal(other.rows.length, 0);
  assert.equal(other.partial, false);
  assert.ok(db.statements.every((entry) => entry.count <= MAX_D1_BINDINGS));
});

test("100-job boundary: materials preserve statuses, type, tenant, ordering and custom limit", async () => {
  const db = new D1BudgetHarness();
  const result = await readers.materials(db.env(), TENANT, JOBS);
  assert.equal(result.rows.length, 100);
  assert.equal(result.partial, false);
  assert.deepEqual(result.rows.map((row) => row.aggregate_id), [...JOBS].reverse());
  assert.ok(result.rows.every((row) => ["open", "contained"].includes(String(row.status))));
  const bounded = await readers.materials(db.env(), TENANT, JOBS, 2);
  assert.equal(bounded.partial, true);
  assert.deepEqual(bounded.rows.map((row) => row.aggregate_id), JOBS.slice(-2).reverse());
  assert.ok(db.statements.every((entry) => entry.count <= MAX_D1_BINDINGS));
});

test("duplicate IDs deduplicate before100 cap; unselected, foreign and hostile IDs do not broaden reads", async () => {
  const db = new D1BudgetHarness();
  const ids = [...Array(120).fill(JOBS[0]), ...JOBS.slice(1), OUTSIDE, FOREIGN, `') OR 1=1 --`];
  const gates = await readers.gates(db.env(), TENANT, ids);
  const materials = await readers.materials(db.env(), TENANT, ids);
  assert.equal(gates.rows.length, 600);
  assert.equal(materials.rows.length, 100);
  assert.ok(gates.rows.every((row) => JOBS.includes(String(row.roof_job_id))));
  assert.ok(materials.rows.every((row) => JOBS.includes(String(row.aggregate_id))));
  assert.equal((await readers.gates(db.env(), TENANT, [FOREIGN, `') OR 1=1 --`])).rows.length, 0);
  assert.equal((await readers.materials(db.env(), TENANT, [FOREIGN, `') OR 1=1 --`])).rows.length, 0);
  assert.equal((await readers.gates(db.env(), "iroof", [FOREIGN])).rows.length, 6);
  assert.equal((await readers.materials(db.env(), "iroof", [FOREIGN])).rows.length, 1);
});

test("empty ID lists make no SQL call; no-state falsy behavior and query failures remain unchanged", async () => {
  const db = new D1BudgetHarness();
  for (const result of [await readers.gates(db.env(), TENANT, []), await readers.materials(db.env(), TENANT, [])]) {
    assert.equal(result.rows.length, 0);
    assert.equal(result.partial, false);
  }
  assert.equal(db.statements.length, 0);
  assert.deepEqual(jsonRows(await readers.gates(db.env(), TENANT, [JOBS[0]], "")),
    jsonRows(await readers.gates(db.env(), TENANT, [JOBS[0]])));
  const failure = new Error("synthetic database failure");
  const broken = { DB: { prepare: () => { throw failure; } } } as unknown as AppEnv;
  await assert.rejects(readers.gates(broken, TENANT, JOBS), (error) => error === failure);
  await assert.rejects(readers.materials(broken, TENANT, JOBS), (error) => error === failure);
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/production"), broken, auth(),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
});

test("production permission denial still precedes every query", async () => {
  const db = new D1BudgetHarness();
  for (const role of ["field", "sales", "accounting"] as const) {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.invalid/api/v1/production"), db.env(), auth(role),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(db.statements.length, 0);
});
