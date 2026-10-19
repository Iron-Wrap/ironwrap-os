import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  citedFacts,
  factReader,
  factVersion,
  hydrate,
  parseFactId,
  refOf,
  resolvePointer,
  subjectFacts,
  SNAPSHOT_LIMITS,
  type ContextFact,
  type ObjectModel,
  type ObjectRead,
} from "../src/agents/memory.ts";
import { minorUnits } from "../src/agents/read-models.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, openRun, proposeStep, runContext, type BoundStatement, type RunContext, type RunRow } from "../src/agents/store.ts";
import { attestGateInLedger } from "./production-gate-ledger-fixture.ts";

const TENANT = "ironwrap";
const AT = "2026-01-01T00:00:00.000Z";
const sha = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** Real SQLite behind the D1 surface the agent store uses, with trigger-inclusive change counts. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  constructor(files: string[] | "all") {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const names = files === "all" ? readdirSync(new URL("../migrations/", import.meta.url)).filter((file) => /^\d+.*\.sql$/.test(file)).sort() : files;
    for (const file of names) this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        return {
          first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
          run: async () => {
            const count = () => Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
            const before = count();
            this.raw.prepare(sql).run(...args);
            return { meta: { changes: count() - before } };
          },
        };
      },
    };
  }
  async batch(statements: BoundStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

const ledger = () => new SqliteD1(["0202_agent_fact_versions.sql"]);

/** A synthetic in-memory object store: each object has a value and links; `throws` fails a read. */
function models(rows: Record<string, ObjectRead | "throws">, views: Record<string, ObjectModel["views"]>) {
  const result: Record<string, ObjectModel> = {};
  for (const kind of Object.keys(views)) {
    result[kind] = {
      views: views[kind],
      read: async (_db, tenant, id) => {
        const row = tenant === TENANT ? rows[`${kind}/${id}`] : undefined;
        if (row === "throws") throw new Error("D1_ERROR: synthetic read failure");
        return row ?? null;
      },
    };
  }
  return result;
}

const row = (data: unknown, links: ObjectRead["links"] = []): ObjectRead => ({ data, links });
const whole = (permission: string) => ({ permission, pointers: null });
const SIGNAL: ContextFact = { fact_id: "signal/sig_0001", kind: "signal", version: 1, hash: "sha256:00", trust: "untrusted_text", observed_at: AT, fresh_until: null, data: { text: "Synthetic" } };
const reader = (db: SqliteD1, registry: Record<string, ObjectModel>, specialist = "estimator") =>
  factReader(db, registry, TENANT, specialist, AT, async (ref) => (ref.fact_id === SIGNAL.fact_id ? SIGNAL : null));

test("fact ids name an object, an id and optionally one field", () => {
  assert.deepEqual(parseFactId("job/job_0001"), { kind: "job", id: "job_0001", pointer: null });
  assert.deepEqual(parseFactId("job/job_0001#/gates/deposit"), { kind: "job", id: "job_0001", pointer: "/gates/deposit" });
  for (const bad of ["job", "job/", "Job/x", "job/x/y", "job/x#gates", "../job/x", "job/ x"]) assert.equal(parseFactId(bad), null, bad);
  const value = { gates: { deposit: { state: "open" } }, lines: [{ "a/b": 1, "m~n": 2 }] };
  assert.deepEqual(resolvePointer(value, "/gates/deposit"), { state: "open" });
  assert.equal(resolvePointer(value, "/lines/0/a~1b"), 1);
  assert.equal(resolvePointer(value, "/lines/0/m~0n"), 2);
  for (const missing of ["/gates/final", "/lines/1", "/lines/01", "/lines/-", "/toString", "/gates/deposit/state/x", "gates", "X/deposit"])
    assert.equal(resolvePointer(value, missing), undefined, missing);
  assert.equal(minorUnits("9860.00"), 986000);
  assert.equal(minorUnits("-0.05"), -5);
  for (const inexact of ["9860", "9860.0", "9,860.00", "09.00", "1e3.00", "9860.001"]) assert.equal(minorUnits(inexact), null, inexact);
});

test("a snapshot holds the subject and the linked objects as far as the reviewer role may read them", async () => {
  const db = ledger();
  const rows = {
    "job/job_0001": row({ commercial: { quote: { total_cents: 986000 } }, money: { deposit: "open" } }, [
      { kind: "customer", id: "cus_0001" },
      { kind: "money_item", id: "mny_0001" },
      { kind: "customer", id: "cus_0001" },
      { kind: "property", id: "prp_missing" },
    ]),
    "customer/cus_0001": row({ display_name: "Synthetic Customer" }),
    "money_item/mny_0001": row({ kind: "deposit", amount_minor: 250000, currency: "CAD" }),
  };
  const registry = models(rows, {
    job: [whole("jobs:read:any"), { permission: "sales:read", pointers: ["/commercial", "/absent"] }],
    customer: [whole("sales:read")],
    money_item: [whole("accounting:read")],
    property: [whole("sales:read")],
  });

  // The estimator reviews as sales: the commercial part of the job and the customer, never money.
  const { facts, omitted } = await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_0001" }, AT);
  assert.deepEqual(
    facts.map((fact) => [fact.fact_id, fact.version, fact.trust]),
    [
      ["job/job_0001#/commercial", 1, "owned"],
      ["customer/cus_0001", 1, "owned"],
    ],
  );
  assert.deepEqual(omitted, []);
  assert.equal(facts[0].hash, sha(rows["job/job_0001"].data.commercial));
  assert.equal(Object.hasOwn(facts[0], "links"), false);
  // The orchestrator reviews as owner and reads every object whole.
  const owner = await subjectFacts(db, registry, TENANT, "orchestrator", { aggregate: "job", id: "job_0001" }, AT);
  assert.deepEqual(owner.facts.map((fact) => fact.fact_id), ["job/job_0001", "customer/cus_0001", "money_item/mny_0001"]);
  // An unknown, forbidden, prototype-named or foreign-tenant subject gives no facts.
  const none = { facts: [], omitted: [] };
  assert.deepEqual(await subjectFacts(db, registry, TENANT, "billing_reconciliation", { aggregate: "customer", id: "cus_0001" }, AT), none);
  assert.deepEqual(await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "quote", id: "q_1" }, AT), none);
  assert.deepEqual(await subjectFacts(db, registry, TENANT, "orchestrator", { aggregate: "constructor", id: "x" }, AT), none);
  assert.deepEqual(await subjectFacts(db, registry, "other-tenant", "orchestrator", { aggregate: "job", id: "job_0001" }, AT), none);
  assert.deepEqual(await subjectFacts(db, registry, TENANT, "orchestrator", null, AT), none);
});

