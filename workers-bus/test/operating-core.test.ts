import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { EnvelopeRecord } from "../src/core.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";
import { bindCrewInLedger, clearScheduleGatesInLedger } from "./production-gate-ledger-fixture.ts";

class TestD1 {
  readonly raw = new DatabaseSync(":memory:");
  private beforeBatchHook: (() => void | Promise<void>) | null;

  constructor(
    beforeBatchHook: (() => void | Promise<void>) | null = null,
    options: { fullChain?: boolean } = {},
  ) {
    this.beforeBatchHook = beforeBatchHook;
    this.raw.exec("PRAGMA foreign_keys = ON");
    // 0153 is here so a retried materialization meets the gate ledger's guards; 0009 and 0106
    // carry the audit and gate clearance columns that migration reads and writes. A case that
    // clears gates through the ledger needs every migration the ledger's entries read.
    const names = options.fullChain
      ? readdirSync(new URL("../migrations/", import.meta.url))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort()
      : [
        "0001_init.sql",
        "0009_replay_approval_audit.sql",
        "0090_operating_core.sql",
        "0106_native_gate_clearance_and_option_packages.sql",
        "0153_production_gate_clearances.sql",
      ];
    for (const name of names) {
      this.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this.raw;
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => (db.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
        run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
      }),
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const hook = this.beforeBatchHook;
    this.beforeBatchHook = null;
    if (hook) await hook();
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function envelope(overrides: Partial<EnvelopeRecord> = {}): EnvelopeRecord {
  const id = overrides.envelope_id ?? "ow_19500000-0000-4000-8000-000000000001";
  const now = overrides.ts ?? "2026-08-20T10:00:00.000Z";
  return {
    envelope_id: id,
    source: "website",
    contact_name: "Jane Doe",
    contact_phone: "+15875551234",
    contact_email: "jane@example.invalid",
    job_ref: null,
    payload_json: JSON.stringify({
      address: "1 Main Street",
      city: "Edmonton",
      province: "AB",
      postal_code: "T5J 0N3",
      service: "metal roof",
      instant_estimate: true,
      estimate_low: "$12,000.00",
      estimate_high: "18000",
      estimate_confidence: "low",
      source_detail: "ironwrap_public_estimator",
      public_estimator: {
        jurisdiction: "Alberta, Canada",
        consent: { contact: true, privacy: true, recorded_at: now },
      },
    }),
    raw_key: `raw/estimates/2026-08-20/${id}.json`,
    ts: now,
    status: "pending_jn_push",
    dedup_key: "p:+15875551234",
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: "residential_sales",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function env(db: TestD1, tenant = "ironwrap") {
  return {
    DB: db as never,
    APP_TENANT_ID: tenant,
    ERPNEXT_ENABLED: "false",
    OPERATING_AUTOMATION_USER: "worker@example.invalid",
  } as never;
}

function rows(db: TestD1, table: string, tenant = "ironwrap"): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`).get(tenant) as { count: number }).count);
}

function seedEnvelope(db: TestD1, rec: EnvelopeRecord): void {
  db.raw.prepare(
    `INSERT INTO envelopes (
       envelope_id, source, contact_name, contact_phone, contact_email, job_ref, payload_json,
       raw_key, ts, status, dedup_key, dup_of, attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    rec.envelope_id, rec.source, rec.contact_name, rec.contact_phone, rec.contact_email,
    rec.job_ref, rec.payload_json, rec.raw_key, rec.ts, rec.status, rec.dedup_key, rec.dup_of,
    rec.created_at, rec.updated_at,
  );
}

test("native operating materialization never fetches Frappe", async (t) => {
  const db = new TestD1();
  seedEnvelope(db, envelope());
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches += 1; throw new Error("frappe_must_not_be_called"); });

  await materializeOperatingCore(env(db), envelope());
  assert.equal(fetches, 0);
  assert.equal(rows(db, "operating_leads"), 1);
  assert.equal(rows(db, "operating_customers"), 1);
  assert.equal(rows(db, "operating_properties"), 1);
  assert.equal(rows(db, "operating_roof_jobs"), 1);
  assert.equal(rows(db, "operating_production_gates"), 7);
  assert.equal(rows(db, "operating_instant_estimates"), 1);
  assert.equal(rows(db, "operating_consents"), 2);
  assert.equal(rows(db, "operating_core_audit"), 1);
});

test("JobNimbus transport binds once to the native Roof Job and conflicting replay fails closed", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  const first = await materializeOperatingCore(env(db), rec);
  const transport = {
    contactId: "jn-contact-1",
    jobId: "jn-job-1",
    jobNumber: "26-0001",
    reused: false,
  };

  await materializeOperatingCore(env(db), rec, transport);
  await materializeOperatingCore(env(db), rec, transport);
  const job = db.raw.prepare(
    `SELECT job_number, jobnimbus_contact_id, jobnimbus_job_id, version
       FROM operating_roof_jobs
      WHERE tenant_id = 'ironwrap' AND roof_job_id = ?`,
  ).get(first.roofJobId) as {
    job_number: string;
    jobnimbus_contact_id: string;
    jobnimbus_job_id: string;
    version: number;
  };
  assert.deepEqual({ ...job }, {
    job_number: "26-0001",
    jobnimbus_contact_id: "jn-contact-1",
    jobnimbus_job_id: "jn-job-1",
    version: 2,
  });

  await assert.rejects(
    materializeOperatingCore(env(db), rec, { ...transport, jobId: "jn-job-other" }),
    /operating_core_jobnimbus_transport_conflict/,
  );
});

