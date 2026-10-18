import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleAgentHostApi, handleAgentTeamAppRoute } from "../src/agents/api.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, type BoundStatement } from "../src/agents/store.ts";
import { handleAuthorityRecordRoute } from "../src/authority-record-api.ts";
import {
  listCurrentAuthorityHeads,
  recordAuthorityReadback,
  resolveAuthorityRequirement,
  type AuthorityRecordReadback,
  type RecordAuthorityReadbackInput,
} from "../src/authority-records.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const TOKEN = "synthetic-agent-host-token-0001";
const NOW = "2026-10-18T12:00:00.000Z";
const CLOCK = Date.parse(NOW);
// The worker the competency is about. Requirements name the person by this reference.
const WORKER = "appu_test_field";
const CREW = "crew_synthetic_0001";
const JOB = "job-synthetic-0001";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Real SQLite with every migration, D1's atomic batch and trigger-inclusive change counts. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  beforeBatch: (() => void | Promise<void>) | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort())
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
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
    // A concurrent write may commit after the caller read its facts but before this transaction.
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    await hook?.();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
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
    } finally {
      release();
    }
  }
}

const ROLES = ["owner", "ops", "sales", "production", "field"] as const;

function setup() {
  const db = new SqliteD1();
  const auths = new Map<AppRole, AuthContext>();
  const created = new Date(CLOCK - 60_000).toISOString();
  const expires = new Date(CLOCK + 3_600_000).toISOString();
  for (const role of ROLES) {
    const id = `appu_test_${role}`;
    db.raw
      .prepare(
        `INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
      )
      .run(id, TENANT, `${role}@example.invalid`, `Synthetic ${role}`, ["owner", "field"].includes(role) ? role : "ops", role, `${role}@frappe.example.invalid`, created, created);
    db.raw
      .prepare(
        `INSERT INTO app_sessions (session_hash,user_id,tenant_id,created_at,expires_at,last_seen_at,created_ip_hash,created_user_agent_hash)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(hash(role), id, TENANT, created, expires, created, hash("ip"), hash("ua"));
    auths.set(role, {
      session: {
        user_id: id,
        tenant_id: TENANT,
        role,
        session_hash: hash(role),
        session_created_at: created,
        session_expires_at: expires,
        email_normalized: `${role}@example.invalid`,
        display_name: `Synthetic ${role}`,
        frappe_user_id: `${role}@frappe.example.invalid`,
        active: 1,
        created_by: "seed",
        created_at: created,
        updated_at: created,
        revoked_at: null,
        device_id: null,
        device_proof_hash: null,
      },
      rawSessionToken: "synthetic-person-session",
      csrfToken: "synthetic-csrf",
      permissions: permissionsForRole(role),
    });
  }
  const env = { DB: db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN } as unknown as AppEnv;
  const scalar = (sql: string, ...values: Array<string | number | null>) => db.raw.prepare(sql).get(...values) as Record<string, any>;
  const rows = (sql: string, ...values: Array<string | number | null>) =>
    db.raw.prepare(sql).all(...values).map((row) => ({ ...row })) as Array<Record<string, any>>;

  /** One `/people` command, as the signed-in role sends it. */
  async function command(role: AppRole, body: Record<string, unknown>, key = `people-${hash(canonicalJson(body)).slice(0, 16)}`, csrf = "synthetic-csrf") {
    const response = await handleAuthorityRecordRoute(
      new Request("https://app.example.invalid/api/v1/authority-records/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ idempotency_key: key, ...body }),
      }),
      env,
      auths.get(role)!,
      () => CLOCK,
    );
    assert.ok(response);
    return { status: response.status, body: (await response.json()) as any };
  }

  /** A person's decision on the step's version as it stands now, or on the version they saw. */
  async function decide(role: AppRole, stepId: string, decision: string, key: string, seenVersion?: number) {
    const row = scalar("SELECT version, args_sha256 FROM agent_run_steps WHERE step_id = ?", stepId);
    const response = await handleAgentTeamAppRoute(
      new Request(`https://bus.example.invalid/api/v1/agent-team/steps/${stepId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "synthetic-csrf", "idempotency-key": key },
        body: JSON.stringify({ decision, expected_version: seenVersion ?? row.version, expected_args_sha256: row.args_sha256 }),
      }),
      env as never,
      auths.get(role)!,
      () => CLOCK,
    );
    return { status: response.status, body: (await response.json()) as any };
  }

  let sequence = 0;
  /** A compliance run about the crew the worker belongs to; its snapshot holds the crew fact. */
  async function complianceRun() {
    const signal = await appendSignal(
      db,
      TENANT,
      {
        kind: "event",
        specialist_id: "compliance",
        watch_id: null,
        source: "synthetic-test",
        subject: { aggregate: "crew", id: CREW },
        content: { text: "Synthetic assessment finished" },
        dedupe_key: `signal:${++sequence}`,
      },
      NOW,
    );
    assert.ok("signal_id" in signal);
    const response = await handleAgentHostApi(
      new Request("https://bus.example.invalid/api/v1/agents/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ signal_id: signal.signal_id, specialist_id: "compliance", host_run_key: `host-run-${sequence}` }),
      }),
      env as never,
      () => CLOCK,
    );
    const opened = (await response.json()) as { run_id: string; context: { facts: Array<{ fact_id: string; version: number }> } };
    const crew = opened.context.facts.find((fact) => fact.fact_id === `crew/${CREW}`);
    assert.ok(crew, "the run snapshot holds the crew fact");
    return {
      run_id: opened.run_id,
      citations: [
        { fact_id: `signal/${signal.signal_id}`, version: 1 },
        { fact_id: crew.fact_id, version: crew.version },
      ],
    };
  }

  async function propose(run: { run_id: string; citations: unknown[] }, args: unknown, actionId = "authority.record") {
    const step = { action_id: actionId, args, citations: run.citations };
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid/api/v1/agents/runs/${run.run_id}/steps`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...step, step_key: hash(canonicalJson(step)) }),
      }),
      env as never,
      () => CLOCK,
    );
    return (await response.json()) as any;
  }

  db.raw
    .prepare("INSERT INTO fleet_crews (crew_id, tenant_id, display_name, status, version, created_at, updated_at) VALUES (?, ?, 'Synthetic Crew', 'Active', 1, ?, ?)")
    .run(CREW, TENANT, NOW, NOW);
  db.raw
    .prepare("INSERT INTO fleet_crew_members (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at) VALUES ('crew_member_0001', ?, ?, ?, 1, 1, ?, ?)")
    .run(TENANT, CREW, WORKER, NOW, NOW);
  return { db, env, auths, scalar, rows, command, decide, complianceRun, propose };
}

