import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi, type AgentEnv } from "../src/agents/api.ts";
import { readObjectFacts, subjectFacts } from "../src/agents/memory.ts";
import { OBJECT_MODELS } from "../src/agents/read-models.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, type BoundStatement } from "../src/agents/store.ts";
import { recordDepositPolicy } from "./deposit-policy-fixture.ts";

const TENANT = "ironwrap";
const NOW = new Date().toISOString();
const TOKEN = "synthetic-deposit-policy-host-token";
const DEFAULT = { policy: "od01_payment_on_completion", version: 0, revision_id: null, set_at: null };

/** Actual complete schema and transactional D1 surface; no substitute policy store. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  failPolicyRead = false;
  policyReads = 0;
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort())
      this.raw.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  prepare(sql: string) {
    if (/SELECT.*tenant_deposit_policy_revisions/s.test(sql)) {
      this.policyReads++;
      if (this.failPolicyRead) throw new Error("synthetic_policy_read_unavailable");
    }
    return { bind: (...values: unknown[]) => {
      const args = values as Array<string | number | null>;
      return {
        first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
        run: async () => {
          const count = () => Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
          const before = count(); this.raw.prepare(sql).run(...args);
          return { meta: { changes: count() - before } };
        },
      };
    } };
  }
  async batch(statements: BoundStatement[]) {
    this.raw.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.raw.exec("COMMIT"); return result; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
}

function owner(db: SqliteD1, tenant = TENANT, id = "policy_owner") {
  db.raw.prepare(`INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'Synthetic Owner', 'owner', 'owner', 1, 'seed', ?, ?)`)
    .run(id, tenant, `${id}@example.invalid`, NOW, NOW);
}
function business(db: SqliteD1) {
  owner(db);
  db.raw.prepare(`INSERT INTO envelopes (envelope_id, tenant_id, source, payload_json, ts, status, created_at, updated_at)
    VALUES ('ow_policy', ?, 'website', '{}', ?, 'received', ?, ?)` ).run(TENANT, NOW, NOW, NOW);
  db.raw.prepare(`INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email, created_at, updated_at)
    VALUES ('lead_policy', ?, 'ow_policy', 'website', 'Synthetic Lead', 'lead@example.invalid', ?, ?)` ).run(TENANT, NOW, NOW);
  db.raw.prepare(`INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at)
    VALUES ('cus_policy', ?, 'ow_policy', 'Synthetic Customer', 'customer@example.invalid', 'active', ?, ?)` ).run(TENANT, NOW, NOW);
  db.raw.prepare(`INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
    VALUES ('job_policy', ?, 'lead_policy', 'cus_policy', 'ow_policy', 'IW-POLICY', 'Synthetic re-roof', 'qualified', ?, ?)` ).run(TENANT, NOW, NOW);
}
async function localFact(db: SqliteD1, role = "owner", id = TENANT) {
  return readObjectFacts(db, OBJECT_MODELS, TENANT, { role }, "deposit_policy", id, NOW);
}
function api(db: SqliteD1) {
  const env: AgentEnv = { DB: db, AGENT_HOST_TOKEN: TOKEN, APP_TENANT_ID: TENANT };
  return async (method: string, path: string, body?: unknown) => {
    const response = await handleAgentHostApi(new Request(`https://bus.example.invalid${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, () => Date.parse(NOW));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}
async function open(db: SqliteD1, specialist: string, subject = { aggregate: "job", id: "job_policy" }, tenant = TENANT) {
  const signal = await appendSignal(db, tenant, {
    kind: "event", specialist_id: specialist, watch_id: null, source: "synthetic_policy_test", subject,
    content: { text: "Synthetic policy context request." }, dedupe_key: `policy:${specialist}:${subject.aggregate}:${subject.id}:${tenant}`,
  }, NOW);
  assert.ok(!("error" in signal), JSON.stringify(signal));
  const result = await api(db)("POST", "/api/v1/agents/runs", {
    signal_id: signal.signal_id, specialist_id: specialist, host_run_key: `policy-${specialist}-${subject.id}-${tenant}`.padEnd(40, "k"),
  });
  return { ...result, signalId: signal.signal_id };
}
const policyFact = (body: Record<string, any>) => body.context.facts.find((f: { fact_id: string }) => f.fact_id === `deposit_policy/${TENANT}`);
function explain(fact: { fact_id: string; version: number }, label: string) {
  const input = { action_id: "fact.explain", args: { object: null, explanation: label }, citations: [{ fact_id: fact.fact_id, version: fact.version }] };
  return { ...input, step_key: createHash("sha256").update(canonicalJson(input)).digest("hex") };
}

test("local policy default is an exact non-PII tuple with independent fact-ledger version", async () => {
  const db = new SqliteD1();
  for (const role of ["owner", "ops", "sales", "accounting"]) {
    const read = await localFact(db, role); assert.ok(read);
    const fact = read.facts[0]; assert.deepEqual(fact.data, DEFAULT); assert.equal(fact.version, 1);
    assert.deepEqual(Object.keys(fact.data as object).sort(), ["policy", "revision_id", "set_at", "version"]);
    assert.equal(fact.trust, "owned");
  }
  for (const role of ["production", "field", "unknown"]) assert.equal(await localFact(db, role), null);
  const reads = db.policyReads;
  for (const id of ["otherwrap", "mistyped_tenant"]) assert.equal(await localFact(db, "owner", id), null);
  assert.equal(db.policyReads, reads, "foreign ids must not call the defaulting getter");
});

test("latest native row is one consistent tuple; domain revision and ledger version evolve independently", async () => {
  const db = new SqliteD1(); owner(db);
  const initial = await localFact(db); assert.ok(initial);
  recordDepositPolicy(db.raw, { tenantId: TENANT, ownerUserId: "policy_owner", at: NOW });
  const row = db.raw.prepare("SELECT policy, revision, revision_id, set_at FROM tenant_deposit_policy_revisions WHERE tenant_id = ? ORDER BY revision DESC LIMIT 1").get(TENANT) as Record<string, unknown>;
  const read = await localFact(db); assert.ok(read);
  assert.deepEqual(read.facts[0].data, { policy: row.policy, version: row.revision, revision_id: row.revision_id, set_at: row.set_at });
  assert.equal(read.facts[0].version, 2); assert.equal((await localFact(db))?.facts[0].version, 2);
  recordDepositPolicy(db.raw, { tenantId: TENANT, ownerUserId: "policy_owner", policy: "od01_payment_on_completion", at: NOW });
  const next = await localFact(db); assert.ok(next);
  assert.equal((next.facts[0].data as Record<string, unknown>).version, 2); assert.equal(next.facts[0].version, 3);
  assert.notEqual(next.facts[0].hash, initial.facts[0].hash);
});

test("job, lead and customer snapshots deliver policy to actual proposal, billing and owner roles", async () => {
  const db = new SqliteD1(); business(db);
  for (const specialist of ["proposal_contract", "billing_reconciliation", "orchestrator"]) {
    const run = await open(db, specialist); assert.equal(run.status, 201, JSON.stringify(run.body));
    const fact = policyFact(run.body); assert.ok(fact); assert.deepEqual(fact.data, DEFAULT);
    const result = await api(db)("POST", `/api/v1/agents/runs/${run.body.run_id}/steps`, explain(fact, `Synthetic ${specialist} policy explanation.`));
    assert.equal(result.body.decision, "recorded", JSON.stringify(result.body));
    assert.deepEqual(result.body.receipt.sources, [{ fact_id: fact.fact_id, version: fact.version, hash: fact.hash }]);
  }
  for (const aggregate of ["lead", "customer"]) {
    const context = await subjectFacts(db, OBJECT_MODELS, TENANT, { role: "sales" }, { aggregate, id: aggregate === "lead" ? "lead_policy" : "cus_policy" }, NOW);
    assert.ok(context.facts.some((f) => f.fact_id === `deposit_policy/${TENANT}`));
  }
  const denied = await open(db, "scheduler_dispatcher"); assert.equal(denied.status, 201); assert.equal(policyFact(denied.body), undefined);
});

test("a policy change invalidates an old native API citation and a fresh run uses the new tuple", async () => {
  const db = new SqliteD1(); business(db);
  const first = await open(db, "proposal_contract"); assert.equal(first.status, 201);
  const old = policyFact(first.body); assert.ok(old);
  recordDepositPolicy(db.raw, { tenantId: TENANT, ownerUserId: "policy_owner", at: NOW });
  const stale = await api(db)("POST", `/api/v1/agents/runs/${first.body.run_id}/steps`, explain(old, "Synthetic old policy citation."));
  assert.equal(stale.body.decision, "abstained"); assert.ok(stale.body.reason_codes.includes("fact_stale"), JSON.stringify(stale.body));
  const fresh = await open(db, "orchestrator"); assert.equal(fresh.status, 201);
  const current = policyFact(fresh.body); assert.equal(current.data.policy, "md13_deposit"); assert.equal(current.data.version, 1); assert.equal(current.version, 2);
  const resumed = await api(db)("POST", "/api/v1/agents/runs", { signal_id: first.signalId, specialist_id: "proposal_contract", host_run_key: `policy-proposal_contract-job_policy-${TENANT}`.padEnd(40, "k") });
  assert.equal(policyFact(resumed.body).data, null); assert.equal(policyFact(resumed.body).current, false);
});

test("foreign tenant rows, ids and signals cannot become a local policy default or leak", async () => {
  const db = new SqliteD1(); business(db); owner(db, "otherwrap", "foreign_owner");
  recordDepositPolicy(db.raw, { tenantId: "otherwrap", ownerUserId: "foreign_owner", at: NOW });
  assert.deepEqual((await localFact(db))?.facts[0].data, DEFAULT);
  const wrongId = await open(db, "orchestrator", { aggregate: "deposit_policy", id: "otherwrap" });
  assert.equal(wrongId.status, 201); assert.equal(policyFact(wrongId.body), undefined);
  const foreignSignal = await open(db, "orchestrator", { aggregate: "deposit_policy", id: "otherwrap" }, "otherwrap");
  assert.equal(foreignSignal.status, 422); assert.equal(foreignSignal.body.error, "signal_not_found");
});

test("policy query failure is explicitly omitted and never converted to the OD01 default", async () => {
  const db = new SqliteD1(); business(db); db.failPolicyRead = true;
  await assert.rejects(localFact(db), /synthetic_policy_read_unavailable/);
  const run = await open(db, "proposal_contract"); assert.equal(run.status, 201);
  assert.equal(policyFact(run.body), undefined);
  assert.ok(run.body.context.omitted.some((f: { fact_id: string; reason: string }) => f.fact_id === `deposit_policy/${TENANT}` && f.reason === "unreadable"));
});