test("replay is idempotent and the same contact reuses one tenant customer", async () => {
  const db = new TestD1();
  const first = envelope();
  seedEnvelope(db, first);
  await materializeOperatingCore(env(db), first);
  await materializeOperatingCore(env(db), first);
  const second = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000002",
    payload_json: JSON.stringify({ address: "2 Main Street", city: "Edmonton", service: "roofing" }),
    raw_key: "raw/2026-08-20/ow_19500000-0000-4000-8000-000000000002.json",
  });
  seedEnvelope(db, second);
  await materializeOperatingCore(env(db), second);

  assert.equal(rows(db, "operating_customers"), 1);
  assert.equal(rows(db, "operating_leads"), 2);
  assert.equal(rows(db, "operating_roof_jobs"), 2);
  assert.equal(rows(db, "operating_core_audit"), 2);
  assert.equal(rows(db, "operating_core_events"), 14 + 11);
});

test("an email-only estimate and an email+phone lead share one customer, in both orders", async () => {
  const estimate = (id: string) => envelope({
    envelope_id: id,
    contact_phone: null,
    dedup_key: "e:jane@example.invalid",
    raw_key: `raw/estimates/${id}.json`,
    payload_json: JSON.stringify({
      instant_estimate: true,
      estimate_type: "instant",
      estimate_project_id: "LP-iro274",
      total_estimate: "$1.00",
      service: "Roof",
      address: "Edmonton, AB",
    }),
  });
  const website = (id: string) => envelope({
    envelope_id: id,
    raw_key: `raw/website/${id}.json`,
    payload_json: JSON.stringify({ service: "metal roofing", brand: "ironwrap" }),
  });
  const orders = [
    ["estimate first", (a: string, b: string) => [estimate(a), website(b)]],
    ["website first", (a: string, b: string) => [website(a), estimate(b)]],
  ] as const;

  for (const [label, build] of orders) {
    const db = new TestD1();
    const [first, second] = build(
      "ow_19500000-0000-4000-8000-0000000000a1",
      "ow_19500000-0000-4000-8000-0000000000a2",
    );
    seedEnvelope(db, first);
    seedEnvelope(db, second);
    const firstResult = await materializeOperatingCore(env(db), first);
    const secondResult = await materializeOperatingCore(env(db), second);

    assert.equal(rows(db, "operating_customers"), 1, label);
    assert.equal(secondResult.customerId, firstResult.customerId, label);
    const jobCustomers = db.raw.prepare(
      "SELECT DISTINCT customer_id FROM operating_roof_jobs",
    ).all() as Array<{ customer_id: string }>;
    assert.deepEqual(jobCustomers.map(({ customer_id }) => customer_id), [firstResult.customerId], label);
  }
});

test("a differing known contact still fails closed", async () => {
  const db = new TestD1();
  const first = envelope({ envelope_id: "ow_19500000-0000-4000-8000-0000000000b1" });
  const second = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-0000000000b2",
    contact_phone: "+15875559999",
    raw_key: "raw/conflict/b2.json",
  });
  seedEnvelope(db, first);
  seedEnvelope(db, second);
  await materializeOperatingCore(env(db), first);
  // The readback runs after db.batch commits, so only the rejection is asserted.
  await assert.rejects(materializeOperatingCore(env(db), second), /operating_core_customer_conflict/);
});

