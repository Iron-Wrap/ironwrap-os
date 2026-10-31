// A crew's Today run sheet names each job's customer, so a stop reads "{customer} · {street} ·
// {code}" without opening the job. The name must be the one the crew job page already shows for
// the same job, and only for the crew's own jobs: Today never names another crew's or another
// tenant's customer.
//
// Real SQLite over the full migration chain, driven through the Today and job routes, so the
// tenant and assignment scoping under test is the SQL that ships, not a mock's idea of it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import { recordOperatingJobAssignment } from "../src/operating-job-assignment-store.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "otherco";
const AT = "2026-03-01T10:00:00.000Z";
const SAVED_AT = "2026-03-01T11:00:00.000Z";
const START = "2026-03-02T15:00:00.000Z";
const GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  /** Every bound statement, so a test can count the reads one route made. */
  readonly reads: Array<{ sql: string; args: unknown[] }> = [];

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql, this.raw.prepare(sql));
  }
}

class SqliteStatement {
  private readonly db: SqliteD1;
  private readonly sql: string;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(db: SqliteD1, sql: string, statement: StatementSync, args: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    this.db.reads.push({ sql: this.sql, args });
    return new SqliteStatement(this.db, this.sql, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.args as never[])) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...(this.args as never[])) as T[] };
  }

  async run() {
    const result = this.statement.run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function seedUser(db: SqliteD1, tenantId: string, userId: string, role: "owner" | "field") {
  db.raw
    .prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
    )
    .run(
      userId,
      tenantId,
      `${userId}@example.invalid`,
      userId,
      role,
      role,
      // The schema requires a field login to carry its compatibility user id.
      role === "field" ? `${userId}@example.invalid` : null,
      AT,
      AT,
    );
}

/** One office owner per tenant, to record assignments. */
function seedTenant(db: SqliteD1, tenantId: string): { ownerId: string } {
  const ownerId = `appu_owner_${tenantId}`;
  seedUser(db, tenantId, ownerId, "owner");
  return { ownerId };
}