test("a failing read is named in omitted instead of failing the run open", async () => {
  const db = ledger();
  const registry = models(
    { "job/job_0001": row({ status: "open" }, [{ kind: "customer", id: "cus_bad" }, { kind: "customer", id: "cus_ok" }]), "customer/cus_bad": "throws", "customer/cus_ok": row({ ok: true }), "job/job_bad": "throws" },
    { job: [whole("sales:read")], customer: [whole("sales:read")] },
  );
  const linked = await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_0001" }, AT);
  assert.deepEqual(linked.facts.map((fact) => fact.fact_id), ["job/job_0001", "customer/cus_ok"]);
  assert.deepEqual(linked.omitted, [{ fact_id: "customer/cus_bad", reason: "unreadable" }]);
  assert.deepEqual(await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_bad" }, AT), {
    facts: [],
    omitted: [{ fact_id: "job/job_bad", reason: "unreadable" }],
  });
  // A citation of an object whose read now fails is unverifiable, not an error.
  const { currentVersions } = await citedFacts([{ fact_id: "job/job_bad", version: 1 }], [{ ...refOf(linked.facts[0]), fact_id: "job/job_bad" }], reader(db, registry));
  assert.equal(currentVersions.get("job/job_bad"), null);
});

test("the version ledger names exact values, and a lost insert race takes the next version", async () => {
  const db = ledger();
  const rows: Record<string, ObjectRead> = { "customer/cus_0001": row({ status: "prospect" }) };
  const registry = models(rows, { customer: [whole("sales:read")] });
  const version = async () => (await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "customer", id: "cus_0001" }, AT)).facts[0].version;
  assert.equal(await version(), 1);
  assert.equal(await version(), 1);
  rows["customer/cus_0001"] = row({ status: "active" });
  assert.equal(await version(), 2);
  rows["customer/cus_0001"] = row({ status: "prospect" });
  assert.equal(await version(), 3);
  assert.deepEqual(
    db.raw.prepare("SELECT version, hash FROM agent_fact_versions WHERE fact_id = 'customer/cus_0001' ORDER BY version").all().map((entry) => ({ ...entry })),
    [
      { version: 1, hash: sha({ status: "prospect" }) },
      { version: 2, hash: sha({ status: "active" }) },
      { version: 3, hash: sha({ status: "prospect" }) },
    ],
  );
  // Another reader commits version 4 between this reader's look and its insert.
  let raced = false;
  const racing = {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          if (!sql.startsWith("INSERT") || raced) return bound;
          return { ...bound, run: async () => { raced = true; db.raw.prepare("INSERT INTO agent_fact_versions VALUES (?, 'customer/cus_0001', 4, ?, ?)").run(TENANT, sha({ status: "other" }), AT); return await bound.run(); } };
        },
      };
    },
    batch: db.batch.bind(db),
  };
  assert.equal(await factVersion(racing as never, TENANT, "customer/cus_0001", sha({ status: "mine" }), AT), 5);
  // Append-only, contiguous and immune to replacement.
  const refuse = (sql: string) => assert.throws(() => db.raw.exec(sql), /agent_fact_versions_append_only/, sql);
  refuse("UPDATE agent_fact_versions SET hash = hash WHERE version = 1");
  refuse("DELETE FROM agent_fact_versions WHERE version = 1");
  refuse(`INSERT OR REPLACE INTO agent_fact_versions VALUES ('${TENANT}', 'customer/cus_0001', 1, '${sha(1)}', '${AT}')`);
  refuse(`INSERT INTO agent_fact_versions VALUES ('${TENANT}', 'customer/cus_0001', 9, '${sha(1)}', '${AT}')`);
  assert.throws(() => db.raw.exec(`INSERT INTO agent_fact_versions VALUES ('${TENANT}', 'x/y', 1, 'sha256:zz', '${AT}')`), /CHECK constraint/);
});