test("consent follows the reused customer when a later source has only the other contact method", async () => {
  const db = new TestD1();
  const first = envelope({ envelope_id: "ow_19500000-0000-4000-8000-00000000000c" });
  const second = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-00000000000d",
    contact_email: null,
    raw_key: "raw/consent/phone-only.json",
  });
  seedEnvelope(db, first);
  seedEnvelope(db, second);
  const firstResult = await materializeOperatingCore(env(db), first);
  await materializeOperatingCore(env(db), second);
  const consentCustomerIds = db.raw.prepare(
    "SELECT DISTINCT customer_id FROM operating_consents ORDER BY customer_id",
  ).all() as Array<{ customer_id: string }>;
  assert.deepEqual(consentCustomerIds.map(({ customer_id }) => customer_id), [firstResult.customerId]);
  assert.equal(rows(db, "operating_consents"), 3);
});

test("stable IDs are opaque and distinguish identities that sanitize alike", async () => {
  const db = new TestD1();
  const first = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000003",
    contact_phone: null,
    contact_email: "a/b@example.invalid",
    payload_json: JSON.stringify({ address: "3 Main Street", service: "roof" }),
    raw_key: "raw/opaque/003.json",
  });
  const second = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000004",
    contact_phone: null,
    contact_email: "a?b@example.invalid",
    payload_json: JSON.stringify({ address: "4 Main Street", service: "roof" }),
    raw_key: "raw/opaque/004.json",
  });
  const longPrefix = "x".repeat(160);
  const third = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000008",
    contact_phone: null,
    contact_email: `${longPrefix}a@example.invalid`,
    payload_json: JSON.stringify({ address: "8 Main Street", service: "roof" }),
    raw_key: "raw/opaque/008.json",
  });
  const fourth = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000009",
    contact_phone: null,
    contact_email: `${longPrefix}b@example.invalid`,
    payload_json: JSON.stringify({ address: "9 Main Street", service: "roof" }),
    raw_key: "raw/opaque/009.json",
  });
  seedEnvelope(db, first);
  seedEnvelope(db, second);
  seedEnvelope(db, third);
  seedEnvelope(db, fourth);
  const firstResult = await materializeOperatingCore(env(db), first);
  const secondResult = await materializeOperatingCore(env(db), second);
  const thirdResult = await materializeOperatingCore(env(db), third);
  const fourthResult = await materializeOperatingCore(env(db), fourth);
  assert.match(firstResult.customerId, /^customer:ironwrap:[0-9a-f]{64}$/);
  assert.match(firstResult.leadId, /^lead:ironwrap:[0-9a-f]{64}$/);
  assert.notEqual(firstResult.customerId, secondResult.customerId);
  assert.notEqual(thirdResult.customerId, fourthResult.customerId);
  const ids = db.raw.prepare(`
    SELECT customer_id AS entity_id FROM operating_customers
    UNION ALL SELECT lead_id FROM operating_leads
    UNION ALL SELECT event_id FROM operating_core_events
    UNION ALL SELECT audit_id FROM operating_core_audit
  `).all();
  assert.match(thirdResult.customerId, /^customer:ironwrap:[0-9a-f]{64}$/);
  assert.match(thirdResult.leadId, /^lead:ironwrap:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(ids), /a\/b|a\?b|example\.invalid/);
});

test("a verified customer association binds exactly and rejects contact lookup drift", async () => {
  const db = new TestD1();
  const original = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000005",
    payload_json: JSON.stringify({ address: "5 Main Street", service: "roof" }),
  });
  seedEnvelope(db, original);
  await materializeOperatingCore(env(db), original);

  const conflicting = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000006",
    payload_json: JSON.stringify({
      address: "6 Main Street",
      service: "roof",
      owned_association: {
        verification_status: "verified",
        customer_id: "provider-customer-claimed",
      },
    }),
  });
  seedEnvelope(db, conflicting);
  await assert.rejects(materializeOperatingCore(env(db), conflicting), /operating_core_customer_identity_conflict/);
  assert.equal(rows(db, "operating_leads"), 1);
  assert.equal(rows(db, "operating_customers"), 1);
});

test("a verified association without an exact customer identity fails closed", async () => {
  const db = new TestD1();
  const rec = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-000000000007",
    payload_json: JSON.stringify({
      address: "7 Main Street",
      owned_association: { verification_status: "verified", roof_job_id: "provider-job-7" },
    }),
  });
  seedEnvelope(db, rec);
  await assert.rejects(
    materializeOperatingCore(env(db), rec),
    /operating_core_verified_association_customer_missing/,
  );
  assert.equal(rows(db, "operating_leads"), 0);
  assert.equal(rows(db, "operating_customers"), 0);
});