function seedCrew(db: SqliteD1, tenantId: string, crewId: string, workerId: string) {
  seedUser(db, tenantId, workerId, "field");
  db.raw
    .prepare(
      `INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
       VALUES (?, ?, 'Synthetic Crew', 'Active', 1, ?, ?)`,
    )
    .run(crewId, tenantId, AT, AT);
  db.raw
    .prepare(
      `INSERT INTO fleet_crew_members
         (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(`membership:${crewId}`, tenantId, crewId, workerId, AT, AT);
}

interface JobSeed {
  tenantId: string;
  suffix: string;
  /** null seeds a job whose customer row is absent, so it has no customer name to show. */
  customerName: string | null;
}

function seedJob(
  db: SqliteD1,
  input: JobSeed,
): { roofJobId: string; customerId: string; customerPhone: string } {
  const roofJobId = `JOB-TODAY-${input.suffix}`;
  // Unique per tenant by schema; derived from the suffix so every seeded customer differs.
  const customerPhone = `+1403555${input.suffix.charCodeAt(0) * 100 + input.suffix.charCodeAt(1)}`;
  const customerId = `customer:today:${input.suffix.toLowerCase()}`;
  const leadId = `lead:today:${input.suffix.toLowerCase()}`;
  const envelopeId = `ow_today_${input.suffix.toLowerCase()}`;
  db.raw
    .prepare(
      `INSERT INTO envelopes
         (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status,
          tenant_id, created_at, updated_at)
       VALUES (?, 'manual', 'Synthetic Seed', ?, '{}', ?, ?, 'reconciled', ?, ?, ?)`,
    )
    .run(
      envelopeId,
      `${envelopeId}@example.invalid`,
      `raw/today/${envelopeId}.json`,
      AT,
      input.tenantId,
      AT,
      AT,
    );
  db.raw
    .prepare(
      `INSERT INTO operating_leads
         (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
          lifecycle_status, version, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', 'Synthetic Lead', ?, 'qualified', 1, ?, ?)`,
    )
    .run(leadId, input.tenantId, envelopeId, `${leadId}@example.invalid`, AT, AT);
  if (input.customerName !== null) {
    db.raw
      .prepare(
        `INSERT INTO operating_customers
           (customer_id, tenant_id, source_envelope_id, display_name, contact_phone,
            contact_email, lifecycle_status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .run(
        customerId,
        input.tenantId,
        envelopeId,
        input.customerName,
        customerPhone,
        `${customerId}@example.invalid`,
        AT,
        AT,
      );
  } else {
    // D1 enforces the customer foreign key, so production cannot hold this row. The read must still
    // answer null rather than throw or borrow a name if it ever meets one.
    db.raw.exec("PRAGMA foreign_keys = OFF");
  }
  try {
    db.raw
      .prepare(
        `INSERT INTO operating_roof_jobs
           (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number,
            service_type, job_status, current_gate_state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ironwrap', ?, 'Metal re-roof', 'in_progress', 'ready', 1, ?, ?)`,
      )
      .run(
        roofJobId,
        input.tenantId,
        leadId,
        customerId,
        envelopeId,
        `IW-${input.suffix}`,
        AT,
        AT,
      );
  } finally {
    db.raw.exec("PRAGMA foreign_keys = ON");
  }
  for (const gate of GATES) {
    db.raw
      .prepare(
        `INSERT INTO operating_production_gates
           (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state, owner_user,
            assigned_at, due_at, blocker_reason, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', 'office@example.invalid', ?, ?, 'No synthetic blocker', 1, ?, ?)`,
      )
      .run(
        `gate:today:${input.suffix.toLowerCase()}:${gate.toLowerCase()}`,
        input.tenantId,
        roofJobId,
        envelopeId,
        gate,
        AT,
        START,
        AT,
        AT,
      );
  }
  return { roofJobId, customerId, customerPhone };
}

async function assign(
  appEnv: AppEnv,
  input: { tenantId: string; roofJobId: string; crewId: string; workerId: string; ownerId: string },
) {
  await recordOperatingJobAssignment(
    { ...appEnv, APP_TENANT_ID: input.tenantId } as AppEnv,
    {
      tenantId: input.tenantId,
      roofJobId: input.roofJobId,
      expectedRoofJobVersion: 1,
      crewId: input.crewId,
      expectedCrewVersion: 1,
      authorityRequirements: [
        {
          authority_record_id: `authority:${input.roofJobId.toLowerCase()}`,
          subject_type: "Person",
          subject_role: "Worker",
          subject_ref: input.workerId,
          authority_kind: "Worker Competency",
          scope_type: "Roof Job",
          scope_ref: input.roofJobId,
          version: 1,
          state_digest_sha256: "c".repeat(64),
        },
      ],
      scheduledStart: START,
      scheduledEnd: null,
      actorUserId: input.ownerId,
      idempotencyKey: `today:schedule:${input.roofJobId.toLowerCase()}`,
    },
    new Date(SAVED_AT),
  );
}

function appEnv(db: SqliteD1): AppEnv {
  return {
    APP_TENANT_ID: TENANT,
    APP_TIME_ZONE: "America/Edmonton",
    DB: db,
  } as unknown as AppEnv;
}

function auth(role: AppRole, userId: string, tenantId = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: AT,
      session_expires_at: "2026-03-02T10:00:00.000Z",
      revoked_at: null,
      user_id: userId,
      tenant_id: tenantId,
      email_normalized: `${userId}@example.invalid`,
      display_name: userId,
      role,
      frappe_user_id: role === "field" ? `${userId}@example.invalid` : null,
      active: 1,
      created_by: "test-seed",
      created_at: AT,
      updated_at: AT,
      device_id: null,
      device_proof_hash: null,
    },
  };
}