function recordCommand(overrides: Record<string, unknown> = {}, record: Record<string, unknown> = {}) {
  return {
    operation: "record",
    authority_kind: "Worker Competency",
    subject_ref: WORKER,
    scope_type: "Roof Job",
    scope_ref: JOB,
    expected_head: null,
    record: {
      authority_scope: "steep-slope shingle installation",
      roof_job: JOB,
      issuer_jurisdiction: "AB-CA",
      issuer_reference: "assessment:synthetic-0001",
      source_version: "rubric:2026-1",
      evidence_refs: [{ ref: "r2://authority/assessment-synthetic-0001.pdf", sha256: "c".repeat(64) }],
      effective_from: "2026-10-01",
      expires_at: "2027-09-30",
      ...record,
    },
    reference: null,
    reason: null,
    ...overrides,
  };
}

const head = (readback: AuthorityRecordReadback) => ({
  authority_record_id: readback.authority_record_id,
  authority_version: readback.authority_version,
});

function verifyCommand(expected: unknown, overrides: Record<string, unknown> = {}) {
  return { ...recordCommand(), operation: "verify", expected_head: expected, record: null, reference: "assessment:synthetic-0001:checked", ...overrides };
}

function revokeCommand(expected: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ...recordCommand(),
    operation: "revoke",
    expected_head: expected,
    record: null,
    reference: "revocation:synthetic-0001",
    reason: "The assessor withdrew the synthetic assessment.",
    ...overrides,
  };
}

const requirement = {
  subject_type: "Person" as const,
  subject_role: "Worker" as const,
  subject_ref: WORKER,
  authority_kind: "Worker Competency" as const,
  scope_type: "Roof Job" as const,
  scope_ref: JOB,
};

/** A row in the worker's identity written outside the native path, as older data could be. */
async function legacyRow(env: AppEnv, overrides: Partial<RecordAuthorityReadbackInput>) {
  const id = overrides.authorityRecordId ?? "competency-legacy";
  const result = await recordAuthorityReadback(env, {
    readbackId: `${id}.legacy-readback`,
    tenantId: TENANT,
    authorityRecordId: id,
    authorityVersion: 1,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: WORKER,
    organization: null,
    authorityKind: "Worker Competency",
    authorityScope: "steep-slope shingle installation",
    scopeType: "Roof Job",
    scopeRef: JOB,
    roofJob: JOB,
    scopeJson: "{}",
    issuerName: TENANT,
    issuerJurisdiction: "AB-CA",
    issuerReference: `assessment:${id}`,
    issuerSourceVersion: "rubric:2026-1",
    verificationState: "unavailable",
    evidenceRefsJson: JSON.stringify([{ ref: "r2://authority/legacy-synthetic.pdf", sha256: "c".repeat(64) }]),
    evidenceSha256: "c".repeat(64),
    authorityStateDigestSha256: hash(id),
    authorityEffectiveFrom: "2026-10-01",
    authorityExpiresAt: "2027-09-30",
    authorityRevokedAt: null,
    supersedesAuthorityRecordId: null,
    authorityVerificationMethod: null,
    issuerReceiptSha256: null,
    observedByUserId: "appu_test_owner",
    observedAt: NOW,
    actionId: null,
    ...overrides,
  });
  assert.equal(result.kind, "recorded");
  return result.readback;
}