test("a verified association reuses the exact customer and job across source envelopes", async () => {
  const db = new TestD1();
  const association = {
    verification_status: "verified",
    customer_id: "provider-customer-bound",
    property_key: "provider-property-bound",
    roof_job_id: "provider-job-bound",
  };
  const first = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-00000000000a",
    payload_json: JSON.stringify({
      address: "10 Main Street",
      service: "roof",
      instant_estimate: true,
      estimate_project_id: "estimate-bound",
      estimate_low: "1000",
      estimate_high: "2000",
      owned_association: association,
    }),
  });
  const second = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-00000000000b",
    payload_json: JSON.stringify({
      address: "10 Main Street",
      service: "roof",
      instant_estimate: true,
      estimate_project_id: "estimate-bound",
      estimate_low: "1000",
      estimate_high: "2000",
      owned_association: association,
    }),
  });
  seedEnvelope(db, first);
  seedEnvelope(db, second);
  const firstResult = await materializeOperatingCore(env(db), first);
  const secondResult = await materializeOperatingCore(env(db), second);
  assert.equal(firstResult.customerId, secondResult.customerId);
  assert.equal(firstResult.roofJobId, secondResult.roofJobId);
  assert.notEqual(firstResult.leadId, secondResult.leadId);
  assert.equal(rows(db, "operating_customers"), 1);
  assert.equal(rows(db, "operating_roof_jobs"), 1);
  assert.equal(rows(db, "operating_instant_estimates"), 1);
  assert.equal(rows(db, "operating_leads"), 2);
  assert.equal(rows(db, "operating_core_audit"), 2);
});

test("concurrent shared-job winner is detected instead of returning a false success", async () => {
  const sharedAssociation = (customerId: string) => ({
    verification_status: "verified",
    customer_id: customerId,
    roof_job_id: "provider-job-shared",
  });
  const winner = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-0000000000w1",
    contact_email: "winner@example.invalid",
    contact_phone: null,
    payload_json: JSON.stringify({
      service: "roof",
      owned_association: sharedAssociation("provider-customer-winner"),
    }),
    raw_key: "raw/race/winner.json",
    dedup_key: "e:winner@example.invalid",
  });
  const loser = envelope({
    envelope_id: "ow_19500000-0000-4000-8000-0000000000l1",
    contact_email: "loser@example.invalid",
    contact_phone: null,
    payload_json: JSON.stringify({
      service: "roof",
      owned_association: sharedAssociation("provider-customer-loser"),
    }),
    raw_key: "raw/race/loser.json",
    dedup_key: "e:loser@example.invalid",
  });
  const db = new TestD1(async () => { await materializeOperatingCore(env(db), winner); });
  seedEnvelope(db, winner);
  seedEnvelope(db, loser);

  await assert.rejects(
    materializeOperatingCore(env(db), loser),
    /operating_core_roof_job_conflict/,
  );
  assert.equal(rows(db, "operating_roof_jobs"), 1);
  assert.equal(rows(db, "operating_core_audit"), 2);
});

test("a changed source envelope cannot masquerade as an idempotent retry", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  await materializeOperatingCore(env(db), rec);
  await assert.rejects(
    materializeOperatingCore(env(db), envelope({
      contact_email: "changed@example.invalid",
      raw_key: "raw/changed-envelope.json",
    })),
    /operating_core_lead_conflict/,
  );
  assert.equal(rows(db, "operating_leads"), 1);
  assert.equal(rows(db, "operating_customers"), 1);
  assert.equal(rows(db, "operating_core_audit"), 1);
});