interface TodayJob {
  id: string;
  customer_display_name: string | null;
}

async function today(db: SqliteD1, who: AuthContext): Promise<{ jobs: TodayJob[]; raw: string }> {
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/today"),
    appEnv(db),
    who,
  );
  assert.equal(response.status, 200, `Today answered ${response.status}`);
  const raw = await response.text();
  return { jobs: (JSON.parse(raw) as { jobs: TodayJob[] }).jobs, raw };
}

async function jobPage(
  db: SqliteD1,
  who: AuthContext,
  jobId: string,
): Promise<{ contact: { display_name: string | null } | null; stale: string[] }> {
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/jobs/${encodeURIComponent(jobId)}`),
    appEnv(db),
    who,
  );
  assert.equal(response.status, 200, `job route answered ${response.status}`);
  const model = (await response.json()) as {
    packet: { contact: { display_name: string | null } | null };
    stale_fields: string[];
  };
  return { contact: model.packet.contact, stale: model.stale_fields };
}

/** Two crews in this tenant and one crew in another, each assigned its own job. */
function fixture() {
  const db = new SqliteD1();
  const home = seedTenant(db, TENANT);
  const other = seedTenant(db, OTHER_TENANT);
  seedCrew(db, TENANT, "crew:today:north", "appu_field_north");
  seedCrew(db, TENANT, "crew:today:south", "appu_field_south");
  seedCrew(db, OTHER_TENANT, "crew:today:other", "appu_field_other");
  const north = seedJob(db, {
    tenantId: TENANT,
    suffix: "N1",
    customerName: "Synthetic Harbour Holdings",
  });
  const northSecond = seedJob(db, {
    tenantId: TENANT,
    suffix: "N2",
    customerName: "Synthetic Birchwood Co-op",
  });
  const south = seedJob(db, {
    tenantId: TENANT,
    suffix: "S1",
    customerName: "Synthetic Ridge Partners",
  });
  const elsewhere = seedJob(db, {
    tenantId: OTHER_TENANT,
    suffix: "O1",
    customerName: "Synthetic Otherco Client",
  });
  return { db, home, other, north, northSecond, south, elsewhere };
}

async function assignFixture(f: ReturnType<typeof fixture>) {
  const env = appEnv(f.db);
  for (const roofJobId of [f.north.roofJobId, f.northSecond.roofJobId]) {
    await assign(env, {
      tenantId: TENANT,
      roofJobId,
      crewId: "crew:today:north",
      workerId: "appu_field_north",
      ownerId: f.home.ownerId,
    });
  }
  await assign(env, {
    tenantId: TENANT,
    roofJobId: f.south.roofJobId,
    crewId: "crew:today:south",
    workerId: "appu_field_south",
    ownerId: f.home.ownerId,
  });
  await assign(env, {
    tenantId: OTHER_TENANT,
    roofJobId: f.elsewhere.roofJobId,
    crewId: "crew:today:other",
    workerId: "appu_field_other",
    ownerId: f.other.ownerId,
  });
}

test("Today names each of the crew's jobs' customer exactly as the job page does", async () => {
  const f = fixture();
  await assignFixture(f);
  const crew = auth("field", "appu_field_north");

  f.db.reads.length = 0;
  const { jobs, raw } = await today(f.db, crew);
  const customerReads = f.db.reads.filter(({ sql }) => sql.includes("FROM operating_customers"));

  assert.deepEqual(
    jobs.map(({ id, customer_display_name }) => ({ id, customer_display_name })).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    [
      { id: f.north.roofJobId, customer_display_name: "Synthetic Harbour Holdings" },
      { id: f.northSecond.roofJobId, customer_display_name: "Synthetic Birchwood Co-op" },
    ],
  );
  for (const job of jobs) {
    const page = await jobPage(f.db, crew, job.id);
    assert.equal(job.customer_display_name, page.contact?.display_name);
  }
  // One batched read for the whole run sheet, not one per job.
  assert.equal(customerReads.length, 1);
  // The run sheet names the customer; the phone stays on the job page.
  assert.ok(!raw.includes(f.north.customerPhone));
  assert.ok(!raw.includes(f.northSecond.customerPhone));
});

test("Today names no customer when the job has no customer name, as the job page does", async () => {
  const f = fixture();
  const nameless = seedJob(f.db, {
    tenantId: TENANT,
    suffix: "N3",
    customerName: null,
  });
  await assignFixture(f);
  await assign(appEnv(f.db), {
    tenantId: TENANT,
    roofJobId: nameless.roofJobId,
    crewId: "crew:today:north",
    workerId: "appu_field_north",
    ownerId: f.home.ownerId,
  });
  const crew = auth("field", "appu_field_north");

  const { jobs } = await today(f.db, crew);
  const row = jobs.find((job) => job.id === nameless.roofJobId);
  assert.ok(row, "the nameless job is still on the run sheet");
  assert.equal(row.customer_display_name, null);
  // The other jobs keep their own names; a missing one is never filled from a neighbour.
  assert.equal(
    jobs.find((job) => job.id === f.north.roofJobId)?.customer_display_name,
    "Synthetic Harbour Holdings",
  );

  const page = await jobPage(f.db, crew, nameless.roofJobId);
  assert.equal(page.contact, null);
  assert.ok(page.stale.includes("packet.contact.display_name"));
});

test("another crew's job and its customer stay off this crew's Today", async () => {
  const f = fixture();
  await assignFixture(f);

  f.db.reads.length = 0;
  const north = await today(f.db, auth("field", "appu_field_north"));
  const customerReads = f.db.reads.filter(({ sql }) => sql.includes("FROM operating_customers"));

  assert.ok(!north.jobs.some((job) => job.id === f.south.roofJobId));
  assert.ok(!north.raw.includes("Synthetic Ridge Partners"));
  assert.ok(!north.raw.includes(f.south.customerId));
  // The south crew's customer is never even read on the north crew's behalf.
  assert.ok(customerReads.every(({ args }) => !args.includes(f.south.customerId)));

  const south = await today(f.db, auth("field", "appu_field_south"));
  assert.deepEqual(
    south.jobs.map(({ id, customer_display_name }) => ({ id, customer_display_name })),
    [{ id: f.south.roofJobId, customer_display_name: "Synthetic Ridge Partners" }],
  );
  assert.ok(!south.raw.includes("Synthetic Harbour Holdings"));
  assert.ok(!south.raw.includes("Synthetic Birchwood Co-op"));
});

test("another tenant's job and its customer never reach Today, even on a whole-tenant read", async () => {
  const f = fixture();
  await assignFixture(f);

  for (const who of [auth("field", "appu_field_north"), auth("ops", "appu_ops_today")]) {
    f.db.reads.length = 0;
    const { jobs, raw } = await today(f.db, who);
    assert.ok(jobs.length > 0, `${who.session.role} sees its own tenant's work`);
    assert.ok(!jobs.some((job) => job.id === f.elsewhere.roofJobId));
    assert.ok(!raw.includes("Synthetic Otherco Client"), `${who.session.role} saw another tenant`);
    assert.ok(!raw.includes(f.elsewhere.customerId));
    for (const { sql, args } of f.db.reads.filter(({ sql }) =>
      sql.includes("FROM operating_customers"),
    )) {
      assert.match(sql, /tenant_id = \?/);
      assert.equal(args[0], TENANT);
    }
  }

  const theirs = await today(f.db, auth("field", "appu_field_other", OTHER_TENANT));
  assert.deepEqual(
    theirs.jobs.map(({ id, customer_display_name }) => ({ id, customer_display_name })),
    [{ id: f.elsewhere.roofJobId, customer_display_name: "Synthetic Otherco Client" }],
  );
  assert.ok(!theirs.raw.includes("Synthetic Harbour Holdings"));
});