test("record, verify and revoke on one database each append one superseding version", async () => {
  const s = setup();
  const recorded = await s.command("owner", recordCommand());
  assert.equal(recorded.status, 201);
  assert.equal(recorded.body.kind, "recorded");
  const v1 = recorded.body.readback as AuthorityRecordReadback;
  assert.equal(v1.authority_version, 1);
  assert.equal(v1.verification_state, "unavailable");
  assert.equal(v1.supersedes_authority_record_id, null);
  assert.equal(v1.authority_verification_method, null);
  assert.equal(v1.person_user, WORKER);
  assert.equal(v1.organization, null);
  assert.equal(v1.scope_json, "{}");
  assert.equal(v1.observed_by_user_id, "appu_test_owner");
  assert.equal(recorded.body.action.status, "applied");
  assert.equal(recorded.body.action.actor_user_id, "appu_test_owner");
  assert.equal(recorded.body.action.expected_version, 1);
  assert.equal(JSON.parse(recorded.body.action.result_json).issuer_readback_id, v1.readback_id);
  assert.equal((await resolveAuthorityRequirement(s.env, { tenantId: TENANT, now: NOW, requirement })).code, "authority_unavailable");

  // A second person verifies: a new version that supersedes the recorded one, never an edit.
  const verified = await s.command("production", verifyCommand(head(v1)));
  assert.equal(verified.status, 201);
  const v2 = verified.body.readback as AuthorityRecordReadback;
  assert.equal(v2.authority_version, 2);
  assert.notEqual(v2.authority_record_id, v1.authority_record_id);
  assert.equal(v2.supersedes_authority_record_id, v1.authority_record_id);
  assert.equal(v2.verification_state, "verified");
  assert.equal(v2.authority_verification_method, "Internal Competency Assessment");
  assert.equal(v2.evidence_sha256, v1.evidence_sha256);
  assert.equal(v2.authority_expires_at, v1.authority_expires_at);
  assert.equal(v2.observed_by_user_id, "appu_test_production");
  const current = await resolveAuthorityRequirement(s.env, { tenantId: TENANT, now: NOW, requirement });
  assert.equal(current.ok, true);
  assert.equal(current.current?.readback_id, v2.readback_id);

  const revoked = await s.command("owner", revokeCommand(head(v2)));
  assert.equal(revoked.status, 201);
  const v3 = revoked.body.readback as AuthorityRecordReadback;
  assert.equal(v3.authority_version, 3);
  assert.equal(v3.supersedes_authority_record_id, v2.authority_record_id);
  assert.equal(v3.verification_state, "revoked");
  assert.equal(v3.authority_revoked_at, NOW);
  assert.equal(v3.authority_verification_method, null);
  assert.equal((await resolveAuthorityRequirement(s.env, { tenantId: TENANT, now: NOW, requirement })).code, "authority_revoked");

  // Append-only: three versions, three digests, and the desk shows the one current head.
  const stored = s.rows("SELECT authority_version, authority_state_digest_sha256 FROM authority_record_readbacks ORDER BY authority_version");
  assert.deepEqual(stored.map((row) => row.authority_version), [1, 2, 3]);
  assert.equal(new Set(stored.map((row) => row.authority_state_digest_sha256)).size, 3);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_actions WHERE status = 'applied'").n, 3);
  const desk = (await listCurrentAuthorityHeads(s.env, TENANT, NOW)).flatMap((subject) => subject.records);
  assert.equal(desk.length, 1);
  assert.equal(desk[0]?.authority_version, 3);
  assert.equal(desk[0]?.verdict, "revoked");

  // A new assessment after the revocation supersedes the revoked head in turn.
  const reassessed = await s.command("owner", recordCommand({ expected_head: head(v3) }, { issuer_reference: "assessment:synthetic-0002" }));
  assert.equal(reassessed.status, 201);
  assert.equal(reassessed.body.readback.authority_version, 4);
  assert.equal(reassessed.body.readback.supersedes_authority_record_id, v3.authority_record_id);
});

test("a command must name the identity's current head, so one identity keeps one head", async () => {
  const s = setup();
  const v1 = (await s.command("owner", recordCommand())).body.readback as AuthorityRecordReadback;
  // A second first version for the same person, kind and scope would be a second head.
  assert.deepEqual((await s.command("owner", recordCommand({}, { issuer_reference: "assessment:synthetic-other" }))).body, {
    error: "authority_head_changed",
  });
  for (const expected of [
    { ...head(v1), authority_version: 2 },
    { authority_record_id: "competency-other-record", authority_version: 1 },
  ]) {
    const refused = await s.command("production", verifyCommand(expected));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "authority_head_changed");
  }
  assert.equal((await s.command("production", verifyCommand(null))).body.error, "authority_command_invalid");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 1);
  // Another scope is another identity, with a head of its own.
  const otherScope = await s.command("owner", recordCommand({ scope_ref: "job-synthetic-0002" }, { roof_job: "job-synthetic-0002" }));
  assert.equal(otherScope.status, 201);
  assert.equal(otherScope.body.readback.authority_version, 1);
});

test("status and verification stay coherent across the lifecycle", async () => {
  const s = setup();
  // An unverified version carries no verification reference.
  assert.equal((await s.command("owner", recordCommand({ reference: "assessment:early" }))).body.error, "authority_command_invalid");
  const v1 = (await s.command("owner", recordCommand())).body.readback as AuthorityRecordReadback;
  assert.equal((await s.command("production", revokeCommand(head(v1), { reason: null }))).body.error, "authority_command_invalid");
  const v2 = (await s.command("production", verifyCommand(head(v1)))).body.readback as AuthorityRecordReadback;
  // Only a recorded assessment can be verified, and a revoked one cannot be revoked again.
  const reverified = await s.command("owner", verifyCommand(head(v2)));
  assert.equal(reverified.status, 409);
  assert.equal(reverified.body.error, "authority_transition_invalid");
  const v3 = (await s.command("owner", revokeCommand(head(v2)))).body.readback as AuthorityRecordReadback;
  assert.equal((await s.command("production", revokeCommand(head(v3)))).body.error, "authority_transition_invalid");
  assert.equal((await s.command("production", verifyCommand(head(v3)))).body.error, "authority_transition_invalid");

  // A verified version is written only when the fence would accept it now.
  const past = { scope_ref: "job-synthetic-0003" };
  const stale = (await s.command("owner", recordCommand(past, { roof_job: "job-synthetic-0003", effective_from: "2025-01-01", expires_at: "2025-12-31" })))
    .body.readback as AuthorityRecordReadback;
  const expired = await s.command("production", verifyCommand(head(stale), past));
  assert.equal(expired.status, 422);
  assert.equal(expired.body.error, "authority_expired");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 4);
});

