import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateAuthority, readsAuthority } from "../src/agents/authority-read.ts";
import { catalogSpecialist } from "../src/agents/catalog.ts";
import { handleAgentHostApi } from "../src/agents/api.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, type BoundStatement } from "../src/agents/store.ts";
import { ROLE_PERMISSIONS, type AppEnv } from "../src/app-types.ts";
import { recordAuthorityReadback, type AuthorityRequirement } from "../src/authority-records.ts";
import { recordOperatingJobAssignment } from "../src/operating-job-assignment-store.ts";

const TENANT = "ironwrap";
const TOKEN = "synthetic-agent-host-token-0001";
const NOW = "2026-08-21T08:00:00.000Z";
const JOB = "job:authority-read:0001";
const CREW = "crew:authority-read:0001";
const OWNER = "appu_owner_authority_read";
const WORKERS = ["appu_field_authority_a", "appu_field_authority_b"];
const RECORD = "authority:authority-read:worker";
const hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** Real SQLite with every migration and D1's one-transaction batch; `failOn` makes matching reads fail. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  failOn: RegExp | null = null;
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) this.raw.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        const read = () => {
          if (this.failOn?.test(sql)) throw new Error("D1_ERROR: synthetic read failure");
        };
        return {
          first: async <T>() => (read(), (this.raw.prepare(sql).get(...args) ?? null) as T | null),
          all: async <T>() => (read(), { results: this.raw.prepare(sql).all(...args) as T[] }),
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

/** The authority the assignment requires of its first crew member, frozen when it was scheduled. */
const REQUIREMENT: AuthorityRequirement = {
  authority_record_id: RECORD,
  subject_type: "Person",
  subject_role: "Worker",
  subject_ref: WORKERS[0],
  authority_kind: "Worker Competency",
  authority_scope: "field installation",
  scope_type: "Roof Job",
  scope_ref: JOB,
  issuer_name: "IronWrap Production",
  issuer_jurisdiction: "AB-CA",
  issuer_reference: "internal:competency:synthetic-1",
  source_version: "assessment:synthetic-1",
  version: 1,
  state_digest_sha256: "e".repeat(64),
};

/** A synthetic job ready for scheduling, its crew of two field people, the assignment and the record. */
async function seed(db: SqliteD1) {
  const env = { DB: db } as unknown as AppEnv;
  const user = db.raw.prepare(
    `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
  );
  user.run(OWNER, TENANT, `${OWNER}@example.invalid`, "Synthetic owner", "owner", "owner", null, NOW, NOW);
  for (const worker of WORKERS) user.run(worker, TENANT, `${worker}@example.invalid`, "Synthetic crew member", "field", "field", `${worker}@example.invalid`, NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO envelopes (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status, created_at, updated_at)
       VALUES ('ow_authority_read_0001', 'manual', 'Synthetic Customer', 'customer@example.invalid', '{}', 'raw/authority-read/0001.json', ?, 'reconciled', ?, ?)`,
    )
    .run(NOW, NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name, contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES ('lead:authority-read:0001', ?, 'ow_authority_read_0001', 'raw/authority-read/0001.json', 'manual', 'Synthetic Customer', 'customer@example.invalid', 'qualified', 1, ?, ?)`,
    )
    .run(TENANT, NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name, contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES ('customer:authority-read:0001', ?, 'ow_authority_read_0001', 'raw/authority-read/0001.json', 'Synthetic Customer', 'customer@example.invalid', 'active', 1, ?, ?)`,
    )
    .run(TENANT, NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, source_raw_key, brand, job_number, service_type, job_status, current_gate_state, version, created_at, updated_at)
       VALUES (?, ?, 'lead:authority-read:0001', 'customer:authority-read:0001', 'ow_authority_read_0001', 'raw/authority-read/0001.json', 'ironwrap', 'IW-AR-1', 'roof_replacement', 'qualified', 'ready', 1, ?, ?)`,
    )
    .run(JOB, TENANT, NOW, NOW);
  const gate = db.raw.prepare(
    `INSERT INTO operating_production_gates (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key, gate, state, owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
     VALUES (?, ?, ?, 'ow_authority_read_0001', 'raw/authority-read/0001.json', ?, 'ready', ?, ?, ?, 'No active blocker', 1, ?, ?)`,
  );
  for (const name of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) gate.run(`gate:authority-read:${name.toLowerCase()}`, TENANT, JOB, name, OWNER, NOW, NOW, NOW, NOW);
  db.raw.prepare("INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at) VALUES (?, ?, 'Synthetic Crew', 'Active', 1, ?, ?)").run(CREW, TENANT, NOW, NOW);
  WORKERS.forEach((worker, n) =>
    db.raw
      .prepare("INSERT INTO fleet_crew_members (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)")
      .run(`membership:authority-read:${n}`, TENANT, CREW, worker, NOW, NOW),
  );
  const scheduled = await recordOperatingJobAssignment(
    env,
    {
      tenantId: TENANT,
      roofJobId: JOB,
      expectedRoofJobVersion: 1,
      crewId: CREW,
      expectedCrewVersion: 1,
      authorityRequirements: [REQUIREMENT],
      scheduledStart: "2026-08-24T14:00:00.000Z",
      scheduledEnd: "2026-08-24T22:00:00.000Z",
      supersedesAssignmentId: null,
      correctionReason: null,
      actorUserId: OWNER,
      idempotencyKey: "authority-read:assignment:0001",
    },
    new Date(NOW),
  );
  await recordAuthorityReadback(env, {
    readbackId: "readback:authority-read:0001",
    tenantId: TENANT,
    authorityRecordId: RECORD,
    authorityVersion: 1,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: WORKERS[0],
    organization: null,
    authorityKind: "Worker Competency",
    authorityScope: "field installation",
    scopeType: "Roof Job",
    scopeRef: JOB,
    roofJob: JOB,
    scopeJson: "{}",
    issuerName: "IronWrap Production",
    issuerJurisdiction: "AB-CA",
    issuerReference: "internal:competency:synthetic-1",
    issuerSourceVersion: "assessment:synthetic-1",
    verificationState: "verified",
    evidenceRefsJson: JSON.stringify([{ ref: "r2://authority/synthetic-competency-1.pdf", sha256: "c".repeat(64) }]),
    evidenceSha256: "c".repeat(64),
    authorityStateDigestSha256: "e".repeat(64),
    authorityEffectiveFrom: "2026-08-01",
    authorityExpiresAt: "2026-12-31",
    authorityRevokedAt: null,
    supersedesAuthorityRecordId: null,
    authorityVerificationMethod: "Internal Competency Assessment",
    issuerReceiptSha256: null,
    observedByUserId: OWNER,
    observedAt: NOW,
    actionId: null,
  });
  return scheduled.assignment.assignment_id;
}

/** Every table's rows, so a read can be shown to change nothing. */
function dump(raw: DatabaseSync): Map<string, string> {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return new Map(tables.map(({ name }) => [name, JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all())]));
}

test("authority.evaluate reads the authority records as the desk and the work fence do, and writes nothing", async () => {
  const db = new SqliteD1();
  const assignmentId = await seed(db);
  const env = { DB: db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN };
  const host = async (path: string, body: unknown) => {
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      env,
      () => Date.parse(NOW),
    );
    return (await response.json()) as any;
  };
  const signal = await appendSignal(db, TENANT, { kind: "watch", specialist_id: "compliance", watch_id: "assignment_check", source: "synthetic-test", subject: null, content: { text: "Synthetic: an assignment was committed." }, dedupe_key: "authority-read:watch" }, NOW);
  assert.ok("signal_id" in signal);
  const run = await host("/api/v1/agents/runs", { signal_id: signal.signal_id, specialist_id: "compliance", host_run_key: "authority-read-run" });
  const evaluate = async (args: Record<string, unknown>) => {
    const proposal = { action_id: "authority.evaluate", args, citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }] };
    return await host(`/api/v1/agents/runs/${run.run_id}/steps`, { ...proposal, step_key: hex(canonicalJson(proposal)) });
  };
  const args = { authority_id: RECORD, job_id: JOB, applicability_id: "applicability:synthetic-1", assignment_id: assignmentId };

  const before = dump(db.raw);
  const read = await evaluate(args);
  assert.equal(read.decision, "recorded");
  assert.deepEqual(read.evaluation, {
    authority: {
      authority_record_id: RECORD,
      head: {
        authority_version: 1,
        authority_kind: "Worker Competency",
        scope_type: "Roof Job",
        scope_ref: JOB,
        verification_state: "verified",
        authority_effective_from: "2026-08-01",
        authority_expires_at: "2026-12-31",
        authority_revoked_at: null,
      },
      denial_code: null,
    },
    assignment: {
      assignment_id: assignmentId,
      roof_job_id: JOB,
      assignment_version: 1,
      requirements: [{ requirement: REQUIREMENT, ok: true, denial_code: null, authority_record_id: RECORD, authority_version: 1 }],
    },
  });
  // Read only: the step's own receipt and its ledger event are the only new rows anywhere.
  const after = dump(db.raw);
  const changed = [...after.keys()].filter((table) => after.get(table) !== before.get(table));
  assert.deepEqual(changed, ["agent_run_events", "agent_run_steps"]);
  for (const table of changed) {
    assert.equal(JSON.parse(after.get(table)!).length, JSON.parse(before.get(table)!).length + 1, table);
  }
  // An A0 read uses no tool and has no readback; the evaluation is the answer, not a record.
  assert.deepEqual([read.receipt.tool, read.receipt.readback, read.receipt.permit.kind], [null, null, "none"]);

  // A record the tenant does not hold, and an assignment that is not the job's current one.
  const unknown = await evaluate({ ...args, authority_id: "authority:authority-read:none", assignment_id: "assignment:authority-read:none" });
  assert.deepEqual([unknown.decision, unknown.evaluation], ["recorded", { authority: null, assignment: null }]);
  // A refused step reads nothing.
  const refused = await evaluate({ ...args, waive: true });
  assert.deepEqual([refused.decision, refused.reason_codes, Object.hasOwn(refused, "evaluation")], ["abstained", ["action_unregistered"], false]);
  // A role that may not read authority records reads none of them.
  assert.deepEqual(await evaluateAuthority(db, TENANT, "sales", args, NOW), { reason: "role_may_not_read" });
  assert.deepEqual(await evaluateAuthority(db, TENANT, "production", args, NOW), read.evaluation);
});

/** A compliance run on a synthetic watch, and a proposer of authority.evaluate steps on it. */
async function complianceRun(db: SqliteD1) {
  const env = { DB: db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN };
  const host = async (path: string, body: unknown) => {
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      env,
      () => Date.parse(NOW),
    );
    return (await response.json()) as any;
  };
  const signal = await appendSignal(db, TENANT, { kind: "watch", specialist_id: "compliance", watch_id: "assignment_check", source: "synthetic-test", subject: null, content: { text: "Synthetic: an assignment was committed." }, dedupe_key: "authority-read:stops" }, NOW);
  assert.ok("signal_id" in signal);
  const run = await host("/api/v1/agents/runs", { signal_id: signal.signal_id, specialist_id: "compliance", host_run_key: "authority-read-stops" });
  return async (args: Record<string, unknown>) => {
    const proposal = { action_id: "authority.evaluate", args, citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }] };
    return await host(`/api/v1/agents/runs/${run.run_id}/steps`, { ...proposal, step_key: hex(canonicalJson(proposal)) });
  };
}

test("a read its reader may not make, or one that fails, abstains with why and is never recorded as done", async () => {
  const db = new SqliteD1();
  const assignmentId = await seed(db);
  const evaluate = await complianceRun(db);
  const args = { authority_id: RECORD, job_id: JOB, applicability_id: "applicability:synthetic-1", assignment_id: assignmentId };
  const failedCheck = (result: any) => result.receipt.policy.checks.find((check: { passed: boolean }) => !check.passed)?.check;

  // Refused: for this test the compliance checker reads as field, which reads no job assignment.
  const compliance = catalogSpecialist("compliance")!;
  const reviewer = compliance.reviewer_role;
  compliance.reviewer_role = "field";
  let refused: any;
  let repeated: any;
  try {
    refused = await evaluate(args);
    repeated = await evaluate(args);
  } finally {
    compliance.reviewer_role = reviewer;
  }
  assert.deepEqual(
    [refused.decision, refused.outcome, refused.reason_codes, refused.evaluation, failedCheck(refused)],
    ["abstained", "abstained", ["out_of_scope"], { reason: "role_may_not_read" }, "read_rights"],
  );
  // A repeat of the step answers the same, from its receipt.
  assert.deepEqual([repeated.step_id, repeated.evaluation], [refused.step_id, { reason: "role_may_not_read" }]);

  // Failed: the authority records cannot be read now.
  db.failOn = /authority_record_readbacks/;
  const failed = await evaluate({ ...args, applicability_id: "applicability:synthetic-2" });
  db.failOn = null;
  assert.deepEqual(
    [failed.decision, failed.reason_codes, failed.evaluation, failedCheck(failed), failed.receipt.needs_from_you?.reviewer_role],
    ["abstained", ["fact_missing"], { reason: "read_failed" }, "read", "production"],
  );
  assert.doesNotMatch(String(failed.receipt.did), /finished/);

  // Neither stop is recorded as done; the same read succeeds once the records can be read.
  const outcomes = db.raw.prepare("SELECT outcome, reason_code FROM agent_run_steps WHERE action_id = 'authority.evaluate' ORDER BY step_seq").all();
  assert.deepEqual(outcomes.map((row) => ({ ...row })), [{ outcome: "abstained", reason_code: "out_of_scope" }, { outcome: "abstained", reason_code: "fact_missing" }]);
  const read = await evaluate({ ...args, applicability_id: "applicability:synthetic-3" });
  assert.deepEqual([read.decision, read.evaluation.assignment.assignment_id], ["recorded", assignmentId]);
});

test("job assignments read only for a role that reads them as well as authority records", async () => {
  // field holds authority:read but reads only the jobs it is assigned, so it reaches no assignment.
  assert.deepEqual(
    Object.fromEntries(Object.keys(ROLE_PERMISSIONS).map((role) => [role, readsAuthority(role)])),
    { owner: true, ops: true, sales: false, production: true, accounting: false, field: false },
  );
  assert.equal(readsAuthority(null), false);
  assert.equal(readsAuthority("auditor"), false);
  const db = new SqliteD1();
  const assignmentId = await seed(db);
  const args = { authority_id: RECORD, job_id: JOB, applicability_id: "applicability:synthetic-1", assignment_id: assignmentId };
  assert.deepEqual(await evaluateAuthority(db, TENANT, "field", args, NOW), { reason: "role_may_not_read" });
  const read = await evaluateAuthority(db, TENANT, "ops", args, NOW);
  assert.ok("assignment" in read && read.assignment?.assignment_id === assignmentId);
});