test("retry cannot overwrite human-owned lifecycle decisions", async () => {
  const db = new TestD1(null, { fullChain: true });
  const rec = envelope();
  seedEnvelope(db, rec);
  await materializeOperatingCore(env(db), rec);
  db.raw.exec(`
    UPDATE operating_leads SET lifecycle_status = 'qualified', version = version + 1;
    UPDATE operating_roof_jobs SET job_status = 'in_progress', current_gate_state = 'in_progress', version = version + 1;
    UPDATE operating_instant_estimates SET status = 'approved', version = version + 1;
  `);
  const { roof_job_id: roofJobId } = db.raw.prepare("SELECT roof_job_id FROM operating_roof_jobs").get() as {
    roof_job_id: string;
  };
  // People clear the five gates a schedule rests on and a schedule binds Crew, through the ledger.
  const user = db.raw.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     VALUES (?, 'ironwrap', ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
  );
  const at = new Date().toISOString();
  for (const [userId, role, access] of [
    ["appu_owner_core_retry", "owner", "owner"],
    ["appu_production_core_retry", "ops", "production"],
    ["appu_field_core_retry", "field", "field"],
  ] as const) {
    const email = `${userId}@example.invalid`;
    user.run(userId, email, userId, role, access, role === "field" ? email : null, at, at);
  }
  clearScheduleGatesInLedger(db.raw, {
    tenantId: "ironwrap",
    roofJobId,
    ownerUserId: "appu_owner_core_retry",
    attesterUserId: "appu_production_core_retry",
    attesterRole: "production",
  });
  db.raw.prepare(
    `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES ('crew:core:retry', 'ironwrap', 'Synthetic Crew', 'Active', 1, ?, ?)`,
  ).run(at, at);
  db.raw.prepare(
    `INSERT INTO fleet_crew_members
       (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
     VALUES ('membership:core:retry', 'ironwrap', 'crew:core:retry', 'appu_field_core_retry', 1, 1, ?, ?)`,
  ).run(at, at);
  bindCrewInLedger(db.raw, { tenantId: "ironwrap", roofJobId, crewId: "crew:core:retry", assignmentId: "assignment:core:retry" });
  const gates = () => db.raw.prepare(
    "SELECT gate, state, version, clearance_decision_id FROM operating_production_gates ORDER BY gate",
  ).all().map((row) => ({ ...row }));
  const cleared = gates();
  await materializeOperatingCore(env(db), rec);
  assert.equal((db.raw.prepare("SELECT lifecycle_status FROM operating_leads").get() as { lifecycle_status: string }).lifecycle_status, "qualified");
  const job = db.raw.prepare("SELECT job_status, current_gate_state FROM operating_roof_jobs").get() as {
    job_status: string;
    current_gate_state: string;
  };
  assert.equal(job.job_status, "in_progress");
  assert.equal(job.current_gate_state, "in_progress");
  assert.deepEqual(gates(), cleared, "every cleared gate survives the retried materialization untouched");
  assert.deepEqual(
    cleared.map((row) => [row.gate, row.state]),
    [
      ["Access", "ready"], ["Completion", "blocked"], ["Crew", "complete"], ["Deposit", "waived"],
      ["Materials", "ready"], ["Safety", "ready"], ["Weather", "ready"],
    ],
  );
  assert.equal((db.raw.prepare("SELECT status FROM operating_instant_estimates").get() as { status: string }).status, "approved");
});

test("D1 guards reject skipped versions, identity rewrites, and event deletion", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  await materializeOperatingCore(env(db), rec);
  assert.throws(
    () => db.raw.exec("UPDATE operating_leads SET version = version + 2"),
    /operating_leads_version_conflict/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE operating_leads SET source_envelope_id = 'other-envelope', version = version + 1"),
    /operating_leads_identity_immutable/,
  );
  assert.throws(
    () => db.raw.exec("DELETE FROM operating_core_events"),
    /operating_core_events_append_only/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE operating_consents SET status = 'revoked'"),
    /operating_consents_append_only/,
  );
  assert.throws(
    () => db.raw.exec("DELETE FROM operating_consents"),
    /operating_consents_append_only/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE operating_instant_estimates SET range_low_cents = 12.5, version = version + 1"),
    /CHECK constraint failed/,
  );
});

test("tenant scope keeps identical contacts and source envelopes isolated", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  await materializeOperatingCore(env(db, "ironwrap"), rec);
  await materializeOperatingCore(env(db, "iroof"), rec);
  assert.equal(rows(db, "operating_customers", "ironwrap"), 1);
  assert.equal(rows(db, "operating_customers", "iroof"), 1);
  assert.equal(rows(db, "operating_leads", "ironwrap"), 1);
  assert.equal(rows(db, "operating_leads", "iroof"), 1);
  assert.equal(
    Number((db.raw.prepare("SELECT COUNT(*) AS count FROM operating_customers").get() as { count: number }).count),
    2,
  );
});

test("malformed money rejects before the D1 batch, leaving no partial facts", async () => {
  const db = new TestD1();
  const rec = envelope({
    payload_json: JSON.stringify({ instant_estimate: true, estimate_low: "12.345", service: "roof" }),
  });
  seedEnvelope(db, rec);
  await assert.rejects(materializeOperatingCore(env(db), rec), /operating_core_money_invalid/);
  for (const table of [
    "operating_leads", "operating_customers", "operating_properties", "operating_roof_jobs",
    "operating_production_gates", "operating_instant_estimates", "operating_consents",
    "operating_core_events", "operating_core_audit",
  ]) assert.equal(rows(db, table), 0, table);
});

test("migration and recovery contracts name every operating-core table", () => {
  const migration = readFileSync(new URL("../migrations/0090_operating_core.sql", import.meta.url), "utf8");
  for (const table of [
    "operating_leads", "operating_customers", "operating_properties", "operating_roof_jobs",
    "operating_production_gates", "operating_instant_estimates", "operating_consents",
    "operating_core_events", "operating_core_audit",
  ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
});