test("the window, the roof job and the person-only subject are checked before anything is read", async () => {
  const s = setup();
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [recordCommand({}, { effective_from: "2027-10-01", expires_at: "2027-09-30" }), 422, "authority_window_invalid"],
    [recordCommand({}, { effective_from: "2026-02-30" }), 422, "authority_window_invalid"],
    [recordCommand({}, { roof_job: null }), 422, "authority_roof_job_required"],
    // A worker competency binds a person only: there is no organization or subject type to name.
    [{ ...recordCommand(), organization: "supplier-synthetic" }, 400, "authority_command_invalid"],
    [{ ...recordCommand(), subject_type: "Organization" }, 400, "authority_command_invalid"],
    [recordCommand({}, { evidence_refs: [{ ref: "evidence-upload://receipt-1", sha256: "c".repeat(64) }] }), 400, "authority_command_invalid"],
    [recordCommand({ operation: "renew" }), 400, "authority_command_invalid"],
  ];
  for (const [body, status, error] of cases) {
    const refused = await s.command("owner", body);
    assert.equal(refused.status, status, JSON.stringify(body));
    assert.equal(refused.body.error, error, JSON.stringify(body));
  }
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
});

test("external issuer kinds are refused by the native path", async () => {
  const s = setup();
  for (const kind of ["WCB Clearance", "Trade Licence", "Insurance Certificate", "Permit"]) {
    const refused = await s.command("owner", recordCommand({ authority_kind: kind }));
    assert.equal(refused.status, 422, kind);
    assert.equal(refused.body.error, "authority_external_issuer_required", kind);
  }
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_actions").n, 0);
});

test("only an owner or a production approver may run a command, and never on their own record", async () => {
  const s = setup();
  for (const role of ["ops", "sales", "field"] as const) {
    const refused = await s.command(role, recordCommand());
    assert.equal(refused.status, 403, role);
    assert.equal(refused.body.error, "authority_approve_required", role);
  }
  assert.equal((await s.command("owner", recordCommand(), "people-csrf-0001", "wrong")).body.error, "csrf_failed");
  // The subject may be named by any identity the approver signs in with, in any case.
  for (const subject of ["appu_test_production", "PRODUCTION@example.invalid", "production@frappe.example.invalid"]) {
    const self = await s.command("production", recordCommand({ subject_ref: subject }));
    assert.equal(self.status, 403, subject);
    assert.equal(self.body.error, "authority_self_approval_forbidden", subject);
  }
  assert.equal((await s.command("owner", recordCommand({ subject_ref: "appu_test_owner" }))).body.error, "authority_self_approval_forbidden");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
  // Production holds `authority:approve` and approves another worker's record.
  const approved = await s.command("production", recordCommand());
  assert.equal(approved.status, 201);
  assert.equal(approved.body.action.actor_user_id, "appu_test_production");
});

test("the batch refuses a head, an approver or a subject that changed after the read", async () => {
  const s = setup();
  const v1 = (await s.command("owner", recordCommand())).body.readback as AuthorityRecordReadback;
  // An owner revocation commits between production's read and its transaction.
  s.db.beforeBatch = async () => {
    assert.equal((await s.command("owner", revokeCommand(head(v1)))).status, 201);
  };
  const raced = await s.command("production", verifyCommand(head(v1)));
  assert.equal(raced.status, 409);
  assert.equal(raced.body.error, "authority_head_changed");
  assert.deepEqual(s.rows("SELECT authority_version, verification_state FROM authority_record_readbacks ORDER BY authority_version"), [
    { authority_version: 1, verification_state: "unavailable" },
    { authority_version: 2, verification_state: "revoked" },
  ]);

  // The approver comes to share an identity with the worker before the transaction runs.
  const fresh = recordCommand({ scope_ref: "job-synthetic-0004" }, { roof_job: "job-synthetic-0004" });
  s.db.beforeBatch = () => {
    s.db.raw.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = 'appu_test_production'").run(WORKER);
  };
  const subjectRaced = await s.command("production", fresh);
  assert.equal(subjectRaced.status, 403);
  assert.equal(subjectRaced.body.error, "session_authority_changed");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks WHERE scope_ref = 'job-synthetic-0004'").n, 0);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM agent_control_guard").n, 0);
});