test("a snapshot stops at its fact and UTF-8 byte limits, and names what it left out", async () => {
  const db = ledger();
  const links = Array.from({ length: SNAPSHOT_LIMITS.facts + 2 }, (_, index) => ({ kind: "customer", id: `cus_${index}` }));
  const rows: Record<string, ObjectRead> = { "job/job_0001": row({ status: "open" }, links), "job/job_huge": row({ text: "é".repeat(250) }) };
  for (const link of links) rows[`customer/${link.id}`] = row({ display_name: `Synthetic ${link.id}` });
  const registry = models(rows, { job: [whole("sales:read")], customer: [whole("sales:read")] });
  const { facts, omitted } = await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_0001" }, AT);
  assert.equal(facts.length, SNAPSHOT_LIMITS.facts);
  assert.equal(facts[0].fact_id, "job/job_0001");
  assert.deepEqual(omitted.map((entry) => entry.reason), ["limit_reached", "limit_reached", "limit_reached"]);
  // 250 two-byte characters fit 500 UTF-16 units but not 500 bytes: the subject is named, not dropped silently.
  const huge = await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_huge" }, AT, 500);
  assert.deepEqual(huge, { facts: [], omitted: [{ fact_id: "job/job_huge", reason: "too_large" }] });
});

test("cited facts are read again: a new value is stale, a lost read or a missing field is unverifiable", async () => {
  const db = ledger();
  const rows: Record<string, ObjectRead> = {
    "job/job_0001": row({ gates: { deposit: { state: "open" } }, gatesX: { deposit: { state: "decoy" } }, status: "estimate_requested" }),
    "customer/cus_0001": row({ display_name: "Synthetic Customer" }),
  };
  const registry = models(rows, {
    job: [whole("jobs:read:any"), { permission: "sales:read", pointers: ["/gates"] }],
    customer: [whole("sales:read")],
  });
  const refs = [
    refOf(SIGNAL),
    ...(await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "job", id: "job_0001" }, AT)).facts.map(refOf),
    ...(await subjectFacts(db, registry, TENANT, "estimator", { aggregate: "customer", id: "cus_0001" }, AT)).facts.map(refOf),
  ];
  assert.equal(refs.every((ref) => !Object.hasOwn(ref, "data")), true);
  const cite = (fact_id: string, version: number) => ({ fact_id, version });
  const read = () =>
    citedFacts(
      [
        cite("signal/sig_0001", 1),
        cite("signal/sig_0001#/text", 1),
        cite("job/job_0001#/gates", 1),
        cite("job/job_0001#/gates/deposit", 1),
        cite("job/job_0001#/gates/final", 1),
        cite("job/job_0001#/gatesX/deposit", 1),
        cite("job/job_0001", 1),
        cite("customer/cus_0001", 1),
        cite("supplier/sup_0001", 1),
        cite("not a fact", 1),
      ],
      refs,
      reader(db, registry),
    );

  let { snapshot, currentVersions } = await read();
  assert.deepEqual([...currentVersions], [
    ["signal/sig_0001", 1],
    ["signal/sig_0001#/text", 1],
    ["job/job_0001#/gates", 1],
    ["job/job_0001#/gates/deposit", 1],
    ["job/job_0001#/gates/final", null],
    // A sibling whose name only starts like the part sales holds is outside it.
    ["job/job_0001#/gatesX/deposit", null],
    // Sales holds only the gates part: the whole job is not in its snapshot.
    ["job/job_0001", null],
    ["customer/cus_0001", 1],
    ["supplier/sup_0001", null],
    ["not a fact", null],
  ]);
  assert.equal(snapshot.get("job/job_0001#/gates/deposit")?.hash, sha({ state: "open" }));
  assert.equal(snapshot.get("job/job_0001#/gates/deposit")?.version, 1);
  assert.equal(snapshot.get("signal/sig_0001#/text")?.hash, sha("Synthetic"));
  assert.equal(snapshot.has("job/job_0001#/gates/final"), false);

  // A transition outside the part sales reads leaves its facts current; a gate change does not.
  rows["job/job_0001"] = row({ gates: { deposit: { state: "open" } }, gatesX: {}, status: "quoted" });
  ({ currentVersions } = await read());
  assert.equal(currentVersions.get("job/job_0001#/gates/deposit"), 1);
  rows["job/job_0001"] = row({ gates: { deposit: { state: "ready" } }, status: "quoted" });
  rows["customer/cus_0001"] = row({ display_name: "Changed" });
  ({ currentVersions } = await read());
  assert.equal(currentVersions.get("job/job_0001#/gates"), 2);
  assert.equal(currentVersions.get("job/job_0001#/gates/deposit"), 2);
  assert.equal(currentVersions.get("customer/cus_0001"), 2);

  // A resumed run gets current values only for facts still at their version.
  const resumed = await hydrate(refs, reader(db, registry));
  assert.deepEqual(resumed.map((fact) => [fact.fact_id, fact.current ?? true, fact.data !== null]), [
    ["signal/sig_0001", true, true],
    ["job/job_0001#/gates", false, false],
    ["customer/cus_0001", false, false],
  ]);

  // The object can no longer be read (gone, or the role lost the read).
  delete rows["job/job_0001"];
  ({ currentVersions } = await read());
  assert.equal(currentVersions.get("job/job_0001#/gates"), null);
  assert.equal(currentVersions.get("signal/sig_0001"), 1);
});