test("a repeated idempotency key replays its first result and refuses any other command", async () => {
  const s = setup();
  const first = await s.command("owner", recordCommand(), "people-replay-0001");
  assert.equal(first.status, 201);
  const replay = await s.command("owner", recordCommand(), "people-replay-0001");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.kind, "replayed");
  assert.deepEqual(replay.body.readback, first.body.readback);
  assert.equal((await s.command("owner", recordCommand({ scope_ref: "job-synthetic-0005" }, { roof_job: "job-synthetic-0005" }), "people-replay-0001")).body.error, "idempotency_conflict");
  assert.equal((await s.command("production", recordCommand(), "people-replay-0001")).body.error, "idempotency_conflict");
  // Two identical requests at once: one records, the other replays it.
  const fresh = recordCommand({ scope_ref: "job-synthetic-0006" }, { roof_job: "job-synthetic-0006" });
  const both = await Promise.all([s.command("owner", fresh, "people-replay-0002"), s.command("owner", fresh, "people-replay-0002")]);
  assert.deepEqual(both.map((response) => response.status).sort(), [200, 201]);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 2);
});

test("an approved authority.record step runs natively and records an owned-store receipt", async () => {
  const s = setup();
  const run = await s.complianceRun();
  const proposed = await s.propose(run, recordCommand());
  assert.equal(proposed.decision, "awaiting_approval");
  assert.equal(proposed.receipt.needs_from_you.reviewer_role, "production");
  assert.equal(proposed.receipt.permit.kind, "asks_first");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);

  const seen = s.scalar("SELECT version FROM agent_run_steps WHERE step_id = ?", proposed.step_id).version as number;
  // Ids a client chooses can never block the approval: both browser routes accept these.
  const claimed = await handleAuthorityRecordRoute(
    new Request("https://app.example.invalid/api/v1/authority-records/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "synthetic-csrf" },
      body: JSON.stringify({
        action_id: `authority_${proposed.step_id}`,
        authority_record_id: "competency-squatted",
        expected_version: 1,
        idempotency_key: `step:${proposed.step_id}`,
        operation: "record",
        request_fingerprint_sha256: "d".repeat(64),
      }),
    }),
    s.env,
    s.auths.get("ops")!,
  );
  assert.equal(claimed?.status, 201);
  assert.equal((await s.command("owner", recordCommand(), `step#${proposed.step_id}`)).body.error, "authority_command_invalid");

  const approved = await s.decide("production", proposed.step_id, "approve", "approve-step-0001");
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body, { outcome: "succeeded", reason_code: null });
  const step = s.scalar("SELECT * FROM agent_run_steps WHERE step_id = ?", proposed.step_id);
  const stored = s.scalar("SELECT * FROM authority_record_readbacks WHERE readback_id = ?", JSON.parse(step.readback_json).reference);
  const action = s.scalar("SELECT * FROM authority_record_actions WHERE action_id = ?", stored.action_id);
  assert.equal(stored.verification_state, "unavailable");
  assert.equal(stored.observed_by_user_id, "appu_test_production");
  assert.equal(action.status, "applied");
  assert.equal(action.actor_user_id, "appu_test_production");
  assert.equal(action.idempotency_key_sha256, hash(`${TENANT}\nstep#${proposed.step_id}`));
  assert.equal(step.outcome, "succeeded");
  assert.deepEqual(JSON.parse(step.tool_json), {
    binding: "authority_record_readbacks",
    idempotency_key: `step#${proposed.step_id}`,
    name: "authority.record",
    request_hash: step.args_sha256,
  });
  assert.deepEqual(JSON.parse(step.readback_json), {
    matched: true,
    reference: stored.readback_id,
    response_hash: stored.observation_fingerprint_sha256,
    source: "owned_store",
  });
  assert.equal(JSON.parse(step.permit_json).approved_by, "appu_test_production");
  assert.deepEqual(JSON.parse(step.policy_json).checks.at(-1), { check: "effect_binding", passed: true });
  // The exact decision replays; it never writes a second version.
  assert.deepEqual((await s.decide("production", proposed.step_id, "approve", "approve-step-0001", seen)).body, approved.body);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 1);
});

test("the AI step refuses an external kind, a bad window and its own subject's approver", async () => {
  const s = setup();
  const run = await s.complianceRun();
  for (const args of [
    recordCommand({ authority_kind: "WCB Clearance" }),
    recordCommand({}, { effective_from: "2028-01-01" }),
  ]) {
    const refused = await s.propose(run, args);
    assert.equal(refused.decision, "abstained");
    assert.deepEqual(refused.reason_codes, ["action_unregistered"]);
  }
  const own = await s.propose(run, recordCommand({ subject_ref: "appu_test_production" }));
  // The worker the record is about decides it neither way, even once a cited fact went stale.
  s.db.raw.prepare("UPDATE fleet_crews SET display_name = 'Synthetic Crew Renamed', version = 2 WHERE crew_id = ?").run(CREW);
  for (const decision of ["approve", "decline", "do_it_myself"]) {
    const self = await s.decide("production", own.step_id, decision, `self-${decision}-0001`);
    assert.equal(self.status, 403, decision);
    assert.equal(self.body.error, "authority_self_approval_forbidden", decision);
  }
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM agent_step_decisions").n, 0);
  // Another approver may still decide it.
  assert.deepEqual((await s.decide("owner", own.step_id, "approve", "approve-own-0002")).body, {
    outcome: "abstained",
    reason_code: "fact_stale",
  });
});

test("a cited fact that changed after the proposal stops the approval", async () => {
  const s = setup();
  const run = await s.complianceRun();
  const proposed = await s.propose(run, recordCommand());
  s.db.raw.prepare("UPDATE fleet_crews SET display_name = 'Synthetic Crew Renamed', version = 2 WHERE crew_id = ?").run(CREW);
  const approved = await s.decide("production", proposed.step_id, "approve", "approve-stale-0001");
  assert.deepEqual(approved.body, { outcome: "abstained", reason_code: "fact_stale" });
  const step = s.scalar("SELECT policy_json, tool_json FROM agent_run_steps WHERE step_id = ?", proposed.step_id);
  assert.deepEqual(JSON.parse(step.policy_json).checks.at(-1), { check: "fresh", passed: false });
  assert.equal(step.tool_json, null);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
});

test("a delegation change between proposal and decision fails inside the decision's transaction", async () => {
  const s = setup();
  const run = await s.complianceRun();
  const proposed = await s.propose(run, recordCommand());
  s.db.beforeBatch = () => {
    s.db.raw
      .prepare(
        `INSERT INTO agent_delegation_settings (setting_id,tenant_id,specialist_id,action_id,revision,control_revision,catalog_version,policy_version,setting,ceiling_json,reason,set_by_user_id,set_at,idempotency_key)
         VALUES ('dlg_synthetic_0001', ?, 'compliance', 'authority.record', 1, 0, 'synthetic', 'synthetic', 'off', NULL, 'Synthetic owner change', 'appu_test_owner', ?, 'synthetic-delegation-0001')`,
      )
      .run(TENANT, NOW);
  };
  const raced = await s.decide("production", proposed.step_id, "approve", "approve-delegation-0001");
  assert.equal(raced.status, 409);
  assert.equal(raced.body.error, "stale_version");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM agent_step_decisions").n, 0);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
  // Read again, the action is off: it can no longer be approved, only declined.
  assert.equal((await s.decide("production", proposed.step_id, "approve", "approve-delegation-0002")).body.error, "delegation_off");
  assert.equal((await s.decide("production", proposed.step_id, "decline", "decline-delegation-0001")).body.outcome, "failed");
});

test("a head that moved after the proposal abstains the step instead of writing a second head", async () => {
  const s = setup();
  const v1 = (await s.command("owner", recordCommand())).body.readback as AuthorityRecordReadback;
  const run = await s.complianceRun();
  const proposed = await s.propose(run, verifyCommand(head(v1)));
  assert.equal(proposed.decision, "awaiting_approval");
  // Committed inside the approval's window: the transaction's head check refuses it.
  s.db.beforeBatch = async () => {
    assert.equal((await s.command("owner", revokeCommand(head(v1)))).status, 201);
  };
  assert.equal((await s.decide("production", proposed.step_id, "approve", "approve-head-0001")).body.error, "stale_version");
  // Read again, the head the step names is no longer current.
  assert.deepEqual((await s.decide("production", proposed.step_id, "approve", "approve-head-0002")).body, {
    outcome: "abstained",
    reason_code: "fact_stale",
  });
  assert.deepEqual(s.rows("SELECT verification_state FROM authority_record_readbacks ORDER BY authority_version"), [
    { verification_state: "unavailable" },
    { verification_state: "revoked" },
  ]);
});

test("a login that shares any coordinate with one of the worker's logins cannot approve the worker's record", async () => {
  const s = setup();
  // One person, two logins: the field login the record is about, and a production login that
  // shares its Frappe user. The worker may be named by the field login's user id or email.
  s.db.raw.prepare("UPDATE app_users SET frappe_user_id = 'field@frappe.example.invalid' WHERE user_id = 'appu_test_production'").run();
  for (const subject of [WORKER, "field@example.invalid", "FIELD@EXAMPLE.INVALID"]) {
    const refused = await s.command("production", recordCommand({ subject_ref: subject }));
    assert.equal(refused.status, 403, subject);
    assert.equal(refused.body.error, "authority_self_approval_forbidden", subject);
  }
  const run = await s.complianceRun();
  const proposed = await s.propose(run, recordCommand());
  const refused = await s.decide("production", proposed.step_id, "approve", "shared-login-approve-0001");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "authority_self_approval_forbidden");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
  // An approver whose login shares nothing with the worker's still approves.
  assert.equal((await s.command("owner", recordCommand())).status, 201);
});

test("the batch refuses a worker login that came to share the approver's user id, email or Frappe user", async () => {
  // Each case names the worker so that only one coordinate of the field login meets the approver.
  const cases: Array<[string, string, string]> = [
    ["user id", "field@example.invalid", WORKER],
    ["email", WORKER, "field@example.invalid"],
    ["Frappe user", WORKER, "field@frappe.example.invalid"],
  ];
  for (const [coordinate, subject, approverFrappeUser] of cases) {
    const s = setup();
    s.db.beforeBatch = () => {
      s.db.raw.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = 'appu_test_production'").run(approverFrappeUser);
    };
    const raced = await s.command("production", recordCommand({ subject_ref: subject }));
    assert.equal(raced.status, 403, coordinate);
    assert.equal(raced.body.error, "session_authority_changed", coordinate);
    assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0, coordinate);
  }
});