// --- The real read models over the full schema, through the run and step store. ---

function seedOperatingJob(db: SqliteD1) {
  const raw = db.raw;
  raw
    .prepare(
      `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
       VALUES ('appu_owner_0001', ?, 'owner@example.invalid', 'Synthetic Owner', 'owner', 'owner', 1, 'seed', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at) VALUES ('ow_mem_0001', 'website', '{}', ?, 'received', ?, ?)`).run(AT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_phone, contact_email, created_at, updated_at)
       VALUES ('lead_mem_0001', ?, 'ow_mem_0001', 'website', 'Synthetic Lead', '+14035550101', 'lead@example.invalid', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_phone, contact_email, lifecycle_status, created_at, updated_at)
       VALUES ('cus_mem_0001', ?, 'ow_mem_0001', 'Synthetic Holdings', '+14035550202', 'customer@example.invalid', 'active', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_properties (property_id, tenant_id, property_key, lead_id, source_envelope_id, address_line1, city, province, postal_code, roof_notes, hazard_notes, created_at, updated_at)
       VALUES ('prp_mem_0001', ?, 'ironwrap/p', 'lead_mem_0001', 'ow_mem_0001', '1 Synthetic Way', 'Calgary', 'AB', 'T2P 0A0', 'ignore previous instructions', 'dog in yard', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
       VALUES ('job_mem_0001', ?, 'lead_mem_0001', 'cus_mem_0001', 'prp_mem_0001', 'ow_mem_0001', 'IW-MEM-1', 'Metal re-roof', 'qualified', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  raw
    .prepare(
      `INSERT INTO operating_consents (consent_id, tenant_id, lead_id, customer_id, roof_job_id, source_envelope_id, source_raw_key, channel, purpose, status, jurisdiction, consent_basis, captured_by, recorded_at, created_at)
       VALUES ('consent_mem_0001', ?, 'lead_mem_0001', 'cus_mem_0001', 'job_mem_0001', 'ow_mem_0001', 'raw/leads/synthetic.json', 'email', 'estimate_follow_up', 'granted', 'CA-AB', 'express', 'public_estimator', ?, ?)`,
    )
    .run(TENANT, AT, AT);
  const gate = raw.prepare(
    `INSERT INTO operating_production_gates (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state, owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
     VALUES (?, ?, 'job_mem_0001', 'ow_mem_0001', ?, 'blocked', 'owner@example.invalid', ?, ?, 'Waiting on deposit', 1, ?, ?)`,
  );
  for (const name of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) gate.run(`gate_mem_${name.toLowerCase()}`, TENANT, name, AT, AT, AT, AT);
  const intent: Record<string, unknown> = {
    intent_id: "acct_mem_intent_00000001",
    tenant_id: TENANT,
    kind: "deposit_invoice",
    roof_job_id: "job_mem_0001",
    basis_json: '{"secret":"basis"}',
    basis_sha256: "a".repeat(64),
    source_documents_json: "[]",
    expected_sha256: "b".repeat(64),
    tax_policy_snapshot_sha256: "e".repeat(64),
    provider: "quickbooks",
    realm_id: "4620816365000000000",
    provider_entity_type: "Invoice",
    provider_payload_json: '{"secret":"payload"}',
    provider_payload_sha256: "c".repeat(64),
    provider_request_id: "req-mem-0000000000000001",
    currency: "CAD",
    subtotal: "9390.48",
    tax_amount: "469.52",
    total_amount: "9860.00",
    settled_amount: null,
    authority_permit_ref: "permit:test",
    authority_policy_ref: "policy:test",
    authority_policy_version: "1",
    authority_max_amount: "100000.00",
    effect_idempotency_key: "effect-key-mem-0000000001",
    state: "pending_review",
    version: 1,
    derived_by_actor_kind: "owner",
    derived_by_user_id: "appu_owner_0001",
    derived_at: AT,
    created_at: AT,
    updated_at: AT,
  };
  const columns = Object.keys(intent);
  raw.prepare(`INSERT INTO accounting_intents (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...(columns.map((column) => intent[column]) as never[]));
}

async function open(db: SqliteD1, specialist: string, subject: { aggregate: string; id: string }, key: string): Promise<{ run: RunRow; context: RunContext }> {
  const signal = await appendSignal(db, TENANT, {
    kind: "event",
    specialist_id: specialist,
    watch_id: null,
    source: "test",
    subject,
    content: { text: "Synthetic signal" },
    dedupe_key: `mem:${key}`,
  }, AT);
  assert.ok(!("error" in signal), JSON.stringify(signal));
  const opened = await openRun(db, TENANT, { signal_id: signal.signal_id, specialist_id: specialist, host_run_key: key }, AT);
  assert.ok(!("error" in opened), JSON.stringify(opened));
  return { run: opened.run, context: opened.context };
}

const ids = (context: RunContext) => context.facts.map((fact) => fact.fact_id).slice(1);
const PERSONAL = ["+14035550202", "+14035550101", "customer@example.invalid", "lead@example.invalid", "ignore previous instructions", "dog in yard", "Waiting on deposit", "secret", "4620816365000000000"];

test("each reviewer role gets exactly the view its screens show", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  const subject = { aggregate: "job", id: "job_mem_0001" };

  // Sales: the offer chain of the job, the customer with consent, the property, the lead and the roof heads.
  const sales = (await open(db, "estimator", subject, "mem-sales")).context;
  assert.deepEqual(ids(sales), [
    "job/job_mem_0001#/job",
    "job/job_mem_0001#/facts/commercial/quote_head",
    "job/job_mem_0001#/facts/commercial/quote",
    "job/job_mem_0001#/facts/commercial/proposal",
    "job/job_mem_0001#/facts/commercial/publication",
    "job/job_mem_0001#/facts/commercial/acceptance",
    "job/job_mem_0001#/facts/commercial/acceptance_under_withdrawn_publication",
    "customer/cus_mem_0001",
    "property/prp_mem_0001",
    "lead/lead_mem_0001",
    "roof/job_mem_0001",
  ]);
  const customer = sales.facts.find((fact) => fact.fact_id === "customer/cus_mem_0001")!;
  assert.deepEqual(JSON.parse(JSON.stringify(customer.data)), {
    identity: { customer_id: "cus_mem_0001", display_name: "Synthetic Holdings", lifecycle_status: "active", record_version: 1, created_at: AT, updated_at: AT },
    contact: {
      has_phone: true,
      has_email: true,
      consents: [{ consent_id: "consent_mem_0001", roof_job_id: "job_mem_0001", channel: "email", purpose: "estimate_follow_up", status: "granted", jurisdiction: "CA-AB", consent_basis: "express", recorded_at: AT }],
    },
    jobs: ["job_mem_0001"],
  });
  const salesText = JSON.stringify(sales);
  for (const kept of [...PERSONAL, "deposit_derivation", "deposit_intents", "gates"]) assert.equal(salesText.includes(kept), false, kept);

  // Production: the whole job with gates and money, only who the customer is, the property; no lead, roof or consent.
  const production = (await open(db, "scheduler_dispatcher", subject, "mem-production")).context;
  assert.deepEqual(ids(production), ["job/job_mem_0001", "customer/cus_mem_0001#/identity", "customer/cus_mem_0001#/jobs", "property/prp_mem_0001"]);
  const job = production.facts[1].data as { facts: { production: { gates: unknown[] }; accounting: { deposit_intents: Array<Record<string, unknown>> } } };
  assert.equal(job.facts.production.gates.length, 6);
  assert.deepEqual(job.facts.accounting.deposit_intents.map((intent) => [intent.total_minor, intent.settled_minor, intent.currency]), [[986000, null, "CAD"]]);
  assert.equal(Object.hasOwn(production.facts[1].data as object, "read_model_generated_at"), false);
  const productionText = JSON.stringify(production);
  // Gate blocker text is production's own record; contact values, notes, consent and roof heads are not.
  for (const kept of [...PERSONAL.filter((value) => value !== "Waiting on deposit"), "consents", "has_phone", "estimator_evidence", "9860.00"])
    assert.equal(productionText.includes(kept), false, kept);

  // Accounting: the money item in minor units, and the job's identity and money part only.
  const money = (await open(db, "billing_reconciliation", { aggregate: "money_item", id: "acct_mem_intent_00000001" }, "mem-money")).context;
  assert.deepEqual(ids(money), ["money_item/acct_mem_intent_00000001", "job/job_mem_0001#/job", "job/job_mem_0001#/facts/accounting"]);
  const item = money.facts[1].data as Record<string, unknown>;
  assert.deepEqual([item.subtotal_minor, item.tax_minor, item.total_minor, item.settled_minor, item.currency], [939048, 46952, 986000, null, "CAD"]);
  const moneyText = JSON.stringify(money);
  for (const kept of [...PERSONAL, "9860.00", "9390.48"]) assert.equal(moneyText.includes(kept), false, kept);
});

test("a run row keeps fact refs only, and a resumed run reads the values again", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  const { run, context } = await open(db, "scheduler_dispatcher", { aggregate: "job", id: "job_mem_0001" }, "mem-resume");
  assert.ok(context.facts.every((fact) => fact.data !== undefined));
  const row = db.raw.prepare("SELECT context_json FROM agent_runs WHERE run_id = ?").get(run.run_id) as { context_json: string };
  const stored = JSON.parse(row.context_json) as { facts: Array<Record<string, unknown>> };
  assert.ok(stored.facts.every((fact) => !Object.hasOwn(fact, "data")));
  for (const value of ["Synthetic Holdings", "1 Synthetic Way", "Synthetic signal", "IW-MEM-1"]) assert.equal(row.context_json.includes(value), false, value);
  assert.deepEqual(runContext(run).facts.map((fact) => fact.fact_id), context.facts.map((fact) => fact.fact_id));

  // The customer is renamed; the resumed run sees the property unchanged and the customer stale.
  db.raw.exec("UPDATE operating_customers SET display_name = 'Renamed Synthetic', version = version + 1 WHERE customer_id = 'cus_mem_0001'");
  const again = await openRun(db, TENANT, { signal_id: run.signal_id, specialist_id: "scheduler_dispatcher", host_run_key: "mem-resume" }, AT);
  assert.ok(!("error" in again) && again.resumed);
  const byId = new Map(again.context.facts.map((fact) => [fact.fact_id, fact]));
  assert.deepEqual(byId.get("customer/cus_mem_0001#/identity"), { ...refOf(context.facts.find((fact) => fact.fact_id === "customer/cus_mem_0001#/identity")!), data: null, current: false });
  assert.equal((byId.get("property/prp_mem_0001")?.data as { address_line1: string }).address_line1, "1 Synthetic Way");
  assert.equal((byId.get(`signal/${run.signal_id}`)?.data as { text: string }).text, "Synthetic signal");
});

test("a step citing a job fact succeeds while it is current and abstains stale once the job moves", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  const { run, context } = await open(db, "scheduler_dispatcher", { aggregate: "job", id: "job_mem_0001" }, "mem-step");
  const jobFact = context.facts.find((fact) => fact.fact_id === "job/job_mem_0001")!;
  const explain = (factId: string, version: number, key: string) =>
    proposeStep(db, TENANT, run, {
      action_id: "fact.explain",
      args: { object: { aggregate: "job", id: "job_mem_0001", version }, explanation: "Synthetic explanation." },
      citations: [{ fact_id: factId, version }],
      step_key: key.padEnd(64, "0"),
    }, Date.parse(AT));

  const current = await explain("job/job_mem_0001#/facts/production/gates/0", jobFact.version, "a1");
  assert.ok(!("error" in current), JSON.stringify(current));
  assert.equal(current.outcome, "succeeded");
  const gate = (jobFact.data as { facts: { production: { gates: unknown[] } } }).facts.production.gates[0];
  assert.deepEqual(JSON.parse(current.sources_json), [{ fact_id: "job/job_mem_0001#/facts/production/gates/0", version: jobFact.version, hash: sha(gate) }]);

  // A gate clears: the job's value changes, so its ledger version moves and the old citation is stale.
  attestGateInLedger(db.raw, { tenantId: TENANT, roofJobId: "job_mem_0001", gate: "Access", actorUserId: "appu_owner_0001", actorRole: "owner" });
  const stale = await explain("job/job_mem_0001", jobFact.version, "a2");
  assert.ok(!("error" in stale), JSON.stringify(stale));
  assert.deepEqual([stale.outcome, stale.reason_code], ["abstained", "fact_stale"]);
  // A supplier fact cannot be read: there is no supplier object yet.
  const supplier = await explain("supplier/sup_mem_0001", 1, "a3");
  assert.ok(!("error" in supplier), JSON.stringify(supplier));
  assert.deepEqual([supplier.outcome, supplier.reason_code], ["abstained", "citation_unverifiable"]);
});

test("crew, inventory position and measurement read models return their exact rows", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  const raw = db.raw;
  raw.prepare("INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at) VALUES ('crew_mem_0001', ?, 'Synthetic Crew', 'Active', 1, ?, ?)").run(TENANT, AT, AT);
  raw.prepare("INSERT INTO fleet_crew_members (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at) VALUES ('mem_0001', ?, 'crew_mem_0001', 'appu_owner_0001', 1, 1, ?, ?)").run(TENANT, AT, AT);
  const crew = (await open(db, "scheduler_dispatcher", { aggregate: "crew", id: "crew_mem_0001" }, "mem-crew")).context;
  assert.deepEqual(JSON.parse(JSON.stringify(crew.facts[1].data)), {
    crew_id: "crew_mem_0001",
    display_name: "Synthetic Crew",
    status: "Active",
    record_version: 1,
    updated_at: AT,
    members: [{ membership_id: "mem_0001", user_id: "appu_owner_0001", active: true, record_version: 1 }],
  });
  // Sales has no crew screen.
  assert.deepEqual(ids((await open(db, "estimator", { aggregate: "crew", id: "crew_mem_0001" }, "mem-crew-sales")).context), []);

  // An inventory position, seeded directly: this checks the read model, not the movement ledger.
  raw.exec("DROP TRIGGER inventory_positions_open_guard");
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.prepare("INSERT INTO inventory_uoms (uom_id, tenant_id, code, dimension, scale, status, created_at, updated_at) VALUES ('uom_mem_ea', ?, 'EA', 'count', 0, 'active', ?, ?)").run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO inventory_items (item_id, tenant_id, item_code, status, item_kind, base_uom_id, quantity_scale, lot_controlled, valuation_method, source_ref, created_at, updated_at)
    VALUES ('item_mem_0001', ?, 'COIL-24', 'active', 'raw_material', 'uom_mem_ea', 0, 1, 'actual', 'seed', ?, ?)`).run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO inventory_locations (location_id, tenant_id, location_code, name, location_kind, status, source_ref, created_at, updated_at)
    VALUES ('loc_mem_0001', ?, 'WH1', 'Warehouse', 'warehouse', 'active', 'seed', ?, ?)`).run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO inventory_bins (bin_id, tenant_id, location_id, bin_code, bin_kind, status, created_at, updated_at)
    VALUES ('bin_mem_0001', ?, 'loc_mem_0001', 'A1', 'stock', 'active', ?, ?)`).run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO inventory_lots (lot_id, tenant_id, item_id, lot_code, lot_kind, status, unit_cost_minor, evidence_refs_json, created_at, updated_at)
    VALUES ('lot_mem_0001', ?, 'item_mem_0001', 'L-0001', 'purchased', 'available', 500, '[]', ?, ?)`).run(TENANT, AT, AT);
  raw.prepare(`INSERT INTO inventory_positions (position_id, tenant_id, item_id, lot_id, bin_id, job_custody, uom_id, quantity_scaled, reserved_scaled, quarantined_scaled, value_minor, currency, version, last_event_id, created_at, updated_at)
    VALUES ('pos_mem_0001', ?, 'item_mem_0001', 'lot_mem_0001', 'bin_mem_0001', '-', 'uom_mem_ea', 12, 0, 0, 6000, 'CAD', 1, 'evt_mem_0001', ?, ?)`).run(TENANT, AT, AT);
  raw.exec("PRAGMA foreign_keys=ON");
  const position = (await open(db, "purchasing_inventory", { aggregate: "inventory_position", id: "pos_mem_0001" }, "mem-position")).context;
  const data = position.facts[1].data as Record<string, any>;
  assert.deepEqual([data.position_id, data.quantity_scaled, data.value_minor, data.currency, data.item.item_code, data.lot.unit_cost_minor, data.reservations], ["pos_mem_0001", 12, 6000, "CAD", "COIL-24", 500, []]);
  assert.equal(Object.hasOwn(data, "tenant_id"), false);

  // A measurement revision whose projection matches its stored canonical bytes and hash.
  const projection = canonicalJson({ area_sq_ft: 2840, pitch: "6/12", schema_version: "ironwrap.native-measurement.v1" });
  raw.prepare(`INSERT INTO measurement_intake_receipts (receipt_id, tenant_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id, provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at, attempts, created_at, updated_at)
    VALUES ('measurement_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, ?, 'payload_hash', 'measurement:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'EagleView', 'IW-MEM-1', 'raw/measurements/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', 'application/json', 'processing', 'lease-mem1', '2026-03-01T11:00:00.000Z', 1, ?, ?)`).run(TENANT, "1".repeat(64), "3".repeat(64), AT, AT);
  const insertRevision = (id: string, sha256: string) =>
    raw.prepare(`INSERT INTO native_measurement_revisions (measurement_revision_id, tenant_id, receipt_id, measurement_id, provider, job_number, roof_job_id, operating_job_version, association_status, association_error, receipt_status, review_required, root_measurement_id, revision_number, supersedes_measurement_revision_id, correction_reason, measurement_raw_key, measurement_raw_sha256, projection_json, projection_sha256, command_fingerprint, created_at)
      VALUES (?, ?, 'measurement_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'measurement:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'EagleView', 'IW-MEM-1', 'job_mem_0001', 1, 'matched', NULL, 'matched', 0, 'measurement:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, NULL, NULL, 'raw/measurements/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', ?, ?, ?, ?, ?)`).run(id, TENANT, "3".repeat(64), projection, sha256, "5".repeat(64), AT);
  insertRevision("mrev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createHash("sha256").update(projection).digest("hex"));
  const measured = (await open(db, "estimator", { aggregate: "measurement", id: "mrev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "mem-measurement")).context;
  assert.deepEqual((measured.facts[1].data as { projection: unknown }).projection, JSON.parse(projection));
  assert.deepEqual(ids(measured).slice(0, 2), ["measurement/mrev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "roof/job_mem_0001"]);
  // Production has no measurement screen.
  assert.deepEqual(ids((await open(db, "scheduler_dispatcher", { aggregate: "measurement", id: "mrev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "mem-measurement-production")).context), []);
});

test("the roof offers the latest design only while its Facet links stand, and money exactness stays in the money part", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  const raw = db.raw;
  raw.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('facet_v2_native_design_projections','facet_v2_link_revocations')").all() as Array<{ name: string }>)
    raw.exec(`DROP TRIGGER ${trigger.name}`);
  const h = (c: string) => c.repeat(64);
  raw.prepare(`INSERT INTO facet_v2_native_design_projections (projection_id, event_id, destination_tenant_id, source_tenant_id, brand_id, facet_project_id, external_project_link_id, producer_identity_link_id, external_customer_identity_link_id, roof_job_id, customer_id, customer_quote_id, source_quote_revision_id, source_quote_version, source_quote_approved_at, source_proposal_revision_id, source_proposal_pack_id, source_publication_event_id, source_acceptance_binding_id, source_acceptance_id, source_acceptance_accepted_at, source_acceptance_receipt_hash, launch_intent_sha256, decision_kind, design_sequence, design_state, previous_event_id, design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_sha256, projection_sha256, projected_at)
    VALUES (?, 'evt1', ?, 'src', 'brand', 'fp1', 'proj_link_1', 'prod_link_1', 'cust_link_1', 'job_mem_0001', 'cus_mem_0001', 'cq1', 'qr1', 1, ?, 'pr1', 'pp1', 'pe1', 'ab1', 'acc1', ?, ?, ?, 'approved', 1, 'active', NULL, 'drev1', ?, ?, ?, ?, ?)`).run(`facet-native-design-v2:${h("a")}`, TENANT, AT, AT, h("1"), h("2"), h("3"), h("4"), h("5"), h("6"), AT);
  let sequence = 0;
  const roof = async () => {
    const { context } = await open(db, "estimator", { aggregate: "roof", id: "job_mem_0001" }, `roof-${++sequence}`);
    return context.facts.find((fact) => fact.fact_id === "roof/job_mem_0001")!.data as { design: { design_revision_id: string } | null; design_links_revoked: boolean };
  };
  assert.deepEqual([(await roof()).design?.design_revision_id, (await roof()).design_links_revoked], ["drev1", false]);
  for (const [kind, link] of [["project", "proj_link_1"], ["producer_identity", "prod_link_1"], ["customer_identity", "cust_link_1"]]) {
    raw.prepare("INSERT INTO facet_v2_link_revocations (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id, destination_tenant_id, revoked_at) VALUES (?, ?, ?, 'synthetic', 'appu_owner_0001', ?, ?)").run(`rv_${kind}`, kind, link, TENANT, AT);
    const revoked = await roof();
    assert.deepEqual([revoked.design, revoked.design_links_revoked], [null, true], kind);
    raw.prepare("DELETE FROM facet_v2_link_revocations WHERE revocation_id = ?").run(`rv_${kind}`);
  }

  // Leading-zero text passes the accounting column check but is not an exact amount. The amount is
  // immutable once derived, so the guard is lifted only to stage this row.
  raw.exec("PRAGMA foreign_keys=ON");
  for (const trigger of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='accounting_intents' AND sql LIKE '%accounting_intent_basis_immutable%'").all() as Array<{ name: string }>)
    raw.exec(`DROP TRIGGER ${trigger.name}`);
  raw.exec("UPDATE accounting_intents SET total_amount = '09860.00', version = version + 1 WHERE intent_id = 'acct_mem_intent_00000001'");
  const production = (await open(db, "scheduler_dispatcher", { aggregate: "job", id: "job_mem_0001" }, "mem-inexact")).context;
  const job = production.facts.find((fact) => fact.fact_id === "job/job_mem_0001")!.data as { facts: { accounting: unknown; production: { gates: unknown[] } } };
  assert.deepEqual(job.facts.accounting, { unreadable: "inexact_amount" });
  assert.equal(job.facts.production.gates.length, 6);
  const sales = (await open(db, "estimator", { aggregate: "job", id: "job_mem_0001" }, "mem-inexact-sales")).context;
  assert.ok(ids(sales).includes("job/job_mem_0001#/facts/commercial/quote"));
});

test("the run row keeps what was omitted, and accounting has no customer screen", async () => {
  const db = new SqliteD1("all");
  seedOperatingJob(db);
  // A job linking a customer whose read fails is still opened, with the failure recorded.
  db.raw.exec("DROP TABLE operating_consents");
  const { run, context } = await open(db, "estimator", { aggregate: "job", id: "job_mem_0001" }, "mem-omitted");
  assert.deepEqual(context.omitted, [{ fact_id: "customer/cus_mem_0001", reason: "unreadable" }, { fact_id: "lead/lead_mem_0001", reason: "unreadable" }]);
  assert.deepEqual(runContext(run).omitted, context.omitted);
  const db2 = new SqliteD1("all");
  seedOperatingJob(db2);
  assert.deepEqual(ids((await open(db2, "billing_reconciliation", { aggregate: "customer", id: "cus_mem_0001" }, "mem-acct-customer")).context), []);
});