test("an identity holds at most the fence's lineage bound, and its last slot is kept for a revocation", async () => {
  const s = setup();
  let current = (await s.command("owner", recordCommand(), "bound-0001")).body.readback as AuthorityRecordReadback;
  for (let version = 2; version <= 31; version += 1) {
    const next = await s.command("owner", recordCommand({ expected_head: head(current) }, { issuer_reference: `assessment:bound-${version}` }), `bound-${String(version).padStart(4, "0")}`);
    assert.equal(next.status, 201, `version ${version}`);
    current = next.body.readback;
  }
  // With one slot left, only a revocation may take it: not another record, and not a verification.
  const another = await s.command("owner", recordCommand({ expected_head: head(current) }, { issuer_reference: "assessment:bound-32" }), "bound-0032-record");
  assert.equal(another.status, 409);
  assert.equal(another.body.error, "authority_version_limit_reached");
  const verify = await s.command("production", verifyCommand(head(current)), "bound-0032-verify");
  assert.equal(verify.status, 409);
  assert.equal(verify.body.error, "authority_version_limit_reached");
  const revoked = await s.command("production", revokeCommand(head(current)), "bound-0032-revoke");
  assert.equal(revoked.status, 201);
  assert.equal(revoked.body.readback.authority_version, 32);
  // A 33rd row would leave the identity unreadable to the fence.
  const beyond = await s.command("owner", recordCommand({ expected_head: head(revoked.body.readback) }, { issuer_reference: "assessment:bound-33" }), "bound-0033");
  assert.equal(beyond.status, 409);
  assert.equal(beyond.body.error, "authority_version_limit_reached");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 32);
  assert.equal((await resolveAuthorityRequirement(s.env, { tenantId: TENANT, now: NOW, requirement })).code, "authority_revoked");
  const desk = (await listCurrentAuthorityHeads(s.env, TENANT, NOW)).flatMap((subject) => subject.records);
  assert.deepEqual(desk.map((record) => [record.authority_version, record.verdict]), [[32, "revoked"]]);
});

test("the action keeps each command's operation, reference and reason readable", async () => {
  const s = setup();
  const recorded = (await s.command("owner", recordCommand())).body;
  const verified = (await s.command("production", verifyCommand(head(recorded.readback)))).body;
  const revoked = (await s.command("owner", revokeCommand(head(verified.readback)))).body;
  const readBack = async (actionId: string) => {
    const response = await handleAuthorityRecordRoute(
      new Request(`https://app.example.invalid/api/v1/authority-records/actions/${actionId}`),
      s.env,
      s.auths.get("production")!,
      () => CLOCK,
    );
    const { operation, verification_reference, revocation_reference, correction_reason } = JSON.parse(((await response!.json()) as any).action.result_json);
    return { operation, verification_reference, revocation_reference, correction_reason };
  };
  assert.deepEqual(await readBack(recorded.action.action_id), {
    operation: "record",
    verification_reference: null,
    revocation_reference: null,
    correction_reason: null,
  });
  assert.deepEqual(await readBack(verified.action.action_id), {
    operation: "verify",
    verification_reference: "assessment:synthetic-0001:checked",
    revocation_reference: null,
    correction_reason: null,
  });
  assert.deepEqual(await readBack(revoked.action.action_id), {
    operation: "revoke",
    verification_reference: null,
    revocation_reference: "revocation:synthetic-0001",
    correction_reason: "The assessor withdrew the synthetic assessment.",
  });
});

test("a first version's batch refuses an identity that gained a version after the read", async () => {
  const s = setup();
  // Another approver records the same worker's first version under a different key in between.
  s.db.beforeBatch = async () => {
    assert.equal((await s.command("owner", recordCommand({}, { issuer_reference: "assessment:first-owner" }), "first-owner-0001")).status, 201);
  };
  const raced = await s.command("production", recordCommand({}, { issuer_reference: "assessment:first-production" }), "first-production-0001");
  assert.equal(raced.status, 409);
  assert.equal(raced.body.error, "authority_head_changed");
  assert.deepEqual(s.rows("SELECT issuer_reference FROM authority_record_readbacks"), [{ issuer_reference: "assessment:first-owner" }]);
});

test("a command from a session revoked after sign-in fails inside its transaction", async () => {
  const s = setup();
  s.db.raw.prepare("UPDATE app_sessions SET revoked_at = created_at WHERE user_id = 'appu_test_production'").run();
  const refused = await s.command("production", recordCommand());
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "session_authority_changed");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_actions").n, 0);
});

test("a native write refuses an identity whose history is not one version line", async () => {
  // Older data the native path never writes itself, each breaking one rule of a single line.
  const topologies: Array<[string, Array<Partial<RecordAuthorityReadbackInput>>, { authority_record_id: string; authority_version: number }]> = [
    [
      "two heads, the newer one sorting first",
      [{ authorityRecordId: "competency-legacy-a", authorityVersion: 2 }, { authorityRecordId: "competency-legacy-b", authorityVersion: 1 }],
      { authority_record_id: "competency-legacy-a", authority_version: 2 },
    ],
    [
      "another record at the head's version",
      [
        { authorityRecordId: "competency-legacy-e", authorityVersion: 3 },
        { authorityRecordId: "competency-legacy-f", authorityVersion: 3, supersedesAuthorityRecordId: "competency-legacy-e" },
      ],
      { authority_record_id: "competency-legacy-f", authority_version: 3 },
    ],
    [
      "the head below another record's version",
      [
        { authorityRecordId: "competency-legacy-e", authorityVersion: 3 },
        { authorityRecordId: "competency-legacy-f", authorityVersion: 1, supersedesAuthorityRecordId: "competency-legacy-e" },
      ],
      { authority_record_id: "competency-legacy-f", authority_version: 1 },
    ],
    [
      "the head superseded from another identity",
      [
        { authorityRecordId: "competency-legacy-h", authorityVersion: 1 },
        {
          authorityRecordId: "competency-legacy-elsewhere",
          authorityVersion: 2,
          supersedesAuthorityRecordId: "competency-legacy-h",
          scopeRef: "job-synthetic-elsewhere",
          roofJob: "job-synthetic-elsewhere",
        },
      ],
      { authority_record_id: "competency-legacy-h", authority_version: 1 },
    ],
  ];
  for (const [topology, legacy, expected] of topologies) {
    const s = setup();
    for (const row of legacy) await legacyRow(s.env, row);
    const refused = await s.command("owner", recordCommand({ expected_head: expected }, { issuer_reference: "assessment:after-legacy" }));
    assert.equal(refused.status, 409, topology);
    assert.equal(refused.body.error, "authority_ambiguous", topology);
  }
});

test("only a worker version of a person can be verified or revoked natively", async () => {
  for (const [shape, overrides] of [
    ["a subcontractor role", { subjectRole: "Subcontractor" }],
    ["an organization named", { organization: "supplier-synthetic" }],
  ] as const) {
    const s = setup();
    const legacy = await legacyRow(s.env, { authorityRecordId: "competency-legacy-shape", ...overrides });
    for (const command of [verifyCommand(head(legacy)), revokeCommand(head(legacy))]) {
      const refused = await s.command("production", command);
      assert.equal(refused.status, 409, `${shape} ${command.operation}`);
      assert.equal(refused.body.error, "authority_transition_invalid", `${shape} ${command.operation}`);
    }
  }
});

test("someone who is not an approver cannot decide an authority step", async () => {
  const s = setup();
  const run = await s.complianceRun();
  const proposed = await s.propose(run, recordCommand());
  assert.equal((await s.decide("ops", proposed.step_id, "approve", "ops-approve-0001")).status, 403);
  // A production session whose login has lost production authority is no approver.
  s.db.raw.prepare("UPDATE app_users SET access_role = 'ops' WHERE user_id = 'appu_test_production'").run();
  const demoted = await s.decide("production", proposed.step_id, "approve", "demoted-approve-0001");
  assert.equal(demoted.status, 403);
  assert.equal(demoted.body.error, "authority_approver_required");
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM agent_step_decisions").n, 0);
  assert.equal(s.scalar("SELECT COUNT(*) AS n FROM authority_record_readbacks").n, 0);
});

test("a reader without authority:approve never reads a colleague's references or reasons", async () => {
  const s = setup();
  const recorded = (await s.command("owner", recordCommand())).body;
  const revoked = (await s.command("production", revokeCommand(head(recorded.readback)))).body;
  const readAs = async (role: AppRole) => {
    const response = await handleAuthorityRecordRoute(
      new Request(`https://app.example.invalid/api/v1/authority-records/actions/${revoked.action.action_id}`),
      s.env,
      s.auths.get(role)!,
      () => CLOCK,
    );
    assert.equal(response?.status, 200, role);
    return JSON.parse(((await response!.json()) as any).action.result_json) as Record<string, unknown>;
  };
  for (const role of ["field", "ops"] as const) {
    const result = await readAs(role);
    assert.equal(result.operation, "revoke", role);
    for (const key of ["verification_reference", "revocation_reference", "correction_reason"]) {
      assert.equal(Object.hasOwn(result, key), false, `${role} ${key}`);
    }
  }
  for (const role of ["production", "owner"] as const) {
    const result = await readAs(role);
    assert.equal(result.operation, "revoke", role);
    assert.equal(result.verification_reference, null, role);
    assert.equal(result.revocation_reference, "revocation:synthetic-0001", role);
    assert.equal(result.correction_reason, "The assessor withdrew the synthetic assessment.", role);
  }

  // The step a specialist proposes carries the same text; an assigned ops reader does not see it.
  s.db.raw.prepare("UPDATE app_users SET active = 0 WHERE user_id = 'appu_test_production'").run();
  const run = await s.complianceRun();
  const proposed = await s.propose(run, revokeCommand(head(revoked.readback), { reason: "Synthetic reason about a colleague." }));
  const stepAs = async (role: AppRole) => {
    const response = await handleAgentTeamAppRoute(
      new Request(`https://bus.example.invalid/api/v1/agent-team/steps/${proposed.step_id}`),
      s.env as never,
      s.auths.get(role)!,
      () => CLOCK,
    );
    assert.equal(response.status, 200, role);
    return ((await response.json()) as any).args as Record<string, unknown>;
  };
  const opsArgs = await stepAs("ops");
  assert.equal(opsArgs.operation, "revoke");
  assert.equal(Object.hasOwn(opsArgs, "reference") || Object.hasOwn(opsArgs, "reason"), false);
  assert.equal((await stepAs("owner")).reason, "Synthetic reason about a colleague.");
});

test("logins without a Frappe user, or with a blank one, never match each other in the batch guard", async () => {
  for (const frappeUser of [null, "", "   "]) {
    const s = setup();
    s.db.raw.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id IN ('appu_test_production', 'appu_test_ops')").run(frappeUser);
    const recorded = await s.command("production", recordCommand({ subject_ref: "appu_test_ops" }));
    assert.equal(recorded.status, 201, JSON.stringify(frappeUser));
    assert.equal(recorded.body.readback.person_user, "appu_test_ops");
  }
});
